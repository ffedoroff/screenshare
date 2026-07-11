//! Обработка WebSocket-соединений: сигналинг-релей, чат и жизненный цикл комнат.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::db::{self, ChatWriteJob, ChatWriteTx};
use crate::protocol::{ClientMessage, PeerInfo, ServerMessage};
use crate::state::{
    generate_peer_id, now_ms, send_to, AppState, Participant, PeerTx, SharedRooms,
    MAX_PARTICIPANTS,
};

/// Лимит на чат: не более `CHAT_RATE_LIMIT` сообщений за `CHAT_RATE_WINDOW`
/// с одного соединения. Простой скользящий счётчик, без сторонних крейтов.
const CHAT_RATE_LIMIT: usize = 10;
const CHAT_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Максимальная длина текста сообщения чата в символах (не байтах).
const CHAT_TEXT_MAX_CHARS: usize = 2000;
/// Максимальная длина отображаемого имени в символах.
const CHAT_NAME_MAX_CHARS: usize = 32;

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
    /// Имя для чата, задаётся при join-room.
    name: Option<String>,
}

/// Что делать с соединением после обработки сообщения.
#[derive(PartialEq)]
enum Flow {
    Continue,
    /// Закрыть сокет (после того как писатель дошлёт всё из очереди).
    Stop,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state.rooms, state.db, state.chat_tx))
}

/// Одно WS-соединение = одна задача tokio. Исходящие сообщения пиру идут
/// через mpsc-канал: другие задачи кладут в канал, а писать в сокет может
/// только эта задача (select ниже) — так исключаются гонки записи.
async fn handle_socket(mut socket: WebSocket, rooms: SharedRooms, db: SqlitePool, chat_tx: ChatWriteTx) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    // Комната/пир этого соединения; None до join-room.
    let mut me: Option<PeerCtx> = None;
    // Взводится, когда очередь исходящих надо дослать и закрыть сокет.
    let mut closing = false;
    // Метки времени последних отправленных чат-сообщений этого соединения
    // (скользящее окно для rate-limit).
    let mut chat_times: VecDeque<Instant> = VecDeque::new();

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
                // После отказа сервер сам закрывает сокет (edge-кейс №3/№4).
                let reject = matches!(msg, ServerMessage::RoomFull | ServerMessage::RoomNotFound);
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
                                    msg, &mut me, &tx, &rooms, &db, &chat_tx, &mut chat_times,
                                ).await;
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
        cleanup_peer(&ctx, &rooms);
    }
}

/// Обработка одного сообщения клиента.
///
/// Асинхронна из-за обращений к БД (чтение истории при `join-room`) — но, как
/// и раньше, ни одно `.await` не происходит ПОКА держится `std::sync::Mutex`
/// над комнатами: критические секции остаются короткими и синхронными, а DB
/// I/O — строго до захвата мьютекса или уже после его освобождения.
async fn handle_message(
    msg: ClientMessage,
    me: &mut Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    db: &SqlitePool,
    chat_tx: &ChatWriteTx,
    chat_times: &mut VecDeque<Instant>,
) -> Flow {
    match msg {
        ClientMessage::JoinRoom { room_id, name } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let name = sanitize_name(name);

            // Синхронная часть целиком под мьютексом, без .await внутри.
            let session_id = {
                let mut rooms_guard = rooms.lock().unwrap();
                let Some(room) = rooms_guard.get_mut(&room_id) else {
                    send_to(tx, ServerMessage::RoomNotFound); // комната не создана или уже удалена реапером
                    return Flow::Continue; // сокет закроет писатель
                };
                if room.participants.len() >= MAX_PARTICIPANTS {
                    send_to(tx, ServerMessage::RoomFull);
                    return Flow::Continue;
                }

                let peer_id = generate_peer_id();

                // Другие уже подключённые участники — до вставки нового.
                let peers: Vec<PeerInfo> = room
                    .participants
                    .iter()
                    .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: p.name.clone() })
                    .collect();
                let screen_owner = room.screen_owner.clone();

                room.participants.insert(
                    peer_id.clone(),
                    Participant { tx: tx.clone(), name: name.clone() },
                );
                // Вход в опустевшую-но-живую комнату снимает отметку TTL.
                room.emptied_at = None;

                let count = room.participants.len();
                info!(room = %room_id, peer = %peer_id, count, "участник подключился");

                // Уведомляем остальных о новом участнике; сам новый участник
                // узнаёт о них через список `peers` в своём `joined`.
                for (id, p) in room.participants.iter() {
                    if id != &peer_id {
                        send_to(&p.tx, ServerMessage::PeerJoined {
                            peer_id: peer_id.clone(),
                            name: name.clone(),
                        });
                    }
                }
                send_to(tx, ServerMessage::Joined { peer_id: peer_id.clone(), peers, screen_owner });

                let session_id = room.session_id;
                *me = Some(PeerCtx { room_id: room_id.clone(), peer_id, name });
                session_id
            };

            // История чата — сразу после `joined`, но уже вне критической
            // секции (запрос к БД не должен идти поперёк мьютекса).
            // `flush_and_fetch_history` сначала дожидается, пока писатель
            // обработает все более ранние сообщения чата, и только потом
            // читает — иначе только что отправленное сообщение могло бы не
            // попасть в выдачу из-за гонки с фоновой записью.
            match db::flush_and_fetch_history(chat_tx, db, session_id).await {
                Ok(messages) => send_to(tx, ServerMessage::ChatHistory { messages }),
                Err(e) => warn!(room = %room_id, "не удалось прочитать историю чата: {e}"),
            }
        }

        // Релей: содержимое не разбираем, только маршрутизируем внутри
        // комнаты отправителя (любому другому участнику), подставляя fromPeerId.
        ClientMessage::Offer { target_peer_id, sdp } => {
            relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Offer {
                from_peer_id: from,
                sdp,
            });
        }
        ClientMessage::Answer { target_peer_id, sdp } => {
            relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Answer {
                from_peer_id: from,
                sdp,
            });
        }
        ClientMessage::IceCandidate { target_peer_id, candidate } => {
            relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::IceCandidate {
                from_peer_id: from,
                candidate,
            });
        }
        ClientMessage::StreamInfo { target_peer_id, info } => {
            relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::StreamInfo {
                from_peer_id: from,
                info,
            });
        }

        ClientMessage::Chat { text } => {
            handle_chat(text, me, tx, rooms, chat_tx, chat_times);
        }

        ClientMessage::ShareStart => {
            handle_share_start(me, tx, rooms);
        }
        ClientMessage::ShareStop => {
            handle_share_stop(me, rooms);
        }

        ClientMessage::Leave => return Flow::Stop,
    }
    Flow::Continue
}

/// Заявка на шаринг экрана: удовлетворяется, только если экран сейчас
/// свободен. Если уже занят — отказ (`share-rejected`) только инициатору,
/// без рассылки остальным. Повторная заявка текущего владельца — не-op.
fn handle_share_start(me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
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
            send_to(tx, ServerMessage::ShareRejected { busy_peer_id: owner.clone() });
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

/// Обработка `chat`: валидация, rate-limit, широковещательная рассылка
/// участникам комнаты (включая отправителя) и постановка в очередь на запись
/// в БД (см. `db::run_chat_writer` — единственный писатель, чтобы порядок и
/// полнота истории не зависели от гонки конкурентных вставок).
fn handle_chat(
    text: String,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    chat_tx: &ChatWriteTx,
    chat_times: &mut VecDeque<Instant>,
) {
    let Some(ctx) = me.as_ref() else {
        send_to(tx, err("not in a room"));
        return;
    };

    if !check_rate_limit(chat_times) {
        send_to(tx, err("too many chat messages, slow down"));
        return;
    }

    let text = match validate_chat_text(&text) {
        Ok(t) => t,
        Err(message) => {
            send_to(tx, err(message));
            return;
        }
    };

    let room_id = ctx.room_id.clone();
    let from_peer_id = ctx.peer_id.clone();
    let name = ctx.name.clone();
    let ts = now_ms();

    // Под мьютексом только собираем получателей и session_id; сама отправка —
    // синхронный send в mpsc-канал (не блокирует), запись в БД — вне мьютекса
    // и через отдельный канал единственному писателю, чтобы доставка не
    // ждала диск (см. `db::run_chat_writer`).
    let (recipients, session_id) = {
        let rooms_guard = rooms.lock().unwrap();
        let Some(room) = rooms_guard.get(&room_id) else {
            debug!(room = %room_id, "chat в уже закрытую комнату — игнорируем");
            return;
        };
        let recipients: Vec<PeerTx> = room.participants.values().map(|p| p.tx.clone()).collect();
        (recipients, room.session_id)
    };

    let chat_msg = ServerMessage::Chat {
        from_peer_id: from_peer_id.clone(),
        name: name.clone(),
        text: text.clone(),
        ts,
    };
    for peer_tx in &recipients {
        send_to(peer_tx, chat_msg.clone());
    }

    let _ = chat_tx.send(ChatWriteJob::Insert {
        session_id,
        peer_id: from_peer_id,
        name,
        text,
        ts,
    });
}

/// Скользящий счётчик: не более `CHAT_RATE_LIMIT` сообщений за
/// `CHAT_RATE_WINDOW` с одного соединения. Возвращает `true`, если сообщение
/// разрешено (и тогда регистрирует его метку времени).
fn check_rate_limit(chat_times: &mut VecDeque<Instant>) -> bool {
    let now = Instant::now();
    while let Some(&oldest) = chat_times.front() {
        if now.duration_since(oldest) > CHAT_RATE_WINDOW {
            chat_times.pop_front();
        } else {
            break;
        }
    }
    if chat_times.len() >= CHAT_RATE_LIMIT {
        return false;
    }
    chat_times.push_back(now);
    true
}

/// `text` после trim должен быть непустым и не длиннее `CHAT_TEXT_MAX_CHARS`
/// символов (считаем именно символы, не байты — иначе многобайтовый UTF-8
/// обрезался бы слишком рано).
fn validate_chat_text(text: &str) -> Result<String, &'static str> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("chat message must not be empty");
    }
    if trimmed.chars().count() > CHAT_TEXT_MAX_CHARS {
        return Err("chat message too long (max 2000 characters)");
    }
    Ok(trimmed.to_string())
}

/// `name`: trim, вырезать управляющие символы, обрезать до
/// `CHAT_NAME_MAX_CHARS` символов; пустое после очистки — `None`.
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
    match room.participants.get(target) {
        Some(p) => send_to(&p.tx, build(ctx.peer_id.clone())),
        None => debug!(target = %target, "релей на неизвестный peerId — игнорируем"),
    }
}

/// Убрать пира из комнаты и уведомить остальных: если он шарил экран —
/// сначала `share-stopped` всем оставшимся, затем (если кто-то остался)
/// `peer-left`. Если комната опустела — не удаляем её сразу, а помечаем
/// момент опустошения: реапер удалит её позже, если никто не подключится
/// до истечения TTL (см. `state::reap_empty_rooms`).
fn cleanup_peer(ctx: &PeerCtx, rooms: &SharedRooms) {
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else { return };
    if room.participants.remove(&ctx.peer_id).is_none() {
        return; // уже не в комнате
    }

    if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
        room.screen_owner = None;
        let msg = ServerMessage::ShareStopped { peer_id: ctx.peer_id.clone() };
        for p in room.participants.values() {
            send_to(&p.tx, msg.clone());
        }
    }

    if room.participants.is_empty() {
        room.emptied_at = Some(Instant::now());
        info!(room = %ctx.room_id, "комната опустела, ожидает TTL перед удалением");
    } else {
        info!(room = %ctx.room_id, peer = %ctx.peer_id, "участник отключился");
        let msg = ServerMessage::PeerLeft { peer_id: ctx.peer_id.clone() };
        for p in room.participants.values() {
            send_to(&p.tx, msg.clone());
        }
    }
}

fn err(message: &str) -> ServerMessage {
    ServerMessage::Error { message: message.to_string() }
}
