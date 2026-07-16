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
//!
//! E2E-модель v2 («вариант E», см. docs/research-p2p-key-handoff.md §6.5–6.6):
//! аддитивно к вышестоящим версиям. Каждый пир на вкладке генерирует
//! эфемерную ECDH-пару и присылает публичную часть (`epub`) в `join-room` —
//! сервер её не парсит (опак, как `sdp`/`candidate`), только каппит длину
//! (см. `crate::ws::sanitize_epub`) и релеит остальным через `peers[]`/
//! `peer-joined`/`join-request`/`waiting.leaderEpub`, чтобы пиры могли вывести
//! попарные ключи (forward secrecy). Имя участника теперь ходит ОТДЕЛЬНЫМ
//! зашифрованным сообщением `name-announce` (а не полем `name` в
//! `join-room`/`peer-joined` — то поле v2-клиенты всегда шлют/видят `null`,
//! но оставлено в схеме как опак для обратной совместимости с v1).

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
    /// Собственный лимит числа участников, который может выставить лидер
    /// (см. docs/research-room-limit.md) — `None` (дефолт, старые клиенты
    /// его просто не шлют) означает «следовать серверному потолку»
    /// (`crate::MAX_PARTICIPANTS`), который и так крутится вместе с ним (см.
    /// `crate::state::Room::effective_max_participants`). Валидация —
    /// только в `crate::ws::handle_update_settings`: `Some(n)` принимается,
    /// только если `2 <= n <= crate::MAX_PARTICIPANTS`, иначе весь
    /// `update-settings` отклоняется целиком (`error`, ничего не
    /// применяется) — нижняя граница 2, а не 1, потому что комната с
    /// лимитом 1 бессмысленна (лидер не смог бы впустить даже самого себя
    /// вторым). Снижение лимита ниже текущей занятости комнаты НЕ выгоняет
    /// уже вошедших — только блокирует последующие `join-room`/`approve`
    /// (см. `Room::effective_max_participants`).
    #[serde(default)]
    pub max_participants: Option<usize>,
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
            max_participants: None,
        }
    }
}

/// Сообщения клиент → сервер.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// Вход участника в уже существующую комнату (комната заводится заранее
    /// через `POST /api/rooms`). `name` НЕ используется и НЕ хранится сервером
    /// (см. docs/research-minimize-state.md §3, `crate::ws::handle_message` —
    /// поле принимается и тут же отбрасывается `name: _`) — оставлено в схеме
    /// проводного протокола только ради обратной совместимости
    /// десериализации (в т.ч. с гипотетическими старыми клиентами, которые
    /// его ещё шлют); у v2-клиентов имя ходит отдельным зашифрованным
    /// `name-announce` (см. комментарий модуля выше).
    ///
    /// `peer_id` — опционально: клиент передаёт свой ПРЕЖНИЙ peerId, если
    /// переподключается после обрыва сигналинга (см. фронтовый авто-reconnect
    /// в `static/room.js`) — mesh-соединения остальных участников на этот
    /// peerId уже настроены и переживают обрыв сигналинга, поэтому сохранить
    /// тот же id избавляет от необходимости пересобирать mesh. Сервер
    /// принимает его, только если это валидный UUID; если он уже занят
    /// ДЕЙСТВУЮЩИМ участником этой же комнаты — это реконнект (см.
    /// `crate::ws::reconnect_participant`), иначе (не передан, невалиден или
    /// занят ожидающим в лобби) генерирует новый как обычно, тем самым это
    /// расширение полностью обратно совместимо со старыми клиентами и
    /// безопасно для новых при коллизии.
    JoinRoom {
        room_id: String,
        #[serde(default)]
        #[allow(dead_code)] // мёртвое поле на wire ради совместимости, см. комментарий выше
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
        /// E2E v2: эфемерный публичный ключ пира на эту вкладку (ECDH P-256,
        /// base64url raw, ~87 симв.) — опак для сервера, только релеится
        /// остальным (см. комментарий модуля выше). Обязателен по факту у
        /// v2-клиентов, но поле `Option`, чтобы старый клиент (без него) не
        /// ломал протокол — additive-only.
        #[serde(default)]
        epub: Option<String>,
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
    /// Заявка на шаринг экрана: «последний победил» — если экран уже занят
    /// кем-то другим, заявка НЕ отклоняется, а замещает текущего владельца
    /// (см. `handle_share_start` в `src/ws.rs`); комната одновременно
    /// поддерживает не более одного шарящего, но им становится последний,
    /// чья заявка была обработана сервером. Права гостя (`guest_screen`)
    /// проверяются как и раньше — отказ по правам остаётся отказом, замещение
    /// касается только конфликта владения.
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
    /// E2E v2: зашифрованный анонс имени конкретному пиру `to` — сервер
    /// содержимое `payload` не разбирает (опак, как `sdp`), только релеит
    /// цели как `ServerMessage::NameAnnounce`. Права (см.
    /// `crate::ws::handle_name_announce`): обычный участник — любому
    /// участнику своей комнаты; ожидающий в лобби — ТОЛЬКО текущему лидеру
    /// (у него нет доступа к остальным участникам вовсе). Каппы: `payload` ≤
    /// 2KB, учитывается в общем relay rate-limit (том же, что у
    /// offer/answer/ICE/stream-info).
    NameAnnounce { to: String, payload: String },
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
        /// Аддитивное поле (не заменяет `expires_in_seconds` выше, оба
        /// присутствуют одновременно): сколько секунд прошло с момента входа
        /// ПЕРВОГО за всю жизнь комнаты участника (см.
        /// `crate::state::Room::first_joined_at`) — источник для клиентского
        /// таймера «сколько уже длится созвон» (count-up), в отличие от
        /// `expires_in_seconds` (обратный отсчёт до истечения лимита
        /// длительности). Для самого первого вошедшего — всегда `0` (сервер
        /// ставит `first_joined_at` непосредственно перед вычислением этого
        /// поля в том же самом вызове, см. `crate::ws::admit_participant`).
        /// Старые клиенты это поле просто не читают.
        room_age_seconds: u64,
        /// ЭФФЕКТИВНЫЙ потолок числа участников ЭТОЙ комнаты (см.
        /// `crate::state::Room::effective_max_participants`,
        /// docs/research-room-limit.md): либо серверный потолок (env
        /// `MAX_PARTICIPANTS`, рекомендуемый дефолт 6 — см.
        /// `crate::MAX_PARTICIPANTS` в `main.rs`), либо, если лидер выставил
        /// собственный (`RoomSettings::max_participants`), он — оба случая
        /// клиент показывает одинаково, «Participants: N / <это значение>»
        /// (см. `static/room.js`), а не захардкоженную «/ 6». Старые клиенты
        /// это поле просто не читают — не меняет их поведения.
        max_participants: usize,
    },
    /// Остальным участникам комнаты: подключился новый участник. `name`
    /// сервер БОЛЬШЕ НЕ ХРАНИТ и всегда подставляет `null` (см.
    /// docs/research-minimize-state.md §3 — мёртвое поле, имя ходит
    /// отдельным зашифрованным `name-announce`, см. комментарий модуля
    /// выше); поле оставлено на wire ради обратной совместимости
    /// десериализации. `epub` — его эфемерный публичный ключ.
    PeerJoined {
        peer_id: String,
        name: Option<String>,
        epub: Option<String>,
    },
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
    /// шаринг экрана начался. Если экран до этого держал кто-то другой, для
    /// НЕГО это же сообщение — сигнал о перехвате: клиент сверяет `peer_id`
    /// с собственным и, если у него ещё жив локальный захват экрана,
    /// останавливает его сам (см. `static/room.js`) — отдельного сообщения
    /// прежнему владельцу не требуется, рассылка и так уходит всем.
    ShareStarted { peer_id: String },
    /// Только инициатору `share-start`: заявка отклонена по правам
    /// (`reason: "forbidden"` — гостю запрещён `guest_screen` в настройках
    /// комнаты). `busy_peer_id` оставлен в форме сообщения для обратной
    /// совместимости, но сервер больше НИКОГДА его не заполняет — конфликт
    /// владения экраном больше не отклоняется, а замещает владельца (см.
    /// `ShareStart`/`ShareStarted`).
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
    /// `leader_peer_id`/`leader_epub` (E2E v2) — текущий лидер комнаты и его
    /// эфемерный публичный ключ (nullable — лидер мог не прислать `epub`,
    /// например старый клиент), чтобы ожидающий мог зашифровать ему
    /// `name-announce`. При смене лидера, пока заявка ещё висит, сервер
    /// шлёт ожидающему СВЕЖИЙ `waiting` с новым лидером (см.
    /// `crate::ws::cleanup_peer`) — старый ключ к новому лидеру не подходит.
    Waiting {
        leader_peer_id: String,
        leader_epub: Option<String>,
    },
    /// Лидеру: новая заявка на вход в комнату с включённым лобби. `name`
    /// сервер БОЛЬШЕ НЕ ХРАНИТ и всегда подставляет `null` (см.
    /// docs/research-minimize-state.md §3, тот же дохлый wire-хвост, что у
    /// `PeerJoined::name`); `epub` — эфемерный публичный ключ ожидающего
    /// (E2E v2), нужен лидеру, чтобы расшифровать его `name-announce`.
    JoinRequest {
        peer_id: String,
        name: Option<String>,
        epub: Option<String>,
    },
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
    /// Целевому пиру: анонс имени от другого пира (релей `name-announce`, см.
    /// `ClientMessage::NameAnnounce`) — `payload` опаковый шифртекст, сервер
    /// его не разбирает, только подставляет `from`.
    NameAnnounce { from: String, payload: String },
}

/// Один другой участник комнаты в списке `Joined::peers`. `name` сервер
/// БОЛЬШЕ НЕ ХРАНИТ (см. docs/research-minimize-state.md §3) — всегда
/// `null`, поле оставлено на wire ради обратной совместимости
/// десериализации. `epub` (E2E v2) — его эфемерный публичный ключ.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub name: Option<String>,
    pub epub: Option<String>,
}

/// Один ожидающий одобрения в лобби — в списке `Joined::pending` (только для
/// лидера); `JoinRequest` — отдельный вариант `ServerMessage` с теми же по
/// смыслу полями (не переиспользует эту структуру напрямую, но несёт то же
/// `epub`). `name` — тот же мёртвый wire-хвост, что у `PeerInfo::name`,
/// всегда `null`. `epub` (E2E v2) — эфемерный публичный ключ ожидающего.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInfo {
    pub peer_id: String,
    pub name: Option<String>,
    pub epub: Option<String>,
}
