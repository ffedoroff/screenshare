// Интеграционный тест сигналинга (протокол v3+ — симметричная комната: все
// участники равны, mesh, шаринг экрана — временное состояние комнаты; чат
// на сервере не проходит вообще — только P2P-шина, серверный fallback-релей
// чата удалён, см. docs/chat.md/src/ws.rs). Гоняет полный жизненный цикл против
// САМОСТОЯТЕЛЬНО поднятого сервера (собирает cargo build, запускает
// ./target/debug/screenshare на порту 3311 и гарантированно прибирает за
// собой). Чистый Node >= 22, глобальный WebSocket/fetch, без npm.
//
// Запуск: node tests/signaling.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const PORT = 3311;
const URL = `ws://localhost:${PORT}/ws`;
const CONFIG_URL = `http://localhost:${PORT}/config`;
const ROOMS_URL = `http://localhost:${PORT}/api/rooms`;
// TTL пустой комнаты для этого прогона — короткий, чтобы тест не ждал 120с.
const EMPTY_ROOM_TTL_SECONDS = 2;
// Разделы E2E v2 (25+) создают несколько комнат через createRoom() без
// собственного отдельного серверного процесса — все они бы иначе делили ОДИН
// и тот же фолбэк-IP-бюджет (см. комментарий у createRoom() про
// `CF-Connecting-IP`) с уже накопленными вызовами createRoom() из более
// ранних разделов (2/10/11/12/15/16/18) и легко упёрлись бы в
// ROOM_CREATION_IP_LIMIT (H2, 10/60с). Свой собственный IP из зарезервированного
// под тесты диапазона (TEST-NET-3) — свой отдельный бюджет, как и у раздела 22.
const E2E_TEST_IP = '203.0.113.99';
// Свой выделенный IP для ВСЕХ обычных restoreRoom()-вызовов в этом файле
// (раздел 2b, раздел 31) — теперь, когда PUT тоже проверяет
// ROOM_CREATION_IP_LIMIT и делит бюджет с POST (H2, §3.1, см. раздел «22c»),
// эти вызовы больше не могут молча делить фолбэк-IP (уже под завязку занят
// createRoom() без явного IP) ни E2E_TEST_IP (тоже занят почти под лимит).
const RESTORE_ROOM_TEST_IP = '203.0.113.50';

let passed = 0, failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

// --- Управление серверным процессом -------------------------------------
//
// Сервер полностью эфемерен (никакой БД/файлов на диске, чат ничего не
// хранит — см. README.md), поэтому здесь не нужна временная БД и её
// уборка — только сам процесс. Трекается в `serverProcs` и гарантированно
// убивается в `cleanup()`.

let serverProc = null;
const serverProcs = [];
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of serverProcs) {
    if (p.exitCode === null && !p.killed) {
      try { p.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }
  }
}
// Гарантия уборки при любом исходе процесса (в т.ч. при непойманном исключении).
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

function buildServer() {
  console.log('Сборка сервера (cargo build)...');
  const res = spawnSync('cargo', ['build'], { cwd: PROJECT_DIR, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`cargo build упал с кодом ${res.status}`);
  }
}

// Поднять сервер на заданном порту с дополнительными переменными окружения.
function spawnServer(port, extraEnv = {}) {
  const bin = path.join(PROJECT_DIR, 'target', 'debug', 'screenshare');
  if (!fs.existsSync(bin)) {
    throw new Error(`бинарник не найден: ${bin}`);
  }
  const proc = spawn(bin, [], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      RUST_LOG: 'error',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.on('exit', (code, signal) => {
    if (!cleaned && code !== 0 && code !== null) {
      console.error(`Сервер (порт ${port}) неожиданно завершился (code=${code}, signal=${signal}):\n${out}`);
    }
  });
  serverProcs.push(proc);
  return proc;
}

function startServer() {
  console.log(`Запуск сервера на порту ${PORT}...`);
  serverProc = spawnServer(PORT, {
    EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS),
    // A (H2, docs/research-dos.md §3.2): JOIN_ROOM_IP_LIMIT — дефолт 20/60с,
    // рассчитан на реальных пользователей одного NAT, а не на этот файл: он
    // сам гоняет через WS многие десятки join-room с ОДНОГО IP за прогон, а
    // WS-хендшейк глобального WebSocket этого рантайма (в отличие от HTTP
    // fetch() у createRoom()) не поддерживает произвольные заголовки —
    // изолировать разделы этого файла друг от друга по CF-Connecting-IP для
    // WS-подключений физически нечем (все они падают на один и тот же
    // адрес пира сокета). Поднимаем лимит ОСНОВНОГО тестового процесса
    // далеко за пределы того, что весь этот файл способен нафлудить за
    // минуту; сам лимит (реальный дефолт, БЕЗ переопределения) проверяется
    // отдельным изолированным серверным процессом — см. раздел «22d».
    JOIN_ROOM_IP_LIMIT: '100000',
  });
}

async function waitForReady(configUrl, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`сервер упал до готовности (exit code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(configUrl);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`сервер не поднялся за ${timeoutMs}мс: ${lastErr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- HTTP: создание комнаты ------------------------------------------------

// `ip` (опционально) — см. раздел про per-IP лимит создания комнат (H2):
// подставляется как заголовок `CF-Connecting-IP`, который сервер понимает в
// первую очередь (см. src/state.rs::extract_client_ip). Без него запрос идёт
// без заголовка — сервер сам фолбэкнется на адрес пира сокета (у всех
// запросов теста без явного `ip` это будет один и тот же адрес localhost,
// поэтому раздельные IP в тестах, где это важно, передаются явно).
async function createRoom(body, roomsUrl = ROOMS_URL, ip = undefined) {
  const opts = { method: 'POST', headers: {} };
  if (ip !== undefined) opts.headers['CF-Connecting-IP'] = ip;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(roomsUrl, opts);
  let json = null;
  try { json = await res.json(); } catch { /* не JSON — ниже проверим статус */ }
  return {
    status: res.status,
    roomId: json && json.roomId,
    leaderToken: json && json.leaderToken,
    // E2E v2 (см. src/main.rs::create_room): срок жизни комнаты в секундах,
    // тот же MAX_ROOM_LIFETIME_SECONDS сервера — нужен клиенту, чтобы зашить
    // его в expiry ссылки при её генерации.
    lifetimeSeconds: json && json.lifetimeSeconds,
  };
}

// Остановить дополнительный серверный процесс (см. spawnServer) и дождаться
// его выхода — используется тестами, которым нужен отдельный процесс с
// нестандартным env (MAX_ROOMS/MAX_ROOM_LIFETIME_SECONDS), не тем же, что у
// основного сервера на PORT.
function stopServer(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
}

// PUT /api/rooms/<roomId> — идемпотентное восстановление (см. src/main.rs::restore_room).
// `ip` (опционально) — см. раздел 22c: PUT теперь тоже проверяет
// ROOM_CREATION_IP_LIMIT (H2, §3.1) и делит бюджет с POST /api/rooms.
async function restoreRoom(roomId, ip = undefined) {
  const opts = { method: 'PUT', headers: {} };
  if (ip !== undefined) opts.headers['CF-Connecting-IP'] = ip;
  const res = await fetch(`${ROOMS_URL}/${encodeURIComponent(roomId)}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* не JSON — ниже проверим статус */ }
  return { status: res.status, roomId: json && json.roomId, lifetimeSeconds: json && json.lifetimeSeconds };
}

// E2E v2: заглушка эфемерного публичного ключа (`epub`) для теста — сервер
// его не парсит вовсе (опак, как sdp/candidate), поэтому реальная
// ECDH-математика тут не нужна, важен только сам факт прозрачной доставки
// строки нужного порядка длины (~87 симв. у настоящего base64url P-256 raw
// ключа, см. docs/research-p2p-key-handoff.md §6.5–6.6).
function fakeEpub(label) {
  return `epub-${label}-` + 'x'.repeat(70);
}

// Простой uuid v4 генератор для тестового клиента (совпадать с крипто-стойким не обязано).
function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- WS-клиент для теста --------------------------------------------------

function connect(wsUrl = URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    };
    ws.onopen = () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      // Дождаться следующего сообщения (с таймаутом).
      next: (ms = 3000) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
        waiters.push((m) => { clearTimeout(t); res(m); });
      }),
      closed: new Promise((res) => { ws.onclose = () => res(); }),
    });
    ws.onerror = reject;
  });
}

// Подключиться и войти в комнату одним шагом; возвращает { peer, joined }.
// `peerId` (опционально) — см. src/protocol.rs::ClientMessage::JoinRoom и
// раздел 5b ниже. `leaderToken` (опционально) — см. раздел 15 (система прав).
// `epub` (опционально, E2E v2) — см. раздел 25: эфемерный публичный ключ,
// сервер его не парсит, только релеит остальным.
async function join(roomId, name, wsUrl = URL, peerId = undefined, leaderToken = undefined, epub = undefined) {
  const peer = await connect(wsUrl);
  const msg = { type: 'join-room', roomId };
  if (name !== undefined) msg.name = name;
  if (peerId !== undefined) msg.peerId = peerId;
  if (leaderToken !== undefined) msg.leaderToken = leaderToken;
  if (epub !== undefined) msg.epub = epub;
  peer.send(msg);
  const joined = await peer.next();
  return { peer, joined };
}

// Сменить настройки комнаты (только лидер) — см. раздел 17.
function updateSettings(sender, settings) {
  sender.send({ type: 'update-settings', settings });
}

// Настройки по умолчанию (см. src/protocol.rs::RoomSettings::default),
// удобно как база для точечного переопределения в тестах.
function defaultSettings(overrides = {}) {
  return {
    lobbyEnabled: false,
    guestChat: true,
    guestAudio: true,
    guestVideo: true,
    guestScreen: true,
    ...overrides,
  };
}

// Маячок для проверок "сокет жив / релей адресный / срезан rate-limit'ом":
// серверного релея чата больше нет (чат только по P2P-шине), поэтому в роли
// маячка — ещё существующий адресный релей stream-info (см. handle_stream_info).
function isBeaconMsg(m) {
  return m && m.type === 'stream-info' && typeof m.fromPeerId === 'string'
    && m.info !== undefined && m.info !== null && typeof m.info === 'object';
}

function sendBeacon(sender, targetPeerId, payload) {
  sender.send({ type: 'stream-info', targetPeerId, info: payload });
}

// Сравнение по структуре, а не по строке: сервер гоняет envelope через
// serde_json::Value, которое (без preserve_order) сортирует ключи объектов
// алфавитно — порядок ключей меняется, но данные остаются теми же. Именно
// это и значит "доставлено как есть" для опакового JSON.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

// --- Сам прогон тестов -----------------------------------------------------

async function runTests() {
  // --- 1. Комната не найдена (никогда не создавалась) ---
  console.log('1. join несуществующей комнаты');
  {
    const v = await connect();
    v.send({ type: 'join-room', roomId: 'nope1234' });
    const m = await v.next();
    ok(m.type === 'room-not-found', 'получен room-not-found');
    await v.closed;
    ok(true, 'сервер закрыл сокет');
  }

  // --- 2. POST /api/rooms создаёт пустую комнату ---
  console.log('2. POST /api/rooms');
  let roomId;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  {
    const { status, roomId: id, leaderToken } = await createRoom();
    ok(status === 201, `201 Created (status=${status})`);
    ok(/^[23456789a-z]{8}$/.test(id), `roomId короткий и человекочитаемый (${id})`);
    ok(typeof leaderToken === 'string' && UUID_RE.test(leaderToken), `leaderToken выдан и похож на uuid (${leaderToken})`);
    roomId = id;

    // Тело опционально и игнорируется — не должно ломать создание.
    const withBody = await createRoom({ name: 'Моя комната' });
    ok(withBody.status === 201 && /^[23456789a-z]{8}$/.test(withBody.roomId),
      'опциональное тело {name} игнорируется, комната всё равно создаётся');
  }

  // --- 2b. PUT /api/rooms/{roomId} — идемпотентное восстановление ---
  console.log('2b. PUT /api/rooms/{roomId}');
  {
    // Комнаты с таким id ещё нет (никогда не создавалась) -> 201, комната создана.
    const freshId = 'zx9k2m7q'; // валидный формат ^[a-z0-9]{8}$, заведомо не существовал
    const created = await restoreRoom(freshId, RESTORE_ROOM_TEST_IP);
    ok(created.status === 201, `восстановление НЕсуществующей комнаты -> 201 (status=${created.status})`);
    ok(created.roomId === freshId, 'в ответе тот же roomId, что запрошен');

    // Вход в только что восстановленную комнату работает как обычно.
    const { peer, joined } = await join(freshId);
    ok(joined.type === 'joined' && joined.peers.length === 0, 'вход в восстановленную комнату успешен, участников ещё 0');

    // Комната уже существует (мы только что в неё вошли) -> 200, ничего не пересоздано.
    const already = await restoreRoom(freshId, RESTORE_ROOM_TEST_IP);
    ok(already.status === 200, `восстановление УЖЕ существующей комнаты -> 200 (status=${already.status})`);
    peer.ws.close();

    // Кривой id (не соответствует ^[a-z0-9]{8}$) -> 400.
    const bad1 = await restoreRoom('AB');
    ok(bad1.status === 400, `слишком короткий/с заглавными id -> 400 (status=${bad1.status})`);
    const bad2 = await restoreRoom('../evil12');
    ok(bad2.status === 400, `id с недопустимыми символами -> 400 (status=${bad2.status})`);
  }

  // --- 3. Первый участник входит в свежесозданную комнату ---
  console.log('3. первый участник входит: peers=[], screenOwner=null');
  const { peer: p1, joined: j1 } = await join(roomId);
  ok(j1.type === 'joined' && Array.isArray(j1.peers) && j1.peers.length === 0 && j1.screenOwner === null,
    'joined: peers=[], screenOwner=null для первого участника');
  const p1Id = j1.peerId;
  // Токен не предъявлен, но лидера в комнате ещё не было -> первый вошедший
  // становится лидером сам (см. раздел 15 про leaderToken).
  ok(j1.leaderId === p1Id, 'первый участник без токена становится лидером сам собой');
  ok(j1.settings && j1.settings.lobbyEnabled === false && j1.settings.guestChat === true
    && j1.settings.guestAudio === true && j1.settings.guestVideo === true && j1.settings.guestScreen === true,
    'joined.settings — дефолты (всё разрешено, лобби выключено)');
  ok(Array.isArray(j1.pending) && j1.pending.length === 0, 'joined.pending — пустой список (заявок в лобби ещё нет)');
  ok(typeof j1.expiresInSeconds === 'number' && j1.expiresInSeconds > 0,
    `joined.expiresInSeconds присутствует и положителен, лимит длительности созвона (${j1.expiresInSeconds})`);

  // --- 4. Второй участник (с именем) входит: видит первого в peers ---
  console.log('4. второй участник: peers содержит первого, peer-joined приходит первому');
  const { peer: p2, joined: j2 } = await join(roomId, 'Аня');
  const p2Id = j2.peerId;
  ok(j2.type === 'joined' && j2.peers.length === 1 && j2.peers[0].peerId === p1Id && j2.peers[0].name === null,
    'joined: peers=[{peerId: первый, name: null}] для второго участника');
  ok(j2.screenOwner === null, 'screenOwner всё ещё null');
  ok(j2.leaderId === p1Id, 'второй участник (гость) видит лидером первого');
  ok(Array.isArray(j2.pending) && j2.pending.length === 0, 'joined.pending пуст для не-лидера, даже если бы там что-то было');

  const pj1 = await p1.next();
  // E (docs/research-minimize-state.md §3): сервер БОЛЬШЕ НЕ ХРАНИТ name —
  // peer-joined всегда несёт null, независимо от того, что клиент прислал в
  // join-room (имя теперь ходит отдельным зашифрованным name-announce).
  ok(pj1.type === 'peer-joined' && pj1.peerId === p2Id && pj1.name === null,
    'первый участник получил peer-joined — name всегда null (сервер его не хранит, см. §E)');

  // --- 4b. join-room с клиентским peerId (свободный/занятый -> реконнект/невалидный) ---
  console.log('4b. join-room с клиентским peerId');
  {
    // Свободный валидный uuid -> сервер принимает его как есть.
    const desiredId = genUuid();
    const { peer: pCustom, joined: jCustom } = await join(roomId, 'Игорь', URL, desiredId);
    ok(jCustom.peerId === desiredId, `свободный валидный peerId принят как есть (${jCustom.peerId})`);
    await Promise.all([p1.next(), p2.next()]); // peer-joined остальным

    // peerId уже занят — но не p1Id/p2Id (они нужны целыми для всего
    // остального файла), а СВОЙ ЖЕ недавно созданный pCustom -> теперь это
    // РЕКОННЕКТ (см. §A/§D задачи, src/ws.rs::reconnect_participant): сервер
    // НЕ генерирует новый peerId, а забирает слот себе (заменяет tx) — тот
    // же peerId остаётся занят той же "личностью", просто новым
    // сигналинг-соединением. Другим участникам peer-joined НЕ шлётся
    // повторно — с их точки зрения этот peerId и не уходил.
    const { peer: pReconnect, joined: jReconnect } = await join(roomId, 'ИгорьСнова', URL, desiredId);
    ok(jReconnect.type === 'joined' && jReconnect.peerId === desiredId,
      `join своим уже занятым peerId -> реконнект, тот же peerId (${jReconnect.peerId})`);

    // Доказываем, что канал реально переехал: релей на desiredId идёт теперь
    // НОВОМУ соединению.
    sendBeacon(p1, desiredId, { kind: 'reconnect-routing-check' });
    const routed = await pReconnect.next();
    ok(isBeaconMsg(routed) && routed.info.kind === 'reconnect-routing-check',
      'после реконнекта релей на peerId уходит новому соединению');

    // Закрываем СТАРЫЙ (уже замещённый, "зомби") сокет — не должен рождать
    // peer-left и не должен портить состояние (см. same_channel-проверку в
    // cleanup_peer, src/ws.rs).
    pCustom.ws.close();
    await sleep(200);
    sendBeacon(p1, p2Id, { kind: 'after-zombie-close-4b' });
    const afterZombie = await p2.next();
    ok(isBeaconMsg(afterZombie) && afterZombie.info.kind === 'after-zombie-close-4b',
      'закрытие уже замещённого (зомби) сокета не рождает peer-left и не портит состояние');

    // Кривой peerId (не uuid) -> сервер тихо генерирует новый.
    const { peer: pBad, joined: jBad } = await join(roomId, 'Кривой', URL, 'not-a-uuid');
    ok(jBad.type === 'joined' && typeof jBad.peerId === 'string' && jBad.peerId !== 'not-a-uuid',
      `невалидный (не-uuid) peerId -> выдан новый (${jBad.peerId})`);
    await Promise.all([p1.next(), p2.next(), pReconnect.next()]); // peer-joined остальным

    // Прибираем оставшихся временных участников за собой.
    pReconnect.ws.close();
    pBad.ws.close();
    for (let i = 0; i < 2; i++) {
      const [m1, m2] = await Promise.all([p1.next(), p2.next()]);
      ok(m1.type === 'peer-left' && m2.type === 'peer-left', 'peer-left дошёл p1 и p2 при уходе временного участника');
    }
  }

  // --- 4c. name в join-room больше не хранится и не влияет на peer-joined —
  // всегда null независимо от длины/содержимого (см. §E,
  // docs/research-minimize-state.md §3: мёртвое поле убрано из
  // Participant/PendingParticipant; прежний тест на обрезку до 512 символов
  // (CHAT_NAME_MAX_CHARS) больше не применим — санитизации/лимита длины
  // больше нет, поле просто игнорируется целиком). ---
  console.log('4c. name: больше не хранится — join с длинным именем работает, peer-joined.name всегда null');
  {
    const name600 = 'y'.repeat(600); // раньше обрезалось бы до 512 — теперь просто не используется вовсе
    const { peer: pLong, joined: jLong } = await join(roomId, name600);
    ok(jLong.type === 'joined', 'участник с именем 600 символов входит без ошибки (длина никак не проверяется)');
    const [pj1c, pj2c] = await Promise.all([p1.next(), p2.next()]);
    ok(pj1c.type === 'peer-joined' && pj1c.name === null, 'peer-joined.name всегда null, вне зависимости от длины имени');
    ok(pj2c.type === 'peer-joined' && pj2c.name === null, 'то же самое видит второй получатель');

    pLong.ws.close();
    await Promise.all([p1.next(), p2.next()]); // peer-left ушедшего временного участника
  }

  // --- 5. Третий участник видит ОБОИХ предыдущих в peers ---
  console.log('5. третий участник видит всех предыдущих; оба получают peer-joined');
  const { peer: p3, joined: j3 } = await join(roomId, 'Боб');
  const p3Id = j3.peerId;
  ok(j3.peers.length === 2, 'у третьего участника peers содержит двух предыдущих');
  ok(j3.peers.every((p) => p.name === null), 'peers[].name всегда null (сервер имя не хранит, см. §E)');
  ok(j3.peers.some((p) => p.peerId === p1Id), 'peers содержит первого');
  ok(j3.peers.some((p) => p.peerId === p2Id), 'peers содержит второго');

  const [pj2a, pj2b] = await Promise.all([p1.next(), p2.next()]);
  ok(pj2a.type === 'peer-joined' && pj2a.peerId === p3Id && pj2a.name === null, 'первый получил peer-joined (name null)');
  ok(pj2b.type === 'peer-joined' && pj2b.peerId === p3Id && pj2b.name === null, 'второй получил peer-joined (name null)');

  // --- 6. Релей offer/answer/ice/stream-info между ДВУМЯ НЕ-первыми участниками ---
  console.log('6. релей между вторым и третьим участником (не первым)');
  p2.send({ type: 'offer', targetPeerId: p3Id, sdp: { type: 'offer', sdp: 'v=0 fake' } });
  const off = await p3.next();
  ok(off.type === 'offer' && off.fromPeerId === p2Id && off.sdp.sdp === 'v=0 fake', 'offer p2->p3 с fromPeerId');

  p3.send({ type: 'answer', targetPeerId: p2Id, sdp: { type: 'answer', sdp: 'v=0 fake2' } });
  const ans = await p2.next();
  ok(ans.type === 'answer' && ans.fromPeerId === p3Id, 'answer p3->p2');

  p2.send({ type: 'ice-candidate', targetPeerId: p3Id, candidate: { candidate: 'candidate:1', sdpMid: '0' } });
  const ice = await p3.next();
  ok(ice.type === 'ice-candidate' && ice.fromPeerId === p2Id && ice.candidate.sdpMid === '0', 'ice-candidate p2->p3');

  p3.send({
    type: 'stream-info',
    targetPeerId: p2Id,
    info: { s1: { peerId: p3Id, name: 'Боб' } },
  });
  const si = await p2.next();
  ok(si.type === 'stream-info' && si.fromPeerId === p3Id && si.info.s1.name === 'Боб', 'stream-info p3->p2');

  // Релей на несуществующий peerId — тихо игнорируется, соединение живо
  // (проверяем маячком через адресный stream-info).
  p2.send({ type: 'ice-candidate', targetPeerId: 'ghost', candidate: {} });
  {
    sendBeacon(p2, p1Id, { kind: 'text', text: 'маячок-после-ghost-релея' });
    const m = await p1.next();
    ok(isBeaconMsg(m) && m.fromPeerId === p2Id && m.info.text === 'маячок-после-ghost-релея',
      'релей на неизвестный peerId не ломает сокет — чат p2->p1 после него доходит');
  }

  // --- 6b. Релей: лимит размера payload offer/answer/ice/stream-info (H2) ---
  console.log('6b. релей: лимит размера payload (H2, 16КБ)');
  {
    const bigSdp = { type: 'offer', sdp: 'x'.repeat(17 * 1024) }; // сериализованный payload заведомо > 16КБ
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: bigSdp });
    const errMsg = await p2.next();
    ok(errMsg.type === 'error', `offer payload >16КБ -> error отправителю (${errMsg.message})`);

    // Доказываем недоставку: следующим валидным offer'ом идёт маячок — p3
    // должен получить именно его, а не просочившийся big offer.
    const beaconSdp = { type: 'offer', sdp: 'маячок-после-oversize-offer' };
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: beaconSdp });
    const beacon = await p3.next();
    ok(beacon.type === 'offer' && beacon.sdp.sdp === 'маячок-после-oversize-offer',
      'offer >16КБ не доставлен; следующий валидный дошёл как есть');

    // Payload чуть меньше лимита — проходит целиком.
    const okSdp = { type: 'offer', sdp: 'y'.repeat(16 * 1024 - 200) };
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: okSdp });
    const okMsg = await p3.next();
    ok(okMsg.type === 'offer' && okMsg.sdp.sdp.length === okSdp.sdp.length,
      'offer размером чуть меньше 16КБ доставлен целиком');
  }

  // --- 6c. Релей: общий rate-limit на ВСЕ типы релея соединения суммарно (H2) ---
  console.log('6c. релей: общий rate-limit (H2, RELAY_RATE_LIMIT=100/10с)');
  {
    // Два временных участника той же комнаты — не переиспользуем p1/p2/p3,
    // чтобы не заранее расходовать их собственный бюджет для дальнейших
    // разделов теста.
    const { peer: pA, joined: jA } = await join(roomId, 'RateA');
    await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined всем текущим
    const { peer: pB, joined: jB } = await join(roomId, 'RateB');
    await Promise.all([p1.next(), p2.next(), p3.next(), pA.next()]); // peer-joined всем текущим

    // 100 ice-candidate подряд с pA на pB — все в пределах общего лимита.
    let allDelivered = true;
    for (let i = 0; i < 100; i++) {
      pA.send({ type: 'ice-candidate', targetPeerId: jB.peerId, candidate: { candidate: `c${i}` } });
      const m = await pB.next();
      if (!(m.type === 'ice-candidate' && m.candidate.candidate === `c${i}`)) allDelivered = false;
    }
    ok(allDelivered, '100 сообщений подряд (в пределах общего релей-лимита) доставлены все');

    // 101-е сообщение за окно -> error самому отправителю, не доставлено.
    pA.send({ type: 'ice-candidate', targetPeerId: jB.peerId, candidate: { candidate: 'over-limit' } });
    const errMsg = await pA.next();
    ok(errMsg.type === 'error', `101-е сообщение за 10с (суммарно по всем типам релея) -> error (${errMsg.message})`);

    // Доказываем недоставку: маячок от ДРУГОГО отправителя (p1, свой чистый
    // бюджет) должен дойти первым же сообщением у pB.
    sendBeacon(p1, jB.peerId, { kind: 'text', text: 'маячок-после-relay-rate-limit' });
    const beacon = await pB.next();
    ok(isBeaconMsg(beacon) && beacon.info.text === 'маячок-после-relay-rate-limit',
      '101-е сообщение, срезанное общим релей-лимитом, не доставлено получателю');

    pA.ws.close();
    await Promise.all([p1.next(), p2.next(), p3.next(), pB.next()]); // peer-left pA
    pB.ws.close();
    await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-left pB
  }

  // --- 8. Четвёртый участник входит (без истории — сервер её не хранит) ---
  console.log('8. четвёртый участник входит');
  const { peer: p4, joined: j4 } = await join(roomId, 'Вова');
  const p4Id = j4.peerId;
  ok(j4.peers.length === 3, 'у четвёртого участника peers содержит трёх предыдущих');
  await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined всем троим

  // --- 9. Шаринг экрана: захват, перехват (последний победил), освобождение, перезахват ---
  console.log('9. шаринг экрана');
  {
    p1.send({ type: 'share-start' });
    const [s1, s2, s3, s4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([s1, s2, s3, s4].every((m) => m.type === 'share-started' && m.peerId === p1Id),
      'share-started приходит ВСЕМ, включая инициатора');

    // --- 9a. Перехват: share-start от НЕ-владельца замещает владельца, а не отклоняется ---
    console.log('9a. перехват шаринга (последний победил)');
    // Второй участник шлёт share-start, пока экран держит первый — раньше это
    // отклонялось (share-rejected); теперь заявка замещает владельца:
    // share-started(p2) уходит ВСЕМ, включая p1 — это же сообщение служит p1
    // уведомлением о перехвате (по нему клиент сам останавливает свой захват,
    // см. static/room.js), отдельного сообщения ему не приходит.
    p2.send({ type: 'share-start' });
    const [ov1, ov2, ov3, ov4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([ov1, ov2, ov3, ov4].every((m) => m.type === 'share-started' && m.peerId === p2Id),
      'перехват: share-started(нового владельца) уходит ВСЕМ, включая прежнего владельца — никакого share-rejected');

    // Комната действительно считает шарящим p2 — проверяем со стороны только
    // что вошедшего участника (независимый источник истины, не завязан на то,
    // что уже разослано выше).
    {
      const { peer: pCheck, joined: jCheck } = await join(roomId, 'Проверка');
      ok(jCheck.screenOwner === p2Id, 'после перехвата joined.screenOwner нового участника — p2 (не p1)');
      await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-joined всем текущим
      pCheck.ws.close();
      await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-left
    }

    // Доказываем, что владелец p2, а НЕ p1: попытка p1 (уже не владелец)
    // остановить шаринг — тихо игнорируется (не он владелец), маячок после
    // неё доходит как обычно.
    {
      p1.send({ type: 'share-stop' });
      sendBeacon(p1, p2Id, { kind: 'text', text: 'маячок-после-share-stop-не-владельца' });
      const b = await p2.next();
      ok(isBeaconMsg(b) && b.info.text === 'маячок-после-share-stop-не-владельца',
        'share-stop от p1 (уже не владельца после перехвата) проигнорирован, сокет жив');
    }

    // share-stop НЕ от владельца (p3) — тихо игнорируется, экран остаётся за p2.
    p3.send({ type: 'share-stop' });
    {
      sendBeacon(p3, p2Id, { kind: 'text', text: 'маячок-после-чужого-share-stop' });
      const b = await p2.next();
      ok(isBeaconMsg(b) && b.info.text === 'маячок-после-чужого-share-stop',
        'share-stop не от владельца (p3) проигнорирован — экран остаётся за p2');
    }

    // Владелец (p2) освобождает экран — share-stopped всем. Если бы владение
    // незаметно съехало (баг), этот share-stop был бы не-op'ом и ничего не
    // разослал бы вовсе — сам факт рассылки подтверждает, что p2 всё это
    // время оставался настоящим владельцем.
    p2.send({ type: 'share-stop' });
    const [st1, st2, st3, st4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([st1, st2, st3, st4].every((m) => m.type === 'share-stopped' && m.peerId === p2Id),
      'share-stopped приходит всем после share-stop владельца (p2)');

    // После освобождения другой участник может свободно захватить экран.
    p1.send({ type: 'share-start' });
    const [c1, c2, c3, c4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([c1, c2, c3, c4].every((m) => m.type === 'share-started' && m.peerId === p1Id),
      'после освобождения другой участник успешно захватывает свободный экран');

    // Новый участник в комнату с активным шарингом получает screenOwner в joined.
    const { peer: p5, joined: j5 } = await join(roomId, 'Галя');
    ok(j5.screenOwner === p1Id, 'новый участник получает screenOwner активного шаринга в joined');
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-joined всем

    // Освобождаем перед следующим блоком (дисконнект-тест).
    p1.send({ type: 'share-stop' });
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next(), p5.next()]);

    // --- 9b. Дисконнект владельца экрана: share-stopped всем + peer-left ---
    console.log('9b. дисконнект владельца экрана');
    p3.send({ type: 'share-start' });
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next(), p5.next()]); // share-started всем

    p3.ws.close();
    const [dsc1, dsc2, dsc4, dsc5] = await Promise.all([p1.next(), p2.next(), p4.next(), p5.next()]);
    ok([dsc1, dsc2, dsc4, dsc5].every((m) => m.type === 'share-stopped' && m.peerId === p3Id),
      'дисконнект владельца шлёт share-stopped всем оставшимся');
    const [pl1, pl2, pl4, pl5] = await Promise.all([p1.next(), p2.next(), p4.next(), p5.next()]);
    ok([pl1, pl2, pl4, pl5].every((m) => m.type === 'peer-left' && m.peerId === p3Id),
      'дисконнект владельца затем шлёт peer-left всем оставшимся');

    // Обычный уход (не владелец) — просто peer-left, без share-stopped.
    console.log('9c. уход обычного участника');
    p5.ws.close();
    const [pl1b, pl2b, pl4b] = await Promise.all([p1.next(), p2.next(), p4.next()]);
    ok([pl1b, pl2b, pl4b].every((m) => m.type === 'peer-left' && m.peerId === j5.peerId),
      'уход обычного участника шлёт peer-left оставшимся (без share-stopped)');

    p1.ws.close();
    p2.ws.close();
    p4.ws.close();
  }

  // --- 10. Лимит 6 участников: 6 входят, 7-й получает room-full ---
  console.log('10. лимит 6 участников');
  {
    const { roomId: fullRoomId } = await createRoom();
    const members = [];
    for (let i = 0; i < 6; i++) {
      const { peer, joined: j } = await join(fullRoomId, `участник${i}`);
      ok(j.type === 'joined', `участник №${i + 1} вошёл`);
      if (i === 0) {
        // MAX_PARTICIPANTS не задан этому серверному процессу -> дефолт 6
        // (см. DEFAULT_MAX_PARTICIPANTS в src/state.rs) — joined несёт его
        // явно (аддитивное поле, см. src/protocol.rs::ServerMessage::Joined).
        ok(j.maxParticipants === 6, `joined.maxParticipants === 6 без env MAX_PARTICIPANTS (получено ${j.maxParticipants})`);
      }
      // peer-joined всем предыдущим участникам этой же комнаты.
      await Promise.all(members.map((m) => m.peer.next()));
      members.push({ peer, joined: j });
    }
    const seventh = await connect();
    seventh.send({ type: 'join-room', roomId: fullRoomId });
    const m = await seventh.next();
    ok(m.type === 'room-full', '7-й участник получил room-full');
    await seventh.closed;
    ok(true, 'сокет 7-го закрыт сервером');

    for (const { peer } of members) peer.ws.close();
  }

  // --- 11. Комната живёт после ухода ВСЕХ участников < TTL, удаляется > TTL ---
  console.log('11. TTL пустой комнаты');
  {
    const { roomId: ttlRoomId } = await createRoom();
    const { peer } = await join(ttlRoomId);
    peer.ws.close();
    await peer.closed;

    await sleep(500); // меньше TTL (2с)
    const { peer: reJoinPeer, joined: reJoined } = await join(ttlRoomId);
    ok(reJoined.type === 'joined', 'вход в опустевшую, но ещё живую комнату (< TTL) успешен');
    reJoinPeer.ws.close();
    await reJoinPeer.closed;

    await sleep(3000); // больше TTL (2с) + запас на тик реапера
    const late = await connect();
    late.send({ type: 'join-room', roomId: ttlRoomId });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'комната удалена реапером после истечения TTL пустоты');
  }

  // --- 12. Короткая страница комнаты /r/{roomId} ---
  console.log('12. GET /r/<roomId>');
  {
    const { roomId: pageRoomId } = await createRoom();
    const res = await fetch(`http://localhost:${PORT}/r/${pageRoomId}`);
    ok(res.status === 200, `GET /r/${pageRoomId} -> 200`);
    ok((res.headers.get('content-type') || '').includes('text/html'), 'ответ /r/<id> — HTML');
  }

  // Ш1: /qr.svg удалён целиком — QR теперь рендерится локально в браузере
  // (см. static/vendor/qrcode.js, static/room.js), сервер картинку не строит.

  // --- 14. Эфемерность: сервер не оставил файлов БД в CWD ---
  console.log('14. эфемерность: нет файлов БД');
  {
    const dbFiles = fs.readdirSync(PROJECT_DIR).filter((f) => f.endsWith('.db') || f.includes('.db-'));
    ok(dbFiles.length === 0,
      `нет файлов БД в ${PROJECT_DIR} (найдено: ${dbFiles.join(', ') || 'ничего'})`);
  }

  // === Система прав (лидер/гости), протокол v4 ===========================

  // --- 15. leaderToken: предъявление делает лидером, токен одноразовый ---
  console.log('15. leaderToken');
  {
    const { roomId: lrId, leaderToken } = await createRoom();

    // Вход с валидным токеном -> сразу лидер (leaderId == свой peerId).
    const { peer: leader, joined: leaderJoined } = await join(lrId, 'Лидер', URL, undefined, leaderToken);
    ok(leaderJoined.leaderId === leaderJoined.peerId, 'вход с leaderToken делает вошедшего лидером (leaderId == свой peerId)');

    // Токен одноразовый: второй вход с ТЕМ ЖЕ токеном -> просто гость (лидер уже есть).
    const { peer: impostor, joined: impostorJoined } = await join(lrId, 'Самозванец', URL, undefined, leaderToken);
    ok(impostorJoined.leaderId === leaderJoined.peerId && impostorJoined.leaderId !== impostorJoined.peerId,
      'повторное предъявление уже сожжённого токена не делает лидером — виден прежний лидер');
    await leader.next(); // peer-joined самозванца лидеру

    leader.ws.close();
    impostor.ws.close();
    await Promise.all([leader.closed, impostor.closed]);
  }

  // --- 16/17/19/20: смена лидера, update-settings, guest_screen/guest_chat enforcement ---
  console.log('16. смена лидера при уходе');
  {
    const { roomId: rId, leaderToken } = await createRoom();
    const { peer: a, joined: ja } = await join(rId, 'A', URL, undefined, leaderToken); // лидер
    const { peer: b, joined: jb } = await join(rId, 'B'); // гость, вошёл вторым
    await a.next(); // peer-joined B у A
    const { peer: c, joined: jc } = await join(rId, 'C'); // гость, вошёл третьим
    await Promise.all([a.next(), b.next()]); // peer-joined C у A и B

    ok(ja.leaderId === ja.peerId && jb.leaderId === ja.peerId && jc.leaderId === ja.peerId,
      'все трое видят A лидером до его ухода');

    a.ws.close();
    const [lcB, lcC] = await Promise.all([b.next(), c.next()]);
    ok(lcB.type === 'leader-changed' && lcC.type === 'leader-changed'
      && lcB.leaderId === jb.peerId && lcC.leaderId === jb.peerId,
      'уход лидера -> leader-changed всем оставшимся, новый лидер — самый старый из оставшихся (B, вошёл раньше C)');
    const [plB, plC] = await Promise.all([b.next(), c.next()]);
    ok(plB.type === 'peer-left' && plC.type === 'peer-left'
      && plB.peerId === ja.peerId && plC.peerId === ja.peerId,
      'вслед за leader-changed приходит peer-left ушедшего лидера');

    // --- 17. update-settings: только лидер (теперь B) может менять настройки ---
    console.log('17. update-settings: только лидер, всем settings-changed');

    // Гость (C) пытается сменить настройки -> error, ничего не разослано.
    updateSettings(c, defaultSettings({ guestChat: false }));
    const errMsg = await c.next();
    ok(errMsg.type === 'error', `гость не может менять настройки комнаты (${errMsg.message})`);

    // Лидер (B) меняет настройки -> settings-changed приходит и ему, и C.
    updateSettings(b, defaultSettings({ guestScreen: false }));
    const [scB, scC] = await Promise.all([b.next(), c.next()]);
    ok(scB.type === 'settings-changed' && scC.type === 'settings-changed'
      && scB.settings.guestScreen === false && scC.settings.guestScreen === false,
      'update-settings лидера рассылает settings-changed всем участникам');

    // --- 19. guest_screen=false: share-start гостя отклонён, лидеру можно ---
    console.log('19. guest_screen=false enforcement');

    // C (гость) пытается шарить экран -> forbidden, без busyPeerId.
    c.send({ type: 'share-start' });
    const rejC = await c.next();
    ok(rejC.type === 'share-rejected' && rejC.reason === 'forbidden' && rejC.busyPeerId === undefined,
      'гостю с guestScreen=false отказано с reason=forbidden, без busyPeerId');

    // B (лидер) может шарить экран независимо от guestScreen.
    b.send({ type: 'share-start' });
    const [ssB, ssC] = await Promise.all([b.next(), c.next()]);
    ok(ssB.type === 'share-started' && ssC.type === 'share-started' && ssB.peerId === jb.peerId,
      'лидеру можно шарить экран даже при guestScreen=false');
    b.send({ type: 'share-stop' });
    await Promise.all([b.next(), c.next()]); // share-stopped

    // Возвращаем guestScreen, чтобы гость мог сам захватить экран.
    updateSettings(b, defaultSettings({ guestScreen: true }));
    await Promise.all([b.next(), c.next()]); // settings-changed

    c.send({ type: 'share-start' });
    const [ss2B, ss2C] = await Promise.all([b.next(), c.next()]);
    ok(ss2B.type === 'share-started' && ss2C.type === 'share-started' && ss2B.peerId === jc.peerId,
      'guestScreen=true -> гость успешно захватывает экран');

    // Лидер отбирает guestScreen, ПОКА гость шарит -> сервер сам шлёт share-stopped всем.
    updateSettings(b, defaultSettings({ guestScreen: false }));
    const [sc2B, sc2C] = await Promise.all([b.next(), c.next()]); // settings-changed
    ok(sc2B.type === 'settings-changed' && sc2C.type === 'settings-changed', 'settings-changed при отзыве guestScreen во время шаринга гостя');
    const [stB, stC] = await Promise.all([b.next(), c.next()]); // сервер сам останавливает шаринг
    ok(stB.type === 'share-stopped' && stC.type === 'share-stopped' && stB.peerId === jc.peerId,
      'отзыв guestScreen у шарящего гостя -> сервер сам шлёт share-stopped всем участникам');

    b.ws.close();
    c.ws.close();
    await Promise.all([b.closed, c.closed]);
  }

  // --- 18. Лобби (wait room): waiting/join-request/approve/reject/cancel/наследование ---
  console.log('18. лобби (wait room)');
  {
    const { roomId: lId, leaderToken } = await createRoom();
    const { peer: leader, joined: leaderJoined } = await join(lId, 'Лидер', URL, undefined, leaderToken);
    ok(leaderJoined.leaderId === leaderJoined.peerId, 'лидер лобби-комнаты — сам вошедший с токеном');

    // Включаем лобби.
    updateSettings(leader, defaultSettings({ lobbyEnabled: true }));
    const scSelf = await leader.next(); // settings-changed (единственный участник пока — сам лидер)
    ok(scSelf.type === 'settings-changed' && scSelf.settings.lobbyEnabled === true, 'лобби включено');

    // Новый гость -> waiting, лидер получает join-request.
    const guest1 = await connect();
    guest1.send({ type: 'join-room', roomId: lId, name: 'Ждущий1' });
    const waitMsg = await guest1.next();
    ok(waitMsg.type === 'waiting', 'новый гость при lobbyEnabled=true получает waiting вместо joined');
    const jr1 = await leader.next();
    ok(jr1.type === 'join-request' && jr1.name === null && typeof jr1.peerId === 'string',
      'лидер получает join-request — name всегда null (сервер его не хранит, см. §E)');
    const guest1Id = jr1.peerId;

    // Approve -> ожидающему joined, остальным (пока только лидеру) peer-joined.
    leader.send({ type: 'approve', peerId: guest1Id });
    const joinedMsg = await guest1.next();
    ok(joinedMsg.type === 'joined' && joinedMsg.peerId === guest1Id && joinedMsg.leaderId === leaderJoined.peerId,
      'approve -> ожидающему приходит полноценный joined');
    ok(Array.isArray(joinedMsg.pending) && joinedMsg.pending.length === 0,
      'joined.pending пуст — approved гость не лидер');
    const pjMsg = await leader.next();
    ok(pjMsg.type === 'peer-joined' && pjMsg.peerId === guest1Id, 'остальным (лидеру) приходит peer-joined после approve');

    // Reject: второй ожидающий отклоняется, сокет закрывается сервером.
    const guest2 = await connect();
    guest2.send({ type: 'join-room', roomId: lId, name: 'Ждущий2' });
    await guest2.next(); // waiting
    const jr2 = await leader.next();
    ok(jr2.type === 'join-request' && jr2.name === null, 'вторая заявка приходит лидеру (name null)');
    leader.send({ type: 'reject', peerId: jr2.peerId });
    const rejMsg = await guest2.next();
    ok(rejMsg.type === 'join-rejected', 'reject -> ожидающему join-rejected');
    await guest2.closed;
    ok(true, 'сервер закрыл сокет отклонённого сервером ожидающего');

    // Cancel: третий ожидающий отваливается сам, не дождавшись решения.
    const guest3 = await connect();
    guest3.send({ type: 'join-room', roomId: lId, name: 'Ждущий3' });
    await guest3.next(); // waiting
    const jr3 = await leader.next();
    ok(jr3.type === 'join-request' && jr3.name === null, 'третья заявка приходит лидеру (name null)');
    guest3.ws.close();
    const cancelMsg = await leader.next();
    ok(cancelMsg.type === 'join-request-cancelled' && cancelMsg.peerId === jr3.peerId,
      'отвал ожидающего, не дождавшегося решения -> лидеру join-request-cancelled');

    // Смена лидера при непустом pending: четвёртый ожидающий заявляется, затем лидер уходит.
    const guest4 = await connect();
    guest4.send({ type: 'join-room', roomId: lId, name: 'Ждущий4' });
    await guest4.next(); // waiting
    const jr4 = await leader.next();
    ok(jr4.type === 'join-request' && jr4.name === null, 'четвёртая заявка приходит прежнему лидеру (name null)');

    // Комната сейчас: участники — leader (лидер) и guest1 (approved); ожидает — guest4.
    leader.ws.close();
    const lcMsg = await guest1.next();
    ok(lcMsg.type === 'leader-changed' && lcMsg.leaderId === guest1Id,
      'уход лидера при непустом pending -> leader-changed новому (единственному оставшемуся) участнику');
    const jrAgain = await guest1.next();
    ok(jrAgain.type === 'join-request' && jrAgain.peerId === jr4.peerId && jrAgain.name === null,
      'непустой pending пересылается новому лидеру заново (join-request, name null)');

    // E2E v2: смена лидера, пока pending ждёт, шлёт ЕМУ СВЕЖИЙ waiting с
    // новым лидером (см. раздел 26/27) — здесь просто дренируем это
    // сообщение, само поведение целиком проверяется в разделе 27.
    const freshWaiting = await guest4.next();
    ok(freshWaiting.type === 'waiting' && freshWaiting.leaderPeerId === guest1Id,
      'смена лидера -> ожидающему тоже приходит свежий waiting с новым лидером');

    // Комната опустевает целиком -> все ещё живые ожидающие получают join-rejected.
    guest1.ws.close();
    const rejAll = await guest4.next();
    ok(rejAll.type === 'join-rejected', 'комната опустела при живых pending -> ожидающим join-rejected');
    await guest4.closed;

    await Promise.all([leader.closed, guest1.closed]);
  }

  // === H2: потолок числа комнат, per-IP лимиты, 3ч-лимит созвона, заголовки ===

  // --- 21. Потолок числа комнат (env MAX_ROOMS, отдельный серверный процесс) ---
  console.log('21. потолок числа комнат (MAX_ROOMS)');
  {
    const port = 3312;
    const proc = spawnServer(port, { MAX_ROOMS: '2' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;

    const r1 = await createRoom(undefined, roomsUrl);
    ok(r1.status === 201, `первая комната создаётся при MAX_ROOMS=2 (status=${r1.status})`);
    const r2 = await createRoom(undefined, roomsUrl);
    ok(r2.status === 201, `вторая комната создаётся при MAX_ROOMS=2 (status=${r2.status})`);
    const r3 = await createRoom(undefined, roomsUrl);
    ok(r3.status === 503, `третья комната при исчерпанном MAX_ROOMS=2 -> 503 (status=${r3.status})`);

    await stopServer(proc);
  }

  // --- 22. Per-IP лимит создания комнат (H2, 429) ---
  console.log('22. per-IP лимит создания комнат (429)');
  {
    // Один и тот же CF-Connecting-IP на все запросы — свой собственный
    // бюджет, отдельный от фолбэк-IP всех остальных createRoom() без
    // заголовка в этом файле (см. комментарий у createRoom()).
    const ip = '203.0.113.5';
    let allCreated = true;
    for (let i = 0; i < 10; i++) {
      const r = await createRoom(undefined, ROOMS_URL, ip);
      if (r.status !== 201) allCreated = false;
    }
    ok(allCreated, '10 создания комнат за окно с одного IP — все в пределах лимита (201)');

    const eleventh = await createRoom(undefined, ROOMS_URL, ip);
    ok(eleventh.status === 429, `11-е создание за окно с того же IP -> 429 (status=${eleventh.status})`);

    // Другой IP — свой собственный, независимый бюджет.
    const otherIp = '203.0.113.6';
    const otherIpResult = await createRoom(undefined, ROOMS_URL, otherIp);
    ok(otherIpResult.status === 201, `создание с ДРУГОГО IP не задето лимитом первого (status=${otherIpResult.status})`);
  }

  // --- 22b. Per-IP лимит на PUT /api/rooms/{id} — делит бюджет с POST (H2, §3.1) ---
  console.log('22b. per-IP лимит на PUT /api/rooms/{id}, общий с POST (429)');
  {
    const ip = '203.0.113.61';
    // 4 создания через POST + 6 восстановлений через PUT = 10 запросов за
    // окно с одного IP — РАЗНЫМИ путями одного и того же бюджета
    // (ROOM_CREATION_IP_LIMIT), доказывает, что бюджет общий.
    let allOk = true;
    for (let i = 0; i < 4; i++) {
      const r = await createRoom(undefined, ROOMS_URL, ip);
      if (r.status !== 201) allOk = false;
    }
    for (let i = 0; i < 6; i++) {
      const freshId = `pb${String(i).padStart(6, '0')}`; // валидный формат ^[a-z0-9]{8}$, заведомо не существовал
      const r = await restoreRoom(freshId, ip);
      if (r.status !== 201) allOk = false;
    }
    ok(allOk, '4 POST + 6 PUT = 10 запросов за окно с одного IP — все в пределах общего лимита (201)');

    const eleventhPut = await restoreRoom('pbeleven', ip);
    ok(eleventhPut.status === 429,
      `11-й запрос (PUT) с тем же IP -> 429, общий с POST бюджет исчерпан (status=${eleventhPut.status})`);
    const eleventhPost = await createRoom(undefined, ROOMS_URL, ip);
    ok(eleventhPost.status === 429,
      `POST с тем же IP тоже отклонён — бюджет действительно общий (status=${eleventhPost.status})`);

    // Другой IP — свой собственный бюджет, не задет.
    const otherIp = '203.0.113.62';
    const otherPut = await restoreRoom('pbother1', otherIp);
    ok(otherPut.status === 201, `PUT с ДРУГОГО IP не задет чужим лимитом (status=${otherPut.status})`);
  }

  // --- 22c. Per-IP лимит на прямой join-room в комнату (H2, §3.2 — главная
  // дыра) + легитимный реконнект не блокируется этим же лимитом. Отдельный
  // изолированный серверный процесс с РЕАЛЬНЫМ дефолтом JOIN_ROOM_IP_LIMIT
  // (20/60с, не переопределяем) — см. комментарий у startServer() про то,
  // почему этот лимит нельзя проверять на основном тестовом процессе. ---
  console.log('22c. per-IP лимит на прямой join-room (§3.2) + реконнект не блокируется');
  {
    const port = 3315;
    // MAX_PARTICIPANTS поднимаем далеко за пределы того, сколько join'ов
    // понадобится нафлудить (иначе комната сама упёрлась бы в room-full
    // задолго до per-IP лимита и смешала бы два разных повода отказа).
    const proc = spawnServer(port, { MAX_PARTICIPANTS: '25' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: floodRoomId } = await createRoom(undefined, roomsUrl);

    // Участник, чей peerId позже используем для проверки легитимного
    // реконнекта — обычный вход, потребляет 1 из бюджета JOIN_ROOM_IP_LIMIT,
    // как и любой другой join.
    const zombieId = genUuid();
    const { peer: zombie, joined: zombieJoined } = await join(floodRoomId, undefined, wsUrl, zombieId);
    ok(zombieJoined.peerId === zombieId, 'участник вошёл со своим желаемым peerId (1/20 бюджета)');

    // Ещё 19 обычных join'ов добивают лимит окна ровно до 20 (1 уже
    // потрачен выше) — держим сокеты открытыми специально, не давая реаперу/
    // MAX_PARTICIPANTS размыть смысл теста.
    const flooders = [];
    for (let i = 0; i < 19; i++) {
      const { peer, joined } = await join(floodRoomId, undefined, wsUrl);
      ok(joined.type === 'joined', `join #${i + 2} из 20 в пределах лимита`);
      flooders.push(peer);
    }

    // 21-й join (не реконнект, случайный новый peerId) -> отказ по лимиту.
    const over = await connect(wsUrl);
    over.send({ type: 'join-room', roomId: floodRoomId });
    const overMsg = await over.next();
    ok(overMsg.type === 'error' && /too many join attempts/.test(overMsg.message),
      `21-й join за окно с одного IP -> отказ по лимиту (получено ${overMsg.type}: ${overMsg.message})`);
    await over.closed;
    ok(true, 'сервер закрыл сокет после отказа по join-лимиту');

    // РЕКОННЕКТ своим уже занятым peerId — не должен спотыкаться о только
    // что исчерпанный лимит: не новый join для целей бюджета (см.
    // src/ws.rs::reconnect_participant).
    const { peer: reconnected, joined: reconnJoined } = await join(floodRoomId, undefined, wsUrl, zombieId);
    ok(reconnJoined.type === 'joined' && reconnJoined.peerId === zombieId,
      'реконнект своим уже занятым peerId проходит, несмотря на исчерпанный per-IP лимит');

    // Релей на zombieId теперь уходит НОВОМУ соединению.
    sendBeacon(flooders[0], zombieId, { kind: 'reconnect-check' });
    const beacon = await reconnected.next();
    ok(isBeaconMsg(beacon) && beacon.info.kind === 'reconnect-check',
      'релей на peerId после реконнекта уходит новому соединению');

    // Старое (зомби) соединение закрываем — не должно портить состояние
    // реконнекченного участника (same_channel-проверка в cleanup_peer).
    zombie.ws.close();
    await sleep(300);
    sendBeacon(flooders[0], zombieId, { kind: 'after-zombie-close' });
    const beacon2 = await reconnected.next();
    ok(isBeaconMsg(beacon2) && beacon2.info.kind === 'after-zombie-close',
      'после закрытия зомби-сокета реконнекченный участник остаётся в комнате');

    reconnected.ws.close();
    for (const p of flooders) p.ws.close();
    await stopServer(proc);
  }

  // --- 23. Лимит длительности созвона (MAX_ROOM_LIFETIME_SECONDS) ---
  console.log('23. лимит длительности созвона (room-expired)');
  {
    const port = 3313;
    const proc = spawnServer(port, { MAX_ROOM_LIFETIME_SECONDS: '3' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: lifeRoomId } = await createRoom(undefined, roomsUrl);
    const { peer, joined } = await join(lifeRoomId, 'Жизнь', wsUrl);
    ok(typeof joined.expiresInSeconds === 'number' && joined.expiresInSeconds >= 1 && joined.expiresInSeconds <= 3,
      `joined.expiresInSeconds ~3 при MAX_ROOM_LIFETIME_SECONDS=3 (получено ${joined.expiresInSeconds})`);

    const expired = await peer.next(6000); // реапер тикает раз в секунду, лимит 3с — 6с более чем достаточно
    ok(expired.type === 'room-expired', `по истечении лимита длительности приходит room-expired (получено ${expired.type})`);
    await peer.closed;
    ok(true, 'сервер закрыл сокет вслед за room-expired');

    // Комната удалена целиком реапером -> повторный join -> room-not-found.
    const late = await connect(wsUrl);
    late.send({ type: 'join-room', roomId: lifeRoomId });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'комната удалена реапером после истечения лимита длительности созвона');

    await stopServer(proc);
  }

  // --- 23b. Потолок числа участников (env MAX_PARTICIPANTS) ---
  console.log('23b. потолок числа участников (MAX_PARTICIPANTS)');
  {
    const port = 3314;
    const proc = spawnServer(port, { MAX_PARTICIPANTS: '2' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: capRoomId } = await createRoom(undefined, roomsUrl);
    const { peer: p1, joined: j1 } = await join(capRoomId, 'Первый', wsUrl);
    ok(j1.maxParticipants === 2, `joined.maxParticipants === 2 при MAX_PARTICIPANTS=2 (получено ${j1.maxParticipants})`);

    const { peer: p2, joined: j2 } = await join(capRoomId, 'Второй', wsUrl);
    ok(j2.type === 'joined', 'второй участник входит при MAX_PARTICIPANTS=2 (лимит ещё не достигнут)');
    await p1.next(); // peer-joined первому

    const third = await connect(wsUrl);
    third.send({ type: 'join-room', roomId: capRoomId });
    const m = await third.next();
    ok(m.type === 'room-full', `3-й участник получил room-full при MAX_PARTICIPANTS=2 (получено ${m.type})`);
    await third.closed;

    p1.ws.close();
    p2.ws.close();
    await stopServer(proc);
  }

  // --- 24. Security-заголовки на API-ответах (M2) ---
  console.log('24. security-заголовки на /config');
  {
    const res = await fetch(CONFIG_URL);
    ok(res.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff на /config');
    ok(res.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer на /config');
  }

  // === E2E v2 («вариант E», см. docs/research-p2p-key-handoff.md §6.5–6.6) ===

  // --- 25. epub: join-room -> joined.peers[].epub / peer-joined.epub / join-request.epub; кап валидации ---
  console.log('25. epub в joined.peers[] / peer-joined / валидация длины');
  {
    const { roomId: eRoomId, leaderToken: eLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const epubA = fakeEpub('A');
    const { peer: eA, joined: jA } = await join(eRoomId, 'A', URL, undefined, eLeaderToken, epubA);
    ok(jA.leaderId === jA.peerId, 'A с leaderToken становится лидером');

    const epubB = fakeEpub('B');
    const { peer: eB, joined: jB } = await join(eRoomId, 'B', URL, undefined, undefined, epubB);
    ok(jB.peers.length === 1 && jB.peers[0].peerId === jA.peerId && jB.peers[0].epub === epubA,
      'joined.peers[] содержит epub первого участника');
    const pjA1 = await eA.next();
    ok(pjA1.type === 'peer-joined' && pjA1.peerId === jB.peerId && pjA1.epub === epubB,
      'peer-joined содержит epub нового участника');

    // Без epub вовсе (обратная совместимость со старым/v1 клиентом).
    const { peer: eC, joined: jC } = await join(eRoomId, 'C');
    ok(jC.type === 'joined', 'вход без epub не отклоняется целиком (обратная совместимость)');
    ok(jC.peers.some((p) => p.peerId === jA.peerId && p.epub === epubA)
      && jC.peers.some((p) => p.peerId === jB.peerId && p.epub === epubB),
      'joined.peers[] корректно содержит epub предыдущих участников');
    const [pjA2, pjB2] = await Promise.all([eA.next(), eB.next()]);
    ok(pjA2.epub === null && pjB2.epub === null, 'peer-joined без epub у отправителя -> epub null');

    // epub длиннее EPUB_MAX_CHARS (200) — сервер не парсит содержимое, но
    // каппит длину: невалидно длинный epub отбрасывается целиком (не
    // обрезается — обрезанный ключ бессмысленен), как если бы его не было.
    const { peer: eD, joined: jD } = await join(eRoomId, 'D', URL, undefined, undefined, 'z'.repeat(250));
    ok(jD.type === 'joined', 'вход с epub длиннее 200 символов не отклоняется целиком');
    ok(jD.peers.find((p) => p.peerId === jC.peerId).epub === null, 'у C изначально не было epub — так и осталось null у D');
    const [pjA3, pjB3, pjC3] = await Promise.all([eA.next(), eB.next(), eC.next()]);
    ok(pjA3.epub === null && pjB3.epub === null && pjC3.epub === null,
      'epub длиннее 200 символов -> peer-joined.epub null (сервер каппит невалидную длину)');

    // Пустая строка epub — тоже невалидна (требуется непустая строка).
    const { peer: eE, joined: jE } = await join(eRoomId, 'E', URL, undefined, undefined, '');
    ok(jE.type === 'joined', 'вход с пустым epub не отклоняется целиком');
    const [pjA4, pjB4, pjC4, pjD4] = await Promise.all([eA.next(), eB.next(), eC.next(), eD.next()]);
    ok(pjA4.epub === null && pjB4.epub === null && pjC4.epub === null && pjD4.epub === null,
      'пустая строка epub -> peer-joined.epub null');

    eA.ws.close(); eB.ws.close(); eC.ws.close(); eD.ws.close(); eE.ws.close();
  }

  // --- 26. waiting: leaderPeerId + leaderEpub; join-request.epub ---
  console.log('26. waiting содержит leaderPeerId/leaderEpub, join-request содержит epub');
  {
    const { roomId: wRoomId, leaderToken: wLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const leaderEpub = fakeEpub('Leader26');
    const { peer: wLeader, joined: wLeaderJoined } = await join(wRoomId, 'Лидер', URL, undefined, wLeaderToken, leaderEpub);
    updateSettings(wLeader, defaultSettings({ lobbyEnabled: true }));
    await wLeader.next(); // settings-changed

    const wGuest = await connect();
    const guestEpub = fakeEpub('Guest26');
    wGuest.send({ type: 'join-room', roomId: wRoomId, name: 'Гость', epub: guestEpub });
    const waitMsg = await wGuest.next();
    ok(waitMsg.type === 'waiting' && waitMsg.leaderPeerId === wLeaderJoined.peerId && waitMsg.leaderEpub === leaderEpub,
      'waiting содержит leaderPeerId и leaderEpub текущего лидера');
    const jr = await wLeader.next();
    ok(jr.type === 'join-request' && jr.epub === guestEpub, 'join-request содержит epub ожидающего');

    wGuest.ws.close();
    await wLeader.next(); // join-request-cancelled
    wLeader.ws.close();
  }

  // --- 27. Смена лидера при непустом pending -> каждому pending СВЕЖИЙ waiting с новым лидером ---
  console.log('27. смена лидера с висящими pending -> свежий waiting');
  {
    const { roomId: fwRoomId, leaderToken: fwLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const leaderEpub1 = fakeEpub('L1-27');
    const { peer: fwLeader, joined: fwLeaderJoined } = await join(fwRoomId, 'L1', URL, undefined, fwLeaderToken, leaderEpub1);

    // Второй участник входит ОБЫЧНЫМ путём, пока лобби ещё выключено — иначе
    // (при уже включённом лобби) он сам попал бы в pending, а не в
    // участники, и не смог бы стать кандидатом на нового лидера (кандидаты —
    // только полноценные участники, см. `cleanup_peer`).
    const secondEpub = fakeEpub('L2-27');
    const { peer: fwSecond, joined: fwSecondJoined } = await join(fwRoomId, 'L2', URL, undefined, undefined, secondEpub);
    await fwLeader.next(); // peer-joined

    // Теперь включаем лобби — settings-changed уходит обоим текущим участникам.
    updateSettings(fwLeader, defaultSettings({ lobbyEnabled: true }));
    await Promise.all([fwLeader.next(), fwSecond.next()]); // settings-changed

    // Ожидающий подаёт заявку, пока L1 ещё лидер.
    const fwPending = await connect();
    const pendingEpub = fakeEpub('Pending27');
    fwPending.send({ type: 'join-room', roomId: fwRoomId, name: 'Ждущий', epub: pendingEpub });
    const wait1 = await fwPending.next();
    ok(wait1.leaderPeerId === fwLeaderJoined.peerId && wait1.leaderEpub === leaderEpub1,
      'первый waiting указывает на исходного лидера L1');
    const jr1 = await fwLeader.next(); // join-request
    ok(jr1.type === 'join-request' && jr1.epub === pendingEpub, 'первый join-request содержит epub ожидающего');

    // Лидер уходит -> L2 становится лидером -> pending получает СВЕЖИЙ waiting.
    fwLeader.ws.close();
    const [lc, wait2] = await Promise.all([fwSecond.next(), fwPending.next()]);
    ok(lc.type === 'leader-changed' && lc.leaderId === fwSecondJoined.peerId, 'leader-changed новому лидеру L2');
    ok(wait2.type === 'waiting' && wait2.leaderPeerId === fwSecondJoined.peerId && wait2.leaderEpub === secondEpub,
      'pending получает свежий waiting с новым лидером (L2) и его epub');
    const jr2 = await fwSecond.next();
    ok(jr2.type === 'join-request' && jr2.peerId === jr1.peerId && jr2.epub === pendingEpub,
      'join-request пересылается новому лидеру заново, с тем же peerId и epub ожидающего');

    fwPending.ws.close();
    await fwSecond.next(); // join-request-cancelled
    fwSecond.ws.close();
  }

  // --- 28. name-announce: участник -> участник доставляется ---
  console.log('28. name-announce участник->участник');
  {
    const { roomId: naRoomId } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: naA, joined: jNaA } = await join(naRoomId, 'A');
    const { peer: naB, joined: jNaB } = await join(naRoomId, 'B');
    await naA.next(); // peer-joined B

    naA.send({ type: 'name-announce', to: jNaB.peerId, payload: 'cipherblob-A-to-B' });
    const recv = await naB.next();
    ok(recv.type === 'name-announce' && recv.from === jNaA.peerId && recv.payload === 'cipherblob-A-to-B',
      'name-announce участник->участник доставлен с корректным from');

    naA.ws.close();
    await naB.next(); // peer-left
    naB.ws.close();
  }

  // --- 29. name-announce: pending -> лидер доставляется; pending -> НЕ-лидер запрещён ---
  console.log('29. name-announce pending->лидер доставляется, pending->НЕ-лидер запрещён');
  {
    const { roomId: naRoomId2, leaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: leader, joined: leaderJoined } = await join(naRoomId2, 'Лидер', URL, undefined, leaderToken);
    const { peer: other, joined: otherJoined } = await join(naRoomId2, 'Другой'); // обычный участник, не лидер
    await leader.next(); // peer-joined

    updateSettings(leader, defaultSettings({ lobbyEnabled: true }));
    await Promise.all([leader.next(), other.next()]); // settings-changed обоим

    const pending = await connect();
    pending.send({ type: 'join-room', roomId: naRoomId2, name: 'Ждущий' });
    await pending.next(); // waiting
    await leader.next(); // join-request

    // pending -> лидер: доставляется.
    pending.send({ type: 'name-announce', to: leaderJoined.peerId, payload: 'pending-to-leader' });
    const toLeader = await leader.next();
    ok(toLeader.type === 'name-announce' && toLeader.from && toLeader.payload === 'pending-to-leader',
      'name-announce pending->лидер доставлен');

    // pending -> не-лидер: явный отказ (не гонка/тихий дроп — нарушение прав), сокет не рвётся.
    pending.send({ type: 'name-announce', to: otherJoined.peerId, payload: 'pending-to-nonleader' });
    const errMsg = await pending.next();
    ok(errMsg.type === 'error', `name-announce pending->не-лидер отклонён явной ошибкой (${errMsg.message})`);
    sendBeacon(leader, otherJoined.peerId, { kind: 'text', text: 'маячок-после-name-announce-not-leader' });
    const beacon = await other.next();
    ok(isBeaconMsg(beacon) && beacon.info.text === 'маячок-после-name-announce-not-leader',
      'сокет остальных участников жив, чужой name-announce им не пришёл');

    pending.ws.close();
    await leader.next(); // join-request-cancelled
    leader.ws.close();
    await other.next(); // leader-changed (other становится единственным оставшимся лидером)
    await other.next(); // peer-left ушедшего лидера
    other.ws.close();
  }

  // --- 30. name-announce: лимит размера payload (H2, 2KB) ---
  console.log('30. name-announce: лимит размера payload (2KB)');
  {
    const { roomId: bigRoomId } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: bigA, joined: jBigA } = await join(bigRoomId, 'A');
    const { peer: bigB, joined: jBigB } = await join(bigRoomId, 'B');
    await bigA.next(); // peer-joined

    const bigPayload = 'x'.repeat(2 * 1024 + 1); // на 1 байт больше лимита
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: bigPayload });
    const errMsg = await bigA.next();
    ok(errMsg.type === 'error', `name-announce payload >2KB -> error отправителю (${errMsg.message})`);

    // Доказываем недоставку: следующий валидный name-announce доходит как маячок.
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: 'маячок-после-oversize-name-announce' });
    const beacon = await bigB.next();
    ok(beacon.type === 'name-announce' && beacon.payload === 'маячок-после-oversize-name-announce',
      'name-announce >2KB не доставлен; следующий валидный дошёл как есть');

    // Payload размером ровно в лимит (2KB) — проходит целиком.
    const okPayload = 'y'.repeat(2 * 1024);
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: okPayload });
    const okMsg = await bigB.next();
    ok(okMsg.type === 'name-announce' && okMsg.payload.length === okPayload.length,
      'name-announce размером ровно 2KB доставлен целиком');

    bigA.ws.close();
    await bigB.next(); // peer-left
    bigB.ws.close();
  }

  // --- 31. lifetimeSeconds в POST /api/rooms и PUT /api/rooms/{id} ---
  console.log('31. lifetimeSeconds в POST/PUT /api/rooms');
  {
    const { status, lifetimeSeconds } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    ok(status === 201 && typeof lifetimeSeconds === 'number' && lifetimeSeconds > 0,
      `POST /api/rooms возвращает lifetimeSeconds (получено ${lifetimeSeconds})`);
    // Дефолт без MAX_ROOM_LIFETIME_SECONDS — 3ч (10800с), см.
    // DEFAULT_MAX_ROOM_LIFETIME_SECONDS в src/state.rs.
    ok(lifetimeSeconds === 10800, `дефолтный lifetimeSeconds — 10800с/3ч (получено ${lifetimeSeconds})`);

    // PUT — то же поле, для симметрии API (см. спецификацию E2E v2 §2): обе ветки идемпотентности.
    const freshId2 = 'lt9k2m7q'; // валидный формат, заведомо не существовал
    const created = await restoreRoom(freshId2, RESTORE_ROOM_TEST_IP);
    ok(created.status === 201 && created.lifetimeSeconds === 10800,
      `PUT восстановления несуществующей комнаты возвращает lifetimeSeconds (${created.lifetimeSeconds})`);
    const already = await restoreRoom(freshId2, RESTORE_ROOM_TEST_IP);
    ok(already.status === 200 && already.lifetimeSeconds === 10800,
      `PUT уже существующей комнаты тоже возвращает lifetimeSeconds (${already.lifetimeSeconds})`);
  }

  // --- 32. Лимит участников от лидера (max_participants, docs/research-room-limit.md) ---
  console.log('32. лимит участников от лидера (max_participants)');
  {
    const { roomId: capId, leaderToken: capToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: leader, joined: leaderJoined } = await join(capId, 'Лидер', URL, undefined, capToken);
    ok(leaderJoined.maxParticipants === 6,
      `без собственного лимита joined.maxParticipants — серверный потолок (получено ${leaderJoined.maxParticipants})`);

    // Второй и третий входят при ещё дефолтном (серверном) лимите.
    const { peer: p2, joined: j2 } = await join(capId, 'Второй');
    await leader.next(); // peer-joined
    const { peer: p3, joined: j3 } = await join(capId, 'Третий');
    await Promise.all([leader.next(), p2.next()]); // peer-joined обоим
    ok(j2.type === 'joined' && j3.type === 'joined', 'второй и третий вошли при серверном лимите');

    // Лидер выставляет свой собственный лимит 2 — НИЖЕ текущей занятости (3).
    updateSettings(leader, defaultSettings({ maxParticipants: 2 }));
    const [sc1, sc2, sc3] = await Promise.all([leader.next(), p2.next(), p3.next()]);
    ok(sc1.type === 'settings-changed' && sc1.settings.maxParticipants === 2
      && sc2.settings.maxParticipants === 2 && sc3.settings.maxParticipants === 2,
      'settings-changed несёт новый maxParticipants=2 всем участникам');

    // Никого не выгнали — все трое всё ещё могут получать/слать (маячок).
    sendBeacon(leader, j2.peerId, { kind: 'still-here' });
    const stillHere = await p2.next();
    ok(isBeaconMsg(stillHere) && stillHere.info.kind === 'still-here',
      'снижение лимита ниже занятости НЕ выгоняет уже вошедших (D, §2.2)');

    // Новый вход отклоняется — уже 3 участника >= эффективного лимита 2.
    const fourth = await connect();
    fourth.send({ type: 'join-room', roomId: capId });
    const roomFull1 = await fourth.next();
    ok(roomFull1.type === 'room-full', 'вход четвёртого отклонён — 3 участника >= лимита лидера (2)');
    await fourth.closed;

    // Один выходит (3 -> 2) — по-прежнему >= 2, всё ещё отказ.
    p3.ws.close();
    await Promise.all([leader.next(), p2.next()]); // peer-left
    const fifth = await connect();
    fifth.send({ type: 'join-room', roomId: capId });
    const roomFull2 = await fifth.next();
    ok(roomFull2.type === 'room-full', 'после ухода одного (2 участника) вход всё ещё отклонён — 2 >= лимита 2');
    await fifth.closed;

    // Ещё один выходит (2 -> 1) — теперь 1 < 2, вход снова разрешён.
    p2.ws.close();
    await leader.next(); // peer-left
    const { peer: p6, joined: j6 } = await join(capId, 'Шестой');
    ok(j6.type === 'joined' && j6.maxParticipants === 2,
      `после освобождения слота вход снова разрешён, joined.maxParticipants===2 (получено ${j6.maxParticipants})`);
    await leader.next(); // peer-joined

    // Валидация границ update-settings: maxParticipants=1 (< 2) -> отказ.
    updateSettings(leader, defaultSettings({ maxParticipants: 1 }));
    const errLow = await leader.next();
    ok(errLow.type === 'error', `maxParticipants=1 (< 2) отклонён как невалидный (${errLow.message})`);

    // maxParticipants=7 (> серверного потолка 6) -> отказ.
    updateSettings(leader, defaultSettings({ maxParticipants: 7 }));
    const errHigh = await leader.next();
    ok(errHigh.type === 'error', `maxParticipants=7 (> серверного потолка 6) отклонён (${errHigh.message})`);

    // Подтверждаем, что ОБА отклонённых update-settings НЕ поменяли
    // действующий лимит — комната всё ещё под ним же (count=2, limit=2).
    const seventh = await connect();
    seventh.send({ type: 'join-room', roomId: capId });
    const stillFull = await seventh.next();
    ok(stillFull.type === 'room-full',
      'после ДВУХ отклонённых update-settings лимит остался прежним (2), вход всё ещё отклонён');
    await seventh.closed;

    // maxParticipants=6 (ровно серверный потолок, верхняя граница) — принят.
    updateSettings(leader, defaultSettings({ maxParticipants: 6 }));
    const [scOk1, scOk2] = await Promise.all([leader.next(), p6.next()]);
    ok(scOk1.type === 'settings-changed' && scOk1.settings.maxParticipants === 6 && scOk2.settings.maxParticipants === 6,
      'maxParticipants=6 (ровно серверный потолок) принят');

    const eighth = await join(capId, 'Восьмой');
    ok(eighth.joined.type === 'joined', 'после поднятия лимита до 6 новый вход снова разрешён');
    await Promise.all([leader.next(), p6.next()]); // peer-joined

    leader.ws.close();
    p6.ws.close();
    eighth.peer.ws.close();
  }
}

// --- main --------------------------------------------------------------

async function main() {
  buildServer();
  startServer();
  try {
    await waitForReady(CONFIG_URL, serverProc);
    await runTests();
  } finally {
    console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  }
}

main()
  .then(() => { cleanup(); process.exit(failed ? 1 : 0); })
  .catch((e) => {
    console.error('Тест упал с исключением:', e);
    failed += 1;
    console.log(`\nИтого: ${passed} ok, ${failed} fail`);
    cleanup();
    process.exit(1);
  });
