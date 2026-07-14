# Privacy

<!-- toc -->

- [1. What the Server Never Sees](#1-what-the-server-never-sees)
- [2. What the Server Does See](#2-what-the-server-does-see)
- [3. Ephemerality](#3-ephemerality)
  - [3.1 In-Memory State Only](#31-in-memory-state-only)
  - [3.2 Empty-Room TTL](#32-empty-room-ttl)
  - [3.3 Maximum Meeting Lifetime](#33-maximum-meeting-lifetime)
  - [3.4 A Restart Erases Everything](#34-a-restart-erases-everything)
- [4. Anonymity](#4-anonymity)
- [5. The "Connection & Privacy" Panel](#5-the-connection--privacy-panel)

<!-- /toc -->

> Source of truth: [`../src/state.rs`](../src/state.rs) (in-memory room
> state, reaper), [`../src/ws.rs`](../src/ws.rs) (what is and isn't logged),
> [`../static/room.js`](../static/room.js) (the in-app "Connection &
> Privacy" panel). This document is the product-facing counterpart to
> [`e2e-encryption.md`](e2e-encryption.md) (the mechanism) and
> [`security.md`](security.md) (the threat model).

## 1. What the Server Never Sees

Everything a client sends through the signaling server is either opaque by
construction or encrypted client-side before it's sent — see
[`e2e-encryption.md`](e2e-encryption.md) for the mechanism. In practical
terms, the server never has access to:

- Video or audio content — media never touches the server at all; it flows
  directly between browsers (see [`webrtc-mesh.md`](webrtc-mesh.md)).
- Chat content — messages travel over the peer-to-peer data-channel bus;
  the server is not in that path. The one exception, the addressed fallback
  relay for a peer whose channel isn't open yet, carries only ciphertext
  (see [`chat.md` §12](chat.md#12-fallback-through-the-server)).
- File contents, images, or audio clips shared in chat — transferred over a
  dedicated peer-to-peer data channel; never proxied through the server
  under any circumstance, including when a direct connection can't be
  established (see [`chat.md` §10](chat.md#10-file-transfer)).
- Participants' display names — encrypted client-side before being sent in
  `join-room` (see [`e2e-encryption.md`](e2e-encryption.md)).
- SDP offers/answers and ICE candidates — encrypted client-side; the server
  relays opaque ciphertext blobs, not real connection descriptions.

## 2. What the Server Does See

Being honest about the boundary matters as much as the guarantee itself.
The server does see, and cannot avoid seeing:

- Participants' IP addresses, at the transport level (though see below —
  they are not logged or retained).
- The room id and each participant's peer id.
- The timing of connections, joins, leaves, and relayed messages.
- The bare fact that a given set of peer ids is sharing a room.

None of this reveals what was said, shown, or shared — but it is genuine
metadata the architecture cannot hide, since the server has to route
messages between peer ids in real time to do its job at all (see
[`e2e-encryption.md` §3.3](e2e-encryption.md#33-what-remains-visible-to-the-server-regardless)).

**IP addresses and ports are not logged or stored anywhere.** Server logs
carry only room and peer identifiers — never a participant's network
address.

## 3. Ephemerality

### 3.1 In-Memory State Only

There is no database and no on-disk storage anywhere in this project. All
room state — participants, names (already ciphertext to the server, see
[§1](#1-what-the-server-never-sees)), who is presenting — lives only in the
signaling process's memory for as long as the process and the room both
live. Chat content isn't even a field in that in-memory structure: the
server holds no chat buffer at all, at any point, in any form (see
[`chat.md`](chat.md) — history lives only in each participant's own tab
memory).

### 3.2 Empty-Room TTL

A room with zero participants — either brand new (created, but no one has
navigated to it yet) or emptied out (everyone left) — is not deleted
immediately. It's kept for a short grace period (configurable; see
[`self-hosting.md`](self-hosting.md)) so a slow creator or a
reload-in-progress participant isn't punished, and is removed by a
background reaper only if no one (re)connects before that period elapses.

### 3.3 Maximum Meeting Lifetime

Independent of participant activity, a room cannot exist longer than a
configurable maximum lifetime (product default: three hours) — see
[`security.md` §8](security.md#8-meeting-duration-ceiling). This is a
privacy property as much as a resource limit: it bounds, in the worst case,
how long any given meeting's metadata can possibly persist in server memory,
even if participants never explicitly leave.

### 3.4 A Restart Erases Everything

Because all state lives in one process's memory, a server restart —
whether a deliberate redeploy or an unplanned crash — erases every room's
participants and names outright, with nothing to recover them from. The
mesh connections between browsers (media, chat) are unaffected by a
signaling restart and keep working; only the signaling channel itself
(new joins, screen-share arbitration, moderation) is briefly unavailable
until the frontend's auto-reconnect flow re-establishes it — see
[`self-hosting.md`](self-hosting.md) for the operational detail and what
survives a redeploy from a user's perspective.

## 4. Anonymity

- **No accounts, no login, ever.** There is nothing to register for and
  nothing to authenticate against beyond possessing the meeting link.
- **No cookies, no `localStorage`, no cross-session identifier of any
  kind**, anywhere in the frontend. A display name is entered fresh in a
  join modal every single time a participant enters a meeting — it is never
  remembered between visits, and it never leaves the browser except as
  ciphertext (see [`e2e-encryption.md`](e2e-encryption.md)).
- Every identifier a client has during a meeting (its peer id, in
  particular) is generated fresh for that session and held only in memory —
  it is not derived from, or correlatable with, anything from a previous
  visit.

## 5. The "Connection & Privacy" Panel

The frontend includes an in-meeting panel, visible to every participant
(not just the leader), that makes the above concrete rather than asking
participants to trust a document:

- The active encryption scheme, read live from the encryption module itself
  rather than hard-coded text — so the label can never silently drift out
  of sync with what's actually running.
- The live connection mode to each other participant — direct
  peer-to-peer, via a TURN relay, or via the server-side fallback — computed
  from real connection statistics (see
  [`webrtc-mesh.md` §7](webrtc-mesh.md#7-connection-mode-detection)), not
  assumed.
- A plain-language list of exactly what the server can see (matching
  [§2](#2-what-the-server-does-see) above), plus **live session counters**
  for how many messages actually went through the server-relayed signaling
  path and through the chat fallback path — a running, honest tally rather
  than a one-time claim, since some server involvement (the bootstrap window
  before a pair's bus opens) is normal and is shown as such rather than
  hidden.
