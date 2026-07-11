#!/usr/bin/env node
// tests/e2e/resilience.spec.mjs — браузерный e2e устойчивости к обрывам,
// переписан под протокол v2 (симметричная комната-встреча, mesh между всеми,
// шаринг экрана — замок на одного участника, комната живёт, пока не
// опустеет + EMPTY_ROOM_TTL_SECONDS для пустой). Тот же самодостаточный
// стиль, что и basic.spec.mjs/старый resilience.spec.mjs: свой мини-раннер,
// свой сервер (порт 3333, состояние целиком в памяти процесса), реальный Chrome через
// playwright-core, синтетические медиастабы по умолчанию (см. helpers.mjs).
//
// Сервер этого файла запускается с EMPTY_ROOM_TTL_SECONDS=5 (не 3 — см.
// сценарий (е): пяти секунд достаточно, чтобы детерминированно проверить и
// «успели зайти вовремя», и «опоздали», без гонки с реапером, который тикает
// раз в секунду, см. src/state.rs::REAPER_INTERVAL).
//
// Порядок сценариев в коде — а, б, в, г, д, е, ж, как в плане (в отличие от
// старого файла порядок дополнительно не переставлялся: ни один из сценариев
// а..д не уничтожает комнату безвозвратно — комната живёт, пока в ней
// остаётся хотя бы один участник, поэтому они естественно текут друг в
// друга через общую комнату Вася/Петя/Оля. Только сценарий (е) закономерно
// опустошает и хоронит эту комнату по TTL, поэтому сценарий (ж) — уже в
// заведомо новой комнате).
//
// Тайминги — поллинг с дедлайном (waitForFunction/waitUntil, всегда третьим
// аргументом { polling: 100, timeout }), без слепых sleep — за одним
// намеренным исключением в сценарии (е): TTL пустой комнаты — это свойство
// реального времени на сервере, а не наблюдаемое состояние DOM, поэтому
// «подождать меньше TTL» и «подождать больше TTL» невозможно выразить через
// поллинг условия — там и только там используется helpers.sleep с
// пояснением на месте.
//
// Обрыв сети (сценарий г) — тот же приём, что и в старом файле: чистый
// `context.setOffline(true)` не рвёт уже открытый WebSocket предсказуемо
// быстро (проверено эмпирически при написании старого теста — см. историю),
// поэтому тестовый арнесс сам принудительно закрывает сигналинг-сокет через
// обёртку window.__e2eSockets (см. подготовку контекста Игоря).

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {
  REAL_MIC_TIMEOUT_MS,
  REAL_CAM_TIMEOUT_MS,
  REAL_CAPTURE_TIMEOUT_MS,
  CAPTURE_FLAGS,
  createRunner,
  buildServer,
  createServerController,
  installCaptureStub,
  installMicStub,
  installCamStub,
  installSavedName,
  waitForOverlayHidden,
  assertVideoPlaying,
  openChatPanel,
  sendChatMessage,
  messageTextsInclude,
  getChatDom,
  waitUntil,
  sleep,
} from './helpers.mjs';

const PORT = 3333;
const EMPTY_ROOM_TTL_SECONDS = 5;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
const server = createServerController(PORT, { EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS) });

const micStubArg = { tryReal: process.env.E2E_TRY_REAL_MIC === '1', timeoutMs: REAL_MIC_TIMEOUT_MS };
const camStubArg = { tryReal: process.env.E2E_TRY_REAL_CAM === '1', timeoutMs: REAL_CAM_TIMEOUT_MS };
const captureStubArg = { tryReal: process.env.E2E_TRY_REAL_CAPTURE === '1', timeoutMs: REAL_CAPTURE_TIMEOUT_MS };

// Мик + камера (в этом порядке — см. комментарий у installCamStub в
// helpers.mjs про делегирование запросов без video).
async function installMicAndCamStubs(context) {
  await context.addInitScript(installMicStub(), micStubArg);
  await context.addInitScript(installCamStub(), camStubArg);
}

async function installCaptureOnly(context) {
  await context.addInitScript(installCaptureStub(), captureStubArg);
}

// --- Хелперы для DOM протокола v2 (тайлы, счётчик участников, оверлей) ---

function tileSelector(name) {
  return `.tile[data-name="${name}"]`;
}

async function waitForTileCount(page, expected, timeoutMs = 8000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.tile').length === n,
    expected,
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitForNoTile(page, name, timeoutMs = 8000) {
  await page.waitForFunction(
    (sel) => !document.querySelector(sel),
    tileSelector(name),
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitForClassOnSelector(page, selector, className, present, timeoutMs = 8000) {
  await page.waitForFunction(
    ({ sel, cls, want }) => {
      const el = document.querySelector(sel);
      return !!el && el.classList.contains(cls) === want;
    },
    { sel: selector, cls: className, want: present },
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitParticipantCount(page, total, timeoutMs = 8000) {
  await page.waitForFunction(
    (text) => document.getElementById('participant-count')?.textContent === text,
    `Участников: ${total} / 6`,
    { polling: 100, timeout: timeoutMs }
  );
}

async function participantCount(page) {
  const text = await page.evaluate(() => document.getElementById('participant-count')?.textContent ?? '');
  const match = text.match(/Участников:\s*(\d+)/);
  return match ? Number(match[1]) : NaN;
}

async function waitOverlayTitle(page, expectedTitle, timeoutMs = 15_000) {
  await page.waitForFunction(
    (title) => document.getElementById('overlay-title')?.textContent === title,
    expectedTitle,
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitScreenButtonOn(page, on, timeoutMs = 8000) {
  await page.waitForFunction(
    (want) => document.getElementById('screen-button')?.classList.contains('control-button--on') === want,
    on,
    { polling: 100, timeout: timeoutMs }
  );
}

async function waitScreenStageHidden(page, hidden, timeoutMs = 8000) {
  await page.waitForFunction(
    (want) => document.getElementById('screen-stage')?.classList.contains('hidden') === want,
    hidden,
    { polling: 100, timeout: timeoutMs }
  );
}

async function createRoomViaApi(baseUrl) {
  const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
  assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
  const data = await res.json();
  assert.ok(data && typeof data.roomId === 'string' && data.roomId, `в ответе нет roomId: ${JSON.stringify(data)}`);
  return data.roomId;
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

    // ============================================================
    // Подготовка: комната через POST /api/rooms, Вася/Петя/Оля заходят
    // напрямую по ссылке (не через лендинг — это уже покрыто basic.spec.mjs).
    // ============================================================
    let roomId = null;
    const setupRoomOk = await step('подготовка: создаём комнату через POST /api/rooms', async () => {
      roomId = await createRoomViaApi(server.baseUrl);
    });
    if (!setupRoomOk || !roomId) {
      console.log('FAIL - критическая ошибка: комната не создана, дальнейшие сценарии невозможны');
      return;
    }
    const roomUrl = `${server.baseUrl}/r/${roomId}`;

    const vasyaContext = await browser.newContext();
    const petyaContext = await browser.newContext();
    const olyaContext = await browser.newContext();
    allContexts.push(vasyaContext, petyaContext, olyaContext);
    await installMicAndCamStubs(vasyaContext);
    await installCaptureOnly(petyaContext); // Петя шарит экран в сценарии (б)
    await installCaptureOnly(olyaContext); // Оля шарит экран в сценариях (б)/(в)
    await installSavedName(vasyaContext, 'Вася');
    await installSavedName(petyaContext, 'Петя');
    await installSavedName(olyaContext, 'Оля');
    let vasyaPage = await vasyaContext.newPage();
    let petyaPage = await petyaContext.newPage();
    let olyaPage = await olyaContext.newPage();

    const bothJoinedOk = await step('подготовка: Вася, Петя и Оля заходят в комнату — у всех по 3 тайла', async () => {
      await vasyaPage.goto(roomUrl);
      await petyaPage.goto(roomUrl);
      await olyaPage.goto(roomUrl);
      await waitForOverlayHidden(vasyaPage);
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);
      for (const page of [vasyaPage, petyaPage, olyaPage]) {
        await waitForTileCount(page, 3);
      }
    });

    if (!bothJoinedOk) {
      console.log('FAIL - критическая ошибка: участники не собрались, дальнейшие сценарии невозможны');
      return;
    }

    // ============================================================
    // (а) Вася включает камеру и микрофон, затем закрывает вкладку
    // ============================================================
    const vasyaTileSel = tileSelector('Вася');

    const scenarioACamOk = await step('(а) Вася включает камеру — у Пети и Оли живое видео в его тайле', async () => {
      await vasyaPage.click('#camera-button');
      for (const page of [petyaPage, olyaPage]) {
        await assertVideoPlaying(page, { selector: `${vasyaTileSel} video` });
      }
    });

    const scenarioAMicOk = await step('(а) Вася включает микрофон — у Пети и Оли «Говорят» на его тайле', async () => {
      await vasyaPage.click('#mic-button');
      for (const page of [petyaPage, olyaPage]) {
        await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', true, 8000);
      }
    });

    if (scenarioACamOk || scenarioAMicOk) {
      await step('(а) Вася закрывает вкладку — у Пети и Оли тайл исчезает, счётчик участников падает, «Говорят» гаснет', async () => {
        await vasyaPage.close();
        for (const page of [petyaPage, olyaPage]) {
          await waitForNoTile(page, 'Вася');
          await waitForTileCount(page, 2);
          await waitParticipantCount(page, 2);
          await page.waitForFunction(
            () => document.querySelectorAll('.tile--speaking').length === 0,
            undefined,
            { polling: 100, timeout: 8000 }
          );
        }
      });

      await step('(а) чат между Петей и Олей продолжает работать после ухода Васи', async () => {
        await openChatPanel(petyaPage);
        await openChatPanel(olyaPage);
        const text = `Петя после ухода Васи — ${Date.now()}`;
        await sendChatMessage(petyaPage, text);
        assert.ok(await messageTextsInclude(petyaPage, text), 'сообщение не появилось у самой Пети');
        assert.ok(await messageTextsInclude(olyaPage, text), 'сообщение не дошло до Оли');
      });
    } else {
      skip('(а) закрытие вкладки Васи', 'не удалось включить камеру/микрофон');
      skip('(а) чат Петя <-> Оля', 'сценарий (а) не выполнен');
    }

    // ============================================================
    // (б) Петя шарит экран, потом закрывает вкладку (дисконнект владельца
    // замка) — Оля видит освобождение и захватывает шаринг сама
    // ============================================================
    const scenarioBShareOk = await step('(б) Петя шарит экран — у Оли главная зона живая', async () => {
      await petyaPage.click('#screen-button');
      await waitScreenButtonOn(petyaPage, true);
      await assertVideoPlaying(olyaPage, { selector: '#screen-video' });
    });

    if (scenarioBShareOk) {
      await step('(б) Петя закрывает вкладку — у Оли экран освобождён (главная зона очищена, кнопка снова активна), комната жива', async () => {
        await petyaPage.close();
        await waitParticipantCount(olyaPage, 1);
        await waitScreenStageHidden(olyaPage, true);
        const disabled = await olyaPage.evaluate(() => document.getElementById('screen-button')?.disabled);
        assert.equal(disabled, false, 'кнопка «Экран» у Оли должна быть снова активна');
      });

      await step('(б) Оля захватывает шаринг — share-started, её превью в главной зоне', async () => {
        await olyaPage.click('#screen-button');
        await waitScreenButtonOn(olyaPage, true);
        await waitScreenStageHidden(olyaPage, false);
      });
    } else {
      skip('(б) закрытие вкладки Пети / освобождение экрана', 'шаринг Пети не заработал');
      skip('(б) Оля захватывает шаринг', 'шаринг Пети не заработал');
    }

    // ============================================================
    // (в) Оля перезагружает страницу посреди своего же шаринга
    // ============================================================
    if (scenarioBShareOk) {
      await step('(в) Оля перезагружает страницу — снова в комнате, старый шаринг освобождён сервером, история чата пришла заново', async () => {
        await olyaPage.reload();
        await waitForOverlayHidden(olyaPage);

        // История чата: сообщение из сценария (а) должно прийти заново.
        await openChatPanel(olyaPage);
        const texts = await (await getChatDom(olyaPage)).messages.allTextContents();
        assert.ok(texts.length >= 1, 'после переподключения история чата у Оли пуста');

        // Старый шаринг реально освобождён сервером (дисконнект = share-stopped),
        // а не просто «выглядит» освобождённым из-за свежей загрузки страницы:
        // если бы сервер всё ещё считал Олю владельцем экрана (баг), новая
        // заявка на шаринг получила бы share-rejected и кнопка не перешла бы
        // в состояние «включено».
        await olyaPage.click('#screen-button');
        await waitScreenButtonOn(olyaPage, true, 8000);
        await waitScreenStageHidden(olyaPage, false);

        // Прибираем за собой перед следующими сценариями.
        await olyaPage.click('#screen-button');
        await waitScreenButtonOn(olyaPage, false, 8000);
        await waitScreenStageHidden(olyaPage, true);
      });
    } else {
      skip('(в) reload Оли посреди шаринга', 'сценарий (б) не выполнен, шаринга у Оли нет');
    }

    // ============================================================
    // (г) Обрыв сети у нового участника (Игорь)
    // ============================================================
    const igorContext = await browser.newContext();
    allContexts.push(igorContext);
    // Учёт WebSocket-инстансов страницы Игоря — нужен, чтобы детерминированно
    // оборвать сигналинг после setOffline(true) (см. комментарий в шапке
    // файла и в старом resilience.spec.mjs: сам setOffline рвёт уже
    // открытый WS только через 46+ секунд, если вообще рвёт).
    await igorContext.addInitScript(() => {
      window.__e2eSockets = [];
      const RealWebSocket = window.WebSocket;
      window.WebSocket = class extends RealWebSocket {
        constructor(...args) {
          super(...args);
          window.__e2eSockets.push(this);
        }
      };
    });
    await installSavedName(igorContext, 'Игорь');
    const igorPage = await igorContext.newPage();

    const igorJoinedOk = await step('(г, подготовка) новый участник Игорь подключается к комнате', async () => {
      await igorPage.goto(roomUrl);
      await waitForOverlayHidden(igorPage);
      await waitForTileCount(olyaPage, 2);
      await waitParticipantCount(olyaPage, 2);
    });

    if (igorJoinedOk) {
      await step('(г) обрыв сети у Игоря (setOffline + принудительный разрыв WS) — у Оли его тайл исчезает', async () => {
        await igorContext.setOffline(true);
        await igorPage.evaluate(() => {
          for (const ws of window.__e2eSockets || []) {
            try { ws.close(); } catch { /* уже закрыт */ }
          }
        });
        await waitForNoTile(olyaPage, 'Игорь', 15_000);
        await waitParticipantCount(olyaPage, 1, 15_000);
      });
      await igorContext.setOffline(false);
    } else {
      skip('(г) обрыв сети у Игоря', 'Игорь не подключился к комнате');
    }

    // ============================================================
    // (д) Переполнение комнаты: добиваем до 6 участников, 7-й видит
    // «Комната заполнена»
    // ============================================================
    const fillerContexts = [];
    const fillerPages = [];
    let roomFullOk = false;
    await step('(д) добиваем комнату до 6 участников лёгкими вкладками, 7-й получает «Комната заполнена»', async () => {
      const current = await participantCount(olyaPage);
      assert.ok(Number.isFinite(current), `не удалось прочитать participant-count у Оли: ${current}`);
      const toAdd = 6 - current;
      assert.ok(toAdd >= 0, `в комнате уже больше 6 участников (${current}) — сценарий неприменим`);

      for (let i = 0; i < toAdd; i++) {
        const ctx = await browser.newContext();
        allContexts.push(ctx);
        fillerContexts.push(ctx);
        const page = await ctx.newPage();
        fillerPages.push(page);
        await page.goto(roomUrl);
      }
      for (const page of fillerPages) {
        await waitForOverlayHidden(page);
      }
      await waitParticipantCount(olyaPage, 6, 15_000);

      const seventhContext = await browser.newContext();
      const seventhPage = await seventhContext.newPage();
      await seventhPage.goto(roomUrl);
      await waitOverlayTitle(seventhPage, 'Комната заполнена', 10_000);
      roomFullOk = true;
      await seventhContext.close(); // в комнату не попал, дальше не нужен
    });

    if (!roomFullOk) {
      skip('(д) переполнение комнаты', 'не удалось довести комнату до 6 участников');
    }

    // ============================================================
    // (е) Опустевшая комната: все выходят («Покинуть» / закрытие) — вход в
    // течение TTL успешен, вход после TTL — «Комната не найдена».
    // ============================================================
    await step('(е) все выходят из комнаты — Оля жмёт «Покинуть», остальные закрывают вкладки', async () => {
      await olyaPage.click('#leave-button');
      for (const page of fillerPages) {
        if (!page.isClosed()) await page.close();
      }
      for (const ctx of fillerContexts) {
        try { await ctx.close(); } catch { /* уже закрыт */ }
      }
    });

    // Намеренный sleep (см. комментарий в шапке файла): TTL — свойство
    // реального времени сервера, а не наблюдаемое состояние DOM, поэтому
    // «меньше TTL» здесь можно проверить только реальной паузой короче него.
    await sleep(1000);

    const test1Context = await browser.newContext();
    allContexts.push(test1Context);
    const test1Page = await test1Context.newPage();
    const withinTtlOk = await step('(е) вход в опустевшую комнату в течение TTL (1с < 5с) — успешен', async () => {
      await test1Page.goto(roomUrl);
      await waitForOverlayHidden(test1Page);
    });

    if (withinTtlOk) {
      // Освобождаем комнату снова — от этого момента отсчитываем TTL заново
      // для проверки истечения.
      await test1Page.close();

      // Намеренный sleep дольше EMPTY_ROOM_TTL_SECONDS(5с) + период
      // реапера(1с, см. src/state.rs::REAPER_INTERVAL) + запас.
      await sleep((EMPTY_ROOM_TTL_SECONDS + 1) * 1000 + 1500);

      const test2Context = await browser.newContext();
      allContexts.push(test2Context);
      const test2Page = await test2Context.newPage();
      await step('(е) вход в ту же комнату после истечения TTL — «Комната не найдена»', async () => {
        await test2Page.goto(roomUrl);
        await waitOverlayTitle(test2Page, 'Комната не найдена', 10_000);
      });
    } else {
      skip('(е) вход после истечения TTL', 'вход в течение TTL не удался, дальнейшая проверка не имеет смысла');
    }

    // ============================================================
    // (ж) Rate-limit чата глазами пользователя — уже в заведомо новой
    // комнате (предыдущая похоронена сценарием (е)).
    // ============================================================
    let ninaPage = null;
    let tolyaPage = null;
    const rateLimitPrepOk = await step('(ж, подготовка) новая комната — Нина и Толя заходят', async () => {
      const newRoomId = await createRoomViaApi(server.baseUrl);
      const newRoomUrl = `${server.baseUrl}/r/${newRoomId}`;

      const ninaContext = await browser.newContext();
      const tolyaContext = await browser.newContext();
      allContexts.push(ninaContext, tolyaContext);
      await installSavedName(ninaContext, 'Нина');
      await installSavedName(tolyaContext, 'Толя');
      ninaPage = await ninaContext.newPage();
      tolyaPage = await tolyaContext.newPage();

      await ninaPage.goto(newRoomUrl);
      await tolyaPage.goto(newRoomUrl);
      await waitForOverlayHidden(ninaPage);
      await waitForOverlayHidden(tolyaPage);
    });

    if (rateLimitPrepOk) {
      await step('(ж) Нина быстро шлёт 11 сообщений — 11-е отклоняется с ошибкой в панели, первые 10 доставлены Толе', async () => {
        await openChatPanel(ninaPage);
        await openChatPanel(tolyaPage);
        const prefix = `RL-${Date.now()}-`;
        for (let i = 1; i <= 11; i++) {
          await sendChatMessage(ninaPage, `${prefix}${i}`);
        }

        const ninaChat = await getChatDom(ninaPage);
        await ninaChat.errorBanner.waitFor({ state: 'visible', timeout: 5000 });
        const errorText = await ninaChat.errorBanner.textContent();
        assert.ok(errorText && errorText.trim().length > 0, 'баннер ошибки чата пуст');

        await waitUntil(
          async () => {
            const tolyaChat = await getChatDom(tolyaPage);
            const texts = await tolyaChat.messages.allTextContents();
            return texts.filter((t) => t.startsWith(prefix)).length === 10;
          },
          { timeoutMs: 8000, message: 'у Толи не набралось ровно 10 сообщений с rate-limit префиксом' }
        );

        const tolyaChat = await getChatDom(tolyaPage);
        const finalTexts = await tolyaChat.messages.allTextContents();
        const matched = finalTexts.filter((t) => t.startsWith(prefix));
        assert.equal(matched.length, 10, `у Толи должно быть ровно 10 сообщений, получено ${matched.length}: ${JSON.stringify(matched)}`);
        assert.ok(!matched.includes(`${prefix}11`), '11-е сообщение не должно было дойти до Толи');
      });
    } else {
      skip('(ж) rate-limit чата', 'Нина/Толя не подключились к новой комнате');
    }

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
