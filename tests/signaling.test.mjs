// Интеграционный тест сигналинга + чата: гоняет полный жизненный цикл комнаты
// против САМОСТОЯТЕЛЬНО поднятого сервера (собирает cargo build, запускает
// ./target/debug/screenshare на порту 3311 с временной SQLite-БД и гарантированно
// прибирает за собой). Чистый Node >= 22, глобальный WebSocket/fetch, без npm.
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
  // --- 1. Комната не найдена ---
  console.log('1. join несуществующей комнаты');
  {
    const v = await connect();
    v.send({ type: 'join-room', roomId: 'nope1234', role: 'viewer' });
    const m = await v.next();
    ok(m.type === 'room-not-found', 'получен room-not-found');
    await v.closed;
    ok(true, 'сервер закрыл сокет');
  }

  // --- 1b. create-room с опциональным name (проверяем оба варианта вызова) ---
  console.log('1b. create-room: старый вызов без name и новый с name');
  {
    const bNamed = await connect();
    bNamed.send({ type: 'create-room', name: 'Вещающий Вова' });
    const createdNamed = await bNamed.next();
    ok(createdNamed.type === 'room-created' && createdNamed.roomId && createdNamed.peerId,
      'create-room с name тоже создаёт комнату');
    bNamed.ws.close();
    await bNamed.closed;
  }

  // --- 2. Создание комнаты (старый вызов БЕЗ name), вход зрителя, offer/answer/ICE ---
  console.log('2. полный цикл сигналинга');
  const b = await connect();
  b.send({ type: 'create-room' }); // старый вызов без name — должен работать как раньше
  const created = await b.next();
  ok(created.type === 'room-created' && created.roomId && created.peerId, `room-created (roomId=${created.roomId})`);
  ok(/^[23456789a-z]{8}$/.test(created.roomId), 'roomId короткий и человекочитаемый');

  const v1 = await connect();
  v1.send({ type: 'join-room', roomId: created.roomId, role: 'viewer' }); // тоже без name
  const joined = await v1.next();
  ok(joined.type === 'joined' && joined.broadcasterId === created.peerId && joined.viewerCount === 1, 'joined с broadcasterId и viewerCount=1');

  const v1History0 = await v1.next();
  ok(v1History0.type === 'chat-history' && Array.isArray(v1History0.messages) && v1History0.messages.length === 0,
    'первый зритель получил пустую chat-history сразу после joined');

  const pj = await b.next();
  ok(pj.type === 'peer-joined' && pj.peerId === joined.peerId && pj.name === null,
    'broadcaster получил peer-joined (зритель без имени -> name null)');

  b.send({ type: 'offer', targetPeerId: joined.peerId, sdp: { type: 'offer', sdp: 'v=0 fake' } });
  const off = await v1.next();
  ok(off.type === 'offer' && off.fromPeerId === created.peerId && off.sdp.sdp === 'v=0 fake', 'viewer получил offer с fromPeerId');

  v1.send({ type: 'answer', targetPeerId: created.peerId, sdp: { type: 'answer', sdp: 'v=0 fake2' } });
  const ans = await b.next();
  ok(ans.type === 'answer' && ans.fromPeerId === joined.peerId, 'broadcaster получил answer');

  b.send({ type: 'ice-candidate', targetPeerId: joined.peerId, candidate: { candidate: 'candidate:1', sdpMid: '0' } });
  const ice = await v1.next();
  ok(ice.type === 'ice-candidate' && ice.fromPeerId === created.peerId && ice.candidate.sdpMid === '0', 'ICE дошёл до viewer');

  // Релей на несуществующий peerId — тихо игнорируется, соединение живо.
  b.send({ type: 'ice-candidate', targetPeerId: 'ghost', candidate: {} });

  // --- 3. Чат: базовая доставка всем участникам, включая отправителя ---
  console.log('3. чат: базовая доставка');
  {
    const [selfMsg, bMsg] = await sendChatAndDrain(v1, 'Привет из зрителя', [v1, b]);
    ok(isChatMsg(selfMsg) && selfMsg.fromPeerId === joined.peerId && selfMsg.name === null && selfMsg.text === 'Привет из зрителя',
      'chat от зрителя приходит самому отправителю (fromPeerId, name, ts)');
    ok(isChatMsg(bMsg) && bMsg.fromPeerId === joined.peerId && bMsg.text === 'Привет из зрителя',
      'chat от зрителя приходит вещающему');
  }
  {
    const [vMsg, selfMsg] = await sendChatAndDrain(b, 'Привет от вещающего', [v1, b]);
    ok(isChatMsg(vMsg) && vMsg.fromPeerId === created.peerId && vMsg.text === 'Привет от вещающего',
      'chat от вещающего приходит зрителю');
    ok(isChatMsg(selfMsg) && selfMsg.fromPeerId === created.peerId,
      'chat от вещающего приходит и самому вещающему (единый путь рендера)');
  }

  // --- 3b. Невалидный чат: пустой текст и слишком длинный ---
  console.log('3b. чат: валидация текста');
  {
    v1.send({ type: 'chat', text: '' });
    const m = await v1.next();
    ok(m.type === 'error', `пустой text -> error (${m.message})`);
  }
  {
    v1.send({ type: 'chat', text: 'a'.repeat(2001) });
    const m = await v1.next();
    ok(m.type === 'error', `текст 2001 символ -> error (${m.message})`);
  }

  // --- 4. Второй зритель (с именем): накопленная chat-history + имя в чате ---
  console.log('4. второй зритель: chat-history + имя из join-room');
  const vRate = await connect();
  vRate.send({ type: 'join-room', roomId: created.roomId, role: 'viewer', name: 'Аня' });
  const joined2 = await vRate.next();
  ok(joined2.type === 'joined' && joined2.viewerCount === 2, 'второй зритель вошёл (viewerCount=2)');
  const pj2 = await b.next(); // peer-joined броадкастеру
  ok(pj2.type === 'peer-joined' && pj2.peerId === joined2.peerId && pj2.name === 'Аня',
    'broadcaster получил peer-joined с именем зрителя (Аня)');

  const hist2 = await vRate.next();
  ok(hist2.type === 'chat-history' && Array.isArray(hist2.messages) && hist2.messages.length === 2,
    'второй зритель получил накопленную chat-history (2 сообщения)');
  ok(
    hist2.messages[0].fromPeerId === joined.peerId && hist2.messages[0].text === 'Привет из зрителя'
    && hist2.messages[1].fromPeerId === created.peerId && hist2.messages[1].text === 'Привет от вещающего',
    'chat-history в хронологическом порядке (сначала сообщение зрителя, потом вещающего)',
  );

  {
    const [selfMsg, v1Msg, bMsg] = await sendChatAndDrain(vRate, 'Привет, я Аня', [vRate, v1, b]);
    ok(selfMsg.name === 'Аня' && v1Msg.name === 'Аня' && bMsg.name === 'Аня',
      'name из join-room попадает в поле name чата');
  }

  // --- 4b. Rate-limit: не более 10 сообщений за окно, 11-е -> error, не доставляется другим ---
  console.log('4b. чат: rate-limit');
  {
    // vRate уже отправил одно валидное сообщение выше — досылаем ещё 9, итого 10 в окне.
    for (let i = 0; i < 9; i++) {
      await sendChatAndDrain(vRate, `сообщение ${i}`, [vRate, v1, b]);
    }
    // 11-е сообщение в окне -> error самому отправителю.
    vRate.send({ type: 'chat', text: 'одиннадцатое' });
    const errMsg = await vRate.next();
    ok(errMsg.type === 'error', `11-е сообщение за окно -> error (${errMsg.message})`);

    // Доказываем, что 11-е сообщение НЕ было разослано другим: следующим
    // сообщением у v1, b и самого vRate должен прийти заведомо другой "маячок"
    // (а не просочившееся 11-е). Обязательно дренируем ВСЕХ участников комнаты,
    // включая vRate — иначе в его очереди останется непрочитанное сообщение.
    const [v1Next, bNext, vRateNext] = await sendChatAndDrain(v1, 'маячок-после-rate-limit', [v1, b, vRate]);
    ok(v1Next.text === 'маячок-после-rate-limit' && bNext.text === 'маячок-после-rate-limit'
      && vRateNext.text === 'маячок-после-rate-limit',
      'сообщение, срезанное rate-limit, не доставлено другим участникам');
  }

  // --- 5. Лимит 5 зрителей: ещё 3 входят (заполняя комнату), 6-й получает room-full ---
  console.log('5. лимит 5 зрителей');
  const extras = [];
  let viewerCount = 2; // v1 + vRate уже внутри
  for (let i = 0; i < 3; i++) {
    const v = await connect();
    v.send({ type: 'join-room', roomId: created.roomId, role: 'viewer' });
    const j = await v.next();
    viewerCount += 1;
    ok(j.type === 'joined' && j.viewerCount === viewerCount, `зритель №${viewerCount} вошёл (viewerCount=${j.viewerCount})`);
    await b.next(); // peer-joined броадкастеру
    const h = await v.next();
    ok(h.type === 'chat-history', `зритель №${viewerCount} получил chat-history`);
    extras.push(v);
  }
  {
    const v6 = await connect();
    v6.send({ type: 'join-room', roomId: created.roomId, role: 'viewer' });
    const m = await v6.next();
    ok(m.type === 'room-full', '6-й зритель получил room-full');
    await v6.closed;
    ok(true, 'сокет 6-го закрыт сервером');
  }

  // --- 6. Чужая роль: второй "broadcaster" не может занять комнату ---
  console.log('6. чужая роль');
  {
    const impostor = await connect();
    impostor.send({ type: 'join-room', roomId: created.roomId, role: 'broadcaster' });
    const m = await impostor.next();
    ok(m.type === 'error', `отказ второму вещающему (${m.message})`);
    impostor.ws.close();
  }

  // --- 6b. После переполнения комнаты чат остальных продолжает работать ---
  console.log('6b. чат после room-full');
  {
    const allViewers = [v1, vRate, ...extras];
    const results = await sendChatAndDrain(b, 'чат жив после room-full', [b, ...allViewers]);
    ok(results.every((m) => isChatMsg(m) && m.text === 'чат жив после room-full'),
      'чат продолжает доставляться всем участникам после отказа 6-му зрителю');
  }

  // --- 6c. Релей stream-info (аудио-хаб): обе стороны с fromPeerId, тихий
  // игнор неизвестного peerId и чужой комнаты, соединение и чат живы дальше ---
  console.log('6c. stream-info: релей и игнор');
  {
    // Зритель -> вещающий.
    v1.send({
      type: 'stream-info',
      targetPeerId: created.peerId,
      info: { s1: { peerId: joined.peerId, name: null } },
    });
    const toB = await b.next();
    ok(
      toB.type === 'stream-info' && toB.fromPeerId === joined.peerId
      && toB.info.s1 && toB.info.s1.peerId === joined.peerId && toB.info.s1.name === null,
      'stream-info от зрителя доходит до вещающего с fromPeerId',
    );

    // Вещающий -> зритель (обычный случай: рассылка карты streamId -> {peerId, name}).
    b.send({
      type: 'stream-info',
      targetPeerId: joined.peerId,
      info: { s2: { peerId: 'kто-то-другой', name: 'Вася' } },
    });
    const toV1 = await v1.next();
    ok(
      toV1.type === 'stream-info' && toV1.fromPeerId === created.peerId
      && toV1.info.s2 && toV1.info.s2.name === 'Вася',
      'stream-info от вещающего доходит до зрителя с fromPeerId',
    );

    // Неизвестный peerId в своей же комнате — тихий игнор.
    b.send({ type: 'stream-info', targetPeerId: 'ghost-peer-id', info: { s3: {} } });

    // Чужая комната: создаём независимую вторую комнату, тут же закрываем её
    // (peerId точно не существует нигде), и пробуем достучаться до её
    // broadcaster'а из первой комнаты — relay() ищет цель только среди
    // участников комнаты ОТПРАВИТЕЛЯ, так что это тоже тихий игнор.
    const b2 = await connect();
    b2.send({ type: 'create-room' });
    const created2 = await b2.next();
    b2.ws.close();
    await b2.closed;
    b.send({ type: 'stream-info', targetPeerId: created2.peerId, info: { s4: {} } });

    // Оба игнора не должны были сломать сокет или чат: следующим сообщением
    // ВСЕМ участникам комнаты (иначе непрочитанный маячок зависнет в очереди
    // vRate/extras и собьёт следующие проверки peer-left/broadcaster-left)
    // должен дойти маячок, а не утечка одного из stream-info.
    const allRecipients = [b, v1, vRate, ...extras];
    const results = await sendChatAndDrain(b, 'маячок-после-stream-info', allRecipients);
    ok(
      results.every((m) => isChatMsg(m) && m.text === 'маячок-после-stream-info'),
      'после игнорируемых stream-info сокет и чат продолжают работать штатно',
    );
  }

  // --- 7. Уход зрителя -> peer-left ---
  console.log('7. уход зрителя');
  v1.ws.close();
  const pl = await b.next();
  ok(pl.type === 'peer-left' && pl.peerId === joined.peerId, 'broadcaster получил peer-left');

  // --- 8. Уход вещающего -> broadcaster-left всем, комната удалена ---
  console.log('8. уход вещающего');
  b.ws.close();
  const remainingViewers = [vRate, ...extras];
  for (const [idx, v] of remainingViewers.entries()) {
    const m = await v.next();
    ok(m.type === 'broadcaster-left', `оставшийся зритель №${idx + 1} получил broadcaster-left`);
    v.ws.close();
  }
  {
    const late = await connect();
    late.send({ type: 'join-room', roomId: created.roomId, role: 'viewer' });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'комната удалена после ухода вещающего');
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
