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
  joinRoom,
  installPcRegistry,
  waitForMeshSettled,
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

/** Корона видна (не .hidden) на тайле `selector .tile-crown` (см. README.md «Права и лидер»). */
async function waitCrownVisible(page, selector, visible, timeoutMs = 8000) {
  await page.waitForFunction(
    ({ sel, want }) => {
      const crown = document.querySelector(`${sel} .tile-crown`);
      return !!crown && crown.classList.contains('hidden') !== want;
    },
    { sel: selector, want: visible },
    { polling: 100, timeout: timeoutMs }
  );
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
    await installPcRegistry(vasyaContext);
    await installPcRegistry(petyaContext);
    await installPcRegistry(olyaContext);
    let vasyaPage = await vasyaContext.newPage();
    let petyaPage = await petyaContext.newPage();
    let olyaPage = await olyaContext.newPage();

    const bothJoinedOk = await step('подготовка: Вася, Петя и Оля заходят в комнату (модалка входа) — у всех по 3 тайла', async () => {
      await vasyaPage.goto(roomUrl);
      await petyaPage.goto(roomUrl);
      await olyaPage.goto(roomUrl);
      await joinRoom(vasyaPage, 'Вася');
      await joinRoom(petyaPage, 'Петя');
      await joinRoom(olyaPage, 'Оля');
      await waitForOverlayHidden(vasyaPage);
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);
      // waitForMeshSettled ждёт и тайлы, и что у всех троих обе mesh-связи
      // реально дошли до connected (см. helpers.mjs) — сценарий (а) ниже
      // сразу кликает по камере/микрофону.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });
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
      await step('(в) Оля перезагружает страницу — снова в комнате, старый шаринг освобождён сервером, история чата пуста (Ф1: сервер её не хранит, а к этому моменту Оля в комнате одна — спросить не у кого)', async () => {
        // page.reload() — это полная перезагрузка (новый JS-контекст, не
        // авто-reconnect внутри вкладки) — модалка входа показывается заново
        // (анонимность, см. static/room.js), имя вводим снова.
        await olyaPage.reload();
        await joinRoom(olyaPage, 'Оля');
        await waitForOverlayHidden(olyaPage);

        // Ф1: истории на сервере больше нет вообще (см. README.md/src/ws.rs) —
        // новичок запрашивает последние сообщения у соседей по mesh
        // DataChannel (см. static/chat.js). К этому моменту сценариев (а)/(б)
        // и Вася, и Петя уже покинули комнату — Оля тут одна, спрашивать не у
        // кого, поэтому у неё ЗАКОНОМЕРНО пустая лента (как и в пустой
        // комнате при первом входе). Реальный кейс «история приходит от
        // живого пира по DataChannel» уже покрыт отдельным сценарием в
        // tests/e2e/basic.spec.mjs.
        await openChatPanel(olyaPage);
        const texts = await (await getChatDom(olyaPage)).messages.allTextContents();
        assert.equal(texts.length, 0, 'у Оли (единственной в комнате после reload) лента чата должна быть пустой');

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
    const igorPage = await igorContext.newPage();

    const igorJoinedOk = await step('(г, подготовка) новый участник Игорь подключается к комнате', async () => {
      await igorPage.goto(roomUrl);
      await joinRoom(igorPage, 'Игорь');
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
      // Роль Игоря в тесте окончена — закрываем его контекст, НЕ восстанавливая
      // сеть (setOffline(false)). Иначе, раз страница Игоря так и осталась
      // открытой, авто-reconnect (см. static/room.js) законно попытался бы
      // переподключиться и заново войти в комнату, как только сеть вернётся —
      // это корректное поведение само по себе (проверяется отдельно в
      // сценарии (з) про рестарт сервера), но здесь только помешало бы
      // последующим сценариям (д)/(е), которые рассчитывают, что Игорь
      // окончательно ушёл.
      try { await igorContext.close(); } catch { /* уже закрыт */ }
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
        await joinRoom(page);
      }
      for (const page of fillerPages) {
        await waitForOverlayHidden(page);
      }
      await waitParticipantCount(olyaPage, 6, 15_000);

      const seventhContext = await browser.newContext();
      const seventhPage = await seventhContext.newPage();
      await seventhPage.goto(roomUrl);
      await joinRoom(seventhPage);
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
      await joinRoom(test1Page);
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
        await joinRoom(test2Page);
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
      ninaPage = await ninaContext.newPage();
      tolyaPage = await tolyaContext.newPage();

      await ninaPage.goto(newRoomUrl);
      await tolyaPage.goto(newRoomUrl);
      await joinRoom(ninaPage, 'Нина');
      await joinRoom(tolyaPage, 'Толя');
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

    // Разгружаем ресурсы перед последним (самым тяжёлым, реальный рестарт
    // сервера) сценарием: закрываем все контексты предыдущих сценариев — они
    // здесь больше не нужны, а простаивающие вкладки (у части из них WebRTC
    // ещё жив) иначе конкурируют за CPU с ICE-негоциацией трёх новых
    // участников ниже и делают waitForMeshSettled эмпирически флейковым.
    for (const ctx of allContexts) {
      try { await ctx.close(); } catch { /* уже закрыт */ }
    }
    allContexts.length = 0;

    // ============================================================
    // (з) Рестарт сервера (деплой): звонок должен пережить его почти
    // незаметно. Свежая комната — Вася/Петя/Оля заходят, у Васи микрофон,
    // Петя шарит экран, есть переписка — затем сервер целиком останавливается
    // (SIGTERM/SIGKILL, см. helpers.mjs::createServerController.stop) и
    // поднимается заново на том же порту (server.start()) — ровно то, что
    // происходит при выкатке новой версии (см. README.md, раздел «Живучесть
    // звонка при деплое»). Мы НЕ трогаем static/* — только сервер-процесс.
    // ============================================================
    let vasya2Page = null;
    let petya2Page = null;
    let olya2Page = null;
    const restartPrepOk = await step(
      '(з, подготовка) новая комната — Вася/Петя/Оля заходят, Вася включает микрофон, Петя шарит экран, есть переписка',
      async () => {
        const restartRoomId = await createRoomViaApi(server.baseUrl);
        const restartRoomUrl = `${server.baseUrl}/r/${restartRoomId}`;

        const vasya2Context = await browser.newContext();
        const petya2Context = await browser.newContext();
        const olya2Context = await browser.newContext();
        allContexts.push(vasya2Context, petya2Context, olya2Context);
        await installMicAndCamStubs(vasya2Context);
        await installCaptureOnly(petya2Context);
        await installPcRegistry(vasya2Context);
        await installPcRegistry(petya2Context);
        await installPcRegistry(olya2Context);
        vasya2Page = await vasya2Context.newPage();
        petya2Page = await petya2Context.newPage();
        olya2Page = await olya2Context.newPage();

        await vasya2Page.goto(restartRoomUrl);
        await petya2Page.goto(restartRoomUrl);
        await olya2Page.goto(restartRoomUrl);
        await joinRoom(vasya2Page, 'Вася');
        await joinRoom(petya2Page, 'Петя');
        await joinRoom(olya2Page, 'Оля');
        await waitForOverlayHidden(vasya2Page);
        await waitForOverlayHidden(petya2Page);
        await waitForOverlayHidden(olya2Page);
        await waitForMeshSettled([vasya2Page, petya2Page, olya2Page], { tileCount: 3, connectionsPerPage: 2 });

        await vasya2Page.click('#camera-button');
        await assertVideoPlaying(petya2Page, { selector: `${tileSelector('Вася')} video` });
        await vasya2Page.click('#mic-button');
        await waitForClassOnSelector(petya2Page, tileSelector('Вася'), 'tile--speaking', true, 8000);

        await petya2Page.click('#screen-button');
        await waitScreenButtonOn(petya2Page, true);
        await assertVideoPlaying(olya2Page, { selector: '#screen-video' });

        await openChatPanel(vasya2Page);
        await openChatPanel(petya2Page);
        await openChatPanel(olya2Page);
        const msg1 = `до рестарта — раз — ${Date.now()}`;
        const msg2 = `до рестарта — два — ${Date.now()}`;
        await sendChatMessage(vasya2Page, msg1);
        assert.ok(await messageTextsInclude(petya2Page, msg1), 'сообщение 1 не дошло до Пети');
        assert.ok(await messageTextsInclude(olya2Page, msg1), 'сообщение 1 не дошло до Оли');
        await sendChatMessage(petya2Page, msg2);
        assert.ok(await messageTextsInclude(vasya2Page, msg2), 'сообщение 2 не дошло до Васи');
        assert.ok(await messageTextsInclude(olya2Page, msg2), 'сообщение 2 не дошло до Оли');

        // Комната создана через createRoomViaApi (без leaderToken) — лидером
        // становится первый вошедший (см. README.md «Права и лидер»), здесь
        // это Вася (join-room отправлен первым, до Пети/Оли).
        await waitCrownVisible(petya2Page, tileSelector('Вася'), true);
      }
    );

    if (restartPrepOk) {
      await step(
        '(з) сервер останавливается — у всех троих баннер «Переподключение…» появляется, тайлы/медиа/чат не разрушены',
        async () => {
          await server.stop();
          for (const page of [vasya2Page, petya2Page, olya2Page]) {
            await waitForClassOnSelector(page, '#reconnect-banner', 'hidden', false, 10_000);
          }
          // Сигналинг мёртв, но mesh (медиа/DataChannel-чат) от него физически
          // не зависит (см. README.md) — тайлы никуда не делись прямо сейчас.
          await waitForTileCount(vasya2Page, 3);
          await waitForTileCount(petya2Page, 3);
          await waitForTileCount(olya2Page, 3);
        }
      );

      // Намеренная контролируемая пауза (не гонка с реальным даунтаймом
      // деплоя): гарантирует, что окно «сервер лежит» не короче интервала
      // поллинга баннера выше, даже на быстрой машине, где процесс успевает
      // перезапуститься почти мгновенно.
      await sleep(1500);

      await step(
        '(з) сервер поднимается заново на том же порту — авто-reconnect восстанавливает сигналинг, баннер исчезает',
        async () => {
          await server.start();
          // Параллельно (не последовательно) и с запасом по времени: первые
          // 1-2 попытки reconnect могут напороться на сервер, который ещё не
          // до конца поднялся (порт слушается чуть раньше, чем приложение
          // готово ответить) — бэкофф (1с→2с→4с→8с) в редком случае может
          // унести реальный успех за пределы десятка секунд, это всё ещё
          // далеко от продуктового бюджета в 2 минуты.
          await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) =>
              waitForClassOnSelector(page, '#reconnect-banner', 'hidden', true, 45_000)
            )
          );
        }
      );

      await step('(з.б) тайлы и счётчик участников восстановились (3 участника = "3 / 6")', async () => {
        for (const page of [vasya2Page, petya2Page, olya2Page]) {
          await waitForTileCount(page, 3, 15_000);
          await waitParticipantCount(page, 3, 15_000);
        }
      });

      // Лидерство при рестарте сервера (см. README.md «Права и лидер»):
      // сервер теряет ВСЮ память (включая leader_id) при рестарте — комната
      // восстанавливается пустой через PUT /api/rooms/{id} и лидером
      // становится первый, кто успешно ре-джойнится (см.
      // src/main.rs::restore_room и src/ws.rs::JoinRoom). Кто из троих
      // ре-джойнится первым — гонка бэкоффов реконнекта (см.
      // static/room.js), НЕ гарантированно снова Вася. Здесь фиксируем
      // фактический исход и главное свойство: без дедлока и ровно один
      // лидер, на котором сходятся ВСЕ участники.
      await step(
        '(з.д) лидерство после рестарта сервера: ровно один лидер, сходятся все участники — фиксируем фактическое поведение',
        async () => {
          const leaderIds = await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) => page.evaluate(() => leaderId))
          );
          assert.ok(
            leaderIds.every((id) => id === leaderIds[0]),
            `все участники должны видеть ОДНОГО И ТОГО ЖЕ лидера (без дедлока/расхождения), получено: ${JSON.stringify(leaderIds)}`
          );
          assert.ok(leaderIds[0], 'leaderId не должен быть пустым после реконнекта');

          const nameByPeerId = {};
          for (const [label, page] of [['Вася', vasya2Page], ['Петя', petya2Page], ['Оля', olya2Page]]) {
            const myId = await page.evaluate(() => myPeerId);
            nameByPeerId[myId] = label;
          }
          console.log(
            `# фактическое поведение (лидерство при рестарте сервера): лидером остался(лась) ${
              nameByPeerId[leaderIds[0]] || leaderIds[0]
            }`
          );

          // Ровно один участник должен видеть корону на СВОЁМ тайле — не ноль
          // (лидер потерян) и не больше одного (несколько «лидеров» разом).
          const ownCrownFlags = await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) =>
              page.evaluate(() => !document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden'))
            )
          );
          assert.equal(
            ownCrownFlags.filter(Boolean).length,
            1,
            `ровно один участник должен видеть корону на своём тайле, получено: ${JSON.stringify(ownCrownFlags)}`
          );
        }
      );

      let screenRestoredActually = false;
      await step('(з.в) шаринг экрана Пети после реконнекта — фиксируем фактическое поведение', async () => {
        try {
          await waitScreenButtonOn(petya2Page, true, 15_000);
          await waitScreenStageHidden(olya2Page, false, 15_000);
          await assertVideoPlaying(olya2Page, { selector: '#screen-video' });
          screenRestoredActually = true;
        } catch (err) {
          screenRestoredActually = false;
          console.log(`[инфо] шаринг экрана Пети НЕ восстановился после реконнекта сервера: ${err.message}`);
        }
      });
      console.log(
        `# фактическое поведение (в): шаринг экрана после рестарта сервера ${
          screenRestoredActually ? 'ВОССТАНОВЛЕН (share-start успешно переигран)' : 'НЕ восстановлен (сцена честно ушла)'
        }`
      );

      await step('(з.г) P2P-чат работает и история на месте (клиентские буферы) после реконнекта', async () => {
        for (const page of [vasya2Page, petya2Page, olya2Page]) {
          await openChatPanel(page);
          const chat = await getChatDom(page);
          const texts = await chat.messages.allTextContents();
          assert.ok(texts.some((t) => t.includes('до рестарта')), 'история чата не сохранилась в клиентском буфере после реконнекта');
        }
        const msg3 = `после рестарта — ${Date.now()}`;
        await sendChatMessage(olya2Page, msg3);
        assert.ok(await messageTextsInclude(vasya2Page, msg3), 'новое сообщение после рестарта не дошло до Васи');
        assert.ok(await messageTextsInclude(petya2Page, msg3), 'новое сообщение после рестарта не дошло до Пети');
      });

      await step('(з.д) медиа живо: видео Васи у Пети продолжает идти (videoWidth растёт)', async () => {
        await assertVideoPlaying(petya2Page, { selector: `${tileSelector('Вася')} video` });
      });
    } else {
      skip('(з) рестарт сервера', 'подготовка не удалась');
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
