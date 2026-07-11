//! Обработка WebSocket-соединений: сигналинг-релей и жизненный цикл комнат.

use std::collections::HashMap;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::protocol::{ClientMessage, ServerMessage};
use crate::state::{
    generate_peer_id, generate_room_id, send_to, PeerTx, Room, SharedRooms, MAX_VIEWERS,
};

/// Кем это соединение зарегистрировано в комнате.
#[derive(Debug, Clone)]
struct PeerCtx {
    room_id: String,
    peer_id: String,
    is_broadcaster: bool,
}

/// Что делать с соединением после обработки сообщения.
#[derive(PartialEq)]
enum Flow {
    Continue,
    /// Закрыть сокет (после того как писатель дошлёт всё из очереди).
    Stop,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(rooms): State<SharedRooms>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, rooms))
}

/// Одно WS-соединение = одна задача tokio. Исходящие сообщения пиру идут
/// через mpsc-канал: другие задачи кладут в канал, а писать в сокет может
/// только эта задача (select ниже) — так исключаются гонки записи.
async fn handle_socket(mut socket: WebSocket, rooms: SharedRooms) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    // Роль/комната этого соединения; None до create-room / join-room.
    let mut me: Option<PeerCtx> = None;
    // Взводится, когда очередь исходящих надо дослать и закрыть сокет.
    let mut closing = false;

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
                                if handle_message(msg, &mut me, &tx, &rooms) == Flow::Stop {
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

/// Обработка одного сообщения клиента. Синхронна и не ждёт I/O —
/// вся отправка идёт через неблокирующие mpsc-каналы.
fn handle_message(
    msg: ClientMessage,
    me: &mut Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
) -> Flow {
    match msg {
        ClientMessage::CreateRoom => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let peer_id = generate_peer_id();
            let mut rooms = rooms.lock().unwrap();
            // Коллизия 8-символьного id астрономически маловероятна,
            // но перегенерировать дёшево.
            let mut room_id = generate_room_id();
            while rooms.contains_key(&room_id) {
                room_id = generate_room_id();
            }
            rooms.insert(
                room_id.clone(),
                Room {
                    broadcaster_id: peer_id.clone(),
                    broadcaster_tx: tx.clone(),
                    viewers: HashMap::new(),
                },
            );
            info!(room = %room_id, "комната создана");
            *me = Some(PeerCtx {
                room_id: room_id.clone(),
                peer_id: peer_id.clone(),
                is_broadcaster: true,
            });
            send_to(tx, ServerMessage::RoomCreated { room_id, peer_id });
        }

        ClientMessage::JoinRoom { room_id, role } => {
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
            let mut rooms = rooms.lock().unwrap();
            let Some(room) = rooms.get_mut(&room_id) else {
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
            *me = Some(PeerCtx { room_id, peer_id, is_broadcaster: false });
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

        ClientMessage::Leave => return Flow::Stop,
    }
    Flow::Continue
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
