// landing.js — logic of the main page: room creation.
//
// Anonymity: no localStorage/sessionStorage/cookies anywhere on this
// page. The participant's name is no longer asked here at all — it will be
// asked by the join modal in the room itself (see static/room.js), freshly
// on EVERY visit, not just once here. `POST /api/rooms` returns {roomId,
// leaderToken} — we put leaderToken in the link fragment (#lt=...), not in
// the path and not in the query: the fragment never goes to the server
// either during normal browser navigation or in the Referer — the token
// only reaches room.js on this same page (see there — it's read and
// immediately wiped from the address bar via history.replaceState, before
// anything else is shown).
//
// E2E v2 ("variant E", see docs/research-p2p-key-handoff.md §6.5-6.6 and
// static/crypto.js): right here, next to leaderToken, TWO parameters of the
// new fragment are generated —
//   - `t` — the static PSK token (16 random bytes, base64url,
//     RoomCrypto.generateRoomToken()). It NEVER encrypts traffic by itself —
//     it only authenticates the ephemeral pairwise keys that each tab
//     derives ITSELF on join (see static/room.js, static/crypto.js).
//   - `e` — the link's expiry moment, unix seconds in base36:
//     `floor(Date.now()/1000) + lifetimeSeconds + 300`. `lifetimeSeconds`
//     is taken from the `POST /api/rooms` response (the same
//     `MAX_ROOM_LIFETIME_SECONDS` that the server actually uses to limit
//     the room's lifetime — see src/main.rs); if the field is missing from
//     the response for some reason (old server) — fallback to 10800 (3h).
//     +300 — 5 minutes of margin on top of the server limit in case the
//     client's and server's clocks are out of sync (see static/room.js —
//     the comparison happens there, on join, with the same margin). `e` is
//     baked into the K_auth derivation (see static/crypto.js:
//     deriveAuthKey) — it cannot be forged/extended without `t`.
// The `k` key no longer exists — the whole room now has no single shared
// encryption secret at all, only PSK authentication + PFS (see
// static/crypto.js). room.js parses `t`/`e` (and `n` below) together from
// the fragment.
//
// The fourth (optional) fragment parameter — `n` — is the room name entered
// into #room-name-input (prefilled with NameGen.roomName(), see
// static/namegen.js; freely editable). This name is seen by ALL room
// participants, not just the creator: it is placed as the LAST parameter of
// the same fragment (#lt=...&t=...&e=...&n=...), but unlike the one-time
// `lt`, `n` is NOT wiped from the address bar — room.js reassembles the
// fragment as `#t=...&e=...&n=...` (see there) and puts `n` into
// buildShareLink() the same way, so the invite link carries the room name
// and any guest who joins via it sees it in the top bar/tab title — and it
// survives F5. The server never sees `n` either, just like `t`/`e`: the
// fragment never goes to the server, neither during normal navigation nor
// in the Referer.

'use strict';

const createButton = document.getElementById('create-room-button');
const messageEl = document.getElementById('landing-message');
const buildFooterEl = document.getElementById('landing-build-footer');
const buildShortEl = document.getElementById('landing-build-short');
const buildFullEl = document.getElementById('landing-build-full');
const roomNameInputEl = document.getElementById('room-name-input');
const roomNameRegenButtonEl = document.getElementById('room-name-regen-button');

// Prefill with a nice generated name (see static/namegen.js) — the user can
// just stick with it (simply click Create room), or erase/edit it before
// creating the room.
roomNameInputEl.value = NameGen.roomName();

// The "regenerate" button next to the input just rerolls a new room name
// (see static/namegen.js: roomName()). type="button" in the markup — the
// click doesn't submit anything (there's no form here anyway, but explicit
// just in case).
roomNameRegenButtonEl.addEventListener('click', () => {
  roomNameInputEl.value = NameGen.roomName();
});

function showMessage(text, isError = true) {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  showMessage('');

  try {
    // Step 2: via window.API_BASE (see static/config.js) — on Cloudflare
    // Pages the front-end and the API live on different hosts, a
    // same-origin '/api/rooms' would hit the Pages host itself, where no
    // such path exists.
    const res = await fetch(`${window.API_BASE}/api/rooms`, { method: 'POST' });
    if (!res.ok) throw new Error(`server responded with status ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.roomId !== 'string' || !data.roomId) {
      throw new Error('response is missing roomId');
    }
    if (typeof data.leaderToken !== 'string' || !data.leaderToken) {
      throw new Error('response is missing leaderToken');
    }

    // E2E v2: `t` — the link's static PSK token, `e` — the expiry moment in
    // base36 (see the file header comment and static/crypto.js:
    // deriveAuthKey). Fallback of 10800s (3h) if the server for some reason
    // didn't send lifetimeSeconds (see src/main.rs::create_room) — the same
    // default as the server itself uses (DEFAULT_MAX_ROOM_LIFETIME_SECONDS),
    // so the "Link expired" overlay on the client (see static/room.js)
    // doesn't trigger prematurely.
    const roomToken = RoomCrypto.generateRoomToken();
    const tokenB64 = RoomCrypto.bytesToBase64url(roomToken);
    const lifetimeSeconds =
      typeof data.lifetimeSeconds === 'number' && data.lifetimeSeconds > 0 ? data.lifetimeSeconds : 10800;
    const expiryB36 = (Math.floor(Date.now() / 1000) + lifetimeSeconds + 300).toString(36);

    // maxlength=40 truncates by UTF-16 code units, not by code point —
    // pasting/autocorrect can split an emoji surrogate pair in half and
    // leave a lone surrogate. toWellFormed() (where available) fixes this
    // properly; on engines without it — a manual regex cleanup of lone
    // surrogates (a high surrogate not followed by a low one / a low
    // surrogate not preceded by a high one).
    const rawRoomName = roomNameInputEl.value.trim();
    const roomName = rawRoomName
      ? (typeof rawRoomName.toWellFormed === 'function'
          ? rawRoomName.toWellFormed()
          : rawRoomName.replace(
              /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
              '$1',
            ))
      : '';

    location.href =
      `/r/${data.roomId}#lt=${encodeURIComponent(data.leaderToken)}&t=${tokenB64}&e=${expiryB36}` +
      (roomName ? `&n=${encodeURIComponent(roomName)}` : '');
  } catch (err) {
    console.error('Failed to create room:', err);
    showMessage('Failed to create room. Check your connection and try again.');
    createButton.disabled = false;
  }
});

// --- Build hash of the published static assets (forensic anchor, see
// docs/security.md, "Published Build Hash") ---
//
// /build-hash.json sits RIGHT NEXT to the page — bundle root on Cloudflare
// Pages (see .github/workflows/deploy-prod.yml, job deploy-pages),
// same-origin fetch, no window.API_BASE at all. In the dev/self-hosted
// build the file doesn't exist at all (the server returns 404 — there's
// simply no such route, see src/main.rs) — then the footer stays silently
// hidden, nothing breaks.
// The hash lives only in the tab's memory (a plain variable, no
// localStorage/sessionStorage — this doesn't break the page's anonymity,
// the value isn't tied to the user).
//
// IMPORTANT: the hash is NOT a cryptographic guarantee (see
// docs/security.md, §10.4) — the static asset host could in theory tamper
// with build-hash.json itself too. The real verification is against the
// GitHub Release (the "verify" link below), not against what this same
// page displays.
async function loadBuildHash() {
  try {
    const res = await fetch('/build-hash.json');
    if (!res.ok) return; // dev/self-hosted without build-hash.json — expected, footer stays hidden
    const data = await res.json();
    if (!data || typeof data.hash !== 'string' || !data.hash) return;
    buildShortEl.textContent = `${data.hash.slice(0, 10)}…`;
    buildFullEl.textContent = data.hash;
    buildFooterEl.title = data.hash;
    buildFooterEl.classList.remove('hidden');
  } catch (err) {
    // Network/parsing — silent: this is an unobtrusive indicator, not a critical part of the UI.
    console.warn('Failed to load build-hash.json:', err);
  }
}

loadBuildHash();
