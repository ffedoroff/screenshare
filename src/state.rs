//! Состояние комнат, целиком в памяти процесса. Никакого хранилища на диске:
//! всё (участники, настройки) живёт ровно до тех пор, пока жив процесс и жива
//! сама комната — реапер или рестарт стирают всё без следа. Чат (см.
//! `static/chat.js`) сервер вообще не хранит — история живёт только в
//! памяти вкладок участников, здесь для неё нет ни поля, ни буфера. Имена
//! участников сервер тоже не хранит вовсе (см. `Participant`/`PendingParticipant`
//! ниже, docs/research-minimize-state.md §3) — имя ходит отдельным
//! зашифрованным `name-announce` напрямую между пирами.
//!
//! Выбор синхронизации: `std::sync::Mutex` поверх `HashMap`, а не tokio-мьютекс
//! и не акторная схема. Обоснование: все критические секции короткие и не
//! содержат `.await` (отправка в `UnboundedSender` синхронна и не блокирует,
//! а удаление устаревших комнат в реапере — тоже чисто синхронная операция
//! над `HashMap`), поэтому обычный мьютекс проще и быстрее асинхронного, а
//! contention при нашем масштабе (единицы комнат по ≤`MAX_PARTICIPANTS`
//! участников, по умолчанию 6) пренебрежим.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;

use crate::protocol::{RoomSettings, ServerMessage};

/// Потолок числа участников в комнате одновременно, если env
/// `MAX_PARTICIPANTS` не задан (см. `crate::MAX_PARTICIPANTS` в `main.rs` —
/// `LazyLock`, тот же приём, что у `MAX_ROOM_LIFETIME`/`MAX_ROOMS`). Это
/// РЕКОМЕНДУЕМЫЙ дефолт, не жёсткий потолок протокола (протокол v2:
/// симметричная комната, роли broadcaster/viewer больше не существует,
/// участников может быть сколько угодно с точки зрения сервера) — 6 выбрано
/// потому что комната — полный WebRTC-mesh (каждый шлёт медиа каждому
/// напрямую), и это разумная зона комфорта по трафику/CPU НА СТОРОНЕ
/// КЛИЕНТОВ (n-1 исходящих копий у каждого) — самого сервера это число не
/// напрягает вовсе, он лишь релеит сигналинг. См. docs/self-hosting.md, §6.
pub const DEFAULT_MAX_PARTICIPANTS: usize = 6;

/// Максимум ожидающих одобрения в лобби одновременно (см.
/// `RoomSettings::lobby_enabled`) — не участники комнаты, отдельный, более
/// щедрый лимит, чтобы не запирать людей в толчее перед началом созвона.
pub const MAX_PENDING: usize = 10;

/// Как часто реапер проверяет комнаты на протухание. Сознательно чаще, чем
/// «раз в 5 секунд» могло бы показаться достаточным: TTL пустой комнаты в
/// тестах — 2 секунды, и с более редким тиком удаление легко перехлёстывает
/// за отведённое тестам время ожидания. Накладные расходы пренебрежимы —
/// комнат единицы, сама проверка — линейный проход по `HashMap` под коротким
/// локом без единого `.await`.
pub const REAPER_INTERVAL: Duration = Duration::from_secs(1);

/// Потолок числа комнат одновременно, если env `MAX_ROOMS` не задан (H2,
/// DoS-защита: без потолка HashMap комнат мог бы расти неограниченно).
pub const DEFAULT_MAX_ROOMS: usize = 500;

/// Лимит долгота созвона по умолчанию, если env `MAX_ROOM_LIFETIME_SECONDS`
/// не задан: 3 часа. См. docs/security.md, «Meeting Duration Ceiling».
pub const DEFAULT_MAX_ROOM_LIFETIME_SECONDS: u64 = 10800;

/// Per-IP лимит на `POST /api/rooms` (H2): не более этого числа запросов за
/// окно с одного IP.
pub const ROOM_CREATION_IP_LIMIT: usize = 10;
pub const ROOM_CREATION_IP_WINDOW: Duration = Duration::from_secs(60);

/// Per-IP лимит на попадание в лобби (M3): своя, отдельная от
/// `ROOM_CREATION_IP_LIMIT`, карта и бюджет — обоснование: создание комнаты и
/// заявка на вход в чужую комнату (по чужой ссылке) — разные по своей природе
/// действия одного и того же IP (например, один участник тесно из общего NAT
/// открывает несколько вкладок с приглашением) — общий с созданием комнат
/// бюджет означал бы, что штурмующий лобби одной комнаты case мог случайно
/// исчерпать лимит и на создание СВОИХ ЖЕ комнат тем же человеком за тем же
/// NAT, что избыточно бьёт по легитимному использованию. Числа те же (10 за
/// 60с) — не потому что механизм общий, а потому что степень «щедрости»
/// разумна для обоих случаев одинаково.
pub const PENDING_JOIN_IP_LIMIT: usize = 10;
pub const PENDING_JOIN_IP_WINDOW: Duration = Duration::from_secs(60);

/// Per-IP лимит на прямой `join-room` В КОМНАТУ (H2, DoS-защита,
/// docs/research-dos.md §3.2 — «главная дыра»): до этой правки прямой вход
/// (лобби выключено, дефолт) не проверялся вообще никак — единственной
/// проверкой была общая, НЕ per-IP, ёмкость комнаты
/// (`room.participants.len() >= MAX_PARTICIPANTS`), поэтому один IP мог
/// открыть `MAX_PARTICIPANTS` WS-соединений и забить чужую комнату по ссылке
/// за доли секунды, ничего не нарушая формально. Своя ОТДЕЛЬНАЯ карта и
/// бюджет — то же обоснование раздельности, что у `PENDING_JOIN_IP_LIMIT`
/// выше: create-комнаты/попадание-в-лобби/прямой-вход-в-комнату — разные по
/// природе действия одного и того же IP, общий бюджет ударил бы по
/// легитимному использованию одного из них при флуде на другом.
///
/// Значение читается из env `JOIN_ROOM_IP_LIMIT` в `main.rs`
/// (`crate::JOIN_ROOM_IP_LIMIT`, тот же `LazyLock`-приём, что у
/// `crate::MAX_PARTICIPANTS`) — в отличие от «соседних» лимитов этого файла
/// (`ROOM_CREATION_IP_LIMIT`/`PENDING_JOIN_IP_LIMIT`, оба захардкожены)
/// configurability здесь осознанно НЕ ради прод-гибкости, а ради
/// тестируемости: HTTP-эндпоинты (`POST`/`PUT /api/rooms`) тестовый клиент
/// может изолировать по IP через заголовок `CF-Connecting-IP` на каждый
/// отдельный запрос (см. `createRoom()` в tests/signaling.test.mjs), а
/// WS-хендшейк глобальным `WebSocket` рантайма (без сторонних пакетов)
/// произвольных заголовков не поддерживает вовсе — единственный способ не
/// дать этому лимиту столкнуться с ОСТАЛЬНЫМИ разделами того же файла
/// (которые все делят один и тот же IP — адрес пира сокета) — поднять лимит
/// у основного тестового процесса через env, а сам лимит по-настоящему
/// проверять в отдельном изолированном серверном процессе с дефолтным
/// значением. `JOIN_ROOM_IP_WINDOW`, в отличие от лимита, не configurable —
/// поднятого лимита у основного тестового процесса достаточно, окно ни на
/// что не влияет, пока лимит недостижим.
///
/// ВАЖНО — реконнект НЕ считается за join для целей этого бюджета: см.
/// `crate::ws::reconnect_participant` и комментарий в обработчике
/// `ClientMessage::JoinRoom` — если предъявленный `peerId` уже занимает слот
/// полноценного участника ЭТОЙ ЖЕ комнаты (типичный случай — клиент лишь
/// ненадолго потерял сигналинг и переподключается быстрее, чем сервер
/// хартбитом обнаружил обрыв, см. docs/research-room-limit.md §4), это
/// обрабатывается отдельным путём ДО проверки этого лимита и не тратит из
/// него ни единицы — иначе легитимный реконнект мог бы сам себя же вытеснить
/// в редком, но реальном случае быстрых повторных обрывов сигналинга.
pub const DEFAULT_JOIN_ROOM_IP_LIMIT: usize = 20;
pub const JOIN_ROOM_IP_WINDOW: Duration = Duration::from_secs(60);

/// Канал для отправки сообщений конкретному WebSocket-соединению.
/// Писатель сокета читает из парного `UnboundedReceiver`.
pub type PeerTx = mpsc::UnboundedSender<ServerMessage>;

/// Один участник комнаты: канал для рассылки ему сообщений + момент входа
/// (для детерминированного выбора нового лидера — см. `Room::leader_id` —
/// при уходе прежнего лидера им становится участник с самым ранним
/// `joined_at`) + эфемерный публичный ключ (E2E v2, см.
/// docs/research-p2p-key-handoff.md §6.5–6.6) — опак для сервера, хранится
/// только чтобы отдать его остальным участникам (`peers[]`/`peer-joined`/
/// `waiting.leaderEpub`), сам сервер его не парсит и не использует.
///
/// Поля `name` здесь больше НЕТ (было в v2 всегда `None`/`null` — имя ходит
/// отдельным зашифрованным `name-announce`, см. комментарий модуля
/// `protocol.rs`; удалено как мёртвое состояние, см.
/// docs/research-minimize-state.md §3). Проводные поля (`ClientMessage::JoinRoom::name`,
/// `PeerInfo::name`, `ServerMessage::PeerJoined::name`) остались в схеме
/// протокола ради обратной совместимости десериализации — сервер их больше
/// не хранит и всегда подставляет `None`/`null` при формировании исходящих
/// сообщений (см. `crate::ws::admit_participant`).
pub struct Participant {
    pub tx: PeerTx,
    pub epub: Option<String>,
    pub joined_at: Instant,
}

/// Один ожидающий одобрения в лобби (см. `RoomSettings::lobby_enabled`) — НЕ
/// участник комнаты (не считается в лимите участников, живёт в
/// отдельной карте `Room::pending` с отдельным лимитом `MAX_PENDING`). `epub` — тот же
/// смысл, что у `Participant::epub` (E2E v2) — отдаётся лидеру в
/// `join-request`, чтобы он мог принять от ожидающего `name-announce`.
///
/// `name` тоже убран — то же обоснование, что у `Participant` выше.
pub struct PendingParticipant {
    pub tx: PeerTx,
    pub epub: Option<String>,
    pub joined_at: Instant,
}

/// Комната: до `crate::MAX_PARTICIPANTS` (env `MAX_PARTICIPANTS`, рекомендуемый
/// дефолт 6 — см. `DEFAULT_MAX_PARTICIPANTS`) равноправных участников,
/// соединяющихся mesh (сервер сам медиа не трогает — только сигналинг). Максимум один из
/// участников может в моменте шарить экран (`screen_owner`).
///
/// Права и лидер (см. docs/permissions-and-leader.md): ровно один участник —
/// лидер (`leader_id`); при его уходе сервер сам детерминированно назначает
/// нового (участника с самым ранним `joined_at`) — кворум не нужен,
/// членство и порядок входа целиком серверные. `leader_token` — одноразовый
/// токен из `POST /api/rooms`, предъявивший его первым при `join-room`
/// становится лидером и сжигает токен; `PUT /api/rooms/{id}` токен не
/// выдаёт вовсе (первый вошедший в восстановленную комнату — лидер).
pub struct Room {
    pub participants: HashMap<String, Participant>,
    /// peerId участника, который сейчас шарит экран (если шарит хоть кто-то).
    pub screen_owner: Option<String>,
    /// Когда комната опустела (последний участник вышел), либо когда она
    /// была создана пустой через `POST /api/rooms`. `None`, пока в комнате
    /// есть хоть один участник. Реапер удаляет комнату, если она пуста
    /// дольше `EMPTY_ROOM_TTL` с этого момента; новый `join-room` в живую
    /// (но помеченную) комнату снимает отметку.
    pub emptied_at: Option<Instant>,
    /// peerId текущего лидера. `None` только пока в комнате нет ни одного
    /// участника (свежесозданная/восстановленная/только что опустевшая
    /// комната) — как только кто-то входит, лидер назначается.
    pub leader_id: Option<String>,
    /// Одноразовый токен лидера. `Some` до первого предъявления валидным
    /// `join-room.leaderToken` (сжигается сразу), либо `None` изначально
    /// (комната восстановлена через `PUT`, без токена).
    pub leader_token: Option<String>,
    /// Настройки комнаты (права гостей + lobby), меняет только лидер.
    pub settings: RoomSettings,
    /// Ожидающие одобрения лидера (лобби) по peerId. НЕ участники комнаты.
    pub pending: HashMap<String, PendingParticipant>,
    /// Момент создания/восстановления комнаты (лимит длительности созвона,
    /// см. docs/security.md, «Meeting Duration Ceiling») — ставится при `POST
    /// /api/rooms` и при `PUT`-восстановлении. Для восстановленной комнаты
    /// отсчёт идёт с момента восстановления, а не какого-то исходного
    /// создания (память о нём не переживает рестарт сервера) — это осознанно
    /// «продлевает» жизнь комнаты на рестарте, тот же trade-off, что и у
    /// `emptied_at`/TTL пустой комнаты.
    pub created_at: Instant,
}

impl Room {
    /// Эффективный потолок числа участников ЭТОЙ комнаты (см.
    /// docs/research-room-limit.md §2.2): собственный лимит лидера
    /// (`settings.max_participants`, `Some`), если он его выставил, иначе —
    /// серверный потолок (`crate::MAX_PARTICIPANTS`). Используется ВЕЗДЕ
    /// вместо прямого сравнения с `crate::MAX_PARTICIPANTS` — при `join-room`
    /// (`src/ws.rs`), при `approve` (`handle_approve`) и в `Joined::max_participants`
    /// (`admit_participant`). Если лидер снизил лимит ниже текущей занятости —
    /// это не какое-то отдельное состояние, а просто означает, что ЛЮБОЙ
    /// следующий вход (`join-room`/`approve`) получит отказ, пока состав не
    /// поредеет сам естественным образом (см. §2.2 исследования — уже
    /// вошедших сервер никогда не выгоняет).
    pub fn effective_max_participants(&self) -> usize {
        self.settings.max_participants.unwrap_or(*crate::MAX_PARTICIPANTS)
    }
}

/// Общее состояние всех комнат.
pub type SharedRooms = Arc<Mutex<HashMap<String, Room>>>;

/// Скользящее окно меток времени по IP: сколько раз этот IP постучался за
/// последние `window`. Общий тип для обоих per-IP лимитов (создание комнат,
/// заявки в лобби) — см. `check_ip_rate_limit`.
pub type IpRateLimitMap = Arc<Mutex<HashMap<String, VecDeque<Instant>>>>;

/// Состояние приложения, разделяемое между всеми обработчиками axum:
/// комнаты целиком в памяти, никакого внешнего хранилища.
#[derive(Clone)]
pub struct AppState {
    pub rooms: SharedRooms,
    /// Потолок числа комнат одновременно (H2, DoS-защита) — env `MAX_ROOMS`,
    /// дефолт см. `DEFAULT_MAX_ROOMS`. `POST /api/rooms` и `PUT`-восстановление
    /// при достижении отвечают `503`.
    pub max_rooms: usize,
    /// Per-IP лимит на `POST /api/rooms` (H2, DoS-защита): своя карта и свой
    /// бюджет, отдельный от `pending_join_ips` — см. комментарий у
    /// `PENDING_JOIN_IP_LIMIT` о том, почему бюджеты не общие.
    pub room_creation_ips: IpRateLimitMap,
    /// Per-IP лимит на попадание в лобби (M3, чтобы лобби не забить) — своя
    /// карта, отдельный бюджет от `room_creation_ips`.
    pub pending_join_ips: IpRateLimitMap,
    /// Per-IP лимит на прямой `join-room` в комнату (H2, docs/research-dos.md
    /// §3.2 — «главная дыра») — своя карта, отдельный бюджет и от
    /// `room_creation_ips`, и от `pending_join_ips` (см. `DEFAULT_JOIN_ROOM_IP_LIMIT`
    /// выше).
    pub join_room_ips: IpRateLimitMap,
    /// Канал активного broadcast-уведомления о шатдауне (SIGTERM/SIGINT, см.
    /// `crate::shutdown_signal`) — каждое `ws::handle_socket` подписывается
    /// на него при старте (`subscribe()`) и, получив сигнал, сам шлёт `Close`
    /// в свой сокет и завершает цикл, вместо того чтобы пассивно доживать до
    /// `terminationGracePeriodSeconds`/`SIGKILL` (см. docs/research-ops.md
    /// §1.0/§1.6 — «дешёвое улучшение», ~30-40с простоя сигналинга при
    /// активном созвоне в момент деплоя сводится к доле секунды). `broadcast`,
    /// а не `watch`/`Notify`: нужно одноразовое уведомление «пора закрываться»
    /// каждому подписчику, а не текущее состояние.
    pub shutdown: ShutdownSignal,
}

/// См. `AppState::shutdown`.
pub type ShutdownSignal = tokio::sync::broadcast::Sender<()>;

/// Отправить сообщение пиру; ошибка (пир уже отвалился) сознательно
/// игнорируется — чистку сделает его собственный обработчик сокета.
pub fn send_to(tx: &PeerTx, msg: ServerMessage) {
    let _ = tx.send(msg);
}

/// Внутренний идентификатор пира — обычный UUID.
pub fn generate_peer_id() -> String {
    Uuid::new_v4().to_string()
}

/// Короткий человекочитаемый roomId для URL: 8 символов из алфавита
/// без похожих друг на друга знаков (нет 0/o, 1/l/i). Энтропию берём из
/// UUIDv4, чтобы не тянуть отдельный крейт rand.
pub fn generate_room_id() -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Фоновая задача: раз в `REAPER_INTERVAL` проходит по всем комнатам и
/// удаляет:
///   - любую комнату старше `max_lifetime` (лимит длительности созвона, см.
///     docs/security.md, «Meeting Duration Ceiling») — НЕЗАВИСИМО от того, есть ли
///     в ней участники: перед удалением рассылает `room-expired` всем
///     участникам И всем ожидающим в лобби (писатель их сокетов сам закроет
///     соединение вслед за этим сообщением, см. `ws.rs::handle_socket`);
///   - комнаты, которые пусты (без единого участника) дольше `empty_ttl` —
///     как раньше, без рассылки (участников там уже нет, а `pending` в этот
///     момент уже пуст — см. `ws::cleanup_peer`, драйнится, когда комната
///     опустевает).
///
/// Инвариант конкурентности: весь проход по комнатам — синхронный
/// (`HashMap::retain`), лок держится только на время самого прохода, без
/// `.await` внутри критической секции (рассылка `send_to` — это просто
/// `UnboundedSender::send`, не блокирует и не ждёт).
pub async fn reap_rooms(rooms: SharedRooms, empty_ttl: Duration, max_lifetime: Duration) {
    let mut interval = tokio::time::interval(REAPER_INTERVAL);
    loop {
        interval.tick().await;
        let mut rooms_guard = rooms.lock().unwrap();
        rooms_guard.retain(|room_id, room| {
            if room.created_at.elapsed() >= max_lifetime {
                info!(room = %room_id, "комната старше лимита длительности созвона — удалена реапером (room-expired)");
                for p in room.participants.values() {
                    send_to(&p.tx, ServerMessage::RoomExpired {});
                }
                for p in room.pending.values() {
                    send_to(&p.tx, ServerMessage::RoomExpired {});
                }
                return false;
            }
            let expired_empty = room.participants.is_empty()
                && room.emptied_at.is_some_and(|t| t.elapsed() >= empty_ttl);
            if expired_empty {
                info!(room = %room_id, "комната пуста дольше TTL — удалена реапером");
            }
            !expired_empty
        });
    }
}

/// IP клиента для per-IP лимитов (H2/M3): `CF-Connecting-IP` (Cloudflare
/// подставляет реальный IP клиента даже через собственный proxy/tunnel) →
/// фолбэк первый адрес из `X-Forwarded-For` (на случай другого reverse-proxy
/// перед сервером) → фолбэк адрес пира сокета (прямое подключение без
/// proxy — например, локальный запуск). Не строгая защита от подделки (клиент
/// или недоверенный проксик может слать любой `CF-Connecting-IP`), но для
/// rate-limit этого достаточно — цель не аутентификация, а срезать грубый
/// флуд с одного адреса.
pub fn extract_client_ip(headers: &HeaderMap, peer_addr: Option<SocketAddr>) -> String {
    if let Some(ip) = headers
        .get("CF-Connecting-IP")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return ip.to_string();
    }
    if let Some(ip) = headers
        .get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return ip.to_string();
    }
    peer_addr
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Скользящий счётчик по IP: не более `limit` попаданий за `window` с одного
/// IP. Тот же приём, что чат-rate-limit в `ws.rs` (`VecDeque<Instant>`), но
/// на уровне целого `AppState`, а не одного соединения, и индексированный по
/// IP, а не по соединению — используется для `POST /api/rooms`
/// (`room_creation_ips`) и попадания в лобби (`pending_join_ips`).
///
/// Заодно чистит карту от IP, у которых все метки уже устарели — иначе она
/// росла бы бесконечно числом РАЗЛИЧНЫХ IP, когда-либо постучавшихся хоть
/// раз. Полный проход по карте на каждый вызов — сознательно простой вариант:
/// по масштабу проекта (личный сервер, единицы-десятки одновременных IP)
/// это дешевле отдельной фоновой задачи уборки.
pub fn check_ip_rate_limit(map: &IpRateLimitMap, ip: &str, limit: usize, window: Duration) -> bool {
    let now = Instant::now();
    let mut guard = map.lock().unwrap();
    guard.retain(|_, times| {
        while let Some(&oldest) = times.front() {
            if now.duration_since(oldest) > window {
                times.pop_front();
            } else {
                break;
            }
        }
        !times.is_empty()
    });
    let times = guard.entry(ip.to_string()).or_default();
    if times.len() >= limit {
        return false;
    }
    times.push_back(now);
    true
}
