//! Типы сообщений сигналинга (JSON поверх WebSocket).
//!
//! Сервер НЕ разбирает содержимое `sdp` / `candidate` — это опаковые
//! JSON-значения, которые лишь маршрутизируются между пирами.
//!
//! Протокол v2: симметричная комната — все участники равны (никакого
//! broadcaster/viewer), соединяются mesh, шаринг экрана — временное
//! состояние комнаты (максимум один шарящий одновременно).
//!
//! Протокол v3 (Ф0/Ф1): чат переехал на mesh RTCDataChannel напрямую между
//! участниками (см. `static/rtc.js`/`static/bus.js`/`static/chat.js`) —
//! сервер в этом пути не участвует вообще. `ClientMessage::Chat`/
//! `ServerMessage::Chat` — только адресный fallback-релей на случай, если
//! DataChannel-шина до конкретного пира ещё не открыта; `envelope` для
//! сервера опаковый JSON (как `sdp`/`candidate`/`info`), не разбирается и
//! нигде не хранится.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Сообщения клиент → сервер.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// Вход участника в уже существующую комнату (комната заводится заранее
    /// через `POST /api/rooms`). `name` — опционально, как показывать этого
    /// участника остальным в чате (не путать с peerId).
    ///
    /// `peer_id` — опционально: клиент передаёт свой ПРЕЖНИЙ peerId, если
    /// переподключается после обрыва сигналинга (см. фронтовый авто-reconnect
    /// в `static/room.js`) — mesh-соединения остальных участников на этот
    /// peerId уже настроены и переживают обрыв сигналинга, поэтому сохранить
    /// тот же id избавляет от необходимости пересобирать mesh. Сервер
    /// принимает его, только если это валидный UUID и он ещё не занят в этой
    /// комнате — иначе (не передан, невалиден или занят) генерирует новый как
    /// обычно, тем самым это расширение полностью обратно совместимо со
    /// старыми клиентами и безопасно для новых при коллизии.
    JoinRoom {
        room_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        peer_id: Option<String>,
    },
    /// SDP-оффер любому другому пиру своей комнаты.
    Offer { target_peer_id: String, sdp: Value },
    /// SDP-ответ любому другому пиру своей комнаты.
    Answer { target_peer_id: String, sdp: Value },
    /// ICE-кандидат (trickle) любому пиру своей комнаты.
    IceCandidate { target_peer_id: String, candidate: Value },
    /// Опаковый JSON, сервер не разбирает содержимое `info`, только релеит
    /// как offer/answer/ICE — используется фронтом для служебной информации
    /// между пирами (например, сопоставление аудиотреков с именами).
    StreamInfo { target_peer_id: String, info: Value },
    /// Адресный fallback-путь чата: используется клиентом, только когда
    /// P2P DataChannel-шина до `target_peer_id` ещё не открыта (см.
    /// `static/rtc.js`/`static/chat.js`). Основной путь чата — mesh
    /// RTCDataChannel напрямую между участниками, этот сервер вообще не
    /// видит. `envelope` — опаковый JSON конверт чата (v/id/lamport/from/
    /// name/kind/text/...), сервер его не разбирает и не хранит, только
    /// релеит адресату (как offer/answer/ICE) с валидацией размера и
    /// rate-limit.
    Chat { target_peer_id: String, envelope: Value },
    /// Заявка на шаринг экрана. Удовлетворяется, только если экран сейчас
    /// свободен (комната одновременно поддерживает не более одного шарящего).
    ShareStart,
    /// Освобождение экрана — принимается только от текущего владельца,
    /// от кого-то другого тихо игнорируется.
    ShareStop,
    /// Явный выход (эквивалентен закрытию сокета).
    Leave,
}

/// Сообщения сервер → клиент.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// Ответ участнику на успешный `join-room`. `peers` — ДРУГИЕ уже
    /// подключённые участники комнаты, `screen_owner` — кто сейчас шарит
    /// экран (если шарит хоть кто-то).
    Joined {
        peer_id: String,
        peers: Vec<PeerInfo>,
        screen_owner: Option<String>,
    },
    /// Остальным участникам комнаты: подключился новый участник.
    PeerJoined { peer_id: String, name: Option<String> },
    /// Остальным участникам комнаты: участник ушёл.
    PeerLeft { peer_id: String },
    /// Целевому пиру: оффер от другого пира.
    Offer { from_peer_id: String, sdp: Value },
    /// Целевому пиру: ответ от другого пира.
    Answer { from_peer_id: String, sdp: Value },
    /// Целевому пиру: ICE-кандидат от другого пира.
    IceCandidate { from_peer_id: String, candidate: Value },
    /// Целевому пиру: информация об аудиопотоке от другого пира (релей
    /// `stream-info`, см. `ClientMessage::StreamInfo`).
    StreamInfo { from_peer_id: String, info: Value },
    /// Всем участникам комнаты (включая инициатора — единый путь рендера):
    /// шаринг экрана начался.
    ShareStarted { peer_id: String },
    /// Только инициатору `share-start`: экран уже занят кем-то другим.
    ShareRejected { busy_peer_id: String },
    /// Всем участникам комнаты: шаринг экрана закончился (явный `share-stop`
    /// владельца или его дисконнект).
    ShareStopped { peer_id: String },
    /// Участнику: в комнате уже максимум участников.
    RoomFull,
    /// Участнику: комнаты нет (не создана, ещё не создана или уже удалена
    /// реапером после истечения TTL пустой комнаты).
    RoomNotFound,
    /// Целевому пиру: fallback-релей чата (см. `ClientMessage::Chat`) —
    /// только когда P2P DataChannel-шина между этой парой не открыта.
    /// `envelope` — тот же опаковый JSON конверт, сервер его не разбирает и
    /// не хранит.
    Chat { from_peer_id: String, envelope: Value },
    /// Отправителю: некорректный запрос.
    Error { message: String },
}

/// Один другой участник комнаты в списке `Joined::peers`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub name: Option<String>,
}
