#!/usr/bin/env node
// tests/e2e/basic.spec.mjs — браузерный e2e-тест реального медиапотока и чата.
//
// Запуск: `node tests/e2e/basic.spec.mjs` (из каталога tests/e2e — предварительно
// `npm install`). Требуется установленный системный Chrome (playwright-core
// браузеры не скачивает, используется channel: 'chrome').
//
// Сценарий: собрать и поднять сервер на порту 3322 с временной SQLite,
// открыть вещающего (broadcaster) и двух зрителей (viewer) через настоящий
// Chrome, прогнать реальный WebRTC-поток видео и чат поверх реального
// сигналинга, закрыть вещающего и проверить, что зрители увидели завершение.
//
// Про диалог getDisplayMedia на macOS (важно, см. финальный отчёт агента):
// реальный захват экрана в headless/автоматизированном Chrome на macOS
// упирается не столько во флаги Chrome, сколько в системное разрешение
// «Screen Recording» (TCC), которое нельзя выдать неинтерактивно и которое
// в этой машине не выдано вообще ни одному процессу (проверено: пусто в
// TCC.db, и даже нативный `screencapture -x` в этой среде падает с
// «could not create image from display»). Из перепробованных комбинаций
// флагов ни одна не даёт стабильного результата: getDisplayMedia либо
// зависает навсегда (промис никогда не резолвится и не реджектится), либо
// изредка (замечено ~1 раз из 5+ попыток) успешно резолвится через ~15-20
// секунд — недостаточно стабильно для CI-теста. Список опробованных комбинаций:
//   1. --auto-select-desktop-capture-source="Entire screen" + --use-fake-ui-for-media-stream
//   2. --auto-select-desktop-capture-source="Entire screen" (без fake-ui)
//   3. --auto-select-desktop-capture-source="<точный заголовок вкладки>" + --use-fake-ui-for-media-stream
//      (попытка выбрать вкладку вместо экрана — не требует Screen Recording,
//      но пикер всё равно не отрабатывает без явного пользовательского клика
//      в системном UI)
//   4. --use-fake-ui-for-media-stream (без auto-select)
//   5. --auto-select-desktop-capture-source="Entire screen" + --use-fake-ui-for-media-stream
//      + --use-fake-device-for-media-stream
//
// Поэтому тест ведёт себя так:
//   - broadcaster-контекст запускается с комбинацией №5 (наиболее вероятная
//     из документации Chromium) и реальный getDisplayMedia пробуется первым,
//     с таймаутом REAL_CAPTURE_TIMEOUT_MS;
//   - если за это время реального потока нет — тестовый арнесс (не
//     static/broadcaster.js!) подменяет navigator.mediaDevices.getDisplayMedia
//     на синтетический источник (canvas.captureStream), чтобы не блокировать
//     остальную часть сценария (комната всё равно должна быть создана: без
//     неё нельзя проверить чат/счётчик зрителей/завершение трансляции).
//     Реальный код broadcaster.js/viewer.js/chat.js при этом не трогается.
//   - в выводе явно помечается, какой источник видео использовался; если
//     использовался синтетический — проверка «это НАСТОЯЩИЙ захват экрана»
//     помечается как skip, но проверки того, что видео реально идёт
//     (videoWidth/readyState/currentTime растёт) всё равно выполняются —
//     они валидны и для синтетического источника, т.к. проверяют настоящий
//     WebRTC-транспорt (SDP/ICE/media), а не происхождение пикселей.

import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PORT = 3322;
const BASE_URL = `http://localhost:${PORT}`;
const BINARY_PATH = path.join(REPO_ROOT, 'target/debug/screenshare');

// Сколько ждём реальный getDisplayMedia в broadcaster-контексте, прежде чем
// откатиться на синтетический источник (см. комментарий выше).
const REAL_CAPTURE_TIMEOUT_MS = 10_000;

const CAPTURE_FLAGS = [
  '--auto-select-desktop-capture-source=Entire screen',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

// --- Мини-раннер: ok/FAIL построчно, без внешнего test-runner'а ---

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

// --- Сервер: сборка, запуск, ожидание готовности, гарантированное убийство ---

let serverProcess = null;
let dbTmpDir = null;

async function buildServer() {
  console.log('# cargo build...');
  execFileSync('cargo', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(BINARY_PATH)) {
    throw new Error(`бинарь не найден после сборки: ${BINARY_PATH}`);
  }
}

async function startServer() {
  dbTmpDir = mkdtempSync(path.join(tmpdir(), 'screenshare-e2e-'));
  const dbPath = path.join(dbTmpDir, 'test.db');
  serverProcess = spawn(BINARY_PATH, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: `sqlite://${dbPath}?mode=rwc`,
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
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return;
    } catch {
      // сервер ещё не поднялся — подождём и попробуем снова
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`сервер не ответил на ${BASE_URL}/ за 10с. Лог:\n${serverLog}`);
}

async function stopServer() {
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
  if (dbTmpDir) {
    rmSync(dbTmpDir, { recursive: true, force: true });
    dbTmpDir = null;
  }
}

// --- Синтетический источник видео для случая, когда реальный getDisplayMedia
//     недоступен (см. комментарий в шапке файла). Ставится ДО загрузки любых
//     скриптов страницы через addInitScript — static/broadcaster.js не трогаем. ---

function installCaptureStub() {
  return (timeoutMs) => {
    const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia
      ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      if (realGetDisplayMedia) {
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
async function waitForOverlayHidden(page, timeoutMs = 20_000) {
  const isOverlayHidden = () => document.getElementById('overlay').classList.contains('hidden');
  const outcome = await Promise.race([
    page.waitForFunction(isOverlayHidden, { timeout: timeoutMs }).then(() => 'hidden'),
    page.waitForSelector('#play-button:not(.hidden)', { timeout: timeoutMs }).then(() => 'play-button'),
  ]);
  if (outcome === 'play-button') {
    await page.click('#play-button');
    await page.waitForFunction(isOverlayHidden, { timeout: 5000 });
  }
}

async function getChatDom(page) {
  return {
    toggleButton: page.locator('.chat-toggle-button'),
    unreadBadge: page.locator('.chat-unread-badge'),
    panel: page.locator('.chat-panel'),
    messages: page.locator('.chat-message-text'),
    textInput: page.locator('.chat-text-input'),
    sendButton: page.locator('.chat-send-button'),
  };
}

async function openChatPanel(page) {
  const chat = await getChatDom(page);
  await chat.toggleButton.click();
  await chat.panel.waitFor({ state: 'visible' });
}

async function sendChatMessage(page, text) {
  const chat = await getChatDom(page);
  await chat.textInput.fill(text);
  await chat.sendButton.click();
}

async function messageTextsInclude(page, text, timeoutMs = 5000) {
  const chat = await getChatDom(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = await chat.messages.allTextContents();
    if (texts.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function unreadBadgeCount(page) {
  const chat = await getChatDom(page);
  const hidden = await chat.unreadBadge.evaluate((el) => el.classList.contains('hidden'));
  if (hidden) return 0;
  const text = await chat.unreadBadge.textContent();
  return Number(text);
}

// --- Основной сценарий ---

async function main() {
  await buildServer();
  await startServer();

  let browser = null;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    // --- Вещающий ---
    const broadcasterContext = await browser.newContext();
    await broadcasterContext.addInitScript(installCaptureStub(), REAL_CAPTURE_TIMEOUT_MS);
    const broadcasterPage = await broadcasterContext.newPage();

    let roomId = null;
    let captureSource = 'unknown';

    const setupOk = await step('вещающий: открыть страницу и начать трансляцию', async () => {
      await broadcasterPage.goto(BASE_URL);
      await broadcasterPage.click('#start-button');
      await broadcasterPage.waitForSelector('#live-section:not(.hidden)', {
        timeout: REAL_CAPTURE_TIMEOUT_MS + 8_000,
      });
      const link = await broadcasterPage.inputValue('#room-link-input');
      const match = link.match(/\/room\/([^/]+)$/);
      assert.ok(match, `не удалось извлечь roomId из ссылки: ${link}`);
      roomId = match[1];
      captureSource = await broadcasterPage.evaluate(() => window.__e2eCaptureSource || 'unknown');
    });

    if (!setupOk || !roomId) {
      console.log('FAIL - критическая ошибка: не удалось создать комнату, дальнейшие проверки невозможны');
      skip('видео у зрителя №1', 'комната не создана');
      skip('видео у зрителя №2', 'комната не создана');
      skip('чат', 'комната не создана');
      skip('счётчик зрителей', 'комната не создана');
      skip('завершение трансляции', 'комната не создана');
      return;
    }

    if (captureSource === 'real') {
      console.log('# источник видео у вещающего: РЕАЛЬНЫЙ getDisplayMedia (флаги сработали)');
    } else {
      console.log(
        `# источник видео у вещающего: синтетический (canvas.captureStream) — ` +
        `реальный getDisplayMedia не отработал за ${REAL_CAPTURE_TIMEOUT_MS}мс, см. комментарий в шапке файла`
      );
      skip(
        'видео: настоящий захват экрана через getDisplayMedia',
        'ни одна из опробованных комбинаций флагов Chrome не дала стабильного результата на этой macOS-машине ' +
        '(нет системного разрешения Screen Recording, и его нельзя выдать неинтерактивно); ' +
        'используется синтетический источник на уровне тестового арнесса, проверки WebRTC-транспорта ниже всё равно выполняются'
      );
    }

    // --- Два зрителя ---
    const viewer1Context = await browser.newContext();
    const viewer2Context = await browser.newContext();
    const viewer1Page = await viewer1Context.newPage();
    const viewer2Page = await viewer2Context.newPage();

    const viewersJoinedOk = await step('оба зрителя: открыть комнату и дождаться исчезновения оверлея', async () => {
      await viewer1Page.goto(`${BASE_URL}/room/${roomId}`);
      await viewer2Page.goto(`${BASE_URL}/room/${roomId}`);
      await waitForOverlayHidden(viewer1Page);
      await waitForOverlayHidden(viewer2Page);
    });

    if (viewersJoinedOk) {
      for (const [label, page] of [['зритель №1', viewer1Page], ['зритель №2', viewer2Page]]) {
        await step(`видео реально идёт у ${label} (videoWidth/readyState/currentTime)`, async () => {
          const before = await page.evaluate(() => {
            const v = document.getElementById('remote-video');
            return { videoWidth: v.videoWidth, readyState: v.readyState, currentTime: v.currentTime };
          });
          assert.ok(before.videoWidth > 0, `videoWidth должен быть > 0, получено ${before.videoWidth}`);
          assert.ok(before.readyState >= 2, `readyState должен быть >= 2, получено ${before.readyState}`);

          await new Promise((r) => setTimeout(r, 2000));

          const after = await page.evaluate(() => {
            const v = document.getElementById('remote-video');
            return { currentTime: v.currentTime };
          });
          assert.ok(
            after.currentTime > before.currentTime,
            `currentTime должен вырасти за 2с: было ${before.currentTime}, стало ${after.currentTime}`
          );
        });
      }
    } else {
      skip('видео у зрителя №1', 'зрители не смогли подключиться к комнате');
      skip('видео у зрителя №2', 'зрители не смогли подключиться к комнате');
    }

    // --- Счётчик зрителей у вещающего ---
    if (viewersJoinedOk) {
      await step('счётчик зрителей у вещающего показывает 2', async () => {
        await broadcasterPage.waitForFunction(
          () => document.getElementById('viewer-count')?.textContent === '2',
          { timeout: 5000 }
        );
      });
    } else {
      skip('счётчик зрителей', 'зрители не подключились');
    }

    // --- Чат ---
    if (viewersJoinedOk) {
      await step('зритель №1 отправляет сообщение — видно у себя, у вещающего и у зрителя №2', async () => {
        await openChatPanel(viewer1Page);
        const text1 = `Привет от зрителя 1 — ${Date.now()}`;
        await sendChatMessage(viewer1Page, text1);

        // Сообщение не рендерится оптимистично на отправителе — оно приходит
        // обратно с сервера как обычный `chat` (сервер рассылает всем
        // участникам, включая отправителя), поэтому ждём его так же, как и
        // у остальных получателей, а не проверяем сразу после клика.
        assert.ok(await messageTextsInclude(viewer1Page, text1), 'сообщение не появилось у самого отправителя (зритель №1)');
        assert.ok(await messageTextsInclude(broadcasterPage, text1), 'сообщение не дошло до вещающего');
        assert.ok(await messageTextsInclude(viewer2Page, text1), 'сообщение не дошло до зрителя №2');

        // Панели вещающего и зрителя №2 свёрнуты по умолчанию (chat.js: attach()
        // вызывает setCollapsed(true)) — значит должен появиться бейдж непрочитанных.
        const broadcasterUnread = await unreadBadgeCount(broadcasterPage);
        assert.equal(broadcasterUnread, 1, `бейдж непрочитанных у вещающего должен быть 1, получено ${broadcasterUnread}`);
        const viewer2Unread = await unreadBadgeCount(viewer2Page);
        assert.equal(viewer2Unread, 1, `бейдж непрочитанных у зрителя №2 должен быть 1, получено ${viewer2Unread}`);
      });

      await step('вещающий отвечает — видно у обоих зрителей, бейдж растёт у свёрнутой панели', async () => {
        await openChatPanel(broadcasterPage); // открытие панели сбрасывает непрочитанные у вещающего
        const broadcasterUnreadAfterOpen = await unreadBadgeCount(broadcasterPage);
        assert.equal(broadcasterUnreadAfterOpen, 0, 'открытие панели должно сбросить бейдж непрочитанных');

        const text2 = `Привет от вещающего — ${Date.now()}`;
        await sendChatMessage(broadcasterPage, text2);

        assert.ok(await messageTextsInclude(broadcasterPage, text2), 'сообщение не появилось у самого отправителя (вещающий)');
        assert.ok(await messageTextsInclude(viewer1Page, text2), 'ответ не дошёл до зрителя №1 (панель открыта)');
        assert.ok(await messageTextsInclude(viewer2Page, text2), 'ответ не дошёл до зрителя №2 (панель свёрнута)');

        // У зрителя №2 панель всё ещё свёрнута — теперь там 2 непрочитанных
        // (первое сообщение зрителя №1 + это).
        const viewer2Unread = await unreadBadgeCount(viewer2Page);
        assert.equal(viewer2Unread, 2, `бейдж непрочитанных у зрителя №2 должен быть 2, получено ${viewer2Unread}`);
      });

      await step('открытие панели зрителем №2 сбрасывает бейдж и показывает оба сообщения', async () => {
        await openChatPanel(viewer2Page);
        const unread = await unreadBadgeCount(viewer2Page);
        assert.equal(unread, 0, 'бейдж должен сброситься после открытия панели');
        const texts = await (await getChatDom(viewer2Page)).messages.allTextContents();
        assert.ok(texts.length >= 2, `ожидалось минимум 2 сообщения в истории, получено ${texts.length}`);
      });
    } else {
      skip('чат: сообщение от зрителя №1', 'зрители не подключились');
      skip('чат: ответ вещающего', 'зрители не подключились');
      skip('чат: бейдж непрочитанных', 'зрители не подключились');
    }

    // --- Завершение трансляции ---
    if (viewersJoinedOk) {
      await step('закрытие вкладки вещающего -> у зрителей оверлей «Трансляция завершена»', async () => {
        await broadcasterPage.close();
        for (const [label, page] of [['зритель №1', viewer1Page], ['зритель №2', viewer2Page]]) {
          await page.waitForFunction(
            () => document.getElementById('overlay-title')?.textContent === 'Трансляция завершена',
            { timeout: 5000 }
          );
        }
      });
    } else {
      skip('завершение трансляции', 'зрители не подключились');
    }

    await viewer1Context.close();
    await viewer2Context.close();
    if (!broadcasterPage.isClosed()) await broadcasterContext.close();
  } finally {
    if (browser) await browser.close();
    await stopServer();
  }
}

main()
  .then(() => {
    console.log('');
    console.log(`# итого: ok=${passedCount} FAIL=${failedCount} skip=${skippedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.log(`FAIL - неожиданная ошибка теста: ${err && err.stack ? err.stack : err}`);
    try { await stopServer(); } catch { /* уже остановлен или не запускался */ }
    console.log('');
    console.log(`# итого: ok=${passedCount} FAIL=${failedCount + 1} skip=${skippedCount}`);
    process.exit(1);
  });
