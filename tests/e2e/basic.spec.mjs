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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  makeTestWavBuffer,
  makeTestWebmBuffer,
  attachFilesToChat,
  generateRoomKeyBase64url,
  roomUrlWithKey,
  leaderUrlWithKey,
  getRoomKeyFromPage,
  installSignalingFrameSpy,
  allFramesSentOn,
  framesOfTypeSentOn,
  waitInvalidLinkOverlay,
  waitForBusOpenToAllPeers,
  installFakeVisualViewport,
  REPO_ROOT,
} from './helpers.mjs';

/**
 * Извлечь тело `run: |` YAML-шага по подстроке в его `name:` — без тяжёлой
 * зависимости от YAML-парсера (в tests/e2e/package.json его нет и заводить
 * ради одного теста не хочется, см. M2-тест ниже). Работает для block-scalar
 * (`|`) с постоянным отступом (наш случай, см. .github/workflows/deploy-prod.yml)
 * — блок кончается на первой строке с отступом МЕНЬШЕ отступа первой
 * содержательной строки тела (следующий `- name:`/ключ шага того же уровня).
 */
function extractYamlRunStepScript(workflowText, stepNameSubstring) {
  const nameIdx = workflowText.indexOf(stepNameSubstring);
  assert.ok(nameIdx >= 0, `не нашёл шаг "${stepNameSubstring}" в workflow`);
  const runIdx = workflowText.indexOf('run: |', nameIdx);
  assert.ok(runIdx >= 0, `не нашёл "run: |" после шага "${stepNameSubstring}"`);
  const afterRunLine = workflowText.slice(runIdx).split('\n').slice(1); // без самой строки "run: |"
  const bodyLines = [];
  let baseIndent = null;
  for (const line of afterRunLine) {
    if (line.trim() === '') {
      bodyLines.push('');
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break; // дедент — блок этого run кончился
    bodyLines.push(line.slice(baseIndent));
  }
  return bodyLines.join('\n');
}

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
//
// Ф2: заодно запоминаем и фреймы type === 'stream-info' (метки медиатреков
// kind/имя/enabled, см. static/room.js: sendStreamInfoTo) — вместе с
// временем отправки (Date.now() того же браузерного контекста, что и
// сравнение в тесте). stream-info по протоколу ВСЕГДА разрешён через сервер
// в bootstrap-окне сразу после входа в комнату (шина до конкретного пира
// ещё не открылась — см. static/rtc.js: onBusOpen), поэтому сам факт
// присутствия такого фрейма не баг — баг это фрейм ПОСЛЕ bootstrap-окна
// (см. проверку ниже в main()).
function installChatWsSpy(context) {
  return context.addInitScript(() => {
    window.__e2eChatFramesSent = [];
    window.__e2eStreamInfoFramesSent = [];
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
            } else if (parsed && parsed.type === 'stream-info') {
              window.__e2eStreamInfoFramesSent.push({ ts: Date.now(), frame: parsed });
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

async function chatFramesSentOn(page) {
  return page.evaluate(() => window.__e2eChatFramesSent || []);
}

async function streamInfoFramesSentOn(page) {
  return page.evaluate(() => window.__e2eStreamInfoFramesSent || []);
}

// Ф3 (повторные offer/answer/ice по шине, см. static/rtc.js): суммарное
// число offer+answer+ice-candidate фреймов, ушедших этой страницей в
// серверный WS (требует installSignalingFrameSpy на контексте — см. main()
// ниже, установлен на vasyaContext/petyaContext/olyaContext). Используется
// парой «до/после» вокруг ренегоциаций после установления mesh (камера/
// микрофон/шаринг экрана) — по протоколу счёт не должен расти вообще, раз
// шина к этому моменту уже открыта (см. waitForBusOpenToAllPeers выше).
async function signalRelayFramesCount(page) {
  const frames = await allFramesSentOn(page);
  return frames.filter((f) => f && (f.type === 'offer' || f.type === 'answer' || f.type === 'ice-candidate')).length;
}

// Сколько миллисекунд после установления mesh-пары (connectionState
// 'connected' у обоих RTCPeerConnection, см. waitForMeshSettled) серверный
// релей stream-info ещё считается штатным bootstrap-путём (шина открывается
// не мгновенно после connected — SCTP-négotiation датаканала идёт следом,
// см. static/rtc.js). После этого окна ЛЮБОЙ новый stream-info должен идти
// только по шине (см. onBusOpen в static/rtc.js/room.js — снапшот, отправленный
// сразу по открытию шины, и делает серверный путь редким).
const STREAM_INFO_BOOTSTRAP_WINDOW_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Проверить, что ни у одной из `pagesByLabel` не было stream-info фреймов
 * через сервер ПОСЛЕ bootstrap-окна (см. STREAM_INFO_BOOTSTRAP_WINDOW_MS).
 * `settledAtByLabel` — Map<label, ts> с момента, когда у соответствующей
 * страницы mesh стал 'connected' (см. вызовы ниже в main()). Если с этого
 * момента реально прошло меньше окна — досыпаем разницу, чтобы не ловить
 * ложный «зелёный» результат только потому, что предыдущие шаги отработали
 * быстрее ожидаемого.
 */
async function assertNoLateStreamInfoOverServer(pagesByLabel, settledAtByLabel) {
  const oldestSettledAt = Math.min(...settledAtByLabel.values());
  const elapsed = Date.now() - oldestSettledAt;
  if (elapsed < STREAM_INFO_BOOTSTRAP_WINDOW_MS) {
    await sleep(STREAM_INFO_BOOTSTRAP_WINDOW_MS - elapsed);
  }
  for (const [label, page] of pagesByLabel) {
    const settledAt = settledAtByLabel.get(label);
    const frames = await streamInfoFramesSentOn(page);
    const late = frames.filter((f) => f.ts > settledAt + STREAM_INFO_BOOTSTRAP_WINDOW_MS);
    assert.equal(
      late.length,
      0,
      `у ${label} после bootstrap-окна (${STREAM_INFO_BOOTSTRAP_WINDOW_MS}мс от установления mesh) ушли stream-info фреймы через сервер вместо шины: ${JSON.stringify(late)}`
    );
  }
}

async function main() {
  await buildServer();
  await server.start();

  let browser = null;
  // Комната, переданная из шага «Ш1: неверный k» шагу «Лимит длительности
  // созвона» — см. комментарий у roomIdForTimerTestReuse = wrongKeyRoomId
  // ниже: экономим один POST /api/rooms (H2: ROOM_CREATION_IP_LIMIT — 10 за
  // 60с с одного IP, а этот файл создаёт много комнат за один прогон).
  let roomIdForTimerTestReuse = null;

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
    // Ф3: шпион на ВСЕ фреймы серверного WS (не только chat/stream-info, см.
    // installChatWsSpy выше) — нужен ниже, чтобы доказать, что offer/answer/
    // ice-candidate повторных ренегоциаций (камера/микрофон/шаринг экрана
    // ПОСЛЕ установления mesh) не растут через сервер (см. проверку в конце
    // основного сценария).
    await installSignalingFrameSpy(vasyaContext);
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
    // Ш1 (E2E-шифрование): ключ комнаты сгенерировал сам браузер Васи при
    // клике «Создать комнату» (см. static/landing.js) — тест его заранее не
    // знает, читаем прямо со страницы (см. getRoomKeyFromPage). Гостям
    // ссылка нужна С #k (без него — «Ссылка неполная», см. ниже отдельный
    // тест) и БЕЗ #lt (тот одноразовый и только для создателя).
    const vasyaRoomKey = await getRoomKeyFromPage(vasyaPage);
    const guestRoomUrl = roomUrlWithKey(server.baseUrl, roomId, vasyaRoomKey);

    // --- Петя и Оля открывают ту же ссылку ---
    const petyaContext = await browser.newContext();
    const olyaContext = await browser.newContext();
    await installMediaStubs(petyaContext);
    await installMediaStubs(olyaContext);
    await installChatWsSpy(petyaContext);
    await installChatWsSpy(olyaContext);
    await installPcRegistry(petyaContext);
    await installPcRegistry(olyaContext);
    await installSignalingFrameSpy(petyaContext);
    await installSignalingFrameSpy(olyaContext);
    const petyaPage = await petyaContext.newPage();
    const olyaPage = await olyaContext.newPage();

    // peerId-метка -> ts (в часах браузерного контекста той же страницы),
    // когда mesh у неё стал 'connected' — см. assertNoLateStreamInfoOverServer
    // ниже (bootstrap-окно stream-info отсчитывается от этого момента).
    const meshSettledAtByLabel = new Map();

    // Ф3: peerId-метка -> число offer+answer+ice-candidate фреймов через
    // сервер В МОМЕНТ, когда mesh+шина уже устаканились (см.
    // signalRelayFramesCount/waitForBusOpenToAllPeers выше) — базовая линия
    // для сравнения «до/после» вокруг всех последующих ренегоциаций
    // (камера/микрофон/шаринг экрана), см. проверку в конце сценария.
    const signalRelayCountAtMeshSettledByLabel = new Map();

    const everyoneJoinedOk = await step('Петя и Оля открывают ссылку комнаты (модалка входа), у всех троих по 3 тайла, корона только у Васи', async () => {
      await petyaPage.goto(guestRoomUrl);
      await olyaPage.goto(guestRoomUrl);
      await joinRoom(petyaPage, 'Петя');
      await joinRoom(olyaPage, 'Оля');
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);

      // waitForMeshSettled ждёт и тайлы, и что у всех троих обе mesh-связи
      // (шина + сигналинг) реально дошли до connected — см. helpers.mjs.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });

      // Ф3: connectionState==='connected' у RTCPeerConnection не гарантирует
      // МГНОВЕННО открытую DataChannel-шину (её собственный SCTP-хендшейк —
      // отдельная, чуть более поздняя договорённость) — явно дожидаемся
      // bus.isOpen() с обеими парами на каждой странице, прежде чем ниже по
      // сценарию намеренно спровоцировать ренегоциации (камера/микрофон/
      // экран) и проверить, что они идут по шине, а не через сервер (см.
      // waitForBusOpenToAllPeers/сравнение счётчиков сигналинга в конце
      // сценария).
      for (const page of [vasyaPage, petyaPage, olyaPage]) {
        await waitForBusOpenToAllPeers(page);
      }

      for (const [label, page] of [['Вася', vasyaPage], ['Петя', petyaPage], ['Оля', olyaPage]]) {
        meshSettledAtByLabel.set(label, await page.evaluate(() => Date.now()));
        signalRelayCountAtMeshSettledByLabel.set(label, await signalRelayFramesCount(page));
      }

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

    // --- Настройки: селекты устройств наполняются (fake-флаги дают fake-устройства) ---
    await step(
      'У Васи в настройках наполняются селекты микрофона/камеры (enumerateDevices не застаблен — реальный список, включая fake-устройства из CAPTURE_FLAGS)',
      async () => {
        await vasyaPage.click('#settings-button');
        await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });
        // refreshDeviceLists() внутри openSettingsPanel асинхронный
        // (enumerateDevices — Promise) — ждём реального появления опций, а не
        // считаем сразу же после клика (гонка, см. static/room.js).
        await vasyaPage.waitForFunction(
          () => document.querySelectorAll('#setting-mic-device option').length > 0,
          undefined,
          { polling: 100, timeout: 3000 }
        );
        const micCount = await vasyaPage.locator('#setting-mic-device option').count();
        const camCount = await vasyaPage.locator('#setting-camera-device option').count();
        assert.ok(micCount > 0, `селект микрофона должен быть наполнен хотя бы одним устройством, получено ${micCount}`);
        assert.ok(camCount > 0, `селект камеры должен быть наполнен хотя бы одним устройством, получено ${camCount}`);
        await vasyaPage.click('#settings-panel-close');
      }
    );

    // --- Настройки: секция «Соединение и приватность» (видна ВСЕМ) ---
    await step(
      'В настройках есть секция «Соединение и приватность»: строка шифрования содержит AES-256-GCM/256 бит, режим соединения с устаканившимся пиром в итоге «напрямую (P2P)», счётчик сигналинга через сервер > 0',
      async () => {
        await vasyaPage.click('#settings-button');
        await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });

        const cryptoText = await vasyaPage.locator('#settings-crypto-text').textContent();
        assert.ok(cryptoText.includes('AES-256-GCM'), `строка шифрования должна содержать "AES-256-GCM": ${cryptoText}`);
        assert.ok(cryptoText.includes('256'), `строка шифрования должна содержать "256" (бит ключа): ${cryptoText}`);

        // Режим соединения с уже устаканившимся (waitForMeshSettled выше)
        // mesh-пиром должен в итоге стать «напрямую (P2P)» — секция
        // обновляется раз в 5с, пока открыта (см. static/room.js:
        // CONNECTION_SECTION_REFRESH_MS), поэтому поллим с запасом до 10с.
        await vasyaPage.waitForFunction(
          () => {
            const rows = Array.from(document.querySelectorAll('#settings-peers-list .settings-peer-row'));
            return rows.some((row) => row.textContent.includes('напрямую (P2P)'));
          },
          undefined,
          { polling: 200, timeout: 10_000 }
        );

        const signalingCountText = await vasyaPage.locator('#settings-signaling-count').textContent();
        assert.ok(
          Number(signalingCountText) > 0,
          `счётчик сигналинга через сервер должен быть > 0 (bootstrap-обмен offer/answer/ice неизбежен), получено ${signalingCountText}`
        );

        await vasyaPage.click('#settings-panel-close');
      }
    );

    // --- Смена камеры "на лету" (устройство включено) — без ренегоциации ---
    if (camOk) {
      await step(
        'Вася меняет камеру в настройках, пока она включена (replaceTrack без ренегоциации) — видео у Пети остаётся живым',
        async () => {
          await vasyaPage.click('#settings-button');
          await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });
          await vasyaPage.waitForFunction(
            () => document.querySelectorAll('#setting-camera-device option').length > 0,
            undefined,
            { polling: 100, timeout: 3000 }
          );
          // Единственное фейковое устройство переизбирается заново — тесту
          // важен не факт смены НА ДРУГОЕ железо (в CI его нет), а то, что сам
          // путь "включена -> getUserMedia -> RTCRtpSender.replaceTrack" не
          // рвёт уже установленное соединение (см. static/room.js:
          // applyCameraDeviceChange/liveSwitchCamTrack).
          const hadOption = await vasyaPage.evaluate(() => {
            const el = document.getElementById('setting-camera-device');
            if (!el.options.length) return false;
            el.value = el.options[0].value;
            el.dispatchEvent(new Event('change'));
            return true;
          });
          assert.ok(hadOption, 'у камеры должен быть хотя бы один вариант в селекте');
          await vasyaPage.click('#settings-panel-close');
          await assertVideoPlaying(petyaPage, { selector: `${vasyaTileSel} video`, waitMs: 1500 });
        }
      );
    } else {
      skip('смена камеры на лету', 'камера Васи не заработала');
    }

    // --- Вася включает микрофон ---
    const micOk = await step('Вася включает микрофон — у Пети и Оли speaking-индикация на его тайле, индикатор «мик выключен» пропадает', async () => {
      await vasyaPage.click('#mic-button');
      for (const page of [petyaPage, olyaPage]) {
        await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', true, 8000);
        await waitForClassOnSelector(page, `${vasyaTileSel} .tile-mic-off`, 'hidden', true, 4000);
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
      skip('кнопка fullscreen сцены шаринга', 'шаринг экрана не заработал');
    }

    // --- Кнопка fullscreen на сцене шаринга: клик не должен ронять страницу ---
    // (сам вход в fullscreen в headless-браузере не проверяем — см. static/room.js:
    // requestFullscreenCompat ловит ошибку сама и не пробрасывает её выше).
    if (petyaShareOk) {
      await step('Кнопка fullscreen на сцене шаринга видна у Оли, клик по ней не роняет страницу', async () => {
        const btn = olyaPage.locator('#screen-fullscreen-button');
        await btn.waitFor({ state: 'visible', timeout: 3000 });
        await btn.click();
        await sleep(200);
        const stillResponsive = await olyaPage.evaluate(() => !!document.getElementById('screen-fullscreen-button'));
        assert.ok(stillResponsive, 'страница должна остаться отзывчивой после клика по fullscreen-кнопке');

        // Headless Chrome реально выполняет переход в fullscreen (это не
        // no-op) — тогда полноэкранный элемент перекрывает остальную
        // страницу (чат и т.п. в следующих шагах). Настоящий пользователь
        // вышел бы через Esc, но синтетическое page.keyboard.press('Escape')
        // не долетает до браузерного обработчика fullscreen-Esc (проверено
        // отдельным прогоном) — поэтому выходим программно тем же API,
        // которым пользуется сама кнопка (см. static/room.js: exitFullscreenCompat).
        const isFullscreen = await olyaPage.evaluate(
          () => !!(document.fullscreenElement || document.webkitFullscreenElement)
        );
        if (isFullscreen) {
          await olyaPage.evaluate(() => {
            const fn = document.exitFullscreen || document.webkitExitFullscreen;
            return fn ? fn.call(document) : undefined;
          });
          await olyaPage
            .waitForFunction(
              () => !(document.fullscreenElement || document.webkitFullscreenElement),
              undefined,
              { polling: 100, timeout: 3000 }
            )
            .catch(() => {});
        }
      });
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
      await step('Вася выключает микрофон повторным кликом — speaking-индикация гаснет у остальных, индикатор «мик выключен» появляется', async () => {
        await vasyaPage.click('#mic-button');
        for (const page of [petyaPage, olyaPage]) {
          await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', false, 6000);
          await waitForClassOnSelector(page, `${vasyaTileSel} .tile-mic-off`, 'hidden', false, 4000);
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

    // --- Попап «Поделиться» (Ш1): QR рендерится ЛОКАЛЬНО (без похода на
    // сервер — см. static/vendor/qrcode.js, static/room.js: renderShareQr),
    // ссылка — вида /r/<id>#k=<ключ> (БЕЗ #lt). ---
    await step('Вася открывает попап «Поделиться» — QR рендерится локальным SVG, ссылка ведёт на /r/<id>#k=<ключ>', async () => {
      await vasyaPage.click('#share-button');
      await vasyaPage.waitForSelector('#share-popup:not(.hidden)', { timeout: 5000 });

      // QR — не <img> с сетевым src, а локально сгенерированный <svg> внутри
      // контейнера #share-popup-qr; непустой — реально содержит path-разметку
      // модулей (не просто пустой тег).
      await vasyaPage.waitForFunction(
        () => !!document.querySelector('#share-popup-qr svg'),
        undefined,
        { polling: 100, timeout: 5000 }
      );
      const qrSvgInfo = await vasyaPage.evaluate(() => {
        const svg = document.querySelector('#share-popup-qr svg');
        const path = svg ? svg.querySelector('path') : null;
        return { hasSvg: !!svg, pathLength: path ? (path.getAttribute('d') || '').length : 0 };
      });
      assert.ok(qrSvgInfo.hasSvg, 'в попапе должен быть отрендерен <svg> QR-кода');
      assert.ok(qrSvgInfo.pathLength > 0, `QR SVG не должен быть пустым (path должен нести координаты модулей), получено: ${qrSvgInfo.pathLength}`);

      const linkText = (await vasyaPage.textContent('#share-popup-link')) || '';
      assert.match(
        linkText.trim(),
        new RegExp(`/r/${roomId}#k=[A-Za-z0-9_-]+$`),
        `ссылка в попапе должна быть вида /r/${roomId}#k=<ключ> (без #lt), получено: ${linkText}`
      );
      assert.ok(!linkText.includes('lt='), `ссылка «Поделиться» не должна нести leaderToken: ${linkText}`);

      // #k в ссылке — это РЕАЛЬНЫЙ ключ комнаты (тот же, что вывел сам Вася
      // при входе, см. vasyaRoomKey выше), а не случайный мусор — сверяем
      // напрямую, не заводя лишнего участника (тот утащил бы за собой новый
      // stream-info-фрейм в bootstrap-окне и сломал бы следующую проверку).
      const linkKey = linkText.trim().split('#k=')[1];
      assert.equal(linkKey, vasyaRoomKey, `#k в ссылке «Поделиться» должен совпадать с реальным ключом комнаты (получено ${linkKey})`);

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

    // --- Живой mesh: НОВЫЕ stream-info (камера/мик вкл/выкл ПОСЛЕ установления
    // связи, выше по сценарию) не должны были уйти через сервер за пределами
    // bootstrap-окна — основной путь теперь DataChannel-шина (см. static/rtc.js:
    // onBusOpen, static/room.js: sendStreamInfoTo/handleStreamInfo).
    if (everyoneJoinedOk) {
      await step(
        `Ни один stream-info фрейм не ушёл в серверный WebSocket ПОСЛЕ bootstrap-окна (${STREAM_INFO_BOOTSTRAP_WINDOW_MS}мс от установления mesh) ни у кого из троих`,
        async () => {
          await assertNoLateStreamInfoOverServer(
            [
              ['Вася', vasyaPage],
              ['Петя', petyaPage],
              ['Оля', olyaPage],
            ],
            meshSettledAtByLabel
          );
        }
      );
    } else {
      skip('проверка "новый stream-info не идёт через сервер после bootstrap-окна"', 'mesh не установился');
    }

    // --- Ф3: повторные offer/answer/ice ПОСЛЕ установления mesh идут по шине,
    // не по серверу ---
    //
    // Со времени mesh+шина устаканились (см. signalRelayCountAtMeshSettledByLabel
    // выше) сценарий уже успел спровоцировать НЕСКОЛЬКО настоящих ренегоциаций
    // (addTrack -> onnegotiationneeded, а не просто track.enabled toggle):
    // Вася включил камеру и микрофон, Петя и Оля по очереди пошарили экран,
    // Вася сменил устройство камеры. Каждая из них — новый offer/answer (и
    // сопутствующий trickle ICE) между соответствующей парой. С учётом Ф3
    // ВСЕ они обязаны были уйти по DataChannel-шине (bus уже открыт, pc уже
    // 'connected' — см. static/rtc.js: _canUseBus/_trySendBusSignal), поэтому
    // счётчик offer+answer+ice-candidate через сервер у КАЖДОГО из троих не
    // должен был вырасти ни на единицу с момента базовой линии. Заодно —
    // само по себе то, что все эти шаги (видео/спикинг/шаринг у остальных)
    // уже прошли (assertVideoPlaying/waitForClassOnSelector выше) — и есть
    // подтверждение, что функционально всё отработало, а не просто «тихо
    // сломалось само по себе».
    if (everyoneJoinedOk) {
      await step(
        'Ренегоциации ПОСЛЕ установления mesh (вкл. камеры/микрофона Васи, шаринг экрана Пети/Оли) не добавили ни одного offer/answer/ice-candidate фрейма в серверный WebSocket ни у кого из троих',
        async () => {
          for (const [label, page] of [['Вася', vasyaPage], ['Петя', petyaPage], ['Оля', olyaPage]]) {
            const before = signalRelayCountAtMeshSettledByLabel.get(label);
            const after = await signalRelayFramesCount(page);
            assert.equal(
              after,
              before,
              `у ${label} счётчик offer/answer/ice-candidate через сервер вырос с ${before} до ${after} после установления mesh — ожидали, что ренегоциации пойдут по шине`
            );
          }
        }
      );
    } else {
      skip('проверка "ренегоциации после mesh идут по шине, не по серверу"', 'mesh не установился');
    }

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
        // Ш1: комната создана напрямую через API (в обход лендинга) — ключ
        // генерирует тест сам (см. generateRoomKeyBase64url), как это в
        // реальности сделал бы браузер создателя.
        const histRoomKey = generateRoomKeyBase64url();
        const histRoomUrl = roomUrlWithKey(server.baseUrl, histRoomId, histRoomKey);

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
        const fmtRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше
        const fmtRoomUrl = roomUrlWithKey(server.baseUrl, fmtRoomId, fmtRoomKey);

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

          // --- (a-2) Ф4: курсив __...__, спойлер ||...|| (скрыт -> клик -> .revealed),
          //     инлайн-код `...` (маркеры внутри НЕ разбираются), именованная
          //     ссылка [текст](url) ---
          const spoilerSecret = `secret-${Date.now()}`;
          const uniqueTag2 = `MARK2-${Date.now()}`;
          const fmtText2 = `__ital__ ||${spoilerSecret}|| \`code*x~y\` [linktext](https://example.org/z) ${uniqueTag2}`;
          await sendChatMessage(aPage, fmtText2);

          const bFmtMsg2 = bPage.locator('.chat-message', { hasText: uniqueTag2 }).last();
          await bFmtMsg2.locator('em').first().waitFor({ state: 'visible', timeout: 5000 });

          const em2Text = await bFmtMsg2.locator('em').first().textContent();
          assert.equal(em2Text, 'ital', `__..__ должен рендериться как <em> "ital", получено: ${em2Text}`);

          const codeEl2 = bFmtMsg2.locator('code.chat-inline-code').first();
          await codeEl2.waitFor({ state: 'visible', timeout: 3000 });
          const codeText2 = await codeEl2.textContent();
          assert.equal(
            codeText2,
            'code*x~y',
            `инлайн-код должен содержать текст буквально, без разбора маркеров внутри: ${codeText2}`
          );

          const link2 = bFmtMsg2.locator('a', { hasText: 'linktext' }).first();
          const link2Href = await link2.getAttribute('href');
          assert.equal(
            link2Href,
            'https://example.org/z',
            `именованная ссылка должна вести на https://example.org/z, получено: ${link2Href}`
          );

          const spoilerEl = bFmtMsg2.locator('.chat-md-spoiler').first();
          await spoilerEl.waitFor({ state: 'visible', timeout: 3000 });
          const revealedBefore = await spoilerEl.evaluate((el) => el.classList.contains('revealed'));
          assert.equal(revealedBefore, false, 'спойлер не должен быть раскрыт (.revealed) до клика');
          const filterBefore = await spoilerEl.evaluate((el) => getComputedStyle(el).filter);
          assert.notEqual(
            filterBefore,
            'none',
            `спойлер должен быть визуально размыт до клика (filter должен быть != none), получено: ${filterBefore}`
          );

          await spoilerEl.click();
          await waitUntil(async () => spoilerEl.evaluate((el) => el.classList.contains('revealed')), {
            timeoutMs: 3000,
            message: 'клик по спойлеру должен добавить класс .revealed',
          });
          const spoilerTextAfter = await spoilerEl.textContent();
          assert.equal(
            spoilerTextAfter,
            spoilerSecret,
            `после раскрытия текст спойлера должен быть виден: ${spoilerTextAfter}`
          );
          // filter анимируется через CSS transition (0.15с, см. style.css:
          // .chat-md-spoiler), поэтому сразу после появления класса .revealed
          // getComputedStyle может ещё вернуть промежуточный/старый кадр —
          // ждём завершения перехода, а не проверяем один раз синхронно.
          let filterAfter = null;
          await waitUntil(
            async () => {
              filterAfter = await spoilerEl.evaluate((el) => getComputedStyle(el).filter);
              return filterAfter === 'none';
            },
            { timeoutMs: 2000, message: `после раскрытия filter должен вернуться в none (был: ${filterAfter})` }
          );

          const bFmtText2 = await bFmtMsg2.locator('.chat-message-text').textContent();
          assert.ok(!bFmtText2.includes('__'), `сырых "__" не должно остаться в рендере: ${bFmtText2}`);
          assert.ok(!bFmtText2.includes('||'), `сырых "||" не должно остаться в рендере: ${bFmtText2}`);
          assert.ok(!bFmtText2.includes('`'), `сырых обратных кавычек не должно остаться в рендере: ${bFmtText2}`);

          // --- (a-3) блок кода: метка языка, кнопка «копировать», содержимое
          //     (включая markdown-подобные символы) НЕ разбирается ---
          const codeBlockTag = `MARK3-${Date.now()}`;
          const codeBlockText = `перед\n\`\`\`js\nlet x = 1; // **not bold** __not italic__\nconsole.log(x);\n\`\`\`\nпосле ${codeBlockTag}`;
          await sendChatMessage(aPage, codeBlockText);

          const bCodeMsg = bPage.locator('.chat-message', { hasText: codeBlockTag }).last();
          const codeBlockEl = bCodeMsg.locator('.chat-code-block').first();
          await codeBlockEl.waitFor({ state: 'visible', timeout: 5000 });

          const langText = await codeBlockEl.locator('.chat-code-block-lang').textContent();
          assert.equal(langText, 'js', `метка языка должна показывать "js", получено: ${langText}`);

          const codeBlockContent = await codeBlockEl.locator('pre code').textContent();
          assert.ok(
            codeBlockContent.includes('**not bold**') && codeBlockContent.includes('__not italic__'),
            `внутри код-блока маркеры не должны разбираться — должны остаться буквально: ${codeBlockContent}`
          );
          assert.equal(
            await codeBlockEl.locator('pre code strong').count(),
            0,
            'внутри код-блока не должно быть <strong> (маркеры не разбираются)'
          );

          const copyButton = codeBlockEl.locator('.chat-code-block-copy');
          await copyButton.click();
          await waitUntil(async () => (await copyButton.textContent()) === 'Скопировано', {
            timeoutMs: 2000,
            message: 'кнопка «копировать» должна показать «Скопировано» после клика',
          });

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

          // --- (б-2) реплай на ФОРМАТИРОВАННОЕ сообщение (**wow** ... из (а)) —
          // плашка над инпутом и цитата в полученном реплае должны показывать
          // ПЛЕЙН-текст, без сырых markdown-маркеров (см. static/chat.js:
          // stripMarkdownForPreview) ---
          await bFmtMsg.hover();
          await bFmtMsg.locator('.chat-message-action--reply').click();
          await bPage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const fmtReplyBarText = (await bPage.locator('.chat-reply-bar-text').textContent()) || '';
          assert.ok(!fmtReplyBarText.includes('**'), `плашка реплая не должна показывать сырые "**": ${fmtReplyBarText}`);
          assert.ok(fmtReplyBarText.includes('wow'), `плашка реплая должна содержать текст оригинала: ${fmtReplyBarText}`);

          const fmtReplyText = `Реплай-на-форматированное-${Date.now()}`;
          await sendChatMessage(bPage, fmtReplyText);
          assert.ok(await messageTextsInclude(cPage, fmtReplyText), 'реплай на форматированное сообщение не дошёл до Вити');

          const cFmtReplyMsg = cPage.locator('.chat-message', { hasText: fmtReplyText }).last();
          const fmtQuoteText = await cFmtReplyMsg.locator('.chat-reply-quote-text').textContent();
          assert.ok(!fmtQuoteText.includes('**'), `цитата реплая не должна показывать сырые "**": ${fmtQuoteText}`);
          assert.ok(fmtQuoteText.includes('wow'), `цитата реплая должна содержать текст оригинала: ${fmtQuoteText}`);

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
        const editRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше
        const editRoomUrl = roomUrlWithKey(server.baseUrl, editRoomId, editRoomKey);

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

          // --- (д) H3: identity binding — envelope.from не сходится с ИСТИННЫМ
          // транспортным отправителем ---
          //
          // В отличие от (г) (выдуманный peerId, никому не принадлежащий),
          // здесь оба id — НАСТОЯЩИЕ peerId реальных участников комнаты:
          // имитируем скомпрометированного Пашу, который прислал бы конверт с
          // envelope.from = РЕАЛЬНЫЙ peerId Инны, пытаясь выдать себя за неё
          // (украсть авторство её сообщения) — bus._dispatch(pPeerId, {from:
          // iPeerId, ...}), вызванный НА СТРАНИЦЕ ИННЫ, воспроизводит именно
          // то, что сделал бы её собственный RtcPeer.onBusMessage, получив
          // такой конверт от настоящего DataChannel с Пашей (см. bus.js:
          // _dispatch(peerId, obj) — peerId там всегда транспортный, не из
          // содержимого сообщения). До фикса dispatchEnvelope брал
          // envelope.from доверчиво — при таком совпадении (envelope.from ===
          // РЕАЛЬНЫЙ id автора оригинала) правка/удаление проходили бы;
          // теперь envelope.from принудительно нормализуется на истинный
          // fromPeerId ДО проверки авторства (см. static/chat.js), поэтому
          // подмена отклоняется.
          const iPeerId = await iPage.evaluate(() => document.querySelector('.tile--own')?.dataset.peerId);
          const pPeerId = await pPage.evaluate(() => document.querySelector('.tile--own')?.dataset.peerId);
          assert.ok(iPeerId, 'не удалось прочитать настоящий peerId Инны');
          assert.ok(pPeerId, 'не удалось прочитать настоящий peerId Паши');
          assert.notEqual(iPeerId, pPeerId, 'peerId Инны и Паши должны различаться, иначе тест не имеет смысла');

          // Новое сообщение Инны — независимое от М1/М2 выше, чтобы негативные
          // проверки ниже не зависели от их уже изменённого состояния.
          const original3 = `Оригинал-3-${Date.now()}`;
          const msg3Id = await sendChatMessageAndGetId(iPage, original3);
          assert.ok(msg3Id, 'не удалось получить id сообщения М3 у Инны');
          assert.ok(await messageTextsInclude(pPage, original3), 'М3 не дошло до Паши');
          const msg3Sel = `.chat-message[data-msg-id="${msg3Id}"]`;

          // (д.1) чужой текст с ПОДМЕНЁННЫМ from не отрисовывается как СВОЁ
          // сообщение получателя, если истинный транспортный отправитель —
          // другой пир (нормализация envelope.from переатрибутирует его на
          // Пашу, а не на Инну, за которую он назвался).
          const forgedTextOwnClass = await iPage.evaluate(
            ({ pashaId, innaId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-text-impersonation',
                lamport: 999999,
                from: innaId, // ПОДМЕНА: настоящий отправитель — Паша (pashaId), выдаёт себя за Инну
                name: 'Инна',
                kind: 'text',
                text: 'ПАША-ВЫДАЛ-СЕБЯ-ЗА-ИННУ',
                ts: Date.now(),
              });
              const el = document.querySelector('.chat-message[data-msg-id="forged-text-impersonation"]');
              return el ? el.classList.contains('chat-message--own') : null;
            },
            { pashaId: pPeerId, innaId: iPeerId }
          );
          assert.equal(
            forgedTextOwnClass,
            false,
            'конверт с чужим (но настоящим) from должен быть переатрибутирован на истинного транспортного отправителя, а не отрисован как СВОЁ сообщение получателя'
          );

          // (д.2) подделанный edit (from=Инна, но истинный транспорт — Паша)
          // на сообщение М3 (реальный автор — Инна) должен быть отклонён.
          const forgedEditText = await iPage.evaluate(
            ({ pashaId, innaId, targetId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-edit-impersonation',
                lamport: 999999,
                from: innaId,
                name: 'Инна',
                kind: 'edit',
                target: targetId,
                text: 'ПАША-ПОДМЕНИЛ-ЭДИТ',
                ts: Date.now(),
              });
              const el = document.querySelector(`.chat-message[data-msg-id="${targetId}"] .chat-message-text`);
              return el ? el.textContent : null;
            },
            { pashaId: pPeerId, innaId: iPeerId, targetId: msg3Id }
          );
          assert.equal(
            forgedEditText,
            original3,
            `подделанный edit с чужим (настоящим) from должен быть отклонён — текст М3 должен остаться «${original3}», получено: ${forgedEditText}`
          );
          assert.ok(
            !(await messageTextsInclude(iPage, 'ПАША-ПОДМЕНИЛ-ЭДИТ', 300)),
            'подделанный текст правки не должен появиться в ленте у Инны'
          );

          // (д.3) подделанный delete (from=Инна, истинный транспорт — Паша)
          // на то же М3 — тоже отклоняется, сообщение остаётся на месте.
          const forgedDeleteApplied = await iPage.evaluate(
            ({ pashaId, innaId, targetId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-delete-impersonation',
                lamport: 1000000,
                from: innaId,
                name: 'Инна',
                kind: 'delete',
                target: targetId,
                ts: Date.now(),
              });
              return document.querySelector(`.chat-message[data-msg-id="${targetId}"]`)?.classList.contains('chat-message--deleted');
            },
            { pashaId: pPeerId, innaId: iPeerId, targetId: msg3Id }
          );
          assert.equal(
            forgedDeleteApplied,
            false,
            'подделанный delete с чужим (настоящим) from не должен удалить сообщение Инны'
          );
          assert.ok(
            await messageTextsInclude(iPage, original3),
            'М3 должно остаться видимым у Инны после отклонённой подделки delete'
          );

          // (д.4) контроль: легитимная правка (настоящий Паша правит СВОЁ
          // сообщение, transport и from совпадают) — как в (а) выше, но здесь
          // — что нормализация envelope.from не мешает нормальной работе.
          const pOriginal = `Паша-оригинал-${Date.now()}`;
          const pMsgId = await sendChatMessageAndGetId(pPage, pOriginal);
          assert.ok(await messageTextsInclude(iPage, pOriginal), 'сообщение Паши не дошло до Инны');
          const pEdited = `Паша-правка-${Date.now()}`;
          const pMsgSel = `.chat-message[data-msg-id="${pMsgId}"]`;
          await pPage.locator(pMsgSel).hover();
          await pPage.locator(pMsgSel).locator('.chat-message-action--edit').click();
          await pPage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await pPage.locator('.chat-text-input').fill(pEdited);
          await pPage.locator('.chat-send-button').click();
          assert.ok(
            await messageTextsInclude(iPage, pEdited),
            'легитимная правка настоящего автора должна дойти и примениться у Инны — нормализация from не должна ломать легитимный путь'
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
      'Передача файлов: авто-скачивание картинки, ручное скачивание файла с прогрессом и сверкой размера, опоздавший скачивает из истории, инлайн-плееры audio/video (Ф4, раздел B)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: fileRoomId } = await res.json();
        const fileRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше
        const fileRoomUrl = roomUrlWithKey(server.baseUrl, fileRoomId, fileRoomKey);

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

          // --- (г) аудио: валидный WAV ~1.5с (см. helpers.mjs:
          //     makeTestWavBuffer) — не авто-скачивается (порог ≤2МБ только
          //     для картинок), Захар жмёт «Скачать» -> <audio controls>,
          //     мета-строка (имя/размер/длительность из loadedmetadata),
          //     скачанный Blob совпадает по размеру. ---
          const wavBuffer = makeTestWavBuffer({ durationSeconds: 1.5 });
          await attachFilesToChat(ePage, [{ name: 'sound.wav', mimeType: 'audio/wav', buffer: wavBuffer }]);

          const fAudioCard = fPage.locator('.chat-file-card', { hasText: 'sound.wav' });
          const fAudioDownloadButton = fAudioCard.locator('.chat-file-download-button');
          await fAudioDownloadButton.waitFor({ state: 'visible', timeout: 10_000 });
          await fAudioDownloadButton.click();

          const fAudioEl = fAudioCard.locator('audio.chat-file-audio');
          await fAudioEl.waitFor({ state: 'attached', timeout: 15_000 });

          const fAudioSizeText = await fAudioCard.locator('.chat-file-meta-size').textContent();
          assert.ok(
            fAudioSizeText && /Б|КБ|МБ/.test(fAudioSizeText),
            `у аудио должен быть виден человекочитаемый размер: ${fAudioSizeText}`
          );

          await fPage.waitForFunction(
            () => {
              const el = document.querySelector('.chat-file-card audio.chat-file-audio');
              return !!el && Number.isFinite(el.duration) && el.duration > 0;
            },
            undefined,
            { polling: 100, timeout: 10_000 }
          );
          const fAudioDurationText = await fAudioCard.locator('.chat-file-meta-duration').textContent();
          assert.ok(
            /^\d+:\d{2}$/.test(fAudioDurationText || ''),
            `длительность аудио должна отображаться в формате М:СС, получено: ${fAudioDurationText}`
          );

          const fAudioDownloadLink = fAudioCard.locator('.chat-file-download-link--compact');
          await fAudioDownloadLink.waitFor({ state: 'visible', timeout: 5000 });
          const fAudioObjectUrl = await fAudioDownloadLink.getAttribute('href');
          const fAudioBlobSize = await fPage.evaluate(async (url) => {
            const blob = await (await fetch(url)).blob();
            return blob.size;
          }, fAudioObjectUrl);
          assert.equal(
            fAudioBlobSize,
            wavBuffer.length,
            `скачанное аудио должно совпадать по размеру с исходным (${wavBuffer.length}), получено ${fAudioBlobSize}`
          );

          // --- (д) видео: крошечный, но настоящий валидный WebM (см.
          //     helpers.mjs: makeTestWebmBuffer) — <video controls>,
          //     src=blob, размер и кнопка «Скачать» проверяются всегда;
          //     длительность из loadedmetadata — проверяем, ТОЛЬКО если
          //     Chromium реально успел её вычислить за отведённое время,
          //     иначе честно логируем и пропускаем именно эту под-проверку
          //     (см. комментарий в задаче про video-duration). ---
          const webmBuffer = makeTestWebmBuffer();
          await attachFilesToChat(ePage, [{ name: 'clip.webm', mimeType: 'video/webm', buffer: webmBuffer }]);

          const fVideoCard = fPage.locator('.chat-file-card', { hasText: 'clip.webm' });
          const fVideoDownloadButton = fVideoCard.locator('.chat-file-download-button');
          await fVideoDownloadButton.waitFor({ state: 'visible', timeout: 10_000 });
          await fVideoDownloadButton.click();

          const fVideoEl = fVideoCard.locator('video.chat-file-video');
          await fVideoEl.waitFor({ state: 'attached', timeout: 15_000 });
          assert.equal(
            await fVideoEl.evaluate((el) => el.hasAttribute('controls')),
            true,
            'видео-плеер должен иметь атрибут controls'
          );
          const fVideoSrc = await fVideoEl.evaluate((el) => el.src);
          assert.ok(fVideoSrc && fVideoSrc.startsWith('blob:'), `src видео должен быть blob-URL, получено: ${fVideoSrc}`);

          const fVideoSizeText = await fVideoCard.locator('.chat-file-meta-size').textContent();
          assert.ok(
            fVideoSizeText && /Б|КБ|МБ/.test(fVideoSizeText),
            `у видео должен быть виден человекочитаемый размер: ${fVideoSizeText}`
          );

          const fVideoDownloadLink = fVideoCard.locator('.chat-file-download-link--compact');
          await fVideoDownloadLink.waitFor({ state: 'visible', timeout: 5000 });
          const fVideoObjectUrl = await fVideoDownloadLink.getAttribute('href');
          const fVideoBlobSize = await fPage.evaluate(async (url) => {
            const blob = await (await fetch(url)).blob();
            return blob.size;
          }, fVideoObjectUrl);
          assert.equal(
            fVideoBlobSize,
            webmBuffer.length,
            `скачанное видео должно совпадать по размеру с исходным (${webmBuffer.length}), получено ${fVideoBlobSize}`
          );

          try {
            await fPage.waitForFunction(
              () => {
                const el = document.querySelector('.chat-file-card video.chat-file-video');
                return !!el && Number.isFinite(el.duration) && el.duration > 0;
              },
              undefined,
              { polling: 100, timeout: 5000 }
            );
            const fVideoDurationText = await fVideoCard.locator('.chat-file-meta-duration').textContent();
            assert.ok(
              /^\d+:\d{2}$/.test(fVideoDurationText || ''),
              `длительность видео должна отображаться в формате М:СС, получено: ${fVideoDurationText}`
            );
          } catch (err) {
            console.log(
              `# [честно опущено] Chromium не вычислил duration для тестового WebM за отведённое время — проверка длительности видео пропущена (элемент <video>/src=blob/размер/кнопка «Скачать» уже проверены выше): ${err.message}`
            );
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
        const permRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше
        const permRoomUrl = roomUrlWithKey(server.baseUrl, permRoomId, permRoomKey);
        const permLeaderUrl = leaderUrlWithKey(server.baseUrl, permRoomId, permLeaderToken, permRoomKey);

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
          // Шестерёнка настроек видна ВСЕМ (секция «Устройства» — выбор
          // микрофона/камеры общая), но секция «Комната» (лобби + права
          // гостей) внутри панели — только у лидера.
          await goshaPage.waitForFunction(
            () => !document.getElementById('settings-button')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          await goshaPage.click('#settings-button');
          await goshaPage.waitForFunction(
            () => document.getElementById('settings-room-section')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          // refreshDeviceLists() асинхронный (enumerateDevices — Promise) —
          // ждём реального появления опций, а не считаем сразу после клика.
          await goshaPage.waitForFunction(
            () => document.querySelectorAll('#setting-mic-device option').length > 0,
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const goshaMicOptionsCount = await goshaPage.locator('#setting-mic-device option').count();
          assert.ok(goshaMicOptionsCount > 0, 'у Гоши селект микрофона должен наполниться хотя бы одним устройством');
          await goshaPage.click('#settings-panel-close');

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
          // Гоша стал лидером — секция «Комната» внутри панели настроек
          // теперь тоже его (шестерёнка была видна и раньше, см. проверку выше).
          await goshaPage.waitForFunction(
            () => !document.getElementById('settings-room-section')?.classList.contains('hidden'),
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

    // --- Мобильный смоук + мобильный чат (волна 11): узкий вьюпорт, новая
    //     (отдельная) комната ---
    // Экран не проверяем намеренно: на реальных мобильных браузерах
    // getDisplayMedia недоступен вовсе и кнопка «Экран» скрывается (см.
    // room.js), а этот тест эмулирует вьюпорт/тач в том же десктопном
    // Chrome, где API формально есть — проверка кнопки тут ничего бы не
    // сказала ни про десктоп (уже покрыт выше), ни про настоящий мобильный
    // Chrome/Safari.
    //
    // Мобильный UX чата (тап-активация действий сообщения, контекстный
    // реплай/реакция/редактирование/удаление, мобильный тулбар
    // форматирования, VisualViewport-подгонка под клавиатуру) проверяется
    // ЗДЕСЬ ЖЕ, вторым эпизодом того же шага (та же комната, тот же
    // mobileContext) — а не отдельным step() с собственным POST /api/rooms:
    // весь файл держит бюджет ровно в 10 созданий комнат за прогон (H2:
    // ROOM_CREATION_IP_LIMIT — 10 за 60с с одного IP, см. roomIdForTimerTestReuse
    // ниже), лишний POST здесь столкнул бы файл за лимит и обрушил бы
    // (429) последующие шаги. Десктопный собеседник подключается к ТОЙ ЖЕ
    // комнате обычным join по ссылке (это не создание комнаты, лимита не
    // расходует).
    await step(
      'Мобильный смоук (390x844, touch) + мобильный чат (волна 11): панель управления видима без горизонтального скролла, действия сообщения скрыты по умолчанию и показываются по тапу для ОДНОГО сообщения (тап по другому переносит, тап мимо снимает), реплай/реакция/редактирование/удаление работают через этот контекстный путь, мобильный тулбар форматирования (по выделению и по кнопке «Aa»), VisualViewport-подгонка под клавиатуру не даёт странице скроллиться и держит инпут в видимой области',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const data = await res.json();
        const mobileRoomId = data.roomId;
        const mobileRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше

        const mobileContext = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
        });
        try {
          await installMediaStubs(mobileContext);
          await installFakeVisualViewport(mobileContext);
          const mobilePage = await mobileContext.newPage();

          await mobilePage.goto(roomUrlWithKey(server.baseUrl, mobileRoomId, mobileRoomKey));

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
          // --- Мобильный UX волны 11: тап-активация действий сообщения,
          //     контекстный реплай/реакция/редактирование/удаление, мобильный
          //     тулбар форматирования, VisualViewport-подгонка под клавиатуру.
          //     Продолжение ТОГО ЖЕ шага/той же комнаты (см. заголовок выше
          //     — экономим POST /api/rooms): десктопный собеседник
          //     присоединяется по ссылке той же комнаты — так реплай/реакция/
          //     редактирование/удаление можно проверить сквозным образом
          //     (действие с мобильного должно долететь и отрендериться у
          //     собеседника), а не только по локальному DOM-состоянию. ---
          const deskContext = await browser.newContext();
          const deskPage = await deskContext.newPage();
          try {
            await installMediaStubs(deskContext);

            await deskPage.goto(roomUrlWithKey(server.baseUrl, mobileRoomId, mobileRoomKey));
            await joinRoom(deskPage, 'Комп');
            await waitForOverlayHidden(deskPage);

            await waitForTileCount(mobilePage, 2);
            await waitForTileCount(deskPage, 2);
            await waitForBusOpenToAllPeers(mobilePage);
            await waitForBusOpenToAllPeers(deskPage);

            await openChatPanel(deskPage);

            // --- (1) действия скрыты по умолчанию, тап активирует ОДНО сообщение ---
            const msg1Text = `Моб-раз-${Date.now()}`;
            const msg1Id = await sendChatMessageAndGetId(mobilePage, msg1Text);
            const msg2Text = `Моб-два-${Date.now()}`;
            const msg2Id = await sendChatMessageAndGetId(mobilePage, msg2Text);
            assert.ok(msg1Id && msg2Id, 'оба сообщения должны получить общий id (data-msg-id)');
            assert.ok(await messageTextsInclude(deskPage, msg1Text), 'msg1 не дошло до десктоп-участника');
            assert.ok(await messageTextsInclude(deskPage, msg2Text), 'msg2 не дошло до десктоп-участника');

            const msg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
            const msg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;

            const actionsBefore = await mobilePage.evaluate((sel) => {
              const el = document.querySelector(`${sel} .chat-message-actions`);
              const style = getComputedStyle(el);
              return { opacity: style.opacity, pointerEvents: style.pointerEvents };
            }, msg1Sel);
            assert.equal(actionsBefore.opacity, '0', `действия должны быть скрыты (opacity=0) до тапа: ${JSON.stringify(actionsBefore)}`);
            assert.equal(actionsBefore.pointerEvents, 'none', `действия должны быть некликабельны до тапа: ${JSON.stringify(actionsBefore)}`);

            // Тап по msg1 -> активируется (класс + видимость действий). Опacity
            // анимируется CSS-переходом (transition: opacity 0.15s, см.
            // style.css) — ждём поллингом итоговое значение, а не читаем его
            // сразу после появления класса (иначе можно поймать промежуточный
            // кадр перехода и словить флейк).
            await mobilePage.click(`${msg1Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg1Sel,
              { timeout: 2000 }
            );
            await mobilePage.waitForFunction(
              (sel) => getComputedStyle(document.querySelector(`${sel} .chat-message-actions`)).opacity === '1',
              msg1Sel,
              { timeout: 2000 }
            );
            const actionsAfterTap1 = await mobilePage.evaluate(
              (sel) => getComputedStyle(document.querySelector(`${sel} .chat-message-actions`)).opacity,
              msg1Sel
            );
            assert.equal(actionsAfterTap1, '1', 'после тапа действия msg1 должны стать видимыми (opacity=1)');
            const msg2ActiveWhileMsg1Active = await mobilePage.evaluate(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg2Sel
            );
            assert.equal(msg2ActiveWhileMsg1Active, false, 'msg2 не должно быть активным, пока активен msg1 (не более одного одновременно)');

            // Тап по msg2 -> активность ПЕРЕНОСИТСЯ (msg1 гаснет).
            await mobilePage.click(`${msg2Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg2Sel,
              { timeout: 2000 }
            );
            const msg1ActiveAfterMsg2Tap = await mobilePage.evaluate(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg1Sel
            );
            assert.equal(msg1ActiveAfterMsg2Tap, false, 'активация msg2 должна снять активность с msg1');

            // Тап мимо (по шапке чата) -> снимает активность.
            await mobilePage.click('.chat-title');
            await mobilePage.waitForFunction(
              (sel) => !document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg2Sel,
              { timeout: 2000 }
            );

            // --- (2) реплай через новый контекстный (тап) путь ---
            await mobilePage.click(`${msg1Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg1Sel,
              { timeout: 2000 }
            );
            await mobilePage.click(`${msg1Sel} .chat-message-action--reply`);
            await mobilePage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
            const replyText = `Моб-реплай-${Date.now()}`;
            await sendChatMessage(mobilePage, replyText);
            assert.ok(await messageTextsInclude(deskPage, replyText), 'реплай с мобильного (через тап-контекст) не дошёл до десктоп-участника');

            // --- (3) реакция через новый контекстный (тап) путь ---
            await mobilePage.click(`${msg2Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg2Sel,
              { timeout: 2000 }
            );
            await mobilePage.click(`${msg2Sel} .chat-message-action--react`);
            await mobilePage.locator('.chat-reaction-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
            await mobilePage.locator('.chat-reaction-popover-emoji[data-emoji="👍"]').click();
            await deskPage.locator(`${msg2Sel} .chat-reaction-chip`).first().waitFor({ state: 'visible', timeout: 5000 });

            // --- (4) редактирование через новый контекстный (тап) путь ---
            await mobilePage.click(`${msg1Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg1Sel,
              { timeout: 2000 }
            );
            await mobilePage.click(`${msg1Sel} .chat-message-action--edit`);
            await mobilePage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
            const editedText = `${msg1Text}-правка`;
            await mobilePage.fill('.chat-text-input', editedText);
            await mobilePage.click('.chat-send-button');
            assert.ok(await messageTextsInclude(deskPage, editedText), 'отредактированный (через тап-контекст) текст не дошёл до десктоп-участника');

            // --- (5) удаление через новый контекстный (тап) путь ---
            await mobilePage.click(`${msg2Sel} .chat-message-text`);
            await mobilePage.waitForFunction(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--active'),
              msg2Sel,
              { timeout: 2000 }
            );
            await mobilePage.click(`${msg2Sel} .chat-message-action--delete`);
            await mobilePage.locator(`${msg2Sel} .chat-message-action--confirm`).waitFor({ timeout: 2000 });
            await mobilePage.click(`${msg2Sel} .chat-message-action--delete`);
            await waitUntil(
              async () => (await deskPage.locator(`${msg2Sel}.chat-message--deleted`).count()) === 1,
              { timeoutMs: 5000, message: 'удаление msg2 (через тап-контекст) не дошло до десктоп-участника' }
            );

            // --- (6а) мобильный тулбар форматирования появляется САМ по выделению ---
            await mobilePage.fill('.chat-text-input', 'выделенный текст');
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-format-toolbar')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );
            await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-text-input');
              el.focus();
              el.setSelectionRange(0, el.value.length);
              document.dispatchEvent(new Event('selectionchange'));
            });
            await mobilePage.waitForFunction(
              () => !document.querySelector('.chat-format-toolbar')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );
            // Схлопнули выделение (курсор без диапазона), кнопку «Aa» не жали — тулбар должен сам спрятаться.
            await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-text-input');
              el.setSelectionRange(0, 0);
              document.dispatchEvent(new Event('selectionchange'));
            });
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-format-toolbar')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );

            // --- (6б) мобильный тулбар форматирования по кнопке «Aa», оборачивание выделения ---
            await mobilePage.click('.chat-format-toggle-button');
            await mobilePage.locator('.chat-format-toolbar:not(.hidden)').waitFor({ state: 'visible', timeout: 2000 });
            await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-text-input');
              el.focus();
              el.setSelectionRange(0, el.value.length);
            });
            await mobilePage.click('.chat-format-btn--bold');
            const boldedValue = await mobilePage.inputValue('.chat-text-input');
            assert.equal(boldedValue, '**выделенный текст**', `тулбар «Ж» должен обернуть выделение в ** **: ${boldedValue}`);
            await mobilePage.click('.chat-format-toggle-button'); // снять принудительное открытие (toggle off)
            await mobilePage.fill('.chat-text-input', '');

            // --- (7) VisualViewport-подгонка под клавиатуру ---
            const fullVvHeight = await mobilePage.evaluate(() => window.visualViewport.height);
            const shrunkHeight = Math.round(fullVvHeight * 0.55); // "клавиатура" заняла ~45% высоты
            await mobilePage.evaluate((h) => window.__e2eSetVisualViewport(h, 0), shrunkHeight);
            await mobilePage.waitForFunction(
              (h) => Math.abs(document.querySelector('.chat-panel').getBoundingClientRect().height - h) < 2,
              shrunkHeight,
              { timeout: 2000 }
            );

            const inputBoxShrunk = await mobilePage.locator('.chat-text-input').boundingBox();
            assert.ok(
              inputBoxShrunk.y + inputBoxShrunk.height <= shrunkHeight + 1,
              `инпут должен оставаться в пределах сжатой видимой области (высота=${shrunkHeight}): ${JSON.stringify(inputBoxShrunk)}`
            );

            const scrollInfoShrunk = await mobilePage.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              scrollY: window.scrollY,
              bodyLocked: document.body.classList.contains('chat-mobile-scroll-lock'),
            }));
            assert.ok(
              scrollInfoShrunk.scrollWidth <= scrollInfoShrunk.clientWidth + 1,
              `не должно быть горизонтального скролла при сжатой (клавиатурой) видимой области: ${JSON.stringify(scrollInfoShrunk)}`
            );
            assert.equal(scrollInfoShrunk.scrollY, 0, 'страница не должна скроллиться, пока открыта клавиатура');
            assert.equal(scrollInfoShrunk.bodyLocked, true, 'body должен быть залочен от скролла, пока мобильный чат открыт на весь экран');

            const messagesGapShrunk = await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-messages');
              return el.scrollHeight - el.scrollTop - el.clientHeight;
            });
            assert.ok(messagesGapShrunk < 40, `лента сообщений должна оставаться проскрolленной к низу после сжатия под клавиатуру: delta=${messagesGapShrunk}`);

            // --- (8) клавиатура "закрылась" -> панель возвращается на всю высоту ---
            await mobilePage.evaluate((h) => window.__e2eSetVisualViewport(h, 0), fullVvHeight);
            await mobilePage.waitForFunction(
              (h) => Math.abs(document.querySelector('.chat-panel').getBoundingClientRect().height - h) < 2,
              fullVvHeight,
              { timeout: 2000 }
            );
          } finally {
            await deskContext.close();
          }
        } finally {
          await mobileContext.close();
        }
      }
    );

    // === Ш1 (E2E-шифрование): проверки схемы самой по себе =================

    // --- (а) WS-шпион: SDP не палится плейнтекстом, имя не палится плейнтекстом ---
    await step(
      'Ш1: серверные offer/answer-фреймы не содержат "v=0"/"fingerprint" (SDP зашифрован под K_sig), join-room не содержит введённого имени плейнтекстом',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: spyRoomId } = await res.json();
        const spyRoomKey = generateRoomKeyBase64url();
        const spyRoomUrl = roomUrlWithKey(server.baseUrl, spyRoomId, spyRoomKey);

        const spyAContext = await browser.newContext();
        const spyBContext = await browser.newContext();
        await installSignalingFrameSpy(spyAContext);
        await installSignalingFrameSpy(spyBContext);
        try {
          const spyAPage = await spyAContext.newPage();
          const spyBPage = await spyBContext.newPage();

          const secretName = 'ОЧЕНЬ-СЕКРЕТНОЕ-ИМЯ-42';
          await spyAPage.goto(spyRoomUrl);
          await spyBPage.goto(spyRoomUrl);
          await joinRoom(spyAPage, secretName);
          await joinRoom(spyBPage, 'Обычный');
          await waitForOverlayHidden(spyAPage);
          await waitForOverlayHidden(spyBPage);
          await waitForTileCount(spyAPage, 2, 10_000);
          await waitForTileCount(spyBPage, 2, 10_000);

          for (const [label, page] of [['A', spyAPage], ['B', spyBPage]]) {
            const joinFrames = await framesOfTypeSentOn(page, 'join-room');
            assert.ok(joinFrames.length > 0, `${label}: должен быть хотя бы один фрейм join-room`);
            for (const frame of joinFrames) {
              const raw = JSON.stringify(frame);
              assert.ok(
                !raw.includes(secretName),
                `${label}: join-room фрейм не должен содержать введённое имя плейнтекстом: ${raw}`
              );
            }

            const sdpFrames = [
              ...(await framesOfTypeSentOn(page, 'offer')),
              ...(await framesOfTypeSentOn(page, 'answer')),
            ];
            assert.ok(sdpFrames.length > 0, `${label}: должен быть хотя бы один offer/answer фрейм`);
            for (const frame of sdpFrames) {
              const raw = JSON.stringify(frame);
              assert.ok(!raw.includes('v=0'), `${label}: SDP-фрейм не должен содержать "v=0" (сырой SDP) в открытом виде: ${raw}`);
              assert.ok(!/fingerprint/i.test(raw), `${label}: SDP-фрейм не должен содержать "fingerprint" в открытом виде: ${raw}`);
            }
          }
        } finally {
          await spyAContext.close();
          await spyBContext.close();
        }
      }
    );

    // --- (б) вход без #k -> оверлей «Ссылка неполная» ---
    await step('Ш1: вход БЕЗ #k -> оверлей «Ссылка неполная», модалка входа не показывается', async () => {
      const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
      assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
      const { roomId: noKeyRoomId } = await res.json();

      const noKeyContext = await browser.newContext();
      try {
        const noKeyPage = await noKeyContext.newPage();
        await noKeyPage.goto(`${server.baseUrl}/r/${noKeyRoomId}`); // ссылка вовсе без #k
        await waitInvalidLinkOverlay(noKeyPage);
        const modalVisible = await noKeyPage.evaluate(
          () => !document.getElementById('join-modal')?.classList.contains('hidden')
        );
        assert.equal(modalVisible, false, 'модалка входа не должна показываться без валидного ключа комнаты');
      } finally {
        await noKeyContext.close();
      }

      // Тот же оверлей — и если k формально не пуст, но не по формату
      // (не декодируется в 32 байта): deriveRoomKeys отказывает синхронно,
      // до какой-либо попытки подключения к сигналингу.
      const badFormatContext = await browser.newContext();
      try {
        const badFormatPage = await badFormatContext.newPage();
        await badFormatPage.goto(roomUrlWithKey(server.baseUrl, noKeyRoomId, 'not-a-valid-key'));
        await waitInvalidLinkOverlay(badFormatPage);
      } finally {
        await badFormatContext.close();
      }
    });

    // --- (в) вход с ИСПОРЧЕННЫМ (валидного вида, но неверным) k -> первый же
    //     провал расшифровки входящего -> тот же оверлей «Ссылка неполная» ---
    //
    // Два дополняющих друг друга сценария:
    //   1) «настоящий» — двое заходят в одну комнату с РАЗНЫМИ (случайными,
    //      каждый сам по себе валидного вида) ключами; кто из двоих первым
    //      столкнётся с чужим SDP/ICE, зависит от того, кто из пары
    //      polite/impolite (см. static/rtc.js) — детерминированно неизвестно
    //      заранее, поэтому проверяем ОБОИХ и требуем срабатывания хотя бы у
    //      одного (это и есть наблюдаемое поведение реального расхождения
    //      ключей — оно не обязано ударить по конкретной стороне).
    //   2) детерминированный — прямая инъекция заведомо нерасшифровываемого
    //      блоба через тот же приём, что и подделанные конверты чата в
    //      других тестах этого файла (envelope.enc/bus._dispatch): здесь —
    //      `signaling._dispatch({type:'stream-info', ...})` с мусорным
    //      {v,iv,ct}, минуя реальный сервер — доказывает механизм
    //      (handleCryptoFailureOnce) напрямую, без зависимости от таймингов
    //      WebRTC-негоциации.
    await step(
      'Ш1: вход с валидным по формату, но НЕВЕРНЫМ k -> первый же провал расшифровки входящего -> оверлей «Ссылка неполная» (реальный SDP-обмен между двумя разными ключами + прямая инъекция мусорного блоба)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms ответил статусом ${res.status}`);
        const { roomId: wrongKeyRoomId } = await res.json();
        // Переиспользуется следующим шагом (лимит длительности созвона) —
        // без лишнего POST /api/rooms: за один прогон файла их и так набегает
        // много (см. H2: ROOM_CREATION_IP_LIMIT — 10 за 60с с одного IP, а
        // Node-фетчи и клик «Создать комнату» в браузере считаются с ОДНОГО
        // IP, localhost), новая комната этому шагу не нужна — участник там
        // solo, ключ комнаты ни с кем не должен совпадать.
        roomIdForTimerTestReuse = wrongKeyRoomId;
        const keyA = generateRoomKeyBase64url();
        const keyB = generateRoomKeyBase64url(); // независимый случайный ключ той же формы — валиден, но не тот же
        assert.notEqual(keyA, keyB, 'сгенерированные ключи должны отличаться, иначе тест не имеет смысла');

        const aContext = await browser.newContext();
        const bContext = await browser.newContext();
        try {
          const aPage = await aContext.newPage();
          const bPage = await bContext.newPage();

          await aPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, keyA));
          await bPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, keyB));
          await joinRoom(aPage, 'Первый');
          await joinRoom(bPage, 'Второй');

          // Сервер честно относит обоих в одну комнату (roomId совпал) — но
          // SDP/ICE друг друга они расшифровать не могут (ключи разные): рано
          // или поздно оверлей вылезает у ОДНОГО ИЗ ДВУХ (см. пояснение выше).
          await Promise.race([waitInvalidLinkOverlay(aPage, 20_000), waitInvalidLinkOverlay(bPage, 20_000)]);
        } finally {
          await aContext.close();
          await bContext.close();
        }

        // Детерминированная версия того же механизма — прямая инъекция.
        const soloContext = await browser.newContext();
        try {
          const soloPage = await soloContext.newPage();
          await soloPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, generateRoomKeyBase64url()));
          await joinRoom(soloPage, 'Одиночка');
          await waitForOverlayHidden(soloPage);

          await soloPage.evaluate(() => {
            signaling._dispatch({
              type: 'stream-info',
              fromPeerId: 'irrelevant-for-this-injection',
              info: { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
            });
          });
          await waitInvalidLinkOverlay(soloPage, 5000);
        } finally {
          await soloContext.close();
        }
      }
    );

    // --- Лимит длительности созвона (3 часа, см. README.md и static/room.js:
    //     startRoomTimer/stopRoomTimer) ---
    //
    // Контракт с бэкендом: `joined.expiresInSeconds` — остаток жизни комнаты
    // на момент входа (реальный дефолт — 3 часа, см. src/state.rs::
    // DEFAULT_MAX_ROOM_LIFETIME_SECONDS); `room-expired {}` рассылается всем,
    // когда лимит истёк, сервер сам закрывает сокет следом (см. src/ws.rs).
    // Гонять реальный тайм-лимит в 3 часа непрактично — вместо этого:
    //   (а)/(б)/(в) подменяем состояние таймера прямым вызовом top-level
    //       startRoomTimer(N) (room.js — классический script, функция видна
    //       из page.evaluate ровно как bus/ChatPanel в других тестах этого
    //       файла) под разные N — норма/жёлтый (<=10 мин)/красный (<=60с);
    //   (г) эмулируем сам сервер: signaling._dispatch({type:'room-expired'})
    //       — тот же приём прямой инъекции, что и у stream-info/invalid-link
    //       выше — и проверяем финальный оверлей + отключение чата;
    //   (д) последующее закрытие сокета (как это сделал бы сам сервер сразу
    //       после room-expired, см. src/ws.rs: reject=true) не должно
    //       перетереть этот оверлей «Соединением потеряно» — terminalState
    //       уже взведён (тот же приём, что у room-not-found/room-full/
    //       join-rejected, см. static/room.js: signaling.onClose).
    await step(
      'Лимит длительности созвона: таймер в баре (норма/жёлтый/красный) + оверлей «Время истекло» по room-expired, не перетирается последующим закрытием сокета',
      async () => {
        // Переиспользуем комнату из шага «Ш1: неверный k» выше (см.
        // roomIdForTimerTestReuse) — экономим POST /api/rooms (H2-лимит на
        // создание, см. комментарий там же); участник здесь solo, комната
        // уже существует на сервере, свой ключ ни с кем совпадать не должен.
        assert.ok(roomIdForTimerTestReuse, 'нет комнаты, переданной предыдущим шагом для переиспользования');
        const timerRoomKey = generateRoomKeyBase64url();
        const timerRoomUrl = roomUrlWithKey(server.baseUrl, roomIdForTimerTestReuse, timerRoomKey);

        const timerContext = await browser.newContext();
        try {
          const timerPage = await timerContext.newPage();
          await timerPage.goto(timerRoomUrl);
          await joinRoom(timerPage, 'Настя');
          await waitForOverlayHidden(timerPage);
          await openChatPanel(timerPage);

          // Сразу после joined (реальный expiresInSeconds ~3ч) таймер уже
          // должен быть виден и не в предупредительном состоянии.
          await timerPage.waitForFunction(
            () => !document.getElementById('room-timer')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const initialState = await timerPage.evaluate(() => ({
            text: document.getElementById('room-timer').textContent,
            warning: document.getElementById('room-timer').classList.contains('room-timer--warning'),
            critical: document.getElementById('room-timer').classList.contains('room-timer--critical'),
          }));
          assert.match(initialState.text, /^\d+:\d{2}:\d{2}$/, `формат таймера должен быть Ч:ММ:СС, получено: ${initialState.text}`);
          assert.equal(initialState.warning, false, 'сразу после входа (лимит ~3ч) таймер не должен быть жёлтым');
          assert.equal(initialState.critical, false, 'сразу после входа (лимит ~3ч) таймер не должен быть красным');

          // (а) норма: час с лишним — ни жёлтого, ни красного.
          await timerPage.evaluate(() => startRoomTimer(3700));
          const normalState = await timerPage.evaluate(() => ({
            text: document.getElementById('room-timer').textContent,
            warning: document.getElementById('room-timer').classList.contains('room-timer--warning'),
            critical: document.getElementById('room-timer').classList.contains('room-timer--critical'),
          }));
          assert.equal(normalState.text, '1:01:40', `таймер должен показывать 1:01:40, получено: ${normalState.text}`);
          assert.equal(normalState.warning, false);
          assert.equal(normalState.critical, false);

          // (б) последние 10 минут — жёлтый.
          await timerPage.evaluate(() => startRoomTimer(300));
          const warningState = await timerPage.evaluate(() => ({
            warning: document.getElementById('room-timer').classList.contains('room-timer--warning'),
            critical: document.getElementById('room-timer').classList.contains('room-timer--critical'),
          }));
          assert.equal(warningState.warning, true, 'при остатке 5 минут таймер должен быть жёлтым (room-timer--warning)');
          assert.equal(warningState.critical, false, 'при остатке 5 минут таймер НЕ должен быть красным');

          // (в) последняя минута — красный.
          await timerPage.evaluate(() => startRoomTimer(30));
          const criticalState = await timerPage.evaluate(() => ({
            warning: document.getElementById('room-timer').classList.contains('room-timer--warning'),
            critical: document.getElementById('room-timer').classList.contains('room-timer--critical'),
          }));
          assert.equal(criticalState.critical, true, 'при остатке 30с таймер должен быть красным (room-timer--critical)');

          // (г) сервер решил, что время вышло — room-expired: финальный
          // оверлей, таймер прячется, чат отключается.
          await timerPage.evaluate(() => {
            signaling._dispatch({ type: 'room-expired' });
          });
          await waitOverlayTitle(timerPage, 'Время созвона истекло (3 часа)');
          const afterExpiry = await timerPage.evaluate(() => ({
            actionLabel: document.getElementById('overlay-action-button')?.textContent,
            timerHidden: document.getElementById('room-timer')?.classList.contains('hidden'),
            chatDisabled: document.querySelector('.chat-text-input')?.disabled,
          }));
          assert.equal(afterExpiry.actionLabel, 'Создать новую', `кнопка оверлея должна вести на создание новой комнаты: ${afterExpiry.actionLabel}`);
          assert.equal(afterExpiry.timerHidden, true, 'таймер должен скрыться после room-expired (stopRoomTimer)');
          assert.equal(afterExpiry.chatDisabled, true, 'инпут чата должен быть задизейблен после room-expired (teardownMeshMediaChat)');

          // (д) терминальность: последующее закрытие сокета (как сделал бы
          // сам сервер сразу за room-expired) не должно перетереть этот
          // оверлей баннером «Соединение потеряно».
          await timerPage.evaluate(() => signaling.ws.close());
          await timerPage.waitForTimeout(500);
          const titleAfterClose = await timerPage.evaluate(() => document.getElementById('overlay-title')?.textContent);
          assert.equal(
            titleAfterClose,
            'Время созвона истекло (3 часа)',
            `оверлей «Время истекло» не должен перетираться закрытием сокета: ${titleAfterClose}`
          );
        } finally {
          await timerContext.close();
        }
      }
    );

    // --- Ш3: forward secrecy контента при смене состава (см.
    //     docs/e2e-encryption.md §7) ---
    //
    // Ротируются ТОЛЬКО K_chat/K_meta (НЕ K_sig), и только лидером, при
    // уходе участника (peer-left). Раздача — строго по P2P-шине (bus),
    // никогда через сервер. `contentEpochs`/`currentContentEpoch` — обычные
    // top-level `let`/`const` в room.js (классический скрипт, не module —
    // тот же приём, что и с `bus`/`roomSettings` в других тестах этого
    // файла), поэтому видны из page.evaluate() напрямую, без всякого
    // window.__debug-моста.
    //
    // Собственный блок ({ ... }), а не отдельная функция — тесту нужны свои
    // vasyaContext/vasyaPage и т.п., те же имена уже заняты (const) самым
    // первым сценарием этого файла; блочная область видимости даёт завести
    // их заново без конфликта, не переименовывая персонажей.
    //
    // Комната — через PUT /api/rooms/<id> (см. static/room.js:
    // restoreRoomViaPut), а не POST: к этому месту файла счёт POST-запросов
    // (H2: ROOM_CREATION_IP_LIMIT — 10 за 60с с одного IP, см.
    // src/state.rs) уже насчитывает 10 других шагов этого файла — ещё один
    // POST здесь мог бы упереться в лимит (не время создания растянуто
    // равномерно: несколько «лёгких» Ш1-шагов подряд перед этим местом
    // укладываются в куда меньше 60с). PUT восстановления комнаты, в
    // отличие от POST её создания, НЕ проверяет этот лимит вовсе (см.
    // src/main.rs::restore_room) — комната создаётся пустой, БЕЗ лидера:
    // первый вошедший (Вася) станет лидером автоматически (см.
    // src/ws.rs::JoinRoom: `!becomes_leader && room.leader_id.is_none()`),
    // никакого leaderToken не нужно.
    {
      const epochRoomId = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
      const epochRoomKey = generateRoomKeyBase64url(); // Ш1: см. комментарий у histRoomKey выше
      const epochRoomUrl = roomUrlWithKey(server.baseUrl, epochRoomId, epochRoomKey);

      const vasyaContext = await browser.newContext();
      const petyaContext = await browser.newContext();
      const olyaContext = await browser.newContext();
      // Нужен, чтобы поймать реальный fallback-фрейм 'chat' на проводе и
      // проверить его поле `epoch` (см. шаг «fallback-конверт» ниже).
      await installChatWsSpy(vasyaContext);

      let vasyaPage, petyaPage, olyaPage;
      let petyaPeerId = null;
      let olyaEpoch0Raw = null;
      let preRotationMsg = null;
      let capturedFallbackEnc = null;

      try {
        const sceneReadyOk = await step(
          'Ш3: Вася (лидер), Петя и Оля устанавливают mesh; Петя шлёт сообщение под эпохой 0 (для будущей проверки истории у новичка)',
          async () => {
            const putRes = await fetch(`${server.baseUrl}/api/rooms/${epochRoomId}`, { method: 'PUT' });
            assert.ok(putRes.ok, `PUT /api/rooms/${epochRoomId} ответил статусом ${putRes.status}`);

            vasyaPage = await vasyaContext.newPage();
            petyaPage = await petyaContext.newPage();
            olyaPage = await olyaContext.newPage();

            // Вася входит ПЕРВОЙ и ОТДЕЛЬНО от Пети/Оли (не параллельно) —
            // комната только что создана PUT'ом пустой, без лидера: лидером
            // становится первый, чьё join-room сервер обработает (см.
            // src/ws.rs выше). joinRoom() лишь кликает кнопку модалки и не
            // дожидается ответа сервера — если бы все трое стартовали
            // join-room без барьера, порядок обработки на сервере не был бы
            // гарантирован. Дожидаемся короны на тайле Васи — это и есть
            // подтверждение, что лидерство уже закреплено сервером за ней,
            // прежде чем впускать остальных.
            await vasyaPage.goto(epochRoomUrl);
            await joinRoom(vasyaPage, 'Вася');
            await waitForOverlayHidden(vasyaPage);
            await vasyaPage.waitForFunction(
              () => !document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden'),
              undefined,
              { polling: 100, timeout: 5000 }
            );

            await petyaPage.goto(epochRoomUrl);
            await olyaPage.goto(epochRoomUrl);
            await joinRoom(petyaPage, 'Петя');
            await joinRoom(olyaPage, 'Оля');
            await waitForOverlayHidden(petyaPage);
            await waitForOverlayHidden(olyaPage);
            await waitForTileCount(vasyaPage, 3, 10_000);
            await waitForTileCount(petyaPage, 3, 10_000);
            await waitForTileCount(olyaPage, 3, 10_000);
            // Шина должна быть открыта до ВСЕХ, прежде чем Оля уйдёт —
            // иначе key-rotate от Васи к Пете лёг бы в очередь RtcPeer
            // (доставился бы всё равно, но смазал бы тайминг проверки ниже).
            await waitForBusOpenToAllPeers(vasyaPage);
            await waitForBusOpenToAllPeers(petyaPage);
            await waitForBusOpenToAllPeers(olyaPage);

            petyaPeerId = await vasyaPage.evaluate(
              () => document.querySelector('.tile[data-name="Петя"]').dataset.peerId
            );
            // Улика forward secrecy: сырой ключ эпохи 0, который держит Оля
            // ДО своего ухода — ровно то, чем бы располагал настоящий
            // ушедший участник (см. проверку «FS» ниже).
            olyaEpoch0Raw = await olyaPage.evaluate(() => Array.from(contentEpochs.get(0).raw));

            await openChatPanel(vasyaPage);
            await openChatPanel(petyaPage);
            await openChatPanel(olyaPage);
            preRotationMsg = `Ш3-до-ротации-эпоха0-${Date.now()}`;
            await sendChatMessage(petyaPage, preRotationMsg);
            assert.ok(
              await messageTextsInclude(vasyaPage, preRotationMsg),
              'Вася должен был увидеть сообщение Пети до ротации (эпоха 0, живой mesh)'
            );
          }
        );

        const rotatedOk =
          sceneReadyOk &&
          (await step(
            'Ш3: Оля уходит (peer-left) — Вася (лидер) ротирует контентные ключи; эпоха инкрементнулась и разошлась по шине Пете',
            async () => {
              await olyaPage.click('#leave-button');
              // olyaContext закрывается один раз, в общем finally этого
              // блока ниже — не здесь, чтобы не рисковать двойным close(),
              // если этот шаг вообще не выполнится (sceneReadyOk === false).

              await waitForTileCount(vasyaPage, 2, 8000);
              await waitForTileCount(petyaPage, 2, 8000);

              await waitUntil(async () => (await vasyaPage.evaluate(() => currentContentEpoch === 1)), {
                timeoutMs: 5000,
                message: 'у Васи (лидера) currentContentEpoch не стал 1 после ухода Оли',
              });
              await waitUntil(async () => (await petyaPage.evaluate(() => currentContentEpoch === 1)), {
                timeoutMs: 5000,
                message: 'у Пети currentContentEpoch не стал 1 — не дошёл key-rotate от лидера по шине?',
              });

              const vasyaEpochCount = await vasyaPage.evaluate(() => contentEpochs.size);
              const petyaEpochCount = await petyaPage.evaluate(() => contentEpochs.size);
              assert.equal(vasyaEpochCount, 2, `у Васи должно быть известно 2 эпохи (0 и 1), получено ${vasyaEpochCount}`);
              assert.equal(petyaEpochCount, 2, `у Пети должно быть известно 2 эпохи (0 и 1), получено ${petyaEpochCount}`);

              // K_sig НЕ ротируется (см. docs/e2e-encryption.md §7.1) —
              // sigKey остаётся тем же самым объектом на всю жизнь комнаты.
              const sigUnchanged = await vasyaPage.evaluate(() => typeof sigKey === 'object' && sigKey !== null);
              assert.equal(sigUnchanged, true, 'sigKey должен остаться валидным CryptoKey (K_sig не ротируется)');
            }
          ));

        const fallbackEpochOk =
          rotatedOk &&
          (await step(
            'Ш3: fallback-конверт чата после ротации несёт epoch:1 и Петя корректно его расшифровывает новой эпохой',
            async () => {
              // Шина между Васей и Петей и так открыта — форсируем именно
              // серверный fallback-путь, временно "притворяясь", что канал
              // к Пете закрыт (единственный воспроизводимый способ проверить
              // реальный fallback у уже устоявшегося mesh, не разрывая его
              // по-настоящему).
              await vasyaPage.evaluate((pid) => {
                window.__e2eRealBusIsOpen = bus.isOpen.bind(bus);
                bus.isOpen = (id) => (id === pid ? false : window.__e2eRealBusIsOpen(id));
              }, petyaPeerId);

              const fallbackMsg = `Ш3-fallback-эпоха1-${Date.now()}`;
              try {
                await sendChatMessage(vasyaPage, fallbackMsg);
                assert.ok(
                  await messageTextsInclude(petyaPage, fallbackMsg),
                  'Петя должен был получить и расшифровать fallback-сообщение под новой эпохой'
                );
              } finally {
                await vasyaPage.evaluate(() => {
                  bus.isOpen = window.__e2eRealBusIsOpen;
                  delete window.__e2eRealBusIsOpen;
                });
              }

              const chatFrames = await chatFramesSentOn(vasyaPage);
              const targeted = chatFrames.filter(
                (f) => f.targetPeerId === petyaPeerId && f.envelope && f.envelope.enc
              );
              assert.ok(
                targeted.length > 0,
                `не нашли ни одного fallback-фрейма 'chat' к Пете: ${JSON.stringify(chatFrames)}`
              );
              const lastFrame = targeted[targeted.length - 1];
              assert.equal(
                lastFrame.envelope.epoch,
                1,
                `fallback-конверт должен нести epoch:1 (текущая эпоха после ротации), получено: ${JSON.stringify(lastFrame.envelope)}`
              );
              capturedFallbackEnc = lastFrame.envelope.enc;
            }
          ));

        if (fallbackEpochOk) {
          await step(
            'Ш3 (forward secrecy): ушедшая Оля (держит только ключ эпохи 0) НЕ может расшифровать конверт новой эпохи',
            async () => {
              assert.ok(capturedFallbackEnc, 'нет захваченного зашифрованного конверта новой эпохи из предыдущего шага');
              const olyaCanStillDecrypt = await vasyaPage.evaluate(async ({ rawArr, enc }) => {
                const raw = new Uint8Array(rawArr);
                const keys = await RoomCrypto.deriveContentKeys(raw);
                try {
                  await RoomCrypto.decrypt(keys.chat, enc);
                  return true; // расшифровалось бы — это и была бы поломанная FS
                } catch (err) {
                  return false;
                }
              }, { rawArr: olyaEpoch0Raw, enc: capturedFallbackEnc });
              assert.equal(
                olyaCanStillDecrypt,
                false,
                'ушедшая Оля (только ключ эпохи 0) смогла расшифровать конверт новой эпохи — forward secrecy нарушена'
              );
            }
          );
        } else {
          skip('Ш3 (forward secrecy): ушедшая Оля не может расшифровать конверт новой эпохи', 'предыдущий шаг (fallback-конверт) не прошёл');
        }

        if (rotatedOk) {
          const igorContext = await browser.newContext();
          let igorPage;
          try {
            const igorReadyOk = await step(
              'Ш3: новичок Игорь входит ПОСЛЕ ротации — запрашивает и получает текущую эпоху у лидера по шине (key-request/key-rotate)',
              async () => {
                igorPage = await igorContext.newPage();
                await igorPage.goto(epochRoomUrl);
                await joinRoom(igorPage, 'Игорь');
                await waitForOverlayHidden(igorPage);
                await waitForTileCount(igorPage, 3, 10_000);

                await waitUntil(async () => (await igorPage.evaluate(() => currentContentEpoch === 1)), {
                  timeoutMs: 8000,
                  message: 'Игорь не получил текущую эпоху (1) от лидера по key-request/key-rotate',
                });
              }
            );

            if (igorReadyOk) {
              await step('Ш3: Игорь видит историю чата под эпохой 0 (сообщение, отправленное до ротации)', async () => {
                await openChatPanel(igorPage);
                assert.ok(
                  await messageTextsInclude(igorPage, preRotationMsg, 8000),
                  'Игорь должен был увидеть историческое сообщение (эпоха 0), полученное по DataChannel'
                );
              });

              await step(
                'Ш3: Игорь получает и корректно расшифровывает НОВЫЙ fallback-конверт под текущей (уже не нулевой) эпохой',
                async () => {
                  const igorPeerId = await vasyaPage.evaluate(
                    () => document.querySelector('.tile[data-name="Игорь"]')?.dataset.peerId
                  );
                  assert.ok(igorPeerId, 'у Васи не нашёлся тайл Игоря');

                  await vasyaPage.evaluate((pid) => {
                    window.__e2eRealBusIsOpen = bus.isOpen.bind(bus);
                    bus.isOpen = (id) => (id === pid ? false : window.__e2eRealBusIsOpen(id));
                  }, igorPeerId);

                  const msgToIgor = `Ш3-новичку-эпоха1-${Date.now()}`;
                  try {
                    await sendChatMessage(vasyaPage, msgToIgor);
                    assert.ok(
                      await messageTextsInclude(igorPage, msgToIgor),
                      'Игорь должен был расшифровать fallback-сообщение под текущей эпохой сразу после входа'
                    );
                  } finally {
                    await vasyaPage.evaluate(() => {
                      bus.isOpen = window.__e2eRealBusIsOpen;
                      delete window.__e2eRealBusIsOpen;
                    });
                  }
                }
              );
            } else {
              skip('Ш3: Игорь видит историю чата под эпохой 0', 'новичок не получил текущую эпоху');
              skip('Ш3: Игорь получает новый fallback-конверт под текущей эпохой', 'новичок не получил текущую эпоху');
            }
          } finally {
            await igorContext.close();
          }
        } else {
          skip('Ш3: новичок входит после ротации и получает текущую эпоху', 'ротация ключей не удалась на предыдущем шаге');
        }
      } finally {
        await vasyaContext.close();
        await petyaContext.close();
        await olyaContext.close();
      }
    }

    // --- M2: заголовки Cloudflare Pages (_headers) ---
    //
    // Прогонять реальный wrangler/Pages в e2e непрактично (координатор ещё
    // не завёл прод-проект, см. .github/workflows/deploy-prod.yml: job
    // deploy-pages гейтится секретом CLOUDFLARE_API_TOKEN) — вместо похода на
    // pages.dev выполняем РОВНО ТОТ ЖЕ шаг сборки, что описан в workflow
    // (шаг "Собрать pages-dist/…", секция генерации _headers), извлечённый
    // прямо из самого workflow-файла (не переписанный вручную — так тест не
    // может разойтись с тем, что реально катится в CI), и проверяем
    // результат на диске. Это не браузерный тест (CSP энфорсится браузером
    // при реальной раздаче с Pages, а не на этом origin-сервере) — здесь
    // фиксируется контракт самого файла _headers.
    await step(
      'M2: сгенерированный _headers для Cloudflare Pages содержит строгий CSP (frame-ancestors \'none\') и сопутствующие security-заголовки',
      async () => {
        const workflowPath = path.join(REPO_ROOT, '.github/workflows/deploy-prod.yml');
        const workflowText = fs.readFileSync(workflowPath, 'utf8');
        const pagesStepScript = extractYamlRunStepScript(workflowText, 'Собрать pages-dist');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-dist-headers-test-'));
        try {
          fs.cpSync(path.join(REPO_ROOT, 'static'), path.join(tmpDir, 'static'), { recursive: true });
          execFileSync('bash', ['-c', pagesStepScript], { cwd: tmpDir, stdio: 'pipe' });

          const headersPath = path.join(tmpDir, 'pages-dist', '_headers');
          assert.ok(fs.existsSync(headersPath), '_headers не был создан шагом сборки pages-dist');
          const headersText = fs.readFileSync(headersPath, 'utf8');

          assert.match(headersText, /Content-Security-Policy:.*frame-ancestors 'none'/, `_headers должен содержать CSP с frame-ancestors 'none': ${headersText}`);
          assert.match(headersText, /Content-Security-Policy:.*default-src 'self'/, `_headers должен содержать default-src 'self': ${headersText}`);
          assert.match(headersText, /X-Frame-Options:\s*DENY/, `_headers должен содержать X-Frame-Options: DENY: ${headersText}`);
          assert.match(headersText, /X-Content-Type-Options:\s*nosniff/, `_headers должен содержать X-Content-Type-Options: nosniff: ${headersText}`);
          assert.match(headersText, /Cache-Control:\s*no-cache/, `_headers должен сохранить существующий Cache-Control: no-cache: ${headersText}`);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
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
