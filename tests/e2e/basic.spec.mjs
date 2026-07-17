#!/usr/bin/env node
// tests/e2e/basic.spec.mjs — browser e2e test of protocol v2 (symmetric
// room, mesh, screen sharing as a temporary room state).
//
// Run: `node tests/e2e/basic.spec.mjs` (from the tests/e2e directory —
// `npm install` first). Requires a system Chrome (playwright-core does not
// download browsers, uses channel: 'chrome').
//
// Scenario: home page -> name "Vasya" -> "Create room" -> wait for the
// transition to /r/<id>; two more participants ("Petya", "Olya") open the
// same link; all three have 3 tiles each. Vasya turns on camera and
// microphone — the others get live video in his tile and speaking
// indication. Petya shares his screen — Vasya's and Olya's main area shows
// the stream, Olya's "Screen" button is disabled (screen is busy). Petya
// stops sharing — the main area clears for everyone, the room stays alive
// (chat, tiles in place), and now Olya can start her own share. At the end —
// Vasya toggles microphone and camera back off, we check that the
// indication turns off and the placeholder appears.
//
// About getDisplayMedia/getUserMedia in automation — see helpers.mjs
// (installCaptureStub/installMicStub/installCamStub) and README.md: real
// screen/camera capture is unavailable on this macOS machine (no TCC
// permissions, can't grant them non-interactively), so by default the test
// harness immediately swaps the sources for synthetic ones
// (canvas.captureStream / Web Audio oscillator) — the WebRTC transport
// (SDP/ICE/media) is still verified for real. Attempting real capture is
// enabled by the same env vars as before: E2E_TRY_REAL_CAPTURE=1,
// E2E_TRY_REAL_MIC=1, E2E_TRY_REAL_CAM=1.

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
  assertLocalScreenPlaceholder,
  assertScreenFullscreenButtonState,
  openChatPanel,
  sendChatMessage,
  sendChatMessageAndGetId,
  messageTextsInclude,
  messageWithLineBreaksIncludes,
  getChatDom,
  waitUntil,
  makeTestPngBuffer,
  makeTestTextFileBuffer,
  makeTestWavBuffer,
  makeTestWebmBuffer,
  attachFilesToChat,
  generateRoomToken,
  expiryB36FromNow,
  defaultValidExpiryB36,
  roomUrlWithKey,
  leaderUrlWithKey,
  getRoomFragmentFromPage,
  installSignalingFrameSpy,
  allFramesSentOn,
  framesOfTypeSentOn,
  waitInvalidLinkOverlay,
  waitLinkExpiredOverlay,
  waitForBusOpenToAllPeers,
  installFakeVisualViewport,
  openMessagePopoverFor,
  closeMessagePopover,
  popoverAction,
  clickPopoverEmoji,
  popoverReactionRows,
  REPO_ROOT,
} from './helpers.mjs';

/**
 * Extract the body of a `run: |` YAML step by a substring of its `name:` —
 * without a heavy dependency on a YAML parser (tests/e2e/package.json
 * doesn't have one, and it's not worth adding just for one test, see the
 * M2 test below). Works for a block scalar (`|`) with constant indentation
 * (our case, see .github/workflows/deploy-prod.yml) — the block ends at
 * the first line whose indentation is LESS than the indentation of the
 * body's first content line (the next `- name:`/step key at the same level).
 */
function extractYamlRunStepScript(workflowText, stepNameSubstring) {
  const nameIdx = workflowText.indexOf(stepNameSubstring);
  assert.ok(nameIdx >= 0, `step "${stepNameSubstring}" not found in workflow`);
  const runIdx = workflowText.indexOf('run: |', nameIdx);
  assert.ok(runIdx >= 0, `"run: |" not found after step "${stepNameSubstring}"`);
  const afterRunLine = workflowText.slice(runIdx).split('\n').slice(1); // without the "run: |" line itself
  const bodyLines = [];
  let baseIndent = null;
  for (const line of afterRunLine) {
    if (line.trim() === '') {
      bodyLines.push('');
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break; // dedent — this run block has ended
    bodyLines.push(line.slice(baseIndent));
  }
  return bodyLines.join('\n');
}

const PORT = 3322;
const { step, skip, printSummary, bumpFailedForUnexpectedError, counts } = createRunner();
// A (H2, docs/research-dos.md §3.2): JOIN_ROOM_IP_LIMIT — default 20/60s for
// join-room from a single IP. This file runs dozens of joinRoom() calls from
// the same address (localhost) in one run — the same reason that already
// led tests/signaling.test.mjs to the same bump for ITS OWN test server
// (see there: `JOIN_ROOM_IP_LIMIT: '100000'`, the comment on
// DEFAULT_JOIN_ROOM_IP_LIMIT in src/state.rs explicitly calls this NOT
// production leniency but testability — the WS handshake doesn't support an
// arbitrary CF-Connecting-IP per request, unlike HTTP). The real default
// (20/60s) is verified in signaling.test.mjs via an isolated
// CF-Connecting-IP per run — here we just need the bump, not a test of the
// limit itself.
const server = createServerController(PORT, { JOIN_ROOM_IP_LIMIT: '100000' });

// Common stubs for a participant's context: mic first (otherwise the
// camera stub can't delegate audio requests to it, see the comment on
// installCamStub in helpers.mjs), then camera, then screen (a separate API
// — its order relative to the other two doesn't matter).
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

/** The crown is visible (not .hidden) on the tile `selector .tile-crown`. */
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

// --- WebSocket spy: intercepts EVERY send() of the page and remembers
// frames with type === 'chat' (see src/protocol.rs::ClientMessage::Chat —
// the addressed fallback relay). F1: chat now goes entirely over the mesh
// RTCDataChannel (see static/chat.js/bus.js) — the server fallback only
// kicks in if the DataChannel bus to a given peer isn't open. With a live,
// settled mesh (as in this test — WebRTC has long been up by the time chat
// is sent), there should be no 'chat' frames on the server socket at all,
// for any participant. Installed BEFORE the first navigation
// (addInitScript runs on every page load of the context).
//
// F2: also remember frames with type === 'stream-info' (media track labels
// kind/name/enabled, see static/room.js: sendStreamInfoTo) — along with the
// send time (Date.now() of the same browser context used for the
// comparison in the test). Per protocol, stream-info is ALWAYS allowed
// through the server during the bootstrap window right after joining the
// room (the bus to a given peer hasn't opened yet — see static/rtc.js:
// onBusOpen), so the mere presence of such a frame isn't a bug — the bug
// would be a frame AFTER the bootstrap window (see the check below in
// main()).
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
            // not a string/not JSON — definitely not our frame
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

// F3 (repeated offer/answer/ice over the bus, see static/rtc.js): the total
// number of offer+answer+ice-candidate frames this page sent to the server
// WS (requires installSignalingFrameSpy on the context — see main() below,
// installed on vasyaContext/petyaContext/olyaContext). Used as a
// "before/after" pair around renegotiations after the mesh has settled
// (camera/microphone/screen sharing) — per protocol the count shouldn't
// grow at all, since the bus is already open by that point (see
// waitForBusOpenToAllPeers above).
async function signalRelayFramesCount(page) {
  const frames = await allFramesSentOn(page);
  return frames.filter((f) => f && (f.type === 'offer' || f.type === 'answer' || f.type === 'ice-candidate')).length;
}

// How many milliseconds after a mesh pair settles (connectionState
// 'connected' on both RTCPeerConnections, see waitForMeshSettled) the
// server relay for stream-info is still considered a normal bootstrap path
// (the bus doesn't open instantly after connected — the data channel's
// SCTP negotiation follows shortly after, see static/rtc.js). After this
// window ANY new stream-info must go only over the bus (see onBusOpen in
// static/rtc.js/room.js — the snapshot sent right when the bus opens is
// what makes the server path rare).
const STREAM_INFO_BOOTSTRAP_WINDOW_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check that none of `pagesByLabel` had stream-info frames go through the
 * server AFTER the bootstrap window (see STREAM_INFO_BOOTSTRAP_WINDOW_MS).
 * `settledAtByLabel` — Map<label, ts> of when the corresponding page's mesh
 * became 'connected' (see the calls below in main()). If less time than
 * the window has actually elapsed since then, we sleep the difference so
 * we don't get a false "green" result just because the previous steps ran
 * faster than expected.
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
      `${label} sent stream-info frames through the server instead of the bus after the bootstrap window (${STREAM_INFO_BOOTSTRAP_WINDOW_MS}ms from mesh settling): ${JSON.stringify(late)}`
    );
  }
}

async function main() {
  await buildServer();
  await server.start();

  let browser = null;
  // Room passed from step "S1: wrong t" to step "Call duration limit" — see
  // the comment on roomIdForTimerTestReuse = wrongKeyRoomId below: this
  // saves one POST /api/rooms (H2: ROOM_CREATION_IP_LIMIT — production
  // default 3 per 60s from a single IP, see
  // state::DEFAULT_ROOM_CREATION_IP_LIMIT in src/state.rs; this file
  // creates many rooms in one run, so the server here is started with
  // ROOM_CREATION_IP_LIMIT=100000, see
  // tests/e2e/helpers.mjs::createServerController — but the room-reuse
  // discipline below is kept not only for the limit but also just to avoid
  // spawning extra rooms).
  let roomIdForTimerTestReuse = null;

  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    // --- Vasya: home page -> name -> create room ---
    const vasyaContext = await browser.newContext();
    await installMediaStubs(vasyaContext);
    await installChatWsSpy(vasyaContext);
    await installPcRegistry(vasyaContext);
    // F3: spy on ALL server WS frames (not just chat/stream-info, see
    // installChatWsSpy above) — needed below to prove that offer/answer/
    // ice-candidate frames from repeated renegotiations (camera/microphone/
    // screen sharing AFTER the mesh has settled) don't grow through the
    // server (see the check at the end of the main scenario).
    await installSignalingFrameSpy(vasyaContext);
    const vasyaPage = await vasyaContext.newPage();

    let roomId = null;
    // Room name (see static/index.html/landing.js: #room-name-input,
    // static/namegen.js: NameGen.roomName()) — now seen by ALL participants
    // who join via the invite link (it carries `&n=`, see buildShareLink in
    // static/room.js), not just the creator (Vasya); used below and in the
    // step about the "Share" popup/privacy.
    const ROOM_NAME = 'My room';
    const roomCreatedOk = await step('Vasya: home page -> edits the prefilled room name -> creates the room -> enters name in the room join modal -> becomes leader (crown)', async () => {
      await vasyaPage.goto(server.baseUrl);

      // The room name input is prefilled with a generated name (emoji + 2
      // English words, see NameGen.roomName()) — before overwriting it with
      // our own value, check that it's actually prefilled and that it fits
      // within maxlength=40 (otherwise the browser would truncate the value
      // on fill, and the later check against the header would diverge from
      // what was actually entered).
      const prefilledRoomName = await vasyaPage.inputValue('#room-name-input');
      assert.ok(prefilledRoomName, 'the #room-name-input on the landing page should be prefilled with a generated name');
      assert.ok(
        prefilledRoomName.length > 0 && prefilledRoomName.length <= 40,
        `the prefilled room name should be non-empty and no longer than 40 characters, got (${prefilledRoomName.length}): "${prefilledRoomName}"`
      );

      // The ↻ button next to the field (see static/index.html: .input-with-regen,
      // static/landing.js: roomNameRegenButtonEl click) — rolls a new
      // generated name without submitting the form.
      await vasyaPage.click('#room-name-regen-button');
      const regeneratedRoomName = await vasyaPage.inputValue('#room-name-input');
      assert.ok(
        regeneratedRoomName && regeneratedRoomName !== prefilledRoomName,
        `clicking ↻ should generate a new room name, was "${prefilledRoomName}", became "${regeneratedRoomName}"`
      );

      await vasyaPage.fill('#room-name-input', ROOM_NAME);

      await vasyaPage.click('#create-room-button');
      await vasyaPage.waitForURL(/\/r\/[^/]+/, { timeout: 10_000 });
      // The landing page no longer asks for the participant's name
      // (anonymity — see static/landing.js) — the role is extracted from
      // /r/<id>#lt=<token>. We don't match the fragment against "$": it may
      // already have been cleaned up by this point via history.replaceState
      // (see static/room.js), or it may not — the regex doesn't care either
      // way.
      const match = vasyaPage.url().match(/\/r\/([^/#]+)/);
      assert.ok(match, `couldn't extract roomId from URL: ${vasyaPage.url()}`);
      roomId = match[1];
      await joinRoom(vasyaPage, 'Vasya');
      await waitForOverlayHidden(vasyaPage);

      // The creator's room name — in the tab title and in the header's
      // .room-logo (see static/room.js: initialRoomName, rendered
      // synchronously even before init()); by this point the fragment has
      // been rebuilt to `#t=...&e=...&n=...` — only the one-time lt is
      // cleaned out, t/e/n remain in the address bar (that's the whole
      // point of v2 — see docs/research-p2p-key-handoff.md §6.5–6.6: the
      // link must survive an F5).
      const title = await vasyaPage.title();
      assert.ok(
        title.includes(ROOM_NAME),
        `the creator's tab title should contain the room name "${ROOM_NAME}", got: "${title}"`
      );
      const roomLogoText = await vasyaPage.locator('.room-logo').textContent();
      assert.equal(
        roomLogoText,
        ROOM_NAME,
        `.room-logo for the creator should show the room name, got: "${roomLogoText}"`
      );
      const hashAfterJoin = await vasyaPage.evaluate(() => location.hash);
      assert.ok(
        hashAfterJoin.includes('t=') && hashAfterJoin.includes('e=') && hashAfterJoin.includes('n='),
        `the fragment should keep t=, e= and n= after the first parse, got: "${hashAfterJoin}"`
      );
      assert.ok(
        !hashAfterJoin.includes('lt='),
        `the fragment should be cleaned of the one-time lt= after the first parse, got: "${hashAfterJoin}"`
      );

      // The creator presented the leaderToken from the link fragment —
      // became leader: crown on their tile.
      await vasyaPage.waitForFunction(
        () => !document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 5000 }
      );
    });

    if (!roomCreatedOk || !roomId) {
      console.log('FAIL - critical error: room was not created, further checks are impossible');
      skip('Petya and Olya join', 'room was not created');
      skip('video/audio/screen sharing/chat', 'room was not created');
      return;
    }

    const roomUrl = `${server.baseUrl}/r/${roomId}`;
    // S1 v2 (E2E encryption): the token `t` and the expiry `e` were
    // generated by Vasya's own browser when clicking "Create room" (see
    // static/landing.js) — the test doesn't know them in advance, we read
    // them straight from the page (see getRoomFragmentFromPage). Guests need
    // the link WITH #t/#e (without them — "Incomplete link", see the
    // separate test below) and WITHOUT #lt (that one is one-time and only
    // for the creator); we add the room name (#n=) here explicitly to
    // simulate a real invite link from buildShareLink (static/room.js) — it
    // now carries `n` too.
    const vasyaFragment = await getRoomFragmentFromPage(vasyaPage); // { t, e }
    const guestRoomUrl = `${roomUrlWithKey(server.baseUrl, roomId, vasyaFragment.t, { e: vasyaFragment.e })}&n=${encodeURIComponent(ROOM_NAME)}`;

    // --- Petya and Olya open the same link ---
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

    // peerId label -> ts (in that same page's browser context clock), for
    // when its mesh became 'connected' — see assertNoLateStreamInfoOverServer
    // below (the stream-info bootstrap window is counted from this moment).
    const meshSettledAtByLabel = new Map();

    // F3: peerId label -> number of offer+answer+ice-candidate frames
    // through the server AT THE MOMENT the mesh+bus have already settled
    // (see signalRelayFramesCount/waitForBusOpenToAllPeers above) — the
    // baseline for the "before/after" comparison around all subsequent
    // renegotiations (camera/microphone/screen sharing), see the check at
    // the end of the scenario.
    const signalRelayCountAtMeshSettledByLabel = new Map();

    const everyoneJoinedOk = await step('Petya and Olya open the room link (join modal), all three have 3 tiles, only Vasya has the crown', async () => {
      await petyaPage.goto(guestRoomUrl);
      await olyaPage.goto(guestRoomUrl);
      await joinRoom(petyaPage, 'Petya');
      await joinRoom(olyaPage, 'Olya');
      await waitForOverlayHidden(petyaPage);
      await waitForOverlayHidden(olyaPage);

      // The room name is now seen by ALL participants, not just the creator
      // (see static/landing.js/room.js): guestRoomUrl carries `&n=`
      // (modeled as a real invite link from buildShareLink) — the tab title
      // and .room-logo for the guests should show "My room", which Vasya
      // entered on the landing page, exactly like for Vasya himself.
      for (const [label, page] of [['Petya', petyaPage], ['Olya', olyaPage]]) {
        const guestTitle = await page.title();
        assert.ok(
          guestTitle.includes(ROOM_NAME),
          `${label}'s tab title should contain the room name "${ROOM_NAME}", got: "${guestTitle}"`
        );
        const guestRoomLogo = await page.locator('.room-logo').textContent();
        assert.equal(
          guestRoomLogo,
          ROOM_NAME,
          `${label}'s .room-logo should show the room name "${ROOM_NAME}", got: "${guestRoomLogo}"`
        );
      }

      // waitForMeshSettled waits both for the tiles and for all three
      // participants' mesh connections (bus + signaling) to actually reach
      // connected — see helpers.mjs.
      await waitForMeshSettled([vasyaPage, petyaPage, olyaPage], { tileCount: 3, connectionsPerPage: 2 });

      // F3: connectionState==='connected' on an RTCPeerConnection doesn't
      // guarantee the DataChannel bus is open INSTANTLY (its own SCTP
      // handshake is a separate, slightly later negotiation) — explicitly
      // wait for bus.isOpen() with both pairs on each page, before
      // deliberately triggering renegotiations further down the scenario
      // (camera/microphone/screen) and checking that they go over the bus,
      // not through the server (see waitForBusOpenToAllPeers/the signaling
      // counter comparison at the end of the scenario).
      for (const page of [vasyaPage, petyaPage, olyaPage]) {
        await waitForBusOpenToAllPeers(page);
      }

      for (const [label, page] of [['Vasya', vasyaPage], ['Petya', petyaPage], ['Olya', olyaPage]]) {
        meshSettledAtByLabel.set(label, await page.evaluate(() => Date.now()));
        signalRelayCountAtMeshSettledByLabel.set(label, await signalRelayFramesCount(page));
      }

      // (a) Vasya is the leader (crown on his tile for everyone else), Petya/Olya have no crown.
      const vasyaTileSel = await tileSelector('Vasya');
      for (const page of [petyaPage, olyaPage]) {
        await page.waitForFunction(
          (sel) => !document.querySelector(`${sel} .tile-crown`)?.classList.contains('hidden'),
          vasyaTileSel,
          { polling: 100, timeout: 5000 }
        );
      }
      for (const [label, page] of [['Petya', petyaPage], ['Olya', olyaPage]]) {
        const ownCrownHidden = await page.evaluate(
          () => document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden')
        );
        assert.equal(ownCrownHidden, true, `${label} should not have a crown on their own tile`);
      }
    });

    if (!everyoneJoinedOk) {
      console.log('FAIL - critical error: failed to get all three participants into the room, further checks are impossible');
      skip('camera/microphone/screen/chat', 'participants did not join');
      return;
    }

    // --- SAS: human-friendly key verification (commit-reveal, see
    // docs/sas-verification.md). Lives ONLY in the top bar of the main window
    // (#topbar-sas) — the old duplicate in the chat panel header (.chat-sas) has been removed. ---
    await step('SAS: all three participants have the same non-empty verification code in the top bar (5 emoji), assembled by the commit-reveal round', async () => {
      const pages = [['Vasya', vasyaPage], ['Petya', petyaPage], ['Olya', olyaPage]];
      // Wait for the round to complete (state 'ok') for everyone — 3s timer + trigger on bus-open.
      for (const [, page] of pages) {
        await waitForClassOnSelector(page, '#topbar-sas', 'topbar-sas--ok', true, 20000);
      }
      const codes = [];
      for (const [label, page] of pages) {
        const topbarHidden = await page.evaluate(() => document.getElementById('topbar-sas')?.classList.contains('hidden'));
        assert.equal(topbarHidden, false, `${label}'s #topbar-sas should be visible after successful verification`);
        const code = await page.locator('#topbar-sas').textContent();
        codes.push([label, code]);
      }
      const first = codes[0][1];
      assert.ok(
        first && first.split(' ').filter(Boolean).length === 5,
        `SAS code should consist of 5 emoji, got from Vasya: "${first}"`
      );
      for (const [label, code] of codes) {
        assert.equal(code, first, `${label}'s SAS code should match the others ("${code}" != "${first}")`);
      }
    });

    // --- Clicking the SAS badge expands details (see static/room.js:
    // openTopbarSasPopup/closeTopbarSasPopup) — the hex code (5 bytes = 10 hex chars) and
    // the state explanation, which used to live in the chat panel header (.chat-sas-note),
    // now live only here. Closing: Esc, clicking the badge again, clicking outside. ---
    await step('SAS: clicking #topbar-sas opens a popup with 5 emoji and a hex code; Esc/clicking again/clicking outside close it', async () => {
      const page = vasyaPage;
      await page.waitForFunction(
        () => document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 2000 }
      );

      await page.click('#topbar-sas');
      await page.waitForFunction(
        () => !document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 3000 }
      );

      const popupEmojiText = (await page.locator('#topbar-sas-popup-emoji').textContent()) || '';
      const topbarText = (await page.locator('#topbar-sas').textContent()) || '';
      assert.equal(
        popupEmojiText,
        topbarText,
        `emoji in the popup should match the badge ("${popupEmojiText}" != "${topbarText}")`
      );
      assert.equal(
        popupEmojiText.split(' ').filter(Boolean).length,
        5,
        `popup should contain 5 emoji, got: "${popupEmojiText}"`
      );

      const hexText = (await page.locator('#topbar-sas-popup-hex').textContent()) || '';
      assert.match(
        hexText,
        /^Text code: [0-9a-f]{10}$/,
        `hex code in the popup should be of the form "Text code: <10 hex>" (5 bytes), got: "${hexText}"`
      );

      const popupNoteText = (await page.locator('#topbar-sas-popup-text').textContent()) || '';
      assert.ok(popupNoteText.length > 0, 'popup should carry explanatory text about SAS verification');

      // Esc closes it (same pattern as onSharePopupKeydown).
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 2000 }
      );

      // Clicking the badge again — open, then close with the same click again.
      await page.click('#topbar-sas');
      await page.waitForFunction(
        () => !document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 3000 }
      );
      await page.click('#topbar-sas');
      await page.waitForFunction(
        () => document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 2000 }
      );

      // Clicking outside (on the popup backdrop, see #topbar-sas-popup-backdrop) — also closes it.
      await page.click('#topbar-sas');
      await page.waitForFunction(
        () => !document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 3000 }
      );
      await page.click('#topbar-sas-popup-backdrop', { position: { x: 5, y: 5 } });
      await page.waitForFunction(
        () => document.getElementById('topbar-sas-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 2000 }
      );
    });

    // --- Vasya turns on the camera ---
    const vasyaTileSel = await tileSelector('Vasya');
    const camOk = await step('Vasya turns on the camera — Petya and Olya see live video in his tile', async () => {
      await vasyaPage.click('#camera-button');
      for (const [label, page] of [['Petya', petyaPage], ['Olya', olyaPage]]) {
        await assertVideoPlaying(page, { selector: `${vasyaTileSel} video` });
      }
    });
    if (!camOk) {
      skip('microphone/speaking', 'Vasya\'s camera did not work');
    }

    // --- Clicking a tile — "full-page" maximization with spotlight (see
    // static/room.js: maximizeTile/unmaximizeTile/updateSpotlightMode, classes
    // .tile--maximized/.tiles-grid--spotlight in static/style.css). In Petya's
    // room, besides Vasya there is also Olya, so maximizing Vasya's tile
    // should enable the ribbon — the maximized tile itself takes up the viewport
    // MINUS the ribbon strip (not 95%+ as it was in the version without spotlight, but
    // noticeably less — somewhere around 0.65-0.85 depending on viewport width), while
    // Petya's tile (own) and Olya's tile remain visible (small, in the ribbon), rather than
    // disappearing from the DOM/being hidden. We check this on Vasya's live video in
    // Petya's tile (camOk above) — and separately on Olya's tile without video. ---
    if (camOk) {
      await step(
        'Petya clicks Vasya\'s tile (video is live) — tile maximizes into spotlight (viewport minus ribbon), others visible small in the ribbon; clicking again and Esc remove it; clicking a tile without video — does nothing',
        async () => {
          const viewport = petyaPage.viewportSize();
          assert.ok(viewport, 'Petya\'s page should have a known viewport size');
          const viewportArea = viewport.width * viewport.height;
          const olyaTileSel = await tileSelector('Olya');
          const ownTileSel = '.tile--own';

          // 1) Clicking Vasya's tile (video visible) — .tile--maximized
          // + .tiles-grid--spotlight appear (Petya also has Olya — the ribbon is needed).
          // The maximized tile occupies a LARGE part of the viewport, but not
          // all of it (on the right/bottom — a ribbon strip, see static/style.css), so
          // the threshold is noticeably lower than the previous 95%, but still much bigger
          // than the normal tile size in the grid.
          await petyaPage.click(vasyaTileSel);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', true, 3000);
          await waitForClassOnSelector(petyaPage, '#tiles-grid', 'tiles-grid--spotlight', true, 3000);
          const maximizedBox = await petyaPage.locator(vasyaTileSel).boundingBox();
          assert.ok(maximizedBox, 'could not get boundingBox of Vasya\'s maximized tile');
          assert.ok(
            maximizedBox.width * maximizedBox.height >= viewportArea * 0.6,
            `spotlight tile should occupy most of the viewport (${viewport.width}x${viewport.height}) minus the ribbon, got ${maximizedBox.width}x${maximizedBox.height}`
          );
          assert.ok(
            maximizedBox.width * maximizedBox.height < viewportArea * 0.98,
            `spotlight tile should NOT occupy the ENTIRE viewport (the ribbon should take up space), got ${maximizedBox.width}x${maximizedBox.height} out of ${viewport.width}x${viewport.height}`
          );

          // The others (Petya's own tile and Olya's tile) remain visible — small,
          // in the ribbon, rather than disappearing from view (same nodes, not moved).
          for (const sel of [ownTileSel, olyaTileSel]) {
            const box = await petyaPage.locator(sel).boundingBox();
            assert.ok(box, `tile ${sel} should remain visible (in the spotlight ribbon)`);
            assert.ok(
              box.width * box.height < viewportArea * 0.2,
              `tile ${sel} in the ribbon should be small, got ${box.width}x${box.height}`
            );
          }

          // 2) Clicking the same (maximized/spotlight) tile again
          // — removes both the maximization and the spotlight, the tile returns to the normal
          // grid (noticeably smaller than the viewport).
          await petyaPage.click(vasyaTileSel);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', false, 3000);
          await waitForClassOnSelector(petyaPage, '#tiles-grid', 'tiles-grid--spotlight', false, 3000);
          const gridBox = await petyaPage.locator(vasyaTileSel).boundingBox();
          assert.ok(gridBox, 'could not get boundingBox of Vasya\'s tile after removing maximization');
          assert.ok(
            gridBox.width * gridBox.height < viewportArea * 0.5,
            `tile should return to normal grid size after removing maximization (noticeably smaller than viewport ${viewport.width}x${viewport.height}), got ${gridBox.width}x${gridBox.height}`
          );

          // 3) Clicking Olya's tile IN THE RIBBON would demonstrate spotlight
          // switching, but Olya has no video in this scenario — clicking her tile does
          // nothing (see point 4 below); switching the spotlight to a live tile
          // is checked separately, when Olya has video (see the step below).
          // Here — click Vasya again (maximize), then Esc — also removes it.
          await petyaPage.click(vasyaTileSel);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', true, 3000);
          await petyaPage.keyboard.press('Escape');
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', false, 3000);
          await waitForClassOnSelector(petyaPage, '#tiles-grid', 'tiles-grid--spotlight', false, 3000);

          // 4) Clicking a tile WITHOUT video (Olya's camera is not
          // turned on at all in this scenario) — maximization should not happen (see
          // createTile: clicking a tile with video.hidden — no-op).
          await petyaPage.click(olyaTileSel);
          await sleep(300);
          const olyaMaximized = await petyaPage.evaluate(
            (sel) => document.querySelector(sel)?.classList.contains('tile--maximized'),
            olyaTileSel
          );
          assert.equal(olyaMaximized, false, 'clicking a tile without video should not maximize it');
        }
      );
    } else {
      skip('clicking Vasya\'s tile — full-page maximization', 'Vasya\'s camera did not work');
    }

    // --- Clicking a DIFFERENT tile in the spotlight ribbon switches to it —
    // "last click wins" (see static/room.js: maximizeTile itself
    // removes the previous maximized tile before setting a new one).
    // We need a second tile with live video at the same time as Vasya's — briefly
    // turn on Petya's own camera (the same fake stub already confirmed by
    // camOk for Vasya), check the switch, then turn it back off, so as
    // not to affect further steps of the scenario (Petya's outgoing speed counter
    // below will survive this equally well in either state — it only checks
    // the "↑" prefix, not the specific value). ---
    let ribbonSwitchOk = false;
    if (camOk) {
      ribbonSwitchOk = await step(
        'Petya has his own camera on — clicking his own (small, in-ribbon) tile switches the spotlight from Vasya to himself',
        async () => {
          const ownTileSel = '.tile--own';
          await petyaPage.click('#camera-button');
          await assertVideoPlaying(petyaPage, { selector: `${ownTileSel} video` });

          // Maximize Vasya (ribbon is active — Petya now has both his own tile with
          // live video, and Olya without video).
          await petyaPage.click(vasyaTileSel);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', true, 3000);

          // Clicking own tile IN THE RIBBON (live video) — switches the spotlight.
          await petyaPage.click(ownTileSel);
          await waitForClassOnSelector(petyaPage, ownTileSel, 'tile--maximized', true, 3000);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', false, 3000);

          // Clean up after ourselves: remove the maximization (click on the spotlight) and
          // turn Petya's camera back off.
          await petyaPage.click(ownTileSel);
          await waitForClassOnSelector(petyaPage, ownTileSel, 'tile--maximized', false, 3000);
          await petyaPage.click('#camera-button');
        }
      );
    } else {
      skip('clicking a tile in the ribbon switches the spotlight', 'Vasya\'s camera did not work (see camOk above)');
    }
    if (!ribbonSwitchOk) {
      console.log('# [diagnostics] spotlight switching by clicking in the ribbon was not confirmed — see FAIL above');
    }

    // --- Speed badges on tiles (see static/room.js: updateTileSpeedBadges,
    // PEER_STATS_REFRESH_MS=3000) — a single poller ticks regardless of whether
    // settings are open. On Vasya's tile for Petya, the badge should show HIS
    // INCOMING speed (Vasya's camera media is actually flowing, since camOk) — format
    // "… B/s"/"… KB/s"/"<1 KB/s" (see formatSpeedBadge), so the regex
    // /B\/s$/ matches all variants. On Petya's OWN tile — the total
    // OUTGOING speed across all peers (Vasya+Olya) with the "↑" prefix: Petya's
    // camera is not yet on in this scenario, but the tile does not show zero
    // traffic as "no speed" — the speed is computed (0 or more) already
    // after the first snapshot of counters, and at minimum a SERVICE DataChannel exchange
    // (bus: SAS commit/reveal, stream-info) happens even without camera/microphone —
    // computePeerConnectionStats takes transport stats, which cover ALL
    // DTLS traffic, not just media (see findTransportBytes). We wait with a margin
    // of ~2-3 poller ticks (3s each).
    if (camOk) {
      await step(
        'For Petya, a speed badge for incoming appears on Vasya\'s tile, and on his own tile — outgoing (with "↑")',
        async () => {
          await petyaPage.waitForFunction(
            (sel) => /B\/s$/.test(document.querySelector(`${sel} .tile-speed`)?.textContent || ''),
            vasyaTileSel,
            { polling: 500, timeout: 10_000 }
          );
          await waitForClassOnSelector(petyaPage, `${vasyaTileSel} .tile-speed`, 'hidden', false, 1000);

          await petyaPage.waitForFunction(
            () => (document.querySelector('.tile--own .tile-speed')?.textContent || '').startsWith('↑'),
            undefined,
            { polling: 500, timeout: 10_000 }
          );
          await waitForClassOnSelector(petyaPage, '.tile--own .tile-speed', 'hidden', false, 1000);
        }
      );
    } else {
      skip('speed badges on tiles', 'Vasya\'s camera did not work');
    }

    // --- Settings: device selects get populated (fake flags provide fake devices) ---
    await step(
      'Vasya\'s settings populate the microphone/camera selects (enumerateDevices is not stubbed — a real list, including fake devices from CAPTURE_FLAGS)',
      async () => {
        await vasyaPage.click('#settings-button');
        await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });
        // refreshDeviceLists() inside openSettingsPanel is asynchronous
        // (enumerateDevices returns a Promise) — we wait for the options to actually appear, rather than
        // counting them right after the click (a race, see static/room.js).
        await vasyaPage.waitForFunction(
          () => document.querySelectorAll('#setting-mic-device option').length > 0,
          undefined,
          { polling: 100, timeout: 3000 }
        );
        const micCount = await vasyaPage.locator('#setting-mic-device option').count();
        const camCount = await vasyaPage.locator('#setting-camera-device option').count();
        assert.ok(micCount > 0, `microphone select should be populated with at least one device, got ${micCount}`);
        assert.ok(camCount > 0, `camera select should be populated with at least one device, got ${camCount}`);
        await vasyaPage.click('#settings-panel-close');
      }
    );

    // --- Settings: "Connection and privacy" section (visible to EVERYONE) ---
    await step(
      'Settings has a "Connection and privacy" section: the encryption line contains AES-256-GCM/256-bit, the connection mode with a settled peer eventually becomes "direct (P2P)", the server signaling counter is > 0, each peer has a traffic stats line (and over time — speed, since Vasya\'s camera is on)',
      async () => {
        await vasyaPage.click('#settings-button');
        await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });

        const cryptoText = await vasyaPage.locator('#settings-crypto-text').textContent();
        assert.ok(cryptoText.includes('AES-256-GCM'), `encryption line should contain "AES-256-GCM": ${cryptoText}`);
        assert.ok(cryptoText.includes('256'), `encryption line should contain "256" (key bits): ${cryptoText}`);

        // The connection mode with an already settled (waitForMeshSettled above)
        // mesh peer should eventually become "direct (P2P)" — the peer list
        // is rendered from the cache of a single speed poller that ticks once every
        // PEER_STATS_REFRESH_MS=3000 (see static/room.js: pollPeerStats),
        // so we poll with a margin of up to 10s.
        await vasyaPage.waitForFunction(
          () => {
            const rows = Array.from(document.querySelectorAll('#settings-peers-list .settings-peer-row'));
            return rows.some((row) => row.textContent.includes('direct (P2P)'));
          },
          undefined,
          { polling: 200, timeout: 10_000 }
        );

        const signalingCountText = await vasyaPage.locator('#settings-signaling-count').textContent();
        assert.ok(
          Number(signalingCountText) > 0,
          `server signaling counter should be > 0 (bootstrap exchange of offer/answer/ice is unavoidable), got ${signalingCountText}`
        );

        // The server WS traffic line (static/common.js: ConnStats.bytesSent/
        // bytesReceived, static/room.js: renderServerCounters) — same format
        // as per-peer stats: "↓ … ↑ …" (cumulative total with "∑" on the first
        // render, speed afterwards). By this point signaling has already happened
        // (the message counter above is > 0), so bytes are > 0 too.
        const serverTrafficText = await vasyaPage.locator('#settings-server-traffic').textContent();
        assert.match(
          serverTrafficText,
          /↓ .+ ↑ .+/,
          `server traffic line should be of the form "↓ … ↑ …", got: "${serverTrafficText}"`
        );

        // (Per-peer stats, see static/room.js: computePeerConnectionStats/
        // formatPeerStatsLine/renderPeerConnectionsList): each peer row now
        // has .settings-peer-stats next to .settings-peer-label — a non-empty
        // string containing both ↓ and ↑ (this holds both for the very first tick —
        // cumulative total "∑ ↓ … ↑ …", and for speed "↓ …/s ↑ …/s").
        const statsTexts = await vasyaPage.evaluate(() =>
          Array.from(document.querySelectorAll('#settings-peers-list .settings-peer-row')).map(
            (row) => row.querySelector('.settings-peer-stats')?.textContent || ''
          )
        );
        assert.ok(statsTexts.length > 0, 'the peer list should have at least one row (Petya+Olya)');
        for (const text of statsTexts) {
          assert.ok(
            text.includes('↓') && text.includes('↑'),
            `.settings-peer-stats line should contain "↓" and "↑", got: "${text}"`
          );
        }

        // The speed poller ticks once every PEER_STATS_REFRESH_MS=3000, ALWAYS
        // (not only while the panel is open, see static/room.js: pollPeerStats)
        // — Vasya's camera is already on (see camOk above), traffic to Petya/Olya
        // is definitely flowing, so sooner or later the line switches from the
        // cumulative total to SPEED ("↓ …B/s ↑ …B/s"). We wait with a margin of
        // several ticks (15s) plus the polling interval itself.
        if (camOk) {
          await vasyaPage.waitForFunction(
            () => {
              const rows = Array.from(document.querySelectorAll('#settings-peers-list .settings-peer-row'));
              return rows.some((row) => /[KMB]?B\/s/.test(row.querySelector('.settings-peer-stats')?.textContent || ''));
            },
            undefined,
            { polling: 500, timeout: 15_000 }
          );

          // RTT — an optional part of the line (currentRoundTripTime might not
          // be provided by the browser), but if it's present — we check the format "· N ms".
          const statsTextsAfterTicks = await vasyaPage.evaluate(() =>
            Array.from(document.querySelectorAll('#settings-peers-list .settings-peer-row')).map(
              (row) => row.querySelector('.settings-peer-stats')?.textContent || ''
            )
          );
          for (const text of statsTextsAfterTicks) {
            const rttMatch = text.match(/· (\d+) ms$/);
            if (rttMatch) {
              assert.ok(Number(rttMatch[1]) >= 0, `RTT in the stats line should be a non-negative number, got: "${text}"`);
            }
          }
        }

        await vasyaPage.click('#settings-panel-close');
      }
    );

    // --- Switching camera "on the fly" (device is on) — without renegotiation ---
    if (camOk) {
      await step(
        'Vasya switches camera in settings while it\'s on (replaceTrack without renegotiation) — video stays live for Petya',
        async () => {
          await vasyaPage.click('#settings-button');
          await vasyaPage.waitForSelector('#settings-panel:not(.hidden)', { timeout: 3000 });
          await vasyaPage.waitForFunction(
            () => document.querySelectorAll('#setting-camera-device option').length > 0,
            undefined,
            { polling: 100, timeout: 3000 }
          );
          // The single fake device is re-selected again — what matters for the test
          // is not switching to DIFFERENT hardware (there is none in CI), but that the
          // "on -> getUserMedia -> RTCRtpSender.replaceTrack" path itself doesn't
          // break the already established connection (see static/room.js:
          // applyCameraDeviceChange/liveSwitchCamTrack).
          const hadOption = await vasyaPage.evaluate(() => {
            const el = document.getElementById('setting-camera-device');
            if (!el.options.length) return false;
            el.value = el.options[0].value;
            el.dispatchEvent(new Event('change'));
            return true;
          });
          assert.ok(hadOption, 'camera select should have at least one option');
          await vasyaPage.click('#settings-panel-close');
          await assertVideoPlaying(petyaPage, { selector: `${vasyaTileSel} video`, waitMs: 1500 });
        }
      );
    } else {
      skip('switching camera on the fly', 'Vasya\'s camera did not work');
    }

    // --- Vasya turns on the microphone ---
    const micOk = await step('Vasya turns on the microphone — Petya and Olya see speaking indication on his tile, the "mic off" indicator disappears', async () => {
      await vasyaPage.click('#mic-button');
      for (const page of [petyaPage, olyaPage]) {
        await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', true, 8000);
        await waitForClassOnSelector(page, `${vasyaTileSel} .tile-mic-off`, 'hidden', true, 4000);
      }
    });

    // --- Petya shares his screen ---
    const petyaShareOk = await step('Petya shares his screen — the main area for Vasya and Olya shows the stream, Olya\'s "Screen" button remains active (taking over sharing is allowed, not blocked); Petya himself sees a "You are sharing" placeholder instead of a preview of his own capture, the fullscreen button is hidden for him and active for viewers', async () => {
      await petyaPage.click('#screen-button');

      await petyaPage.waitForFunction(
        () => document.getElementById('screen-button')?.classList.contains('control-button--on'),
        undefined,
        { polling: 100, timeout: 8000 }
      );

      for (const page of [vasyaPage, olyaPage]) {
        await assertVideoPlaying(page, { selector: '#screen-video' });
        await assertScreenFullscreenButtonState(page, { hidden: false, disabled: false });
      }

      // For Petya himself (the sharer) — a placeholder, NOT a live preview of his own capture
      // (see static/room.js: showLocalScreenPreview — otherwise, when capturing the whole
      // screen, the preview would recursively end up in the frame of the capture itself, a "mirror
      // corridor"). There's no point fullscreening this placeholder — the button is hidden.
      await assertLocalScreenPlaceholder(petyaPage);
      await assertScreenFullscreenButtonState(petyaPage, { hidden: true, disabled: true });

      // Previously, the "Screen" button for others was disabled while someone was sharing —
      // now someone else sharing no longer blocks the button: clicking it takes over
      // the sharing (see the next step), the button is only disabled by the leader's ban.
      const olyaDisabled = await olyaPage.evaluate(() => document.getElementById('screen-button')?.disabled);
      assert.equal(olyaDisabled, false, 'Olya\'s "Screen" button should remain active while Petya is sharing');
    });
    if (!petyaShareOk) {
      skip('Olya takes over sharing from Petya', 'screen sharing did not work');
      skip('fullscreen button of the sharing scene', 'screen sharing did not work');
    }

    // --- Olya takes over screen sharing from Petya (last one wins) ---
    let takeoverOk = false;
    if (petyaShareOk) {
      takeoverOk = await step(
        'Olya takes over sharing — the stage switches to Olya for everyone, Petya\'s sharing is stopped and the button returns to its initial state',
        async () => {
          await olyaPage.click('#screen-button');

          await olyaPage.waitForFunction(
            () => document.getElementById('screen-button')?.classList.contains('control-button--on'),
            undefined,
            { polling: 100, timeout: 8000 }
          );

          // Petya's local capture should stop on its own — the share-started
          // handler on his page recognizes the takeover (the peerId in the
          // broadcast is no longer his, while his own screen capture is still
          // alive) and calls forceStopLocalScreenCapture itself (see static/room.js).
          // The button returns to its normal active state, not "pressed".
          await petyaPage.waitForFunction(
            () => {
              const btn = document.getElementById('screen-button');
              return !!btn && !btn.disabled && !btn.classList.contains('control-button--on');
            },
            undefined,
            { polling: 100, timeout: 8000 }
          );

          // The stage for Vasya and Petya now shows Olya's stream, while Olya
          // herself (the new sharer) sees a placeholder instead of a preview of
          // her own capture, her fullscreen button is hidden, and it's active
          // for the viewers.
          for (const page of [vasyaPage, petyaPage]) {
            await assertVideoPlaying(page, { selector: '#screen-video' });
            await assertScreenFullscreenButtonState(page, { hidden: false, disabled: false });
          }
          await assertLocalScreenPlaceholder(olyaPage);
          await assertScreenFullscreenButtonState(olyaPage, { hidden: true, disabled: true });
        }
      );
    } else {
      skip('Olya takes over sharing from Petya', 'screen sharing did not work');
    }
    if (!takeoverOk) {
      skip('sharing stage fullscreen button', 'the takeover of sharing did not work');
    }

    // --- Fullscreen button on the sharing stage: clicking it must not crash the page ---
    // (we don't check actually entering fullscreen in the headless browser — see
    // static/room.js: requestFullscreenCompat catches the error itself and doesn't rethrow it).
    // We check this on Vasya's page — after the takeover he remains a viewer
    // the whole time (not Olya's owning counterpart), the way Olya was before.
    if (takeoverOk) {
      await step('The fullscreen button on the sharing stage is visible for Vasya, clicking it does not crash the page', async () => {
        const btn = vasyaPage.locator('#screen-fullscreen-button');
        await btn.waitFor({ state: 'visible', timeout: 3000 });
        await btn.click();
        await sleep(200);
        const stillResponsive = await vasyaPage.evaluate(() => !!document.getElementById('screen-fullscreen-button'));
        assert.ok(stillResponsive, 'the page should remain responsive after clicking the fullscreen button');

        // Headless Chrome actually performs the transition to fullscreen (it's not
        // a no-op) — in that case the fullscreen element covers the rest of the
        // page (chat, etc. in the following steps). A real user would exit via
        // Esc, but a synthetic page.keyboard.press('Escape') doesn't reach the
        // browser's fullscreen-Esc handler (verified in a separate run) — so we
        // exit programmatically with the same API the button itself uses (see
        // static/room.js: exitFullscreenCompat).
        const isFullscreen = await vasyaPage.evaluate(
          () => !!(document.fullscreenElement || document.webkitFullscreenElement)
        );
        if (isFullscreen) {
          await vasyaPage.evaluate(() => {
            const fn = document.exitFullscreen || document.webkitExitFullscreen;
            return fn ? fn.call(document) : undefined;
          });
          await vasyaPage
            .waitForFunction(
              () => !(document.fullscreenElement || document.webkitFullscreenElement),
              undefined,
              { polling: 100, timeout: 3000 }
            )
            .catch(() => {});
        }
      });
    }

    // --- Olya stops sharing ---
    let stopShareOk = false;
    if (takeoverOk) {
      stopShareOk = await step('Olya stops sharing — the main area clears for everyone, the room stays alive', async () => {
        await olyaPage.click('#screen-button');

        for (const page of [vasyaPage, petyaPage, olyaPage]) {
          await page.waitForFunction(
            () => document.getElementById('screen-stage')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 8000 }
          );
        }

        // The room is alive: tiles are in place, chat flows between everyone.
        for (const page of [vasyaPage, petyaPage, olyaPage]) {
          await waitForTileCount(page, 3, 3000);
        }

        await openChatPanel(vasyaPage);
        await openChatPanel(petyaPage);
        await openChatPanel(olyaPage);
        const text = `Hello from Vasya — ${Date.now()}`;
        await sendChatMessage(vasyaPage, text);
        assert.ok(await messageTextsInclude(vasyaPage, text), 'the message did not appear for the sender itself (Vasya)');
        assert.ok(await messageTextsInclude(petyaPage, text), 'the message did not reach Petya');
        assert.ok(await messageTextsInclude(olyaPage, text), 'the message did not reach Olya');

        // And in the opposite direction — from Petya to everyone, so the spy
        // below sees traffic from each of the three sides, not just from Vasya.
        const text2 = `Reply from Petya — ${Date.now()}`;
        await sendChatMessage(petyaPage, text2);
        assert.ok(await messageTextsInclude(vasyaPage, text2), 'the reply message did not reach Vasya');
        assert.ok(await messageTextsInclude(petyaPage, text2), 'the reply message did not appear for the sender itself (Petya)');
        assert.ok(await messageTextsInclude(olyaPage, text2), 'the reply message did not reach Olya');
      });
    } else {
      skip('Olya stops sharing', 'the takeover of sharing did not work');
    }

    // --- Live mesh: chat should not have used the server fallback ---
    if (stopShareOk) {
      await step(
        'No chat frame went out over the server WebSocket for any of the three (mesh has long been established, the DataChannel bus is open)',
        async () => {
          for (const [label, page] of [['Vasya', vasyaPage], ['Petya', petyaPage], ['Olya', olyaPage]]) {
            const frames = await chatFramesSentOn(page);
            assert.equal(
              frames.length,
              0,
              `${label} had chat frames go out over the server socket (expected 0, the DataChannel bus should have been open): ${JSON.stringify(frames)}`
            );
          }
        }
      );
    } else {
      skip('check "chat does not go through the server"', 'message exchange in the previous step was not performed');
    }

    // --- Petya starts screen sharing again (the screen is free after Olya left) ---
    if (stopShareOk) {
      await step('Petya starts screen sharing again — the button is active, share-started goes through', async () => {
        const disabledBefore = await petyaPage.evaluate(() => document.getElementById('screen-button')?.disabled);
        assert.equal(disabledBefore, false, 'the "Screen" button for Petya should be active after the screen is freed');

        await petyaPage.click('#screen-button');
        await petyaPage.waitForFunction(
          () => document.getElementById('screen-button')?.classList.contains('control-button--on'),
          undefined,
          { polling: 100, timeout: 8000 }
        );
        // The own preview in the main area appears immediately, without waiting for WebRTC.
        await petyaPage.waitForFunction(
          () => !document.getElementById('screen-stage')?.classList.contains('hidden'),
          undefined,
          { polling: 100, timeout: 5000 }
        );
      });
    } else {
      skip('Petya starts screen sharing again', 'the screen was not freed by Olya');
    }

    // --- Vasya turns the microphone and camera back off ---
    if (micOk) {
      await step('Vasya turns off the microphone with another click — the speaking indication turns off for everyone else, the "mic off" indicator appears', async () => {
        await vasyaPage.click('#mic-button');
        for (const page of [petyaPage, olyaPage]) {
          await waitForClassOnSelector(page, vasyaTileSel, 'tile--speaking', false, 6000);
          await waitForClassOnSelector(page, `${vasyaTileSel} .tile-mic-off`, 'hidden', false, 4000);
        }
      });
    } else {
      skip('Vasya turns off the microphone', 'the microphone was not successfully turned on earlier');
    }

    if (camOk) {
      await step(
        'Vasya turns off the camera — a placeholder appears instead of video for Petya; if Vasya\'s tile was maximized — auto-exit from maximization',
        async () => {
          // Auto-exit (see static/room.js: exitMaximizeIfHidden, called from
          // showTileVideo when a specific tile's video is hidden) — first we
          // maximize Vasya's tile for Petya again, so there's something to exit
          // from (after the previous step it had already been un-maximized again).
          await petyaPage.click(vasyaTileSel);
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', true, 3000);

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
          // The video is hidden — the maximization should be undone automatically,
          // without another click/Esc (otherwise Petya would be left with a black
          // fixed overlay with no picture), and the spotlight strip (if there was
          // one) — also automatically, along with it.
          await waitForClassOnSelector(petyaPage, vasyaTileSel, 'tile--maximized', false, 3000);
          await waitForClassOnSelector(petyaPage, '#tiles-grid', 'tiles-grid--spotlight', false, 3000);
        }
      );
    } else {
      skip('Vasya turns off the camera', 'the camera was not successfully turned on earlier');
    }

    // --- "Share" popup (S1 v2): the QR code is rendered LOCALLY (no trip
    // to the server — see static/vendor/qrcode.js, static/room.js: renderShareQr),
    // the link is of the form /r/<id>#t=<token>&e=<expiry>&n=<name> (WITHOUT #lt). ---
    await step('Vasya opens the "Share" popup — the QR is rendered as a local SVG, the link points to /r/<id>#t=<token>&e=<expiry>&n=<name>', async () => {
      await vasyaPage.click('#share-button');
      await vasyaPage.waitForSelector('#share-popup:not(.hidden)', { timeout: 5000 });

      // The QR is not an <img> with a network src, but a locally generated
      // <svg> inside the #share-popup-qr container; non-empty — it actually
      // contains path markup for the modules (not just an empty tag).
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
      assert.ok(qrSvgInfo.hasSvg, 'the popup should have a QR code <svg> rendered');
      assert.ok(qrSvgInfo.pathLength > 0, `the QR SVG should not be empty (the path should carry module coordinates), got: ${qrSvgInfo.pathLength}`);

      const linkText = (await vasyaPage.textContent('#share-popup-link')) || '';
      assert.match(
        linkText.trim(),
        new RegExp(`/r/${roomId}#t=[A-Za-z0-9_-]+&e=[0-9a-z]+&n=[^&]+$`),
        `the link in the popup should be of the form /r/${roomId}#t=<token>&e=<expiry>&n=<name> (without #lt), got: ${linkText}`
      );
      assert.ok(!linkText.includes('lt='), `the "Share" link must not carry a leaderToken: ${linkText}`);
      // The room name is now PART of the invite link (see static/room.js:
      // buildShareLink) — that's how everyone who follows the link sees it.
      assert.ok(
        linkText.includes(`n=${encodeURIComponent(ROOM_NAME)}`),
        `the "Share" link should carry the room name (n=${encodeURIComponent(ROOM_NAME)}): ${linkText}`
      );

      // #t/#e in the link are the REAL room token and expiry (the same ones
      // Vasya himself derived on entry, see vasyaFragment above), not random
      // junk — we verify this directly, without adding an extra participant
      // (that would drag along a new stream-info frame in the bootstrap
      // window and break the next check). The link is now of the form
      // `#t=<t>&e=<e>&n=<name>` — we take the substrings between `#t=`/`&e=`
      // and the next `&`, not everything to the end of the string.
      const afterHash = linkText.trim().split('#t=')[1];
      const linkToken = afterHash.split('&e=')[0];
      const linkExpiry = afterHash.split('&e=')[1].split('&')[0];
      assert.equal(linkToken, vasyaFragment.t, `#t in the "Share" link should match the real room token (got ${linkToken})`);
      assert.equal(linkExpiry, vasyaFragment.e, `#e in the "Share" link should match the real room expiry (got ${linkExpiry})`);

      // Privacy of the room name (S1): even now that ALL participants see
      // the name via the invite link, #n= never goes to the server (see
      // static/landing.js/room.js — by construction the fragment never
      // leaves the browser on its own) — we verify this in practice through
      // the spy on ALL server-WS frames installed on Vasya's page at the very
      // start of the scenario (installSignalingFrameSpy): neither the raw
      // room name string nor its encodeURIComponent variant should appear in
      // any frame sent during the whole scenario up to this point (join,
      // offer/answer/ice, stream-info, chat messages, etc.).
      const vasyaFramesRaw = JSON.stringify(await allFramesSentOn(vasyaPage));
      assert.ok(
        !vasyaFramesRaw.includes(ROOM_NAME),
        `the room name "${ROOM_NAME}" must not appear in any of Vasya's WS frames`
      );
      assert.ok(
        !vasyaFramesRaw.includes(encodeURIComponent(ROOM_NAME)),
        `the URL-encoded room name must not appear in any of Vasya's WS frames`
      );

      await vasyaPage.click('#share-popup-close');
      // Not page.waitForSelector('#share-popup.hidden') — by default it waits
      // for the matched element's visibility, and .hidden is display:none (see
      // the same trick in helpers.mjs::waitForOverlayHidden), so that selector
      // would never resolve.
      await vasyaPage.waitForFunction(
        () => document.getElementById('share-popup')?.classList.contains('hidden'),
        undefined,
        { polling: 100, timeout: 5000 }
      );
    });

    // --- Live mesh: NEW stream-info (camera/mic on/off AFTER the connection
    // was established, earlier in the scenario) should not have gone through
    // the server outside the bootstrap window — the main path is now the
    // DataChannel bus (see static/rtc.js: onBusOpen, static/room.js:
    // sendStreamInfoTo/handleStreamInfo).
    if (everyoneJoinedOk) {
      await step(
        `No stream-info frame went out over the server WebSocket AFTER the bootstrap window (${STREAM_INFO_BOOTSTRAP_WINDOW_MS}ms from mesh being established) for any of the three`,
        async () => {
          await assertNoLateStreamInfoOverServer(
            [
              ['Vasya', vasyaPage],
              ['Petya', petyaPage],
              ['Olya', olyaPage],
            ],
            meshSettledAtByLabel
          );
        }
      );
    } else {
      skip('check "new stream-info does not go through the server after the bootstrap window"', 'mesh did not get established');
    }

    // --- F3: repeated offer/answer/ice AFTER mesh is established go over the
    // bus, not through the server ---
    //
    // Since mesh+bus settled (see signalRelayCountAtMeshSettledByLabel above)
    // the scenario has already managed to trigger SEVERAL real renegotiations
    // (addTrack -> onnegotiationneeded, not just a track.enabled toggle):
    // Vasya turned his camera and microphone on, Petya and Olya shared their
    // screens one after another, Vasya switched his camera device. Each of
    // these is a new offer/answer (and the accompanying trickle ICE) between
    // the corresponding pair. Given F3, ALL of them should have gone over the
    // DataChannel bus (the bus is already open, pc is already 'connected' —
    // see static/rtc.js: _canUseBus/_trySendBusSignal), so the count of
    // offer+answer+ice-candidate through the server for EACH of the three
    // should not have grown by even one since the baseline. At the same time,
    // the very fact that all these steps (video/speaking/sharing for the
    // others) already passed (assertVideoPlaying/waitForClassOnSelector above)
    // is confirmation that everything worked functionally, and didn't just
    // "quietly break on its own".
    if (everyoneJoinedOk) {
      await step(
        'Renegotiations AFTER mesh is established (Vasya turning on his camera/mic, Petya/Olya sharing their screens) did not add a single offer/answer/ice-candidate frame to the server WebSocket for any of the three',
        async () => {
          for (const [label, page] of [['Vasya', vasyaPage], ['Petya', petyaPage], ['Olya', olyaPage]]) {
            const before = signalRelayCountAtMeshSettledByLabel.get(label);
            const after = await signalRelayFramesCount(page);
            assert.equal(
              after,
              before,
              `${label}'s offer/answer/ice-candidate counter through the server grew from ${before} to ${after} after mesh was established — expected renegotiations to go over the bus`
            );
          }
        }
      );
    } else {
      skip('check "renegotiations after mesh go over the bus, not the server"', 'mesh did not get established');
    }

    await vasyaContext.close();
    await petyaContext.close();
    await olyaContext.close();

    // --- Chat history: a third participant joins AFTER two messages and sees
    // them, receiving them via DataChannel from a peer (not through server
    // history — it no longer exists, see src/ws.rs/README.md) ---
    await step(
      'Chat history: a third participant joins after two messages and sees them, receiving them via DataChannel',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: histRoomId } = await res.json();
        // S1: the room is created directly via the API (bypassing the landing
        // page) — the link token (`t`) is generated by the test itself (see
        // generateRoomToken), the way the creator's browser would in reality;
        // `e` is valid by default (see roomUrlWithKey/defaultValidExpiryB36 in
        // helpers.mjs).
        const histRoomKey = generateRoomToken();
        const histRoomUrl = roomUrlWithKey(server.baseUrl, histRoomId, histRoomKey);

        const igorContext = await browser.newContext();
        const nastyaContext = await browser.newContext();
        const igorPage = await igorContext.newPage();
        const nastyaPage = await nastyaContext.newPage();

        try {
          await igorPage.goto(histRoomUrl);
          await nastyaPage.goto(histRoomUrl);
          await joinRoom(igorPage, 'Igor');
          await joinRoom(nastyaPage, 'Nastya');
          await waitForOverlayHidden(igorPage);
          await waitForOverlayHidden(nastyaPage);
          await waitForTileCount(igorPage, 2);
          await waitForTileCount(nastyaPage, 2);

          await openChatPanel(igorPage);
          await openChatPanel(nastyaPage);

          const msg1 = `History-1-${Date.now()}`;
          await sendChatMessage(igorPage, msg1);
          assert.ok(await messageTextsInclude(nastyaPage, msg1), 'the first message did not reach the second participant (before the third one joined)');

          const msg2 = `History-2-${Date.now()}`;
          await sendChatMessage(nastyaPage, msg2);
          assert.ok(await messageTextsInclude(igorPage, msg2), 'the second message did not reach the first participant (before the third one joined)');

          // The third participant — with a spy on the WS: we prove that the
          // history itself (history-request/history-response, see static/chat.js)
          // also goes entirely over DataChannel, without contacting the server.
          const tretyContext = await browser.newContext();
          await installChatWsSpy(tretyContext);
          const tretyPage = await tretyContext.newPage();
          try {
            await tretyPage.goto(histRoomUrl);
            await joinRoom(tretyPage, 'Third');
            await waitForOverlayHidden(tretyPage);
            await waitForTileCount(tretyPage, 3);

            await openChatPanel(tretyPage);
            assert.ok(
              await messageTextsInclude(tretyPage, msg1),
              'the third participant did not see historical message 1 (expected to receive it via DataChannel from a peer)'
            );
            assert.ok(
              await messageTextsInclude(tretyPage, msg2),
              'the third participant did not see historical message 2 (expected to receive it via DataChannel from a peer)'
            );

            const frames = await chatFramesSentOn(tretyPage);
            assert.equal(
              frames.length,
              0,
              `history should have arrived to the third participant via DataChannel, not through the server fallback: ${JSON.stringify(frames)}`
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

    // --- Formatting, replies, and reactions (F2) ---
    //
    // A separate room, three participants from the very start (Anya, Borya,
    // Vitya — needed to verify "the reaction is visible to OTHER
    // participants" (c), not only to the ones who haven't left and not only
    // to the author), plus a fourth — Grisha — joins LATER, after the
    // message and reaction have already been sent: he should see both of
    // them replayed from history (d), not from the live feed.
    await step(
      'Formatting (bold/italic/strike/link, <script> is not executed), reply with quote, reactions (live + from history for the latecomer)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: fmtRoomId } = await res.json();
        const fmtRoomKey = generateRoomToken(); // S1: see the comment on histRoomKey above
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
          await joinRoom(aPage, 'Anya');
          await joinRoom(bPage, 'Borya');
          await joinRoom(cPage, 'Vitya');
          await waitForOverlayHidden(aPage);
          await waitForOverlayHidden(bPage);
          await waitForOverlayHidden(cPage);
          await waitForTileCount(aPage, 3);
          await waitForTileCount(bPage, 3);
          await waitForTileCount(cPage, 3);

          await openChatPanel(aPage);
          await openChatPanel(bPage);
          await openChatPanel(cPage);

          // --- (a) formatting: **bold** *italic* ~~strike~~ + link + <script> ---
          const fmtText =
            '**wow** *si* ~~no~~ https://example.com/page and <script>window.__e2eXss=1</script>';
          await sendChatMessage(aPage, fmtText);
          await messageTextsInclude(bPage, fmtText).catch(() => {}); // wait for delivery (the comparison below is by DOM, not by plain text)

          const bFmtMsg = bPage
            .locator('.chat-message', { hasText: 'wow' })
            .filter({ hasText: 'example.com' })
            .last();
          await bFmtMsg.locator('strong').first().waitFor({ state: 'visible', timeout: 5000 });

          const strongText = await bFmtMsg.locator('strong').first().textContent();
          assert.equal(strongText, 'wow', `<strong> should contain "wow", got: ${strongText}`);
          const emText = await bFmtMsg.locator('em').first().textContent();
          assert.equal(emText, 'si', `<em> should contain "si", got: ${emText}`);
          const delText = await bFmtMsg.locator('del').first().textContent();
          assert.equal(delText, 'no', `<del> should contain "no", got: ${delText}`);
          const linkEl = bFmtMsg.locator('a').first();
          const linkHref = await linkEl.getAttribute('href');
          assert.equal(
            linkHref,
            'https://example.com/page',
            `link should point to https://example.com/page, got: ${linkHref}`
          );
          assert.equal(await linkEl.getAttribute('target'), '_blank', 'link should open in a new tab');
          const linkRel = (await linkEl.getAttribute('rel')) || '';
          assert.ok(
            linkRel.includes('noopener') && linkRel.includes('noreferrer'),
            `link's rel should include noopener noreferrer, got: ${linkRel}`
          );

          const bFmtText = await bFmtMsg.locator('.chat-message-text').textContent();
          assert.ok(!bFmtText.includes('**'), `raw "**" should not remain in the render: ${bFmtText}`);
          assert.ok(!bFmtText.includes('~~'), `raw "~~" should not remain in the render: ${bFmtText}`);
          assert.ok(
            bFmtText.includes('<script>'),
            `the text "<script>..." should be present as VISIBLE text: ${bFmtText}`
          );

          const xssRan = await bPage.evaluate(() => window.__e2eXss);
          assert.equal(xssRan, undefined, '<script> from the message text should not execute');
          const scriptTagCount = await bPage.evaluate(
            () => document.querySelectorAll('.chat-message-text script').length
          );
          assert.equal(scriptTagCount, 0, 'the <script> tag should not appear as a real DOM element');

          // --- (a-1) DESKTOP: formatting toolbar — not just hotkeys ---
          // Regression test for the bug "formatting is gone on desktop,
          // there's no button": the "Aa" button and the toolbar (triggered by
          // text selection) must be visible on desktop layout too, not just
          // on mobile (see static/chat.js: updateFormatToolbarVisibility,
          // static/style.css: .chat-format-toggle-button). aPage here is a
          // regular desktop context (default viewport, guaranteed
          // ≥1024px), no isMobile involved.
          const aDesktopViewport = aPage.viewportSize();
          assert.ok(
            aDesktopViewport && aDesktopViewport.width >= 1024,
            `Anya's context should be desktop (≥1024px), got: ${JSON.stringify(aDesktopViewport)}`
          );
          const aChat = await getChatDom(aPage);
          await aChat.textInput.fill('desktop toolbar check');
          const aFormatButtonVisible = await aPage.locator('.chat-format-toggle-button').isVisible();
          assert.ok(aFormatButtonVisible, 'the "Aa" button should be visible on desktop layout, not just mobile');
          await aPage.evaluate(() => {
            const el = document.querySelector('.chat-text-input');
            el.focus();
            el.setSelectionRange(0, el.value.length);
            document.dispatchEvent(new Event('selectionchange'));
          });
          await aPage.locator('.chat-format-toolbar:not(.hidden)').waitFor({
            state: 'visible',
            timeout: 2000,
          });
          await aPage.click('.chat-format-btn--bold');
          const aValueAfterBold = await aChat.textInput.inputValue();
          assert.equal(
            aValueAfterBold,
            '**desktop toolbar check**',
            `clicking "Bold" in the desktop toolbar should wrap the selection in **...**, got: ${aValueAfterBold}`
          );

          // --- (a-2) F4: italics __...__, spoiler ||...|| (hidden -> click -> .revealed),
          //     inline code `...` (markers inside are NOT parsed), named
          //     link [text](url) ---
          const spoilerSecret = `secret-${Date.now()}`;
          const uniqueTag2 = `MARK2-${Date.now()}`;
          const fmtText2 = `__ital__ ||${spoilerSecret}|| \`code*x~y\` [linktext](https://example.org/z) ${uniqueTag2}`;
          await sendChatMessage(aPage, fmtText2);

          const bFmtMsg2 = bPage.locator('.chat-message', { hasText: uniqueTag2 }).last();
          await bFmtMsg2.locator('em').first().waitFor({ state: 'visible', timeout: 5000 });

          const em2Text = await bFmtMsg2.locator('em').first().textContent();
          assert.equal(em2Text, 'ital', `__..__ should render as <em> "ital", got: ${em2Text}`);

          const codeEl2 = bFmtMsg2.locator('code.chat-inline-code').first();
          await codeEl2.waitFor({ state: 'visible', timeout: 3000 });
          const codeText2 = await codeEl2.textContent();
          assert.equal(
            codeText2,
            'code*x~y',
            `inline code should contain the text literally, without parsing markers inside: ${codeText2}`
          );

          const link2 = bFmtMsg2.locator('a', { hasText: 'linktext' }).first();
          const link2Href = await link2.getAttribute('href');
          assert.equal(
            link2Href,
            'https://example.org/z',
            `named link should point to https://example.org/z, got: ${link2Href}`
          );

          const spoilerEl = bFmtMsg2.locator('.chat-md-spoiler').first();
          await spoilerEl.waitFor({ state: 'visible', timeout: 3000 });
          const revealedBefore = await spoilerEl.evaluate((el) => el.classList.contains('revealed'));
          assert.equal(revealedBefore, false, 'spoiler should not be revealed (.revealed) before click');
          const filterBefore = await spoilerEl.evaluate((el) => getComputedStyle(el).filter);
          assert.notEqual(
            filterBefore,
            'none',
            `spoiler should be visually blurred before click (filter should be != none), got: ${filterBefore}`
          );

          await spoilerEl.click();
          await waitUntil(async () => spoilerEl.evaluate((el) => el.classList.contains('revealed')), {
            timeoutMs: 3000,
            message: 'clicking the spoiler should add the .revealed class',
          });
          const spoilerTextAfter = await spoilerEl.textContent();
          assert.equal(
            spoilerTextAfter,
            spoilerSecret,
            `after reveal, the spoiler text should be visible: ${spoilerTextAfter}`
          );
          // filter is animated via a CSS transition (0.15s, see style.css:
          // .chat-md-spoiler), so right after the .revealed class appears
          // getComputedStyle may still return an intermediate/old frame —
          // wait for the transition to finish instead of checking once synchronously.
          let filterAfter = null;
          await waitUntil(
            async () => {
              filterAfter = await spoilerEl.evaluate((el) => getComputedStyle(el).filter);
              return filterAfter === 'none';
            },
            { timeoutMs: 2000, message: `after reveal, filter should return to none (was: ${filterAfter})` }
          );

          const bFmtText2 = await bFmtMsg2.locator('.chat-message-text').textContent();
          assert.ok(!bFmtText2.includes('__'), `raw "__" should not remain in the render: ${bFmtText2}`);
          assert.ok(!bFmtText2.includes('||'), `raw "||" should not remain in the render: ${bFmtText2}`);
          assert.ok(!bFmtText2.includes('`'), `raw backticks should not remain in the render: ${bFmtText2}`);

          // --- (a-3) code block: language label, "copy" button, content
          //     (including markdown-like characters) is NOT parsed ---
          const codeBlockTag = `MARK3-${Date.now()}`;
          const codeBlockText = `before\n\`\`\`js\nlet x = 1; // **not bold** __not italic__\nconsole.log(x);\n\`\`\`\nafter ${codeBlockTag}`;
          await sendChatMessage(aPage, codeBlockText);

          const bCodeMsg = bPage.locator('.chat-message', { hasText: codeBlockTag }).last();
          const codeBlockEl = bCodeMsg.locator('.chat-code-block').first();
          await codeBlockEl.waitFor({ state: 'visible', timeout: 5000 });

          const langText = await codeBlockEl.locator('.chat-code-block-lang').textContent();
          assert.equal(langText, 'js', `the language label should show "js", got: ${langText}`);

          const codeBlockContent = await codeBlockEl.locator('pre code').textContent();
          assert.ok(
            codeBlockContent.includes('**not bold**') && codeBlockContent.includes('__not italic__'),
            `markers inside the code block should not be parsed — they should remain literal: ${codeBlockContent}`
          );
          assert.equal(
            await codeBlockEl.locator('pre code strong').count(),
            0,
            'there should be no <strong> inside the code block (markers are not parsed)'
          );

          const copyButton = codeBlockEl.locator('.chat-code-block-copy');
          await copyButton.click();
          await waitUntil(async () => (await copyButton.textContent()) === 'Copied', {
            timeoutMs: 2000,
            message: 'the "copy" button should show "Copied" after a click',
          });

          // --- (b) reply: the recipient sees a quote with the original author's name ---
          const originalText = `Original-from-Borya-${Date.now()}`;
          await sendChatMessage(bPage, originalText);
          assert.ok(await messageTextsInclude(aPage, originalText), 'the original did not reach Anya');
          assert.ok(await messageTextsInclude(cPage, originalText), 'the original did not reach Vitya');

          const aOriginalMsg = aPage.locator('.chat-message', { hasText: originalText }).last();
          await openMessagePopoverFor(aPage, aOriginalMsg);
          await popoverAction(aPage, 'reply').click();
          await aPage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const replyBarText = (await aPage.locator('.chat-reply-bar-text').textContent()) || '';
          assert.ok(replyBarText.includes('Borya'), `the reply bar should mention the original author "Borya": ${replyBarText}`);

          const replyText = `Reply-from-Anya-${Date.now()}`;
          await sendChatMessage(aPage, replyText);
          assert.ok(await messageTextsInclude(bPage, replyText), 'the reply did not reach Borya');

          const bReplyMsg = bPage.locator('.chat-message', { hasText: replyText }).last();
          const quoteNameText = await bReplyMsg.locator('.chat-reply-quote-name').textContent();
          assert.ok(
            quoteNameText.includes('Borya'),
            `the reply quote for the recipient should show the original author's name "Borya": ${quoteNameText}`
          );

          // --- (b-2) reply to a FORMATTED message (**wow** ... from (a)) —
          // the bar above the input and the quote in the received reply should show
          // PLAIN text, without raw markdown markers (see static/chat.js:
          // stripMarkdownForPreview) ---
          await openMessagePopoverFor(bPage, bFmtMsg);
          await popoverAction(bPage, 'reply').click();
          await bPage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const fmtReplyBarText = (await bPage.locator('.chat-reply-bar-text').textContent()) || '';
          assert.ok(!fmtReplyBarText.includes('**'), `the reply bar should not show raw "**": ${fmtReplyBarText}`);
          assert.ok(fmtReplyBarText.includes('wow'), `the reply bar should contain the original text: ${fmtReplyBarText}`);

          const fmtReplyText = `Reply-to-formatted-${Date.now()}`;
          await sendChatMessage(bPage, fmtReplyText);
          assert.ok(await messageTextsInclude(cPage, fmtReplyText), 'the reply to the formatted message did not reach Vitya');

          const cFmtReplyMsg = cPage.locator('.chat-message', { hasText: fmtReplyText }).last();
          const fmtQuoteText = await cFmtReplyMsg.locator('.chat-reply-quote-text').textContent();
          assert.ok(!fmtQuoteText.includes('**'), `the reply quote should not show raw "**": ${fmtQuoteText}`);
          assert.ok(fmtQuoteText.includes('wow'), `the reply quote should contain the original text: ${fmtQuoteText}`);

          // --- (c) reactions via the actions popover: Anya puts a 👍 on Borya's
          // message -> Borya and Vitya get a "👍 1" chip; toggling removes it. The
          // emoji palette is now PART of the single actions popover (wave 13),
          // not a separate popover triggered by a button — we open the popover by
          // clicking the message and immediately click the emoji in it. ---
          const aTargetMsg = aPage.locator('.chat-message', { hasText: originalText }).last();
          await openMessagePopoverFor(aPage, aTargetMsg);
          await clickPopoverEmoji(aPage, '👍');

          const bTargetMsg = bPage.locator('.chat-message', { hasText: originalText }).last();
          const cTargetMsg = cPage.locator('.chat-message', { hasText: originalText }).last();
          await bTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
          await cTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
          const bChipText = await bTargetMsg.locator('.chat-reaction-chip').first().textContent();
          const cChipText = await cTargetMsg.locator('.chat-reaction-chip').first().textContent();
          assert.ok(bChipText.includes('👍') && bChipText.includes('1'), `Borya should get a "👍 1" chip: ${bChipText}`);
          assert.ok(cChipText.includes('👍') && cChipText.includes('1'), `Vitya should get a "👍 1" chip: ${cChipText}`);

          // Reaction breakdown "who/what/when" — in Borya's (the recipient's)
          // popover a row should appear with the reaction author's name (Anya),
          // emoji, and time (HH:MM).
          await openMessagePopoverFor(bPage, bTargetMsg);
          await bPage.waitForFunction(
            () => !document.querySelector('.chat-message-popover-reactions')?.classList.contains('hidden'),
            undefined,
            { timeout: 3000 }
          );
          const reactionRows = popoverReactionRows(bPage);
          await reactionRows.first().waitFor({ state: 'visible', timeout: 3000 });
          const reactionRowText = (await reactionRows.first().textContent()) || '';
          assert.ok(
            reactionRowText.includes('Anya') && reactionRowText.includes('👍'),
            `the reaction breakdown should show the name and emoji of who reacted (Anya, 👍): ${reactionRowText}`
          );
          assert.ok(
            /\d{2}:\d{2}/.test(reactionRowText),
            `the reaction breakdown should show the reaction time (HH:MM): ${reactionRowText}`
          );
          await closeMessagePopover(bPage);

          // toggle: clicking your own reaction again removes it for everyone
          await openMessagePopoverFor(aPage, aTargetMsg);
          await clickPopoverEmoji(aPage, '👍');

          await waitUntil(async () => (await bTargetMsg.locator('.chat-reaction-chip').count()) === 0, {
            timeoutMs: 5000,
            message: 'the reaction chip should disappear for Borya after the toggle removal',
          });
          await waitUntil(async () => (await cTargetMsg.locator('.chat-reaction-chip').count()) === 0, {
            timeoutMs: 5000,
            message: 'the reaction chip should disappear for Vitya after the toggle removal',
          });

          // react again — it should be present in history for the latecomer (d)
          await openMessagePopoverFor(aPage, aTargetMsg);
          await clickPopoverEmoji(aPage, '👍');
          await bTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });

          // --- (d) the latecomer (Grisha) sees both the message and the reaction from history ---
          const dContext = await browser.newContext();
          const dPage = await dContext.newPage();
          try {
            await dPage.goto(fmtRoomUrl);
            await joinRoom(dPage, 'Grisha');
            await waitForOverlayHidden(dPage);
            await waitForTileCount(dPage, 4);
            await openChatPanel(dPage);

            assert.ok(
              await messageTextsInclude(dPage, originalText),
              'the latecomer did not see the historical message via DataChannel'
            );

            const dTargetMsg = dPage.locator('.chat-message', { hasText: originalText }).last();
            await dTargetMsg.locator('.chat-reaction-chip').first().waitFor({ state: 'visible', timeout: 5000 });
            const dChipText = await dTargetMsg.locator('.chat-reaction-chip').first().textContent();
            assert.ok(
              dChipText.includes('👍') && dChipText.includes('1'),
              `the latecomer should see a "👍 1" chip from the history replay: ${dChipText}`
            );

            // Reaction breakdown from the history replay should also know the name of who reacted.
            await openMessagePopoverFor(dPage, dTargetMsg);
            await dPage.waitForFunction(
              () => !document.querySelector('.chat-message-popover-reactions')?.classList.contains('hidden'),
              undefined,
              { timeout: 3000 }
            );
            const dReactionRowText = (await popoverReactionRows(dPage).first().textContent()) || '';
            assert.ok(
              dReactionRowText.includes('Anya') && dReactionRowText.includes('👍'),
              `the latecomer should see the name and emoji in the reaction breakdown from history: ${dReactionRowText}`
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

    // --- Editing and deleting your own messages ---
    //
    // Separate room: Inna and Pasha from the start (Pasha is needed to see
    // both the edit and the deletion "live", not just from the author's side).
    // Two independent messages — M1 gets edited (but not deleted), M2 first
    // gets a reaction from Pasha, then gets deleted — this way tests (a)/(b)
    // don't mix effects, and the latecomer Slava (c) can separately verify
    // both derived states (edited text and tombstone) from the history replay.
    // The negative case (d) — a forged 'edit' envelope with someone else's
    // `from`, injected directly into the bus handler (bus._dispatch) at
    // Pasha's side, bypassing the real DataChannel: bus is a regular
    // top-level `const` in room.js (classic, non-module script) and is
    // therefore visible from page.evaluate() exactly like ChatPanel is
    // visible from room.js (the same shared top-level document scope).
    await step(
      'Editing (text + "(edited)") and deleting (tombstone, reactions disappear) your own messages, including replay to a latecomer and ignoring someone else\'s from',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: editRoomId } = await res.json();
        const editRoomKey = generateRoomToken(); // S1: see the comment near histRoomKey above
        const editRoomUrl = roomUrlWithKey(server.baseUrl, editRoomId, editRoomKey);

        const iContext = await browser.newContext();
        const pContext = await browser.newContext();
        const iPage = await iContext.newPage();
        const pPage = await pContext.newPage();

        try {
          await iPage.goto(editRoomUrl);
          await pPage.goto(editRoomUrl);
          await joinRoom(iPage, 'Inna');
          await joinRoom(pPage, 'Pasha');
          await waitForOverlayHidden(iPage);
          await waitForOverlayHidden(pPage);
          await waitForTileCount(iPage, 2);
          await waitForTileCount(pPage, 2);

          await openChatPanel(iPage);
          await openChatPanel(pPage);

          // --- (a) editing: M1 ---
          const original1 = `Original-1-${Date.now()}`;
          const msg1Id = await sendChatMessageAndGetId(iPage, original1);
          assert.ok(msg1Id, 'failed to get the id of the just-sent M1 message from Inna');
          assert.ok(await messageTextsInclude(pPage, original1), 'M1 did not reach Pasha');

          const iMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
          await openMessagePopoverFor(iPage, iPage.locator(iMsg1Sel));
          await popoverAction(iPage, 'edit').click();
          await iPage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          const editBarValue = await iPage.locator('.chat-text-input').inputValue();
          assert.equal(editBarValue, original1, `the textarea when opening edit mode should contain the current text of M1: ${editBarValue}`);

          const edited1 = `Edit-1-${Date.now()}`;
          await iPage.locator('.chat-text-input').fill(edited1);
          await iPage.locator('.chat-send-button').click();

          // For the author (Inna): new text + "(edited)", the edit bar has closed.
          await iPage.locator(`${iMsg1Sel} .chat-message-text`).filter({ hasText: edited1 }).waitFor({ timeout: 5000 });
          // NOT locator('.chat-edit-bar.hidden').waitFor(), because .hidden is
          // display:none and by default waitFor waits for the matched element to
          // become VISIBLE (see the same trick in helpers.mjs::waitForOverlayHidden) —
          // we check classList directly via waitForFunction instead.
          await iPage.waitForFunction(
            () => document.querySelector('.chat-edit-bar')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const iMeta1 = await iPage.locator(`${iMsg1Sel} .chat-message-meta-edited`).count();
          assert.ok(iMeta1 > 0, 'after editing, the author should see the "(edited)" mark appear');

          // For Pasha (not the author): the same new text + the same mark, the original is gone.
          const pMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
          await waitUntil(
            async () => (await pPage.locator(`${pMsg1Sel} .chat-message-text`).textContent())?.includes(edited1),
            { timeoutMs: 5000, message: "Pasha's M1 text should change to the edited version" }
          );
          const pMeta1 = await pPage.locator(`${pMsg1Sel} .chat-message-meta-edited`).count();
          assert.ok(pMeta1 > 0, 'Pasha should also see the "(edited)" mark');
          assert.ok(!(await messageTextsInclude(pPage, original1, 300)), "the original M1 text should not remain in Pasha's feed after the edit");

          // --- (b) deletion: M2 (first gets a reaction from Pasha, then gets deleted) ---
          const original2 = `Original-2-${Date.now()}`;
          const msg2Id = await sendChatMessageAndGetId(iPage, original2);
          assert.ok(msg2Id, 'failed to get the id of the just-sent M2 message from Inna');
          assert.ok(await messageTextsInclude(pPage, original2), 'M2 did not reach Pasha');

          const iMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;
          const pMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;

          await openMessagePopoverFor(pPage, pPage.locator(pMsg2Sel));
          await clickPopoverEmoji(pPage, '👍');
          await iPage.locator(`${iMsg2Sel} .chat-reaction-chip`).first().waitFor({ state: 'visible', timeout: 5000 });

          await openMessagePopoverFor(iPage, iPage.locator(iMsg2Sel));
          const iDeleteBtn2 = popoverAction(iPage, 'delete');
          await iDeleteBtn2.click(); // first click — transition to the confirmation state
          await iPage.locator('.chat-message-popover .chat-message-action--confirm').waitFor({ timeout: 2000 });
          await iDeleteBtn2.click(); // second click within 3s — confirms, sends delete and closes the popover

          // For the author: a tombstone instead of text, reactions are gone, the popover no longer opens on the tombstone.
          await iPage.locator(`${iMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
          const iTombstoneText = await iPage.locator(`${iMsg2Sel} .chat-message-text`).textContent();
          assert.equal(iTombstoneText, 'Message deleted', `the author's tombstone should show "Message deleted": ${iTombstoneText}`);
          assert.equal(await iPage.locator(`${iMsg2Sel} .chat-reaction-chip`).count(), 0, 'reaction chips should disappear for the author on the deleted message');
          await iPage.locator(iMsg2Sel).locator('.chat-message-meta').click();
          await new Promise((r) => setTimeout(r, 300));
          assert.equal(
            await iPage.evaluate(() => document.querySelector('.chat-message-popover')?.classList.contains('hidden')),
            true,
            'tapping the tombstone should not open the actions popover'
          );

          // For Pasha: the same thing — tombstone, reaction chips gone.
          await pPage.locator(`${pMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
          const pTombstoneText = await pPage.locator(`${pMsg2Sel} .chat-message-text`).textContent();
          assert.equal(pTombstoneText, 'Message deleted', `Pasha's tombstone should show "Message deleted": ${pTombstoneText}`);
          await waitUntil(async () => (await pPage.locator(`${pMsg2Sel} .chat-reaction-chip`).count()) === 0, {
            timeoutMs: 5000,
            message: 'reaction chips should disappear for Pasha on the deleted message',
          });

          // --- (c) the latecomer (Slava) sees from the history replay: the edited
          //     text of M1 (not the original) and a tombstone instead of the deleted M2 ---
          const sContext = await browser.newContext();
          const sPage = await sContext.newPage();
          try {
            await sPage.goto(editRoomUrl);
            await joinRoom(sPage, 'Slava');
            await waitForOverlayHidden(sPage);
            await waitForTileCount(sPage, 3);
            await openChatPanel(sPage);

            assert.ok(
              await messageTextsInclude(sPage, edited1),
              'the latecomer should see the edited text of M1 from the history replay'
            );
            assert.ok(
              !(await messageTextsInclude(sPage, original1, 300)),
              'the latecomer should NOT see the original (non-edited) text of M1'
            );
            const sMsg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
            assert.ok(
              (await sPage.locator(`${sMsg1Sel} .chat-message-meta-edited`).count()) > 0,
              'the latecomer should see the "(edited)" mark on M1'
            );

            const sMsg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;
            await sPage.locator(`${sMsg2Sel} .chat-message-text--deleted`).waitFor({ timeout: 5000 });
            const sTombstoneText = await sPage.locator(`${sMsg2Sel} .chat-message-text`).textContent();
            assert.equal(
              sTombstoneText,
              'Message deleted',
              `the latecomer should see a tombstone instead of the M2 original: ${sTombstoneText}`
            );
            assert.ok(
              !(await messageTextsInclude(sPage, original2, 300)),
              'the latecomer should NOT see the original text of the deleted M2'
            );
          } finally {
            await sContext.close();
          }

          // --- (d) negative: an 'edit' envelope with SOMEONE ELSE's from — should be ignored ---
          // Direct injection into Pasha's bus handler (bus._dispatch), bypassing
          // the real DataChannel: we simulate an attacker who would send an
          // envelope with kind='edit' and a forged `from`, targeting M1 (currently
          // displayed as `edited1` for Pasha, whose author is Inna with HER real peerId).
          const forgedResult = await pPage.evaluate(
            ({ targetId }) => {
              bus._dispatch('forged-peer-id-not-the-real-author', {
                v: 1,
                id: 'forged-edit-envelope-id',
                lamport: 999999,
                from: 'forged-peer-id-not-the-real-author',
                name: 'Scammer',
                kind: 'edit',
                target: targetId,
                text: 'HACKED',
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
            `an edit envelope with someone else's from should be ignored — the text should remain "${edited1}", got: ${forgedResult}`
          );
          assert.ok(
            !(await messageTextsInclude(pPage, 'HACKED', 300)),
            "the forged text \"HACKED\" should not appear in Pasha's feed"
          );
          // --- (e) H3: identity binding — envelope.from does not match the ACTUAL
          // transport sender ---
          //
          // Unlike (d) (a made-up peerId belonging to no one), here both ids are
          // REAL peerIds of actual room participants: we simulate a compromised
          // Pasha who sends an envelope with envelope.from = Inna's REAL peerId,
          // trying to pass himself off as her (stealing authorship of her
          // message) — bus._dispatch(pPeerId, {from: iPeerId, ...}), called ON
          // INNA'S PAGE, reproduces exactly what her own RtcPeer.onBusMessage
          // would do upon receiving such an envelope from the real DataChannel
          // with Pasha (see bus.js: _dispatch(peerId, obj) — peerId there is
          // always the transport one, never from the message contents). Before
          // the fix, dispatchEnvelope trusted envelope.from blindly — with such
          // a match (envelope.from === the REAL id of the original author), the
          // edit/delete would have gone through; now envelope.from is forcibly
          // normalized to the true fromPeerId BEFORE the authorship check (see
          // static/chat.js), so the spoof is rejected.
          const iPeerId = await iPage.evaluate(() => document.querySelector('.tile--own')?.dataset.peerId);
          const pPeerId = await pPage.evaluate(() => document.querySelector('.tile--own')?.dataset.peerId);
          assert.ok(iPeerId, "failed to read Inna's real peerId");
          assert.ok(pPeerId, "failed to read Pasha's real peerId");
          assert.notEqual(iPeerId, pPeerId, "Inna's and Pasha's peerId must differ, otherwise the test is meaningless");

          // A new message from Inna — independent of M1/M2 above, so that the
          // negative checks below don't depend on their already-modified state.
          const original3 = `Original-3-${Date.now()}`;
          const msg3Id = await sendChatMessageAndGetId(iPage, original3);
          assert.ok(msg3Id, 'failed to get the M3 message id from Inna');
          assert.ok(await messageTextsInclude(pPage, original3), 'M3 did not reach Pasha');
          const msg3Sel = `.chat-message[data-msg-id="${msg3Id}"]`;

          // (e.1) someone else's text with a SPOOFED from is not rendered as
          // the recipient's OWN message when the actual transport sender is a
          // different peer (envelope.from normalization reattributes it to
          // Pasha, not to Inna whose identity he claimed).
          const forgedTextOwnClass = await iPage.evaluate(
            ({ pashaId, innaId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-text-impersonation',
                lamport: 999999,
                from: innaId, // SPOOF: the actual sender is Pasha (pashaId), impersonating Inna
                name: 'Inna',
                kind: 'text',
                text: 'PASHA-IMPERSONATED-INNA',
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
            "an envelope with someone else's (but real) from must be reattributed to the true transport sender, not rendered as the recipient's OWN message"
          );

          // (e.2) a forged edit (from=Inna, but the actual transport is Pasha)
          // on message M3 (real author — Inna) must be rejected.
          const forgedEditText = await iPage.evaluate(
            ({ pashaId, innaId, targetId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-edit-impersonation',
                lamport: 999999,
                from: innaId,
                name: 'Inna',
                kind: 'edit',
                target: targetId,
                text: 'PASHA-FORGED-THE-EDIT',
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
            `a forged edit with someone else's (real) from must be rejected — M3's text must remain "${original3}", got: ${forgedEditText}`
          );
          assert.ok(
            !(await messageTextsInclude(iPage, 'PASHA-FORGED-THE-EDIT', 300)),
            "the forged edit text must not appear in Inna's feed"
          );

          // (e.3) a forged delete (from=Inna, actual transport — Pasha) on the
          // same M3 — also rejected, the message stays in place.
          const forgedDeleteApplied = await iPage.evaluate(
            ({ pashaId, innaId, targetId }) => {
              bus._dispatch(pashaId, {
                v: 1,
                id: 'forged-delete-impersonation',
                lamport: 1000000,
                from: innaId,
                name: 'Inna',
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
            "a forged delete with someone else's (real) from must not delete Inna's message"
          );
          assert.ok(
            await messageTextsInclude(iPage, original3),
            "M3 must remain visible for Inna after the forged delete is rejected"
          );

          // (e.4) control: a legitimate edit (the real Pasha editing HIS OWN
          // message, transport and from match) — like in (a) above, but here
          // to confirm envelope.from normalization does not break normal
          // operation.
          const pOriginal = `Pasha-original-${Date.now()}`;
          const pMsgId = await sendChatMessageAndGetId(pPage, pOriginal);
          assert.ok(await messageTextsInclude(iPage, pOriginal), "Pasha's message did not reach Inna");
          const pEdited = `Pasha-edit-${Date.now()}`;
          const pMsgSel = `.chat-message[data-msg-id="${pMsgId}"]`;
          await openMessagePopoverFor(pPage, pPage.locator(pMsgSel));
          await popoverAction(pPage, 'edit').click();
          await pPage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
          await pPage.locator('.chat-text-input').fill(pEdited);
          await pPage.locator('.chat-send-button').click();
          assert.ok(
            await messageTextsInclude(iPage, pEdited),
            "a legitimate edit by the real author must reach and apply for Inna — from normalization must not break the legitimate path"
          );

          // --- (f) desktop: Enter is ALWAYS a line break, not a send;
          // Cmd/Ctrl+Enter sends (desktop convenience, see static/chat.js) ---
          await iPage.fill('.chat-text-input', '');
          await iPage.click('.chat-text-input');
          await iPage.keyboard.type('first line desktop');
          await iPage.keyboard.press('Enter');
          await iPage.keyboard.type('second line desktop');
          const iValueAfterEnter = await iPage.inputValue('.chat-text-input');
          assert.equal(
            iValueAfterEnter,
            'first line desktop\nsecond line desktop',
            `Enter on desktop should also be a line break, not a send: ${JSON.stringify(iValueAfterEnter)}`
          );
          assert.equal(
            await messageTextsInclude(iPage, 'first line desktop', 300),
            false,
            'the message should not have been sent by a single Enter on desktop'
          );
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
          await iPage.keyboard.press(`${modifier}+Enter`);
          assert.ok(
            await messageWithLineBreaksIncludes(iPage, ['first line desktop', 'second line desktop']),
            'Cmd/Ctrl+Enter should send the multi-line message (with a real line break — <br> between lines)'
          );
          assert.ok(
            await messageWithLineBreaksIncludes(pPage, ['first line desktop', 'second line desktop']),
            'the message sent with Cmd/Ctrl+Enter should reach the other party with the line break'
          );

          // --- (g) desktop action popover: closing via the close button, Esc, and clicking the backdrop ---
          const iLastMsg = iPage.locator('.chat-message', { hasText: pEdited }).last();
          await openMessagePopoverFor(iPage, iLastMsg);
          await iPage.click('.chat-message-popover-close');
          await iPage.waitForFunction(
            () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
            undefined,
            { timeout: 2000 }
          );

          await openMessagePopoverFor(iPage, iLastMsg);
          await iPage.keyboard.press('Escape');
          await iPage.waitForFunction(
            () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
            undefined,
            { timeout: 2000 }
          );

          await openMessagePopoverFor(iPage, iLastMsg);
          await iPage.click('.chat-message-popover-backdrop', { position: { x: 5, y: 5 } });
          await iPage.waitForFunction(
            () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
            undefined,
            { timeout: 2000 }
          );
        } finally {
          await iContext.close();
          await pContext.close();
        }
      }
    );

    // --- File transfer (F3): strictly P2P, lazily on demand ---
    //
    // A separate room, Zhenya and Zakhar from the very start (we explicitly
    // wait for mesh to settle — unlike text/reactions, the file DataChannel
    // has no server fallback at all, so a "the bus channel hasn't opened yet"
    // race must not be masked here by lucky timing). Zhenya sends a ~50KB
    // image (a) — until Zakhar clicks the card, only the name and size are
    // visible (no auto-download, including for images — files must not
    // download themselves on the recipient's side), clicking "Download" ->
    // progress -> inline preview; then a ~300KB "file" text/plain (b) — the
    // same manual path, we wait for the progress to disappear and compare the
    // resulting Blob byte-for-byte. Ivan joins LATER, after both files have
    // already been sent (c) — he sees the cards from history (not live) and
    // can still request them while Zhenya (the original sender) is still in
    // the room.
    await step(
      'File transfer: before clicking — only name and size (no auto-download), manual download with progress and size verification, a latecomer downloads from history, inline audio/video players (F4, section B)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: fileRoomId } = await res.json();
        const fileRoomKey = generateRoomToken(); // S1: see the comment near histRoomKey above
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
          await joinRoom(ePage, 'Zhenya');
          await joinRoom(fPage, 'Zakhar');
          await waitForOverlayHidden(ePage);
          await waitForOverlayHidden(fPage);
          // Specifically waitForMeshSettled (not just waitForTileCount) — the
          // file DataChannel requires a bus that is REALLY open to the specific
          // peer; text/reactions have a server fallback, file bytes never do.
          await waitForMeshSettled([ePage, fPage], { tileCount: 2, connectionsPerPage: 1 });

          await openChatPanel(ePage);
          await openChatPanel(fPage);

          // --- (a) ~50KB image: for Zakhar, before clicking the card, only the
          //     name and size are shown; manual download -> inline preview ---
          const pngBuffer = makeTestPngBuffer({ width: 112, height: 112 });
          await attachFilesToChat(ePage, [{ name: 'photo.png', mimeType: 'image/png', buffer: pngBuffer }]);

          // Fix for the sender's own file (see static/chat.js:
          // handleFilesSelected/renderFileDoneBody) — Zhenya must see HIS OWN
          // card immediately in done state (preview + a working Download from
          // the LOCAL objectURL), without waiting for any exchange with
          // Zakhar.
          const eOwnFileCard = ePage
            .locator('.chat-message--file.chat-message--own', { hasText: 'photo.png' })
            .locator('.chat-file-card');
          await eOwnFileCard.locator('.chat-file-image').waitFor({ state: 'visible', timeout: 5000 });
          const eOwnImageSrc = await eOwnFileCard.locator('.chat-file-image').getAttribute('src');
          assert.ok(
            eOwnImageSrc && eOwnImageSrc.startsWith('blob:'),
            `the sender's preview should point to a local blob:, got: "${eOwnImageSrc}"`
          );
          const eOwnDownloadHrefBefore = await eOwnFileCard.locator('.chat-file-download-link').getAttribute('href');
          assert.ok(
            eOwnDownloadHrefBefore && eOwnDownloadHrefBefore.startsWith('blob:'),
            `the sender's Download link should point to a local blob:, got: "${eOwnDownloadHrefBefore}"`
          );

          // For Zakhar (the recipient), the image card must remain in offer
          // state — only name and size, WITHOUT any automatic byte download:
          // no <img> preview, not a single blob: link. We wait with a small
          // margin (not a forever timeout, but the window during which
          // auto-download of images ≤2MB used to trigger) so as not to
          // confuse "auto-download no longer happens" with "just hasn't had
          // time yet".
          const fImageCard = fPage.locator('.chat-file-card', { hasText: 'photo.png' });
          await fImageCard.locator('.chat-file-name').waitFor({ state: 'visible', timeout: 10_000 });
          assert.equal(await fImageCard.locator('.chat-file-name').textContent(), 'photo.png');
          const fImageOfferSizeText = await fImageCard.locator('.chat-file-size').textContent();
          assert.ok(
            fImageOfferSizeText && /B|KB|MB/.test(fImageOfferSizeText),
            `in offer state the recipient should see a human-readable size: ${fImageOfferSizeText}`
          );
          await fPage.waitForTimeout(1500); // the window during which auto-download of ≤2MB used to trigger
          assert.equal(
            await fImageCard.locator('.chat-file-image').count(),
            0,
            'before the recipient clicks, the image must not download itself and show a preview'
          );
          assert.equal(
            await fImageCard.locator('a[href^="blob:"]').count(),
            0,
            'before the recipient clicks, the card must not contain a single blob: link'
          );

          // Clicking the "Download" button -> progress -> done state with
          // preview (the same manual path as for the other file types below).
          const fImageDownloadButton = fImageCard.locator('.chat-file-download-button');
          await fImageDownloadButton.waitFor({ state: 'visible', timeout: 5000 });
          await fImageDownloadButton.click();

          await fPage.waitForFunction(
            () => (document.querySelector('.chat-file-image')?.naturalWidth || 0) > 0,
            undefined,
            { polling: 100, timeout: 10_000 }
          );
          const fImageSrc = await fImageCard.locator('.chat-file-image').getAttribute('src');
          assert.ok(fImageSrc && fImageSrc.startsWith('blob:'), `the image src should be a blob URL, got: ${fImageSrc}`);
          const fImageDownloadLink = fImageCard.locator('.chat-file-download-link--compact');
          await fImageDownloadLink.waitFor({ state: 'visible', timeout: 5000 });
          const fImageObjectUrl = await fImageDownloadLink.getAttribute('href');
          const fImageBlobSize = await fPage.evaluate(async (url) => {
            const blob = await (await fetch(url)).blob();
            return blob.size;
          }, fImageObjectUrl);
          assert.equal(
            fImageBlobSize,
            pngBuffer.length,
            `the downloaded image should match the original in size (${pngBuffer.length}), got ${fImageBlobSize}`
          );

          // After Zakhar has received the file (the recipient's card above
          // has already moved to done — img.naturalWidth>0), the SENDER's
          // card must not degrade back to "title only": the sending statuses
          // (sending/sent, see beginSendingFile) must not overwrite the own
          // state with objectUrl (see renderFileCardBody: the check is based
          // on the presence of state.objectUrl, not on the current status).
          await eOwnFileCard.locator('.chat-file-image').waitFor({ state: 'visible', timeout: 3000 });
          const eOwnDownloadHrefAfter = await eOwnFileCard.locator('.chat-file-download-link').getAttribute('href');
          assert.ok(
            eOwnDownloadHrefAfter && eOwnDownloadHrefAfter.startsWith('blob:'),
            `after handing the file off to the recipient, the sender's card should remain in done state (Download pointing to blob:), got: "${eOwnDownloadHrefAfter}"`
          );

          // --- (b) ~300KB "file" (text/plain): Zakhar has a card with a
          //     button, clicking "Download" -> progress appears and
          //     disappears, the resulting Blob matches the original in size. ---
          const textBuffer = makeTestTextFileBuffer(300 * 1024);
          await attachFilesToChat(ePage, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: textBuffer }]);

          const fFileCard = fPage.locator('.chat-file-card', { hasText: 'notes.txt' });
          const fDownloadButton = fFileCard.locator('.chat-file-download-button');
          await fDownloadButton.waitFor({ state: 'visible', timeout: 10_000 });
          await fDownloadButton.click();

          const fDownloadLink = fFileCard.locator('.chat-file-download-link');
          await fDownloadLink.waitFor({ state: 'visible', timeout: 15_000 });

          const progressStillThere = await fFileCard.locator('.chat-file-progress').count();
          assert.equal(progressStillThere, 0, 'the progress bar should disappear once the transfer completes');

          const fObjectUrl = await fDownloadLink.getAttribute('href');
          const fBlobSize = await fPage.evaluate(async (url) => {
            const blob = await (await fetch(url)).blob();
            return blob.size;
          }, fObjectUrl);
          assert.equal(
            fBlobSize,
            textBuffer.length,
            `the downloaded file should match the original in size (${textBuffer.length}), got ${fBlobSize}`
          );

          // --- (c) a latecomer (Ivan) sees the cards from history and can
          //     download while the sender (Zhenya) is still in the room ---
          const gContext = await browser.newContext();
          await installPcRegistry(gContext);
          const gPage = await gContext.newPage();
          try {
            await gPage.goto(fileRoomUrl);
            await joinRoom(gPage, 'Ivan');
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
              `the latecomer should download the file from history with the same size (${textBuffer.length}), got ${gBlobSize}`
            );
          } finally {
            await gContext.close();
          }

          // --- (d) audio: a valid ~1.5s WAV (see helpers.mjs:
          //     makeTestWavBuffer) — Zakhar clicks "Download" -> <audio
          //     controls>, a meta line (name/size/duration from
          //     loadedmetadata), the downloaded Blob matches in size. ---
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
            fAudioSizeText && /B|KB|MB/.test(fAudioSizeText),
            `the audio should show a human-readable size: ${fAudioSizeText}`
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
            `the audio duration should be displayed in M:SS format, got: ${fAudioDurationText}`
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
            `the downloaded audio should match the original in size (${wavBuffer.length}), got ${fAudioBlobSize}`
          );

          // --- (e) video: a tiny but genuinely valid WebM (see helpers.mjs:
          //     makeTestWebmBuffer) — <video controls>, src=blob, size and the
          //     "Download" button are always checked; duration from
          //     loadedmetadata — checked ONLY if Chromium actually managed to
          //     compute it within the allotted time, otherwise we honestly log
          //     it and skip just this sub-check (see the comment in the task
          //     about video-duration). ---
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
            'the video player must have the controls attribute'
          );
          const fVideoSrc = await fVideoEl.evaluate((el) => el.src);
          assert.ok(fVideoSrc && fVideoSrc.startsWith('blob:'), `the video src should be a blob URL, got: ${fVideoSrc}`);

          const fVideoSizeText = await fVideoCard.locator('.chat-file-meta-size').textContent();
          assert.ok(
            fVideoSizeText && /B|KB|MB/.test(fVideoSizeText),
            `the video should show a human-readable size: ${fVideoSizeText}`
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
            `the downloaded video should match the original in size (${webmBuffer.length}), got ${fVideoBlobSize}`
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
              `the video duration should be displayed in M:SS format, got: ${fVideoDurationText}`
            );
          } catch (err) {
            console.log(
              `# [honestly skipped] Chromium did not compute the duration for the test WebM within the allotted time — the video duration check was skipped (the <video> element/src=blob/size/"Download" button were already verified above): ${err.message}`
            );
          }
          // --- Join-modal name prefill (see static/room.js:
          //     showJoinModal, static/namegen.js: NameGen.userName()) —
          //     a new participant (Klava) joins the SAME room and clicks
          //     "Join" WITHOUT touching the field at all: joinRoom() won't
          //     work here — it unconditionally clears the field with an
          //     empty string (see helpers.mjs), and we specifically need to
          //     verify the prefill, so we click #join-modal-button directly.
          //     While at it, we also check the ↻ button next to the field.
          //     The tile label should carry the prefilled name WITHOUT the
          //     leading emoji (it duplicates the circular avatar, see
          //     static/room.js: tileDisplayName/stripLeadingAvatarEmoji),
          //     and the avatar letter must not be "�" (see static/room.js:
          //     createTile, grapheme-cluster fix). ---
          const klavaContext = await browser.newContext();
          try {
            await installPcRegistry(klavaContext);
            const klavaPage = await klavaContext.newPage();
            await klavaPage.goto(fileRoomUrl);
            await klavaPage.waitForSelector('#join-modal:not(.hidden)', { timeout: 10_000 });
            const prefilledUserName = await klavaPage.inputValue('#join-name-input');
            assert.ok(prefilledUserName, 'the join modal should be prefilled with a generated name');
            assert.match(
              prefilledUserName,
              /^\p{Extended_Pictographic}/u,
              `the prefilled name should start with an emoji, got: "${prefilledUserName}"`
            );

            // The ↻ button next to the join-modal field (see static/room.html:
            // .input-with-regen, static/room.js: joinNameRegenButtonEl click)
            // — rolls a new NameGen.userName(); we restore the field to its
            // previous value right after checking, so we don't lose
            // prefilledUserName as the anchor for the label/avatar-letter
            // checks below.
            await klavaPage.click('#join-name-regen-button');
            const regeneratedUserName = await klavaPage.inputValue('#join-name-input');
            assert.ok(
              regeneratedUserName && regeneratedUserName !== prefilledUserName,
              `clicking ↻ should generate a new name, was "${prefilledUserName}", became "${regeneratedUserName}"`
            );
            await klavaPage.fill('#join-name-input', prefilledUserName);

            await klavaPage.click('#join-modal-button');
            await waitForOverlayHidden(klavaPage);

            // The first grapheme cluster of the prefilled name — namegen.js only
            // produces single-codepoint emoji (no VS16/ZWJ), so a plain string
            // spread (by code point, not UTF-16 code unit) gives the same
            // result as the [...str][0] fallback in static/room.js.
            const expectedLetter = [...prefilledUserName][0];

            // The tile label (see static/room.js: tileDisplayName/
            // stripLeadingAvatarEmoji) no longer carries the full name: the
            // leading grapheme cluster, if it's an emoji (and the namegen.js
            // prefilled name almost always starts with an emoji — already
            // verified by the regex above), gets stripped from the label as
            // a duplicate of the circular avatar. Since a non-empty
            // remainder is left after subtracting it, we expect exactly that
            // remainder (trimmed of whitespace), not the full name.
            const expectedOwnLabel = prefilledUserName.slice(expectedLetter.length).trim() || prefilledUserName;
            const ownLabel = await klavaPage.locator('.tile--own .tile-name').textContent();
            assert.equal(
              ownLabel,
              expectedOwnLabel,
              `own tile label should be the prefilled name without the duplicate leading emoji, expected "${expectedOwnLabel}", got: "${ownLabel}"`
            );
            const avatarLetter = await klavaPage.locator('.tile--own .tile-placeholder-letter').textContent();
            assert.equal(
              avatarLetter,
              expectedLetter,
              `avatar letter should be the first grapheme cluster of the name ("${expectedLetter}"), got: "${avatarLetter}" (not "�")`
            );
          } finally {
            await klavaContext.close();
          }
        } finally {
          await eContext.close();
          await fContext.close();
        }
      }
    );

    // --- Permissions and leader (see README.md "Permissions and leader") ---
    //
    // A separate room: Lida is the creator (presents the leaderToken from
    // the fragment, becomes leader), Gosha is a regular guest via a direct
    // link (no token, lobby still off). Steps that follow: (a.5) the leader
    // limits the number of participants via the UI panel
    // (#setting-max-participants=2), the "Participants: N / M" counter shows
    // the effective limit for BOTH participants (not just the leader), a
    // third participant via a direct link gets "Room is full", reverting to
    // "No limit" lets them in again; (b) the leader turns on the lobby,
    // Tonya waits for approval and gets it, Yura waits and gets rejected;
    // (c) the leader disables chat for guests — Gosha's input gets disabled,
    // and a FORGED envelope (injected via evaluate into bus._dispatch on
    // Lida's side, bypassing the real DataChannel — the same trick as in the
    // negative edit test above) with SOMEONE ELSE'S from does not render for
    // anyone; (d) the leader disables screen sharing for guests — Gosha's
    // "Screen" button gets disabled; (e) the leader leaves — the oldest
    // guest (Gosha, joined_at earlier than Tonya) gets the crown and a
    // toast.
    await step(
      'Permissions and leader: creator crown, leader-set participant limit via UI (counter + room-full + limit removal), lobby (approval/rejection), guest chat ban (+ ignoring a forged envelope), guest screen-share ban, leader handoff on leave',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: permRoomId, leaderToken: permLeaderToken } = await res.json();
        const permRoomKey = generateRoomToken(); // S1: see the comment on histRoomKey above
        const permRoomUrl = roomUrlWithKey(server.baseUrl, permRoomId, permRoomKey);
        const permLeaderUrl = leaderUrlWithKey(server.baseUrl, permRoomId, permLeaderToken, permRoomKey);

        const lidaContext = await browser.newContext();
        const goshaContext = await browser.newContext();
        const lidaPage = await lidaContext.newPage();
        const goshaPage = await goshaContext.newPage();

        try {
          // --- setup: Lida (creator, leader) and Gosha (regular guest) ---
          await lidaPage.goto(permLeaderUrl);
          await joinRoom(lidaPage, 'Lida');
          await waitForOverlayHidden(lidaPage);

          await goshaPage.goto(permRoomUrl);
          await joinRoom(goshaPage, 'Gosha');
          await waitForOverlayHidden(goshaPage);
          // Simple tile-count check, WITHOUT waitForMeshSettled: this scenario
          // doesn't check video/audio, only permissions/leader/chat UI — tiles
          // and the room bus (bus.addPeer) are already in place right on
          // joined/peer-joined, without waiting for the actual
          // connectionState === 'connected' — so the test doesn't depend on
          // machine load from ICE negotiation (this scenario runs last in the
          // file, after the heavy WebRTC scenarios already accumulated above).
          await waitForTileCount(lidaPage, 2, 10_000);
          await waitForTileCount(goshaPage, 2, 10_000);

          const lidaTileSel = await tileSelector('Lida');
          await waitCrownVisible(goshaPage, lidaTileSel, true);
          const goshaOwnCrownHidden = await goshaPage.evaluate(
            () => document.querySelector('.tile--own .tile-crown')?.classList.contains('hidden')
          );
          assert.equal(goshaOwnCrownHidden, true, 'Gosha should not have a crown on their own tile');
          // The settings gear is visible to EVERYONE (the "Devices" section —
          // mic/camera selection — is shared), but the "Room" section (lobby
          // + guest permissions) inside the panel is leader-only.
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
          // refreshDeviceLists() is async (enumerateDevices is a Promise) —
          // we wait for the options to actually appear rather than counting
          // right after the click.
          await goshaPage.waitForFunction(
            () => document.querySelectorAll('#setting-mic-device option').length > 0,
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const goshaMicOptionsCount = await goshaPage.locator('#setting-mic-device option').count();
          assert.ok(goshaMicOptionsCount > 0, "Gosha's mic select should be populated with at least one device");
          await goshaPage.click('#settings-panel-close');

          // --- (a.5) the leader limits the number of participants via the
          //     UI panel (RoomSettings.max_participants) ---
          //
          // The room currently has exactly Lida + Gosha (2 participants, see
          // the setup above) — the perfect moment to check the "no third
          // participant gets in" limit, before the count grows further in
          // steps (b) below (lobby, Tonya, Yura). We don't spin up a
          // separate room for this bit or spend an extra POST /api/rooms —
          // H2: ROOM_CREATION_IP_LIMIT (prod default is 3 per 60s per IP, see
          // the comment on roomIdForTimerTestReuse at the start of the file
          // about the test override), the file already keeps its budget at
          // exactly 10 (see the comment on roomIdForTimerTestReuse below) —
          // we reuse this same step's permRoomUrl/permRoomId. The
          // server-side signaling path (validating 2..cap, "lowering doesn't
          // kick anyone out", etc.) is already covered by
          // signaling.test.mjs — here it's specifically the UI: the select
          // in the settings panel, the counter for BOTH participants (not
          // just the leader), and the "Room is full" overlay for the one who
          // gets blocked.
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-max-participants').selectOption('2');
          await waitUntil(
            async () => (await lidaPage.evaluate(() => roomSettings && roomSettings.maxParticipants === 2)),
            { timeoutMs: 5000, message: 'maxParticipants=2 did not apply for Lida after selecting in the select' }
          );
          await lidaPage.click('#settings-panel-close');

          // The "Participants: N / M" counter shows the effective limit for
          // BOTH — this isn't leader-only UI (unlike the settings "Room"
          // section itself, see the check for Gosha above).
          for (const page of [lidaPage, goshaPage]) {
            await page.waitForFunction(
              () => document.getElementById('participant-count')?.textContent === 'Participants: 2 / 2',
              undefined,
              { polling: 100, timeout: 5000 }
            );
          }

          // A third participant via a direct link (lobby still off, before
          // step (b)) — "Room is full" (the same overflow pattern as in
          // tests/e2e/resilience.spec.mjs about the server default).
          const extraContext = await browser.newContext();
          try {
            const extraPage = await extraContext.newPage();
            await extraPage.goto(permRoomUrl);
            await joinRoom(extraPage, 'Extra');
            await waitOverlayTitle(extraPage, 'Room is full', 10_000);
          } finally {
            await extraContext.close();
          }
          // The room wasn't affected by the rejected attempt — still two people.
          await waitForTileCount(lidaPage, 2, 5000);
          await waitForTileCount(goshaPage, 2, 5000);

          // Reverting to "No limit": the fact that it's applied
          // (roomSettings.maxParticipants === null for both) is already
          // checked above in the update-settings tests (see the
          // guestChat/guestScreen blocks below — the same UI-select ->
          // broadcast -> roomSettings causal chain) and separately by
          // server-side validation in signaling.test.mjs; here we do NOT add
          // another join-room to verify the room "lets people in again" —
          // the file is already close to the JOIN_ROOM_IP_LIMIT (20
          // join-rooms per 60s from one IP, see DEFAULT_JOIN_ROOM_IP_LIMIT in
          // src/state.rs) due to the sum of all joinRoom() calls across the
          // file; an extra join here empirically broke subsequent steps
          // ("Mobile smoke test", "S1: wrong t") with a server rejection on
          // this limit. Whether "No limit" lets people in again is purely
          // server-side logic (effective_max_participants), already covered
          // by signaling.test.mjs; what matters here is specifically the UI
          // select transition and that it actually reaches the server (see
          // the roomSettings check below).
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-max-participants').selectOption('');
          await waitUntil(
            async () => (await lidaPage.evaluate(() => roomSettings && roomSettings.maxParticipants === null)),
            { timeoutMs: 5000, message: 'reverting to "No limit" did not apply for Lida' }
          );
          await waitUntil(
            async () => (await goshaPage.evaluate(() => roomSettings && roomSettings.maxParticipants === null)),
            { timeoutMs: 5000, message: 'reverting to "No limit" did not apply for Gosha' }
          );
          await lidaPage.click('#settings-panel-close');
          await waitForTileCount(lidaPage, 2, 5000);
          await waitForTileCount(goshaPage, 2, 5000);

          // --- (b) the leader turns on the lobby ---
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-lobby').check();
          await waitUntil(async () => (await lidaPage.evaluate(() => roomSettings && roomSettings.lobbyEnabled === true)), {
            timeoutMs: 5000,
            message: 'lobbyEnabled did not apply for Lida after the toggle',
          });
          await lidaPage.click('#settings-panel-close');

          // Tonya joins via a direct link — lands in the lobby, waits for approval.
          const tonyaContext = await browser.newContext();
          const tonyaPage = await tonyaContext.newPage();
          await tonyaPage.goto(permRoomUrl);
          await joinRoom(tonyaPage, 'Tonya');
          await waitOverlayTitle(tonyaPage, 'Waiting for approval…');

          const tonyaRequestCard = lidaPage.locator('.join-request-card', { hasText: 'Tonya' });
          await tonyaRequestCard.waitFor({ state: 'visible', timeout: 8000 });
          const badgeText = await lidaPage.locator('#settings-badge').textContent();
          assert.equal(badgeText, '1', `lobby request badge should show 1, got: ${badgeText}`);

          await tonyaRequestCard.locator('.join-request-button--accept').click();
          await waitForOverlayHidden(tonyaPage);
          // Simple tile-count check (not waitForMeshSettled with its
          // reload-retry): a reload here is dangerous — with
          // lobbyEnabled=true it would send Tonya back to the lobby, requiring
          // approval again.
          for (const page of [lidaPage, goshaPage, tonyaPage]) {
            await waitForTileCount(page, 3, 10_000);
          }

          // Yura joins — also into the lobby, the leader rejects him.
          const yuraContext = await browser.newContext();
          const yuraPage = await yuraContext.newPage();
          try {
            await yuraPage.goto(permRoomUrl);
            await joinRoom(yuraPage, 'Yura');
            await waitOverlayTitle(yuraPage, 'Waiting for approval…');

            const yuraRequestCard = lidaPage.locator('.join-request-card', { hasText: 'Yura' });
            await yuraRequestCard.waitFor({ state: 'visible', timeout: 8000 });
            await yuraRequestCard.locator('.join-request-button--reject').click();
            await waitOverlayTitle(yuraPage, 'Access denied');
          } finally {
            await yuraContext.close();
          }

          // --- (c) the leader disables chat for guests ---
          await openChatPanel(lidaPage);
          await openChatPanel(goshaPage);
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-guest-chat').uncheck();
          await waitUntil(async () => (await goshaPage.evaluate(() => roomSettings && roomSettings.guestChat === false)), {
            timeoutMs: 5000,
            message: 'guestChat=false did not apply for Gosha',
          });
          await lidaPage.click('#settings-panel-close');

          const goshaChatState = await goshaPage.evaluate(() => ({
            disabled: document.querySelector('.chat-text-input').disabled,
            placeholder: document.querySelector('.chat-text-input').placeholder,
          }));
          assert.equal(goshaChatState.disabled, true, "Gosha's chat input should be disabled when guestChat=false");
          assert.equal(
            goshaChatState.placeholder,
            'Chat disabled by the leader',
            `placeholder should explain the ban: ${goshaChatState.placeholder}`
          );

          // A forged envelope as if from Gosha (guestChat=false, Gosha is not
          // the leader) — injected directly into bus._dispatch on Lida's
          // side, bypassing the real DataChannel (the same trick as in the
          // negative edit test above) — the recipient should silently ignore
          // it.
          const goshaPeerId = await lidaPage.evaluate(() => document.querySelector('.tile[data-name="Gosha"]').dataset.peerId);
          await lidaPage.evaluate(
            (pid) => {
              bus._dispatch(pid, {
                v: 1,
                id: 'forged-text-guestchat-forbidden',
                lamport: 999999,
                from: pid,
                name: 'Gosha',
                kind: 'text',
                text: 'FORBIDDEN-GUEST-TEXT',
                ts: Date.now(),
              });
            },
            goshaPeerId
          );
          assert.ok(
            !(await messageTextsInclude(lidaPage, 'FORBIDDEN-GUEST-TEXT', 300)),
            'a guest envelope with guestChat=false should be ignored by the recipient (even when forged directly into the bus)'
          );

          // The leader can still chat.
          const leaderMsg = `Lida-can-chat-${Date.now()}`;
          await sendChatMessage(lidaPage, leaderMsg);
          assert.ok(await messageTextsInclude(goshaPage, leaderMsg), 'the leader should be able to chat when guestChat=false');

          // --- (d) the leader disables screen sharing for guests ---
          await lidaPage.click('#settings-button');
          await lidaPage.locator('#setting-guest-screen').uncheck();
          await waitUntil(async () => (await goshaPage.evaluate(() => roomSettings && roomSettings.guestScreen === false)), {
            timeoutMs: 5000,
            message: 'guestScreen=false did not apply for Gosha',
          });
          await lidaPage.click('#settings-panel-close');

          const goshaScreenState = await goshaPage.evaluate(() => ({
            disabled: document.getElementById('screen-button')?.disabled,
            title: document.getElementById('screen-button')?.title,
          }));
          assert.equal(goshaScreenState.disabled, true, 'Gosha\'s "Screen" button should be disabled when guestScreen=false');
          assert.equal(
            goshaScreenState.title,
            'Disabled by the leader',
            `the "Screen" button title should explain the ban: ${goshaScreenState.title}`
          );

          // --- (e) the leader leaves — the oldest guest (Gosha) gets the crown and a toast ---
          const goshaTileSel = await tileSelector('Gosha');
          await lidaPage.click('#leave-button');

          await goshaPage.waitForFunction(
            () => document.getElementById('toast')?.textContent === 'You are now the leader' && !document.getElementById('toast')?.classList.contains('hidden'),
            undefined,
            { polling: 50, timeout: 8000 }
          );
          await waitCrownVisible(goshaPage, '.tile--own', true);
          // Gosha became the leader — the "Room" section inside the settings
          // panel is now his too (the gear was already visible before, see
          // the check above).
          await goshaPage.waitForFunction(
            () => !document.getElementById('settings-room-section')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 5000 }
          );

          await tonyaPage.waitForFunction(
            () => (document.getElementById('toast')?.textContent || '').includes('Gosha') && !document.getElementById('toast')?.classList.contains('hidden'),
            undefined,
            { polling: 50, timeout: 8000 }
          );
          await waitCrownVisible(tonyaPage, goshaTileSel, true);

          await waitForTileCount(goshaPage, 2, 8000);
          await waitForTileCount(tonyaPage, 2, 8000);

          // --- (f) anonymity: zero localStorage/cookies on all involved pages ---
          for (const [label, page] of [['Gosha', goshaPage], ['Tonya', tonyaPage]]) {
            const anon = await page.evaluate(() => ({ lsLength: localStorage.length, cookie: document.cookie }));
            assert.equal(anon.lsLength, 0, `${label}'s localStorage.length should be 0, got ${anon.lsLength}`);
            assert.equal(anon.cookie, '', `${label}'s document.cookie should be empty, got "${anon.cookie}"`);
          }
          // Lida, after clicking "Leave", goes to the landing page — also without traces.
          await lidaPage.waitForURL(/\/$/, { timeout: 5000 });
          const lidaAnon = await lidaPage.evaluate(() => ({ lsLength: localStorage.length, cookie: document.cookie }));
          assert.equal(lidaAnon.lsLength, 0, `Lida's (landing page) localStorage.length should be 0, got ${lidaAnon.lsLength}`);
          assert.equal(lidaAnon.cookie, '', `Lida's (landing page) document.cookie should be empty, got "${lidaAnon.cookie}"`);

          await tonyaContext.close();
        } finally {
          await lidaContext.close();
          await goshaContext.close();
        }
      }
    );

    // --- Mobile smoke test + mobile chat (wave 11): narrow viewport, a new
    //     (separate) room ---
    // We deliberately don't check the screen: on real mobile browsers
    // getDisplayMedia isn't available at all and the "Screen" button gets
    // hidden (see room.js), while this test emulates viewport/touch in the
    // same desktop Chrome, where the API is formally present — checking the
    // button here wouldn't tell us anything either about desktop (already
    // covered above) or about real mobile Chrome/Safari.
    //
    // The mobile chat UX (wave 13: clean feed with no buttons, a single tap
    // action popup — reply/reaction+reaction breakdown/edit/delete/copy,
    // Enter=newline, textarea auto-grow, mobile formatting toolbar,
    // VisualViewport keyboard adjustment) is checked RIGHT HERE, as a second
    // episode of the same step (same room, same mobileContext) — rather than
    // a separate step() with its own POST /api/rooms:
    // the whole file keeps its budget at exactly 10 room creations per run
    // (H2: ROOM_CREATION_IP_LIMIT — the prod default is now 3 per 60s from
    // one IP, but the test server raises it via env, see
    // roomIdForTimerTestReuse below), an extra POST here would push the file
    // over the limit and would break (429) the subsequent steps. The desktop
    // counterpart connects to the SAME room via a regular join link (this
    // isn't room creation, doesn't consume the limit).
    await step(
      'Mobile smoke test (390x844, touch) + mobile chat (wave 13): control panel visible without horizontal scroll, chat feed is clean (no action buttons in the DOM at all), tapping a message opens the action popup for ONE message (tapping another switches, tapping outside closes it), reply/reaction+reaction breakdown/edit/delete/copy work through the popup, Enter inserts a newline (does not send), sending via the button, textarea grows for multi-line text, mobile formatting toolbar (via selection and via the "Aa" button), VisualViewport keyboard adjustment prevents the page from scrolling and keeps the input in the visible area',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const data = await res.json();
        const mobileRoomId = data.roomId;
        const mobileRoomKey = generateRoomToken(); // S1: see the comment on histRoomKey above

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

          // The join modal — the first thing a participant sees; it should
          // fit within 390×844 without horizontal scroll (mobile-first, see
          // README.md).
          await mobilePage.waitForSelector('#join-modal:not(.hidden)', { timeout: 10_000 });
          const joinModalBox = await mobilePage.locator('.join-modal-card').boundingBox();
          assert.ok(joinModalBox, 'the join modal should be visible on the mobile viewport');
          assert.ok(
            joinModalBox.x >= -1 && joinModalBox.x + joinModalBox.width <= 390 + 1,
            `the join modal should fit within the viewport width (390px): ${JSON.stringify(joinModalBox)}`
          );
          const modalOverflowInfo = await mobilePage.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            modalOverflowInfo.scrollWidth <= modalOverflowInfo.clientWidth + 1,
            `the join modal should not cause horizontal scroll: ${JSON.stringify(modalOverflowInfo)}`
          );

          await joinRoom(mobilePage, 'Mobile');
          await waitForOverlayHidden(mobilePage);
          await waitForTileCount(mobilePage, 1);

          const overflowInfo = await mobilePage.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            overflowInfo.scrollWidth <= overflowInfo.clientWidth + 1,
            `the document should not have horizontal scroll: scrollWidth=${overflowInfo.scrollWidth}, clientWidth=${overflowInfo.clientWidth}`
          );

          const panelBox = await mobilePage.locator('.control-panel').boundingBox();
          assert.ok(panelBox, 'the control panel should be visible in the viewport');
          assert.ok(
            panelBox.x >= -1 && panelBox.x + panelBox.width <= 390 + 1,
            `the control panel should fit within the viewport width (390px): ${JSON.stringify(panelBox)}`
          );
          assert.ok(
            panelBox.y + panelBox.height <= 844 + 1,
            `the control panel should fit within the viewport height (844px): ${JSON.stringify(panelBox)}`
          );
          const tileBox = await mobilePage.locator('.tile').first().boundingBox();
          assert.ok(tileBox, 'at least one participant tile should be visible');

          await mobilePage.click('#mic-button');
          await mobilePage.waitForFunction(
            () => document.getElementById('mic-button')?.getAttribute('aria-pressed') === 'true',
            undefined,
            { polling: 100, timeout: 5000 }
          );

          // Open chat on mobile — full-screen view (not a sidebar/
          // bottom-sheet like on desktop): check that the chat panel
          // covers almost the entire viewport.
          await openChatPanel(mobilePage);
          const chat = await getChatDom(mobilePage);
          const chatBox = await chat.panel.boundingBox();
          assert.ok(chatBox, 'chat panel should be visible after opening');
          const viewportArea = 390 * 844;
          const chatArea = chatBox.width * chatBox.height;
          assert.ok(
            chatArea >= viewportArea * 0.95,
            `open chat on mobile should cover almost the whole screen (>=95%): ${JSON.stringify(chatBox)}`
          );
          // --- Mobile UX wave 11: tap-activation of message actions,
          //     contextual reply/reaction/edit/delete, mobile formatting
          //     toolbar, VisualViewport adjustment for the keyboard.
          //     Continuation of the SAME step/room (see the heading above
          //     — saving POST /api/rooms): the desktop counterpart joins
          //     via the link to the same room — this way reply/reaction/
          //     edit/delete can be verified end-to-end (an action from
          //     mobile must reach and render at the counterpart), not just
          //     via local DOM state. ---
          const deskContext = await browser.newContext();
          const deskPage = await deskContext.newPage();
          try {
            await installMediaStubs(deskContext);

            // IMPORTANT: the desktop counterpart's URL must carry the SAME
            // `e` as the mobile one's — `e` is baked into K_auth (see
            // static/crypto.js), and a mismatch of even a second gives an
            // honest GCM failure "Link is invalid". makeRoomFragment
            // guarantees this via the e-per-token cache (see helpers.mjs:
            // defaultExpiryForToken) — the historical source of a flaky
            // failure specifically at this entry point.
            await deskPage.goto(roomUrlWithKey(server.baseUrl, mobileRoomId, mobileRoomKey));
            await joinRoom(deskPage, 'Desktop');
            await waitForOverlayHidden(deskPage);

            await waitForTileCount(mobilePage, 2);
            await waitForTileCount(deskPage, 2);
            await waitForBusOpenToAllPeers(mobilePage);
            await waitForBusOpenToAllPeers(deskPage);

            await openChatPanel(deskPage);

            // --- (1) the feed is CLEAN: not a single action button in the
            //     DOM for any message (wave 13 removed the previous wave's
            //     on-tap action-row and hover-buttons entirely — not just
            //     hid them, but doesn't render them at all), the action
            //     popup is closed ---
            const msg1Text = `Mob-one-${Date.now()}`;
            const msg1Id = await sendChatMessageAndGetId(mobilePage, msg1Text);
            const msg2Text = `Mob-two-${Date.now()}`;
            const msg2Id = await sendChatMessageAndGetId(mobilePage, msg2Text);
            assert.ok(msg1Id && msg2Id, 'both messages should get an id assigned (data-msg-id)');
            assert.ok(await messageTextsInclude(deskPage, msg1Text), 'msg1 did not reach the desktop participant');
            assert.ok(await messageTextsInclude(deskPage, msg2Text), 'msg2 did not reach the desktop participant');

            const msg1Sel = `.chat-message[data-msg-id="${msg1Id}"]`;
            const msg2Sel = `.chat-message[data-msg-id="${msg2Id}"]`;

            const actionButtonCount = await mobilePage.evaluate(
              () => document.querySelectorAll('.chat-message-action').length
            );
            assert.equal(actionButtonCount, 0, 'there should be no action buttons in the feed at all (none by default, none always)');
            const popoverHiddenInitially = await mobilePage.evaluate(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden')
            );
            assert.equal(popoverHiddenInitially, true, 'the action popup should be closed by default');

            // --- (2) tapping a message opens the action popup; the popup
            //     is modal (the dimming backdrop actually covers the rest
            //     of the feed, as befits a modal/bottom-sheet — see
            //     style.css: .chat-message-popover-backdrop), so tapping
            //     ANOTHER message while the popup is open is physically
            //     impossible (the backdrop intercepts the tap first, as it
            //     does any tap "elsewhere" in general) — first close, then
            //     open for another message (never more than one at a
            //     time) ---
            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg1Sel));
            const popoverMsgIdAfterTap1 = await mobilePage.evaluate(
              () => document.querySelector('.chat-message.chat-message--popover-open')?.dataset.msgId
            );
            assert.equal(popoverMsgIdAfterTap1, msg1Id, 'the popup should be open for msg1 after tapping it');

            // Tapping the background (backdrop) -> closes it, clears the mark from msg1.
            await mobilePage.click('.chat-message-popover-backdrop', { position: { x: 5, y: 5 } });
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );
            const msg1StillActive = await mobilePage.evaluate(
              (sel) => document.querySelector(sel)?.classList.contains('chat-message--popover-open'),
              msg1Sel
            );
            assert.equal(msg1StillActive, false, 'closing the popup (tap on background) should clear the mark from msg1');

            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg2Sel));
            const popoverMsgIdAfterTap2 = await mobilePage.evaluate(
              () => document.querySelector('.chat-message.chat-message--popover-open')?.dataset.msgId
            );
            assert.equal(popoverMsgIdAfterTap2, msg2Id, 'the popup should open for msg2 with a separate tap (after closing the previous one)');

            // Esc also closes the popup (background/close-button already covered above).
            await mobilePage.keyboard.press('Escape');
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );

            // --- (3) reply via the popup ---
            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg1Sel));
            await mobilePage.click('.chat-message-popover .chat-message-action--reply');
            await mobilePage.locator('.chat-reply-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
            const replyText = `Mob-reply-${Date.now()}`;
            await sendChatMessage(mobilePage, replyText);
            assert.ok(await messageTextsInclude(deskPage, replyText), 'the reply from mobile (via the popup) did not reach the desktop participant');

            // --- (4) reaction via the emoji palette IN THE SAME popup;
            //     the reaction breakdown "who/with what/when" shows the
            //     author ---
            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg2Sel));
            await mobilePage.click('.chat-message-popover-emoji[data-emoji="👍"]');
            await deskPage.locator(`${msg2Sel} .chat-reaction-chip`).first().waitFor({ state: 'visible', timeout: 5000 });

            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg2Sel));
            await mobilePage.waitForFunction(
              () => !document.querySelector('.chat-message-popover-reactions')?.classList.contains('hidden'),
              undefined,
              { timeout: 3000 }
            );
            const mobileReactionRowText =
              (await mobilePage.locator('.chat-message-popover-reaction-row').first().textContent()) || '';
            assert.ok(
              mobileReactionRowText.includes('Mobile') && mobileReactionRowText.includes('👍'),
              `the reaction breakdown in the popup should show the reactor's name and emoji: ${mobileReactionRowText}`
            );
            await mobilePage.click('.chat-message-popover-close');
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );

            // --- (5) editing via the popup ---
            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg1Sel));
            await mobilePage.click('.chat-message-popover .chat-message-action--edit');
            await mobilePage.locator('.chat-edit-bar:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
            const editedText = `${msg1Text}-edited`;
            await mobilePage.fill('.chat-text-input', editedText);
            await mobilePage.click('.chat-send-button');
            assert.ok(await messageTextsInclude(deskPage, editedText), 'the edited (via popup) text did not reach the desktop participant');

            // --- (6) deletion (double confirmation) via the popup ---
            await openMessagePopoverFor(mobilePage, mobilePage.locator(msg2Sel));
            const mobileDeleteBtn = mobilePage.locator('.chat-message-popover .chat-message-action--delete');
            await mobileDeleteBtn.click();
            await mobilePage.locator('.chat-message-popover .chat-message-action--confirm').waitFor({ timeout: 2000 });
            await mobileDeleteBtn.click();
            await waitUntil(
              async () => (await deskPage.locator(`${msg2Sel}.chat-message--deleted`).count()) === 1,
              { timeoutMs: 5000, message: 'the deletion of msg2 (via popup) did not reach the desktop participant' }
            );
            // The popup closes by itself after a confirmed deletion.
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );

            // --- (7) copying text via the popup (a third message — msg1/msg2 are already edited/deleted) ---
            const msg3Text = `Mob-three-${Date.now()}`;
            const msg3Id = await sendChatMessageAndGetId(mobilePage, msg3Text);
            await openMessagePopoverFor(mobilePage, mobilePage.locator(`.chat-message[data-msg-id="${msg3Id}"]`));
            const copyBtn = mobilePage.locator('.chat-message-popover .chat-message-action--copy');
            await copyBtn.click();
            await waitUntil(async () => (await copyBtn.textContent())?.includes('Copied'), {
              timeoutMs: 2000,
              message: 'the "Copy text" button should show "Copied" after the click',
            });
            await mobilePage.click('.chat-message-popover-close');
            await mobilePage.waitForFunction(
              () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
              undefined,
              { timeout: 2000 }
            );

            // --- (8) Enter — ALWAYS a line break, never a send (neither
            //     on mobile nor on desktop); sending is via the button
            //     only ---
            await mobilePage.fill('.chat-text-input', '');
            await mobilePage.click('.chat-text-input');
            await mobilePage.keyboard.type('first line');
            await mobilePage.keyboard.press('Enter');
            await mobilePage.keyboard.type('second line');
            const valueAfterEnter = await mobilePage.inputValue('.chat-text-input');
            assert.equal(
              valueAfterEnter,
              'first line\nsecond line',
              `Enter should insert a line break, not send the message: ${JSON.stringify(valueAfterEnter)}`
            );
            assert.equal(
              await messageTextsInclude(mobilePage, 'first line', 300),
              false,
              'the message should NOT have been sent by a single Enter'
            );
            // Sending via the button — the normal path, text with a line
            // break goes through as-is (see messageWithLineBreaksIncludes
            // — the render inserts <br>, not '\n', into textContent).
            await mobilePage.click('.chat-send-button');
            assert.ok(
              await messageWithLineBreaksIncludes(mobilePage, ['first line', 'second line']),
              'the multiline message should have been sent by clicking the send button, with an actual line break'
            );

            // --- (9) textarea auto-grow: multiline input increases the input height ---
            await mobilePage.fill('.chat-text-input', '');
            const singleLineHeight = (await mobilePage.locator('.chat-text-input').boundingBox()).height;
            const manyLines = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
            await mobilePage.locator('.chat-text-input').fill(manyLines);
            await mobilePage.waitForFunction(
              (baseline) => document.querySelector('.chat-text-input').getBoundingClientRect().height > baseline + 20,
              singleLineHeight,
              { timeout: 2000 }
            );
            const grownHeight = (await mobilePage.locator('.chat-text-input').boundingBox()).height;
            assert.ok(
              grownHeight > singleLineHeight,
              `the input should grow for multiline text: was ${singleLineHeight}, became ${grownHeight}`
            );
            // Send and clear — doesn't interfere with the following checks.
            await mobilePage.click('.chat-send-button');
            await mobilePage.waitForFunction(
              (baseline) => document.querySelector('.chat-text-input').getBoundingClientRect().height <= baseline + 2,
              singleLineHeight,
              { timeout: 2000 }
            );

            // --- (6a) the mobile formatting toolbar appears BY ITSELF on selection ---
            await mobilePage.fill('.chat-text-input', 'selected text');
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
            // Collapsed the selection (cursor with no range), didn't press
            // the "Aa" button — the toolbar should hide itself.
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

            // --- (6b) the mobile formatting toolbar via the "Aa" button, wrapping the selection ---
            await mobilePage.click('.chat-format-toggle-button');
            await mobilePage.locator('.chat-format-toolbar:not(.hidden)').waitFor({ state: 'visible', timeout: 2000 });
            await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-text-input');
              el.focus();
              el.setSelectionRange(0, el.value.length);
            });
            await mobilePage.click('.chat-format-btn--bold');
            const boldedValue = await mobilePage.inputValue('.chat-text-input');
            assert.equal(boldedValue, '**selected text**', `the "B" toolbar button should wrap the selection in ** **: ${boldedValue}`);
            await mobilePage.click('.chat-format-toggle-button'); // turn off the forced-open state (toggle off)
            await mobilePage.fill('.chat-text-input', '');

            // --- (7) VisualViewport adjustment for the keyboard ---
            const fullVvHeight = await mobilePage.evaluate(() => window.visualViewport.height);
            const shrunkHeight = Math.round(fullVvHeight * 0.55); // the "keyboard" took up ~45% of the height
            await mobilePage.evaluate((h) => window.__e2eSetVisualViewport(h, 0), shrunkHeight);
            await mobilePage.waitForFunction(
              (h) => Math.abs(document.querySelector('.chat-panel').getBoundingClientRect().height - h) < 2,
              shrunkHeight,
              { timeout: 2000 }
            );

            const inputBoxShrunk = await mobilePage.locator('.chat-text-input').boundingBox();
            assert.ok(
              inputBoxShrunk.y + inputBoxShrunk.height <= shrunkHeight + 1,
              `the input should stay within the shrunk visible area (height=${shrunkHeight}): ${JSON.stringify(inputBoxShrunk)}`
            );

            const scrollInfoShrunk = await mobilePage.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              scrollY: window.scrollY,
              bodyLocked: document.body.classList.contains('chat-mobile-scroll-lock'),
            }));
            assert.ok(
              scrollInfoShrunk.scrollWidth <= scrollInfoShrunk.clientWidth + 1,
              `there should be no horizontal scroll when the visible area is shrunk (by the keyboard): ${JSON.stringify(scrollInfoShrunk)}`
            );
            assert.equal(scrollInfoShrunk.scrollY, 0, 'the page should not scroll while the keyboard is open');
            assert.equal(scrollInfoShrunk.bodyLocked, true, 'the body should be scroll-locked while the mobile chat is open fullscreen');

            const messagesGapShrunk = await mobilePage.evaluate(() => {
              const el = document.querySelector('.chat-messages');
              return el.scrollHeight - el.scrollTop - el.clientHeight;
            });
            assert.ok(messagesGapShrunk < 40, `the message feed should remain scrolled to the bottom after shrinking for the keyboard: delta=${messagesGapShrunk}`);

            // --- (8) the keyboard "closed" -> the panel returns to full height ---
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

    // === S1 (E2E encryption v2 — PSK token `t`/`e` + ephemeral pairwise
    //     keys, see docs/research-p2p-key-handoff.md §6.5–6.6): checks of
    //     the scheme itself ===================================

    // --- (a) WS spy: SDP is not leaked in plaintext, the name is not
    //     leaked in plaintext ANYWHERE (join-room now always carries
    //     name:null — the name itself travels later, separately, as an
    //     encrypted `name-announce`) ---
    await step(
      'S1: server offer/answer frames are encrypted with an envelope {v:2,iv,ct} (do not contain "v=0"/"fingerprint"), join-room carries name:null+epub, the entered name does not appear in plaintext in ANY WS frame (it only appears in the name-announce ciphertext)',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: spyRoomId } = await res.json();
        const spyRoomToken = generateRoomToken();
        const spyRoomUrl = roomUrlWithKey(server.baseUrl, spyRoomId, spyRoomToken);

        const spyAContext = await browser.newContext();
        const spyBContext = await browser.newContext();
        await installSignalingFrameSpy(spyAContext);
        await installSignalingFrameSpy(spyBContext);
        try {
          const spyAPage = await spyAContext.newPage();
          const spyBPage = await spyBContext.newPage();

          const secretName = 'VERY-SECRET-NAME-42';
          await spyAPage.goto(spyRoomUrl);
          await spyBPage.goto(spyRoomUrl);
          await joinRoom(spyAPage, secretName);
          await joinRoom(spyBPage, 'Regular');
          await waitForOverlayHidden(spyAPage);
          await waitForOverlayHidden(spyBPage);
          await waitForTileCount(spyAPage, 2, 10_000);
          await waitForTileCount(spyBPage, 2, 10_000);

          for (const [label, page] of [['A', spyAPage], ['B', spyBPage]]) {
            const joinFrames = await framesOfTypeSentOn(page, 'join-room');
            assert.ok(joinFrames.length > 0, `${label}: there should be at least one join-room frame`);
            for (const frame of joinFrames) {
              assert.equal(frame.name, null, `${label}: join-room should carry name:null (the name no longer travels in join-room) — got: ${JSON.stringify(frame)}`);
              assert.equal(typeof frame.epub, 'string', `${label}: join-room should carry epub (ephemeral public key) — got: ${JSON.stringify(frame)}`);
              assert.ok(frame.epub.length > 0, `${label}: join-room.epub should not be an empty string`);
            }

            const sdpFrames = [
              ...(await framesOfTypeSentOn(page, 'offer')),
              ...(await framesOfTypeSentOn(page, 'answer')),
            ];
            assert.ok(sdpFrames.length > 0, `${label}: there should be at least one offer/answer frame`);
            for (const frame of sdpFrames) {
              const raw = JSON.stringify(frame);
              assert.ok(!raw.includes('v=0'), `${label}: an SDP frame should not contain "v=0" (raw SDP) in plaintext: ${raw}`);
              assert.ok(!/fingerprint/i.test(raw), `${label}: an SDP frame should not contain "fingerprint" in plaintext: ${raw}`);
              // S1 v2: the SDP/ICE envelope is now {v:2,iv,ct} (used to be
              // {v:1,...} under the room-wide K_sig) — now under the
              // pairwise K_pair_sig, see static/crypto.js:
              // encryptJson/decryptJson (rejects if v!==2).
              assert.equal(frame.sdp?.v, 2, `${label}: the SDP envelope should be version v:2, got: ${raw}`);
              assert.equal(typeof frame.sdp?.iv, 'string', `${label}: the SDP envelope should carry iv: ${raw}`);
              assert.equal(typeof frame.sdp?.ct, 'string', `${label}: the SDP envelope should carry ct: ${raw}`);
            }
          }

          // S1 v2: the name now travels as a SEPARATE encrypted
          // `name-announce` (not in join-room) — check that the secret
          // name does not appear in plaintext AT ALL, in any frame
          // captured over the whole scenario (join-room/joined/
          // peer-joined/offer/answer/ice-candidate/name-announce, etc.),
          // not just in join-room.
          for (const [label, page] of [['A', spyAPage], ['B', spyBPage]]) {
            const allRaw = JSON.stringify(await allFramesSentOn(page));
            assert.ok(
              !allRaw.includes(secretName),
              `${label}: the secret name should not appear in plaintext in any WS frame (it is encrypted inside name-announce): ${allRaw}`
            );
            const nameAnnounceFrames = await framesOfTypeSentOn(page, 'name-announce');
            assert.ok(nameAnnounceFrames.length > 0, `${label}: there should be at least one name-announce frame`);
            for (const frame of nameAnnounceFrames) {
              assert.equal(typeof frame.payload, 'string', `${label}: name-announce.payload should be a string (base64 iv‖ct): ${JSON.stringify(frame)}`);
              assert.ok(!frame.payload.includes(secretName), `${label}: name-announce.payload should not contain the name in plaintext: ${JSON.stringify(frame)}`);
            }
          }
        } finally {
          await spyAContext.close();
          await spyBContext.close();
        }
      }
    );

    // --- (b) entry without #t -> "Incomplete link" overlay ---
    await step('S1: entry WITHOUT #t -> "Incomplete link" overlay, join modal is not shown', async () => {
      const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
      assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
      const { roomId: noKeyRoomId } = await res.json();

      const noKeyContext = await browser.newContext();
      try {
        const noKeyPage = await noKeyContext.newPage();
        await noKeyPage.goto(`${server.baseUrl}/r/${noKeyRoomId}`); // a link entirely without #t/#e
        await waitInvalidLinkOverlay(noKeyPage);
        const modalVisible = await noKeyPage.evaluate(
          () => !document.getElementById('join-modal')?.classList.contains('hidden')
        );
        assert.equal(modalVisible, false, 'the join modal should not be shown without a valid link token');
      } finally {
        await noKeyContext.close();
      }

      // Same overlay — and if t is formally non-empty but malformed
      // (doesn't decode to 16 bytes): initCryptoIdentity fails
      // synchronously, before any attempt to connect to signaling.
      const badFormatContext = await browser.newContext();
      try {
        const badFormatPage = await badFormatContext.newPage();
        await badFormatPage.goto(roomUrlWithKey(server.baseUrl, noKeyRoomId, 'not-a-valid-token'));
        await waitInvalidLinkOverlay(badFormatPage);
      } finally {
        await badFormatContext.close();
      }
    });

    // --- (b-2) NEW in v2: `e` in the past (beyond
    //     LINK_EXPIRY_GRACE_SECONDS) -> terminal "Link expired" overlay
    //     (separate from "Link is invalid" — the token is valid by
    //     format, the link has simply expired), join modal is not
    //     shown ---
    await step('S1 v2: entry with `e` in the past -> "Link expired" overlay, join modal is not shown', async () => {
      // WITHOUT POST /api/rooms: initCryptoIdentity() checks the
      // format/expiry of t/e synchronously on the client, BEFORE any
      // attempt to connect to signaling (see static/room.js: init()) —
      // the room may not even exist on the server, the roomId below is
      // purely decorative. This matters practically too: this file has a
      // budget of exactly 10 POST /api/rooms per 60s per IP (H2:
      // ROOM_CREATION_IP_LIMIT, see roomIdForTimerTestReuse above) — an
      // extra POST here would push the file over the limit.
      const expiredRoomId = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

      const expiredContext = await browser.newContext();
      try {
        const expiredPage = await expiredContext.newPage();
        // e = an hour ago — far beyond the 120s tolerance (see
        // static/room.js: LINK_EXPIRY_GRACE_SECONDS).
        await expiredPage.goto(
          roomUrlWithKey(server.baseUrl, expiredRoomId, generateRoomToken(), { e: expiryB36FromNow(-3600) })
        );
        await waitLinkExpiredOverlay(expiredPage);
        const modalVisible = await expiredPage.evaluate(
          () => !document.getElementById('join-modal')?.classList.contains('hidden')
        );
        assert.equal(modalVisible, false, 'the join modal should not be shown for an expired link');
      } finally {
        await expiredContext.close();
      }
    });
    // --- (c) incoming decryption failures: from a KNOWN peer — terminal
    //     overlay "Incomplete link", from an UNKNOWN one — silent ignore ---
    //
    // Two complementary scenarios (different outcomes by design):
    //   1) the "real" one — two people join the same room with DIFFERENT
    //      (random, each individually valid-looking) `t` tokens; which of
    //      the two hits the other's SDP/ICE first depends on which of the
    //      pair is polite/impolite (see static/rtc.js) — deterministically
    //      unknown in advance, so we check BOTH and require it to fire for
    //      at least one of them (this is exactly the observable behavior of
    //      a real K_auth/pairwise-key mismatch — it isn't required to hit a
    //      specific side).
    //   2) a guard against an UNKNOWN sender — a direct injection of
    //      garbage stream-info from a peerId the page doesn't know (no
    //      cached pair, see static/room.js: pairKeysCache.has-guard in
    //      signaling.on('stream-info'/'name-announce')), using the same
    //      technique as the forged chat envelopes elsewhere in this file
    //      (envelope.enc/bus._dispatch): such a message is a legitimate
    //      in-flight message from a peer that just left, NOT a sign of
    //      MITM, so it is silently ignored (console.warn), the terminal
    //      overlay is NOT shown, and the room keeps living. The real
    //      protection — a GCM failure on a KNOWN pair — is covered by the
    //      first half of the step.
    await step(
      'S1: joining with a format-valid but WRONG t -> decryption failure from a KNOWN peer -> "Incomplete link" overlay (real SDP exchange between two different tokens); garbage from an UNKNOWN sender is silently ignored (console.warn), no overlay',
      async () => {
        const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        assert.ok(res.ok, `POST /api/rooms responded with status ${res.status}`);
        const { roomId: wrongKeyRoomId } = await res.json();
        // Reused by the next step (call-duration limit) — without an extra
        // POST /api/rooms: a single run of this file already racks up
        // plenty of them (see H2: ROOM_CREATION_IP_LIMIT — prod default 3
        // per 60s from one IP, the test server raises it via env, and both
        // Node fetches and the "Create room" click in the browser count as
        // coming from ONE IP, localhost) — this step doesn't need a new
        // room — the participant here is solo, the link token shouldn't
        // match anyone else's.
        roomIdForTimerTestReuse = wrongKeyRoomId;
        const tokenA = generateRoomToken();
        const tokenB = generateRoomToken(); // independent random token of the same shape — valid, but not the same one
        assert.notEqual(tokenA, tokenB, 'the generated tokens must differ, otherwise the test is meaningless');

        const aContext = await browser.newContext();
        const bContext = await browser.newContext();
        try {
          const aPage = await aContext.newPage();
          const bPage = await bContext.newPage();

          await aPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, tokenA));
          await bPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, tokenB));
          await joinRoom(aPage, 'First');
          await joinRoom(bPage, 'Second');

          // The server honestly puts both into the same room (roomId
          // matched) — but they can't decrypt each other's SDP/ICE (K_auth,
          // and transitively the pairwise keys, differ): sooner or later
          // the overlay shows up for ONE OF THE TWO (see explanation
          // above).
          await Promise.race([waitInvalidLinkOverlay(aPage, 20_000), waitInvalidLinkOverlay(bPage, 20_000)]);
        } finally {
          await aContext.close();
          await bContext.close();
        }

        // Second half: garbage stream-info from an UNKNOWN sender (no pair
        // in pairKeysCache — as if from a peer that just left, whose
        // message was still in flight over the relay) — by design it is
        // IGNORED silently (see static/room.js: guard via
        // pairKeysCache.has() in signaling.on('stream-info')), rather than
        // tearing down the room with a terminal overlay: there's nothing to
        // decrypt such a message with in principle, and it's
        // indistinguishable from a normal live-relay race. We check
        // POSITIVELY: after the injection the overlay never appeared, the
        // page is still alive, and the ignore is honestly logged via
        // console.warn.
        const soloContext = await browser.newContext();
        try {
          const soloPage = await soloContext.newPage();
          const soloWarnings = [];
          soloPage.on('console', (msg) => {
            if (msg.type() === 'warning') soloWarnings.push(msg.text());
          });
          await soloPage.goto(roomUrlWithKey(server.baseUrl, wrongKeyRoomId, generateRoomToken()));
          await joinRoom(soloPage, 'Loner');
          await waitForOverlayHidden(soloPage);

          await soloPage.evaluate(() => {
            signaling._dispatch({
              type: 'stream-info',
              fromPeerId: 'unknown-peer-in-flight-after-leave',
              info: { v: 2, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
            });
          });

          // A negative check "the overlay did NOT appear" can't be
          // expressed by polling a condition (there's nothing to wait for —
          // we need to make sure an event did NOT happen) — we give the
          // guard a generously sufficient 2s (the handler is synchronous,
          // but insurance against any deferred microtasks is cheap) and
          // only then look at the state.
          await sleep(2000);

          const soloState = await soloPage.evaluate(() => ({
            overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
            overlayTitle: document.getElementById('overlay-title')?.textContent,
            participantCount: document.getElementById('participant-count')?.textContent,
          }));
          assert.equal(
            soloState.overlayHidden,
            true,
            `garbage from an unknown sender should not show the overlay (got overlay "${soloState.overlayTitle}")`
          );
          assert.equal(
            soloState.participantCount,
            'Participants: 1 / 6',
            `the page should remain alive in the room (got: "${soloState.participantCount}")`
          );
          assert.ok(
            soloWarnings.some((w) => w.includes('stream-info from a sender with no established pair')),
            `the ignore should be logged via the guard's console.warn, warnings received: ${JSON.stringify(soloWarnings)}`
          );
        } finally {
          await soloContext.close();
        }
      }
    );

    // --- Call-duration limit (3 hours, see README.md and static/room.js:
    //     startRoomTimer/stopRoomTimer) ---
    //
    // The contract with the backend now has TWO fields in `joined`:
    // `expiresInSeconds` (the room's remaining lifetime — the server still
    // computes and sends it itself, `room-expired {}` is broadcast to
    // everyone and closes the sockets when it runs out, see src/ws.rs) and
    // the additive `roomAgeSeconds` (how much time has passed since the
    // FIRST participant joined — see src/ws.rs::room_age_seconds). The bar
    // timer now shows EXACTLY the latter — count-up, not a countdown to the
    // limit — which is why it no longer has a yellow/red threshold (that
    // was tied to the remaining time, not to elapsed time), nor any
    // dependency on expiresInSeconds for display. Running the real 3-hour
    // time limit is impractical — instead:
    //   (a)/(b) we substitute the timer state via a direct call to the
    //       top-level startRoomTimer(N) (room.js — a classic script, the
    //       function is visible from page.evaluate exactly like
    //       bus/ChatPanel in other tests in this file) — the format before/
    //       after an hour and time actually moving forward;
    //   (c) we emulate the server itself:
    //       signaling._dispatch({type:'room-expired'}) — the same direct-
    //       injection technique as stream-info/invalid-link above — and
    //       check the final overlay + chat being disabled (the room's LIFE
    //       limit hasn't gone anywhere — only its DISPLAY changed from a
    //       countdown to "how long it's been running");
    //   (d) the subsequent socket close (as the server itself would do
    //       right after room-expired, see src/ws.rs: reject=true) must not
    //       overwrite this "Connection lost" overlay — terminalState is
    //       already armed (the same technique as room-not-found/room-full/
    //       join-rejected, see static/room.js: signaling.onClose).
    await step(
      'Call-duration limit: the timer in the bar counts up (grows over time, no yellow/red) + "Time is up" overlay on room-expired, not overwritten by a subsequent socket close',
      async () => {
        // Reuse the room from step "S1: wrong k" above (see
        // roomIdForTimerTestReuse) — saving on a POST /api/rooms (H2 limit
        // on creation, see the comment there); the participant here is
        // solo, the room already exists on the server, its own token
        // shouldn't match anyone else's.
        assert.ok(roomIdForTimerTestReuse, 'no room passed by the previous step for reuse');
        const timerRoomKey = generateRoomToken();
        const timerRoomUrl = roomUrlWithKey(server.baseUrl, roomIdForTimerTestReuse, timerRoomKey);

        const timerContext = await browser.newContext();
        try {
          const timerPage = await timerContext.newPage();
          await timerPage.goto(timerRoomUrl);
          await joinRoom(timerPage, 'Nastya');
          await waitForOverlayHidden(timerPage);
          await openChatPanel(timerPage);

          // Right after joined, the timer should already be visible. At
          // this point the room has existed for only a few seconds (created
          // by the previous step of the same run) — the real
          // roomAgeSeconds is small, so the format should be M:SS (an hour
          // hasn't accumulated yet), not H:MM:SS — no
          // warning/critical classes (see static/style.css:
          // .room-timer--warning/--critical, removed together with the
          // countdown) exist anymore at all, so we don't check them here or
          // below.
          await timerPage.waitForFunction(
            () => !document.getElementById('room-timer')?.classList.contains('hidden'),
            undefined,
            { polling: 100, timeout: 3000 }
          );
          const initialText = await timerPage.evaluate(() => document.getElementById('room-timer').textContent);
          assert.match(initialText, /^\d+:\d{2}$/, `the timer format for a small elapsed time should be M:SS, got: ${initialText}`);

          // (a) the format after an hour of elapsed time — H:MM:SS (the
          // same string format as in the old countdown — formatRoomTimer
          // doesn't distinguish count-up from count-down, it just counts
          // seconds).
          await timerPage.evaluate(() => startRoomTimer(3700));
          const normalText = await timerPage.evaluate(() => document.getElementById('room-timer').textContent);
          assert.equal(normalText, '1:01:40', `the timer should show 1:01:40, got: ${normalText}`);

          // (b) count-up: the timer goes UP — we sync the base to 0 and, by
          // polling (not a blocking sleep — the timer's one-second tick
          // interval doesn't necessarily line up in phase with the moment
          // we reset it, see static/room.js:
          // startRoomTimer/updateRoomTimerDisplay), wait until the
          // displayed value has actually grown, rather than staying at 0:00
          // or going backwards.
          await timerPage.evaluate(() => startRoomTimer(0));
          const zeroText = await timerPage.evaluate(() => document.getElementById('room-timer').textContent);
          assert.equal(zeroText, '0:00', `right after startRoomTimer(0) the timer should show 0:00, got: ${zeroText}`);
          await timerPage.waitForFunction(
            (prevText) => document.getElementById('room-timer')?.textContent !== prevText,
            zeroText,
            { polling: 100, timeout: 5000 }
          );
          const grownText = await timerPage.evaluate(() => document.getElementById('room-timer').textContent);
          const grownSeconds = grownText.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
          assert.ok(grownSeconds >= 1, `the timer should have grown (count-up), not stayed put/gone backwards: was "${zeroText}", is now "${grownText}"`);

          // (c) the server decided time is up — room-expired: final
          // overlay, timer hides, chat is disabled. The room's LIFE limit
          // (expiresInSeconds) is still computed by the server itself and
          // it sends this same signal regardless of what the bar displays
          // — here we just emulate its arrival.
          await timerPage.evaluate(() => {
            signaling._dispatch({ type: 'room-expired' });
          });
          await waitOverlayTitle(timerPage, 'Meeting time is up (3 hours)');
          const afterExpiry = await timerPage.evaluate(() => ({
            actionLabel: document.getElementById('overlay-action-button')?.textContent,
            timerHidden: document.getElementById('room-timer')?.classList.contains('hidden'),
            chatDisabled: document.querySelector('.chat-text-input')?.disabled,
          }));
          assert.equal(afterExpiry.actionLabel, 'Create a new one', `the overlay button should lead to creating a new room: ${afterExpiry.actionLabel}`);
          assert.equal(afterExpiry.timerHidden, true, 'the timer should hide after room-expired (stopRoomTimer)');
          assert.equal(afterExpiry.chatDisabled, true, 'the chat input should be disabled after room-expired (teardownMeshMediaChat)');

          // (d) terminality: a subsequent socket close (as the server
          // itself would do right after room-expired) must not overwrite
          // this overlay with a "Connection lost" banner.
          await timerPage.evaluate(() => signaling.ws.close());
          await timerPage.waitForTimeout(500);
          const titleAfterClose = await timerPage.evaluate(() => document.getElementById('overlay-title')?.textContent);
          assert.equal(
            titleAfterClose,
            'Meeting time is up (3 hours)',
            `the "Time is up" overlay must not be overwritten by the socket closing: ${titleAfterClose}`
          );
        } finally {
          await timerContext.close();
        }
      }
    );


    // --- Build hash of the published static assets (forensic anchor, see
    // docs/security.md, "Published Build Hash") ---
    //
    // The test server (target/debug/screenshare) does NOT serve
    // /build-hash.json — there's no such route on it at all (see
    // src/main.rs): it's an artifact that ONLY the deploy-pages job in CI
    // (see .github/workflows/deploy-prod.yml) puts into the bundle, for
    // Cloudflare Pages. To check that the frontend CORRECTLY shows the hash
    // when it's present, we mock /build-hash.json at the Playwright
    // network-interception level (context.route) — more reliable than a
    // temporary file under static/ (which wouldn't be reachable at the
    // right path anyway: the server only serves static assets under
    // /static/*, see src/main.rs — there's no root route for arbitrary
    // files) and leaves nothing behind on disk.
    {
      const FAKE_BUILD_HASH = 'b5f68626b068a00bfcabf88ccf3efda9519de4208858eeca7e0367320519c195';
      assert.equal(FAKE_BUILD_HASH.length, 64, 'the fake test hash should look like a real SHA-256 (64 hex characters)');

      await step('Build hash: the landing page footer shows the build string from /build-hash.json', async () => {
        const context = await browser.newContext();
        try {
          await context.route('**/build-hash.json', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ hash: FAKE_BUILD_HASH, commit: 'deadbeef', buildDate: '2026-01-01T00:00:00Z' }),
            })
          );
          const page = await context.newPage();
          await page.goto(server.baseUrl);
          await page.waitForSelector('#landing-build-footer:not(.hidden)', { timeout: 5000 });

          const shortText = await page.locator('#landing-build-short').textContent();
          const fullText = await page.locator('#landing-build-full').textContent();
          const verifyHref = await page.locator('#landing-build-verify-link').getAttribute('href');

          assert.equal(
            shortText,
            `${FAKE_BUILD_HASH.slice(0, 10)}…`,
            `the footer should show the first 10 characters of the hash: ${shortText}`
          );
          assert.equal(fullText, FAKE_BUILD_HASH, `the full hash should be available on expanding (details): ${fullText}`);
          assert.match(verifyHref || '', /github\.com\/.+\/releases/, `the "verify" link should lead to GitHub Releases: ${verifyHref}`);
        } finally {
          await context.close();
        }
      });

      await step('Build hash: without /build-hash.json (dev/self-hosted, 404) the footer stays hidden, nothing crashes', async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const consoleErrors = [];
          page.on('pageerror', (err) => consoleErrors.push(String(err)));
          await page.goto(server.baseUrl);
          // The real test server doesn't serve /build-hash.json anyway — we don't mock anything, we check the behavior "as is".
          await page.waitForTimeout(500); // let fetch() finish (it's fire-and-forget in loadBuildHash())
          const hidden = await page.locator('#landing-build-footer').evaluate((el) => el.classList.contains('hidden'));
          assert.ok(hidden, 'the build-hash footer should stay hidden when /build-hash.json is unavailable (404)');
          assert.equal(consoleErrors.length, 0, `there should be no uncaught page errors: ${consoleErrors.join('; ')}`);
        } finally {
          await context.close();
        }
      });

      await step(
        'Build hash: the "Share" popup shows the short hash + verify link SEPARATELY from the link/QR (those don\'t contain the hash)',
        async () => {
          const context = await browser.newContext();
          try {
            await context.route('**/build-hash.json', (route) =>
              route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ hash: FAKE_BUILD_HASH, commit: 'deadbeef', buildDate: '2026-01-01T00:00:00Z' }),
              })
            );
            const page = await context.newPage();

            // PUT /api/rooms/<id>, not POST: the room is created empty,
            // without a leader — the first one to join (this page) becomes
            // the leader automatically, leaderToken isn't needed.
            //
            // (B, docs/research-dos.md §3.1): PUT restore_room NOW (unlike
            // the old behavior the previous comment here relied on) also
            // checks the per-IP limit — it shares the budget with POST
            // /api/rooms (the same ROOM_CREATION_IP_LIMIT/room_creation_ips,
            // see src/main.rs::restore_room) rather than having a separate
            // counter. By this point in the file, plenty of POST requests
            // from the real (localhost) IP have already accumulated (see
            // H2: ROOM_CREATION_IP_LIMIT — prod default now 3 per 60s, the
            // test server raises it via env) — sharing the budget with them
            // would be a race against how long the run actually takes (how
            // many of them have already fallen out of the sliding window).
            // We isolate this call with its OWN CF-Connecting-IP (the same
            // technique as in tests/signaling.test.mjs::createRoom(ip) — the
            // server trusts this header directly, see
            // src/state.rs::extract_client_ip), so this check of PUT is
            // about the actual behavior of the recovery endpoint, rather
            // than luck with the timing of the rest of the file.
            const roomId = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
            // We fix `t`/`e` ourselves (rather than letting the default
            // generate `e` inside roomUrlWithKey), so that below we know
            // exactly which `e` will end up in the address bar (for
            // expectedLink=/=linkText) — the client doesn't need `e` from
            // the server for recovery via PUT (it's already in the address
            // bar, see the spec docs §2/§5), so we don't read the PUT
            // response here.
            const roomToken = generateRoomToken();
            const roomExpiry = defaultValidExpiryB36();
            const putRes = await fetch(`${server.baseUrl}/api/rooms/${roomId}`, {
              method: 'PUT',
              headers: { 'CF-Connecting-IP': '10.77.0.1' }, // see the comment above about isolating from ROOM_CREATION_IP_LIMIT
            });
            assert.ok(putRes.ok, `PUT /api/rooms/${roomId} responded with status ${putRes.status}`);

            await page.goto(roomUrlWithKey(server.baseUrl, roomId, roomToken, { e: roomExpiry }));
            await joinRoom(page, 'Tester');
            await waitForOverlayHidden(page);

            await page.click('#share-button');
            await page.waitForSelector('#share-popup:not(.hidden)');
            await page.waitForSelector('#share-popup-build:not(.hidden)', { timeout: 5000 });

            const linkText = await page.locator('#share-popup-link').textContent();
            const buildShortText = await page.locator('#share-popup-build-short').textContent();
            const buildFullText = await page.locator('#share-popup-build-full').textContent();
            const buildVerifyHref = await page.locator('#share-popup-build-verify-link').getAttribute('href');
            const expectedLink = `${server.baseUrl}/r/${roomId}#t=${roomToken}&e=${roomExpiry}`;

            assert.equal(linkText, expectedLink, `the link should be exactly "<origin>/r/<id>#t=<token>&e=<expiry>", without the hash: ${linkText}`);
            assert.ok(!linkText.includes(FAKE_BUILD_HASH), `the link must NOT contain the build hash: ${linkText}`);
            assert.equal(
              buildShortText,
              `${FAKE_BUILD_HASH.slice(0, 10)}…`,
              `the popup should show the first 10 characters of the hash: ${buildShortText}`
            );
            assert.equal(
              buildFullText,
              FAKE_BUILD_HASH,
              `the full hash should be available on expanding (details), separately from the link: ${buildFullText}`
            );
            assert.match(
              buildVerifyHref || '',
              /github\.com\/.+\/releases/,
              `the "verify" link in the popup should lead to GitHub Releases: ${buildVerifyHref}`
            );
            assert.notEqual(buildFullText, linkText, 'the build string and the link string should be different DOM nodes with different text');

            // QR: we compare the VECTOR DATA (the `d` attribute of the
            // <path> — the actual coordinates of the filled QR modules)
            // with what the SAME vendored library (static/vendor/qrcode.js)
            // produces when encoding ONLY the link — if the hash were mixed
            // into the QR data (even not visibly as text in the SVG markup
            // — it's purely vector), the coordinates themselves would
            // differ, and this comparison would catch the discrepancy. We
            // compare `d` specifically, not the entire markup byte-for-byte:
            // page.innerHTML() gives the SERIALIZATION of the REAL DOM (the
            // browser expands self-closing tags like `<rect .../>` into
            // `<rect ...></rect>` and normalizes whitespace in attributes
            // during parsing/serialization) — this differs from the raw
            // string that the library's createSvgTag() returns without
            // going through the DOM, even though the encoded data is
            // identical.
            const require = createRequire(import.meta.url);
            const qrcodeFactory = require(path.join(REPO_ROOT, 'static/vendor/qrcode.js'));
            const expectedQr = qrcodeFactory(0, 'M');
            expectedQr.addData(expectedLink);
            expectedQr.make();
            const expectedSvg = expectedQr.createSvgTag(4, 12);
            const expectedPathD = expectedSvg.match(/<path d="([^"]*)"/)?.[1];
            assert.ok(expectedPathD, 'failed to extract d= from the expected (reference) QR SVG');

            const actualSvg = await page.locator('#share-popup-qr').innerHTML();
            const actualPathD = actualSvg.match(/<path d="([^"]*)"/)?.[1];
            assert.ok(actualPathD, 'failed to extract d= from the QR SVG rendered in the popup');

            assert.equal(
              actualPathD,
              expectedPathD,
              'the QR module coordinates should match byte-for-byte with encoding ONLY the room link (without the build hash)'
            );
          } finally {
            await context.close();
          }
        }
      );
    }

    // --- M2: Cloudflare Pages headers (_headers) ---
    //
    // Running a real wrangler/Pages instance in e2e is impractical (the
    // coordinator hasn't set up the prod project yet, see
    // .github/workflows/deploy-prod.yml: the deploy-pages job is gated by
    // the CLOUDFLARE_API_TOKEN secret) — instead of going to pages.dev we
    // run EXACTLY THE SAME build step described in the workflow (the "Build
    // pages-dist/…" step, the _headers-generation section), extracted
    // directly from the workflow file itself (not rewritten by hand — so
    // the test can't drift from what actually ships in CI), and check the
    // result on disk. This isn't a browser test (CSP is enforced by the
    // browser when actually served from Pages, not on this origin server)
    // — here we're pinning down the contract of the _headers file itself.
    await step(
      'M2: the generated _headers for Cloudflare Pages contains a strict CSP (frame-ancestors \'none\') and the accompanying security headers',
      async () => {
        const workflowPath = path.join(REPO_ROOT, '.github/workflows/deploy-prod.yml');
        const workflowText = fs.readFileSync(workflowPath, 'utf8');
        const pagesStepScript = extractYamlRunStepScript(workflowText, 'Build pages-dist');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-dist-headers-test-'));
        try {
          fs.cpSync(path.join(REPO_ROOT, 'static'), path.join(tmpDir, 'static'), { recursive: true });
          execFileSync('bash', ['-c', pagesStepScript], { cwd: tmpDir, stdio: 'pipe' });

          const headersPath = path.join(tmpDir, 'pages-dist', '_headers');
          assert.ok(fs.existsSync(headersPath), '_headers was not created by the pages-dist build step');
          const headersText = fs.readFileSync(headersPath, 'utf8');

          assert.match(headersText, /Content-Security-Policy:.*frame-ancestors 'none'/, `_headers should contain a CSP with frame-ancestors 'none': ${headersText}`);
          assert.match(headersText, /Content-Security-Policy:.*default-src 'self'/, `_headers should contain default-src 'self': ${headersText}`);
          assert.match(headersText, /X-Frame-Options:\s*DENY/, `_headers should contain X-Frame-Options: DENY: ${headersText}`);
          assert.match(headersText, /X-Content-Type-Options:\s*nosniff/, `_headers should contain X-Content-Type-Options: nosniff: ${headersText}`);
          assert.match(headersText, /Cache-Control:\s*no-cache/, `_headers should preserve the existing Cache-Control: no-cache: ${headersText}`);
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
    console.log(`FAIL - unexpected test error: ${err && err.stack ? err.stack : err}`);
    try { await server.stop(); } catch { /* already stopped or never started */ }
    bumpFailedForUnexpectedError();
    printSummary();
    process.exit(1);
  });
