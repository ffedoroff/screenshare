# screenshare

Браузерный шеринг экрана «один вещает — несколько смотрят», без регистрации, чатов и записи.

## Архитектура

- **Топология — mesh P2P звездой вокруг вещающего.** Broadcaster держит по одному прямому `RTCPeerConnection` с каждым зрителем. Зрители друг с другом не соединяются.
- **Видео идёт напрямую между браузерами** по WebRTC (P2P). Через backend медиатрафик не проходит ни байтом.
- Весь WebRTC (`getDisplayMedia`, `createOffer`/`createAnswer`, ICE) — на фронтенде, на чистом JS. На Rust WebRTC-стек не используется.
- Backend (Rust/axum) делает ровно две вещи:
  1. signaling-релей поверх WebSocket (`/ws`) — пересылка offer/answer/ICE-кандидатов и управление комнатами;
  2. раздача статики фронтенда.
- Состояние комнат — в памяти процесса (`HashMap`), без БД.
- Лимит: **максимум 5 зрителей** на комнату одновременно; 6-й получает отказ `room-full`. Один broadcaster на комнату.
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
src/
  main.rs            — маршруты axum, /config, раздача статики, старт сервера
  protocol.rs         — типы сообщений сигналинга (ClientMessage/ServerMessage)
  state.rs            — состояние комнат в памяти (Room, SharedRooms, лимит зрителей)
  ws.rs               — обработчик WebSocket-соединений, релей и жизненный цикл комнат
static/
  index.html          — страница вещающего (broadcaster)
  room.html            — страница зрителя (roomId читается из URL на фронте)
  style.css            — общие стили, тёмная тема
  app.js / broadcaster.js / viewer.js — логика WebRTC и сигналинга на клиенте
```

## Протокол сигналинга (WebSocket, JSON)

Все сообщения — JSON с полем `type`. `offer`/`answer`/`ice-candidate` сервер не разбирает по смыслу, только маршрутизирует от отправителя к `targetPeerId`.

### Клиент → сервер

| type | поля | кто шлёт |
|---|---|---|
| `create-room` | — | broadcaster |
| `join-room` | `roomId`, `role: "viewer"` | viewer |
| `offer` | `targetPeerId`, `sdp` | broadcaster |
| `answer` | `targetPeerId`, `sdp` | viewer |
| `ice-candidate` | `targetPeerId`, `candidate` | оба |
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
| `room-full` | — | viewer |
| `room-not-found` | — | viewer |
| `broadcaster-left` | — | все зрители комнаты |
| `error` | `message` | отправителю |
