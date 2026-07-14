# End-to-End Encryption of Signaling

<!-- toc -->

- [1. Why This Exists](#1-why-this-exists)
- [2. Key Model](#2-key-model)
  - [2.1 The Room Key](#21-the-room-key)
  - [2.2 Key Derivation (HKDF-SHA256 → Three AES-256-GCM Keys)](#22-key-derivation-hkdf-sha256--three-aes-256-gcm-keys)
- [3. What Is Encrypted, What Isn't](#3-what-is-encrypted-what-isnt)
  - [3.1 Encrypted Under a Derived Key](#31-encrypted-under-a-derived-key)
  - [3.2 Never Touched by This Layer (Already E2E via DTLS)](#32-never-touched-by-this-layer-already-e2e-via-dtls)
  - [3.3 What Remains Visible to the Server Regardless](#33-what-remains-visible-to-the-server-regardless)
- [4. Trust Split (Static Origin vs. Signaling Server)](#4-trust-split-static-origin-vs-signaling-server)
- [5. Threat Model](#5-threat-model)
- [6. Known Limitations](#6-known-limitations)
- [7. Forward Secrecy for Content on Membership Change (Ш3)](#7-forward-secrecy-for-content-on-membership-change-ш3)
  - [7.1 What Rotates, What Doesn't](#71-what-rotates-what-doesnt)
  - [7.2 Who Rotates, and When](#72-who-rotates-and-when)
  - [7.3 Distribution: Strictly Over the P2P Bus](#73-distribution-strictly-over-the-p2p-bus)
  - [7.4 Storage: A Map of Epochs, Never Discarded](#74-storage-a-map-of-epochs-never-discarded)
  - [7.5 Bootstrapping a Newcomer](#75-bootstrapping-a-newcomer)
  - [7.6 Wire Format](#76-wire-format)
  - [7.7 What This Does and Doesn't Fix — Stated Plainly](#77-what-this-does-and-doesnt-fix--stated-plainly)

<!-- /toc -->

> Source of truth: [`../static/crypto.js`](../static/crypto.js) (key
> derivation, encrypt/decrypt), [`../static/rtc.js`](../static/rtc.js) (where
> signaling ciphertext is produced/consumed), [`../static/landing.js`](../static/landing.js)
> (room-key generation at room creation). Wire-level field shapes are in
> [`signaling-protocol.md`](signaling-protocol.md).

## 1. Why This Exists

Before this layer existed, the signaling server saw SDP offers/answers and
ICE candidates in plaintext. It had no legitimate reason to parse them (and
didn't — it only relayed them), but nothing *structurally* prevented a
compromised or coerced server (or anyone with access to traffic reaching it)
from reading them, and — more seriously — from rewriting the DTLS
fingerprints embedded in the SDP to insert itself as a man-in-the-middle of
a WebRTC connection, even though the media itself travels peer-to-peer. This
phase removes that capability structurally rather than by policy: the
signaling server never has the key needed to read or tamper with what it
relays.

## 2. Key Model

### 2.1 The Room Key

The room key, `k`, is 32 random bytes generated **client-side** when a
meeting is created (see [`../static/landing.js`](../static/landing.js)) and
carried only in the URL **fragment** of the meeting link (`#k=...`). The
fragment is never sent to any server by the browser under any normal
navigation, so the signaling server never sees `k` and plays no part in
generating it. Sharing the link is therefore the entire key-distribution
mechanism — see [`privacy.md`](privacy.md) for what this implies about who
can read a meeting.

### 2.2 Key Derivation (HKDF-SHA256 → Three AES-256-GCM Keys)

From `k`, three independent AES-256-GCM keys are derived via HKDF-SHA256
(see [`../static/crypto.js`](../static/crypto.js): `deriveKeys`), one per
purpose, each with a distinct HKDF `info` string:

| Context | `info` string | Used for |
|---|---|---|
| `K_sig` | `"sig-v1"` | `sdp` / `candidate` / `info` fields relayed through the signaling server |
| `K_meta` | `"meta-v1"` | The participant's display name in `join-room` |
| `K_chat` | `"chat-v1"` | The addressed fallback chat envelope relayed through the server (see [`chat.md`](chat.md)) |

Deriving three separate keys from one `k` means compromising one context
(e.g., somehow recovering `K_chat`) gives no help recovering the other two.
The HKDF salt is intentionally empty: the only secret input material is `k`
itself (32 random bytes with adequate entropy) — HKDF's salt exists to
separate *independent* sources of key material, and there is only one source
here, with nothing else available to use as a salt (RFC 5869 explicitly
permits an empty salt).

Two wire encodings are used, both AES-256-GCM with a random 12-byte IV:

- **Opaque object form**, for JSON-typed protocol fields (`sdp`, `candidate`,
  `info`, the chat fallback envelope): `{ v: 1, iv: base64, ct: base64 }`.
- **Opaque string form**, for the one protocol field that must stay a plain
  string rather than an object — the participant's `name` in `join-room`:
  IV and ciphertext are concatenated and the whole thing base64-encoded into
  one string.

## 3. What Is Encrypted, What Isn't

### 3.1 Encrypted Under a Derived Key

- `sdp` / `candidate` / `info` in `offer` / `answer` / `ice-candidate` /
  `stream-info` — the server sees only `{v, iv, ct}`, never a real SDP body
  or its DTLS fingerprints.
- The participant's display name in `join-room` — a ciphertext string
  instead of plaintext; a peer that fails to decrypt it (wrong room key)
  falls back to showing a generic placeholder name rather than erroring.
- The addressed fallback chat envelope, wrapped whole as `{enc: {v, iv, ct}}`
  (see [`chat.md`](chat.md)).

### 3.2 Never Touched by This Layer (Already E2E via DTLS)

The mesh data-channel bus (chat, `stream-info` snapshots once the bus is
open — see [`webrtc-mesh.md`](webrtc-mesh.md)) and media tracks are **not**
encrypted by this layer: WebRTC is required to carry both over DTLS between
the two specific browsers involved, which is already a complete end-to-end
guarantee for that pair. A second application-level encryption pass over
traffic that already has this property would add no new security guarantee,
only CPU cost.

### 3.3 What Remains Visible to the Server Regardless

Even with this layer fully in place, the signaling server (and anyone with
equivalent access to it) still sees: participants' IP addresses (at the
transport level — see [`privacy.md`](privacy.md) on what is and isn't
logged), the room id, each participant's peer id, the timing of
connections/messages, and the bare fact that some set of peer ids is sharing
a room. None of the *content* (what was said, how someone is named, what
video is playing) is visible — but this metadata is not, and cannot be
without a fundamentally different architecture (see
[`webrtc-mesh.md` §1](webrtc-mesh.md#1-topology) on why a server-mediated
architecture was rejected).

## 4. Trust Split (Static Origin vs. Signaling Server)

Before this layer's server/frontend trust split, the same operator served
both the client JavaScript (including the encryption code itself) and the
signaling server — a compromised or coerced backend could in principle have
served tampered client code and defeated the whole scheme at its root. A
deployment that serves the static frontend from an origin independent of the
signaling server (see [`self-hosting.md`](self-hosting.md) and
[`DESIGN.md` §1.2](DESIGN.md#12-trust-split)) closes that gap: one operator
no longer needs to simultaneously control both the code the client runs and
the signaling channel that code talks to. This split is optional — a
single-origin deployment (one process serving both) remains supported and is
the simpler default, at the cost of reintroducing that single point of
trust.

## 5. Threat Model

What this layer defends against:

- **A passive observer of signaling traffic** (the server operator, or
  anyone with access to traffic reaching the signaling server) reading SDP
  bodies, ICE candidates, participant names, or fallback chat content.
- **An active signaling server tampering with DTLS fingerprints** in transit
  to man-in-the-middle a WebRTC connection — it cannot construct a valid
  ciphertext without the room key, so a tampered SDP fails to decrypt rather
  than silently succeeding with attacker-controlled fingerprints.

What it does **not** defend against (see [§6](#6-known-limitations) and
[`security.md`](security.md) for the fuller threat catalog):

- Anyone who has the meeting link has the room key and can decrypt
  everything relayed through the server for that room — the link **is**
  the credential; there is no separate per-participant authentication.
- Metadata visible to the server regardless of this layer (see
  [§3.3](#33-what-remains-visible-to-the-server-regardless)).
- The media and chat content once it's flowing over the mesh — that's
  protected by DTLS/WebRTC itself, a different (and, for that traffic,
  sufficient) mechanism.

## 6. Known Limitations

- **Forward secrecy is now PARTIAL, not absent** — see
  [§7](#7-forward-secrecy-for-content-on-membership-change-ш3) for the full
  picture. `K_chat`/`K_meta` are rotated by the room's leader whenever the
  membership changes (a participant leaves, or a lobby request is rejected),
  so content relayed through the server's fallback path *after* that point is
  unreadable by whoever just left. This is narrower than it sounds — read
  [§7.7](#77-what-this-does-and-doesnt-fix--stated-plainly) before assuming
  more than it delivers: `K_sig` is never rotated, the newcomer's own name in
  `join-room` is always under epoch 0, and there is no ratchet or
  post-compromise security — this remains explicitly out of scope, not an
  oversight.
- **Trust between room participants is assumed, not verified.** Anyone who
  has the link can derive the same keys as everyone else; there is no
  per-participant identity or signature layer distinguishing "a legitimate
  invitee" from "anyone who obtained the link." This is consistent with the
  product's anonymity goals (see [`PRD.md` §5.5](PRD.md#55-anonymity)) but
  means the encryption protects against the *server*, not against another
  room participant who might misbehave.
- **The trust split in [§4](#4-trust-split-static-origin-vs-signaling-server)
  is opt-in at the deployment level.** A single-origin deployment does not
  get that property automatically — see [`self-hosting.md`](self-hosting.md).

## 7. Forward Secrecy for Content on Membership Change (Ш3)

> Source of truth: [`../static/crypto.js`](../static/crypto.js)
> (`deriveContentKeys`, `generateRoomKey`), [`../static/room.js`](../static/room.js)
> (`contentEpochs`, `rotateContentKeysIfLeader`, `applyContentEpoch`,
> the `key-rotate`/`key-request` bus handlers), [`../static/chat.js`](../static/chat.js)
> (`sendEnvelopeToPeer`, the `chat` signaling handler in `attach()`).

This is a **deliberately narrow** phase, not a general ratchet. It buys
exactly one property: a participant who leaves a room (or is turned away at
the lobby) can no longer read *fallback-relayed* chat content or display
names sent *after* that point. It does not attempt post-compromise security,
does not touch signaling, and does not build anything resembling MLS or the
Signal double ratchet — see [§7.7](#77-what-this-does-and-doesnt-fix--stated-plainly)
for the boundary, stated as plainly as [§6](#6-known-limitations) states
everything else.

### 7.1 What Rotates, What Doesn't

Only the two **content** keys rotate: `K_chat` (the fallback chat envelope)
and `K_meta` (the display name in `join-room`). `K_sig` never rotates — it
stays derived from `k` for the entire lifetime of the room. This is a
deliberate trade-off, not an oversight: a newcomer joining with only the
room key `k` from the invite link must be able to bootstrap its very first
signaling exchange (offer/answer) with existing peers before it has any
other keying material, and that exchange is encrypted under `K_sig`. If
`K_sig` rotated too, a newcomer would have no way to decrypt the signaling
that establishes the mesh connection needed to receive the *content* epoch
in the first place — see [§7.5](#75-bootstrapping-a-newcomer). The residual
cost of this choice is stated in [§7.7](#77-what-this-does-and-doesnt-fix--stated-plainly).

Each rotation produces a fresh, independent 32-byte "epoch key" — generated
exactly like the room key `k` itself (`RoomCrypto.generateRoomKey()`) — from
which `K_chat`/`K_meta` for that epoch are derived via
`RoomCrypto.deriveContentKeys()`, the same HKDF-SHA256 construction and the
same `info` strings (`"chat-v1"`/`"meta-v1"`) as [§2.2](#22-key-derivation-hkdf-sha256--three-aes-256-gcm-keys),
just with different input material per epoch. Epoch 0 is `k` itself — the
existing scheme, unchanged, is simply epoch 0 of this one.

### 7.2 Who Rotates, and When

Only the room's current **leader** rotates keys — followers never generate
an epoch on their own. Rotation is triggered by exactly two events, both
representing a membership change:

- **`peer-left`** — a participant left voluntarily or was disconnected.
- **A lobby request is rejected** — the leader clicks "Отклонить" on a
  waiting-room entry.

On either event, the leader generates a new epoch key, increments the epoch
counter, and pushes it to every participant *currently* in the room. If the
room is empty after the departure (`peers.size === 0`), rotation is skipped
entirely — there's nobody to protect future content from, and generating an
epoch nobody will ever receive would just be memory churn for zero benefit.

Rejecting a lobby entrant rotates keys too, even though the rejected visitor
never held any content key to begin with (they were never admitted, so they
never received an epoch) — the rotation is harmless and cheap, and doing it
uniformly for both membership-change events is simpler than explaining a
special case where it's skipped.

There is currently no mechanism to forcibly remove an *already-joined*
participant ("kick") distinct from `peer-left` — the protocol (see
[`signaling-protocol.md`](signaling-protocol.md)) only has voluntary
`Leave`/disconnect and pre-join `Reject`. If a kick feature is added later,
it should rotate on the same trigger as `peer-left`.

### 7.3 Distribution: Strictly Over the P2P Bus

The new epoch key is sent to each current peer with
`bus.sendToPeer(peerId, { kind: 'key-rotate', epoch, key })` — the mesh
DataChannel bus (see [`webrtc-mesh.md`](webrtc-mesh.md)), **never** the
signaling server, in any form, even encrypted. This is the whole point: if
the key ever touched the server, a server compromise (or the departed
participant colluding with server access) could recover it; keeping it
strictly peer-to-peer means the server never has it to leak, and the
guarantee reduces to "DTLS between two specific browsers already protects
this," the same argument as [§3.2](#32-never-touched-by-this-layer-already-e2e-via-dtls).
`bus.sendToPeer` queues the message inside the underlying `RtcPeer` if the
DataChannel isn't open yet at the exact instant of rotation, so a peer whose
channel is mid-negotiation still receives it once the channel opens — no
special-casing needed for that race.

A newcomer that doesn't yet know the current epoch asks for it explicitly —
see [§7.5](#75-bootstrapping-a-newcomer) — with `{ kind: 'key-request' }`,
also over the bus; only the leader answers, addressed directly back to the
requester, with the current epoch.

### 7.4 Storage: A Map of Epochs, Never Discarded

Each client keeps `Map<epoch, { raw, chat, meta }>` — every epoch it has
ever learned, not just the current one. Old epochs are **not** discarded:
they're needed to decrypt history and any fallback message that happens to
arrive still labeled with a previous epoch (see [§7.6](#76-wire-format)).
Given the room's hard lifetime ceiling (three hours, see
[`security.md` §8](security.md#8-meeting-duration-ceiling)) and that
membership changes are not a high-frequency event, the number of epochs a
client will ever accumulate is small — this is not the kind of unbounded
growth that would need pruning.

The raw 32-byte epoch key is kept, not just the derived `CryptoKey`s,
because `crypto.subtle.deriveKey` in `static/crypto.js` produces
non-extractable keys (`extractable: false`) — the leader needs the *raw*
bytes on hand to be able to re-send a past epoch's key material to a
newcomer asking about the current one, since that's what gets base64url-
encoded onto the wire in `key-rotate`.

### 7.5 Bootstrapping a Newcomer

A newcomer only ever starts with epoch 0 (derived from `k` in the invite
link). If the leader had already rotated before the newcomer arrived, epoch
0 is stale for content purposes (though still correct for `K_sig`, and still
correct for reading any history/messages actually sent under epoch 0). Two
things happen on join:

1. **Outgoing fallback chat is queued, not sent under a possibly-stale
   epoch.** As soon as `joined` arrives, if there's anyone else already in
   the room and this client isn't the leader, its notion of "the current
   epoch" is considered unconfirmed. Any chat message that would have to go
   through the server fallback path (because the bus to that particular peer
   isn't open yet) is held in a small queue instead of being encrypted under
   epoch 0 speculatively — see `static/chat.js`: `pendingFallbackSends`.
   Content that goes over the bus directly is **not** affected — it was
   never epoch-encrypted to begin with (see [§3.2](#32-never-touched-by-this-layer-already-e2e-via-dtls)).
2. **The newcomer asks the leader.** As soon as the DataChannel bus opens to
   the leader specifically, the newcomer sends `{ kind: 'key-request' }`;
   the leader answers with the current epoch. Once that arrives (or a
   3-second timeout elapses without an answer — availability wins over
   waiting forever for an unreachable leader), the queue from step 1 is
   flushed using whatever epoch is now known.

The newcomer's own display name in `join-room`, however, is **never**
queued — it's encrypted under epoch-0 `K_meta` and sent immediately, as part
of the very first contact that establishes the connection at all, before any
bus to anyone (let alone the leader) could possibly be open yet. See
[§7.7](#77-what-this-does-and-doesnt-fix--stated-plainly) for what this
means in practice.

Reading history is unaffected by any of this: history is exchanged entirely
over the bus (`history-request`/`history-response`, see
[`chat.md`](chat.md)), which was never epoch-encrypted, so a newcomer sees
old messages (sent under epoch 0 or any later epoch, whichever was current
when they were sent) exactly as it always could.

### 7.6 Wire Format

The fallback chat envelope (see [§3.1](#31-encrypted-under-a-derived-key))
gains one plaintext field alongside the ciphertext:
`{ enc: { v, iv, ct }, epoch }` — `epoch` has to sit *outside* `enc` because
the recipient needs it to pick the right key *before* it can attempt
decryption at all. A recipient that doesn't recognize the epoch (shouldn't
happen under correct distribution — see [§7.3](#73-distribution-strictly-over-the-p2p-bus))
logs a warning and silently drops that one message, the same "don't take
down the whole panel over one bad envelope" policy `chat.js` already applied
to plain decryption failures before this phase.

The signaling relay's own encrypted fields (`sdp`/`candidate`/`info`, and the
`join-room` name) are **unchanged** — they stay on `K_sig`/epoch-0 `K_meta`
respectively and carry no `epoch` field, since neither of those ever
rotates (`sdp`/`candidate`/`info`) or ever *can* rotate for the one client
that needs to read it before anything else is possible (`join-room` name).

### 7.7 What This Does and Doesn't Fix — Stated Plainly

What it fixes: a participant who leaves the room, or is rejected at the
lobby, cannot read fallback-relayed chat content or display names sent
*after* that point — recovering the content requires either the old epoch
key (which they may still have, but which no longer decrypts anything
current) or the new one (which they were never given, and never will be).

What it does **not** fix — every one of these is a deliberate boundary of
this phase, not an oversight:

1. **`K_sig` is never rotated.** A participant who has left still holds the
   same `K_sig` as everyone else, for the entire lifetime of the room (see
   [§7.1](#71-what-rotates-what-doesnt)). In principle they could still
   decrypt future `sdp`/`candidate`/`info` relayed through the server, or
   even attempt to inject a crafted one — *if* they could still get
   messages relayed to/from the room at all. What actually prevents that is
   **the lobby/room membership check on the server side**
   (`src/ws.rs`/`src/state.rs`), not cryptography: a peer who has left is no
   longer a recognized participant of the room, so the server won't relay
   signaling to or from them regardless of what keys they hold. This is a
   real, separate gap worth being honest about: it depends on the server
   enforcing membership correctly, not on an independent cryptographic
   barrier the way content forward secrecy now does.
2. **A newcomer's own display name in `join-room` is always encrypted under
   epoch-0 `K_meta`**, never the current epoch — see
   [§7.5](#75-bootstrapping-a-newcomer) for why (it's the very first message
   sent, before any epoch beyond 0 could possibly be known). Anyone who ever
   held epoch-0 `K_meta` — including someone who has since left — could in
   principle decrypt a *newcomer's* name specifically, even after their own
   departure. This is judged an acceptable residual: display names are
   low-sensitivity relative to chat content, and it only affects the name
   field of participants who join *after* a departure, not their message
   content.
3. **No post-compromise security, no ratchet.** This phase rotates keys on
   membership-change *events*; it does not ratchet forward on every message,
   does not protect against an attacker who compromises a *current*
   participant's browser/memory (they'd have the live epoch key just like
   anyone else in the room), and does not attempt anything like MLS's
   tree-based group rekeying or the Signal double ratchet. That remains a
   deliberate, stated exclusion from scope — see
   [§6](#6-known-limitations)'s framing before this phase, which still
   applies to everything this phase doesn't specifically address.
4. **The P2P bus itself was never the target.** Chat/media flowing directly
   between two peers over the mesh DataChannel is protected by DTLS, not by
   any key described here (see [§3.2](#32-never-touched-by-this-layer-already-e2e-via-dtls)) —
   a departed participant is simply no longer a party to those
   DTLS-protected connections at all, which is a structural (transport-level)
   guarantee that predates and is independent of this phase. This phase's
   forward secrecy is specifically about the **server-relayed fallback
   path** — the one place a departed participant could otherwise still be
   listening in without needing any ongoing connection to anyone.
