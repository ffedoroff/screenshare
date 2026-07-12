// tests/e2e/helpers.mjs — переиспользуемое между *.spec.mjs: мини-раннер
// step/skip, сборка/запуск/остановка сервера (порт параметром), стабы
// getDisplayMedia/getUserMedia, чат-хелперы, ожидание ухода оверлея, флаги
// запуска Chrome. Выделено из basic.spec.mjs (см. историю решений там же —
// заголовок файла объясняет, почему стабы и waitForFunction именно такие).
//
// Ничего из static/*.js этот файл не трогает и не подменяет — только
// тестовый арнесс со стороны страницы (addInitScript) и драйвер сервера.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import nodeCrypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const BINARY_PATH = path.join(REPO_ROOT, 'target/debug/screenshare');

// --- Ш1 (E2E-шифрование, см. static/crypto.js): ключ комнаты в тестах ---
//
// Ключ комнаты `k` — чисто клиентский секрет (см. static/landing.js): в
// реальном приложении его генерирует браузер при клике «Создать комнату» и
// сервер о нём никогда не узнаёт. Когда сценарий заводит комнату НАПРЯМУЮ
// через `POST /api/rooms` (в обход лендинга — так делает большинство
// сценариев ниже, чтобы не гонять реальный клик по кнопке ради каждой новой
// комнаты), ключ точно так же должен появиться на стороне теста — сервер
// его не выдаст. `generateRoomKeyBase64url` — тот же формат, что и
// `RoomCrypto.generateRoomKey()+bytesToBase64url()` (32 случайных байта,
// base64url без паддинга — `Buffer.toString('base64url')` в Node даёт
// побайтово то же самое).

/** Случайный ключ комнаты для тестового сценария, создающего комнату напрямую через POST /api/rooms (см. заголовок раздела выше). */
export function generateRoomKeyBase64url() {
  return nodeCrypto.randomBytes(32).toString('base64url');
}

/** Ссылка гостя: `<baseUrl>/r/<roomId>#k=<key>` — без leaderToken (гость лидером не становится). */
export function roomUrlWithKey(baseUrl, roomId, key) {
  return `${baseUrl}/r/${roomId}#k=${key}`;
}

/** Ссылка создателя: `<baseUrl>/r/<roomId>#lt=<token>&k=<key>` — предъявляет leaderToken, становится лидером. */
export function leaderUrlWithKey(baseUrl, roomId, leaderToken, key) {
  return `${baseUrl}/r/${roomId}#lt=${encodeURIComponent(leaderToken)}&k=${key}`;
}

/**
 * Прочитать ключ комнаты (base64url) со СТРАНИЦЫ уже вошедшего участника —
 * top-level `const roomKeyBase64url` в static/room.js, тот же приём, что и
 * чтение `leaderId`/`myPeerId`/`roomSettings`/`bus` в существующих тестах
 * (обычный classic-script top-level scope, не модуль). Нужен там, где
 * комната заведена через реальный лендинг (ключ сгенерировал сам браузер,
 * тест его заранее не знает) — см. basic.spec.mjs, сценарий создания
 * комнаты кликом.
 */
export async function getRoomKeyFromPage(page) {
  return page.evaluate(() => roomKeyBase64url);
}

// Сколько ждём реальный getDisplayMedia в broadcaster-контексте, прежде чем
// откатиться на синтетический источник (см. installCaptureStub).
export const REAL_CAPTURE_TIMEOUT_MS = 10_000;

// Сколько ждём реальный getUserMedia(audio) у зрителя, прежде чем откатиться
// на синтетический источник (см. installMicStub).
export const REAL_MIC_TIMEOUT_MS = 5_000;

// Сколько ждём реальный getUserMedia(video) (камера), прежде чем откатиться
// на синтетический источник (см. installCamStub).
export const REAL_CAM_TIMEOUT_MS = 5_000;

export const CAPTURE_FLAGS = [
  '--auto-select-desktop-capture-source=Entire screen',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

// --- Мини-раннер: ok/FAIL построчно, без внешнего test-runner'а ---
//
// Каждый *.spec.mjs вызывает createRunner() один раз и получает свой
// изолированный счётчик (важно: два спека в одном процессе не делили бы
// счётчики иначе — на практике спеки и так отдельные процессы, но
// изоляция дешёвая и не создаёт скрытых предположений).
export function createRunner() {
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  async function step(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
      passedCount++;
      return true;
    } catch (err) {
      console.log(`FAIL - ${name}: ${err && err.message ? err.message : err}`);
      failedCount++;
      return false;
    }
  }

  function skip(name, reason) {
    console.log(`skip - ${name}: ${reason}`);
    skippedCount++;
  }

  function printSummary() {
    console.log('');
    console.log(`# итого: ok=${passedCount} FAIL=${failedCount} skip=${skippedCount}`);
  }

  function bumpFailedForUnexpectedError() {
    failedCount++;
  }

  return {
    step,
    skip,
    printSummary,
    bumpFailedForUnexpectedError,
    get counts() {
      return { passedCount, failedCount, skippedCount };
    },
  };
}

// --- Сервер: сборка, запуск, ожидание готовности, гарантированное убийство ---

export async function buildServer() {
  console.log('# cargo build...');
  execFileSync('cargo', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(BINARY_PATH)) {
    throw new Error(`бинарь не найден после сборки: ${BINARY_PATH}`);
  }
}

// Возвращает контроллер сервера на конкретном порту: { baseUrl, start(), stop() }.
// Инкапсулирует свой process/tmp-dir — можно поднимать несколько независимых
// серверов в одном файле (не требуется сейчас, но не создаёт скрытого
// глобального состояния).
//
// `extraEnv` — дополнительные переменные окружения сервера (например,
// EMPTY_ROOM_TTL_SECONDS для resilience.spec.mjs, сценарий с TTL пустой
// комнаты) — необязательный второй параметр, не ломает существующие вызовы
// с одним аргументом (basic.spec.mjs).
export function createServerController(port, extraEnv = {}) {
  const baseUrl = `http://localhost:${port}`;
  let serverProcess = null;

  async function start() {
    serverProcess = spawn(BINARY_PATH, [], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLog = '';
    serverProcess.stdout.on('data', (d) => { serverLog += d.toString(); });
    serverProcess.stderr.on('data', (d) => { serverLog += d.toString(); });
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.log(`# сервер неожиданно завершился (code=${code}, signal=${signal})`);
        console.log(serverLog);
      }
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/`);
        if (res.ok) return;
      } catch {
        // сервер ещё не поднялся — подождём и попробуем снова
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`сервер не ответил на ${baseUrl}/ за 10с. Лог:\n${serverLog}`);
  }

  async function stop() {
    if (!serverProcess) return;
    await new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      serverProcess.once('exit', done);
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!resolved) {
          serverProcess.kill('SIGKILL');
          done();
        }
      }, 3000);
    });
    serverProcess = null;
  }

  return { baseUrl, start, stop };
}

// --- Синтетический источник видео для случая, когда реальный getDisplayMedia
//     недоступен. Ставится ДО загрузки любых скриптов страницы через
//     addInitScript — static/broadcaster.js не трогаем. ---
//
// ВАЖНО (выяснено диагностикой флейка mic-ренегоциации): попытка реального
// getDisplayMedia, чей промис на этой машине никогда не резолвится, не просто
// стоит 10 секунд на старте — зависший desktop-capture-запрос остаётся жить в
// медиастеке Chrome и потом задерживает обработку последующих медиа-операций
// той же страницы (ответ вещающего на mic-offer зрителя приходил ровно через
// REAL_CAPTURE_TIMEOUT_MS после offer'а). Поэтому по умолчанию идём сразу в
// синтетику; попытка реального захвата — только по E2E_TRY_REAL_CAPTURE=1.
export function installCaptureStub() {
  return ({ tryReal, timeoutMs }) => {
    const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia
      ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      if (tryReal && realGetDisplayMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-capture-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(realGetDisplayMedia(constraints), timeoutMs);
          window.__e2eCaptureSource = 'real';
          return stream;
        } catch (err) {
          console.warn('[e2e] реальный getDisplayMedia не сработал за отведённое время, откат на синтетический источник:', err);
        }
      }

      window.__e2eCaptureSource = 'synthetic';
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      let hue = 0;
      const draw = () => {
        hue = (hue + 3) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '20px sans-serif';
        ctx.fillText(String(Date.now()), 10, 30);
        window.__e2eSyntheticFrame = requestAnimationFrame(draw);
      };
      draw();
      return canvas.captureStream(30);
    };
  };
}

// --- Синтетический источник аудио для микрофона зрителя ---
//
// На этой машине getUserMedia(audio) зависает навсегда даже при выданном
// разрешении (permissions.query -> 'granted') — подменяем на осциллятор Web
// Audio API -> MediaStreamAudioDestinationNode, полноценный live-трек, не
// трогающий реальное аудио-железо. static/viewer.js не меняется — как обычно
// вызывает getUserMedia({ audio: true }).
//
// ВАЖНО: «сначала реальный getUserMedia с Promise.race + setTimeout»
// ненадёжно — страница зрителя к моменту клика по микрофону может быть
// фоновой, а Chrome троттлит таймеры фоновых страниц, поэтому фолбэк
// срабатывал через десятки секунд и тест мигал. По умолчанию — сразу
// синтетика; реальный захват — E2E_TRY_REAL_MIC=1.
export function installMicStub() {
  return ({ tryReal, timeoutMs }) => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (tryReal && realGetUserMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-mic-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(realGetUserMedia(constraints), timeoutMs);
          window.__e2eMicSource = 'real';
          // Нормализация громкости: фейковое аудиоустройство Chrome
          // (--use-fake-device-for-media-stream) выдаёт очень тихий тон —
          // RMS ~0.010–0.019, аккурат на границе продуктового порога
          // детектора «кто говорит» (0.02), из-за чего проверка индикатора
          // флейкала. Прогоняем трек через GainNode ×6: тестируется тот же
          // реальный путь getUserMedia (разрешения, устройство), но громкость
          // становится детерминированно «речевой». Порог продукта под тест
          // не подгоняем принципиально.
          const boostCtx = new (window.AudioContext || window.webkitAudioContext)();
          const boostSrc = boostCtx.createMediaStreamSource(stream);
          const gain = boostCtx.createGain();
          gain.gain.value = 6;
          const boostDst = boostCtx.createMediaStreamDestination();
          boostSrc.connect(gain);
          gain.connect(boostDst);
          return boostDst.stream;
        } catch (err) {
          console.warn('[e2e] реальный getUserMedia(audio) не сработал за отведённое время, откат на синтетический источник:', err);
        }
      }

      window.__e2eMicSource = 'synthetic';
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCtor();
      const oscillator = audioCtx.createOscillator();
      oscillator.frequency.value = 440;
      const destination = audioCtx.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  };
}

// --- Синтетический источник видео для камеры участника (протокол v2: room.js) ---
//
// room.js вызывает getUserMedia({ video: {...} }) для камеры и отдельно
// getUserMedia({ audio: true }) для микрофона — оба через один и тот же
// navigator.mediaDevices.getUserMedia. Чтобы стабы камеры и микрофона могли
// сосуществовать на одной странице, этот стаб проверяет constraints сам:
// запрос без constraints.video прозрачно делегируется в ту функцию
// getUserMedia, что была установлена ДО него (обычно installMicStub) — важен
// порядок установки в addInitScript: сначала installMicStub, потом
// installCamStub (иначе делегирование пойдёт не туда). Запрос с
// constraints.video обрабатывается этим стабом: как и installCaptureStub,
// сперва (по флагу) пробует реальный getUserMedia с таймаутом, иначе сразу
// синтетический canvas.captureStream() — той же логике, что и у камеры.
export function installCamStub() {
  return ({ tryReal, timeoutMs }) => {
    const previousGetUserMedia = navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const wantsVideo = !!(constraints && constraints.video);
      if (!wantsVideo) {
        if (previousGetUserMedia) return previousGetUserMedia(constraints);
        throw new Error('getUserMedia недоступен (нет ни реального, ни предыдущего стаба)');
      }

      if (tryReal && previousGetUserMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-cam-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(previousGetUserMedia(constraints), timeoutMs);
          window.__e2eCamSource = 'real';
          return stream;
        } catch (err) {
          console.warn('[e2e] реальный getUserMedia(video) не сработал за отведённое время, откат на синтетический источник:', err);
        }
      }

      window.__e2eCamSource = 'synthetic';
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      let hue = 120;
      const draw = () => {
        hue = (hue + 2) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 45%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px sans-serif';
        ctx.fillText(String(Date.now()), 10, 30);
        window.__e2eCamFrame = requestAnimationFrame(draw);
      };
      draw();
      return canvas.captureStream(30);
    };
  };
}

// --- Модалка входа (анонимность — см. static/room.js) ---
//
// Никакого localStorage больше нет: имя вводится в модалке «Присоединиться»
// при КАЖДОМ заходе в комнату (первый вход и любой page.reload() — реконнект
// после обрыва сигналинга БЕЗ перезагрузки страницы модалку повторно не
// показывает, см. static/room.js). Эта функция — единая точка входа для
// ВСЕХ сценариев теста: дождаться модалки, (опционально) ввести имя, кликнуть
// «Войти». Создатель комнаты тоже проходит через неё — лендинг больше не
// спрашивает имя, только создаёт комнату и редиректит на /r/<id>#lt=<token>.
export async function joinRoom(page, name) {
  await page.waitForSelector('#join-modal:not(.hidden)', { timeout: 10_000 });
  if (name) {
    await page.fill('#join-name-input', name);
  }
  await page.click('#join-modal-button');
}

// --- Ш1 (E2E-шифрование): шпион на ВСЕ фреймы серверного WebSocket ---
//
// Тот же приём, что и installChatWsSpy/installPcRegistry (см. basic.spec.mjs)
// — оборачивает window.WebSocket до первой навигации (addInitScript). В
// отличие от installChatWsSpy (там интересен только `type==='chat'`) этот
// шпион копит АБСОЛЮТНО ВСЁ, что страница отправляет в сокет — нужен для
// проверок Ш1: и `join-room` (не должно быть плейнтекстового имени), и
// `offer`/`answer` (SDP должен быть уже зашифрованным блобом, а не текстом с
// "v=0"/fingerprint).
export function installSignalingFrameSpy(context) {
  return context.addInitScript(() => {
    window.__e2eAllFramesSent = [];
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(...args) {
        super(...args);
        const realSend = this.send.bind(this);
        this.send = (data) => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.type === 'string') {
              window.__e2eAllFramesSent.push(parsed);
            }
          } catch {
            // не строка/не JSON — точно не наш фрейм
          }
          return realSend(data);
        };
      }
    };
  });
}

export async function allFramesSentOn(page) {
  return page.evaluate(() => window.__e2eAllFramesSent || []);
}

/** Фреймы конкретного `type` из allFramesSentOn(page) — сокращение для частого фильтра. */
export async function framesOfTypeSentOn(page, type) {
  const frames = await allFramesSentOn(page);
  return frames.filter((f) => f && f.type === type);
}

/** Оверлей «Ссылка неполная» (Ш1: нет валидного `k`, либо ключ неверен — см. static/room.js: showInvalidLinkOverlay). */
export async function waitInvalidLinkOverlay(page, timeoutMs = 10_000) {
  await page.waitForFunction(
    () => document.getElementById('overlay-title')?.textContent === 'Ссылка неполная',
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

// --- Реестр RTCPeerConnection для ожидания реального "соединения устаканились" ---
//
// Ф0 (см. static/rtc.js): каждая пара заводит DataChannel-шину сразу при
// входе в комнату (createDataChannel у impolite-стороны, ondatachannel у
// polite), а не по клику пользователя — то есть SDP-негоциация для КАЖДОЙ
// пары стартует почти сразу после join, ещё до включения любой медиа. В
// процессе расследования одной hang-флакиности (см. историю: симметричный
// negotiated-канал с id=0 у обеих сторон иногда не триггерил
// onnegotiationneeded вовсе у одного из нескольких RTCPeerConnection,
// созданных на странице почти одновременно) был найден и устранён
// продуктовый баг — static/rtc.js теперь использует классическую
// одностороннюю схему (createDataChannel только у impolite,
// ondatachannel у polite), ту же, что уже была проверена для медиа-треков
// до Ф0. Реестр здесь и waitForAllConnectionsSettled/waitForMeshSettled
// ниже оставлены как недорогая страховка теста (ждать реального
// connectionState==='connected' надёжнее и быстрее, чем гадать с
// таймерами) — тестам basic.spec.mjs/resilience.spec.mjs это ничего не
// стоит, а вложенный ретрай на случай редкого ICE-затора (setOffline,
// перегруженный CI-раннер и т.п.) не помешает.
//
// installPcRegistry не трогает static/*.js — только оборачивает
// window.RTCPeerConnection в addInitScript, как и installChatWsSpy
// оборачивает WebSocket в basic.spec.mjs.
export function installPcRegistry(context) {
  return context.addInitScript(() => {
    window.__e2ePcs = [];
    const RealPC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends RealPC {
      constructor(...args) {
        super(...args);
        window.__e2ePcs.push(this);
      }
    };
  });
}

// Дождаться, пока на странице появится минимум `expectedCount` учтённых
// RTCPeerConnection и у ВСЕХ них connectionState === 'connected'. Требует
// installPcRegistry(context) до навигации.
export async function waitForAllConnectionsSettled(page, expectedCount, timeoutMs = 12000) {
  await page.waitForFunction(
    (n) => {
      const pcs = window.__e2ePcs || [];
      if (pcs.length < n) return false;
      return pcs.every((pc) => pc.connectionState === 'connected');
    },
    expectedCount,
    { polling: 100, timeout: timeoutMs }
  );
}

// --- Ожидание "mesh устаканился", со страховочным ретраем через перезаход ---
//
// Ждём тайлы и connectionState==='connected' у всех mesh-связей страницы.
// Обёрнуто в пару попыток с page.reload() между ними — недорогая страховка
// на случай единичного реального ICE-затора в CI/песочнице (сеть,
// перегруженный раннер), не связанная с конкретным багом протокола.
export async function waitForMeshSettled(pages, { tileCount, connectionsPerPage, attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      for (const page of pages) {
        await page.waitForFunction(
          (n) => document.querySelectorAll('.tile').length === n,
          tileCount,
          { polling: 100, timeout: 10_000 }
        );
      }
      for (const page of pages) {
        await waitForAllConnectionsSettled(page, connectionsPerPage);
      }
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(
        `[waitForMeshSettled] попытка ${attempt}/${attempts} не устаканилась (${err.message}) — перезаходим в комнату и пробуем снова`
      );
      for (const page of pages) {
        // page.reload() — полная перезагрузка (не авто-reconnect внутри
        // вкладки) — модалка входа появляется заново (анонимность, см.
        // static/room.js), имя заново не важно для этой страховки — просто
        // жмём «Войти» пустым именем, чтобы снова оказаться в комнате.
        await page.reload();
        await joinRoom(page);
        await waitForOverlayHidden(page);
      }
    }
  }
}

// --- Вспомогательные функции для страниц ---

// Дожидается реального просмотра потока у зрителя. Хром блокирует autoplay
// незамьюченного <video> без пользовательского взаимодействия со страницей —
// в этом случае viewer.js сам показывает кнопку «Нажмите, чтобы начать
// просмотр» (см. static/viewer.js: attemptPlay()). Это штатное поведение
// приложения, а не баг — поэтому тест эмулирует реального пользователя и
// кликает по кнопке, если она появилась, вместо того чтобы обходить это стороной.
// Важно: НЕ page.waitForSelector('#overlay.hidden') — по умолчанию он ждёт
// видимость совпавшего элемента, а элемент с классом .hidden как раз
// display:none (см. static/style.css), поэтому такой селектор никогда бы не
// срезолвился. Проверяем classList напрямую через waitForFunction.
export async function waitForOverlayHidden(page, timeoutMs = 20_000) {
  const isOverlayHidden = () => document.getElementById('overlay').classList.contains('hidden');
  const outcome = await Promise.race([
    page.waitForFunction(isOverlayHidden, undefined, { polling: 100, timeout: timeoutMs }).then(() => 'hidden'),
    page.waitForSelector('#play-button:not(.hidden)', { timeout: timeoutMs }).then(() => 'play-button'),
  ]);
  if (outcome === 'play-button') {
    await page.click('#play-button');
    await page.waitForFunction(isOverlayHidden, undefined, { polling: 100, timeout: 5000 });
  }
}

// Проверка, что видео реально идёт: videoWidth/readyState сразу, и
// currentTime растёт спустя waitMs. Используется и в basic.spec.mjs (сразу
// после подключения — и там, и в room.js-версии теста, для разных <video> —
// см. `selector`), и в resilience.spec.mjs (после reload, старый viewer.js
// с единственным #remote-video — поэтому `selector` по умолчанию именно им
// и остаётся, ради обратной совместимости).
export async function assertVideoPlaying(
  page,
  { selector = '#remote-video', waitMs = 2000, warmupTimeoutMs = 5000 } = {}
) {
  // videoWidth может на пару кадров отставать от момента, когда overlay уже
  // скрылся/трек подключён (синхронно, но декодирование первого кадра — нет)
  // — особенно заметно сразу после reload(), когда вся страница (и
  // WebRTC-стек) поднимается с нуля. Поэтому сначала дожидаемся первого
  // кадра поллингом, а не считаем videoWidth>0 сразу гарантированным.
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.videoWidth || 0) > 0,
    selector,
    { polling: 100, timeout: warmupTimeoutMs }
  );

  const before = await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { videoWidth: v.videoWidth, readyState: v.readyState, currentTime: v.currentTime };
  }, selector);
  assert.ok(before.videoWidth > 0, `videoWidth должен быть > 0, получено ${before.videoWidth}`);
  assert.ok(before.readyState >= 2, `readyState должен быть >= 2, получено ${before.readyState}`);

  await new Promise((r) => setTimeout(r, waitMs));

  const after = await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { currentTime: v.currentTime };
  }, selector);
  assert.ok(
    after.currentTime > before.currentTime,
    `currentTime должен вырасти за ${waitMs}мс: было ${before.currentTime}, стало ${after.currentTime}`
  );
}

export async function getChatDom(page) {
  return {
    toggleButton: page.locator('#chat-button'),
    unreadBadge: page.locator('.chat-unread-badge'),
    panel: page.locator('.chat-panel'),
    messages: page.locator('.chat-message-text'),
    textInput: page.locator('.chat-text-input'),
    sendButton: page.locator('.chat-send-button'),
    errorBanner: page.locator('.chat-error-banner'),
  };
}

// Идемпотентно: если панель уже открыта — просто убеждаемся, что она видима.
// Кнопка-тогглер (#chat-button в пилюле управления) всегда на месте и видима
// — в отличие от старой плавающей кнопки, теперь она не прячется, пока чат
// открыт, а просто переключает open/closed (см. chat.js: toggleButton click).
export async function openChatPanel(page) {
  const chat = await getChatDom(page);
  const alreadyOpen = await chat.panel.evaluate((el) => !el.classList.contains('hidden'));
  if (!alreadyOpen) {
    await chat.toggleButton.click();
  }
  await chat.panel.waitFor({ state: 'visible' });
}

export async function sendChatMessage(page, text) {
  const chat = await getChatDom(page);
  await chat.textInput.fill(text);
  await chat.sendButton.click();
}

export async function messageTextsInclude(page, text, timeoutMs = 5000) {
  const chat = await getChatDom(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = await chat.messages.allTextContents();
    if (texts.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Отправить текстовое сообщение и вернуть его сгенерированный id (см.
 * chat.js: dataset.msgId на .chat-message) — нужно, когда дальше по тесту
 * сообщение будут редактировать/удалять и его ТЕКСТ перестанет быть
 * стабильным якорем для поиска элемента (в отличие от id, который не
 * меняется). Id общий для всех участников (один и тот же конверт), поэтому
 * им же можно искать `.chat-message[data-msg-id="..."]` и на других страницах.
 */
export async function sendChatMessageAndGetId(page, text) {
  await sendChatMessage(page, text);
  const id = await page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll('.chat-message--own'));
    for (let i = items.length - 1; i >= 0; i--) {
      const textEl = items[i].querySelector('.chat-message-text');
      if (textEl && textEl.textContent === t) return items[i].dataset.msgId;
    }
    return null;
  }, text);
  return id;
}

// --- Передача файлов (Ф3): генерация тестовых файлов и хелпер вброса ---
//
// PNG собирается вручную (сигнатура + IHDR + один IDAT со случайными
// пикселями, сжатыми zlib.deflateSync, + IEND) — так тест не тянет
// сторонних зависимостей (canvas/pngjs) и не гадает с browser-side
// canvas.toBlob(). Пиксели случайны намеренно: PNG со случайным шумом почти
// не сжимается, поэтому итоговый размер файла предсказуемо близок к сырому
// (ширина×высота×4 + служебные байты строк), а не схлопывается в
// несколько байт, как было бы с однотонной заливкой.

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Валидный PNG (RGBA, 8 бит) заданных размеров со случайными пикселями — размер файла ~width*height*4 байт. */
export function makeTestPngBuffer({ width = 112, height = 112 } = {}) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: None
    for (let x = 0; x < width * 4; x++) {
      raw[offset++] = Math.floor(Math.random() * 256);
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Текстовый "файл" заданного размера (повторяющаяся ASCII-фраза) — для проверки передачи произвольного (не картиночного) файла. */
export function makeTestTextFileBuffer(sizeBytes) {
  const phrase = Buffer.from('The quick brown fox jumps over the lazy dog. ', 'ascii');
  const buf = Buffer.alloc(sizeBytes);
  let pos = 0;
  while (pos < sizeBytes) {
    const n = Math.min(phrase.length, sizeBytes - pos);
    phrase.copy(buf, pos, 0, n);
    pos += n;
  }
  return buf;
}

/**
 * Вбросить файлы в чат через скрытый `<input type=file>` скрепки (см.
 * static/chat.js: buildDom -> .chat-file-input). setInputFiles не требует
 * видимости элемента (в отличие от click) — работает даже пока сам инпут
 * `hidden`, поэтому не обязательно предварительно открывать панель, хотя в
 * тестах мы всё равно открываем её для остальных проверок по соседству.
 * `files` — массив { name, mimeType, buffer } (см. Playwright FilePayload).
 */
export async function attachFilesToChat(page, files) {
  await page.locator('.chat-file-input').setInputFiles(files);
}

export async function unreadBadgeCount(page) {
  const chat = await getChatDom(page);
  const hidden = await chat.unreadBadge.evaluate((el) => el.classList.contains('hidden'));
  if (hidden) return 0;
  const text = await chat.unreadBadge.textContent();
  return Number(text);
}

// --- Наблюдатель за счётчиком зрителей у вещающего (#viewer-count) ---
//
// MutationObserver фиксирует КАЖДОЕ изменение textContent синхронно
// (микротаска на мутацию), в отличие от поллинга с интервалом — не пропустит
// короткий "провал" счётчика (например, 1 -> 0 -> 1 при переподключении
// зрителя), даже если сама просадка длится миллисекунды. Устанавливается
// один раз (после появления #live-section, элемент уже существует).
export async function installViewerCountHistory(broadcasterPage) {
  await broadcasterPage.evaluate(() => {
    const el = document.getElementById('viewer-count');
    if (!window.__viewerCountHistory) {
      window.__viewerCountHistory = [el.textContent];
      new MutationObserver(() => {
        window.__viewerCountHistory.push(el.textContent);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
}

export async function viewerCountHistoryLength(broadcasterPage) {
  return broadcasterPage.evaluate(() => (window.__viewerCountHistory || []).length);
}

export async function viewerCountHistorySince(broadcasterPage, fromIndex) {
  return broadcasterPage.evaluate(
    (i) => (window.__viewerCountHistory || []).slice(i),
    fromIndex
  );
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Поллинг произвольного условия с дедлайном — используется там, где
// page.waitForFunction не подходит (например, условие зависит от нескольких
// страниц/значений сразу). Никогда не спит "вслепую" фиксированное время —
// всегда проверяет условие и завершается досрочно, как только оно выполнено.
export async function waitUntil(conditionFn, { timeoutMs = 10_000, intervalMs = 150, message = 'условие не выполнилось' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() >= deadline) throw new Error(`${message} (таймаут ${timeoutMs}мс)`);
    await sleep(intervalMs);
  }
}
