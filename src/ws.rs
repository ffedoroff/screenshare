//! Обработка WebSocket-соединений: сигналинг-релей, чат и жизненный цикл комнат.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
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
    PendingParticipant, Participant, PeerTx, Room, SharedRooms, MAX_PARTICIPANTS, MAX_PENDING,
    PENDING_JOIN_IP_LIMIT, PENDING_JOIN_IP_WINDOW,
};

/// Лимит на fallback-релей чата (см. `ClientMessage::Chat`): не более
/// `CHAT_RATE_LIMIT` сообщений за `CHAT_RATE_WINDOW` с одного соединения.
/// Основной путь чата (mesh RTCDataChannel) через сервер не идёт вообще и
/// этому лимиту не подчиняется — см. `static/chat.js` (клиентский, мягкий
/// rate-limit 10/10с там же, независимо от этого серверного). Простой
/// скользящий счётчик, без сторонних крейтов.
const CHAT_RATE_LIMIT: usize = 10;
const CHAT_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Максимальный размер сериализованного JSON конверта чата (`envelope`) в
/// байтах — сервер не разбирает содержимое, но обязан ограничить размер,
/// чтобы fallback-релей нельзя было использовать для перекачки произвольных
/// объёмов данных через сервер.
const CHAT_ENVELOPE_MAX_BYTES: usize = 8 * 1024;

/// Максимальная длина отображаемого имени в символах.
///
/// Ш1 (E2E-шифрование, см. static/crypto.js/room.js): `name` теперь — не
/// открытый текст, а шифрблоб (base64: iv + AES-256-GCM ciphertext, см.
/// `RoomCrypto.encryptToBase64`) под ключом, выведенным из секрета `k`,
/// известного только участникам (сервер его не видит и не может видеть) —
/// поэтому сервер больше не понимает содержимое этого поля вообще и не
/// может проверить, что это осмысленное «имя»: единственная содержательная
/// проверка, которая ему тут по силам — не пропустить откровенно
/// неадекватный размер и управляющие символы. Лимит поднят с прежних 32
/// (когда поле было настоящим именем) до 512 — шифртекст всегда длиннее
/// исходного открытого имени (12 байт iv + до 16 байт GCM-тега + base64
/// накладывает ~33% сверху), 512 символов даёт большой запас даже для имён
/// у верхней границы `maxlength` инпута (см. static/room.html).
const CHAT_NAME_MAX_CHARS: usize = 512;

/// H2 (DoS-защита): максимальный размер сериализованного payload одного
/// релея offer/answer/ice-candidate/stream-info (`sdp`/`candidate`/`info`
/// соответственно) в байтах. Сервер эти поля не разбирает (опаковый JSON),
/// но обязан ограничить размер — иначе релей превращается в бесплатный канал
/// перекачки произвольных объёмов данных через сервер под видом сигналинга.
/// Отдельно от `CHAT_ENVELOPE_MAX_BYTES` (8КБ) — легитимный offer с
/// несколькими медиалиниями крупнее заведомо крошечного чат-конверта.
const RELAY_MAX_BYTES: usize = 16 * 1024;

/// H2 (DoS-защита): скользящее окно rate-limit НА ВСЕ релеи одного
/// соединения суммарно — offer/answer/ice-candidate/stream-info И chat
/// (адресный fallback) вместе, единым счётчиком. Обоснование объединения (а
/// не отдельного счётчика на каждый тип): вектор атаки один и тот же
/// (флудить сообщениями с одного соединения) независимо от того, какой
/// именно тип релея используется — раздельные счётчики позволили бы
/// обойти лимит одного типа, просто чередуя типы сообщений. `chat` у себя
/// ДОПОЛНИТЕЛЬНО подчиняется более строгому специфическому лимиту
/// (`CHAT_RATE_LIMIT`, 10/10с) — этот общий лимит (100/10с) шире и в первую
/// очередь защищает от флуда ICE-кандидатами (их бывает много легитимно при
/// установке соединения — 100 за 10с должно перекрывать нормальный
/// trickle-ICE с запасом).
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

/// Оба скользящих окна rate-limit одного соединения — чат-специфичное
/// (`CHAT_RATE_LIMIT`) и общее на все релеи суммарно (`RELAY_RATE_LIMIT`) —
/// сгруппированы в одну структуру, а не переданы в `handle_message` двумя
/// отдельными параметрами, просто чтобы не раздувать её сигнатуру дальше.
#[derive(Default)]
struct RateLimits {
    chat_times: VecDeque<Instant>,
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
                                    &ip, &state.pending_join_ips,
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

    // Чистка при любом исходе: leave, close, обрыв.
    if let Some(ctx) = me {
        cleanup_peer(&ctx, &state.rooms);
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
) -> Flow {
    match msg {
        ClientMessage::JoinRoom { room_id, name, peer_id, leader_token } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let name = sanitize_name(name);

            let mut rooms_guard = rooms.lock().unwrap();
            let Some(room) = rooms_guard.get_mut(&room_id) else {
                send_to(tx, ServerMessage::RoomNotFound); // комната не создана или уже удалена реапером
                return Flow::Continue; // сокет закроет писатель
            };

            // Клиентский peerId (переподключение после обрыва сигналинга, см.
            // ClientMessage::JoinRoom) — принимаем, только если валидный UUID
            // и ещё свободен в этой комнате (ни среди участников, ни среди
            // ожидающих в лобби); иначе как раньше генерируем новый.
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
                    PendingParticipant { tx: tx.clone(), name: name.clone(), joined_at: Instant::now() },
                );
                info!(room = %room_id, peer = %peer_id, "участник ждёт одобрения в лобби");
                send_to(tx, ServerMessage::Waiting {});
                if let Some(leader_id) = room.leader_id.clone() {
                    if let Some(leader) = room.participants.get(&leader_id) {
                        send_to(&leader.tx, ServerMessage::JoinRequest {
                            peer_id: peer_id.clone(),
                            name: name.clone(),
                        });
                    }
                }
                drop(rooms_guard);
                *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
                return Flow::Continue;
            }

            if room.participants.len() >= MAX_PARTICIPANTS {
                send_to(tx, ServerMessage::RoomFull);
                return Flow::Continue;
            }

            admit_participant(room, &room_id, peer_id.clone(), name.clone(), tx.clone(), becomes_leader);

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

        ClientMessage::Chat { target_peer_id, envelope } => {
            handle_chat(target_peer_id, envelope, me, tx, rooms, rate_limits);
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
    }
    Flow::Continue
}

/// Общая часть приёма участника в комнату напрямую (минуя лобби): либо
/// потому что он стал лидером, либо потому что лобби выключено (или его для
/// данного входа не применили). Вставляет участника, назначает лидера (если
/// стал им), уведомляет остальных `peer-joined` и шлёт самому вошедшему
/// `joined` — с текущими pending-заявками ТОЛЬКО если он лидер, иначе с
/// пустым списком.
fn admit_participant(
    room: &mut Room,
    room_id: &str,
    peer_id: String,
    name: Option<String>,
    tx: PeerTx,
    becomes_leader: bool,
) {
    // Другие уже подключённые участники — до вставки нового.
    let peers: Vec<PeerInfo> = room
        .participants
        .iter()
        .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: p.name.clone() })
        .collect();
    let screen_owner = room.screen_owner.clone();

    room.participants.insert(
        peer_id.clone(),
        Participant { tx: tx.clone(), name: name.clone(), joined_at: Instant::now() },
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
                name: name.clone(),
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
    });

    // Истории чата сервер новичку больше не шлёт: чат целиком на mesh
    // RTCDataChannel, историю новичок запрашивает сам у соседей по шине (см.
    // `static/chat.js`) — сервер её не хранит.
}

/// Текущие заявки лобби, отсортированные по времени подачи (`joined_at`,
/// старейшая первой) — используется и для `Joined::pending` лидера, и при
/// переносе заявок новому лидеру после смены (см. `cleanup_peer`).
fn pending_sorted_by_arrival(room: &Room) -> Vec<PendingInfo> {
    let mut items: Vec<_> = room.pending.iter().collect();
    items.sort_by_key(|(_, p)| p.joined_at);
    items
        .into_iter()
        .map(|(id, p)| PendingInfo { peer_id: id.clone(), name: p.name.clone() })
        .collect()
}

/// `update-settings`: применяет новые настройки целиком (не патч) — только от
/// лидера, иначе `error`. Рассылает `settings-changed` всем участникам. Если
/// `guest_screen` только что отобрали, а текущий владелец экрана — не лидер,
/// сервер сам останавливает его шаринг (`share-stopped` всем).
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
/// `room.pending`. Переносит ожидающего в участники (тем же `tx`/`name`),
/// шлёт ему полноценный `joined` и остальным `peer-joined`. Если комната
/// успела заполниться, пока заявка ждала — отклоняем её отдельно (не даём
/// превысить `MAX_PARTICIPANTS`).
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
    if room.participants.len() >= MAX_PARTICIPANTS {
        send_to(&pending.tx, ServerMessage::RoomFull);
        send_to(tx, err("room is full, cannot approve"));
        return;
    }

    let room_id = ctx.room_id.clone();
    admit_participant(room, &room_id, target, pending.name, pending.tx, false);
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

/// Заявка на шаринг экрана: удовлетворяется, только если экран сейчас
/// свободен. Если уже занят — отказ (`share-rejected`) только инициатору,
/// без рассылки остальным. Повторная заявка текущего владельца — не-op.
/// Не-лидеру при `guest_screen=false` — отказ с `reason: "forbidden"`
/// (без `busyPeerId`), независимо от того, свободен экран или нет.
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
    match &room.screen_owner {
        None => {
            room.screen_owner = Some(ctx.peer_id.clone());
            let msg = ServerMessage::ShareStarted { peer_id: ctx.peer_id.clone() };
            for p in room.participants.values() {
                send_to(&p.tx, msg.clone());
            }
        }
        Some(owner) if owner == &ctx.peer_id => {
            // Уже владеет экраном — заявка избыточна, ничего не меняем.
        }
        Some(owner) => {
            send_to(tx, ServerMessage::ShareRejected { busy_peer_id: Some(owner.clone()), reason: None });
        }
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

/// Обработка `chat` (адресный fallback-релей, см. `ClientMessage::Chat`):
/// rate-limit + проверка размера конверта, затем релей `target_peer_id`
/// один-в-один как `offer`/`answer`/`stream-info` — сервер содержимое
/// `envelope` не разбирает и нигде не хранит (ни в памяти комнаты, ни тем
/// более на диске). Основной путь чата — mesh RTCDataChannel напрямую между
/// участниками, сюда попадают только сообщения к пирам, у которых шина ещё
/// не открыта.
fn handle_chat(
    target_peer_id: String,
    envelope: Value,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    rate_limits: &mut RateLimits,
) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };

    // Право на чат: лидеру всегда можно, гостю — только если не отобрано
    // настройками комнаты (`guest_chat`).
    {
        let rooms_guard = rooms.lock().unwrap();
        if let Some(room) = rooms_guard.get(&ctx.room_id) {
            let is_leader = room.leader_id.as_deref() == Some(ctx.peer_id.as_str());
            if !is_leader && !room.settings.guest_chat {
                drop(rooms_guard);
                send_to(tx, err("чат запрещён лидером"));
                return;
            }
        }
    }

    // H2 (DoS-защита): общий релей-лимит (все типы релеев суммарно) — раньше
    // специфичного чат-лимита ниже и раньше проверки размера, тем же
    // порядком, что и в offer/answer/ice/stream-info (см. их комментарий):
    // расходует бюджет частоты даже для сообщений, отклонённых позже.
    if !check_relay_rate_limit(&mut rate_limits.relay_times) {
        send_to(tx, err("too many messages, slow down"));
        return;
    }

    if !check_rate_limit(&mut rate_limits.chat_times) {
        send_to(tx, err("too many chat messages, slow down"));
        return;
    }

    let size = serde_json::to_vec(&envelope).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > CHAT_ENVELOPE_MAX_BYTES {
        send_to(tx, err("chat envelope too large (max 8KB)"));
        return;
    }

    relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Chat {
        from_peer_id: from,
        envelope,
    });
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

/// Скользящий счётчик: не более `CHAT_RATE_LIMIT` сообщений за
/// `CHAT_RATE_WINDOW` с одного соединения. Возвращает `true`, если сообщение
/// разрешено (и тогда регистрирует его метку времени). Специфичный для
/// адресного fallback-чата лимит — строже общего релей-лимита ниже.
fn check_rate_limit(chat_times: &mut VecDeque<Instant>) -> bool {
    sliding_window_ok(chat_times, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW)
}

/// H2 (DoS-защита): общий скользящий счётчик на ВСЕ релеи соединения
/// суммарно (offer/answer/ice-candidate/stream-info/chat) — см.
/// `RELAY_RATE_LIMIT`.
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
/// созвона, см. README.md «Лимит длительности созвона») — `MAX_ROOM_LIFETIME`
/// минус возраст комнаты, зажатый снизу в 0. Используется в `Joined`, чтобы
/// клиент мог сам показать обратный отсчёт/предупреждение.
fn room_expires_in_seconds(room: &Room) -> u64 {
    crate::MAX_ROOM_LIFETIME
        .checked_sub(room.created_at.elapsed())
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

/// `name`: trim, вырезать управляющие символы, обрезать до
/// `CHAT_NAME_MAX_CHARS` символов; пустое после очистки — `None`. С Ш1 это
/// шифрблоб (см. CHAT_NAME_MAX_CHARS выше), но сама санитизация (trim +
/// вырезание control-символов) безвредна и для base64 — там таких символов
/// не бывает — и оставлена как есть, а не убрана вовсе: это дешёвая защита
/// от совсем уж некорректных байтов, даже если клиент когда-нибудь пришлёт
/// что-то, не являющееся валидным шифрблобом.
fn sanitize_name(name: Option<String>) -> Option<String> {
    let raw = name?;
    let cleaned: String = raw.trim().chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(CHAT_NAME_MAX_CHARS).collect())
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
fn cleanup_peer(ctx: &PeerCtx, rooms: &SharedRooms) {
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else { return };

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
                // заново (в порядке подачи), он их ещё не видел.
                if !room.pending.is_empty() {
                    let pending = pending_sorted_by_arrival(room);
                    if let Some(new_leader) = room.participants.get(&new_leader_id) {
                        for p in pending {
                            send_to(&new_leader.tx, ServerMessage::JoinRequest {
                                peer_id: p.peer_id,
                                name: p.name,
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
