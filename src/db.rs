//! Доступ к SQLite: история чата комнат.
//!
//! Сознательно без compile-time макросов sqlx (`query!`/`query_as!`) — они
//! проверяют SQL на этапе сборки против живой БД, а нам нужно, чтобы
//! `cargo build` проходил без запущенной БД. Поэтому везде обычные
//! `sqlx::query`/`query_as` с ручным биндингом и извлечением колонок.

use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::ChatHistoryEntry;

/// Сколько последних сообщений отдаём в `chat-history`.
pub const HISTORY_LIMIT: i64 = 50;

/// Задание для фонового писателя чата (см. `run_chat_writer`).
pub enum ChatWriteJob {
    /// Сохранить одно сообщение чата.
    Insert {
        session_id: i64,
        peer_id: String,
        name: Option<String>,
        text: String,
        ts: i64,
    },
    /// Барьер: сигнализирует через `done`, когда все задания, поставленные в
    /// очередь СТРОГО ДО этого барьера, уже записаны в БД. Нужен, чтобы
    /// `join-room` мог достоверно прочитать историю чата, не поймав гонку
    /// с ещё не закоммиченным последним сообщением (см. `flush_and_fetch_history`).
    Flush { done: oneshot::Sender<()> },
}

pub type ChatWriteTx = mpsc::UnboundedSender<ChatWriteJob>;

/// Единственный писатель чата в БД: обрабатывает задания строго по очереди
/// (FIFO), поэтому порядок сообщений в истории всегда совпадает с порядком
/// их отправки, а `Flush` гарантирует, что все более ранние вставки уже
/// закоммичены к моменту, когда придёт время читать историю. Доставка
/// сообщений живым участникам при этом не ждёт диск: она уже произошла
/// синхронной рассылкой в `ws::handle_chat` ДО постановки задания сюда —
/// этот писатель лишь отвечает за персистентность.
pub async fn run_chat_writer(pool: SqlitePool, mut rx: mpsc::UnboundedReceiver<ChatWriteJob>) {
    while let Some(job) = rx.recv().await {
        match job {
            ChatWriteJob::Insert { session_id, peer_id, name, text, ts } => {
                if let Err(e) =
                    insert_message(&pool, session_id, &peer_id, name.as_deref(), &text, ts).await
                {
                    tracing::error!("не удалось сохранить сообщение чата в БД: {e}");
                }
            }
            ChatWriteJob::Flush { done } => {
                let _ = done.send(());
            }
        }
    }
}

/// Дождаться, пока писатель обработает все задания, поставленные до этого
/// вызова (см. `ChatWriteJob::Flush`), и только потом прочитать историю —
/// иначе только что отправленное сообщение могло бы не попасть в выдачу.
pub async fn flush_and_fetch_history(
    chat_tx: &ChatWriteTx,
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Vec<ChatHistoryEntry>, sqlx::Error> {
    let (done_tx, done_rx) = oneshot::channel();
    // Если писатель почему-то уже недоступен — просто читаем как есть.
    let _ = chat_tx.send(ChatWriteJob::Flush { done: done_tx });
    let _ = done_rx.await;
    fetch_history(pool, session_id).await
}

/// Открыть пул соединений и применить миграции из `./migrations`.
pub async fn init_pool(database_url: &str) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .connect(database_url)
        .await
        .unwrap_or_else(|e| panic!("не удалось подключиться к БД {database_url}: {e}"));
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .unwrap_or_else(|e| panic!("не удалось применить миграции: {e}"));
    pool
}

/// Завести новую сессию комнаты (вызывается при `create-room`) и вернуть её id.
/// История чата ищется по этому id, а не по `room_id` — так переиспользование
/// короткого `roomId` не подмешивает историю прошлой комнаты.
pub async fn create_session(
    pool: &SqlitePool,
    room_id: &str,
    created_at_ms: i64,
) -> Result<i64, sqlx::Error> {
    let result = sqlx::query("INSERT INTO room_sessions (room_id, created_at) VALUES (?, ?)")
        .bind(room_id)
        .bind(created_at_ms)
        .execute(pool)
        .await?;
    Ok(result.last_insert_rowid())
}

/// Записать одно сообщение чата. Вызывается из `tokio::spawn`, поэтому
/// доставка сообщения участникам комнаты не ждёт диска.
pub async fn insert_message(
    pool: &SqlitePool,
    session_id: i64,
    peer_id: &str,
    name: Option<&str>,
    text: &str,
    ts_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO messages (session_id, peer_id, name, text, ts) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(peer_id)
    .bind(name)
    .bind(text)
    .bind(ts_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Последние `HISTORY_LIMIT` сообщений сессии в хронологическом порядке.
pub async fn fetch_history(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Vec<ChatHistoryEntry>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT peer_id, name, text, ts FROM messages \
         WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(HISTORY_LIMIT)
    .fetch_all(pool)
    .await?;

    let mut messages: Vec<ChatHistoryEntry> = rows
        .into_iter()
        .map(|row| ChatHistoryEntry {
            from_peer_id: row.get("peer_id"),
            name: row.get("name"),
            text: row.get("text"),
            ts: row.get("ts"),
        })
        .collect();
    // Достали в обратном порядке (LIMIT по последним), разворачиваем в хронологический.
    messages.reverse();
    Ok(messages)
}
