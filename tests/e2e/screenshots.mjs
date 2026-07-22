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
//    is the one that gets resized across viewports and screenshotted. It
//    still turns its own camera on like everyone else, so its own tile shows
//    live synthetic video, not a placeholder.
//
// 2) The "no camera" participant (last one, only when --users >= 4, per the
//    task spec) is achieved by simply NEVER clicking that participant's
//    #camera-button — NOT by making getUserMedia() reject. We verified in
//    static/room.js that the app never calls getUserMedia() on its own: both
//    the mic and the camera are requested lazily, only from the
//    #mic-button/#camera-button click handlers (see cameraButton/micButton
//    addEventListener('click', ...) in room.js). A tile is created up front
//    with its video element hidden and the avatar placeholder shown (see
//    createTile in room.js) — that placeholder IS the "no camera" visual,
//    and it's already there before any getUserMedia call happens. So the
//    simplest, most realistic way to get a "no camera" tile is to just not
//    press the button. We still install a getUserMedia stub on that
//    participant's page for defense in depth (rejecting with NotFoundError,
//    the same DOMException name a real "no camera hardware" browser would
//    throw) — in case some future code path calls it automatically, the
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

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_FLAGS,
  buildServer,
  createServerController,
  joinRoom,
  waitForOverlayHidden,
  generateRoomToken,
  roomUrlWithKey,
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

      // ---------- Build the room: N participants, one of them the observer ----------
      //
      // Room created directly via POST /api/rooms (bypassing the landing
      // page's UI, exactly like basic.spec.mjs's "Chat history" and several
      // other scenarios do — see roomUrlWithKey/generateRoomToken in
      // helpers.mjs) — the link token (`t`) is generated test-side, the way
      // a real creator's browser would.
      const res = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
      if (!res.ok) throw new Error(`POST /api/rooms responded with status ${res.status}`);
      const { roomId } = await res.json();
      const roomToken = generateRoomToken();
      const roomUrl = `${roomUrlWithKey(server.baseUrl, roomId, roomToken)}&n=${encodeURIComponent('Screenshot QA room')}`;

      // Per-participant plan: cycle through ASPECTS; the LAST participant
      // goes camera-less when there are enough participants for it to read
      // clearly as "one of several, but no camera" (task spec item 3: only
      // when --users >= 4).
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

      console.log(`[screenshots] room ${roomId}: ${participants.map((p) => p.displayName).join(', ')}`);

      const allContexts = [];
      let observerPage = null;

      try {
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
          await page.goto(roomUrl);
          await joinRoom(page, p.displayName);
          await waitForOverlayHidden(page);

          if (!p.noVideo) {
            await page.click('#camera-button');
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
            timeoutMs: 30_000,
            intervalMs: 300,
            message: `mesh did not settle: expected ${users} tiles on the observer page, all video-carrying ones playing`,
          }
        );

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
