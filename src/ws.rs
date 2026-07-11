//! Обработка WebSocket-соединений: сигналинг-релей, чат и жизненный цикл комнат.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::db;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::state::{
    generate_peer_id, generate_room_id, now_ms, send_to, AppState, PeerTx, Room, SharedRooms,
    MAX_VIEWERS,
};

/// Лимит на чат: не более `CHAT_RATE_LIMIT` сообщений за `CHAT_RATE_WINDOW`
/// с одного соединения. Простой скользящий счётчик, без сторонних крейтов.
const CHAT_RATE_LIMIT: usize = 10;
const CHAT_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Максимальная длина текста сообщения чата в символах (не байтах).
const CHAT_TEXT_MAX_CHARS: usize = 2000;
/// Максимальная длина отображаемого имени в символах.
const CHAT_NAME_MAX_CHARS: usize = 32;

/// Кем это соединение зарегистрировано в комнате.
#[derive(Debug, Clone)]
struct PeerCtx {
    room_id: String,
    peer_id: String,
    is_broadcaster: bool,
    /// Имя для чата (broadcaster/viewer), задаётся при create-room/join-room.
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
    ws.on_upgrade(move |socket| handle_socket(socket, state.rooms, state.db))
}

/// Одно WS-соединение = одна задача tokio. Исходящие сообщения пиру идут
/// через mpsc-канал: другие задачи кладут в канал, а писать в сокет может
/// только эта задача (select ниже) — так исключаются гонки записи.
async fn handle_socket(mut socket: WebSocket, rooms: SharedRooms, db: SqlitePool) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    // Роль/комната этого соединения; None до create-room / join-room.
    let mut me: Option<PeerCtx> = None;
    // Взводится, когда очередь исходящих надо дослать и закрыть сокет.
    let mut closing = false;
    // Метки времени последних отправленных чат-сообщений этого соединения
    // (скользящее окно для rate-limit).
    let mut chat_times: VecDeque<Instant> = VecDeque::new();

    loop {
        tokio::select! {
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
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(msg) => {
                                let flow = handle_message(
                                    msg, &mut me, &tx, &rooms, &db, &mut chat_times,
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
                    // Ping/pong axum обрабатывает сам; бинарные кадры игнорируем.
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
/// Асинхронна из-за обращений к БД (создание сессии при `create-room`,
/// чтение истории при `join-room`) — но, как и раньше, ни одно `.await` не
/// происходит ПОКА держится `std::sync::Mutex` над комнатами: критические
/// секции остаются короткими и синхронными, а DB I/O — строго до захвата
/// мьютекса или уже после его освобождения.
async fn handle_message(
    msg: ClientMessage,
    me: &mut Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    db: &SqlitePool,
    chat_times: &mut VecDeque<Instant>,
) -> Flow {
    match msg {
        ClientMessage::CreateRoom { name } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let peer_id = generate_peer_id();
            let name = sanitize_name(name);
            let room_id = generate_room_id();

            // Сессия заводится в БД ДО захвата мьютекса комнат: вставка в
            // HashMap синхронна и не должна ждать диск.
            let session_id = match db::create_session(db, &room_id, now_ms()).await {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!("не удалось создать сессию комнаты в БД: {e}");
                    send_to(tx, err("internal error, try again"));
                    return Flow::Continue;
                }
            };

            let mut rooms_guard = rooms.lock().unwrap();
            // Коллизия 8-символьного id астрономически маловероятна
            // (32^8 вариантов). В отличие от прежней версии, здесь нельзя
            // просто перегенерировать в цикле под мьютексом — id уже ушёл
            // в БД вместе с сессией, поэтому в теоретическом проигрышном
            // случае просто отказываем: клиент повторит create-room.
            if rooms_guard.contains_key(&room_id) {
                drop(rooms_guard);
                warn!(room = %room_id, "коллизия roomId при создании — отказ");
                send_to(tx, err("try again"));
                return Flow::Continue;
            }
            rooms_guard.insert(
                room_id.clone(),
                Room {
                    broadcaster_id: peer_id.clone(),
                    broadcaster_tx: tx.clone(),
                    viewers: HashMap::new(),
                    session_id,
                },
            );
            drop(rooms_guard);
            info!(room = %room_id, "комната создана");
            *me = Some(PeerCtx {
                room_id: room_id.clone(),
                peer_id: peer_id.clone(),
                is_broadcaster: true,
                name,
            });
            send_to(tx, ServerMessage::RoomCreated { room_id, peer_id });
        }

        ClientMessage::JoinRoom { room_id, role, name } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            // Второй "вещающий" в чужую комнату не пускается: единственный
            // способ стать broadcaster — create-room (один на комнату).
            if role != "viewer" {
                send_to(tx, err("only role \"viewer\" can join a room"));
                return Flow::Stop;
            }
            let name = sanitize_name(name);

            // Синхронная часть целиком под мьютексом, без .await внутри.
            let session_id = {
                let mut rooms_guard = rooms.lock().unwrap();
                let Some(room) = rooms_guard.get_mut(&room_id) else {
                    send_to(tx, ServerMessage::RoomNotFound); // edge-кейс №4
                    return Flow::Continue; // сокет закроет писатель
                };
                if room.viewers.len() >= MAX_VIEWERS {
                    send_to(tx, ServerMessage::RoomFull); // edge-кейс №3
                    return Flow::Continue;
                }
                let peer_id = generate_peer_id();
                room.viewers.insert(peer_id.clone(), tx.clone());
                let viewer_count = room.viewers.len();
                info!(room = %room_id, viewer = %peer_id, count = viewer_count, "зритель подключился");
                // Broadcaster инициирует оффер по этому событию. Одновременные
                // входы зрителей безопасны: мьютекс сериализует вставки, а
                // офферы независимы по peerId (edge-кейс №9).
                send_to(&room.broadcaster_tx, ServerMessage::PeerJoined { peer_id: peer_id.clone() });
                send_to(
                    tx,
                    ServerMessage::Joined {
                        peer_id: peer_id.clone(),
                        broadcaster_id: room.broadcaster_id.clone(),
                        viewer_count,
                    },
                );
                let session_id = room.session_id;
                *me = Some(PeerCtx { room_id: room_id.clone(), peer_id, is_broadcaster: false, name });
                session_id
            };

            // История чата — сразу после `joined`, но уже вне критической
            // секции (запрос к БД не должен идти поперёк мьютекса).
            match db::fetch_history(db, session_id).await {
                Ok(messages) => send_to(tx, ServerMessage::ChatHistory { messages }),
                Err(e) => warn!(room = %room_id, "не удалось прочитать историю чата: {e}"),
            }
        }

        // Релей: содержимое не разбираем, только маршрутизируем внутри
        // комнаты отправителя, подставляя fromPeerId.
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

        ClientMessage::Chat { text } => {
            handle_chat(text, me, tx, rooms, db, chat_times).await;
        }

        ClientMessage::Leave => return Flow::Stop,
    }
    Flow::Continue
}

/// Обработка `chat`: валидация, rate-limit, широковещательная рассылка
/// участникам комнаты (включая отправителя) и фоновая запись в БД.
async fn handle_chat(
    text: String,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    db: &SqlitePool,
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
    // и вовсе в отдельной задаче, чтобы доставка не ждала диск.
    let (recipients, session_id) = {
        let rooms_guard = rooms.lock().unwrap();
        let Some(room) = rooms_guard.get(&room_id) else {
            debug!(room = %room_id, "chat в уже закрытую комнату — игнорируем");
            return;
        };
        let mut recipients: Vec<PeerTx> = Vec::with_capacity(room.viewers.len() + 1);
        recipients.push(room.broadcaster_tx.clone());
        recipients.extend(room.viewers.values().cloned());
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

    let db = db.clone();
    tokio::spawn(async move {
        if let Err(e) =
            db::insert_message(&db, session_id, &from_peer_id, name.as_deref(), &text, ts).await
        {
            tracing::error!("не удалось сохранить сообщение чата в БД: {e}");
        }
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

/// Доставить сообщение пиру `target` в комнате отправителя.
/// Неизвестный targetPeerId тихо игнорируется (edge-кейс №10): это штатная
/// гонка — пир мог отвалиться, пока сообщение летело.
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
    let target_tx = if room.broadcaster_id == target {
        Some(&room.broadcaster_tx)
    } else {
        room.viewers.get(target)
    };
    match target_tx {
        Some(t) => send_to(t, build(ctx.peer_id.clone())),
        None => debug!(target = %target, "релей на неизвестный peerId — игнорируем"),
    }
}

/// Убрать пира из комнаты и уведомить остальных.
fn cleanup_peer(ctx: &PeerCtx, rooms: &SharedRooms) {
    let mut rooms = rooms.lock().unwrap();
    if ctx.is_broadcaster {
        // Edge-кейс №1: вещающий ушёл — комната удаляется,
        // все зрители получают broadcaster-left.
        if let Some(room) = rooms.remove(&ctx.room_id) {
            info!(room = %ctx.room_id, "вещающий ушёл, комната удалена");
            for viewer_tx in room.viewers.values() {
                send_to(viewer_tx, ServerMessage::BroadcasterLeft);
            }
        }
    } else if let Some(room) = rooms.get_mut(&ctx.room_id) {
        // Edge-кейс №2: зритель ушёл — уведомляем вещающего.
        // Комната могла уже исчезнуть вместе с вещающим — тогда ничего не делаем.
        if room.viewers.remove(&ctx.peer_id).is_some() {
            info!(room = %ctx.room_id, viewer = %ctx.peer_id, "зритель отключился");
            send_to(
                &room.broadcaster_tx,
                ServerMessage::PeerLeft { peer_id: ctx.peer_id.clone() },
            );
        }
    }
}

fn err(message: &str) -> ServerMessage {
    ServerMessage::Error { message: message.to_string() }
}
