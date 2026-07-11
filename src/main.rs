//! Точка входа: HTTP-сервер на axum.
//!
//! Backend делает ровно две вещи (по спецификации):
//!   1. Signaling-релей поверх WebSocket (`/ws`) — см. `ws.rs`.
//!   2. Раздача статики фронтенда (`/`, `/room/{id}`, `/static/...`).
//! Плюс крошечный `/config` с ICE-серверами из переменных окружения.
//! Медиа через сервер не проходит.

mod protocol;
mod state;
mod ws;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tracing::info;

use crate::state::SharedRooms;

/// Статика лежит рядом с Cargo.toml; путь фиксируется на этапе компиляции,
/// поэтому `cargo run` работает из любой текущей директории.
const STATIC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/static");

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,screenshare=debug".into()),
        )
        .init();

    let rooms: SharedRooms = Arc::new(Mutex::new(HashMap::new()));

    let app = Router::new()
        // Страница вещающего.
        .route("/", get(|| page("index.html")))
        // Страница зрителя: roomId фронтенд читает из URL сам.
        .route("/room/{room_id}", get(|_: Path<String>| page("room.html")))
        .route("/config", get(ice_config))
        .route("/ws", get(ws::ws_handler))
        .route("/static/{*path}", get(static_file))
        .with_state(rooms);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось занять {addr}: {e}"));
    info!("сервер слушает http://localhost:{port}");
    axum::serve(listener, app).await.expect("серверу конец");
}

/// Отдать HTML-страницу из static/.
async fn page(name: &str) -> Response {
    match tokio::fs::read_to_string(format!("{STATIC_DIR}/{name}")).await {
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
    match tokio::fs::read(format!("{STATIC_DIR}/{path}")).await {
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
