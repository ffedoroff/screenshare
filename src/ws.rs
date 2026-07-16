//! Обработка WebSocket-соединений: сигналинг-релей и жизненный цикл комнат.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::protocol::{ClientMessage, PeerInfo, PendingInfo, RoomSettings, ServerMessage};
use crate::state::{
    check_ip_rate_limit, extract_client_ip, generate_peer_id, send_to, AppState, IpRateLimitMap,
    PendingParticipant, Participant, PeerTx, Room, SharedRooms, JOIN_ROOM_IP_WINDOW, MAX_PENDING,
    PENDING_JOIN_IP_LIMIT, PENDING_JOIN_IP_WINDOW,
};

/// E2E v2 (см. docs/research-p2p-key-handoff.md §6.5–6.6): максимальная длина
/// `epub` (эфемерный публичный ключ пира, ECDH P-256, base64url raw) в
/// символах. Сервер его НЕ парсит (опак, как `sdp`) — только каппит размер:
/// реальный `epub` укладывается в ~87 симв. (65 байт raw в base64url), 200 —
/// щедрый запас на будущую смену кривой/формата без немедленной правки
/// сервера. Слишком длинное значение — не обрезаем (обрезанный ключ
/// бессмысленен и всё равно не даст вывести правильный shared secret), а
/// целиком отбрасываем как если бы клиент не прислал `epub` вовсе (см.
/// `sanitize_epub`).
const EPUB_MAX_CHARS: usize = 200;

/// E2E v2: максимальный размер `payload` одного `name-announce` в байтах —
/// зашифрованное имя (base64: iv + AES-256-GCM ciphertext), с большим
/// запасом даже для длинных имён у верхней границы `maxlength` инпута (см.
/// static/room.html) — 2KB заведомо избыточен для одного имени, но не
/// открывает канал перекачки произвольных объёмов данных под видом анонса
/// имени.
const NAME_ANNOUNCE_MAX_BYTES: usize = 2 * 1024;

/// H2 (DoS-защита): максимальный размер сериализованного payload одного
/// релея offer/answer/ice-candidate/stream-info (`sdp`/`candidate`/`info`
/// соответственно) в байтах. Сервер эти поля не разбирает (опаковый JSON),
/// но обязан ограничить размер — иначе релей превращается в бесплатный канал
/// перекачки произвольных объёмов данных через сервер под видом сигналинга.
const RELAY_MAX_BYTES: usize = 16 * 1024;

/// H2 (DoS-защита): скользящее окно rate-limit НА ВСЕ релеи одного
/// соединения суммарно — offer/answer/ice-candidate/stream-info вместе,
/// единым счётчиком. Обоснование объединения (а не отдельного счётчика на
/// каждый тип): вектор атаки один и тот же (флудить сообщениями с одного
/// соединения) независимо от того, какой именно тип релея используется —
/// раздельные счётчики позволили бы обойти лимит одного типа, просто
/// чередуя типы сообщений. Чат в этот счётчик не входит вовсе — сервер в
/// чате не участвует, он ходит только по mesh RTCDataChannel напрямую между
/// участниками (см. `crate::protocol`, docs/chat.md §12). Этот лимит
/// (100/10с) в первую очередь защищает от флуда ICE-кандидатами (их бывает
/// много легитимно при установке соединения — 100 за 10с должно перекрывать
/// нормальный trickle-ICE с запасом).
const RELAY_RATE_LIMIT: usize = 100;
const RELAY_RATE_WINDOW: Duration = Duration::from_secs(10);

/// H2 (DoS-защита): лимиты на сам WS-кадр/сообщение — независимо от
/// прикладных лимитов выше, на уровне протокола. Наш крупнейший легитимный
/// кадр — offer с несколькими медиалиниями, укладывается на порядок меньше
/// этого лимита; всё, что крупнее, рассматриваем как атаку и axum сам
/// разрывает соединение, не пропуская кадр в приложение.
const WS_MAX_MESSAGE_SIZE: usize = 64 * 1024;
const WS_MAX_FRAME_SIZE: usize = 64 * 1024;

/// Серверный ping/pong-хартбит: как часто сами пингуем клиента.
///
/// Зачем: TCP-соединение может оборваться тихо, без FIN/RST (у клиента сдох
/// Wi-Fi, ноутбук ушёл в сон, между нами и клиентом лежит NAT/балансировщик,
/// молча уронивший состояние) — `socket.recv()` в этом случае не вернёт ни
/// ошибку, ни `None` ещё очень долго: обрыв обнаружится только по TCP-таймауту
/// операционной системы, а это минуты. Активный ping/pong ловит такой обрыв
/// за секунды-десятки секунд вместо минут — дальше чистку доводит уже
/// существующая `cleanup_peer` (комната освобождается, остальные пиры узнают).
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Если подряд отправлено `MAX_MISSED_PONGS` ping'ов и на них не пришло НИ
/// ОДНОГО pong'а (и вообще ничего от клиента за это время) — считаем
/// соединение мёртвым и рвём его сами.
const MAX_MISSED_PONGS: u32 = 2;

/// Кем это соединение зарегистрировано в комнате.
#[derive(Debug, Clone)]
struct PeerCtx {
    room_id: String,
    peer_id: String,
}

/// Скользящее окно rate-limit одного соединения — общее на все релеи суммарно
/// (`RELAY_RATE_LIMIT`). В структуре (а не голым полем), чтобы легко было
/// вернуть сюда дополнительные окна, если понадобятся.
#[derive(Default)]
struct RateLimits {
    relay_times: VecDeque<Instant>,
}

/// Что делать с соединением после обработки сообщения.
#[derive(PartialEq)]
enum Flow {
    Continue,
    /// Закрыть сокет (после того как писатель дошлёт всё из очереди).
    Stop,
}

/// Ш2 (см. src/main.rs, "Топология Ш2"): WebSocket кросс-ориджн работает и
/// БЕЗ единого заголовка CORS (браузеры не применяют same-origin policy к
/// WS-хендшейку так, как к fetch) — но раз уж фронт и API теперь МОГУТ жить
/// на разных хостах, лишним не будет опционально свериться с тем же
/// allow-list `CORS_ORIGIN`, что и HTTP-эндпоинты (см. `crate::CORS_ORIGIN`,
/// `crate::cors_middleware`). Если `CORS_ORIGIN` не задан (дефолт — локалка
/// и нынешний прод, фронт и API ещё на одном хосте) — проверки нет вовсе,
/// поведение как раньше. Если задан, а пришедший `Origin` с ним не совпал —
/// `403`, апгрейда не будет.
pub async fn ws_handler(
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    if let Some(allowed) = crate::CORS_ORIGIN.as_deref() {
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if origin != Some(allowed) {
            warn!(?origin, allowed, "WS-хендшейк с несовпавшим Origin отклонён");
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    let ip = extract_client_ip(&headers, Some(peer_addr));
    // H2 (DoS-защита): кап на размер WS-сообщения/кадра — см. WS_MAX_MESSAGE_SIZE
    // выше. Проверено на актуальном API axum 0.8 (`WebSocketUpgrade::max_message_size`/
    // `max_frame_size`, src/extract/ws.rs) — не выдумано.
    ws.max_message_size(WS_MAX_MESSAGE_SIZE)
        .max_frame_size(WS_MAX_FRAME_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, state, ip))
}

/// Одно WS-соединение = одна задача tokio. Исходящие сообщения пиру идут
/// через mpsc-канал: другие задачи кладут в канал, а писать в сокет может
/// только эта задача (select ниже) — так исключаются гонки записи.
async fn handle_socket(mut socket: WebSocket, state: AppState, ip: String) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    // Комната/пир этого соединения; None до join-room.
    let mut me: Option<PeerCtx> = None;
    // Взводится, когда очередь исходящих надо дослать и закрыть сокет.
    let mut closing = false;
    // Оба скользящих окна rate-limit этого соединения (чат-специфичное и
    // общее на все релеи) сгруппированы в одну структуру — см. `RateLimits`.
    let mut rate_limits = RateLimits::default();

    // C (docs/research-ops.md §1.0/§1.6, см. `crate::shutdown_signal`):
    // подписка на broadcast-уведомление о шатдауне — по SIGTERM/SIGINT сервер
    // сам активно закрывает это соединение (см. select ниже), вместо того
    // чтобы пассивно доживать до `terminationGracePeriodSeconds`/`SIGKILL`.
    let mut shutdown_rx = state.shutdown.subscribe();

    // Хартбит: тикает каждые PING_INTERVAL, шлёт Message::Ping. axum сам
    // отвечает Pong'ом на ВХОДЯЩИЕ Ping (нам ничего для этого делать не нужно),
    // а вот входящие Pong (ответ на НАШ ping) прилетают в socket.recv() ниже
    // как Message::Pong — их и считаем. missed_pongs растёт на каждый
    // отправленный ping и сбрасывается в 0 любым входящим сообщением от
    // клиента (в том числе pong) — значит клиент жив, кто бы что ни отвечал.
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.tick().await; // первый тик — мгновенно, не в счёт
    let mut missed_pongs: u32 = 0;

    loop {
        tokio::select! {
            // C: сервер уходит на SIGTERM/SIGINT — закрываем сокет активно
            // СЕЙЧАС, а не ждём пассивно `terminationGracePeriodSeconds`
            // (30с)/`SIGKILL` (см. docs/research-ops.md §1.0/§1.6). Клиент
            // ловит `Close` немедленно и уходит в свой обычный
            // auto-reconnect. Результат `recv()` (Ok/Err/Lagged) не важен —
            // в любом случае пора закрываться; `Err` возможен только если
            // отправитель уже сброшен (сервер уже почти остановлен) — тоже
            // сигнал закрываться.
            _ = shutdown_rx.recv() => {
                debug!("получен сигнал шатдауна — закрываем WS активно");
                let _ = socket.send(Message::Close(Some(CloseFrame {
                    code: axum::extract::ws::close_code::RESTART,
                    reason: "server restarting, please reconnect".into(),
                }))).await;
                break;
            }

            // Хартбит: раз в PING_INTERVAL. Если два ping'а подряд ушли без
            // единого ответа (пуст ни pong, ни вообще что-либо от клиента) —
            // соединение считаем мёртвым и рвём сами, не дожидаясь TCP-таймаута.
            _ = ping_interval.tick() => {
                if missed_pongs >= MAX_MISSED_PONGS {
                    debug!("клиент не отвечает на ping ({missed_pongs} подряд без ответа) — считаем соединение мёртвым");
                    break;
                }
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break; // сокет уже мёртв — чистка ниже
                }
                missed_pongs += 1;
            }

            // Исходящие сообщения этому пиру.
            out = rx.recv() => {
                // None невозможен, пока жив наш собственный `tx`, но
                // обрабатываем аккуратно.
                let Some(msg) = out else { break };
                // После отказа сервер сам закрывает сокет (edge-кейс №3/№4;
                // JoinRejected — отказ лидера ожидающему в лобби).
                let reject = matches!(
                    msg,
                    ServerMessage::RoomFull
                        | ServerMessage::RoomNotFound
                        | ServerMessage::JoinRejected {}
                        | ServerMessage::RoomExpired {}
                );
                let text = match serde_json::to_string(&msg) {
                    Ok(t) => t,
                    Err(e) => { warn!("сериализация ServerMessage: {e}"); continue }
                };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break; // сокет умер — чистка ниже
                }
                if reject {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                // Явный `leave`: дослали всё, что было в очереди, и выходим.
                if closing && rx.is_empty() {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }

            // Входящие сообщения от клиента.
            inbound = socket.recv() => {
                // Любое входящее сообщение — знак, что клиент жив: сбрасываем
                // счётчик пропущенных pong'ов. Касается и Message::Pong (ответ
                // на наш ping, axum отдаёт его сюда как обычный кадр), и всего
                // остального (Text/Binary/входящий Ping клиента и т.д.).
                if matches!(inbound, Some(Ok(_))) {
                    missed_pongs = 0;
                }
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(msg) => {
                                let flow = handle_message(
                                    msg, &mut me, &tx, &state.rooms, &mut rate_limits,
                                    &ip, &state.pending_join_ips, &state.join_room_ips,
                                );
                                if flow == Flow::Stop {
                                    // Не рвём сразу: даём писателю дослать очередь.
                                    closing = true;
                                    if rx.is_empty() {
                                        let _ = socket.send(Message::Close(None)).await;
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                debug!("некорректное сообщение клиента: {e}");
                                send_to(&tx, ServerMessage::Error {
                                    message: format!("bad message: {e}"),
                                });
                            }
                        }
                    }
                    // Закрытие или обрыв сокета (edge-кейс №8).
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // Входящий Ping от клиента — axum отвечает Pong'ом сам, нам
                    // ничего делать не нужно. Message::Pong (ответ на НАШ
                    // хартбит-ping) уже учтён сбросом missed_pongs выше — здесь
                    // как и бинарные кадры дальше просто игнорируется.
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    // Чистка при любом исходе: leave, close, обрыв. `&tx` — см.
    // `cleanup_peer`: нужен, чтобы отличить "это соединение всё ещё владеет
    // своим слотом" от "слот уже перехвачен реконнектом другого соединения"
    // (см. `reconnect_participant`/задачи A/D).
    if let Some(ctx) = me {
        cleanup_peer(&ctx, &state.rooms, &tx);
    }
}

/// Обработка одного сообщения клиента. Целиком синхронна: всё состояние —
/// в памяти под `std::sync::Mutex`, никакого I/O на диск или к внешнему
/// хранилищу.
fn handle_message(
    msg: ClientMessage,
    me: &mut Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    rate_limits: &mut RateLimits,
    ip: &str,
    pending_join_ips: &IpRateLimitMap,
    join_room_ips: &IpRateLimitMap,
) -> Flow {
    match msg {
        // `name` сознательно не биндится (`name: _`): сервер его больше не
        // хранит и не использует — см. docs/research-minimize-state.md §3,
        // комментарий у `crate::state::Participant`. Поле остаётся в схеме
        // протокола только ради обратной совместимости десериализации.
        ClientMessage::JoinRoom { room_id, name: _, peer_id, leader_token, epub } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let epub = sanitize_epub(epub);

            let mut rooms_guard = rooms.lock().unwrap();
            let Some(room) = rooms_guard.get_mut(&room_id) else {
                send_to(tx, ServerMessage::RoomNotFound); // комната не создана или уже удалена реапером
                return Flow::Continue; // сокет закроет писатель
            };

            // A/D: реконнект СВОИМ прежним peerId, который ПРЯМО СЕЙЧАС
            // занимает слот полноценного участника этой же комнаты — см.
            // `reconnect_participant` за подробным обоснованием. Обрабатываем
            // ДО per-IP лимита join-room (A) и ДО room-full/effective-лимита
            // (D): это не новый вход, а тот же самый участник с новым
            // сигналинг-соединением, поэтому не должен ни тратить чужой/свой
            // бюджет, ни спотыкаться о лимит, который сам уже занимает.
            if let Some(id) = peer_id.as_deref() {
                if Uuid::parse_str(id).is_ok() && room.participants.contains_key(id) {
                    let peer_id = id.to_string();
                    reconnect_participant(room, &room_id, &peer_id, tx.clone());
                    drop(rooms_guard);
                    *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
                    return Flow::Continue;
                }
            }

            // A (H2, DoS-защита, docs/research-dos.md §3.2 — «главная дыра»):
            // per-IP лимит на сам факт JoinRoom, отдельный бюджет от
            // ROOM_CREATION_IP_LIMIT/PENDING_JOIN_IP_LIMIT (см.
            // DEFAULT_JOIN_ROOM_IP_LIMIT в state.rs). Проверяется здесь,
            // ДО ветвления на лобби/прямой вход — попадание в лобби поэтому
            // расходует и этот бюджет, и PENDING_JOIN_IP_LIMIT ниже; это не
            // ошибка, а сознательно избыточная защита (раздельные карты,
            // не делят счётчик) ради простоты одной точки проверки.
            if !check_ip_rate_limit(join_room_ips, ip, *crate::JOIN_ROOM_IP_LIMIT, JOIN_ROOM_IP_WINDOW) {
                send_to(tx, err("too many join attempts from your network, try again later"));
                drop(rooms_guard);
                return Flow::Stop;
            }

            // Клиентский peerId (переподключение после обрыва сигналинга, см.
            // ClientMessage::JoinRoom) — принимаем, только если валидный UUID
            // и ещё свободен в этой комнате (ни среди участников, ни среди
            // ожидающих в лобби; занятый среди участников уже обработан выше
            // как реконнект); иначе как раньше генерируем новый.
            let peer_id = peer_id
                .filter(|id| Uuid::parse_str(id).is_ok())
                .filter(|id| !room.participants.contains_key(id) && !room.pending.contains_key(id))
                .unwrap_or_else(generate_peer_id);

            // Лидерство: предъявленный токен, совпавший с хранимым, сжигается
            // и делает вошедшего лидером; иначе — если в комнате прямо сейчас
            // нет лидера (свежесозданная/восстановленная/только что опустевшая
            // комната) — лидером становится первый вошедший.
            let mut becomes_leader = false;
            if let Some(token) = &leader_token {
                if room.leader_token.as_deref() == Some(token.as_str()) {
                    becomes_leader = true;
                    room.leader_token = None; // одноразовый — сжигаем
                }
            }
            if !becomes_leader && room.leader_id.is_none() {
                becomes_leader = true;
            }

            // Лобби (wait room) применяется только к НЕ-лидеру: лидер всегда
            // входит напрямую, минуя ожидание.
            if !becomes_leader && room.settings.lobby_enabled {
                if room.pending.len() >= MAX_PENDING {
                    send_to(tx, err("waiting room is full, try again later"));
                    drop(rooms_guard);
                    return Flow::Stop;
                }
                // M3 (лобби не забить): per-IP лимит на попадание в pending,
                // отдельный бюджет от лимита создания комнат (см.
                // `PENDING_JOIN_IP_LIMIT`) — не даёт одному IP забить лобби
                // разом множеством соединений, даже если MAX_PENDING этой
                // конкретной комнаты формально не исчерпан.
                if !check_ip_rate_limit(pending_join_ips, ip, PENDING_JOIN_IP_LIMIT, PENDING_JOIN_IP_WINDOW) {
                    send_to(tx, err("too many join attempts from your network, try again later"));
                    drop(rooms_guard);
                    return Flow::Stop;
                }
                room.pending.insert(
                    peer_id.clone(),
                    PendingParticipant {
                        tx: tx.clone(),
                        epub: epub.clone(),
                        joined_at: Instant::now(),
                    },
                );
                info!(room = %room_id, peer = %peer_id, "участник ждёт одобрения в лобби");
                // Инвариант: до этой точки `!becomes_leader` при попадании в
                // лобби означает, что в комнате уже точно есть лидер (см.
                // ветку выше: `becomes_leader` иначе стал бы `true` сам —
                // "если в комнате прямо сейчас нет лидера... лидером
                // становится первый вошедший"), поэтому `room.leader_id`
                // здесь всегда `Some`. `unwrap_or_default()` — не паника на
                // случай, если этот инвариант когда-нибудь нарушится.
                let leader_id = room.leader_id.clone();
                let leader_epub = leader_id
                    .as_ref()
                    .and_then(|id| room.participants.get(id))
                    .and_then(|p| p.epub.clone());
                send_to(tx, ServerMessage::Waiting {
                    leader_peer_id: leader_id.clone().unwrap_or_default(),
                    leader_epub,
                });
                if let Some(leader_id) = leader_id {
                    if let Some(leader) = room.participants.get(&leader_id) {
                        send_to(&leader.tx, ServerMessage::JoinRequest {
                            peer_id: peer_id.clone(),
                            name: None, // мёртвое поле, см. комментарий модуля protocol.rs
                            epub: epub.clone(),
                        });
                    }
                }
                drop(rooms_guard);
                *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
                return Flow::Continue;
            }

            // D (docs/research-room-limit.md §2.2): эффективный лимит комнаты
            // — собственный лидера, если задан, иначе серверный потолок (см.
            // `Room::effective_max_participants`) — ВЕЗДЕ вместо прямого
            // сравнения с `crate::MAX_PARTICIPANTS`.
            if room.participants.len() >= room.effective_max_participants() {
                send_to(tx, ServerMessage::RoomFull);
                return Flow::Continue;
            }

            admit_participant(room, &room_id, peer_id.clone(), epub.clone(), tx.clone(), becomes_leader);

            drop(rooms_guard);
            *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
        }

        // Релей: содержимое не разбираем, только маршрутизируем внутри
        // комнаты отправителя (любому другому участнику), подставляя
        // fromPeerId. H2 (DoS-защита): каждый релей сначала проходит общий
        // счётчик частоты (RELAY_RATE_LIMIT, суммарный на все типы релеев
        // этого соединения — см. её комментарий), затем кап на размер payload
        // (RELAY_MAX_BYTES) — в этом порядке, чтобы попытка протащить
        // огромный payload тоже расходовала бюджет частоты, а не обходила
        // rate-limit бесплатно.
        ClientMessage::Offer { target_peer_id, sdp } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&sdp) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Offer {
                    from_peer_id: from,
                    sdp,
                });
            }
        }
        ClientMessage::Answer { target_peer_id, sdp } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&sdp) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Answer {
                    from_peer_id: from,
                    sdp,
                });
            }
        }
        ClientMessage::IceCandidate { target_peer_id, candidate } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&candidate) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::IceCandidate {
                    from_peer_id: from,
                    candidate,
                });
            }
        }
        ClientMessage::StreamInfo { target_peer_id, info } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&info) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::StreamInfo {
                    from_peer_id: from,
                    info,
                });
            }
        }

        ClientMessage::ShareStart => {
            handle_share_start(me, tx, rooms);
        }
        ClientMessage::ShareStop => {
            handle_share_stop(me, rooms);
        }

        ClientMessage::UpdateSettings { settings } => {
            handle_update_settings(settings, me, tx, rooms);
        }
        ClientMessage::Approve { peer_id } => {
            handle_approve(peer_id, me, tx, rooms);
        }
        ClientMessage::Reject { peer_id } => {
            handle_reject(peer_id, me, tx, rooms);
        }

        ClientMessage::Leave => return Flow::Stop,

        ClientMessage::NameAnnounce { to, payload } => {
            handle_name_announce(to, payload, me, tx, rooms, rate_limits);
        }
    }
    Flow::Continue
}

/// Общая часть приёма участника в комнату напрямую (минуя лобби): либо
/// потому что он стал лидером, либо потому что лобби выключено (или его для
/// данного входа не применили). Вставляет участника, назначает лидера (если
/// стал им), уведомляет остальных `peer-joined` и шлёт самому вошедшему
/// `joined` — с текущими pending-заявками ТОЛЬКО если он лидер, иначе с
/// пустым списком.
///
/// `name` больше не параметр (было мёртвое поле — сервер его не хранит, см.
/// docs/research-minimize-state.md §3): и в `peers[]`/`peer-joined`
/// подставляется `None`/`null` безусловно.
fn admit_participant(
    room: &mut Room,
    room_id: &str,
    peer_id: String,
    epub: Option<String>,
    tx: PeerTx,
    becomes_leader: bool,
) {
    // Другие уже подключённые участники — до вставки нового.
    let peers: Vec<PeerInfo> = room
        .participants
        .iter()
        .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect();
    let screen_owner = room.screen_owner.clone();

    room.participants.insert(
        peer_id.clone(),
        Participant { tx: tx.clone(), epub: epub.clone(), joined_at: Instant::now() },
    );
    // Вход в опустевшую-но-живую комнату снимает отметку TTL.
    room.emptied_at = None;

    if becomes_leader {
        room.leader_id = Some(peer_id.clone());
    }
    let leader_id = room.leader_id.clone().unwrap_or_else(|| peer_id.clone());

    let count = room.participants.len();
    info!(room = %room_id, peer = %peer_id, count, "участник подключился");

    // Уведомляем остальных о новом участнике; сам новый участник узнаёт о
    // них через список `peers` в своём `joined`.
    for (id, p) in room.participants.iter() {
        if id != &peer_id {
            send_to(&p.tx, ServerMessage::PeerJoined {
                peer_id: peer_id.clone(),
                name: None,
                epub: epub.clone(),
            });
        }
    }

    // Ожидающие в лобби видны ТОЛЬКО самому лидеру — остальным пустой список.
    // Порядок — по времени подачи заявки (`joined_at`), старейшая первой.
    let pending = if becomes_leader {
        pending_sorted_by_arrival(room)
    } else {
        Vec::new()
    };

    send_to(&tx, ServerMessage::Joined {
        peer_id,
        peers,
        screen_owner,
        leader_id,
        settings: room.settings.clone(),
        pending,
        expires_in_seconds: room_expires_in_seconds(room),
        // D: эффективный лимит комнаты (лидерский, если задан, иначе
        // серверный потолок), см. `Room::effective_max_participants`.
        max_participants: room.effective_max_participants(),
    });

    // Истории чата сервер новичку больше не шлёт: чат целиком на mesh
    // RTCDataChannel, историю новичок запрашивает сам у соседей по шине (см.
    // `static/chat.js`) — сервер её не хранит.
}

/// Текущие заявки лобби, отсортированные по времени подачи (`joined_at`,
/// старейшая первой) — используется и для `Joined::pending` лидера, и при
/// переносе заявок новому лидеру после смены (см. `cleanup_peer`). `name`
/// сервер больше не хранит — всегда `None` (см. комментарий модуля
/// protocol.rs).
fn pending_sorted_by_arrival(room: &Room) -> Vec<PendingInfo> {
    let mut items: Vec<_> = room.pending.iter().collect();
    items.sort_by_key(|(_, p)| p.joined_at);
    items
        .into_iter()
        .map(|(id, p)| PendingInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect()
}

/// A/D: реконнект СВОИМ прежним `peerId`, который прямо сейчас занимает слот
/// полноценного участника этой же комнаты. Типичная причина — клиент потерял
/// только сигналинг-WS (не mesh, см. docs/self-hosting.md §7.2) и успел
/// переподключиться быстрее, чем сервер хартбитом (до `PING_INTERVAL *
/// MAX_MISSED_PONGS`, ~40-60с) обнаружил обрыв старого соединения: старая
/// запись `Participant` всё это время «зомби» — числится занятой, но её `tx`
/// уже никто не читает на другом конце. Заводить для такого реконнекта НОВЫЙ
/// слот (как раньше — коллизия peerId просто генерировала новый) означает:
/// (а) ложный `room-full`/`effective_max_participants` именно в комнатах с
/// маленьким лидерским лимитом (см. docs/research-room-limit.md §4 — это и
/// есть тот «тонкий момент», который там явно предупреждён), (б) расход
/// per-IP бюджета `JOIN_ROOM_IP_LIMIT` за легитимное действие.
///
/// Что делаем: заменяем `tx` в СУЩЕСТВУЮЩЕЙ записи новым каналом. `joined_at`
/// НЕ трогаем — иначе реконнект перепрыгнул бы очередь на лидерство
/// относительно участников, вошедших раньше него, но позже его первого
/// входа. `epub` тоже НЕ трогаем: остальные участники уже получили
/// `peer-joined` с ПРЕЖНИМ `epub` этого пира и вывели попарные E2E-ключи из
/// него (см. docs/e2e-encryption.md) — подменить значение сейчас означало бы
/// разъехаться по ключам с уже сидящими участниками; рассылать всем новый
/// `peer-joined` для того, кто и не уходил с их точки зрения, тоже не нужно
/// — membership для них не изменился.
///
/// Старое (замещённое) соединение само по себе не трогаем — его собственный
/// `handle_socket`-цикл рано или поздно завершится сам (хартбит или просто
/// обрыв), и в этот момент его `cleanup_peer` НЕ должен снести чужой, уже
/// перехваченный слот — см. проверку `same_channel` там.
///
/// Доверие к переиспользованию: единственная проверка — совпадение самого
/// `peerId`, а он `Uuid::new_v4()` (128 бит криптослучайности, см.
/// `generate_peer_id`) — угадать чужой практически невозможно, тот же
/// уровень доверия, что уже есть у `leaderToken`. Если он всё же угадан —
/// жертва (если её соединение ещё живо) продолжает получать сообщения по
/// старому каналу до его собственной смерти, а НОВЫЕ сообщения, адресованные
/// ей другими, уходят захватчику: заметный сбой сигналинга для конкретной
/// пары, но не молчаливая утечка контента (SDP/ICE шифруются попарным
/// ключом, выведенным из `epub`, которого захватчик не знает).
///
/// Реконнектящемуся шлём ПОЛНОЦЕННЫЙ свежий `joined` (как при обычном входе)
/// — не no-op: пока сигналинг был оборван, состояние комнаты могло измениться
/// (настройки, лобби, владелец экрана, эффективный лимит) — свежий `joined`
/// даёт клиенту тот же самый ресинк, что уже делает `waiting` при смене
/// лидера (см. `cleanup_peer`). Остальным участникам НИЧЕГО не рассылаем —
/// с их точки зрения этот peerId никуда не уходил (`peer-joined`/`peer-left`
/// не было и не будет).
fn reconnect_participant(room: &mut Room, room_id: &str, peer_id: &str, tx: PeerTx) {
    match room.participants.get_mut(peer_id) {
        Some(participant) => participant.tx = tx.clone(),
        None => return,
    }
    info!(room = %room_id, peer = %peer_id, "реконнект существующего участника (сигналинг переустановлен)");

    let peers: Vec<PeerInfo> = room
        .participants
        .iter()
        .filter(|(id, _)| id.as_str() != peer_id)
        .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect();
    let is_leader = room.leader_id.as_deref() == Some(peer_id);
    let pending = if is_leader { pending_sorted_by_arrival(room) } else { Vec::new() };

    send_to(&tx, ServerMessage::Joined {
        peer_id: peer_id.to_string(),
        peers,
        screen_owner: room.screen_owner.clone(),
        leader_id: room.leader_id.clone().unwrap_or_else(|| peer_id.to_string()),
        settings: room.settings.clone(),
        pending,
        expires_in_seconds: room_expires_in_seconds(room),
        max_participants: room.effective_max_participants(),
    });
}

/// `update-settings`: применяет новые настройки целиком (не патч) — только от
/// лидера, иначе `error`. Рассылает `settings-changed` всем участникам. Если
/// `guest_screen` только что отобрали, а текущий владелец экрана — не лидер,
/// сервер сам останавливает его шаринг (`share-stopped` всем).
///
/// D (docs/research-room-limit.md §2.1): `settings.max_participants`, если
/// `Some(n)`, валидируется — `n` должно быть `2..=crate::MAX_PARTICIPANTS`,
/// иначе весь `update-settings` отклоняется ЦЕЛИКОМ (`error`, ничего не
/// применяется — та же механика «всё или ничего», что у остальных полей
/// `settings`). Нижняя граница 2 (не 1) — комната с лимитом 1 не имеет
/// смысла: лидер не смог бы впустить даже самого себя вторым.
fn handle_update_settings(
    settings: RoomSettings,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can change settings"));
        return;
    }
    if let Some(n) = settings.max_participants {
        if !(2..=*crate::MAX_PARTICIPANTS).contains(&n) {
            send_to(tx, err(&format!(
                "maxParticipants must be between 2 and {} (server limit)",
                *crate::MAX_PARTICIPANTS,
            )));
            return;
        }
    }

    let guest_screen_was_allowed = room.settings.guest_screen;
    room.settings = settings.clone();

    let changed_msg = ServerMessage::SettingsChanged { settings };
    for p in room.participants.values() {
        send_to(&p.tx, changed_msg.clone());
    }

    // Отобрали право шаринга у гостей, пока гость (не лидер) шарит — сервер
    // сам останавливает его.
    if guest_screen_was_allowed && !room.settings.guest_screen {
        if let Some(owner) = room.screen_owner.clone() {
            if room.leader_id.as_deref() != Some(owner.as_str()) {
                room.screen_owner = None;
                let stop_msg = ServerMessage::ShareStopped { peer_id: owner };
                for p in room.participants.values() {
                    send_to(&p.tx, stop_msg.clone());
                }
            }
        }
    }
}

/// `approve {peerId}`: только лидер, только по действующей заявке в
/// `room.pending`. Переносит ожидающего в участники (тем же `tx`), шлёт ему
/// полноценный `joined` и остальным `peer-joined`. Если комната успела
/// заполниться, пока заявка ждала — отклоняем её отдельно (не даём превысить
/// эффективный лимит комнаты, см. `Room::effective_max_participants` — D).
fn handle_approve(target: String, me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can approve"));
        return;
    }
    let Some(pending) = room.pending.remove(&target) else {
        send_to(tx, err("no such pending join request"));
        return;
    };
    if room.participants.len() >= room.effective_max_participants() {
        send_to(&pending.tx, ServerMessage::RoomFull);
        send_to(tx, err("room is full, cannot approve"));
        return;
    }

    let room_id = ctx.room_id.clone();
    admit_participant(room, &room_id, target, pending.epub, pending.tx, false);
}

/// `reject {peerId}`: только лидер, только по действующей заявке. Ожидающему
/// уходит `join-rejected`, писатель его соединения сам закрывает сокет сразу
/// вслед за этим сообщением (см. `reject` в `handle_socket`).
fn handle_reject(target: String, me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can reject"));
        return;
    }
    let Some(pending) = room.pending.remove(&target) else {
        send_to(tx, err("no such pending join request"));
        return;
    };
    send_to(&pending.tx, ServerMessage::JoinRejected {});
}

/// Заявка на шаринг экрана: «последний победил». Если экран свободен —
/// инициатор становится владельцем как и раньше; если его уже держит
/// кто-то другой, заявка НЕ отклоняется, а замещает владельца — экран
/// переходит инициатору, и `share-started` уходит всем участникам, включая
/// прежнего владельца. Прежний владелец узнаёт о перехвате из этого же
/// broadcast (peerId в нём — уже не его) и сам останавливает свой локальный
/// захват (см. `static/room.js`) — отдельное сообщение ему не нужно.
/// Повторная заявка ТЕКУЩЕГО владельца — не-op (ничего не меняем и не
/// рассылаем повторно). Не-лидеру при `guest_screen=false` — отказ с
/// `reason: "forbidden"` (без `busyPeerId`, который теперь не используется
/// вовсе — см. `ServerMessage::ShareRejected`), независимо от того, свободен
/// экран или занят.
fn handle_share_start(me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if !room.participants.contains_key(&ctx.peer_id) {
        send_to(tx, err("not in a room"));
        return;
    }
    let is_leader = room.leader_id.as_deref() == Some(ctx.peer_id.as_str());
    if !is_leader && !room.settings.guest_screen {
        send_to(tx, ServerMessage::ShareRejected { busy_peer_id: None, reason: Some("forbidden".to_string()) });
        return;
    }
    if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
        // Уже владеет экраном — заявка избыточна, ничего не меняем.
        return;
    }
    // Свободен или занят кем-то другим — в обоих случаях инициатор становится
    // новым владельцем ("последний победил"); рассылка всем одинакова.
    room.screen_owner = Some(ctx.peer_id.clone());
    let msg = ServerMessage::ShareStarted { peer_id: ctx.peer_id.clone() };
    for p in room.participants.values() {
        send_to(&p.tx, msg.clone());
    }
}

/// Освобождение экрана. Принимается только от текущего владельца — заявка
/// не от владельца тихо игнорируется (экран остаётся занят как был).
fn handle_share_stop(me: &Option<PeerCtx>, rooms: &SharedRooms) {
    let Some(ctx) = me else { return };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
        room.screen_owner = None;
        let msg = ServerMessage::ShareStopped { peer_id: ctx.peer_id.clone() };
        for p in room.participants.values() {
            send_to(&p.tx, msg.clone());
        }
    }
}

/// Скользящее окно, общее для чат-лимита и релей-лимита (см.
/// `check_rate_limit`/`check_relay_rate_limit`): не более `limit` меток за
/// `window`. Возвращает `true`, если ещё одна метка разрешена (и тогда
/// регистрирует её).
fn sliding_window_ok(times: &mut VecDeque<Instant>, limit: usize, window: Duration) -> bool {
    let now = Instant::now();
    while let Some(&oldest) = times.front() {
        if now.duration_since(oldest) > window {
            times.pop_front();
        } else {
            break;
        }
    }
    if times.len() >= limit {
        return false;
    }
    times.push_back(now);
    true
}

/// H2 (DoS-защита): общий скользящий счётчик на ВСЕ релеи соединения
/// суммарно (offer/answer/ice-candidate/stream-info) — см. `RELAY_RATE_LIMIT`.
fn check_relay_rate_limit(relay_times: &mut VecDeque<Instant>) -> bool {
    sliding_window_ok(relay_times, RELAY_RATE_LIMIT, RELAY_RATE_WINDOW)
}

/// H2 (DoS-защита): сериализованный размер payload релея (`sdp`/`candidate`/
/// `info`) превышает `RELAY_MAX_BYTES`? Сервер эти значения не разбирает, но
/// должен ограничить их размер — см. `RELAY_MAX_BYTES`.
fn relay_payload_too_large(value: &Value) -> bool {
    let size = serde_json::to_string(value).map(|s| s.len()).unwrap_or(usize::MAX);
    size > RELAY_MAX_BYTES
}

/// Остаток жизни комнаты в секундах на текущий момент (лимит длительности
/// созвона, см. docs/security.md, «Meeting Duration Ceiling») — `MAX_ROOM_LIFETIME`
/// минус возраст комнаты, зажатый снизу в 0. Используется в `Joined`, чтобы
/// клиент мог сам показать обратный отсчёт/предупреждение.
fn room_expires_in_seconds(room: &Room) -> u64 {
    crate::MAX_ROOM_LIFETIME
        .checked_sub(room.created_at.elapsed())
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

/// `epub` (E2E v2): непустая строка после trim, не длиннее `EPUB_MAX_CHARS`
/// символов — иначе (пусто, отсутствует вовсе, слишком длинная) `None`.
/// Сервер содержимое НЕ парсит (опак, как `sdp`/`candidate`) — единственная
/// его забота — не пропустить откровенно неадекватный размер. НЕ обрезаем
/// слишком длинное значение, а отбрасываем целиком: обрезанный публичный
/// ключ не будет соответствовать ни одному валидному ключу, так что "почти
/// правильный, но обрезанный" эфемерный эпаб бесполезен и только маскирует
/// ошибку клиента.
///
/// (`name` в `join-room` больше не санитизируется/не хранится вовсе — см.
/// docs/research-minimize-state.md §3 и комментарий у
/// `crate::state::Participant`: поле мёртвое у всех v2-клиентов, сервер
/// просто игнорирует присланное значение целиком.)
fn sanitize_epub(epub: Option<String>) -> Option<String> {
    let raw = epub?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > EPUB_MAX_CHARS {
        return None;
    }
    Some(trimmed.to_string())
}

/// Доставить сообщение пиру `target` в комнате отправителя (любому другому
/// участнику — топология симметричная, mesh).
/// Неизвестный targetPeerId тихо игнорируется: это штатная гонка — пир мог
/// отвалиться, пока сообщение летело.
fn relay<F>(me: &Option<PeerCtx>, rooms: &SharedRooms, tx: &PeerTx, target: &str, build: F)
where
    F: FnOnce(String) -> ServerMessage,
{
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let rooms = rooms.lock().unwrap();
    let Some(room) = rooms.get(&ctx.room_id) else {
        debug!(room = %ctx.room_id, "релей в уже удалённую комнату — игнорируем");
        return;
    };
    // Ожидающий одобрения в лобби (см. `Room::pending`) — ещё не участник,
    // ему релей недоступен (ни как отправителю, ни как получателю — вторых
    // тут проверять не нужно, он не окажется в `room.participants`).
    if !room.participants.contains_key(&ctx.peer_id) {
        send_to(tx, err("not in a room"));
        return;
    }
    match room.participants.get(target) {
        Some(p) => send_to(&p.tx, build(ctx.peer_id.clone())),
        None => debug!(target = %target, "релей на неизвестный peerId — игнорируем"),
    }
}

/// `name-announce` (E2E v2, см. комментарий модуля `protocol.rs`): релей
/// зашифрованного анонса имени пиру `to`. В отличие от `relay()` выше,
/// отправителем МОЖЕТ быть не только полноценный участник, но и ожидающий в
/// лобби (`Room::pending`) — единственный случай во всём протоколе, когда
/// pending может САМ инициировать релей, а не только пассивно получать
/// `waiting`/`join-rejected` и т.п. Права:
///   - участник комнаты → любому другому участнику той же комнаты (как
///     обычный `relay()`); неизвестный `to` — тихо игнорируем (та же гонка,
///     что и в `relay()` — целевой пир мог уже отвалиться);
///   - ожидающий в лобби → ТОЛЬКО текущему лидеру комнаты (у него и так нет
///     видимости других участников) — иное `to` не гонка, а нарушение прав,
///     поэтому явный `error` отправителю (тот же паттерн, что у
///     `update-settings`/`approve`/`reject` от не-лидера), а не тихий дроп;
///   - ни участник, ни pending (сокет уже выпал из комнаты в обоих смыслах,
///     не должно происходить в штатной работе) — `error`, как у `relay()`.
///
/// Каппы (H2, DoS-защита): общий relay rate-limit (тот же счётчик, что у
/// offer/answer/ICE/stream-info) и `NAME_ANNOUNCE_MAX_BYTES` на размер
/// `payload` — в этом порядке, по тем же соображениям, что у
/// `relay_payload_too_large` в `handle_message`.
fn handle_name_announce(
    to: String,
    payload: String,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    rate_limits: &mut RateLimits,
) {
    if !check_relay_rate_limit(&mut rate_limits.relay_times) {
        send_to(tx, err("too many messages, slow down"));
        return;
    }
    if payload.len() > NAME_ANNOUNCE_MAX_BYTES {
        send_to(tx, err("payload too large (max 2KB)"));
        return;
    }
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get(&ctx.room_id) else {
        debug!(room = %ctx.room_id, "name-announce в уже удалённую комнату — игнорируем");
        return;
    };

    if room.participants.contains_key(&ctx.peer_id) {
        match room.participants.get(&to) {
            Some(p) => send_to(&p.tx, ServerMessage::NameAnnounce { from: ctx.peer_id.clone(), payload }),
            None => debug!(target = %to, "name-announce на неизвестный peerId — игнорируем"),
        }
        return;
    }

    if room.pending.contains_key(&ctx.peer_id) {
        if room.leader_id.as_deref() == Some(to.as_str()) {
            match room.leader_id.as_ref().and_then(|id| room.participants.get(id)) {
                Some(leader) => send_to(&leader.tx, ServerMessage::NameAnnounce { from: ctx.peer_id.clone(), payload }),
                // Лидер значится в `room.leader_id`, но не найден среди
                // участников — на практике не должно происходить (уход
                // лидера снимает `leader_id` синхронно, см. `cleanup_peer`),
                // но не паникуем на рассинхроне инвариантов.
                None => debug!(leader = %to, "name-announce лидеру, которого не оказалось среди участников — игнорируем"),
            }
        } else {
            send_to(tx, err("pending participants can only send name-announce to the room leader"));
        }
        return;
    }

    send_to(tx, err("not in a room"));
}

/// Убрать пира из комнаты и уведомить остальных. Пир мог быть либо полным
/// участником, либо ожидающим одобрения в лобби (`Room::pending`) — это
/// взаимоисключающие карты, обрабатываем по очереди.
///
/// Для участника: если он шарил экран — сначала `share-stopped` всем
/// оставшимся; если он был лидером — сервер детерминированно назначает
/// нового (участника с самым ранним `joined_at`) и рассылает
/// `leader-changed`, а накопленные заявки лобби пересылает новому лидеру
/// заново (`join-request` за каждую); затем (если кто-то остался)
/// `peer-left`. Если комната опустела — не удаляем её сразу, а помечаем
/// момент опустошения: реапер удалит её позже, если никто не подключится до
/// истечения TTL (см. `state::reap_rooms`); все ещё живые заявки
/// лобби в этот момент отклоняются (`join-rejected` + закрытие сокета) —
/// одобрять их больше некому.
///
/// Для ожидающего в лобби: просто убираем из `pending` и, если лидер ещё
/// есть, уведомляем его `join-request-cancelled`.
///
/// `tx` — канал ИМЕННО ЭТОГО (закрывающегося) соединения (см. A/D,
/// `reconnect_participant`): реконнект мог УЖЕ забрать `ctx.peer_id` себе,
/// заменив `tx` в `room.participants` на канал нового, более свежего
/// соединения, пока СТАРОЕ (это) соединение просто ещё не успело завершить
/// свой собственный `handle_socket`-цикл (хартбит истекает не мгновенно).
/// Если это произошло — слот больше не принадлежит этому вызову: не трогаем
/// участника вовсе (ни удаления, ни `peer-left`/`leader-changed` за чужое,
/// уже живое соединение) — сравниваем каналы через `same_channel`
/// (`tokio::sync::mpsc::UnboundedSender::same_channel`), а не сам факт
/// наличия записи.
fn cleanup_peer(ctx: &PeerCtx, rooms: &SharedRooms, tx: &PeerTx) {
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else { return };

    if let Some(participant) = room.participants.get(&ctx.peer_id) {
        if !participant.tx.same_channel(tx) {
            debug!(room = %ctx.room_id, peer = %ctx.peer_id,
                "закрывается уже замещённое реконнектом соединение — слот не трогаем");
            return;
        }
    }

    if room.participants.remove(&ctx.peer_id).is_some() {
        if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
            room.screen_owner = None;
            let msg = ServerMessage::ShareStopped { peer_id: ctx.peer_id.clone() };
            for p in room.participants.values() {
                send_to(&p.tx, msg.clone());
            }
        }

        let was_leader = room.leader_id.as_deref() == Some(ctx.peer_id.as_str());
        if was_leader {
            let new_leader = room
                .participants
                .iter()
                .min_by_key(|(_, p)| p.joined_at)
                .map(|(id, _)| id.clone());
            room.leader_id = new_leader.clone();
            if let Some(new_leader_id) = new_leader {
                info!(room = %ctx.room_id, leader = %new_leader_id, "лидер ушёл — назначен новый");
                let msg = ServerMessage::LeaderChanged { leader_id: new_leader_id.clone() };
                for p in room.participants.values() {
                    send_to(&p.tx, msg.clone());
                }
                // Заявки лобби наследуются новым лидером — пересылаем их ему
                // заново (в порядке подачи), он их ещё не видел. Заодно (E2E
                // v2, см. `ServerMessage::Waiting`) каждому висящему pending
                // шлём СВЕЖИЙ `waiting` с новым лидером и его `epub` — старый
                // ключ, выведенный на прежнего лидера, для нового не годится,
                // а без свежего `waiting` pending не узнает, кому переслать
                // `name-announce`.
                if !room.pending.is_empty() {
                    let new_leader_epub = room
                        .participants
                        .get(&new_leader_id)
                        .and_then(|p| p.epub.clone());
                    let waiting_msg = ServerMessage::Waiting {
                        leader_peer_id: new_leader_id.clone(),
                        leader_epub: new_leader_epub,
                    };
                    for p in room.pending.values() {
                        send_to(&p.tx, waiting_msg.clone());
                    }

                    let pending = pending_sorted_by_arrival(room);
                    if let Some(new_leader) = room.participants.get(&new_leader_id) {
                        for p in pending {
                            send_to(&new_leader.tx, ServerMessage::JoinRequest {
                                peer_id: p.peer_id,
                                name: p.name,
                                epub: p.epub,
                            });
                        }
                    }
                }
            }
        }

        if room.participants.is_empty() {
            room.emptied_at = Some(Instant::now());
            // Некому больше одобрять — отклоняем всех, кто ещё ждал.
            for (_, pend) in room.pending.drain() {
                send_to(&pend.tx, ServerMessage::JoinRejected {});
            }
            info!(room = %ctx.room_id, "комната опустела, ожидает TTL перед удалением");
        } else {
            info!(room = %ctx.room_id, peer = %ctx.peer_id, "участник отключился");
            let msg = ServerMessage::PeerLeft { peer_id: ctx.peer_id.clone() };
            for p in room.participants.values() {
                send_to(&p.tx, msg.clone());
            }
        }
        return;
    }

    if room.pending.remove(&ctx.peer_id).is_some() {
        info!(room = %ctx.room_id, peer = %ctx.peer_id, "ожидающий отвалился, заявка снята");
        if let Some(leader_id) = room.leader_id.clone() {
            if let Some(leader) = room.participants.get(&leader_id) {
                send_to(&leader.tx, ServerMessage::JoinRequestCancelled { peer_id: ctx.peer_id.clone() });
            }
        }
    }
    // Иначе пир уже не в комнате ни в каком виде — нечего делать.
}

fn err(message: &str) -> ServerMessage {
    ServerMessage::Error { message: message.to_string() }
}
