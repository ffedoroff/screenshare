// Интеграционный тест сигналинга (протокол v3 — симметричная комната: все
// участники равны, mesh, шаринг экрана — временное состояние комнаты; чат
// на сервере — только адресный fallback-релей опакового конверта, см.
// README.md/src/ws.rs). Гоняет полный жизненный цикл комнаты против
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

async function createRoom(body, roomsUrl = ROOMS_URL) {
  const opts = { method: 'POST' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(roomsUrl, opts);
  let json = null;
  try { json = await res.json(); } catch { /* не JSON — ниже проверим статус */ }
  return { status: res.status, roomId: json && json.roomId, leaderToken: json && json.leaderToken };
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

function isChatMsg(m) {
  return m && m.type === 'chat' && typeof m.fromPeerId === 'string'
    && m.envelope !== undefined && m.envelope !== null && typeof m.envelope === 'object';
}

function sendChat(sender, targetPeerId, envelope) {
  sender.send({ type: 'chat', targetPeerId, envelope });
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
  // (проверяем маячком через адресный чат — см. п.7 про формат конверта).
  p2.send({ type: 'ice-candidate', targetPeerId: 'ghost', candidate: {} });
  {
    sendChat(p2, p1Id, { kind: 'text', text: 'маячок-после-ghost-релея' });
    const m = await p1.next();
    ok(isChatMsg(m) && m.fromPeerId === p2Id && m.envelope.text === 'маячок-после-ghost-релея',
      'релей на неизвестный peerId не ломает сокет — чат p2->p1 после него доходит');
  }

  // --- 7. Чат: адресный relay опакового конверта (сервер конверт не разбирает) ---
  console.log('7. чат: адресный relay envelope (опаковость)');
  {
    // Конверт — намеренно с полями, каких сервер никогда не видел (v/id/
    // lamport/from/name/kind/text/replyTo из static/chat.js + пара
    // совершенно произвольных полей) — сервер обязан доставить его КАК ЕСТЬ,
    // не разбирая и не валидируя содержимое (кроме размера, см. п.7b).
    const envelope = {
      v: 1,
      id: 'msg-1',
      lamport: 3,
      from: p2Id,
      name: 'Аня',
      kind: 'text',
      text: 'Привет от Ани',
      replyTo: null,
      arbitraryField: { nested: [1, 2, 3] },
      anotherOne: 'ромашки',
    };
    sendChat(p2, p1Id, envelope);
    const m = await p1.next();
    ok(m.type === 'chat' && m.fromPeerId === p2Id && deepEqual(m.envelope, envelope),
      'адресату конверт доставлен побайтово как есть (опаковость), с fromPeerId отправителя');
  }
  {
    // Доказываем, что это АДРЕСНЫЙ релей, а не broadcast: p2 шлёт p1
    // envelope-A, затем сразу p3 envelope-B (маячок) — у p3 следующим
    // сообщением должен прийти именно маячок B, а не просочившийся A.
    const envelopeA = { kind: 'text', text: 'A — только для p1' };
    const envelopeB = { kind: 'text', text: 'B — маячок для p3' };
    sendChat(p2, p1Id, envelopeA);
    sendChat(p2, p3Id, envelopeB);
    const [mp1, mp3] = await Promise.all([p1.next(), p3.next()]);
    ok(isChatMsg(mp1) && mp1.envelope.text === 'A — только для p1', 'p1 получил именно envelope A');
    ok(isChatMsg(mp3) && mp3.envelope.text === 'B — маячок для p3', 'p3 получил именно маячок B, не A (адресный релей, не broadcast)');
  }

  // --- 7b. Чат: конверт больше 8КБ -> error, не доставляется ---
  console.log('7b. чат: envelope больше 8КБ -> error');
  {
    const bigEnvelope = { kind: 'text', text: 'x'.repeat(9000) };
    sendChat(p1, p2Id, bigEnvelope);
    const m = await p1.next();
    ok(m.type === 'error', `envelope >8КБ -> error отправителю (${m.message})`);

    // Доказываем, что слишком большой конверт НЕ доставлен: следующим
    // сообщением у p2 должен прийти явный маячок, а не просочившийся bigEnvelope.
    sendChat(p1, p2Id, { kind: 'text', text: 'маячок-после-oversize' });
    const m2 = await p2.next();
    ok(isChatMsg(m2) && m2.envelope.text === 'маячок-после-oversize',
      'слишком большой конверт не дошёл до адресата');
  }

  // --- 8. Четвёртый участник входит (без истории — сервер её не хранит) ---
  console.log('8. четвёртый участник входит');
  const { peer: p4, joined: j4 } = await join(roomId, 'Вова');
  const p4Id = j4.peerId;
  ok(j4.peers.length === 3, 'у четвёртого участника peers содержит трёх предыдущих');
  await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined всем троим

  // --- 8b. Rate-limit: не более 10 сообщений за окно, 11-е -> error, не доставляется ---
  console.log('8b. чат: rate-limit (серверный, на fallback-пути)');
  {
    // 10 адресных сообщений подряд с одного соединения (p4) — все проходят.
    for (let i = 0; i < 10; i++) {
      sendChat(p4, p1Id, { kind: 'text', text: `сообщение ${i}` });
      const m = await p1.next();
      ok(isChatMsg(m) && m.fromPeerId === p4Id, `сообщение ${i} доставлено (в пределах лимита)`);
    }
    // 11-е сообщение в окне -> error самому отправителю.
    sendChat(p4, p1Id, { kind: 'text', text: 'одиннадцатое' });
    const errMsg = await p4.next();
    ok(errMsg.type === 'error', `11-е сообщение за окно -> error (${errMsg.message})`);

    // Доказываем, что 11-е сообщение НЕ было доставлено: следующим сообщением
    // p1 должен прийти заведомо другой маячок от другого отправителя (p2), а
    // не просочившееся 11-е от p4.
    sendChat(p2, p1Id, { kind: 'text', text: 'маячок-после-rate-limit' });
    const beacon = await p1.next();
    ok(isChatMsg(beacon) && beacon.fromPeerId === p2Id && beacon.envelope.text === 'маячок-после-rate-limit',
      'сообщение, срезанное rate-limit, не доставлено адресату');
  }

  // --- 9. Шаринг экрана: захват, отказ занятому, освобождение, перезахват ---
  console.log('9. шаринг экрана');
  {
    p1.send({ type: 'share-start' });
    const [s1, s2, s3, s4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([s1, s2, s3, s4].every((m) => m.type === 'share-started' && m.peerId === p1Id),
      'share-started приходит ВСЕМ, включая инициатора');

    // Второй участник пытается захватить занятый экран — отказ только ему.
    p2.send({ type: 'share-start' });
    const rej = await p2.next();
    ok(rej.type === 'share-rejected' && rej.busyPeerId === p1Id, 'share-rejected с busyPeerId занявшего экран участника');

    // Доказываем, что share-rejected НЕ разослан остальным: следующим адресным
    // сообщением p1 должен прийти маячок, а не второй share-started/share-rejected.
    {
      sendChat(p2, p1Id, { kind: 'text', text: 'маячок-после-share-rejected' });
      const b = await p1.next();
      ok(isChatMsg(b) && b.envelope.text === 'маячок-после-share-rejected',
        'share-rejected доставлен только инициатору, остальные его не получили');
    }

    // share-stop НЕ от владельца — тихо игнорируется, экран остаётся за p1.
    p3.send({ type: 'share-stop' });
    p2.send({ type: 'share-start' }); // если бы share-stop сработал, тут был бы share-started
    const stillBusy = await p2.next();
    ok(stillBusy.type === 'share-rejected' && stillBusy.busyPeerId === p1Id,
      'share-stop не от владельца проигнорирован — экран остаётся за прежним владельцем');

    // Владелец освобождает экран — share-stopped всем.
    p1.send({ type: 'share-stop' });
    const [st1, st2, st3, st4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([st1, st2, st3, st4].every((m) => m.type === 'share-stopped' && m.peerId === p1Id),
      'share-stopped приходит всем после share-stop владельца');

    // После освобождения другой участник может захватить экран.
    p2.send({ type: 'share-start' });
    const [c1, c2, c3, c4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([c1, c2, c3, c4].every((m) => m.type === 'share-started' && m.peerId === p2Id),
      'после освобождения другой участник успешно захватывает экран');

    // Новый участник в комнату с активным шарингом получает screenOwner в joined.
    const { peer: p5, joined: j5 } = await join(roomId, 'Галя');
    ok(j5.screenOwner === p2Id, 'новый участник получает screenOwner активного шаринга в joined');
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-joined всем

    // Освобождаем перед следующим блоком (дисконнект-тест).
    p2.send({ type: 'share-stop' });
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

  // --- 13. QR-код /qr.svg?room=<roomId> ---
  console.log('13. GET /qr.svg');
  {
    const res = await fetch(`http://localhost:${PORT}/qr.svg?room=abcd2345`);
    ok(res.status === 200, 'GET /qr.svg?room=abcd2345 -> 200');
    ok((res.headers.get('content-type') || '').includes('image/svg+xml'), 'content-type image/svg+xml');
    const body = await res.text();
    ok(body.includes('<svg'), 'тело ответа содержит <svg');

    const bad = await fetch(`http://localhost:${PORT}/qr.svg?room=${encodeURIComponent('../evil')}`);
    ok(bad.status === 400, '?room=../evil -> 400');

    const missing = await fetch(`http://localhost:${PORT}/qr.svg`);
    ok(missing.status === 400, 'без параметра room -> 400');
  }

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

    // --- 20. guest_chat=false: chat гостя error, лидера проходит ---
    console.log('20. guest_chat=false enforcement');
    updateSettings(b, defaultSettings({ guestScreen: false, guestChat: false }));
    await Promise.all([b.next(), c.next()]); // settings-changed

    sendChat(c, jb.peerId, { kind: 'text', text: 'запрещённое сообщение' });
    const chatErr = await c.next();
    ok(chatErr.type === 'error', `гостю с guestChat=false запрещён fallback-чат (${chatErr.message})`);

    sendChat(b, jc.peerId, { kind: 'text', text: 'лидеру можно' });
    const chatOk = await c.next();
    ok(isChatMsg(chatOk) && chatOk.fromPeerId === jb.peerId && chatOk.envelope.text === 'лидеру можно',
      'лидеру fallback-чат разрешён независимо от guestChat');

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
