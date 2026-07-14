//! Типы сообщений сигналинга (JSON поверх WebSocket).
//!
//! Сервер НЕ разбирает содержимое `sdp` / `candidate` — это опаковые
//! JSON-значения, которые лишь маршрутизируются между пирами.
//!
//! Протокол v2: симметричная комната — все участники равны (никакого
//! broadcaster/viewer), соединяются mesh, шаринг экрана — временное
//! состояние комнаты (максимум один шарящий одновременно).
//!
//! Протокол v3+ (Ф0/Ф1): чат ходит ИСКЛЮЧИТЕЛЬНО по mesh RTCDataChannel
//! напрямую между участниками (см. `static/rtc.js`/`static/bus.js`/
//! `static/chat.js`) — сервер в этом пути не участвует вообще. Прежний
//! адресный fallback-релей чата через сервер удалён (см. docs/chat.md): чат
//! возможен только при установленном P2P/TURN-соединении, а до открытия шины
//! исходящее ждёт в локальной очереди клиента, а не идёт через сервер.
//!
//! Протокол v4 (система прав): комната теперь имеет лидера (`leaderId`) и
//! `settings` (права гостей), опционально wait room (`lobby_enabled`) —
//! подробности модели см. docs/permissions-and-leader.md.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Настройки комнаты: права гостей + переключатель wait room. Меняет только
/// лидер (`update-settings`), рассылаются всем участникам (`settings-changed`)
/// и новому участнику в `joined`. По умолчанию разрешено всё, кроме комнаты
/// ожидания (`lobby_enabled=false` — входить может кто угодно без одобрения).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    #[serde(default)]
    pub lobby_enabled: bool,
    #[serde(default = "default_true")]
    pub guest_chat: bool,
    #[serde(default = "default_true")]
    pub guest_audio: bool,
    #[serde(default = "default_true")]
    pub guest_video: bool,
    #[serde(default = "default_true")]
    pub guest_screen: bool,
}

fn default_true() -> bool {
    true
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self {
            lobby_enabled: false,
            guest_chat: true,
            guest_audio: true,
            guest_video: true,
            guest_screen: true,
        }
    }
}

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
        /// Одноразовый токен лидера, выданный `POST /api/rooms` (см.
        /// `AppState`/`main.rs::create_room`). Совпал с хранимым в комнате —
        /// вошедший становится лидером и токен сгорает. `PUT
        /// /api/rooms/{id}` токен не выдаёт вовсе — восстановленная комната
        /// отдаёт лидерство первому вошедшему (см. docs/permissions-and-leader.md).
        #[serde(default)]
        leader_token: Option<String>,
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
    /// Заявка на шаринг экрана. Удовлетворяется, только если экран сейчас
    /// свободен (комната одновременно поддерживает не более одного шарящего).
    ShareStart,
    /// Освобождение экрана — принимается только от текущего владельца,
    /// от кого-то другого тихо игнорируется.
    ShareStop,
    /// Сменить настройки комнаты (права гостей + lobby). Только лидер —
    /// от кого-то другого `error`. Применяется целиком (не патч), рассылается
    /// всем участникам как `settings-changed`.
    UpdateSettings { settings: RoomSettings },
    /// Впустить ожидающего в комнату (лобби). Только лидер.
    Approve { peer_id: String },
    /// Отклонить ожидающего — ему `join-rejected` и сервер закрывает его
    /// сокет. Только лидер.
    Reject { peer_id: String },
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
        /// peerId текущего лидера комнаты (см. docs/permissions-and-leader.md).
        leader_id: String,
        /// Текущие настройки комнаты (права гостей + lobby).
        settings: RoomSettings,
        /// Ожидающие одобрения в лобби — заполнено ТОЛЬКО для самого лидера
        /// (чтобы он мог сразу увидеть, кого одобрить/отклонить); всем
        /// остальным приходит пустой список.
        pending: Vec<PendingInfo>,
        /// Остаток жизни комнаты в секундах на момент входа (лимит
        /// длительности созвона — см. docs/security.md, «Meeting Duration
        /// Ceiling»): `MAX_ROOM_LIFETIME_SECONDS` минус возраст комнаты,
        /// зажатый снизу в 0. Сервер меряет возраст монотонными часами
        /// (`Instant`), поэтому клиенту шлём именно ОСТАТОК, а не абсолютное
        /// время истечения — у клиента нет способа сопоставить `Instant`
        /// сервера со своими часами.
        expires_in_seconds: u64,
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
    /// Только инициатору `share-start`: заявка отклонена. `busy_peer_id`
    /// присутствует, если экран занят кем-то другим; отсутствует (`None`),
    /// если отказ по правам (`reason: "forbidden"` — гостю запрещён
    /// `guest_screen` в настройках комнаты).
    ShareRejected {
        #[serde(skip_serializing_if = "Option::is_none")]
        busy_peer_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Всем участникам комнаты: шаринг экрана закончился (явный `share-stop`
    /// владельца или его дисконнект).
    ShareStopped { peer_id: String },
    /// Участнику: в комнате уже максимум участников.
    RoomFull,
    /// Участнику: комнаты нет (не создана, ещё не создана или уже удалена
    /// реапером после истечения TTL пустой комнаты).
    RoomNotFound,
    /// Отправителю: некорректный запрос.
    Error { message: String },
    /// Ожидающему в лобби (см. `RoomSettings::lobby_enabled`): заявка на вход
    /// принята сервером, ждём решения лидера (`approve`/`reject`).
    Waiting {},
    /// Лидеру: новая заявка на вход в комнату с включённым лобби.
    JoinRequest { peer_id: String, name: Option<String> },
    /// Лидеру: ожидающий отвалился (закрыл вкладку/сокет), не дождавшись
    /// решения — заявка снята сама собой.
    JoinRequestCancelled { peer_id: String },
    /// Ожидающему: лидер отклонил заявку — сервер закрывает сокет сразу
    /// вслед за этим сообщением.
    JoinRejected {},
    /// Всем участникам комнаты: лидер сменил настройки комнаты.
    SettingsChanged { settings: RoomSettings },
    /// Всем участникам комнаты: сменился лидер (прежний вышел, сервер
    /// детерминированно назначил участника с самым ранним `joined_at`).
    LeaderChanged { leader_id: String },
    /// Всем участникам И ожидающим в лобби: комната прожила дольше
    /// `MAX_ROOM_LIFETIME_SECONDS` (см. docs/security.md, «Meeting Duration
    /// Ceiling») — реапер (`state::reap_rooms`) шлёт это сообщение каждому,
    /// затем удаляет комнату целиком, независимо от того, есть ли в ней
    /// живые участники. Как `room-full`/`room-not-found`/`join-rejected` —
    /// сервер сам закрывает сокет сразу вслед за этим сообщением (см.
    /// `handle_socket`).
    RoomExpired {},
}

/// Один другой участник комнаты в списке `Joined::peers`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub name: Option<String>,
}

/// Один ожидающий одобрения в лобби — в списке `Joined::pending` (только для
/// лидера) и в поле `JoinRequest`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInfo {
    pub peer_id: String,
    pub name: Option<String>,
}
