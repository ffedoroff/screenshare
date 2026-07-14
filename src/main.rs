//! Точка входа: HTTP-сервер на axum.
//!
//! Backend делает ровно три вещи (по спецификации):
//!   1. Signaling-релей поверх WebSocket (`/ws`) — см. `ws.rs`. Текстовый чат
//!      комнаты сюда почти не попадает: он идёт напрямую между участниками
//!      по mesh RTCDataChannel (см. `static/chat.js`), сервер лишь релеит
//!      адресный fallback, если шина до конкретного пира ещё не открыта, и
//!      не хранит ни байта из содержимого чата.
//!   2. Раздача статики фронтенда (`/`, `/r/{id}`, `/static/...`).
//!   3. Крошечный `/config` с ICE-серверами из переменных окружения.
//! Медиа через сервер по-прежнему не проходит.
//!
//! Ш1 (E2E-шифрование, см. static/crypto.js): сервер релеит sdp/candidate/
//! info/имя участника/fallback-чат уже ЗАШИФРОВАННЫМИ клиентом (ключ комнаты
//! — секрет только фрагмента ссылки, сервер его никогда не видел и не
//! видит) — с точки зрения этого файла и `ws.rs` ничего не изменилось, они
//! как релеили опаковый JSON/строку, так и продолжают. QR-код (раньше
//! `GET /qr.svg`) теперь рендерится ЛОКАЛЬНО в браузере (см.
//! `static/vendor/qrcode.js`, `static/room.js`), чтобы ссылка с секретным
//! `#k` не уходила на сервер ради картинки — этот эндпоинт удалён целиком.
//!
//! Приватность: на диске не остаётся ничего — ни IP/портов клиентов (в
//! tracing-логах фигурируют только room/peer id), ни содержимого чата
//! (сервер его не видит и не хранит вовсе — см. выше), ни какой бы то ни
//! было информации о сессии. Комната умирает — умирает вся её память
//! (участники, имена).
//!
//! Ш2 (разнесение доверия, см. docs/self-hosting.md, «Split Origin (Frontend
//! / Signaling Separated)», и docs/e2e-encryption.md, «Trust Split»): статика
//! фронтенда может уехать на отдельный статический хостинг, этот сервер
//! остаётся ТОЛЬКО API/WS на отдельном хосте (a separate API host) — фронт и
//! бэкенд МОГУТ жить на разных origin. Отсюда: CORS на кросс-оригин
//! HTTP-эндпоинтах (`cors_middleware` ниже, включается через env
//! `CORS_ORIGIN`) и опциональная проверка `Origin`
//! на `/ws` (см. `ws.rs::ws_handler`) — оба выключены (никаких заголовков,
//! никакой проверки) по умолчанию, пока `CORS_ORIGIN` не задан, так что
//! локалка и нынешний прод (статика и API ещё на одном хосте) ведут себя
//! ровно как раньше.

mod protocol;
mod state;
mod ws;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use axum::Router;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::json;
use sha1::Sha1;
use tracing::{info, warn};
use uuid::Uuid;

use crate::protocol::RoomSettings;
use crate::state::{
    check_ip_rate_limit, extract_client_ip, AppState, Room, DEFAULT_MAX_ROOMS,
    DEFAULT_MAX_ROOM_LIFETIME_SECONDS, ROOM_CREATION_IP_LIMIT, ROOM_CREATION_IP_WINDOW,
};

/// Каталог со статикой фронтенда. Настраивается через env `STATIC_DIR` (в
/// контейнере — например `/app/static`), а для `cargo run` без переменной
/// падаем на путь рядом с Cargo.toml, зафиксированный на этапе компиляции.
static STATIC_DIR: LazyLock<String> = LazyLock::new(|| {
    std::env::var("STATIC_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/static").to_string())
});

/// Ш2 (разнесение доверия — статика уезжает на отдельный статический хостинг,
/// этот сервер остаётся только API/WS на отдельном хосте, см.
/// docs/self-hosting.md, «Split Origin (Frontend / Signaling Separated)»):
/// разрешённый кросс-оригин для CORS, из env `CORS_ORIGIN` (например
/// `https://your-domain.example`). Пусто/не задано (дефолт — локалка и
/// однохостовый деплой, где фронт и API ещё на одном хосте) значит «CORS
/// выключен целиком»:
/// ни один Access-Control-* заголовок не шлётся (см. `cors_middleware`) — с
/// точки зрения браузера ничего не изменилось по сравнению с тем, как сервер
/// вёл себя раньше.
pub(crate) static CORS_ORIGIN: LazyLock<Option<String>> = LazyLock::new(|| {
    std::env::var("CORS_ORIGIN")
        .ok()
        .filter(|v| !v.is_empty())
});

/// Лимит длительности созвона (см. docs/security.md, «Meeting Duration
/// Ceiling»): комната старше этого возраста удаляется реапером (`state::reap_rooms`)
/// целиком, даже если в ней есть живые участники — им перед этим рассылается
/// `room-expired`. Env `MAX_ROOM_LIFETIME_SECONDS`, дефолт 3 часа
/// (`DEFAULT_MAX_ROOM_LIFETIME_SECONDS`). `LazyLock` (как `CORS_ORIGIN` выше)
/// читает env один раз при первом обращении — этого достаточно, значение не
/// меняется на лету; используется и здесь при спауне реапера, и в `ws.rs`
/// (`room_expires_in_seconds`) при подсчёте остатка для `Joined`.
pub(crate) static MAX_ROOM_LIFETIME: LazyLock<Duration> = LazyLock::new(|| {
    let secs: u64 = std::env::var("MAX_ROOM_LIFETIME_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_ROOM_LIFETIME_SECONDS);
    Duration::from_secs(secs)
});

/// CORS вручную, без tower-http: у нас всего три кросс-оригин HTTP-пути
/// (`/api/rooms` (+`/api/rooms/{id}`), `/config`, `/version.json`) — тащить
/// отдельный крейт (лишняя компиляция, лишняя поверхность) ради заголовков на
/// три хендлера показалось overkill; сам протокол CORS здесь тривиален
/// (никаких credentials/cookies, один статичный allow-list origin из env).
/// Применяется точечно через `.route_layer()` только к этим маршрутам (см.
/// main()) — остальные (статика, `/`, `/r/{id}`, `/ws`) не тратят на него
/// ничего.
///
/// Preflight `OPTIONS` перехватывается и ЗДЕСЬ ЖЕ, до вызова хендлера маршрута
/// (тем хендлерам метод OPTIONS не зарегистрирован вовсе) — отвечаем `204` с
/// теми же заголовками. Если `CORS_ORIGIN` не задан, никакие Access-Control-*
/// заголовки не добавляются вообще (см. `CORS_ORIGIN` выше) — но сам ответ
/// `204` на OPTIONS сервер всё равно отдаст; практического значения это не
/// имеет, т.к. same-origin запросы preflight не вызывают.
async fn cors_middleware(req: Request, next: Next) -> Response {
    let mut response = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };

    if let Some(origin) = CORS_ORIGIN.as_deref() {
        let headers = response.headers_mut();
        match HeaderValue::from_str(origin) {
            Ok(v) => {
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            }
            Err(e) => warn!("CORS_ORIGIN={origin:?} не годится в заголовок: {e}"),
        }
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
    }

    // M2 (security-заголовки на API-ответах): применяются на тех же
    // маршрутах, что и CORS выше (`/api/rooms`, `/config`, `/version.json` —
    // см. `.route_layer(cors...)` в `main()`), НЕЗАВИСИМО от того, задан ли
    // `CORS_ORIGIN` — это чисто ответные заголовки, не про кросс-ориджин.
    // Страницы (`page()`/`static_file()`) их не получают — эта мидлварь на
    // них не навешана вовсе (см. main()), фронт-статика уезжает на Cloudflare
    // Pages и заголовки страниц настраивает через `_headers` сама.
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));

    response
}

/// Handler-заглушка для метода `OPTIONS` на CORS-маршрутах. Тело НИКОГДА не
/// выполняется: `cors_middleware` перехватывает `OPTIONS` до вызова
/// `next.run()` и отвечает сам. Он всё равно должен существовать: у axum
/// `MethodRouter` без зарегистрированного `OPTIONS` коротит незнакомый метод
/// сразу в `405 Method Not Allowed` — ДО того, как запрос вообще дойдёт до
/// `route_layer`-мидлвари (её накат `.route_layer()` оборачивает только уже
/// зарегистрированные на этом MethodRouter методы, а не 405-фоллбэк) — без
/// этой заглушки preflight OPTIONS никогда бы не увидел CORS-заголовки.
async fn options_stub() -> StatusCode {
    StatusCode::NO_CONTENT
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,screenshare=debug".into()),
        )
        .init();

    let rooms = Arc::new(Mutex::new(HashMap::new()));

    // Сколько пустая комната (никого не подключилось / все вышли) живёт до
    // удаления реапером. Дефолт 120с — время создателю перейти по ссылке;
    // в тестах выставляется значительно короче.
    let empty_room_ttl_secs: u64 = std::env::var("EMPTY_ROOM_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let empty_room_ttl = Duration::from_secs(empty_room_ttl_secs);
    // Лимит длительности созвона (см. docs/security.md, «Meeting Duration
    // Ceiling») — читаем сразу (форсируем LazyLock), чтобы значение зафиксировалось до
    // спауна реапера и первого запроса.
    let max_room_lifetime = *MAX_ROOM_LIFETIME;
    tokio::spawn(state::reap_rooms(rooms.clone(), empty_room_ttl, max_room_lifetime));

    // H2 (DoS-защита): потолок числа комнат одновременно — env `MAX_ROOMS`,
    // дефолт `DEFAULT_MAX_ROOMS`.
    let max_rooms: usize = std::env::var("MAX_ROOMS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_ROOMS);

    let state = AppState {
        rooms,
        max_rooms,
        room_creation_ips: Arc::new(Mutex::new(HashMap::new())),
        pending_join_ips: Arc::new(Mutex::new(HashMap::new())),
    };

    // Ш2: CORS-мидлварь навешивается ТОЧЕЧНО только на кросс-оригин
    // HTTP-эндпоинты (см. cors_middleware выше) — статика/страницы/`/ws` её
    // не видят вовсе.
    let cors = middleware::from_fn(cors_middleware);

    let app = Router::new()
        // Страница входа/лендинга.
        .route("/", get(|| page("index.html")))
        // Страница комнаты: roomId фронтенд читает из URL сам.
        .route("/r/{room_id}", get(|_: Path<String>| page("room.html")))
        .route(
            "/api/rooms",
            post(create_room)
                .options(options_stub)
                .route_layer(cors.clone()),
        )
        .route(
            "/api/rooms/{room_id}",
            put(restore_room)
                .options(options_stub)
                .route_layer(cors.clone()),
        )
        .route(
            "/config",
            get(ice_config).options(options_stub).route_layer(cors.clone()),
        )
        .route("/healthz", get(healthz))
        .route(
            "/version.json",
            get(version_json).options(options_stub).route_layer(cors),
        )
        .route("/ws", get(ws::ws_handler))
        .route("/static/{*path}", get(static_file))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось занять {addr}: {e}"));
    info!("сервер слушает http://localhost:{port}");
    // `with_connect_info`: нужен для `ConnectInfo<SocketAddr>` в
    // `ws::ws_handler`/`create_room` — фолбэк-источник IP клиента для
    // per-IP лимитов (H2/M3), когда ни `CF-Connecting-IP`, ни
    // `X-Forwarded-For` не пришли (прямое подключение без proxy).
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("серверу конец");
}

/// Ждёт SIGTERM (стандартный сигнал остановки в k8s) или SIGINT (Ctrl+C
/// локально). По любому из них сервер перестаёт принимать новые соединения
/// и завершается, дав in-flight запросам/сокетам доработать.
async fn shutdown_signal() {
    let sigterm = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("не удалось подписаться на SIGTERM")
            .recv()
            .await;
    };
    let sigint = async {
        tokio::signal::ctrl_c()
            .await
            .expect("не удалось подписаться на SIGINT");
    };
    tokio::select! {
        _ = sigterm => info!("получен SIGTERM, завершаемся"),
        _ = sigint => info!("получен SIGINT, завершаемся"),
    }
}

/// `POST /api/rooms`: создать новую ПУСТУЮ комнату (протокол v2 — комната
/// заводится отдельно от входа в неё, чтобы создатель успел скопировать и
/// открыть ссылку). Тело запроса опционально и сейчас не используется
/// (задел на будущее — например, название комнаты), поэтому сознательно не
/// парсится вовсе.
///
/// Комната без единого участника живёт `EMPTY_ROOM_TTL_SECONDS` — если за
/// это время никто не подключится, реапер (`state::reap_rooms`) её
/// удалит.
///
/// Возвращает вместе с `roomId` одноразовый `leaderToken` (см.
/// docs/permissions-and-leader.md): создатель предъявляет его в своём `join-room`, чтобы
/// стать лидером комнаты — токен сгорает при первом же успешном предъявлении
/// (совпавшем с хранимым). Если никто не предъявит токен, лидером станет
/// первый вошедший как обычно.
async fn create_room(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // H2 (DoS-защита): per-IP лимит — не больше ROOM_CREATION_IP_LIMIT
    // запросов за ROOM_CREATION_IP_WINDOW с одного IP (см. её комментарий в
    // state.rs про то, почему бюджет отдельный от лобби).
    let ip = extract_client_ip(&headers, Some(peer_addr));
    if !check_ip_rate_limit(&state.room_creation_ips, &ip, ROOM_CREATION_IP_LIMIT, ROOM_CREATION_IP_WINDOW) {
        warn!(%ip, "превышен per-IP лимит создания комнат — 429");
        return (StatusCode::TOO_MANY_REQUESTS, "too many rooms created, slow down").into_response();
    }

    let room_id = state::generate_room_id();
    let leader_token = Uuid::new_v4().to_string();

    let mut rooms_guard = state.rooms.lock().unwrap();
    // H2 (DoS-защита): глобальный потолок числа комнат — проверяем ПОД ТЕМ
    // ЖЕ локом, что и вставку ниже, иначе гонка двух одновременных create_room
    // могла бы обе пройти проверку и вместе превысить потолок.
    if rooms_guard.len() >= state.max_rooms {
        drop(rooms_guard);
        warn!(max_rooms = state.max_rooms, "потолок числа комнат достигнут — 503");
        return (StatusCode::SERVICE_UNAVAILABLE, "server busy").into_response();
    }
    // Коллизия 8-символьного id астрономически маловероятна (32^8 вариантов);
    // в теоретическом проигрышном случае просто отказываем — клиент повторит
    // запрос.
    if rooms_guard.contains_key(&room_id) {
        drop(rooms_guard);
        warn!(room = %room_id, "коллизия roomId при создании — отказ");
        return (StatusCode::INTERNAL_SERVER_ERROR, "try again").into_response();
    }
    rooms_guard.insert(
        room_id.clone(),
        Room {
            participants: HashMap::new(),
            screen_owner: None,
            // Сразу помечена «пустой»: если никто не подключится за TTL,
            // реапер её удалит.
            emptied_at: Some(Instant::now()),
            leader_id: None,
            leader_token: Some(leader_token.clone()),
            settings: RoomSettings::default(),
            pending: HashMap::new(),
            created_at: Instant::now(),
        },
    );
    drop(rooms_guard);
    info!(room = %room_id, "комната создана (пустая)");

    (
        StatusCode::CREATED,
        Json(json!({ "roomId": room_id, "leaderToken": leader_token })),
    )
        .into_response()
}

/// `PUT /api/rooms/{room_id}`: идемпотентное восстановление комнаты после
/// рестарта сервера (см. docs/self-hosting.md, «Surviving a Restart/Redeploy»)
/// — вся память комнат целиком в процессе, поэтому рестарт стирает её без следа, а
/// клиенты при авто-reconnect могут наткнуться на `room-not-found` для
/// комнаты, в которой только что были. Вместо того чтобы это было тупиком,
/// фронтенд (см. `static/room.js`) в ответ на `room-not-found` при
/// переподключении сначала бьёт сюда с ЗАПОМНЕННЫМ `roomId`, а затем повторяет
/// `join-room`.
///
/// Семантика идемпотентности:
///   - `room_id` не соответствует формату (`^[a-z0-9]{8}$`, см.
///     `is_valid_room_id`) — `400`;
///   - комнаты с таким id нет — создаём пустую (как `POST /api/rooms`, но с
///     заданным, а не случайным id) — `201`;
///   - комната уже есть (не важно, пуста или с участниками) — ничего не
///     трогаем, просто подтверждаем — `200`.
///
/// Про безопасность восстановления по известному id: комнаты в этом проекте
/// эфемерны и не имеют отдельного контроля доступа — единственный секрет это
/// сам `roomId` в ссылке (см. docs/privacy.md). Восстановление по
/// уже известному клиенту id НИЧЕГО не расширяет по доступу — кто знал
/// ссылку до рестарта, тот и после рестарта мог бы просто получить
/// `room-not-found` и создать СВОЮ новую комнату с другим id; этот эндпоинт
/// лишь избавляет знающего ссылку от необходимости создавать новую и
/// рассылать её заново остальным участникам. Кто ссылку не знал — не может
/// подобрать `room_id` (8 символов из ограниченного алфавита) практическим
/// перебором ни через этот эндпоинт, ни через `POST /api/rooms`.
async fn restore_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Response {
    if !is_valid_room_id(&room_id) {
        return (StatusCode::BAD_REQUEST, "invalid room id").into_response();
    }

    let mut rooms_guard = state.rooms.lock().unwrap();
    if rooms_guard.contains_key(&room_id) {
        drop(rooms_guard);
        return (StatusCode::OK, Json(json!({ "roomId": room_id }))).into_response();
    }
    // H2 (DoS-защита): тот же глобальный потолок, что в create_room, под тем
    // же локом — восстановление НЕсуществующей комнаты тоже создаёт запись.
    if rooms_guard.len() >= state.max_rooms {
        drop(rooms_guard);
        warn!(max_rooms = state.max_rooms, "потолок числа комнат достигнут — 503 (restore)");
        return (StatusCode::SERVICE_UNAVAILABLE, "server busy").into_response();
    }
    rooms_guard.insert(
        room_id.clone(),
        Room {
            participants: HashMap::new(),
            screen_owner: None,
            emptied_at: Some(Instant::now()),
            // Восстановленная комната токен лидера не выдаёт — лидером
            // станет первый вошедший (см. docs/permissions-and-leader.md).
            leader_id: None,
            leader_token: None,
            settings: RoomSettings::default(),
            pending: HashMap::new(),
            // Отсчёт лимита длительности созвона — с момента восстановления,
            // а не какого-то исходного создания (память о нём не переживает
            // рестарт сервера) — см. комментарий у Room::created_at.
            created_at: Instant::now(),
        },
    );
    drop(rooms_guard);
    info!(room = %room_id, "комната восстановлена после рестарта (PUT /api/rooms/{{id}})");

    (StatusCode::CREATED, Json(json!({ "roomId": room_id }))).into_response()
}

/// Проба готовности/живости для k8s: если процесс отвечает на HTTP — он жив.
async fn healthz() -> &'static str {
    "ok"
}

/// Версия задеплоенного артефакта (стандарт versioning-release.md):
/// APP_VERSION/GIT_COMMIT/BUILD_DATE впекает CI через build-args Dockerfile.
/// Клиенты могут сверять версию для детекта version-skew (баннер «обновите
/// страницу» — задел на будущее). Локальный `cargo run` отдаёт "dev".
async fn version_json() -> Json<serde_json::Value> {
    let env_or = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    Json(json!({
        "version": env_or("APP_VERSION", "dev"),
        "commit": env_or("GIT_COMMIT", "unknown"),
        "buildDate": env_or("BUILD_DATE", "unknown"),
    }))
}

/// Запрет кэширования страниц и статики. Без этого Cloudflare кэширует
/// .css/.js на edge по расширению (origin не слал Cache-Control), и после
/// деплоя браузеры получали СТАРУЮ статику к новой разметке — страницы
/// выглядели разломанными до истечения edge-TTL (поймано живой проверкой
/// прода 2026-07-12). Файлы крошечные, безусловный no-cache дешевле и
/// надёжнее ETag-механики.
const NO_CACHE: (header::HeaderName, &str) = (header::CACHE_CONTROL, "no-cache");

/// Отдать HTML-страницу из static/.
async fn page(name: &str) -> Response {
    match tokio::fs::read_to_string(format!("{}/{name}", *STATIC_DIR)).await {
        Ok(body) => ([NO_CACHE], Html(body)).into_response(),
        Err(e) => {
            tracing::error!("нет файла статики {name}: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "static file missing").into_response()
        }
    }
}

/// Отдать ассет из static/ (js/css). Без сторонних крейтов: файлов три штуки,
/// полноценный ServeDir не нужен.
async fn static_file(Path(path): Path<String>) -> Response {
    // Защита от выхода за пределы каталога.
    if path.contains("..") || path.contains('\\') {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }
    let content_type = match path.rsplit('.').next() {
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(format!("{}/{path}", *STATIC_DIR)).await {
        Ok(body) => ([(header::CONTENT_TYPE, content_type), (NO_CACHE.0, NO_CACHE.1)], body).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// H1 (эфемерные TURN-креды, см. docs/security.md, «H1 — Ephemeral TURN
/// Credentials», и docs/self-hosting.md, «TURN (Optional)»): срок жизни
/// каждой выданной `/config` пары username/credential — час достаточно на
/// звонок (см. `MAX_ROOM_LIFETIME` — комнаты и так живут не дольше 3ч по
/// умолчанию, а сам созвон переустанавливать ICE каждый час не должен: раз
/// установленное TURN-allocation клиент продолжает рефрешить тем же
/// credential, полученным при входе). НЕ энфорсится сервером turn-rs (см.
/// предупреждение в `ice_config` ниже) — реальная граница жизни утёкшей
/// пары задаётся ротацией `TURN_STATIC_SECRET`, а не этим числом.
const TURN_CRED_TTL_SECONDS: u64 = 3600;

/// Текущее unix-время в секундах. `unwrap_or_default()` на случай часов
/// раньше эпохи (не должно происходить на реальном сервере) — деградирует
/// в `0`, что для TTL-расчёта означает «уже истекло», а не панику.
fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// `credential = base64(HMAC-SHA1(secret, username))` — ровно та схема TURN
/// REST API (coturn-style long-term credentials,
/// draft-uberti-behave-turn-rest-00 §2.2), которую понимает turn-rs через
/// `auth.static-auth-secret` (проверено по его исходникам,
/// `codec::crypto::static_auth_secret` в mycrl/turn-rs, считает буквально
/// то же самое перед тем, как вывести из результата долгоживущий ключ
/// `MD5(username:realm:password)`).
fn turn_hmac_credential(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC-SHA1 принимает ключ произвольной длины");
    mac.update(username.as_bytes());
    BASE64_STANDARD.encode(mac.finalize().into_bytes())
}

/// ICE-конфигурация для клиента: STUN всегда, TURN — если задан `TURN_URL`
/// (сервер turn-rs поднимается отдельно, см. `deploy/manifests/turn.yaml`).
///
/// H1 (было — открытый релей): раньше сервер отдавал СТАТИЧЕСКИЙ
/// `TURN_USERNAME`/`TURN_PASSWORD` любому, кто вызвал `/config` — пара
/// валидна бессрочно, пока админ не поменяет её руками сразу в двух местах
/// (Secret turn-rs и Secret этого сервера) и не перезапустит оба — кто
/// угодно, взяв её один раз, мог гонять свой трафик через наш TURN сколько
/// угодно (кража bandwidth чужого хостера).
///
/// Теперь, если задан `TURN_STATIC_SECRET`, каждый вызов `/config` получает
/// СВОЮ, отдельно вычисленную пару:
///   - `username = "<unix-время-истечения>:chat"`;
///   - `credential = base64(HMAC-SHA1(TURN_STATIC_SECRET, username))`
///     (см. `turn_hmac_credential`).
///
/// ВАЖНО, честно: сам turn-rs эту встроенную в `username` метку времени НЕ
/// проверяет — по его исходникам (`codec::crypto::static_auth_secret`),
/// комментарий там прямо говорит, что RFC не обязывает к проверке
/// временной метки и что за её актуальность отвечает внешний сервис.
/// Значит, TTL здесь — это НЕ жёсткая граница на стороне TURN-сервера
/// (протухшая по времени пара всё равно пройдёт HMAC-проверку и позволит
/// и дальше рефрешить существующее allocation, и даже создать новое): это
/// (а) метка для аудита в логах turn-rs (`get_password: username=...`), и
/// (б) единица, синхронная с ПЕРИОДИЧЕСКОЙ РОТАЦИЕЙ `TURN_STATIC_SECRET` —
/// именно ротация секрета (не встроенная метка) одним действием обесценивает
/// вообще все ранее выданные пары сразу, и теперь для этого достаточно
/// поменять ОДНО значение в ОДНОМ Secret'е, а не логин и пароль в двух
/// разных местах синхронно. Настоящая серверная проверка срока (turn-rs
/// умеет и её — `auth.enable-hooks-auth` + `hooks.endpoint`, вызов НАШЕГО
/// вебхука на каждый `get_password`) — отдельная фаза, здесь не сделана.
///
/// Обратная совместимость: если `TURN_STATIC_SECRET` не задан, но заданы
/// старые `TURN_USERNAME`/`TURN_PASSWORD` — отдаём их как раньше (тот же
/// статический риск, просто ещё не смигрировали на секрет). Если не задано
/// вообще ничего — клиент получает только STUN, как и было.
async fn ice_config() -> Json<serde_json::Value> {
    let mut servers = vec![json!({ "urls": "stun:stun.l.google.com:19302" })];
    if let Ok(url) = std::env::var("TURN_URL") {
        if !url.is_empty() {
            let mut turn = json!({ "urls": url });
            let static_secret = std::env::var("TURN_STATIC_SECRET")
                .ok()
                .filter(|s| !s.is_empty());
            if let Some(secret) = static_secret {
                let expiry = unix_now_secs() + TURN_CRED_TTL_SECONDS;
                let username = format!("{expiry}:chat");
                let credential = turn_hmac_credential(&secret, &username);
                turn["username"] = json!(username);
                turn["credential"] = json!(credential);
            } else {
                // Фоллбэк обратной совместимости — старая статическая пара.
                if let Ok(user) = std::env::var("TURN_USERNAME") {
                    turn["username"] = json!(user);
                }
                if let Ok(pass) = std::env::var("TURN_PASSWORD") {
                    turn["credential"] = json!(pass);
                }
            }
            servers.push(turn);
        }
    }
    Json(json!({ "iceServers": servers }))
}

/// `room` валиден по `^[a-z0-9]{8}$` (то же множество символов, что генерирует
/// `state::generate_room_id`, плюс цифры 0/1, которые генератор не использует,
/// но которые не вредно принять во входной валидации).
fn is_valid_room_id(room: &str) -> bool {
    room.len() == 8 && room.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// H1 (эфемерные TURN-креды): юнит-проверка `turn_hmac_credential` и
/// формата `username`, без подъёма сервера/turn-rs (для end-to-end
/// проверки формата ответа `/config` см. docs/security.md, «H1 — Ephemeral
/// TURN Credentials» — curl локально поднятого сервера с тестовым
/// `TURN_STATIC_SECRET`).
#[cfg(test)]
mod turn_credential_tests {
    use super::*;

    #[test]
    fn hmac_credential_is_deterministic_valid_base64_and_input_sensitive() {
        let secret = "test-secret";
        let username = "1234567890:chat";

        let cred1 = turn_hmac_credential(secret, username);
        let cred2 = turn_hmac_credential(secret, username);
        assert_eq!(cred1, cred2, "тот же вход должен давать тот же credential");
        assert!(!cred1.is_empty());
        assert!(
            BASE64_STANDARD.decode(&cred1).is_ok(),
            "credential должен быть валидным base64: {cred1:?}"
        );

        let cred_other_username = turn_hmac_credential(secret, "1234567891:chat");
        assert_ne!(
            cred1, cred_other_username,
            "другой username должен давать другой credential"
        );

        let cred_other_secret = turn_hmac_credential("другой-секрет", username);
        assert_ne!(
            cred1, cred_other_secret,
            "другой secret должен давать другой credential"
        );
    }

    #[test]
    fn username_format_is_expiry_colon_label_and_expiry_is_in_the_future() {
        let now = unix_now_secs();
        let expiry = now + TURN_CRED_TTL_SECONDS;
        let username = format!("{expiry}:chat");

        let (ts_part, label) = username
            .split_once(':')
            .expect("username должен быть вида '<unix_ts>:label'");
        let ts: u64 = ts_part
            .parse()
            .expect("часть до ':' должна парситься как unix-timestamp");

        assert_eq!(label, "chat");
        assert!(ts > now, "expiry должен быть в будущем относительно момента генерации");
        assert_eq!(ts - now, TURN_CRED_TTL_SECONDS);
    }
}
