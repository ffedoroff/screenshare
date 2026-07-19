// room.js — single room page, protocol v2 (symmetric room).
//
// All participants are equal and connect in a mesh: each other participant
// gets its own RtcPeer (see rtc.js, perfect negotiation). The polite/impolite
// role is not tied to a participant type (there's no broadcaster/viewer
// anymore) — it's deterministically derived from comparing peerId: whoever
// has the lexicographically GREATER peerId is polite. Both sides compute the
// same comparison over the same pair of ids, so exactly one of the two gets
// polite=true — offer collisions are resolved as usual (see rtc.js).
//
// roomId is taken from the URL (last pathname segment), same as before in viewer.js.

'use strict';

// --- Anonymity: leaderToken from the link fragment (see static/landing.js —
// POST /api/rooms -> redirects to /r/<id>#lt=<token>&t=<token>&e=<expiry>&n=<name>)
// is read BEFORE ANYTHING ELSE. From the address bar we clean up ONLY the
// one-time #lt (after the first join it's burned by the server and useless,
// no point exposing it). `#t`/`#e`/`#n` don't need cleaning up — they ARE
// PART of the invite link (see below) and stay in the address bar for all
// participants (in particular — they survive F5, see init/initCryptoIdentity).
//
// E2E v2 ("variant E", see docs/research-p2p-key-handoff.md §6.5–6.6 and
// static/crypto.js): `t` — static PSK link token (16 bytes,
// base64url) — it NEVER encrypts traffic itself, only authenticates.
// `e` — link expiry moment (unix seconds, base36) — part of the K_auth
// derivation, can't be forged (see static/crypto.js). Both are DELIBERATELY
// KEPT in the address bar: the link itself IS the secret by design (it's
// what gets shared), and keeping t/e in the URL allows surviving F5 —
// otherwise a reload would kick you out of the room ("incomplete link"),
// given that storing the secret in storage is forbidden (full anonymity).
// Same pattern as Excalidraw. The fragment never goes to the server by
// itself.
//
// The actual encryption keys (K_pair_sig/K_pair_meta for each pair of
// participants) are EPHEMERAL: derived anew by each tab on entry from its
// own one-time ECDH P-256 pair + K_auth(t,e), see initCryptoIdentity below
// and static/crypto.js. `t`/`e` are parsed RIGHT HERE — before the page has
// had a chance to show anything, and before any contact with signaling.
//
// `n` — the room name that the CREATOR entered on the landing page (see
// static/landing.js, static/namegen.js). It used to live only in the
// one-time #lt fragment and would disappear for the creator after the first
// F5, while guests never saw it at all. Now `n` is PART of the invite link
// (buildShareLink puts it there) and stays in the address bar
// (`#t=...&e=...&n=...`) for EVERYONE who joined via the link — all
// participants see the room name, and it survives F5. The key invariant is
// unchanged: the server never sees the fragment (it never travels over the
// network), so the room name remains unknown to the server too. Malformed
// percent-encoding (e.g. from manually editing the URL) must not crash the
// page — decodeURIComponent is wrapped in try/catch, and on error the name
// is simply absent (null).
const { initialLeaderToken, linkTokenBase64url, linkExpiry, initialRoomName } = (() => {
  const hash = location.hash;
  const ltMatch = hash.match(/(?:^|[&#])lt=([^&]+)/);
  const tMatch = hash.match(/(?:^|[&#])t=([^&]+)/);
  const eMatch = hash.match(/(?:^|[&#])e=([^&]+)/);
  const nMatch = hash.match(/(?:^|[&#])n=([^&]+)/);
  const lt = ltMatch ? decodeURIComponent(ltMatch[1]) : null;
  // `t` (base64url) and `e` (base36) consist only of URL-safe characters —
  // decodeURIComponent isn't needed (it wouldn't hurt either, but isn't
  // needed). Further format validation happens in initCryptoIdentity (see
  // below), not here: here it's just plain extraction from the fragment.
  const t = tMatch ? tMatch[1] : null;
  const e = eMatch ? eMatch[1] : null;
  let n = null;
  if (nMatch) {
    try {
      n = decodeURIComponent(nMatch[1]);
    } catch (err) {
      n = null; // malformed percent-encoding — just go without a name, don't crash the page
    }
  }
  if (lt) {
    // Rebuild the fragment without lt (a one-time secret — no point exposing
    // it in the address bar), keeping t/e/n. We take `n` from the already
    // decoded `n` and re-encode it (rather than carrying nMatch[1] over
    // as-is) — this guarantees no double-encoding and no stale
    // percent-encoding from an invalid/manually edited URL.
    const parts = [];
    if (t) parts.push(`t=${t}`);
    if (e) parts.push(`e=${e}`);
    if (n) parts.push(`n=${encodeURIComponent(n)}`);
    history.replaceState(null, '', location.pathname + location.search + (parts.length ? `#${parts.join('&')}` : ''));
  }
  return { initialLeaderToken: lt, linkTokenBase64url: t, linkExpiry: e, initialRoomName: n };
})();

// --- Local render of the room name (visible to ALL participants who joined
// via an invite link with `n` — see comment above) — done IMMEDIATELY,
// before init(), so the tab title and header don't flash the default text.
// If the link had no `n` (e.g. a link without a room name), .room-logo/title
// stay at their defaults.
if (initialRoomName) {
  document.title = `${initialRoomName} — video call`;
  const roomLogoEl = document.querySelector('.room-logo');
  if (roomLogoEl) roomLogoEl.textContent = initialRoomName;
}

// --- DOM ---
const joinModalEl = document.getElementById('join-modal');
const joinNameInputEl = document.getElementById('join-name-input');
const joinNameRegenButtonEl = document.getElementById('join-name-regen-button');
const joinModalButtonEl = document.getElementById('join-modal-button');
const toastEl = document.getElementById('toast');
const overlayEl = document.getElementById('overlay');
const overlaySpinnerEl = document.getElementById('overlay-spinner');
const overlayTitleEl = document.getElementById('overlay-title');
const overlayTextEl = document.getElementById('overlay-text');
const overlayActionButtonEl = document.getElementById('overlay-action-button');
const participantCountEl = document.getElementById('participant-count');
const roomTimerEl = document.getElementById('room-timer');
const topbarSasEl = document.getElementById('topbar-sas');
const topbarSasPopupEl = document.getElementById('topbar-sas-popup');
const topbarSasPopupBackdropEl = document.getElementById('topbar-sas-popup-backdrop');
const topbarSasPopupEmojiEl = document.getElementById('topbar-sas-popup-emoji');
const topbarSasPopupTextEl = document.getElementById('topbar-sas-popup-text');
const topbarSasPopupHexEl = document.getElementById('topbar-sas-popup-hex');
const screenStageEl = document.getElementById('screen-stage');
const screenVideoEl = document.getElementById('screen-video');
const screenSelfPlaceholderEl = document.getElementById('screen-self-placeholder');
const screenCaptionEl = document.getElementById('screen-caption');
const tilesGridEl = document.getElementById('tiles-grid');
const roomMessageEl = document.getElementById('room-message');
const inviteCtaEl = document.getElementById('invite-cta');
const inviteCtaButtonEl = document.getElementById('invite-cta-button');
const micButton = document.getElementById('mic-button');
const cameraButton = document.getElementById('camera-button');
const screenButton = document.getElementById('screen-button');
const shareButton = document.getElementById('share-button');
const chatButton = document.getElementById('chat-button');
const leaveButton = document.getElementById('leave-button');
const sharePopupEl = document.getElementById('share-popup');
const sharePopupBackdropEl = document.getElementById('share-popup-backdrop');
const sharePopupCloseEl = document.getElementById('share-popup-close');
const sharePopupQrEl = document.getElementById('share-popup-qr');
const sharePopupLinkEl = document.getElementById('share-popup-link');
const sharePopupBuildEl = document.getElementById('share-popup-build');
const sharePopupBuildShortEl = document.getElementById('share-popup-build-short');
const sharePopupBuildFullEl = document.getElementById('share-popup-build-full');
const sharePopupCopyButtonEl = document.getElementById('share-popup-copy-button');
const reconnectBannerEl = document.getElementById('reconnect-banner');
const versionBannerEl = document.getElementById('version-banner');
const versionBannerReloadButtonEl = document.getElementById('version-banner-reload-button');

// --- DOM: permissions and leader (see docs/permissions-and-leader.md) ---
const settingsButton = document.getElementById('settings-button');
const settingsBadgeEl = document.getElementById('settings-badge');
const joinRequestsEl = document.getElementById('join-requests');
const settingsPanelEl = document.getElementById('settings-panel');
const settingsPanelBackdropEl = document.getElementById('settings-panel-backdrop');
const settingsPanelCloseEl = document.getElementById('settings-panel-close');
const settingsRoomSectionEl = document.getElementById('settings-room-section');
const settingLobbyInput = document.getElementById('setting-lobby');
const settingGuestChatInput = document.getElementById('setting-guest-chat');
const settingGuestAudioInput = document.getElementById('setting-guest-audio');
const settingGuestVideoInput = document.getElementById('setting-guest-video');
const settingGuestScreenInput = document.getElementById('setting-guest-screen');
const settingMaxParticipantsInput = document.getElementById('setting-max-participants');

// --- DOM: "Connection and privacy" (see section below) — visible to ALL participants ---
const settingsCryptoRowEl = document.getElementById('settings-crypto-row');
const settingsCryptoTextEl = document.getElementById('settings-crypto-text');
const settingsPeersListEl = document.getElementById('settings-peers-list');
const settingsSignalingCountEl = document.getElementById('settings-signaling-count');
const settingsServerTrafficEl = document.getElementById('settings-server-traffic');
const settingsBuildRowEl = document.getElementById('settings-build-row');
const settingsBuildTextEl = document.getElementById('settings-build-text');

// --- DOM: devices (see the "Camera and microphone selection" section header below) — visible to ALL participants, not just the leader ---
const settingMicDeviceSelect = document.getElementById('setting-mic-device');
const settingCameraDeviceSelect = document.getElementById('setting-camera-device');

// --- DOM: fullscreen button for the screen-share stage ---
const screenFullscreenButtonEl = document.getElementById('screen-fullscreen-button');

// Static markup (doesn't depend on user data) — safe for innerHTML.
const CROWN_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 19h18l-1.6-9.6-5.2 3.6L12 5l-2.2 8-5.2-3.6L3 19z"/></svg>';

// Muted-mic icon on the tile (see the "Mic off" indicator section below) —
// also static markup.
const MIC_OFF_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="11" rx="3"></rect>' +
  '<path d="M5 10a7 7 0 0 0 14 0"></path>' +
  '<line x1="12" y1="19" x2="12" y2="22"></line>' +
  '<line x1="8" y1="22" x2="16" y2="22"></line>' +
  '<line x1="3" y1="3" x2="21" y2="21"></line>' +
  '</svg>';

// roomId — the last path segment, e.g. /r/abc123 -> "abc123".
const roomId = location.pathname.split('/').filter(Boolean).pop();

// Mobile browsers (Android Chrome, iOS Safari) don't implement
// getDisplayMedia — there's no native screen capture from the web on them at
// all (it's not a permissions issue, the method simply isn't in the API). In
// that case we don't disable the "Screen" button (that would imply
// "temporarily unavailable"), we hide it entirely — we don't promise
// functionality that fundamentally doesn't exist on this device.
const screenShareSupported = !!(
  navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'
);
if (!screenShareSupported) {
  screenButton.classList.add('hidden');
}

// --- E2E v2: cryptographic identity of the tab (see static/crypto.js) ---
// Derived ONCE at page startup (see init/initCryptoIdentity below), BEFORE
// join-room — null while derivation hasn't completed (or hasn't started).
// Unlike room-wide v1 (a single K_sig/K_meta for the whole room), these are
// PERSONAL materials of the tab, from which a separate key pair is derived
// for EACH peer individually (see pairKeysCache below) — no single
// encryption key is shared across the room.
let myEphemeralKeyPair = null; // {publicKey, privateKey} — ECDH P-256, one-time per tab (PFS)
let myEpub = null; // base64url(raw) export of the public half — this is what goes over the wire as `epub`
let kAuthBytes = null; // K_auth (see static/crypto.js: deriveAuthKey) — HKDF salt for ALL pairwise keys
// Cache of pairwise keys: peerId -> Promise<{sigKey, metaKey}> — populated
// lazily as soon as this peer's `epub` becomes known (joined.peers[]/
// peer-joined/join-request/waiting.leaderEpub — see cachePairKeys), cleared
// when the peer leaves (see removeRemotePeer).
const pairKeysCache = new Map();
// Set once on the first failed decryption of incoming data
// (SDP/ICE/stream-info/name-announce from the server relay) — almost always
// means the link token (`t`/`e`) is wrong or mismatched between sides (see
// handleCryptoFailureOnce). Kept separate from terminalState so we don't
// show the overlay twice when several peers fail in parallel at once.
let cryptoFailureHandled = false;

// --- Shared room/signaling state ---
let signaling = null;
let myPeerId = null;
let myName = null;
let joinedOnce = false;
// Once the "final" overlay is shown (error/disconnect), we no longer
// overwrite it with messages about incidental problems.
let terminalState = false;
// ICE servers obtained once on the first page load — reused when creating
// peers both for regular peer-joined and during reconnect reconciliation.
let iceServersCache = null;

// --- SAS: human-friendly key verification (see static/crypto.js: deriveSas,
// docs/security.md "SAS / MITM") ---
//
// A SINGLE DTLS certificate for the whole session, reused across all
// RTCPeerConnections of this participant (passed into RtcPeer via
// certificate) — so we have one stable fingerprint, seen identically by all
// peers. Otherwise the browser would generate a new certificate for each
// connection and the "room fingerprint" wouldn't match up. Generated once in
// connectAndJoin (ensureSessionCertificate) and survives reconnect.
let sessionCertificate = null;
let ownCertFingerprint = null; // fingerprint of our sessionCertificate (normalized in crypto.js)

// --- SAS v2: commit-before-reveal round (see docs/sas-verification.md) ---
//
// A round is identified by roundId = hash(membership by peerId ‖ their
// fingerprints). A change in membership OR any fingerprint -> new roundId ->
// a fresh round with new nonces (this is what closes off the
// certificate-grinding attack after reveal, §7.2).
let sasCurrentRoundId = null; // roundId of the current round, or null
let sasRoundMembers = null; // snapshot [{peerId, fingerprint}] at round start (fixed expected membership)
let sasMyNonce = null; // our nonce for the current round (Uint8Array 32)
let sasCommits = new Map(); // peerId -> commitHex (ours + received over the bus)
let sasReveals = new Map(); // peerId -> nonce (Uint8Array), ours + received and (later) verified
let sasRevealed = false; // whether we've already revealed our nonce this round (gate: only after all commits)
let sasState = 'hidden'; // hidden | unavailable | verifying | ok | mismatch
let sasResult = null; // { emoji:[...], hex } when state==='ok'
let sasRefreshTimer = null;
const SAS_REFRESH_MS = 3000;

// --- Auto-reconnect for signaling (survives a server deploy/restart) ---
//
// Key idea: a WS signaling drop by itself must NOT tear down the mesh
// (media/DataChannel chat) — they don't physically depend on signaling and
// stay alive as long as the P2P connection itself is alive (see
// docs/self-hosting.md, "Surviving a Restart/Redeploy"). So an unexpected
// drop (not "Leave", not room-not-found/room-full — those are already
// terminal by themselves) starts a reconnection cycle with exponential
// backoff instead of an immediate "Connection lost".
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000]; // 1s→2s→4s→8s, then repeats at 8s (cap)
const RECONNECT_TOTAL_BUDGET_MS = 120_000; // total attempt budget — about 2 minutes
const RECONNECT_JOIN_TIMEOUT_MS = 8000; // how long we wait for a join-room response on a single attempt
// How long we wait for a lagging peer/screen-share owner after a successful
// reconnect, before considering them finally gone — other participants are
// also reconnecting at their own pace and need time for their own reconnect.
const RECONNECT_PEER_GRACE_MS = 13_000;

let reconnecting = false;
let reconnectAttempt = 0;
let reconnectDeadline = 0;
let reconnectTimer = null;
// Set before the socket is intentionally closed by the user themselves (the
// "Leave" button) — such a closure must not trigger auto-reconnect.
let intentionalDisconnect = false;
// Resolver for the current join-room attempt during reconnect (see
// waitForJoinOutcome/sendJoinAndWait) — the regular joined/room-not-found/
// room-full handlers additionally report the outcome here if it's set,
// instead of (or in addition to) normal handling.
let pendingJoinResolve = null;
// peerId -> id of the deferred peer-removal timer for a peer not found in
// the fresh joined.peers right after reconnect (see reconcileAfterReconnect).
const pendingPeerRemovals = new Map();
// Grace-period timer for a screen-share owner who hasn't re-joined yet
// themselves after a reconnect (see reconcileScreenShareAfterReconnect).
let screenOwnerGraceTimer = null;
// App version (see GET /version.json) that this page was loaded with —
// re-checked after every successful reconnect (the version-skew banner
// standard, see docs/signaling-protocol.md, "GET /version.json").
let lastKnownVersion = null;

// --- Call-duration timer (see docs/security.md, "Meeting Duration
// Ceiling") ---
//
// We used to show the REMAINDER until the server limit (expiresInSeconds)
// with yellow/red highlighting as it approached the end. Now instead we show
// a count-up: time ELAPSED since the FIRST participant joined the room. The
// server sends this as `joined.roomAgeSeconds` (an additive field, whole
// seconds, 0 for the very first joiner, see src/ws.rs) — the value is SHARED
// across all room participants (not "how long have I personally been here"),
// so a latecomer's timer immediately shows the room's actual age instead of
// 0. The server still sends `expiresInSeconds` (the room lifetime limit
// hasn't gone anywhere — when it expires the server sends `room-expired`,
// see signaling.on('room-expired') below), but it's no longer used for
// display, so the yellow/red "criticality" is also gone — it was tied
// specifically to the remainder until the limit, not to elapsed time.
let roomAgeBaseSeconds = null; // roomAgeSeconds from the last joined, null until the first joined
let roomAgeBaseAtMs = null; // Date.now() at the moment this joined was received — the base we count "+ elapsed since" from
let roomTimerInterval = null;

// Room participant limit — the server sends the EFFECTIVE limit in
// `joined.maxParticipants` (see src/protocol.rs::ServerMessage::Joined) on
// EVERY joined; `settings-changed` doesn't carry a separate number — we
// recompute it ourselves from `settings.maxParticipants` (see the
// settings-changed handler below). The effective limit is either the
// server-side ceiling from the `MAX_PARTICIPANTS` env var (recommended
// default 6, see docs/self-hosting.md §6), or the room leader's OWN, lower
// limit set via the settings panel (`RoomSettings.maxParticipants`, `null` =
// "no custom limit", automatically follows the server ceiling — see
// populateMaxParticipantsOptions below). The 6 here is a fallback ONLY for
// the case of a very old server that doesn't send this field at all.
// Lowering the limit does NOT kick out people who already joined — the
// server simply stops admitting new ones until the membership thins out
// naturally on its own (see docs/research-room-limit.md §2.2) — the client
// here only displays the current value and blocks selecting numbers above
// the already-known maximum, it never kicks anyone out itself and can't.
let maxParticipants = 6;

// Best known value of the ACTUAL server ceiling (disregarding the leader's
// own limit, if any) — needed for two things: (a) the upper bound of the
// option list in the "Max participants" select (see
// populateMaxParticipantsOptions), so that after narrowing the limit the
// leader can raise it back to the real ceiling, not just to the currently
// narrowed number; (b) a fallback when recomputing the effective limit from
// settings-changed, which (unlike joined) doesn't send the effective number
// separately — see the settings-changed handler below. Updated ONLY when we
// have solid proof: right after a joined/reconnect where
// `roomSettings.maxParticipants === null` (the leader hasn't narrowed the
// limit) — at that moment `joined.maxParticipants` matches the real ceiling
// by construction (see `Room::effective_max_participants` on the server). If
// we joined a room already narrowed by someone else and never saw it
// un-narrowed, it stays at the default fallback of 6 until the first joined
// without a custom limit.
let knownServerMaxParticipants = 6;

/**
 * M:SS from milliseconds, and H:MM:SS past the one-hour mark (can't be
 * negative — the caller clamps it to 0 from below).
 */
function formatRoomTimer(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Once a second — recompute the room's elapsed time and update the timer pill. */
function updateRoomTimerDisplay() {
  if (roomAgeBaseSeconds === null) return;
  const elapsedMs = roomAgeBaseSeconds * 1000 + (Date.now() - roomAgeBaseAtMs);
  roomTimerEl.textContent = formatRoomTimer(elapsedMs);
  roomTimerEl.classList.remove('hidden');
}

/**
 * Called on EVERY joined (initial entry and reconnect) — resynchronizes the
 * counting base from the fresh roomAgeSeconds. The value grows monotonically
 * on the server, so here we simply take it as the new base (rather than
 * trying to "continue" the old one) — after a long reconnect this pulls the
 * timer forward to the real elapsed time instead of leaving it lagging.
 */
function startRoomTimer(roomAgeSeconds) {
  if (typeof roomAgeSeconds !== 'number' || !Number.isFinite(roomAgeSeconds)) return;
  roomAgeBaseSeconds = roomAgeSeconds;
  roomAgeBaseAtMs = Date.now();
  updateRoomTimerDisplay();
  if (!roomTimerInterval) {
    roomTimerInterval = setInterval(updateRoomTimerDisplay, 1000);
  }
}

/** The room has expired (room-expired) — the timer stops running, there's nothing further to show. */
function stopRoomTimer() {
  if (roomTimerInterval) {
    clearInterval(roomTimerInterval);
    roomTimerInterval = null;
  }
  roomAgeBaseSeconds = null;
  roomAgeBaseAtMs = null;
  roomTimerEl.classList.add('hidden');
}

// peerId -> { rtc: RtcPeer, name, tile: {root, videoEl, placeholderEl, labelEl, crownEl} }
const peers = new Map();
// peerId -> name (we don't store our own here — our own name is in myName).
const peerNames = new Map();
// peerId -> { bytesSent, bytesReceived, ts } — snapshot of transport-stats
// counters from the PREVIOUS tick of the shared speed poller
// (PEER_STATS_REFRESH_MS, see pollPeerStats/computePeerConnectionStats
// further in the file) — the baseline for computing in/out speed between
// ticks. Cleared when a peer leaves (removeRemotePeer) — otherwise, if the
// same peerId gets reused on a new connection, the speed on the first tick
// would be computed against someone else's stale byte counts.
const peerStatsHistory = new Map();
// { bytesSent, bytesReceived, ts } from the PREVIOUS call to
// renderServerCounters — the baseline for the "Server relay traffic" line's
// speed in the "Connection and privacy" section. Same trick as
// peerStatsHistory above, but for the aggregated server WS counter
// (static/common.js: ConnStats), not per-peer WebRTC transport — and unlike
// peerStatsHistory, there's no getStats() here, so it's updated right in the
// render (see formatPeerStatsLine below) rather than in the shared poller.
// null until the first call.
let serverBytesHistory = null;
// Our own tile (created right after joined).
let ownTile = null;
// The tile object (as returned by createTile) currently maximized to full
// page via a click (see maximizeTile/unmaximizeTile), or null. Only one
// tile can be maximized at a time — ours or someone else's.
let maximizedTile = null;

// --- Permissions and leader (see docs/permissions-and-leader.md) ---
let leaderId = null;
let isLeader = false;
// RoomSettings from the server (see src/protocol.rs::RoomSettings) — null until the first joined.
let roomSettings = null;
// Lobby requests, visible ONLY to the leader: [{ peerId, name }].
let pendingRequests = [];
let toastTimer = null;
// peerId -> { mic: {stream, track} | null, camera: {stream, track, enabled} | null } —
// stores references to guests' incoming tracks REGARDLESS of whether
// they're currently allowed to be rendered, so we can retroactively show/hide
// them when guestAudio/guestVideo changes on the fly (see
// refreshMediaRenderingForPeer).
const peerMediaRefs = new Map();

// Phase 0: room bus on top of the mesh RTCDataChannel (see bus.js/rtc.js) —
// shared by chat (chat.js) and future features, lives for the whole session
// in the room (a peer is registered/deregistered in sync with peers, see
// createRemotePeer/removeRemotePeer).
const bus = new Bus();

// --- Local media ---
let micStream = null;
let micTrack = null;
let micRequestInProgress = false;

let camStream = null;
let camTrack = null;
let camRequestInProgress = false;

// --- Device selection (see the "Camera and microphone" section below) ---
//
// The user's choice lives ONLY in the tab's memory (no localStorage —
// anonymity, see docs/privacy.md, "Anonymity") and survives turning the mic
// or camera off/on via the button, but not a reload/switching to another room.
// selected*DeviceId — what's currently selected in the dropdown (desired);
// current*DeviceId — the deviceId actually behind the active track (what's
// physically captured right now). They diverge when the user picked a
// device WHILE the mic/camera is off via the button — the actual switch is
// then deferred until the next time it's turned on (see micButton/cameraButton
// click).
let selectedMicDeviceId = null;
let selectedCamDeviceId = null;
let currentMicDeviceId = null;
let currentCamDeviceId = null;

let screenStream = null;
// peerId of the current screen-share owner (can be myPeerId) or null.
let currentScreenOwnerPeerId = null;
// Resolver for awaiting the server's decision on share-start (see screenButton click).
let pendingShareDecision = null;

// --- Routing incoming tracks via stream-info ---
// streamId -> { kind: 'mic'|'camera'|'screen', name }
const streamInfoMap = new Map();
// streamId -> [{ peerId, stream, track }] — tracks for which ontrack has
// already fired, but the corresponding stream-info hasn't arrived yet (the
// race is real).
const pendingTracks = new Map();

// peerId -> hidden <audio> element with the incoming microphone.
const micAudioEls = new Map();
// peerId -> stop() function of the audio-level monitor (see common.js: SpeakingDetection).
const micMonitors = new Map();
// streamId -> peerId whose incoming camera stream this is — needed to apply
// an `enabled` update from a repeated stream-info (see broadcastStreamEnabled).
const cameraStreamOwner = new Map();
// Same thing for microphone streams — needed to apply an `enabled` update to
// the "mic off" indicator on the tile (see applyMicEnabledUpdate).
const micStreamOwner = new Map();

let chat = null;

// ---------- Overlay ----------

// `onAction` — an optional callback for the overlay button; by default (not
// passed) the button goes to the home page (see overlayActionButtonEl
// below) — that's how "Room not found"/"Room full" used to work. The lobby
// ("Waiting for approval…") overrides it to "Cancel" = leave + go home (see
// registerSignalingHandlers: signaling.on('waiting', ...)).
let overlayActionHandler = null;

function showOverlay({ title, text = '', spinner = false, actionLabel = null, onAction = null }) {
  overlayEl.classList.remove('hidden');
  overlayTitleEl.textContent = title;
  overlayTextEl.textContent = text;
  overlaySpinnerEl.classList.toggle('hidden', !spinner);
  overlayActionHandler = onAction;
  if (actionLabel) {
    overlayActionButtonEl.textContent = actionLabel;
    overlayActionButtonEl.classList.remove('hidden');
  } else {
    overlayActionButtonEl.classList.add('hidden');
  }
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

overlayActionButtonEl.addEventListener('click', () => {
  if (overlayActionHandler) {
    overlayActionHandler();
  } else {
    location.href = '/';
  }
});

// ---------- E2E v2: cryptographic identity of the tab ----------

const LINK_TOKEN_BYTES = 16; // must match RoomCrypto TOKEN_BYTES
const LINK_EXPIRY_GRACE_SECONDS = 120; // tolerance for client/server clock skew (see static/landing.js: +300 on top of lifetimeSeconds on the server)

/**
 * Parse and validate `t`/`e` from the link fragment (see top of file),
 * derive K_auth and generate a one-time ephemeral tab key pair — ALL OF
 * THIS BEFORE join-room (see init below). Returns:
 *   - 'invalid' — `t`/`e` are missing or malformed (don't decode, `t` isn't
 *     exactly 16 bytes, `e` isn't base36), or WebCrypto itself failed
 *     (unavailable, etc.) — treated as "incomplete link";
 *   - 'expired' — the format is valid, but `now > e + LINK_EXPIRY_GRACE_SECONDS` —
 *     the terminal "Link expired" overlay (see showLinkExpiredOverlay);
 *   - 'ok' — can proceed to join-room.
 * Also generates myPeerId (see below, "Why the client chooses peerId").
 */
async function initCryptoIdentity() {
  if (!linkTokenBase64url || !linkExpiry) return 'invalid';

  let tokenBytes;
  try {
    tokenBytes = RoomCrypto.base64urlToBytes(linkTokenBase64url);
  } catch (err) {
    console.error('Failed to decode link token:', err);
    return 'invalid';
  }
  if (tokenBytes.length !== LINK_TOKEN_BYTES) return 'invalid';

  if (!/^[0-9a-z]+$/.test(linkExpiry)) return 'invalid'; // base36 lowercase, see static/landing.js
  const expirySeconds = parseInt(linkExpiry, 36);
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) return 'invalid';
  // Checked ONLY here, at entry — not at runtime (see top of file and
  // docs/security.md): a clock skew in the middle of a live call shouldn't
  // tear it down, the room's lifetime is already bounded by the server
  // (room-expired).
  if (Math.floor(Date.now() / 1000) > expirySeconds + LINK_EXPIRY_GRACE_SECONDS) return 'expired';

  try {
    kAuthBytes = await RoomCrypto.deriveAuthKey(tokenBytes, linkExpiry);
    myEphemeralKeyPair = await RoomCrypto.generateEphemeralKeyPair();
    myEpub = await RoomCrypto.exportEpub(myEphemeralKeyPair.publicKey);
  } catch (err) {
    console.error('Failed to initialize the tab\'s cryptographic identity:', err);
    return 'invalid';
  }

  // Why the CLIENT chooses peerId (rather than only the server, as before):
  // while a participant is waiting in the lobby (see signaling.on('waiting')
  // below), they must send the leader a name-announce encrypted under a
  // pairwise key whose transcript includes the peerId of BOTH sides (see
  // static/crypto.js: derivePairKeys) — and the server's lobby path (see
  // src/ws.rs) doesn't tell the waiting participant their own peerId before
  // approval (Waiting only carries leaderPeerId/leaderEpub). The solution:
  // we generate peerId OURSELVES (UUID v4 — the same alphabet as generate_peer_id() on
  // the server) and send it in join-room EXPLICITLY from the very first
  // entry (not only on reconnect, as it used to be) — the server accepts
  // the presented peerId if it's a valid UUID and is free in the room (see
  // src/ws.rs::handle_join_room), which in practice is always true for a
  // freshly generated UUID. The same myPeerId lives for the whole tab
  // session (including all reconnects), just like myEphemeralKeyPair.
  myPeerId = crypto.randomUUID();

  return 'ok';
}

/** "Incomplete link" overlay — entering without valid `t`/`e` OR the first failed decryption of incoming data (see handleCryptoFailureOnce) are treated the same way: with this token (or without one), nothing in the room will work anyway. */
function showInvalidLinkOverlay() {
  terminalState = true;
  // join-modal is visible BY DEFAULT (in room.html markup it has no
  // .hidden class — only JS hides/shows it, see showJoinModal/hideJoinModal
  // below) and its z-index is HIGHER than #overlay's (see static/style.css)
  // — if it isn't explicitly hidden here, it would stay on top of this
  // overlay (and technically clickable) in the "token is invalid even
  // before entry" scenario, when showJoinModal() never had a chance to run.
  hideJoinModal();
  showOverlay({
    title: 'Link is invalid',
    text: 'Ask a room participant for a new link.',
    actionLabel: 'Go home',
  });
}

/** Terminal "link expired" overlay — `e` from the fragment is in the past (with the LINK_EXPIRY_GRACE_SECONDS margin), see initCryptoIdentity. Kept separate from showInvalidLinkOverlay: the message is more honest ("this link WAS working, but has expired", rather than "the link is broken"). */
function showLinkExpiredOverlay() {
  terminalState = true;
  hideJoinModal();
  showOverlay({
    title: 'Link expired',
    text: 'Ask a participant for a fresh link.',
    actionLabel: 'Go home',
  });
}

/**
 * The first failed decryption of an incoming message from the server relay
 * (SDP/ICE/stream-info/name-announce — see static/rtc.js: onCryptoFailure,
 * and signaling.on('stream-info'/'name-announce') below) — almost
 * certainly means our link token (`t`/`e`) doesn't match the other side's
 * (corrupted while copying, different links after a MITM swap, etc.): with a
 * matching token the GCM tag will almost never fail on its own (see
 * static/crypto.js, "Why PSK-in-salt provides authentication").
 * We show the same overlay as for a missing/malformed `t`/`e` — from the
 * user's point of view the distinction doesn't matter, the outcome is the
 * same ("this link doesn't work, need a new one").
 */
function handleCryptoFailureOnce(err) {
  if (cryptoFailureHandled || terminalState) return;
  cryptoFailureHandled = true;
  console.error('Looks like the link token is wrong (failed to decrypt an incoming message):', err);
  showInvalidLinkOverlay();
  if (signaling) signaling.close();
}

/**
 * Get (lazily derive, if not already derived) pairwise keys for `peerId` —
 * see static/crypto.js: derivePairKeys. `epubStr` is required the FIRST
 * time we learn about this peer (joined.peers[]/peer-joined/join-request/
 * waiting.leaderEpub) — after that the cache is reused without it.
 * IMPORTANT: `pairKeysCache.set(promise)` itself is SYNCHRONOUS (key
 * derivation is async, but the promise lands in the cache immediately): by
 * the time the server delivers the first relay from this peer over the same
 * WS, the cache entry already exists — the pairKeysCache.has() guards (see
 * signaling.on('stream-info'/'name-announce')) never swallow a message
 * from a legitimate peer. A promise rejection for an ALREADY cached pair
 * (invalid epub, WebCrypto failed) is treated further down the code as a
 * cryptographic failure (see encryptSigFor/decryptSigFrom) — "don't
 * silently ignore it".
 */
function cachePairKeys(peerId, epubStr) {
  if (!pairKeysCache.has(peerId)) {
    const promise = !epubStr
      ? Promise.reject(new Error(`cachePairKeys: no epub known for peer ${peerId}`))
      : RoomCrypto.derivePairKeys({
          myPriv: myEphemeralKeyPair.privateKey,
          theirEpubStr: epubStr,
          myPeerId,
          theirPeerId: peerId,
          myEpubStr: myEpub,
          roomId,
          expiryString: linkExpiry,
          kAuthBytes,
        });
    pairKeysCache.set(peerId, promise);
  }
  return pairKeysCache.get(peerId);
}

/** The same cache, but without epub — for places where the pair MUST already be cached in advance (see createRemotePeer/sendStreamInfoTo/signaling.on('stream-info')). An unknown peerId — rejection (see cachePairKeys). */
function getPairKeys(peerId) {
  return pairKeysCache.get(peerId) || Promise.reject(new Error(`getPairKeys: no pair keys cached for peer ${peerId}`));
}

/** Encrypt SDP/ICE/stream-info under the pairwise K_pair_sig for a specific `peerId` — see static/rtc.js: sigCrypto, and sendStreamInfoTo below. */
async function encryptSigFor(peerId, obj) {
  const { sigKey } = await getPairKeys(peerId);
  return RoomCrypto.encryptJson(sigKey, obj);
}

/** Decrypt SDP/ICE/stream-info from a specific `peerId` under the pairwise K_pair_sig — any error (unknown epub, wrong key, malformed envelope) is propagated to the caller as-is (see static/rtc.js: onCryptoFailure, and signaling.on('stream-info') below). */
async function decryptSigFrom(peerId, blob) {
  const { sigKey } = await getPairKeys(peerId);
  return RoomCrypto.decryptJson(sigKey, blob);
}

/** Encrypt our own name under a specific `peerId`'s pairwise K_pair_meta — the payload for `name-announce` (see src/protocol.rs::ClientMessage::NameAnnounce). */
async function encryptNameAnnouncePayload(peerId) {
  const { metaKey } = await getPairKeys(peerId);
  return RoomCrypto.encryptToBase64(metaKey, { name: myName || null });
}

/** Send `name-announce` to peer/leader `peerId` — send nothing if our own name is empty (an anonymous user is already shown as "Guest" to everyone, an extra message adds no information). A failure (e.g. the pair isn't cached yet) doesn't bring down the room, we just log it: this is OUR OWN outgoing action, not a suspicious incoming one. */
async function sendNameAnnounceTo(peerId) {
  if (!myName) return;
  try {
    const payload = await encryptNameAnnouncePayload(peerId);
    signaling.send('name-announce', { to: peerId, payload });
  } catch (err) {
    console.error(`Failed to send name-announce to peer ${peerId}:`, err);
  }
}

/** sendNameAnnounceTo for a whole list of peerIds — see signaling.on('joined')/reconnect below ("idempotently resend to everyone"). */
function broadcastNameAnnounceTo(peerIds) {
  if (!myName) return;
  for (const peerId of peerIds) sendNameAnnounceTo(peerId);
}

/**
 * Decrypt the payload of an incoming `name-announce` from `fromPeerId`
 * under its pairwise K_pair_meta. Any error (sender's invalid epub, wrong
 * key, malformed envelope) is propagated as-is — the caller
 * (signaling.on('name-announce') below; senders without an established pair
 * are already filtered out there BEFORE the call — see the
 * pairKeysCache.has() guard) treats ANY error here as a cryptographic
 * failure (see handleCryptoFailureOnce): unlike v1, where a name that
 * failed to decrypt silently turned into "Guest", here a legitimate sender
 * with the correct `t`/`e` ALWAYS decrypts successfully — a failure means a
 * spoof/token mismatch, not the harmless corruption of a single field.
 */
async function decryptNameAnnouncePayload(fromPeerId, payload) {
  const { metaKey } = await getPairKeys(fromPeerId);
  const obj = await RoomCrypto.decryptFromBase64(metaKey, payload);
  return obj && typeof obj.name === 'string' && obj.name ? obj.name : null;
}

// SAS v2 (see docs/sas-verification.md, state machine below). fromPeerId is
// the AUTHENTICATED transport sender (the bus calls handlers with it, see
// H3 in docs/security.md): messages don't carry a self-declared id, the
// author can't be spoofed. Messages from a different round are ignored.
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'sas-commit') return;
  if (obj.round !== sasCurrentRoundId || typeof obj.commit !== 'string') return;
  if (!sasCommits.has(fromPeerId)) sasCommits.set(fromPeerId, obj.commit);
  sasTryComplete().catch((err) => console.warn('SAS: failed to process sas-commit:', err));
});
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'sas-reveal') return;
  if (obj.round !== sasCurrentRoundId || typeof obj.nonce !== 'string') return;
  try {
    sasReveals.set(fromPeerId, RoomCrypto.base64urlToBytes(obj.nonce));
  } catch {
    return;
  }
  sasTryComplete().catch((err) => console.warn('SAS: failed to process sas-reveal:', err));
});

// ---------- Unobtrusive messages ----------

let roomMessageTimer = null;
function showRoomMessage(text) {
  roomMessageEl.textContent = text;
  roomMessageEl.classList.remove('hidden');
  if (roomMessageTimer) clearTimeout(roomMessageTimer);
  roomMessageTimer = setTimeout(() => {
    roomMessageEl.classList.add('hidden');
  }, 4000);
}

/** Unobtrusive toast (leader change, etc., see docs/permissions-and-leader.md) — kept separate from showRoomMessage (that one is reserved for warnings/errors). */
function showToast(text, ms = 3000) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, ms);
}

// ---------- Signaling reconnect banner ----------

function showReconnectBanner() {
  reconnectBannerEl.classList.remove('hidden');
}

function hideReconnectBanner() {
  reconnectBannerEl.classList.add('hidden');
}

// ---------- Version-skew banner ----------

async function fetchVersion() {
  try {
    // Step 2: via window.API_BASE (see static/config.js) — /version.json
    // lives on the API host, which doesn't necessarily match this page's origin.
    const res = await fetch(`${window.API_BASE}/version.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.version) || null;
  } catch (err) {
    return null;
  }
}

/** Compare the current server version with the one this page was loaded with. Never "forgets" a mismatch it has already shown. */
async function checkVersionSkew() {
  const current = await fetchVersion();
  if (current && lastKnownVersion && current !== lastKnownVersion) {
    versionBannerEl.classList.remove('hidden');
  }
}

versionBannerReloadButtonEl.addEventListener('click', () => {
  location.reload();
});

// ---------- Build hash of the published static bundle (a forensic anchor,
// see docs/security.md, "Published Build Hash") ----------
//
// /build-hash.json lives NEXT TO the page — the bundle root on Cloudflare
// Pages (see .github/workflows/deploy-prod.yml, job deploy-pages), a
// same-origin fetch, NOT via window.API_BASE (unlike /version.json above —
// that lives on the signaling host, this one on the static-assets host, see
// Step 2 in docs/self-hosting.md §1.2). In a dev/self-hosted build the file
// doesn't exist at all (no such route on the server, see src/main.rs) —
// then all three display spots (landing page, "Share" popup, settings) stay
// hidden, nothing breaks. The cache lives only in the tab's memory (fetched
// exactly once), no localStorage — the page's anonymity isn't broken.
//
// IMPORTANT: this is NOT a cryptographic guarantee (see docs/security.md
// §10.4) — the static-assets host could in theory tamper with
// build-hash.json itself along with the rest of the bundle. The real check
// is against the GitHub Release, an independent channel, not against what
// this very page displays.
let buildHashInfo = null;
let buildHashPromise = null;

function fetchBuildHashOnce() {
  if (!buildHashPromise) {
    buildHashPromise = (async () => {
      try {
        const res = await fetch('/build-hash.json');
        if (!res.ok) return null; // dev/self-hosted without build-hash.json — expected
        const data = await res.json();
        if (!data || typeof data.hash !== 'string' || !data.hash) return null;
        return data;
      } catch (err) {
        return null;
      }
    })().then((data) => {
      buildHashInfo = data;
      return data;
    });
  }
  return buildHashPromise;
}

/**
 * The "build: <short hash>… + verify" line in the "Share" popup — next to
 * the link/QR, NOT inside them (see static/room.html). Format matches the
 * landing page footer (static/index.html/landing.js: loadBuildHash): 10
 * hash characters + ellipsis in the summary, the full hash shown on
 * expanding (details) and in the title, the "verify" link points to the
 * same GitHub Releases.
 */
function renderShareBuildLine() {
  if (!buildHashInfo) {
    sharePopupBuildEl.classList.add('hidden');
    sharePopupBuildShortEl.textContent = '';
    sharePopupBuildFullEl.textContent = '';
    sharePopupBuildEl.title = '';
    return;
  }
  sharePopupBuildShortEl.textContent = `${buildHashInfo.hash.slice(0, 10)}…`;
  sharePopupBuildFullEl.textContent = buildHashInfo.hash;
  sharePopupBuildEl.title = buildHashInfo.hash;
  sharePopupBuildEl.classList.remove('hidden');
}

/** An optional line in "Connection and privacy" — the same hash, for those who look there instead of the "Share" popup. */
function renderSettingsBuildRow() {
  if (!buildHashInfo) {
    settingsBuildRowEl.classList.add('hidden');
    return;
  }
  settingsBuildTextEl.textContent = `Build: ${buildHashInfo.hash.slice(0, 12)}…`;
  settingsBuildTextEl.title = buildHashInfo.hash;
  settingsBuildRowEl.classList.remove('hidden');
}

fetchBuildHashOnce().then(() => {
  renderShareBuildLine();
  renderSettingsBuildRow();
});

// ---------- Playback with a fallback to mute when autoplay is blocked ----------

function safePlay(el) {
  const p = el.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      if (!el.muted) {
        el.muted = true;
        el.play().catch(() => {});
      }
    });
  }
}

// ---------- Participant tiles ----------

/**
 * Deterministic hue derived from peerId — so camera-off placeholders differ
 * from each other with a live color instead of being identical blue
 * circles. The same peerId always yields the same gradient (including
 * across re-joins), since the hash is purely string-based, no randomness.
 */
function hueFromPeerId(peerId) {
  let hash = 0;
  const str = String(peerId || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * First grapheme cluster of a string — the avatar letter takes the cluster
 * specifically, not charAt(0)/[0]: for a name starting with an emoji (see
 * static/namegen.js: userName()), charAt(0) would return half of a
 * surrogate pair. Intl.Segmenter is the precise way; the [...str][0]
 * fallback takes the first code point whole (correct for single-code-point
 * ANIMALS emoji, see namegen.js). Used in both createTile and
 * updatePeerTileName/updateOwnTileLabel — three places where this code used
 * to be duplicated verbatim.
 */
function firstGraphemeOf(str) {
  if (!str) return null;
  return typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter().segment(str)][0]?.segment
    : [...str][0];
}

/**
 * The tile caption shows just the name (see task item 5), but the avatar
 * circle already carries the name's first grapheme cluster as a separate,
 * large image — if that cluster turns out to be an emoji (see
 * static/namegen.js: userName() almost always starts with an emoji), the
 * caption would duplicate it as text next to the circle.
 * \p{Extended_Pictographic} is a reliable check for "this is an emoji", as
 * opposed to the first letter of a regular name (otherwise, e.g., the name
 * "Alice" would lose its "A"). If nothing remains after removing the
 * cluster (the name is a single emoji with no word), we return the original
 * string so the caption isn't empty.
 */
function stripLeadingAvatarEmoji(trimmedName, grapheme) {
  if (!trimmedName || !grapheme) return trimmedName;
  if (!/\p{Extended_Pictographic}/u.test(grapheme)) return trimmedName;
  const rest = trimmedName.slice(grapheme.length).trim();
  return rest || trimmedName;
}

/** Name to display under the avatar/in the tile corner — just the name, without the "Guest" placeholder if there already is one. */
function tileDisplayName(trimmedName, grapheme) {
  return trimmedName ? stripLeadingAvatarEmoji(trimmedName, grapheme) : 'Guest';
}

// ---------- Tile grid layout: fixed grid for the 6-participant limit ----------
//
// The room is limited to 6 participants by default (see
// knownServerMaxParticipants above) — per the spec (item 6), the layout for
// 1..6 tiles is FIXED and predictable (not "best of an N-way search over
// column counts" as computeBestFitTileLayout used to do — that search
// produced a variable number of columns depending on the stage shape, which
// made it hard to fit both width and height at once without scrolling):
// desktop — 1→1, 2→2, 3→3, 4→2×2, 5-6→3×2; mobile portrait (see @media
// (max-width: 640px) in static/style.css) — always 2 columns (except for a
// single tile).
//
// The tile itself still scales to a 16:9 aspect ratio and fits the MAXIMUM
// possible size — but now with an EXPLICITLY fixed number of columns/rows,
// rather than by search. Both grid tracks (grid-template-columns AND
// grid-template-rows) are set inline in px — previously row height was left
// to the CSS fallback `grid-auto-rows: minmax(0, 1fr)`, which, given the
// non-deterministic (auto) height of #tiles-grid itself, could mismatch the
// height actually verified by the fit computation. Explicit
// grid-template-rows removes this ambiguity: the resulting grid height is
// guaranteed to equal rows*tileHeight + gaps, i.e. exactly what was checked
// to fit the stage height (see also the .room-page fix: height instead of
// min-height in static/style.css — the other half of the same scrolling bug).
const TILE_ASPECT_RATIO = 16 / 9;

// The same breakpoint as the mobile @media in static/style.css — the column
// layout must match what the user actually sees.
const MOBILE_TILES_MEDIA_QUERY = '(max-width: 640px)';

/**
 * Number of columns for the fixed layout given tileCount (see comment
 * above). More than 6 tiles — a non-standard server configuration with an
 * increased participant limit — isn't described separately by the spec; we
 * use a generic reasonable fallback of ceil(sqrt(n)) so the grid doesn't
 * sprawl into a single row/column, not because it's the "correct" layout
 * for that case.
 */
function computeTileGridColumns(tileCount, isMobile, isPortrait) {
  if (tileCount <= 1) return 1;
  if (isMobile) {
    // Two participants on a portrait phone: stack them in ONE column (each
    // tile full-width, one above the other) — two side-by-side tiles would be
    // tiny on a narrow portrait screen. Landscape keeps 2 columns (side by
    // side fills the wide screen), and 3+ tiles keep 2 columns either way.
    if (isPortrait && tileCount === 2) return 1;
    return 2;
  }
  if (tileCount === 2) return 2;
  if (tileCount === 3) return 3;
  if (tileCount === 4) return 2;
  if (tileCount <= 6) return 3;
  return Math.ceil(Math.sqrt(tileCount));
}

/**
 * Maximum 16:9 tile size that fits SIMULTANEOUSLY both by width
 * (containerWidth, divided by cols accounting for gaps) and by height
 * (containerHeight, divided by rows) — returns { cols, rows, tileWidth,
 * tileHeight } or null if the container/tile list is empty.
 */
function computeFixedTileLayout(containerWidth, containerHeight, tileCount, gapPx, isMobile, isPortrait) {
  if (tileCount <= 0 || containerWidth <= 0 || containerHeight <= 0) return null;
  const cols = computeTileGridColumns(tileCount, isMobile, isPortrait);
  const rows = Math.ceil(tileCount / cols);
  const cellWidth = (containerWidth - gapPx * (cols - 1)) / cols;
  const cellHeight = (containerHeight - gapPx * (rows - 1)) / rows;
  if (cellWidth <= 0 || cellHeight <= 0) return null;
  let tileWidth = cellWidth;
  let tileHeight = tileWidth / TILE_ASPECT_RATIO;
  if (tileHeight > cellHeight) {
    // The column width would allow a tile taller than the row — scale by
    // height instead (the 16:9 aspect ratio is preserved either way, the
    // leftover width space is simply left empty on the edge thanks to
    // justify-content: center).
    tileHeight = cellHeight;
    tileWidth = tileHeight * TILE_ASPECT_RATIO;
  }
  return { cols, rows, tileWidth, tileHeight };
}

/**
 * Available space for #tiles-grid inside .room-stage — the stage is shared
 * with other visible children (mainly #screen-stage, when someone is
 * sharing their screen, and #invite-cta in a solo room), so from the full
 * content-box of .room-stage we subtract the height+gap of every other
 * VISIBLE direct child (a general approach, not tied specifically to
 * screen-stage — if another sibling appears, it will be accounted for
 * automatically).
 */
function computeAvailableGridBox() {
  const stage = tilesGridEl.parentElement;
  if (!stage) return { width: 0, height: 0 };
  const stageRect = stage.getBoundingClientRect();
  const cs = getComputedStyle(stage);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const stageGap = parseFloat(cs.rowGap || cs.gap) || 0;

  let width = stageRect.width - padLeft - padRight;
  let height = stageRect.height - padTop - padBottom;

  for (const sibling of stage.children) {
    if (sibling === tilesGridEl || sibling.classList.contains('hidden')) continue;
    const h = sibling.getBoundingClientRect().height;
    if (h > 0) height -= h + stageGap;
  }

  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Recompute and apply the fixed layout — called when the tile count
 * changes (see updateSoloState, called from updateParticipantCount), when
 * --compact is toggled (showScreenStageContainer/hideScreenStage — via the
 * same updateSoloState), and on window resize (see the listener below;
 * resize includes phone rotation, which is unrelated to isMobile here — the
 * breakpoint is by width, not orientation, but a recompute is still needed
 * since width changes too). Doesn't touch --compact (the filmstrip during
 * screen sharing has its own flex layout with a fixed tile width, see
 * static/style.css) or --spotlight (the maximized-tile filmstrip also has
 * its own CSS layout, see updateSpotlightMode) — a fixed grid would be out
 * of place there and would conflict with their own geometry.
 */
function layoutTilesGrid() {
  if (tilesGridEl.classList.contains('tiles-grid--compact')) return;
  if (tilesGridEl.classList.contains('tiles-grid--spotlight')) return;
  const tileCount = tilesGridEl.children.length;
  if (tileCount === 0) return;
  const { width: stageWidth, height } = computeAvailableGridBox();
  // #tiles-grid itself is capped at `max-width: 1200px` in CSS (see
  // static/style.css) — on wide desktop screens the stage (.room-stage) is
  // wider than this limit, and without accounting for it the JS here would
  // compute columns for the FULL stage width, while the grid itself would
  // render narrower (max-width would clip its box), causing the explicitly
  // set grid-template-columns to not fit within the grid's actual
  // clientWidth — a horizontal scroll of EXACTLY this kind was found by
  // smoke testing (see spec item 6: 1280×800, 6 tiles).
  const cssMaxWidth = parseFloat(getComputedStyle(tilesGridEl).maxWidth);
  const width = Number.isFinite(cssMaxWidth) ? Math.min(stageWidth, cssMaxWidth) : stageWidth;
  const gapPx = parseFloat(getComputedStyle(tilesGridEl).columnGap) || 0;
  const isMobile = window.matchMedia(MOBILE_TILES_MEDIA_QUERY).matches;
  const isPortrait = window.matchMedia('(orientation: portrait)').matches;
  const layout = computeFixedTileLayout(width, height, tileCount, gapPx, isMobile, isPortrait);
  if (!layout) return;
  const tileWidthPx = Math.floor(layout.tileWidth);
  const tileHeightPx = Math.floor(layout.tileHeight);
  tilesGridEl.style.gridTemplateColumns = `repeat(${layout.cols}, ${tileWidthPx}px)`;
  // grid-template-rows (not auto-rows: minmax(0, 1fr) from the CSS
  // fallback) — this specifically was missing before: without an explicit
  // row height, the resulting grid height wasn't guaranteed to be bounded
  // by the height-checked computation (see the comment above
  // computeFixedTileLayout and the .room-page fix in static/style.css —
  // the other half of the same desktop scrolling bug).
  tilesGridEl.style.gridTemplateRows = `repeat(${layout.rows}, ${tileHeightPx}px)`;
}

// Window resize (phone rotation, resizing the desktop browser window,
// DevTools) — the only one of the three recompute triggers (see the
// layoutTilesGrid comment) that doesn't already go through updateSoloState.
window.addEventListener('resize', layoutTilesGrid);

function createTile(peerId, name, isOwn) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isOwn ? ' tile--own' : '');
  tile.dataset.peerId = peerId;
  tile.dataset.name = name || '';

  const video = document.createElement('video');
  video.className = 'tile-video hidden';
  video.autoplay = true;
  video.playsInline = true;
  if (isOwn) {
    video.muted = true;
    video.classList.add('tile-video--mirror');
  }

  // No-video placeholder: avatar circle (letter/emoji, now noticeably
  // larger and strictly round — see .tile-placeholder-avatar in
  // static/style.css) + the name shown LARGE below it. .tile-placeholder is
  // just a flex container covering the whole tile, the gradient circle is
  // a separate .tile-placeholder-avatar.
  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';

  const avatar = document.createElement('div');
  avatar.className = 'tile-placeholder-avatar';
  const hue = hueFromPeerId(peerId);
  avatar.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 45) % 360}, 70%, 32%))`;

  // Leader crown ABOVE the avatar circle (see spec item 4) — absolutely
  // positioned relative to the circle itself (avatar: position: relative,
  // see static/style.css), not relative to the whole tile: this keeps it
  // exactly centered above the circle at any tile size (best-fit/grid)
  // without a separate recompute in JS. This is a SEPARATE element from
  // .tile-crown in .tile-name below — that crown is visible only during
  // video (the corner name badge), this one only on the no-video
  // placeholder; both are toggled together in setLeaderIndicator, since
  // video/placeholder are never shown at the same time.
  const placeholderCrown = document.createElement('span');
  placeholderCrown.className = 'tile-crown tile-crown--placeholder hidden';
  placeholderCrown.setAttribute('aria-hidden', 'true');
  placeholderCrown.innerHTML = CROWN_ICON_SVG; // static markup, not user data
  avatar.appendChild(placeholderCrown);

  const letter = document.createElement('span');
  letter.className = 'tile-placeholder-letter';
  const trimmedName = (name || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  letter.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  avatar.appendChild(letter);
  placeholder.appendChild(avatar);

  const placeholderName = document.createElement('div');
  placeholderName.className = 'tile-placeholder-name';
  placeholder.appendChild(placeholderName);

  // Corner caption (visible only while video is on — see
  // setTileVideoVisible below: on the placeholder the name is already
  // shown large and centered, no point duplicating it in the corner).
  // Leader crown — inline before the name in this same badge (video mode,
  // see the placeholderCrown comment above about the placeholder solution).
  const label = document.createElement('div');
  label.className = 'tile-name hidden';

  const crown = document.createElement('span');
  crown.className = 'tile-crown hidden';
  crown.setAttribute('aria-hidden', 'true');
  crown.innerHTML = CROWN_ICON_SVG; // static markup, not user data
  label.appendChild(crown);

  const labelText = document.createElement('span');
  labelText.className = 'tile-name-text';
  label.appendChild(labelText);

  // Just the name, BIGGER (see spec item 5) — without a "You (...)" wrapper
  // and without a "leader" role word (leadership is already visible via the
  // crown); our own name isn't distinguished from others' by text. A
  // leading emoji that duplicates the avatar circle is stripped (see
  // tileDisplayName/stripLeadingAvatarEmoji above).
  const labelValue = tileDisplayName(trimmedName, firstGrapheme);
  labelText.textContent = labelValue;
  placeholderName.textContent = labelValue;

  // "Mic off/absent" indicator (see static/style.css: .tile-mic-off) —
  // visible BY DEFAULT (not .hidden): before the first enable/stream-info,
  // this participant genuinely doesn't have a track yet, which per spec
  // also shows the icon (see setTileMicOff/applyMicEnabledUpdate).
  const micOff = document.createElement('span');
  micOff.className = 'tile-mic-off';
  micOff.setAttribute('aria-hidden', 'true');
  micOff.innerHTML = MIC_OFF_ICON_SVG; // static markup, not user data

  // Speed badge (see static/style.css: .tile-speed, static/room.js:
  // updateTileSpeedBadges) — hidden by default: speed isn't known before
  // the first tick of the speed poller where two traffic snapshots have
  // already accumulated for this peer (see pollPeerStats). The free corner
  // is bottom-right (the top ones are taken by the name/crown and mic, see
  // static/style.css).
  const speed = document.createElement('span');
  speed.className = 'tile-speed hidden';
  speed.setAttribute('aria-hidden', 'true');

  tile.appendChild(video);
  tile.appendChild(placeholder);
  tile.appendChild(label);
  tile.appendChild(micOff);
  tile.appendChild(speed);

  if (isOwn) {
    tilesGridEl.prepend(tile);
  } else {
    tilesGridEl.appendChild(tile);
  }

  const tileObj = {
    root: tile,
    videoEl: video,
    placeholderEl: placeholder,
    labelEl: label,
    labelTextEl: labelText,
    placeholderNameEl: placeholderName,
    letterEl: letter, // E2E v2: the avatar letter is updated separately from tile creation, see updatePeerTileName (the name arrives later, via a separate name-announce)
    crownEl: crown,
    placeholderCrownEl: placeholderCrown, // crown above the placeholder avatar circle (see spec item 4) — toggled in sync with crownEl in setLeaderIndicator
    micOffEl: micOff,
    speedEl: speed,
  };

  // Clicking a tile — toggles "full page" mode (see
  // maximizeTile/unmaximizeTile and .tile--maximized/.tiles-grid--spotlight
  // in style.css). Attached once here rather than via global delegation on
  // #tiles-grid — the tile already has a closure over its own
  // videoEl/tileObj, no need for extra DOM traversal. closest('button') —
  // for the future: if buttons appear inside the tile, clicking them
  // shouldn't toggle maximization. Clicking an ALREADY maximized tile
  // (including in spotlight) exits the mode; clicking ANY OTHER tile with
  // live video (including a small one in the spotlight filmstrip) —
  // maximizeTile itself un-maximizes the previous one and maximizes the new
  // one ("last click wins").
  tile.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (maximizedTile === tileObj) {
      unmaximizeTile();
    } else if (!video.classList.contains('hidden')) {
      // Maximizing only makes sense when video is actually showing — there's
      // nothing to expand on a bare placeholder (avatar placeholder).
      maximizeTile(tileObj);
    }
  });

  return tileObj;
}

/**
 * E2E v2: update an ALREADY created tile for a remote peer with a new name
 * that arrived via `name-announce` (see signaling.on('name-announce')) —
 * the tile is created EARLIER (with a "Guest" placeholder, see createTile
 * above), because epub/name now arrive separately (the name even comes as
 * a separate message from epub/peerId). Updates the corner caption, the
 * caption under the placeholder avatar, and the avatar's first letter —
 * i.e. all three places where createTile initially sets
 * `labelValue`/the first grapheme.
 */
function updatePeerTileName(peerId, name) {
  const entry = peers.get(peerId);
  if (!entry) return; // the peer already left while the message was in flight — not rare on a live relay
  entry.name = name || null;
  const tile = entry.tile;
  const trimmedName = (name || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  const labelValue = tileDisplayName(trimmedName, firstGrapheme);
  tile.root.dataset.name = name || '';
  tile.labelTextEl.textContent = labelValue;
  tile.placeholderNameEl.textContent = labelValue;
  tile.letterEl.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
}

/**
 * Expand a tile to full page over the whole UI. Deliberately a simple
 * fixed overlay (see .tile--maximized), NOT the Fullscreen API: first,
 * per spec this is a "full page" toggle (within the tab), not "full
 * screen" — an F11-like mode isn't needed and would be unexpected for the
 * user; second, the fullscreen screen-share display
 * (#screen-fullscreen-button/requestFullscreenCompat) is a DIFFERENT stage
 * and a different mechanism (the real Fullscreen API), there's no need for
 * them to overlap: the fixed overlay simply draws on top (z-index above
 * everything else) and doesn't touch the browser's top-layer.
 *
 * "Spotlight": if there are other tiles in the room besides the one being
 * maximized (see updateSpotlightMode) — they don't disappear, they become
 * a small filmstrip alongside (on the right on desktop, at the bottom on
 * mobile — see .tiles-grid--spotlight in static/style.css). This is a
 * PURELY CSS effect: tile nodes aren't moved (otherwise their video would
 * restart), the maximized tile is still the same .tile--maximized, just
 * its position:fixed geometry is shrunk to make room for the filmstrip,
 * and the other tiles are regular grid children, with the grid itself
 * turning into a flex filmstrip container for the duration of spotlight
 * (see updateSpotlightMode).
 */
function maximizeTile(tile) {
  if (maximizedTile === tile) return;
  if (maximizedTile) unmaximizeTile(); // guard: only one tile can be maximized at a time
  maximizedTile = tile;
  tile.root.classList.add('tile--maximized');
  updateSpotlightMode();
  document.addEventListener('keydown', onMaximizedTileKeydown);
}

/** Collapse the currently maximized tile back into the grid. */
function unmaximizeTile() {
  if (!maximizedTile) return;
  maximizedTile.root.classList.remove('tile--maximized');
  maximizedTile = null;
  updateSpotlightMode();
  document.removeEventListener('keydown', onMaximizedTileKeydown);
}

function onMaximizedTileKeydown(event) {
  if (event.key === 'Escape') unmaximizeTile();
}

/**
 * Toggle the spotlight filmstrip class on the grid (see
 * .tiles-grid--spotlight in static/style.css) — called from
 * maximizeTile/unmaximizeTile AND from updateParticipantCount (membership
 * can change while someone is maximized: a new participant joins — they
 * should appear in the filmstrip; the last other participant leaves — the
 * filmstrip is no longer needed, the maximized tile takes up the whole
 * screen as before). The filmstrip is only enabled if there's at least one
 * other tile besides the maximized one — otherwise (maximizing the only
 * tile in an empty room) there's no point showing an empty filmstrip.
 */
function updateSpotlightMode() {
  const hasOthers = maximizedTile !== null && 1 + peers.size > 1;
  tilesGridEl.classList.toggle('tiles-grid--spotlight', hasOthers);
}

/**
 * Auto-exit maximization if THIS tile's video has just been hidden (camera
 * turned off/track disappeared) while the tile was expanded — otherwise a
 * black fullscreen overlay with no picture would remain, which a regular
 * user without Esc couldn't get out of. Called from every place that hides
 * a specific tile's video — showTileVideo(peerId, false) for others' tiles
 * and manual toggles of ownTile.videoEl (camera button, guest enforcement)
 * for our own.
 */
function exitMaximizeIfHidden(tile, show) {
  if (!show && maximizedTile === tile) unmaximizeTile();
}

/** Show/hide the "mic off" icon on a specific tile object (our own ownTile or peers.get(id).tile). */
function setTileMicOffIndicator(tile, micOff) {
  if (!tile) return;
  tile.micOffEl.classList.toggle('hidden', !micOff);
}

function updateParticipantCount() {
  const total = 1 + peers.size;
  participantCountEl.textContent = `Participants: ${total} / ${maxParticipants}`;
  updateSoloState();
  // Membership might have changed while someone is maximized — the
  // spotlight filmstrip must appear/disappear in sync (see updateSpotlightMode).
  updateSpotlightMode();
}

/**
 * A room with just one person (only our own tile, no one sharing a screen)
 * — our own tile is bigger and centered, with an unobtrusive invite prompt
 * below it (see .tiles-grid--solo/.invite-cta in style.css).
 */
function updateSoloState() {
  const solo = peers.size === 0 && screenStageEl.classList.contains('hidden');
  tilesGridEl.classList.toggle('tiles-grid--solo', solo);
  inviteCtaEl.classList.toggle('hidden', !solo);
  // The tile count and/or --compact mode may have changed — recompute the
  // grid layout (see layoutTilesGrid below; it does nothing itself in
  // --compact/--spotlight, they have their own CSS logic).
  layoutTilesGrid();
}

// ---------- Leader: crown on the tile, own tile caption, gear icon visibility ----------

function isPeerLeader(peerId) {
  return leaderId !== null && peerId === leaderId;
}

/**
 * Update the crown on the tiles (our own and all current peers) for the new
 * leaderId + our own tile's caption. Each tile carries TWO crowns (see
 * createTile) — crownEl (corner of the name badge, visible during video)
 * and placeholderCrownEl (above the placeholder avatar circle, visible
 * without video) — toggled together, since video/placeholder are mutually
 * exclusive (see setTileVideoVisible), but rather than depending on which
 * one is currently visible, we simply keep both up to date at all times.
 */
function setLeaderIndicator(newLeaderId) {
  leaderId = newLeaderId || null;
  isLeader = myPeerId !== null && myPeerId === leaderId;
  if (ownTile) {
    const iAmLeader = leaderId === myPeerId;
    ownTile.crownEl.classList.toggle('hidden', !iAmLeader);
    ownTile.placeholderCrownEl.classList.toggle('hidden', !iAmLeader);
  }
  for (const [peerId, entry] of peers) {
    const peerIsLeader = leaderId === peerId;
    entry.tile.crownEl.classList.toggle('hidden', !peerIsLeader);
    entry.tile.placeholderCrownEl.classList.toggle('hidden', !peerIsLeader);
  }
  updateOwnTileLabel();
}

/**
 * Just the name (see spec item 5) — without a "You (...)" wrapper and
 * without a "leader" role word (leadership is shown by the crown, see
 * setLeaderIndicator, not by text). Recomputed on any name/leaderId
 * change. Written both into the corner caption and into the caption under
 * the placeholder avatar — both carry the same text (see createTile).
 */
function updateOwnTileLabel() {
  if (!ownTile) return;
  const trimmedName = (myName || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  const text = tileDisplayName(trimmedName, firstGrapheme);
  ownTile.labelTextEl.textContent = text;
  ownTile.placeholderNameEl.textContent = text;
}

/**
 * The settings gear is visible to EVERYONE (the "Devices" section —
 * microphone/camera selection — is a shared capability). The "Room"
 * section (lobby + guest permissions) within the panel is visible only to
 * the leader — after losing leadership, we hide it and the request list
 * (they're no longer ours), but we do NOT close the panel itself: a guest
 * could well be in the middle of picking a device at that moment.
 */
function updateSettingsButtonVisibility() {
  settingsRoomSectionEl.classList.toggle('hidden', !isLeader);
  if (!isLeader) {
    pendingRequests = [];
    renderJoinRequests();
  }
}

function setTileSpeaking(peerId, speaking) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.tile.root.classList.toggle('tile--speaking', speaking);
}

/**
 * A single point that toggles a tile's video/placeholder/corner caption —
 * keeps all three in sync (our own ownTile or someone else's
 * peers.get(id).tile) and itself triggers auto-exit from maximization. The
 * corner caption .tile-name is visible ONLY while video is on — on the
 * placeholder the name is already shown large and centered (see
 * createTile/.tile-placeholder-name), no point duplicating it in the corner.
 */
function setTileVideoVisible(tile, show) {
  tile.videoEl.classList.toggle('hidden', !show);
  tile.placeholderEl.classList.toggle('hidden', show);
  tile.labelEl.classList.toggle('hidden', !show);
  exitMaximizeIfHidden(tile, show);
}

function showTileVideo(peerId, show) {
  const entry = peers.get(peerId);
  if (!entry) return;
  setTileVideoVisible(entry.tile, show);
}

// ---------- Screen (main area) ----------

function updateScreenButtonState() {
  // Guest permissions (see docs/permissions-and-leader.md, "Screen Sharing —
  // Server-Enforced"): guestScreen=false forbids
  // a guest (not the leader) from even trying — the button is disabled
  // regardless of the current screen-ownership state. This restriction
  // doesn't apply to the leader.
  if (!isLeader && roomSettings && !roomSettings.guestScreen) {
    screenButton.disabled = true;
    screenButton.title = 'Disabled by the leader';
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
    return;
  }
  if (currentScreenOwnerPeerId === null) {
    screenButton.disabled = false;
    screenButton.title = '';
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
  } else if (currentScreenOwnerPeerId === myPeerId) {
    screenButton.disabled = false;
    screenButton.title = '';
    screenButton.classList.add('control-button--on');
    screenButton.setAttribute('aria-pressed', 'true');
  } else {
    // Someone else is already sharing — the button STAYS active (see
    // docs/permissions-and-leader.md, "screen-share takeover"): the click
    // isn't blocked, it takes the screen over from the current owner ("last
    // one wins", see src/ws.rs::handle_share_start) — sending share-start
    // below already handles this, here we just reflect the state in the
    // button's tooltip.
    const name = peerNames.get(currentScreenOwnerPeerId) || 'another participant';
    screenButton.disabled = false;
    screenButton.title = `${name} is sharing their screen — click to take over`;
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
  }
}

function showScreenStageContainer() {
  screenStageEl.classList.remove('hidden');
  tilesGridEl.classList.add('tiles-grid--compact');
  updateSoloState();
}

function hideScreenStage() {
  screenStageEl.classList.add('hidden');
  tilesGridEl.classList.remove('tiles-grid--compact');
  screenVideoEl.srcObject = null;
  screenVideoEl.classList.remove('hidden'); // reset in case the stage was hidden during our own share (see showLocalScreenPreview)
  screenSelfPlaceholderEl.classList.add('hidden');
  screenCaptionEl.textContent = '';
  updateFullscreenButtonState(); // the stage is fully hidden, but the button state shouldn't linger from the previous share
  updateSoloState();
}

/**
 * A placeholder instead of a live preview of OUR OWN capture — we do NOT
 * attach screenStream to a <video> on our own stage. Reason: when capturing
 * "the whole screen," this preview would itself land inside the captured
 * frame — recursive self-capture (a "hall of mirrors" effect, the same
 * reason Meet/Zoom never show the sharer a live preview of their own
 * screen), which on macOS is aggravated into a visibly frozen buffer and a
 * trail of cursors, especially in fullscreen (see requestFullscreenCompat
 * below). Instead of video — a static placeholder (see
 * #screen-self-placeholder in room.html). Nothing changes for viewers
 * (attachScreenVideo) — they always see someone else's stream, for which
 * this problem doesn't exist.
 */
function showLocalScreenPreview() {
  showScreenStageContainer();
  screenVideoEl.srcObject = null;
  screenVideoEl.classList.add('hidden');
  screenSelfPlaceholderEl.classList.remove('hidden');
  screenCaptionEl.textContent = `Screen: You${myName ? ` (${myName})` : ''}`;
  updateFullscreenButtonState(); // no point fullscreening our own placeholder — the button is hidden
}

function showRemoteScreenCaption(peerId) {
  showScreenStageContainer();
  // A screen-share takeover (see iAmPreempted in registerSignalingHandlers:
  // share-started) can catch the stage in "showing our own share's
  // placeholder" state — the owner is different now, restore the normal
  // view with video.
  screenSelfPlaceholderEl.classList.add('hidden');
  screenVideoEl.classList.remove('hidden');
  screenCaptionEl.textContent = `Screen: ${peerNames.get(peerId) || 'Guest'}`;
  updateFullscreenButtonState();
}

// ---------- Guest permissions: enforcement on our own side (sender) ----------
//
// Cooperative enforcement (see docs/permissions-and-leader.md, §7): applied
// on OUR OWN side (mic/camera/screen buttons, chat input) upon receiving
// settings-changed/joined. Can be bypassed by a modified client — the
// server doesn't even try to prevent this technically (media/chat are
// P2P), it just doesn't show extra capabilities to an honest client.
// Symmetric enforcement on the RECEIVER side — see
// refreshMediaRenderingForPeer below and
// ChatPanel.isIncomingEnvelopeAllowed in chat.js.
function applyGuestEnforcement() {
  if (!roomSettings) return;
  const restrictAudio = !isLeader && !roomSettings.guestAudio;
  const restrictVideo = !isLeader && !roomSettings.guestVideo;
  const restrictChat = !isLeader && !roomSettings.guestChat;

  micButton.disabled = restrictAudio;
  micButton.title = restrictAudio ? 'Disabled by the leader' : '';
  if (restrictAudio && micTrack && micTrack.enabled) {
    micTrack.enabled = false;
    setMicButtonOn(false);
    updateOwnMicIndicator();
    broadcastStreamEnabled(micStream, 'mic', false);
  }

  cameraButton.disabled = restrictVideo;
  cameraButton.title = restrictVideo ? 'Disabled by the leader' : '';
  if (restrictVideo && camTrack && camTrack.enabled) {
    camTrack.enabled = false;
    setCameraButtonOn(false);
    if (ownTile) setTileVideoVisible(ownTile, false);
    broadcastStreamEnabled(camStream, 'camera', false);
  }

  updateScreenButtonState(); // checks guestScreen/isLeader itself

  if (chat) chat.setChatForbidden(restrictChat);
}

// ---------- Guest permissions: enforcement on the RECEIVER side (rendering others' tracks) ----------
//
// guestAudio/guestVideo=false — receivers don't render the corresponding
// track of GUESTS (not the leader), regardless of whether the guest
// themselves disabled the track via the button (see applyGuestEnforcement
// above — the enforcement is specifically cooperative: the server doesn't
// see media streams and can't forbid them technically, see
// docs/permissions-and-leader.md, "Audio & Video — Receiver-Enforced Only").

function getOrCreateMediaRefs(peerId) {
  let refs = peerMediaRefs.get(peerId);
  if (!refs) {
    refs = { mic: null, camera: null };
    peerMediaRefs.set(peerId, refs);
  }
  return refs;
}

/** Recompute rendering of one peer's incoming mic/camera tracks under the current roomSettings/leaderId. */
function refreshMediaRenderingForPeer(peerId) {
  const refs = peerMediaRefs.get(peerId);
  if (!refs || !roomSettings) return;
  const exempt = isPeerLeader(peerId); // restrictions don't apply to the leader

  if (refs.mic) {
    if (exempt || roomSettings.guestAudio) {
      attachMicAudio(peerId, refs.mic.stream, refs.mic.track);
    } else {
      cleanupMicAudio(peerId);
    }
  }

  if (refs.camera) {
    if (exempt || roomSettings.guestVideo) {
      attachCameraVideo(peerId, refs.camera.stream, refs.camera.track, refs.camera.enabled);
    } else {
      showTileVideo(peerId, false);
      const entry = peers.get(peerId);
      if (entry) entry.tile.videoEl.srcObject = null;
    }
  }
}

function refreshMediaRenderingForAllPeers() {
  for (const peerId of peers.keys()) refreshMediaRenderingForPeer(peerId);
}

// ---------- Lobby: join requests (leader only) ----------

function renderJoinRequests() {
  joinRequestsEl.textContent = '';
  if (pendingRequests.length === 0) {
    joinRequestsEl.classList.add('hidden');
  } else {
    joinRequestsEl.classList.remove('hidden');
    for (const req of pendingRequests) {
      joinRequestsEl.appendChild(buildJoinRequestCardEl(req));
    }
  }
  updateSettingsBadge();
}

function buildJoinRequestCardEl(req) {
  const card = document.createElement('div');
  card.className = 'join-request-card';
  card.dataset.peerId = req.peerId;

  const name = document.createElement('span');
  name.className = 'join-request-name';
  name.textContent = req.name || 'Guest';

  const actions = document.createElement('div');
  actions.className = 'join-request-actions';

  const acceptButton = document.createElement('button');
  acceptButton.type = 'button';
  acceptButton.className = 'join-request-button join-request-button--accept';
  acceptButton.textContent = 'Accept';
  acceptButton.addEventListener('click', () => {
    signaling.send('approve', { peerId: req.peerId });
    removePendingRequest(req.peerId);
  });

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className = 'join-request-button join-request-button--reject';
  rejectButton.textContent = 'Decline';
  rejectButton.addEventListener('click', () => {
    signaling.send('reject', { peerId: req.peerId });
    removePendingRequest(req.peerId);
    pairKeysCache.delete(req.peerId); // rejected for good — the pair is no longer needed (see removeRemotePeer)
  });

  actions.appendChild(acceptButton);
  actions.appendChild(rejectButton);
  card.appendChild(name);
  card.appendChild(actions);
  return card;
}

function updateSettingsBadge() {
  settingsBadgeEl.textContent = String(pendingRequests.length);
  settingsBadgeEl.classList.toggle('hidden', pendingRequests.length === 0);
}

function addPendingRequest(peerId, name) {
  if (pendingRequests.some((r) => r.peerId === peerId)) return;
  pendingRequests.push({ peerId, name: name || null });
  renderJoinRequests();
}

function removePendingRequest(peerId) {
  pendingRequests = pendingRequests.filter((r) => r.peerId !== peerId);
  renderJoinRequests();
}

/** E2E v2: update the name on an already-shown join request from an incoming name-announce (see signaling.on('name-announce')) — before that the card shows "Guest" (see buildJoinRequestCardEl). Not found among pendingRequests (it's not a waiting peer but a regular participant) — a silent no-op. */
function setPendingRequestName(peerId, name) {
  const req = pendingRequests.find((r) => r.peerId === peerId);
  if (!req) return;
  req.name = name || null;
  renderJoinRequests();
}

// ---------- Room settings (leader only): popup/bottom-sheet ----------

function syncSettingsPanelInputs() {
  if (!roomSettings) return;
  settingLobbyInput.checked = !!roomSettings.lobbyEnabled;
  settingGuestChatInput.checked = !!roomSettings.guestChat;
  settingGuestAudioInput.checked = !!roomSettings.guestAudio;
  settingGuestVideoInput.checked = !!roomSettings.guestVideo;
  settingGuestScreenInput.checked = !!roomSettings.guestScreen;
  populateMaxParticipantsOptions();
}

/**
 * Rebuild the "Max participants" select's options: "No limit (default)"
 * (= null on the wire) + numbers 2..knownServerMaxParticipants.
 *
 * Why the list's upper bound is knownServerMaxParticipants (see its
 * declaration above), rather than maxParticipants itself: the server sends
 * us ONLY the effective value (settings.maxParticipants ?? the server env),
 * never the real ceiling separately. If we built the list directly from
 * the current effective value, then after the leader narrows the limit
 * (say, to 2), the list would collapse to a single "2" option, and without
 * an explicit "first restore No limit" step it would be impossible to
 * raise the limit back up. knownServerMaxParticipants remembers the real
 * ceiling separately (see its declaration) precisely to avoid this — the
 * list is always complete as long as we've seen the room without the
 * leader's own limit at least once.
 */
function populateMaxParticipantsOptions() {
  if (!roomSettings) return;
  const current = roomSettings.maxParticipants; // null = "no custom limit" (default)
  // A safety net: if we joined a room already narrowed by someone else and
  // never saw it un-narrowed, knownServerMaxParticipants may be lower
  // (stuck at the fallback) than the current value — don't let the list
  // "lose" the leader's current choice, always include it in the range.
  const ceiling = Math.max(2, knownServerMaxParticipants, typeof current === 'number' ? current : 0);
  settingMaxParticipantsInput.innerHTML = '';
  const noLimitOption = document.createElement('option');
  noLimitOption.value = '';
  noLimitOption.textContent = 'No limit (default)';
  settingMaxParticipantsInput.appendChild(noLimitOption);
  for (let n = 2; n <= ceiling; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    settingMaxParticipantsInput.appendChild(opt);
  }
  settingMaxParticipantsInput.value = current === null || current === undefined ? '' : String(current);
}

function openSettingsPanel() {
  syncSettingsPanelInputs();
  refreshDeviceLists();
  refreshConnectionSection();
  // Peer list — right away from the speed poller's cache (see
  // PEER_STATS_REFRESH_MS/pollPeerStats), without waiting for its next
  // tick: the poller ticks continuously and independently of the panel, but
  // between a peer appearing and the first tick the cache could still be
  // empty (renderPeerConnectionsList itself accounts for this, showing
  // "connecting…"). While the panel is open, everything further is updated
  // by the poller's tick (both refreshConnectionSection and the peer list)
  // — the panel has no timer of its own, the page's whole rhythm is
  // unified, once every 3 seconds.
  renderPeerConnectionsList();
  settingsPanelEl.classList.remove('hidden');
}

function closeSettingsPanel() {
  settingsPanelEl.classList.add('hidden');
}

// ---------- "Connection and privacy": per-peer mode + what the server sees ----------
//
// Visible to ALL participants (unlike #settings-room-section above, leader
// only) — implements the goal of "show what mode we're operating in and
// what goes to the server." Three parts:
//   1) a static encryption line — from RoomCrypto.getCryptoInfo(), we do
//      NOT hardcode the algorithm text (see static/crypto.js);
//   2) the connection mode with each peer — P2P/TURN relay/server
//      fallback/connecting — see computePeerConnectionStats below (also
//      in/out traffic and RTT from the same statsReport);
//   3) a static list of what the server sees, plus per-session counters
//      (see static/common.js: ConnStats — incremented at the actual
//      sending points via signaling.send in rtc.js/room.js/chat.js).
//
// The whole section is updated by the SINGLE shared speed poller (see
// PEER_STATS_REFRESH_MS below, next to renderPeerConnectionsList) — every 3
// seconds, the settings panel has no other periodic timers. The poller
// ticks ALWAYS, not only while this panel is open: the same numbers are
// needed by the speed badges on tiles (see updateTileSpeedBadges), which
// are visible regardless of settings. While the panel is open, a tick
// additionally redraws both the cheap parts (1 and 3 —
// refreshConnectionSection, no getStats) and the peer list (2).
// renderPeerConnectionsList() itself doesn't call getStats() at all — it
// only reads the poller's ready cache (peerLastStats), so there's exactly
// one getStats() call per peer per tick, even with the settings panel open.

const PEER_MODE_LABELS = {
  p2p: 'direct (P2P)',
  turn: 'via TURN relay',
  fallback: 'via server (fallback)',
  connecting: 'connecting…',
};

/** Render the encryption line from getCryptoInfo() — the algorithm text is NOT hardcoded, only the phrase template is. */
function renderCryptoInfo() {
  const info = RoomCrypto.getCryptoInfo();
  if (!info.active) {
    settingsCryptoRowEl.classList.add('settings-crypto-row--off');
    settingsCryptoTextEl.textContent = 'E2E encryption is off — the server can see the content';
    return;
  }
  settingsCryptoRowEl.classList.remove('settings-crypto-row--off');
  settingsCryptoTextEl.textContent =
    `E2E encryption: ${info.algorithm} · ${info.keyBits}-bit key · ${info.kdf}`;
}

/**
 * Selected candidate pair from the pc.getStats() report — the spec path
 * via `transport.selectedCandidatePairId` (see
 * https://www.w3.org/TR/webrtc-stats/), with a fallback to legacy markers
 * (`selected`/`nominated`+`succeeded` directly on the candidate-pair) for
 * browsers whose transport stats don't carry this field.
 */
function findSelectedCandidatePair(statsReport) {
  for (const stat of statsReport.values()) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      const pair = statsReport.get(stat.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  for (const stat of statsReport.values()) {
    if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) {
      return stat;
    }
  }
  return null;
}

/** 'p2p' or 'turn' based on the local/remote candidate types of the already selected pair. */
function candidatePairMode(pair, statsReport) {
  const local = statsReport.get(pair.localCandidateId);
  const remote = statsReport.get(pair.remoteCandidateId);
  const localType = local && local.candidateType;
  const remoteType = remote && remote.candidateType;
  return localType === 'relay' || remoteType === 'relay' ? 'turn' : 'p2p';
}

/**
 * Byte counter for the connection's transport (the peerConnection, not a
 * single candidate) — the type==='transport' record covers ALL of the
 * connection's DTLS traffic: media (audio/video RTP) AND data channels
 * (files, chat, the bus protocol), so this is an honest in/out for the
 * peer. If the browser didn't provide such a record (old Firefox), the
 * fallback is the sum of outbound-rtp/inbound-rtp records — that's only
 * media without data channels, but better than nothing.
 */
function findTransportBytes(statsReport) {
  for (const stat of statsReport.values()) {
    if (stat.type === 'transport' && (typeof stat.bytesSent === 'number' || typeof stat.bytesReceived === 'number')) {
      return { bytesSent: stat.bytesSent || 0, bytesReceived: stat.bytesReceived || 0 };
    }
  }
  let bytesSent = null;
  let bytesReceived = null;
  for (const stat of statsReport.values()) {
    if (stat.type === 'outbound-rtp' && typeof stat.bytesSent === 'number') {
      bytesSent = (bytesSent || 0) + stat.bytesSent;
    } else if (stat.type === 'inbound-rtp' && typeof stat.bytesReceived === 'number') {
      bytesReceived = (bytesReceived || 0) + stat.bytesReceived;
    }
  }
  return { bytesSent, bytesReceived };
}

/**
 * Mode + traffic + RTT for the connection with one peer — a single pass
 * over ONE statsReport (we don't do a second getStats() per peer, it's an
 * expensive operation). Mode priority is exactly as in the spec:
 *  1) a selected candidate pair exists -> 'p2p' (host/srflx/prflx on both
 *     sides) or 'turn' (one side of the pair is relay); RTT is taken right
 *     here — the candidate-pair's currentRoundTripTime, seconds -> ms;
 *  2) no pair yet and the DataChannel bus to the peer isn't open ->
 *     'fallback' (all traffic to the peer goes through the server relay:
 *     signaling.send for a mesh that hasn't settled yet);
 *  3) otherwise (no pair, but the bus is somehow already open — a race
 *     edge case, normally unreachable) -> 'connecting'.
 * bytesSent/bytesReceived are null if stats couldn't be obtained at all
 * (see catch) or no transport/rtp records were found.
 */
async function computePeerConnectionStats(peerId, entry) {
  const pc = entry.rtc && entry.rtc.pc;
  if (!pc) return { mode: 'connecting', rtt: null, bytesSent: null, bytesReceived: null };
  try {
    const statsReport = await pc.getStats();
    const pair = findSelectedCandidatePair(statsReport);
    const { bytesSent, bytesReceived } = findTransportBytes(statsReport);
    const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
    const mode = pair ? candidatePairMode(pair, statsReport) : (bus.isOpen(peerId) ? 'connecting' : 'fallback');
    return { mode, rtt, bytesSent, bytesReceived };
  } catch (err) {
    console.warn(`[peer ${peerId}] getStats() for the settings section failed:`, err);
  }
  return { mode: bus.isOpen(peerId) ? 'connecting' : 'fallback', rtt: null, bytesSent: null, bytesReceived: null };
}

/**
 * Adaptive size format: B / KB / MB (base 1024). Whole bytes and whole KB
 * have no fractional part (rounded to 1 KB: fractional kilobytes are
 * excessive precision both for tile badges and for settings lines), MB has
 * one decimal digit (there the fractional part isn't noise, it's a
 * multi-fold difference). Used both for accumulated volume
 * (`formatBytesCompact(4404019)` -> "4.2 MB") and — with "/s" appended —
 * for speed (see formatPeerStatsLine).
 */
function formatBytesCompact(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  if (abs < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Speed for the TILE BADGE (see updateTileSpeedBadges) — unlike
 * formatBytesCompact above (which honestly prints even tiny "3 B" values,
 * fine for settings where there's surrounding context), on a tile
 * overlaying video we need a compact order of magnitude rather than exact
 * bytes per second — below 1 KB/s we print a fixed "<1 KB/s".
 */
function formatSpeedBadge(bytesPerSec) {
  if (bytesPerSec < 1024) return '<1 KB/s';
  return `${formatBytesCompact(bytesPerSec)}/s`;
}

/**
 * The stats line under a peer's name: "↓ 320 KB/s ↑ 12 KB/s · 45 ms".
 *
 * Speed is ALWAYS a byte delta between two ticks of the section (WebRTC
 * doesn't provide instantaneous throughput, only monotonically growing
 * counters since the connection started), so a baseline is needed —
 * prevSnapshot from peerStatsHistory. On the first tick after opening the
 * panel (or after transport stats appear for a peer that just connected)
 * there's no baseline yet: we show the total accumulated since the
 * connection started (with a "∑" prefix) — this is more honest than dashes
 * (the data is real, it's just not a rate) and doesn't make the user wait
 * for an "empty" tick.
 */
function formatPeerStatsLine(prevSnapshot, stats, nowMs) {
  if (stats.bytesSent == null || stats.bytesReceived == null) return null; // neither transport nor rtp stats were found — nothing to show
  const rttPart = typeof stats.rtt === 'number' ? ` · ${Math.round(stats.rtt)} ms` : '';

  if (!prevSnapshot) {
    return `∑ ↓ ${formatBytesCompact(stats.bytesReceived)} ↑ ${formatBytesCompact(stats.bytesSent)}${rttPart}`;
  }
  const dtSec = Math.max(0.001, (nowMs - prevSnapshot.ts) / 1000);
  // Math.max(0, …) — counters can "dip" if the pair was rebuilt (ICE
  // restart / switching transport from p2p to turn) and the stats restarted
  // counting from zero; a negative delta at such a moment is better shown
  // as 0 than as "negative traffic".
  const downRate = Math.max(0, (stats.bytesReceived - prevSnapshot.bytesReceived) / dtSec);
  const upRate = Math.max(0, (stats.bytesSent - prevSnapshot.bytesSent) / dtSec);
  return `↓ ${formatBytesCompact(downRate)}/s ↑ ${formatBytesCompact(upRate)}/s${rttPart}`;
}

/**
 * Redraw the "Connections with participants" list — READS the
 * peerLastStats cache, NO getStats() calls of its own: the numbers are
 * computed by the single shared speed poller (see pollPeerStats below),
 * which ticks independently of whether this panel is open. Synchronous
 * (used to be async because of its own Promise.all over getStats) — the
 * render is instant, there was no flicker of a partially-ready list and
 * there still isn't.
 */
function renderPeerConnectionsList() {
  const entries = Array.from(peers.entries());
  if (entries.length === 0) {
    settingsPeersListEl.textContent = '';
    const li = document.createElement('li');
    li.className = 'settings-peer-row settings-peer-row--empty';
    li.textContent = 'No one else here yet — you are alone in the room.';
    settingsPeersListEl.appendChild(li);
    return;
  }

  settingsPeersListEl.textContent = '';
  for (const [peerId] of entries) {
    // Before the poller's first tick after a peer appears, there's no cache
    // yet — the same fallback mode that computePeerConnectionStats itself
    // used to return for a peer without a ready pc.
    const cached = peerLastStats.get(peerId);
    const mode = cached ? cached.mode : 'connecting';
    const li = document.createElement('li');
    li.className = 'settings-peer-row';

    const dot = document.createElement('span');
    dot.className = `settings-peer-dot settings-peer-dot--${mode}`;
    dot.setAttribute('aria-hidden', 'true');

    const info = document.createElement('span');
    info.className = 'settings-peer-info';

    const label = document.createElement('span');
    label.className = 'settings-peer-label';
    label.textContent = `${peerNames.get(peerId) || 'Guest'} — ${PEER_MODE_LABELS[mode]}`;
    info.appendChild(label);

    if (cached && cached.statsLine) {
      const statsEl = document.createElement('span');
      statsEl.className = 'settings-peer-stats';
      statsEl.textContent = cached.statsLine;
      info.appendChild(statsEl);
    }

    li.appendChild(dot);
    li.appendChild(info);
    settingsPeersListEl.appendChild(li);
  }
}

// ---------- Single shared speed poller (see the top comment of the "Connection and privacy" section) ----------
//
// Once every PEER_STATS_REFRESH_MS, ALWAYS (not only while settings are
// open) — one getStats() call per peer computes mode/RTT/traffic, updates
// peerStatsHistory (the baseline for the next tick, see formatPeerStatsLine
// above), and caches the ready result in peerLastStats. This cache is used
// both by renderPeerConnectionsList (if the settings panel is open) and by
// the speed badges on tiles (updateTileSpeedBadges) — there's no second
// getStats() pass for either the panel or the badges.
const PEER_STATS_REFRESH_MS = 3000;
let peerStatsTimer = null;
// peerId -> { mode, rtt, statsLine, downRate, upRate } — the ready result of
// the poller's last tick. downRate/upRate are null until at least two
// snapshots have accumulated for this peer (the first tick after
// connecting/after the pair is rebuilt) — the same gate as
// formatPeerStatsLine's ("∑ …" instead of "…/s"), but kept separate from the
// ready-made string: the badges need the raw numbers.
const peerLastStats = new Map();

/** A single poller tick — see the section comment above. */
async function pollPeerStats() {
  const nowMs = Date.now();
  for (const [peerId, entry] of peers) {
    const stats = await computePeerConnectionStats(peerId, entry);
    const prev = peerStatsHistory.get(peerId);
    const statsLine = formatPeerStatsLine(prev, stats, nowMs);

    let downRate = null;
    let upRate = null;
    if (prev && stats.bytesSent != null && stats.bytesReceived != null) {
      const dtSec = Math.max(0.001, (nowMs - prev.ts) / 1000);
      // Math.max(0, …) — the same protection against "dipped" counters
      // after the pair is rebuilt (ICE restart/transport switch) as in
      // formatPeerStatsLine.
      downRate = Math.max(0, (stats.bytesReceived - prev.bytesReceived) / dtSec);
      upRate = Math.max(0, (stats.bytesSent - prev.bytesSent) / dtSec);
    }

    // The baseline for speed on the NEXT tick. If stats are unavailable
    // this time (bytes === null), the record isn't updated/removed, so a
    // temporary getStats() failure doesn't reset an already accumulated
    // baseline.
    if (stats.bytesSent != null && stats.bytesReceived != null) {
      peerStatsHistory.set(peerId, { bytesSent: stats.bytesSent, bytesReceived: stats.bytesReceived, ts: nowMs });
    }

    peerLastStats.set(peerId, { mode: stats.mode, rtt: stats.rtt, statsLine, downRate, upRate });
  }

  updateTileSpeedBadges();
  // The settings panel might be open right now — redraw the whole
  // "Connection and privacy" section immediately: the peer list from the
  // already-ready cache (no extra getStats(), see renderPeerConnectionsList)
  // and the cheap parts (refreshConnectionSection). The panel has no
  // separate timer — this is its only periodic update mechanism.
  if (!settingsPanelEl.classList.contains('hidden')) {
    refreshConnectionSection();
    renderPeerConnectionsList();
  }
}

/**
 * Start the poller (idempotently) — called when entering the room (the
 * first joined, see registerSignalingHandlers, next to startSasUpdates)
 * and keeps ticking for the whole session: a tick with no peers is almost
 * a no-op (for…of over an empty Map), while refreshConnectionSection from a
 * tick is still needed even for a solo participant with the panel open. So
 * we don't stop/restart it on every join/leave — only on terminal teardown
 * (see stopPeerStatsPolling).
 */
function startPeerStatsPolling() {
  if (peerStatsTimer) return;
  peerStatsTimer = setInterval(() => {
    pollPeerStats().catch((err) => console.warn('Peer speed poller failed:', err));
  }, PEER_STATS_REFRESH_MS);
}

/** Stop the poller — terminal teardown (see teardownMeshMediaChat). */
function stopPeerStatsPolling() {
  if (peerStatsTimer) {
    clearInterval(peerStatsTimer);
    peerStatsTimer = null;
  }
}

/**
 * Speed badges on tiles (.tile-speed, see createTile/static/style.css) —
 * called from pollPeerStats on every tick. On a peer's tile — their
 * INCOMING speed (their media TO US): this is an honest "speed of their
 * video for me," which is what someone looking at a specific tile wants to
 * see (not the speed at which WE send to them). On OUR OWN tile — the
 * combined OUTGOING speed across all peers (with "↑"): in a mesh we send n
 * separate copies of our media, one copy per participant, and an honest
 * "my upload" is the sum across all of them, not the speed to one
 * arbitrary peer. Until speed has been computed (the first tick after a
 * peer connects — downRate/upRate still null) — the badge stays/becomes
 * hidden.
 */
function updateTileSpeedBadges() {
  let totalUpRate = null;
  for (const [peerId, entry] of peers) {
    const cached = peerLastStats.get(peerId);
    const downRate = cached ? cached.downRate : null;
    if (downRate == null) {
      entry.tile.speedEl.classList.add('hidden');
    } else {
      entry.tile.speedEl.textContent = formatSpeedBadge(downRate);
      entry.tile.speedEl.classList.remove('hidden');
    }
    if (cached && cached.upRate != null) {
      totalUpRate = (totalUpRate || 0) + cached.upRate;
    }
  }

  if (!ownTile) return;
  if (totalUpRate == null) {
    ownTile.speedEl.classList.add('hidden');
  } else {
    ownTile.speedEl.textContent = `↑ ${formatSpeedBadge(totalUpRate)}`;
    ownTile.speedEl.classList.remove('hidden');
  }
}

/**
 * Dynamic "what the server sees" counters — see static/common.js: ConnStats.
 * The traffic line uses the same format as per-peer stats
 * (formatPeerStatsLine above): an accumulated total with "∑" on the first
 * call (no baseline yet), a rate between subsequent calls. Called both when
 * opening the panel (openSettingsPanel) and on every tick of the shared
 * poller while the panel is open (refreshConnectionSection) — the same
 * rhythm as the rest of the section.
 */
function renderServerCounters() {
  settingsSignalingCountEl.textContent = String(ConnStats.signalingRelayCount);

  const nowMs = Date.now();
  const stats = { bytesSent: ConnStats.bytesSent, bytesReceived: ConnStats.bytesReceived, rtt: null };
  settingsServerTrafficEl.textContent = formatPeerStatsLine(serverBytesHistory, stats, nowMs);
  serverBytesHistory = { bytesSent: stats.bytesSent, bytesReceived: stats.bytesReceived, ts: nowMs };
}

/**
 * Generate the session DTLS certificate for SAS once per session (see the
 * sessionCertificate declaration block above). Idempotent and doesn't
 * throw: on failure it simply leaves sessionCertificate=null (the call
 * still works, SAS just isn't shown). ECDSA P-256 is the same default the
 * browser picks on its own, so there's no impact on connection compatibility.
 */
async function ensureSessionCertificate() {
  if (sessionCertificate) return;
  try {
    sessionCertificate = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    });
    const fps = sessionCertificate.getFingerprints ? sessionCertificate.getFingerprints() : [];
    const sha256 = fps.find((f) => f.algorithm === 'sha-256') || fps[0];
    ownCertFingerprint = sha256 ? sha256.value : null;
  } catch (err) {
    console.warn('Failed to generate the session certificate for SAS:', err);
    sessionCertificate = null;
    ownCertFingerprint = null;
  }
}

// ---------- SAS v2: commit-before-reveal state machine ----------
//
// Full spec — docs/sas-verification.md. Driven by a timer (sasRefresh) plus
// incoming sas-commit/sas-reveal messages (handlers above). Invariant: a
// round is defined by the sasRoundMembers snapshot fixed at its start;
// messages with a different roundId are ignored; 'ok' is shown only once
// reveals from ALL expected participants have arrived and been verified.

/** Render the current SAS state in the main window's top bar — the only place it appears in the UI (see docs/sas-verification.md §9). Idempotent. */
function renderRoomSas() {
  renderTopbarSas(sasState, sasResult);
}

/**
 * The SAS "room fingerprint" in the top bar: a compact badge, visible
 * without opening chat (used to be duplicated in the chat panel header —
 * removed, this is now the single source, see docs/sas-verification.md
 * §9). Clicking the badge opens #topbar-sas-popup with details
 * (openTopbarSasPopup / renderTopbarSasPopupContent); if the popup is
 * already open at the moment the state changes (e.g. verifying -> ok), we
 * also update its content so it doesn't show stale text.
 */
function renderTopbarSas(state, result) {
  if (!topbarSasEl) return;
  topbarSasEl.classList.remove(
    'topbar-sas--ok',
    'topbar-sas--verifying',
    'topbar-sas--mismatch',
    'topbar-sas--unavailable'
  );
  topbarSasEl.title = '';

  if (!state || state === 'hidden') {
    // We're alone in the room — nothing and no one to verify against (see
    // docs/sas-verification.md §9). The only state where there's no badge
    // at all — meaning the popup has nothing left to stay open for either,
    // close it if it was open.
    topbarSasEl.classList.add('hidden');
    topbarSasEl.textContent = '';
    closeTopbarSasPopup();
    return;
  }
  topbarSasEl.classList.remove('hidden');

  if (state === 'ok' && result && Array.isArray(result.emoji)) {
    topbarSasEl.classList.add('topbar-sas--ok');
    topbarSasEl.textContent = result.emoji.join(' ');
    topbarSasEl.title = result.hex ? `Text code: ${result.hex}` : 'Room verification code';
  } else if (state === 'mismatch') {
    topbarSasEl.classList.add('topbar-sas--mismatch');
    topbarSasEl.textContent = '⚠️ verification failed';
    topbarSasEl.title = 'Room verification failed — codes do not match';
  } else if (state === 'unavailable') {
    topbarSasEl.classList.add('topbar-sas--unavailable');
    topbarSasEl.textContent = 'not verified';
    topbarSasEl.title = 'Verification unavailable — no direct connection';
  } else {
    // verifying
    topbarSasEl.classList.add('topbar-sas--verifying');
    topbarSasEl.textContent = 'verifying…';
    topbarSasEl.title = 'Verifying room…';
  }

  // The popup is already open (e.g. it changed verifying -> ok while the
  // user is reading it) — update its content, otherwise it would show stale
  // text.
  if (!topbarSasPopupEl.classList.contains('hidden')) renderTopbarSasPopupContent(state, result);
}

/**
 * Fill in the SAS details popup's content for the current state — the same
 * wording that used to live in static/chat.js: setRoomSas/.chat-sas-note
 * (moved here when SAS was removed from the chat panel header). Doesn't
 * touch the popup's own hidden class — only its content.
 */
function renderTopbarSasPopupContent(state, result) {
  if (state === 'ok' && result && Array.isArray(result.emoji)) {
    topbarSasPopupEmojiEl.textContent = result.emoji.join(' ');
    topbarSasPopupEmojiEl.classList.remove('hidden');
    topbarSasPopupTextEl.textContent =
      "These emoji are a fingerprint of this call's encryption key. Compare them out loud before discussing anything sensitive: if everyone sees the same emoji, no one is intercepting the call. If they differ, someone may have handed you a tampered link.";
    topbarSasPopupHexEl.textContent = result.hex ? `Text code: ${result.hex}` : '';
  } else if (state === 'mismatch') {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent =
      'Room verification failed — the codes do not match. This can mean someone is intercepting the call; do not discuss anything sensitive until this is resolved.';
    topbarSasPopupHexEl.textContent = '';
  } else if (state === 'unavailable') {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent =
      'Verification unavailable — there is no direct peer-to-peer connection to verify yet.';
    topbarSasPopupHexEl.textContent = '';
  } else {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent = 'Verifying the room…';
    topbarSasPopupHexEl.textContent = '';
  }
}

function onTopbarSasPopupKeydown(event) {
  if (event.key === 'Escape') closeTopbarSasPopup();
}

/** Open the SAS details popup (modeled on openSharePopup). Does nothing if the badge is hidden (state hidden — nothing to show). */
function openTopbarSasPopup() {
  if (topbarSasEl.classList.contains('hidden')) return;
  renderTopbarSasPopupContent(sasState, sasResult);
  topbarSasPopupEl.classList.remove('hidden');
  document.addEventListener('keydown', onTopbarSasPopupKeydown);
}

function closeTopbarSasPopup() {
  topbarSasPopupEl.classList.add('hidden');
  document.removeEventListener('keydown', onTopbarSasPopupKeydown);
}

/** Clicking the badge toggles the popup (see static/style.css: .topbar-sas — its z-index is explicitly above the popup's backdrop, so the badge stays directly clickable and a repeat click closes the popup the same way it opened it). */
function toggleTopbarSasPopup() {
  if (topbarSasPopupEl.classList.contains('hidden')) openTopbarSasPopup();
  else closeTopbarSasPopup();
}

topbarSasEl.addEventListener('click', toggleTopbarSasPopup);
// Clicking outside (on the transparent fullscreen backdrop) — closes it
// (the same trick as .share-popup-backdrop/openSharePopup).
topbarSasPopupBackdropEl.addEventListener('click', closeTopbarSasPopup);

function sasSetState(state) {
  if (state !== 'ok') sasResult = null;
  sasState = state;
  renderRoomSas();
}

/** Reset round state (going to hidden/unavailable — no one to verify against). */
function sasResetRound(state) {
  sasCurrentRoundId = null;
  sasRoundMembers = null;
  sasMyNonce = null;
  sasCommits = new Map();
  sasReveals = new Map();
  sasRevealed = false;
  sasSetState(state);
}

/** Start a new round over the membership snapshot `members` ([{peerId, fingerprint}]) with identifier `rid`. */
function sasStartRound(rid, members) {
  sasCurrentRoundId = rid;
  sasRoundMembers = members;
  sasMyNonce = RoomCrypto.generateSasNonce();
  sasCommits = new Map();
  sasReveals = new Map([[myPeerId, sasMyNonce]]); // our own nonce is known right away
  sasRevealed = false;
  sasSetState('verifying');
  RoomCrypto.sasCommit(rid, myPeerId, sasMyNonce)
    .then((commit) => {
      if (rid !== sasCurrentRoundId) return; // the round has already changed
      sasCommits.set(myPeerId, commit);
      bus.broadcast({ kind: 'sas-commit', round: rid, commit });
      return sasTryComplete();
    })
    .catch((err) => console.warn('SAS: failed to start round:', err));
}

/** Re-broadcast our own commit (and reveal, if already revealed) — covers peers whose bus opened after the first broadcast. */
function sasRebroadcast() {
  const commit = sasCommits.get(myPeerId);
  if (commit) bus.broadcast({ kind: 'sas-commit', round: sasCurrentRoundId, commit });
  if (sasRevealed && sasMyNonce) {
    bus.broadcast({
      kind: 'sas-reveal',
      round: sasCurrentRoundId,
      nonce: RoomCrypto.bytesToBase64url(sasMyNonce),
    });
  }
}

/**
 * Advance the current round: the reveal gate (we only reveal after
 * collecting ALL commits), verifying reveals against commits, deriving
 * SAS. Idempotent; safe under concurrent calls (checks whether the round
 * has changed).
 */
async function sasTryComplete() {
  const rid = sasCurrentRoundId;
  if (!rid || !sasRoundMembers) return;
  const expected = sasRoundMembers.map((m) => m.peerId);

  // 1. Wait for commits from all expected participants.
  if (!expected.every((p) => sasCommits.has(p))) {
    sasSetState('verifying');
    return;
  }
  // 2. Gate: all commits are collected — we can reveal our own nonce.
  if (!sasRevealed) {
    sasRevealed = true;
    bus.broadcast({ kind: 'sas-reveal', round: rid, nonce: RoomCrypto.bytesToBase64url(sasMyNonce) });
  }
  // 3. Wait for reveals from everyone.
  if (!expected.every((p) => sasReveals.has(p))) {
    sasSetState('verifying');
    return;
  }
  // 4. Verify each other reveal against its commit.
  for (const m of sasRoundMembers) {
    if (m.peerId === myPeerId) continue; // we trust our own nonce
    const commit = await RoomCrypto.sasCommit(rid, m.peerId, sasReveals.get(m.peerId));
    if (rid !== sasCurrentRoundId) return; // the round changed during the await
    if (commit !== sasCommits.get(m.peerId)) {
      sasSetState('mismatch');
      return;
    }
  }
  // 5. Everything matched — derive the SAS.
  const entries = sasRoundMembers.map((m) => ({
    peerId: m.peerId,
    fingerprint: m.fingerprint,
    nonce: sasReveals.get(m.peerId),
  }));
  const result = await RoomCrypto.deriveSas(entries);
  if (rid !== sasCurrentRoundId) return;
  sasResult = result;
  sasSetState('ok');
}

/**
 * Periodic tick: gather the current membership (ourselves + peers with an
 * OPEN bus and a known DTLS fingerprint), compute roundId (includes
 * fingerprints), and start a fresh round if it changed. Otherwise, drive
 * the current one forward. States:
 *  - alone in the room -> hidden (no one to verify against);
 *  - there are peers, but no verifiable P2P path to any of them ->
 *    unavailable (there's no media path either — see
 *    docs/sas-verification.md §8/§9).
 */
async function sasRefresh() {
  if (!ownCertFingerprint || !myPeerId) return; // certificate isn't ready — SAS is silently unavailable
  const peerEntries = Array.from(peers.entries());
  if (peerEntries.length === 0) {
    if (sasState !== 'hidden') sasResetRound('hidden');
    return;
  }
  const members = [{ peerId: myPeerId, fingerprint: ownCertFingerprint }];
  for (const [pid, entry] of peerEntries) {
    if (!bus.isOpen(pid)) continue;
    const fp = await entry.rtc.getRemoteCertificateFingerprint();
    if (fp) members.push({ peerId: pid, fingerprint: fp });
  }
  if (members.length < 2) {
    if (sasState !== 'unavailable') sasResetRound('unavailable');
    return;
  }
  const rid = await RoomCrypto.sasRoundId(members);
  if (rid !== sasCurrentRoundId) {
    sasStartRound(rid, members);
  } else {
    sasRebroadcast();
    await sasTryComplete();
  }
}

/** Start the periodic SAS tick (idempotently, survives reconnect). */
function startSasUpdates() {
  const tick = () => sasRefresh().catch((err) => console.warn('SAS tick failed:', err));
  tick();
  if (!sasRefreshTimer) sasRefreshTimer = setInterval(tick, SAS_REFRESH_MS);
}

/**
 * The crypto line/signaling counters/build hash — the cheap parts of the
 * "Connection and privacy" section (no getStats). Called when opening the
 * panel (openSettingsPanel) and on every tick of the shared 3-second speed
 * poller while the panel is open (see PEER_STATS_REFRESH_MS/pollPeerStats
 * above) — the section has no timer of its own. The peer list isn't part
 * of this — it's drawn by renderPeerConnectionsList, from the same call sites.
 */
function refreshConnectionSection() {
  renderCryptoInfo();
  renderServerCounters();
  renderSettingsBuildRow();
}

// ---------- Devices: microphone/camera selects (visible to all participants) ----------
//
// enumerateDevices() only returns human-readable labels ONCE the user has
// granted mic/camera permission at least once in this tab (before that —
// an empty string for every device, the spec deliberately doesn't reveal
// hardware without permission) — so before the first permission grant we
// show a numbered fallback like "Microphone 1", "Camera 2", etc. The list
// is rebuilt on every panel open and on the devicechange event (see below)
// — plugging in/unplugging a device should refresh the list even while the
// panel is already open.
async function refreshDeviceLists() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    console.warn('enumerateDevices failed:', err);
    return;
  }
  fillDeviceSelect(
    settingMicDeviceSelect,
    devices.filter((d) => d.kind === 'audioinput'),
    'Microphone'
  );
  fillDeviceSelect(
    settingCameraDeviceSelect,
    devices.filter((d) => d.kind === 'videoinput'),
    'Camera'
  );
}

function fillDeviceSelect(selectEl, list, labelPrefix) {
  // Preserve the select's current choice (the user may have already picked
  // a device this same session before the list was rebuilt, see
  // selected*DeviceId) — it takes priority, otherwise we keep whatever was
  // already set in the select itself.
  const wantId = selectEl.dataset.selectedDeviceId || selectEl.value || '';
  selectEl.textContent = '';
  list.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${labelPrefix} ${i + 1}`;
    selectEl.appendChild(opt);
  });
  if (wantId && list.some((d) => d.deviceId === wantId)) {
    selectEl.value = wantId;
  }
}

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', refreshDeviceLists);
}

settingMicDeviceSelect.addEventListener('change', () => {
  settingMicDeviceSelect.dataset.selectedDeviceId = settingMicDeviceSelect.value;
  applyMicDeviceChange(settingMicDeviceSelect.value || null);
});

settingCameraDeviceSelect.addEventListener('change', () => {
  settingCameraDeviceSelect.dataset.selectedDeviceId = settingCameraDeviceSelect.value;
  applyCameraDeviceChange(settingCameraDeviceSelect.value || null);
});

/** Sends update-settings as a WHOLE object (not a patch, see src/protocol.rs) — the server broadcasts settings-changed to everyone, including us (see registerSignalingHandlers). */
function sendSettingsUpdate(partial) {
  if (!roomSettings) return;
  const next = { ...roomSettings, ...partial };
  signaling.send('update-settings', { settings: next });
}

function wireSettingToggle(inputEl, key) {
  inputEl.addEventListener('change', () => {
    sendSettingsUpdate({ [key]: inputEl.checked });
  });
}

settingsButton.addEventListener('click', openSettingsPanel);
settingsPanelCloseEl.addEventListener('click', closeSettingsPanel);
settingsPanelBackdropEl.addEventListener('click', closeSettingsPanel);
wireSettingToggle(settingLobbyInput, 'lobbyEnabled');
wireSettingToggle(settingGuestChatInput, 'guestChat');
wireSettingToggle(settingGuestAudioInput, 'guestAudio');
wireSettingToggle(settingGuestVideoInput, 'guestVideo');
wireSettingToggle(settingGuestScreenInput, 'guestScreen');

// The select's empty value ("No limit") is encoded as null on the wire,
// not as a number — see populateMaxParticipantsOptions above for why this
// matters (null "follows" the server ceiling, a fixed number doesn't).
settingMaxParticipantsInput.addEventListener('change', () => {
  const raw = settingMaxParticipantsInput.value;
  sendSettingsUpdate({ maxParticipants: raw === '' ? null : parseInt(raw, 10) });
});

// ---------- Local streams: broadcasting to new and existing peers ----------

/**
 * Send stream-info to a single peer: if the DataChannel bus to them is
 * already open — through it (see bus.js/rtc.js, Phase 2), otherwise —
 * through the server relay as before (fallback: while the mesh is still
 * being established, there's no bus yet). The message format on receipt is
 * the same for both paths — see handleStreamInfo.
 *
 * E2E v2: over the bus `info` goes AS-IS (P2P DataChannel is already E2E
 * thanks to DTLS, see static/crypto.js/rtc.js) — whereas the server
 * fallback encrypts `info` as a whole under THIS `peerId`'s pairwise
 * K_pair_sig, the server sees only {v,iv,ct}.
 */
function sendStreamInfoTo(peerId, info) {
  if (bus.isOpen(peerId)) {
    bus.sendToPeer(peerId, { kind: 'stream-info', info });
  } else {
    encryptSigFor(peerId, info)
      .then((encInfo) => {
        signaling.send('stream-info', { targetPeerId: peerId, info: encInfo });
        ConnStats.incSignalingRelay();
      })
      .catch((err) => console.error(`Failed to encrypt stream-info for ${peerId}:`, err));
  }
}

/** Add `stream`'s track(s) to all existing PeerConnections and broadcast stream-info. */
function broadcastLocalStream(stream, kind) {
  const info = { [stream.id]: { kind, name: myName || null, enabled: true } };
  for (const [peerId, entry] of peers) {
    for (const track of stream.getTracks()) {
      entry.rtc.pc.addTrack(track, stream);
    }
    sendStreamInfoTo(peerId, info);
  }
}

/**
 * Tell all peers that a local stream toggled `enabled` (camera toggled via
 * the button). `stream-info` is opaque JSON to the server, so this is a
 * purely client-side protocol extension, not a separate message type.
 *
 * Why this is even needed (a gotcha found empirically): per the WebRTC
 * spec one might hope that `track.enabled = false` on the sender would
 * trigger a `mute` event on the corresponding track at the receiver — that's
 * how MediaStreamTrack behaves for local rendering. In practice, however,
 * in Chrome the sender keeps sending black frames when `enabled = false`
 * (similar to silence for audio — see the project history comment about the
 * microphone counter), so `mute`/`unmute` does NOT fire on the receiver: the
 * track stays live and "unmuted," just with black content. That's why
 * `track.onmute`/`onunmute` in attachCameraVideo are kept only as a safety
 * net (in case another browser behaves differently), while the main path is
 * this explicit signal via stream-info.
 */
function broadcastStreamEnabled(stream, kind, enabled) {
  const info = { [stream.id]: { kind, name: myName || null, enabled } };
  for (const peerId of peers.keys()) {
    sendStreamInfoTo(peerId, info);
  }
}

/** Remove all of `stream`'s tracks from every PeerConnection (used when stopping screen sharing). */
function removeLocalStreamFromAllPeers(stream) {
  const tracks = stream.getTracks();
  for (const entry of peers.values()) {
    for (const sender of entry.rtc.pc.getSenders()) {
      if (sender.track && tracks.includes(sender.track)) {
        try {
          entry.rtc.pc.removeTrack(sender);
        } catch (err) {
          console.warn('Failed to remove local track from peer:', err);
        }
      }
    }
  }
}

/**
 * Tell a specific peer about all our active streams (a snapshot) — called
 * TWICE over a pair's lifetime (see createRemotePeer):
 *   1) right when the peer is created — the bus isn't open yet, it will go
 *      through the server relay (the usual bootstrap path while the mesh
 *      is still being established);
 *   2) again the moment the bus to this peer opens (onBusOpen) — this time
 *      it will go over the bus (sendStreamInfoTo sees bus.isOpen() === true).
 * Repeat #2 closes the race of "the offer with tracks went out before the
 * bus opened": even if the server lost/delayed the first send, the current
 * state is guaranteed to arrive over the P2P channel as soon as it's ready
 * — after that, point updates (broadcastLocalStream/broadcastStreamEnabled)
 * almost always go over the bus.
 */
function sendAllActiveStreamInfoTo(peerId) {
  const info = {};
  if (micStream) info[micStream.id] = { kind: 'mic', name: myName || null, enabled: micTrack ? micTrack.enabled : true };
  if (camStream) info[camStream.id] = { kind: 'camera', name: myName || null, enabled: camTrack ? camTrack.enabled : true };
  if (screenStream) info[screenStream.id] = { kind: 'screen', name: myName || null, enabled: true };
  if (Object.keys(info).length > 0) {
    sendStreamInfoTo(peerId, info);
  }
}

// ---------- Incoming tracks: routing via stream-info ----------

/**
 * The single entry point for receiving stream-info — regardless of whether
 * it arrived over the DataChannel bus (see bus.onMessage below) or over the
 * server relay fallback (see signaling.on('stream-info', ...) in
 * registerSignalingHandlers): the `info` format is the same in both cases
 * (see sendStreamInfoTo), so all routing/deduplication logic lives here in
 * one place.
 */
function handleStreamInfo(info) {
  if (!info || typeof info !== 'object') return;
  for (const [streamId, meta] of Object.entries(info)) {
    const hadMetaBefore = streamInfoMap.has(streamId);
    streamInfoMap.set(streamId, meta);
    const queue = pendingTracks.get(streamId);
    if (queue) {
      pendingTracks.delete(streamId);
      for (const item of queue) {
        routeRemoteTrack(item.peerId, streamId, item.stream, item.track, meta);
      }
    } else if (hadMetaBefore && meta.kind === 'camera' && typeof meta.enabled === 'boolean') {
      // A repeated stream-info for an already-attached camera stream is an
      // enabled toggle (see broadcastStreamEnabled), not a new track.
      applyCameraEnabledUpdate(streamId, meta.enabled);
    } else if (hadMetaBefore && meta.kind === 'mic' && typeof meta.enabled === 'boolean') {
      // The same enabled toggle, but for the microphone — moves the "mic
      // off" indicator on the tile (see applyMicEnabledUpdate).
      applyMicEnabledUpdate(streamId, meta.enabled);
    }
  }
}

// Receiving stream-info over the bus (Phase 2) — the normal path once a
// mesh pair is established; the handler is shared with the server fallback
// (handleStreamInfo above). Chat messages and other bus features (see
// chat.js: dispatchEnvelope, envelope.kind) don't land here — filtered by
// kind: 'stream-info'.
bus.onMessage((_fromPeerId, obj) => {
  if (obj && obj.kind === 'stream-info') handleStreamInfo(obj.info);
});

// Phase 3: receiving repeated offer/answer/ice OVER THE BUS (see
// static/rtc.js — RtcPeer._trySendBusSignal on the sender side, sigCrypto
// isn't involved there anymore, the payload arrives in the clear).
// Routed to the SAME RtcPeer that sent the message (bus._dispatch calls
// handlers with fromPeerId — see bus.js/rtc.js: onBusMessage), so here we
// just need the specific peer's own RtcPeer — bus.getPeer(fromPeerId),
// not the full bus transport (rtc-signal isn't a chat message/feature, it
// needs access to handleBusSignal, which the Bus API doesn't have and
// shouldn't have).
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'rtc-signal') return;
  const rtc = bus.getPeer(fromPeerId);
  if (rtc) rtc.handleBusSignal(obj.payload);
});

function handleRemoteTrack(peerId, event) {
  const track = event.track;
  const stream = event.streams[0] || new MediaStream([track]);
  const streamId = stream.id;

  const meta = streamInfoMap.get(streamId);
  if (meta) {
    routeRemoteTrack(peerId, streamId, stream, track, meta);
    return;
  }
  let queue = pendingTracks.get(streamId);
  if (!queue) {
    queue = [];
    pendingTracks.set(streamId, queue);
  }
  queue.push({ peerId, stream, track });
}

function routeRemoteTrack(peerId, streamId, stream, track, meta) {
  if (!peers.has(peerId)) return; // the peer already left while the info was in flight
  if (meta.kind === 'mic') {
    micStreamOwner.set(streamId, peerId);
    // We always store the reference (see the header of the "Guest
    // permissions: enforcement on the receiver side" section) — we only
    // render it if currently allowed.
    const enabled = meta.enabled !== false;
    getOrCreateMediaRefs(peerId).mic = { stream, track, enabled };
    refreshMediaRenderingForPeer(peerId);
    setTileMicOffIndicator(peers.get(peerId).tile, !enabled);
  } else if (meta.kind === 'camera') {
    cameraStreamOwner.set(streamId, peerId);
    getOrCreateMediaRefs(peerId).camera = { stream, track, enabled: meta.enabled !== false };
    refreshMediaRenderingForPeer(peerId);
  } else if (meta.kind === 'screen') {
    attachScreenVideo(peerId, stream);
  }
}

function attachMicAudio(peerId, stream, track) {
  let audioEl = micAudioEls.get(peerId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.dataset.peerId = peerId;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    micAudioEls.set(peerId, audioEl);
  }
  if (audioEl.srcObject !== stream) {
    audioEl.srcObject = stream;
    safePlay(audioEl);
  }

  if (!micMonitors.has(peerId)) {
    const stop = SpeakingDetection.monitorTrack(track, (speaking) => setTileSpeaking(peerId, speaking));
    micMonitors.set(peerId, stop);
  }

  // A gotcha from the old viewer.js: removeTrack on the sender side gives
  // us mute, NOT ended — the reliable signal that a track is gone is
  // removetrack on the MediaStream itself (see the comment there).
  stream.onremovetrack = () => {
    if (stream.getAudioTracks().length === 0) {
      cleanupMicAudio(peerId);
    }
  };
  track.onended = () => cleanupMicAudio(peerId);
}

function cleanupMicAudio(peerId) {
  const audioEl = micAudioEls.get(peerId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    micAudioEls.delete(peerId);
  }
  const stop = micMonitors.get(peerId);
  if (stop) {
    stop();
    micMonitors.delete(peerId);
  }
  setTileSpeaking(peerId, false);
}

function attachCameraVideo(peerId, stream, track, initiallyEnabled = true) {
  const entry = peers.get(peerId);
  if (!entry) return;
  const videoEl = entry.tile.videoEl;
  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
    safePlay(videoEl);
  }
  showTileVideo(peerId, initiallyEnabled);

  // Turning the camera off via the button is track.enabled=false on the
  // sender side, the track isn't removed. The primary signal for this is an
  // explicit stream-info update with the enabled field (see
  // broadcastStreamEnabled and applyCameraEnabledUpdate) — track
  // mute/unmute here is kept only as a safety net for a different
  // browser/behavior: empirically in Chrome, with enabled=false the sender
  // keeps sending black frames, mute never fires.
  track.onmute = () => showTileVideo(peerId, false);
  track.onunmute = () => showTileVideo(peerId, true);

  // A safety net in case the track is actually removed (right now the
  // camera is never explicitly removeTrack'd, but if the browser does send
  // this, we don't get stuck on the last frame).
  stream.onremovetrack = () => {
    if (stream.getVideoTracks().length === 0) {
      showTileVideo(peerId, false);
      videoEl.srcObject = null;
    }
  };
  track.onended = () => {
    showTileVideo(peerId, false);
    videoEl.srcObject = null;
  };
}

function attachScreenVideo(peerId, stream) {
  // The owner and caption are already set by the `share-started` handler —
  // here we just attach the video stream itself, as soon as it actually
  // arrives (which can happen a bit later than share-started itself —
  // WebRTC negotiation isn't instant).
  showScreenStageContainer();
  if (screenVideoEl.srcObject !== stream) {
    screenVideoEl.srcObject = stream;
    screenVideoEl.muted = false;
    safePlay(screenVideoEl);
  }
  if (peerId !== myPeerId) {
    showRemoteScreenCaption(peerId);
  }
}

/** Apply an `enabled` update for an already-attached camera stream (toggle). */
function applyCameraEnabledUpdate(streamId, enabled) {
  const peerId = cameraStreamOwner.get(streamId);
  if (!peerId) return;
  const refs = peerMediaRefs.get(peerId);
  if (refs && refs.camera) refs.camera.enabled = enabled;
  // If rendering is currently forbidden by guest permissions (see
  // refreshMediaRenderingForPeer), the video isn't attached anyway, no need
  // to touch the element (otherwise it would show an empty/stale frame).
  const allowed = isPeerLeader(peerId) || (roomSettings && roomSettings.guestVideo);
  if (allowed) showTileVideo(peerId, enabled);
}

/** Apply an `enabled` update for an already-attached microphone stream (toggle) — moves the "mic off" indicator on the tile (see static/style.css: .tile-mic-off), regardless of the guest's audio-rendering permissions. */
function applyMicEnabledUpdate(streamId, enabled) {
  const peerId = micStreamOwner.get(streamId);
  if (!peerId) return;
  const refs = peerMediaRefs.get(peerId);
  if (refs && refs.mic) refs.mic.enabled = enabled;
  const entry = peers.get(peerId);
  if (entry) setTileMicOffIndicator(entry.tile, !enabled);
}

// ---------- Peers: creation/removal ----------

function createRemotePeer(peerId, name, iceServers) {
  const rtc = new RtcPeer({
    iceServers,
    polite: myPeerId > peerId,
    signaling,
    targetPeerId: peerId,
    // SAS: a single session certificate for all connections (see
    // ensureSessionCertificate, static/crypto.js: deriveSas). Can be null
    // if generation failed — then the browser issues its own certificate,
    // and SAS simply won't be shown.
    certificate: sessionCertificate,
    // E2E v2: offer/answer/ice-candidate to THIS peer always go through the
    // server signaling relay — RtcPeer encrypts/decrypts them itself under
    // this peerId's PAIRWISE K_pair_sig (see static/rtc.js, static/crypto.js),
    // room.js just supplies the functions. The pair must already be cached
    // by this point (see cachePairKeys — called BEFORE createRemotePeer
    // everywhere).
    sigCrypto: {
      encrypt: (obj) => encryptSigFor(peerId, obj),
      decrypt: (blob) => decryptSigFrom(peerId, blob),
    },
    onCryptoFailure: handleCryptoFailureOnce,
    onTrack: (event) => handleRemoteTrack(peerId, event),
    onStateChange: () => {},
    onBusMessage: (obj) => bus._dispatch(peerId, obj),
    // Phase 2: as soon as the bus to this peer opens — immediately forward
    // it a snapshot of all our current stream-info over it (see
    // sendAllActiveStreamInfoTo, and there for why this second time is needed).
    onBusOpen: () => {
      sendAllActiveStreamInfoTo(peerId);
      // SAS: the bus to the peer opened — membership/fingerprints may have
      // changed, rebuild the round without waiting for the timer (see sasRefresh).
      if (sasRefreshTimer) sasRefresh().catch(() => {});
      // Chat: flush the local outgoing queue that was waiting for the bus
      // to open (arrived in place of the server fallback relay, see
      // static/chat.js: notifyBusOpen).
      if (chat && typeof chat.notifyBusOpen === 'function') chat.notifyBusOpen(peerId);
    },
    // Phase 3: an incoming file DataChannel — routed to ChatPanel (that's
    // where the file-transfer protocol lives, see static/chat.js). `chat`
    // may not yet be created at the moment this callback is registered (for
    // the first peers, ChatPanel.create() is called later, see joined
    // below) — we read the variable at the moment the callback actually
    // fires, not at registration time.
    onFileChannel: (channel) => {
      if (chat) chat.handleIncomingFileChannel(peerId, channel);
    },
  });
  bus.addPeer(peerId, rtc);

  const tile = createTile(peerId, name, false);
  tile.crownEl.classList.toggle('hidden', leaderId !== peerId); // leaderId may already be known (peer-joined/reconnect)
  peers.set(peerId, { rtc, name, tile });

  // Local active tracks — added to the new pc right away (coalesced into a single offer).
  if (micStream) rtc.pc.addTrack(micTrack, micStream);
  if (camStream) rtc.pc.addTrack(camTrack, camStream);
  if (screenStream) {
    for (const track of screenStream.getTracks()) rtc.pc.addTrack(track, screenStream);
  }
  sendAllActiveStreamInfoTo(peerId);
}

function removeRemotePeer(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  if (maximizedTile === entry.tile) unmaximizeTile(); // the peer left — nothing left to show large
  entry.rtc.close();
  entry.tile.root.remove();
  peers.delete(peerId);
  peerNames.delete(peerId);
  pairKeysCache.delete(peerId); // E2E v2: the peer left — the pairwise key is no longer needed (see static/crypto.js, PFS)
  peerMediaRefs.delete(peerId);
  peerStatsHistory.delete(peerId); // otherwise a new connection reusing the same peerId would inherit someone else's speed baseline
  peerLastStats.delete(peerId); // same principle — the speed cache mustn't outlive the peerId
  bus.removePeer(peerId);
  cleanupMicAudio(peerId);
  for (const [streamId, ownerPeerId] of cameraStreamOwner) {
    if (ownerPeerId === peerId) cameraStreamOwner.delete(streamId);
  }
  for (const [streamId, ownerPeerId] of micStreamOwner) {
    if (ownerPeerId === peerId) micStreamOwner.delete(streamId);
  }

  if (currentScreenOwnerPeerId === peerId) {
    currentScreenOwnerPeerId = null;
    hideScreenStage();
    updateScreenButtonState();
  }

  // SAS: membership changed — rebuild the round (otherwise the old roundId would linger).
  if (sasRefreshTimer) sasRefresh().catch(() => {});
}

/**
 * Full local teardown of the mesh/media/chat — used by terminal states
 * after which restoring the connection is pointless (see
 * signaling.on('room-expired') in registerSignalingHandlers: the room is
 * already deleted on the server). Unlike giveUpReconnect (there the
 * signaling socket died, but the mesh/DataChannel chat can physically
 * survive that and are left as-is — see docs/self-hosting.md, "Surviving a
 * Restart/Redeploy"), here the reason is terminal IN SUBSTANCE (not "the
 * server blinked" but "time is up") — there's no point leaving P2P
 * connections and captured mic/camera/screen browser tracks hanging, we
 * stop them right away.
 */
function teardownMeshMediaChat(reason) {
  // Our own camera track below is stopped directly (not via
  // showTileVideo/the camera button) — if our own tile happened to be
  // maximized at this moment, exitMaximizeIfHidden won't fire on its own
  // here, so we un-maximize explicitly (otherwise a stuck black overlay
  // would remain after the terminal teardown).
  unmaximizeTile();
  // The single shared speed poller (see startPeerStatsPolling) would
  // survive this teardown on its own — ticking on empty peers is cheap,
  // but the room won't be restored anymore (see the function comment
  // above), so we stop it explicitly, same as roomTimerInterval (see
  // stopRoomTimer in signaling.on('room-expired')).
  stopPeerStatsPolling();
  for (const peerId of Array.from(peers.keys())) {
    removeRemotePeer(peerId);
  }
  if (micTrack) micTrack.stop();
  micStream = null;
  micTrack = null;
  if (camTrack) camTrack.stop();
  camStream = null;
  camTrack = null;
  forceStopLocalScreenCapture();
  if (chat) chat.disableInput(reason);
}

// ---------- Reconnect: grace period for lagging peers/screen-share owner ----------

/**
 * After a successful reconnect, a peer may temporarily drop out of the
 * fresh joined.peers (after a restart the server remembers nothing until
 * the participant reconnects themselves) — instead of removing it
 * immediately, we give it RECONNECT_PEER_GRACE_MS to reconnect. If a
 * peer-joined with the same peerId arrives within that time, the timer is
 * cancelled (see cancelPendingPeerRemoval in the peer-joined handler), the
 * mesh peer was never removed at all.
 */
function schedulePeerRemoval(peerId) {
  if (pendingPeerRemovals.has(peerId)) return;
  const timer = setTimeout(() => {
    pendingPeerRemovals.delete(peerId);
    removeRemotePeer(peerId);
    updateParticipantCount();
  }, RECONNECT_PEER_GRACE_MS);
  pendingPeerRemovals.set(peerId, timer);
}

function cancelPendingPeerRemoval(peerId) {
  const timer = pendingPeerRemovals.get(peerId);
  if (timer) {
    clearTimeout(timer);
    pendingPeerRemovals.delete(peerId);
  }
}

/** A symmetric grace period for a screen-share owner who hasn't re-joined yet themselves (see reconcileScreenShareAfterReconnect). */
function scheduleScreenOwnerGrace(ownerPeerId) {
  if (screenOwnerGraceTimer) return;
  screenOwnerGraceTimer = setTimeout(() => {
    screenOwnerGraceTimer = null;
    if (currentScreenOwnerPeerId === ownerPeerId) {
      // The owner never re-joined within the allotted time — the stage is fairly torn down.
      currentScreenOwnerPeerId = null;
      hideScreenStage();
      updateScreenButtonState();
    }
  }, RECONNECT_PEER_GRACE_MS);
}

function cancelScreenOwnerGrace() {
  if (screenOwnerGraceTimer) {
    clearTimeout(screenOwnerGraceTimer);
    screenOwnerGraceTimer = null;
  }
}

// ---------- Signaling ----------

// ---------- Join modal: shown FIRST, join-room is only sent after the click ----------

function showJoinModal() {
  joinModalEl.classList.remove('hidden');
  // Pre-filled with a generated name (see static/namegen.js: userName()) —
  // click "Join" and that's it, no need to ask. The user can clear the
  // field → as before, they stay anonymous (onJoinModalSubmit: trim() + `||
  // null`). !value — in case the field already contains something (it
  // shouldn't at this point, but we don't overwrite it just in case).
  if (!joinNameInputEl.value) joinNameInputEl.value = NameGen.userName();
  joinNameInputEl.focus();
  // Deliberately NOT .select() — the generated name shouldn't come up
  // highlighted; the cursor just sits in the field so you can edit if you want.
}

function hideJoinModal() {
  joinModalEl.classList.add('hidden');
}

let joinSubmitInProgress = false;

async function onJoinModalSubmit() {
  if (joinSubmitInProgress) return;
  joinSubmitInProgress = true;
  // A click is a user gesture, also useful for AudioContext (see
  // static/common.js: SpeakingDetection tries to resume the AudioContext
  // on click/keydown).
  const raw = joinNameInputEl.value.trim();
  myName = raw || null;
  hideJoinModal();
  await connectAndJoin();
}

joinModalButtonEl.addEventListener('click', onJoinModalSubmit);
joinNameInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    onJoinModalSubmit();
  }
});

// The "regenerate" button next to the name field (see showJoinModal) —
// rolls a new NameGen.userName() and returns focus to the field. NOT
// .select() — the new name shouldn't come up highlighted (same as the
// initial prefill in showJoinModal).
joinNameRegenButtonEl.addEventListener('click', () => {
  joinNameInputEl.value = NameGen.userName();
  joinNameInputEl.focus();
});

async function init() {
  // E2E v2: the link token (`t`/`e`) is required BEFORE showing anything
  // related to actually joining — without it there's no point even asking
  // for a name, nothing will work anyway (see docs/e2e-encryption.md,
  // initCryptoIdentity above). Same semantics (for 'invalid') as a failed
  // decryption of the first incoming message (see showInvalidLinkOverlay);
  // 'expired' is a separate terminal overlay (see showLinkExpiredOverlay).
  const status = await initCryptoIdentity();
  if (status === 'invalid') {
    showInvalidLinkOverlay();
    return;
  }
  if (status === 'expired') {
    showLinkExpiredOverlay();
    return;
  }

  // Anonymity (see docs/privacy.md, "Anonymity"): the name is asked again
  // on EVERY visit via this modal — no localStorage at all. The field is
  // pre-filled with a generated name (see showJoinModal: NameGen.userName())
  // so you can simply click "Join" without typing, but the user can clear
  // it — then they stay anonymous, as before. join-room is only sent after
  // clicking "Join" (see onJoinModalSubmit). On auto-reconnect the modal
  // isn't shown again — the name is already in the tab's memory (myName),
  // see attemptReconnectOnce/sendJoinAndWait below.
  showJoinModal();
}

async function connectAndJoin() {
  showOverlay({ title: 'Connecting…', spinner: true });

  iceServersCache = await fetchIceServers();
  lastKnownVersion = await fetchVersion();
  await ensureSessionCertificate();

  signaling = new Signaling();
  signaling.onError = (event) => {
    console.error('Signaling error:', event);
  };
  signaling.onClose = () => {
    // Already reconnecting (this close is from a failed attempt inside the
    // reconnect loop itself) — the loop will handle it, don't start it again.
    if (reconnecting) return;
    // The user left on their own, or a terminal overlay is already shown
    // (room-not-found/room-full before the first joined, or a drop before
    // the first joined) — reconnecting here would be inappropriate.
    if (intentionalDisconnect || terminalState || !joinedOnce) return;

    // An unexpected signaling drop after a successful join — the mesh
    // (media, DataChannel chat) stays alive through this (see
    // docs/self-hosting.md, "Surviving a Restart/Redeploy"), so we do NOT
    // tear down the UI right away: a thin banner + auto-reconnect with
    // backoff, and only if it exhausts its budget — the terminal
    // "Connection lost" overlay.
    startReconnectLoop();
  };

  try {
    await signaling.connect();
  } catch (err) {
    terminalState = true;
    showOverlay({
      title: 'Could not connect',
      text: 'Check your internet connection and refresh the page.',
    });
    return;
  }

  registerSignalingHandlers(iceServersCache);
  // E2E v2: `name` is now ALWAYS null on the wire (the name travels as a
  // separate encrypted `name-announce`, see src/protocol.rs and
  // sendNameAnnounceTo/broadcastNameAnnounceTo above) — `peerId`/`epub` are
  // our own tab identity (see initCryptoIdentity), sent explicitly from the
  // very first entry (not only on reconnect, see the comment there "Why the
  // client chooses peerId").
  signaling.send('join-room', {
    roomId,
    name: null,
    peerId: myPeerId,
    epub: myEpub,
    ...(initialLeaderToken ? { leaderToken: initialLeaderToken } : {}),
  });
}

function registerSignalingHandlers(iceServers) {
  signaling.on('joined', ({ peerId, peers: otherPeers, screenOwner, leaderId: joinedLeaderId, settings, pending, roomAgeSeconds, maxParticipants: joinedMaxParticipants }) => {
    // Reconnect is specifically waiting for this response (see
    // waitForJoinOutcome) — report it the outcome in addition to the
    // regular handling below (on the initial join, pendingJoinResolve is
    // never set).
    if (pendingJoinResolve) pendingJoinResolve('joined');

    // The call-duration timer (count-up): resync the counting base from
    // the fresh roomAgeSeconds on EVERY joined — both on initial entry and
    // on reconnect (see startRoomTimer above and docs/security.md,
    // "Meeting Duration Ceiling").
    startRoomTimer(roomAgeSeconds);

    // The participant ceiling — taken from the server on EVERY joined (an
    // additive field, see maxParticipants above); if it's absent (an old
    // server), we don't touch the current fallback. The total is
    // recomputed below via updateParticipantCount along its usual path.
    if (typeof joinedMaxParticipants === 'number' && Number.isFinite(joinedMaxParticipants)) {
      maxParticipants = joinedMaxParticipants;
      // If the room currently has no custom limit (the leader hasn't
      // narrowed it), the effective value above IS the real server
      // ceiling, remember it separately (see knownServerMaxParticipants
      // above) — this is the only moment we can be sure of that.
      if (settings && settings.maxParticipants == null) {
        knownServerMaxParticipants = joinedMaxParticipants;
      }
    }

    if (!joinedOnce) {
      // --- Initial entry into the room (not a reconnect) ---
      joinedOnce = true;
      myPeerId = peerId; // almost always the same as what we generated ourselves (see initCryptoIdentity) — reassigned in case of an extremely rare UUID collision
      hideOverlay();

      ownTile = createTile(peerId, myName, true);

      // E2E v2: other participants' names no longer arrive in this message
      // (PeerInfo.name is always null for v2 clients, see src/protocol.rs)
      // — tiles are created with a "Guest" placeholder (see createTile),
      // real names will arrive as separate name-announce messages (see
      // below). We cache key pairs RIGHT AWAY from epub — before
      // createRemotePeer, so sigCrypto (SDP/ICE/stream-info, see
      // createRemotePeer) immediately finds the ready key in the cache.
      for (const p of otherPeers) {
        cachePairKeys(p.peerId, p.epub);
        createRemotePeer(p.peerId, null, iceServers);
      }
      // Announce our own name to everyone we already see (if it's not
      // empty) — resent "idempotently" on reconnect too (see the branch below).
      broadcastNameAnnounceTo(otherPeers.map((p) => p.peerId));

      currentScreenOwnerPeerId = screenOwner || null;
      if (currentScreenOwnerPeerId && currentScreenOwnerPeerId !== myPeerId) {
        showRemoteScreenCaption(currentScreenOwnerPeerId);
      }

      roomSettings = settings;
      pendingRequests = (pending || []).map((p) => {
        cachePairKeys(p.peerId, p.epub);
        return { peerId: p.peerId, name: null }; // "Guest" until a name-announce arrives from this pending request
      });
      setLeaderIndicator(joinedLeaderId);
      updateSettingsButtonVisibility();
      renderJoinRequests();
      applyGuestEnforcement();

      updateScreenButtonState();
      updateParticipantCount();

      chat = ChatPanel.create({
        signaling,
        bus,
        peerId,
        name: myName,
        variant: 'room',
        toggleButton: chatButton,
        getPeerIds: () => Array.from(peers.keys()),
        initialPeerIds: otherPeers.map((p) => p.peerId),
        getLeaderId: () => leaderId,
        getGuestChatAllowed: () => (roomSettings ? roomSettings.guestChat : true),
      });
      startSasUpdates();
      // The shared speed poller (see PEER_STATS_REFRESH_MS/pollPeerStats) —
      // starts on entering the room and keeps ticking for the whole
      // session, regardless of peer count and whether the settings panel is open.
      startPeerStatsPolling();
      return;
    }

    // --- Reconnect: reconcile the room state against what we already have ---
    // (the mesh/media/chat have been alive this whole time, none of it is
    // recreated here — see reconcileAfterReconnect). The server usually
    // returns the same peerId (see src/ws.rs::JoinRoom { peer_id }), but we
    // guard against the rare case where it changed anyway.
    myPeerId = peerId;
    roomSettings = settings;
    setLeaderIndicator(joinedLeaderId);
    updateSettingsButtonVisibility();
    // Leadership can change across a reconnect (see
    // docs/permissions-and-leader.md, "Reconnecting With the Same Peer Id":
    // the server may have already removed us and assigned a new leader) —
    // we only see pending requests again if we're the leader once more
    // after the reconnect.
    pendingRequests = isLeader
      ? (pending || []).map((p) => {
          cachePairKeys(p.peerId, p.epub);
          return { peerId: p.peerId, name: null };
        })
      : [];
    renderJoinRequests();
    applyGuestEnforcement();
    reconcileAfterReconnect(otherPeers, screenOwner);
    refreshMediaRenderingForAllPeers();
    updateParticipantCount(); // in case maxParticipants changed above (the server was restarted with a different env)
    // Re-joining (see static/crypto.js, "PFS"): the key pair is the same
    // (myEphemeralKeyPair didn't change), but we resend name-announce to
    // everyone — idempotently, in case one of the peers also reconnected
    // and lost state.
    broadcastNameAnnounceTo(otherPeers.map((p) => p.peerId));
  });

  signaling.on('waiting', ({ leaderPeerId, leaderEpub }) => {
    // Lobby (see docs/permissions-and-leader.md, "The Waiting Room
    // (Lobby)"): instead of joined, this arrives first — we wait for the
    // leader's decision. "Cancel" = leave + go home (the same trick as
    // leaveButton below — intentionalDisconnect before leave). E2E v2: as
    // soon as the leader's epub is known, we announce our own name to them
    // (if it's not empty), see sendNameAnnounceTo. The server sends a FRESH
    // `waiting` when the leader changes while we're waiting (see
    // src/ws.rs) — this handler fires again and resends the announcement
    // to the new leader.
    cachePairKeys(leaderPeerId, leaderEpub);
    sendNameAnnounceTo(leaderPeerId);
    showOverlay({
      title: 'Waiting for approval…',
      text: myName ? `You joined as "${myName}"` : 'Waiting for the room leader to respond.',
      spinner: true,
      actionLabel: 'Cancel',
      onAction: () => {
        intentionalDisconnect = true;
        if (signaling) signaling.send('leave');
        location.href = '/';
      },
    });
  });

  signaling.on('join-request', ({ peerId, epub }) => {
    cachePairKeys(peerId, epub);
    addPendingRequest(peerId, null); // "Guest" until a name-announce arrives from this pending request (see signaling.on('name-announce'))
  });

  signaling.on('join-request-cancelled', ({ peerId }) => {
    removePendingRequest(peerId);
    pairKeysCache.delete(peerId); // the waiting peer left for good without waiting for a decision — the pair is no longer needed
  });

  // E2E v2: name announcement (see src/protocol.rs::ServerMessage::NameAnnounce)
  // — from a regular participant to ANY other one, or from a pending
  // participant ONLY to the current leader (the server itself enforces
  // this distinction, see src/ws.rs::handle_name_announce).
  //
  // A message from a sender with NO established pair (pairKeysCache) is
  // silently ignored with a warning — this is NOT a crypto failure: either
  // a legitimate in-flight message from a peer that just left (its pair is
  // already cleaned up in removeRemotePeer/reject/join-request-cancelled —
  // the "message was already in flight when the peer left" race is normal
  // for a live relay), or a garbage peerId from the server. Neither is a
  // sign of MITM — an attacker gains nothing from a message we ignore,
  // while a real MITM tampering with traffic for a KNOWN pair still runs
  // into the GCM failure below. The semantics of "known sender + failed to
  // decrypt = terminal overlay" (handleCryptoFailureOnce) is unchanged —
  // the same principle as for offer/answer/ice-candidate (there peers.get
  // serves as the guard).
  signaling.on('name-announce', ({ from, payload }) => {
    if (!pairKeysCache.has(from)) {
      console.warn('name-announce from a sender with no established pair (left/unknown) — ignoring:', from);
      return;
    }
    decryptNameAnnouncePayload(from, payload)
      .then((name) => {
        peerNames.set(from, name);
        updatePeerTileName(from, name);
        setPendingRequestName(from, name);
      })
      .catch((err) => handleCryptoFailureOnce(err));
  });

  signaling.on('join-rejected', () => {
    terminalState = true;
    showOverlay({
      title: 'Access denied',
      text: 'The room leader declined your join request.',
      actionLabel: 'Go home',
    });
  });

  signaling.on('settings-changed', ({ settings }) => {
    roomSettings = settings;
    // IMPORTANT (an easily-forgotten detail, see
    // docs/research-room-limit.md §2.3): unlike joined, settings-changed
    // doesn't send the effective limit as a separate number — only the
    // settings themselves. We recompute it ourselves: settings.maxParticipants
    // if the leader set a custom one (not null), otherwise the best known
    // value of the real server ceiling (see knownServerMaxParticipants
    // above). Without this recompute, the "Participants: N / M" counter and
    // the "Room is full" overlay text wouldn't update in real time for
    // already-connected participants when the leader changes the limit
    // mid-call — they read maxParticipants specifically, not roomSettings directly.
    maxParticipants = typeof settings.maxParticipants === 'number' ? settings.maxParticipants : knownServerMaxParticipants;
    updateParticipantCount();
    if (!settingsPanelEl.classList.contains('hidden')) syncSettingsPanelInputs();
    applyGuestEnforcement();
    refreshMediaRenderingForAllPeers();
  });

  signaling.on('leader-changed', ({ leaderId: newLeaderId }) => {
    setLeaderIndicator(newLeaderId);
    updateSettingsButtonVisibility();
    applyGuestEnforcement();
    refreshMediaRenderingForAllPeers();
    if (newLeaderId === myPeerId) {
      showToast('You are now the leader');
    } else {
      showToast(`${peerNames.get(newLeaderId) || 'Guest'} is now the leader`);
    }
  });

  signaling.on('room-not-found', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-not-found');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Room not found',
      text: 'The link is invalid or the room has already been deleted.',
      actionLabel: 'Create a new one',
    });
  });

  signaling.on('room-full', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-full');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Room is full',
      // room-full arrives BEFORE joined (the request was rejected, joined
      // will never arrive for this socket) — there is and will be no fresh
      // joined.maxParticipants for THIS rejection, so the text uses the
      // same maxParticipants variable as the rest of the UI: the
      // server-provided value if we ourselves ever successfully joined
      // during this browser session, otherwise the fallback of 6.
      text: `This room already has the maximum of ${maxParticipants} participants. Please try again later.`,
    });
  });

  // The meeting-duration limit (3 hours, see docs/security.md, "Meeting
  // Duration Ceiling", and startRoomTimer above): the server itself decides
  // when time's up — broadcasts this to all participants AND those waiting
  // in the lobby, and closes the socket itself right after (see
  // src/ws.rs::reap_rooms, src/state.rs). We set terminalState=true
  // SYNCHRONOUSLY right here (before the close itself arrives) — the same
  // trick as room-not-found/room-full/join-rejected above:
  // signaling.onClose checks terminalState and doesn't start
  // auto-reconnect, doesn't overwrite this overlay with "Connection lost"
  // (see connectAndJoin: signaling.onClose). Terminal and irreversible —
  // the room is already deleted on the server, reconnecting to it won't
  // technically restore anything (unlike a server restart, see
  // restoreRoomViaPut — here there's nothing to restore, the limit expired deliberately).
  signaling.on('room-expired', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-expired');
    }
    if (terminalState) return; // the overlay is already shown (double delivery/race) — don't overwrite it
    terminalState = true;
    stopRoomTimer();
    showOverlay({
      title: 'Meeting time is up (3 hours)',
      text: 'The room is closed — the meeting duration limit was reached.',
      actionLabel: 'Create a new one',
    });
    teardownMeshMediaChat('Meeting time is up.');
  });

  signaling.on('peer-joined', ({ peerId, epub }) => {
    cachePairKeys(peerId, epub);
    if (peers.has(peerId)) {
      // We already know this peer — the mesh survived a signaling drop
      // (ours or theirs), this is just a repeated peer-joined from their
      // own reconnect. Idempotent: we do NOT recreate the existing RtcPeer.
      cancelPendingPeerRemoval(peerId);
      return;
    }
    // E2E v2: the name will arrive as a separate name-announce (see above)
    // — until then, a tile with a "Guest" placeholder (see createTile).
    createRemotePeer(peerId, null, iceServers);
    updateParticipantCount();
    sendNameAnnounceTo(peerId); // "on a new peer's peer-joined — send them a name-announce"
  });

  signaling.on('peer-left', ({ peerId }) => {
    removeRemotePeer(peerId);
    updateParticipantCount();
  });

  signaling.on('offer', async ({ fromPeerId, sdp }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) {
      console.warn('offer from an unknown peer:', fromPeerId);
      return;
    }
    await entry.rtc.handleDescription(sdp);
  });

  signaling.on('answer', async ({ fromPeerId, sdp }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) return;
    await entry.rtc.handleDescription(sdp);
  });

  signaling.on('ice-candidate', async ({ fromPeerId, candidate }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) return;
    await entry.rtc.handleCandidate(candidate);
  });

  // The server relay fallback (see sendStreamInfoTo) — relevant while the
  // bus to a specific peer isn't open yet (mainly the bootstrap window
  // right after joining the room); after that the main path is
  // bus.onMessage above, and this handler becomes rare (see
  // handleStreamInfo — the shared entry point). E2E v2: `info` on this path
  // arrives encrypted under the pairwise K_pair_sig of the sender
  // `fromPeerId` specifically (see sendStreamInfoTo) — over the bus
  // (bus.onMessage above) info stays as-is, unwrapped. A sender with no
  // established pair — a silent warn-skip, NOT a crypto failure: an
  // in-flight message from a peer that just left (its pair is already cleaned up in
  // removeRemotePeer) — a normal race for a live relay, see the detailed
  // reasoning at signaling.on('name-announce') above.
  signaling.on('stream-info', ({ fromPeerId, info }) => {
    if (!pairKeysCache.has(fromPeerId)) {
      console.warn('stream-info from a sender with no established pair (left/unknown) — ignoring:', fromPeerId);
      return;
    }
    decryptSigFrom(fromPeerId, info)
      .then((plainInfo) => handleStreamInfo(plainInfo))
      .catch((err) => handleCryptoFailureOnce(err));
  });

  signaling.on('share-started', ({ peerId }) => {
    cancelScreenOwnerGrace(); // the owner is confirmed by the server — the grace period is no longer needed
    // Screen-share takeover (see docs/permissions-and-leader.md, "last
    // wins"): if before this message I was the OWNER
    // (currentScreenOwnerPeerId===myPeerId) and my local capture
    // (getDisplayMedia) is still alive, but the peerId in this broadcast
    // isn't mine anymore, it means I've just been taken over. The server
    // doesn't send a separate message for this — it broadcasts
    // share-started to everyone, including the previous owner, and this
    // same message serves as their signal to stop their own capture.
    const iAmPreempted = currentScreenOwnerPeerId === myPeerId && screenStream && peerId !== myPeerId;
    currentScreenOwnerPeerId = peerId;
    if (peerId === myPeerId) {
      showLocalScreenPreview();
    } else {
      if (iAmPreempted) {
        forceStopLocalScreenCapture();
      }
      showRemoteScreenCaption(peerId);
    }
    updateScreenButtonState();
    if (pendingShareDecision && peerId === myPeerId) {
      pendingShareDecision.resolve(true);
      pendingShareDecision = null;
    }
  });

  signaling.on('share-stopped', ({ peerId }) => {
    cancelScreenOwnerGrace();
    if (currentScreenOwnerPeerId === peerId) {
      currentScreenOwnerPeerId = null;
    }
    hideScreenStage();
    updateScreenButtonState();
  });

  signaling.on('share-rejected', ({ busyPeerId, reason }) => {
    cancelScreenOwnerGrace();
    if (screenStream && currentScreenOwnerPeerId === myPeerId) {
      // We were sharing our screen before the signaling drop, and after
      // reconnecting we tried to replay share-start (see
      // reconcileScreenShareAfterReconnect). Screen busyness is no longer
      // rejected (takeover on ownership conflict instead — see
      // handle_share_start), so the only real reason for a rejection here
      // is losing permission (the leader disabled guestScreen while we
      // were offline, see the reason==='forbidden' branch below) — we
      // correctly stop our own local capture.
      forceStopLocalScreenCapture();
    }
    if (reason === 'forbidden') {
      // Rejected due to permissions (guestScreen=false, see
      // docs/permissions-and-leader.md, "Screen Sharing —
      // Server-Enforced"), not because the screen is busy — busyPeerId
      // doesn't arrive in this case.
      currentScreenOwnerPeerId = null;
      updateScreenButtonState();
      showRoomMessage('The leader has disabled screen sharing.');
    } else {
      // The server no longer ever sends "busy" (see
      // src/protocol.rs::ShareRejected) — this branch is dead in practice,
      // kept only as a defensive state sync in case of an unforeseen rejection reason.
      currentScreenOwnerPeerId = busyPeerId || null;
      updateScreenButtonState();
      if (busyPeerId) {
        showRoomMessage(`${peerNames.get(busyPeerId) || 'Another participant'} is already sharing their screen.`);
      }
    }
    if (pendingShareDecision) {
      pendingShareDecision.resolve(false);
      pendingShareDecision = null;
    }
  });

  signaling.on('error', ({ message }) => {
    console.error('Signaling server reported an error:', message);
  });
}

// ---------- Reconnect: reconnection loop ----------

/** Wait for the outcome of ONE join-room attempt: 'joined' | 'room-not-found' | 'room-full' | 'timeout'. */
function waitForJoinOutcome(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      pendingJoinResolve = null;
      resolve(status);
    };
    pendingJoinResolve = finish;
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** Send join-room with our previous peerId/epub (see src/protocol.rs) and wait for the outcome. */
function sendJoinAndWait() {
  const promise = waitForJoinOutcome(RECONNECT_JOIN_TIMEOUT_MS);
  // E2E v2: `name` is always null (see connectAndJoin) — peerId/epub are the
  // same as on the initial entry (unchanged, see initCryptoIdentity).
  signaling.send('join-room', {
    roomId,
    name: null,
    peerId: myPeerId,
    epub: myEpub,
  });
  return promise;
}

/** PUT /api/rooms/<roomId> — restore the room if the reaper/a restart removed it (see src/main.rs::restore_room). */
async function restoreRoomViaPut() {
  try {
    // Step 2: via window.API_BASE — see fetchVersion above and static/config.js.
    const res = await fetch(`${window.API_BASE}/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PUT' });
    return res.ok; // 200 (already existed) or 201 (created) — both are fine
  } catch (err) {
    return false;
  }
}

/** One full reconnect attempt: open the WS -> join-room -> (if room-not-found) PUT restore -> join-room again. */
async function attemptReconnectOnce() {
  try {
    await signaling.connect();
  } catch (err) {
    return false;
  }

  const outcome = await sendJoinAndWait();
  if (outcome === 'joined') return true;

  if (outcome === 'room-not-found') {
    const restored = await restoreRoomViaPut();
    if (!restored) return false;
    // The server itself closes the socket right after a room-not-found
    // rejection (see src/ws.rs: "after a rejection the server closes the
    // socket itself") — a repeated join-room on the SAME socket would go
    // nowhere (see Signaling.send: silently won't send on a closed socket),
    // so before retrying we open a NEW connection.
    try {
      await signaling.connect();
    } catch (err) {
      return false;
    }
    const outcome2 = await sendJoinAndWait();
    return outcome2 === 'joined';
  }

  // 'room-full' (unlikely — our spot frees up almost right after the drop)
  // or 'timeout' — the attempt is treated as failed, the loop will retry with backoff.
  return false;
}

function startReconnectLoop() {
  if (reconnecting) return;
  reconnecting = true;
  reconnectAttempt = 0;
  reconnectDeadline = Date.now() + RECONNECT_TOTAL_BUDGET_MS;
  showReconnectBanner();
  scheduleNextReconnectAttempt(0);
}

function scheduleNextReconnectAttempt(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    const ok = await attemptReconnectOnce();
    if (ok) {
      finishReconnectSuccess();
      return;
    }
    if (Date.now() >= reconnectDeadline) {
      giveUpReconnect();
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    scheduleNextReconnectAttempt(delay);
  }, delayMs);
}

function finishReconnectSuccess() {
  reconnecting = false;
  hideReconnectBanner();
  // The version-skew banner standard: re-fetch /version.json after every
  // successful reconnect (see docs/signaling-protocol.md, "GET /version.json").
  checkVersionSkew();
}

function giveUpReconnect() {
  reconnecting = false;
  hideReconnectBanner();
  terminalState = true;
  showOverlay({
    title: 'Connection lost',
    text: 'Lost the connection to the signaling server. Please refresh the page.',
  });
  if (chat) chat.disableInput('Connection lost.');
}

// ---------- Reconnect: reconciling room state after a successful join ----------

/**
 * After a reconnect, the server may know LESS about the room than we do
 * ourselves (if it restarted — the room was recreated empty via PUT
 * restore and is refilled as other participants also reconnect). We do
 * NOT recreate what already exists (mesh, tiles, chat) — we only
 * reconcile: peers new to us are created, those no longer in the fresh
 * list aren't removed immediately, but given a grace period (see
 * schedulePeerRemoval) in case they just haven't re-joined yet.
 */
function reconcileAfterReconnect(otherPeers, screenOwner) {
  const freshIds = new Set(otherPeers.map((p) => p.peerId));

  for (const p of otherPeers) {
    cachePairKeys(p.peerId, p.epub); // the same K_pair_meta/K_pair_sig as in joined/peer-joined (the peer's epub doesn't change during its session)
    if (peers.has(p.peerId)) {
      cancelPendingPeerRemoval(p.peerId);
    } else {
      // The name (if already known from BEFORE the drop) was preserved in
      // peerNames — the tile is created with it, not a placeholder
      // (otherwise a reconnect without the grace period for an expired
      // peer would look like it "forgot" an already-shown name).
      createRemotePeer(p.peerId, peerNames.get(p.peerId) || null, iceServersCache);
    }
  }

  for (const peerId of Array.from(peers.keys())) {
    if (!freshIds.has(peerId)) {
      schedulePeerRemoval(peerId);
    }
  }

  updateParticipantCount();
  reconcileScreenShareAfterReconnect(screenOwner);
}

/**
 * Reconcile screen-sharing state after a reconnect:
 *   - if WE ourselves were sharing before the drop (and the capture is
 *     still alive locally — mesh/getDisplayMedia don't depend on
 *     signaling) — replay share-start; the server no longer rejects for
 *     screen busyness (takeover instead of rejection — see
 *     handle_share_start), so this either gets confirmed (share-started,
 *     taking over from whoever grabbed the screen while we were offline,
 *     if needed), or, if the leader managed to revoke guestScreen — a
 *     share-rejected {reason: forbidden} arrives, in which case we
 *     correctly stop our own capture (see the share-rejected handler above);
 *   - if someone else was sharing and the server already knows about it
 *     after restarting (screenOwner arrived) — just sync the label;
 *   - if someone else was sharing, but the server doesn't know about it yet
 *     (the owner hasn't re-joined, screenOwner=null) — the stage is
 *     already alive via the mesh, we do NOT tear it down immediately, we
 *     give it the same grace period as peers;
 *   - if no one was sharing — just clear the label.
 */
function reconcileScreenShareAfterReconnect(screenOwner) {
  if (currentScreenOwnerPeerId === myPeerId && screenStream) {
    pendingShareDecision = null; // in case of a stuck resolver from a stale attempt
    signaling.send('share-start');
    return;
  }

  if (screenOwner) {
    currentScreenOwnerPeerId = screenOwner;
    if (screenOwner !== myPeerId) {
      showRemoteScreenCaption(screenOwner);
    }
    updateScreenButtonState();
  } else if (currentScreenOwnerPeerId && currentScreenOwnerPeerId !== myPeerId) {
    scheduleScreenOwnerGrace(currentScreenOwnerPeerId);
  } else {
    currentScreenOwnerPeerId = null;
    updateScreenButtonState();
  }
}

// ---------- Microphone ----------

function setMicButtonOn(on) {
  micButton.classList.toggle('control-button--on', on);
  micButton.setAttribute('aria-pressed', String(on));
}

/** "Mic off" indicator on our own tile — based on whether the current micTrack exists and is enabled. */
function updateOwnMicIndicator() {
  setTileMicOffIndicator(ownTile, !(micTrack && micTrack.enabled));
}

/**
 * Live microphone device switch WITHOUT renegotiation: a new getUserMedia
 * -> RTCRtpSender.replaceTrack on all existing connections (the spec
 * guarantees replaceTrack doesn't trigger onnegotiationneeded — receivers
 * don't see a new ontrack, the same remote track simply starts carrying
 * different content) -> stop the old track. `enabledValue` — the state
 * (enabled/disabled) the new track should get: the caller decides (for a
 * regular on-the-fly switch we keep the current state; for a deferred
 * enable after a device change while the mic was silent — whatever a
 * regular "turn on" click would have produced).
 */
async function liveSwitchMicTrack(deviceId, enabledValue) {
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (err) {
    console.warn('Failed to switch microphone:', err);
    showRoomMessage('Could not switch microphone.');
    return;
  }
  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = enabledValue;
  for (const entry of peers.values()) {
    const sender = entry.rtc.pc.getSenders().find((s) => s.track === micTrack);
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        console.warn('replaceTrack(mic) failed:', err);
      }
    }
  }
  const oldTrack = micTrack;
  micStream.removeTrack(oldTrack);
  micStream.addTrack(newTrack);
  oldTrack.stop();
  micTrack = newTrack;
  currentMicDeviceId = deviceId || null;
}

/** Device selection in the dropdown (see static/room.html: #setting-mic-device). */
async function applyMicDeviceChange(deviceId) {
  selectedMicDeviceId = deviceId || null;
  // The mic is currently actually on — switch immediately (see spec item
  // 1). Otherwise (turned off via the button or never requested yet) —
  // we've only remembered the choice, the actual switch happens on the
  // next enable (see micButton click below).
  if (!micTrack || !micTrack.enabled) return;
  await liveSwitchMicTrack(selectedMicDeviceId, true);
  updateOwnMicIndicator();
}

micButton.addEventListener('click', async () => {
  if (micRequestInProgress) return;

  if (!micTrack) {
    micRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicDeviceId ? { deviceId: { exact: selectedMicDeviceId } } : true,
      });
    } catch (err) {
      console.warn('Microphone access denied:', err);
      showRoomMessage('Could not access the microphone.');
      micRequestInProgress = false;
      return;
    }
    micRequestInProgress = false;

    micStream = stream;
    micTrack = stream.getAudioTracks()[0];
    currentMicDeviceId = selectedMicDeviceId;
    broadcastLocalStream(stream, 'mic');
    setMicButtonOn(true);
    updateOwnMicIndicator();
    refreshDeviceLists(); // permission granted — enumerateDevices now has labels
  } else {
    const turningOn = !micTrack.enabled;
    if (turningOn && selectedMicDeviceId && selectedMicDeviceId !== currentMicDeviceId) {
      // While muted, a different device was selected in settings — pick it
      // up right now, on enable (see the spec, "while disabled — remember
      // and use on next enable").
      await liveSwitchMicTrack(selectedMicDeviceId, true);
    } else {
      micTrack.enabled = turningOn;
    }
    setMicButtonOn(micTrack.enabled);
    updateOwnMicIndicator();
    broadcastStreamEnabled(micStream, 'mic', micTrack.enabled);
  }
});

// ---------- Camera ----------

function setCameraButtonOn(on) {
  cameraButton.classList.toggle('control-button--on', on);
  cameraButton.setAttribute('aria-pressed', String(on));
}

function cameraConstraintsFor(deviceId) {
  return {
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 15 },
    // deviceId and facingMode aren't needed together — a specific device is
    // already unambiguously selected; facingMode (front camera by default
    // on a phone) remains just a fallback until the user picks something themselves.
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  };
}

/** Live camera device switch WITHOUT renegotiation — see liveSwitchMicTrack, the same trick for video. */
async function liveSwitchCamTrack(deviceId, enabledValue) {
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraintsFor(deviceId) });
  } catch (err) {
    console.warn('Failed to switch camera:', err);
    showRoomMessage('Could not switch camera.');
    return;
  }
  const newTrack = newStream.getVideoTracks()[0];
  newTrack.enabled = enabledValue;
  for (const entry of peers.values()) {
    const sender = entry.rtc.pc.getSenders().find((s) => s.track === camTrack);
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        console.warn('replaceTrack(camera) failed:', err);
      }
    }
  }
  const oldTrack = camTrack;
  camStream.removeTrack(oldTrack);
  camStream.addTrack(newTrack);
  oldTrack.stop();
  camTrack = newTrack;
  currentCamDeviceId = deviceId || null;
  if (ownTile) {
    ownTile.videoEl.srcObject = camStream;
    safePlay(ownTile.videoEl);
  }
}

/** Device selection in the dropdown (see static/room.html: #setting-camera-device). */
async function applyCameraDeviceChange(deviceId) {
  selectedCamDeviceId = deviceId || null;
  if (!camTrack || !camTrack.enabled) return;
  await liveSwitchCamTrack(selectedCamDeviceId, true);
}

cameraButton.addEventListener('click', async () => {
  if (camRequestInProgress) return;

  if (!camTrack) {
    camRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraintsFor(selectedCamDeviceId) });
    } catch (err) {
      console.warn('Camera access denied:', err);
      showRoomMessage('Could not access the camera.');
      camRequestInProgress = false;
      return;
    }
    camRequestInProgress = false;

    camStream = stream;
    camTrack = stream.getVideoTracks()[0];
    currentCamDeviceId = selectedCamDeviceId;
    broadcastLocalStream(stream, 'camera');

    if (ownTile) {
      ownTile.videoEl.srcObject = stream;
      safePlay(ownTile.videoEl);
      setTileVideoVisible(ownTile, true);
    }
    setCameraButtonOn(true);
    refreshDeviceLists(); // permission granted — enumerateDevices now has labels
  } else {
    const turningOn = !camTrack.enabled;
    if (turningOn && selectedCamDeviceId && selectedCamDeviceId !== currentCamDeviceId) {
      await liveSwitchCamTrack(selectedCamDeviceId, true);
    } else {
      camTrack.enabled = turningOn;
    }
    setCameraButtonOn(camTrack.enabled);
    if (ownTile) setTileVideoVisible(ownTile, camTrack.enabled);
    broadcastStreamEnabled(camStream, 'camera', camTrack.enabled);
  }
});

// ---------- Screen (button) ----------

screenButton.addEventListener('click', async () => {
  if (screenButton.disabled) return;

  if (currentScreenOwnerPeerId === myPeerId) {
    stopScreenShare();
    return;
  }

  screenButton.disabled = true; // prevent another click while we wait for the server's decision
  const granted = await new Promise((resolve) => {
    pendingShareDecision = { resolve };
    signaling.send('share-start');
  });

  if (!granted) {
    updateScreenButtonState();
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      // Defense-in-depth alongside the placeholder in showLocalScreenPreview
      // (the main fix for the "hall of mirrors" — see its comment):
      // selfBrowserSurface removes OUR OWN tab from the capture picker
      // (doesn't help for the "whole screen" option — these are top-level
      // getDisplayMedia option fields, not video constraints; browsers
      // without support for them safely ignore them).
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    console.warn('getDisplayMedia cancelled/denied:', err);
    signaling.send('share-stop'); // release the lock we grabbed
    showRoomMessage('Screen sharing was cancelled.');
    updateScreenButtonState();
    return;
  }

  if (currentScreenOwnerPeerId !== myPeerId) {
    // A race (see docs/permissions-and-leader.md, "screen-share takeover"):
    // while we were waiting for the OS/browser's decision in
    // getDisplayMedia (a real async pause — the only window where this is
    // possible), someone else managed to send their own share-start and
    // take over the screen before us (the share-started handler above has
    // already updated currentScreenOwnerPeerId and the stage). Our capture
    // is now useless to anyone — we stop it right away, without showing
    // our own stage or touching anyone else's.
    for (const track of stream.getTracks()) track.stop();
    updateScreenButtonState();
    return;
  }

  screenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      console.log('Screen video track ended by the browser (the native "Stop sharing" bar) — stopping the share');
      stopScreenShare();
    };
  }

  broadcastLocalStream(stream, 'screen');
  showLocalScreenPreview();
  updateScreenButtonState();
});

/** Stop the local screen capture (tracks + sending to peers), without sending share-stop to the server and without touching the stage UI — used by a regular stop (stopScreenShare), by reconnect (see the share-rejected handler in registerSignalingHandlers), and by a screen-share takeover from another participant (see the share-started handler there too). */
function forceStopLocalScreenCapture() {
  if (!screenStream) return;
  removeLocalStreamFromAllPeers(screenStream);
  for (const track of screenStream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  screenStream = null;
}

function stopScreenShare() {
  if (!screenStream) return;
  forceStopLocalScreenCapture();
  signaling.send('share-stop');
  hideScreenStage();
  currentScreenOwnerPeerId = null;
  updateScreenButtonState();
}

// ---------- Fullscreen for the screen-share stage ----------
//
// The Fullscreen API in modern Chrome/Safari doesn't require a webkit
// prefix on desktop, but iOS Safari (even current versions as of writing —
// see caniyouse.com/fullscreen) doesn't support requestFullscreen() on an
// arbitrary element as reliably everywhere as webkitRequestFullscreen —
// so we try the standard method first and fall back to the webkit version
// as an iOS fallback. The same trick for exitFullscreen/fullscreenElement.
function requestFullscreenCompat(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error('Fullscreen API is not available'));
  return fn.call(el);
}

function exitFullscreenCompat() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (!fn) return Promise.resolve();
  return fn.call(document);
}

function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Besides the usual aria-pressed/title reflecting the actual Fullscreen
 * API state, hides and disables the button when I'm currently sharing my
 * own screen — there's no point fullscreening our own static "You are
 * sharing your screen" placeholder (see showLocalScreenPreview), there's no
 * live video there. Recomputed from
 * showLocalScreenPreview/showRemoteScreenCaption/hideScreenStage (stage
 * ownership may have changed, including via a takeover) and normally on fullscreenchange.
 */
function updateFullscreenButtonState() {
  const selfSharing = currentScreenOwnerPeerId === myPeerId;
  screenFullscreenButtonEl.classList.toggle('hidden', selfSharing);
  screenFullscreenButtonEl.disabled = selfSharing;
  if (selfSharing) {
    screenFullscreenButtonEl.title = 'Not available while sharing your own screen';
    screenFullscreenButtonEl.setAttribute('aria-label', screenFullscreenButtonEl.title);
    return;
  }
  const active = isFullscreenActive();
  screenFullscreenButtonEl.setAttribute('aria-pressed', String(active));
  screenFullscreenButtonEl.title = active ? 'Exit fullscreen' : 'Fullscreen';
  screenFullscreenButtonEl.setAttribute('aria-label', screenFullscreenButtonEl.title);
}

screenFullscreenButtonEl.addEventListener('click', async () => {
  try {
    if (isFullscreenActive()) {
      await exitFullscreenCompat();
    } else {
      await requestFullscreenCompat(screenStageEl);
    }
  } catch (err) {
    // Fullscreen may be unavailable (headless browser, environment
    // restriction, etc.) — don't break the rest of the UI, just log it.
    console.warn('Fullscreen unavailable:', err);
  }
});

document.addEventListener('fullscreenchange', updateFullscreenButtonState);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);

// ---------- Share (popup with QR + link) ----------

/** Copy text to the clipboard, with a fallback for environments without the Clipboard API. */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const tmpInput = document.createElement('input');
      tmpInput.value = text;
      tmpInput.style.position = 'fixed';
      tmpInput.style.opacity = '0';
      document.body.appendChild(tmpInput);
      tmpInput.focus();
      tmpInput.select();
      tmpInput.setSelectionRange(0, text.length);
      const success = document.execCommand('copy');
      tmpInput.remove();
      return success;
    } catch (execErr) {
      console.error('Failed to copy the link:', execErr);
      return false;
    }
  }
}

function onSharePopupKeydown(event) {
  if (event.key === 'Escape') closeSharePopup();
}

/**
 * The "Share" link (E2E v2): rebuilt FROM SCRATCH from location.pathname +
 * the token/expiry remembered when the page started (linkTokenBase64url/
 * linkExpiry, see top of file) — NOT from location.href, because
 * leaderToken would never be there anyway (it's one-time and only for the
 * creator). Shape: `<origin>/r/<id>#t=<token>&e=<expiry>&n=<name>` — WITHOUT
 * lt. `n` is added only if the room name is known (initialRoomName) — this
 * way the room name travels in the invite link and becomes visible to
 * everyone who follows it (see the initialRoomName render and the fragment
 * parsing above); the server still won't see this name — the fragment
 * never goes to the server. Everyone who joins via this link authenticates
 * with the SAME `t`/`e` (as before with `k`), but each derives THEIR OWN
 * pairwise keys (see static/crypto.js).
 */
function buildShareLink() {
  const namePart = initialRoomName ? `&n=${encodeURIComponent(initialRoomName)}` : '';
  return `${location.origin}${location.pathname}#t=${linkTokenBase64url}&e=${linkExpiry}${namePart}`;
}

/**
 * Render the QR code LOCALLY in the browser (see static/vendor/qrcode.js —
 * kazuhikoarase/qrcode-generator, MIT) instead of going to the server: the
 * room link carries secret `#t`/`#e` and shouldn't leave the tab just for
 * an image. `qrcode(0, 'M')` — typeNumber=0 means auto-selecting the QR
 * version based on text length, 'M' is the standard error-correction
 * level. createSvgTag builds SVG from plain numeric coordinates (the link
 * text itself doesn't end up in the markup as HTML) — safe to insert via innerHTML.
 */
function renderShareQr(text) {
  sharePopupQrEl.textContent = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    sharePopupQrEl.innerHTML = qr.createSvgTag(4, 12);
  } catch (err) {
    console.error('Failed to build the room QR code:', err);
  }
}

function openSharePopup() {
  const link = buildShareLink();
  renderShareQr(link);
  sharePopupLinkEl.textContent = link;
  renderShareBuildLine(); // doesn't block opening — if the hash hasn't arrived yet, fetchBuildHashOnce().then() above will update the line itself once it does
  sharePopupEl.classList.remove('hidden');
  document.addEventListener('keydown', onSharePopupKeydown);
}

function closeSharePopup() {
  sharePopupEl.classList.add('hidden');
  document.removeEventListener('keydown', onSharePopupKeydown);
}

shareButton.addEventListener('click', openSharePopup);
inviteCtaButtonEl.addEventListener('click', openSharePopup);
sharePopupCloseEl.addEventListener('click', closeSharePopup);
sharePopupBackdropEl.addEventListener('click', closeSharePopup);

sharePopupCopyButtonEl.addEventListener('click', async () => {
  const success = await copyTextToClipboard(buildShareLink());
  if (success) {
    const original = sharePopupCopyButtonEl.textContent;
    sharePopupCopyButtonEl.textContent = 'Copied';
    setTimeout(() => {
      sharePopupCopyButtonEl.textContent = original;
    }, 1500);
  }
});

// ---------- Leave room ----------

// The tab is closing/navigating away (the X button, navigation, reload) —
// the WS will drop on its own in a moment, but this is NOT a signaling
// drop that needs fixing: the page is disappearing anyway, a reconnect
// cycle (even a single attempt that manages to start) at this point would
// only extend the room's lifetime on the server with a redundant
// join-room from a dying tab. `pagehide` fires earlier than the actual
// connection drop on close/navigation/reload — we manage to set the flag
// before onClose.
window.addEventListener('pagehide', () => {
  intentionalDisconnect = true;
});

leaveButton.addEventListener('click', () => {
  // An intentional exit — the socket closure that follows must NOT
  // trigger auto-reconnect (see signaling.onClose in init()).
  intentionalDisconnect = true;
  if (signaling) {
    signaling.send('leave');
  }
  location.href = '/';
});

init();
