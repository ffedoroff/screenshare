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
  installSavedName,
  installPcRegistry,
  waitForMeshSettled,
  waitForOverlayHidden,
  assertVideoPlaying,
  openChatPanel,
  sendChatMessage,
  messageTextsInclude,
  getChatDom,
  waitUntil,
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
    const roomCreatedOk = await step('Вася: главная страница, вводит имя, создаёт комнату', async () => {
      await vasyaPage.goto(server.baseUrl);
      await vasyaPage.fill('#name-input', 'Вася');
      await vasyaPage.click('#create-room-button');
      await vasyaPage.waitForURL(/\/r\/[^/]+$/, { timeout: 10_000 });
      const match = vasyaPage.url().match(/\/r\/([^/]+)$/);
      assert.ok(match, `не удалось извлечь roomId из URL: ${vasyaPage.url()}`);
      roomId = match[1];
      await waitForOverlayHidden(vasyaPage);
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
    await installSavedName(petyaContext, 'Петя');
    await installSavedName(olyaContext, 'Оля');
    const petyaPage = await petyaContext.newPage();
    const olyaPage = await olyaContext.newPage();

    const everyoneJoinedOk = await step('Петя и Оля открывают ссылку комнаты, у всех троих по 3 тайла', async () => {
      await petyaPage.goto(roomUrl);
      await olyaPage.goto(roomUrl);
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);

      // waitForMeshSettled ждёт и тайлы, и что у всех троих обе mesh-связи
      // (шина + сигналинг) реально дошли до connected — см. helpers.mjs.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });
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
        await installSavedName(igorContext, 'Игорь');
        await installSavedName(nastyaContext, 'Настя');
        const igorPage = await igorContext.newPage();
        const nastyaPage = await nastyaContext.newPage();

        try {
          await igorPage.goto(histRoomUrl);
          await nastyaPage.goto(histRoomUrl);
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
          await installSavedName(tretyContext, 'Третий');
          const tretyPage = await tretyContext.newPage();
          try {
            await tretyPage.goto(histRoomUrl);
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
        await installSavedName(aContext, 'Аня');
        await installSavedName(bContext, 'Боря');
        await installSavedName(cContext, 'Витя');
        const aPage = await aContext.newPage();
        const bPage = await bContext.newPage();
        const cPage = await cContext.newPage();

        try {
          await aPage.goto(fmtRoomUrl);
          await bPage.goto(fmtRoomUrl);
          await cPage.goto(fmtRoomUrl);
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
          await installSavedName(dContext, 'Гриша');
          const dPage = await dContext.newPage();
          try {
            await dPage.goto(fmtRoomUrl);
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
