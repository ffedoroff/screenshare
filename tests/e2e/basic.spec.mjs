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
// Переиспользуемая инфраструктура (мини-раннер, сервер, стабы медиа,
// чат-хелперы) вынесена в helpers.mjs — см. там подробные комментарии про
// почему стабы именно такие и почему waitForFunction всегда с options
// третьим аргументом. Второй e2e-файл — resilience.spec.mjs (обрывы связи).
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
//   - по умолчанию тестовый арнесс (не static/broadcaster.js!) сразу подменяет
//     navigator.mediaDevices.getDisplayMedia на синтетический источник
//     (canvas.captureStream) — реальный захват даже не пробуется: его зависший
//     запрос ещё и тормозит последующие медиа-операции страницы (см. комментарий
//     у installCaptureStub в helpers.mjs). Попытка реального захвата —
//     E2E_TRY_REAL_CAPTURE=1 (аналогично для микрофона зрителя —
//     E2E_TRY_REAL_MIC=1); реальный код broadcaster.js/viewer.js/chat.js при
//     этом не трогается.
//   - в выводе явно помечается, какой источник видео использовался; если
//     использовался синтетический — проверка «это НАСТОЯЩИЙ захват экрана»
//     помечается как skip, но проверки того, что видео реально идёт
//     (videoWidth/readyState/currentTime растёт) всё равно выполняются —
//     они валидны и для синтетического источника, т.к. проверяют настоящий
//     WebRTC-транспорt (SDP/ICE/media), а не происхождение пикселей.

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {
  REAL_CAPTURE_TIMEOUT_MS,
  REAL_MIC_TIMEOUT_MS,
  CAPTURE_FLAGS,
  createRunner,
  buildServer,
  createServerController,
  installCaptureStub,
  installMicStub,
  installSavedName,
  waitForOverlayHidden,
  assertVideoPlaying,
  openChatPanel,
  sendChatMessage,
  messageTextsInclude,
  unreadBadgeCount,
} from './helpers.mjs';

const PORT = 3322;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
const server = createServerController(PORT);

async function main() {
  await buildServer();
  await server.start();

  let browser = null;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    // --- Вещающий ---
    const broadcasterContext = await browser.newContext();
    await broadcasterContext.addInitScript(installCaptureStub(), {
      tryReal: process.env.E2E_TRY_REAL_CAPTURE === '1',
      timeoutMs: REAL_CAPTURE_TIMEOUT_MS,
    });
    const broadcasterPage = await broadcasterContext.newPage();

    let roomId = null;
    let captureSource = 'unknown';

    const setupOk = await step('вещающий: открыть страницу и начать трансляцию', async () => {
      await broadcasterPage.goto(server.baseUrl);
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
    const micStubArg = {
      tryReal: process.env.E2E_TRY_REAL_MIC === '1',
      timeoutMs: REAL_MIC_TIMEOUT_MS,
    };
    await viewer1Context.addInitScript(installMicStub(), micStubArg);
    await viewer2Context.addInitScript(installMicStub(), micStubArg);
    // Имена зрителей — заранее в localStorage (chat.js: NAME_STORAGE_KEY =
    // 'screenshare-name'), чтобы broadcaster узнал их из join-room и подписал
    // ими источники ретранслируемого аудио (см. индикатор «кто говорит» ниже).
    await installSavedName(viewer1Context, 'Вася');
    await installSavedName(viewer2Context, 'Петя');
    const viewer1Page = await viewer1Context.newPage();
    const viewer2Page = await viewer2Context.newPage();

    const viewersJoinedOk = await step('оба зрителя: открыть комнату и дождаться исчезновения оверлея', async () => {
      await viewer1Page.goto(`${server.baseUrl}/room/${roomId}`);
      await viewer2Page.goto(`${server.baseUrl}/room/${roomId}`);
      await waitForOverlayHidden(viewer1Page);
      await waitForOverlayHidden(viewer2Page);
    });

    if (viewersJoinedOk) {
      for (const [label, page] of [['зритель №1', viewer1Page], ['зритель №2', viewer2Page]]) {
        await step(`видео реально идёт у ${label} (videoWidth/readyState/currentTime)`, async () => {
          await assertVideoPlaying(page);
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
          undefined,
          { polling: 100, timeout: 5000 }
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
        const texts = await viewer2Page.locator('.chat-message-text').allTextContents();
        assert.ok(texts.length >= 2, `ожидалось минимум 2 сообщения в истории, получено ${texts.length}`);
      });
    } else {
      skip('чат: сообщение от зрителя №1', 'зрители не подключились');
      skip('чат: ответ вещающего', 'зрители не подключились');
      skip('чат: бейдж непрочитанных', 'зрители не подключились');
    }

    // --- Микрофон зрителя ---
    // Контексты зрителей запущены с --use-fake-device-for-media-stream и
    // --use-fake-ui-for-media-stream (CAPTURE_FLAGS в browser.launch — это
    // process-wide флаги Chrome, действуют на все контексты этого браузера) —
    // по документации Chromium этого достаточно, чтобы getUserMedia({ audio: true })
    // резолвился фейковым микрофоном без диалога. installMicStub() пробует
    // это первым и только если не сработало (как оказалось, стабильно не
    // срабатывает на этой машине, см. комментарий у installMicStub в helpers.mjs) —
    // подменяет источник на синтетический аудиотрек тестового арнесса. В любом
    // случае WebRTC-ренегоциация и обновление UI у вещающего проверяются по-настоящему.
    if (viewersJoinedOk) {
      await step('зритель №1 включает микрофон — у вещающего появляется «микрофонов: 1» и <audio>-элемент', async () => {
        await viewer1Page.click('#mic-button');

        await broadcasterPage.waitForFunction(
          () => {
            const el = document.getElementById('mic-indicator');
            return !!el && !el.classList.contains('hidden') && el.textContent.includes('1');
          },
          undefined,
          { polling: 100, timeout: 8000 }
        );

        const micSource = await viewer1Page.evaluate(() => window.__e2eMicSource || 'unknown');
        if (micSource === 'real') {
          console.log('# источник микрофона у зрителя №1: РЕАЛЬНЫЙ getUserMedia (флаги сработали)');
        } else {
          console.log(
            `# источник микрофона у зрителя №1: синтетический (Web Audio API) — ` +
            `реальный getUserMedia(audio) не отработал за ${REAL_MIC_TIMEOUT_MS}мс, см. комментарий у installMicStub`
          );
          skip(
            'микрофон: настоящий захват через getUserMedia',
            'на этой машине getUserMedia(audio) зависает даже при выданном разрешении (permissions.query -> granted); ' +
            'используется синтетический аудиотрек на уровне тестового арнесса, проверки WebRTC-ренегоциации и UI ниже всё равно выполняются'
          );
        }

        const audioCount = await broadcasterPage.evaluate(
          () => document.querySelectorAll('audio[data-peer-id]').length
        );
        assert.equal(audioCount, 1, `ожидался один <audio>-элемент микрофона у вещающего, получено ${audioCount}`);

        const micButtonOn = await viewer1Page.evaluate(
          () => document.getElementById('mic-button').classList.contains('mic-button--on')
        );
        assert.equal(micButtonOn, true, 'кнопка микрофона у зрителя №1 должна быть в состоянии «включено»');
      });

      // Аудио-хаб (п.9 плана): микрофон зрителя №1 ретранслируется вещающим
      // всем ОСТАЛЬНЫМ зрителям (не через сервер — броадкастер добавляет
      // трек в PeerConnection зрителя №2). Плюс индикатор «кто говорит» —
      // честный анализ громкости (осциллятор синтетического микрофона звучит
      // постоянно, поэтому детектор должен сработать стабильно) и подпись
      // из stream-info (имя «Вася» взято из localStorage перед goto).
      await step('у зрителя №2 появляется скрытый <audio> с чужим (ретранслированным) треком и индикатор «Говорят: Вася»', async () => {
        await viewer2Page.waitForFunction(
          () => document.querySelectorAll('audio[data-stream-id]').length > 0,
          undefined,
          { polling: 100, timeout: 5000 }
        );

        await viewer2Page.waitForFunction(
          () => (document.getElementById('speaking-indicator')?.textContent || '').includes('Вася'),
          undefined,
          { polling: 100, timeout: 5000 }
        );

        await broadcasterPage.waitForFunction(
          () => (document.getElementById('speaking-indicator')?.textContent || '').includes('Вася'),
          undefined,
          { polling: 100, timeout: 5000 }
        );
      });

      await step('зритель №1 выключает микрофон повторным кликом — кнопка меняет состояние, индикатор у вещающего не падает', async () => {
        await viewer1Page.click('#mic-button');

        const micButtonOn = await viewer1Page.evaluate(
          () => document.getElementById('mic-button').classList.contains('mic-button--on')
        );
        assert.equal(micButtonOn, false, 'после повторного клика кнопка должна выйти из состояния «включено»');

        // track.enabled = false не завершает трек — на приёмнике он остаётся
        // live, поэтому счётчик «микрофонов» у вещающего честно не меняется
        // (см. комментарий в static/broadcaster.js: handleIncomingTrack).
        const micIndicatorText = await broadcasterPage.evaluate(
          () => document.getElementById('mic-indicator').textContent
        );
        assert.ok(
          micIndicatorText.includes('1'),
          `индикатор микрофонов должен остаться «...1», получено «${micIndicatorText}»`
        );
      });

      // track.enabled = false отдаёт тишину на приёмнике (в отличие от
      // счётчика «микрофонов» выше — детектор уровня звука это отличает),
      // поэтому индикатор «Говорят» должен погаснуть у обоих слушателей.
      await step('после выключения микрофона индикатор «Говорят» гаснет у зрителя №2 и у вещающего', async () => {
        await viewer2Page.waitForFunction(
          () => document.getElementById('speaking-indicator')?.classList.contains('hidden'),
          undefined,
          { polling: 100, timeout: 4000 }
        );

        await broadcasterPage.waitForFunction(
          () => document.getElementById('speaking-indicator')?.classList.contains('hidden'),
          undefined,
          { polling: 100, timeout: 4000 }
        );
      });
    } else {
      skip('микрофон зрителя: включение', 'зрители не подключились');
      skip('микрофон зрителя: выключение', 'зрители не подключились');
    }

    // --- Завершение трансляции ---
    if (viewersJoinedOk) {
      await step('закрытие вкладки вещающего -> у зрителей оверлей «Трансляция завершена»', async () => {
        await broadcasterPage.close();
        for (const [label, page] of [['зритель №1', viewer1Page], ['зритель №2', viewer2Page]]) {
          await page.waitForFunction(
            () => document.getElementById('overlay-title')?.textContent === 'Трансляция завершена',
            undefined,
            { polling: 100, timeout: 5000 }
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
    await server.stop();
  }
}

main()
  .then(() => {
    printSummary();
    process.exit(counts.failedCount > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.log(`FAIL - неожиданная ошибка теста: ${err && err.stack ? err.stack : err}`);
    try { await server.stop(); } catch { /* уже остановлен или не запускался */ }
    bumpFailedForUnexpectedError();
    printSummary();
    process.exit(1);
  });
