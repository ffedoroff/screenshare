#!/usr/bin/env node
// tests/e2e/resilience.spec.mjs — browser e2e resilience-to-disconnects test,
// rewritten for protocol v2 (a symmetric meeting room, mesh between everyone,
// screen sharing — a lock held by one participant, the room stays alive until
// it's empty + EMPTY_ROOM_TTL_SECONDS for an empty room). The same
// self-contained style as basic.spec.mjs/the old resilience.spec.mjs: its own
// mini runner, its own server (port 3333, state entirely in the process's
// memory), a real Chrome via playwright-core. Screen-share capture uses a
// synthetic stub by default (installCaptureOnly, see helpers.mjs:
// installCaptureStub) — real getDisplayMedia can hang on this macOS test
// machine (no TCC screen-recording permission). Mic/camera need no JS-level
// stub at all anymore — CAPTURE_FLAGS' own --use-fake-device-for-media-stream
// already covers every getUserMedia call, including the pre-join card's
// combined audio+video request (see joinRoom in helpers.mjs).
//
// This file's server is started with EMPTY_ROOM_TTL_SECONDS=5 (not 3 — see
// scenario (e): five seconds is enough to deterministically check both
// "joined in time" and "was late", without racing the reaper, which ticks
// once a second, see src/state.rs::REAPER_INTERVAL).
//
// Scenario order in the code — a, b, c, d, e, f, g, as in the plan (unlike
// the old file the order was not further rearranged: none of scenarios
// a..d permanently destroys the room — the room stays alive as long as at
// least one participant remains, so they naturally flow into one another
// through a shared room of Vasya/Petya/Olya. Only scenario (e) predictably
// empties and buries that room via TTL, so scenario (f) is already in a
// deliberately new room).
//
// Timing — deadline-based polling (waitForFunction/waitUntil, always with a
// third argument { polling: 100, timeout }), no blind sleeps — with one
// deliberate exception in scenario (e): the TTL of an empty room is a
// property of real time on the server, not observable DOM state, so "wait
// less than the TTL" and "wait more than the TTL" can't be expressed via
// condition polling — that is the one and only place helpers.sleep is used,
// with an explanation right there.
//
// Network drop (scenario d) — the same trick as in the old file: a plain
// `context.setOffline(true)` doesn't reliably close an already-open
// WebSocket quickly (verified empirically while writing the old test — see
// history), so the test harness itself forcibly closes the signaling socket
// via the window.__e2eSockets wrapper (see the setup of Igor's context).

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {
  REAL_CAPTURE_TIMEOUT_MS,
  CAPTURE_FLAGS,
  createRunner,
  buildServer,
  createServerController,
  installCaptureStub,
  joinRoom,
  installPcRegistry,
  waitForMeshSettled,
  waitForOverlayHidden,
  assertVideoPlaying,
  assertLocalScreenPlaceholder,
  assertScreenFullscreenButtonState,
  openChatPanel,
  sendChatMessage,
  messageTextsInclude,
  getChatDom,
  waitUntil,
  sleep,
  generateRoomToken,
  roomUrlWithKey,
} from './helpers.mjs';

const PORT = 3333;
const EMPTY_ROOM_TTL_SECONDS = 5;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
const server = createServerController(PORT, { EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS) });

const captureStubArg = { tryReal: process.env.E2E_TRY_REAL_CAPTURE === '1', timeoutMs: REAL_CAPTURE_TIMEOUT_MS };

async function installCaptureOnly(context) {
  await context.addInitScript(installCaptureStub(), captureStubArg);
}

// --- Helpers for the protocol v2 DOM (tiles, participant counter, overlay) ---

function tileSelector(name) {
  return `.tile[data-name="${name}"]`;
}

/** The crown is visible (not .hidden) on the tile `selector .tile-crown` (see README.md "Permissions and the leader"). */
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
    `Participants: ${total} / 6`,
    { polling: 100, timeout: timeoutMs }
  );
}

async function participantCount(page) {
  const text = await page.evaluate(() => document.getElementById('participant-count')?.textContent ?? '');
  const match = text.match(/Participants:\s*(\d+)/);
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
  assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
  const data = await res.json();
  assert.ok(data && typeof data.roomId === 'string' && data.roomId, `no roomId in the response: ${JSON.stringify(data)}`);
  return data.roomId;
}

/**
 * S1 v2 (E2E encryption): the room is created directly via the API (bypassing
 * the landing page) — the server neither issues nor knows the link token
 * (`t`) and expiry (`e`) at all, so the test generates them itself (see
 * generateRoomToken/roomUrlWithKey in helpers.mjs, `e` is valid by default)
 * and immediately returns a ready-made guest link (with `#t=...&e=...`,
 * without leaderToken) — all participants below join through it, otherwise
 * without a valid token they'd hit the "Link is incomplete" overlay (see
 * static/room.js). This same link (with its own `t`/`e` right in the address
 * bar, WITHOUT `lt` — it was never there to begin with) also stays working
 * after `page.reload()` — this is a key property of v2 (the link survives
 * F5), see scenario (c) below.
 */
async function createRoomViaApiWithKey(baseUrl) {
  const roomId = await createRoomViaApi(baseUrl);
  const roomKey = generateRoomToken();
  const roomUrl = roomUrlWithKey(baseUrl, roomId, roomKey);
  return { roomId, roomKey, roomUrl };
}

async function main() {
  await buildServer();
  await server.start();

  let browser = null;
  // Keep all created contexts so we can guarantee closing them in finally
  // even if some step failed partway through.
  const allContexts = [];

  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    // ============================================================
    // Setup: a room via POST /api/rooms, Vasya/Petya/Olya join directly
    // via the link (not via the landing page — that's already covered by
    // basic.spec.mjs).
    // ============================================================
    let roomId = null;
    let roomKey = null;
    let roomUrl = null;
    const setupRoomOk = await step('setup: create a room via POST /api/rooms', async () => {
      ({ roomId, roomKey, roomUrl } = await createRoomViaApiWithKey(server.baseUrl));
    });
    if (!setupRoomOk || !roomId) {
      console.log('FAIL - critical error: room was not created, further scenarios are impossible');
      return;
    }

    const vasyaContext = await browser.newContext();
    const petyaContext = await browser.newContext();
    const olyaContext = await browser.newContext();
    allContexts.push(vasyaContext, petyaContext, olyaContext);
    // Vasya's mic/camera no longer need a JS-level stub at all (see the
    // comment on installCaptureOnly above and helpers.mjs: CAPTURE_FLAGS'
    // --use-fake-device-for-media-stream, passed once at chromium.launch()
    // below, already covers every getUserMedia call on every context/page
    // spawned from this browser) — Vasya joins via a plain guest link here
    // (createRoomViaApiWithKey never issues a leaderToken), so his pre-join
    // card ALSO fires the guest flow's combined getUserMedia (see
    // static/room.js: acquireGuestPrejoinMedia) the instant it's shown;
    // joinRoom() below defaults to waiting for that and then flipping both
    // pre-join selects to "Off", reproducing the muted/videoless baseline
    // scenario (a) needs (it turns the camera/mic on itself, via the
    // toolbar, expecting them to start off).
    await installCaptureOnly(petyaContext); // Petya shares their screen in scenario (b)
    await installCaptureOnly(olyaContext); // Olya shares their screen in scenarios (b)/(c)
    await installPcRegistry(vasyaContext);
    await installPcRegistry(petyaContext);
    await installPcRegistry(olyaContext);
    let vasyaPage = await vasyaContext.newPage();
    let petyaPage = await petyaContext.newPage();
    let olyaPage = await olyaContext.newPage();

    const bothJoinedOk = await step('setup: Vasya, Petya, and Olya join the room (join modal) — everyone has 3 tiles', async () => {
      await vasyaPage.goto(roomUrl);
      await petyaPage.goto(roomUrl);
      await olyaPage.goto(roomUrl);
      await joinRoom(vasyaPage, 'Vasya');
      await joinRoom(petyaPage, 'Petya');
      await joinRoom(olyaPage, 'Olya');
      await waitForOverlayHidden(vasyaPage);
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);
      // waitForMeshSettled waits for both the tiles and for all three of
      // them to have both mesh connections actually reach connected (see
      // helpers.mjs) — scenario (a) below immediately clicks the
      // camera/mic.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });
    });

    if (!bothJoinedOk) {
      console.log('FAIL - critical error: participants did not assemble, further scenarios are impossible');
      return;
    }

    // ============================================================
    // (a) Vasya turns on the camera and microphone, then closes the tab
    // ============================================================
    const vasyaTileSel = tileSelector('Vasya');

    const scenarioACamOk = await step('(a) Vasya turns on the camera — Petya and Olya see live video on his tile', async () => {
      await vasyaPage.click('#camera-button');
      for (const page of [petyaPage, olyaPage]) {
        await assertVideoPlaying(page, { selector: `${vasyaTileSel} video` });
      }
    });

    const scenarioAMicOk = await step('(a) Vasya turns on the microphone — Petya and Olya see "Speaking" on his tile', async () => {
      await vasyaPage.click('#mic-button');
      for (const page of [petyaPage, olyaPage]) {
        await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', true, 8000);
      }
    });

    if (scenarioACamOk || scenarioAMicOk) {
      await step('(a) Vasya closes the tab — Petya and Olya see his tile disappear, the participant count drops, "Speaking" goes off', async () => {
        await vasyaPage.close();
        for (const page of [petyaPage, olyaPage]) {
          await waitForNoTile(page, 'Vasya');
          await waitForTileCount(page, 2);
          await waitParticipantCount(page, 2);
          await page.waitForFunction(
            () => document.querySelectorAll('.tile--speaking').length === 0,
            undefined,
            { polling: 100, timeout: 8000 }
          );
        }
      });

      await step('(a) chat between Petya and Olya keeps working after Vasya leaves', async () => {
        await openChatPanel(petyaPage);
        await openChatPanel(olyaPage);
        const text = `Petya after Vasya left — ${Date.now()}`;
        await sendChatMessage(petyaPage, text);
        assert.ok(await messageTextsInclude(petyaPage, text), 'the message did not appear for Petya themselves');
        assert.ok(await messageTextsInclude(olyaPage, text), 'the message did not reach Olya');
      });
    } else {
      skip('(a) closing Vasya\'s tab', 'failed to turn on the camera/microphone');
      skip('(a) chat Petya <-> Olya', 'scenario (a) did not complete');
    }

    // ============================================================
    // (b) Petya shares their screen, then closes the tab (owner disconnect
    // of the lock) — Olya sees the release and grabs the share herself
    // ============================================================
    const scenarioBShareOk = await step(
      '(b) Petya shares their screen — Olya sees a live main stage, Petya himself sees a "You are sharing" placeholder instead of a preview of his own capture, his fullscreen button is hidden',
      async () => {
        await petyaPage.click('#screen-button');
        await waitScreenButtonOn(petyaPage, true);
        await assertVideoPlaying(olyaPage, { selector: '#screen-video' });
        await assertLocalScreenPlaceholder(petyaPage);
        await assertScreenFullscreenButtonState(petyaPage, { hidden: true, disabled: true });
        await assertScreenFullscreenButtonState(olyaPage, { hidden: false, disabled: false });
      }
    );

    if (scenarioBShareOk) {
      await step('(b) Petya closes the tab — Olya sees the screen released (main stage cleared, button active again), the room is alive', async () => {
        await petyaPage.close();
        await waitParticipantCount(olyaPage, 1);
        await waitScreenStageHidden(olyaPage, true);
        const disabled = await olyaPage.evaluate(() => document.getElementById('screen-button')?.disabled);
        assert.equal(disabled, false, 'Olya\'s "Screen" button should be active again');
      });

      await step(
        '(b) Olya grabs the share — share-started, she sees a "You are sharing" placeholder on her main stage (not a live video of her own capture — see static/room.js: showLocalScreenPreview), her fullscreen button is hidden',
        async () => {
          await olyaPage.click('#screen-button');
          await waitScreenButtonOn(olyaPage, true);
          await waitScreenStageHidden(olyaPage, false);
          await assertLocalScreenPlaceholder(olyaPage);
          await assertScreenFullscreenButtonState(olyaPage, { hidden: true, disabled: true });
        }
      );
    } else {
      skip('(b) closing Petya\'s tab / releasing the screen', 'Petya\'s share did not work');
      skip('(b) Olya grabs the share', 'Petya\'s share did not work');
    }

    // ============================================================
    // (c) Olya reloads the page (F5) in the middle of her own share
    // ============================================================
    if (scenarioBShareOk) {
      await step('(c) Olya reloads the page (F5) — comes back into the room via t/e from the address bar WITHOUT a new link, the old share is released by the server, chat history is empty (F1: the server doesn\'t store it, and at this point Olya is alone in the room — no one to ask)', async () => {
        // S1 v2 (E2E encryption, see static/room.js/docs/research-p2p-key-handoff.md
        // §6.5–6.6): `t`/`e` are NOT cleared from the address bar (only the
        // one-time `lt` is cleared, which olyaPage's guest link never had
        // anyway) — this is a key property of v2, the link must survive F5.
        // So a REAL page.reload() can and should be used here, rather than
        // emulated (as would be necessary in v1, where the room key lived
        // only in the tab's memory and was entirely cleared from the URL).
        const urlBeforeReload = olyaPage.url();
        const hashBeforeReload = await olyaPage.evaluate(() => location.hash);
        assert.ok(
          hashBeforeReload.includes('t=') && hashBeforeReload.includes('e='),
          `before F5 the address bar should contain t=/e=, got: "${hashBeforeReload}"`
        );
        assert.ok(
          !hashBeforeReload.includes('lt='),
          `lt= should not be in the address bar (this guest link never carried it): "${hashBeforeReload}"`
        );

        await olyaPage.reload();
        await joinRoom(olyaPage, 'Olya');
        await waitForOverlayHidden(olyaPage);

        // Explicit check of the key v2 property: rejoining after F5 happened
        // WITHOUT a new link — the URL (including t=/e=) did not change by a
        // single character, no need to go fetch a fresh fragment.
        assert.equal(
          olyaPage.url(),
          urlBeforeReload,
          'after F5 the URL should stay the same — t/e do not change, no new link is needed'
        );
        const hashAfterReload = await olyaPage.evaluate(() => location.hash);
        assert.equal(hashAfterReload, hashBeforeReload, 'the fragment after F5 should stay exactly the same (t=/e=)');

        // F1: there is no history on the server at all anymore (see
        // README.md/src/ws.rs) — a newcomer requests the latest messages from
        // their mesh peers via DataChannel (see static/chat.js). By this
        // point in scenarios (a)/(b) both Vasya and Petya have already left
        // the room — Olya is alone here, no one to ask, so her feed is
        // PREDICTABLY empty (same as in an empty room on first join). The
        // real case of "history arrives from a live peer over DataChannel" is
        // already covered by a separate scenario in tests/e2e/basic.spec.mjs.
        await openChatPanel(olyaPage);
        const texts = await (await getChatDom(olyaPage)).messages.allTextContents();
        assert.equal(texts.length, 0, 'Olya\'s (the only one left in the room after reload) chat feed should be empty');

        // The old share is actually released by the server (disconnect =
        // share-stopped), not just "looking" released because the page was
        // freshly loaded: if the server still considered Olya the screen
        // owner (a bug), a new share request would get share-rejected and
        // the button wouldn't switch to the "on" state.
        await olyaPage.click('#screen-button');
        await waitScreenButtonOn(olyaPage, true, 8000);
        await waitScreenStageHidden(olyaPage, false);

        // Clean up before the next scenarios.
        await olyaPage.click('#screen-button');
        await waitScreenButtonOn(olyaPage, false, 8000);
        await waitScreenStageHidden(olyaPage, true);
      });
    } else {
      skip('(c) Olya\'s reload mid-share', 'scenario (b) did not complete, Olya has no share');
    }

    // ============================================================
    // (d) Network drop for a new participant (Igor)
    // ============================================================
    const igorContext = await browser.newContext();
    allContexts.push(igorContext);
    // Track Igor's page's WebSocket instances — needed to deterministically
    // break signaling after setOffline(true) (see the comment in the file
    // header and in the old resilience.spec.mjs: setOffline itself only
    // breaks an already-open WS after 46+ seconds, if it breaks it at all).
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

    const igorJoinedOk = await step('(d, setup) new participant Igor joins the room', async () => {
      await igorPage.goto(roomUrl);
      await joinRoom(igorPage, 'Igor');
      await waitForOverlayHidden(igorPage);
      await waitForTileCount(olyaPage, 2);
      await waitParticipantCount(olyaPage, 2);
    });

    if (igorJoinedOk) {
      await step('(d) network drop for Igor (setOffline + forced WS close) — Olya sees his tile disappear', async () => {
        await igorContext.setOffline(true);
        await igorPage.evaluate(() => {
          for (const ws of window.__e2eSockets || []) {
            try { ws.close(); } catch { /* already closed */ }
          }
        });
        await waitForNoTile(olyaPage, 'Igor', 15_000);
        await waitParticipantCount(olyaPage, 1, 15_000);
      });
      // Igor's role in the test is done — close his context, WITHOUT
      // restoring the network (setOffline(false)). Otherwise, since Igor's
      // page is still open, auto-reconnect (see static/room.js) would
      // legitimately try to reconnect and rejoin the room as soon as the
      // network came back — that's correct behavior in its own right
      // (verified separately in scenario (h) about a server restart), but
      // here it would only get in the way of the following scenarios (e)/(f),
      // which rely on Igor having permanently left.
      try { await igorContext.close(); } catch { /* already closed */ }
    } else {
      skip('(d) network drop for Igor', 'Igor did not join the room');
    }

    // ============================================================
    // (e) Room overflow: fill the room up to 6 participants, the 7th sees
    // "Room is full"
    // ============================================================
    const fillerContexts = [];
    const fillerPages = [];
    let roomFullOk = false;
    await step('(e) fill the room up to 6 participants with lightweight tabs, the 7th gets "Room is full"', async () => {
      const current = await participantCount(olyaPage);
      assert.ok(Number.isFinite(current), `failed to read Olya's participant-count: ${current}`);
      const toAdd = 6 - current;
      assert.ok(toAdd >= 0, `the room already has more than 6 participants (${current}) — the scenario doesn't apply`);

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

      // The fixed tile grid (see item 6 of the task and static/room.js:
      // computeTileGridColumns/layoutTilesGrid — desktop: 3×2 for 6 tiles)
      // should not cause the stage to scroll: this is exactly the bug
      // (best-fit layout plus grid max-width, see the comment at
      // layoutTilesGrid) that was fixed in this batch. olyaContext is a
      // default desktop viewport (no explicit viewport/isMobile, unlike the
      // mobile smoke test in basic.spec.mjs), so the check here specifically
      // exercises the desktop layout.
      const gridOverflow = await olyaPage.evaluate(() => {
        const grid = document.getElementById('tiles-grid');
        return grid
          ? {
              scrollWidth: grid.scrollWidth,
              clientWidth: grid.clientWidth,
              scrollHeight: grid.scrollHeight,
              clientHeight: grid.clientHeight,
            }
          : null;
      });
      assert.ok(gridOverflow, '#tiles-grid should be in the DOM with 6 participants');
      assert.ok(
        gridOverflow.scrollWidth <= gridOverflow.clientWidth + 1,
        `#tiles-grid should not scroll horizontally with 6 tiles: ${JSON.stringify(gridOverflow)}`
      );
      assert.ok(
        gridOverflow.scrollHeight <= gridOverflow.clientHeight + 1,
        `#tiles-grid should not scroll vertically with 6 tiles: ${JSON.stringify(gridOverflow)}`
      );

      const seventhContext = await browser.newContext();
      const seventhPage = await seventhContext.newPage();
      await seventhPage.goto(roomUrl);
      // NOT joinRoom() here: the pre-join card's own GET /api/rooms/<id>
      // check (see static/room.js: initGuestPrejoin/showPrejoinRoomFullOverlay)
      // sees the room already at capacity and shows this terminal overlay
      // BEFORE the card itself is ever shown — joinRoom() would just hang
      // waiting for a #join-modal that never appears.
      await waitOverlayTitle(seventhPage, 'Room is full', 10_000);
      roomFullOk = true;
      await seventhContext.close(); // did not get into the room, not needed further
    });

    if (!roomFullOk) {
      skip('(e) room overflow', 'failed to bring the room up to 6 participants');
    }

    // ============================================================
    // (f) Empty room: everyone leaves ("Leave" / closing tabs) — joining
    // within the TTL succeeds, joining after the TTL — "Room not found".
    // ============================================================
    await step('(f) everyone leaves the room — Olya clicks "Leave", the rest close their tabs', async () => {
      await olyaPage.click('#leave-button');
      for (const page of fillerPages) {
        if (!page.isClosed()) await page.close();
      }
      for (const ctx of fillerContexts) {
        try { await ctx.close(); } catch { /* already closed */ }
      }
    });

    // Deliberate sleep (see the comment in the file header): the TTL is a
    // property of real server time, not observable DOM state, so "less than
    // the TTL" can only be checked here with a real pause shorter than it.
    await sleep(1000);

    const test1Context = await browser.newContext();
    allContexts.push(test1Context);
    const test1Page = await test1Context.newPage();
    const withinTtlOk = await step('(f) joining an emptied room within the TTL (1s < 5s) — succeeds', async () => {
      await test1Page.goto(roomUrl);
      await joinRoom(test1Page);
      await waitForOverlayHidden(test1Page);
    });

    if (withinTtlOk) {
      // Empty the room again — from this moment we count the TTL anew for
      // checking expiry.
      await test1Page.close();

      // Deliberate sleep longer than EMPTY_ROOM_TTL_SECONDS(5s) + the reaper's
      // period (1s, see src/state.rs::REAPER_INTERVAL) + margin.
      await sleep((EMPTY_ROOM_TTL_SECONDS + 1) * 1000 + 1500);

      const test2Context = await browser.newContext();
      allContexts.push(test2Context);
      const test2Page = await test2Context.newPage();
      await step('(f) joining the same room after the TTL has expired — "Room not found"', async () => {
        await test2Page.goto(roomUrl);
        // NOT joinRoom(): the pre-join card's GET /api/rooms/<id> check gets
        // a 404 (the room was reaped) and shows this terminal overlay
        // directly (see static/room.js: initGuestPrejoin/
        // showPrejoinRoomGoneOverlay) — the card itself never appears.
        await waitOverlayTitle(test2Page, 'Room not found', 10_000);
      });
    } else {
      skip('(f) joining after TTL expiry', 'joining within the TTL failed, further checking is pointless');
    }

    // ============================================================
    // (g) Chat rate limit from the user's perspective — already in a
    // deliberately new room (the previous one was buried by scenario (f)).
    // ============================================================
    let ninaPage = null;
    let tolyaPage = null;
    const rateLimitPrepOk = await step('(g, setup) new room — Nina and Tolya join', async () => {
      const { roomUrl: newRoomUrl } = await createRoomViaApiWithKey(server.baseUrl);

      const ninaContext = await browser.newContext();
      const tolyaContext = await browser.newContext();
      allContexts.push(ninaContext, tolyaContext);
      ninaPage = await ninaContext.newPage();
      tolyaPage = await tolyaContext.newPage();

      await ninaPage.goto(newRoomUrl);
      await tolyaPage.goto(newRoomUrl);
      await joinRoom(ninaPage, 'Nina');
      await joinRoom(tolyaPage, 'Tolya');
      await waitForOverlayHidden(ninaPage);
      await waitForOverlayHidden(tolyaPage);
    });

    if (rateLimitPrepOk) {
      await step('(g) Nina quickly sends 11 messages — the 11th is rejected with an error in the panel, the first 10 are delivered to Tolya', async () => {
        await openChatPanel(ninaPage);
        await openChatPanel(tolyaPage);
        const prefix = `RL-${Date.now()}-`;
        for (let i = 1; i <= 11; i++) {
          await sendChatMessage(ninaPage, `${prefix}${i}`);
        }

        const ninaChat = await getChatDom(ninaPage);
        await ninaChat.errorBanner.waitFor({ state: 'visible', timeout: 5000 });
        const errorText = await ninaChat.errorBanner.textContent();
        assert.ok(errorText && errorText.trim().length > 0, 'the chat error banner is empty');

        await waitUntil(
          async () => {
            const tolyaChat = await getChatDom(tolyaPage);
            const texts = await tolyaChat.messages.allTextContents();
            return texts.filter((t) => t.startsWith(prefix)).length === 10;
          },
          { timeoutMs: 8000, message: 'Tolya did not end up with exactly 10 messages with the rate-limit prefix' }
        );

        const tolyaChat = await getChatDom(tolyaPage);
        const finalTexts = await tolyaChat.messages.allTextContents();
        const matched = finalTexts.filter((t) => t.startsWith(prefix));
        assert.equal(matched.length, 10, `Tolya should have exactly 10 messages, got ${matched.length}: ${JSON.stringify(matched)}`);
        assert.ok(!matched.includes(`${prefix}11`), 'the 11th message should not have reached Tolya');
      });
    } else {
      skip('(g) chat rate limit', 'Nina/Tolya did not join the new room');
    }

    // Free up resources before the last (heaviest, a real server restart)
    // scenario: close all contexts from previous scenarios — they're no
    // longer needed here, and idle tabs (some of which still have WebRTC
    // alive) would otherwise compete for CPU with the ICE negotiation of the
    // three new participants below and make waitForMeshSettled empirically
    // flaky.
    for (const ctx of allContexts) {
      try { await ctx.close(); } catch { /* already closed */ }
    }
    allContexts.length = 0;

    // ============================================================
    // (h) Server restart (deploy): the call should survive it almost
    // unnoticed. A fresh room — Vasya/Petya/Olya join, Vasya has his
    // microphone on, Petya shares their screen, there's some chat history —
    // then the server is stopped entirely (SIGTERM/SIGKILL, see
    // helpers.mjs::createServerController.stop) and comes back up on the
    // same port (server.start()) — exactly what happens when a new version
    // is rolled out (see README.md, section "Call resilience during
    // deploys"). We do NOT touch static/* — only the server process.
    // ============================================================
    let vasya2Page = null;
    let petya2Page = null;
    let olya2Page = null;
    const restartPrepOk = await step(
      '(h, setup) new room — Vasya/Petya/Olya join, Vasya turns on his microphone, Petya shares their screen, there is chat history',
      async () => {
        const { roomUrl: restartRoomUrl } = await createRoomViaApiWithKey(server.baseUrl);

        const vasya2Context = await browser.newContext();
        const petya2Context = await browser.newContext();
        const olya2Context = await browser.newContext();
        allContexts.push(vasya2Context, petya2Context, olya2Context);
        // See the comment on Vasya's context in the setup above — no
        // JS-level mic/camera stub needed anymore.
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
        await joinRoom(vasya2Page, 'Vasya');
        await joinRoom(petya2Page, 'Petya');
        await joinRoom(olya2Page, 'Olya');
        await waitForOverlayHidden(vasya2Page);
        await waitForOverlayHidden(petya2Page);
        await waitForOverlayHidden(olya2Page);
        await waitForMeshSettled([vasya2Page, petya2Page, olya2Page], { tileCount: 3, connectionsPerPage: 2 });

        await vasya2Page.click('#camera-button');
        await assertVideoPlaying(petya2Page, { selector: `${tileSelector('Vasya')} video` });
        await vasya2Page.click('#mic-button');
        await waitForClassOnSelector(petya2Page, tileSelector('Vasya'), 'tile--speaking', true, 8000);

        await petya2Page.click('#screen-button');
        await waitScreenButtonOn(petya2Page, true);
        await assertVideoPlaying(olya2Page, { selector: '#screen-video' });

        await openChatPanel(vasya2Page);
        await openChatPanel(petya2Page);
        await openChatPanel(olya2Page);
        const msg1 = `before the restart — one — ${Date.now()}`;
        const msg2 = `before the restart — two — ${Date.now()}`;
        await sendChatMessage(vasya2Page, msg1);
        assert.ok(await messageTextsInclude(petya2Page, msg1), 'message 1 did not reach Petya');
        assert.ok(await messageTextsInclude(olya2Page, msg1), 'message 1 did not reach Olya');
        await sendChatMessage(petya2Page, msg2);
        assert.ok(await messageTextsInclude(vasya2Page, msg2), 'message 2 did not reach Vasya');
        assert.ok(await messageTextsInclude(olya2Page, msg2), 'message 2 did not reach Olya');

        // The room was created via createRoomViaApi (without leaderToken) —
        // the first one to join becomes the leader (see README.md
        // "Permissions and the leader"), here that's Vasya (join-room was
        // sent first, before Petya/Olya).
        await waitCrownVisible(petya2Page, tileSelector('Vasya'), true);
      }
    );

    if (restartPrepOk) {
      await step(
        '(h) the server stops — all three see the "Reconnecting…" banner appear, tiles/media/chat are not destroyed',
        async () => {
          await server.stop();
          for (const page of [vasya2Page, petya2Page, olya2Page]) {
            await waitForClassOnSelector(page, '#reconnect-banner', 'hidden', false, 10_000);
          }
          // Signaling is dead, but the mesh (media/DataChannel chat)
          // doesn't physically depend on it (see README.md) — the tiles
          // haven't gone anywhere right now.
          await waitForTileCount(vasya2Page, 3);
          await waitForTileCount(petya2Page, 3);
          await waitForTileCount(olya2Page, 3);
        }
      );

      // A deliberate controlled pause (not a race with the real deploy
      // downtime): guarantees the "server is down" window is not shorter
      // than the banner's polling interval above, even on a fast machine
      // where the process restarts almost instantly.
      await sleep(1500);

      await step(
        '(h) the server comes back up on the same port — auto-reconnect restores signaling, the banner disappears',
        async () => {
          await server.start();
          // In parallel (not sequentially) and with a time margin: the first
          // 1-2 reconnect attempts might hit a server that hasn't fully come
          // up yet (the port is listening slightly before the app is ready
          // to respond) — the backoff (1s→2s→4s→8s) could in a rare case
          // push the real success beyond ten seconds, which is still far
          // from the product budget of 2 minutes.
          await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) =>
              waitForClassOnSelector(page, '#reconnect-banner', 'hidden', true, 45_000)
            )
          );
        }
      );

      await step('(h.b) tiles and the participant counter have recovered (3 participants = "3 / 6")', async () => {
        for (const page of [vasya2Page, petya2Page, olya2Page]) {
          await waitForTileCount(page, 3, 15_000);
          await waitParticipantCount(page, 3, 15_000);
        }
      });

      // Leadership on server restart (see README.md "Permissions and the
      // leader"): the server loses ALL its memory (including leader_id) on
      // restart — the room is restored empty via PUT /api/rooms/{id} and the
      // leader becomes whoever successfully rejoins first (see
      // src/main.rs::restore_room and src/ws.rs::JoinRoom). Which of the
      // three rejoins first is a race of reconnect backoffs (see
      // static/room.js), NOT guaranteed to be Vasya again. Here we record the
      // actual outcome and the main property: no deadlock and exactly one
      // leader that all participants agree on.
      await step(
        '(h.e) leadership after the server restart: exactly one leader, all participants agree — recording the actual behavior',
        async () => {
          const leaderIds = await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) => page.evaluate(() => leaderId))
          );
          assert.ok(
            leaderIds.every((id) => id === leaderIds[0]),
            `all participants should see THE SAME ONE leader (no deadlock/divergence), got: ${JSON.stringify(leaderIds)}`
          );
          assert.ok(leaderIds[0], 'leaderId should not be empty after reconnect');

          const nameByPeerId = {};
          for (const [label, page] of [['Vasya', vasya2Page], ['Petya', petya2Page], ['Olya', olya2Page]]) {
            const myId = await page.evaluate(() => myPeerId);
            nameByPeerId[myId] = label;
          }
          console.log(
            `# actual behavior (leadership on server restart): the leader remained ${
              nameByPeerId[leaderIds[0]] || leaderIds[0]
            }`
          );

          // Exactly one participant should see the crown on THEIR OWN tile —
          // not zero (leader lost) and not more than one (several "leaders"
          // at once).
          const ownCrownFlags = await Promise.all(
            [vasya2Page, petya2Page, olya2Page].map((page) =>
              page.evaluate(() => !document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden'))
            )
          );
          assert.equal(
            ownCrownFlags.filter(Boolean).length,
            1,
            `exactly one participant should see the crown on their own tile, got: ${JSON.stringify(ownCrownFlags)}`
          );
        }
      );

      let screenRestoredActually = false;
      await step('(h.c) Petya\'s screen share after reconnect — recording the actual behavior', async () => {
        try {
          await waitScreenButtonOn(petya2Page, true, 15_000);
          await waitScreenStageHidden(olya2Page, false, 15_000);
          await assertVideoPlaying(olya2Page, { selector: '#screen-video' });
          screenRestoredActually = true;
        } catch (err) {
          screenRestoredActually = false;
          console.log(`[info] Petya's screen share did NOT restore after the server reconnect: ${err.message}`);
        }
      });
      console.log(
        `# actual behavior (c): screen share after server restart ${
          screenRestoredActually ? 'RESTORED (share-start replayed successfully)' : 'NOT restored (the stage rightfully went away)'
        }`
      );

      await step('(h.d) P2P chat works and history is intact (client-side buffers) after reconnect', async () => {
        for (const page of [vasya2Page, petya2Page, olya2Page]) {
          await openChatPanel(page);
          const chat = await getChatDom(page);
          const texts = await chat.messages.allTextContents();
          assert.ok(texts.some((t) => t.includes('before the restart')), 'chat history was not preserved in the client-side buffer after reconnect');
        }
        const msg3 = `after the restart — ${Date.now()}`;
        await sendChatMessage(olya2Page, msg3);
        assert.ok(await messageTextsInclude(vasya2Page, msg3), 'the new message after the restart did not reach Vasya');
        assert.ok(await messageTextsInclude(petya2Page, msg3), 'the new message after the restart did not reach Petya');
      });

      await step('(h.e) media is alive: Vasya\'s video keeps playing for Petya (videoWidth is growing)', async () => {
        await assertVideoPlaying(petya2Page, { selector: `${tileSelector('Vasya')} video` });
      });
    } else {
      skip('(h) server restart', 'setup failed');
    }

    for (const ctx of allContexts) {
      try { await ctx.close(); } catch { /* already closed */ }
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
    console.log(`FAIL - unexpected test error: ${err && err.stack ? err.stack : err}`);
    try { await server.stop(); } catch { /* already stopped or never started */ }
    bumpFailedForUnexpectedError();
    printSummary();
    process.exit(1);
  });
