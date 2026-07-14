# Signaling Protocol

<!-- toc -->

- [1. Overview](#1-overview)
- [2. HTTP Endpoints](#2-http-endpoints)
  - [2.1 `POST /api/rooms`](#21-post-apirooms)
  - [2.2 `PUT /api/rooms/{roomId}`](#22-put-apiroomsroomid)
  - [2.3 `GET /r/{roomId}`](#23-get-rroomid)
  - [2.4 `GET /config`](#24-get-config)
  - [2.5 `GET /healthz`](#25-get-healthz)
  - [2.6 `GET /version.json`](#26-get-versionjson)
  - [2.7 `GET /ws` (WebSocket upgrade)](#27-get-ws-websocket-upgrade)
- [3. WebSocket: Client → Server](#3-websocket-client--server)
- [4. WebSocket: Server → Client](#4-websocket-server--client)
- [5. Relay Semantics](#5-relay-semantics)
- [6. Heartbeat (Ping/Pong)](#6-heartbeat-pingpong)
- [7. Close Behavior & Codes](#7-close-behavior--codes)
- [8. Versioning & Backward Compatibility](#8-versioning--backward-compatibility)

<!-- /toc -->

> **Source of truth.** This document mirrors [`../src/protocol.rs`](../src/protocol.rs)
> (message shapes) and [`../src/ws.rs`](../src/ws.rs) (relay/session behavior)
> field-for-field. If it ever drifts from the code, the code wins — treat any
> discrepancy found here as a documentation bug.

## 1. Overview

The room is a **symmetric mesh**: every participant is transport-equal (each
holds one direct `RTCPeerConnection` to every other participant), with one
participant holding a signaling-level **leader** role (see
[`permissions-and-leader.md`](permissions-and-leader.md)). Screen sharing is
transient room state, not a role — at most one participant holds it. A room
lives as long as it has at least one participant, plus a grace period while
empty (see [`state.rs`](../src/state.rs)).

Since protocol v3, chat travels over the mesh `RTCDataChannel` bus, not this
WebSocket connection (see [`chat.md`](chat.md)) — the WebSocket protocol
below carries only: signaling (offer/answer/ICE/`stream-info`), an addressed
fallback relay for chat envelopes when the data-channel bus to a given peer
isn't open yet, and (since v4) permission/lobby control. The protocol is
**additive**: an older client that doesn't know a newer field or message type
keeps working (see [§8](#8-versioning--backward-compatibility)).

All WebSocket messages are JSON with a `type` field
(`#[serde(tag = "type", rename_all = "kebab-case")]` in Rust). The server
does not parse the *content* of `sdp` / `candidate` / `info` — these are
opaque JSON values it only routes between peers; since the end-to-end
encryption phase (see [`e2e-encryption.md`](e2e-encryption.md)), these fields
and the participant's `name` are opaque ciphertext even before considering
that the server doesn't inspect them.

## 2. HTTP Endpoints

| Method + Path | Request Body | Response | Purpose |
|---|---|---|---|
| `POST /api/rooms` | none (an optional `{"name": "..."}` is accepted and ignored) | `201 {"roomId": "<8 chars>", "leaderToken": "<uuid>"}`, or `429` (per-IP room-creation rate limit), or `503` (room count ceiling) | Create a new, empty room. Participants join it separately via `join-room` over WebSocket. |
| `PUT /api/rooms/{roomId}` | none | `201 {"roomId": ...}` (didn't exist — created), `200 {"roomId": ...}` (already existed), `400` (malformed id), `503` (room count ceiling) | Idempotent restore of a room after a server restart (see [`self-hosting.md`](self-hosting.md)). Issues no `leaderToken` — the restored room's leader is whoever joins first. |
| `GET /r/{roomId}` | — | `200` HTML (`room.html`) | Short link that serves the room page; the frontend reads `roomId` from the URL itself. |
| `GET /config` | — | `200 {"iceServers": [...]}` | ICE server list for the frontend: a public STUN server always, plus a TURN server if configured (with short-lived HMAC credentials — see [`webrtc-mesh.md`](webrtc-mesh.md) and [`self-hosting.md`](self-hosting.md)). |
| `GET /healthz` | — | `200 "ok"` | Liveness/readiness probe. |
| `GET /version.json` | — | `200 {"version", "commit", "buildDate"}` | Deployed build identity, used by the frontend to detect a version skew after reconnecting. |
| `GET /ws` | — | WebSocket upgrade | The signaling connection — see [§2.7](#27-get-ws-websocket-upgrade) and §3/§4 below. |

A room's QR code is **not** a server endpoint: it is rendered locally in the
browser from the room link (which carries the secret key in its URL
fragment), so the link is never sent to the server just to produce an image.

### 2.1 `POST /api/rooms`

Creates a new, empty room and returns its `roomId` and a one-time
`leaderToken`. The creator presents that token in their own `join-room` to
become the room's leader (see [`permissions-and-leader.md`](permissions-and-leader.md));
the token is consumed on first successful presentation. A room with zero
participants is kept alive for a configurable grace period in case the
creator hasn't navigated to it yet; a background reaper removes it if no one
joins in time.

Rate-limited per source IP (separately from the lobby-join limit — see
[`security.md`](security.md)), and gated by a global room-count ceiling.

### 2.2 `PUT /api/rooms/{roomId}`

Idempotent "upsert" used by the frontend's auto-reconnect flow after a
`room-not-found` response, so a client that already had a working link
doesn't need to mint (and redistribute) a brand new one after the signaling
process restarts (all room state is in-memory — see [`privacy.md`](privacy.md)).
Restoring a room by an already-known id grants no additional access: the
room id itself is the only access control a room has, and whoever already
had the link could reach the same outcome by creating a fresh room with a
different id. `roomId` must match `^[a-z0-9]{8}$`.

### 2.3 `GET /r/{roomId}`

Serves the room page directly; the room id is read from the URL client-side.

### 2.4 `GET /config`

Always includes a public STUN server. If a TURN server is configured, its
credentials are computed per-request with a short TTL rather than being a
static, indefinitely valid pair — see [`webrtc-mesh.md`](webrtc-mesh.md) for
the ICE mechanics and [`security.md`](security.md) for why static TURN
credentials were a vulnerability.

### 2.5 `GET /healthz`

Trivial liveness check: if the process answers HTTP, it is up.

### 2.6 `GET /version.json`

Returns the build's version/commit/build-date. The frontend records this
value on load and re-checks it after every successful reconnect; a mismatch
triggers a non-intrusive "a new version is available" banner rather than a
forced reload.

### 2.7 `GET /ws` (WebSocket upgrade)

Upgrades to the signaling WebSocket. The upgrade enforces frame/message size
caps (see [§5](#5-relay-semantics)) and, when the deployment is configured
with a cross-origin allow-list, validates the `Origin` header against it —
see [`self-hosting.md`](self-hosting.md) for when that matters (a
single-origin deployment does not need it and leaves the check disabled by
default).

## 3. WebSocket: Client → Server

| type | Fields | Purpose |
|---|---|---|
| `join-room` | `roomId`, `name?` (opaque ciphertext string — see [`e2e-encryption.md`](e2e-encryption.md)), `peerId?` (the client's *previous* peer id, presented when reconnecting after a signaling drop), `leaderToken?` (one-time token from `POST /api/rooms`) | Join an existing room. If the presented `leaderToken` matches the one stored for the room, the joiner becomes leader and the token is burned. If the room has the waiting room enabled and the joiner isn't becoming leader, they're placed in the pending queue instead of admitted immediately (see [`permissions-and-leader.md`](permissions-and-leader.md)). |
| `offer` | `targetPeerId`, `sdp` | An SDP offer to any other participant in the room; payload capped at 16KB. |
| `answer` | `targetPeerId`, `sdp` | An SDP answer to any other participant; same cap. |
| `ice-candidate` | `targetPeerId`, `candidate` | A trickled ICE candidate to any peer; same cap. |
| `stream-info` | `targetPeerId`, `info` (opaque JSON) | Out-of-band info relayed exactly like offer/answer/ICE — used by the frontend to associate incoming tracks with peers/labels (see [`webrtc-mesh.md`](webrtc-mesh.md)). |
| `chat` | `targetPeerId`, `envelope` (opaque JSON, ≤8KB) | The addressed **fallback** relay for one chat envelope — used only when the mesh data-channel bus to `targetPeerId` isn't open yet. The primary chat path never touches this message (see [`chat.md`](chat.md)). |
| `share-start` | — | Request to start screen sharing; granted only if no one else currently holds it. |
| `share-stop` | — | Release screen sharing; a no-op unless sent by the current holder. |
| `update-settings` | `settings: RoomSettings` | Replace the room's settings wholesale (guest chat/audio/video/screen permissions, waiting-room toggle). Leader only. |
| `approve` | `peerId` | Admit a pending arrival from the waiting room. Leader only. |
| `reject` | `peerId` | Decline a pending arrival. Leader only. |
| `leave` | — | Explicit exit, equivalent to closing the socket. |

`RoomSettings` (see [`permissions-and-leader.md`](permissions-and-leader.md)
for the full model):

```
{ lobbyEnabled: bool, guestChat: bool, guestAudio: bool, guestVideo: bool, guestScreen: bool }
```

## 4. WebSocket: Server → Client

| type | Fields | Sent To |
|---|---|---|
| `joined` | `peerId`, `peers: [{peerId, name}]` (other current participants), `screenOwner?`, `leaderId`, `settings`, `pending: [{peerId, name}]` (non-empty **only** for the leader), `expiresInSeconds` | The newly admitted participant |
| `peer-joined` | `peerId`, `name?` | Everyone else already in the room |
| `peer-left` | `peerId` | Everyone else in the room |
| `offer` | `fromPeerId`, `sdp` | The addressed target peer |
| `answer` | `fromPeerId`, `sdp` | The addressed target peer |
| `ice-candidate` | `fromPeerId`, `candidate` | The addressed target peer |
| `stream-info` | `fromPeerId`, `info` | The addressed target peer |
| `share-started` | `peerId` | Everyone in the room, including the initiator (one render path for all) |
| `share-rejected` | `busyPeerId?` (who holds it, on a busy conflict), `reason?` (`"forbidden"` on a permission denial — `busyPeerId` absent in that case) | Only the requester of `share-start` |
| `share-stopped` | `peerId` | Everyone in the room — on explicit stop, on the holder disconnecting, or when the leader revokes `guestScreen` mid-share |
| `chat` | `fromPeerId`, `envelope` | The addressed target peer — fallback relay, mirrors client `chat` |
| `waiting` | — | A new arrival, instead of `joined`, while they're in the waiting room |
| `join-request` | `peerId`, `name?` | The leader — a new (or re-delivered, after a leader change) pending arrival |
| `join-request-cancelled` | `peerId` | The leader — a waiting arrival disconnected before a decision |
| `join-rejected` | — | A waiting arrival who was declined (or whose room emptied out before a decision); the server closes their socket immediately after |
| `settings-changed` | `settings` | Everyone in the room — the leader changed room settings |
| `leader-changed` | `leaderId` | Everyone in the room — the previous leader left and the server assigned a new one |
| `room-full` | — | A joiner when the room is already at its participant ceiling |
| `room-not-found` | — | A joiner when the room doesn't exist (never created, or already reaped) |
| `room-expired` | — | Everyone in the room *and* everyone waiting: the room outlived its maximum lifetime; the server closes the socket immediately after |
| `error` | `message` | The sender of a malformed, oversized, rate-limited, or permission-denied message |

## 5. Relay Semantics

- **Content-blind routing.** `offer`/`answer`/`ice-candidate`/`stream-info`
  are routed from sender to `targetPeerId` (any other participant in the
  sender's room) without the server interpreting their payload.
- **Size caps.** Signaling relay payloads (`sdp`/`candidate`/`info`) are
  capped at 16KB serialized; the chat envelope fallback path is capped
  separately at 8KB. Oversized payloads are rejected with `error` and never
  relayed. The WebSocket frame/message itself is additionally capped at 64KB
  at the transport level — see [`security.md`](security.md) for the full
  rationale.
- **Rate limits.** One shared sliding-window counter covers all relay types
  on a connection combined (offer/answer/ICE/`stream-info`/chat) so an
  attacker can't dodge a per-type limit by alternating message types; chat
  additionally has its own, stricter limit on top. See
  [`security.md`](security.md) for the exact numbers and reasoning.
- **Unknown targets are silently dropped.** A `targetPeerId` that has already
  left is a normal race, not an error — the message is simply not relayed
  (logged at debug level).
- **Waiting arrivals cannot relay.** A peer sitting in the waiting room is
  not a participant and cannot send or receive relayed messages until
  admitted.
- **Permission-gated message types.** `chat` and `share-start` are checked
  against the room's current `RoomSettings` for non-leader senders before
  being processed (see [`permissions-and-leader.md`](permissions-and-leader.md)).

## 6. Heartbeat (Ping/Pong)

The server pings each connection on a fixed interval. A TCP connection can
die silently (sleeping laptop, dropped Wi-Fi, a NAT/load balancer that
quietly discarded state) without the OS surfacing an error for minutes; the
active ping/pong catches this in seconds-to-tens-of-seconds instead. If two
consecutive pings go completely unanswered (no pong, nothing at all from the
client), the server treats the connection as dead and tears it down itself,
which triggers the same cleanup as an explicit `leave` (see
[`permissions-and-leader.md`](permissions-and-leader.md) for what happens to
leadership/screen-share ownership on disconnect). Any inbound message,
including an ordinary `Pong`, resets the missed-ping counter.

## 7. Close Behavior & Codes

The server closes the socket itself, right after sending the message, for:
`room-full`, `room-not-found`, `join-rejected`, and `room-expired`. For an
explicit `leave`, the server drains any already-queued outgoing messages
before closing. In every other case (ordinary disconnect, ping timeout,
transport error), cleanup runs the same participant-removal path described
in [`permissions-and-leader.md`](permissions-and-leader.md).

## 8. Versioning & Backward Compatibility

The protocol is **additive only** within a major version: new fields and new
message types are added without removing or repurposing old ones, so a
client running older frontend code keeps working against a newer server
without a forced reload. This is what makes the reconnect-after-restart flow
safe (see [`self-hosting.md`](self-hosting.md)) — a client can reconnect
mid-session against a server that has since gained new message types it
simply never uses. The frontend surfaces an informational "a new version is
available" banner (via `/version.json`, see [§2.6](#26-get-versionjson)) but
never forces a reload on its own.
