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
  serverProc = spawnServer(PORT, { EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS) });
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
  return { status: res.status, roomId: json && json.roomId, leaderToken: json && json.leaderToken };
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
async function restoreRoom(roomId) {
  const res = await fetch(`${ROOMS_URL}/${encodeURIComponent(roomId)}`, { method: 'PUT' });
  let json = null;
  try { json = await res.json(); } catch { /* не JSON — ниже проверим статус */ }
  return { status: res.status, roomId: json && json.roomId };
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
async function join(roomId, name, wsUrl = URL, peerId = undefined, leaderToken = undefined) {
  const peer = await connect(wsUrl);
  const msg = { type: 'join-room', roomId };
  if (name !== undefined) msg.name = name;
  if (peerId !== undefined) msg.peerId = peerId;
  if (leaderToken !== undefined) msg.leaderToken = leaderToken;
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
    const created = await restoreRoom(freshId);
    ok(created.status === 201, `восстановление НЕсуществующей комнаты -> 201 (status=${created.status})`);
    ok(created.roomId === freshId, 'в ответе тот же roomId, что запрошен');

    // Вход в только что восстановленную комнату работает как обычно.
    const { peer, joined } = await join(freshId);
    ok(joined.type === 'joined' && joined.peers.length === 0, 'вход в восстановленную комнату успешен, участников ещё 0');

    // Комната уже существует (мы только что в неё вошли) -> 200, ничего не пересоздано.
    const already = await restoreRoom(freshId);
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
  ok(pj1.type === 'peer-joined' && pj1.peerId === p2Id && pj1.name === 'Аня',
    'первый участник получил peer-joined с именем второго (Аня)');

  // --- 4b. join-room с клиентским peerId (переподключение после обрыва сигналинга) ---
  console.log('4b. join-room с клиентским peerId');
  {
    // Свободный валидный uuid -> сервер принимает его как есть.
    const desiredId = genUuid();
    const { peer: pCustom, joined: jCustom } = await join(roomId, 'Игорь', URL, desiredId);
    ok(jCustom.peerId === desiredId, `свободный валидный peerId принят как есть (${jCustom.peerId})`);
    await Promise.all([p1.next(), p2.next()]); // peer-joined остальным

    // peerId уже занят (p1Id) -> сервер тихо генерирует новый, а не отказывает.
    const { peer: pTaken, joined: jTaken } = await join(roomId, 'Занятой', URL, p1Id);
    ok(jTaken.type === 'joined' && jTaken.peerId !== p1Id, `занятый peerId -> выдан другой (${jTaken.peerId} !== ${p1Id})`);
    await Promise.all([p1.next(), p2.next(), pCustom.next()]); // peer-joined остальным

    // Кривой peerId (не uuid) -> сервер тихо генерирует новый.
    const { peer: pBad, joined: jBad } = await join(roomId, 'Кривой', URL, 'not-a-uuid');
    ok(jBad.type === 'joined' && typeof jBad.peerId === 'string' && jBad.peerId !== 'not-a-uuid',
      `невалидный (не-uuid) peerId -> выдан новый (${jBad.peerId})`);
    await Promise.all([p1.next(), p2.next(), pCustom.next(), pTaken.next()]); // peer-joined остальным

    // Прибираем троих за собой — порядок трёх peer-left относительно друг
    // друга не важен, важно что p1/p2 получат ровно по три (не считаем, чей
    // именно peerId в каком сообщении — уже проверено выше при входе).
    pCustom.ws.close();
    pTaken.ws.close();
    pBad.ws.close();
    for (let i = 0; i < 3; i++) {
      const [m1, m2] = await Promise.all([p1.next(), p2.next()]);
      ok(m1.type === 'peer-left' && m2.type === 'peer-left', 'peer-left дошёл p1 и p2 при уходе временного участника');
    }
  }

  // --- 4c. Ш1: лимит имени поднят с 32 до 512 символов (name теперь шифрблоб
  // клиента — длиннее открытого текста, см. src/ws.rs::CHAT_NAME_MAX_CHARS) —
  // сервер по-прежнему прозрачен к содержимому: не проверяет, что это валидный
  // шифрблоб, просто обрезает по новому лимиту символов. ---
  console.log('4c. name: лимит поднят с 32 до 512 символов');
  {
    const name400 = 'x'.repeat(400); // укладывается в новый лимит (512) — не уложилось бы в прежний (32)
    const { peer: pLong, joined: jLong } = await join(roomId, name400);
    ok(jLong.type === 'joined', 'участник с именем 400 символов входит без ошибки');
    ok(jLong.peerId, 'у вошедшего есть свой peerId');
    await Promise.all([p1.next(), p2.next()]); // peer-joined у уже сидящих в комнате

    const name600 = 'y'.repeat(600); // длиннее нового лимита (512) -> сервер обрезает
    const { peer: pTooLong, joined: jTooLong } = await join(roomId, name600);
    ok(jTooLong.type === 'joined', 'участник с именем 600 символов всё равно входит (не ошибка, просто обрежется)');
    const [pj1, pj2, pjLong] = await Promise.all([p1.next(), p2.next(), pLong.next()]);
    ok(
      pj1.type === 'peer-joined' && pj1.name === 'y'.repeat(512),
      `peer-joined с именем 600 символов обрезан сервером до 512 (получено ${pj1.name ? pj1.name.length : 'null'})`
    );
    ok(pj2.type === 'peer-joined' && pj2.name.length === 512, 'второй получатель тоже видит обрезанное до 512 имя');
    ok(pjLong.type === 'peer-joined' && pjLong.name.length === 512, 'третий получатель тоже видит обрезанное до 512 имя');

    // Прибираем обоих за собой — по одному, чтобы не гадать порядок peer-left.
    pTooLong.ws.close();
    await Promise.all([p1.next(), p2.next(), pLong.next()]); // peer-left ушедшего с длинным именем

    pLong.ws.close();
    await Promise.all([p1.next(), p2.next()]); // peer-left второго временного участника
  }

  // --- 5. Третий участник видит ОБОИХ предыдущих в peers ---
  console.log('5. третий участник видит всех предыдущих; оба получают peer-joined');
  const { peer: p3, joined: j3 } = await join(roomId, 'Боб');
  const p3Id = j3.peerId;
  ok(j3.peers.length === 2, 'у третьего участника peers содержит двух предыдущих');
  ok(j3.peers.some((p) => p.peerId === p1Id && p.name === null), 'peers содержит первого (имя null)');
  ok(j3.peers.some((p) => p.peerId === p2Id && p.name === 'Аня'), 'peers содержит второго (имя Аня)');

  const [pj2a, pj2b] = await Promise.all([p1.next(), p2.next()]);
  ok(pj2a.type === 'peer-joined' && pj2a.peerId === p3Id && pj2a.name === 'Боб', 'первый получил peer-joined (Боб)');
  ok(pj2b.type === 'peer-joined' && pj2b.peerId === p3Id && pj2b.name === 'Боб', 'второй получил peer-joined (Боб)');

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
    ok(jr1.type === 'join-request' && jr1.name === 'Ждущий1' && typeof jr1.peerId === 'string',
      'лидер получает join-request с именем ожидающего');
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
    ok(jr2.type === 'join-request' && jr2.name === 'Ждущий2', 'вторая заявка приходит лидеру');
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
    ok(jr3.type === 'join-request' && jr3.name === 'Ждущий3', 'третья заявка приходит лидеру');
    guest3.ws.close();
    const cancelMsg = await leader.next();
    ok(cancelMsg.type === 'join-request-cancelled' && cancelMsg.peerId === jr3.peerId,
      'отвал ожидающего, не дождавшегося решения -> лидеру join-request-cancelled');

    // Смена лидера при непустом pending: четвёртый ожидающий заявляется, затем лидер уходит.
    const guest4 = await connect();
    guest4.send({ type: 'join-room', roomId: lId, name: 'Ждущий4' });
    await guest4.next(); // waiting
    const jr4 = await leader.next();
    ok(jr4.type === 'join-request' && jr4.name === 'Ждущий4', 'четвёртая заявка приходит прежнему лидеру');

    // Комната сейчас: участники — leader (лидер) и guest1 (approved); ожидает — guest4.
    leader.ws.close();
    const lcMsg = await guest1.next();
    ok(lcMsg.type === 'leader-changed' && lcMsg.leaderId === guest1Id,
      'уход лидера при непустом pending -> leader-changed новому (единственному оставшемуся) участнику');
    const jrAgain = await guest1.next();
    ok(jrAgain.type === 'join-request' && jrAgain.peerId === jr4.peerId && jrAgain.name === 'Ждущий4',
      'непустой pending пересылается новому лидеру заново (join-request)');

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

  // --- 24. Security-заголовки на API-ответах (M2) ---
  console.log('24. security-заголовки на /config');
  {
    const res = await fetch(CONFIG_URL);
    ok(res.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff на /config');
    ok(res.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer на /config');
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
