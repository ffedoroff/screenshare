// chat.js — room text chat panel (Wave 1: chat over mesh RTCDataChannel;
// Wave 2: text formatting, replies and reactions — see below).
//
// Transport: ONLY the P2P bus (see bus.js/rtc.js) — broadcasting the envelope to all
// peers with an open DataChannel. There is NO server-side chat relay: for peers whose
// channel isn't open yet, the envelope waits in a local queue and goes out over the bus once it
// opens (see sendEnvelopeToPeer/notifyBusOpen). See docs/chat.md §12.
//
// Encryption: the envelope goes out over the bus AS IS — the P2P DataChannel is already E2E
// thanks to DTLS (see static/crypto.js, docs/e2e-encryption.md §3.2). Chat has no
// application-level encryption layer and doesn't need one; K_chat and content epochs (Wave 3) were
// only needed for the former server-side fallback path and were removed along with it.
//
// Message envelope (EXTENSIBLE — extensions from future waves must land without
// breaking the format):
//   { v: 1, id, lamport, from, name, kind: 'text', text, replyTo, ts }
// `replyTo` — id of the message being replied to (null if not a reply).
// `ts` — client-side creation time (ms, Date.now()); this field is not part of the
// protocol minimum, added on top of it purely for displaying
// time in the feed (the same function the server-side ts used to serve) — the server
// doesn't touch it, it's a purely client-side extension inside an envelope already
// opaque to the server.
//
// Reactions (Wave 2) — a separate kind, same transport (broadcast over the bus),
// same shared history buffer as text messages:
//   { v: 1, id, lamport, from, name, kind: 'reaction', target, emoji, op, ts }
// `target` — id of the message the reaction refers to; `emoji` — one of a
// fixed set (see REACTION_EMOJIS); `op` — 'add'|'remove'
// (clicking your own reaction again sends 'remove' — a toggle on the
// sender's side, applied identically for everyone based on (lamport, from)).
//
// Service kinds of this phase: 'history-request' (no extra fields) and
// 'history-response' { messages: [envelopes] }. An unknown kind is silently
// ignored (forward-compat). The history buffer (see HISTORY_CAP) stores
// text and reaction envelopes interleaved — reaction state (map msgId ->
// emoji -> Set<peerId>) is always recomputed from scratch over the whole buffer in
// (lamport, from) order, so the result doesn't depend on network delivery
// order (see recomputeReactions).
//
// Editing and deletion — using the same approach (derived state,
// recomputed from the buffer), the same shared history buffer/transport:
//   { v: 1, id, lamport, from, name, kind: 'edit', target, text, ts }
//   { v: 1, id, lamport, from, name, kind: 'delete', target, ts }
// `target` — id of the message (text or file-offer) being edited/deleted.
// The envelope is applied ONLY IF envelope.from matches the `from` of
// the original message (otherwise it's silently ignored — see
// recomputeMessageMeta); the original is looked up in the same `messages` buffer, so
// if it has already been evicted from HISTORY_CAP, authorship can't be verified and the edit/
// delete are likewise ignored (safe default). 'edit' only applies to
// kind='text' (file-offer has no text, nothing to edit). For multiple
// edit envelopes on the same target — the last one in (lamport,
// from) order wins, since `messages` is already sorted by this same comparator and the recompute
// simply proceeds in order, overwriting the previous value (the same technique
// as in recomputeReactions). 'delete' on a target is a final state:
// once a valid delete has been applied, SUBSEQUENT edits (with a higher lamport)
// on the same target no longer apply — deletion is not undone by them.
// edit/delete envelopes are stored in the same 50-slot shared buffer alongside text/reaction/
// file-offer and likewise go out to a latecomer in history-response —
// the latecomer recomputes the same messageOverlays over the whole replay and
// therefore immediately sees the final state (the edited text or a
// tombstone), not the original.
//
// File transfer (Wave 3) — strictly P2P, the server never sees the file bytes:
//   { v: 1, id, lamport, from, name, kind: 'file-offer', fileId, fileName,
//     size, mime, ts }
// The offer is a regular envelope over the same transport (broadcast over the bus)
// and in the same shared history buffer as text/reaction
// — a latecomer sees the file card from the history replay just like a
// historical text message (see mergeHistory). The file itself (the File object)
// lives only on the sender's side, in the tab's memory (fileSendMap: fileId -> File)
// — the server and the history buffer carry only metadata, not content.
// The sender's own card is 'done' immediately: since the File is already fully in our
// possession (fileSendMap), there's no reason to wait for any P2P exchange for our own
// preview/download — the objectUrl is created from this same File locally, synchronously,
// in handleFilesSelected (unlike the receiver, who only gets the objectUrl
// in beginReceivingFile.onclose, after the actual byte transfer over a
// separate channel, see below). Delivery statuses ('sending'/'sent' from
// beginSendingFile, one delivery per requesting receiver) don't affect
// this already-ready card state — see renderFileCardBody, where the
// check is based on the presence of objectUrl, not the current status.
//
// To actually download the file, the receiver sends an ADDRESSED (not broadcast)
// envelope to the sender:
//   { v: 1, id, lamport, from, name, kind: 'file-request', fileId, ts }
// This kind never lands in the history buffer (transient, like
// history-request/response). Upon receiving it, the sender (if still holding the File
// with that fileId) opens a SEPARATE DataChannel on the existing
// RTCPeerConnection for that pair — pc.createDataChannel(`file-${fileId}-${to}`)
// — the receiver catches it via pc.ondatachannel by an exact label match
// (see RtcPeer.createFileChannel/onFileChannel in rtc.js). The first message on the
// channel is JSON metadata { fileId, size, mime, name }, followed by binary chunks
// of FILE_CHUNK_SIZE bytes (ArrayBuffer), with backpressure based on bufferedAmount;
// the sender closes the channel upon completion, the receiver assembles a Blob and
// verifies the final size. An offer with no P2P channel to the sender (the channel didn't
// open, or the sender has already left) — the card honestly shows
// unavailability instead of attempting to download via the server (the server never
// shuttles file bytes — see handleFileRequest/requestFileDownload/beginSendingFile/
// beginReceivingFile below).
//
// Lamport clock: on send — own counter +1; on receive — max(own,
// received)+1. Order in the feed — sorted by (lamport, from), so it's
// the same for all participants regardless of network delivery order.
//
// Own message is rendered immediately, locally (optimistically, without waiting
// for an echo — there's no echo from the server anymore, the whole path is P2P).
//
// History: a buffer of the last 50 envelopes (text+reaction) in the tab's memory (not
// persistent, lives until the page is closed/reloaded). A newcomer, after
// joined, requests history from the first peer in joined.peers; if within 3s the channel
// to it hasn't opened or there's no response — tries the next one. An empty room
// (nobody in joined.peers) — empty history, nobody to ask.
//
// Rate limit — client-side, soft: no more than 10 messages per 10s, blocks
// sending with a message in the panel. There is no server-side rate limit for chat — the
// server doesn't see the chat. Reactions aren't limited by this — they're lightweight
// toggle events, not full messages.
//
// Text formatting (kind=text) — see renderMessageBody/appendInlineNodes
// below (Wave 4, Telegram-like syntax, double markers): **bold**,
// __italic__ AND *italic* (both forms), ~~strikethrough~~, ||spoiler|| (blur,
// revealed on click/Enter/Space — .revealed class), `inline code` (not
// parsed further), triple backticks ```[lang]\n...\n``` — code block
// (<pre><code>, language label, "copy" button, also not
// parsed inside), "> " at the start of a line — blockquote (already existed), http(s) links
// and named [text](url) links are clickable without preview cards — no
// network requests on link click, for the sake of privacy. Nesting — where meaningful
// (formatting inside a quote and inside a spoiler — both recursively run
// their content through appendInlineNodes), but NOT inside inline code/code block
// (code is code). CRITICAL: rendering builds DOM nodes via
// createElement/textContent — no innerHTML with user-supplied data
// anywhere in this file (innerHTML is used only for static markup not
// dependent on user input — the panel itself and the reactions
// popup). Desktop hotkeys for these same markers — see
// wrapSelectionWithMarkers/handleFormattingShortcut below (Cmd/Ctrl+B/I,
// Cmd/Ctrl+Shift+X/P/M/K); mobile toolbar on selection — a future wave,
// not here.
//
// Replies — the "Reply" item in the message action popup (see the header below,
// the section on the popup) opens a compact bar above the input; sending puts
// replyTo in the envelope. A message with replyTo renders a quote of the
// original above the text (name + truncated text) from the local buffer; clicking the quote —
// smooth-scrolls to the original with brief highlighting (see
// scrollToMessageAndHighlight).
//
// Message action popup (wave 13, entirely replaces the on-tap action row and
// hover buttons of past waves, both on mobile and desktop) — the
// message row in the feed carries ONLY text/time/reaction chips, no buttons.
// Click/tap on the message itself opens a single unified popup (see
// openMessagePopover/closeMessagePopover/toggleMessagePopover): on mobile
// — a bottom-sheet from the bottom of the screen, on desktop — a compact card near
// the message (see positionMessagePopoverDesktop). Inside it — the
// emoji-reaction palette (a tap sets/removes a reaction and closes the popup), a breakdown
// of "who/which/when" for reactions already placed (see buildPopoverReactionsList —
// the participant's name is derived the same way as the message caption, see
// displayName), and a list of actions (Reply/Edit[own,
// text]/Delete[own]/Copy text, see populatePopoverActions).
// Only one message can have its popup open at a time — activePopoverMsgId.
//
// The panel is a per-page singleton: the DOM is created once on the first
// ChatPanel.create() call; subsequent calls reuse the same markup but
// reset the history and rebind handlers for the new session (new
// signaling/bus/peerId — e.g. after page.reload()).
//
// Toggle button (open/close chat, unread badge) — part of the
// control pill's markup (#chat-button in room.html), not created here: its
// element is passed into ChatPanel.create({ toggleButton }) by the caller.
// The panel itself (.chat-panel) is still created and lives in body.
//
// Anonymity: there is no longer a name input field in the chat header — the name is fixed
// once per session by the room join modal (see static/room.js) and passed
// in here as the `name` parameter of ChatPanel.create()/attach(). There is no
// localStorage/sessionStorage here or anywhere in this file.
//
// Guest permissions (see docs/permissions-and-leader.md, "Chat — Cooperative
// Only"): when `guestChat=false` the input is disabled (see room.js:
// ChatPanel.setChatForbidden) and receivers ignore incoming
// 'text'/'file-offer' envelopes from NON-leaders (see dispatchEnvelope below).
// This is a COOPERATIVE safeguard (the server doesn't see the chat at all): a
// modified receiver client can ignore it and render the envelope anyway —
// that's by design, see docs/permissions-and-leader.md.
//
// H3 — identity binding: envelope.from is a SELF-ASSERTED
// field, the sender is free to put anything in it (including someone else's peerId).
// The transport (bus) nonetheless KNOWS the true sender regardless of the
// envelope's content: it's the peerId of the very RtcPeer pair whose DataChannel
// carried the message (see bus.js: _dispatch(peerId, obj), room.js:
// onBusMessage) — the `fromPeerId` arriving in dispatchEnvelope BELOW cannot be
// forged (it's not self-asserted, it's a transport-level fact).
// Without cross-checking these two sources of truth, ANY participant could send
// text/reaction/edit/delete/file-offer with envelope.from = someone else's peerId and
// render (or edit/delete someone else's message — see
// recomputeMessageMeta) under someone else's name: the rendering and edit/delete
// authorship check used envelope.from directly, with no
// cross-check against the true sender at all. The fix is NORMALIZATION, not rejection:
// dispatchEnvelope forcibly overwrites envelope.from = fromPeerId (the transport-level,
// true value) BEFORE any processing, for all kinds that carry authorship (see
// SELF_ASSERTED_FROM_KINDS below) — this way the self-asserted field physically
// cannot diverge from the truth by the time rendering or
// recomputeMessageMeta/recomputeReactions gets to it. Rejecting the envelope would be simpler, but
// normalization is more robust: it fixes the field for ALL downstream consumers
// (history, replies, "own" classification in renderMessageEl) with one change
// at a single entry point, instead of making every consumer duplicate
// the check itself.
//
// history-response is an intentional EXCEPTION to this normalization: the
// history-response envelope itself carries the `from` of the responder (this is normalized as usual —
// it's kind='history-response', not part of SELF_ASSERTED_FROM_KINDS, though it doesn't even
// need it: the authorship of the response itself is checked separately, see
// handleHistoryResponse — resolve fires only for the fromPeerId that
// WE ourselves requested, see historyResponseWaiters); but the `messages` inside it are
// someone else's historical envelopes, embedded as DATA, not as "a message from
// me": whoever answers a history-request is not their author, and
// normalizing their `from` to the responder's fromPeerId would be wrong —
// it would lose the distinction between "who responded" and "who wrote it". mergeHistory (see
// below) therefore does NOT check the authorship of embedded messages against the transport
// — this is a known, deliberate limitation of the cooperative model (whoever
// answers a history-request can technically embed a historical
// envelope with any `from`, including someone else's) — an assumption of the same kind as
// the rest of this file's cooperative safeguards (a modified client can
// lie, and the server neither sees nor verifies the P2P bytes).

'use strict';

const ChatPanel = (() => {
  const NEAR_BOTTOM_THRESHOLD = 32; // px
  const HISTORY_CAP = 50;
  const HISTORY_REQUEST_TIMEOUT_MS = 3000;
  const RATE_LIMIT_COUNT = 10;
  const RATE_LIMIT_WINDOW_MS = 10_000;
  const REPLY_PREVIEW_MAX_LEN = 60;
  const HIGHLIGHT_DURATION_MS = 1200;
  const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '😮', '😢'];
  // Input auto-grow (wave 13, "Telegram-like" requirement): the textarea
  // grows with the number of lines up to this limit, beyond that — internal scroll (see
  // autoGrowTextInput).
  const MAX_INPUT_LINES = 13;
  // Same breakpoint as in style.css (@media (max-width: 640px)) — the mobile
  // UX of wave 11 (fullscreen chat, tap-activated message actions, see
  // isMobileLayout/applyVisualViewportSizing below) switches at exactly
  // this point, so the JS state and CSS markup don't diverge at the width
  // boundary. The formatting toolbar (see updateFormatToolbarVisibility) is no
  // longer tied to this boundary — it's shared across all layouts.
  const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

  // --- File transfer (Wave 3) ---
  const FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024; // 25MB — hard per-file limit
  const FILE_CHUNK_SIZE = 16 * 1024; // 16KB per chunk
  const FILE_BUFFERED_LOW_THRESHOLD = 256 * 1024; // bufferedamountlow fires below this
  const FILE_BUFFERED_HIGH_WATERMARK = 1024 * 1024; // wait for drain if this much has accumulated
  const FILE_REQUEST_TIMEOUT_MS = 8000; // how long we wait for the file channel to open after a request

  // Static markup independent of user data — safe
  // for innerHTML (see the critical requirement on message rendering above, it
  // applies ONLY to user-supplied text).
  const REPLY_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="9 14 4 9 9 4"></polyline>
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H13"></path>
  </svg>`;

  const ATTACH_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
  </svg>`;

  // The "Copy text" action in the message popup (see buildCopyButton).
  const COPY_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`;

  // Editing/deleting own messages — buttons in .chat-message-actions
  // (see renderMessageEl/renderFileOfferEl), same SVG icon style as
  // REPLY_ICON_SVG above.
  const EDIT_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>`;
  const DELETE_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    <line x1="10" y1="11" x2="10" y2="17"></line>
    <line x1="14" y1="11" x2="14" y2="17"></line>
  </svg>`;
  // How long we wait for the second (confirming) click on the delete button before
  // reverting it back to its initial state (see buildDeleteButton).
  const DELETE_CONFIRM_MS = 3000;

  // File card icons by mime category — static markup, independent
  // of user data, safe for innerHTML.
  const FILE_ICON_IMAGE_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <path d="M21 15l-5-5L5 21"></path>
  </svg>`;
  const FILE_ICON_AUDIO_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13"></path>
    <circle cx="6" cy="18" r="3"></circle>
    <circle cx="18" cy="16" r="3"></circle>
  </svg>`;
  const FILE_ICON_VIDEO_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="23 7 16 12 23 17 23 7"></polygon>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
  </svg>`;
  const FILE_ICON_GENERIC_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>`;

  function fileIconSvgForMime(mime) {
    const m = String(mime || '');
    if (m.startsWith('image/')) return FILE_ICON_IMAGE_SVG;
    if (m.startsWith('audio/')) return FILE_ICON_AUDIO_SVG;
    if (m.startsWith('video/')) return FILE_ICON_VIDEO_SVG;
    return FILE_ICON_GENERIC_SVG;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function displayName(msg) {
    if (msg.name) return msg.name;
    const suffix = (msg.from || '').slice(-4);
    return `Guest-${suffix}`;
  }

  function truncateText(text, maxLen) {
    const str = String(text || '');
    return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
  }

  /**
   * Strip markdown markers (**bold**, __italic__/*italic*, ~~strikethrough~~,
   * ||spoiler||, `code`, ```code block```, "> " quote, [text](url)) from the text
   * for a PLAIN-TEXT preview — the reply bar above the input (startReply) and the
   * original's quote inside the message itself (buildReplyQuoteEl) don't render
   * markup (little space, compactness matters more), so markers must not "leak"
   * into them as raw asterisks. Same syntax that renderMessageBody/
   * INLINE_MD_RE render in full — here it's just marker stripping, without
   * building any DOM. A spoiler is deliberately replaced with the word "spoiler",
   * not with its (hidden) content — the preview shouldn't "spoil" it before the
   * user clicks the message itself. A code block is replaced with its own text
   * (newlines inside are collapsed to a space, same as newlines between
   * message blocks) — the preview is single-line.
   */
  function stripMarkdownForPreview(text) {
    let result = String(text || '').replace(/```[^\n`]*\n([\s\S]*?)```/g, (_, code) =>
      code.replace(/\n/g, ' ').trim()
    );
    result = result
      .split('\n')
      .map((line) => (line.startsWith('> ') ? line.slice(2) : line))
      .join(' ');
    return result
      .replace(/\|\|(?!\s)([^|]+?)(?<!\s)\|\|/g, 'spoiler')
      .replace(/`([^`]+?)`/g, '$1')
      .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, '$1')
      .replace(/__(?!\s)([^_]+?)(?<!\s)__/g, '$1')
      .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '$1')
      .replace(/\[([^\]\n]+)\]\((?:https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, '$1');
  }

  /** CSS.escape with a fallback — like in scrollToMessageAndHighlight, factored out here for reuse by file cards. */
  function escapeForSelector(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
  }

  /** Human-readable file size: "512 B", "12.3 KB", "1.4 MB" etc. */
  function humanFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
  }

  /** Human-readable duration (audio/video, from `loadedmetadata` of an already-received blob) in "M:SS" format. */
  function humanDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** uuid v4 (crypto.randomUUID is available everywhere RTCPeerConnection lives). */
  function genId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID — not cryptographically
    // strong, but here only uniqueness within the room matters, not secrecy.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Order in the feed: (lamport, from) — stable and identical for everyone. */
  function compareOrder(a, b) {
    if (a.lamport !== b.lamport) return a.lamport - b.lamport;
    if (a.from < b.from) return -1;
    if (a.from > b.from) return 1;
    return 0;
  }

  /**
   * Mobile layout right now (same breakpoint as style.css: see
   * MOBILE_BREAKPOINT_QUERY above) — used so that JS behavior
   * (tap-activated message actions, VisualViewport-based panel sizing) is
   * applied at EXACTLY the same point where CSS switches the layout to fullscreen
   * mobile view, rather than at a separate, potentially out-of-sync
   * threshold. The formatting toolbar no longer belongs here (it's shared across all
   * layouts, see updateFormatToolbarVisibility). matchMedia
   * is unavailable only in very exotic/test environments without a DOM —
   * in that case we just treat the layout as desktop (safe default: nothing
   * changes relative to the behavior before this wave).
   */
  function isMobileLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  }

  // --- Rendering the markdown subset in message text ---
  //
  // Only createElement/textContent — no innerHTML with user-supplied
  // data (see the file header). Nested inline markup — only where it's
  // meaningful: a quote (buildReplyQuoteEl/renderMessageBody) and a spoiler
  // (buildSpoilerEl) recursively run THEIR OWN content through
  // appendInlineNodes — meaning **bold** inside a "> quote" or inside a
  // ||spoiler|| is rendered in full. Inline code and code blocks are NEVER
  // run through it again (code is code, see buildCodeBlockEl).
  //
  // The order of alternatives in the regex matters: at each starting position the regex
  // tries the alternatives left to right. Inline code is checked FIRST — its
  // content must be captured whole by a single match, not carved up by
  // other markers. "**" (bold) and "__" (italic-underscore) are checked
  // before a single "*" (italic) — otherwise bold would never match.
  // A named link "[text](url)" is checked before a bare link, otherwise
  // the bare-link alternative would grab "url)" without the parens. The marker
  // character is excluded from the character class's content ([^*]/[^_]/[^~]/[^|]) —
  // this not only simplifies greediness but also prevents a lone "*" from accidentally
  // "jumping" across the boundary of an already-recognized **...**. The lookaheads/
  // lookbehinds for whitespace at the edges (*(?!\s)...(?<!\s)*) rule out the most
  // common false-positive case — a lone "*" used as multiplication/separator
  // ("5 * 3 * 2"), which doesn't form a genuine italic pair.
  const INLINE_MD_RE =
    /`([^`]+?)`|\*\*(?!\s)([^*]+?)(?<!\s)\*\*|__(?!\s)([^_]+?)(?<!\s)__|~~(?!\s)([^~]+?)(?<!\s)~~|\|\|(?!\s)([^|]+?)(?<!\s)\|\||\*(?!\s)([^*]+?)(?<!\s)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')]+)/g;

  /**
   * Parse a single line (no line breaks) into text nodes +
   * inline elements and append them to `parent`. A spoiler (see buildSpoilerEl)
   * recursively calls THIS SAME function while INSIDE the body of the current loop
   * — if the regex were a single shared object with a mutable lastIndex
   * (as it used to be), the recursive call would reset lastIndex OUT FROM UNDER
   * the outer loop, which on the next iteration would start matching again
   * from the beginning of the line and NEVER reach the end of `line` — an infinite loop
   * that freezes the tab (found empirically: clicking "Send" with a
   * message like "||spoiler||" hung the page dead). That's why here —
   * we use OUR OWN RegExp instance on every call (including recursive ones), no
   * shared mutable state between recursion levels.
   */
  function appendInlineNodes(parent, line) {
    if (line === '') return;
    const inlineRe = new RegExp(INLINE_MD_RE.source, 'g');
    let lastIndex = 0;
    let match;
    while ((match = inlineRe.exec(line))) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      if (match[1] !== undefined) {
        // Inline code — textContent directly, WITHOUT recursion (see the header).
        const code = document.createElement('code');
        code.className = 'chat-inline-code';
        code.textContent = match[1];
        parent.appendChild(code);
      } else if (match[2] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[2];
        parent.appendChild(strong);
      } else if (match[3] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[3];
        parent.appendChild(em);
      } else if (match[4] !== undefined) {
        const del = document.createElement('del');
        del.textContent = match[4];
        parent.appendChild(del);
      } else if (match[5] !== undefined) {
        parent.appendChild(buildSpoilerEl(match[5]));
      } else if (match[6] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[6];
        parent.appendChild(em);
      } else if (match[7] !== undefined && match[8] !== undefined) {
        const a = document.createElement('a');
        a.href = match[8];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[7];
        parent.appendChild(a);
      } else if (match[9] !== undefined) {
        const a = document.createElement('a');
        a.href = match[9];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[9];
        parent.appendChild(a);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) {
      parent.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
  }

  /**
   * Spoiler (||...||) — blurred until click/Enter/Space (see .chat-md-spoiler in
   * style.css), reveals PERMANENTLY within the rendered element (the
   * .revealed class is added, never removed again — like in the Telegram client).
   * Content is rendered RECURSIVELY via appendInlineNodes (see the file
   * header above) — formatting under a spoiler (e.g. **bold**) also
   * works. role="button"+tabindex — keyboard accessibility (only
   * desktop input in this wave, mobile toolbar — next wave).
   */
  function buildSpoilerEl(content) {
    const span = document.createElement('span');
    span.className = 'chat-md-spoiler';
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-label', 'Spoiler, click to reveal');
    appendInlineNodes(span, content);
    const reveal = () => span.classList.add('revealed');
    span.addEventListener('click', reveal);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    return span;
  }

  /**
   * Copy arbitrary text to the clipboard — first via
   * navigator.clipboard (needs a secure context, we always have https/
   * localhost), fallback — a hidden textarea + document.execCommand('copy')
   * for environments without the Clipboard API. Shared by the code block's "Copy"
   * button (see copyCodeToClipboard/buildCodeBlockEl) and the "Copy text"
   * action in the message popup (see buildCopyButton) — the two only differ
   * in the visual feedback on THEIR OWN button, the copy mechanism itself is the same.
   */
  function copyTextToClipboard(text, onDone) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onDone).catch(() => fallbackCopyToClipboard(text, onDone));
    } else {
      fallbackCopyToClipboard(text, onDone);
    }
  }

  /** The code block's "Copy" button (see buildCodeBlockEl) — a wrapper over copyTextToClipboard with visual feedback on this specific button. */
  function copyCodeToClipboard(code, buttonEl) {
    const showCopied = () => {
      const prevText = buttonEl.textContent;
      buttonEl.classList.add('chat-code-block-copy--done');
      buttonEl.textContent = 'Copied';
      setTimeout(() => {
        buttonEl.classList.remove('chat-code-block-copy--done');
        buttonEl.textContent = prevText;
      }, 1500);
    };
    copyTextToClipboard(code, showCopied);
  }

  function fallbackCopyToClipboard(code, onDone) {
    const textarea = document.createElement('textarea');
    textarea.value = code;
    // Off-screen, but not display:none (Safari doesn't copy from
    // invisible/non-rendering elements) — offset positioning via
    // CSSOM (element.style), not an inline attribute — this doesn't violate CSP (see
    // the file header: the same assumption as for the progress bar's .style.width).
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.warn('Failed to copy code block (neither Clipboard API nor execCommand worked):', err);
    }
    document.body.removeChild(textarea);
    onDone();
  }

  /**
   * Code block (```[lang]\n...\n```, see renderMessageBody) — <pre><code>
   * in a monospace font, a language label (if given), and a "copy" button.
   * `code` — textContent directly, WITHOUT appendInlineNodes (code is code, see
   * the file header) — marker characters inside are not interpreted.
   */
  function buildCodeBlockEl(lang, code) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-code-block';

    const header = document.createElement('div');
    header.className = 'chat-code-block-header';

    const langEl = document.createElement('span');
    langEl.className = 'chat-code-block-lang';
    langEl.textContent = lang || '';
    header.appendChild(langEl);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chat-code-block-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyCodeToClipboard(code, copyBtn));
    header.appendChild(copyBtn);

    wrap.appendChild(header);

    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrap.appendChild(pre);

    return wrap;
  }

  /**
   * Render the full message body into `container` (usually .chat-message-text).
   * Block-level constructs are recognized line by line, TOP TO BOTTOM, before the inline parser:
   * triple backticks ```[lang]``` … ``` — a code block (see buildCodeBlockEl,
   * content is NOT run through the inline parser — code is code); lines
   * starting with exactly "> " are grouped into a blockquote (left bar, see
   * .chat-md-quote in style.css, content is run through
   * appendInlineNodes — bold/italic etc. inside a quote works);
   * other lines — regular inline-formatted text. Line breaks
   * between blocks — <br>.
   */
  function renderMessageBody(container, text) {
    const lines = String(text || '').split('\n');
    let firstBlock = true;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fenceMatch = /^```(\S*)$/.exec(line.replace(/\s+$/, ''));
      if (fenceMatch) {
        // Look for a closing triple-backtick fence among the FOLLOWING lines. If not
        // found by the end of the message — an unclosed fence, back off and render this
        // line as plain text (instead of swallowing everything to the end).
        let j = i + 1;
        const codeLines = [];
        let closed = false;
        while (j < lines.length) {
          if (lines[j].replace(/\s+$/, '') === '```') {
            closed = true;
            break;
          }
          codeLines.push(lines[j]);
          j++;
        }
        if (closed) {
          if (!firstBlock) container.appendChild(document.createElement('br'));
          container.appendChild(buildCodeBlockEl(fenceMatch[1], codeLines.join('\n')));
          firstBlock = false;
          i = j + 1;
          continue;
        }
      }
      if (line.startsWith('> ')) {
        const quoteLines = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].slice(2));
          i++;
        }
        if (!firstBlock) container.appendChild(document.createElement('br'));
        const block = document.createElement('div');
        block.className = 'chat-md-quote';
        quoteLines.forEach((qLine, idx) => {
          if (idx > 0) block.appendChild(document.createElement('br'));
          appendInlineNodes(block, qLine);
        });
        container.appendChild(block);
        firstBlock = false;
      } else {
        if (!firstBlock) container.appendChild(document.createElement('br'));
        appendInlineNodes(container, line);
        firstBlock = false;
        i++;
      }
    }
  }

  // The single panel instance per page (the DOM is reused across
  // connections, see attach()).
  let singleton = null;

  function buildDom(variant, toggleButton) {
    const panel = document.createElement('div');
    panel.className = `chat-panel chat-panel--${variant} hidden`;
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Chat</span>
        <button type="button" class="chat-collapse-button" aria-label="Collapse chat" title="Collapse chat">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="5" y1="5" x2="19" y2="19"></line>
            <line x1="19" y1="5" x2="5" y2="19"></line>
          </svg>
        </button>
      </div>
      <div class="chat-messages"></div>
      <div class="chat-error-banner hidden"></div>
      <div class="chat-reply-bar hidden">
        <span class="chat-reply-bar-text"></span>
        <button type="button" class="chat-reply-bar-close" aria-label="Cancel reply" title="Cancel reply">×</button>
      </div>
      <div class="chat-edit-bar hidden">
        <span class="chat-edit-bar-label">Editing</span>
        <button type="button" class="chat-edit-bar-close" aria-label="Cancel editing" title="Cancel editing">×</button>
      </div>
      <div class="chat-format-toolbar hidden">
        <button type="button" class="chat-format-btn chat-format-btn--bold" data-format="bold" aria-label="Bold" title="Bold">B</button>
        <button type="button" class="chat-format-btn chat-format-btn--italic" data-format="italic" aria-label="Italic" title="Italic">I</button>
        <button type="button" class="chat-format-btn chat-format-btn--strike" data-format="strike" aria-label="Strikethrough" title="Strikethrough">S</button>
        <button type="button" class="chat-format-btn chat-format-btn--spoiler" data-format="spoiler" aria-label="Spoiler" title="Spoiler">🙈</button>
        <button type="button" class="chat-format-btn chat-format-btn--code" data-format="code" aria-label="Code" title="Code">&lt;/&gt;</button>
        <button type="button" class="chat-format-btn chat-format-btn--link" data-format="link" aria-label="Link" title="Link">🔗</button>
      </div>
      <div class="chat-input-row">
        <textarea class="chat-text-input" rows="1" placeholder="Message…" maxlength="2000"></textarea>
        <div class="chat-input-actions">
          <button type="button" class="chat-attach-button" aria-label="Attach file" title="Attach file"></button>
          <input type="file" class="chat-file-input" multiple hidden />
          <button type="button" class="chat-format-toggle-button" aria-label="Text formatting" title="Text formatting" aria-pressed="false">Aa</button>
          <button type="button" class="chat-send-button" aria-label="Send" title="Send">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    `;
    panel.querySelector('.chat-attach-button').innerHTML = ATTACH_ICON_SVG; // static markup

    // Message action popup (wave 13) — a SINGLE entry point for all
    // actions (reply/react/edit/delete/copy) and for the "who/which/when"
    // breakdown of reactions; opened by a tap/click on the message itself
    // (see the messagesEl click delegation below). Shared per panel (a singleton,
    // not one per message) — on mobile it opens as a bottom-sheet
    // from the bottom (see style.css: @media max-width:640px), on desktop —
    // a compact popover near the message (see positionMessagePopoverDesktop).
    // The emoji-reaction row is built once (static, fixed set —
    // safe to build via textContent), the action list and the reaction
    // breakdown are rebuilt each time it opens (they depend on the specific msg).
    const messagePopover = document.createElement('div');
    messagePopover.className = 'chat-message-popover hidden';
    messagePopover.innerHTML = `
      <div class="chat-message-popover-backdrop"></div>
      <div class="chat-message-popover-card" role="dialog" aria-modal="true">
        <div class="chat-message-popover-handle" aria-hidden="true"></div>
        <button type="button" class="chat-message-popover-close" aria-label="Close" title="Close">×</button>
        <div class="chat-message-popover-emojis"></div>
        <div class="chat-message-popover-reactions hidden">
          <div class="chat-message-popover-reactions-title">Reactions</div>
          <div class="chat-message-popover-reactions-list"></div>
        </div>
        <div class="chat-message-popover-actions"></div>
      </div>
    `;
    const popoverEmojisEl = messagePopover.querySelector('.chat-message-popover-emojis');
    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-message-popover-emoji';
      btn.dataset.emoji = emoji;
      btn.textContent = emoji;
      popoverEmojisEl.appendChild(btn);
    }
    panel.appendChild(messagePopover);

    document.body.appendChild(panel);

    return {
      toggleButton,
      panel,
      unreadBadge: toggleButton.querySelector('.chat-unread-badge'),
      collapseButton: panel.querySelector('.chat-collapse-button'),
      messagesEl: panel.querySelector('.chat-messages'),
      errorBanner: panel.querySelector('.chat-error-banner'),
      replyBar: panel.querySelector('.chat-reply-bar'),
      replyBarText: panel.querySelector('.chat-reply-bar-text'),
      replyBarClose: panel.querySelector('.chat-reply-bar-close'),
      editBar: panel.querySelector('.chat-edit-bar'),
      editBarClose: panel.querySelector('.chat-edit-bar-close'),
      messagePopover,
      popoverBackdrop: messagePopover.querySelector('.chat-message-popover-backdrop'),
      popoverCard: messagePopover.querySelector('.chat-message-popover-card'),
      popoverClose: messagePopover.querySelector('.chat-message-popover-close'),
      popoverEmojisEl,
      popoverReactionsEl: messagePopover.querySelector('.chat-message-popover-reactions'),
      popoverReactionsListEl: messagePopover.querySelector('.chat-message-popover-reactions-list'),
      popoverActionsEl: messagePopover.querySelector('.chat-message-popover-actions'),
      inputRow: panel.querySelector('.chat-input-row'),
      textInput: panel.querySelector('.chat-text-input'),
      sendButton: panel.querySelector('.chat-send-button'),
      attachButton: panel.querySelector('.chat-attach-button'),
      fileInput: panel.querySelector('.chat-file-input'),
      formatToolbar: panel.querySelector('.chat-format-toolbar'),
      formatToggleButton: panel.querySelector('.chat-format-toggle-button'),
    };
  }

  /**
   * @param {object} opts
   * @param {object} opts.signaling — Signaling (see common.js), for receiving server-side errors ('error').
   * @param {object} opts.bus — Bus (see bus.js), the sole chat transport (P2P).
   * @param {string} opts.peerId — our own peerId.
   * @param {?string} opts.name — our own display name (fixed for the session, as before).
   * @param {string} opts.variant
   * @param {HTMLElement} opts.toggleButton
   * @param {() => string[]} opts.getPeerIds — the current list of the other participants' peerIds (for broadcasting).
   * @param {string[]} opts.initialPeerIds — the other participants' peerIds at the time of joined, in joined.peers order (for requesting history).
   */
  function create({
    signaling,
    bus,
    peerId,
    name,
    variant,
    toggleButton,
    getPeerIds,
    initialPeerIds,
    getLeaderId,
    getGuestChatAllowed,
  }) {
    if (!singleton) {
      const dom = buildDom(variant, toggleButton);
      singleton = createController(dom);
    }
    singleton.attach({
      signaling,
      bus,
      peerId,
      name,
      getPeerIds,
      initialPeerIds,
      getLeaderId,
      getGuestChatAllowed,
    });
    return singleton.publicApi;
  }

  function createController(dom) {
    const {
      toggleButton,
      panel,
      unreadBadge,
      collapseButton,
      messagesEl,
      errorBanner,
      replyBar,
      replyBarText,
      replyBarClose,
      editBar,
      editBarClose,
      messagePopover,
      popoverBackdrop,
      popoverCard,
      popoverClose,
      popoverEmojisEl,
      popoverReactionsEl,
      popoverReactionsListEl,
      popoverActionsEl,
      inputRow,
      textInput,
      sendButton,
      attachButton,
      fileInput,
      formatToolbar,
      formatToggleButton,
    } = dom;

    let signaling = null;
    let bus = null;
    let peerId = null;
    let myName = null;
    // Outgoing chat queue, accumulated while the P2P bus to the recipient isn't
    // open yet — flushed in notifyBusOpen() (room.js calls it from onBusOpen).
    // Replaces the former server-side fallback chat relay: chat travels only over the bus
    // (DTLS-E2E), and until it opens the envelope waits locally instead of going through the
    // server (see docs/chat.md).
    let pendingBusSends = [];
    let getPeerIds = () => [];
    // Guest permissions (see docs/permissions-and-leader.md, "Chat — Partially
    // Server-Enforced"): getLeaderId/getGuestChatAllowed
    // — room.js callbacks that read the LIVE leaderId/roomSettings.guestChat at
    // call time (not a snapshot taken at attach) — used in
    // isIncomingEnvelopeAllowed below to ignore incoming text/file-offer
    // envelopes from non-leaders when guestChat=false (see the file header).
    let getLeaderId = () => null;
    let getGuestChatAllowed = () => true;
    let unreadCount = 0;
    let errorTimer = null;
    // Sending (OUR OWN input) is disabled by room.js via publicApi.setChatForbidden
    // when guestChat=false — independent of connectionLost (see disableInput/
    // enableInput below), both states are taken into account together in applyInputState.
    let connectionLost = false;
    let forbiddenByLeader = false;

    // --- Chat protocol state ---
    let lamportClock = 0;
    // The single history buffer (capped at HISTORY_CAP) — holds
    // kind='text' and kind='reaction' envelopes interleaved, sorted by compareOrder.
    // This exact array is sent whole in history-response (see
    // handleHistoryRequest) and is recomputed whole for reactions on any
    // change (see recomputeReactions).
    let messages = [];
    let seenIds = new Set();
    // msgId -> Map(emoji -> Set<peerId>) — derived state, always
    // recomputed from scratch from `messages` (see recomputeReactions), so it
    // doesn't depend on delivery order/history replay order.
    let reactions = new Map();
    // msgId -> { deleted: boolean, editText: string|null } — derived
    // edit/delete state, likewise always recomputed from scratch
    // from `messages` (see recomputeMessageMeta), see the comment in the file header.
    let messageOverlays = new Map();
    let sendTimes = []; // client-side rate limit: timestamps of our own sends
    let historyResponseWaiters = new Map(); // peerId -> resolve(messages[])
    let replyTarget = null; // the envelope of the message we're currently replying to (or null)
    let editTarget = null; // the envelope of OUR OWN message we're currently editing (or null) — mutually exclusive with replyTarget
    // Message action popup (wave 13, replaces the on-tap action row and
    // hover buttons of past waves) — the msgId of the message whose
    // popup is currently open (reply/react/edit/delete/copy +
    // reaction breakdown), or null. No more than one at a time — opening
    // it for a new message reuses the same DOM singleton (see
    // openMessagePopover). Works IDENTICALLY on mobile (bottom-sheet) and
    // desktop (compact popover near the message) — a single entry point, without
    // a separate hover state.
    let activePopoverMsgId = null;
    // Formatting toolbar (wave 11, shared across all layouts) —
    // forced open by the "Aa" button (see formatToggleButton below);
    // besides that, the toolbar also shows up ON ITS OWN as long as textInput has a
    // non-empty selection (see updateFormatToolbarVisibility/document
    // 'selectionchange').
    let formatToolbarForcedOpen = false;

    // --- File transfer state (Wave 3) ---
    // fileId -> File — files WE sent (kept alive as long as the tab/session lives),
    // to answer a file-request by sending over a separate DataChannel.
    let fileSendMap = new Map();
    // fileId -> { status, progress, objectUrl, blobSize } — derived state
    // of the file card (both as sender and as receiver), not stored in the envelope.
    // status: 'offer' | 'requesting' | 'transferring' | 'sending' | 'sent' | 'done'
    //       | 'unavailable' | 'no-p2p' | 'failed'.
    let fileStates = new Map();
    // fileId -> { targetPeerId, expectedLabel, mime, name, size } — a download
    // request we're waiting on (for an incoming file DataChannel to open).
    let pendingFileRequests = new Map();

    function isNearBottom() {
      return (
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
        NEAR_BOTTOM_THRESHOLD
      );
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * Preview text for a reply/quote (wave 13: replying is now available from
     * the popup on ANY message, including file-offer — see
     * populatePopoverActions/buildReplyActionButton; a file-offer has no text at
     * all, so the preview is built from the file name with a paperclip).
     */
    function replyPreviewBodyText(msg) {
      if (msg.kind === 'file-offer') return `📎 ${msg.fileName}`;
      return msg.text;
    }

    /** Find ANY editable/deletable message (text or file-offer) by id — for checking edit/delete authorship. */
    function findEditableOriginalById(id) {
      for (const msg of messages) {
        if ((msg.kind === 'text' || msg.kind === 'file-offer') && msg.id === id) return msg;
      }
      return null;
    }

    /**
     * Recompute the edit/delete map from scratch from `messages` — the same
     * technique as recomputeReactions: the buffer is already sorted by (lamport,
     * from), so we simply go in order and overwrite the state with the
     * last valid edit/delete for each target (see the file header).
     * Authorship check — envelope.from must match the original's from;
     * if the original isn't found (already evicted from HISTORY_CAP), the envelope is ignored
     * (safe default, see the file header). Once a delete has been applied
     * to a target — subsequent edits (with a higher lamport) are no longer considered:
     * deletion is final and isn't undone by edits.
     */
    function recomputeMessageMeta() {
      const next = new Map();
      for (const msg of messages) {
        if (msg.kind !== 'edit' && msg.kind !== 'delete') continue;
        if (!msg.target || !msg.from) continue;
        const original = findEditableOriginalById(msg.target);
        if (!original || original.from !== msg.from) continue; // not the original's author (or the original is no longer available) — ignore
        let overlay = next.get(msg.target);
        if (!overlay) {
          overlay = { deleted: false, editText: null };
          next.set(msg.target, overlay);
        }
        if (overlay.deleted) continue; // deletion already applied — subsequent edits don't undo it
        if (msg.kind === 'delete') {
          overlay.deleted = true;
          overlay.editText = null;
        } else if (original.kind === 'text' && typeof msg.text === 'string') {
          // 'edit' only applies to text — file-offer has no text.
          overlay.editText = msg.text;
        }
      }
      messageOverlays = next;
    }

    /**
     * Recompute the reactions map from scratch from `messages`, applying ops in
     * (lamport, from) order — the buffer is already sorted this way. The value at the
     * lower level is Map(peerId -> {name, ts}), not just Set<peerId>: the name and
     * timestamp are needed for the "who/which/when" breakdown in the action popup (see
     * buildPopoverReactionsList) — nevertheless Map supports the same
     * .has()/.size as Set, so the rest of the code (reaction chips,
     * toggle) doesn't change at all.
     */
    function recomputeReactions() {
      const next = new Map();
      for (const msg of messages) {
        if (msg.kind !== 'reaction') continue;
        if (!msg.target || typeof msg.emoji !== 'string' || !msg.from) continue;
        let byEmoji = next.get(msg.target);
        if (!byEmoji) {
          byEmoji = new Map();
          next.set(msg.target, byEmoji);
        }
        let peers = byEmoji.get(msg.emoji);
        if (!peers) {
          peers = new Map();
          byEmoji.set(msg.emoji, peers);
        }
        if (msg.op === 'add') peers.set(msg.from, { name: msg.name || null, ts: msg.ts || Date.now() });
        else if (msg.op === 'remove') peers.delete(msg.from);
      }
      reactions = next;
    }

    function buildReplyQuoteEl(targetId) {
      const quote = document.createElement('div');
      quote.className = 'chat-reply-quote';
      const original = findEditableOriginalById(targetId);
      if (!original) {
        quote.classList.add('chat-reply-quote--missing');
        quote.textContent = 'message unavailable';
        return quote;
      }
      const overlay = messageOverlays.get(targetId);
      const nameEl = document.createElement('span');
      nameEl.className = 'chat-reply-quote-name';
      nameEl.textContent = displayName(original);
      const textEl = document.createElement('span');
      textEl.className = 'chat-reply-quote-text';
      if (overlay && overlay.deleted) {
        textEl.textContent = 'Message deleted';
      } else {
        const bodyText =
          overlay && typeof overlay.editText === 'string' ? overlay.editText : replyPreviewBodyText(original);
        textEl.textContent = truncateText(stripMarkdownForPreview(bodyText), REPLY_PREVIEW_MAX_LEN);
      }
      quote.appendChild(nameEl);
      quote.appendChild(textEl);
      quote.addEventListener('click', () => scrollToMessageAndHighlight(targetId));
      return quote;
    }

    function buildReactionsRowEl(msgId) {
      const byEmoji = reactions.get(msgId);
      if (!byEmoji || byEmoji.size === 0) return null;
      const row = document.createElement('div');
      row.className = 'chat-message-reactions';
      let any = false;
      for (const emoji of REACTION_EMOJIS) {
        const peersSet = byEmoji.get(emoji);
        if (!peersSet || peersSet.size === 0) continue;
        any = true;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chat-reaction-chip' + (peersSet.has(peerId) ? ' chat-reaction-chip--own' : '');
        chip.textContent = `${emoji} ${peersSet.size}`;
        chip.title = peersSet.has(peerId) ? 'Remove reaction' : 'Add reaction';
        chip.addEventListener('click', () => sendReactionToggle(msgId, emoji));
        row.appendChild(chip);
      }
      return any ? row : null;
    }

    function scrollToMessageAndHighlight(targetId) {
      const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetId) : targetId;
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${safeId}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const textEl = el.querySelector('.chat-message-text');
      if (textEl) {
        textEl.classList.add('chat-message-text--flash');
        setTimeout(() => textEl.classList.remove('chat-message-text--flash'), HIGHLIGHT_DURATION_MS);
      }
    }

    /** `overlay` — messageOverlays.get(msg.id), passed in by the caller so it doesn't need to be recomputed/looked up here. */
    function buildMetaEl(msg, overlay) {
      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName(msg);
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(msg.ts || Date.now());
      meta.appendChild(nameSpan);
      meta.appendChild(timeSpan);
      if (overlay && !overlay.deleted && typeof overlay.editText === 'string') {
        const editedSpan = document.createElement('span');
        editedSpan.className = 'chat-message-meta-edited';
        editedSpan.textContent = '(edited)';
        meta.appendChild(editedSpan);
      }
      return meta;
    }

    function renderMessageEl(msg) {
      const own = msg.from === peerId;
      const overlay = messageOverlays.get(msg.id);
      const isDeleted = !!(overlay && overlay.deleted);

      const item = document.createElement('div');
      item.className =
        'chat-message' +
        (own ? ' chat-message--own' : '') +
        (isDeleted ? ' chat-message--deleted' : '') +
        (msg.id === activePopoverMsgId ? ' chat-message--popover-open' : '');
      item.dataset.msgId = msg.id;

      item.appendChild(buildMetaEl(msg, overlay));

      if (msg.replyTo) {
        item.appendChild(buildReplyQuoteEl(msg.replyTo));
      }

      const text = document.createElement('div');
      text.className = 'chat-message-text';
      if (isDeleted) {
        text.classList.add('chat-message-text--deleted');
        text.textContent = 'Message deleted';
      } else {
        const bodyText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
        renderMessageBody(text, bodyText);
      }
      item.appendChild(text);

      if (!isDeleted) {
        const reactionsRow = buildReactionsRowEl(msg.id);
        if (reactionsRow) item.appendChild(reactionsRow);
      }

      messagesEl.appendChild(item);
    }

    /** Action popup row: icon (static SVG) + label — the same look for all items (see populatePopoverActions). */
    function buildPopoverActionRow(iconSvg, label) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const icon = document.createElement('span');
      icon.className = 'chat-message-action-icon';
      icon.innerHTML = iconSvg; // static markup, not user data
      const labelEl = document.createElement('span');
      labelEl.className = 'chat-message-action-label';
      labelEl.textContent = label;
      btn.appendChild(icon);
      btn.appendChild(labelEl);
      return { btn, labelEl };
    }

    /** Pencil — only on OUR OWN text messages (see populatePopoverActions); a file-offer cannot be edited. */
    function buildEditButton(msg) {
      const { btn } = buildPopoverActionRow(EDIT_ICON_SVG, 'Edit');
      btn.className = 'chat-message-action chat-message-action--edit';
      btn.setAttribute('aria-label', 'Edit');
      btn.title = 'Edit';
      btn.addEventListener('click', () => startEdit(msg));
      return btn;
    }

    /**
     * Trash can — on OUR OWN text and file-offer messages. The first click switches
     * the button into a confirmation state ("Confirm delete?") for
     * DELETE_CONFIRM_MS; a second click within that window sends delete; a timeout without
     * a second click reverts to the original label without sending anything.
     */
    function buildDeleteButton(msg) {
      const { btn, labelEl } = buildPopoverActionRow(DELETE_ICON_SVG, 'Delete');
      btn.className = 'chat-message-action chat-message-action--delete';
      btn.setAttribute('aria-label', 'Delete');
      btn.title = 'Delete';
      let confirmTimer = null;

      function resetToIdle() {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        btn.classList.remove('chat-message-action--confirm');
        labelEl.textContent = 'Delete';
        btn.setAttribute('aria-label', 'Delete');
        btn.title = 'Delete';
      }

      btn.addEventListener('click', () => {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
          sendDeleteMessage(msg.id);
          closeMessagePopover();
          return;
        }
        btn.classList.add('chat-message-action--confirm');
        labelEl.textContent = 'Confirm delete?';
        btn.setAttribute('aria-label', 'Confirm deletion');
        btn.title = 'Click again to confirm deletion';
        confirmTimer = setTimeout(resetToIdle, DELETE_CONFIRM_MS);
      });

      return btn;
    }

    // --- File card rendering (Wave 3) — kind='file-offer' ---
    //
    // Unlike text messages, the card body depends not only on
    // the envelope itself (which is immutable) but also on the derived
    // fileStates (has the file been requested, is a transfer in progress, is a Blob ready) —
    // so the body is built by a separate renderFileCardBody(), called both on the
    // initial render and on every status change (see setFileStatus).
    // Progress within a single status is updated in place (setFileProgress),
    // without rebuilding the DOM — otherwise every chunk (there can be hundreds) would trigger
    // an expensive full rebuild of the card.
    function renderFileOfferEl(msg) {
      const own = msg.from === peerId;
      const overlay = messageOverlays.get(msg.id);
      const isDeleted = !!(overlay && overlay.deleted);

      const item = document.createElement('div');
      item.className =
        'chat-message chat-message--file' +
        (own ? ' chat-message--own' : '') +
        (isDeleted ? ' chat-message--deleted' : '') +
        (msg.id === activePopoverMsgId ? ' chat-message--popover-open' : '');
      item.dataset.msgId = msg.id;

      item.appendChild(buildMetaEl(msg, overlay));

      if (isDeleted) {
        // A tombstone instead of a card. IMPORTANT: deleting an offer only
        // hides the card in the feed, it does NOT revoke copies of the file already
        // transferred/received — receivers who managed to download it (Blob/objectUrl) before
        // the deletion keep access to their local copy; this is expected
        // behavior of the strictly P2P model (the server doesn't store the file, so there's
        // nothing to revoke, see the file header on Wave 3).
        const text = document.createElement('div');
        text.className = 'chat-message-text chat-message-text--deleted';
        text.textContent = 'Message deleted';
        item.appendChild(text);
        messagesEl.appendChild(item);
        return;
      }

      const card = document.createElement('div');
      card.className = 'chat-file-card';
      item.appendChild(card);
      renderFileCardBody(card, msg, own);

      messagesEl.appendChild(item);
    }

    /** Find the file-offer envelope by fileId in the current buffer (for targeted status/progress updates). */
    function findFileOfferByFileId(fileId) {
      for (const msg of messages) {
        if (msg.kind === 'file-offer' && msg.fileId === fileId) return msg;
      }
      return null;
    }

    function fileCardHeaderEl(msg) {
      const header = document.createElement('div');
      header.className = 'chat-file-header';

      const icon = document.createElement('span');
      icon.className = 'chat-file-icon';
      icon.innerHTML = fileIconSvgForMime(msg.mime); // static set of SVGs by mime category, not user data

      const info = document.createElement('div');
      info.className = 'chat-file-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'chat-file-name';
      nameEl.textContent = msg.fileName;
      nameEl.title = msg.fileName;
      const sizeEl = document.createElement('div');
      sizeEl.className = 'chat-file-size';
      sizeEl.textContent = humanFileSize(msg.size);
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      header.appendChild(icon);
      header.appendChild(info);
      return header;
    }

    function fileProgressEl(fileId, fraction) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-file-progress';
      const bar = document.createElement('div');
      bar.className = 'chat-file-progress-bar';
      bar.dataset.fileId = fileId;
      bar.style.width = `${Math.round((fraction || 0) * 100)}%`;
      wrap.appendChild(bar);
      return wrap;
    }

    /** Rebuild the contents of `card` from msg + the current fileStates.get(msg.fileId). */
    function renderFileCardBody(card, msg, own) {
      card.textContent = '';
      const state = fileStates.get(msg.fileId) || { status: 'offer', progress: 0 };

      // The presence of objectUrl is a self-sufficient signal of "a Blob is ready,
      // show preview/Download", REGARDLESS of the current state.status.
      // This matters for our own (own) card: handleFilesSelected immediately
      // sets it to status:'done' with an objectUrl from our own File, but
      // the status may later switch several times to 'sending'/
      // 'sent' — beginSendingFile serves the file to each requesting receiver
      // separately and overwrites the status each time (see setFileStatus). If
      // we checked status==='done' here, such a delivery would roll the sender's
      // already-ready card back to "header only". objectUrl in
      // fileStates is left untouched by this (beginSendingFile doesn't pass it
      // in extra), so checking against it gives the same behavior for our own and someone
      // else's (received) card.
      if (state.objectUrl) {
        renderFileDoneBody(card, msg, state);
        return;
      }

      card.appendChild(fileCardHeaderEl(msg));

      if (state.status === 'requesting' || state.status === 'transferring' || state.status === 'sending') {
        card.appendChild(fileProgressEl(msg.fileId, state.progress));
        return;
      }

      if (state.status === 'unavailable') {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Sender unavailable';
        card.appendChild(note);
        return;
      }

      if (state.status === 'failed') {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Failed to receive file';
        card.appendChild(note);
        if (!own) {
          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'chat-file-download-button';
          retryButton.textContent = 'Retry';
          retryButton.addEventListener('click', () => requestFileDownload(msg));
          card.appendChild(retryButton);
        }
        return;
      }

      // status === 'offer' (the initial state with no record, nothing has been
      // requested yet) — someone else's card: a "Download" button (or an
      // unavailability note). Our own card practically never reaches here: for own,
      // fileStates.objectUrl is set synchronously in handleFilesSelected,
      // meaning the early return on objectUrl above already fired; the `own` check here
      // is just a safety net in case the state somehow wasn't created.
      if (own) return;

      if (!getPeerIds().includes(msg.from)) {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Sender unavailable';
        card.appendChild(note);
        return;
      }

      if (!bus.isOpen(msg.from)) {
        const note = document.createElement('div');
        note.className = 'chat-file-download-button chat-file-download-button--disabled';
        note.textContent = 'Unavailable: no direct connection';
        note.title = 'There is no direct P2P connection between you and the sender — file transfer only works directly, files are not relayed through the server.';
        card.appendChild(note);
        return;
      }

      const downloadButton = document.createElement('button');
      downloadButton.type = 'button';
      downloadButton.className = 'chat-file-download-button';
      downloadButton.textContent = 'Download';
      downloadButton.addEventListener('click', () => requestFileDownload(msg));
      card.appendChild(downloadButton);
    }

    /**
     * The meta row under the inline media (image/video/audio) of a ready card:
     * file name + size (+ an empty node for duration — filled in
     * later by the loadedmetadata event, see the calling code) + a "Download" button
     * from the already-received objectUrl (no repeat network access — see the
     * file header on Wave 3: the server neither sees nor stores the bytes, and the file itself
     * is already ours as a Blob/ObjectURL).
     */
    function buildFileMetaRow(msg) {
      const meta = document.createElement('div');
      meta.className = 'chat-file-meta-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'chat-file-meta-name';
      nameEl.textContent = msg.fileName;
      nameEl.title = msg.fileName;
      meta.appendChild(nameEl);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'chat-file-meta-size';
      sizeEl.textContent = humanFileSize(msg.size);
      meta.appendChild(sizeEl);

      return meta;
    }

    /** Empty node for duration — text is set by loadedmetadata (see renderFileDoneBody). */
    function buildFileMetaDurationEl() {
      const durationEl = document.createElement('span');
      durationEl.className = 'chat-file-meta-duration';
      return durationEl;
    }

    /** Compact "Download" link-button from the already-received objectUrl (see buildFileMetaRow). */
    function buildFileMetaDownloadLink(msg, state) {
      const link = document.createElement('a');
      link.className = 'chat-file-download-link chat-file-download-link--compact';
      link.href = state.objectUrl;
      link.download = msg.fileName;
      link.textContent = 'Download';
      return link;
    }

    /**
     * The final look of a ready (status='done') card — based on the mime of the received
     * file (see the file header, section B):
     *  - image/* — an inline preview (clicking the picture opens the original in a new
     *    tab, as before), with a meta row below it (name, size, "Download");
     *  - video/* — <video controls preload=metadata>, duration is
     *    set by loadedmetadata (M:SS, see humanDuration) —
     *    an invalid/unplayable container simply won't fire this event,
     *    the meta row then stays without a duration (not an error);
     *  - audio/* — <audio controls>, duration likewise via loadedmetadata;
     *  - everything else — a header card (icon/name/size) + a separate
     *    "Download" link-button (as before).
     * objectUrl is NOT recreated here on every re-render — it's already stored
     * in fileStates (see beginReceivingFile: URL.createObjectURL is called
     * EXACTLY ONCE upon receiving the Blob), `state` is simply passed in here.
     */
    function renderFileDoneBody(card, msg, state) {
      const mime = msg.mime || '';

      if (mime.startsWith('image/')) {
        const link = document.createElement('a');
        link.href = state.objectUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'chat-file-media-link';
        const img = document.createElement('img');
        img.className = 'chat-file-image';
        img.src = state.objectUrl;
        img.alt = msg.fileName;
        link.appendChild(img);
        card.appendChild(link);

        const meta = buildFileMetaRow(msg);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);
        return;
      }

      if (mime.startsWith('video/')) {
        const video = document.createElement('video');
        video.className = 'chat-file-video';
        video.controls = true;
        video.preload = 'metadata';
        video.src = state.objectUrl;
        card.appendChild(video);

        const meta = buildFileMetaRow(msg);
        const durationEl = buildFileMetaDurationEl();
        meta.appendChild(durationEl);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);

        video.addEventListener(
          'loadedmetadata',
          () => {
            if (Number.isFinite(video.duration)) durationEl.textContent = humanDuration(video.duration);
          },
          { once: true }
        );
        return;
      }

      if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.className = 'chat-file-audio';
        audio.controls = true;
        audio.src = state.objectUrl;
        card.appendChild(audio);

        const meta = buildFileMetaRow(msg);
        const durationEl = buildFileMetaDurationEl();
        meta.appendChild(durationEl);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);

        audio.addEventListener(
          'loadedmetadata',
          () => {
            if (Number.isFinite(audio.duration)) durationEl.textContent = humanDuration(audio.duration);
          },
          { once: true }
        );
        return;
      }

      // Everything else — a header card (icon by mime/name/size) + a link-button.
      card.appendChild(fileCardHeaderEl(msg));
      const link = document.createElement('a');
      link.className = 'chat-file-download-link';
      link.href = state.objectUrl;
      link.download = msg.fileName;
      link.textContent = 'Download';
      card.appendChild(link);
    }

    /** Update only the progress bar in place (without rebuilding the card) — called frequently (on every chunk). */
    function setFileProgress(fileId, fraction) {
      const state = fileStates.get(fileId);
      if (!state) return;
      state.progress = fraction;
      const bar = messagesEl.querySelector(
        `.chat-file-progress-bar[data-file-id="${escapeForSelector(fileId)}"]`
      );
      if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    }

    /** Change the file card's status and rebuild its body (a structural change — not just progress). */
    function setFileStatus(fileId, status, extra) {
      const prev = fileStates.get(fileId) || { progress: 0 };
      const next = Object.assign({}, prev, { status }, extra || {});
      fileStates.set(fileId, next);
      const msg = findFileOfferByFileId(fileId);
      if (!msg) return;
      const safeMsgId = escapeForSelector(msg.id);
      const item = messagesEl.querySelector(`.chat-message[data-msg-id="${safeMsgId}"]`);
      if (!item) return; // not currently rendered (e.g. evicted from HISTORY_CAP) — not a problem
      const card = item.querySelector('.chat-file-card');
      if (card) renderFileCardBody(card, msg, msg.from === peerId);
    }

    /** Redraw the whole feed from `messages` (the buffer is small — up to 50, a full redraw is cheaper than incremental insertion in the middle). Reactions aren't standalone bubbles in the feed, only text messages and file cards are. */
    function renderAll(forceScrollBottom) {
      const wasNearBottom = isNearBottom();
      messagesEl.textContent = '';
      for (const msg of messages) {
        if (msg.kind === 'text') renderMessageEl(msg);
        else if (msg.kind === 'file-offer') renderFileOfferEl(msg);
      }
      if (forceScrollBottom || wasNearBottom) scrollToBottom();
    }

    /** Insert an envelope (text or reaction) with dedup by id and sorting by (lamport, from); caps the buffer at HISTORY_CAP. Returns true if actually inserted (not a duplicate). */
    function insertMessage(msg) {
      if (seenIds.has(msg.id)) return false;
      seenIds.add(msg.id);
      let idx = messages.length;
      while (idx > 0 && compareOrder(messages[idx - 1], msg) > 0) idx--;
      messages.splice(idx, 0, msg);
      while (messages.length > HISTORY_CAP) {
        const removed = messages.shift();
        seenIds.delete(removed.id);
      }
      return true;
    }

    function clearMessages() {
      messagesEl.textContent = '';
      messages = [];
      seenIds = new Set();
      reactions = new Map();
      messageOverlays = new Map();
      lamportClock = 0;
      sendTimes = [];
      historyResponseWaiters = new Map();
      fileSendMap = new Map();
      fileStates = new Map();
      pendingFileRequests = new Map();
      pendingBusSends = [];
      cancelReply();
      cancelEditAndClear();
      closeMessagePopover();
      formatToolbarForcedOpen = false;
      updateFormatToolbarVisibility();
      autoGrowTextInput();
    }

    /**
     * VisualViewport-based sizing of the fullscreen mobile chat panel (reported
     * issue: the system keyboard covered part of the chat and added an
     * extra page scroll instead of the chat shrinking to fit the visible
     * area, see style.css: @media (max-width:640px) .chat-panel, 100dvh).
     * 100dvh reacts to address-bar/orientation changes, but NOT to the
     * keyboard appearing on iOS — the primary approach here is therefore
     * the VisualViewport API: while the chat is open in mobile layout, the panel's height
     * = visualViewport.height, the panel's top = visualViewport.offsetTop (the offset
     * of the visible area relative to the layout viewport) — this keeps the input (anchored to
     * the bottom of the panel) ABOVE the keyboard, instead of sliding under it. The message
     * list shrinks on its own (flex:1 on .chat-messages) — here we just
     * scroll it to the bottom so the last message stays
     * visible after the visible area shrinks.
     *
     * Fallback (no window.visualViewport — older browsers): reset the
     * inline styles to an empty string, from then on only CSS (100dvh) applies — no
     * worse than the behavior before this wave.
     *
     * .chat-mobile-scroll-lock on body (see style.css) — while the chat is open on
     * mobile, the page does NOT scroll under any circumstances: the panel
     * already covers the whole viewport (position:fixed; inset:0), but focusing the
     * textarea next to the opening keyboard triggers, in some browsers,
     * an attempt to "scroll the field into view" at the document
     * level — the lock reliably suppresses it.
     */
    function syncMobileChatViewport() {
      const isOpen = !panel.classList.contains('hidden');
      const mobile = isOpen && isMobileLayout();
      document.body.classList.toggle('chat-mobile-scroll-lock', mobile);
      if (!mobile || !window.visualViewport) {
        panel.style.top = '';
        panel.style.height = '';
        return;
      }
      const vv = window.visualViewport;
      panel.style.top = `${vv.offsetTop}px`;
      panel.style.height = `${vv.height}px`;
      scrollToBottom();
    }

    // VisualViewport listeners are set up EXACTLY ONCE (createController is
    // a per-page singleton, see the file header) — 'resize' fires both on
    // the keyboard showing/hiding and on pinch-zoom; 'scroll' fires when
    // the visible area shifts relative to the layout viewport (e.g. the
    // browser scrolls the focused field into the visible part). window
    // 'resize'/'orientationchange' — a fallback path and orientation changes:
    // in some browsers window.visualViewport also emits resize for this, but
    // it's not guaranteed everywhere, so we subscribe to these separately as well.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncMobileChatViewport);
      window.visualViewport.addEventListener('scroll', syncMobileChatViewport);
    }
    window.addEventListener('resize', () => {
      syncMobileChatViewport();
      updateFormatToolbarVisibility();
      // Desktop<->mobile resize (rotation/DevTools) — reposition an open
      // popup to fit the new layout (mobile bottom-sheet <-> desktop
      // popover near the message).
      if (activePopoverMsgId && !messagePopover.classList.contains('hidden')) {
        const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(activePopoverMsgId)}"]`);
        positionMessagePopoverDesktop(el || panel);
      }
    });
    window.addEventListener('orientationchange', syncMobileChatViewport);

    function setCollapsed(collapsed) {
      panel.classList.toggle('hidden', collapsed);
      toggleButton.classList.toggle('control-button--on', !collapsed);
      toggleButton.setAttribute('aria-pressed', String(!collapsed));
      if (!collapsed) {
        unreadCount = 0;
        updateUnreadBadge();
        // Up to this point the panel (and the textarea inside it) could have been
        // display:none (see .chat-panel.hidden) — scrollHeight of a hidden
        // element is always 0, so autoGrowTextInput(), called EARLIER
        // (e.g. from clearMessages() during attach, when the panel was still
        // closed), could have computed and set the wrong (zero) height.
        // Recompute now that the panel is definitely visible.
        autoGrowTextInput();
        scrollToBottom();
        textInput.focus();
      } else {
        closeMessagePopover();
        formatToolbarForcedOpen = false;
        updateFormatToolbarVisibility();
      }
      syncMobileChatViewport();
    }

    function updateUnreadBadge() {
      unreadBadge.textContent = String(unreadCount);
      unreadBadge.classList.toggle('hidden', unreadCount === 0);
    }

    function showError(message) {
      errorBanner.textContent = message;
      errorBanner.classList.remove('hidden');
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        errorBanner.classList.add('hidden');
      }, 4000);
    }

    // --- Replies: compact bar above the input ---
    function startReply(msg) {
      cancelEditAndClear(); // reply and editing are mutually exclusive (see the file header)
      replyTarget = msg;
      replyBarText.textContent = `Reply to ${displayName(msg)}: ${truncateText(stripMarkdownForPreview(replyPreviewBodyText(msg)), REPLY_PREVIEW_MAX_LEN)}`;
      replyBar.classList.remove('hidden');
      closeMessagePopover();
      textInput.focus();
    }

    function cancelReply() {
      replyTarget = null;
      replyBar.classList.add('hidden');
    }

    replyBarClose.addEventListener('click', cancelReply);

    // --- Editing your own message: a bar above the input, modeled after
    // the reply bar above, mutually exclusive with it (see the file header). ---
    function startEdit(msg) {
      cancelReply();
      editTarget = msg;
      const overlay = messageOverlays.get(msg.id);
      const currentText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
      textInput.value = currentText;
      editBar.classList.remove('hidden');
      autoGrowTextInput();
      closeMessagePopover();
      textInput.focus();
      const len = textInput.value.length;
      textInput.setSelectionRange(len, len); // cursor to the end — otherwise the browser puts it at the start when value is set programmatically
    }

    function cancelEdit() {
      editTarget = null;
      editBar.classList.add('hidden');
    }

    /** Esc/close button — cancels editing AND clears the textarea (unlike cancelReply, which doesn't touch the input field). */
    function cancelEditAndClear() {
      const wasEditing = !!editTarget;
      cancelEdit();
      if (wasEditing) {
        textInput.value = '';
        autoGrowTextInput();
      }
    }

    editBarClose.addEventListener('click', cancelEditAndClear);

    /**
     * Whether the event's propagation path contains an element matching
     * `selector` — the same as `event.target.closest(selector)`, BUT
     * robust to the fact that `event.target` itself may have been detached from the DOM
     * by ANOTHER handler of THIS SAME event before it bubbled up to here
     * (found empirically: clicking the delete button — buildDeleteButton
     * synchronously does `btn.textContent = '✓?'` on the first click, replacing
     * the child SVG element — if event.target was exactly that SVG
     * (a common case: the click lands on the icon inside the button), then by the
     * time bubbling reaches messagesEl/document,
     * `event.target.closest(...)` returns null — the SVG is already detached from
     * its parent). `event.composedPath()` is a snapshot of the path taken AT THE MOMENT
     * OF DISPATCH, taken BEFORE any handler had a chance to change anything in the DOM,
     * so it isn't affected by this problem.
     */
    function eventPathMatches(event, selector) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (node instanceof Element && node.matches(selector)) return true;
      }
      return false;
    }

    // --- Message action popup (wave 13) ---
    //
    // Entirely replaces both the on-tap action row of the previous wave's mobile UX and
    // desktop's hover buttons: the only way to reach a message's actions
    // (reply/react/edit/delete/copy) now is a
    // tap/click on the message itself, IDENTICALLY on mobile and desktop (see
    // the messagesEl click delegation below). By default the message row keeps
    // no buttons at all — neither persistent ones nor hover ones (the reported
    // issue from the previous wave was specifically about the visual noise of actions;
    // this wave removes it entirely, rather than just hiding it behind a tap).

    /** Find ANY message (text or file-offer) by id — the same as findEditableOriginalById, a separate name for readability in the popup context. */
    function findAnyMessageById(id) {
      return findEditableOriginalById(id);
    }

    /** Build the "who/which/when" reaction breakdown — a list grouped by emoji (in REACTION_EMOJIS order), within each group ordered by reaction time. */
    function buildPopoverReactionsList(msgId) {
      popoverReactionsListEl.textContent = '';
      const byEmoji = reactions.get(msgId);
      let any = false;
      if (byEmoji) {
        for (const emoji of REACTION_EMOJIS) {
          const peers = byEmoji.get(emoji);
          if (!peers || peers.size === 0) continue;
          const entries = Array.from(peers.entries()).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
          for (const [reactorPeerId, info] of entries) {
            any = true;
            const row = document.createElement('div');
            row.className = 'chat-message-popover-reaction-row';

            const emojiEl = document.createElement('span');
            emojiEl.className = 'chat-message-popover-reaction-emoji';
            emojiEl.textContent = emoji;

            const nameEl = document.createElement('span');
            nameEl.className = 'chat-message-popover-reaction-name';
            nameEl.textContent = displayName({ from: reactorPeerId, name: info.name });

            const timeEl = document.createElement('span');
            timeEl.className = 'chat-message-popover-reaction-time';
            timeEl.textContent = formatTime(info.ts || Date.now());

            row.appendChild(emojiEl);
            row.appendChild(nameEl);
            row.appendChild(timeEl);
            popoverReactionsListEl.appendChild(row);
          }
        }
      }
      popoverReactionsEl.classList.toggle('hidden', !any);
    }

    /** Copy the CURRENT (edit-aware) message text to the clipboard — the "Copy" action in the popup. */
    function buildCopyButton(msg, overlay) {
      const { btn, labelEl } = buildPopoverActionRow(COPY_ICON_SVG, 'Copy text');
      btn.className = 'chat-message-action chat-message-action--copy';
      btn.addEventListener('click', () => {
        const bodyText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
        copyTextToClipboard(String(bodyText || ''), () => {
          labelEl.textContent = 'Copied';
          setTimeout(() => {
            labelEl.textContent = 'Copy text';
          }, 1200);
        });
      });
      return btn;
    }

    function buildReplyActionButton(msg) {
      const { btn } = buildPopoverActionRow(REPLY_ICON_SVG, 'Reply');
      btn.className = 'chat-message-action chat-message-action--reply';
      btn.addEventListener('click', () => {
        closeMessagePopover();
        startReply(msg);
      });
      return btn;
    }

    /** Fill `.chat-message-popover-actions` with actions appropriate for the specific message (own/kind/deleted). */
    function populatePopoverActions(msg, overlay) {
      popoverActionsEl.textContent = '';
      const own = msg.from === peerId;
      popoverActionsEl.appendChild(buildReplyActionButton(msg));
      if (own && msg.kind === 'text') {
        const editBtn = buildEditButton(msg);
        editBtn.addEventListener('click', closeMessagePopover);
        popoverActionsEl.appendChild(editBtn);
      }
      if (own) {
        popoverActionsEl.appendChild(buildDeleteButton(msg));
      }
      if (msg.kind === 'text') {
        popoverActionsEl.appendChild(buildCopyButton(msg, overlay));
      }
    }

    /**
     * Positioning ONLY for desktop (>640px) — a compact popover near the
     * message. `.chat-message-popover` is designed as position:fixed;inset:0
     * (see style.css) — the containing block for the absolutely
     * positioned `.chat-message-popover-card` is ALMOST always the entire
     * viewport, BUT not guaranteed: `.chat-panel--room` uses
     * `backdrop-filter` (see style.css), and per spec filter/backdrop-filter on an
     * ANCESTOR themselves create a containing block for fixed descendants —
     * in that case `.chat-message-popover` ends up effectively confined to the bounds
     * of `.chat-panel`, not the viewport (found empirically during a visual
     * self-check: the popup rendered hundreds of pixels further right than expected
     * — the card was positioned relative to the PANEL's edges, while the coordinate
     * math assumed the VIEWPORT's edges). To avoid depending on which
     * containing block ends up applying in a given browser/layout, coordinates
     * are computed relative to the ACTUAL bounding rect of
     * `.chat-message-popover` itself (messagePopover.getBoundingClientRect()) — it
     * is the actual containing block for the absolutely positioned card, whatever it
     * turns out to be. On mobile (bottom-sheet) positioning is handled entirely by
     * CSS — inline styles are reset here to avoid conflicting with it.
     */
    function positionMessagePopoverDesktop(anchorEl) {
      if (isMobileLayout()) {
        popoverCard.style.left = '';
        popoverCard.style.top = '';
        return;
      }
      const containingRect = messagePopover.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      const cardRect = popoverCard.getBoundingClientRect();

      let left = anchorRect.left - containingRect.left;
      const maxLeft = Math.max(4, containingRect.width - cardRect.width - 4);
      left = Math.max(4, Math.min(left, maxLeft));

      let top = anchorRect.bottom - containingRect.top + 4;
      if (top + cardRect.height > containingRect.height - 4) {
        top = anchorRect.top - containingRect.top - cardRect.height - 4;
      }
      top = Math.max(4, top);

      popoverCard.style.left = `${left}px`;
      popoverCard.style.top = `${top}px`;
    }

    function openMessagePopover(msgId, anchorEl) {
      const msg = findAnyMessageById(msgId);
      if (!msg) return;
      const overlay = messageOverlays.get(msgId);
      if (overlay && overlay.deleted) return; // a tombstone has no actions

      const prevId = activePopoverMsgId;
      activePopoverMsgId = msgId;
      if (prevId && prevId !== msgId) {
        const prevEl = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(prevId)}"]`);
        if (prevEl) prevEl.classList.remove('chat-message--popover-open');
      }
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(msgId)}"]`);
      if (el) el.classList.add('chat-message--popover-open');

      buildPopoverReactionsList(msgId);
      populatePopoverActions(msg, overlay);

      messagePopover.classList.remove('hidden');
      positionMessagePopoverDesktop(anchorEl || el || panel);
    }

    function closeMessagePopover() {
      if (!activePopoverMsgId) {
        messagePopover.classList.add('hidden');
        return;
      }
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(activePopoverMsgId)}"]`);
      if (el) el.classList.remove('chat-message--popover-open');
      activePopoverMsgId = null;
      messagePopover.classList.add('hidden');
    }

    function toggleMessagePopover(msgId, anchorEl) {
      if (activePopoverMsgId === msgId && !messagePopover.classList.contains('hidden')) {
        closeMessagePopover();
        return;
      }
      cancelReply();
      openMessagePopover(msgId, anchorEl);
    }

    // The emoji palette inside the popup — a tap/click on an emoji sets/removes
    // the reaction (toggle, see sendReactionToggle) and closes the whole popup
    // (Telegram-style: choosing a reaction is a final action, not an intermediate step).
    popoverEmojisEl.querySelectorAll('.chat-message-popover-emoji').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        const targetId = activePopoverMsgId;
        closeMessagePopover();
        if (targetId && emoji) sendReactionToggle(targetId, emoji);
      });
    });

    popoverClose.addEventListener('click', closeMessagePopover);
    popoverBackdrop.addEventListener('click', closeMessagePopover);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!messagePopover.classList.contains('hidden')) {
        closeMessagePopover();
        return;
      }
      if (!editBar.classList.contains('hidden')) {
        cancelEditAndClear();
      }
    });

    // A click on the message body opens the action popup (clicking again on an
    // already-open one — closes it, see toggleMessagePopover). Clicks on
    // elements with their own click logic (reaction chip, reply quote,
    // link, spoiler, button/media control inside a file card) do NOT
    // additionally open the popup — the same technique as in the previous wave
    // (see eventPathMatches above). Tombstones (deleted messages) have no
    // actions — openMessagePopover won't open on its own (see the overlay check
    // inside it), but click delegation doesn't trigger for them either, for clarity.
    messagesEl.addEventListener('click', (event) => {
      if (
        eventPathMatches(
          event,
          '.chat-reaction-chip, .chat-reply-quote, a, button, video, audio, .chat-md-spoiler'
        )
      ) {
        return;
      }
      const item = event.target.closest ? event.target.closest('.chat-message') : null;
      if (!item) return;
      if (item.classList.contains('chat-message--deleted')) return;
      toggleMessagePopover(item.dataset.msgId, item);
    });

    // A click OUTSIDE any message and outside the popup itself closes the popup (a tap
    // on the chat header, an empty spot in the feed, the input, etc.). Clicks INSIDE
    // a message are handled by the messagesEl delegation above (toggle) — they
    // also reach here via bubbling, but are excluded by the explicit check below,
    // otherwise this handler would immediately close a popup that was just opened.
    document.addEventListener('click', (event) => {
      if (messagePopover.classList.contains('hidden')) return;
      if (eventPathMatches(event, '.chat-message-popover') || eventPathMatches(event, '.chat-message')) return;
      closeMessagePopover();
    });

    // --- Rate limit (client-side, soft) — only for text messages ---
    function checkClientRateLimit() {
      const now = Date.now();
      while (sendTimes.length && now - sendTimes[0] > RATE_LIMIT_WINDOW_MS) sendTimes.shift();
      if (sendTimes.length >= RATE_LIMIT_COUNT) return false;
      sendTimes.push(now);
      return true;
    }

    // --- Transport: broadcast the envelope to all peers (bus where open; server fallback where not) ---
    function broadcastEnvelope(envelope) {
      for (const targetPeerId of getPeerIds()) {
        sendEnvelopeToPeer(targetPeerId, envelope);
      }
    }

    /**
     * Send an envelope to ONE specific peer (addressed) — exclusively over the
     * P2P bus (the DataChannel is already E2E thanks to DTLS, see static/rtc.js). If the bus
     * to the recipient isn't open yet, the envelope is QUEUED LOCALLY (pendingBusSends) and
     * goes out once it opens (see notifyBusOpen) — there is no longer a server-side fallback
     * relay for chat (see docs/chat.md: chat only works with P2P/TURN,
     * media doesn't exist without it either way). Chat requires no application-level
     * encryption on top of DTLS.
     */
    function sendEnvelopeToPeer(targetPeerId, envelope) {
      if (bus.isOpen(targetPeerId)) {
        bus.sendToPeer(targetPeerId, envelope);
        return;
      }
      pendingBusSends.push({ targetPeerId, envelope });
    }

    /** Flush the local outgoing queue accumulated while the bus to recipients wasn't open (see sendEnvelopeToPeer) — called from room.js (onBusOpen) via publicApi.notifyBusOpen, when the bus to someone has opened. We try everything; whatever still isn't open goes back into the queue. */
    function notifyBusOpen() {
      if (pendingBusSends.length === 0) return;
      const queued = pendingBusSends;
      pendingBusSends = [];
      for (const { targetPeerId, envelope } of queued) {
        sendEnvelopeToPeer(targetPeerId, envelope);
      }
    }

    /**
     * Guest permissions on the RECEIVER side (see docs/permissions-and-leader.md,
     * "Chat — Cooperative Only", and the file header): when
     * `guestChat=false`, incoming 'text'/'file-offer' from
     * anyone other than the current leader is silently ignored (a single entry
     * point — dispatchEnvelope).
     * Other kinds (reaction/edit/delete/history-*) are not affected by this
     * restriction: they're lightweight derived operations on already-shown
     * messages, not standalone text.
     *
     * Cooperative safeguard: a modified receiver client can skip this
     * filter and render the envelope anyway — the server doesn't see the P2P bytes
     * and physically cannot prevent their delivery (see
     * docs/permissions-and-leader.md, "Chat — Cooperative Only").
     */
    function isIncomingEnvelopeAllowed(fromPeerId, envelope) {
      if (envelope.kind !== 'text' && envelope.kind !== 'file-offer') return true;
      if (getGuestChatAllowed()) return true;
      return fromPeerId === getLeaderId();
    }

    // H3: kinds that carry self-asserted authorship (envelope.from) — see
    // the discussion in the file header. file-request is deliberately NOT
    // included here: its handler (handleFileRequest) already uses the transport-level
    // fromPeerId, not envelope.from, to decide who to open the file
    // channel for — forging envelope.from there gains an attacker nothing.
    const SELF_ASSERTED_FROM_KINDS = new Set(['text', 'reaction', 'edit', 'delete', 'file-offer']);

    // --- Receiving: a single entry point for messages from the bus ---
    function dispatchEnvelope(fromPeerId, envelope) {
      if (!envelope || typeof envelope !== 'object' || typeof envelope.kind !== 'string') return;
      // H3: the self-asserted envelope.from cannot be trusted — the transport knows
      // the truth (see the file header). We overwrite it BEFORE isIncomingEnvelopeAllowed
      // and before the switch below, so that neither rendering, nor the edit/delete
      // authorship check, nor the message's "own" classification can ever see the forged value.
      if (SELF_ASSERTED_FROM_KINDS.has(envelope.kind) && typeof fromPeerId === 'string') {
        envelope.from = fromPeerId;
      }
      if (!isIncomingEnvelopeAllowed(fromPeerId, envelope)) return;
      switch (envelope.kind) {
        case 'text':
          handleIncomingText(envelope);
          break;
        case 'reaction':
          handleIncomingReaction(envelope);
          break;
        case 'edit':
        case 'delete':
          handleIncomingEditOrDelete(envelope);
          break;
        case 'file-offer':
          handleIncomingFileOffer(envelope);
          break;
        case 'file-request':
          handleFileRequest(fromPeerId, envelope);
          break;
        case 'history-request':
          handleHistoryRequest(fromPeerId);
          break;
        case 'history-response':
          handleHistoryResponse(fromPeerId, envelope);
          break;
        default:
          // Unknown kind (future waves — files, etc.) — ignore silently.
          break;
      }
    }

    function bumpLamportOnReceive(receivedLamport) {
      lamportClock = Math.max(lamportClock, receivedLamport || 0) + 1;
    }

    function handleIncomingText(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      renderAll(false);
      if (panel.classList.contains('hidden')) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    }

    function handleIncomingReaction(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      recomputeReactions();
      renderAll(false);
    }

    /** kind='edit'|'delete' — authorship is checked inside recomputeMessageMeta (see its header and the file header); an envelope with someone else's from is silently not applied. */
    function handleIncomingEditOrDelete(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      recomputeMessageMeta();
      renderAll(false);
    }

    // --- File transfer (Wave 3) ---

    function handleIncomingFileOffer(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      renderAll(false);
      if (panel.classList.contains('hidden')) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    }

    /**
     * The receiver clicks "Download" — we send an addressed file-request to the sender and
     * wait for them to open a file DataChannel. There is no auto-download
     * for any mime type (including images) — until the receiver clicks,
     * any file's card shows only the name and size (see
     * renderFileCardBody, status 'offer'); bytes are never requested on their
     * own, neither for a live offer nor during a history replay (mergeHistory just
     * inserts the message into the buffer, nothing is called here).
     * Idempotent: a repeat call while something is already in progress/ready is a no-op.
     */
    function requestFileDownload(msg) {
      const fileId = msg.fileId;
      const existing = fileStates.get(fileId);
      if (existing && ['requesting', 'transferring', 'done'].includes(existing.status)) return;

      if (!getPeerIds().includes(msg.from)) {
        setFileStatus(fileId, 'unavailable');
        return;
      }

      const expectedLabel = `file-${fileId}-${peerId}`;
      pendingFileRequests.set(fileId, {
        targetPeerId: msg.from,
        expectedLabel,
        mime: msg.mime,
        name: msg.fileName,
        size: msg.size,
      });
      setFileStatus(fileId, 'requesting', { progress: 0 });

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'file-request',
        fileId,
        ts: Date.now(),
      };
      sendEnvelopeToPeer(msg.from, envelope);

      setTimeout(() => {
        const state = fileStates.get(fileId);
        if (state && state.status === 'requesting') {
          pendingFileRequests.delete(fileId);
          setFileStatus(fileId, 'unavailable');
        }
      }, FILE_REQUEST_TIMEOUT_MS);
    }

    /** The sender received an addressed file-request — if we still hold the file, open a file channel to that peer. */
    function handleFileRequest(fromPeerId, envelope) {
      const file = fileSendMap.get(envelope.fileId);
      if (!file) return; // we're not holding this file (or it's no longer relevant) — ignore silently
      beginSendingFile(fromPeerId, file, envelope.fileId);
    }

    function waitForBufferedAmountLow(channel) {
      return new Promise((resolve) => {
        const onLow = () => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
      });
    }

    /**
     * Wait until the entire send buffer has DRAINED (bufferedAmount === 0), before
     * closing the channel. A pitfall (found empirically on a ~300KB file):
     * channel.close() immediately after a series of send() calls does NOT guarantee that bytes
     * already queued but not yet physically sent will reach
     * the peer — for a large enough file (when the synchronous send() loop
     * manages to queue more than one SCTP packet), closing
     * cuts off the "tail" of the data: the receiver consistently sees receivedBytes=0
     * (the channel closes before even the very first message arrives). Small
     * files (fitting in a single packet) appeared to "work" even without this wait —
     * which is what masked the bug. 'bufferedamountlow' is an EDGE-triggered event
     * (fires on crossing the threshold), so if bufferedAmount already reached 0 BEFORE
     * we subscribed, the event will never arrive — we poll
     * bufferedAmount explicitly instead of relying solely on the event.
     */
    function waitForBufferedAmountZero(channel) {
      return new Promise((resolve) => {
        if (channel.bufferedAmount === 0) {
          resolve();
          return;
        }
        const iv = setInterval(() => {
          if (channel.bufferedAmount === 0) {
            clearInterval(iv);
            resolve();
          }
        }, 30);
      });
    }

    /** Sender: open a file DataChannel to the specific requesting peer and stream the file in chunks with backpressure. */
    function beginSendingFile(requesterPeerId, file, fileId) {
      const rtc = bus.getPeer(requesterPeerId);
      if (!rtc) return; // the peer already left between the request and the channel opening

      const label = `file-${fileId}-${requesterPeerId}`;
      let channel;
      try {
        channel = rtc.createFileChannel(label);
      } catch (err) {
        console.error(`Failed to open file DataChannel (${label}):`, err);
        return;
      }
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = FILE_BUFFERED_LOW_THRESHOLD;

      setFileStatus(fileId, 'sending', { progress: 0 });

      channel.onerror = (event) => {
        console.error(`File DataChannel error (sending, fileId=${fileId}):`, event);
      };

      channel.onopen = async () => {
        try {
          channel.send(
            JSON.stringify({
              fileId,
              size: file.size,
              mime: file.type || 'application/octet-stream',
              name: file.name,
            })
          );

          let offset = 0;
          while (offset < file.size) {
            if (channel.bufferedAmount > FILE_BUFFERED_HIGH_WATERMARK) {
              await waitForBufferedAmountLow(channel);
            }
            const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
            const buf = await slice.arrayBuffer();
            channel.send(buf);
            offset += buf.byteLength;
            setFileProgress(fileId, file.size === 0 ? 1 : Math.min(1, offset / file.size));
          }
          setFileStatus(fileId, 'sent', { progress: 1 });
        } catch (err) {
          console.error(`Error sending file (fileId=${fileId}):`, err);
        } finally {
          try {
            await waitForBufferedAmountZero(channel);
            channel.close();
          } catch (err) {
            // the channel may have already closed/broken — not a problem
          }
        }
      };
    }

    /**
     * Receiver: an incoming file DataChannel has arrived (see onFileChannel in
     * rtc.js, dispatched by room.js -> publicApi.handleIncomingFileChannel).
     * We match by an EXACT label match against what we ourselves expected
     * (constructed in requestFileDownload) — no need to parse fileId/peerId out of
     * the label string (both ids are uuids with dashes, a naive split would be
     * ambiguous).
     */
    function handleIncomingFileChannel(fromPeerId, channel) {
      for (const [fileId, req] of pendingFileRequests) {
        if (req.expectedLabel === channel.label) {
          pendingFileRequests.delete(fileId);
          beginReceivingFile(fileId, channel, req);
          return;
        }
      }
      console.warn('Received a file DataChannel with no matching pending request, label=', channel.label);
    }

    function beginReceivingFile(fileId, channel, req) {
      channel.binaryType = 'arraybuffer';
      let meta = null;
      const chunks = [];
      let receivedBytes = 0;

      setFileStatus(fileId, 'transferring', { progress: 0 });

      channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            meta = JSON.parse(event.data);
          } catch (err) {
            console.error(`Invalid JSON metadata on file channel (fileId=${fileId}):`, event.data, err);
          }
          return;
        }
        const buf = event.data;
        chunks.push(buf);
        receivedBytes += buf.byteLength;
        const total = (meta && meta.size) || req.size || 0;
        setFileProgress(fileId, total > 0 ? Math.min(1, receivedBytes / total) : 0);
      };

      channel.onerror = (event) => {
        console.error(`File DataChannel error (receiving, fileId=${fileId}):`, event);
      };

      channel.onclose = () => {
        const total = typeof (meta && meta.size) === 'number' ? meta.size : req.size;
        if (typeof total === 'number' && receivedBytes < total) {
          // The channel closed before all the bytes arrived — almost always because
          // the sender left the room mid-transfer.
          setFileStatus(fileId, 'unavailable');
          return;
        }
        const blob = new Blob(chunks, { type: (meta && meta.mime) || req.mime || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        setFileStatus(fileId, 'done', { objectUrl, blobSize: blob.size, progress: 1 });
      };
    }

    /** File selection (paperclip/drag&drop/paste) — size limit check, an optimistic own card, broadcasting the offer. */
    function handleFilesSelected(fileList) {
      if (!signaling || !bus) return;
      const files = Array.from(fileList || []);
      for (const file of files) {
        if (file.size > FILE_SIZE_LIMIT_BYTES) {
          showError(`File "${file.name}" is larger than 25MB — not sent.`);
          continue;
        }

        const fileId = genId();
        fileSendMap.set(fileId, file);
        // Our own card shouldn't have to wait for any P2P exchange to show a
        // preview/Download — the File is already fully in our possession (fileSendMap above),
        // so we create an objectUrl from it locally and immediately switch
        // fileStates to 'done', using the same field as the receiver does after
        // beginReceivingFile.onclose (see renderFileDoneBody). The message itself
        // hasn't been inserted into messages/DOM yet (insertMessage/renderAll — below),
        // so setFileStatus here just warms up fileStates: its
        // own attempt to redraw the card silently no-ops
        // (findFileOfferByFileId won't find anything), and the up-to-date look
        // will be picked up shortly by the very first renderAll(true) — see
        // renderFileCardBody (which checks state.objectUrl, not status).
        setFileStatus(fileId, 'done', { objectUrl: URL.createObjectURL(file), blobSize: file.size, progress: 1 });

        lamportClock += 1;
        const envelope = {
          v: 1,
          id: genId(),
          lamport: lamportClock,
          from: peerId,
          name: myName || null,
          kind: 'file-offer',
          fileId,
          fileName: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          ts: Date.now(),
        };

        insertMessage(envelope);
        renderAll(true);
        broadcastEnvelope(envelope);
      }
    }

    function handleHistoryRequest(fromPeerId) {
      bus.sendToPeer(fromPeerId, {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'history-response',
        messages: messages.slice(),
      });
    }

    function handleHistoryResponse(fromPeerId, envelope) {
      const waiter = historyResponseWaiters.get(fromPeerId);
      if (!waiter) return; // we weren't waiting for a response from this peer (or already got one) — ignore
      waiter(Array.isArray(envelope.messages) ? envelope.messages : []);
    }

    const KNOWN_HISTORY_KINDS = new Set(['text', 'reaction', 'file-offer', 'edit', 'delete']);

    function mergeHistory(historyMessages) {
      let insertedAny = false;
      for (const msg of historyMessages) {
        if (!msg || typeof msg !== 'object') continue;
        if (!KNOWN_HISTORY_KINDS.has(msg.kind)) continue;
        bumpLamportOnReceive(msg.lamport);
        if (insertMessage(msg)) insertedAny = true;
      }
      if (insertedAny) {
        recomputeReactions();
        recomputeMessageMeta();
        renderAll(true);
      }
    }

    // --- Requesting history from neighbors when joining the room ---
    function waitForBusOpen(targetPeerId, timeoutMs) {
      return new Promise((resolve) => {
        if (bus.isOpen(targetPeerId)) {
          resolve(true);
          return;
        }
        const deadline = Date.now() + timeoutMs;
        const iv = setInterval(() => {
          if (bus.isOpen(targetPeerId)) {
            clearInterval(iv);
            resolve(true);
          } else if (Date.now() >= deadline) {
            clearInterval(iv);
            resolve(false);
          }
        }, 50);
      });
    }

    async function requestHistoryFrom(targetPeerId, timeoutMs) {
      const start = Date.now();
      const opened = await waitForBusOpen(targetPeerId, timeoutMs);
      if (!opened) return null;
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          historyResponseWaiters.delete(targetPeerId);
          resolve(null);
        }, remaining);
        historyResponseWaiters.set(targetPeerId, (msgs) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          historyResponseWaiters.delete(targetPeerId);
          resolve(msgs);
        });
        bus.sendToPeer(targetPeerId, {
          v: 1,
          id: genId(),
          lamport: lamportClock,
          from: peerId,
          name: myName || null,
          kind: 'history-request',
        });
      });
    }

    async function requestHistorySequential(candidatePeerIds) {
      for (const targetPeerId of candidatePeerIds) {
        const msgs = await requestHistoryFrom(targetPeerId, HISTORY_REQUEST_TIMEOUT_MS);
        if (msgs !== null) {
          mergeHistory(msgs);
          return;
        }
      }
      // All candidates exhausted (nobody responded in time) — the
      // newcomer's history stays empty, as it would in an empty room.
    }

    function sendCurrentText() {
      const text = textInput.value.trim();
      if (!text) return;
      if (!signaling || !bus) return;

      if (!checkClientRateLimit()) {
        showError('Too many messages in a row — please wait a moment.');
        return;
      }

      // The editing bar is open — this send edits an existing
      // message (kind='edit') instead of creating a new one (see startEdit).
      if (editTarget) {
        sendEditMessage(text);
        return;
      }

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'text',
        text,
        replyTo: replyTarget ? replyTarget.id : null,
        ts: Date.now(),
      };
      textInput.value = '';
      autoGrowTextInput();
      cancelReply();

      // Our own message — immediately and locally, optimistically (there's no
      // echo from the server anymore: the path is entirely P2P).
      insertMessage(envelope);
      renderAll(true);

      broadcastEnvelope(envelope);
    }

    /** The rate limit was already checked in sendCurrentText — a single counter shared by text and edits. */
    function sendEditMessage(text) {
      const targetId = editTarget.id;
      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'edit',
        target: targetId,
        text,
        ts: Date.now(),
      };
      textInput.value = '';
      autoGrowTextInput();
      cancelEdit();

      if (insertMessage(envelope)) {
        recomputeMessageMeta();
        renderAll(true);
      }
      broadcastEnvelope(envelope);
    }

    /**
     * Called from buildDeleteButton on the second (confirming) click.
     * Not subject to the client-side rate limit (see the file header: a reaction-like
     * lightweight action with its own 3-second UI confirmation, rather than a
     * full-fledged text send).
     */
    function sendDeleteMessage(targetId) {
      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'delete',
        target: targetId,
        ts: Date.now(),
      };

      // Deleting whatever we're currently editing — close the bar and clear the input.
      if (editTarget && editTarget.id === targetId) cancelEditAndClear();

      if (insertMessage(envelope)) {
        recomputeMessageMeta();
        renderAll(false);
      }
      broadcastEnvelope(envelope);
    }

    function sendReactionToggle(targetMsgId, emoji) {
      if (!signaling || !bus) return;
      const already = reactions.get(targetMsgId)?.get(emoji)?.has(peerId) || false;
      const op = already ? 'remove' : 'add';

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'reaction',
        target: targetMsgId,
        emoji,
        op,
        ts: Date.now(),
      };

      if (insertMessage(envelope)) {
        recomputeReactions();
        renderAll(false);
      }

      broadcastEnvelope(envelope);
    }

    toggleButton.addEventListener('click', () => {
      const isOpen = !panel.classList.contains('hidden');
      setCollapsed(isOpen);
    });
    collapseButton.addEventListener('click', () => setCollapsed(true));

    sendButton.addEventListener('click', sendCurrentText);
    // Owner requirement ("Telegram-like"): Enter is ALWAYS a line
    // break, both on mobile and desktop — sending only happens via the button
    // (paper plane). Cmd/Ctrl+Enter is a desktop convenience for sending, it doesn't
    // replace plain Enter. Plain Enter is deliberately NOT
    // intercepted here (no event.preventDefault()) — a regular line break
    // remains entirely native textarea browser behavior.
    textInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendCurrentText();
        return;
      }
      handleFormattingShortcut(event);
    });

    /**
     * Auto-grow the textarea by number of lines (wave 13, "Telegram-like") —
     * grows up to MAX_INPUT_LINES, beyond that — internal scroll on the textarea
     * itself (overflow-y:auto), the input panel itself doesn't move (only
     * the textarea itself grows, the buttons are anchored to the bottom via align-items:flex-end on
     * .chat-input-row, see style.css). Recomputed on every input
     * event and everywhere value changes programmatically (edit/send/cancel
     * editing/formatting hotkeys) — see the calls below.
     * Height is computed via a temporary reset to 'auto' (so scrollHeight
     * reflects the ACTUAL content, not the current stretched height) — border
     * is accounted for separately (scrollHeight doesn't include border, while
     * box-sizing:border-box on .chat-text-input assumes height INCLUDING
     * border, see style.css).
     *
     * Input row layout (wave 14): as long as the textarea fits on one
     * line — a compact horizontal row [📎][Aa][textarea][➤] (as
     * before). As soon as it grows past one line, the buttons
     * (📎/Aa/➤, wrapped in .chat-input-actions — see buildDom) rearrange
     * into a vertical column to the right of the textarea, anchored to the bottom: see
     * .chat-input-row--expanded in style.css (also explained there — why this works
     * without moving the buttons in the DOM: .chat-input-actions in normal mode is
     * display:contents, in expanded mode a genuine flex-column). The number of lines
     * is counted from the content (scrollHeight minus padding), not from the
     * final (already capped at MAX_INPUT_LINES) height.
     */
    function autoGrowTextInput() {
      const style = getComputedStyle(textInput);
      const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const lineHeight = parseFloat(style.lineHeight) || 20;
      textInput.style.height = 'auto';
      const desired = textInput.scrollHeight + borderY;
      const maxHeight = Math.round(lineHeight * MAX_INPUT_LINES + paddingY + borderY);
      textInput.style.height = `${Math.min(desired, maxHeight)}px`;
      textInput.style.overflowY = desired > maxHeight ? 'auto' : 'hidden';

      const numLines = Math.round((textInput.scrollHeight - paddingY) / lineHeight);
      inputRow.classList.toggle('chat-input-row--expanded', numLines > 1);
    }

    textInput.addEventListener('input', () => {
      const wasNearBottom = isNearBottom();
      autoGrowTextInput();
      if (wasNearBottom) scrollToBottom();
    });

    // --- Desktop formatting hotkeys (see the file header) ---
    // The formatting toolbar (by selection/by the "Aa" button, shared across all
    // layouts) — see the block below, after handleFormattingShortcut, reuses
    // these SAME wrapper functions.
    /**
     * Wrap textInput's current selection in a pair of markers (**, __, ~~, ||,
     * `); no selection — insert an empty pair and place the cursor BETWEEN the
     * markers (rather than leaving a placeholder), as required by the hotkey
     * spec.
     */
    function wrapSelectionWithMarkers(before, after) {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      const value = textInput.value;
      const selected = value.slice(start, end);
      textInput.value = value.slice(0, start) + before + selected + after + value.slice(end);
      const cursor = selected
        ? start + before.length + selected.length + after.length
        : start + before.length;
      textInput.setSelectionRange(cursor, cursor);
      textInput.focus();
      autoGrowTextInput();
    }

    /**
     * Cmd/Ctrl+Shift+K — wrap the selection in a markdown link [text](url), with
     * the URL supplied via window.prompt (no selection — a "link"
     * placeholder instead of text). Canceling the prompt (null/empty) is a no-op, nothing gets
     * inserted.
     */
    function insertLinkMarkdown() {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      const value = textInput.value;
      const selected = value.slice(start, end);
      const url = window.prompt('Link (URL):', 'https://');
      if (!url) {
        textInput.focus();
        return;
      }
      const inserted = `[${selected || 'link'}](${url})`;
      textInput.value = value.slice(0, start) + inserted + value.slice(end);
      const cursor = start + inserted.length;
      textInput.setSelectionRange(cursor, cursor);
      textInput.focus();
      autoGrowTextInput();
    }

    /**
     * Cmd/Ctrl+B/I — bold/italic without Shift; Cmd/Ctrl+Shift+X/P/M/K —
     * strikethrough/spoiler/inline code/link. metaKey — Mac (Cmd), ctrlKey —
     * Windows/Linux (Ctrl); both are handled identically, there's no real reason to
     * distinguish them for these combinations (none of them are claimed by the browser in a
     * plain <textarea>).
     */
    function handleFormattingShortcut(event) {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === 'b') {
        event.preventDefault();
        wrapSelectionWithMarkers('**', '**');
      } else if (!event.shiftKey && key === 'i') {
        event.preventDefault();
        wrapSelectionWithMarkers('__', '__');
      } else if (event.shiftKey && key === 'x') {
        event.preventDefault();
        wrapSelectionWithMarkers('~~', '~~');
      } else if (event.shiftKey && key === 'p') {
        event.preventDefault();
        wrapSelectionWithMarkers('||', '||');
      } else if (event.shiftKey && key === 'm') {
        event.preventDefault();
        wrapSelectionWithMarkers('`', '`');
      } else if (event.shiftKey && key === 'k') {
        event.preventDefault();
        insertLinkMarkdown();
      }
    }

    // --- Formatting toolbar (wave 11; desktop — see the fix below) ---
    //
    // Typing "**"/"||" by hand is inconvenient everywhere, not just on a phone — on
    // desktop, hotkeys exist (Cmd/Ctrl+B/I/Shift+X/P/M/K, see above),
    // but without this toolbar (or the "Aa" button itself) they were COMPLETELY
    // undiscoverable: no hint that formatting even exists,
    // unless you already know the hotkeys. The toolbar is now shared across all
    // layouts, with two triggers that show the SAME toolbar (reusing
    // wrapSelectionWithMarkers/insertLinkMarkdown — the same logic as the
    // hotkeys, no separate formatting code):
    //   1) "by selection" — select text in the textarea and the toolbar appears
    //      on its own (see document 'selectionchange' below);
    //   2) "by button" — the "Aa" button next to the input (see formatToggleButton)
    //      opens the same toolbar manually (also works without a selection —
    //      in that case the buttons insert an empty pair of markers with the cursor between
    //      them, the same fallback behavior as the hotkeys without a selection).
    // Both states are independent and combined with OR — see
    // updateFormatToolbarVisibility: the toolbar is visible if it was opened manually (Aa)
    // OR there's currently a non-empty selection.
    function updateFormatToolbarVisibility() {
      const hasSelection =
        document.activeElement === textInput && textInput.selectionStart !== textInput.selectionEnd;
      const shouldShow = formatToolbarForcedOpen || hasSelection;
      formatToolbar.classList.toggle('hidden', !shouldShow);
      formatToggleButton.classList.toggle('chat-format-toggle-button--on', formatToolbarForcedOpen);
      formatToggleButton.setAttribute('aria-pressed', String(formatToolbarForcedOpen));
    }

    formatToggleButton.addEventListener('click', () => {
      formatToolbarForcedOpen = !formatToolbarForcedOpen;
      if (formatToolbarForcedOpen) textInput.focus();
      updateFormatToolbarVisibility();
    });

    // 'selectionchange' — a global DOM event (not tied to a specific element):
    // we filter by activeElement inside updateFormatToolbarVisibility. It catches
    // selection made by swipe/long-press on a phone, by mouse on desktop, and
    // programmatic selection changes (including textInput.setSelectionRange
    // from wrapSelectionWithMarkers/insertLinkMarkdown themselves after
    // formatting is applied — the selection collapses to a cursor,
    // hasSelection becomes false, and the toolbar hides itself unless
    // pinned open by the "Aa" button).
    document.addEventListener('selectionchange', updateFormatToolbarVisibility);

    // Toolbar buttons: mousedown with preventDefault — so that tapping the button does NOT
    // steal focus (and, with it, the selection) from the textarea BEFORE the
    // click handler below gets a chance to read textInput.selectionStart/End
    // (in fact selectionStart/End aren't reset on losing focus — they're
    // just properties of the DOM element — but preventDefault on mousedown is a
    // common and more robust technique for formatting toolbars,
    // one that doesn't rely on this particular browser implementation detail). click still
    // fires as usual — preventDefault on mousedown only cancels
    // the focus/selection of the button itself, not the subsequent click.
    formatToolbar.querySelectorAll('.chat-format-btn').forEach((btn) => {
      btn.addEventListener('mousedown', (event) => event.preventDefault());
      btn.addEventListener('click', () => {
        switch (btn.dataset.format) {
          case 'bold':
            wrapSelectionWithMarkers('**', '**');
            break;
          case 'italic':
            wrapSelectionWithMarkers('__', '__');
            break;
          case 'strike':
            wrapSelectionWithMarkers('~~', '~~');
            break;
          case 'spoiler':
            wrapSelectionWithMarkers('||', '||');
            break;
          case 'code':
            wrapSelectionWithMarkers('`', '`');
            break;
          case 'link':
            insertLinkMarkdown();
            break;
          default:
            break;
        }
        updateFormatToolbarVisibility();
      });
    });

    // --- File sending UI: paperclip, drag&drop, pasting an image from the clipboard ---
    attachButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      handleFilesSelected(fileInput.files);
      fileInput.value = ''; // reset — otherwise re-selecting the SAME file won't fire change
    });

    panel.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    panel.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length > 0) handleFilesSelected(files);
    });

    textInput.addEventListener('paste', (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        handleFilesSelected(files);
      }
    });

    /**
     * A single point that applies the input state — accounts for BOTH independent
     * reasons to disable sending at the same time (a lost connection and the leader's
     * restriction, see the controller constructor's header): connectionLost takes
     * priority over forbiddenByLeader simply by check order (both produce
     * the same visual effect anyway — a disabled input with an explanatory
     * placeholder).
     */
    function applyInputState() {
      if (connectionLost) {
        textInput.disabled = true;
        sendButton.disabled = true;
        attachButton.disabled = true;
        textInput.placeholder = 'Connection lost.';
        return;
      }
      if (forbiddenByLeader) {
        textInput.disabled = true;
        sendButton.disabled = true;
        attachButton.disabled = true;
        textInput.placeholder = 'Chat disabled by the leader';
        return;
      }
      textInput.disabled = false;
      sendButton.disabled = false;
      attachButton.disabled = false;
      textInput.placeholder = 'Message…';
    }

    function enableInput() {
      connectionLost = false;
      applyInputState();
    }

    function disableInput(reason) {
      connectionLost = true;
      applyInputState();
    }

    /** Called by room.js on applyGuestEnforcement()/settings-changed (see docs/permissions-and-leader.md). */
    function setChatForbidden(forbidden) {
      forbiddenByLeader = forbidden;
      applyInputState();
    }

    const publicApi = {
      disableInput,
      enableInput,
      setChatForbidden,
      handleIncomingFileChannel,
      notifyBusOpen,
    };

    function handleServerError({ message }) {
      // Server-side errors (e.g. rate limit) — shown in the panel via the same banner.
      if (message) showError(message);
    }

    function attach({
      signaling: newSignaling,
      bus: newBus,
      peerId: newPeerId,
      name,
      getPeerIds: newGetPeerIds,
      initialPeerIds,
      getLeaderId: newGetLeaderId,
      getGuestChatAllowed: newGetGuestChatAllowed,
    }) {
      signaling = newSignaling;
      bus = newBus;
      peerId = newPeerId;
      myName = name || null;
      getPeerIds = typeof newGetPeerIds === 'function' ? newGetPeerIds : () => [];
      getLeaderId = typeof newGetLeaderId === 'function' ? newGetLeaderId : () => null;
      getGuestChatAllowed = typeof newGetGuestChatAllowed === 'function' ? newGetGuestChatAllowed : () => true;

      clearMessages();
      unreadCount = 0;
      updateUnreadBadge();
      errorBanner.classList.add('hidden');
      connectionLost = false;
      forbiddenByLeader = false;
      applyInputState();
      setCollapsed(true);

      // Chat travels EXCLUSIVELY over the P2P bus (DataChannel, E2E thanks to DTLS).
      // There is no longer a server-side fallback relay for chat (see docs/chat.md): if
      // the bus to the recipient isn't open yet, the envelope is queued locally and goes out
      // once it opens (see sendEnvelopeToPeer/notifyBusOpen), rather than through the server.
      bus.onMessage(dispatchEnvelope);
      signaling.on('error', handleServerError);

      const candidates = Array.isArray(initialPeerIds) ? initialPeerIds.slice() : [];
      if (candidates.length > 0) {
        requestHistorySequential(candidates);
      }
      // An empty room (candidates is empty) — nobody to ask, history stays empty.
    }

    return { attach, publicApi };
  }

  return { create };
})();
