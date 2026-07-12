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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const BINARY_PATH = path.join(REPO_ROOT, 'target/debug/screenshare');

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

// Задать имя участника в localStorage (chat.js: NAME_STORAGE_KEY =
// 'screenshare-name') ДО загрузки скриптов страницы — addInitScript
// выполняется при каждой навигации (в т.ч. при page.reload()).
export function installSavedName(context, name) {
  return context.addInitScript((n) => {
    localStorage.setItem('screenshare-name', n);
  }, name);
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
