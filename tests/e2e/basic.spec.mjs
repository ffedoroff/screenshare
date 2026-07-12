#!/usr/bin/env node
// tests/e2e/basic.spec.mjs — браузерный e2e-тест протокола v2 (симметричная
// комната, mesh, шаринг экрана как временное состояние комнаты).
//
// Запуск: `node tests/e2e/basic.spec.mjs` (из каталога tests/e2e —
// предварительно `npm install`). Требуется системный Chrome (playwright-core
// браузеры не скачивает, используется channel: 'chrome').
//
// Сценарий: главная страница -> имя «Вася» -> «Создать комнату» -> дождаться
// перехода на /r/<id>; ещё двое участников («Петя», «Оля») открывают эту
// же ссылку; у всех троих по 3 тайла. Вася включает камеру и микрофон —
// у остальных живое видео в его тайле и speaking-индикация. Петя шарит
// экран — у Васи и Оли главная зона показывает поток, у Оли кнопка «Экран»
// задизейблена (экран занят). Петя останавливает показ — главная зона
// очищается у всех, комната остаётся живой (чат, тайлы на месте), и теперь
// Оля может начать свой показ. Под конец — Вася выключает микрофон и камеру
// обратно (toggle), проверяем, что индикация гаснет и заглушка появляется.
//
// Про getDisplayMedia/getUserMedia в автоматизации — см. helpers.mjs
// (installCaptureStub/installMicStub/installCamStub) и README.md: реальный
// захват экрана/камеры на этой macOS-машине недоступен (нет TCC-разрешений,
// выдать их неинтерактивно нельзя), поэтому по умолчанию тестовый арнесс
// сразу подменяет источники на синтетические (canvas.captureStream /
// Web Audio осциллятор) — WebRTC-транспорт (SDP/ICE/media) при этом
// проверяется по-настоящему. Попытка реального захвата включается теми же
// переменными окружения, что и раньше: E2E_TRY_REAL_CAPTURE=1,
// E2E_TRY_REAL_MIC=1, E2E_TRY_REAL_CAM=1.

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {
  REAL_CAPTURE_TIMEOUT_MS,
  REAL_MIC_TIMEOUT_MS,
  REAL_CAM_TIMEOUT_MS,
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
  sendChatMessageAndGetId,
  messageTextsInclude,
  getChatDom,
  waitUntil,
  makeTestPngBuffer,
  makeTestTextFileBuffer,
  attachFilesToChat,
} from './helpers.mjs';

const PORT = 3322;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
const server = createServerController(PORT);

// Общие стабы для контекста участника: сначала мик (иначе камера-стаб не
// сможет к нему делегировать audio-запросы, см. комментарий у installCamStub
// в helpers.mjs), потом камера, потом экран (отдельный API — порядок с
// остальными двумя не важен).
async function installMediaStubs(context) {
  const micArg = { tryReal: process.env.E2E_TRY_REAL_MIC === '1', timeoutMs: REAL_MIC_TIMEOUT_MS };
  const camArg = { tryReal: process.env.E2E_TRY_REAL_CAM === '1', timeoutMs: REAL_CAM_TIMEOUT_MS };
  const captureArg = { tryReal: process.env.E2E_TRY_REAL_CAPTURE === '1', timeoutMs: REAL_CAPTURE_TIMEOUT_MS };
  await context.addInitScript(installMicStub(), micArg);
  await context.addInitScript(installCamStub(), camArg);
  await context.addInitScript(installCaptureStub(), captureArg);
}

async function waitForTileCount(page, expected, timeoutMs = 8000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.tile').length === n,
    expected,
    { polling: 100, timeout: timeoutMs }
  );
}

async function tileSelector(name) {
  return `.tile[data-name="${name}"]`;
}

async function waitOverlayTitle(page, expectedTitle, timeoutMs = 10_000) {
  await page.waitForFunction(
    (title) => document.getElementById('overlay-title')?.textContent === title,
    expectedTitle,
    { polling: 100, timeout: timeoutMs }
  );
}

/** Корона видна (не .hidden) на тайле `selector .tile-crown`. */
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

// --- Шпион на WebSocket: перехватывает КАЖДЫЙ send() страницы и запоминает
// фреймы с type === 'chat' (см. src/protocol.rs::ClientMessage::Chat —
// адресный fallback-релей). Ф1: чат теперь целиком на mesh RTCDataChannel
// (см. static/chat.js/bus.js) — fallback через сервер срабатывает, только
// если DataChannel-шина до конкретного пира не открыта. При живом
// установившемся mesh (как в этом тесте — WebRTC уже давно поднят к
// моменту отправки чата) фреймов 'chat' в серверном сокете быть не должно
// вообще ни у одного из участников. Ставится ДО первой навигации
// (addInitScript выполняется при каждой загрузке страницы контекста).
function installChatWsSpy(context) {
  return context.addInitScript(() => {
    window.__e2eChatFramesSent = [];
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(...args) {
        super(...args);
        const realSend = this.send.bind(this);
        this.send = (data) => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.type === 'chat') {
              window.__e2eChatFramesSent.push(parsed);
            }
          } catch {
            // не строка/не JSON — точно не наш chat-фрейм
          }
          return realSend(data);
        };
      }
    };
  });
}

async function chatFramesSentOn(page) {
  return page.evaluate(() => window.__e2eChatFramesSent || []);
}

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

    // --- Вася: главная страница -> имя -> создать комнату ---
    const vasyaContext = await browser.newContext();
    await installMediaStubs(vasyaContext);
    await installChatWsSpy(vasyaContext);
    await installPcRegistry(vasyaContext);
    const vasyaPage = await vasyaContext.newPage();

    let roomId = null;
    const roomCreatedOk = await step('Вася: главная страница -> создаёт комнату -> вводит имя в модалке входа комнаты -> становится лидером (корона)', async () => {
      await vasyaPage.goto(server.baseUrl);
      await vasyaPage.click('#create-room-button');
      await vasyaPage.waitForURL(/\/r\/[^/]+/, { timeout: 10_000 });
      // Лендинг больше не спрашивает имя (анонимность — см. static/landing.js) —
      // роль извлекается из /r/<id>#lt=<token>. Фрагмент не матчим "$": он
      // может быть уже вычищен к этому моменту через history.replaceState
      // (см. static/room.js), а может ещё нет — регэксп безразличен к обоим случаям.
      const match = vasyaPage.url().match(/\/r\/([^/#]+)/);
      assert.ok(match, `не удалось извлечь roomId из URL: ${vasyaPage.url()}`);
      roomId = match[1];
      await joinRoom(vasyaPage, 'Вася');
      await waitForOverlayHidden(vasyaPage);

      // Создатель предъявил leaderToken из фрагмента ссылки — стал лидером:
      // корона на своём тайле.
      await vasyaPage.waitForFunction(
        () => !document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 5000 }
      );
    });

    if (!roomCreatedOk || !roomId) {
      console.log('FAIL - критическая ошибка: комната не создана, дальнейшие проверки невозможны');
      skip('Петя и Оля подключаются', 'комната не создана');
      skip('видео/аудио/шаринг экрана/чат', 'комната не создана');
      return;
    }

    const roomUrl = `${server.baseUrl}/r/${roomId}`;

    // --- Петя и Оля открывают ту же ссылку ---
    const petyaContext = await browser.newContext();
    const olyaContext = await browser.newContext();
    await installMediaStubs(petyaContext);
    await installMediaStubs(olyaContext);
    await installChatWsSpy(petyaContext);
    await installChatWsSpy(olyaContext);
    await installPcRegistry(petyaContext);
    await installPcRegistry(olyaContext);
    const petyaPage = await petyaContext.newPage();
    const olyaPage = await olyaContext.newPage();

    const everyoneJoinedOk = await step('Петя и Оля открывают ссылку комнаты (модалка входа), у всех троих по 3 тайла, корона только у Васи', async () => {
      await petyaPage.goto(roomUrl);
      await olyaPage.goto(roomUrl);
      await joinRoom(petyaPage, 'Петя');
      await joinRoom(olyaPage, 'Оля');
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);

      // waitForMeshSettled ждёт и тайлы, и что у всех троих обе mesh-связи
      // (шина + сигналинг) реально дошли до connected — см. helpers.mjs.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });

      // (а) Вася — лидер (корона на его тайле у остальных), у Пети/Оли короны нет.
      const vasyaTileSel = await tileSelector('Вася');
      for (const page of [petyaPage, olyaPage]) {
        await page.waitForFunction(
          (sel) => !document.querySelector(`${sel} .tile-crown`)?.classList.contains('hidden'),
          vasyaTileSel,
          { polling: 100, timeout: 5000 }
        );
      }
      for (const [label, page] of [['Петя', petyaPage], ['Оля', olyaPage]]) {
        const ownCrownHidden = await page.evaluate(
          () => document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden')
        );
        assert.equal(ownCrownHidden, true, `у ${label} на своём тайле не должно быть короны`);
      }
    });

    if (!everyoneJoinedOk) {
      console.log('FAIL - критическая ошибка: не удалось собрать всех троих в комнате, дальнейшие проверки невозможны');
      skip('камера/микрофон/экран/чат', 'участники не собрались');
      return;
    }

    // --- Вася включает камеру ---
    const vasyaTileSel = await tileSelector('Вася');
    const camOk = await step('Вася включает камеру — у Пети и Оли живое видео в его тайле', async () => {
      await vasyaPage.click('#camera-button');
      for (const [label, page] of [['Петя', petyaPage], ['Оля', olyaPage]]) {
        await assertVideoPlaying(page, { selector: `${vasyaTileSel} video` });
      }
    });
    if (!camOk) {
      skip('микрофон/спикинг', 'камера Васи не заработала');
    }

    // --- Вася включает микрофон ---
    const micOk = await step('Вася включает микрофон — у Пети и Оли speaking-индикация на его тайле', async () => {
      await vasyaPage.click('#mic-button');
      for (const page of [petyaPage, olyaPage]) {
        await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', true, 8000);
      }
    });

    // --- Петя шарит экран ---
    const petyaShareOk = await step('Петя шарит экран — главная зона у Васи и Оли показывает поток, у Оли кнопка «Экран» задизейблена', async () => {
      await petyaPage.click('#screen-button');

      await petyaPage.waitForFunction(
        () => document.getElementById('screen-button')?.classList.contains('control-button--on'),
        undefined,
        { polling: 100, timeout: 8000 }
      );

      for (const page of [vasyaPage, olyaPage]) {
        await assertVideoPlaying(page, { selector: '#screen-video' });
      }

      await olyaPage.waitForFunction(
        () => document.getElementById('screen-button')?.disabled === true,
        undefined,
        { polling: 100, timeout: 5000 }
      );
    });
    if (!petyaShareOk) {
      skip('Петя прекращает показ', 'шаринг экрана не заработал');
      skip('Оля начинает свой показ', 'шаринг экрана не заработал');
    }

    // --- Петя прекращает показ ---
    let stopShareOk = false;
    if (petyaShareOk) {
      stopShareOk = await step('Петя прекращает показ — главная зона очищается у всех, комната жива', async () => {
        await petyaPage.click('#screen-button');

        for (const page of [vasyaPage, petyaPage, olyaPage]) {
          await page.waitForFunction(
            () => document.getElementById('screen-stage')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 8000 }
          );
        }

        // Комната жива: тайлы на месте, чат ходит между всеми.
        for (const page of [vasyaPage, petyaPage, olyaPage]) {
          await waitForTileCount(page, 3, 3000);
        }

        await openChatPanel(vasyaPage);
        await openChatPanel(petyaPage);
        await openChatPanel(olyaPage);
        const text = `Привет от Васи — ${Date.now()}`;
        await sendChatMessage(vasyaPage, text);
        assert.ok(await messageTextsInclude(vasyaPage, text), 'сообщение не появилось у самого отправителя (Вася)');
        assert.ok(await messageTextsInclude(petyaPage, text), 'сообщение не дошло до Пети');
        assert.ok(await messageTextsInclude(olyaPage, text), 'сообщение не дошло до Оли');

        // И в обратную сторону — от Пети всем, чтобы шпион ниже видел трафик
        // по каждой из трёх сторон, а не только от Васи.
        const text2 = `Ответ от Пети — ${Date.now()}`;
        await sendChatMessage(petyaPage, text2);
        assert.ok(await messageTextsInclude(vasyaPage, text2), 'ответное сообщение не дошло до Васи');
        assert.ok(await messageTextsInclude(petyaPage, text2), 'ответное сообщение не появилось у самого отправителя (Петя)');
        assert.ok(await messageTextsInclude(olyaPage, text2), 'ответное сообщение не дошло до Оли');
      });
    }

    // --- Живой mesh: чат не должен был использовать серверный fallback ---
    if (stopShareOk) {
      await step(
        'Ни один chat-фрейм не ушёл в серверный WebSocket ни у кого из троих (mesh давно установлен, DataChannel-шина открыта)',
        async () => {
          for (const [label, page] of [['Вася', vasyaPage], ['Петя', petyaPage], ['Оля', olyaPage]]) {
            const frames = await chatFramesSentOn(page);
            assert.equal(
              frames.length,
              0,
              `у ${label} в серверный сокет ушли chat-фреймы (ожидали 0, DataChannel-шина должна была быть открыта): ${JSON.stringify(frames)}`
            );
          }
        }
      );
    } else {
      skip('проверка "чат не идёт через сервер"', 'обмен сообщениями в предыдущем шаге не выполнен');
    }

    // --- Оля теперь может начать шаринг ---
    if (stopShareOk) {
      await step('Оля начинает свой показ экрана — кнопка активна, share-started проходит', async () => {
        const disabledBefore = await olyaPage.evaluate(() => document.getElementById('screen-button')?.disabled);
        assert.equal(disabledBefore, false, 'кнопка «Экран» у Оли должна быть активна после освобождения экрана');

        await olyaPage.click('#screen-button');
        await olyaPage.waitForFunction(
          () => document.getElementById('screen-button')?.classList.contains('control-button--on'),
          undefined,
          { polling: 100, timeout: 8000 }
        );
        // Собственное превью в главной зоне появляется сразу же, без ожидания WebRTC.
        await olyaPage.waitForFunction(
          () => !document.getElementById('screen-stage')?.classList.contains('hidden'),
          undefined,
          { polling: 100, timeout: 5000 }
        );
      });
    } else {
      skip('Оля начинает свой показ', 'экран не был освобождён Петей');
    }

    // --- Вася выключает микрофон и камеру обратно ---
    if (micOk) {
      await step('Вася выключает микрофон повторным кликом — speaking-индикация гаснет у остальных', async () => {
        await vasyaPage.click('#mic-button');
        for (const page of [petyaPage, olyaPage]) {
          await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', false, 6000);
        }
      });
    } else {
      skip('Вася выключает микрофон', 'микрофон не был успешно включён ранее');
    }

    if (camOk) {
      await step('Вася выключает камеру — у Пети появляется заглушка вместо видео', async () => {
        await vasyaPage.click('#camera-button');
        await petyaPage.waitForFunction(
          (sel) => {
            const video = document.querySelector(`${sel} video`);
            const placeholder = document.querySelector(`${sel} .tile-placeholder`);
            return !!video && !!placeholder && video.classList.contains('hidden') && !placeholder.classList.contains('hidden');
          },
          vasyaTileSel,
          { polling: 100, timeout: 8000 }
        );
      });
    } else {
      skip('Вася выключает камеру', 'камера не была успешно включена ранее');
    }

    // --- Попап «Поделиться»: QR (серверный SVG) + ссылка вида /r/<id> ---
    await step('Вася открывает попап «Поделиться» — QR грузится, ссылка ведёт на /r/<id>', async () => {
      await vasyaPage.click('#share-button');
      await vasyaPage.waitForSelector('#share-popup:not(.hidden)', { timeout: 5000 });

      const qrSrc = await vasyaPage.getAttribute('#share-popup-qr', 'src');
      assert.ok(
        qrSrc && qrSrc.includes(`/qr.svg?room=${roomId}`),
        `src у QR-картинки должен указывать на /qr.svg?room=${roomId}, получено: ${qrSrc}`
      );

      // Картинка реально загрузилась (не просто есть атрибут src).
      await vasyaPage.waitForFunction(
        () => (document.getElementById('share-popup-qr')?.naturalWidth || 0) > 0,
        undefined,
        { polling: 100, timeout: 5000 }
      );

      // И отдельно — что сервер реально отдаёт SVG с 200 (а не просто картинка
      // как-то отрендерилась благодаря кэшу браузера).
      const qrUrl = new URL(qrSrc, roomUrl).toString();
      const res = await fetch(qrUrl);
      assert.equal(res.status, 200, `GET ${qrUrl} должен вернуть 200, получено ${res.status}`);
      assert.match(
        res.headers.get('content-type') || '',
        /image\/svg\+xml/,
        'content-type ответа /qr.svg должен быть image/svg+xml'
      );

      const linkText = (await vasyaPage.textContent('#share-popup-link')) || '';
      assert.match(
        linkText.trim(),
        new RegExp(`/r/${roomId}$`),
        `ссылка в попапе должна быть вида /r/${roomId}, получено: ${linkText}`
      );

      await vasyaPage.click('#share-popup-close');
      // Не page.waitForSelector('#share-popup.hidden') — по умолчанию он ждёт
      // видимость совпавшего элемента, а .hidden — это display:none (см.
      // такой же приём в helpers.mjs::waitForOverlayHidden), поэтому такой
      // селектор никогда бы не срезолвился.
      await vasyaPage.waitForFunction(
        () => document.getElementById('share-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 5000 }
      );
    });

    await vasyaContext.close();
    await petyaContext.close();
    await olyaContext.close();

    // --- История чата: третий участник входит ПОСЛЕ двух сообщений и видит
    // их, получив по DataChannel от пира (не через серверную историю — её
    // больше нет, см. src/ws.rs/README.md) ---
    await step(
      'История чата: третий участник входит после двух сообщений и видит их, получив по DataChannel',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: histRoomId } = await res.json();
        const histRoomUrl = `${server.baseUrl}/r/${histRoomId}`;

        const igorContext = await browser.newContext();
        const nastyaContext = await browser.newContext();
        const igorPage = await igorContext.newPage();
        const nastyaPage = await nastyaContext.newPage();

        try {
          await igorPage.goto(histRoomUrl);
          await nastyaPage.goto(histRoomUrl);
          await joinRoom(igorPage, 'Игорь');
          await joinRoom(nastyaPage, 'Настя');
          await waitForOverlayHidden(igorPage);
          await waitForOverlayHidden(nastyaPage);
          await waitForTileCount(igorPage, 2);
          await waitForTileCount(nastyaPage, 2);

          await openChatPanel(igorPage);
          await openChatPanel(nastyaPage);

          const msg1 = `История-1-${Date.now()}`;
          await sendChatMessage(igorPage, msg1);
          assert.ok(await messageTextsInclude(nastyaPage, msg1), 'первое сообщение не дошло до второго участника (до входа третьего)');

          const msg2 = `История-2-${Date.now()}`;
          await sendChatMessage(nastyaPage, msg2);
          assert.ok(await messageTextsInclude(igorPage, msg2), 'второе сообщение не дошло до первого участника (до входа третьего)');

          // Третий участник — со шпионом на WS: доказываем, что и сама
          // история (history-request/history-response, см. static/chat.js)
          // тоже целиком по DataChannel, без обращения к серверу.
          const tretyContext = await browser.newContext();
          await installChatWsSpy(tretyContext);
          const tretyPage = await tretyContext.newPage();
          try {
            await tretyPage.goto(histRoomUrl);
            await joinRoom(tretyPage, 'Третий');
            await waitForOverlayHidden(tretyPage);
            await waitForTileCount(tretyPage, 3);

            await openChatPanel(tretyPage);
            assert.ok(
              await messageTextsInclude(tretyPage, msg1),
              'третий участник не увидел историческое сообщение 1 (ожидали получение по DataChannel от пира)'
            );
            assert.ok(
              await messageTextsInclude(tretyPage, msg2),
              'третий участник не увидел историческое сообщение 2 (ожидали получение по DataChannel от пира)'
            );

            const frames = await chatFramesSentOn(tretyPage);
            assert.equal(
              frames.length,
              0,
              `история должна была прийти третьему участнику по DataChannel, а не через серверный fallback: ${JSON.stringify(frames)}`
            );
          } finally {
            await tretyContext.close();
          }
        } finally {
          await igorContext.close();
          await nastyaContext.close();
        }
      }
    );

    // --- Форматирование, реплаи и реакции (Ф2) ---
    //
    // Отдельная комната, трое участников с самого начала (Аня, Боря, Витя —
    // нужны для проверки "реакция видна ДРУГИМ участникам" (в), пока не
    // ушедшим и не только автору), плюс четвёртый — Гриша — заходит ПОЗЖЕ,
    // уже после того как сообщение и реакция отправлены: он должен увидеть
    // и то, и другое из реплея истории (г), а не из живого эфира.
    await step(
      'Форматирование (bold/italic/strike/ссылка, <script> не исполняется), реплай с цитатой, реакции (live + из истории у опоздавшего)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: fmtRoomId } = await res.json();
        const fmtRoomUrl = `${server.baseUrl}/r/${fmtRoomId}`;

        const aContext = await browser.newContext();
        const bContext = await browser.newContext();
        const cContext = await browser.newContext();
        const aPage = await aContext.newPage();
        const bPage = await bContext.newPage();
        const cPage = await cContext.newPage();

        try {
          await aPage.goto(fmtRoomUrl);
          await bPage.goto(fmtRoomUrl);
          await cPage.goto(fmtRoomUrl);
          await joinRoom(aPage, 'Аня');
          await joinRoom(bPage, 'Боря');
          await joinRoom(cPage, 'Витя');
          await waitForOverlayHidden(aPage);
          await waitForOverlayHidden(bPage);
          await waitForOverlayHidden(cPage);
          await waitForTileCount(aPage, 3);
          await waitForTileCount(bPage, 3);
          await waitForTileCount(cPage, 3);

          await openChatPanel(aPage);
          await openChatPanel(bPage);
          await openChatPanel(cPage);

          // --- (а) форматирование: **bold** *italic* ~~strike~~ + ссылка + <script> ---
          const fmtText =
            '**wow** *si* ~~no~~ https://example.com/page and <script>window.__e2eXss=1</script>';
          await sendChatMessage(aPage, fmtText);
          await messageTextsInclude(bPage, fmtText).catch(() => {}); // подождать доставки (сравнение ниже по DOM, не по чистому тексту)

          const bFmtMsg = bPage
            .locator('.chat-message', { hasText: 'wow' })
            .filter({ hasText: 'example.com' })
            .last();
          await bFmtMsg.locator('strong').first().waitFor({ state: 'visible', timeout: 5000 });

          const strongText = await bFmtMsg.locator('strong').first().textContent();
          assert.equal(strongText, 'wow', `<strong> должен содержать "wow", получено: ${strongText}`);
          const emText = await bFmtMsg.locator('em').first().textContent();
          assert.equal(emText, 'si', `<em> должен содержать "si", получено: ${emText}`);
          const delText = await bFmtMsg.locator('del').first().textContent();
          assert.equal(delText, 'no', `<del> должен содержать "no", получено: ${delText}`);

          const linkEl = bFmtMsg.locator('a').first();
          const linkHref = await linkEl.getAttribute('href');
          assert.equal(
            linkHref,
            'https://example.com/page',
            `ссылка должна вести на https://example.com/page, получено: ${linkHref}`
          );
          assert.equal(await linkEl.getAttribute('target'), '_blank', 'ссылка должна открываться в новой вкладке');
          const linkRel = (await linkEl.getAttribute('rel')) || '';
          assert.ok(
            linkRel.includes('noopener') && linkRel.includes('noreferrer'),
            `rel ссылки должен включать noopener noreferrer, получено: ${linkRel}`
          );

          const bFmtText = await bFmtMsg.locator('.chat-message-text').textContent();
          assert.ok(!bFmtText.includes('**'), `сырых "**" не должно остаться в рендере: ${bFmtText}`);
          assert.ok(!bFmtText.includes('~~'), `сырых "~~" не должно остаться в рендере: ${bFmtText}`);
          assert.ok(
            bFmtText.includes('<script>'),
            `текст "<script>..." должен присутствовать как ВИДИМЫЙ текст: ${bFmtText}`
          );

          const xssRan = await bPage.evaluate(() => window.__e2eXss);
          assert.equal(xssRan, undefined, '<script> из текста сообщения не должен исполниться');
          const scriptTagCount = await bPage.evaluate(
            () => document.querySelectorAll('.chat-message-text script').length
          );
          assert.equal(scriptTagCount, 0, 'тег <script> не должен появиться как реальный DOM-элемент');

          // --- (б) реплай: у получателя видна цитата с именем автора оригинала ---
          const originalText = `Оригинал-от-Бори-${Date.now()}`;
          await sendChatMessage(bPage, originalText);
          assert.ok(await messageTextsInclude(aPage, originalText), 'оригинал не дошёл до Ани');
          assert.ok(await messageTextsInclude(cPage, originalText), 'оригинал не дошёл до Вити');

          const aOriginalMsg = aPage.locator('.chat-message', { hasText: originalText }).last();
          await aOriginalMsg.hover();
          await aOriginalMsg.locator('.chat-message-action--reply').click();
          await aPage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const replyBarText = (await aPage.locator('.chat-reply-bar-text').textContent()) || '';
          assert.ok(replyBarText.includes('Боря'), `плашка реплая должна упоминать автора оригинала «Боря»: ${replyBarText}`);

          const replyText = `Реплай-от-Ани-${Date.now()}`;
          await sendChatMessage(aPage, replyText);
          assert.ok(await messageTextsInclude(bPage, replyText), 'реплай не дошёл до Бори');

          const bReplyMsg = bPage.locator('.chat-message', { hasText: replyText }).last();
          const quoteNameText = await bReplyMsg.locator('.chat-reply-quote-name').textContent();
          assert.ok(
            quoteNameText.includes('Боря'),
            `цитата реплая у получателя должна показывать имя автора оригинала «Боря»: ${quoteNameText}`
          );

          // --- (в) реакции: Аня ставит 👍 на сообщение Бори -> у Бори и Вити чип «👍 1»; toggle убирает ---
          const aTargetMsg = aPage.locator('.chat-message', { hasText: originalText }).last();
          await aTargetMsg.hover();
          await aTargetMsg.locator('.chat-message-action--react').click();
          await aPage.locator('.chat-reaction-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await aPage.locator('.chat-reaction-popover-emoji[data-emoji="👍"]').click();

          const bTargetMsg = bPage.locator('.chat-message', { hasText: originalText }).last();
          const cTargetMsg = cPage.locator('.chat-message', { hasText: originalText }).last();
          await bTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
          await cTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
          const bChipText = await bTargetMsg.locator('.chat-reaction-chip').first().textContent();
          const cChipText = await cTargetMsg.locator('.chat-reaction-chip').first().textContent();
          assert.ok(bChipText.includes('👍') && bChipText.includes('1'), `у Бори должен появиться чип «👍 1»: ${bChipText}`);
          assert.ok(cChipText.includes('👍') && cChipText.includes('1'), `у Вити должен появиться чип «👍 1»: ${cChipText}`);

          // toggle: повторный клик своей же реакции убирает её у всех
          await aTargetMsg.hover();
          await aTargetMsg.locator('.chat-message-action--react').click();
          await aPage.locator('.chat-reaction-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await aPage.locator('.chat-reaction-popover-emoji[data-emoji="👍"]').click();

          await waitUntil(async () => (await bTargetMsg.locator('.chat-reaction-chip').count()) === 0, {
            timeoutMs: 5000,
            message: 'чип реакции должен исчезнуть у Бори после toggle-удаления',
          });
          await waitUntil(async () => (await cTargetMsg.locator('.chat-reaction-chip').count()) === 0, {
            timeoutMs: 5000,
            message: 'чип реакции должен исчезнуть у Вити после toggle-удаления',
          });

          // ставим реакцию заново — она должна быть в истории для опоздавшего (г)
          await aTargetMsg.hover();
          await aTargetMsg.locator('.chat-message-action--react').click();
          await aPage.locator('.chat-reaction-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await aPage.locator('.chat-reaction-popover-emoji[data-emoji="👍"]').click();
          await bTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });

          // --- (г) опоздавший (Гриша) видит и сообщение, и реакцию из истории ---
          const dContext = await browser.newContext();
          const dPage = await dContext.newPage();
          try {
            await dPage.goto(fmtRoomUrl);
            await joinRoom(dPage, 'Гриша');
            await waitForOverlayHidden(dPage);
            await waitForTileCount(dPage, 4);
            await openChatPanel(dPage);

            assert.ok(
              await messageTextsInclude(dPage, originalText),
              'опоздавший не увидел историческое сообщение по DataChannel'
            );

            const dTargetMsg = dPage.locator('.chat-message', { hasText: originalText }).last();
            await dTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
            const dChipText = await dTargetMsg.locator('.chat-reaction-chip').first().textContent();
            assert.ok(
              dChipText.includes('👍') && dChipText.includes('1'),
              `опоздавший должен увидеть чип «👍 1» из реплея истории: ${dChipText}`
            );
          } finally {
            await dContext.close();
          }
        } finally {
          await aContext.close();
          await bContext.close();
          await cContext.close();
        }
      }
    );

    // --- Редактирование и удаление своих сообщений ---
    //
    // Отдельная комната: Инна и Паша с самого начала (Паша нужен, чтобы видеть
    // и правки, и удаление "живьём", а не только у автора). Два независимых
    // сообщения — М1 редактируют (но не удаляют), М2 сначала получает реакцию
    // от Паши, потом удаляется — так тесты (а)/(б) не смешивают эффекты, и
    // опоздавший Слава (в) может отдельно проверить оба производных состояния
    // (отредактированный текст и тумбстоун) из реплея истории. Негативный
    // случай (г) — подделанный конверт 'edit' с чужим `from`, вброшенный
    // напрямую в обработчик шины (bus._dispatch) у Паши, минуя реальный
    // DataChannel: bus — обычный top-level `const` в room.js (классический,
    // не module, script) и потому виден из page.evaluate() ровно так же, как
    // ChatPanel виден из room.js (тот же общий top-level scope документа).
    await step(
      'Редактирование (текст + «(изменено)») и удаление (тумбстоун, реакции пропадают) своих сообщений, включая реплей опоздавшему и игнор чужого from',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: editRoomId } = await res.json();
        const editRoomUrl = `${server.baseUrl}/r/${editRoomId}`;

        const iContext = await browser.newContext();
        const pContext = await browser.newContext();
        const iPage = await iContext.newPage();
        const pPage = await pContext.newPage();

        try {
          await iPage.goto(editRoomUrl);
          await pPage.goto(editRoomUrl);
          await joinRoom(iPage, 'Инна');
          await joinRoom(pPage, 'Паша');
          await waitForOverlayHidden(iPage);
          await waitForOverlayHidden(pPage);
          await waitForTileCount(iPage, 2);
          await waitForTileCount(pPage, 2);

          await openChatPanel(iPage);
          await openChatPanel(pPage);

          // --- (а) редактирование: М1 ---
          const original1 = `Оригинал-1-${Date.now()}`;
          const msg1Id = await sendChatMessageAndGetId(iPage, original1);
          assert.ok(msg1Id, 'не удалось получить id только что отправленного сообщения М1 у Инны');
          assert.ok(await messageTextsInclude(pPage, original1), 'М1 не дошло до Паши');

          const iMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
          await iPage.locator(iMsg1Sel).hover();
          await iPage.locator(iMsg1Sel).locator('.chat-message-action--edit').click();
          await iPage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const editBarValue = await iPage.locator('.chat-text-input').inputValue();
          assert.equal(editBarValue, original1, `textarea при открытии редактирования должна содержать текущий текст М1: ${editBarValue}`);

          const edited1 = `Правка-1-${Date.now()}`;
          await iPage.locator('.chat-text-input').fill(edited1);
          await iPage.locator('.chat-send-button').click();

          // У автора (Инна): новый текст + «(изменено)», плашка редактирования закрылась.
          await iPage.locator(`${iMsg1Sel} .chat-message-text`).filter({ hasText: edited1 }).waitFor({ timeout: 5000 });
          // НЕ locator('.chat-edit-bar.hidden').waitFor(), т.к. .hidden — это
          // display:none и по умолчанию waitFor ждёт ВИДИМОСТЬ совпавшего
          // элемента (см. такой же приём в helpers.mjs::waitForOverlayHidden) —
          // проверяем classList напрямую через waitForFunction.
          await iPage.waitForFunction(
            () => document.querySelector('.chat-edit-bar')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const iMeta1 = await iPage.locator(`${iMsg1Sel} .chat-message-meta-edited`).count();
          assert.ok(iMeta1 > 0, 'у автора после редактирования должна появиться пометка «(изменено)»');

          // У Паши (не автор): тот же новый текст + та же пометка, оригинал пропал.
          const pMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
          await waitUntil(
            async () => (await pPage.locator(`${pMsg1Sel} .chat-message-text`).textContent())?.includes(edited1),
            { timeoutMs: 5000, message: 'у Паши текст М1 должен смениться на отредактированный' }
          );
          const pMeta1 = await pPage.locator(`${pMsg1Sel} .chat-message-meta-edited`).count();
          assert.ok(pMeta1 > 0, 'у Паши тоже должна быть видна пометка «(изменено)»');
          assert.ok(!(await messageTextsInclude(pPage, original1, 300)), 'оригинальный текст М1 не должен остаться в ленте у Паши после правки');

          // --- (б) удаление: М2 (сначала получает реакцию от Паши, потом удаляется) ---
          const original2 = `Оригинал-2-${Date.now()}`;
          const msg2Id = await sendChatMessageAndGetId(iPage, original2);
          assert.ok(msg2Id, 'не удалось получить id только что отправленного сообщения М2 у Инны');
          assert.ok(await messageTextsInclude(pPage, original2), 'М2 не дошло до Паши');

          const iMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;
          const pMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;

          await pPage.locator(pMsg2Sel).hover();
          await pPage.locator(pMsg2Sel).locator('.chat-message-action--react').click();
          await pPage.locator('.chat-reaction-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await pPage.locator('.chat-reaction-popover-emoji[data-emoji="👍"]').click();
          await iPage.locator(`${iMsg2Sel} .chat-reaction-chip`).first().waitFor({ state: 'visible', timeout: 5000 });

          await iPage.locator(iMsg2Sel).hover();
          const iDeleteBtn2 = iPage.locator(iMsg2Sel).locator('.chat-message-action--delete');
          await iDeleteBtn2.click(); // первый клик — переход в состояние подтверждения
          await iPage.locator(`${iMsg2Sel} .chat-message-action--confirm`).waitFor({ timeout: 2000 });
          await iDeleteBtn2.click(); // второй клик в течение 3с — подтверждение, шлём delete

          // У автора: тумбстоун вместо текста, реакции и кнопки действий пропали.
          await iPage.locator(`${iMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
          const iTombstoneText = await iPage.locator(`${iMsg2Sel} .chat-message-text`).textContent();
          assert.equal(iTombstoneText, 'Сообщение удалено', `тумбстоун у автора должен показывать «Сообщение удалено»: ${iTombstoneText}`);
          assert.equal(await iPage.locator(`${iMsg2Sel} .chat-reaction-chip`).count(), 0, 'у автора чипы реакций должны исчезнуть у удалённого сообщения');
          assert.equal(await iPage.locator(`${iMsg2Sel} .chat-message-actions`).count(), 0, 'у тумбстоуна не должно быть кнопок действий');

          // У Паши: то же самое — тумбстоун, чипы реакций пропали.
          await pPage.locator(`${pMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
          const pTombstoneText = await pPage.locator(`${pMsg2Sel} .chat-message-text`).textContent();
          assert.equal(pTombstoneText, 'Сообщение удалено', `тумбстоун у Паши должен показывать «Сообщение удалено»: ${pTombstoneText}`);
          await waitUntil(async () => (await pPage.locator(`${pMsg2Sel} .chat-reaction-chip`).count()) === 0, {
            timeoutMs: 5000,
            message: 'у Паши чипы реакций должны исчезнуть у удалённого сообщения',
          });

          // --- (в) опоздавший (Слава) видит из реплея истории: отредактированный
          //     текст М1 (не оригинал) и тумбстоун вместо удалённого М2 ---
          const sContext = await browser.newContext();
          const sPage = await sContext.newPage();
          try {
            await sPage.goto(editRoomUrl);
            await joinRoom(sPage, 'Слава');
            await waitForOverlayHidden(sPage);
            await waitForTileCount(sPage, 3);
            await openChatPanel(sPage);

            assert.ok(
              await messageTextsInclude(sPage, edited1),
              'опоздавший должен увидеть отредактированный текст М1 из реплея истории'
            );
            assert.ok(
              !(await messageTextsInclude(sPage, original1, 300)),
              'опоздавший НЕ должен увидеть оригинальный (не отредактированный) текст М1'
            );
            const sMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
            assert.ok(
              (await sPage.locator(`${sMsg1Sel} .chat-message-meta-edited`).count()) > 0,
              'опоздавший должен увидеть пометку «(изменено)» у М1'
            );

            const sMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;
            await sPage.locator(`${sMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
            const sTombstoneText = await sPage.locator(`${sMsg2Sel} .chat-message-text`).textContent();
            assert.equal(
              sTombstoneText,
              'Сообщение удалено',
              `опоздавший должен увидеть тумбстоун вместо оригинала М2: ${sTombstoneText}`
            );
            assert.ok(
              !(await messageTextsInclude(sPage, original2, 300)),
              'опоздавший НЕ должен увидеть оригинальный текст удалённого М2'
            );
          } finally {
            await sContext.close();
          }

          // --- (г) негатив: конверт 'edit' с ЧУЖИМ from — должен быть проигнорирован ---
          // Прямая инъекция в обработчик шины у Паши (bus._dispatch), минуя
          // реальный DataChannel: имитируем злоумышленника, который прислал бы
          // envelope с kind='edit' и подделанным `from`, целясь в М1 (сейчас
          // отображается как `edited1` у Паши, автор — Инна с ЕЁ настоящим peerId).
          const forgedResult = await pPage.evaluate(
            ({ targetId }) => {
              bus._dispatch('forged-peer-id-not-the-real-author', {
                v: 1,
                id: 'forged-edit-envelope-id',
                lamport: 999999,
                from: 'forged-peer-id-not-the-real-author',
                name: 'Мошенник',
                kind: 'edit',
                target: targetId,
                text: 'ВЗЛОМАНО',
                ts: Date.now(),
              });
              const el = document.querySelector(`.chat-message[data-msg-id="${targetId}"] .chat-message-text`);
              return el ? el.textContent : null;
            },
            { targetId: msg1Id }
          );
          assert.equal(
            forgedResult,
            edited1,
            `конверт edit с чужим from должен быть проигнорирован — текст должен остаться «${edited1}», получено: ${forgedResult}`
          );
          assert.ok(
            !(await messageTextsInclude(pPage, 'ВЗЛОМАНО', 300)),
            'подделанный текст «ВЗЛОМАНО» не должен появиться в ленте у Паши'
          );
        } finally {
          await iContext.close();
          await pContext.close();
        }
      }
    );

    // --- Передача файлов (Ф3): строго P2P, лениво по запросу ---
    //
    // Отдельная комната, Женя и Захар с самого начала (mesh дожидаемся явно —
    // файловый DataChannel, в отличие от текста/реакций, не имеет серверного
    // фоллбэка вовсе, поэтому гонка "канал шины ещё не открылся" тут не
    // должна маскироваться удачным таймингом). Женя отправляет картинку
    // ~50КБ (а) — авто-скачивание, инлайн-превью у Захара; затем "файл"
    // ~300КБ text/plain (б) — Захар жмёт «Скачать», ждём исчезновения
    // прогресса и сверяем итоговый Blob побайтово. Иван заходит ПОЗЖЕ, уже
    // после отправки обоих файлов (в) — видит карточки из истории (не
    // живьём) и всё ещё может их запросить, пока Женя (исходный отправитель)
    // в комнате.
    await step(
      'Передача файлов: авто-скачивание картинки, ручное скачивание файла с прогрессом и сверкой размера, опоздавший скачивает из истории',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: fileRoomId } = await res.json();
        const fileRoomUrl = `${server.baseUrl}/r/${fileRoomId}`;

        const eContext = await browser.newContext();
        const fContext = await browser.newContext();
        await installPcRegistry(eContext);
        await installPcRegistry(fContext);
        const ePage = await eContext.newPage();
        const fPage = await fContext.newPage();

        try {
          await ePage.goto(fileRoomUrl);
          await fPage.goto(fileRoomUrl);
          await joinRoom(ePage, 'Женя');
          await joinRoom(fPage, 'Захар');
          await waitForOverlayHidden(ePage);
          await waitForOverlayHidden(fPage);
          // Именно waitForMeshSettled (не просто waitForTileCount) — файловый
          // DataChannel требует РЕАЛЬНО открытой шины до конкретного пира, у
          // текста/реакций есть серверный фоллбэк, у байтов файла — никогда.
          await waitForMeshSettled([ePage, fPage], { tileCount: 2, connectionsPerPage: 1 });

          await openChatPanel(ePage);
          await openChatPanel(fPage);

          // --- (а) картинка ~50КБ: авто-скачивание у Захара, инлайн-превью ---
          const pngBuffer = makeTestPngBuffer({ width: 112, height: 112 });
          await attachFilesToChat(ePage, [{ name: 'photo.png', mimeType: 'image/png', buffer: pngBuffer }]);

          await fPage.waitForFunction(
            () => (document.querySelector('.chat-file-image')?.naturalWidth || 0) > 0,
            undefined,
            { polling: 100, timeout: 10_000 }
          );

          // --- (б) "файл" ~300КБ (text/plain): у Захара карточка с кнопкой,
          //     клик "Скачать" -> прогресс появляется и исчезает, итоговый
          //     Blob совпадает по размеру с исходным. ---
          const textBuffer = makeTestTextFileBuffer(300 * 1024);
          await attachFilesToChat(ePage, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: textBuffer }]);

          const fFileCard = fPage.locator('.chat-file-card', { hasText: 'notes.txt' });
          const fDownloadButton = fFileCard.locator('.chat-file-download-button');
          await fDownloadButton.waitFor({ state: 'visible', timeout: 10_000 });
          await fDownloadButton.click();

          const fDownloadLink = fFileCard.locator('.chat-file-download-link');
          await fDownloadLink.waitFor({ state: 'visible', timeout: 15_000 });

          const progressStillThere = await fFileCard.locator('.chat-file-progress').count();
          assert.equal(progressStillThere, 0, 'полоса прогресса должна исчезнуть после завершения передачи');

          const fObjectUrl = await fDownloadLink.getAttribute('href');
          const fBlobSize = await fPage.evaluate(async (url) => {
            const blob = await (await fetch(url)).blob();
            return blob.size;
          }, fObjectUrl);
          assert.equal(
            fBlobSize,
            textBuffer.length,
            `скачанный файл должен совпадать по размеру с исходным (${textBuffer.length}), получено ${fBlobSize}`
          );

          // --- (в) опоздавший (Иван) видит карточки из истории и может
          //     скачать, пока отправитель (Женя) ещё в комнате ---
          const gContext = await browser.newContext();
          await installPcRegistry(gContext);
          const gPage = await gContext.newPage();
          try {
            await gPage.goto(fileRoomUrl);
            await joinRoom(gPage, 'Иван');
            await waitForOverlayHidden(gPage);
            await waitForMeshSettled([ePage, fPage, gPage], { tileCount: 3, connectionsPerPage: 2 });
            await openChatPanel(gPage);

            const gFileCard = gPage.locator('.chat-file-card', { hasText: 'notes.txt' });
            const gDownloadButton = gFileCard.locator('.chat-file-download-button');
            await gDownloadButton.waitFor({ state: 'visible', timeout: 10_000 });
            await gDownloadButton.click();

            const gDownloadLink = gFileCard.locator('.chat-file-download-link');
            await gDownloadLink.waitFor({ state: 'visible', timeout: 15_000 });

            const gObjectUrl = await gDownloadLink.getAttribute('href');
            const gBlobSize = await gPage.evaluate(async (url) => {
              const blob = await (await fetch(url)).blob();
              return blob.size;
            }, gObjectUrl);
            assert.equal(
              gBlobSize,
              textBuffer.length,
              `опоздавший должен скачать файл из истории с тем же размером (${textBuffer.length}), получено ${gBlobSize}`
            );
          } finally {
            await gContext.close();
          }
        } finally {
          await eContext.close();
          await fContext.close();
        }
      }
    );

    // --- Права и лидер (см. README.md «Права и лидер») ---
    //
    // Отдельная комната: Лида — создатель (предъявляет leaderToken из
    // фрагмента, становится лидером), Гоша — обычный гость по прямой ссылке
    // (без токена, лобби пока выключено). Дальше по шагам: (б) лидер включает
    // лобби, Тоня ждёт одобрения и получает его, Юра ждёт и получает отказ;
    // (в) лидер выключает гостям чат — у Гоши инпут дизейблен, а ПОДДЕЛАННЫЙ
    // конверт (инъекция через evaluate в bus._dispatch у Лиды, минуя реальный
    // DataChannel — тот же приём, что и в негативном тесте edit выше) с
    // ЧУЖИМ from не рендерится ни у кого; (г) лидер выключает гостям показ
    // экрана — кнопка «Экран» у Гоши дизейблена; (д) лидер уходит — старейший
    // гость (Гоша, joined_at раньше Тони) получает корону и тост.
    await step(
      'Права и лидер: корона создателя, лобби (одобрение/отказ), запрет чата гостям (+ игнор поддельного конверта), запрет показа экрана, смена лидера при уходе',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: permRoomId, leaderToken: permLeaderToken } = await res.json();
        const permRoomUrl = `${server.baseUrl}/r/${permRoomId}`;
        const permLeaderUrl = `${permRoomUrl}#lt=${encodeURIComponent(permLeaderToken)}`;

        const lidaContext = await browser.newContext();
        const goshaContext = await browser.newContext();
        const lidaPage = await lidaContext.newPage();
        const goshaPage = await goshaContext.newPage();

        try {
          // --- подготовка: Лида (создатель, лидер) и Гоша (обычный гость) ---
          await lidaPage.goto(permLeaderUrl);
          await joinRoom(lidaPage, 'Лида');
          await waitForOverlayHidden(lidaPage);

          await goshaPage.goto(permRoomUrl);
          await joinRoom(goshaPage, 'Гоша');
          await waitForOverlayHidden(goshaPage);
          // Простая проверка по тайлам, БЕЗ waitForMeshSettled: этот сценарий
          // не проверяет видео/аудио, только UI прав/лидера/чата — тайлы и
          // шина комнаты (bus.addPeer) уже на месте сразу по joined/peer-joined,
          // не дожидаясь фактического connectionState==='connected' — так
          // тест не зависит от загруженности машины ICE-негоциацией (этот
          // сценарий идёт последним в файле, после уже накопленных тяжёлых
          // WebRTC-сценариев выше).
          await waitForTileCount(lidaPage, 2, 10_000);
          await waitForTileCount(goshaPage, 2, 10_000);

          const lidaTileSel = await tileSelector('Лида');
          await waitCrownVisible(goshaPage, lidaTileSel, true);
          const goshaOwnCrownHidden = await goshaPage.evaluate(
            () => document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden')
          );
          assert.equal(goshaOwnCrownHidden, true, 'у Гоши на своём тайле короны быть не должно');
          await goshaPage.waitForFunction(
            () => document.getElementById('settings-button')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );

          // --- (б) лидер включает лобби ---
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-lobby').check();
          await waitUntil(async () => (await lidaPage.evaluate(() => roomSettings && roomSettings.lobbyEnabled === true)), {
            timeoutMs: 5000,
            message: 'lobbyEnabled не применился у Лиды после тумблера',
          });
          await lidaPage.click('#settings-panel-close');

          // Тоня заходит по прямой ссылке — попадает в лобби, ждёт одобрения.
          const tonyaContext = await browser.newContext();
          const tonyaPage = await tonyaContext.newPage();
          await tonyaPage.goto(permRoomUrl);
          await joinRoom(tonyaPage, 'Тоня');
          await waitOverlayTitle(tonyaPage, 'Ожидание одобрения…');

          const tonyaRequestCard = lidaPage.locator('.join-request-card', { hasText: 'Тоня' });
          await tonyaRequestCard.waitFor({ state: 'visible', timeout: 8000 });
          const badgeText = await lidaPage.locator('#settings-badge').textContent();
          assert.equal(badgeText, '1', `бейдж заявок лобби должен показывать 1, получено: ${badgeText}`);

          await tonyaRequestCard.locator('.join-request-button--accept').click();
          await waitForOverlayHidden(tonyaPage);
          // Простая проверка по тайлам (не waitForMeshSettled с его
          // reload-ретраем): reload здесь опасен — при lobbyEnabled=true он
          // заново отправил бы Тоню в лобби, требуя повторного одобрения.
          for (const page of [lidaPage, goshaPage, tonyaPage]) {
            await waitForTileCount(page, 3, 10_000);
          }

          // Юра заходит — тоже в лобби, лидер его отклоняет.
          const yuraContext = await browser.newContext();
          const yuraPage = await yuraContext.newPage();
          try {
            await yuraPage.goto(permRoomUrl);
            await joinRoom(yuraPage, 'Юра');
            await waitOverlayTitle(yuraPage, 'Ожидание одобрения…');

            const yuraRequestCard = lidaPage.locator('.join-request-card', { hasText: 'Юра' });
            await yuraRequestCard.waitFor({ state: 'visible', timeout: 8000 });
            await yuraRequestCard.locator('.join-request-button--reject').click();
            await waitOverlayTitle(yuraPage, 'Вход отклонён');
          } finally {
            await yuraContext.close();
          }

          // --- (в) лидер запрещает гостям чат ---
          await openChatPanel(lidaPage);
          await openChatPanel(goshaPage);
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-guest-chat').uncheck();
          await waitUntil(async () => (await goshaPage.evaluate(() => roomSettings && roomSettings.guestChat === false)), {
            timeoutMs: 5000,
            message: 'guestChat=false не применился у Гоши',
          });
          await lidaPage.click('#settings-panel-close');

          const goshaChatState = await goshaPage.evaluate(() => ({
            disabled: document.querySelector('.chat-text-input').disabled,
            placeholder: document.querySelector('.chat-text-input').placeholder,
          }));
          assert.equal(goshaChatState.disabled, true, 'у Гоши инпут чата должен быть задизейблен при guestChat=false');
          assert.equal(
            goshaChatState.placeholder,
            'Чат запрещён лидером',
            `плейсхолдер должен объяснять запрет: ${goshaChatState.placeholder}`
          );

          // Поддельный конверт как будто от Гоши (guestChat=false, Гоша не
          // лидер) — инъекция напрямую в bus._dispatch у Лиды, минуя реальный
          // DataChannel (тот же приём, что и в негативном тесте edit выше) —
          // получатель должен молча проигнорировать.
          const goshaPeerId = await lidaPage.evaluate(() => document.querySelector('.tile[data-name="Гоша"]').dataset.peerId);
          await lidaPage.evaluate(
            (pid) => {
              bus._dispatch(pid, {
                v: 1,
                id: 'forged-text-guestchat-forbidden',
                lamport: 999999,
                from: pid,
                name: 'Гоша',
                kind: 'text',
                text: 'ЗАПРЕЩЁННЫЙ-ТЕКСТ-ГОСТЯ',
                ts: Date.now(),
              });
            },
            goshaPeerId
          );
          assert.ok(
            !(await messageTextsInclude(lidaPage, 'ЗАПРЕЩЁННЫЙ-ТЕКСТ-ГОСТЯ', 300)),
            'конверт от гостя при guestChat=false должен быть проигнорирован получателем (даже подделанный напрямую в шину)'
          );

          // Лидеру чат по-прежнему разрешён.
          const leaderMsg = `Лида-может-писать-${Date.now()}`;
          await sendChatMessage(lidaPage, leaderMsg);
          assert.ok(await messageTextsInclude(goshaPage, leaderMsg), 'лидеру должно быть можно писать в чат при guestChat=false');

          // --- (г) лидер запрещает гостям показ экрана ---
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-guest-screen').uncheck();
          await waitUntil(async () => (await goshaPage.evaluate(() => roomSettings && roomSettings.guestScreen === false)), {
            timeoutMs: 5000,
            message: 'guestScreen=false не применился у Гоши',
          });
          await lidaPage.click('#settings-panel-close');

          const goshaScreenState = await goshaPage.evaluate(() => ({
            disabled: document.getElementById('screen-button')?.disabled,
            title: document.getElementById('screen-button')?.title,
          }));
          assert.equal(goshaScreenState.disabled, true, 'кнопка «Экран» у Гоши должна быть задизейблена при guestScreen=false');
          assert.equal(
            goshaScreenState.title,
            'Запрещено лидером',
            `title кнопки «Экран» должен объяснять запрет: ${goshaScreenState.title}`
          );

          // --- (д) лидер уходит — старейший гость (Гоша) получает корону и тост ---
          const goshaTileSel = await tileSelector('Гоша');
          await lidaPage.click('#leave-button');

          await goshaPage.waitForFunction(
            () => document.getElementById('toast')?.textContent === 'Вы стали лидером' && !document.getElementById('toast')?.classList.contains('hidden'),
            undefined,
            { polling: 50, timeout: 8000 }
          );
          await waitCrownVisible(goshaPage, '.tile--own', true);
          await goshaPage.waitForFunction(
            () => !document.getElementById('settings-button')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 5000 }
          );

          await tonyaPage.waitForFunction(
            () => (document.getElementById('toast')?.textContent || '').includes('Гоша') && !document.getElementById('toast')?.classList.contains('hidden'),
            undefined,
            { polling: 50, timeout: 8000 }
          );
          await waitCrownVisible(tonyaPage, goshaTileSel, true);

          await waitForTileCount(goshaPage, 2, 8000);
          await waitForTileCount(tonyaPage, 2, 8000);

          // --- (е) анонимность: ноль localStorage/cookie на всех вовлечённых страницах ---
          for (const [label, page] of [['Гоша', goshaPage], ['Тоня', tonyaPage]]) {
            const anon = await page.evaluate(() => ({ lsLength: localStorage.length, cookie: document.cookie }));
            assert.equal(anon.lsLength, 0, `у ${label} localStorage.length должен быть 0, получено ${anon.lsLength}`);
            assert.equal(anon.cookie, '', `у ${label} document.cookie должен быть пустым, получено "${anon.cookie}"`);
          }
          // Лида после «Покинуть» уходит на лендинг — тоже без следов.
          await lidaPage.waitForURL(/\/$/, { timeout: 5000 });
          const lidaAnon = await lidaPage.evaluate(() => ({ lsLength: localStorage.length, cookie: document.cookie }));
          assert.equal(lidaAnon.lsLength, 0, `у Лиды (лендинг) localStorage.length должен быть 0, получено ${lidaAnon.lsLength}`);
          assert.equal(lidaAnon.cookie, '', `у Лиды (лендинг) document.cookie должен быть пустым, получено "${lidaAnon.cookie}"`);

          await tonyaContext.close();
        } finally {
          await lidaContext.close();
          await goshaContext.close();
        }
      }
    );

    // --- Мобильный смоук: узкий вьюпорт, новая (отдельная) комната ---
    // Экран не проверяем намеренно: на реальных мобильных браузерах
    // getDisplayMedia недоступен вовсе и кнопка «Экран» скрывается (см.
    // room.js), а этот тест эмулирует вьюпорт/тач в том же десктопном
    // Chrome, где API формально есть — проверка кнопки тут ничего бы не
    // сказала ни про десктоп (уже покрыт выше), ни про настоящий мобильный
    // Chrome/Safari.
    await step(
      'Мобильный смоук (390x844, touch): участник заходит в комнату, панель управления видима, страница без горизонтального скролла, микрофон переключается',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const data = await res.json();
        const mobileRoomId = data.roomId;

        const mobileContext = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
        });
        try {
          await installMediaStubs(mobileContext);
          const mobilePage = await mobileContext.newPage();

          await mobilePage.goto(`${server.baseUrl}/r/${mobileRoomId}`);

          // Модалка входа — первое, что видит участник; должна помещаться в
          // 390×844 без горизонтального скролла (mobile-first, см. README.md).
          await mobilePage.waitForSelector('#join-modal:not(.hidden)', { timeout: 10_000 });
          const joinModalBox = await mobilePage.locator('.join-modal-card').boundingBox();
          assert.ok(joinModalBox, 'модалка входа должна быть видима на мобильном вьюпорте');
          assert.ok(
            joinModalBox.x >= -1 && joinModalBox.x + joinModalBox.width <= 390 + 1,
            `модалка входа должна помещаться по ширине вьюпорта (390px): ${JSON.stringify(joinModalBox)}`
          );
          const modalOverflowInfo = await mobilePage.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            modalOverflowInfo.scrollWidth <= modalOverflowInfo.clientWidth + 1,
            `модалка входа не должна вызывать горизонтальный скролл: ${JSON.stringify(modalOverflowInfo)}`
          );

          await joinRoom(mobilePage, 'Мобильный');
          await waitForOverlayHidden(mobilePage);
          await waitForTileCount(mobilePage, 1);

          const overflowInfo = await mobilePage.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            overflowInfo.scrollWidth <= overflowInfo.clientWidth + 1,
            `документ не должен иметь горизонтальный скролл: scrollWidth=${overflowInfo.scrollWidth}, clientWidth=${overflowInfo.clientWidth}`
          );

          const panelBox = await mobilePage.locator('.control-panel').boundingBox();
          assert.ok(panelBox, 'панель управления должна быть видима во вьюпорте');
          assert.ok(
            panelBox.x >= -1 && panelBox.x + panelBox.width <= 390 + 1,
            `панель управления должна помещаться по ширине вьюпорта (390px): ${JSON.stringify(panelBox)}`
          );
          assert.ok(
            panelBox.y + panelBox.height <= 844 + 1,
            `панель управления должна помещаться по высоте вьюпорта (844px): ${JSON.stringify(panelBox)}`
          );

          const tileBox = await mobilePage.locator('.tile').first().boundingBox();
          assert.ok(tileBox, 'хотя бы один тайл участника должен быть видим');

          await mobilePage.click('#mic-button');
          await mobilePage.waitForFunction(
            () => document.getElementById('mic-button')?.getAttribute('aria-pressed') === 'true',
            undefined,
            { polling: 100, timeout: 5000 }
          );

          // Открытый чат на мобильном — полноэкранный вид (не боковая
          // панель/bottom-sheet как на десктопе): проверяем, что панель чата
          // покрывает почти весь вьюпорт.
          await openChatPanel(mobilePage);
          const chat = await getChatDom(mobilePage);
          const chatBox = await chat.panel.boundingBox();
          assert.ok(chatBox, 'панель чата должна быть видима после открытия');
          const viewportArea = 390 * 844;
          const chatArea = chatBox.width * chatBox.height;
          assert.ok(
            chatArea >= viewportArea * 0.95,
            `открытый чат на мобильном должен покрывать почти весь экран (>=95%): ${JSON.stringify(chatBox)}`
          );
        } finally {
          await mobileContext.close();
        }
      }
    );
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
