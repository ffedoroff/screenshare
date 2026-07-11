//! Типы сообщений сигналинга (JSON поверх WebSocket).
//!
//! Сервер НЕ разбирает содержимое `sdp` / `candidate` — это опаковые
//! JSON-значения, которые лишь маршрутизируются между пирами.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Сообщения клиент → сервер.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// Broadcaster создаёт комнату.
    CreateRoom,
    /// Viewer входит в существующую комнату.
    JoinRoom { room_id: String, role: String },
    /// SDP-оффер от broadcaster конкретному зрителю.
    Offer { target_peer_id: String, sdp: Value },
    /// SDP-ответ от зрителя broadcaster'у.
    Answer { target_peer_id: String, sdp: Value },
    /// ICE-кандидат (trickle) любому пиру своей комнаты.
    IceCandidate { target_peer_id: String, candidate: Value },
    /// Явный выход (эквивалентен закрытию сокета).
    Leave,
}

/// Сообщения сервер → клиент.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// Ответ broadcaster'у на `create-room`.
    RoomCreated { room_id: String, peer_id: String },
    /// Ответ зрителю на успешный `join-room`.
    Joined {
        peer_id: String,
        broadcaster_id: String,
        viewer_count: usize,
    },
    /// Broadcaster'у: подключился новый зритель — пора слать оффер.
    PeerJoined { peer_id: String },
    /// Broadcaster'у: зритель ушёл.
    PeerLeft { peer_id: String },
    /// Зрителю: оффер от broadcaster'а.
    Offer { from_peer_id: String, sdp: Value },
    /// Broadcaster'у: ответ зрителя.
    Answer { from_peer_id: String, sdp: Value },
    /// Целевому пиру: ICE-кандидат от другого пира.
    IceCandidate { from_peer_id: String, candidate: Value },
    /// Зрителю: в комнате уже максимум зрителей.
    RoomFull,
    /// Зрителю: комнаты нет (не создана или уже закрыта).
    RoomNotFound,
    /// Всем зрителям комнаты: вещающий ушёл, трансляция завершена.
    BroadcasterLeft,
    /// Отправителю: некорректный запрос.
    Error { message: String },
}
