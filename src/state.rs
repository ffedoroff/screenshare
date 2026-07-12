//! Состояние комнат, целиком в памяти процесса. Никакого хранилища на диске:
//! всё (участники, имена) живёт ровно до тех пор, пока жив процесс и жива
//! сама комната — реапер или рестарт стирают всё без следа. Чат (см.
//! `static/chat.js`) сервер вообще не хранит — история живёт только в
//! памяти вкладок участников, здесь для неё нет ни поля, ни буфера.
//!
//! Выбор синхронизации: `std::sync::Mutex` поверх `HashMap`, а не tokio-мьютекс
//! и не акторная схема. Обоснование: все критические секции короткие и не
//! содержат `.await` (отправка в `UnboundedSender` синхронна и не блокирует,
//! а удаление устаревших комнат в реапере — тоже чисто синхронная операция
//! над `HashMap`), поэтому обычный мьютекс проще и быстрее асинхронного, а
//! contention при нашем масштабе (единицы комнат по ≤6 участников) пренебрежим.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;

use crate::protocol::ServerMessage;

/// Максимум участников в комнате одновременно (протокол v2: симметричная
/// комната, роли broadcaster/viewer больше не существует).
pub const MAX_PARTICIPANTS: usize = 6;

/// Как часто реапер проверяет комнаты на протухание. Сознательно чаще, чем
/// «раз в 5 секунд» могло бы показаться достаточным: TTL пустой комнаты в
/// тестах — 2 секунды, и с более редким тиком удаление легко перехлёстывает
/// за отведённое тестам время ожидания. Накладные расходы пренебрежимы —
/// комнат единицы, сама проверка — линейный проход по `HashMap` под коротким
/// локом без единого `.await`.
pub const REAPER_INTERVAL: Duration = Duration::from_secs(1);

/// Канал для отправки сообщений конкретному WebSocket-соединению.
/// Писатель сокета читает из парного `UnboundedReceiver`.
pub type PeerTx = mpsc::UnboundedSender<ServerMessage>;

/// Один участник комнаты: канал для рассылки ему сообщений + имя для чата.
pub struct Participant {
    pub tx: PeerTx,
    pub name: Option<String>,
}

/// Комната: до `MAX_PARTICIPANTS` равноправных участников, соединяющихся
/// mesh (сервер сам медиа не трогает — только сигналинг). Максимум один из
/// участников может в моменте шарить экран (`screen_owner`).
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
}

/// Общее состояние всех комнат.
pub type SharedRooms = Arc<Mutex<HashMap<String, Room>>>;

/// Состояние приложения, разделяемое между всеми обработчиками axum:
/// комнаты целиком в памяти, никакого внешнего хранилища.
#[derive(Clone)]
pub struct AppState {
    pub rooms: SharedRooms,
}

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

/// Фоновая задача: раз в `REAPER_INTERVAL` удаляет комнаты, которые пусты
/// (без единого участника) дольше `ttl`. Инвариант конкурентности: весь
/// проход по комнатам — синхронный (`HashMap::retain`), лок держится только
/// на время самого прохода, без `.await` внутри критической секции.
pub async fn reap_empty_rooms(rooms: SharedRooms, ttl: Duration) {
    let mut interval = tokio::time::interval(REAPER_INTERVAL);
    loop {
        interval.tick().await;
        let mut rooms_guard = rooms.lock().unwrap();
        rooms_guard.retain(|room_id, room| {
            let expired = room.participants.is_empty()
                && room.emptied_at.is_some_and(|t| t.elapsed() >= ttl);
            if expired {
                info!(room = %room_id, "комната пуста дольше TTL — удалена реапером");
            }
            !expired
        });
    }
}
