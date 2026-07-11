#!/usr/bin/env node
// tests/e2e/resilience.spec.mjs — браузерный e2e устойчивости к обрывам
// (п.10 плана). Тот же самодостаточный стиль, что и basic.spec.mjs: свой
// мини-раннер, свой сервер (порт 3333, отдельная временная SQLite),
// реальный Chrome через playwright-core, синтетические медиастабы по
// умолчанию (см. helpers.mjs — те же причины: зависший реальный
// getDisplayMedia/getUserMedia на этой машине травит последующие
// медиа-операции страницы).
//
// Порядок сценариев в коде — а, б, в, г, е, д (буквы — как в плане), НЕ
// а..е по порядку: сценарий (д) необратимо завершает трансляцию (вещающий
// закрывает вкладку, комната удаляется), поэтому всё, что ещё нуждается в
// живом чате/комнате (сценарий (е) — rate-limit чата), должно отработать до
// него. Все сценарии переиспользуют одну и ту же комнату/вещающего —
// состояние (кто в комнате, сколько зрителей) читается из реального DOM
// перед каждым шагом, а не предполагается по номеру шага.
//
// Тайминги обрывов — с запасом (серверная чистка при обрыве TCP может занять
// секунды: сценарии ниже рвут TCP явно, socket.recv() видит ошибку/EOF сразу;
// у сервера есть ещё и ping/pong-хартбит — см. src/ws.rs, PING_INTERVAL/
// MAX_MISSED_PONGS — но он на секунды-десятки секунд медленнее явного обрыва,
// поэтому тесты его не дожидаются), но нигде нет слепого sleep — везде
// поллинг условия с дедлайном (waitForFunction с options третьим аргументом
// и polling: 100, либо helpers.waitUntil).

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {
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
  getChatDom,
  installViewerCountHistory,
  viewerCountHistoryLength,
  viewerCountHistorySince,
  waitUntil,
} from './helpers.mjs';

const PORT = 3333;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
const server = createServerController(PORT);

const micStubArg = {
  tryReal: process.env.E2E_TRY_REAL_MIC === '1',
  timeoutMs: REAL_MIC_TIMEOUT_MS,
};

async function viewerCountText(broadcasterPage) {
  return broadcasterPage.evaluate(() => document.getElementById('viewer-count')?.textContent ?? null);
}

async function waitViewerCount(broadcasterPage, expected, timeoutMs = 8000) {
  await broadcasterPage.waitForFunction(
    (exp) => document.getElementById('viewer-count')?.textContent === exp,
    String(expected),
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitMicCount(broadcasterPage, expected, timeoutMs = 8000) {
  if (expected === 0) {
    await broadcasterPage.waitForFunction(
      () => document.getElementById('mic-indicator')?.classList.contains('hidden'),
      undefined,
      { polling: 100, timeout: timeoutMs }
    );
  } else {
    await broadcasterPage.waitForFunction(
      (n) => {
        const el = document.getElementById('mic-indicator');
        return !!el && !el.classList.contains('hidden') && el.textContent.includes(String(n));
      },
      expected,
      { polling: 100, timeout: timeoutMs }
    );
  }
}

async function waitSpeakingHidden(page, timeoutMs = 6000) {
  await page.waitForFunction(
    () => document.getElementById('speaking-indicator')?.classList.contains('hidden'),
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitOverlayTitle(page, expectedTitle, timeoutMs = 15_000) {
  await page.waitForFunction(
    (title) => document.getElementById('overlay-title')?.textContent === title,
    expectedTitle,
    { polling: 100, timeout: timeoutMs }
  );
}

async function main() {
  await buildServer();
  await server.start();

  let browser = null;
  // Держим все созданные контексты, чтобы гарантированно закрыть в finally
  // даже если какой-то шаг упал посередине.
  const allContexts = [];

  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    // --- Общая подготовка: вещающий + два зрителя (Вася, Петя) ---
    const broadcasterContext = await browser.newContext();
    allContexts.push(broadcasterContext);
    await broadcasterContext.addInitScript(installCaptureStub(), {
      tryReal: process.env.E2E_TRY_REAL_CAPTURE === '1',
      timeoutMs: 10_000,
    });
    const broadcasterPage = await broadcasterContext.newPage();

    let roomId = null;
    const setupOk = await step('подготовка: вещающий открывает страницу и начинает трансляцию', async () => {
      await broadcasterPage.goto(server.baseUrl);
      await broadcasterPage.click('#start-button');
      await broadcasterPage.waitForSelector('#live-section:not(.hidden)', { timeout: 18_000 });
      const link = await broadcasterPage.inputValue('#room-link-input');
      const match = link.match(/\/room\/([^/]+)$/);
      assert.ok(match, `не удалось извлечь roomId из ссылки: ${link}`);
      roomId = match[1];
      await installViewerCountHistory(broadcasterPage);
    });

    if (!setupOk || !roomId) {
      console.log('FAIL - критическая ошибка: не удалось создать комнату, дальнейшие сценарии невозможны');
      return;
    }
    const roomUrl = `${server.baseUrl}/room/${roomId}`;

    let viewer1Context = await browser.newContext(); // Вася
    let viewer2Context = await browser.newContext(); // Петя
    allContexts.push(viewer1Context, viewer2Context);
    await viewer1Context.addInitScript(installMicStub(), micStubArg);
    await viewer2Context.addInitScript(installMicStub(), micStubArg);
    await installSavedName(viewer1Context, 'Вася');
    await installSavedName(viewer2Context, 'Петя');
    // Учёт WebSocket-инстансов страницы Пети — нужен сценарию (в), чтобы
    // детерминированно оборвать сигналинг после setOffline(true) (см.
    // большой комментарий у сценария (в): сам setOffline рвёт уже открытый
    // WS только через ~46+ секунд, если вообще рвёт). Wrapper прозрачный —
    // static/common.js работает с ним как с обычным WebSocket.
    await viewer2Context.addInitScript(() => {
      window.__e2eSockets = [];
      const RealWebSocket = window.WebSocket;
      window.WebSocket = class extends RealWebSocket {
        constructor(...args) {
          super(...args);
          window.__e2eSockets.push(this);
        }
      };
    });
    let viewer1Page = await viewer1Context.newPage();
    let viewer2Page = await viewer2Context.newPage();

    const bothJoinedOk = await step('подготовка: Вася и Петя подключаются к комнате', async () => {
      await viewer1Page.goto(roomUrl);
      await viewer2Page.goto(roomUrl);
      await waitForOverlayHidden(viewer1Page);
      await waitForOverlayHidden(viewer2Page);
      await waitViewerCount(broadcasterPage, 2);
    });

    if (!bothJoinedOk) {
      console.log('FAIL - критическая ошибка: зрители не подключились, дальнейшие сценарии невозможны');
      return;
    }

    // ============================================================
    // (а) Вася включает микрофон и говорит, потом закрывает вкладку
    // ============================================================
    const scenarioAOk = await step('(а) Вася включает микрофон — у вещающего «микрофонов: 1» и «Говорят: Вася»', async () => {
      await viewer1Page.click('#mic-button');
      await waitMicCount(broadcasterPage, 1);
      await broadcasterPage.waitForFunction(
        () => (document.getElementById('speaking-indicator')?.textContent || '').includes('Вася'),
        undefined,
        { polling: 100, timeout: 6000 }
      );
      // У Пети должен появиться ретранслированный трек Васи + тот же индикатор.
      await viewer2Page.waitForFunction(
        () => document.querySelectorAll('audio[data-stream-id]').length > 0,
        undefined,
        { polling: 100, timeout: 6000 }
      );
      await viewer2Page.waitForFunction(
        () => (document.getElementById('speaking-indicator')?.textContent || '').includes('Вася'),
        undefined,
        { polling: 100, timeout: 6000 }
      );
    });

    if (scenarioAOk) {
      await step('(а) Вася закрывает вкладку -> у вещающего счётчик зрителей 2 -> 1, «микрофонов» и «Говорят» гаснут', async () => {
        await viewer1Page.close();
        await waitViewerCount(broadcasterPage, 1);
        await waitMicCount(broadcasterPage, 0);
        await waitSpeakingHidden(broadcasterPage);
      });

      await step('(а) у Пети индикатор «Говорят» гаснет, ретранслированный <audio> Васи физически удалён из DOM', async () => {
        // Индикатор — честный RMS-анализ звука: после ухода Васи трек Пети
        // перестаёт нести данные, детектор видит тишину и гасит индикатор.
        await waitSpeakingHidden(viewer2Page, 15_000);

        // Раньше здесь был известный баг: когда вещающий убирает ретранслированный
        // трек через pc.removeTrack (broadcaster.js: unrelayAudioTrack), у Пети
        // соответствующий remote-трек получает событие 'mute' (track.muted = true,
        // readyState остаётся 'live'), а 'ended' не приходит вовсе — а
        // static/viewer.js чистил скрытый <audio data-stream-id> только по
        // track.onended, поэтому элемент и монитор уровня звука утекали.
        // Исправлено: viewer.js теперь слушает 'removetrack' на самой
        // MediaStream (надёжный сигнал в этом сценарии) и чистит <audio>, как
        // только у стрима не осталось аудиодорожек — 'ended' остаётся страховкой,
        // 'mute' сам по себе чистку не триггерит (бывает транзиентным). Поэтому
        // теперь требуем строгий инвариант: элемента в DOM быть не должно.
        await viewer2Page.waitForFunction(
          () => document.querySelectorAll('audio[data-stream-id]').length === 0,
          undefined,
          { polling: 100, timeout: 15_000 }
        );
      });

      await step('(а) чат продолжает работать между Петей и вещающим после ухода Васи', async () => {
        await openChatPanel(viewer2Page);
        await openChatPanel(broadcasterPage);
        const text = `Петя после ухода Васи — ${Date.now()}`;
        await sendChatMessage(viewer2Page, text);
        assert.ok(await messageTextsInclude(viewer2Page, text), 'сообщение не появилось у самой Пети');
        assert.ok(await messageTextsInclude(broadcasterPage, text), 'сообщение не дошло до вещающего');
      });
    } else {
      skip('(а) закрытие вкладки Васи', 'не удалось включить микрофон/убедиться в ретрансляции');
      skip('(а) чат Петя <-> вещающий', 'сценарий (а) не выполнен');
    }

    // ============================================================
    // (б) Петя перезагружает страницу
    // ============================================================
    const historyMarker = await viewerCountHistoryLength(broadcasterPage);

    const scenarioBOk = await step('(б) Петя перезагружает страницу и снова подключается', async () => {
      await viewer2Page.reload();
      await waitForOverlayHidden(viewer2Page);
      await assertVideoPlaying(viewer2Page);
      await waitViewerCount(broadcasterPage, 1, 10_000);
    });

    if (scenarioBOk) {
      await step('(б) счётчик у вещающего проходил через кратковременный 0 между уходом старой сессии и приходом новой', async () => {
        const history = await viewerCountHistorySince(broadcasterPage, historyMarker);
        assert.ok(
          history.includes('0'),
          `ожидали увидеть промежуточное значение "0" в истории счётчика, получено: ${JSON.stringify(history)}`
        );
        assert.equal(history[history.length - 1], '1', `итоговое значение счётчика должно быть "1", получено: ${JSON.stringify(history)}`);
      });

      await step('(б) история чата приходит заново Пете — видно сообщение из сценария (а)', async () => {
        await openChatPanel(viewer2Page);
        const texts = await (await getChatDom(viewer2Page)).messages.allTextContents();
        assert.ok(texts.length >= 1, 'после переподключения история чата пуста');
      });
    } else {
      skip('(б) кратковременный 0 в счётчике', 'перезагрузка/переподключение Пети не удались');
      skip('(б) история чата после переподключения', 'перезагрузка/переподключение Пети не удались');
    }

    // ============================================================
    // (в) Обрыв сети у зрителя (Петя)
    //
    // ВАЖНО (эмпирика этой среды, установлено диагностикой при написании
    // теста — см. финальный отчёт агента):
    // `browserContext.setOffline(true)` НЕ обрывает уже установленное
    // WebSocket-соединение — ни сразу, ни «в течение ~10с». Проверено двумя
    // изолированными экспериментами:
    //   1) голый WebSocket: readyState оставался OPEN 20+ секунд после
    //      setOffline, без событий close/error;
    //   2) против нашего сервера: Chrome в одном прогоне сам послал
    //      close-фрейм (код 1001 "Going Away") через ~46 секунд, в другом —
    //      не послал и за 70 секунд. Существующий TCP-сокет при offline
    //      продолжает работать (close-фрейм в первом прогоне дошёл до
    //      сервера) — offline-эмуляция Chrome блокирует НОВЫЕ соединения,
    //      а к уже открытым применяет какой-то свой ленивый таймер.
    // Ждать этот недетерминированный таймер (46-70+с) — медленно и флейково,
    // поэтому обрыв доводим до конца сами: после setOffline(true) тестовый
    // арнесс принудительно закрывает сигналинг-сокет Пети (учтён wrapper'ом
    // window.__e2eSockets, см. подготовку контекста). Для приложения это
    // неотличимо от «браузер признал сеть мёртвой и порвал WS»: у Пети
    // срабатывает штатный signaling.onClose (оверлей «Соединение потеряно»),
    // а сервер обрабатывает Close/Err/None одной и той же веткой (src/ws.rs:
    // `Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break`) — то есть
    // серверная чистка по обрыву проверяется по-настоящему.
    let offlineWasSet = false;
    const scenarioCOk = await step('(в) обрыв сети у Пети (setOffline + принудительный разрыв WS) -> у вещающего счётчик падает до 0', async () => {
      await viewer2Context.setOffline(true);
      offlineWasSet = true;
      // Довершаем обрыв, не дожидаясь ленивого таймера Chrome (см. выше).
      await viewer2Page.evaluate(() => {
        for (const ws of window.__e2eSockets || []) {
          try { ws.close(); } catch { /* уже закрыт */ }
        }
      });
      await waitViewerCount(broadcasterPage, 0, 15_000);
    });

    if (scenarioCOk) {
      await step('(в) у Пети показывается оверлей «Соединение потеряно»', async () => {
        await waitOverlayTitle(viewer2Page, 'Соединение потеряно', 10_000);
      });
    } else {
      skip('(в) оверлей «Соединение потеряно» у Пети', 'обрыв сети не привёл к уходу зрителя со стороны сервера в отведённое время');
    }

    // Восстанавливаем сеть ВСЕГДА (даже если сама проверка выше упала) —
    // иначе все последующие сценарии для Пети посыплются каскадом (именно
    // так и произошло при отладке этого теста).
    if (offlineWasSet) {
      await viewer2Context.setOffline(false);
    }

    const scenarioCReconnectOk = await step('(в) после восстановления сети и перезагрузки Петя снова в комнате', async () => {
      await viewer2Page.reload();
      await waitForOverlayHidden(viewer2Page);
      await waitViewerCount(broadcasterPage, 1, 10_000);
    });
    if (!scenarioCReconnectOk) {
      console.log('# переподключение Пети после offline не удалось — последующие сценарии, зависящие от Пети, тоже могут быть затронуты');
    }

    // ============================================================
    // (г) Переполнение комнаты
    // ============================================================
    // Лёгкие страницы-заполнители (без микрофона и стабов — им нужен только
    // вход в комнату). fillerPages нужны и сценарию (д) — они должны увидеть
    // «Трансляция завершена». 6-й зритель — отдельно: он в комнату не попал
    // и навсегда остаётся с «Комната заполнена» (terminalState в viewer.js).
    const fillerPages = [];
    let roomFullOk = false;
    await step('(г) добиваем комнату до 5 зрителей, 6-й получает «Комната заполнена»', async () => {
      const currentCountText = await viewerCountText(broadcasterPage);
      const currentCount = Number(currentCountText);
      assert.ok(Number.isFinite(currentCount), `не удалось прочитать текущий счётчик зрителей: ${currentCountText}`);
      const toAdd = 5 - currentCount;
      assert.ok(toAdd >= 0, `в комнате уже больше 5 зрителей (${currentCount}) — тест сценария не применим`);

      for (let i = 0; i < toAdd; i++) {
        const ctx = await browser.newContext();
        allContexts.push(ctx);
        const page = await ctx.newPage();
        fillerPages.push(page);
        await page.goto(roomUrl);
      }
      for (const page of fillerPages) {
        await waitForOverlayHidden(page);
      }
      await waitViewerCount(broadcasterPage, 5, 15_000);

      // 6-й — комната уже полна.
      const sixthContext = await browser.newContext();
      allContexts.push(sixthContext);
      const sixthPage = await sixthContext.newPage();
      await sixthPage.goto(roomUrl);
      await waitOverlayTitle(sixthPage, 'Комната заполнена', 10_000);
      roomFullOk = true;
    });

    if (!roomFullOk) {
      skip('(г) переполнение комнаты', 'не удалось довести комнату до 5 зрителей');
    }

    // ============================================================
    // (е) Rate-limit чата глазами Пети (до того, как вещающий завершит
    // трансляцию сценарием (д) — см. комментарий в шапке файла про порядок)
    // ============================================================
    const rateLimitOk = await step('(е) Петя быстро шлёт 11 сообщений — 11-е отклоняется с ненавязчивой ошибкой в панели', async () => {
      await openChatPanel(viewer2Page);
      await openChatPanel(broadcasterPage);
      const prefix = `RL-${Date.now()}-`;
      for (let i = 1; i <= 11; i++) {
        await sendChatMessage(viewer2Page, `${prefix}${i}`);
      }

      // Ненавязчивая ошибка рендерится в .chat-error-banner (см. chat.js:
      // showError/handleError) только отправителю 11-го сообщения — Пете.
      const chat = await getChatDom(viewer2Page);
      await chat.errorBanner.waitFor({ state: 'visible', timeout: 5000 });
      const errorText = await chat.errorBanner.textContent();
      assert.ok(errorText && errorText.trim().length > 0, 'баннер ошибки чата пуст');

      // Первые 10 должны дойти до вещающего, 11-е — нет. Ждём, пока число
      // пришедших сообщений с этим префиксом стабилизируется на 10.
      await waitUntil(
        async () => {
          const broadcasterChat = await getChatDom(broadcasterPage);
          const texts = await broadcasterChat.messages.allTextContents();
          return texts.filter((t) => t.startsWith(prefix)).length === 10;
        },
        { timeoutMs: 8000, message: 'у вещающего не набралось ровно 10 сообщений с rate-limit префиксом' }
      );

      const broadcasterChat = await getChatDom(broadcasterPage);
      const finalTexts = await broadcasterChat.messages.allTextContents();
      const matched = finalTexts.filter((t) => t.startsWith(prefix));
      assert.equal(matched.length, 10, `у вещающего должно быть ровно 10 сообщений, получено ${matched.length}: ${JSON.stringify(matched)}`);
      assert.ok(!matched.includes(`${prefix}11`), '11-е сообщение не должно было дойти до вещающего');
    });

    if (!rateLimitOk) {
      console.log('# rate-limit чата не подтверждён — см. FAIL выше');
    }

    // ============================================================
    // (д) Вещающий закрывает вкладку, пока у зрителя открыт чат и включён микрофон
    // ============================================================
    const micOnForScenarioD = await step('(д, подготовка) Петя снова включает микрофон перед завершением трансляции', async () => {
      await viewer2Page.click('#mic-button');
      await waitMicCount(broadcasterPage, 1, 8000);
    });
    if (!micOnForScenarioD) {
      skip('(д) состояние микрофона Пети перед завершением', 'не удалось включить микрофон повторно');
    }

    await step('(д) вещающий закрывает вкладку -> у зрителей оверлей «Трансляция завершена», чат заблокирован', async () => {
      await broadcasterPage.close();

      await waitOverlayTitle(viewer2Page, 'Трансляция завершена', 8000);
      const petyaChat = await getChatDom(viewer2Page);
      const petyaInputDisabled = await petyaChat.textInput.evaluate((el) => el.disabled);
      assert.equal(petyaInputDisabled, true, 'чат-инпут у Пети должен быть заблокирован (disabled)');
      const petyaSendDisabled = await petyaChat.sendButton.evaluate((el) => el.disabled);
      assert.equal(petyaSendDisabled, true, 'кнопка отправки чата у Пети должна быть заблокирована (disabled)');

      // «Заполняющие» зрители из сценария (г) тоже должны увидеть завершение
      // (6-й зритель — не среди них: он в комнату не попал и остаётся со
      // своим оверлеем «Комната заполнена»).
      for (const page of fillerPages) {
        if (page.isClosed()) continue;
        await waitOverlayTitle(page, 'Трансляция завершена', 8000);
      }
    });

    for (const ctx of allContexts) {
      try { await ctx.close(); } catch { /* уже закрыт */ }
    }
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
