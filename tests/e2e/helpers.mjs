// tests/e2e/helpers.mjs — shared between *.spec.mjs: mini test runner
// step/skip, build/run/stop server (port as a parameter), stubs for
// getDisplayMedia/getUserMedia, chat helpers, waiting for the overlay to
// hide, Chrome launch flags. Extracted from basic.spec.mjs (see the decision
// history there — the file header explains why the stubs and
// waitForFunction calls are shaped this way).
//
// Nothing under static/*.js is touched or replaced by this file — only the
// test harness on the page side (addInitScript) and the server driver.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import nodeCrypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const BINARY_PATH = path.join(REPO_ROOT, 'target/debug/screenshare');

// --- S1 (E2E encryption v2, see static/crypto.js/docs/research-p2p-key-handoff.md
//     §6.5–6.6): PSK token `t` + expiry `e` in tests ---
//
// The link fragment format is now `#lt=<leaderToken>&t=<token>&e=<expiry>[&n=<roomName>]`
// (see static/landing.js/static/room.js) — `t` (16 random bytes, base64url,
// 22 characters) statically authenticates the room, `e` (unix seconds of
// expiry in base36) is baked into the K_auth derivation. Both are purely
// client-side: a real browser generates them on clicking "Create room" and
// the server never learns them. When a scenario creates a room DIRECTLY via
// `POST /api/rooms` (bypassing the landing page — most scenarios below do
// this, to avoid driving a real click on the button for every new room),
// `t`/`e` must appear on the test side the exact same way — the server will
// not hand them out.

const TOKEN_BYTES = 16; // must match LINK_TOKEN_BYTES in static/room.js / RoomCrypto.generateRoomToken()
const DEFAULT_LINK_LIFETIME_SECONDS = 10800; // same default as static/landing.js (fallback when lifetimeSeconds is absent from the POST /api/rooms response)
const LINK_EXPIRY_GRACE_SECONDS = 300; // +5 minutes — the same margin as static/landing.js: expiryB36

/** Random link PSK token (16 bytes, base64url without padding, 22 characters) — the same format as `RoomCrypto.generateRoomToken()+bytesToBase64url()`. */
export function generateRoomToken() {
  return nodeCrypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** `e` (base36 unix seconds) at `deltaSeconds` from now — a negative value gives an ALREADY expired link (see the "Link expired" test). */
export function expiryB36FromNow(deltaSeconds) {
  return (Math.floor(Date.now() / 1000) + deltaSeconds).toString(36);
}

/** Valid (non-expired) default `e` — as static/landing.js would compute it for a room with the default lifetime. */
export function defaultValidExpiryB36(lifetimeSeconds = DEFAULT_LINK_LIFETIME_SECONDS) {
  return expiryB36FromNow(lifetimeSeconds + LINK_EXPIRY_GRACE_SECONDS);
}

/**
 * Default `e` for a given token — DETERMINISTIC: the same token always gets
 * the same `e` within a single run (cache below).
 *
 * CRITICAL for E2E v2: `e` is baked into the K_auth derivation (see
 * static/crypto.js), so for all participants of ONE room `e` must match
 * character-for-character — otherwise the pairwise keys diverge and the very
 * first SDP produces a legitimate GCM failure "Link is invalid". Real users
 * share one link, so their `t`+`e` match by construction; the tests, however,
 * used to build the URL separately for each page, and two calls straddling a
 * second boundary got different `e` values — the source of a flaky mobile
 * smoke test failure (the desktop participant would fail).
 */
const defaultExpiryByToken = new Map();
function defaultExpiryForToken(token) {
  if (!defaultExpiryByToken.has(token)) {
    defaultExpiryByToken.set(token, defaultValidExpiryB36());
  }
  return defaultExpiryByToken.get(token);
}

/**
 * Build `t=...&e=...[&n=...]` — the body of a new link fragment (without `lt=`).
 * `t`/`e`, when not passed explicitly, are generated as valid (see above); the
 * default `e` is stable for a given `t` (see defaultExpiryForToken) —
 * participants of the same room whose URLs are built by independent calls
 * with the same token get an identical fragment, as if they shared one real
 * link.
 */
export function makeRoomFragment({ t, e, n } = {}) {
  const tok = t ?? generateRoomToken();
  const exp = e ?? defaultExpiryForToken(tok);
  let frag = `t=${tok}&e=${exp}`;
  if (n) frag += `&n=${encodeURIComponent(n)}`;
  return frag;
}

/**
 * Guest link: `<baseUrl>/r/<roomId>#t=<token>&e=<expiry>[&n=...]` — without
 * leaderToken (a guest does not become the leader). `token` — the `t` string
 * (usually generateRoomToken(), but a deliberately invalid string is also
 * allowed — see the "Link is invalid" test for a malformed format). `extra` —
 * optional `e`/`n` (defaults to a valid `e`, no room name).
 */
export function roomUrlWithKey(baseUrl, roomId, token, extra = {}) {
  return `${baseUrl}/r/${roomId}#${makeRoomFragment({ t: token, ...extra })}`;
}

/** Creator's link: `<baseUrl>/r/<roomId>#lt=<leaderToken>&t=<token>&e=<expiry>[&n=...]` — presents the leaderToken, becomes the leader. */
export function leaderUrlWithKey(baseUrl, roomId, leaderToken, token, extra = {}) {
  return `${baseUrl}/r/${roomId}#lt=${encodeURIComponent(leaderToken)}&${makeRoomFragment({ t: token, ...extra })}`;
}

/**
 * Read `t`/`e` (base64url/base36 strings as they sit in the fragment) from
 * the PAGE of an already-joined participant — the top-level `const
 * linkTokenBase64url`/`linkExpiry` in static/room.js, the same trick used to
 * read `leaderId`/`myPeerId`/`roomSettings`/`bus` in existing tests (a
 * classic-script top-level scope, not a module). Needed where the room was
 * created through the real landing page (t/e was generated by the browser
 * itself, the test doesn't know them in advance) — see basic.spec.mjs, the
 * room-creation-by-click scenario.
 */
export async function getRoomFragmentFromPage(page) {
  return page.evaluate(() => ({ t: linkTokenBase64url, e: linkExpiry }));
}

// How long to wait for a real getDisplayMedia in the broadcaster context
// before falling back to a synthetic source (see installCaptureStub).
export const REAL_CAPTURE_TIMEOUT_MS = 10_000;

// How long to wait for a real getUserMedia(audio) on the viewer before
// falling back to a synthetic source (see installMicStub).
export const REAL_MIC_TIMEOUT_MS = 5_000;

// How long to wait for a real getUserMedia(video) (camera) before falling
// back to a synthetic source (see installCamStub).
export const REAL_CAM_TIMEOUT_MS = 5_000;

export const CAPTURE_FLAGS = [
  '--auto-select-desktop-capture-source=Entire screen',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

// --- Mini runner: ok/FAIL line by line, without an external test runner ---
//
// Each *.spec.mjs calls createRunner() once and gets its own isolated
// counter (this matters: two specs in the same process wouldn't want to
// share counters otherwise — in practice specs are already separate
// processes, but the isolation is cheap and doesn't create hidden
// assumptions).
export function createRunner() {
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  async function step(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
      passedCount++;
      return true;
    } catch (err) {
      console.log(`FAIL - ${name}: ${err && err.message ? err.message : err}`);
      failedCount++;
      return false;
    }
  }

  function skip(name, reason) {
    console.log(`skip - ${name}: ${reason}`);
    skippedCount++;
  }

  function printSummary() {
    console.log('');
    console.log(`# total: ok=${passedCount} FAIL=${failedCount} skip=${skippedCount}`);
  }

  function bumpFailedForUnexpectedError() {
    failedCount++;
  }

  return {
    step,
    skip,
    printSummary,
    bumpFailedForUnexpectedError,
    get counts() {
      return { passedCount, failedCount, skippedCount };
    },
  };
}

// --- Server: build, start, wait for readiness, guaranteed kill ---

export async function buildServer() {
  console.log('# cargo build...');
  execFileSync('cargo', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(BINARY_PATH)) {
    throw new Error(`binary not found after build: ${BINARY_PATH}`);
  }
}

// Returns a controller for a server on a specific port: { baseUrl, start(), stop() }.
// Encapsulates its own process/tmp-dir — several independent servers could be
// started in a single file (not needed right now, but doesn't create hidden
// global state).
//
// `extraEnv` — extra server environment variables (e.g. EMPTY_ROOM_TTL_SECONDS
// for resilience.spec.mjs, the empty-room TTL scenario) — an optional second
// parameter that doesn't break existing single-argument calls (basic.spec.mjs).
export function createServerController(port, extraEnv = {}) {
  const baseUrl = `http://localhost:${port}`;
  let serverProcess = null;

  async function start() {
    serverProcess = spawn(BINARY_PATH, [], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        // ROOM_CREATION_IP_LIMIT: the prod default is tightened to 3/60s (see
        // state::DEFAULT_ROOM_CREATION_IP_LIMIT in src/state.rs) — the e2e
        // specs (basic.spec.mjs, resilience.spec.mjs) create/restore many
        // rooms from the same IP within a run (see the ROOM_CREATION_IP_LIMIT
        // comments there), so this controller's default env raises the limit
        // well beyond what a run could possibly flood — the same trick used
        // for JOIN_ROOM_IP_LIMIT in basic.spec.mjs. `extraEnv` below can
        // override it if needed.
        ROOM_CREATION_IP_LIMIT: '100000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLog = '';
    serverProcess.stdout.on('data', (d) => { serverLog += d.toString(); });
    serverProcess.stderr.on('data', (d) => { serverLog += d.toString(); });
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.log(`# server exited unexpectedly (code=${code}, signal=${signal})`);
        console.log(serverLog);
      }
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/`);
        if (res.ok) return;
      } catch {
        // server not up yet — wait a bit and try again
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`server did not respond at ${baseUrl}/ within 10s. Log:\n${serverLog}`);
  }

  async function stop() {
    if (!serverProcess) return;
    await new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      serverProcess.once('exit', done);
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!resolved) {
          serverProcess.kill('SIGKILL');
          done();
        }
      }, 3000);
    });
    serverProcess = null;
  }

  return { baseUrl, start, stop };
}

// --- Synthetic video source for when a real getDisplayMedia is unavailable.
//     Installed BEFORE any page scripts load, via addInitScript —
//     static/broadcaster.js is not touched. ---
//
// IMPORTANT (found while diagnosing a mic-renegotiation flake): attempting a
// real getDisplayMedia whose promise never resolves on this machine doesn't
// just cost 10 seconds at startup — the hung desktop-capture request stays
// alive in Chrome's media stack and then delays processing of subsequent
// media operations on the same page (the broadcaster's response to the
// viewer's mic-offer arrived exactly REAL_CAPTURE_TIMEOUT_MS after the
// offer). So by default we go straight to synthetic; a real capture attempt
// only happens with E2E_TRY_REAL_CAPTURE=1.
export function installCaptureStub() {
  return ({ tryReal, timeoutMs }) => {
    const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia
      ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      if (tryReal && realGetDisplayMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-capture-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(realGetDisplayMedia(constraints), timeoutMs);
          window.__e2eCaptureSource = 'real';
          return stream;
        } catch (err) {
          console.warn('[e2e] real getDisplayMedia did not succeed in time, falling back to synthetic source:', err);
        }
      }

      window.__e2eCaptureSource = 'synthetic';
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      let hue = 0;
      const draw = () => {
        hue = (hue + 3) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '20px sans-serif';
        ctx.fillText(String(Date.now()), 10, 30);
        window.__e2eSyntheticFrame = requestAnimationFrame(draw);
      };
      draw();
      return canvas.captureStream(30);
    };
  };
}

// --- Synthetic audio source for the viewer's microphone ---
//
// On this machine getUserMedia(audio) hangs forever even with permission
// granted (permissions.query -> 'granted') — we replace it with a Web Audio
// API oscillator -> MediaStreamAudioDestinationNode, a full live track that
// doesn't touch real audio hardware. static/viewer.js is unchanged — it
// calls getUserMedia({ audio: true }) as usual.
//
// IMPORTANT: "try the real getUserMedia first with Promise.race + setTimeout"
// is unreliable — by the time the viewer clicks the mic, the page may be
// backgrounded, and Chrome throttles timers on background pages, so the
// fallback could take tens of seconds and make the test flaky. By default —
// go straight to synthetic; real capture — E2E_TRY_REAL_MIC=1.
export function installMicStub() {
  return ({ tryReal, timeoutMs }) => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (tryReal && realGetUserMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-mic-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(realGetUserMedia(constraints), timeoutMs);
          window.__e2eMicSource = 'real';
          // Volume normalization: Chrome's fake audio device
          // (--use-fake-device-for-media-stream) outputs a very quiet tone —
          // RMS ~0.010–0.019, right at the edge of the product's "who is
          // speaking" detector threshold (0.02), which made the indicator
          // check flaky. We run the track through a GainNode ×6: the same
          // real getUserMedia path is exercised (permissions, device), but
          // the volume becomes deterministically "speech-like". We
          // deliberately don't tune the product's threshold to fit the test.
          const boostCtx = new (window.AudioContext || window.webkitAudioContext)();
          const boostSrc = boostCtx.createMediaStreamSource(stream);
          const gain = boostCtx.createGain();
          gain.gain.value = 6;
          const boostDst = boostCtx.createMediaStreamDestination();
          boostSrc.connect(gain);
          gain.connect(boostDst);
          return boostDst.stream;
        } catch (err) {
          console.warn('[e2e] real getUserMedia(audio) did not succeed in time, falling back to synthetic source:', err);
        }
      }

      window.__e2eMicSource = 'synthetic';
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCtor();
      const oscillator = audioCtx.createOscillator();
      oscillator.frequency.value = 440;
      const destination = audioCtx.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  };
}

// --- Synthetic video source for a participant's camera (protocol v2: room.js) ---
//
// room.js calls getUserMedia({ video: {...} }) for the camera and separately
// getUserMedia({ audio: true }) for the microphone — both through the same
// navigator.mediaDevices.getUserMedia. So that the camera and mic stubs can
// coexist on one page, this stub inspects the constraints itself: a request
// without constraints.video is transparently delegated to whatever
// getUserMedia function was installed BEFORE it (usually installMicStub) —
// the installation order in addInitScript matters: installMicStub first,
// then installCamStub (otherwise the delegation would go to the wrong
// place). A request with constraints.video is handled by this stub: like
// installCaptureStub, it first (behind a flag) tries a real getUserMedia
// with a timeout, otherwise goes straight to a synthetic
// canvas.captureStream() — the same logic used for the camera.
export function installCamStub() {
  return ({ tryReal, timeoutMs }) => {
    const previousGetUserMedia = navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const wantsVideo = !!(constraints && constraints.video);
      if (!wantsVideo) {
        if (previousGetUserMedia) return previousGetUserMedia(constraints);
        throw new Error('getUserMedia unavailable (no real implementation nor a previous stub)');
      }

      if (tryReal && previousGetUserMedia) {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('e2e-real-cam-timeout')), ms)),
          ]);
        try {
          const stream = await withTimeout(previousGetUserMedia(constraints), timeoutMs);
          window.__e2eCamSource = 'real';
          return stream;
        } catch (err) {
          console.warn('[e2e] real getUserMedia(video) did not succeed in time, falling back to synthetic source:', err);
        }
      }

      window.__e2eCamSource = 'synthetic';
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      let hue = 120;
      const draw = () => {
        hue = (hue + 2) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 45%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px sans-serif';
        ctx.fillText(String(Date.now()), 10, 30);
        window.__e2eCamFrame = requestAnimationFrame(draw);
      };
      draw();
      return canvas.captureStream(30);
    };
  };
}

// --- Mobile chat UX (wave 11): fake window.visualViewport ---
//
// There is no real virtual keyboard in headless Chromium (even with
// isMobile:true/hasTouch:true) — focusing a textarea doesn't open it and
// window.visualViewport never shrinks on its own, so testing how the
// full-screen mobile chat panel adapts to the keyboard (see
// static/chat.js: syncMobileChatViewport) requires a deterministic way to
// emulate its appearance. The real VisualViewport has almost all its
// properties (height/width/offsetTop/offsetLeft/scale) as read-only getters
// on the prototype, so they can't be assigned directly; instead, BEFORE the
// first navigation (see addInitScript) we replace the entire
// window.visualViewport with a plain EventTarget with the same property
// names (regular mutable fields, not getters) — chat.js works with it
// exactly the same way (feature-detect + addEventListener/height/
// offsetTop), the product code is unchanged and doesn't know the viewport is
// fake.
// window.__e2eSetVisualViewport(height, offsetTop) — invoked from the test
// to "shrink" the visible area (as if a keyboard grew from the bottom) and
// dispatch a 'resize' event, which chat.js listens for.
// IMPORTANT (found empirically): addInitScript runs at document CREATION
// time — BEFORE the HTML parser reaches <meta name="viewport">, so
// window.innerHeight/innerWidth, read SYNCHRONOUSLY RIGHT IN THE
// CONSTRUCTOR, on mobile emulation (isMobile:true) at that moment reflect a
// not-yet-applied viewport-meta and turn out to be wild numbers (observed:
// 844 -> 2121) — because of this, on the very first measurement the panel
// would "shrink" to the giant original size instead of the real viewport
// size, making it physically impossible to send a message (or tap a button)
// because the element was off-viewport. The fix — read
// innerHeight/innerWidth LAZILY through getters (the default value, as long
// as explicitTest hasn't set anything explicitly) — by the time chat.js
// actually accesses .height (after the chat is opened, much later than
// DOMContentLoaded), window.innerHeight is already correct.
export function installFakeVisualViewport(context) {
  return context.addInitScript(() => {
    class FakeVisualViewport extends EventTarget {
      constructor() {
        super();
        this._height = null;
        this._width = null;
        this._offsetTop = 0;
        this._offsetLeft = 0;
        this.scale = 1;
      }
      get height() {
        return this._height === null ? window.innerHeight : this._height;
      }
      set height(v) {
        this._height = v;
      }
      get width() {
        return this._width === null ? window.innerWidth : this._width;
      }
      set width(v) {
        this._width = v;
      }
      get offsetTop() {
        return this._offsetTop;
      }
      set offsetTop(v) {
        this._offsetTop = v;
      }
      get offsetLeft() {
        return this._offsetLeft;
      }
      set offsetLeft(v) {
        this._offsetLeft = v;
      }
    }
    const fake = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', {
      value: fake,
      configurable: true,
      writable: false,
    });
    window.__e2eSetVisualViewport = (height, offsetTop = 0) => {
      fake.height = height;
      fake.offsetTop = offsetTop;
      fake.dispatchEvent(new Event('resize'));
    };
  });
}

// --- Pre-join card (anonymity — see static/room.js) ---
//
// There is no more localStorage at all: the name is entered on the pre-join
// card on EVERY entry into the room (the first join and any page.reload() —
// a reconnect after a signaling drop WITHOUT reloading the page does not
// show the card again, see static/room.js). The room creator also goes
// through it — the landing page no longer asks for a name OR a room name at
// all, it only creates the room and redirects to /r/<id>#lt=<token>&t=...&e=...
// (no `&n=`) — the room's name is now chosen HERE, on this same card, once
// the roomId already exists (see static/room.js: showPrejoinCard/
// onPrejoinSubmit).
//
// ONE card, two personalities (kept ids #join-modal/#join-name-input/
// #join-name-regen-button/#join-modal-button are the same for both — the
// e2e suite has always depended on them, this redesign kept them stable):
//   - CREATOR (the URL carries the one-time `lt`, see static/room.js —
//     `isCreator`): eyebrow "Start the room", button "Start", an EDITABLE
//     #prejoin-room-name-input (prefilled with a generated name). Mic/camera
//     start OFF — showPrejoinCard never calls getUserMedia for the creator
//     at all (see the "Device defaults" comment there), so the creator's own
//     tile shows the avatar placeholder until a toolbar click.
//   - GUEST (no `lt`): eyebrow "Join the room", button "Join", a STATIC
//     #prejoin-room-name-static (the name from the invite link's `n`, or the
//     word "Room"). Mic AND camera start ON — the guest branch fires ONE
//     combined getUserMedia({audio:true,video:true}) the instant the card is
//     shown (see static/room.js: acquireGuestPrejoinMedia) — the exact
//     OPPOSITE of the old "everyone starts muted" default. That single
//     acquisition is fire-and-forget from the app's own perspective (nothing
//     in showPrejoinCard awaits it) and, once it resolves, unconditionally
//     turns both tracks on — see waitForGuestPrejoinMediaReady/
//     setPrejoinDeviceOff below for why a test that wants a muted/videoless
//     guest MUST wait for that resolution before touching the selects,
//     rather than racing it.
//
// `opts`:
//   - `roomName` — CREATOR ONLY: types this into #prejoin-room-name-input
//     before submitting (leaving it untouched keeps the generated default —
//     see static/room.js: NameGen.roomName()). Throws if passed for a guest
//     card — that field doesn't exist for a guest (the room name arrives
//     from the invite link's `n` instead, read-only).
//   - `micOff`/`camOff` (default `true` for BOTH) — GUEST ONLY, no-op for
//     the creator (whose mic/camera have nothing to wait for — see above).
//     The overwhelming majority of existing scenarios were written for the
//     OLD "fresh participant is muted, no video, must click the toolbar"
//     baseline (no crown/no "speaking"/clicking a video-less tile is a
//     no-op/etc.) — defaulting both to `true` reproduces exactly that
//     baseline against the new combined-acquisition guest flow: we wait for
//     the one-shot acquisition to land (waitForGuestPrejoinMediaReady) and
//     then flip the corresponding select(s) to "Off" (setPrejoinDeviceOff).
//     Pass `{ micOff: false }`/`{ camOff: false }` for a scenario that
//     specifically wants to exercise the new "guest arrives with live media"
//     behavior instead (see the dedicated coverage in basic.spec.mjs).
//   - `closeSharePopup` (default `true`) — CREATOR ONLY, no-op for a guest
//     (whose Share popup never auto-opens at all — see static/room.js:
//     `isCreator &&` guard in signaling.on('joined')). Task item 2: the
//     Share popup now auto-opens ONCE for the creator right after this very
//     join — it's a modal (backdrop + aria-modal) that would otherwise
//     swallow whatever click a scenario makes next, so by default we wait
//     for it and close it here, transparently, for every one of this file's
//     ~40 existing call sites. Pass `{ closeSharePopup: false }` for a
//     scenario that wants to inspect the auto-opened popup itself before
//     deciding what to do with it.
//
// The #join-name-input field is pre-filled with a generated name (see
// static/room.js: showPrejoinCard, NameGen.userName()) — without an explicit
// `name` the test wants to join anonymously, as before, rather than carry a
// random generated name into the room. That's why the fill is
// unconditional: `name ?? ''` overwrites the pre-fill with an empty string
// when no name is passed, and types `name` when it is passed — this
// preserves the previous deterministic semantics of joinRoom(page) across
// this file's many existing call sites (including the filler pages in
// resilience.spec.mjs and the retry path in waitForMeshSettled below).
export async function joinRoom(page, name, opts = {}) {
  const { roomName, micOff = true, camOff = true, closeSharePopup = true } = opts;
  await waitForPrejoinCard(page);

  const isCreatorCard = await page.evaluate(
    () => !document.getElementById('prejoin-room-name-editable')?.classList.contains('hidden')
  );

  if (isCreatorCard) {
    if (roomName !== undefined) {
      await page.fill('#prejoin-room-name-input', roomName);
    }
  } else {
    if (roomName !== undefined) {
      throw new Error('joinRoom: the `roomName` option only applies to a CREATOR card (the room name field is read-only for a guest)');
    }
    if (micOff || camOff) {
      // MUST happen before flipping the selects — see the file-header
      // comment on waitForGuestPrejoinMediaReady below: acquireGuestPrejoinMedia
      // turns both tracks on unconditionally the moment its getUserMedia
      // resolves, clobbering an "Off" set any earlier.
      await waitForGuestPrejoinMediaReady(page);
      if (micOff) await setPrejoinDeviceOff(page, '#prejoin-mic-select');
      if (camOff) await setPrejoinDeviceOff(page, '#prejoin-cam-select');
    }
  }

  await page.fill('#join-name-input', name ?? '');
  await page.click('#join-modal-button');

  if (isCreatorCard && closeSharePopup) {
    await page.waitForSelector('#share-popup:not(.hidden)', { timeout: 8000 });
    await page.click('#share-popup-close');
    await page.waitForFunction(
      () => document.getElementById('share-popup')?.classList.contains('hidden'),
      undefined,
      { timeout: 3000 }
    );
  }
}

/** Wait for the pre-join card (creator "Start the room" or guest "Join the room" — see static/room.js: showPrejoinCard) to become visible. Shared by joinRoom above and any scenario that wants to inspect the card BEFORE calling joinRoom (e.g. checking the dynamic button label or the mic/camera defaults). */
export async function waitForPrejoinCard(page, timeoutMs = 10_000) {
  await page.waitForSelector('#join-modal:not(.hidden)', { timeout: timeoutMs });
}

/**
 * GUEST ONLY: wait until the pre-join card's one-shot combined
 * getUserMedia({audio:true,video:true}) (see static/room.js:
 * acquireGuestPrejoinMedia) has actually been applied — i.e. both camTrack
 * and micTrack (top-level `let`s in room.js, a classic script — the same
 * trick already used elsewhere in this file to read linkTokenBase64url/
 * linkExpiry directly via page.evaluate) are non-null.
 *
 * MUST be awaited before calling setPrejoinDeviceOff on either select:
 * acquireGuestPrejoinMedia calls applyMicStream/applyCameraStream (turning
 * both tracks on) the moment its getUserMedia call resolves, REGARDLESS of
 * anything a test did to the selects in the meantime — flipping a select to
 * "Off" before this resolves would just get silently clobbered back to "on"
 * a moment later. Both tracks become non-null in the same synchronous
 * block (no `await` between extracting the audio/video tracks of the one
 * combined MediaStream and applying each), so there is no further race
 * between the two — waiting for either is equivalent to waiting for both,
 * but we check both for clarity/robustness against that implementation
 * detail changing.
 *
 * Not meaningful for the creator (whose mic/camera are never acquired on
 * this screen at all — see showPrejoinCard's "Device defaults" comment) —
 * calling this on a creator card would simply hang until timeoutMs.
 */
export async function waitForGuestPrejoinMediaReady(page, timeoutMs = 8000) {
  await page.waitForFunction(
    () => typeof camTrack !== 'undefined' && !!camTrack && typeof micTrack !== 'undefined' && !!micTrack,
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

/**
 * Flip a pre-join device select (#prejoin-mic-select or #prejoin-cam-select)
 * to "Off" — selecting by the visible option LABEL ("Off") rather than the
 * internal sentinel value (see static/room.js: PREJOIN_DEVICE_OFF —
 * `'__off__'`), so the test doesn't depend on that implementation detail.
 * Playwright's selectOption dispatches a real 'change' event itself, the
 * same one static/room.js's prejoinMicSelectEl/prejoinCamSelectEl 'change'
 * listeners react to (stopPrejoinMic/stopPrejoinCamera).
 */
export async function setPrejoinDeviceOff(page, selector) {
  await page.selectOption(selector, { label: 'Off' });
}

/**
 * Lobby "waiting for approval" sub-state of the pre-join card (see
 * static/room.js: signaling.on('waiting')/setPrejoinWaitingMode) — task item
 * 3: this NO LONGER shows the full-screen #overlay (that's what the OLD
 * waitOverlayTitle(page, 'Waiting for approval…') checked, and it now hangs
 * forever). The guest stays on the SAME pre-join card, just with its
 * interactive controls (mic/cam rows, name field, Start/Join button) swapped
 * for the waiting block (#prejoin-waiting) — the header and the live
 * preview underneath are untouched, see static/room.js for why.
 */
export async function waitPrejoinWaiting(page, timeoutMs = 10_000) {
  await page.waitForSelector('#prejoin-waiting:not(.hidden)', { timeout: timeoutMs });
}

// --- S1 (E2E encryption): spy on ALL frames of the server WebSocket ---
//
// The same trick as installChatWsSpy/installPcRegistry (see basic.spec.mjs)
// — wraps window.WebSocket before the first navigation (addInitScript). Unlike
// installChatWsSpy (which only cares about `type==='chat'`), this spy
// collects ABSOLUTELY EVERYTHING the page sends over the socket — needed for
// S1 checks: both `join-room` (must not contain a plaintext name) and
// `offer`/`answer` (the SDP must already be an encrypted blob, not plaintext
// with "v=0"/fingerprint).
export function installSignalingFrameSpy(context) {
  return context.addInitScript(() => {
    window.__e2eAllFramesSent = [];
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(...args) {
        super(...args);
        const realSend = this.send.bind(this);
        this.send = (data) => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.type === 'string') {
              window.__e2eAllFramesSent.push(parsed);
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

export async function allFramesSentOn(page) {
  return page.evaluate(() => window.__e2eAllFramesSent || []);
}

/** Frames of a given `type` from allFramesSentOn(page) — a shorthand for a common filter. */
export async function framesOfTypeSentOn(page, type) {
  const frames = await allFramesSentOn(page);
  return frames.filter((f) => f && f.type === type);
}

/**
 * F3 (repeated offer/answer/ice over the bus, see static/rtc.js): wait until
 * the DataChannel bus (static/bus.js: bus.isOpen) is open with ALL other
 * participants on this page. `bus` — a plain top-level `const` in room.js
 * (a classic script, not a module — the same trick as with
 * ChatPanel/leaderId in the other helpers in this file), so it's visible
 * directly from page.evaluate().
 *
 * Needed to rule out the race "pc.connectionState is already 'connected'
 * (see waitForAllConnectionsSettled above), but the bus's own SCTP handshake
 * hasn't finished yet" before the test deliberately triggers a renegotiation
 * (addTrack when turning on the camera/mic/screen share) and checks that
 * offer/answer/ice go over the bus at that point, not through the server.
 */
export async function waitForBusOpenToAllPeers(page, timeoutMs = 8000) {
  await page.waitForFunction(
    () => {
      const tiles = Array.from(document.querySelectorAll('.tile:not(.tile--own)'));
      if (tiles.length === 0) return false;
      return tiles.every((t) => typeof bus !== 'undefined' && bus.isOpen(t.dataset.peerId));
    },
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

/** "Link is incomplete" overlay (S1: no valid `t`/`e`, or an invalid token — see static/room.js: showInvalidLinkOverlay). */
export async function waitInvalidLinkOverlay(page, timeoutMs = 10_000) {
  await page.waitForFunction(
    () => document.getElementById('overlay-title')?.textContent === 'Link is invalid',
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

/** "Link expired" overlay (S1 v2: the fragment's `e` is in the past beyond LINK_EXPIRY_GRACE_SECONDS — see static/room.js: showLinkExpiredOverlay). */
export async function waitLinkExpiredOverlay(page, timeoutMs = 10_000) {
  await page.waitForFunction(
    () => document.getElementById('overlay-title')?.textContent === 'Link expired',
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

// --- RTCPeerConnection registry for waiting for a real "connections settled" ---
//
// F0 (see static/rtc.js): every pair sets up a DataChannel bus right at room
// entry (createDataChannel on the impolite side, ondatachannel on the polite
// side), not on a user click — meaning SDP negotiation for EVERY pair starts
// almost immediately after join, before any media is turned on. While
// investigating a hang flakiness (see history: a symmetric negotiated
// channel with id=0 on both sides sometimes didn't trigger
// onnegotiationneeded at all for one of several RTCPeerConnections created
// on a page nearly simultaneously), a product bug was found and fixed —
// static/rtc.js now uses the classic one-directional scheme
// (createDataChannel only on the impolite side, ondatachannel on the polite
// side), the same scheme already verified for media tracks before F0. The
// registry here and waitForAllConnectionsSettled/waitForMeshSettled below
// are kept as a cheap test-side safety net (waiting for a real
// connectionState==='connected' is more reliable and faster than guessing
// with timers) — this costs basic.spec.mjs/resilience.spec.mjs nothing, and
// the nested retry for the rare ICE stall (setOffline, an overloaded CI
// runner, etc.) won't hurt.
//
// installPcRegistry doesn't touch static/*.js — it only wraps
// window.RTCPeerConnection in addInitScript, the same way installChatWsSpy
// wraps WebSocket in basic.spec.mjs.
export function installPcRegistry(context) {
  return context.addInitScript(() => {
    window.__e2ePcs = [];
    const RealPC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends RealPC {
      constructor(...args) {
        super(...args);
        window.__e2ePcs.push(this);
      }
    };
  });
}

// Wait until at least `expectedCount` RTCPeerConnections have been
// registered on the page and ALL of them have connectionState ===
// 'connected'. Requires installPcRegistry(context) before navigation.
export async function waitForAllConnectionsSettled(page, expectedCount, timeoutMs = 12000) {
  await page.waitForFunction(
    (n) => {
      const pcs = window.__e2ePcs || [];
      if (pcs.length < n) return false;
      return pcs.every((pc) => pc.connectionState === 'connected');
    },
    expectedCount,
    { polling: 100, timeout: timeoutMs }
  );
}

// --- Wait for "mesh settled", with a safety-net retry via rejoin ---
//
// Wait for tiles and connectionState==='connected' on all mesh connections
// of the page. Wrapped in a couple of attempts with page.reload() between
// them — a cheap safety net in case of a single real ICE stall in
// CI/sandbox (network, an overloaded runner), unrelated to a specific
// protocol bug.
export async function waitForMeshSettled(pages, { tileCount, connectionsPerPage, attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      for (const page of pages) {
        await page.waitForFunction(
          (n) => document.querySelectorAll('.tile').length === n,
          tileCount,
          { polling: 100, timeout: 10_000 }
        );
      }
      for (const page of pages) {
        await waitForAllConnectionsSettled(page, connectionsPerPage);
      }
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(
        `[waitForMeshSettled] attempt ${attempt}/${attempts} did not settle (${err.message}) — rejoining the room and trying again`
      );
      for (const page of pages) {
        // page.reload() — a full reload (not an in-tab auto-reconnect) — the
        // join modal appears again (anonymity, see static/room.js), the name
        // doesn't matter for this safety net — we just click "Join" without
        // a name (joinRoom(page) without a second argument overwrites the
        // NameGen.userName() pre-fill with an empty string, see joinRoom
        // above), to end up back in the room anonymously.
        await page.reload();
        await joinRoom(page);
        await waitForOverlayHidden(page);
      }
    }
  }
}

// --- Helper functions for pages ---

// Waits for the viewer to actually be watching the stream. Chrome blocks
// autoplay of an unmuted <video> without a user interaction on the page —
// in that case viewer.js itself shows a "Click to start watching" button
// (see static/viewer.js: attemptPlay()). This is expected app behavior, not
// a bug — so the test emulates a real user and clicks the button if it
// appears, instead of working around it.
// Important: NOT page.waitForSelector('#overlay.hidden') — by default it
// waits for the matched element to be visible, and an element with the
// .hidden class is exactly display:none (see static/style.css), so such a
// selector would never resolve. We check classList directly via
// waitForFunction.
export async function waitForOverlayHidden(page, timeoutMs = 20_000) {
  const isOverlayHidden = () => document.getElementById('overlay').classList.contains('hidden');
  const outcome = await Promise.race([
    page.waitForFunction(isOverlayHidden, undefined, { polling: 100, timeout: timeoutMs }).then(() => 'hidden'),
    page.waitForSelector('#play-button:not(.hidden)', { timeout: timeoutMs }).then(() => 'play-button'),
  ]);
  if (outcome === 'play-button') {
    await page.click('#play-button');
    await page.waitForFunction(isOverlayHidden, undefined, { polling: 100, timeout: 5000 });
  }
}

// Check that the video is actually playing: videoWidth/readyState right
// away, and currentTime growing after waitMs. Used both in basic.spec.mjs
// (right after connecting — for both the room.js version of the test and a
// different <video> — see `selector`), and in resilience.spec.mjs (after
// reload, the old viewer.js with a single #remote-video — which is why
// `selector` defaults to it, for backward compatibility).
export async function assertVideoPlaying(
  page,
  { selector = '#remote-video', waitMs = 2000, warmupTimeoutMs = 5000 } = {}
) {
  // videoWidth may lag the moment the overlay hid / the track connected
  // (synchronously, but decoding the first frame is not) by a couple of
  // frames — especially noticeable right after reload(), when the whole
  // page (and the WebRTC stack) comes up from scratch. So we first wait for
  // the first frame by polling, rather than assuming videoWidth>0
  // immediately.
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.videoWidth || 0) > 0,
    selector,
    { polling: 100, timeout: warmupTimeoutMs }
  );

  const before = await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { videoWidth: v.videoWidth, readyState: v.readyState, currentTime: v.currentTime };
  }, selector);
  assert.ok(before.videoWidth > 0, `videoWidth should be > 0, got ${before.videoWidth}`);
  assert.ok(before.readyState >= 2, `readyState should be >= 2, got ${before.readyState}`);

  await new Promise((r) => setTimeout(r, waitMs));

  const after = await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { currentTime: v.currentTime };
  }, selector);
  assert.ok(
    after.currentTime > before.currentTime,
    `currentTime should have grown over ${waitMs}ms: was ${before.currentTime}, now ${after.currentTime}`
  );
}

// Placeholder "You are sharing your screen" instead of a live preview for
// the SHARER (see static/room.js: showLocalScreenPreview) — a recursive
// self-capture of the "entire screen" would otherwise produce a "mirror
// corridor" (a trail of cursors, visible buffer freeze on macOS, especially
// in fullscreen). We check both that the placeholder is visible and that
// the video is actually not connected (not just visually covered) —
// otherwise the recursion would still happen invisibly to the test.
export async function assertLocalScreenPlaceholder(page, timeoutMs = 5000) {
  await page.waitForFunction(
    () => {
      const placeholder = document.getElementById('screen-self-placeholder');
      const video = document.getElementById('screen-video');
      return (
        !!placeholder &&
        !placeholder.classList.contains('hidden') &&
        !!video &&
        video.classList.contains('hidden') &&
        !video.srcObject
      );
    },
    undefined,
    { polling: 100, timeout: timeoutMs }
  );
}

// State of the screen-share fullscreen button (#screen-fullscreen-button) —
// for the person sharing themselves it's hidden and disabled (no point in
// fullscreening the placeholder, see updateFullscreenButtonState in
// static/room.js), for a viewer it stays normal.
export async function assertScreenFullscreenButtonState(page, { hidden, disabled }) {
  const state = await page.evaluate(() => {
    const btn = document.getElementById('screen-fullscreen-button');
    return btn ? { hidden: btn.classList.contains('hidden'), disabled: btn.disabled } : null;
  });
  assert.ok(state, '#screen-fullscreen-button should be in the DOM');
  assert.equal(state.hidden, hidden, `screen-fullscreen-button.hidden: expected ${hidden}, got ${state.hidden}`);
  assert.equal(
    state.disabled,
    disabled,
    `screen-fullscreen-button.disabled: expected ${disabled}, got ${state.disabled}`
  );
}

export async function getChatDom(page) {
  return {
    toggleButton: page.locator('#chat-button'),
    unreadBadge: page.locator('.chat-unread-badge'),
    panel: page.locator('.chat-panel'),
    messages: page.locator('.chat-message-text'),
    textInput: page.locator('.chat-text-input'),
    sendButton: page.locator('.chat-send-button'),
    errorBanner: page.locator('.chat-error-banner'),
  };
}

// Idempotent: if the panel is already open — just make sure it's visible.
// The toggle button (#chat-button in the control pill) is always present
// and visible — unlike the old floating button, it no longer hides while
// chat is open, it just toggles open/closed (see chat.js: toggleButton
// click).
export async function openChatPanel(page) {
  const chat = await getChatDom(page);
  const alreadyOpen = await chat.panel.evaluate((el) => !el.classList.contains('hidden'));
  if (!alreadyOpen) {
    await chat.toggleButton.click();
  }
  await chat.panel.waitFor({ state: 'visible' });
}

export async function sendChatMessage(page, text) {
  const chat = await getChatDom(page);
  await chat.textInput.fill(text);
  await chat.sendButton.click();
}

export async function messageTextsInclude(page, text, timeoutMs = 5000) {
  const chat = await getChatDom(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = await chat.messages.allTextContents();
    if (texts.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Wait for a rendered MULTI-LINE message from `lines` (see
 * static/chat.js: renderMessageBody inserts <br> between lines, NOT a text
 * '\n' — so a multi-line message's `.textContent` is the lines joined
 * WITHOUT a separator, e.g. ['a','b'] -> textContent "ab", NOT "a\nb";
 * `messageTextsInclude` with text containing a literal '\n' will therefore
 * never match the real textContent — this helper checks multi-line
 * rendering correctly: the concatenated lines match the container's
 * textContent AND there are at least `lines.length - 1` <br> elements
 * inside it (proving that a line break was actually applied, not just
 * visually matching text without a break).
 */
export async function messageWithLineBreaksIncludes(page, lines, timeoutMs = 5000) {
  const expectedConcat = lines.join('');
  const minBreaks = lines.length - 1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(
      ({ expectedConcat, minBreaks }) => {
        const els = Array.from(document.querySelectorAll('.chat-message-text'));
        return els.some(
          (el) => el.textContent === expectedConcat && el.querySelectorAll('br').length >= minBreaks
        );
      },
      { expectedConcat, minBreaks }
    );
    if (found) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Send a text message and return its generated id (see chat.js:
 * dataset.msgId on .chat-message) — needed when the message will later be
 * edited/deleted in the test and its TEXT stops being a stable anchor for
 * finding the element (unlike the id, which doesn't change). The id is
 * shared across all participants (the same envelope), so it can also be
 * used to find `.chat-message[data-msg-id="..."]` on other pages.
 */
export async function sendChatMessageAndGetId(page, text) {
  await sendChatMessage(page, text);
  const id = await page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll('.chat-message--own'));
    for (let i = items.length - 1; i >= 0; i--) {
      const textEl = items[i].querySelector('.chat-message-text');
      if (textEl && textEl.textContent === t) return items[i].dataset.msgId;
    }
    return null;
  }, text);
  return id;
}

// --- Message action popover (wave 13) — replaces the hover-buttons/on-tap
// action-row of previous waves: the only way to reach a message's actions
// now is a tap/click on the message itself, see static/chat.js:
// openMessagePopover/closeMessagePopover. A single singleton per panel (not
// one per message) — all the `.chat-message-popover *` locators below work
// THE SAME WAY on mobile (bottom-sheet) and desktop (popover next to the
// message).

/**
 * Open the actions popover for message `messageLocator` (already filtered
 * `.chat-message`, e.g. `page.locator('.chat-message', { hasText }).last()`).
 * The click targets `.chat-message-meta` (the name+time row): it never
 * contains links/reaction chips/spoilers, so it doesn't risk hitting an
 * element with its own separate click logic (unlike clicking the whole
 * `.chat-message-text`, which for formatted messages may contain a
 * link/spoiler).
 */
export async function openMessagePopoverFor(page, messageLocator) {
  await messageLocator.locator('.chat-message-meta').click();
  await page.locator('.chat-message-popover:not(.hidden)').waitFor({ state: 'visible', timeout: 3000 });
}

/** Close the actions popover via the close (X) button (see openMessagePopoverFor). */
export async function closeMessagePopover(page) {
  await page.click('.chat-message-popover-close');
  await page.waitForFunction(
    () => document.querySelector('.chat-message-popover')?.classList.contains('hidden'),
    undefined,
    { timeout: 2000 }
  );
}

/** Popover action locator by class suffix (reply/react/edit/delete/copy) — there's one popover per page, so no need to scope it to a specific message. */
export function popoverAction(page, suffix) {
  return page.locator(`.chat-message-popover .chat-message-action--${suffix}`);
}

/** Click an emoji in the popover's reaction palette (see .chat-message-popover-emoji). */
export async function clickPopoverEmoji(page, emoji) {
  await page.locator(`.chat-message-popover-emoji[data-emoji="${emoji}"]`).click();
}

/** Reaction breakdown rows "who/which/when" in the open popover (see .chat-message-popover-reaction-row). */
export function popoverReactionRows(page) {
  return page.locator('.chat-message-popover-reaction-row');
}

// --- File transfer (F3): generating test files and an injection helper ---
//
// The PNG is assembled by hand (signature + IHDR + a single IDAT with random
// pixels compressed via zlib.deflateSync, + IEND) — this way the test
// doesn't pull in third-party dependencies (canvas/pngjs) and doesn't have
// to fuss with browser-side canvas.toBlob(). Pixels are random on purpose: a
// PNG with random noise barely compresses, so the resulting file size is
// predictably close to the raw size (width×height×4 + row overhead bytes),
// instead of collapsing to a few bytes as it would with a solid fill.

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** A valid PNG (RGBA, 8-bit) of the given dimensions with random pixels — file size ~width*height*4 bytes. */
export function makeTestPngBuffer({ width = 112, height = 112 } = {}) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: None
    for (let x = 0; x < width * 4; x++) {
      raw[offset++] = Math.floor(Math.random() * 256);
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** A text "file" of the given size (a repeating ASCII phrase) — for checking transfer of an arbitrary (non-image) file. */
export function makeTestTextFileBuffer(sizeBytes) {
  const phrase = Buffer.from('The quick brown fox jumps over the lazy dog. ', 'ascii');
  const buf = Buffer.alloc(sizeBytes);
  let pos = 0;
  while (pos < sizeBytes) {
    const n = Math.min(phrase.length, sizeBytes - pos);
    phrase.copy(buf, pos, 0, n);
    pos += n;
  }
  return buf;
}

/**
 * A valid WAV (16-bit PCM, a 440Hz tone of the given duration) — trivially a
 * real audio container (RIFF/WAVE/fmt/data header per spec), no third-party
 * dependencies/codecs needed, Chromium actually plays it and reports the
 * duration via `loadedmetadata` deterministically (unlike video containers,
 * see TINY_WEBM_BASE64 below). File size and duration are directly related
 * (durationSeconds * sampleRate * 2 bytes + 44 header bytes) — both
 * properties are checked in the tests.
 */
export function makeTestWavBuffer({ durationSeconds = 1, sampleRate = 8000, numChannels = 1 } = {}) {
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const numSamples = Math.round(durationSeconds * sampleRate);
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // subchunk1 size (PCM)
  buf.writeUInt16LE(1, 20); // audio format = PCM (uncompressed)
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  // Not pure digital silence (though that would be valid too) — a simple
  // 440Hz tone, so the file doesn't look "empty" on manual inspection.
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000);
    for (let ch = 0; ch < numChannels; ch++) {
      buf.writeInt16LE(sample, 44 + i * blockAlign + ch * 2);
    }
  }
  return buf;
}

// --- A tiny but REAL valid WebM container (video) ---
//
// Unlike WAV (trivially assembled by hand per spec), a valid video container
// can't be hand-built — we use a pre-generated (offline, via ffmpeg) minimal
// VP8/WebM: 64×64, 5 fps, 1 second, no audio (`ffmpeg -f lavfi -i
// color=c=blue:s=64x64:d=1:r=5 -c:v libvpx -crf 40 -b:v 40k -an tiny.webm`)
// — hardcoded as base64, the tests don't regenerate it and don't require a
// third-party binary dependency (ffmpeg) on the test machine. Chromium
// actually plays this file and reports duration≈1s via `loadedmetadata` —
// the test below verifies this.
const TINY_WEBM_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJnEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggJR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDBXQYxMYXZmNjEuNy4xMDBEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIa65O3zZP2V+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgUC6gUCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAwc3PWY8CLY8WIa65O3zZP2V9nyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QKjngQCjw4EAAICQAwCdASpAAEAAAEcIhYWIhYSIAgICdaoD+AIG6EFcMdITAFVYAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjloEAyADRAQAHEOwAGAAYWC/0AAiOgACjloEBkADRAQAHEOwAGAAYWC/0AAiOgACjloECWADRAQAHEOwAGAAYWC/0AAiOgACjloEDIADRAQAHEOwAGAAYWC/0AAiOgAAcU7trkbuPs4EAt4r3gQHxggGj8IED';

export function makeTestWebmBuffer() {
  return Buffer.from(TINY_WEBM_BASE64, 'base64');
}

/**
 * Inject files into chat via the hidden paperclip `<input type=file>` (see
 * static/chat.js: buildDom -> .chat-file-input). setInputFiles doesn't
 * require the element to be visible (unlike click) — it works even while
 * the input itself is `hidden`, so opening the panel first isn't required,
 * though the tests open it anyway for other checks nearby. `files` — an
 * array of { name, mimeType, buffer } (see Playwright FilePayload).
 */
export async function attachFilesToChat(page, files) {
  await page.locator('.chat-file-input').setInputFiles(files);
}

export async function unreadBadgeCount(page) {
  const chat = await getChatDom(page);
  const hidden = await chat.unreadBadge.evaluate((el) => el.classList.contains('hidden'));
  if (hidden) return 0;
  const text = await chat.unreadBadge.textContent();
  return Number(text);
}

// --- Observer for the broadcaster's viewer counter (#viewer-count) ---
//
// A MutationObserver captures EVERY textContent change synchronously (a
// microtask per mutation), unlike interval polling — it won't miss a brief
// counter "dip" (e.g. 1 -> 0 -> 1 on viewer reconnect), even if the dip
// itself lasts milliseconds. Installed once (after #live-section appears,
// the element already exists).
export async function installViewerCountHistory(broadcasterPage) {
  await broadcasterPage.evaluate(() => {
    const el = document.getElementById('viewer-count');
    if (!window.__viewerCountHistory) {
      window.__viewerCountHistory = [el.textContent];
      new MutationObserver(() => {
        window.__viewerCountHistory.push(el.textContent);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
}

export async function viewerCountHistoryLength(broadcasterPage) {
  return broadcasterPage.evaluate(() => (window.__viewerCountHistory || []).length);
}

export async function viewerCountHistorySince(broadcasterPage, fromIndex) {
  return broadcasterPage.evaluate(
    (i) => (window.__viewerCountHistory || []).slice(i),
    fromIndex
  );
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Polling of an arbitrary condition with a deadline — used where
// page.waitForFunction doesn't fit (e.g. the condition depends on several
// pages/values at once). Never sleeps "blindly" for a fixed time — always
// checks the condition and finishes early as soon as it's met.
export async function waitUntil(conditionFn, { timeoutMs = 10_000, intervalMs = 150, message = 'condition not met' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() >= deadline) throw new Error(`${message} (timeout ${timeoutMs}ms)`);
    await sleep(intervalMs);
  }
}

