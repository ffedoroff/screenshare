//! Состояние комнат, целиком в памяти процесса (БД по спецификации нет).
//!
//! Выбор синхронизации: `std::sync::Mutex` поверх `HashMap`, а не tokio-мьютекс
//! и не акторная схема. Обоснование: все критические секции короткие и не
//! содержат `.await` (отправка в `UnboundedSender` синхронна и не блокирует),
//! поэтому обычный мьютекс проще и быстрее асинхронного, а contention при
//! нашем масштабе (единицы комнат по ≤6 пиров) пренебрежим.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use uuid::Uuid;

use crate::protocol::ServerMessage;

/// Максимум зрителей в комнате одновременно.
pub const MAX_VIEWERS: usize = 5;

/// Канал для отправки сообщений конкретному WebSocket-соединению.
/// Писатель сокета читает из парного `UnboundedReceiver`.
pub type PeerTx = mpsc::UnboundedSender<ServerMessage>;

/// Комната: один вещающий + до `MAX_VIEWERS` зрителей.
pub struct Room {
    pub broadcaster_id: String,
    pub broadcaster_tx: PeerTx,
    pub viewers: HashMap<String, PeerTx>,
}

/// Общее состояние всех комнат.
pub type SharedRooms = Arc<Mutex<HashMap<String, Room>>>;

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
