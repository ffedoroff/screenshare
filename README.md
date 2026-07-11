# screenshare

Браузерный шеринг экрана «один вещает — несколько смотрят», без регистрации и записи. Плюс текстовый чат комнаты с историей.

## Архитектура

- **Топология — mesh P2P звездой вокруг вещающего.** Broadcaster держит по одному прямому `RTCPeerConnection` с каждым зрителем. Зрители друг с другом не соединяются.
- **Видео идёт напрямую между браузерами** по WebRTC (P2P). Через backend медиатрафик не проходит ни байтом.
- Весь WebRTC (`getDisplayMedia`, `createOffer`/`createAnswer`, ICE) — на фронтенде, на чистом JS. На Rust WebRTC-стек не используется.
- Backend (Rust/axum) делает ровно две вещи:
  1. signaling-релей поверх WebSocket (`/ws`) — пересылка offer/answer/ICE-кандидатов, чат комнаты и управление комнатами;
  2. раздача статики фронтенда.
- Состояние комнат (кто в какой комнате, каналы для рассылки) — в памяти процесса (`HashMap`). История чата — в SQLite (`sqlx`, без compile-time query-макросов).
- Лимит: **максимум 5 зрителей** на комнату одновременно; 6-й получает отказ `room-full`. Один broadcaster на комнату.
- Чат: до 2000 символов на сообщение, до 10 сообщений за 10 секунд с одного соединения; хранятся последние 50 сообщений на сессию комнаты.
- STUN — публичный `stun:stun.l.google.com:19302`. TURN — опциональный, отдельный сервер (например `turn-rs`), настраивается через переменные окружения.

## Запуск

```
cargo run
```

По умолчанию сервер слушает порт `3000`. Открыть в браузере: http://localhost:3000

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `PORT` | нет (по умолчанию `3000`) | порт HTTP/WebSocket-сервера |
| `DATABASE_URL` | нет (по умолчанию `sqlite://screenshare.db?mode=rwc`) | путь к SQLite-БД истории чата; миграции применяются автоматически при старте |
| `TURN_URL` | нет | адрес TURN-сервера (например `turn:example.com:3478`) |
| `TURN_USERNAME` | нет | логин для TURN |
| `TURN_PASSWORD` | нет | пароль для TURN |

Если `TURN_URL` не задан, клиент получает от `/config` только STUN-сервер Google. TURN нужен, если P2P-соединение не устанавливается напрямую (симметричный NAT и т.п.).

## Проверка локально в двух вкладках

`localhost` браузер считает secure context, поэтому `getDisplayMedia()` работает без HTTPS.

1. `cargo run`.
2. Вкладка 1: открыть http://localhost:3000, нажать «Начать трансляцию», выбрать источник (вкладку/окно/экран).
3. Скопировать появившуюся ссылку вида `http://localhost:3000/room/<roomId>`.
4. Вкладка 2 (или другое устройство в той же сети, если сервер слушает `0.0.0.0`): открыть эту ссылку — трансляция должна появиться в реальном времени.
5. Можно открыть ссылку из вкладки 4 в третьей и т.д., до 5 зрителей одновременно.

## Тестирование

Два независимых уровня, друг от друга не зависят.

### 1. Протокол сигналинга (без браузера)

```
node tests/signaling.test.mjs
```

Чистый Node (>= 22, без npm-зависимостей): сам собирает `cargo build`, поднимает
`./target/debug/screenshare` на порту 3311 с временной SQLite и гоняет полный
жизненный цикл комнаты/чата напрямую по WebSocket (`ws://`/`fetch`), без браузера.
Гарантированно убивает сервер за собой.

### 2. Браузерный e2e (реальный Chrome, реальный WebRTC-поток и чат)

```
cd tests/e2e && npm install && node basic.spec.mjs
```

Требуется установленный локально Google Chrome. `tests/e2e/` — отдельный
дев-инструментарий со своим `package.json` (единственная зависимость —
`playwright-core`; браузеры этот пакет не скачивает, тест использует
системный Chrome через `channel: 'chrome'`).

Сценарий: собирает и поднимает сервер на порту 3322 с временной SQLite,
открывает вещающего и двух зрителей в реальном Chrome, проверяет, что видео
реально идёт (`videoWidth`/`readyState`/растущий `currentTime`), чат работает
между всеми тремя участниками (включая бейдж непрочитанных у свёрнутой по
умолчанию панели), счётчик зрителей показывает 2, а закрытие вкладки
вещающего показывает зрителям оверлей «Трансляция завершена».

Про диалог `getDisplayMedia()` в автоматизации: реальный захват экрана в
Chrome требует либо клика пользователя в системном пикере, либо флагов вида
`--auto-select-desktop-capture-source=<имя источника>` и
`--use-fake-ui-for-media-stream`/`--use-fake-device-for-media-stream`. На
macOS это дополнительно упирается в системное разрешение «Screen Recording»
(TCC), которое нельзя выдать неинтерактивно — если оно не выдано, промис
`getDisplayMedia()` в headless/автоматизированном Chrome может зависать
надолго или навсегда независимо от флагов. В этом случае тест сам
детектирует таймаут и на уровне тестового арнесса (не трогая
`static/broadcaster.js`) подменяет `getDisplayMedia` на синтетический
источник (`canvas.captureStream()`), чтобы всё остальное (комната, чат,
счётчик, завершение) можно было проверить и дальше — это явно
помечается в выводе теста.

## TURN-сервер (turn-rs) рядом, кратко

Если STUN недостаточно (P2P не устанавливается за NAT), рядом поднимается `turn-rs`.

Docker:
```
docker run -d --network=host ghcr.io/webrtc-rs/turn-server \
  --public-ip <внешний-IP> --listening-port 3478 \
  --realm example.com --users "user=pass"
```

Или `cargo install turn-server` и запуск с теми же флагами (см. `--help`).

Приложению после этого выставить:
```
TURN_URL=turn:<внешний-IP>:3478
TURN_USERNAME=user
TURN_PASSWORD=pass
```

## Структура репозитория

```
Cargo.toml          — зависимости и метаданные крейта
Cargo.lock           — зафиксированные версии зависимостей
migrations/
  0001_chat.sql        — схема SQLite: room_sessions, messages
src/
  main.rs            — маршруты axum, /config, раздача статики, старт сервера, БД-пул
  protocol.rs         — типы сообщений сигналинга (ClientMessage/ServerMessage)
  state.rs            — состояние комнат в памяти (Room, SharedRooms, AppState, лимит зрителей)
  ws.rs               — обработчик WebSocket-соединений, релей, чат и жизненный цикл комнат
  db.rs               — доступ к SQLite: сессии комнат и история чата (runtime sqlx, без query!)
static/
  index.html          — страница вещающего (broadcaster)
  room.html            — страница зрителя (roomId читается из URL на фронте)
  style.css            — общие стили, тёмная тема
  app.js / broadcaster.js / viewer.js — логика WebRTC и сигналинга на клиенте
tests/
  signaling.test.mjs   — протокольный тест сигналинга/чата без браузера (см. «Тестирование»)
  e2e/                 — браузерный e2e на playwright-core + системный Chrome (см. «Тестирование»)
```

## Протокол сигналинга (WebSocket, JSON)

Все сообщения — JSON с полем `type`. `offer`/`answer`/`ice-candidate` сервер не разбирает по смыслу, только маршрутизирует от отправителя к `targetPeerId`. `chat` тоже не разбирается по смыслу — только валидируется (длина, rate-limit) и рассылается.

### Клиент → сервер

| type | поля | кто шлёт |
|---|---|---|
| `create-room` | `name?` (имя вещающего для чата) | broadcaster |
| `join-room` | `roomId`, `role: "viewer"`, `name?` (имя зрителя для чата) | viewer |
| `offer` | `targetPeerId`, `sdp` | broadcaster |
| `answer` | `targetPeerId`, `sdp` | viewer |
| `ice-candidate` | `targetPeerId`, `candidate` | оба |
| `chat` | `text` (≤2000 символов после trim) | оба |
| `leave` | — | оба (или закрытие сокета) |

### Сервер → клиент

| type | поля | кому |
|---|---|---|
| `room-created` | `roomId`, `peerId` | broadcaster |
| `joined` | `peerId`, `broadcasterId`, `viewerCount` | viewer |
| `peer-joined` | `peerId` | broadcaster |
| `peer-left` | `peerId` | broadcaster |
| `offer` | `fromPeerId`, `sdp` | viewer |
| `answer` | `fromPeerId`, `sdp` | broadcaster |
| `ice-candidate` | `fromPeerId`, `candidate` | целевой пир |
| `chat` | `fromPeerId`, `name`, `text`, `ts` (unix millis) | все участники комнаты, включая отправителя |
| `chat-history` | `messages: [{fromPeerId, name, text, ts}, ...]` | зрителю сразу после `joined` (последние 50, хронологически) |
| `room-full` | — | viewer |
| `room-not-found` | — | viewer |
| `broadcaster-left` | — | все зрители комнаты |
| `error` | `message` | отправителю |
