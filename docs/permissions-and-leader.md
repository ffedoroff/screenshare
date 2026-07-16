# Permissions & the Leader Role

<!-- toc -->

- [1. Overview](#1-overview)
- [2. Becoming Leader](#2-becoming-leader)
- [3. Leader Succession](#3-leader-succession)
- [4. Reconnecting With the Same Peer Id](#4-reconnecting-with-the-same-peer-id)
- [5. Room Settings](#5-room-settings)
- [6. The Waiting Room (Lobby)](#6-the-waiting-room-lobby)
- [7. Guest Permissions & How They're Actually Enforced](#7-guest-permissions--how-theyre-actually-enforced)
  - [7.1 Screen Sharing — Server-Enforced](#71-screen-sharing--server-enforced)
  - [7.2 Chat — Cooperative Only](#72-chat--cooperative-only)
  - [7.3 Audio & Video — Receiver-Enforced Only](#73-audio--video--receiver-enforced-only)

<!-- /toc -->

> Source of truth: [`../src/state.rs`](../src/state.rs) (`Room`, `Participant`,
> `PendingParticipant`), [`../src/ws.rs`](../src/ws.rs) (all the handlers
> referenced below), [`../src/protocol.rs`](../src/protocol.rs)
> (`RoomSettings`). Wire messages are cataloged in
> [`signaling-protocol.md`](signaling-protocol.md).

## 1. Overview

A room has exactly one **leader** and, optionally, guests. Membership and
role are entirely server-side truth — there is no quorum, no vote, no
peer-to-peer coordination involved in deciding who is a member or who leads;
the server simply knows who is who and when each participant joined.

## 2. Becoming Leader

`POST /api/rooms` returns `{roomId, leaderToken}` — a one-time token (see
[`signaling-protocol.md` §2.1](signaling-protocol.md#21-post-apirooms)). The
room's creator presents that token in their own `join-room`; if it matches
the one stored for the room, they become leader and the token is burned
immediately (a second presentation of the same token does nothing — the
room already has a leader). If no one has presented the token and the room
currently has no leader (a brand-new room, a room restored after a restart
via `PUT /api/rooms/{id}` — which never issues a token at all — or a room
that has just emptied out), the **first participant to join becomes
leader**, unconditionally.

## 3. Leader Succession

When the leader leaves (explicit `leave`, tab close, connection drop), and
other participants remain, the server **deterministically** assigns a new
leader: whoever has been connected the longest (compared by `joined_at`, a
server-side timestamp). No quorum or vote is needed or possible — the
server is the sole source of truth for arrival order, so every client
converges on the same answer without needing to agree among themselves. Any
pending waiting-room requests the outgoing leader hadn't yet acted on
transfer to the new leader (re-delivered as fresh `join-request` messages —
see [§6](#6-the-waiting-room-lobby)).

## 4. Reconnecting With the Same Peer Id

If a participant reconnects with their previous peer id before the server
has removed them (a fast reconnect), their leadership status (if any) is
unchanged. If the server had already removed them and, in the meantime,
assigned a new leader, the returning participant rejoins as an ordinary
guest — despite having the same peer id, they are no longer leader.

## 5. Room Settings

`RoomSettings` (see [`../src/protocol.rs`](../src/protocol.rs)) — changed
only by the leader, via `update-settings`, applied **wholesale** (not
patched field-by-field):

| Field | Default | Meaning |
|---|---|---|
| `lobbyEnabled` | `false` | Whether new arrivals (other than the leader) are held in the waiting room |
| `guestChat` | `true` | Whether guests may send chat messages |
| `guestAudio` | `true` | Whether guests' microphones are rendered for other participants |
| `guestVideo` | `true` | Whether guests' cameras are rendered for other participants |
| `guestScreen` | `true` | Whether guests may start screen sharing |
| `maxParticipants` | `null` | Leader-set ceiling on room size, on top of the server's own `MAX_PARTICIPANTS` — see below |

Any change is broadcast to all current participants as `settings-changed`
(see [`signaling-protocol.md`](signaling-protocol.md)) and takes effect
immediately, not only for future arrivals.

`maxParticipants` is `Option<usize>`: `null` means "no leader-set limit" and
the room simply follows the server's own ceiling (`MAX_PARTICIPANTS` env,
default 6). If the leader sets a number, it must be `2..=MAX_PARTICIPANTS`
(inclusive on the server ceiling) — anything outside that range is rejected
by the server and the whole `update-settings` call is refused (no partial
application, same as any other invalid `RoomSettings`). The room's
*effective* limit is always `maxParticipants ?? MAX_PARTICIPANTS`, and that's
the number used everywhere the ceiling matters: `join-room`, `approve` for a
waiting-room request, and the `Joined.maxParticipants` value the client shows
in its "Participants: N / M" counter. Lowering the limit below the current
occupancy does **not** evict anyone already in the room — there is no `kick`
in the protocol — it only blocks *future* admissions (direct `join-room` or
lobby `approve`) until the count naturally drops back under the new ceiling.
As with membership itself ([§1](#1-overview)), this is server-side truth: the
server is the only party that ever compares occupancy against the effective
limit, and it applies the same check regardless of whether the limit came
from the operator's env var or the leader's own choice.

## 6. The Waiting Room (Lobby)

While `lobbyEnabled` is `true`, any **non-leader** joining the room is not
admitted immediately: the server places them in a separate pending list
(distinct from the room's participant list — the participant ceiling
doesn't count them, though the waiting list itself has its own, more
generous cap), sends them `waiting {leaderPeerId, leaderEpub}`, and notifies
the leader with `join-request {peerId, epub}`.

Neither message carries a plaintext name any more (E2E v2, see
[`e2e-encryption.md`](e2e-encryption.md)): a pending arrival's name field is
always `null` in `join-request`, and the leader's lobby card for them shows a
generic "Guest" placeholder until the arrival separately sends a
`name-announce` to the leader (encrypted under a key derived from the
arrival's own `epub` and the `leaderEpub` it was handed) — the card updates
in place once that decrypts. A pending arrival is otherwise not a
participant: it cannot target `name-announce` at anyone *other* than the
current leader (see [`signaling-protocol.md`](signaling-protocol.md)), since
it has no visibility into who else is in the room.

The leader resolves each request individually:

- **`approve {peerId}`** — the pending arrival becomes a full participant:
  they receive `joined`, everyone else receives `peer-joined`.
- **`reject {peerId}`** — the pending arrival receives `join-rejected`; the
  server closes their socket immediately after.

Additional rules:

- If a waiting arrival disconnects before a decision, the leader receives
  `join-request-cancelled`.
- If the leader changes while requests are still pending, the **new**
  leader receives every pending request again (as fresh `join-request`
  messages) — they haven't seen them yet. Symmetrically, every **pending
  arrival** still waiting receives a fresh `waiting` with the new leader's
  `leaderPeerId`/`leaderEpub` (E2E v2) — its old `leaderEpub` derives a
  pairwise key with a leader who is no longer there, so its client
  re-sends its `name-announce` to the new leader using the new `leaderEpub`.
- If the room empties out entirely while requests are still pending, every
  waiting arrival receives `join-rejected` and is disconnected — there is no
  one left to approve them, and the room itself proceeds into its normal
  empty-room grace period (see [`privacy.md`](privacy.md)).

## 7. Guest Permissions & How They're Actually Enforced

This section is deliberately honest about the difference between
**server-enforced** (the server can and does refuse the action) and
**cooperative** (the server merely signals intent; enforcement, if any,
happens on receiving clients that choose to honor it) restrictions. This
distinction follows directly from the mesh architecture (see
[`webrtc-mesh.md`](webrtc-mesh.md)): the server is not in the media or chat
data path at all, so it structurally cannot inspect or block what it never
sees.

### 7.1 Screen Sharing — Server-Enforced

Screen-share ownership is server-held room state (see
[`webrtc-mesh.md` §8](webrtc-mesh.md#8-screen-sharing)), not a
peer-to-peer stream detail, so the server can and does fully enforce this
one: with `guestScreen=false`, a guest's `share-start` is answered with
`share-rejected {reason: "forbidden"}` (note: no `busyPeerId` — this is a
permission denial, not a busy conflict). The leader can always share.

**Screen takeover ("last wins").** A `share-start` from someone other than
the current holder is never refused for being "busy": the requester
immediately becomes the new holder (subject to the same permission check
above), and `share-started {peerId: <new holder>}` goes out to everyone,
including the participant who just lost it. That broadcast **is** the
preemption signal — there is no separate message to the displaced holder:
its client recognizes the `peerId` isn't its own, notices its local capture
(`getDisplayMedia`) is still live, and stops it itself (see
`static/room.js`). Two `share-start`s that arrive almost simultaneously are
serialized by the server like any other message on a room; whichever is
processed last determines the final holder — the frontend's "Screen" button
is therefore never disabled merely because someone else is presenting
(clicking it while someone else holds the screen takes over, rather than
being a no-op); it is disabled only by the `guestScreen=false` permission
check above. `share-rejected`'s `busyPeerId` field is kept in the wire shape
for backward compatibility but is no longer populated — the only rejection
reason left is `"forbidden"`.

If guest screen sharing is revoked **while** a guest is actively presenting,
the server itself ends the share (`share-stopped` to everyone) without
waiting for the guest's client to cooperate.

### 7.2 Chat — Cooperative Only

Chat travels **only** over the mesh `RTCDataChannel` bus directly between
browsers — the server physically never sees it, and there is no server relay
for chat any more (the earlier addressed fallback was removed, see
[`chat.md` §12](chat.md#12-no-server-fallback)). So `guestChat` is enforced
**cooperatively, on the client only**: a well-behaved guest client disables
its own input and honours the setting, but a modified/non-cooperative client
could keep sending over the bus, and the server has no way to detect or block
that — it has no visibility into that channel at all. This is the same
cooperative model as audio/video/screen below. (Previously the server could
gate chat on its fallback relay path; with that path gone, that partial
server enforcement is gone too.)

### 7.3 Audio & Video — Receiver-Enforced Only

The server does not participate in media streams at all (pure mesh
peer-to-peer — see [`webrtc-mesh.md`](webrtc-mesh.md)) and has no mechanism,
even in principle, to permit or block them at the transport level.
`guestAudio`/`guestVideo` are pieces of input the **frontend** acts on: the
server only stores and broadcasts the setting's value
(`settings-changed`); it is each **recipient** who decides whether to render
the incoming track from a participant whose audio/video the leader has
turned off. In other words, enforcement here lives entirely on the
receiving side of each connection, not on the sender and not on the server —
a cooperative control in exactly the same sense as guest chat above, just
one layer further from any server involvement.
