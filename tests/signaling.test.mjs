// Signaling integration test (protocol v3+ — symmetric room: all
// participants are equal, mesh, screen sharing — room state is ephemeral; chat
// never goes through the server at all — only the P2P bus, the server-side fallback
// relay for chat was removed, see docs/chat.md/src/ws.rs). Runs the full lifecycle against
// a SELF-managed server (builds via cargo build, starts
// ./target/debug/screenshare on port 3311, and reliably cleans up
// after itself). Plain Node >= 22, global WebSocket/fetch, no npm.
//
// Run: node tests/signaling.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const PORT = 3311;
const URL = `ws://localhost:${PORT}/ws`;
const CONFIG_URL = `http://localhost:${PORT}/config`;
const ROOMS_URL = `http://localhost:${PORT}/api/rooms`;
// Management port (see src/main.rs::spawn_metrics_server) of the main test
// server — `/metrics`, same pattern as code-ranker-backend (a separate
// port, default 8081 in prod, but here we fix our own that doesn't conflict with
// any of the ports of this file's other isolated server processes —
// see their list next to their own `spawnServer(...)` calls below).
const MGMT_PORT = 3411;
const METRICS_URL = `http://localhost:${MGMT_PORT}/metrics`;
// Empty-room TTL for this run — short, so the test doesn't wait 120s.
const EMPTY_ROOM_TTL_SECONDS = 2;
// E2E v2 sections (25+) create several rooms via createRoom() without
// their own separate server process — otherwise they'd all share ONE
// and the same fallback-IP budget (see the comment on createRoom() about
// `CF-Connecting-IP`) with the already-accumulated createRoom() calls from
// earlier sections (2/10/11/12/15/16/18) and would easily hit
// ROOM_CREATION_IP_LIMIT (H2, 10/60s). Its own IP from the range reserved
// for tests (TEST-NET-3) — its own separate budget, same as section 22.
const E2E_TEST_IP = '203.0.113.99';
// Its own dedicated IP for ALL regular restoreRoom() calls in this file
// (section 2b, section 31) — now that PUT also checks
// ROOM_CREATION_IP_LIMIT and shares the budget with POST (H2, §3.1, see section «22c»),
// these calls can no longer silently share the fallback IP (already nearly maxed out by
// createRoom() with no explicit IP) or E2E_TEST_IP (also almost at its limit).
const RESTORE_ROOM_TEST_IP = '203.0.113.50';

let passed = 0, failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

// --- Server process management -------------------------------------
//
// The server is fully ephemeral (no DB/files on disk, chat stores
// nothing — see README.md), so there's no need for a temp DB or its
// cleanup here — just the process itself. Tracked in `serverProcs` and reliably
// killed in `cleanup()`.

let serverProc = null;
const serverProcs = [];
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of serverProcs) {
    if (p.exitCode === null && !p.killed) {
      try { p.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }
}
// Guarantees cleanup on any process outcome (including an uncaught exception).
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

function buildServer() {
  console.log('Building server (cargo build)...');
  const res = spawnSync('cargo', ['build'], { cwd: PROJECT_DIR, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`cargo build failed with code ${res.status}`);
  }
}

// Start the server on the given port with additional environment variables.
function spawnServer(port, extraEnv = {}) {
  const bin = path.join(PROJECT_DIR, 'target', 'debug', 'screenshare');
  if (!fs.existsSync(bin)) {
    throw new Error(`binary not found: ${bin}`);
  }
  const proc = spawn(bin, [], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      RUST_LOG: 'error',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.on('exit', (code, signal) => {
    if (!cleaned && code !== 0 && code !== null) {
      console.error(`Server (port ${port}) exited unexpectedly (code=${code}, signal=${signal}):\n${out}`);
    }
  });
  serverProcs.push(proc);
  return proc;
}

function startServer() {
  console.log(`Starting server on port ${PORT}...`);
  serverProc = spawnServer(PORT, {
    EMPTY_ROOM_TTL_SECONDS: String(EMPTY_ROOM_TTL_SECONDS),
    // A (H2, docs/research-dos.md §3.2): JOIN_ROOM_IP_LIMIT — default 20/60s,
    // sized for real users behind one NAT, not for this file: it
    // itself runs many dozens of join-room calls over WS from ONE IP per run, and
    // the WS handshake of this runtime's global WebSocket (unlike the HTTP
    // fetch() used by createRoom()) doesn't support arbitrary headers —
    // there's simply no way to isolate this file's sections from each other by
    // CF-Connecting-IP for WS connections (they all land on the same
    // socket peer address). We raise the limit of the MAIN test process
    // far beyond what this whole file could possibly flood in a
    // minute; the actual limit (the real default, WITHOUT override) is checked
    // by a separate isolated server process — see section «22d».
    JOIN_ROOM_IP_LIMIT: '100000',
    // ROOM_CREATION_IP_LIMIT — the prod default was tightened to 3/60s (see
    // state::DEFAULT_ROOM_CREATION_IP_LIMIT), and this file runs many dozens of
    // createRoom()/restoreRoom() requests from the same
    // fallback IP per run (sections 2/10/11/12/15/16/18/22/22b etc., see
    // the comment about E2E_TEST_IP/RESTORE_ROOM_TEST_IP above) — we raise
    // the main test process's limit far beyond that; the actual
    // prod default (WITHOUT override) is checked by a separate isolated
    // server process — see section «22e».
    ROOM_CREATION_IP_LIMIT: '100000',
    MGMT_PORT: String(MGMT_PORT),
  });
}

async function waitForReady(configUrl, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server crashed before becoming ready (exit code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(configUrl);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms: ${lastErr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- HTTP: room creation ------------------------------------------------

// `ip` (optional) — see the section on the per-IP room-creation limit (H2):
// passed as the `CF-Connecting-IP` header, which the server prioritizes
// (see src/state.rs::extract_client_ip). Without it the request goes
// without the header — the server falls back to the socket peer address
// (for all test requests without an explicit `ip` this will be the same
// localhost address, so separate IPs are passed explicitly in tests where it matters).
async function createRoom(body, roomsUrl = ROOMS_URL, ip = undefined) {
  const opts = { method: 'POST', headers: {} };
  if (ip !== undefined) opts.headers['CF-Connecting-IP'] = ip;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(roomsUrl, opts);
  let json = null;
  try { json = await res.json(); } catch { /* not JSON — status is checked below */ }
  return {
    status: res.status,
    roomId: json && json.roomId,
    leaderToken: json && json.leaderToken,
    // E2E v2 (see src/main.rs::create_room): room lifetime in seconds,
    // the same MAX_ROOM_LIFETIME_SECONDS as the server — the client needs it to bake
    // into the expiry link when generating it.
    lifetimeSeconds: json && json.lifetimeSeconds,
  };
}

// Stop an additional server process (see spawnServer) and wait for
// its exit — used by tests that need a separate process with
// non-standard env (MAX_ROOMS/MAX_ROOM_LIFETIME_SECONDS), different from the
// main server on PORT.
function stopServer(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
}

// PUT /api/rooms/<roomId> — idempotent restore (see src/main.rs::restore_room).
// `ip` (optional) — see section 22c: PUT now also checks
// ROOM_CREATION_IP_LIMIT (H2, §3.1) and shares the budget with POST /api/rooms.
// `roomsUrl` (optional, like createRoom()) — for isolated server
// processes on a non-standard port (see section 22b).
async function restoreRoom(roomId, ip = undefined, roomsUrl = ROOMS_URL) {
  const opts = { method: 'PUT', headers: {} };
  if (ip !== undefined) opts.headers['CF-Connecting-IP'] = ip;
  const res = await fetch(`${roomsUrl}/${encodeURIComponent(roomId)}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* not JSON — status is checked below */ }
  return { status: res.status, roomId: json && json.roomId, lifetimeSeconds: json && json.lifetimeSeconds };
}

// GET /api/rooms/<roomId> — unauthenticated pre-join preview (see
// src/main.rs::room_status). `ip` (optional, like restoreRoom()) — its own
// rate-limit budget (ROOM_STATUS_IP_LIMIT), separate from room creation, so
// tests that hammer this endpoint don't need to touch ROOM_CREATION_IP_LIMIT
// at all. Returns the raw Response too, so callers can inspect headers
// (see section 34's headers check, mirroring section 24).
async function roomStatus(roomId, ip = undefined, roomsUrl = ROOMS_URL) {
  const opts = { headers: {} };
  if (ip !== undefined) opts.headers['CF-Connecting-IP'] = ip;
  const res = await fetch(`${roomsUrl}/${encodeURIComponent(roomId)}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* not JSON — status is checked below */ }
  return {
    status: res.status,
    participants: json && json.participants,
    capacity: json && json.capacity,
    ageSeconds: json && json.ageSeconds,
    headers: res.headers,
  };
}

// E2E v2: stub ephemeral public key (`epub`) for the test — the server
// doesn't parse it at all (opaque, like sdp/candidate), so real
// ECDH math isn't needed here, only the fact of transparent delivery
// of a string of the right length (~87 chars for a real base64url P-256 raw
// key, see docs/research-p2p-key-handoff.md §6.5–6.6) matters.
function fakeEpub(label) {
  return `epub-${label}-` + 'x'.repeat(70);
}

// Simple uuid v4 generator for the test client (doesn't need to be crypto-strong).
function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- WS test client --------------------------------------------------

function connect(wsUrl = URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    };
    ws.onopen = () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      // Wait for the next message (with a timeout).
      next: (ms = 3000) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
        waiters.push((m) => { clearTimeout(t); res(m); });
      }),
      closed: new Promise((res) => { ws.onclose = () => res(); }),
    });
    ws.onerror = reject;
  });
}

// Connect and join a room in one step; returns { peer, joined }.
// `peerId` (optional) — see src/protocol.rs::ClientMessage::JoinRoom and
// section 5b below. `leaderToken` (optional) — see section 15 (permission system).
// `epub` (optional, E2E v2) — see section 25: ephemeral public key,
// the server doesn't parse it, only relays it to the others.
async function join(roomId, name, wsUrl = URL, peerId = undefined, leaderToken = undefined, epub = undefined) {
  const peer = await connect(wsUrl);
  const msg = { type: 'join-room', roomId };
  if (name !== undefined) msg.name = name;
  if (peerId !== undefined) msg.peerId = peerId;
  if (leaderToken !== undefined) msg.leaderToken = leaderToken;
  if (epub !== undefined) msg.epub = epub;
  peer.send(msg);
  const joined = await peer.next();
  return { peer, joined };
}

// Change room settings (leader only) — see section 17.
function updateSettings(sender, settings) {
  sender.send({ type: 'update-settings', settings });
}

// Default settings (see src/protocol.rs::RoomSettings::default),
// handy as a base for targeted overrides in tests.
function defaultSettings(overrides = {}) {
  return {
    lobbyEnabled: false,
    guestChat: true,
    guestAudio: true,
    guestVideo: true,
    guestScreen: true,
    ...overrides,
  };
}

// Beacon for checking "socket alive / relay is addressed / clipped by rate-limit":
// the server-side chat relay is gone (chat is P2P-bus only), so the beacon
// role is played by the still-existing addressed stream-info relay (see handle_stream_info).
function isBeaconMsg(m) {
  return m && m.type === 'stream-info' && typeof m.fromPeerId === 'string'
    && m.info !== undefined && m.info !== null && typeof m.info === 'object';
}

function sendBeacon(sender, targetPeerId, payload) {
  sender.send({ type: 'stream-info', targetPeerId, info: payload });
}

// Structural comparison, not string comparison: the server passes the envelope through
// serde_json::Value, which (without preserve_order) sorts object keys
// alphabetically — key order changes, but the data stays the same. That's
// exactly what "delivered as-is" means for opaque JSON.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

// --- The actual test run -----------------------------------------------------

async function runTests() {
  // --- 1. Room not found (never created) ---
  console.log('1. join a non-existent room');
  {
    const v = await connect();
    v.send({ type: 'join-room', roomId: 'nope1234' });
    const m = await v.next();
    ok(m.type === 'room-not-found', 'received room-not-found');
    await v.closed;
    ok(true, 'server closed the socket');
  }

  // --- 2. POST /api/rooms creates an empty room ---
  console.log('2. POST /api/rooms');
  let roomId;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  {
    const { status, roomId: id, leaderToken } = await createRoom();
    ok(status === 201, `201 Created (status=${status})`);
    ok(/^[23456789a-z]{8}$/.test(id), `roomId is short and human-readable (${id})`);
    ok(typeof leaderToken === 'string' && UUID_RE.test(leaderToken), `leaderToken is issued and looks like a uuid (${leaderToken})`);
    roomId = id;

    // Body is optional and ignored — should not break creation.
    const withBody = await createRoom({ name: 'My room' });
    ok(withBody.status === 201 && /^[23456789a-z]{8}$/.test(withBody.roomId),
      'optional {name} body is ignored, room is still created');
  }

  // --- 2b. PUT /api/rooms/{roomId} — idempotent restore ---
  console.log('2b. PUT /api/rooms/{roomId}');
  {
    // No room with this id exists yet (never created) -> 201, room created.
    const freshId = 'zx9k2m7q'; // valid format ^[a-z0-9]{8}$, deliberately never existed
    const created = await restoreRoom(freshId, RESTORE_ROOM_TEST_IP);
    ok(created.status === 201, `restoring a NON-existent room -> 201 (status=${created.status})`);
    ok(created.roomId === freshId, 'the response has the same roomId that was requested');

    // Joining the just-restored room works as usual.
    const { peer, joined } = await join(freshId);
    ok(joined.type === 'joined' && joined.peers.length === 0, 'joining a restored room succeeds, still 0 participants');

    // The room already exists (we just joined it) -> 200, nothing recreated.
    const already = await restoreRoom(freshId, RESTORE_ROOM_TEST_IP);
    ok(already.status === 200, `restoring an ALREADY existing room -> 200 (status=${already.status})`);
    peer.ws.close();

    // Bogus id (does not match ^[a-z0-9]{8}$) -> 400.
    const bad1 = await restoreRoom('AB');
    ok(bad1.status === 400, `too short / uppercase id -> 400 (status=${bad1.status})`);
    const bad2 = await restoreRoom('../evil12');
    ok(bad2.status === 400, `id with disallowed characters -> 400 (status=${bad2.status})`);
  }

  // --- 3. First participant joins the freshly created room ---
  console.log('3. first participant joins: peers=[], screenOwner=null');
  const { peer: p1, joined: j1 } = await join(roomId);
  ok(j1.type === 'joined' && Array.isArray(j1.peers) && j1.peers.length === 0 && j1.screenOwner === null,
    'joined: peers=[], screenOwner=null for the first participant');
  const p1Id = j1.peerId;
  // No token presented, but there was no leader in the room yet -> the first to join
  // becomes leader themselves (see section 15 on leaderToken).
  ok(j1.leaderId === p1Id, 'first participant without a token becomes leader on their own');
  ok(j1.settings && j1.settings.lobbyEnabled === false && j1.settings.guestChat === true
    && j1.settings.guestAudio === true && j1.settings.guestVideo === true && j1.settings.guestScreen === true,
    'joined.settings — defaults (everything allowed, lobby disabled)');
  ok(Array.isArray(j1.pending) && j1.pending.length === 0, 'joined.pending — empty list (no lobby requests yet)');
  ok(typeof j1.expiresInSeconds === 'number' && j1.expiresInSeconds > 0,
    `joined.expiresInSeconds present and positive, call duration limit (${j1.expiresInSeconds})`);
  // Server-side count-up timer field (see src/state.rs::Room::first_joined_at,
  // src/ws.rs::room_age_seconds): for the very first participant — always 0,
  // the server sets first_joined_at right before computing this
  // field in the same call (admit_participant).
  ok(typeof j1.roomAgeSeconds === 'number' && j1.roomAgeSeconds === 0,
    `joined.roomAgeSeconds === 0 for the first participant (got ${j1.roomAgeSeconds})`);

  // --- 4. Second participant (with a name) joins: sees the first in peers ---
  console.log('4. second participant: peers contains the first, peer-joined arrives at the first');
  const { peer: p2, joined: j2 } = await join(roomId, 'Anya');
  const p2Id = j2.peerId;
  ok(j2.type === 'joined' && j2.peers.length === 1 && j2.peers[0].peerId === p1Id && j2.peers[0].name === null,
    'joined: peers=[{peerId: first, name: null}] for the second participant');
  ok(j2.screenOwner === null, 'screenOwner is still null');
  ok(j2.leaderId === p1Id, 'second participant (guest) sees the first as leader');
  ok(Array.isArray(j2.pending) && j2.pending.length === 0, 'joined.pending is empty for a non-leader, even if it had something');
  // The second participant joins the same (no longer empty) room — first_joined_at
  // is already set from the first join, roomAgeSeconds is simply non-negative (same
  // monotonic base as the first, difference is an order of magnitude below a second).
  ok(typeof j2.roomAgeSeconds === 'number' && j2.roomAgeSeconds >= 0,
    `joined.roomAgeSeconds present and non-negative for the second participant (${j2.roomAgeSeconds})`);

  const pj1 = await p1.next();
  // E (docs/research-minimize-state.md §3): the server NO LONGER STORES name —
  // peer-joined always carries null, regardless of what the client sent in
  // join-room (the name now travels as a separate encrypted name-announce).
  ok(pj1.type === 'peer-joined' && pj1.peerId === p2Id && pj1.name === null,
    'first participant received peer-joined — name is always null (server does not store it, see §E)');

  // --- 4b. join-room with a client-supplied peerId (free/taken -> reconnect/invalid) ---
  console.log('4b. join-room with a client-supplied peerId');
  {
    // Free, valid uuid -> the server accepts it as-is.
    const desiredId = genUuid();
    const { peer: pCustom, joined: jCustom } = await join(roomId, 'Igor', URL, desiredId);
    ok(jCustom.peerId === desiredId, `free valid peerId is accepted as-is (${jCustom.peerId})`);
    await Promise.all([p1.next(), p2.next()]); // peer-joined to the others

    // peerId already taken — but not p1Id/p2Id (they need to stay intact for the
    // rest of the file), but by its OWN recently created pCustom -> this is now a
    // RECONNECT (see §A/§D task, src/ws.rs::reconnect_participant): the server
    // does NOT generate a new peerId, but takes over the slot (replaces tx) — the
    // same peerId stays held by the same "identity", just with a new
    // signaling connection. peer-joined is NOT sent again to other
    // participants — from their point of view this peerId never left.
    const { peer: pReconnect, joined: jReconnect } = await join(roomId, 'IgorAgain', URL, desiredId);
    ok(jReconnect.type === 'joined' && jReconnect.peerId === desiredId,
      `join with its own already-taken peerId -> reconnect, same peerId (${jReconnect.peerId})`);

    // Prove that the channel actually moved: relay to desiredId now goes
    // to the NEW connection.
    sendBeacon(p1, desiredId, { kind: 'reconnect-routing-check' });
    const routed = await pReconnect.next();
    ok(isBeaconMsg(routed) && routed.info.kind === 'reconnect-routing-check',
      'after reconnect, relay to the peerId goes to the new connection');

    // Close the OLD (already-replaced, "zombie") socket — should not spawn
    // peer-left and should not corrupt state (see the same_channel check in
    // cleanup_peer, src/ws.rs).
    pCustom.ws.close();
    await sleep(200);
    sendBeacon(p1, p2Id, { kind: 'after-zombie-close-4b' });
    const afterZombie = await p2.next();
    ok(isBeaconMsg(afterZombie) && afterZombie.info.kind === 'after-zombie-close-4b',
      'closing an already-replaced (zombie) socket does not spawn peer-left and does not corrupt state');

    // Bogus peerId (not a uuid) -> the server silently generates a new one.
    const { peer: pBad, joined: jBad } = await join(roomId, 'Bogus', URL, 'not-a-uuid');
    ok(jBad.type === 'joined' && typeof jBad.peerId === 'string' && jBad.peerId !== 'not-a-uuid',
      `invalid (non-uuid) peerId -> a new one is issued (${jBad.peerId})`);
    await Promise.all([p1.next(), p2.next(), pReconnect.next()]); // peer-joined to the others

    // Clean up the remaining temporary participants.
    pReconnect.ws.close();
    pBad.ws.close();
    for (let i = 0; i < 2; i++) {
      const [m1, m2] = await Promise.all([p1.next(), p2.next()]);
      ok(m1.type === 'peer-left' && m2.type === 'peer-left', 'peer-left reached p1 and p2 when the temporary participant left');
    }
  }

  // --- 4c. name in join-room is no longer stored and doesn't affect peer-joined —
  // always null regardless of length/content (see §E,
  // docs/research-minimize-state.md §3: dead field removed from
  // Participant/PendingParticipant; the old test for truncation to 512 chars
  // (CHAT_NAME_MAX_CHARS) no longer applies — there's no sanitization/length
  // limit anymore, the field is simply ignored entirely). ---
  console.log('4c. name: no longer stored — join with a long name works, peer-joined.name is always null');
  {
    const name600 = 'y'.repeat(600); // used to be truncated to 512 — now simply unused at all
    const { peer: pLong, joined: jLong } = await join(roomId, name600);
    ok(jLong.type === 'joined', 'participant with a 600-char name joins without error (length is never checked)');
    const [pj1c, pj2c] = await Promise.all([p1.next(), p2.next()]);
    ok(pj1c.type === 'peer-joined' && pj1c.name === null, 'peer-joined.name is always null, regardless of name length');
    ok(pj2c.type === 'peer-joined' && pj2c.name === null, 'the second recipient sees the same thing');

    pLong.ws.close();
    await Promise.all([p1.next(), p2.next()]); // peer-left of the departed temporary participant
  }

  // --- 5. Third participant sees BOTH previous ones in peers ---
  console.log('5. third participant sees all previous ones; both receive peer-joined');
  const { peer: p3, joined: j3 } = await join(roomId, 'Bob');
  const p3Id = j3.peerId;
  ok(j3.peers.length === 2, 'the third participant has peers containing the two previous ones');
  ok(j3.peers.every((p) => p.name === null), 'peers[].name is always null (server does not store the name, see §E)');
  ok(j3.peers.some((p) => p.peerId === p1Id), 'peers contains the first');
  ok(j3.peers.some((p) => p.peerId === p2Id), 'peers contains the second');

  const [pj2a, pj2b] = await Promise.all([p1.next(), p2.next()]);
  ok(pj2a.type === 'peer-joined' && pj2a.peerId === p3Id && pj2a.name === null, 'first received peer-joined (name null)');
  ok(pj2b.type === 'peer-joined' && pj2b.peerId === p3Id && pj2b.name === null, 'second received peer-joined (name null)');

  // --- 6. Relay of offer/answer/ice/stream-info between TWO NON-first participants ---
  console.log('6. relay between the second and third participant (not the first)');
  p2.send({ type: 'offer', targetPeerId: p3Id, sdp: { type: 'offer', sdp: 'v=0 fake' } });
  const off = await p3.next();
  ok(off.type === 'offer' && off.fromPeerId === p2Id && off.sdp.sdp === 'v=0 fake', 'offer p2->p3 with fromPeerId');

  p3.send({ type: 'answer', targetPeerId: p2Id, sdp: { type: 'answer', sdp: 'v=0 fake2' } });
  const ans = await p2.next();
  ok(ans.type === 'answer' && ans.fromPeerId === p3Id, 'answer p3->p2');

  p2.send({ type: 'ice-candidate', targetPeerId: p3Id, candidate: { candidate: 'candidate:1', sdpMid: '0' } });
  const ice = await p3.next();
  ok(ice.type === 'ice-candidate' && ice.fromPeerId === p2Id && ice.candidate.sdpMid === '0', 'ice-candidate p2->p3');

  p3.send({
    type: 'stream-info',
    targetPeerId: p2Id,
    info: { s1: { peerId: p3Id, name: 'Bob' } },
  });
  const si = await p2.next();
  ok(si.type === 'stream-info' && si.fromPeerId === p3Id && si.info.s1.name === 'Bob', 'stream-info p3->p2');

  // Relay to a non-existent peerId — silently ignored, connection stays alive
  // (checked with a beacon via addressed stream-info).
  p2.send({ type: 'ice-candidate', targetPeerId: 'ghost', candidate: {} });
  {
    sendBeacon(p2, p1Id, { kind: 'text', text: 'beacon-after-ghost-relay' });
    const m = await p1.next();
    ok(isBeaconMsg(m) && m.fromPeerId === p2Id && m.info.text === 'beacon-after-ghost-relay',
      'relay to an unknown peerId does not break the socket — chat p2->p1 after it still arrives');
  }

  // --- 6b. Relay: payload size limit for offer/answer/ice/stream-info (H2) ---
  console.log('6b. relay: payload size limit (H2, 16KB)');
  {
    const bigSdp = { type: 'offer', sdp: 'x'.repeat(17 * 1024) }; // serialized payload deliberately > 16KB
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: bigSdp });
    const errMsg = await p2.next();
    ok(errMsg.type === 'error', `offer payload >16KB -> error to the sender (${errMsg.message})`);

    // Prove non-delivery: the next valid offer is a beacon — p3
    // should receive exactly that, not a leaked big offer.
    const beaconSdp = { type: 'offer', sdp: 'beacon-after-oversize-offer' };
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: beaconSdp });
    const beacon = await p3.next();
    ok(beacon.type === 'offer' && beacon.sdp.sdp === 'beacon-after-oversize-offer',
      'offer >16KB not delivered; the next valid one arrived as-is');

    // Payload just under the limit — passes through in full.
    const okSdp = { type: 'offer', sdp: 'y'.repeat(16 * 1024 - 200) };
    p2.send({ type: 'offer', targetPeerId: p3Id, sdp: okSdp });
    const okMsg = await p3.next();
    ok(okMsg.type === 'offer' && okMsg.sdp.sdp.length === okSdp.sdp.length,
      'offer just under 16KB delivered in full');
  }

  // --- 6c. Relay: overall rate limit across ALL relay types for a connection combined (H2) ---
  console.log('6c. relay: overall rate limit (H2, RELAY_RATE_LIMIT=100/10s)');
  {
    // Two temporary participants in the same room — don't reuse p1/p2/p3,
    // so as not to prematurely spend their own budget needed by further
    // sections of the test.
    const { peer: pA, joined: jA } = await join(roomId, 'RateA');
    await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined to everyone current
    const { peer: pB, joined: jB } = await join(roomId, 'RateB');
    await Promise.all([p1.next(), p2.next(), p3.next(), pA.next()]); // peer-joined to everyone current

    // 100 ice-candidate messages in a row from pA to pB — all within the overall limit.
    let allDelivered = true;
    for (let i = 0; i < 100; i++) {
      pA.send({ type: 'ice-candidate', targetPeerId: jB.peerId, candidate: { candidate: `c${i}` } });
      const m = await pB.next();
      if (!(m.type === 'ice-candidate' && m.candidate.candidate === `c${i}`)) allDelivered = false;
    }
    ok(allDelivered, '100 messages in a row (within the overall relay limit) all delivered');

    // The 101st message in the window -> error to the sender, not delivered.
    pA.send({ type: 'ice-candidate', targetPeerId: jB.peerId, candidate: { candidate: 'over-limit' } });
    const errMsg = await pA.next();
    ok(errMsg.type === 'error', `101st message in 10s (combined across all relay types) -> error (${errMsg.message})`);

    // Prove non-delivery: a beacon from a DIFFERENT sender (p1, its own clean
    // budget) should arrive as the very first message at pB.
    sendBeacon(p1, jB.peerId, { kind: 'text', text: 'beacon-after-relay-rate-limit' });
    const beacon = await pB.next();
    ok(isBeaconMsg(beacon) && beacon.info.text === 'beacon-after-relay-rate-limit',
      'the 101st message, clipped by the overall relay limit, was not delivered to the recipient');

    pA.ws.close();
    await Promise.all([p1.next(), p2.next(), p3.next(), pB.next()]); // peer-left pA
    pB.ws.close();
    await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-left pB
  }

  // --- 8. Fourth participant joins (no history — server doesn't store it) ---
  console.log('8. fourth participant joins');
  const { peer: p4, joined: j4 } = await join(roomId, 'Vova');
  const p4Id = j4.peerId;
  ok(j4.peers.length === 3, 'the fourth participant has peers containing the three previous ones');
  await Promise.all([p1.next(), p2.next(), p3.next()]); // peer-joined to all three

  // --- 9. Screen sharing: capture, takeover (last wins), release, re-capture ---
  console.log('9. screen sharing');
  {
    p1.send({ type: 'share-start' });
    const [s1, s2, s3, s4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([s1, s2, s3, s4].every((m) => m.type === 'share-started' && m.peerId === p1Id),
      'share-started arrives at EVERYONE, including the initiator');

    // --- 9a. Takeover: share-start from a NON-owner replaces the owner instead of being rejected ---
    console.log('9a. sharing takeover (last wins)');
    // The second participant sends share-start while the first still holds the
    // screen — this used to be rejected (share-rejected); now the request replaces
    // the owner: share-started(p2) goes to EVERYONE, including p1 — this same
    // message serves as p1's notification of the takeover (the client uses it to
    // stop its own capture, see static/room.js), no separate message is sent to it.
    p2.send({ type: 'share-start' });
    const [ov1, ov2, ov3, ov4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([ov1, ov2, ov3, ov4].every((m) => m.type === 'share-started' && m.peerId === p2Id),
      'takeover: share-started(new owner) goes to EVERYONE, including the previous owner — no share-rejected at all');

    // The room actually considers p2 to be sharing — checked from the
    // perspective of a freshly joined participant (independent source of truth, not tied to
    // what was already broadcast above).
    {
      const { peer: pCheck, joined: jCheck } = await join(roomId, 'Checker');
      ok(jCheck.screenOwner === p2Id, 'after the takeover, joined.screenOwner of a new participant is p2 (not p1)');
      await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-joined to everyone current
      pCheck.ws.close();
      await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-left
    }

    // Prove the owner is p2, NOT p1: p1's attempt (no longer the owner) to
    // stop sharing is silently ignored (not the owner), a beacon after it
    // still arrives as usual.
    {
      p1.send({ type: 'share-stop' });
      sendBeacon(p1, p2Id, { kind: 'text', text: 'beacon-after-share-stop-by-non-owner' });
      const b = await p2.next();
      ok(isBeaconMsg(b) && b.info.text === 'beacon-after-share-stop-by-non-owner',
        'share-stop from p1 (no longer the owner after the takeover) is ignored, socket is alive');
    }

    // share-stop NOT from the owner (p3) — silently ignored, screen stays with p2.
    p3.send({ type: 'share-stop' });
    {
      sendBeacon(p3, p2Id, { kind: 'text', text: 'beacon-after-someone-elses-share-stop' });
      const b = await p2.next();
      ok(isBeaconMsg(b) && b.info.text === 'beacon-after-someone-elses-share-stop',
        'share-stop not from the owner (p3) is ignored — screen stays with p2');
    }

    // The owner (p2) releases the screen — share-stopped to everyone. If
    // ownership had silently drifted (a bug), this share-stop would have been a
    // no-op and would not have broadcast anything at all — the very fact of the
    // broadcast confirms p2 remained the true owner the whole time.
    p2.send({ type: 'share-stop' });
    const [st1, st2, st3, st4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([st1, st2, st3, st4].every((m) => m.type === 'share-stopped' && m.peerId === p2Id),
      'share-stopped arrives at everyone after the owner (p2) share-stop');

    // After release, another participant can freely capture the screen.
    p1.send({ type: 'share-start' });
    const [c1, c2, c3, c4] = await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]);
    ok([c1, c2, c3, c4].every((m) => m.type === 'share-started' && m.peerId === p1Id),
      'after release, another participant successfully captures the free screen');

    // A new participant joining a room with active sharing gets screenOwner in joined.
    const { peer: p5, joined: j5 } = await join(roomId, 'Galya');
    ok(j5.screenOwner === p1Id, 'new participant gets the screenOwner of active sharing in joined');
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next()]); // peer-joined to everyone

    // Release before the next block (disconnect test).
    p1.send({ type: 'share-stop' });
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next(), p5.next()]);

    // --- 9b. Screen owner disconnect: share-stopped to everyone + peer-left ---
    console.log('9b. screen owner disconnect');
    p3.send({ type: 'share-start' });
    await Promise.all([p1.next(), p2.next(), p3.next(), p4.next(), p5.next()]); // share-started to everyone

    p3.ws.close();
    const [dsc1, dsc2, dsc4, dsc5] = await Promise.all([p1.next(), p2.next(), p4.next(), p5.next()]);
    ok([dsc1, dsc2, dsc4, dsc5].every((m) => m.type === 'share-stopped' && m.peerId === p3Id),
      'owner disconnect sends share-stopped to everyone remaining');
    const [pl1, pl2, pl4, pl5] = await Promise.all([p1.next(), p2.next(), p4.next(), p5.next()]);
    ok([pl1, pl2, pl4, pl5].every((m) => m.type === 'peer-left' && m.peerId === p3Id),
      'owner disconnect then sends peer-left to everyone remaining');

    // Regular departure (not the owner) — just peer-left, no share-stopped.
    console.log('9c. regular participant leaving');
    p5.ws.close();
    const [pl1b, pl2b, pl4b] = await Promise.all([p1.next(), p2.next(), p4.next()]);
    ok([pl1b, pl2b, pl4b].every((m) => m.type === 'peer-left' && m.peerId === j5.peerId),
      'a regular participant leaving sends peer-left to the rest (no share-stopped)');

    p1.ws.close();
    p2.ws.close();
    p4.ws.close();
  }

  // --- 10. Limit of 6 participants: 6 join, the 7th gets room-full ---
  console.log('10. limit of 6 participants');
  {
    const { roomId: fullRoomId } = await createRoom();
    const members = [];
    for (let i = 0; i < 6; i++) {
      const { peer, joined: j } = await join(fullRoomId, `participant${i}`);
      ok(j.type === 'joined', `participant #${i + 1} joined`);
      if (i === 0) {
        // MAX_PARTICIPANTS is not set for this server process -> default 6
        // (see DEFAULT_MAX_PARTICIPANTS in src/state.rs) — joined carries it
        // explicitly (additive field, see src/protocol.rs::ServerMessage::Joined).
        ok(j.maxParticipants === 6, `joined.maxParticipants === 6 without the MAX_PARTICIPANTS env var (got ${j.maxParticipants})`);
      }
      // peer-joined to all previous participants of this same room.
      await Promise.all(members.map((m) => m.peer.next()));
      members.push({ peer, joined: j });
    }
    const seventh = await connect();
    seventh.send({ type: 'join-room', roomId: fullRoomId });
    const m = await seventh.next();
    ok(m.type === 'room-full', '7th participant received room-full');
    await seventh.closed;
    ok(true, 'the 7th socket was closed by the server');

    for (const { peer } of members) peer.ws.close();
  }

  // --- 11. Room stays alive after ALL participants leave below TTL, gets removed above TTL ---
  console.log('11. empty room TTL');
  {
    const { roomId: ttlRoomId } = await createRoom();
    const { peer } = await join(ttlRoomId);
    peer.ws.close();
    await peer.closed;

    await sleep(500); // less than the TTL (2s)
    const { peer: reJoinPeer, joined: reJoined } = await join(ttlRoomId);
    ok(reJoined.type === 'joined', 'joining an emptied but still-alive room (< TTL) succeeds');
    reJoinPeer.ws.close();
    await reJoinPeer.closed;

    await sleep(3000); // more than the TTL (2s) + margin for a reaper tick
    const late = await connect();
    late.send({ type: 'join-room', roomId: ttlRoomId });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'room removed by the reaper after the empty-room TTL expired');
  }

  // --- 12. Short room page /r/{roomId} ---
  console.log('12. GET /r/<roomId>');
  {
    const { roomId: pageRoomId } = await createRoom();
    const res = await fetch(`http://localhost:${PORT}/r/${pageRoomId}`);
    ok(res.status === 200, `GET /r/${pageRoomId} -> 200`);
    ok((res.headers.get('content-type') || '').includes('text/html'), 'the /r/<id> response is HTML');
  }

  // S1: /qr.svg was removed entirely — the QR code is now rendered locally in the browser
  // (see static/vendor/qrcode.js, static/room.js), the server no longer builds the image.

  // --- 14. Ephemerality: the server left no DB files in the CWD ---
  console.log('14. ephemerality: no DB files');
  {
    const dbFiles = fs.readdirSync(PROJECT_DIR).filter((f) => f.endsWith('.db') || f.includes('.db-'));
    ok(dbFiles.length === 0,
      `no DB files in ${PROJECT_DIR} (found: ${dbFiles.join(', ') || 'none'})`);
  }

  // === Permission system (leader/guests), protocol v4 ===========================

  // --- 15. leaderToken: presenting it makes you leader, token is one-time-use ---
  console.log('15. leaderToken');
  {
    const { roomId: lrId, leaderToken } = await createRoom();

    // Joining with a valid token -> immediately leader (leaderId == own peerId).
    const { peer: leader, joined: leaderJoined } = await join(lrId, 'Leader', URL, undefined, leaderToken);
    ok(leaderJoined.leaderId === leaderJoined.peerId, 'joining with leaderToken makes the joiner leader (leaderId == own peerId)');

    // Token is one-time-use: a second join with the SAME token -> just a guest (leader already exists).
    const { peer: impostor, joined: impostorJoined } = await join(lrId, 'Impostor', URL, undefined, leaderToken);
    ok(impostorJoined.leaderId === leaderJoined.peerId && impostorJoined.leaderId !== impostorJoined.peerId,
      'presenting an already-burned token again does not make you leader — the previous leader is still shown');
    await leader.next(); // peer-joined of the impostor to the leader

    leader.ws.close();
    impostor.ws.close();
    await Promise.all([leader.closed, impostor.closed]);
  }

  // --- 16/17/19/20: leader handoff, update-settings, guest_screen/guest_chat enforcement ---
  console.log('16. leader handoff on departure');
  {
    const { roomId: rId, leaderToken } = await createRoom();
    const { peer: a, joined: ja } = await join(rId, 'A', URL, undefined, leaderToken); // leader
    const { peer: b, joined: jb } = await join(rId, 'B'); // guest, joined second
    await a.next(); // peer-joined B at A
    const { peer: c, joined: jc } = await join(rId, 'C'); // guest, joined third
    await Promise.all([a.next(), b.next()]); // peer-joined C at A and B

    ok(ja.leaderId === ja.peerId && jb.leaderId === ja.peerId && jc.leaderId === ja.peerId,
      'all three see A as leader before A leaves');

    a.ws.close();
    const [lcB, lcC] = await Promise.all([b.next(), c.next()]);
    ok(lcB.type === 'leader-changed' && lcC.type === 'leader-changed'
      && lcB.leaderId === jb.peerId && lcC.leaderId === jb.peerId,
      'leader departure -> leader-changed to everyone remaining, the new leader is the oldest of those remaining (B, joined before C)');
    const [plB, plC] = await Promise.all([b.next(), c.next()]);
    ok(plB.type === 'peer-left' && plC.type === 'peer-left'
      && plB.peerId === ja.peerId && plC.peerId === ja.peerId,
      'peer-left of the departed leader arrives right after leader-changed');

    // --- 17. update-settings: only the leader (now B) can change settings ---
    console.log('17. update-settings: leader only, settings-changed to everyone');

    // Guest (C) tries to change settings -> error, nothing broadcast.
    updateSettings(c, defaultSettings({ guestChat: false }));
    const errMsg = await c.next();
    ok(errMsg.type === 'error', `guest cannot change room settings (${errMsg.message})`);

    // Leader (B) changes settings -> settings-changed arrives at both B and C.
    updateSettings(b, defaultSettings({ guestScreen: false }));
    const [scB, scC] = await Promise.all([b.next(), c.next()]);
    ok(scB.type === 'settings-changed' && scC.type === 'settings-changed'
      && scB.settings.guestScreen === false && scC.settings.guestScreen === false,
      "leader's update-settings broadcasts settings-changed to all participants");

    // --- 19. guest_screen=false: guest's share-start rejected, leader allowed ---
    console.log('19. guest_screen=false enforcement');

    // C (guest) tries to share the screen -> forbidden, no busyPeerId.
    c.send({ type: 'share-start' });
    const rejC = await c.next();
    ok(rejC.type === 'share-rejected' && rejC.reason === 'forbidden' && rejC.busyPeerId === undefined,
      'guest with guestScreen=false is denied with reason=forbidden, no busyPeerId');

    // B (leader) can share the screen regardless of guestScreen.
    b.send({ type: 'share-start' });
    const [ssB, ssC] = await Promise.all([b.next(), c.next()]);
    ok(ssB.type === 'share-started' && ssC.type === 'share-started' && ssB.peerId === jb.peerId,
      'leader is allowed to share the screen even with guestScreen=false');
    b.send({ type: 'share-stop' });
    await Promise.all([b.next(), c.next()]); // share-stopped

    // Restore guestScreen so the guest can capture the screen themselves.
    updateSettings(b, defaultSettings({ guestScreen: true }));
    await Promise.all([b.next(), c.next()]); // settings-changed

    c.send({ type: 'share-start' });
    const [ss2B, ss2C] = await Promise.all([b.next(), c.next()]);
    ok(ss2B.type === 'share-started' && ss2C.type === 'share-started' && ss2B.peerId === jc.peerId,
      'guestScreen=true -> guest successfully captures the screen');

    // Leader revokes guestScreen WHILE the guest is sharing -> the server itself sends share-stopped to everyone.
    updateSettings(b, defaultSettings({ guestScreen: false }));
    const [sc2B, sc2C] = await Promise.all([b.next(), c.next()]); // settings-changed
    ok(sc2B.type === 'settings-changed' && sc2C.type === 'settings-changed', 'settings-changed when guestScreen is revoked while a guest is sharing');
    const [stB, stC] = await Promise.all([b.next(), c.next()]); // the server itself stops the sharing
    ok(stB.type === 'share-stopped' && stC.type === 'share-stopped' && stB.peerId === jc.peerId,
      'revoking guestScreen from a sharing guest -> the server itself sends share-stopped to all participants');

    b.ws.close();
    c.ws.close();
    await Promise.all([b.closed, c.closed]);
  }

  // --- 18. Lobby (wait room): waiting/join-request/approve/reject/cancel/inheritance ---
  console.log('18. lobby (wait room)');
  {
    const { roomId: lId, leaderToken } = await createRoom();
    const { peer: leader, joined: leaderJoined } = await join(lId, 'Leader', URL, undefined, leaderToken);
    ok(leaderJoined.leaderId === leaderJoined.peerId, 'the leader of the lobby room is the one who joined with the token');

    // Enable the lobby.
    updateSettings(leader, defaultSettings({ lobbyEnabled: true }));
    const scSelf = await leader.next(); // settings-changed (only participant so far — the leader themselves)
    ok(scSelf.type === 'settings-changed' && scSelf.settings.lobbyEnabled === true, 'lobby enabled');

    // New guest -> waiting, the leader receives join-request.
    const guest1 = await connect();
    guest1.send({ type: 'join-room', roomId: lId, name: 'Waiting1' });
    const waitMsg = await guest1.next();
    ok(waitMsg.type === 'waiting', 'a new guest gets waiting instead of joined when lobbyEnabled=true');
    const jr1 = await leader.next();
    ok(jr1.type === 'join-request' && jr1.name === null && typeof jr1.peerId === 'string',
      'leader receives join-request — name is always null (server does not store it, see §E)');
    const guest1Id = jr1.peerId;

    // Approve -> the waiting one gets joined, the others (only the leader so far) get peer-joined.
    leader.send({ type: 'approve', peerId: guest1Id });
    const joinedMsg = await guest1.next();
    ok(joinedMsg.type === 'joined' && joinedMsg.peerId === guest1Id && joinedMsg.leaderId === leaderJoined.peerId,
      'approve -> the waiting participant receives a full joined');
    ok(Array.isArray(joinedMsg.pending) && joinedMsg.pending.length === 0,
      'joined.pending is empty — the approved guest is not the leader');
    const pjMsg = await leader.next();
    ok(pjMsg.type === 'peer-joined' && pjMsg.peerId === guest1Id, 'others (the leader) receive peer-joined after approve');

    // Reject: the second waiting participant is rejected, the socket is closed by the server.
    const guest2 = await connect();
    guest2.send({ type: 'join-room', roomId: lId, name: 'Waiting2' });
    await guest2.next(); // waiting
    const jr2 = await leader.next();
    ok(jr2.type === 'join-request' && jr2.name === null, 'the second request arrives at the leader (name null)');
    leader.send({ type: 'reject', peerId: jr2.peerId });
    const rejMsg = await guest2.next();
    ok(rejMsg.type === 'join-rejected', 'reject -> join-rejected to the waiting participant');
    await guest2.closed;
    ok(true, 'server closed the socket of the participant rejected by the server');

    // Cancel: the third waiting participant drops out on its own, without waiting for a decision.
    const guest3 = await connect();
    guest3.send({ type: 'join-room', roomId: lId, name: 'Waiting3' });
    await guest3.next(); // waiting
    const jr3 = await leader.next();
    ok(jr3.type === 'join-request' && jr3.name === null, 'the third request arrives at the leader (name null)');
    guest3.ws.close();
    const cancelMsg = await leader.next();
    ok(cancelMsg.type === 'join-request-cancelled' && cancelMsg.peerId === jr3.peerId,
      'a waiting participant dropping out before a decision -> join-request-cancelled to the leader');

    // Leader handoff with a non-empty pending: a fourth waiting participant applies, then the leader leaves.
    const guest4 = await connect();
    guest4.send({ type: 'join-room', roomId: lId, name: 'Waiting4' });
    await guest4.next(); // waiting
    const jr4 = await leader.next();
    ok(jr4.type === 'join-request' && jr4.name === null, 'the fourth request arrives at the previous leader (name null)');

    // The room right now: participants — leader (leader) and guest1 (approved); waiting — guest4.
    leader.ws.close();
    const lcMsg = await guest1.next();
    ok(lcMsg.type === 'leader-changed' && lcMsg.leaderId === guest1Id,
      'leader departure with non-empty pending -> leader-changed to the new (only remaining) participant');
    const jrAgain = await guest1.next();
    ok(jrAgain.type === 'join-request' && jrAgain.peerId === jr4.peerId && jrAgain.name === null,
      'non-empty pending is re-forwarded to the new leader (join-request, name null)');

    // E2E v2: a leader change while pending is waiting sends IT a FRESH waiting
    // with the new leader (see section 26/27) — here we just drain this
    // message, the behavior itself is fully tested in section 27.
    const freshWaiting = await guest4.next();
    ok(freshWaiting.type === 'waiting' && freshWaiting.leaderPeerId === guest1Id,
      'leader change -> the waiting participant also receives a fresh waiting with the new leader');

    // The room empties out completely -> all still-alive waiting participants receive join-rejected.
    guest1.ws.close();
    const rejAll = await guest4.next();
    ok(rejAll.type === 'join-rejected', 'room emptied out while pending entries were alive -> join-rejected to the waiting participants');
    await guest4.closed;

    await Promise.all([leader.closed, guest1.closed]);
  }

  // === H2: room-count ceiling, per-IP limits, 3h call limit, headers ===

  // --- 21. Room-count ceiling (env MAX_ROOMS, separate server process) ---
  console.log('21. room-count ceiling (MAX_ROOMS)');
  {
    const port = 3312;
    const proc = spawnServer(port, { MAX_ROOMS: '2' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;

    const r1 = await createRoom(undefined, roomsUrl);
    ok(r1.status === 201, `first room is created with MAX_ROOMS=2 (status=${r1.status})`);
    const r2 = await createRoom(undefined, roomsUrl);
    ok(r2.status === 201, `second room is created with MAX_ROOMS=2 (status=${r2.status})`);
    const r3 = await createRoom(undefined, roomsUrl);
    ok(r3.status === 503, `third room once MAX_ROOMS=2 is exhausted -> 503 (status=${r3.status})`);

    await stopServer(proc);
  }

  // --- 22. Per-IP room-creation limit (H2, 429), the REAL prod default is
  // 3/60s (see state::DEFAULT_ROOM_CREATION_IP_LIMIT) — tightened from the old
  // 10/60s. The main test process (see startServer()) keeps this limit
  // raised via env far beyond what this file could possibly flood, so we
  // check the actual limit on a SEPARATE isolated server process with an
  // explicit ROOM_CREATION_IP_LIMIT=3 — this same test also
  // checks the configurability of the limit via env (see main.rs::ROOM_CREATION_IP_LIMIT). ---
  console.log('22. per-IP room-creation limit, default tightened to 3/60s (429)');
  {
    const port = 3316;
    const proc = spawnServer(port, { ROOM_CREATION_IP_LIMIT: '3' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;

    const ip = '203.0.113.5';
    let allCreated = true;
    for (let i = 0; i < 3; i++) {
      const r = await createRoom(undefined, roomsUrl, ip);
      if (r.status !== 201) allCreated = false;
    }
    ok(allCreated, '3 room creations in the window from one IP — all within the 3/60s limit (201)');

    const fourth = await createRoom(undefined, roomsUrl, ip);
    ok(fourth.status === 429, `4th creation in the window from the same IP -> 429 with a limit of 3 (status=${fourth.status})`);

    // A different IP — its own independent budget.
    const otherIp = '203.0.113.6';
    const otherIpResult = await createRoom(undefined, roomsUrl, otherIp);
    ok(otherIpResult.status === 201, `creation from a DIFFERENT IP is unaffected by the first one's limit (status=${otherIpResult.status})`);

    await stopServer(proc);
  }

  // --- 22b. Per-IP limit on PUT /api/rooms/{id} — shares the budget with POST (H2,
  // §3.1), the same tightened 3/60s limit. Its own separate isolated
  // server process (as in section 22 — the shared POST/PUT budget can't be
  // checked on the main test process, whose limit is raised via env). ---
  console.log('22b. per-IP limit on PUT /api/rooms/{id}, shared with POST, limit 3/60s (429)');
  {
    const port = 3317;
    const proc = spawnServer(port, { ROOM_CREATION_IP_LIMIT: '3' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;

    const ip = '203.0.113.61';
    // 1 creation via POST + 2 restores via PUT = 3 requests in the window
    // from one IP — via DIFFERENT paths of the same budget
    // (ROOM_CREATION_IP_LIMIT), proving the budget is shared.
    let allOk = true;
    const first = await createRoom(undefined, roomsUrl, ip);
    if (first.status !== 201) allOk = false;
    for (let i = 0; i < 2; i++) {
      const freshId = `pb${String(i).padStart(6, '0')}`; // valid format ^[a-z0-9]{8}$, deliberately never existed
      const r = await restoreRoom(freshId, ip, roomsUrl);
      if (r.status !== 201) allOk = false;
    }
    ok(allOk, '1 POST + 2 PUT = 3 requests in the window from one IP — all within the shared 3/60s limit (201)');

    const fourthPut = await restoreRoom('pbfourth', ip, roomsUrl);
    ok(fourthPut.status === 429,
      `4th request (PUT) from the same IP -> 429, the budget shared with POST (3) is exhausted (status=${fourthPut.status})`);
    const fourthPost = await createRoom(undefined, roomsUrl, ip);
    ok(fourthPost.status === 429,
      `POST from the same IP is also rejected — the budget really is shared (status=${fourthPost.status})`);

    // A different IP — its own budget, unaffected.
    const otherIp = '203.0.113.62';
    const otherPut = await restoreRoom('pbother1', otherIp, roomsUrl);
    ok(otherPut.status === 201, `PUT from a DIFFERENT IP is unaffected by someone else's limit (status=${otherPut.status})`);

    await stopServer(proc);
  }

  // --- 22c. Per-IP limit on a direct join-room into a room (H2, §3.2 — the main
  // hole) + a legitimate reconnect is not blocked by this same limit. Separate
  // isolated server process with the REAL default JOIN_ROOM_IP_LIMIT
  // (20/60s, not overridden) — see the comment on startServer() about
  // why this limit can't be checked on the main test process. ---
  console.log('22c. per-IP limit on a direct join-room (§3.2) + reconnect is not blocked');
  {
    const port = 3315;
    // Raise MAX_PARTICIPANTS far beyond how many joins we'll need to
    // flood (otherwise the room would hit room-full on its own long
    // before the per-IP limit and mix up two different reasons for rejection).
    const proc = spawnServer(port, { MAX_PARTICIPANTS: '25' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: floodRoomId } = await createRoom(undefined, roomsUrl);

    // A participant whose peerId we'll later use to check a legitimate
    // reconnect — a regular join, consumes 1 unit of the JOIN_ROOM_IP_LIMIT budget,
    // just like any other join.
    const zombieId = genUuid();
    const { peer: zombie, joined: zombieJoined } = await join(floodRoomId, undefined, wsUrl, zombieId);
    ok(zombieJoined.peerId === zombieId, 'participant joined with its desired peerId (1/20 of the budget)');

    // 19 more regular joins bring the window limit up to exactly 20 (1 was
    // already spent above) — we keep the sockets open on purpose, so the reaper/
    // MAX_PARTICIPANTS doesn't blur the point of the test.
    const flooders = [];
    for (let i = 0; i < 19; i++) {
      const { peer, joined } = await join(floodRoomId, undefined, wsUrl);
      ok(joined.type === 'joined', `join #${i + 2} of 20, within the limit`);
      flooders.push(peer);
    }

    // The 21st join (not a reconnect, a random new peerId) -> rejected by the limit.
    const over = await connect(wsUrl);
    over.send({ type: 'join-room', roomId: floodRoomId });
    const overMsg = await over.next();
    ok(overMsg.type === 'error' && /too many join attempts/.test(overMsg.message),
      `21st join in the window from one IP -> rejected by the limit (got ${overMsg.type}: ${overMsg.message})`);
    await over.closed;
    ok(true, 'server closed the socket after rejecting due to the join limit');

    // RECONNECT with its own already-taken peerId — should not trip over the
    // limit that was just exhausted: not a new join for budget purposes (see
    // src/ws.rs::reconnect_participant).
    const { peer: reconnected, joined: reconnJoined } = await join(floodRoomId, undefined, wsUrl, zombieId);
    ok(reconnJoined.type === 'joined' && reconnJoined.peerId === zombieId,
      'reconnect with its own already-taken peerId goes through, despite the exhausted per-IP limit');

    // Relay to zombieId now goes to the NEW connection.
    sendBeacon(flooders[0], zombieId, { kind: 'reconnect-check' });
    const beacon = await reconnected.next();
    ok(isBeaconMsg(beacon) && beacon.info.kind === 'reconnect-check',
      'relay to the peerId after reconnect goes to the new connection');

    // Close the old (zombie) connection — should not corrupt the state of
    // the reconnected participant (same_channel check in cleanup_peer).
    zombie.ws.close();
    await sleep(300);
    sendBeacon(flooders[0], zombieId, { kind: 'after-zombie-close' });
    const beacon2 = await reconnected.next();
    ok(isBeaconMsg(beacon2) && beacon2.info.kind === 'after-zombie-close',
      'after closing the zombie socket, the reconnected participant stays in the room');

    reconnected.ws.close();
    for (const p of flooders) p.ws.close();
    await stopServer(proc);
  }

  // --- 23. Call duration limit (MAX_ROOM_LIFETIME_SECONDS) ---
  console.log('23. call duration limit (room-expired)');
  {
    const port = 3313;
    const proc = spawnServer(port, { MAX_ROOM_LIFETIME_SECONDS: '3' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: lifeRoomId } = await createRoom(undefined, roomsUrl);
    const { peer, joined } = await join(lifeRoomId, 'Life', wsUrl);
    ok(typeof joined.expiresInSeconds === 'number' && joined.expiresInSeconds >= 1 && joined.expiresInSeconds <= 3,
      `joined.expiresInSeconds ~3 with MAX_ROOM_LIFETIME_SECONDS=3 (got ${joined.expiresInSeconds})`);

    const expired = await peer.next(6000); // the reaper ticks once a second, limit is 3s — 6s is more than enough
    ok(expired.type === 'room-expired', `room-expired arrives once the duration limit expires (got ${expired.type})`);
    await peer.closed;
    ok(true, 'server closed the socket right after room-expired');

    // The room is fully removed by the reaper -> a subsequent join -> room-not-found.
    const late = await connect(wsUrl);
    late.send({ type: 'join-room', roomId: lifeRoomId });
    const m = await late.next();
    ok(m.type === 'room-not-found', 'room removed by the reaper after the call duration limit expired');

    await stopServer(proc);
  }

  // --- 23b. Participant-count ceiling (env MAX_PARTICIPANTS) ---
  console.log('23b. participant-count ceiling (MAX_PARTICIPANTS)');
  {
    const port = 3314;
    const proc = spawnServer(port, { MAX_PARTICIPANTS: '2' });
    await waitForReady(`http://localhost:${port}/config`, proc);
    const roomsUrl = `http://localhost:${port}/api/rooms`;
    const wsUrl = `ws://localhost:${port}/ws`;

    const { roomId: capRoomId } = await createRoom(undefined, roomsUrl);
    const { peer: p1, joined: j1 } = await join(capRoomId, 'First', wsUrl);
    ok(j1.maxParticipants === 2, `joined.maxParticipants === 2 with MAX_PARTICIPANTS=2 (got ${j1.maxParticipants})`);

    const { peer: p2, joined: j2 } = await join(capRoomId, 'Second', wsUrl);
    ok(j2.type === 'joined', 'second participant joins with MAX_PARTICIPANTS=2 (limit not yet reached)');
    await p1.next(); // peer-joined to the first

    const third = await connect(wsUrl);
    third.send({ type: 'join-room', roomId: capRoomId });
    const m = await third.next();
    ok(m.type === 'room-full', `3rd participant received room-full with MAX_PARTICIPANTS=2 (got ${m.type})`);
    await third.closed;

    p1.ws.close();
    p2.ws.close();
    await stopServer(proc);
  }

  // --- 24. Security headers on API responses (M2) ---
  console.log('24. security headers on /config');
  {
    const res = await fetch(CONFIG_URL);
    ok(res.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff on /config');
    ok(res.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer on /config');
  }

  // === E2E v2 ("variant E", see docs/research-p2p-key-handoff.md §6.5-6.6) ===

  // --- 25. epub: join-room -> joined.peers[].epub / peer-joined.epub / join-request.epub; validation cap ---
  console.log('25. epub in joined.peers[] / peer-joined / length validation');
  {
    const { roomId: eRoomId, leaderToken: eLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const epubA = fakeEpub('A');
    const { peer: eA, joined: jA } = await join(eRoomId, 'A', URL, undefined, eLeaderToken, epubA);
    ok(jA.leaderId === jA.peerId, 'A with leaderToken becomes leader');

    const epubB = fakeEpub('B');
    const { peer: eB, joined: jB } = await join(eRoomId, 'B', URL, undefined, undefined, epubB);
    ok(jB.peers.length === 1 && jB.peers[0].peerId === jA.peerId && jB.peers[0].epub === epubA,
      'joined.peers[] contains the first participant\'s epub');
    const pjA1 = await eA.next();
    ok(pjA1.type === 'peer-joined' && pjA1.peerId === jB.peerId && pjA1.epub === epubB,
      'peer-joined contains the new participant\'s epub');

    // Without epub at all (backward compatibility with an old/v1 client).
    const { peer: eC, joined: jC } = await join(eRoomId, 'C');
    ok(jC.type === 'joined', 'joining without epub is not rejected outright (backward compatibility)');
    ok(jC.peers.some((p) => p.peerId === jA.peerId && p.epub === epubA)
      && jC.peers.some((p) => p.peerId === jB.peerId && p.epub === epubB),
      'joined.peers[] correctly contains the epub of previous participants');
    const [pjA2, pjB2] = await Promise.all([eA.next(), eB.next()]);
    ok(pjA2.epub === null && pjB2.epub === null, 'peer-joined without an epub from the sender -> epub null');

    // epub longer than EPUB_MAX_CHARS (200) — the server doesn't parse the content, but
    // caps the length: an invalidly long epub is dropped entirely (not
    // truncated — a truncated key is meaningless), as if it weren't there.
    const { peer: eD, joined: jD } = await join(eRoomId, 'D', URL, undefined, undefined, 'z'.repeat(250));
    ok(jD.type === 'joined', 'joining with an epub longer than 200 chars is not rejected outright');
    ok(jD.peers.find((p) => p.peerId === jC.peerId).epub === null, 'C never had an epub to begin with — stays null for D too');
    const [pjA3, pjB3, pjC3] = await Promise.all([eA.next(), eB.next(), eC.next()]);
    ok(pjA3.epub === null && pjB3.epub === null && pjC3.epub === null,
      'epub longer than 200 chars -> peer-joined.epub null (server caps the invalid length)');

    // An empty epub string is also invalid (a non-empty string is required).
    const { peer: eE, joined: jE } = await join(eRoomId, 'E', URL, undefined, undefined, '');
    ok(jE.type === 'joined', 'joining with an empty epub is not rejected outright');
    const [pjA4, pjB4, pjC4, pjD4] = await Promise.all([eA.next(), eB.next(), eC.next(), eD.next()]);
    ok(pjA4.epub === null && pjB4.epub === null && pjC4.epub === null && pjD4.epub === null,
      'empty epub string -> peer-joined.epub null');

    eA.ws.close(); eB.ws.close(); eC.ws.close(); eD.ws.close(); eE.ws.close();
  }

  // --- 26. waiting: leaderPeerId + leaderEpub; join-request.epub ---
  console.log('26. waiting contains leaderPeerId/leaderEpub, join-request contains epub');
  {
    const { roomId: wRoomId, leaderToken: wLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const leaderEpub = fakeEpub('Leader26');
    const { peer: wLeader, joined: wLeaderJoined } = await join(wRoomId, 'Leader', URL, undefined, wLeaderToken, leaderEpub);
    updateSettings(wLeader, defaultSettings({ lobbyEnabled: true }));
    await wLeader.next(); // settings-changed

    const wGuest = await connect();
    const guestEpub = fakeEpub('Guest26');
    wGuest.send({ type: 'join-room', roomId: wRoomId, name: 'Guest', epub: guestEpub });
    const waitMsg = await wGuest.next();
    ok(waitMsg.type === 'waiting' && waitMsg.leaderPeerId === wLeaderJoined.peerId && waitMsg.leaderEpub === leaderEpub,
      'waiting contains the current leader\'s leaderPeerId and leaderEpub');
    const jr = await wLeader.next();
    ok(jr.type === 'join-request' && jr.epub === guestEpub, 'join-request contains the waiting participant\'s epub');

    wGuest.ws.close();
    await wLeader.next(); // join-request-cancelled
    wLeader.ws.close();
  }

  // --- 27. Leader handoff with non-empty pending -> each pending gets a FRESH waiting with the new leader ---
  console.log('27. leader handoff with pending waiting -> fresh waiting');
  {
    const { roomId: fwRoomId, leaderToken: fwLeaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const leaderEpub1 = fakeEpub('L1-27');
    const { peer: fwLeader, joined: fwLeaderJoined } = await join(fwRoomId, 'L1', URL, undefined, fwLeaderToken, leaderEpub1);

    // The second participant joins the REGULAR way, while the lobby is still
    // disabled — otherwise (if the lobby were already enabled) it would end up
    // in pending itself, not among the participants, and couldn't become a
    // candidate for the new leader (candidates are only full participants, see
    // `cleanup_peer`).
    const secondEpub = fakeEpub('L2-27');
    const { peer: fwSecond, joined: fwSecondJoined } = await join(fwRoomId, 'L2', URL, undefined, undefined, secondEpub);
    await fwLeader.next(); // peer-joined

    // Now enable the lobby — settings-changed goes out to both current participants.
    updateSettings(fwLeader, defaultSettings({ lobbyEnabled: true }));
    await Promise.all([fwLeader.next(), fwSecond.next()]); // settings-changed

    // A waiting participant applies while L1 is still leader.
    const fwPending = await connect();
    const pendingEpub = fakeEpub('Pending27');
    fwPending.send({ type: 'join-room', roomId: fwRoomId, name: 'Waiting', epub: pendingEpub });
    const wait1 = await fwPending.next();
    ok(wait1.leaderPeerId === fwLeaderJoined.peerId && wait1.leaderEpub === leaderEpub1,
      'the first waiting points at the original leader L1');
    const jr1 = await fwLeader.next(); // join-request
    ok(jr1.type === 'join-request' && jr1.epub === pendingEpub, 'the first join-request contains the waiting participant\'s epub');

    // The leader leaves -> L2 becomes leader -> pending receives a FRESH waiting.
    fwLeader.ws.close();
    const [lc, wait2] = await Promise.all([fwSecond.next(), fwPending.next()]);
    ok(lc.type === 'leader-changed' && lc.leaderId === fwSecondJoined.peerId, 'leader-changed to the new leader L2');
    ok(wait2.type === 'waiting' && wait2.leaderPeerId === fwSecondJoined.peerId && wait2.leaderEpub === secondEpub,
      'pending receives a fresh waiting with the new leader (L2) and its epub');
    const jr2 = await fwSecond.next();
    ok(jr2.type === 'join-request' && jr2.peerId === jr1.peerId && jr2.epub === pendingEpub,
      'join-request is re-forwarded to the new leader, with the same peerId and epub of the waiting participant');

    fwPending.ws.close();
    await fwSecond.next(); // join-request-cancelled
    fwSecond.ws.close();
  }

  // --- 28. name-announce: participant -> participant is delivered ---
  console.log('28. name-announce participant->participant');
  {
    const { roomId: naRoomId } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: naA, joined: jNaA } = await join(naRoomId, 'A');
    const { peer: naB, joined: jNaB } = await join(naRoomId, 'B');
    await naA.next(); // peer-joined B

    naA.send({ type: 'name-announce', to: jNaB.peerId, payload: 'cipherblob-A-to-B' });
    const recv = await naB.next();
    ok(recv.type === 'name-announce' && recv.from === jNaA.peerId && recv.payload === 'cipherblob-A-to-B',
      'name-announce participant->participant delivered with the correct from');

    naA.ws.close();
    await naB.next(); // peer-left
    naB.ws.close();
  }

  // --- 29. name-announce: pending -> leader is delivered; pending -> NON-leader is forbidden ---
  console.log('29. name-announce pending->leader delivered, pending->NON-leader forbidden');
  {
    const { roomId: naRoomId2, leaderToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: leader, joined: leaderJoined } = await join(naRoomId2, 'Leader', URL, undefined, leaderToken);
    const { peer: other, joined: otherJoined } = await join(naRoomId2, 'Other'); // regular participant, not the leader
    await leader.next(); // peer-joined

    updateSettings(leader, defaultSettings({ lobbyEnabled: true }));
    await Promise.all([leader.next(), other.next()]); // settings-changed to both

    const pending = await connect();
    pending.send({ type: 'join-room', roomId: naRoomId2, name: 'Waiting' });
    await pending.next(); // waiting
    await leader.next(); // join-request

    // pending -> leader: delivered.
    pending.send({ type: 'name-announce', to: leaderJoined.peerId, payload: 'pending-to-leader' });
    const toLeader = await leader.next();
    ok(toLeader.type === 'name-announce' && toLeader.from && toLeader.payload === 'pending-to-leader',
      'name-announce pending->leader delivered');

    // pending -> non-leader: explicit rejection (not a race/silent drop — a permission violation), socket doesn't break.
    pending.send({ type: 'name-announce', to: otherJoined.peerId, payload: 'pending-to-nonleader' });
    const errMsg = await pending.next();
    ok(errMsg.type === 'error', `name-announce pending->non-leader rejected with an explicit error (${errMsg.message})`);
    sendBeacon(leader, otherJoined.peerId, { kind: 'text', text: 'beacon-after-name-announce-not-leader' });
    const beacon = await other.next();
    ok(isBeaconMsg(beacon) && beacon.info.text === 'beacon-after-name-announce-not-leader',
      'the other participants\' sockets are alive, the disallowed name-announce did not reach them');

    pending.ws.close();
    await leader.next(); // join-request-cancelled
    leader.ws.close();
    await other.next(); // leader-changed (other becomes the sole remaining leader)
    await other.next(); // peer-left of the departed leader
    other.ws.close();
  }

  // --- 30. name-announce: payload size limit (H2, 2KB) ---
  console.log('30. name-announce: payload size limit (2KB)');
  {
    const { roomId: bigRoomId } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: bigA, joined: jBigA } = await join(bigRoomId, 'A');
    const { peer: bigB, joined: jBigB } = await join(bigRoomId, 'B');
    await bigA.next(); // peer-joined

    const bigPayload = 'x'.repeat(2 * 1024 + 1); // 1 byte over the limit
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: bigPayload });
    const errMsg = await bigA.next();
    ok(errMsg.type === 'error', `name-announce payload >2KB -> error to the sender (${errMsg.message})`);

    // Prove non-delivery: the next valid name-announce arrives as a beacon.
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: 'beacon-after-oversize-name-announce' });
    const beacon = await bigB.next();
    ok(beacon.type === 'name-announce' && beacon.payload === 'beacon-after-oversize-name-announce',
      'name-announce >2KB not delivered; the next valid one arrived as-is');

    // Payload sized exactly at the limit (2KB) — passes through in full.
    const okPayload = 'y'.repeat(2 * 1024);
    bigA.send({ type: 'name-announce', to: jBigB.peerId, payload: okPayload });
    const okMsg = await bigB.next();
    ok(okMsg.type === 'name-announce' && okMsg.payload.length === okPayload.length,
      'name-announce sized exactly 2KB delivered in full');

    bigA.ws.close();
    await bigB.next(); // peer-left
    bigB.ws.close();
  }

  // --- 31. lifetimeSeconds in POST /api/rooms and PUT /api/rooms/{id} ---
  console.log('31. lifetimeSeconds in POST/PUT /api/rooms');
  {
    const { status, lifetimeSeconds } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    ok(status === 201 && typeof lifetimeSeconds === 'number' && lifetimeSeconds > 0,
      `POST /api/rooms returns lifetimeSeconds (got ${lifetimeSeconds})`);
    // Default without MAX_ROOM_LIFETIME_SECONDS is 3h (10800s), see
    // DEFAULT_MAX_ROOM_LIFETIME_SECONDS in src/state.rs.
    ok(lifetimeSeconds === 10800, `default lifetimeSeconds is 10800s/3h (got ${lifetimeSeconds})`);

    // PUT — same field, for API symmetry (see the E2E v2 spec §2): both idempotency branches.
    const freshId2 = 'lt9k2m7q'; // valid format, deliberately never existed
    const created = await restoreRoom(freshId2, RESTORE_ROOM_TEST_IP);
    ok(created.status === 201 && created.lifetimeSeconds === 10800,
      `PUT restoring a non-existent room returns lifetimeSeconds (${created.lifetimeSeconds})`);
    const already = await restoreRoom(freshId2, RESTORE_ROOM_TEST_IP);
    ok(already.status === 200 && already.lifetimeSeconds === 10800,
      `PUT of an already-existing room also returns lifetimeSeconds (${already.lifetimeSeconds})`);
  }

  // --- 32. Leader-set participant limit (max_participants, docs/research-room-limit.md) ---
  console.log('32. leader-set participant limit (max_participants)');
  {
    const { roomId: capId, leaderToken: capToken } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: leader, joined: leaderJoined } = await join(capId, 'Leader', URL, undefined, capToken);
    ok(leaderJoined.maxParticipants === 6,
      `without its own limit, joined.maxParticipants is the server ceiling (got ${leaderJoined.maxParticipants})`);

    // Second and third join while the limit is still the default (server) one.
    const { peer: p2, joined: j2 } = await join(capId, 'Second');
    await leader.next(); // peer-joined
    const { peer: p3, joined: j3 } = await join(capId, 'Third');
    await Promise.all([leader.next(), p2.next()]); // peer-joined to both
    ok(j2.type === 'joined' && j3.type === 'joined', 'second and third joined under the server limit');

    // Leader sets its own limit of 2 — BELOW the current occupancy (3).
    updateSettings(leader, defaultSettings({ maxParticipants: 2 }));
    const [sc1, sc2, sc3] = await Promise.all([leader.next(), p2.next(), p3.next()]);
    ok(sc1.type === 'settings-changed' && sc1.settings.maxParticipants === 2
      && sc2.settings.maxParticipants === 2 && sc3.settings.maxParticipants === 2,
      'settings-changed carries the new maxParticipants=2 to all participants');

    // Nobody was kicked out — all three can still receive/send (beacon).
    sendBeacon(leader, j2.peerId, { kind: 'still-here' });
    const stillHere = await p2.next();
    ok(isBeaconMsg(stillHere) && stillHere.info.kind === 'still-here',
      'lowering the limit below occupancy does NOT kick out those already joined (D, §2.2)');

    // A new join is rejected — already 3 participants >= the effective limit of 2.
    const fourth = await connect();
    fourth.send({ type: 'join-room', roomId: capId });
    const roomFull1 = await fourth.next();
    ok(roomFull1.type === 'room-full', 'the fourth join is rejected — 3 participants >= the leader\'s limit (2)');
    await fourth.closed;

    // One leaves (3 -> 2) — still >= 2, still rejected.
    p3.ws.close();
    await Promise.all([leader.next(), p2.next()]); // peer-left
    const fifth = await connect();
    fifth.send({ type: 'join-room', roomId: capId });
    const roomFull2 = await fifth.next();
    ok(roomFull2.type === 'room-full', 'after one departure (2 participants), joining is still rejected — 2 >= limit of 2');
    await fifth.closed;

    // One more leaves (2 -> 1) — now 1 < 2, joining is allowed again.
    p2.ws.close();
    await leader.next(); // peer-left
    const { peer: p6, joined: j6 } = await join(capId, 'Sixth');
    ok(j6.type === 'joined' && j6.maxParticipants === 2,
      `after a slot frees up, joining is allowed again, joined.maxParticipants===2 (got ${j6.maxParticipants})`);
    await leader.next(); // peer-joined

    // update-settings boundary validation: maxParticipants=1 (< 2) -> rejected.
    updateSettings(leader, defaultSettings({ maxParticipants: 1 }));
    const errLow = await leader.next();
    ok(errLow.type === 'error', `maxParticipants=1 (< 2) rejected as invalid (${errLow.message})`);

    // maxParticipants=7 (> the server ceiling of 6) -> rejected.
    updateSettings(leader, defaultSettings({ maxParticipants: 7 }));
    const errHigh = await leader.next();
    ok(errHigh.type === 'error', `maxParticipants=7 (> the server ceiling of 6) rejected (${errHigh.message})`);

    // Confirm that BOTH rejected update-settings calls did NOT change
    // the effective limit — the room is still under the same one (count=2, limit=2).
    const seventh = await connect();
    seventh.send({ type: 'join-room', roomId: capId });
    const stillFull = await seventh.next();
    ok(stillFull.type === 'room-full',
      'after TWO rejected update-settings calls the limit stayed the same (2), joining is still rejected');
    await seventh.closed;

    // maxParticipants=6 (exactly the server ceiling, upper bound) — accepted.
    updateSettings(leader, defaultSettings({ maxParticipants: 6 }));
    const [scOk1, scOk2] = await Promise.all([leader.next(), p6.next()]);
    ok(scOk1.type === 'settings-changed' && scOk1.settings.maxParticipants === 6 && scOk2.settings.maxParticipants === 6,
      'maxParticipants=6 (exactly the server ceiling) accepted');

    const eighth = await join(capId, 'Eighth');
    ok(eighth.joined.type === 'joined', 'after raising the limit to 6, a new join is allowed again');
    await Promise.all([leader.next(), p6.next()]); // peer-joined

    leader.ws.close();
    p6.ws.close();
    eighth.peer.ws.close();
  }

  // --- 33. Prometheus metrics (src/metrics.rs, src/main.rs::spawn_metrics_server) ---
  console.log('33. /metrics on the management port: HELP/TYPE + gauges reflect actual state');
  {
    // Pre-registration (crate::metrics::describe(), see main.rs) — HELP/TYPE
    // should be present even before this run (the server has already run
    // sections 1-32 by this point, so events have definitely already happened, but
    // pre-registration itself is checked by the presence of the # HELP/# TYPE
    // lines, not by the fact of a first event).
    const res = await fetch(METRICS_URL);
    ok(res.ok, `GET ${METRICS_URL} responds 200`);
    const before = await res.text();
    for (const name of ['chat_rooms', 'chat_participants', 'chat_pending', 'chat_rooms_created_total', 'chat_websocket_connections']) {
      ok(before.includes(`# TYPE ${name} `), `/metrics contains "# TYPE ${name}" (pre-registration, describe())`);
    }

    // Create a room and connect a participant — the `chat_rooms`/
    // `chat_participants` gauges are updated by a periodic sampler in
    // `state::reap_rooms` (once every REAPER_INTERVAL=1s, see its comment),
    // so we wait a bit longer than a tick before comparing values.
    const { roomId: metricsRoomId } = await createRoom(undefined, ROOMS_URL, E2E_TEST_IP);
    const { peer: metricsPeer } = await join(metricsRoomId);
    await sleep(1300);

    const after = await (await fetch(METRICS_URL)).text();
    const gaugeValue = (text, name) => {
      const m = text.match(new RegExp(`^${name}\\s+(\\S+)$`, 'm'));
      return m ? Number(m[1]) : NaN;
    };
    ok(gaugeValue(after, 'chat_rooms') >= 1, `chat_rooms >= 1 after creating a room (${gaugeValue(after, 'chat_rooms')})`);
    ok(gaugeValue(after, 'chat_participants') >= 1,
      `chat_participants >= 1 after a participant joins (${gaugeValue(after, 'chat_participants')})`);
    ok(gaugeValue(after, 'chat_websocket_connections') >= 1,
      `chat_websocket_connections >= 1 with an open WS (${gaugeValue(after, 'chat_websocket_connections')})`);
    // The counter is monotonically non-decreasing; by this point sections 1-32 have
    // already created many rooms, so we just check "noticeably greater than zero",
    // not an exact number (an exact number isn't isolated from the other
    // sections and would be a brittle test).
    ok(gaugeValue(after, 'chat_rooms_created_total') > 10,
      `chat_rooms_created_total is noticeably greater than zero by this point in the run (${gaugeValue(after, 'chat_rooms_created_total')})`);

    metricsPeer.ws.close();
  }

  // --- 34. GET /api/rooms/{room_id}: unauthenticated pre-join preview ---
  console.log('34. GET /api/rooms/{roomId} — pre-join preview (participants/capacity/ageSeconds)');
  {
    // 404 for a room id that was never created.
    const missing = await roomStatus('nope5678');
    ok(missing.status === 404, `GET of a non-existent room -> 404 (status=${missing.status})`);

    // Freshly created, nobody has joined yet: participants=0, capacity is
    // the configured max (default 6, DEFAULT_MAX_PARTICIPANTS — this test
    // server has no MAX_PARTICIPANTS override), ageSeconds small.
    const { roomId: statusRoomId, leaderToken: statusLeaderToken } = await createRoom();
    const fresh = await roomStatus(statusRoomId);
    ok(fresh.status === 200, `GET of a freshly created room -> 200 (status=${fresh.status})`);
    ok(fresh.participants === 0, `participants === 0 before anyone joins (got ${fresh.participants})`);
    ok(fresh.capacity === 6, `capacity === 6 (DEFAULT_MAX_PARTICIPANTS, no env override) (got ${fresh.capacity})`);
    ok(typeof fresh.ageSeconds === 'number' && fresh.ageSeconds >= 0 && fresh.ageSeconds < 3,
      `ageSeconds is small right after creation (got ${fresh.ageSeconds})`);

    // ageSeconds grows with wall-clock time even though nobody has joined —
    // it's measured from Room::created_at (see src/state.rs::Room::age_seconds),
    // deliberately NOT from first_joined_at (which would stay 0 with no
    // participants at all — see the doc comment on age_seconds for why this
    // preview needs a different basis than the in-room roomAgeSeconds timer).
    await sleep(1200);
    const later = await roomStatus(statusRoomId);
    ok(later.ageSeconds >= 1 && later.ageSeconds >= fresh.ageSeconds,
      `ageSeconds advanced after waiting ~1.2s (before=${fresh.ageSeconds}, after=${later.ageSeconds})`);

    // A real participant joins over /ws -> participants becomes 1.
    const { peer: statusLeader } = await join(statusRoomId, 'Leader', URL, undefined, statusLeaderToken);
    const withOneJoined = await roomStatus(statusRoomId);
    ok(withOneJoined.participants === 1, `participants === 1 after a real WS participant joins (got ${withOneJoined.participants})`);

    // A peer waiting in the lobby (lobbyEnabled=true) is NOT a room
    // participant (see Room::pending vs Room::participants) and must NOT be
    // counted here.
    updateSettings(statusLeader, defaultSettings({ lobbyEnabled: true }));
    await statusLeader.next(); // settings-changed
    const statusGuest = await connect();
    statusGuest.send({ type: 'join-room', roomId: statusRoomId, name: 'Waiting' });
    const waitMsg = await statusGuest.next();
    ok(waitMsg.type === 'waiting', 'guest enters the lobby (waiting), not the room, while lobbyEnabled=true');
    const withPending = await roomStatus(statusRoomId);
    ok(withPending.participants === 1,
      `a peer waiting in the lobby does NOT increase participants (still got ${withPending.participants})`);

    statusGuest.ws.close();
    statusLeader.ws.close();

    // Security headers (M2) — same assertions as section 24's /config check,
    // applied to this endpoint (route_layer(cors) covers it the same way).
    ok(fresh.headers.get('x-content-type-options') === 'nosniff',
      'X-Content-Type-Options: nosniff on GET /api/rooms/{roomId}');
    ok(fresh.headers.get('referrer-policy') === 'no-referrer',
      'Referrer-Policy: no-referrer on GET /api/rooms/{roomId}');
  }
}

// --- main --------------------------------------------------------------

async function main() {
  buildServer();
  startServer();
  try {
    await waitForReady(CONFIG_URL, serverProc);
    await runTests();
  } finally {
    console.log(`\nTotal: ${passed} ok, ${failed} fail`);
  }
}

main()
  .then(() => { cleanup(); process.exit(failed ? 1 : 0); })
  .catch((e) => {
    console.error('Test crashed with an exception:', e);
    failed += 1;
    console.log(`\nTotal: ${passed} ok, ${failed} fail`);
    cleanup();
    process.exit(1);
  });
