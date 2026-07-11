-- История чата комнат.
--
-- room_sessions: одна запись на каждый вызов create-room. roomId — короткий
-- человекочитаемый идентификатор и может переиспользоваться после того, как
-- прежняя комната закрылась, поэтому история ищется по session_id, а не по
-- roomId — так переиспользование roomId не подмешивает чужую историю.
CREATE TABLE room_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Сообщения чата, привязаны к конкретной сессии комнаты.
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES room_sessions(id),
    peer_id TEXT NOT NULL,
    name TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
);

CREATE INDEX idx_messages_session_id ON messages(session_id);
