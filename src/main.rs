//! Точка входа: HTTP-сервер на axum.
//!
//! Backend делает ровно две вещи (по спецификации):
//!   1. Signaling-релей поверх WebSocket (`/ws`) — см. `ws.rs`. Сюда же
//!      подмешан текстовый чат комнаты с историей в SQLite (`db.rs`).
//!   2. Раздача статики фронтенда (`/`, `/room/{id}`, `/static/...`).
//! Плюс крошечный `/config` с ICE-серверами из переменных окружения.
//! Медиа через сервер по-прежнему не проходит.

mod db;
mod protocol;
mod state;
mod ws;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tracing::info;

use crate::state::AppState;

/// Каталог со статикой фронтенда. Настраивается через env `STATIC_DIR` (в
/// контейнере — например `/app/static`), а для `cargo run` без переменной
/// падаем на путь рядом с Cargo.toml, зафиксированный на этапе компиляции.
static STATIC_DIR: LazyLock<String> = LazyLock::new(|| {
    std::env::var("STATIC_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/static").to_string())
});

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,screenshare=debug".into()),
        )
        .init();

    let rooms = Arc::new(Mutex::new(HashMap::new()));

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://screenshare.db?mode=rwc".to_string());
    info!(url = %database_url, "подключение к БД истории чата");
    let db = db::init_pool(&database_url).await;

    let state = AppState { rooms, db };

    let app = Router::new()
        // Страница вещающего.
        .route("/", get(|| page("index.html")))
        // Страница зрителя: roomId фронтенд читает из URL сам.
        .route("/room/{room_id}", get(|_: Path<String>| page("room.html")))
        .route("/config", get(ice_config))
        .route("/healthz", get(healthz))
        .route("/version.json", get(version_json))
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
    axum::serve(listener, app)
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

/// Отдать HTML-страницу из static/.
async fn page(name: &str) -> Response {
    match tokio::fs::read_to_string(format!("{}/{name}", *STATIC_DIR)).await {
        Ok(body) => Html(body).into_response(),
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
        Ok(body) => ([(header::CONTENT_TYPE, content_type)], body).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// ICE-конфигурация для клиента: STUN всегда, TURN — если задан в окружении
/// (TURN_URL / TURN_USERNAME / TURN_PASSWORD; сервер turn-rs поднимается отдельно).
async fn ice_config() -> Json<serde_json::Value> {
    let mut servers = vec![json!({ "urls": "stun:stun.l.google.com:19302" })];
    if let Ok(url) = std::env::var("TURN_URL") {
        if !url.is_empty() {
            let mut turn = json!({ "urls": url });
            if let Ok(user) = std::env::var("TURN_USERNAME") {
                turn["username"] = json!(user);
            }
            if let Ok(pass) = std::env::var("TURN_PASSWORD") {
                turn["credential"] = json!(pass);
            }
            servers.push(turn);
        }
    }
    Json(json!({ "iceServers": servers }))
}
