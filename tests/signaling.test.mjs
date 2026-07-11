// Интеграционный тест сигналинга + чата (протокол v2 — симметричная комната:
// все участники равны, mesh, шаринг экрана — временное состояние комнаты).
// Гоняет полный жизненный цикл комнаты против САМОСТОЯТЕЛЬНО поднятого
// сервера (собирает cargo build, запускает ./target/debug/screenshare на
// порту 3311 с временной SQLite-БД и гарантированно прибирает за собой).
// Чистый Node >= 22, глобальный WebSocket/fetch, без npm.
//
// Запуск: node tests/signaling.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

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

const dbPath = path.join(os.tmpdir(), `screenshare-test-${process.pid}-${crypto.randomUUID()}.db`);
const dbSidecars = ['', '-wal', '-shm', '-journal'].map((suf) => dbPath + suf);
let serverProc = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (serverProc && serverProc.exitCode === null && !serverProc.killed) {
    try { serverProc.kill('SIGKILL'); } catch { /* уже мёртв */ }
  }
  for (const f of dbSidecars) {
    try { fs.rmSync(f, { force: true }); } catch { /* нет файла — и хорошо */ }
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

function startServer() {
  const bin = path.join(PROJECT_DIR, 'target', 'debug', 'screenshare');
  if (!fs.existsSync(bin)) {
    throw new Error(`бинарник не найден: ${bin}`);
  }
  console.log(`Запуск сервера на порту ${PORT} (БД: ${dbPath})...`);
  serverProc = spawn(bin, [], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: `sqlite://${dbPath}?mode=rwc`,
      EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS),
      RUST_LOG: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  serverProc.stdout.on('data', (d) => { out += d; });
  serverProc.stderr.on('data', (d) => { out += d; });
  serverProc.on('exit', (code, signal) => {
    if (!cleaned && code !== 0 && code !== null) {
      console.error(`Сервер неожиданно завершился (code=${code}, signal=${signal}):\n${out}`);
    }
  });
  return () => out; // для отладки при необходимости
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) {
      throw new Error(`сервер упал до готовности (exit code ${serverProc.exitCode})`);
    }
    try {
      const res = await fetch(CONFIG_URL);
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

async function createRoom(body) {
  const opts = { method: 'POST' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(ROOMS_URL, opts);
  let json = null;
  try { json = await res.json(); } catch { /* не JSON — ниже проверим статус */ }
  return { status: res.status, roomId: json && json.roomId };
}

// --- WS-клиент для теста --------------------------------------------------

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
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

// Подключиться и войти в комнату одним шагом; возвращает { peer, joined }
// (без ожидания chat-history — вызывающий код сам решает, ждать её или нет).
async function join(roomId, name) {
  const peer = await connect();
  const msg = { type: 'join-room', roomId };
  if (name !== undefined) msg.name = name;
  peer.send(msg);
  const joined = await peer.next();
  return { peer, joined };
}

// Отправить chat с одного пира и дождаться его широковещательной копии
// у каждого из recipients (порядок результата соответствует порядку recipients).
function sendChatAndDrain(sender, text, recipients) {
  sender.send({ type: 'chat', text });
  return Promise.all(recipients.map((r) => r.next()));
}

function isChatMsg(m) {
  return m && m.type === 'chat' && typeof m.fromPeerId === 'string'
    && typeof m.text === 'string' && typeof m.ts === 'number';
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
  {
    const { status, roomId: id } = await createRoom();
    ok(status === 201, `201 Created (status=${status})`);
    ok(/^[23456789a-z]{8}$/.test(id), `roomId короткий и человекочитаемый (${id})`);
    roomId = id;

    // Тело опционально и игнорируется — не должно ломать создание.
    const withBody = await createRoom({ name: 'Моя комната' });
    ok(withBody.status === 201 && /^[23456789a-z]{8}$/.test(withBody.roomId),
      'опциональное тело {name} игнорируется, комната всё равно создаётся');
  }

  // --- 3. Первый участник входит в свежесозданную комнату ---
  console.log('3. первый участник входит: peers=[], screenOwner=null');
  const { peer: p1, joined: j1 } = await join(roomId);
  ok(j1.type === 'joined' && Array.isArray(j1.peers) && j1.peers.length === 0 && j1.screenOwner === null,
    'joined: peers=[], screenOwner=null для первого участника');
  const p1Id = j1.peerId;

  const p1History0 = await p1.next();
  ok(p1History0.type === 'chat-history' && Array.isArray(p1History0.messages) && p1History0.messages.length === 0,
    'первый участник получил пустую chat-history сразу после joined');

  // --- 4. Второй участник (с именем) входит: видит первого в peers ---
  console.log('4. второй участник: peers содержит первого, peer-joined приходит первому');
  const { peer: p2, joined: j2 } = await join(roomId, 'Аня');
  const p2Id = j2.peerId;
  ok(j2.type === 'joined' && j2.peers.length === 1 && j2.peers[0].peerId === p1Id && j2.peers[0].name === null,
    'joined: peers=[{peerId: первый, name: null}] для второго участника');
  ok(j2.screenOwner === null, 'screenOwner всё ещё null');
  await p2.next(); // chat-history (пустая)

  const pj1 = await p1.next();
  ok(pj1.type === 'peer-joined' && pj1.peerId === p2Id && pj1.name === 'Аня',
    'первый участник получил peer-joined с именем второго (Аня)');

  // --- 5. Третий участник видит ОБОИХ предыдущих в peers ---
  console.log('5. третий участник видит всех предыдущих; оба получают peer-joined');
  const { peer: p3, joined: j3 } = await join(roomId, 'Боб');
  const p3Id = j3.peerId;
  ok(j3.peers.length === 2, 'у третьего участника peers содержит двух предыдущих');
  ok(j3.peers.some((p) => p.peerId === p1Id && p.name === null), 'peers содержит первого (имя null)');
  ok(j3.peers.some((p) => p.peerId === p2Id && p.name === 'Аня'), 'peers содержит второго (имя Аня)');
  await p3.next(); // chat-history

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

  // Релей на несуществующий peerId — тихо игнорируется, соединение живо.
  p2.send({ type: 'ice-candidate', targetPeerId: 'ghost', candidate: {} });
  {
    const results = await sendChatAndDrain(p2, 'маячок-после-ghost-релея', [p1, p2, p3]);
    ok(results.every((m) => isChatMsg(m) && m.text === 'маячок-после-ghost-релея'),
      'релей на неизвестный peerId не ломает сокет/чат');
  }

  // --- 7. Чат: базовая доставка всем участникам, включая отправителя ---
  console.log('7. чат: базовая доставка и история');
  {
    const [selfMsg, p1Msg, p3Msg] = await sendChatAndDrain(p2, 'Привет от Ани', [p2, p1, p3]);
    ok(isChatMsg(selfMsg) && selfMsg.fromPeerId === p2Id && selfMsg.name === 'Аня' && selfMsg.text === 'Привет от Ани',
      'chat приходит самому отправителю (fromPeerId, name, ts)');
    ok(isChatMsg(p1Msg) && p1Msg.fromPeerId === p2Id, 'chat приходит первому участнику');
    ok(isChatMsg(p3Msg) && p3Msg.fromPeerId === p2Id, 'chat приходит третьему участнику');
  }
  {
    const [p2Msg, selfMsg, p3Msg] = await sendChatAndDrain(p1, 'Привет от первого', [p2, p1, p3]);
    ok(isChatMsg(p2Msg) && p2Msg.fromPeerId === p1Id && p2Msg.name === null, 'chat от первого доходит второму');
    ok(isChatMsg(selfMsg) && selfMsg.fromPeerId === p1Id, 'chat доходит самому себе (единый путь рендера)');
    ok(isChatMsg(p3Msg) && p3Msg.fromPeerId === p1Id, 'chat от первого доходит третьему');
  }

  // --- 7b. Невалидный чат: пустой текст и слишком длинный ---
  console.log('7b. чат: валидация текста');
  {
    p1.send({ type: 'chat', text: '' });
    const m = await p1.next();
    ok(m.type === 'error', `пустой text -> error (${m.message})`);
  }
  {
    p1.send({ type: 'chat', text: 'a'.repeat(2001) });
    const m = await p1.next();
    ok(m.type === 'error', `текст 2001 символ -> error (${m.message})`);
  }

  // --- 8. Новый участник получает накопленную историю в хронологическом порядке ---
  console.log('8. четвёртый участник: chat-history с 2 сообщениями');
  const { peer: p4, joined: j4 } = await join(roomId, 'Вова');
  const p4Id = j4.peerId;
  ok(j4.peers.length === 3, 'у четвёртого участника peers содержит трёх предыдущих');
  await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined всем троим

  const hist4 = await p4.next();
  // 3 сообщения: маячок из релей-теста (п.6) + два из п.7.
  ok(hist4.type === 'chat-history' && hist4.messages.length === 3, 'четвёртый участник получил накопленную историю (3 сообщения)');
  ok(
    hist4.messages[0].text === 'маячок-после-ghost-релея'
    && hist4.messages[1].fromPeerId === p2Id && hist4.messages[1].text === 'Привет от Ани'
    && hist4.messages[2].fromPeerId === p1Id && hist4.messages[2].text === 'Привет от первого',
    'chat-history в хронологическом порядке',
  );

  {
    const [selfMsg, p1Msg, p2Msg, p3Msg] = await sendChatAndDrain(p4, 'Привет, я Вова', [p4, p1, p2, p3]);
    ok(selfMsg.name === 'Вова' && p1Msg.name === 'Вова' && p2Msg.name === 'Вова' && p3Msg.name === 'Вова',
      'name из join-room попадает в поле name чата');
  }

  // --- 8b. Rate-limit: не более 10 сообщений за окно, 11-е -> error, не доставляется другим ---
  console.log('8b. чат: rate-limit');
  {
    // p4 уже отправил одно валидное сообщение выше — досылаем ещё 9, итого 10 в окне.
    for (let i = 0; i < 9; i++) {
      await sendChatAndDrain(p4, `сообщение ${i}`, [p4, p1, p2, p3]);
    }
    // 11-е сообщение в окне -> error самому отправителю.
    p4.send({ type: 'chat', text: 'одиннадцатое' });
    const errMsg = await p4.next();
    ok(errMsg.type === 'error', `11-е сообщение за окно -> error (${errMsg.message})`);

    // Доказываем, что 11-е сообщение НЕ было разослано другим: следующим
    // сообщением должен прийти заведомо другой "маячок", а не просочившееся 11-е.
    const [p1Next, p2Next, p3Next, p4Next] = await sendChatAndDrain(p1, 'маячок-после-rate-limit', [p1, p2, p3, p4]);
    ok(p1Next.text === 'маячок-после-rate-limit' && p2Next.text === 'маячок-после-rate-limit'
      && p3Next.text === 'маячок-после-rate-limit' && p4Next.text === 'маячок-после-rate-limit',
      'сообщение, срезанное rate-limit, не доставлено другим участникам');
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

    // Доказываем, что share-rejected НЕ разослан остальным: следующим сообщением
    // всем (включая самого p2 — chat всегда приходит и отправителю) должен
    // прийти маячок, а не второй share-started/share-rejected.
    {
      const [b1, b2, b3, b4] = await sendChatAndDrain(p2, 'маячок-после-share-rejected', [p1, p2, p3, p4]);
      ok([b1, b2, b3, b4].every((m) => isChatMsg(m) && m.text === 'маячок-после-share-rejected'),
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
    await p5.next(); // chat-history

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
      await peer.next(); // chat-history
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
    await peer.next(); // chat-history
    peer.ws.close();
    await peer.closed;

    await sleep(500); // меньше TTL (2с)
    const { peer: reJoinPeer, joined: reJoined } = await join(ttlRoomId);
    ok(reJoined.type === 'joined', 'вход в опустевшую, но ещё живую комнату (< TTL) успешен');
    await reJoinPeer.next(); // chat-history
    reJoinPeer.ws.close();
    await reJoinPeer.closed;

    await sleep(3000); // больше TTL (2с) + запас на тик реапера
    const late = await connect();
    late.send({ type: 'join-room', roomId: ttlRoomId });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'комната удалена реапером после истечения TTL пустоты');
  }
}

// --- main --------------------------------------------------------------

async function main() {
  buildServer();
  startServer();
  try {
    await waitForReady();
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
