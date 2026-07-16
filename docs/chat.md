# Chat

<!-- toc -->

- [1. Transport](#1-transport)
- [2. The Message Envelope](#2-the-message-envelope)
- [3. Ordering: Lamport Clocks](#3-ordering-lamport-clocks)
- [4. Deduplication & History](#4-deduplication--history)
- [5. Envelope Kinds](#5-envelope-kinds)
  - [5.1 `text`](#51-text)
  - [5.2 `reaction`](#52-reaction)
  - [5.3 `edit` / `delete`](#53-edit--delete)
  - [5.4 `file-offer` / `file-request`](#54-file-offer--file-request)
  - [5.5 `history-request` / `history-response`](#55-history-request--history-response)
- [6. Identity Binding (Who Really Sent This)](#6-identity-binding-who-really-sent-this)
- [7. Text Formatting](#7-text-formatting)
- [8. Reactions & Replies](#8-reactions--replies)
- [9. Edit & Delete](#9-edit--delete)
- [10. File Transfer](#10-file-transfer)
- [11. Rate Limiting](#11-rate-limiting)
- [12. No Server Fallback](#12-no-server-fallback)

<!-- /toc -->

> Source of truth: [`../static/chat.js`](../static/chat.js). Bus transport
> mechanics are in [`webrtc-mesh.md` §3](webrtc-mesh.md#3-the-data-channel-bus).
> Chat runs only over the bus — there is no server relay for it (see
> [§12](#12-no-server-fallback)); what the server can and cannot see about chat
> is covered in [`privacy.md`](privacy.md).

## 1. Transport

Chat travels **exclusively between participants** over the mesh
`RTCDataChannel` bus (see [`webrtc-mesh.md`](webrtc-mesh.md)):

- **The only path**: broadcast an envelope to every peer whose bus channel is
  currently open.
- **Not yet open**: for a peer whose channel hasn't opened yet, the envelope
  is held in a small **local outgoing queue** and flushed onto the bus the
  moment that peer's channel opens (see [`../static/chat.js`](../static/chat.js):
  `sendEnvelopeToPeer` / `notifyBusOpen`). It is **never** relayed through the
  server.

There is **no server-relayed chat fallback** — the earlier addressed
`chat`/`envelope` relay was removed (see [§12](#12-no-server-fallback) for the
rationale). The server never sees, parses, relays, or stores chat content in
any capacity; if no peer-to-peer path exists at all (direct or via TURN),
there is simply no chat — and no media either, since the server carries no
media. This keeps a single, uniform end-to-end story: everything is DTLS
between the two browsers, with nothing weaker running alongside it.

## 2. The Message Envelope

Every chat-related message is a JSON object, deliberately **extensible** —
new fields and new `kind` values can be added without breaking older
clients, which silently ignore a `kind` they don't recognize:

```
{ v: 1, id, lamport, from, name, kind, ...kind-specific fields, ts }
```

- `id` — a locally generated unique id for this message.
- `lamport` — this sender's Lamport clock value at send time (see
  [§3](#3-ordering-lamport-clocks)).
- `from` — the sender's peer id. **Self-asserted on the wire** but
  normalized against the true transport sender before use — see
  [§6](#6-identity-binding-who-really-sent-this).
- `name` — the sender's display name at send time.
- `kind` — the envelope's type; see [§5](#5-envelope-kinds).
- `ts` — client send time (`Date.now()`), used only for display. Not part
  of the protocol's ordering guarantee (see [§3](#3-ordering-lamport-clocks));
  it's a client-side convenience field layered on top of an otherwise opaque
  (to the server) envelope.

Own messages render immediately, optimistically, without waiting for any
echo — there is no echo in this design; the whole path is peer-to-peer.

## 3. Ordering: Lamport Clocks

Every client keeps a Lamport clock: incremented by one on send, and set to
`max(own, received) + 1` on receipt of any envelope carrying a `lamport`
value. The feed's display order is `(lamport, from)` — a total order that
every participant computes identically regardless of the order messages
actually arrived over the network. This is what lets `edit`/`delete`/
reaction application (see [§5](#5-envelope-kinds)) be replayed
deterministically from a buffer that may have been assembled out of network
order.

## 4. Deduplication & History

- Each tab keeps an in-memory buffer of the last 50 envelopes (`text` +
  `reaction` + `edit` + `delete` + `file-offer` — everything that needs to
  survive for a late joiner to reconstruct state), deduplicated by `id`.
  This buffer is **not persisted** — it lives only in tab memory and is gone
  on reload/close (see [`privacy.md`](privacy.md)).
- A participant who joins mid-conversation requests history from the first
  peer listed in their `joined.peers` (see
  [`signaling-protocol.md`](signaling-protocol.md)): `history-request` →
  `history-response { messages: [...] }` over the bus. If that peer's
  channel doesn't open, or doesn't answer, within a timeout, the client
  tries the next peer. If the room was empty on arrival, there is simply no
  one to ask, and history stays empty.
- `history-request`/`history-response` never enter the 50-message buffer
  themselves (they are transient, not history-worthy).

## 5. Envelope Kinds

### 5.1 `text`

```
{ v: 1, id, lamport, from, name, kind: 'text', text, replyTo, ts }
```

`replyTo` is the `id` of the message being replied to, or `null`.

### 5.2 `reaction`

```
{ v: 1, id, lamport, from, name, kind: 'reaction', target, emoji, op, ts }
```

`target` is the reacted-to message's `id`; `emoji` is one of a fixed set;
`op` is `'add'` or `'remove'` (clicking your own existing reaction again
sends `'remove'` — a toggle on the sender's side, applied identically by
everyone in `(lamport, from)` order). The reaction state for a message
(`Map<emoji, Set<peerId>>`) is always recomputed from scratch over the whole
buffer in that order, so the result never depends on network delivery order.

### 5.3 `edit` / `delete`

```
{ v: 1, id, lamport, from, name, kind: 'edit',   target, text, ts }
{ v: 1, id, lamport, from, name, kind: 'delete', target, ts }
```

`target` is the `id` of the message (a `text` or a `file-offer`) being
edited or deleted. See [§9](#9-edit--delete) for the authorship check and
ordering rules that make this safe.

### 5.4 `file-offer` / `file-request`

```
{ v: 1, id, lamport, from, name, kind: 'file-offer', fileId, fileName, size, mime, ts }
{ v: 1, id, lamport, from, name, kind: 'file-request', fileId, ts }
```

See [§10](#10-file-transfer) for the full transfer protocol these two kinds
bootstrap.

### 5.5 `history-request` / `history-response`

```
{ kind: 'history-request' }
{ kind: 'history-response', messages: [ ...envelopes ] }
```

Transient control messages — never stored in the history buffer themselves
(see [§4](#4-deduplication--history)). `history-response`'s own `from` *is*
normalized like any other envelope (it's not in the set exempted in
[§6](#6-identity-binding-who-really-sent-this)) since the responder's
identity is genuinely their own claim — but the historical envelopes nested
inside its `messages` array are data, not an assertion of authorship by the
responder, so they are deliberately **not** re-normalized against the
responder's transport identity. A participant answering a history request
can, in principle, hand back historical envelopes with any `from` they like
— this is a known, accepted limitation of the same cooperative-trust model
described in [§6](#6-identity-binding-who-really-sent-this) and
[`security.md`](security.md): the server cannot see or validate P2P chat
traffic at all, so this is not a gap the server could plausibly close either.

## 6. Identity Binding (Who Really Sent This)

**H3 mitigation.** `envelope.from` is a **self-asserted** field — nothing
stops a sender from writing someone else's peer id into it. What can't be
forged is the **transport-level** identity of who actually delivered the
message: over the bus, that's the peer id of the specific `RtcPeer` whose
data channel carried it — the client cannot control this value. (Chat only
ever travels over the bus now; there is no server relay for it.)

Before any other processing, the dispatcher overwrites `envelope.from` with
this true transport identity for every `kind` that carries authorship
(`text`, `reaction`, `edit`, `delete`, `file-offer`). This is a
**normalization**, not a rejection: without it, any participant could send a
`text`/`edit`/`delete`/`file-offer` with `envelope.from` set to someone
else's peer id and have it rendered — or an edit/delete accepted — as if it
came from that other person, because rendering and the edit/delete
authorship check both used to read `envelope.from` directly with nothing
cross-checking it against the real sender. Normalizing at the single point
where messages enter the dispatcher fixes the field for every downstream
consumer (rendering, replies, "is this my own message" classification, the
authorship check in [§9](#9-edit--delete)) at once, rather than requiring
each consumer to re-derive trust independently.

`file-request` is deliberately **not** in the normalized set: its own
handler already keys off the true transport sender directly (to decide who
to open a file channel to), so forging `envelope.from` on a `file-request`
gains an attacker nothing.

## 7. Text Formatting

`text` messages support a small, deliberately limited markdown subset:
`**bold**`, `*italic*`, `~~strikethrough~~`, and `> ` at the start of a line
for a block quote. `http(s)` links are made clickable **without** link
preview cards — no network request is made on a participant's behalf just
because a URL appeared in a message, to avoid leaking that a link was seen
to any third party.

**Rendering is DOM-based, never `innerHTML`, for anything derived from
user input** — messages are built with `createElement`/`textContent`.
`innerHTML` is used only for static markup that does not depend on user
data at all (the panel chrome, the reaction popover).

## 8. Reactions & Replies

- **Reactions**: a fixed emoji set, applied via `add`/`remove` envelopes
  (see [§5.2](#52-reaction)); the current reaction state for a message is
  always a full recomputation over the ordered buffer, not an incremental
  patch, so it's insensitive to delivery order.
- **Replies**: a "reply" action on any message opens a compact composer
  banner; sending fills in the new envelope's `replyTo`. A reply renders a
  quoted preview of the original (name + truncated text) pulled from the
  local buffer; clicking the quote smooth-scrolls to and briefly highlights
  the original message.

## 9. Edit & Delete

An `edit` or `delete` envelope is applied **only if** `envelope.from`
(already normalized — see [§6](#6-identity-binding-who-really-sent-this))
matches the `from` of the **original** message with that `target` id, looked
up in the same local buffer. If the original has already been evicted from
the 50-message buffer, there's nothing to check authorship against, so the
edit/delete is ignored — a deliberately safe default. `edit` only applies to
`kind: 'text'` (a `file-offer` has no text to edit).

Multiple `edit`s on the same `target` — the buffer is already sorted by
`(lamport, from)`, so replaying it in order and overwriting a per-message
"overlay" state (`{ deleted, editText }`) naturally makes the **last** edit
in that order win. Once a valid `delete` has been applied to a target, any
**subsequent** (higher-lamport) `edit` on that target no longer applies —
deletion is a final state that a later edit cannot undo.

Because `edit`/`delete` envelopes live in the same 50-message history buffer
as `text`/`reaction`/`file-offer` and ride the same history-replay path, a
late joiner who requests history replays the same overlay computation over
the full replay and immediately sees the final state (an edited body, or a
tombstone reading "message deleted") rather than the stale original.

## 10. File Transfer

Strictly peer-to-peer — the server never sees file bytes, under any
circumstance.

1. **Offer.** The sender posts a `file-offer` envelope through the normal
   chat transport (bus broadcast) and it lands in the same
   history buffer as text messages — a late joiner sees the file card from
   history replay exactly as they would a historical text message. The
   actual `File` object lives only in the sender's tab memory
   (`fileId → File`); the buffer and any history replay carry only metadata
   (name, size, MIME type), never content.
2. **Request.** To actually download, a recipient sends an addressed (not
   broadcast) `file-request` envelope back to the offering peer. This kind
   never enters the history buffer (transient, like
   `history-request`/`history-response`).
3. **Channel.** If the offering peer still holds that `File` (by `fileId`),
   it opens a **new**, dedicated `RTCDataChannel` on the existing peer
   connection for that pair, labeled `file-{fileId}-{requester}`, and the
   requester matches the incoming channel by exact label (see
   [`webrtc-mesh.md` §3](webrtc-mesh.md#3-the-data-channel-bus) on
   label-based dispatch).
4. **Transfer.** The channel's first message is a JSON metadata object
   (`{fileId, size, mime, name}`); after that, binary chunks of 16KB each,
   with backpressure managed via `bufferedAmount`
   (`bufferedamountlow` threshold / high-watermark pause). The sender waits
   for `bufferedAmount === 0` before closing the channel — closing
   immediately after queuing sends was found to silently drop the tail of
   larger files, since `bufferedamountlow` is an edge-triggered event and
   won't fire if the buffer was already empty before the listener attached.
   The receiver accumulates chunks into a `Blob` and checks the final size
   against the declared size.
5. **Unavailability.** An offer with no live P2P channel to the sender (the
   sender having since left, or no channel ever formed) results in the
   card honestly showing "unavailable" — the product never falls back to
   proxying file bytes through the server (see
   [`PRD.md` §5.3](PRD.md#53-chat) and [`privacy.md`](privacy.md)).

Limits: 25MB per file, 16KB per chunk. Downloading is always an explicit
action — a fresh offer, of any mime type or size, renders as a card with
just the file's name and size and a Download button; nothing is requested
over the wire until the recipient clicks it (an earlier version auto-
downloaded images ≤2MB with no click; that path was removed). The sender's
own card is the one exception, and not really an exception at all: it goes
straight to the same "done" body a recipient sees after downloading, because
the sender already holds the full `File` locally and has nothing to
request.

## 11. Rate Limiting

A **client-side, soft** rate limit — no more than 10 messages per 10 seconds
— blocks sending with an inline error in the panel. Since chat never touches
the server, this is the *only* chat rate limit there is (there is no
server-side chat limit any more); reactions are not subject to it at all,
being lightweight toggle events rather than full messages.

## 12. No Server Fallback

Chat has **no server-relayed fallback**. An earlier version relayed
addressed `chat`/`envelope` messages through the signaling server for the
bootstrap window before a pair's bus channel opened; that path was removed.

The reasoning: the server carries no media, so a session with no
peer-to-peer path (direct or via TURN) has no call to speak of — a
text-only "chat over the server" mode would prop up a corner where the
actual product is already dead, at the cost of a second, weaker transport
that bypasses the bus's DTLS end-to-end guarantee and complicates the trust
story (see [`sas-verification.md`](sas-verification.md) and
[`e2e-encryption.md`](e2e-encryption.md)). The bootstrap window is instead
covered by a purely **local** outgoing queue that flushes onto the bus when
the channel opens ([§1](#1-transport)) — one transport, no server chat path,
and "no verification code shown" now unambiguously means "not connected yet"
rather than "connected but unverifiable."

Consequently the `guestChat` permission is now **cooperative only**, like the
audio/video/screen permissions — there is no server-visible chat path left to
gate. See [`permissions-and-leader.md`](permissions-and-leader.md) for the
honest statement of what is and isn't enforceable.
