#!/usr/bin/env node
// tests/e2e/screenshots.mjs — a standalone VISUAL-QA HARNESS (not a test:
// no assertions, no ok/FAIL runner) that renders a room full of fake
// participants with different video aspect ratios and takes PNG screenshots
// at several viewport sizes. Meant for eyeballing tile-grid/spotlight layout
// changes across desktop/tablet/phone breakpoints without a human having to
// manually open five browser windows and fake five webcams.
//
// Run (from anywhere, or from tests/e2e — `npm install` first, see
// package.json): `node tests/e2e/screenshots.mjs [--users N] [--out DIR]`
//   --users N   number of participants in the room (default 5)
//   --out DIR   output directory for PNGs (default tests/e2e/screenshots-out,
//               relative to THIS file, not the current working directory)
//
// Reuses the server build/launch machinery and join-modal helper from
// helpers.mjs (see tests/e2e/helpers.mjs, and basic.spec.mjs for the
// established chromium.launch/newContext conventions this file follows) —
// nothing under static/*.js is touched, only page-side addInitScript stubs
// and the server driver, exactly like the existing e2e specs.
//
// --- Design decisions worth documenting up front ---
//
// 1) Observer == one of the N participants (not an extra (N+1)-th page).
//    The task allowed either; we picked "one of the N" so that `--users N`
//    produces a room screenshot with EXACTLY N tiles (an extra dedicated
//    observer page would make it N+1, which is confusing for a "room full of
//    N participants" QA tool and complicates the N-tiles sanity check run
//    while developing this harness). Concretely: participant index 0 (the
//    first name, e.g. "Anna 16:9") *is* the observer — its own BrowserContext
//    is the one that gets resized across viewports and screenshotted.
//
//    Pre-join redesign: the observer is now ALSO the room's CREATOR (goes in
//    through a `leaderUrlWithKey` link, presenting the one-time `lt` —
//    see static/room.js) rather than just another guest link — it's the one
//    that sets/keeps the room's name on the pre-join card and, right after
//    joining, gets the auto-opened "Share" popup (see static/room.js:
//    signaling.on('joined'), shareAutoOpenedForCreator) — screenshotted
//    (see share-popup-{size}.png below) and then closed, since it would
//    otherwise swallow the clicks below. The creator's mic/camera start OFF
//    (no getUserMedia at all on this screen, see static/room.js:
//    showPrejoinCard) — it still turns its own camera on like everyone
//    else afterward, via the toolbar, so its own tile shows live synthetic
//    video, not a placeholder.
//
// 2) The "no camera" participant (last one, only when --users >= 4, per the
//    task spec) is now achieved by setting that participant's pre-join
//    #prejoin-cam-select to "Off" before submitting the card — NOT by
//    simply never clicking #camera-button afterward, the way this harness
//    used to. Why the old trick alone no longer works: this participant is
//    a GUEST, and the guest pre-join card now acquires a COMBINED
//    mic+camera stream automatically the instant it's shown (see
//    static/room.js: acquireGuestPrejoinMedia) — by the time a mid-call
//    "never click the button" choice would matter, the camera is already
//    live. installSyntheticCamera's own `noCamera` stub (see below) is kept
//    too, as defense in depth (getUserMedia rejects outright with
//    NotFoundError, the same DOMException name a real "no camera hardware"
//    browser would throw, regardless of what the select is set to) — in
//    case some future code path acquires media some other way, the
//    placeholder must still be what ends up on screen, not a broken page.
//
// 3) Each participant gets its OWN BrowserContext (matching basic.spec.mjs,
//    which never shares a context between participants either) — mainly
//    because only the observer needs deviceScaleFactor: 2 (crisp @2x
//    screenshots) and a resizable viewport; deviceScaleFactor is fixed at
//    context-creation time in Playwright/Chromium and applies to every page
//    in that context, so giving each participant an isolated context is the
//    cheapest way to keep the other N-1 pages at the default (cheaper)
//    devicePixelRatio while the observer renders at 2x.
//
// 4) getUserMedia() stub: unlike helpers.mjs's installCamStub/installMicStub
//    (which are generic synthetic sources reused across many scenarios),
//    each participant here needs a DISTINCT resolution/color/label baked in,
//    so we don't reuse those exports — we install a small per-participant
//    stub directly in this file (see installSyntheticCamera below). It
//    builds a canvas.captureStream(15) (video) and a
//    MediaStreamAudioDestinationNode fed by an oscillator through a gain
//    node pinned to 0 (silent audio) — the SAME primitives helpers.mjs's
//    stubs use, just parameterized per participant. The stub answers
//    getUserMedia({video:...}) with ONLY the video track and
//    getUserMedia({audio:...}) with ONLY the silent audio track (never both
//    bundled into one stream) — this matters because static/room.js's
//    broadcastLocalStream(stream, kind) blindly adds EVERY track of
//    `stream` to every peer connection (see broadcastLocalStream in
//    room.js); if the video-only getUserMedia({video:...}) call returned a
//    stream that ALSO carried the silent audio track, clicking
//    #camera-button would silently smuggle an extra audio m-line into the
//    "camera" broadcast — harmless in practice, but not what a real camera
//    device would do, and needless surface area for this QA tool. Splitting
//    the two keeps the stub behaviorally honest.
//
//    Pre-join redesign: a GUEST's pre-join card now also asks for BOTH at
//    once (getUserMedia({audio:true,video:true}), see static/room.js:
//    acquireGuestPrejoinMedia) — this stub answers that combined request
//    with a SINGLE MediaStream carrying both tracks (wantVideo && wantAudio
//    both true), which sounds like it contradicts the paragraph above, but
//    doesn't in practice: acquireGuestPrejoinMedia immediately pulls the
//    audio/video tracks apart into their OWN per-kind MediaStream wrappers
//    before hand-off (see applyMicStream/applyCameraStream in
//    static/room.js) — by the time anything gets broadcast, the split has
//    already happened on the app side, regardless of how bundled the
//    original getUserMedia() response was.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_FLAGS,
  buildServer,
  createServerController,
  joinRoom,
  waitForPrejoinCard,
  setPrejoinDeviceOff,
  waitForOverlayHidden,
  generateRoomToken,
  roomUrlWithKey,
  leaderUrlWithKey,
  sleep,
  waitUntil,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 3344; // distinct from basic.spec.mjs (3322) / resilience.spec.mjs (3333) — this harness can run alongside those without a port clash

// --- CLI args ---

function parseArgs(argv) {
  let users = 5;
  let out = path.join(__dirname, 'screenshots-out');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--users') {
      users = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--users=')) {
      users = parseInt(arg.slice('--users='.length), 10);
    } else if (arg === '--out') {
      out = path.resolve(process.cwd(), argv[++i]);
    } else if (arg.startsWith('--out=')) {
      out = path.resolve(process.cwd(), arg.slice('--out='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tests/e2e/screenshots.mjs [--users N] [--out DIR]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(users) || users < 1) {
    throw new Error(`--users must be a positive integer, got: ${users}`);
  }
  return { users, out };
}

// --- Distinct video aspect ratios to cycle through (see task spec item 3) ---
const ASPECTS = [
  { label: '16:9', width: 1280, height: 720 },
  { label: '9:16', width: 720, height: 1280 }, // portrait
  { label: '4:3', width: 960, height: 720 },
  { label: '1:1', width: 720, height: 720 },
  { label: 'wide', width: 1680, height: 720 }, // ultra-wide
];

// Readable first names, cycled/suffixed if --users exceeds the pool (see
// task spec item 4 — "Anna 16:9", "Boris 9:16", ... "Fedor novideo").
const FIRST_NAMES = [
  'Anna', 'Boris', 'Clara', 'Dmitri', 'Eva', 'Fedor', 'Greta', 'Hugo',
  'Ivy', 'Jonas', 'Karla', 'Leo', 'Mira', 'Noah', 'Olga', 'Petr',
];

function nameFor(i) {
  const base = FIRST_NAMES[i % FIRST_NAMES.length];
  const suffix = i >= FIRST_NAMES.length ? String(Math.floor(i / FIRST_NAMES.length) + 1) : '';
  return base + suffix;
}

// --- Viewport sizes to screenshot the room at (see task spec item 5) ---
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
];
const DEVICE_SCALE_FACTOR = 2; // crisp @2x screenshots, per task spec item 5
const SETTLE_MS = 2000; // "wait ~2s after resize for layout to settle", per task spec item 5

/**
 * Per-participant synthetic camera: returns a function suitable for
 * `context.addInitScript(fn, arg)` — runs BEFORE any page script (including
 * static/room.js) on every navigation of that context, exactly like
 * helpers.mjs's installCamStub/installMicStub (see the file header above for
 * why this one is a local, per-participant variant rather than reusing those
 * exports).
 *
 * `arg`: { width, height, label, color, noCamera }
 *   width/height — the canvas (and therefore captured video) resolution.
 *   label        — big text drawn on the canvas (the participant's display
 *                   name, e.g. "Anna 16:9") — makes each tile identifiable
 *                   at a glance in a screenshot.
 *   color        — solid CSS color string, distinct per participant, used
 *                   as the canvas background.
 *   noCamera     — when true, getUserMedia always rejects with
 *                   NotFoundError (see design decision #2 above — this is a
 *                   defense-in-depth fallback; the harness itself achieves
 *                   "no camera" by never clicking #camera-button).
 */
function installSyntheticCamera() {
  return ({ width, height, label, color, noCamera }) => {
    if (noCamera) {
      navigator.mediaDevices.getUserMedia = async () => {
        // Same DOMException name/shape a real browser reports when no
        // camera/mic hardware is present — see static/room.js:
        // cameraButton/micButton click handlers, both wrap their
        // getUserMedia() call in try/catch and just show a
        // "Could not access the camera/microphone." message on rejection,
        // leaving the tile on its default (already-placeholder) state.
        throw new DOMException('Requested device not found', 'NotFoundError');
      };
      return;
    }

    // --- Synthetic video source: an animated canvas, captured at 15fps ---
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // A bouncing circle so the stream is visibly "live" (not a frozen
    // frame) in a screenshot taken at an arbitrary moment; radius/speed
    // scaled to the canvas size so tiny (square) and huge (ultra-wide)
    // canvases both look reasonable.
    const shapeR = Math.max(16, Math.min(width, height) * 0.09);
    let x = shapeR + Math.random() * (width - 2 * shapeR);
    let y = shapeR + Math.random() * (height - 2 * shapeR);
    let vx = Math.max(2, width / 200);
    let vy = Math.max(2, height / 240);

    function draw() {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);

      x += vx;
      y += vy;
      if (x - shapeR < 0 || x + shapeR > width) vx = -vx;
      if (y - shapeR < 0 || y + shapeR > height) vy = -vy;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.arc(x, y, shapeR, 0, Math.PI * 2);
      ctx.fill();

      // Big participant label, centered.
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(Math.min(width, height) * 0.12)}px sans-serif`;
      ctx.fillText(label, width / 2, height / 2);

      // Canvas resolution as text, just below the label.
      ctx.font = `${Math.round(Math.min(width, height) * 0.05)}px monospace`;
      ctx.fillText(`${width}x${height}`, width / 2, height / 2 + Math.round(Math.min(width, height) * 0.14));

      window.__e2eFakeCamFrame = requestAnimationFrame(draw);
    }
    draw();

    const videoStream = canvas.captureStream(15);

    // --- Synthetic (silent) audio source: oscillator -> gain(0) -> destination ---
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextCtor();
    const oscillator = audioCtx.createOscillator();
    oscillator.frequency.value = 220;
    const gain = audioCtx.createGain();
    gain.gain.value = 0; // silent — a real, live track that never produces audible sound
    const destination = audioCtx.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const audioStream = destination.stream;

    // getUserMedia answers each request with ONLY the tracks it asked for
    // (see the file header, design decision #4, for why video and audio are
    // NOT bundled into a single returned stream).
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const wantVideo = !!(constraints && constraints.video);
      const wantAudio = !!(constraints && constraints.audio);
      const out = new MediaStream();
      if (wantVideo) videoStream.getVideoTracks().forEach((t) => out.addTrack(t));
      if (wantAudio) audioStream.getAudioTracks().forEach((t) => out.addTrack(t));
      if (out.getTracks().length === 0) {
        throw new DOMException('getUserMedia called without audio/video constraints', 'NotFoundError');
      }
      return out;
    };
  };
}

/** `.tile[data-name="..."]` selector — same convention as basic.spec.mjs's tileSelector(). */
function tileSelector(name) {
  return `.tile[data-name="${name}"]`;
}

async function main() {
  const { users, out } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(out, { recursive: true });

  const writtenFiles = [];

  // MAX_PARTICIPANTS defaults to 6 in the server (see src/state.rs:
  // DEFAULT_MAX_PARTICIPANTS — a room is a full WebRTC mesh, 6 is the
  // recommended ceiling) — bump it so `--users` above that still works.
  // JOIN_ROOM_IP_LIMIT: raised the same way basic.spec.mjs does, since this
  // harness calls joinRoom() `users` times from the same (localhost) IP in
  // one run (see the H2 comment in basic.spec.mjs for the full story).
  const server = createServerController(PORT, {
    JOIN_ROOM_IP_LIMIT: '100000',
    MAX_PARTICIPANTS: String(Math.max(users, 6)),
  });

  let browser = null;

  try {
    await buildServer();
    await server.start();

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CAPTURE_FLAGS,
    });

    try {
      // ---------- (a) Landing page screenshots ----------
      // A dedicated, ephemeral context — separate from the room participants
      // below — closed right after use.
      await (async () => {
        const landingContext = await browser.newContext({ deviceScaleFactor: DEVICE_SCALE_FACTOR });
        try {
          const landingPage = await landingContext.newPage();
          for (const sizeName of ['desktop', 'phone-portrait']) {
            const size = VIEWPORTS.find((v) => v.name === sizeName);
            await landingPage.setViewportSize({ width: size.width, height: size.height });
            await landingPage.goto(server.baseUrl);
            await sleep(SETTLE_MS);
            const file = path.join(out, `landing-${sizeName}.png`);
            await landingPage.screenshot({ path: file });
            writtenFiles.push(file);
          }
        } finally {
          await landingContext.close();
        }
      })();

      // ---------- (a2) Pre-join screenshots ----------
      //
      // A dedicated, EPHEMERAL room (its own POST /api/rooms) — separate
      // from the N-participant room built below — used ONLY to screenshot
      // the pre-join card itself, for both personalities, before anyone
      // ever actually submits it: the creator's card (editable room-name
      // field, mic/camera defaulting to "Off") and a guest's card (static
      // room-name display + the "N people · started..." meta line, both
      // mic+camera defaulting to live). Neither page ever clicks
      // "Start"/"Join" — the room is torn down (context closed) right after.
      await (async () => {
        const preRes = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
        if (!preRes.ok) throw new Error(`POST /api/rooms responded with status ${preRes.status}`);
        const { roomId: preRoomId, leaderToken: preLeaderToken } = await preRes.json();
        const preRoomToken = generateRoomToken();
        const PREJOIN_DEMO_NAME = 'Design Team Sync';
        const creatorPrejoinUrl = leaderUrlWithKey(server.baseUrl, preRoomId, preLeaderToken, preRoomToken);
        const guestPrejoinUrl = `${roomUrlWithKey(server.baseUrl, preRoomId, preRoomToken)}&n=${encodeURIComponent(PREJOIN_DEMO_NAME)}`;

        const prejoinContext = await browser.newContext({ deviceScaleFactor: DEVICE_SCALE_FACTOR });
        try {
          const creatorPage = await prejoinContext.newPage();
          for (const sizeName of ['desktop', 'phone-portrait']) {
            const size = VIEWPORTS.find((v) => v.name === sizeName);
            await creatorPage.setViewportSize({ width: size.width, height: size.height });
            await creatorPage.goto(creatorPrejoinUrl);
            await waitForPrejoinCard(creatorPage);
            // A recognizable, stable name (rather than the random
            // NameGen.roomName() default) — nicer for QA, less run-to-run
            // visual diffing.
            await creatorPage.fill('#prejoin-room-name-input', PREJOIN_DEMO_NAME);
            await sleep(SETTLE_MS);
            const file = path.join(out, `prejoin-creator-${sizeName}.png`);
            await creatorPage.screenshot({ path: file });
            writtenFiles.push(file);
          }

          const guestPage = await prejoinContext.newPage();
          for (const sizeName of ['desktop', 'phone-portrait']) {
            const size = VIEWPORTS.find((v) => v.name === sizeName);
            await guestPage.setViewportSize({ width: size.width, height: size.height });
            await guestPage.goto(guestPrejoinUrl);
            await waitForPrejoinCard(guestPage);
            await sleep(SETTLE_MS);
            const file = path.join(out, `prejoin-guest-${sizeName}.png`);
            await guestPage.screenshot({ path: file });
            writtenFiles.push(file);
          }
        } finally {
          await prejoinContext.close();
        }
      })();

      // ---------- Build the room: N participants, one of them the observer ----------
      //
      // Room created directly via POST /api/rooms (bypassing the landing
      // page's UI, exactly like basic.spec.mjs's "Chat history" and several
      // other scenarios do — see roomUrlWithKey/generateRoomToken in
      // helpers.mjs) — the link token (`t`) is generated test-side, the way
      // a real creator's browser would. The OBSERVER (participant 0) becomes
      // the room's CREATOR (goes in via leaderUrlWithKey, presenting the
      // one-time `lt`) — see design decision #1 above; everyone else is a
      // plain guest via roomUrl, which carries the room name the creator is
      // about to set (see ROOM_NAME below) so their pre-join cards show it too.
      //
      // MESH_SETTLE_ATTEMPTS (investigated separately — see the diagnostic
      // harness scratchpad/mesh-probe.mjs this accompanies): "mesh did not
      // settle" at --users 5 turned out to be NEITHER a signaling/protocol
      // bug (a stuck pair's offer/answer/ICE credentials were always
      // mutually consistent on both sides — getStats() showed the POLITE
      // side's RTCPeerConnection had gathered ZERO local ICE candidates and
      // just never tried again) NOR "just needs more time" (an extended
      // wait of 2-3 more minutes past the 60s deadline never once recovered
      // a stuck pair in ~8 hangs observed, and neither did an explicit
      // pc.restartIce() retry loop prototyped directly in static/rtc.js
      // during the investigation and then reverted — it made no measurable
      // difference). It reproduced identically with cheap 320x180
      // synthetic video for every participant, so it isn't an
      // encoding-cost/CPU-starvation artifact either (~40% hang rate at 5
      // participants with EITHER full-res or cheap video, over 10 runs
      // each) — it scales with the NUMBER of participants instead (~10% of
      // 3-participant runs vs ~40-50% of 5-participant runs hung, 10-20
      // runs each), i.e. with how many RTCPeerConnections get constructed
      // in the same synchronous burst when a participant joins a room that
      // already has several people in it (static/room.js: createRemotePeer,
      // called once per existing peer in a tight loop with no yield in
      // between) — a browser/OS concurrency limit this harness's "N full
      // Chrome contexts on one machine" pattern hits far more often than a
      // real call between N separate physical devices ever would (each
      // real participant's own browser only ever constructs ITS OWN
      // handful of RTCPeerConnections, not everyone else's simultaneously
      // too). Since a wedged RTCPeerConnection was never observed to
      // recover on its own or via an explicit ICE restart, the only thing
      // that reliably works is exactly what a human re-running this QA
      // tool already does: start over with a brand new room, which hands
      // everyone brand new RTCPeerConnection objects. Bounded (not
      // infinite) at 3 attempts — keeps the EXPECTED failure rate low
      // (~0.4³ ≈ 6%, roughly the ambient flakiness already tolerated
      // elsewhere in this app's multi-participant e2e coverage, see
      // resilience.spec.mjs) while keeping the worst case bounded (3 × 60s
      // = 3 minutes); this is a visual QA tool, not a merge-blocking gate,
      // so an occasional manual re-run on total exhaustion is acceptable.
      // Simply raising the settle timeout instead (as before, 30s → 60s)
      // would NOT have helped here — a wedged pair was never observed to
      // unstick itself no matter how long the FIRST attempt was allowed to
      // keep waiting, so a longer single wait just fails slower.
      const MESH_SETTLE_ATTEMPTS = 3;

      // Per-participant plan: cycle through ASPECTS; the LAST participant
      // goes camera-less when there are enough participants for it to read
      // clearly as "one of several, but no camera" (task spec item 3: only
      // when --users >= 4). Independent of which room attempt below we're
      // on, so built once, outside the retry loop.
      const participants = [];
      for (let i = 0; i < users; i++) {
        const isLast = i === users - 1;
        const noVideo = isLast && users >= 4;
        const aspect = ASPECTS[i % ASPECTS.length];
        const baseName = nameFor(i);
        const displayName = noVideo ? `${baseName} novideo` : `${baseName} ${aspect.label}`;
        const hue = Math.round((360 * i) / users);
        participants.push({
          index: i,
          isObserver: i === 0,
          noVideo,
          displayName,
          width: aspect.width,
          height: aspect.height,
          color: `hsl(${hue}, 60%, 38%)`,
        });
      }

      let allContexts = [];
      let observerPage = null;

      try {
        for (let attempt = 1; attempt <= MESH_SETTLE_ATTEMPTS; attempt++) {
          const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
          if (!res.ok) throw new Error(`POST /api/rooms responded with status ${res.status}`);
          const { roomId, leaderToken } = await res.json();
          const roomToken = generateRoomToken();
          const ROOM_NAME = 'Screenshot QA room';
          const creatorRoomUrl = leaderUrlWithKey(server.baseUrl, roomId, leaderToken, roomToken);
          const roomUrl = `${roomUrlWithKey(server.baseUrl, roomId, roomToken)}&n=${encodeURIComponent(ROOM_NAME)}`;

          console.log(
            `[screenshots] room ${roomId} (attempt ${attempt}/${MESH_SETTLE_ATTEMPTS}): ${participants.map((p) => p.displayName).join(', ')}`
          );

          allContexts = [];
          observerPage = null;

          // Joined SEQUENTIALLY (matching basic.spec.mjs's multi-participant
          // scenarios) — each join triggers new mesh connections to every
          // already-joined peer, so this is also a gentler ramp-up than
          // opening all N at once.
          for (const p of participants) {
            const context = p.isObserver
              ? await browser.newContext({
                  viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
                  deviceScaleFactor: DEVICE_SCALE_FACTOR,
                })
              : await browser.newContext();
            allContexts.push(context);

            await context.addInitScript(installSyntheticCamera(), {
              width: p.width,
              height: p.height,
              label: p.displayName,
              color: p.color,
              noCamera: p.noVideo,
            });

            const page = await context.newPage();

            if (p.isObserver) {
              // --- The creator (see design decision #1): sets the room name
              //     on the pre-join card, mic/camera start OFF (no
              //     getUserMedia at all on this screen) — turned on below,
              //     via the toolbar, like every other video-having
              //     participant. ---
              await page.goto(creatorRoomUrl);
              await joinRoom(page, p.displayName, { roomName: ROOM_NAME, closeSharePopup: false });

              // The Share popup auto-opens once, right here, for the creator
              // (see static/room.js: signaling.on('joined'),
              // shareAutoOpenedForCreator) — screenshot it (desktop + phone,
              // per the task spec) before closing it: it's a modal that would
              // otherwise swallow the clicks below. Only screenshotted on the
              // FIRST attempt — a retried room is an implementation detail of
              // getting the mesh to settle, not something worth a second set
              // of share-popup PNGs.
              await page.waitForSelector('#share-popup:not(.hidden)', { timeout: 8000 });
              if (attempt === 1) {
                for (const sizeName of ['desktop', 'phone-portrait']) {
                  const size = VIEWPORTS.find((v) => v.name === sizeName);
                  await page.setViewportSize({ width: size.width, height: size.height });
                  await sleep(SETTLE_MS);
                  const file = path.join(out, `share-popup-${sizeName}.png`);
                  await page.screenshot({ path: file });
                  writtenFiles.push(file);
                }
                await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height }); // back to desktop for the rest of the join sequence
              }
              await page.click('#share-popup-close');
              await page.waitForFunction(
                () => document.getElementById('share-popup')?.classList.contains('hidden'),
                undefined,
                { timeout: 3000 }
              );
              await waitForOverlayHidden(page);
              // The creator's camera is still off at this point (see the
              // comment above) — turn it on now, exactly like every other
              // video-having participant.
              await page.click('#camera-button');
            } else if (p.noVideo) {
              // --- The "no camera" guest (design decision #2): the guest
              //     pre-join card auto-acquires a combined mic+camera stream
              //     (see static/room.js: acquireGuestPrejoinMedia) — but
              //     installSyntheticCamera's `noCamera` stub above makes
              //     THAT SAME getUserMedia call reject outright, so there is
              //     nothing to wait for (unlike a normal guest — see the
              //     `else` branch below, which DOES wait via joinRoom's
              //     `micOff`/`camOff` options): we go straight to flipping
              //     the camera select to "Off" (the deliberate mechanism,
              //     see design decision #2) and submit directly. ---
              await page.goto(roomUrl);
              await waitForPrejoinCard(page);
              await setPrejoinDeviceOff(page, '#prejoin-cam-select');
              await page.fill('#join-name-input', p.displayName);
              await page.click('#join-modal-button');
              await waitForOverlayHidden(page);
            } else {
              // --- A regular video-having guest: leave the pre-join card's
              //     auto-acquired combined mic+camera stream live (task item
              //     3) — camera is ALREADY on by the time this resolves, so
              //     unlike the old flow we must NOT click #camera-button
              //     here: with a track already enabled, that click would
              //     TURN IT OFF (see static/room.js: cameraButton's click
              //     handler, the "already have a track" branch just toggles
              //     .enabled). ---
              await page.goto(roomUrl);
              await joinRoom(page, p.displayName, { micOff: false, camOff: false });
              await waitForOverlayHidden(page);
            }

            if (p.isObserver) observerPage = page;
          }

          // ---------- Wait for the mesh to settle before screenshotting ----------
          // Not a strict connectionState=='connected' check (this is a QA
          // tool, not a correctness test — see waitForAllConnectionsSettled in
          // helpers.mjs for that stricter variant) — just: all N tiles present
          // on the observer's page, and every video-carrying participant's
          // <video> element actually has decoded a frame (videoWidth > 0).
          const videoNames = participants.filter((p) => !p.noVideo).map((p) => p.displayName);
          // 60s (bumped from the pre-redesign 30s): with several GUESTS now
          // arriving with an already-live combined mic+camera stream (see
          // design decision #1/#2), createRemotePeer folds their tracks into
          // the very first offer to every existing peer rather than a later
          // renegotiation — functionally fine, but with N participants worth
          // of synthetic canvases + a 2x-scaled observer all fighting for CPU
          // on one machine, ICE/DTLS for the LAST pairs to settle can
          // genuinely take longer than 30s under load (verified empirically:
          // a single random participant's video would still be at
          // videoWidth===0 right at the old deadline, then arrive fine soon
          // after). NOT raised further (see MESH_SETTLE_ATTEMPTS above) —
          // past this point a stuck pair was proven to never recover within
          // the SAME room, so the retry loop starts a fresh one instead.
          let settled = false;
          try {
            await waitUntil(
              () =>
                observerPage.evaluate(
                  ({ count, names }) => {
                    if (document.querySelectorAll('.tile').length < count) return false;
                    return names.every((n) => {
                      const v = document.querySelector(`.tile[data-name="${n}"] video`);
                      return !!v && !v.classList.contains('hidden') && v.videoWidth > 0;
                    });
                  },
                  { count: users, names: videoNames }
                ),
              {
                timeoutMs: 60_000,
                intervalMs: 300,
                message: `mesh did not settle: expected ${users} tiles on the observer page, all video-carrying ones playing`,
              }
            );
            settled = true;
          } catch (err) {
            // A per-tile breakdown on failure — cheap and saves a re-run with
            // manual devtools poking when this QA tool itself misbehaves.
            const diag = await observerPage.evaluate((names) => ({
              tileCount: document.querySelectorAll('.tile').length,
              tileNames: Array.from(document.querySelectorAll('.tile')).map((t) => t.dataset.name),
              perName: names.map((n) => {
                const v = document.querySelector(`.tile[data-name="${n}"] video`);
                return { n, exists: !!v, hidden: v?.classList.contains('hidden'), videoWidth: v?.videoWidth };
              }),
            }), videoNames);
            console.error(`[screenshots] DIAGNOSTIC (attempt ${attempt}/${MESH_SETTLE_ATTEMPTS}):`, JSON.stringify(diag, null, 2));
            if (attempt === MESH_SETTLE_ATTEMPTS) throw err;
            console.log(
              `[screenshots] mesh did not settle on attempt ${attempt}/${MESH_SETTLE_ATTEMPTS} — closing these ${allContexts.length} contexts and retrying with a fresh room`
            );
            for (const context of allContexts) {
              await context.close();
            }
          }

          if (settled) break;
        }

        const actualTileCount = await observerPage.evaluate(() => document.querySelectorAll('.tile').length);
        console.log(`[screenshots] observer sees ${actualTileCount} tiles (expected ${users})`);

        // ---------- (b) Room screenshots at every viewport size ----------
        for (const size of VIEWPORTS) {
          await observerPage.setViewportSize({ width: size.width, height: size.height });
          await sleep(SETTLE_MS);
          const file = path.join(out, `room-${users}u-${size.name}.png`);
          await observerPage.screenshot({ path: file });
          writtenFiles.push(file);
        }

        // ---------- (c) Spotlight (maximized tile) screenshots ----------
        // Click a tile that has video to maximize it (see static/room.js:
        // maximizeTile/the tile click handler — clicking a tile WITHOUT
        // video is a no-op). Prefer a REMOTE participant's tile (proves
        // cross-participant maximize works, not just "maximize my own
        // tile"); participants[1] always has video unless --users == 1 (in
        // which case the observer IS the only tile, so we maximize its own).
        const spotlightTarget = participants.length > 1 ? participants[1] : participants[0];
        const spotlightSelector = tileSelector(spotlightTarget.displayName);

        await observerPage.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height }); // desktop, for a clean click target
        await sleep(SETTLE_MS);
        await observerPage.click(spotlightSelector);
        await observerPage.waitForFunction(
          (sel) => document.querySelector(sel)?.classList.contains('tile--maximized'),
          spotlightSelector,
          { polling: 100, timeout: 5000 }
        );

        for (const sizeName of ['desktop', 'phone-portrait']) {
          const size = VIEWPORTS.find((v) => v.name === sizeName);
          await observerPage.setViewportSize({ width: size.width, height: size.height });
          await sleep(SETTLE_MS);
          const file = path.join(out, `spotlight-${sizeName}.png`);
          await observerPage.screenshot({ path: file });
          writtenFiles.push(file);
        }

        // Click again to restore (un-maximize) — leaves the room in a clean
        // state, though nothing downstream actually depends on this since
        // the harness tears everything down right after.
        await observerPage.click(spotlightSelector);
        await observerPage.waitForFunction(
          (sel) => !document.querySelector(sel)?.classList.contains('tile--maximized'),
          spotlightSelector,
          { polling: 100, timeout: 5000 }
        );
      } finally {
        for (const context of allContexts) {
          await context.close();
        }
      }
    } finally {
      if (browser) await browser.close();
    }
  } finally {
    await server.stop();

    console.log('');
    console.log(`[screenshots] wrote ${writtenFiles.length} file(s) to ${out}:`);
    for (const f of writtenFiles) console.log(`  ${f}`);
  }
}

main().catch((err) => {
  console.error('[screenshots] FAILED:', err);
  process.exitCode = 1;
});
