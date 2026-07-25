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
// `n` — the room name. Unlike `t`/`e` this one is NOT chosen once and
// frozen at creation time: it's chosen by the CREATOR on the pre-join
// screen INSIDE the room itself (see showPrejoinCard/onPrejoinSubmit,
// static/namegen.js) — landing.js no longer asks for it at all, and on the
// very first load the creator's own fragment never carries an `n` (there's
// nothing to parse yet). Once the creator submits the pre-join card we set
// `currentRoomName` ourselves and push `#t=...&e=...&n=...` via
// history.replaceState (see writeRoomNameToFragment) — from that moment on
// it behaves exactly like it always did for a GUEST: PART of the invite
// link (buildShareLink puts it there) and stays in the address bar for
// everyone who joins via that link, surviving F5. The key invariant is
// unchanged: the server never sees the fragment (it never travels over the
// network), so the room name remains unknown to the server too. Malformed
// percent-encoding (e.g. from manually editing the URL) must not crash the
// page — decodeURIComponent is wrapped in try/catch, and on error the name
// is simply absent (null).
//
// `currentRoomName` is deliberately a mutable `let`, assigned from inside
// the IIFE below (closure) rather than being one of the IIFE's returned,
// `const`-bound fields like the other three — it's the one piece of this
// bundle that legitimately changes later in the tab's life (see
// writeRoomNameToFragment).
let currentRoomName;
const { initialLeaderToken, linkTokenBase64url, linkExpiry } = (() => {
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
  currentRoomName = n;
  return { initialLeaderToken: lt, linkTokenBase64url: t, linkExpiry: e };
})();

// --- Local render of the room name (visible to ALL participants who joined
// via an invite link with `n`, and to the creator right after they submit
// the pre-join card — see comment above) — the initial call below happens
// IMMEDIATELY, before init(), so the tab title and header don't flash the
// default text; onPrejoinSubmit calls it again once the creator has chosen
// a name. If there's no name yet (a fresh creator load, or a link with no
// `n`), .room-logo/title just stay at their defaults.
function renderRoomNameChrome() {
  if (!currentRoomName) return;
  document.title = `${currentRoomName} — video call`;
  const roomLogoEl = document.querySelector('.room-logo');
  if (roomLogoEl) roomLogoEl.textContent = currentRoomName;
}
renderRoomNameChrome();

// --- DOM ---
const joinModalEl = document.getElementById('join-modal');
const joinNameInputEl = document.getElementById('join-name-input');
const joinNameRegenButtonEl = document.getElementById('join-name-regen-button');
const joinModalButtonEl = document.getElementById('join-modal-button');

// --- DOM: pre-join card (see the "Pre-join card" section far below —
// showPrejoinCard/onPrejoinSubmit) — one card, shared markup for both the
// creator ("Start the room") and a guest ("Join the room"), see
// static/room.html for the full structure. ---
const prejoinEyebrowEl = document.getElementById('prejoin-eyebrow');
const prejoinRoomNameEditableEl = document.getElementById('prejoin-room-name-editable');
const prejoinRoomNameInputEl = document.getElementById('prejoin-room-name-input');
const prejoinRoomNameRegenEl = document.getElementById('prejoin-room-name-regen');
const prejoinRoomNameStaticEl = document.getElementById('prejoin-room-name-static');
const prejoinRoomTitleEl = document.getElementById('prejoin-room-title');
const prejoinRoomMetaEl = document.getElementById('prejoin-room-meta');
const prejoinRoomMetaTextEl = document.getElementById('prejoin-room-meta-text');
const prejoinPreviewVideoEl = document.getElementById('prejoin-preview-video');
const prejoinPreviewPlaceholderEl = document.getElementById('prejoin-preview-placeholder');
const prejoinAvatarEl = document.getElementById('prejoin-avatar');
const prejoinAvatarLetterEl = document.getElementById('prejoin-avatar-letter');
const prejoinPreviewPillTextEl = document.getElementById('prejoin-preview-pill-text');
const prejoinMicRowEl = document.getElementById('prejoin-mic-row');
const prejoinMicSelectEl = document.getElementById('prejoin-mic-select');
const prejoinCamRowEl = document.getElementById('prejoin-cam-row');
const prejoinCamSelectEl = document.getElementById('prejoin-cam-select');
const prejoinNameFieldEl = document.getElementById('prejoin-name-field');
// --- DOM: pre-join card, lobby "waiting for approval" sub-state (see
// setPrejoinWaitingMode/signaling.on('waiting') in the "Pre-join card"
// section far below) ---
const prejoinWaitingEl = document.getElementById('prejoin-waiting');
const prejoinWaitingTextEl = document.getElementById('prejoin-waiting-text');
const prejoinWaitingCancelEl = document.getElementById('prejoin-waiting-cancel');
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
const sharePopupRoomNameEl = document.getElementById('share-popup-room-name');
const sharePopupCopyButtonEl = document.getElementById('share-popup-copy-button');
const sharePopupShareButtonEl = document.getElementById('share-popup-share-button');
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

// Web Share API (see openSharePopup/the "Share" click handler far below) —
// present on most mobile browsers and Safari, absent on most desktop
// Chromium/Firefox as of this writing. Same reasoning as screenShareSupported
// above: feature-detected ONCE at startup (the capability can't change
// during a page's lifetime) and gated on the button's very EXISTENCE in the
// DOM (hidden via a class), not just left enabled-but-broken — there's
// nothing to explain to the user about a button that isn't there. Where it
// exists, Share is the PRIMARY (accent) action in the popup and Copy
// becomes secondary next to it — a native share sheet (Messages/WhatsApp/
// AirDrop/...) is usually the fastest way to actually reach someone; where
// it doesn't, Copy alone remains the (full-width) primary action. See
// static/style.css: .share-popup-action-button(--primary|--secondary).
const shareApiSupported = typeof navigator.share === 'function';
if (shareApiSupported) {
  sharePopupShareButtonEl.classList.remove('hidden');
  sharePopupShareButtonEl.classList.add('share-popup-action-button--primary');
  sharePopupCopyButtonEl.classList.add('share-popup-action-button--secondary');
} else {
  sharePopupCopyButtonEl.classList.add('share-popup-action-button--primary');
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
  // #join-modal (the pre-join card) is visible BY DEFAULT (in room.html
  // markup it has no .hidden class — only JS hides/shows it, see
  // showPrejoinCard/hidePrejoinCard below) and its z-index is HIGHER than
  // #overlay's (see static/style.css) — if it isn't explicitly hidden
  // here, it would stay on top of this overlay (and technically clickable)
  // in the "token is invalid even before entry" scenario, when
  // showPrejoinCard() never had a chance to run.
  hidePrejoinCard();
  showOverlay({
    title: 'Link is invalid',
    text: 'Ask a room participant for a new link.',
    actionLabel: 'Go home',
  });
}

/** Terminal "link expired" overlay — `e` from the fragment is in the past (with the LINK_EXPIRY_GRACE_SECONDS margin), see initCryptoIdentity. Kept separate from showInvalidLinkOverlay: the message is more honest ("this link WAS working, but has expired", rather than "the link is broken"). */
function showLinkExpiredOverlay() {
  terminalState = true;
  hidePrejoinCard();
  showOverlay({
    title: 'Link expired',
    text: 'Ask for a fresh link.',
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
 * The avatar circle's gradient CSS, derived from a peerId (see
 * hueFromPeerId above) — factored out of createTile so the pre-join
 * preview (see showPrejoinCard in the "Pre-join card" section) can paint
 * the EXACT same gradient for our own avatar before we've even joined:
 * myPeerId is generated in initCryptoIdentity, before the pre-join card is
 * shown, and (per the comment on signaling.on('joined')) is "almost
 * always" the very peerId createTile later receives — so the preview and
 * the real own tile end up visually identical without coordinating on
 * anything beyond sharing this one function.
 */
function avatarGradientCss(peerId) {
  const hue = hueFromPeerId(peerId);
  return `linear-gradient(135deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 45) % 360}, 70%, 32%))`;
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
  if (!isEmojiGrapheme(grapheme)) return trimmedName;
  const rest = trimmedName.slice(grapheme.length).trim();
  return rest || trimmedName;
}

/**
 * Whether a grapheme cluster (see firstGraphemeOf above) is an emoji rather
 * than a regular letter — \p{Extended_Pictographic} is the same reliable
 * check used above in stripLeadingAvatarEmoji, factored out here because a
 * second caller needs it: the avatar circle's glyph class (see createTile/
 * updatePeerTileName below, and static/style.css:
 * .tile-placeholder-letter--emoji). Letters and emoji need different
 * font-sizing to look equally "full" inside the circle — a capital
 * letter's cap-height is noticeably shorter than its own font-size (its em
 * box), while a color emoji's glyph fills nearly the whole em box — so the
 * circle needs to know which kind of glyph it's showing.
 */
function isEmojiGrapheme(grapheme) {
  return !!grapheme && /\p{Extended_Pictographic}/u.test(grapheme);
}

/**
 * Name to display in the tile's name pill (the SAME pill element visible
 * both during video and over the avatar placeholder, see createTile) — the
 * avatar/name rule: while `videoVisible` is true the avatar circle (which
 * carries the name's first grapheme as its big glyph, see createTile/
 * updatePeerTileName) is off screen, so the pill shows the FULL name,
 * leading emoji included; while it's false the circle IS on screen, so the
 * pill strips that same leading emoji (via stripLeadingAvatarEmoji) to avoid
 * showing it twice. Falls back to the "Guest" placeholder for an empty name
 * regardless of videoVisible. Recomputed whenever either input changes —
 * see setTileVideoVisible (video visibility flips), updatePeerTileName/
 * updateOwnTileLabel (the name itself changes), and, on the pre-join card,
 * updatePrejoinNamePill (camera toggles) — this function itself is stateless.
 */
function tileDisplayName(trimmedName, grapheme, videoVisible) {
  if (!trimmedName) return 'Guest';
  return videoVisible ? trimmedName : stripLeadingAvatarEmoji(trimmedName, grapheme);
}

// ---------- Tile grid layout: aspect-ratio-aware packing ("justified rows") ----------
//
// The room is limited to 6 participants by default (see
// knownServerMaxParticipants above), which is what makes the approach below
// affordable: instead of a fixed column/row count per tileCount (the OLD
// computeTileGridColumns/computeFixedTileLayout — see git history — which
// forced every tile into the same 16:9 box regardless of what it actually
// showed), the grid is now packed by BRUTE-FORCE SEARCH over candidate
// layouts, scored by how much of the stage they cover with USEFUL content
// (a video's own intrinsic aspect, or a flexible range for a no-video
// placeholder) while still looking tidy. n<=6 keeps the full search cheap —
// see partitionsIntoRows for the exact candidate count (a few hundred at
// most), redone on every layout pass rather than cached.
//
// The algorithm ("justified rows", the same family used by photo-gallery
// grids):
//   1. Every tile contributes an aspect (tileAspectDescriptor): a tile
//      showing video uses the VIDEO's own videoWidth/videoHeight (falling
//      back to 16:9 until loadedmetadata fires — see the listeners in
//      createTile); a tile on its no-video placeholder (avatar + name, which
//      visually adapts to any reasonable box) is marked `flexible` and can
//      be resolved to any aspect in [1.0, 1.9] by the packer itself.
//   2. Candidates = every row count 1..n, crossed with every CONTIGUOUS way
//      to split the (possibly reordered) tile list into that many rows
//      (partitionsIntoRows), crossed with a handful of orderings
//      (orderPackerIndices: original DOM order; ascending/descending by
//      aspect; portraits grouped first) — trying a sorted order lets the
//      search discover partitions that keep visually similar tiles in the
//      same row, at the cost of possibly reshuffling participants on
//      screen, which is why a small stability bonus favors the original
//      order in the final score (see scorePackerCandidate).
//   3. Each candidate is sized in TWO variants, both scored, best kept:
//      - "justified" (photo-gallery style, evaluatePackerCandidate): every
//        row is stretched to the FULL available width — row height
//        h_j = availWidth / sum(aspects in row) — with flexible tiles
//        resolving their aspect toward the per-row share of the height
//        budget ((availHeight - gaps) / rowCount; this both equalizes rows
//        AND lets placeholder-heavy layouts actually use the stage height —
//        see resolveFlexibleRowAspects for the underfill bug an earlier
//        ideal-aspect-mean target caused). If the rows' total (plus gaps)
//        would exceed the available height, EVERY row is scaled down
//        UNIFORMLY (never up — a bigger scale would blow row width past
//        what's available, since rows are already justified to fill it).
//      - "equal-height" (evaluateEqualRowsCandidate): all rows share ONE
//        height — the smallest of the per-row justified heights, capped at
//        the per-row height budget — and rows are NOT stretched to full
//        width; narrower rows are simply centered. This is what rescues
//        identical-aspect tiles in uneven partitions (e.g. 3 cameras as
//        2+1): justified rows would give the lone tile ~2x the pair's area
//        (rejected by the fairness constraint in step 4), collapsing such
//        tile counts into a single sliver-height row, while equal heights
//        keep every tile the same size at a far better fill.
//      Either way the resulting block, possibly short of the full
//      width/height, is centered on both axes (pixelizePackedLayout).
//   4. Candidates are scored by filled-area fraction of the stage, MINUS
//      aesthetic penalties (row-height variance, a starved-looking last row,
//      tiles below a readable minimum size, extreme width contrast between
//      neighbors sharing a row, a fuller row hanging below an emptier one) —
//      see scorePackerCandidate for the exact formula. A hard-ish constraint
//      (heavy penalty, not outright rejection, so a fallback always exists)
//      keeps every tile's area within ±30% of the candidate's mean tile
//      area, per spec.
//
// Verified independently of the DOM by a throwaway node script during
// development (see the task this shipped under) — the block below, from
// `combinations` through `applySoloAreaCap`, touches no DOM API and can be
// pasted into (or required by, via a small source-extraction shim) a plain
// node script to exercise the math directly.

const FALLBACK_VIDEO_ASPECT = 16 / 9; // used until a video's loadedmetadata fires (see createTile) — matches the old fixed layout's default so early frames don't look wildly different
const FLEXIBLE_TILE_ASPECT_MIN = 1.0; // no-video placeholder tiles (avatar + name) can be packed at any aspect in this range — the content itself doesn't dictate one
const FLEXIBLE_TILE_ASPECT_MAX = 1.9;
const FLEXIBLE_TILE_ASPECT_IDEAL = 4 / 3; // representative aspect for the ordering heuristics (orderPackerIndices) and the pre-resolution descriptor default only — the aspect actually PACKED is resolved per row, see resolveFlexibleRowAspects
const TILE_AREA_TOLERANCE = 0.3; // hard-ish constraint (spec item 2): no tile's area may deviate from the candidate's mean tile area by more than this fraction
const MIN_READABLE_TILE_WIDTH_PX = 110;
const MIN_READABLE_TILE_HEIGHT_PX = 80;
const SOLO_MAX_AREA_FRACTION = 0.5; // see applySoloAreaCap
const PACKER_ORDERINGS = ['original', 'ascending', 'descending', 'portrait-first'];

/** All k-combinations of `pool`, each returned as an ascending-order subset — the building block for partitionsIntoRows below. */
function combinations(pool, k) {
  const result = [];
  const combo = [];
  function recurse(start) {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < pool.length; i++) {
      combo.push(pool[i]);
      recurse(i + 1);
      combo.pop();
    }
  }
  recurse(0);
  return result;
}

/**
 * Every way to split `n` items (in whatever order they're given — the
 * caller applies an ordering first, see orderPackerIndices) into exactly
 * `rows` CONTIGUOUS, non-empty groups — e.g. n=4, rows=2 -> [[1,3], [2,2],
 * [3,1]] (sizes of each row, left to right). This is "stars and bars":
 * choosing rows-1 cut points among the n-1 gaps between items. With n
 * capped at 6 (knownServerMaxParticipants) the total across all row counts
 * is C(5,0)+C(5,1)+...+C(5,5) = 32 partitions per ordering — trivial to
 * evaluate all of, many times a second if needed.
 */
function partitionsIntoRows(n, rows) {
  if (rows <= 0 || rows > n || n <= 0) return [];
  if (rows === 1) return [[n]];
  const gapPositions = [];
  for (let i = 1; i < n; i++) gapPositions.push(i);
  return combinations(gapPositions, rows - 1).map((cuts) => {
    const sizes = [];
    let prev = 0;
    for (const cut of cuts) {
      sizes.push(cut - prev);
      prev = cut;
    }
    sizes.push(n - prev);
    return sizes;
  });
}

/**
 * One permutation of tile indices to try partitioning into rows (see
 * partitionsIntoRows) — 'original' keeps the current DOM/participant order
 * (checked first, and the only one eligible for the stability bonus in
 * scorePackerCandidate); the others group visually-similar aspects together
 * so the search can find partitions that keep a row's tiles from clashing.
 * Flexible (placeholder) tiles are ranked by their IDEAL aspect for sorting
 * purposes only — their real aspect is resolved per-row later.
 */
function orderPackerIndices(descriptors, orderingName) {
  const idx = descriptors.map((_, i) => i);
  const repAspect = (i) => (descriptors[i].flexible ? FLEXIBLE_TILE_ASPECT_IDEAL : descriptors[i].aspect);
  switch (orderingName) {
    case 'ascending':
      return idx.slice().sort((a, b) => repAspect(a) - repAspect(b));
    case 'descending':
      return idx.slice().sort((a, b) => repAspect(b) - repAspect(a));
    case 'portrait-first': {
      // A STABLE partition (not a sort): portrait-ish tiles (aspect < 1)
      // keep their original relative order, moved ahead of everything else.
      // Mixing one narrow portrait tile into an otherwise-landscape row
      // forces the WHOLE row to that tile's height (row height = width /
      // sum-of-aspects, and a small aspect in the sum inflates 1/sum) —
      // exactly the "extreme neighbor contrast" scorePackerCandidate's
      // contrastPenalty frowns on. Trying this order gives the search a
      // shot at a partition that puts portraits in a row of their own.
      const portraits = idx.filter((i) => repAspect(i) < 1);
      const rest = idx.filter((i) => repAspect(i) >= 1);
      return portraits.concat(rest);
    }
    case 'original':
    default:
      return idx;
  }
}

/** Slice an ordered index list into row groups of the given sizes (see partitionsIntoRows). */
function buildRowGroups(order, rowSizes) {
  const rows = [];
  let pos = 0;
  for (const size of rowSizes) {
    rows.push(order.slice(pos, pos + size));
    pos += size;
  }
  return rows;
}

/**
 * Spec item 2 ("flexible tiles resolve their aspect within their range to
 * help the row fit"): pick the aspect for every flexible tile in this row
 * that would make the row's height, once justified to availWidth, equal
 * `targetHeight` — clamped to [FLEXIBLE_TILE_ASPECT_MIN,
 * FLEXIBLE_TILE_ASPECT_MAX]. The needed adjustment is split evenly across
 * however many flexible tiles share the row; fixed-aspect (video) tiles are
 * never touched. Returns { aspects: Map<origIdx, aspect>, height } — height
 * is the row's ACTUAL resulting height (justified to full width), equal to
 * targetHeight only if no clamping was needed.
 *
 * The caller picks the target. The justified variant
 * (evaluatePackerCandidate) passes the per-row share of the height budget,
 * (availHeight - gaps) / rowCount — NOT the row's height at the
 * placeholders' "ideal" 4/3 aspect, as an earlier version did: steering
 * toward the ideal meant an all-placeholder row never grew taller than its
 * ideal-aspect height no matter how much unused stage height remained below
 * (found by the scenario script: 3 placeholders on a 1200x700 stage packed
 * as a single 292px-tall row, 40.6% fill, when the same row at aspect 1.0
 * reaches 54% and a 2+1 equal-height split 75%). Targeting the height
 * budget serves both goals at once: every row steers toward the SAME height
 * (uniformity), and that height is the largest the stage can actually
 * accommodate (fill). The equal-height variant (evaluateEqualRowsCandidate)
 * passes its common row height instead — see the no-overflow argument
 * there.
 */
function resolveFlexibleRowAspects(rowIndices, descriptors, availWidth, gapPx, targetHeight) {
  const usableWidth = availWidth - gapPx * (rowIndices.length - 1);
  const fixedIdx = rowIndices.filter((i) => !descriptors[i].flexible);
  const flexIdx = rowIndices.filter((i) => descriptors[i].flexible);
  const fixedAspectSum = fixedIdx.reduce((sum, i) => sum + descriptors[i].aspect, 0);

  let flexAspect = FLEXIBLE_TILE_ASPECT_IDEAL;
  if (flexIdx.length > 0 && targetHeight > 0 && usableWidth > 0) {
    const neededAspectSum = usableWidth / targetHeight;
    const neededFlexAspectEach = (neededAspectSum - fixedAspectSum) / flexIdx.length;
    flexAspect = Math.min(FLEXIBLE_TILE_ASPECT_MAX, Math.max(FLEXIBLE_TILE_ASPECT_MIN, neededFlexAspectEach));
  }

  const aspects = new Map();
  for (const i of fixedIdx) aspects.set(i, descriptors[i].aspect);
  for (const i of flexIdx) aspects.set(i, flexAspect);

  const sumAspect = rowIndices.reduce((sum, i) => sum + aspects.get(i), 0);
  const height = usableWidth > 0 && sumAspect > 0 ? usableWidth / sumAspect : 0;
  return { aspects, height };
}

/**
 * Evaluate one (ordering, row-partition) pair in the JUSTIFIED variant (see
 * step 3 of the big comment above): every row is stretched to the full
 * available width, with flexible tiles resolved toward the per-row share of
 * the height budget; all rows are scaled down UNIFORMLY if their natural
 * total exceeds availHeight (never up — see that comment for why). Returns
 * null for candidates that can't produce a usable geometry at all (e.g.
 * more rows than the available height can fit even at a single px each)
 * rather than a broken/negative layout. The `variant` tag on the result is
 * purely for debuggability (the scenario script prints which variant won) —
 * nothing downstream branches on it.
 */
function evaluatePackerCandidate(descriptors, order, rowSizes, availWidth, availHeight, gapPx) {
  const rows = buildRowGroups(order, rowSizes);
  const rowGapTotal = gapPx * (rows.length - 1);
  const availableForRows = availHeight - rowGapTotal;
  if (availableForRows <= 0) return null;
  const targetHeight = availableForRows / rows.length;

  const resolvedRows = rows.map((row) => resolveFlexibleRowAspects(row, descriptors, availWidth, gapPx, targetHeight));
  const preScaleRowHeights = resolvedRows.map((r) => r.height);
  if (preScaleRowHeights.some((h) => !(h > 0))) return null;

  const preScaleBlockHeight = preScaleRowHeights.reduce((a, b) => a + b, 0) + rowGapTotal;
  const scale = preScaleBlockHeight > availHeight ? availableForRows / (preScaleBlockHeight - rowGapTotal) : 1;
  if (!(scale > 0)) return null;

  const rowHeights = preScaleRowHeights.map((h) => h * scale);
  const tiles = new Array(descriptors.length);
  rows.forEach((rowIndices, j) => {
    const { aspects } = resolvedRows[j];
    const height = rowHeights[j];
    for (const origIdx of rowIndices) {
      const aspect = aspects.get(origIdx);
      tiles[origIdx] = { width: height * aspect, height, aspect };
    }
  });

  return { rows, rowHeights, tiles, variant: 'justified' };
}

/**
 * Evaluate the same (ordering, row-partition) pair in the EQUAL-HEIGHT
 * variant (see step 3 of the big comment above): every row gets the SAME
 * height — the smallest of the per-row justified heights, capped at the
 * per-row share of the height budget — and a row whose aspects don't fill
 * availWidth at that height stays NARROWER (pixelizePackedLayout centers
 * it) instead of being stretched. Exists because the justified variant
 * structurally CANNOT give identical-aspect tiles equal areas in an uneven
 * partition (row height is width / sum-of-aspects, so the row with fewer
 * tiles is always taller), which made the ±30% fairness constraint reject
 * every multi-row candidate for e.g. 3 or 5 equal cameras and collapse them
 * into one sliver-height full-width row — found by the scenario script
 * (3x16:9 on 1200x700: 31.5% fill justified-only vs ~70% as an equal-height
 * 2+1).
 *
 * Flexible tiles resolve against the common height exactly as in the
 * justified variant. Width overflow can't happen by construction: the
 * common height never exceeds any row's own probe (justified) height, and a
 * LOWER height means resolveFlexibleRowAspects asks flexible tiles to be
 * WIDER than the probe did — so its MIN clamp can't engage any harder than
 * it already did in the probe; an unclamped resolution lands the row at
 * exactly availWidth, and the MAX clamp only makes it narrower. Vertically,
 * rows * height + gaps <= availHeight because height <= availableForRows /
 * rowCount — so no post-scaling pass is needed at all.
 */
function evaluateEqualRowsCandidate(descriptors, order, rowSizes, availWidth, availHeight, gapPx) {
  const rows = buildRowGroups(order, rowSizes);
  const rowGapTotal = gapPx * (rows.length - 1);
  const availableForRows = availHeight - rowGapTotal;
  if (availableForRows <= 0) return null;
  const budget = availableForRows / rows.length;

  const probe = rows.map((row) => resolveFlexibleRowAspects(row, descriptors, availWidth, gapPx, budget));
  const probeHeights = probe.map((r) => r.height);
  if (probeHeights.some((h) => !(h > 0))) return null;
  const height = Math.min(budget, ...probeHeights);
  if (!(height > 0)) return null;

  const resolvedRows = rows.map((row) => resolveFlexibleRowAspects(row, descriptors, availWidth, gapPx, height));
  const tiles = new Array(descriptors.length);
  rows.forEach((rowIndices, j) => {
    const { aspects } = resolvedRows[j];
    for (const origIdx of rowIndices) {
      const aspect = aspects.get(origIdx);
      tiles[origIdx] = { width: height * aspect, height, aspect };
    }
  });

  return { rows, rowHeights: rows.map(() => height), tiles, variant: 'equal-height' };
}

/**
 * Turn a candidate's geometry into one comparable number (spec item 2).
 * fillRatio (covering the stage) is the PRIMARY objective and lives in
 * [0, 1]; every other term is a subtracted penalty, weighted so that,
 * short of a pathological layout, they stay well under fillRatio's dynamic
 * range — aesthetics are meant to break ties among comparably-filled
 * candidates, not veto a large fill advantage. An earlier version of this
 * scorer summed EVERY penalty (including the area-tolerance one) as a raw,
 * unnormalized total with much larger weights, which — found by the
 * throwaway node verification script this shipped with, on 6 tiles mixing
 * very different aspects (16:9/9:16/4:3/1:1) — could make the search prefer
 * a lopsided partition covering just ~13% of the stage over one covering
 * ~93%, purely because the 13% one happened to dodge more of the aesthetic
 * penalties; exactly backwards from "maximize coverage, then tidy it up."
 *
 * The ±30% mean-tile-area rule (areaExcess below) is handled DIFFERENTLY
 * from the rest, because spec item 2 calls it out as a hard constraint
 * rather than an aesthetic nice-to-have: it's driven by the WORST single
 * tile's deviation, not an average across tiles — an average dilutes as n
 * grows, which is the opposite of what a fairness constraint should do
 * (one participant's tile ending up 2x+ another's for no reason other than
 * incidental row grouping is exactly the "favoritism" it exists to
 * prevent). Its weight (1.5) is the largest in the formula but deliberately
 * NOT overwhelming, and both halves of that are scenario-script findings:
 * - Large enough: unfair candidates must lose whenever a fair alternative
 *   exists at comparable fill. Since the equal-height variant
 *   (evaluateEqualRowsCandidate) was added, such an alternative exists
 *   with ZERO deviation for the worst offenders (identical-aspect cameras
 *   at odd counts, where every uneven JUSTIFIED partition deviates
 *   50-140%), trailing the unfair candidates by well under 0.2 in
 *   fillRatio — so even a modest weight settles those decisively.
 * - Not overwhelming: when the aspect mix makes the constraint IMPOSSIBLE
 *   to satisfy (a 9:16 sharing a row height with a 16:9 is a >3x area
 *   ratio by construction; NO partition of 5 wildly-mixed tiles on a
 *   phone stage stays within 30%), a RELATIVE penalty starts rewarding
 *   layouts that simply shrink everyone: deviation is a ratio, so a
 *   low-fill layout can be "fairer" while handing every participant —
 *   including the worst-off one it's nominally protecting — a smaller
 *   tile in absolute px. An earlier weight of 3 did exactly that on the
 *   5-tiles-on-a-phone scenario: it chose 34.8% fill over 64% to shave
 *   the worst relative deviation from 0.27 to 0.12, and the "protected"
 *   portrait tile came out SMALLER (79px wide vs 91px). 1.5 keeps the
 *   fair-when-possible behavior with a wide margin in the cases above,
 *   without letting unavoidable violations starve the whole layout.
 */
function scorePackerCandidate(candidate, availWidth, availHeight, isOriginalOrder) {
  const { rows, rowHeights, tiles } = candidate;
  const n = tiles.length;
  const stageArea = availWidth * availHeight;
  const filledArea = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
  const fillRatio = stageArea > 0 ? filledArea / stageArea : 0;

  const meanArea = filledArea / n;
  let maxAreaDeviation = 0;
  for (const t of tiles) {
    const deviation = Math.abs((t.width * t.height) / meanArea - 1);
    if (deviation > maxAreaDeviation) maxAreaDeviation = deviation;
  }
  const areaExcess = Math.max(0, maxAreaDeviation - TILE_AREA_TOLERANCE);

  const meanRowHeight = rowHeights.reduce((a, b) => a + b, 0) / rowHeights.length;
  const rowHeightVariance = rowHeights.reduce((sum, h) => sum + (h - meanRowHeight) ** 2, 0) / rowHeights.length;
  const rowHeightCv = meanRowHeight > 0 ? Math.sqrt(rowHeightVariance) / meanRowHeight : 0;

  // A last row noticeably SHORTER than the rest reads as "ran out of
  // participants," which looks unfinished in a way that a merely
  // taller-than-average row doesn't (that's already covered by the
  // variance term above) — see spec item 2's "last row dramatically
  // emptier" aesthetic penalty.
  let lastRowEmptinessPenalty = 0;
  if (rowHeights.length > 1) {
    const last = rowHeights[rowHeights.length - 1];
    const othersMean = rowHeights.slice(0, -1).reduce((a, b) => a + b, 0) / (rowHeights.length - 1);
    if (othersMean > 0 && last < othersMean) lastRowEmptinessPenalty = 1 - last / othersMean;
  }

  let minSizePenalty = 0;
  for (const t of tiles) {
    if (t.width < MIN_READABLE_TILE_WIDTH_PX) minSizePenalty += (MIN_READABLE_TILE_WIDTH_PX - t.width) / MIN_READABLE_TILE_WIDTH_PX;
    if (t.height < MIN_READABLE_TILE_HEIGHT_PX) minSizePenalty += (MIN_READABLE_TILE_HEIGHT_PX - t.height) / MIN_READABLE_TILE_HEIGHT_PX;
  }
  const minSizePenaltyMean = minSizePenalty / n;

  // Within a row every tile shares the same height (justified rows), so the
  // only per-tile size difference is WIDTH — a big width ratio between two
  // tiles side by side is the "extreme neighbor contrast" spec item 2 warns
  // about.
  const CONTRAST_LIMIT = 2.2;
  let contrastPenalty = 0;
  let contrastRowCount = 0;
  for (const row of rows) {
    if (row.length < 2) continue;
    contrastRowCount++;
    let maxWidth = 0;
    let minWidth = Infinity;
    for (const i of row) {
      const w = tiles[i].width;
      if (w > maxWidth) maxWidth = w;
      if (w < minWidth) minWidth = w;
    }
    if (minWidth > 0) {
      const ratio = maxWidth / minWidth;
      if (ratio > CONTRAST_LIMIT) contrastPenalty += ratio - CONTRAST_LIMIT;
    }
  }
  const contrastPenaltyMean = contrastRowCount > 0 ? contrastPenalty / contrastRowCount : 0;

  // Gallery convention: the emptier row sits at the BOTTOM (the way Meet
  // parks the odd participant on the last row) — a fuller row hanging under
  // a narrower one reads upside-down. Measured by row CONTENT width (the
  // sum of tile widths; gaps omitted — this is a relative comparison, and
  // the scorer deliberately isn't told gapPx), not by tile count: with
  // mixed aspects a row of two 16:9s can genuinely be "fuller" than three
  // portraits. In the justified variant every row spans (almost) the full
  // width, so this stays ~0 there and matters mainly for the equal-height
  // variant, where [1,2] and [2,1] splits otherwise score identically (same
  // heights, same areas) and the tie would fall to enumeration order —
  // which happens to emit [1,2], i.e. orphan on top, first.
  let rowOrderPenalty = 0;
  for (let j = 0; j + 1 < rows.length; j++) {
    const upper = rows[j].reduce((sum, i) => sum + tiles[i].width, 0);
    const lower = rows[j + 1].reduce((sum, i) => sum + tiles[i].width, 0);
    if (lower > upper && lower > 0) rowOrderPenalty += (lower - upper) / lower;
  }

  const STABILITY_BONUS = 0.01; // spec item 2: "small tie-break bonus for the original tile order"
  const score =
    fillRatio -
    areaExcess * 1.5 -
    rowHeightCv * 0.3 -
    lastRowEmptinessPenalty * 0.15 -
    minSizePenaltyMean * 0.3 -
    contrastPenaltyMean * 0.15 -
    rowOrderPenalty * 0.05 +
    (isOriginalOrder ? STABILITY_BONUS : 0);

  return {
    score,
    fillRatio,
    areaExcess,
    rowHeightCv,
    lastRowEmptinessPenalty,
    minSizePenaltyMean,
    contrastPenaltyMean,
    rowOrderPenalty,
  };
}

/**
 * Best-of-search entry point: tries every (row count) x (contiguous
 * partition) x (ordering) x (sizing variant: justified / equal-height, see
 * evaluatePackerCandidate / evaluateEqualRowsCandidate) combination and
 * keeps the highest-scoring one (scorePackerCandidate). The two variants
 * coincide for single-row candidates and even partitions of identical
 * aspects — evaluating the duplicate anyway is cheaper than detecting it,
 * given the tiny candidate space (n<=6). Returns null only if NO
 * combination produces a usable geometry (e.g. a degenerate zero-size
 * stage).
 */
function packTiles(descriptors, availWidth, availHeight, gapPx) {
  const n = descriptors.length;
  if (n === 0 || availWidth <= 0 || availHeight <= 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const orderingName of PACKER_ORDERINGS) {
    const order = orderPackerIndices(descriptors, orderingName);
    const isOriginalOrder = orderingName === 'original';
    for (let rows = 1; rows <= n; rows++) {
      for (const rowSizes of partitionsIntoRows(n, rows)) {
        const candidates = [
          evaluatePackerCandidate(descriptors, order, rowSizes, availWidth, availHeight, gapPx),
          evaluateEqualRowsCandidate(descriptors, order, rowSizes, availWidth, availHeight, gapPx),
        ];
        for (const candidate of candidates) {
          if (!candidate) continue;
          const { score } = scorePackerCandidate(candidate, availWidth, availHeight, isOriginalOrder);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
    }
  }
  return best;
}

/**
 * Turn the winning candidate's float geometry into integer px boxes,
 * indexed by ORIGINAL tile order (spec item 2: "round positions/sizes to
 * integer px") — regardless of which internal ordering the search picked,
 * the packer only ever decides WHERE each original tile lands; it never
 * reorders DOM nodes (unnecessary given position:absolute, and it would
 * restart any live <video> inside them).
 *
 * Rounding uses running-cumulative-sum rounding (round the cumulative edge;
 * a box's size is the difference between two rounded edges), both across a
 * row's tiles and across the stack of rows — this is what guarantees
 * adjacent boxes never overlap NOR leave a stray sub-pixel gap purely from
 * independently rounding each box.
 *
 * Both axes are centered: each row horizontally within availWidth (a row
 * narrower than full width — the block scaled down in the justified
 * variant, or a naturally narrow row in the equal-height variant, whose
 * rows can each be a DIFFERENT width — leaves equal margin left/right), and
 * the whole stack of rows vertically within availHeight. Deliberately NOT done by giving #tiles-grid a content-sized
 * height and letting the surrounding flex .room-stage center it — that
 * would make the grid's own box shrink/grow with the tile count, and a
 * tile mid-CSS-transition toward a new position could momentarily poke
 * outside a box that just shrank under it. Keeping #tiles-grid fixed at
 * availHeight and centering the content INSIDE it means a tile's old and
 * new boxes are always both within the SAME stable bounds — and since a
 * transition interpolates left/top/width/height independently but linearly,
 * it can never exit a rectangular region whose two endpoints are both
 * inside it (the sum of two in-bounds linear interpolations, e.g. left(t) +
 * width(t), is itself an in-bounds linear interpolation of the two edges).
 *
 * The centering offset (per row horizontally, and once vertically for the
 * whole block) is folded INTO the same cumulative-rounding accumulator
 * rather than rounded separately and added on top — rounding it separately
 * and adding two already-rounded numbers can overshoot the stage by a
 * stray px (found by the throwaway node verification script this engine
 * shipped with: 5 same-aspect tiles in one row very nearly filled
 * availWidth exactly, and rounding the centering offset and the row's
 * content width independently pushed the last tile's right edge 2px past
 * the stage). Feeding the unrounded offset as the accumulator's starting
 * value keeps the whole row (or block) a single rounding problem, so its
 * final edge lands EXACTLY on `Math.round(offset + content size)` — which,
 * since content size never exceeds the available space (both variants
 * guarantee every row is at most availWidth wide and the block at most
 * availHeight tall — see evaluatePackerCandidate /
 * evaluateEqualRowsCandidate), can only round down to it or below.
 */
function pixelizePackedLayout(candidate, availWidth, availHeight, gapPx) {
  const { rows, rowHeights, tiles } = candidate;
  const rowGapTotal = gapPx * (rows.length - 1);
  const blockHeight = rowHeights.reduce((a, b) => a + b, 0) + rowGapTotal;
  const verticalOffset = Math.max(0, (availHeight - blockHeight) / 2);

  const boxes = new Array(tiles.length);
  let topAcc = verticalOffset;
  rows.forEach((rowIndices, j) => {
    const top = Math.round(topAcc);
    topAcc += rowHeights[j];
    const bottom = Math.round(topAcc);
    const rowHeightPx = bottom - top;
    if (j < rows.length - 1) topAcc += gapPx;

    // NOTE: widths here come from the tile's TRUE (unrounded) float height —
    // NOT rowHeightPx — precisely so that content width stays exactly what
    // evaluatePackerCandidate justified it to (see the constraint above).
    // The tiny mismatch this leaves between rowHeightPx and the height used
    // to derive each width is well under a pixel and is exactly the kind of
    // "float rounding" slack the aspect is allowed to have.
    const contentWidth = rowIndices.reduce((sum, i) => sum + tiles[i].width, 0) + gapPx * (rowIndices.length - 1);
    const rowOffsetX = Math.max(0, (availWidth - contentWidth) / 2);

    let leftAcc = rowOffsetX;
    rowIndices.forEach((origIdx, k) => {
      const left = Math.round(leftAcc);
      leftAcc += tiles[origIdx].width;
      const right = Math.round(leftAcc);
      if (k < rowIndices.length - 1) leftAcc += gapPx;
      boxes[origIdx] = { left, top, width: right - left, height: rowHeightPx };
    });
  });
  return boxes;
}

/**
 * Solo room (spec item 4): the packer above would happily stretch the
 * single tile to fill the ENTIRE stage — maximal fill, technically, but one
 * giant videocall tile edge-to-edge on a big desktop monitor reads as a bug,
 * not a deliberate design (the OLD fixed layout capped solo at
 * minmax(260px, 480px) regardless of stage size — see git history). Cap the
 * tile's AREA at a fraction of the stage instead of a fixed px size, so it
 * still scales up on bigger screens ("proportionally larger is fine" per
 * spec) — then re-center within the stage box at the smaller size.
 */
function applySoloAreaCap(boxes, availWidth, availHeight) {
  const box = boxes[0];
  if (!box) return boxes;
  const area = box.width * box.height;
  const cap = SOLO_MAX_AREA_FRACTION * availWidth * availHeight;
  if (area <= cap) return boxes;
  const scale = Math.sqrt(cap / area);
  const width = Math.round(box.width * scale);
  const height = Math.round(box.height * scale);
  const left = Math.round((availWidth - width) / 2);
  const top = Math.round((availHeight - height) / 2);
  return [{ left, top, width, height }];
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
 * Per-tile aspect fed into the packer (spec item 1): a tile currently
 * showing video contributes the VIDEO's own intrinsic aspect (falling back
 * to 16:9 before the first loadedmetadata — see the listeners in createTile
 * below) and is NOT adjustable by the packer; a tile still on its no-video
 * placeholder (avatar circle + name, see createTile) has no aspect of its
 * own — the placeholder content adapts to any reasonable box — so it's
 * marked `flexible`, letting resolveFlexibleRowAspects pick whatever aspect
 * in [FLEXIBLE_TILE_ASPECT_MIN, FLEXIBLE_TILE_ASPECT_MAX] helps its row.
 */
function tileAspectDescriptor(tileEl) {
  const videoEl = tileEl.querySelector('.tile-video');
  const hasVideo = !!videoEl && !videoEl.classList.contains('hidden');
  if (hasVideo) {
    const { videoWidth, videoHeight } = videoEl;
    const aspect = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : FALLBACK_VIDEO_ASPECT;
    return { flexible: false, aspect };
  }
  return { flexible: true, aspect: FLEXIBLE_TILE_ASPECT_IDEAL };
}

// The geometry actually written to a tile by the last successful
// layoutTilesGrid() call, keyed by element — lets applyPackedLayout (a) skip
// the style write entirely when a recompute produces the SAME numbers (spec
// item 5: "skip applying when the computed geometry didn't actually change,
// avoid transition jitter from no-op writes") and (b) tell a tile's FIRST
// placement (no entry yet) apart from a later reposition, which is how the
// fly-in-from-the-corner transition gets suppressed on first placement (see
// applyPackedLayout).
const packedTileGeometry = new WeakMap();

/**
 * Strip every packer-applied inline style from one tile — used whenever a
 * tile's geometry is about to be handed BACK to CSS: entering --compact (its
 * own flex filmstrip), entering --spotlight (its own flex filmstrip), or the
 * tile becoming .tile--maximized (position:fixed overlay). In every one of
 * these cases a leftover inline `position: absolute` plus explicit px
 * `left/top/width/height` would corrupt the CSS layout: position:absolute
 * removes an element from flex flow entirely (breaking the compact/
 * spotlight filmstrips), and — for .tile--maximized specifically — an
 * inline style always outranks a CSS class selector regardless of
 * specificity, so the tile would stay pinned at its small grid box instead
 * of the CSS `position: fixed; inset: 0` rule taking over. See
 * maximizeTile/showScreenStageContainer for the call sites, and the guards
 * at the top of layoutTilesGrid that keep the packer from writing these
 * styles again while any of these modes is active.
 */
function clearPackedTileStyle(tileEl) {
  tileEl.style.position = '';
  tileEl.style.left = '';
  tileEl.style.top = '';
  tileEl.style.width = '';
  tileEl.style.height = '';
  tileEl.style.aspectRatio = '';
  tileEl.classList.remove('tile--placed');
  packedTileGeometry.delete(tileEl);
}

/** clearPackedTileStyle for every current tile, plus #tiles-grid's own inline height/position (see layoutTilesGrid/applyPackedLayout). */
function clearPackedTileLayout() {
  for (const tileEl of tilesGridEl.children) clearPackedTileStyle(tileEl);
  tilesGridEl.style.position = '';
  tilesGridEl.style.height = '';
}

/**
 * Write the packer's computed boxes to the DOM (spec item 3). `boxes` is
 * indexed by #tiles-grid's CURRENT DOM child order (the same order
 * layoutTilesGrid read tileAspectDescriptor in) — the packer decides WHERE
 * each existing tile lands, it never reorders the DOM nodes themselves (see
 * pixelizePackedLayout for why).
 */
function applyPackedLayout(boxes, gridHeightPx) {
  tilesGridEl.style.position = 'relative';
  tilesGridEl.style.height = `${gridHeightPx}px`;
  const children = tilesGridEl.children;
  for (let i = 0; i < children.length; i++) {
    const tileEl = children[i];
    const box = boxes[i];
    if (!box) continue;
    const previous = packedTileGeometry.get(tileEl);
    if (
      previous &&
      previous.left === box.left &&
      previous.top === box.top &&
      previous.width === box.width &&
      previous.height === box.height
    ) {
      continue; // identical geometry — skip the write (see packedTileGeometry)
    }
    const isFirstPlacement = !previous;
    tileEl.style.position = 'absolute';
    tileEl.style.left = `${box.left}px`;
    tileEl.style.top = `${box.top}px`;
    tileEl.style.width = `${box.width}px`;
    tileEl.style.height = `${box.height}px`;
    // Neutralize the base .tile { aspect-ratio: 16/9 } fallback (see
    // static/style.css) — the inline width/height above already fully
    // determine the box, but an explicit 'auto' here removes any doubt.
    tileEl.style.aspectRatio = 'auto';
    packedTileGeometry.set(tileEl, box);
    if (isFirstPlacement) {
      // No fly-in from the top-left corner for a tile that's only just
      // appearing (a fresh join, or one returning from compact/spotlight/
      // maximized — clearPackedTileStyle deletes the cache entry precisely
      // so this branch is taken again on the way back): .tile--placed (see
      // static/style.css) is what turns on the left/top/width/height
      // transition, and adding it a frame AFTER the geometry above already
      // landed means this specific change is a silent jump; only the NEXT
      // geometry change for this tile will glide.
      requestAnimationFrame(() => tileEl.classList.add('tile--placed'));
    }
  }
}

/**
 * Recompute and apply the packed layout (see the big comment above
 * partitionsIntoRows for the algorithm). Triggered — always through
 * scheduleLayoutTilesGrid below, never called directly, so a burst of
 * triggers within one frame collapses into a single recompute (spec item
 * 5) — by: the tile count changing (updateSoloState, from
 * updateParticipantCount); a tile's video/placeholder state flipping
 * (setTileVideoVisible — its USEFUL aspect just changed, see
 * tileAspectDescriptor); a video's intrinsic size arriving or changing
 * (the loadedmetadata/resize listeners in createTile — dimensions can show
 * up late, or change mid-call if the sender rotates their phone); window
 * resize; and exiting --compact/--spotlight (hideScreenStage/
 * unmaximizeTile).
 *
 * Does nothing in --compact (the screen-share filmstrip has its own fixed
 * flex geometry, see static/style.css) or --spotlight (the maximized-tile
 * filmstrip likewise). ALSO does nothing while any tile is maximized even
 * WITHOUT spotlight — see maximizeTile: spotlight only turns on when
 * there's at least one OTHER participant, so a solo maximized tile carries
 * neither class, yet must still not be repositioned here: the packer's
 * inline position:absolute would outrank the CSS `.tile--maximized {
 * position: fixed }` rule that's supposed to blow it up to fill the page
 * (see clearPackedTileStyle's comment for the general mechanism, and
 * maximizeTile/unmaximizeTile for how packer control is handed off and
 * back across this transition).
 */
function layoutTilesGrid() {
  if (tilesGridEl.classList.contains('tiles-grid--compact')) return;
  if (tilesGridEl.classList.contains('tiles-grid--spotlight')) return;
  if (maximizedTile) return;
  const tileCount = tilesGridEl.children.length;
  if (tileCount === 0) return;

  const { width: stageWidth, height: availHeight } = computeAvailableGridBox();
  // #tiles-grid itself is capped at `max-width: 1200px` in CSS (see
  // static/style.css) — on wide desktop screens the stage (.room-stage) is
  // wider than this limit, and without accounting for it the JS here would
  // pack tiles for the FULL stage width while the grid itself renders
  // narrower (max-width clips its box) — a horizontal scroll of exactly
  // this kind was found by smoke testing the old fixed grid (see spec item
  // 6: 1280×800, 6 tiles).
  const cssMaxWidth = parseFloat(getComputedStyle(tilesGridEl).maxWidth);
  const availWidth = Number.isFinite(cssMaxWidth) ? Math.min(stageWidth, cssMaxWidth) : stageWidth;
  const gapPx = parseFloat(getComputedStyle(tilesGridEl).columnGap) || 0;
  if (availWidth <= 0 || availHeight <= 0) return;

  const descriptors = Array.from(tilesGridEl.children, tileAspectDescriptor);
  const candidate = packTiles(descriptors, availWidth, availHeight, gapPx);
  if (!candidate) return;
  let boxes = pixelizePackedLayout(candidate, availWidth, availHeight, gapPx);
  // Solo cap (spec item 4) applies only to the single-tile case — see
  // applySoloAreaCap.
  if (tileCount === 1) boxes = applySoloAreaCap(boxes, availWidth, availHeight);
  applyPackedLayout(boxes, Math.round(availHeight));
}

let layoutTilesGridRafPending = false;

/**
 * Coalescing wrapper (spec item 5) — every external trigger listed in the
 * layoutTilesGrid comment calls THIS, never layoutTilesGrid() directly, so
 * a burst of triggers landing within the same frame (e.g. several peers'
 * videos all firing loadedmetadata within milliseconds of each other while
 * a call is still connecting) collapses into a single recompute instead of
 * one per event.
 */
function scheduleLayoutTilesGrid() {
  if (layoutTilesGridRafPending) return;
  layoutTilesGridRafPending = true;
  requestAnimationFrame(() => {
    layoutTilesGridRafPending = false;
    layoutTilesGrid();
  });
}

// Window resize (phone rotation, resizing the desktop browser window,
// DevTools) — the only one of the recompute triggers (see the
// layoutTilesGrid comment) that doesn't already go through updateSoloState
// or one of the per-tile video listeners.
window.addEventListener('resize', scheduleLayoutTilesGrid);

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
  // The packer (see tileAspectDescriptor/layoutTilesGrid) needs the video's
  // OWN intrinsic aspect, which isn't known yet at track-attach time —
  // videoWidth/videoHeight only become available once the browser has
  // decoded the first frame (loadedmetadata). 'resize' fires again later if
  // those dimensions ever CHANGE mid-call (e.g. the sender rotates their
  // phone, or switches cameras) — both go through the same coalesced
  // scheduler as every other layout trigger (spec item 5).
  video.addEventListener('loadedmetadata', scheduleLayoutTilesGrid);
  video.addEventListener('resize', scheduleLayoutTilesGrid);

  // No-video placeholder: avatar circle (letter/emoji, now noticeably
  // larger and strictly round — see .tile-placeholder-avatar in
  // static/style.css) + the name shown LARGE below it. .tile-placeholder is
  // just a flex container covering the whole tile, the gradient circle is
  // a separate .tile-placeholder-avatar.
  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';

  const avatar = document.createElement('div');
  avatar.className = 'tile-placeholder-avatar';
  avatar.style.background = avatarGradientCss(peerId);

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

  // Circular clipping wrapper around the glyph (see static/style.css:
  // .tile-placeholder-glyph-clip) — clips an oversized emoji glyph to the
  // circle like a zoomed photo crop, letting it fill almost the whole
  // circle instead of being capped by inscribed-square geometry. The crown
  // is deliberately NOT inside this wrapper (it must overflow the top rim
  // unclipped) and is appended AFTER it: both are positioned elements, so
  // DOM order is paint order, and the crown's dip into the circle has to
  // paint over the glyph.
  const glyphClip = document.createElement('div');
  glyphClip.className = 'tile-placeholder-glyph-clip';

  const letter = document.createElement('span');
  letter.className = 'tile-placeholder-letter';
  const trimmedName = (name || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  letter.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  // See static/style.css: .tile-placeholder-letter--emoji — an emoji glyph
  // is sized much larger than a letter (and clipped by the wrapper above),
  // see isEmojiGrapheme above.
  letter.classList.toggle('tile-placeholder-letter--emoji', isEmojiGrapheme(firstGrapheme));
  glyphClip.appendChild(letter);
  avatar.appendChild(glyphClip);
  avatar.appendChild(placeholderCrown);
  placeholder.appendChild(avatar);

  // Kept only as a text sink for backward-compatible name-writing code
  // paths (updatePeerTileName/updateOwnTileLabel still write into it) —
  // CSS-hidden (see static/style.css: .tile-placeholder-name) now that the
  // name lives in ONE place, the bottom-center pill (label, below) visible
  // in both video and placeholder states.
  const placeholderName = document.createElement('div');
  placeholderName.className = 'tile-placeholder-name';
  placeholder.appendChild(placeholderName);

  // The name pill — now ALWAYS visible (bottom-center of the tile, both
  // with and without video, see static/style.css: .tile-name), not just a
  // "corner caption during video" anymore. Leader crown — inline before the
  // name in this same badge, but shown ONLY while video is on (see
  // setTileVideoVisible, which drives crown.style.display) — without video,
  // placeholderCrown above the avatar circle is the one on screen instead,
  // and showing both at once would double up the crown.
  const label = document.createElement('div');
  label.className = 'tile-name';

  const crown = document.createElement('span');
  crown.className = 'tile-crown hidden';
  crown.setAttribute('aria-hidden', 'true');
  crown.innerHTML = CROWN_ICON_SVG; // static markup, not user data
  // No video at creation time (see video.className above) — force the
  // inline crown hidden regardless of leader status until setTileVideoVisible(tile, true)
  // runs; see that function for why this is an inline style, not a class.
  crown.style.display = 'none';
  label.appendChild(crown);

  const labelText = document.createElement('span');
  labelText.className = 'tile-name-text';
  label.appendChild(labelText);

  // Just the name, BIGGER (see spec item 5) — without a "You (...)" wrapper
  // and without a "leader" role word (leadership is already visible via the
  // crown); our own name isn't distinguished from others' by text. No video
  // at creation time (see video.className above), so the pill starts in its
  // "avatar circle visible" form — leading emoji stripped, see
  // tileDisplayName — corrected a moment later by the first
  // setTileVideoVisible call once the real enabled/track state is known.
  labelText.textContent = tileDisplayName(trimmedName, firstGrapheme, false);
  placeholderName.textContent = tileDisplayName(trimmedName, firstGrapheme, false);

  // "Mic off/absent" indicator (see static/style.css: .tile-mic-off) —
  // visible BY DEFAULT (not .hidden): before the first enable/stream-info,
  // this participant genuinely doesn't have a track yet, which per spec
  // also shows the icon (see setTileMicOff/applyMicEnabledUpdate).
  const micOff = document.createElement('span');
  micOff.className = 'tile-mic-off';
  micOff.setAttribute('aria-hidden', 'true');
  micOff.innerHTML = MIC_OFF_ICON_SVG; // static markup, not user data

  // Speed badge (see static/style.css: .tile-speed, static/room.js:
  // updateTileSpeedBadges) — ALWAYS visible; shows a "…" placeholder until the
  // first speed value is known (the poller needs two traffic snapshots for
  // this peer, see pollPeerStats). Pinned top-left (top-right is mic,
  // bottom-center is the name pill).
  //
  // Two children, not one text node — .tile-speed-rate (this same "…"/
  // "↓ 320 KB/s"/"↑ …" text as before) and .tile-speed-rtt (the ping, e.g.
  // "· 45 ms"; hidden below the LARGE size tier, see static/style.css).
  // updateTileSpeedBadges writes into these two spans SEPARATELY on every
  // poller tick — a single `speedEl.textContent = …` (the old approach)
  // would wipe whichever of the two it didn't just set.
  const speed = document.createElement('span');
  speed.className = 'tile-speed';
  speed.setAttribute('aria-hidden', 'true');

  const speedRate = document.createElement('span');
  speedRate.className = 'tile-speed-rate';
  speedRate.textContent = '…';
  speed.appendChild(speedRate);

  const speedRtt = document.createElement('span');
  speedRtt.className = 'tile-speed-rtt';
  speed.appendChild(speedRtt);

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
    speedEl: speed, // the outer .tile-speed badge (hidden/shown, size-tiered as a whole) — see rateEl/rttEl below for the two text children
    rateEl: speedRate,
    rttEl: speedRtt,
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
 * `labelValue`/the first grapheme. The pill's videoVisible form is taken
 * from the tile's CURRENT state (video.classList) rather than assumed — the
 * name can change (a late name-announce) while video is already on, and the
 * pill must reflect whichever form is on screen right now (see
 * tileDisplayName/task item 4).
 */
function updatePeerTileName(peerId, name) {
  const entry = peers.get(peerId);
  if (!entry) return; // the peer already left while the message was in flight — not rare on a live relay
  entry.name = name || null;
  const tile = entry.tile;
  const trimmedName = (name || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  const videoVisible = !tile.videoEl.classList.contains('hidden');
  tile.root.dataset.name = name || '';
  tile.labelTextEl.textContent = tileDisplayName(trimmedName, firstGrapheme, videoVisible);
  tile.placeholderNameEl.textContent = tileDisplayName(trimmedName, firstGrapheme, false);
  tile.letterEl.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  // See createTile above / static/style.css: .tile-placeholder-letter--emoji.
  tile.letterEl.classList.toggle('tile-placeholder-letter--emoji', isEmojiGrapheme(firstGrapheme));
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
  // Hand geometry control from the packer back to CSS — see
  // clearPackedTileLayout's comment for exactly why a leftover inline
  // position:absolute + px left/top/width/height would break BOTH this
  // tile (outranks the CSS `position: fixed` on .tile--maximized) and, if
  // updateSpotlightMode below turns spotlight on, every OTHER tile too (they
  // become flex items of the filmstrip, and position:absolute would drop
  // them out of that flow entirely). Clearing all of them unconditionally
  // here — rather than only when spotlight actually turns on — also covers
  // the solo-maximize case (no other participants, spotlight never turns
  // on): layoutTilesGrid's own `if (maximizedTile) return` guard means
  // nothing will repack them until unmaximizeTile() explicitly asks for it.
  clearPackedTileLayout();
  updateSpotlightMode();
  document.addEventListener('keydown', onMaximizedTileKeydown);
}

/** Collapse the currently maximized tile back into the grid. */
function unmaximizeTile() {
  if (!maximizedTile) return;
  maximizedTile.root.classList.remove('tile--maximized');
  maximizedTile = null;
  updateSpotlightMode();
  // Nothing repacked the grid while this tile was maximized (see
  // layoutTilesGrid's `if (maximizedTile) return` guard) — ask for it
  // explicitly now that the guard no longer applies.
  scheduleLayoutTilesGrid();
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
  // packed grid layout (see layoutTilesGrid above; it does nothing itself in
  // --compact/--spotlight/while a tile is maximized, they have their own CSS
  // logic).
  scheduleLayoutTilesGrid();
}

// ---------- Leader: crown on the tile, own tile caption, gear icon visibility ----------

function isPeerLeader(peerId) {
  return leaderId !== null && peerId === leaderId;
}

/**
 * Update the crown on the tiles (our own and all current peers) for the new
 * leaderId + our own tile's caption. Each tile carries TWO crowns (see
 * createTile) — crownEl (inline in the name pill, meant for the video
 * state) and placeholderCrownEl (above the placeholder avatar circle,
 * meant for the no-video state) — toggled together here purely by leader
 * status, since which one is ACTUALLY on screen (video vs. placeholder) is
 * governed independently by setTileVideoVisible (crownEl.style.display) and
 * by placeholderEl's own hidden state (which hides placeholderCrownEl along
 * with the rest of the placeholder). The two mechanisms compose regardless
 * of call order: at most one of the two crowns is ever visible at a time.
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
 * setLeaderIndicator, not by text). Recomputed on any name/leaderId change.
 * The pill (labelTextEl) reflects the tile's CURRENT video-visibility state
 * (see tileDisplayName/task item 4: full name incl. emoji while video is on,
 * emoji stripped once the avatar circle is on screen instead); the
 * placeholder caption (placeholderNameEl) always uses the latter form —
 * it's only ever rendered together with the circle.
 */
function updateOwnTileLabel() {
  if (!ownTile) return;
  const trimmedName = (myName || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  const videoVisible = !ownTile.videoEl.classList.contains('hidden');
  ownTile.labelTextEl.textContent = tileDisplayName(trimmedName, firstGrapheme, videoVisible);
  ownTile.placeholderNameEl.textContent = tileDisplayName(trimmedName, firstGrapheme, false);
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
 * A single point that toggles a tile's video/placeholder — keeps both in
 * sync (our own ownTile or someone else's peers.get(id).tile) and itself
 * triggers auto-exit from maximization. tile.labelEl (.tile-name, the
 * bottom-center name pill) is NOT toggled here anymore — it's always
 * visible in both states (see createTile/style.css).
 *
 * The one thing that DOES still depend on video visibility is the inline
 * leader crown inside the name pill (tile.crownEl): it must show ONLY
 * while video is on, because without video the OTHER crown
 * (placeholderCrownEl, above the avatar circle — see createTile) is the one
 * on screen, and it's already auto-hidden whenever placeholderEl itself is
 * hidden (a hidden parent hides all its children regardless of their own
 * classes). Forcing crownEl via an inline style (rather than a class) keeps
 * it independent from the leader-driven 'hidden' class toggled in
 * setLeaderIndicator: whichever of the two runs last still leaves exactly
 * one crown on screen, with no ordering dependency between the two
 * functions.
 *
 * Also recomputes the pill's TEXT (tile.labelTextEl) for the new visibility
 * — task item 4's avatar/name rule: the pill shows the full name (leading
 * emoji included) while video is on, and the emoji stripped once video
 * hides and the avatar circle (which already shows that same emoji as its
 * big glyph) takes its place, see tileDisplayName. The name itself is read
 * from tile.root.dataset.name (the single source of truth kept in sync by
 * createTile/updatePeerTileName), not passed in — this function only ever
 * gets a tile + a visibility flag. Since the maximized tile, the spotlight
 * filmstrip and the screen-share compact strip are all pure CSS
 * repositioning of this SAME tile (see maximizeTile/updateSpotlightMode/
 * showScreenStageContainer — no separate DOM/pill for any of them), fixing
 * the pill text here once keeps all of them correct.
 */
function setTileVideoVisible(tile, show) {
  tile.videoEl.classList.toggle('hidden', !show);
  tile.placeholderEl.classList.toggle('hidden', show);
  tile.crownEl.style.display = show ? '' : 'none';
  const trimmedName = (tile.root.dataset.name || '').trim();
  tile.labelTextEl.textContent = tileDisplayName(trimmedName, firstGraphemeOf(trimmedName), show);
  exitMaximizeIfHidden(tile, show);
  // The tile's USEFUL aspect just changed (see tileAspectDescriptor: video
  // uses its own intrinsic aspect, a placeholder is flexible) — the packer
  // needs to re-run to account for it (spec item 5).
  scheduleLayoutTilesGrid();
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
  // Hand geometry control to the compact filmstrip's own CSS (flex, fixed
  // tile width — see static/style.css) — see clearPackedTileLayout's
  // comment for why leftover packer inline styles would corrupt it
  // (position:absolute removes a tile from the flex flow entirely).
  clearPackedTileLayout();
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

/**
 * Task item 4's avatar/name rule applied to a lobby request card: a round
 * avatar with the guest's first grapheme — the SAME gradient derivation as
 * a real tile (avatarGradientCss(peerId), see createTile) so the circle
 * already matches the one they'll have once admitted — next to the name
 * WITHOUT its leading emoji (the circle already carries it, see
 * tileDisplayName — this card's avatar is ALWAYS on screen, so it's always
 * the videoVisible=false form). Before the encrypted name-announce arrives
 * (see signaling.on('name-announce')) req.name is null and the card still
 * reads "Guest" (tileDisplayName's own empty-name fallback), with a neutral
 * "?" in the circle rather than "G" — a placeholder word doesn't deserve a
 * highlighted initial.
 */
function buildJoinRequestCardEl(req) {
  const card = document.createElement('div');
  card.className = 'join-request-card';
  card.dataset.peerId = req.peerId;

  const trimmedName = (req.name || '').trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);

  const avatar = document.createElement('div');
  avatar.className = 'join-request-avatar';
  avatar.style.background = avatarGradientCss(req.peerId);

  const avatarLetter = document.createElement('span');
  avatarLetter.className = 'join-request-avatar-letter';
  avatarLetter.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  avatarLetter.classList.toggle('join-request-avatar-letter--emoji', isEmojiGrapheme(firstGrapheme));
  avatar.appendChild(avatarLetter);

  const info = document.createElement('div');
  info.className = 'join-request-info';

  const name = document.createElement('span');
  name.className = 'join-request-name';
  name.textContent = tileDisplayName(trimmedName, firstGrapheme, false);

  const wantsLine = document.createElement('span');
  wantsLine.className = 'join-request-wants';
  wantsLine.textContent = 'wants to join';

  info.appendChild(name);
  info.appendChild(wantsLine);

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
  card.appendChild(avatar);
  card.appendChild(info);
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
    // Always visible (see createTile) — "…" until the first rate is known.
    // Writes into the dedicated .tile-speed-rate span, NOT the outer
    // .tile-speed container — see createTile: the container also holds the
    // sibling .tile-speed-rtt span below, and a `speedEl.textContent = …`
    // here would delete that sibling's text node along with its own.
    entry.tile.rateEl.textContent = downRate == null ? '…' : formatSpeedBadge(downRate);
    // Ping (see static/style.css: .tile-speed-rtt, hidden below the LARGE
    // container-query size tier) — rtt is already computed by the shared
    // poller and cached per peer (see peerLastStats/pollPeerStats above), no
    // extra getStats() call needed here. Empty string (not a placeholder)
    // when not yet known, same as formatPeerStatsLine's rttPart — an empty
    // span simply renders nothing instead of a stray "…".
    entry.tile.rttEl.textContent = cached && typeof cached.rtt === 'number' ? `· ${Math.round(cached.rtt)} ms` : '';
    if (cached && cached.upRate != null) {
      totalUpRate = (totalUpRate || 0) + cached.upRate;
    }
  }

  if (!ownTile) return;
  // Own tile: the aggregate OUTGOING rate only (see the doc comment above) —
  // a per-peer ping doesn't make sense for a SUM across peers, so the rtt
  // span is simply left empty here rather than showing any one peer's
  // number as if it applied to the aggregate.
  ownTile.rateEl.textContent = totalUpRate == null ? '↑ …' : `↑ ${formatSpeedBadge(totalUpRate)}`;
  ownTile.rttEl.textContent = '';
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
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cams = devices.filter((d) => d.kind === 'videoinput');
  fillDeviceSelect(settingMicDeviceSelect, mics, 'Microphone');
  fillDeviceSelect(settingCameraDeviceSelect, cams, 'Camera');
  // Pre-join card (see the "Pre-join card" section far below) — same
  // enumerateDevices() call, just a different populate function (Off is
  // baked into the list itself there, see fillPrejoinDeviceSelect), so a
  // device plugged in/out (devicechange, below) or a permission grant
  // (acquireGuestPrejoinMedia/switchPrejoinMic/switchPrejoinCamera) keeps
  // every select in the page in sync from this one enumeration.
  fillPrejoinDeviceSelect(prejoinMicSelectEl, mics, 'Microphone');
  fillPrejoinDeviceSelect(prejoinCamSelectEl, cams, 'Camera');
  updatePrejoinMicRowUi();
  updatePrejoinCamRowUi();
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

// ---------- Pre-join device selects: "Off" folded into the list itself ----------
//
// Unlike the in-call settings selects above (real devices only — off/on
// there is the mic/camera TOOLBAR BUTTON's job, not the select), the
// pre-join card has no separate on/off control (see the pre-join card
// spec): "Off" is just the first option of the select itself. This
// sentinel can never collide with a real deviceId (an opaque string handed
// out by the browser) — used as the select's value when no device is
// active.
const PREJOIN_DEVICE_OFF = '__off__';

/**
 * Populate a pre-join select: "Off" first, then either the real device list
 * (once labels are available — see hasLabels below) or ONE generic "Default
 * microphone"/"Default camera" entry standing in for "whatever device the
 * browser/OS picks" (deviceId '', same as omitting deviceId from the
 * getUserMedia constraints).
 *
 * Why collapse to a single generic entry rather than listing whatever
 * enumerateDevices() returns pre-permission: per spec (see
 * navigator.mediaDevices.enumerateDevices(), and the comment on
 * refreshDeviceLists above), before this tab's first mic/camera permission
 * grant EVERY device comes back with an empty label — and in practice often
 * with indistinguishable deviceIds too. Rendering one blank "Microphone
 * 1"/"Microphone 2" per hidden device would just be several options that
 * don't actually let you choose a real device; a single "Default …" entry
 * is honest about what we actually know at that point. The instant ANY
 * entry in `list` has a real label (permission granted, by this or an
 * earlier acquisition), we switch to showing the real list instead.
 */
function fillPrejoinDeviceSelect(selectEl, list, labelPrefix) {
  // Unlike fillDeviceSelect above, a stored empty string ('' — "Default")
  // is a legitimate selection, not "nothing selected yet" — so this reads
  // the dataset with an explicit `!== undefined` check instead of `||`
  // (which would treat '' the same as "unset" and wrongly fall back to Off).
  const storedId = selectEl.dataset.selectedDeviceId;
  const wantId = storedId !== undefined ? storedId : selectEl.value || PREJOIN_DEVICE_OFF;

  selectEl.textContent = '';
  const offOpt = document.createElement('option');
  offOpt.value = PREJOIN_DEVICE_OFF;
  offOpt.textContent = 'Off';
  selectEl.appendChild(offOpt);

  const hasLabels = list.some((d) => d.label);
  if (!hasLabels) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `Default ${labelPrefix.toLowerCase()}`;
    selectEl.appendChild(opt);
  } else {
    list.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${labelPrefix} ${i + 1}`;
      selectEl.appendChild(opt);
    });
  }

  const hasWantId = Array.from(selectEl.options).some((o) => o.value === wantId);
  selectEl.value = hasWantId ? wantId : PREJOIN_DEVICE_OFF;
}

/** Icon/text styling for the mic row (see static/style.css: .prejoin-device-row--off) — kept in sync with the select's CURRENT value from every call site that might change it (onchange, a failed switch falling back to Off, the initial guest acquisition, a plain refreshDeviceLists rebuild). */
function updatePrejoinMicRowUi() {
  prejoinMicRowEl.classList.toggle('prejoin-device-row--off', prejoinMicSelectEl.value === PREJOIN_DEVICE_OFF);
}

/** Camera counterpart of updatePrejoinMicRowUi above. */
function updatePrejoinCamRowUi() {
  prejoinCamRowEl.classList.toggle('prejoin-device-row--off', prejoinCamSelectEl.value === PREJOIN_DEVICE_OFF);
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

// ---------- Pre-join card: shown FIRST, join-room is only sent after
// Start/Join is clicked ----------
//
// One card, same #join-modal/#join-modal-button markup for both roles (see
// static/room.html) — only the header/meta and the mic/camera DEFAULTS
// differ:
//   - Creator (isCreator === true, i.e. we hold a one-time #lt leaderToken —
//     see the fragment-parsing IIFE at the top of the file): "Start the
//     room", an EDITABLE room-name title, mic/camera OFF (no getUserMedia
//     call happens here at all — no permission prompt of any kind).
//   - Guest (no #lt): "Join the room", a STATIC room-name title + a live
//     "N people · started X ago" line from GET /api/rooms/<id> (see
//     initGuestPrejoin below), mic/camera ON by default via a SINGLE
//     combined getUserMedia call (see acquireGuestPrejoinMedia).
//
// The centerpiece is a live 16:9 preview (own camera, mirrored, or the
// avatar placeholder) with a name pill — built from the SAME
// tile-placeholder-*/tile-name markup and classes as an in-call tile (see
// createTile) so it looks and sizes identically. Whatever mic/camera state
// this screen leaves us in is handed to the call AS-IS on submit — see
// onPrejoinSubmit, applyMicStream/applyCameraStream above, and the
// "reflect pre-join media" block in signaling.on('joined') below — nothing
// here ever calls getUserMedia a second time for the same kind.

let isCreator = false; // set once in init(), from initialLeaderToken (see the fragment-parsing IIFE)
let prejoinCardOpen = false; // guards the guest's room-status poll (see startRoomStatusPolling/stopRoomStatusPolling)
// Task item 2: auto-open the "Share" popup for the room's CREATOR right
// after their very first entry (see signaling.on('joined') below) — a
// single-shot latch. Belt-and-suspenders alongside the `!joinedOnce` guard
// already around that whole branch (which by itself already only runs once
// per tab): this makes the "exactly once, ever" invariant obvious locally
// without relying on that outer guard's unrelated purpose.
let shareAutoOpenedForCreator = false;

/**
 * Trim + repair the room-name input before it becomes `currentRoomName`/the
 * `n` fragment param (see onPrejoinSubmit/writeRoomNameToFragment). This
 * logic used to live in static/landing.js, back when the ROOM NAME was
 * chosen there rather than here — moved verbatim (comment included) now
 * that the pre-join redesign moved room-name entry onto this screen.
 *
 * Why the lone-surrogate repair is needed at all: the input has
 * maxlength="40", enforced by the BROWSER in UTF-16 CODE UNITS, not Unicode
 * code points. A name ending in an emoji outside the BMP (astronomical
 * plane — most of NameGen's ROOM_EMOJI) is encoded as a surrogate PAIR (2
 * UTF-16 units); if the 40-unit cutoff lands between the two halves of that
 * pair, the string ends in a lone, unpaired surrogate. A lone surrogate is
 * a technically valid JS string element but not valid Unicode text — left
 * alone it throws a URIError out of encodeURIComponent the moment we put
 * the name into the `n` fragment param / the invite link.
 * String.prototype.toWellFormed() (Baseline 2024) replaces every lone
 * surrogate with U+FFFD; toWellFormedFallback below is a manual equivalent
 * for engines without it (older Safari/Firefox) — a plain scan rather than
 * a clever regex, deliberately, since off-by-one errors in surrogate-pair
 * regexes are exactly the kind of bug that's easy to write and hard to spot
 * in review.
 */
function toWellFormedFallback(str) {
  if (typeof str.toWellFormed === 'function') return str.toWellFormed();
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — valid only if immediately followed by a low one.
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += str[i] + str[i + 1];
        i++;
      } else {
        result += '�';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '�'; // a lone low surrogate — its high half was never here to begin with
    } else {
      result += str[i];
    }
  }
  return result;
}

function cleanRoomNameInput(rawValue) {
  return toWellFormedFallback(rawValue).trim() || null;
}

/**
 * Creator-only, called once on submit (see onPrejoinSubmit): pushes the
 * chosen room name into the address bar as `#t=...&e=...&n=...`. There's
 * nothing but t/e in the creator's fragment before this point (see the
 * fragment-parsing IIFE at the top of the file — `n` is never present on
 * the very first load anymore). From here on the creator's own fragment
 * behaves exactly like a guest's: buildShareLink reads currentRoomName as
 * part of the invite link, and an F5 rehydrates the same name via that same
 * top-of-file parsing.
 */
function writeRoomNameToFragment() {
  const parts = [`t=${linkTokenBase64url}`, `e=${linkExpiry}`];
  if (currentRoomName) parts.push(`n=${encodeURIComponent(currentRoomName)}`);
  history.replaceState(null, '', location.pathname + location.search + `#${parts.join('&')}`);
}

/**
 * Swap the preview between live camera video and the avatar placeholder,
 * and refresh the name pill to match (see updatePrejoinNamePill) — called
 * whenever the camera track's existence/enabled state changes (device
 * select, a failed switch falling back to Off) and once up front when the
 * card is first shown.
 */
function updatePrejoinPreviewMode() {
  const camOn = !!(camTrack && camTrack.enabled);
  prejoinPreviewVideoEl.classList.toggle('hidden', !camOn);
  prejoinPreviewPlaceholderEl.classList.toggle('hidden', camOn);
  if (camOn) {
    prejoinPreviewVideoEl.srcObject = camStream;
    safePlay(prejoinPreviewVideoEl);
  }
  updatePrejoinNamePill();
}

/**
 * The avatar glyph + name pill, kept in sync with the "Your name" field on
 * every keystroke (spec: "typing in the name field updates the avatar
 * glyph and the pill immediately") and with the camera on/off state (see
 * updatePrejoinPreviewMode). Same firstGraphemeOf/isEmojiGrapheme/
 * tileDisplayName helpers as createTile/updatePeerTileName use for the
 * in-call tile — see the "Name pill rule" in the pre-join card spec: with
 * the camera OFF (avatar circle visible) the pill omits a leading emoji
 * (it's already the big glyph in the circle); with the camera ON (no
 * circle) the pill carries the FULL name, emoji included.
 */
function updatePrejoinNamePill() {
  const trimmedName = joinNameInputEl.value.trim();
  const firstGrapheme = firstGraphemeOf(trimmedName);
  const camOn = !!(camTrack && camTrack.enabled);
  prejoinPreviewPillTextEl.textContent = tileDisplayName(trimmedName, firstGrapheme, camOn);
  prejoinAvatarLetterEl.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  prejoinAvatarLetterEl.classList.toggle('tile-placeholder-letter--emoji', isEmojiGrapheme(firstGrapheme));
}

// ---------- Pre-join mic/camera: "Off" folded into the select itself ----------
//
// No separate on/off button here (see the pre-join card spec) — picking a
// real device switches the preview live (stop the old track, acquire the
// new one, apply); picking "Off" just stops whatever's currently active.
// Both reuse acquireMicStream/applyMicStream (acquireCameraStream/
// applyCameraStream) — the SAME split the mic/camera toolbar buttons use
// (see above) — so the stream handed to the call on submit (see
// onPrejoinSubmit) is never re-acquired.

async function switchPrejoinMic(deviceId) {
  if (micTrack) micTrack.stop();
  micStream = null;
  micTrack = null;
  let stream;
  try {
    stream = await acquireMicStream(deviceId);
  } catch (err) {
    console.warn('Pre-join: could not switch microphone, falling back to Off:', err);
    prejoinMicSelectEl.value = PREJOIN_DEVICE_OFF;
    prejoinMicSelectEl.dataset.selectedDeviceId = PREJOIN_DEVICE_OFF;
    setMicButtonOn(false);
    updateOwnMicIndicator();
    updatePrejoinMicRowUi();
    return;
  }
  applyMicStream(stream, true);
  // The RESOLVED deviceId (not necessarily `deviceId` itself — that was
  // null/'' for "Default microphone") is what the selects should remember
  // from now on: the instant permission is granted, fillPrejoinDeviceSelect
  // switches from the single generic '' entry to the real device list (see
  // its hasLabels check) — a stale '' selection would then match nothing
  // and strand the UI back on "Off" even though the mic is actually live.
  const resolvedId = micTrack.getSettings().deviceId || null;
  selectedMicDeviceId = resolvedId;
  prejoinMicSelectEl.dataset.selectedDeviceId = resolvedId || '';
  settingMicDeviceSelect.dataset.selectedDeviceId = resolvedId || '';
  refreshDeviceLists(); // permission may have JUST been granted — pick up real labels if so
}

function stopPrejoinMic() {
  if (micTrack) micTrack.stop();
  micStream = null;
  micTrack = null;
  setMicButtonOn(false);
  updateOwnMicIndicator();
}

async function switchPrejoinCamera(deviceId) {
  if (camTrack) camTrack.stop();
  camStream = null;
  camTrack = null;
  let stream;
  try {
    stream = await acquireCameraStream(deviceId);
  } catch (err) {
    console.warn('Pre-join: could not switch camera, falling back to Off:', err);
    prejoinCamSelectEl.value = PREJOIN_DEVICE_OFF;
    prejoinCamSelectEl.dataset.selectedDeviceId = PREJOIN_DEVICE_OFF;
    setCameraButtonOn(false);
    updatePrejoinPreviewMode();
    updatePrejoinCamRowUi();
    return;
  }
  applyCameraStream(stream, true);
  updatePrejoinPreviewMode();
  // See the matching comment in switchPrejoinMic above — remember the
  // RESOLVED deviceId, not the possibly-empty one that was requested.
  const resolvedId = camTrack.getSettings().deviceId || null;
  selectedCamDeviceId = resolvedId;
  prejoinCamSelectEl.dataset.selectedDeviceId = resolvedId || '';
  settingCameraDeviceSelect.dataset.selectedDeviceId = resolvedId || '';
  refreshDeviceLists(); // permission may have JUST been granted — pick up real labels if so
}

function stopPrejoinCamera() {
  if (camTrack) camTrack.stop();
  camStream = null;
  camTrack = null;
  setCameraButtonOn(false);
  updatePrejoinPreviewMode();
}

prejoinMicSelectEl.addEventListener('change', () => {
  const val = prejoinMicSelectEl.value;
  prejoinMicSelectEl.dataset.selectedDeviceId = val;
  updatePrejoinMicRowUi();
  if (val === PREJOIN_DEVICE_OFF) {
    stopPrejoinMic();
    return;
  }
  const deviceId = val || null; // '' ("Default microphone") -> null, unconstrained
  selectedMicDeviceId = deviceId;
  settingMicDeviceSelect.dataset.selectedDeviceId = val;
  switchPrejoinMic(deviceId);
});

prejoinCamSelectEl.addEventListener('change', () => {
  const val = prejoinCamSelectEl.value;
  prejoinCamSelectEl.dataset.selectedDeviceId = val;
  updatePrejoinCamRowUi();
  if (val === PREJOIN_DEVICE_OFF) {
    stopPrejoinCamera();
    return;
  }
  const deviceId = val || null;
  selectedCamDeviceId = deviceId;
  settingCameraDeviceSelect.dataset.selectedDeviceId = val;
  switchPrejoinCamera(deviceId);
});

/**
 * Guest device defaults (spec: "microphone On, camera On, using the first
 * available device of each kind"): ONE combined getUserMedia call so there
 * is only a SINGLE permission prompt (not two) — see cameraButton/micButton
 * above for why a separate call per kind is the norm mid-call (there it's
 * fine, no prompt is showing at the same time as another). If the combined
 * call rejects outright (denied, no device at all, or a browser that
 * refuses getUserMedia without a user gesture — e.g. some iOS versions,
 * where this initial auto-run has none), we fall back SILENTLY to Off for
 * BOTH kinds with a console.warn and stop there: getUserMedia is
 * all-or-nothing for a single call (the spec doesn't do partial success),
 * so there's no finer-grained failure to report. Recovery is the device
 * select itself — picking a real entry there is a fresh user gesture and
 * goes through switchPrejoinMic/switchPrejoinCamera above, which can
 * succeed even if this initial attempt couldn't.
 */
async function acquireGuestPrejoinMedia() {
  let combined;
  try {
    combined = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    console.warn('Guest pre-join: combined mic+camera request failed — leaving both Off (pick a device below to retry with a fresh user gesture):', err);
    return;
  }

  const audioTrack = combined.getAudioTracks()[0] || null;
  const videoTrack = combined.getVideoTracks()[0] || null;

  if (audioTrack) {
    const deviceId = audioTrack.getSettings().deviceId || null;
    selectedMicDeviceId = deviceId;
    settingMicDeviceSelect.dataset.selectedDeviceId = deviceId || '';
    prejoinMicSelectEl.dataset.selectedDeviceId = deviceId || '';
    applyMicStream(new MediaStream([audioTrack]), true);
  } else {
    console.warn('Guest pre-join: the combined stream came back without an audio track — leaving the microphone Off.');
  }

  if (videoTrack) {
    const deviceId = videoTrack.getSettings().deviceId || null;
    selectedCamDeviceId = deviceId;
    settingCameraDeviceSelect.dataset.selectedDeviceId = deviceId || '';
    prejoinCamSelectEl.dataset.selectedDeviceId = deviceId || '';
    applyCameraStream(new MediaStream([videoTrack]), true);
  } else {
    console.warn('Guest pre-join: the combined stream came back without a video track — leaving the camera Off.');
  }

  updatePrejoinPreviewMode();
  refreshDeviceLists(); // permission granted — re-enumerate for real labels, rebuilding every select from the dataset selections just set above
}

/** Release any live pre-join mic/camera tracks without proceeding into the call — see showPrejoinRoomGoneOverlay/showPrejoinRoomFullOverlay: a guest whose combined getUserMedia already succeeded shouldn't keep the camera/mic hardware open behind a terminal "room is gone/full" overlay they can't get past. */
function stopPrejoinMediaOnAbort() {
  if (micTrack) micTrack.stop();
  micStream = null;
  micTrack = null;
  if (camTrack) camTrack.stop();
  camStream = null;
  camTrack = null;
}

// ---------- Guest-only: room status before joining (GET /api/rooms/<id>) ----------
//
// Only a GUEST calls this — the creator just created the room via POST
// /api/rooms and already knows it's empty; hitting the read endpoint right
// after create would race the server's own write for no reason and
// couldn't tell the creator anything they don't already know. Server: see
// src/main.rs — 200 {participants, capacity, ageSeconds}, 404 (plain text,
// room gone), 429 (per-IP limit, 240/min).
let roomStatusPollTimer = null;

/**
 * One GET /api/rooms/<id>. Returns:
 *   - {ok:true, participants, capacity, ageSeconds} on a well-formed 200
 *   - {ok:false, reason:'not-found'} on 404
 *   - {ok:false, reason:'other'} for anything else (429, 5xx, a network
 *     error, malformed JSON) — deliberately NOT terminal (see
 *     startRoomStatusPolling/initGuestPrejoin below): a rate-limited or
 *     momentarily-flaky read must never be confused with "the room doesn't
 *     exist" and tear down the screen.
 */
async function fetchRoomStatus() {
  try {
    // Via window.API_BASE (see static/config.js) — same split-origin
    // reasoning as fetchVersion/restoreRoomViaPut above.
    const res = await fetch(`${window.API_BASE}/api/rooms/${encodeURIComponent(roomId)}`);
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (!res.ok) return { ok: false, reason: 'other' };
    const data = await res.json();
    if (
      !data ||
      typeof data.participants !== 'number' ||
      typeof data.capacity !== 'number' ||
      typeof data.ageSeconds !== 'number'
    ) {
      return { ok: false, reason: 'other' };
    }
    return { ok: true, participants: data.participants, capacity: data.capacity, ageSeconds: data.ageSeconds };
  } catch (err) {
    return { ok: false, reason: 'other' };
  }
}

/** `just now` / `1 minute ago` / `7 minutes ago` / `1 hour ago` / `2 hours ago` — see the pre-join card spec, "Guest-only: room status". */
function humanizeRoomAge(ageSeconds) {
  if (ageSeconds < 60) return 'just now';
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

function renderPrejoinRoomMeta(participants, ageSeconds) {
  const peopleText = participants === 1 ? '1 person' : `${participants} people`;
  prejoinRoomMetaTextEl.textContent = `${peopleText} · started ${humanizeRoomAge(ageSeconds)}`;
  prejoinRoomMetaEl.classList.remove('hidden');
}

/** Guest pre-join, GET /api/rooms/<id> came back 404 — the room is gone (deleted/reaped) before the guest ever got to join. A DIFFERENT check from signaling.on('room-not-found') below (that one fires from a real join-room attempt, after this screen); reuses the same overlay/terminalState machinery, just with wording that doesn't presuppose a join was ever attempted. */
function showPrejoinRoomGoneOverlay() {
  stopPrejoinMediaOnAbort();
  hidePrejoinCard();
  terminalState = true;
  showOverlay({
    title: 'Room not found',
    text: 'This room has already ended.',
    actionLabel: 'Create a new one',
  });
}

/** Guest pre-join, GET /api/rooms/<id> reports participants >= capacity — deliberately no numbers in the text (spec), unlike signaling.on('room-full') below (a different, later check, once an actual join-room was rejected). */
function showPrejoinRoomFullOverlay() {
  stopPrejoinMediaOnAbort();
  hidePrejoinCard();
  terminalState = true;
  showOverlay({
    title: 'Room is full',
    text: 'Try again in a minute.',
  });
}

/** Every 5s while the guest's pre-join card is open — stopped on submit or when the card is hidden (see hidePrejoinCard). A failed/rate-limited tick keeps the last known numbers on screen and just tries again next time (see fetchRoomStatus). */
function startRoomStatusPolling() {
  stopRoomStatusPolling();
  roomStatusPollTimer = setInterval(async () => {
    const status = await fetchRoomStatus();
    if (!prejoinCardOpen) return; // the card was hidden/submitted while this fetch was in flight
    if (!status.ok) {
      if (status.reason === 'not-found') showPrejoinRoomGoneOverlay();
      return; // 'other' (429/network/etc.) — never break the screen, just skip this tick
    }
    if (status.participants >= status.capacity) {
      showPrejoinRoomFullOverlay();
      return;
    }
    renderPrejoinRoomMeta(status.participants, status.ageSeconds);
  }, 5000);
}

function stopRoomStatusPolling() {
  if (roomStatusPollTimer) {
    clearInterval(roomStatusPollTimer);
    roomStatusPollTimer = null;
  }
}

/** Guest entry point (see init below): the FIRST status check gates whether the card is even shown — 404/full replace it outright (see showPrejoinRoomGoneOverlay/showPrejoinRoomFullOverlay); anything else (including a flaky first read) shows the card anyway, with the meta line simply staying hidden until the next successful poll tick. */
async function initGuestPrejoin() {
  const status = await fetchRoomStatus();
  if (!status.ok && status.reason === 'not-found') {
    showPrejoinRoomGoneOverlay();
    return;
  }
  if (status.ok && status.participants >= status.capacity) {
    showPrejoinRoomFullOverlay();
    return;
  }
  showPrejoinCard();
  if (status.ok) renderPrejoinRoomMeta(status.participants, status.ageSeconds);
  startRoomStatusPolling();
}

function showPrejoinCard() {
  prejoinCardOpen = true;
  joinModalEl.classList.remove('hidden');
  prejoinEyebrowEl.textContent = isCreator ? 'Start the room' : 'Join the room';
  joinModalButtonEl.textContent = isCreator ? 'Start' : 'Join';

  prejoinRoomNameEditableEl.classList.toggle('hidden', !isCreator);
  prejoinRoomNameStaticEl.classList.toggle('hidden', isCreator);
  if (isCreator) {
    // Prefilled with a generated name (see static/namegen.js: roomName()) —
    // click "Start" and that's it, no need to type; the regen button (see
    // prejoinRoomNameRegenEl below) rolls a new one on demand.
    if (!prejoinRoomNameInputEl.value) prejoinRoomNameInputEl.value = NameGen.roomName();
  } else {
    // currentRoomName comes from the invite link's `n` (see the
    // fragment-parsing IIFE at the top of the file) — absent only for a
    // link shared before the creator ever set a name, which per this
    // redesign shouldn't normally happen, but a manually-edited/older link
    // is still handled gracefully with the plain word "Room".
    prejoinRoomTitleEl.textContent = currentRoomName || 'Room';
    prejoinRoomMetaEl.classList.add('hidden'); // shown once the first status fetch resolves (see renderPrejoinRoomMeta)
  }

  // Avatar gradient: derived from OUR OWN peerId, already generated in
  // initCryptoIdentity before this screen is ever shown — see
  // avatarGradientCss for why this ends up matching the real own tile.
  prejoinAvatarEl.style.background = avatarGradientCss(myPeerId);

  // Pre-filled with a generated name (see static/namegen.js: userName()),
  // same as the old join-modal (kept: click "Start"/"Join" and that's it).
  // The user can clear the field → stays anonymous, as before
  // (onPrejoinSubmit: trim() + `|| null`).
  if (!joinNameInputEl.value) joinNameInputEl.value = NameGen.userName();
  updatePrejoinPreviewMode(); // mic/camera are still Off for everyone at this point — sets the initial avatar+pill

  // Device defaults (spec, "Device defaults and permissions"): the creator
  // gets Off/Off with NO getUserMedia call on this screen at all (just
  // enumerateDevices() below, which never prompts); the guest gets a
  // single combined getUserMedia (see acquireGuestPrejoinMedia).
  refreshDeviceLists();
  if (!isCreator) acquireGuestPrejoinMedia();

  // The name field is NOT focused/selected by default (same reasoning as
  // the old join-modal: the generated name shouldn't come up
  // active/highlighted, and a phone shouldn't pop the keyboard on open) —
  // the Start/Join button is the default action instead (Enter on the name
  // field submits, see joinNameInputEl's keydown listener below).
  joinModalButtonEl.focus();
}

/**
 * Swap the pre-join card between its normal interactive state (mic/camera
 * rows, the name field, the Start/Join button) and the lobby "waiting for
 * approval" state (see signaling.on('waiting') below and task item 3) —
 * the header (eyebrow/room name/meta) and the live preview are deliberately
 * untouched by either state: they're the whole reason the guest stays on
 * this SAME card instead of being sent to a full-screen overlay while
 * waiting (their camera/mic keep streaming underneath, see
 * onPrejoinSubmit — nothing here re-acquires micStream/camStream).
 */
function setPrejoinWaitingMode(waiting) {
  prejoinMicRowEl.classList.toggle('hidden', waiting);
  prejoinCamRowEl.classList.toggle('hidden', waiting);
  prejoinNameFieldEl.classList.toggle('hidden', waiting);
  joinModalButtonEl.classList.toggle('hidden', waiting);
  prejoinWaitingEl.classList.toggle('hidden', !waiting);
}

function hidePrejoinCard() {
  prejoinCardOpen = false;
  stopRoomStatusPolling();
  // Undo the lobby waiting state (see setPrejoinWaitingMode/
  // signaling.on('waiting')) in case we're leaving FROM there (the leader
  // just approved us) — a harmless no-op on the direct-join path, where it
  // was never turned on to begin with.
  setPrejoinWaitingMode(false);
  joinModalEl.classList.add('hidden');
}

// Lobby "Cancel" (see signaling.on('waiting') below) — leave + go home, the
// same trick as leaveButton far below: set intentionalDisconnect BEFORE
// sending 'leave' so the resulting signaling close doesn't trigger
// auto-reconnect (see connectAndJoin/signaling.onClose).
prejoinWaitingCancelEl.addEventListener('click', () => {
  intentionalDisconnect = true;
  if (signaling) signaling.send('leave');
  location.href = '/';
});

let joinSubmitInProgress = false;

async function onPrejoinSubmit() {
  if (joinSubmitInProgress) return;
  joinSubmitInProgress = true;
  // A click is a user gesture, also useful for AudioContext (see
  // static/common.js: SpeakingDetection tries to resume the AudioContext
  // on click/keydown).
  const raw = joinNameInputEl.value.trim();
  myName = raw || null;

  if (isCreator) {
    currentRoomName = cleanRoomNameInput(prejoinRoomNameInputEl.value);
    renderRoomNameChrome();
    writeRoomNameToFragment();
  }

  hidePrejoinCard();
  // NOTE: mic/camera are NOT (re-)acquired here — whatever this screen left
  // us with (micStream/micTrack/camStream/camTrack, applied live via
  // applyMicStream/applyCameraStream as the user interacted with the
  // selects above) is handed to the call as-is; see the "reflect pre-join
  // media" block in signaling.on('joined') below for how the toolbar/tile
  // pick up that state on the very first frame.
  await connectAndJoin();
}

joinModalButtonEl.addEventListener('click', onPrejoinSubmit);
joinNameInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    onPrejoinSubmit();
  }
});
joinNameInputEl.addEventListener('input', updatePrejoinNamePill);

// The "regenerate" button next to the name field — rolls a new
// NameGen.userName(). Does NOT focus/select the field, consistent with
// showPrejoinCard not activating it either.
joinNameRegenButtonEl.addEventListener('click', () => {
  joinNameInputEl.value = NameGen.userName();
  updatePrejoinNamePill();
});

// Creator only (hidden for a guest, see showPrejoinCard) — same pattern as
// the "Your name" field/regen button above, one level up: a fresh
// NameGen.roomName(), and Enter here submits the card too.
prejoinRoomNameRegenEl.addEventListener('click', () => {
  prejoinRoomNameInputEl.value = NameGen.roomName();
});
prejoinRoomNameInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    onPrejoinSubmit();
  }
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

  // Creator vs guest (see the pre-join card spec): a one-time leaderToken
  // (#lt, see the fragment-parsing IIFE at the top of the file) is only
  // ever present for the tab that just created the room via POST
  // /api/rooms — everyone else arrived through a plain invite link.
  isCreator = !!initialLeaderToken;

  // Anonymity (see docs/privacy.md, "Anonymity"): the name is asked again
  // on EVERY visit via this card — no localStorage at all. join-room is
  // only sent after clicking Start/Join (see onPrejoinSubmit). On
  // auto-reconnect the card isn't shown again — the name is already in the
  // tab's memory (myName), see attemptReconnectOnce/sendJoinAndWait below.
  if (isCreator) {
    showPrejoinCard();
  } else {
    // The guest path additionally gates on room status BEFORE showing
    // anything (see initGuestPrejoin) — the creator skips this entirely
    // (see the comment on the guest-only room-status section above).
    await initGuestPrejoin();
  }
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
      // The pre-join card may currently be showing the lobby "waiting for
      // approval" sub-state (see signaling.on('waiting') below) if we just
      // got approved — tear it down the same way the direct-join path
      // already does in onPrejoinSubmit (hidePrejoinCard is idempotent, so
      // this is a harmless no-op there).
      hidePrejoinCard();

      ownTile = createTile(peerId, myName, true);

      // Reflect whatever the pre-join card already turned on (see
      // onPrejoinSubmit/acquireGuestPrejoinMedia/switchPrejoinMic/
      // switchPrejoinCamera) — by this point micTrack/camTrack, if set at
      // all, are the SAME stream/track objects the preview was already
      // using: never re-acquired here (a second getUserMedia would
      // re-prompt, be slow, and on iOS can even kill the first stream —
      // see applyMicStream/applyCameraStream above). The toolbar buttons
      // are already correct (applyMicStream/applyCameraStream set them the
      // moment the stream was applied, before we even got here) — what
      // COULDN'T happen yet is anything that needed ownTile, which comes
      // into existence only right above.
      if (micTrack) updateOwnMicIndicator();
      if (camTrack) {
        ownTile.videoEl.srcObject = camStream;
        safePlay(ownTile.videoEl);
        setTileVideoVisible(ownTile, camTrack.enabled);
      }

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

      // Task item 2: auto-open the invite popup for the CREATOR's very
      // first entry into their own (necessarily empty) room — gated on
      // isCreator (set in init() from the one-time #lt fragment token, see
      // initialLeaderToken at the top of the file), NOT on room occupancy —
      // a guest who happens to be alone must not get this, and isCreator
      // can only be true here on THIS exact first `joined` anyway: `lt` is
      // wiped from the address bar after the very first parse, so a later
      // reload of the same room never sets it again. shareAutoOpenedForCreator
      // (see its declaration) is a single-shot latch on top of that.
      if (isCreator && !shareAutoOpenedForCreator) {
        shareAutoOpenedForCreator = true;
        openSharePopup();
      }
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
    // leader's decision. E2E v2: as soon as the leader's epub is known, we
    // announce our own name to them (if it's not empty), see
    // sendNameAnnounceTo. The server sends a FRESH `waiting` when the leader
    // changes while we're waiting (see src/ws.rs) — this handler fires again
    // and resends the announcement to the new leader; it's otherwise
    // idempotent (see setPrejoinWaitingMode — just toggling classes/text, no
    // duplicate side effects beyond cachePairKeys/sendNameAnnounceTo, which
    // are themselves idempotent).
    //
    // Task item 3: unlike before, we do NOT show the full-screen #overlay
    // here — the guest stays on the SAME pre-join card they just submitted
    // (hidden a moment ago by hidePrejoinCard() in onPrejoinSubmit), header
    // and LIVE camera/mic preview untouched underneath (nothing here
    // re-acquires micStream/camStream — see onPrejoinSubmit/
    // updatePrejoinPreviewMode), with only the interactive controls swapped
    // for a waiting block (see setPrejoinWaitingMode). hideOverlay() clears
    // the brief "Connecting…" overlay connectAndJoin showed a moment ago —
    // a harmless no-op if it's already hidden (e.g. on a second `waiting`
    // for the same still-pending guest).
    cachePairKeys(leaderPeerId, leaderEpub);
    sendNameAnnounceTo(leaderPeerId);
    hideOverlay();
    joinModalEl.classList.remove('hidden');
    prejoinWaitingTextEl.textContent = myName ? `You joined as “${myName}”.` : 'The room leader will let you in.';
    setPrejoinWaitingMode(true);
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
    // The guest was almost certainly on the pre-join card's lobby waiting
    // sub-state when this arrives (see signaling.on('waiting') above) —
    // #join-modal sits ABOVE #overlay (z-index 55 vs. 50, see
    // static/style.css), so showOverlay() below would otherwise render
    // completely hidden behind it. stopPrejoinMediaOnAbort releases the
    // waiting preview's camera/mic — the call never proceeds past a
    // rejection, so there's no reason to keep the hardware open behind this
    // terminal overlay (same reasoning as showPrejoinRoomGoneOverlay/
    // showPrejoinRoomFullOverlay above).
    stopPrejoinMediaOnAbort();
    hidePrejoinCard();
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
    // As the comment above notes, this can arrive while a guest is still on
    // the pre-join card's lobby waiting sub-state (see signaling.on('waiting'))
    // — #join-modal sits ABOVE #overlay (z-index 55 vs. 50, see
    // static/style.css), so showOverlay() below would otherwise be
    // completely hidden behind it. A harmless no-op if we're past that
    // point already (hidePrejoinCard is idempotent, teardownMeshMediaChat
    // below stops micTrack/camTrack regardless of whether the card is
    // still open).
    hidePrejoinCard();
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

/**
 * Acquire a fresh microphone-only stream for `deviceId` (null = whatever
 * the browser/OS treats as the default device) — no side effects beyond
 * the permission prompt itself. Throws on failure (NotAllowedError,
 * NotFoundError, …) — every caller decides for itself how loudly to react:
 * micButton's click (below) shows a room message, the pre-join card's
 * device select (see switchPrejoinMic in the "Pre-join card" section) just
 * logs a warning and falls back to Off.
 */
async function acquireMicStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
}

/**
 * Make `stream` our own outgoing microphone: remembers stream/track/
 * deviceId, sets the enabled flag, and updates the toolbar button + our own
 * tile's mic-off indicator (a no-op via updateOwnMicIndicator/
 * setTileMicOffIndicator if ownTile doesn't exist yet — see the pre-join
 * card, where there's no tile at all until 'joined' arrives). Adding the
 * track to already-connected peers (broadcastLocalStream) only matters
 * mid-call (turning the mic on for the first time after already having
 * joined, when `peers` is non-empty); called from the pre-join card
 * (`peers` is always empty there) it's a harmless no-op — createRemotePeer
 * picks up micStream/micTrack on its own the moment we actually join (see
 * there).
 *
 * Split out of micButton's click handler (which used to both acquire AND
 * apply in one go) precisely so the pre-join card can hand over the SAME
 * stream it already acquired for the live preview instead of calling
 * getUserMedia a SECOND time (see onPrejoinSubmit) — a second prompt would
 * be slow/jarring, and on iOS can even kill the first stream outright.
 */
function applyMicStream(stream, enabledValue) {
  micStream = stream;
  micTrack = stream.getAudioTracks()[0];
  micTrack.enabled = enabledValue;
  currentMicDeviceId = selectedMicDeviceId;
  broadcastLocalStream(stream, 'mic');
  setMicButtonOn(enabledValue);
  updateOwnMicIndicator();
}

micButton.addEventListener('click', async () => {
  if (micRequestInProgress) return;

  if (!micTrack) {
    micRequestInProgress = true;
    let stream;
    try {
      stream = await acquireMicStream(selectedMicDeviceId);
    } catch (err) {
      console.warn('Microphone access denied:', err);
      showRoomMessage('Could not access the microphone.');
      micRequestInProgress = false;
      return;
    }
    micRequestInProgress = false;
    applyMicStream(stream, true);
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

/** Acquire a fresh camera-only stream for `deviceId` — see acquireMicStream above, the same split and the same reasoning, just for video. */
async function acquireCameraStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({ video: cameraConstraintsFor(deviceId) });
}

/**
 * Make `stream` our own outgoing camera — see applyMicStream above for the
 * full reasoning (split out of cameraButton's click handler so the
 * pre-join card can hand over the stream it already acquired for the live
 * preview, see onPrejoinSubmit). `ownTile` doesn't exist yet on the
 * pre-join card (created only once 'joined' arrives) — the video-element
 * wiring below is skipped in that case and instead applied retroactively
 * right after createTile (see signaling.on('joined')).
 */
function applyCameraStream(stream, enabledValue) {
  camStream = stream;
  camTrack = stream.getVideoTracks()[0];
  camTrack.enabled = enabledValue;
  currentCamDeviceId = selectedCamDeviceId;
  broadcastLocalStream(stream, 'camera');
  if (ownTile) {
    ownTile.videoEl.srcObject = stream;
    safePlay(ownTile.videoEl);
    setTileVideoVisible(ownTile, enabledValue);
  }
  setCameraButtonOn(enabledValue);
}

cameraButton.addEventListener('click', async () => {
  if (camRequestInProgress) return;

  if (!camTrack) {
    camRequestInProgress = true;
    let stream;
    try {
      stream = await acquireCameraStream(selectedCamDeviceId);
    } catch (err) {
      console.warn('Camera access denied:', err);
      showRoomMessage('Could not access the camera.');
      camRequestInProgress = false;
      return;
    }
    camRequestInProgress = false;
    applyCameraStream(stream, true);
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
 * lt. `n` is added only if the room name is known (currentRoomName — for
 * the creator this is only set once they've submitted the pre-join card,
 * see onPrejoinSubmit/writeRoomNameToFragment; a guest already has it from
 * the invite link they followed) — this way the room name travels in the
 * invite link and becomes visible to everyone who follows it (see
 * renderRoomNameChrome and the fragment parsing above); the server still
 * won't see this name — the fragment never goes to the server. Everyone who
 * joins via this link authenticates with the SAME `t`/`e` (as before with
 * `k`), but each derives THEIR OWN pairwise keys (see static/crypto.js).
 */
function buildShareLink() {
  const namePart = currentRoomName ? `&n=${encodeURIComponent(currentRoomName)}` : '';
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

/**
 * The room's own name (task item 1), WITH its leading emoji exactly as
 * currentRoomName carries it — never re-derived/stripped here, this is a
 * headline next to the eyebrow, not an avatar-adjacent pill (compare
 * tileDisplayName, which DOES strip it, for the tiles/pre-join preview).
 * Hidden ENTIRELY (not a placeholder like "Room") when the room doesn't
 * have a name yet — a link shared before the creator ever set one, or a
 * malformed `n` (see the fragment-parsing IIFE at the top of the file).
 */
function renderShareRoomName() {
  if (!currentRoomName) {
    sharePopupRoomNameEl.classList.add('hidden');
    sharePopupRoomNameEl.textContent = '';
    return;
  }
  sharePopupRoomNameEl.textContent = currentRoomName;
  sharePopupRoomNameEl.classList.remove('hidden');
}

function openSharePopup() {
  const link = buildShareLink();
  renderShareRoomName();
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

// The native Web Share API (see shareApiSupported above — the button is
// hidden entirely when it's absent, so this listener is harmless dead code
// in that case, never actually reachable by a click). Same link as
// Copy/the QR — nothing beyond it is shared (no room name-as-text, no extra
// metadata) other than `title`, which only appears in the OS share sheet
// UI, never in the room link itself. A user dismissing the native sheet
// rejects the promise with an AbortError — that's a normal cancel, not a
// failure, and is swallowed silently; anything else is logged for
// debugging but doesn't surface in the UI (there's no good terminal state
// to show for "the OS share sheet failed").
sharePopupShareButtonEl.addEventListener('click', async () => {
  try {
    await navigator.share({ title: currentRoomName || 'Video call', url: buildShareLink() });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.warn('navigator.share failed:', err);
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
