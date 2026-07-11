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
    /// Broadcaster создаёт комнату. `name` — опционально, как его показывать
    /// зрителям в чате (не путать с peerId).
    CreateRoom {
        #[serde(default)]
        name: Option<String>,
    },
    /// Viewer входит в существующую комнату. `name` — опционально, имя зрителя в чате.
    JoinRoom {
        room_id: String,
        role: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// SDP-оффер от broadcaster конкретному зрителю.
    Offer { target_peer_id: String, sdp: Value },
    /// SDP-ответ от зрителя broadcaster'у.
    Answer { target_peer_id: String, sdp: Value },
    /// ICE-кандидат (trickle) любому пиру своей комнаты.
    IceCandidate { target_peer_id: String, candidate: Value },
    /// Информация об аудиопотоке (аудио-хаб) — опаковый JSON, сервер не
    /// разбирает содержимое `info`, только релеит как offer/answer/ICE.
    /// Используется broadcaster'ом, чтобы сообщить зрителю соответствие
    /// `streamId -> { peerId, name }` для ретранслируемых чужих аудиотреков.
    StreamInfo { target_peer_id: String, info: Value },
    /// Текстовое сообщение в чат комнаты — от любого участника.
    Chat { text: String },
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
    /// `name` — имя зрителя из `join-room` (то же, что уходит в чат), нужно
    /// broadcaster'у, чтобы подписывать источник ретранслируемого аудио.
    PeerJoined { peer_id: String, name: Option<String> },
    /// Broadcaster'у: зритель ушёл.
    PeerLeft { peer_id: String },
    /// Зрителю: оффер от broadcaster'а.
    Offer { from_peer_id: String, sdp: Value },
    /// Broadcaster'у: ответ зрителя.
    Answer { from_peer_id: String, sdp: Value },
    /// Целевому пиру: ICE-кандидат от другого пира.
    IceCandidate { from_peer_id: String, candidate: Value },
    /// Целевому пиру: информация об аудиопотоке от другого пира (релей
    /// `stream-info`, см. `ClientMessage::StreamInfo`).
    StreamInfo { from_peer_id: String, info: Value },
    /// Зрителю: в комнате уже максимум зрителей.
    RoomFull,
    /// Зрителю: комнаты нет (не создана или уже закрыта).
    RoomNotFound,
    /// Всем зрителям комнаты: вещающий ушёл, трансляция завершена.
    BroadcasterLeft,
    /// Всем участникам комнаты (включая отправителя — единый путь рендера):
    /// новое сообщение чата.
    Chat {
        from_peer_id: String,
        name: Option<String>,
        text: String,
        ts: i64,
    },
    /// Зрителю сразу после `joined`: последние сообщения чата комнаты
    /// в хронологическом порядке.
    ChatHistory { messages: Vec<ChatHistoryEntry> },
    /// Отправителю: некорректный запрос.
    Error { message: String },
}

/// Одно сообщение в списке `ChatHistory::messages`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryEntry {
    pub from_peer_id: String,
    pub name: Option<String>,
    pub text: String,
    pub ts: i64,
}
