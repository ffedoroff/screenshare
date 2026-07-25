# Signaling Protocol

<!-- toc -->

- [1. Overview](#1-overview)
- [2. HTTP Endpoints](#2-http-endpoints)
  - [2.1 `POST /api/rooms`](#21-post-apirooms)
  - [2.2 `PUT /api/rooms/{roomId}`](#22-put-apiroomsroomid)
  - [2.3 `GET /api/rooms/{roomId}`](#23-get-apiroomsroomid)
  - [2.4 `GET /r/{roomId}`](#24-get-rroomid)
  - [2.5 `GET /config`](#25-get-config)
  - [2.6 `GET /healthz`](#26-get-healthz)
  - [2.7 `GET /version.json`](#27-get-versionjson)
  - [2.8 `GET /ws` (WebSocket upgrade)](#28-get-ws-websocket-upgrade)
  - [2.9 `GET /metrics` (management port)](#29-get-metrics-management-port)
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
below carries only: signaling (offer/answer/ICE/`stream-info`) and (since v4)
permission/lobby control. There is **no** server relay for chat: the earlier
addressed `chat`/`envelope` fallback was removed (see
[`chat.md` §12](chat.md#12-no-server-fallback)). The protocol is
**additive**: an older client that doesn't know a newer field or message type
keeps working (see [§8](#8-versioning--backward-compatibility)).

The E2E v2 key model (see [`e2e-encryption.md`](e2e-encryption.md)) adds a
further additive layer: every participant carries an ephemeral public key
(`epub`), relayed alongside `join-room`/`joined`/`peer-joined`/`join-request`/
`waiting` so peers can derive pairwise encryption keys; and display names no
longer travel as a plaintext-shaped `name` field at all — a v2 client always
sends/sees `name: null` there and instead announces its name, encrypted, via
a dedicated `name-announce` message (see [§3](#3-websocket-client--server)
and [§4](#4-websocket-server--client)).

All WebSocket messages are JSON with a `type` field
(`#[serde(tag = "type", rename_all = "kebab-case")]` in Rust). The server
does not parse the *content* of `sdp` / `candidate` / `info` / `epub` /
`name-announce`'s `payload` — these are opaque JSON values (or opaque
strings) it only routes between peers; since the end-to-end encryption
phase (see [`e2e-encryption.md`](e2e-encryption.md)), the signaling fields
and the participant's name are opaque ciphertext even before considering
that the server doesn't inspect them. `epub` is the one exception that's
opaque but **not** ciphertext — it's a public key, harmless for the server
to see (see [`privacy.md` §2](privacy.md#2-what-the-server-does-see)).

## 2. HTTP Endpoints

| Method + Path | Request Body | Response | Purpose |
|---|---|---|---|
| `POST /api/rooms` | none (an optional `{"name": "..."}` is accepted and ignored) | `201 {"roomId": "<8 chars>", "leaderToken": "<uuid>", "lifetimeSeconds": <u64>}`, or `429` (per-IP room-creation rate limit), or `503` (room count ceiling) | Create a new, empty room. Participants join it separately via `join-room` over WebSocket. |
| `PUT /api/rooms/{roomId}` | none | `201 {"roomId": ..., "lifetimeSeconds": <u64>}` (didn't exist — created), `200 {"roomId": ..., "lifetimeSeconds": <u64>}` (already existed), `400` (malformed id), `429` (per-IP room-creation rate limit — shared with `POST /api/rooms`, see [§2.2](#22-put-apiroomsroomid)), `503` (room count ceiling) | Idempotent restore of a room after a server restart (see [`self-hosting.md`](self-hosting.md)). Issues no `leaderToken` — the restored room's leader is whoever joins first. |
| `GET /api/rooms/{roomId}` | — | `200 {"participants": <u32>, "capacity": <u32>, "ageSeconds": <u64>}`, `404` (plain text — no such room), or `429` (its own, separate per-IP rate limit) | Public, unauthenticated preview of a room for the frontend's pre-join screen (see [§2.3](#23-get-apiroomsroomid)) — no `join-room`/WebSocket round trip needed just to answer "how many people, how full, how old." |
| `GET /r/{roomId}` | — | `200` HTML (`room.html`) | Short link that serves the room page; the frontend reads `roomId` from the URL itself. |
| `GET /config` | — | `200 {"iceServers": [...]}` | ICE server list for the frontend: a public STUN server always, plus a TURN server if configured (with short-lived HMAC credentials — see [`webrtc-mesh.md`](webrtc-mesh.md) and [`self-hosting.md`](self-hosting.md)). |
| `GET /healthz` | — | `200 "ok"` | Liveness/readiness probe. |
| `GET /version.json` | — | `200 {"version", "commit", "buildDate"}` | Deployed build identity, used by the frontend to detect a version skew after reconnecting. |
| `GET /ws` | — | WebSocket upgrade | The signaling connection — see [§2.8](#28-get-ws-websocket-upgrade) and §3/§4 below. |

A room's QR code is **not** a server endpoint: it is rendered locally in the
browser from the room link (which carries the secret key in its URL
fragment), so the link is never sent to the server just to produce an image.

### 2.1 `POST /api/rooms`

Creates a new, empty room and returns its `roomId`, a one-time
`leaderToken`, and `lifetimeSeconds` (the server's own
`MAX_ROOM_LIFETIME_SECONDS`, see [`security.md` §8](security.md#8-meeting-duration-ceiling)).
The creator presents `leaderToken` in their own `join-room` to become the
room's leader (see [`permissions-and-leader.md`](permissions-and-leader.md));
the token is consumed on first successful presentation. `lifetimeSeconds` is
used client-side to compute the link's expiry `e`, baked into the E2E key
derivation (see [`e2e-encryption.md` §2.2](e2e-encryption.md#22-expiry-e--a-cryptographic-boundary-not-a-runtime-check));
a client that doesn't find this field (an older server) falls back to a
hardcoded default. A room with zero participants is kept alive for a
configurable grace period in case the creator hasn't navigated to it yet; a
background reaper removes it if no one joins in time.

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
different id. `roomId` must match `^[a-z0-9]{8}$`. `lifetimeSeconds` is
returned for symmetry with `POST /api/rooms`, but the client doesn't actually
need it here on a recovery path — its link's `e` is already fixed in the URL
fragment from when the room was originally created.

Rate-limited per source IP: this endpoint shares the same budget and counter
as `POST /api/rooms` (it's the other "create-a-room-record" path — the limit
cares about how many room records one IP mints total, not which of the two
routes it used), not a separate one.

### 2.3 `GET /api/rooms/{roomId}`

A public, unauthenticated, read-only preview of a room, meant to be polled
from the frontend's pre-join screen (see [`DESIGN.md` §1.3](DESIGN.md#13-entry-flow-landing--pre-join--room))
*before* the visitor actually joins over `/ws` — "how many people are in
here, is it full, how old is this call" — without a `join-room` round trip,
or a WebSocket connection at all.

Returns `200 {"participants": <u32>, "capacity": <u32>, "ageSeconds": <u64>}`:

- `participants` counts only people **currently admitted** to the room — a
  peer waiting in the lobby for the leader's approval is never counted (see
  [`permissions-and-leader.md` §6](permissions-and-leader.md#6-the-waiting-room-lobby)),
  matching how the pre-join screen wants to answer "how many people are
  already in the call," not "how many are trying to be."
- `capacity` is the room's *effective* participant ceiling — the exact same
  number `join-room`/`approve` enforce (the leader's own `maxParticipants` if
  set, otherwise the server-wide default — see
  [`permissions-and-leader.md` §5](permissions-and-leader.md#5-room-settings)) —
  so a pre-join "this room is full" check uses the identical notion of "full"
  the server will actually apply on the real join attempt.
- `ageSeconds` is how long the room has existed since it was created (or last
  restored via `PUT /api/rooms/{roomId}`) — a simpler, independent clock from
  `roomAgeSeconds` on the WS `joined` message, which instead measures from the
  room's *first participant* rather than its creation (see
  [§4](#4-websocket-server--client)).

`404` (plain-text body, like every other error in this API) if no such room
exists — never created, not yet created, or already removed by the reaper —
the same three cases `room-not-found` covers on the WS join path.

This endpoint deliberately exposes **nothing else**: no participant names
(impossible regardless — the server never learns them, see
[`privacy.md`](privacy.md)), no peer ids, no room settings, no tokens.
Knowing a `roomId` should tell an onlooker only whether it's worth bothering
to join, not who's already there — see
[`privacy.md` §2](privacy.md#2-what-the-server-does-see) for the privacy
framing of that trade-off.

Rate-limited per source IP on its **own**, separate budget (240 requests/60s
by default, `ROOM_STATUS_IP_LIMIT` — see
[`self-hosting.md` §6](self-hosting.md#6-environment-variables)), deliberately
more generous than the room-creation limit above: this endpoint is meant to
be polled every few seconds for as long as a pre-join screen stays open,
which the tight room-creation budget was never sized for.

### 2.4 `GET /r/{roomId}`

Serves the room page directly; the room id is read from the URL client-side.

### 2.5 `GET /config`

Always includes a public STUN server. If a TURN server is configured, its
credentials are computed per-request with a short TTL rather than being a
static, indefinitely valid pair — see [`webrtc-mesh.md`](webrtc-mesh.md) for
the ICE mechanics and [`security.md`](security.md) for why static TURN
credentials were a vulnerability.

### 2.6 `GET /healthz`

Trivial liveness check: if the process answers HTTP, it is up.

### 2.7 `GET /version.json`

Returns the build's version/commit/build-date. The frontend records this
value on load and re-checks it after every successful reconnect; a mismatch
triggers a non-intrusive "a new version is available" banner rather than a
forced reload.

### 2.8 `GET /ws` (WebSocket upgrade)

Upgrades to the signaling WebSocket. The upgrade enforces frame/message size
caps (see [§5](#5-relay-semantics)) and, when the deployment is configured
with a cross-origin allow-list, validates the `Origin` header against it —
see [`self-hosting.md`](self-hosting.md) for when that matters (a
single-origin deployment does not need it and leaves the check disabled by
default).

### 2.9 `GET /metrics` (management port)

Prometheus text-format exposition (`text/plain; version=0.0.4`), served on a
**separate** management port (`MGMT_PORT`, default `8081`) — not on the main
signaling port, and not reachable through the same load-balancer path as
`/ws`/`/api/*`. See [`self-hosting.md` §7.4](self-hosting.md#74-metrics--dashboard)
for the exposed metric names and what each one counts, and
[`../src/metrics.rs`](../src/metrics.rs) for the source of truth. Every
metric is a plain aggregate gauge/counter — no room id, peer id, or other
per-entity label is ever attached (see [`privacy.md`](privacy.md)).

## 3. WebSocket: Client → Server

| type | Fields | Purpose |
|---|---|---|
| `join-room` | `roomId`, `name?` (accepted but never stored or looked at by the server — always relayed back as `null`, see below), `peerId?` (the client's *previous* peer id, presented when reconnecting after a signaling drop), `leaderToken?` (one-time token from `POST /api/rooms`), `epub?` (E2E v2: the tab's ephemeral ECDH public key, base64url raw; opaque to the server, only relayed — effectively required from a v2 client, but `Option` so an older client without it still works) | Join an existing room. Rate-limited per source IP (`JOIN_ROOM_IP_LIMIT`, default 20/60s — a separate budget from the `POST`/`PUT /api/rooms` one above; over the limit, the server sends `error` and closes the socket) — see [`security.md`](security.md). Reconnecting with an already-recognized `peerId` doesn't consume from this budget. If the presented `leaderToken` matches the one stored for the room, the joiner becomes leader and the token is burned. If the room has the waiting room enabled and the joiner isn't becoming leader, they're placed in the pending queue instead of admitted immediately (see [`permissions-and-leader.md`](permissions-and-leader.md)). |
| `offer` | `targetPeerId`, `sdp` | An SDP offer to any other participant in the room; payload capped at 16KB. |
| `answer` | `targetPeerId`, `sdp` | An SDP answer to any other participant; same cap. |
| `ice-candidate` | `targetPeerId`, `candidate` | A trickled ICE candidate to any peer; same cap. |
| `stream-info` | `targetPeerId`, `info` (opaque JSON) | Out-of-band info relayed exactly like offer/answer/ICE — used by the frontend to associate incoming tracks with peers/labels (see [`webrtc-mesh.md`](webrtc-mesh.md)). |
| `share-start` | — | Request to start screen sharing. "Last wins": if no one holds it, the requester is granted it; if someone else already holds it, the requester **preempts** them instead of being refused (see [§4](#4-websocket-server--client) and [`permissions-and-leader.md`](permissions-and-leader.md)) — subject to the same permission check either way. |
| `share-stop` | — | Release screen sharing; a no-op unless sent by the current holder. |
| `update-settings` | `settings: RoomSettings` | Replace the room's settings wholesale (guest chat/audio/video/screen permissions, waiting-room toggle). Leader only. |
| `approve` | `peerId` | Admit a pending arrival from the waiting room. Leader only. |
| `reject` | `peerId` | Decline a pending arrival. Leader only. |
| `leave` | — | Explicit exit, equivalent to closing the socket. |
| `name-announce` | `to` (target peerId), `payload` (opaque ciphertext string, encrypted under the sender/recipient pair's `K_pair_meta` — see [`e2e-encryption.md`](e2e-encryption.md)) | E2E v2: announce (or re-announce) the sender's display name to one specific peer. Rights: an ordinary participant may target any other participant in the same room; a pending arrival in the waiting room may target **only the current leader** (it has no visibility into anyone else). Capped at 2KB, counted against the same shared relay rate limit as offer/answer/ICE/`stream-info`. |

`RoomSettings` (see [`permissions-and-leader.md`](permissions-and-leader.md)
for the full model):

```
{ lobbyEnabled: bool, guestChat: bool, guestAudio: bool, guestVideo: bool, guestScreen: bool, maxParticipants: number | null }
```

`maxParticipants` (additive field): `null` means "no leader-set limit, follow
the server's own `MAX_PARTICIPANTS`"; a number must be `2..=MAX_PARTICIPANTS`
or the whole `update-settings` call is rejected. See
[`permissions-and-leader.md` §5](permissions-and-leader.md#5-room-settings)
for the full model, including that lowering it never evicts anyone already
in the room.

## 4. WebSocket: Server → Client

| type | Fields | Sent To |
|---|---|---|
| `joined` | `peerId`, `peers: [{peerId, name, epub}]` (other current participants; `name` always `null` — the server no longer stores it at all, see [§3](#3-websocket-client--server)), `screenOwner?`, `leaderId`, `settings`, `pending: [{peerId, name, epub}]` (non-empty **only** for the leader), `expiresInSeconds` (no longer used by the frontend for display — kept on the wire for backward compatibility, see the note below the table), `roomAgeSeconds` (additive field: seconds since the room's very first participant joined — `0` for that first joiner; shared by everyone in the room, so a late joiner sees the room's real elapsed age rather than `0`; survives being emptied and refilled within the empty-room TTL, but not a server restart, see [`../src/state.rs`](../src/state.rs) `Room::first_joined_at`), `maxParticipants` (the room's *effective* ceiling — `settings.maxParticipants ?? MAX_PARTICIPANTS`, see [`permissions-and-leader.md` §5](permissions-and-leader.md#5-room-settings)) | The newly admitted participant |
| `peer-joined` | `peerId`, `name?` (always `null` — the server never stores this field, kept in the wire shape only for backward compatibility, see [§3](#3-websocket-client--server)), `epub?` | Everyone else already in the room |
| `peer-left` | `peerId` | Everyone else in the room |
| `offer` | `fromPeerId`, `sdp` | The addressed target peer |
| `answer` | `fromPeerId`, `sdp` | The addressed target peer |
| `ice-candidate` | `fromPeerId`, `candidate` | The addressed target peer |
| `stream-info` | `fromPeerId`, `info` | The addressed target peer |
| `share-started` | `peerId` | Everyone in the room, including the initiator (one render path for all) — also the **only** signal a preempted former holder gets: it recognizes `peerId` isn't its own and, if its local capture is still live, stops it (see [`permissions-and-leader.md`](permissions-and-leader.md)) |
| `share-rejected` | `busyPeerId?` (kept in the wire shape for backward compatibility; the server never populates it any more — see [§7.1](permissions-and-leader.md#71-screen-sharing--server-enforced)), `reason?` (`"forbidden"` on a permission denial, the only case this message is sent for now) | Only the requester of `share-start` |
| `share-stopped` | `peerId` | Everyone in the room — on explicit stop, on the holder disconnecting, or when the leader revokes `guestScreen` mid-share |
| `waiting` | `leaderPeerId`, `leaderEpub?` (E2E v2: the current leader's ephemeral public key, so the waiting arrival can encrypt a `name-announce` to them — nullable, e.g. if the leader is on an older client) | A new arrival, instead of `joined`, while they're in the waiting room. **Re-sent** with the new leader's `leaderPeerId`/`leaderEpub` if the leader changes while this arrival is still pending — the old `leaderEpub` derives a pairwise key with a leader who's no longer there. |
| `join-request` | `peerId`, `name?` (always `null` — the server never stores this field; the arrival's actual name comes separately via `name-announce`), `epub?` (the pending arrival's ephemeral public key, needed by the leader to decrypt that `name-announce`) | The leader — a new (or re-delivered, after a leader change) pending arrival |
| `join-request-cancelled` | `peerId` | The leader — a waiting arrival disconnected before a decision |
| `join-rejected` | — | A waiting arrival who was declined (or whose room emptied out before a decision); the server closes their socket immediately after |
| `settings-changed` | `settings` | Everyone in the room — the leader changed room settings |
| `leader-changed` | `leaderId` | Everyone in the room — the previous leader left and the server assigned a new one |
| `room-full` | — | A joiner when the room is already at its participant ceiling |
| `room-not-found` | — | A joiner when the room doesn't exist (never created, or already reaped) |
| `room-expired` | — | Everyone in the room *and* everyone waiting: the room outlived its maximum lifetime; the server closes the socket immediately after |
| `error` | `message` | The sender of a malformed, oversized, rate-limited, or permission-denied message |
| `name-announce` | `from` (the true transport sender, never self-declared), `payload` | The target peer named in the client's `name-announce { to, payload }` — relayed opaquely, see [§3](#3-websocket-client--server) |

> **`expiresInSeconds` vs. `roomAgeSeconds`.** The server still computes and
> sends both on every `joined` (first join and reconnect alike) — the meeting
> duration ceiling itself hasn't changed, only what the frontend's timer pill
> shows. `expiresInSeconds` (remaining time until the ceiling) used to drive a
> countdown display with a warning/critical color threshold; the frontend now
> instead shows a count-**up** built from `roomAgeSeconds` (elapsed time since
> the room's first participant joined), with no color thresholds at all — see
> `startRoomTimer`/`formatRoomTimer` in [`../static/room.js`](../static/room.js).
> `expiresInSeconds` is kept on the wire only for backward compatibility with
> any client that still reads it; `room-expired` still fires exactly when the
> real ceiling is hit, independent of either field's display use.

## 5. Relay Semantics

- **Content-blind routing.** `offer`/`answer`/`ice-candidate`/`stream-info`
  are routed from sender to `targetPeerId` (any other participant in the
  sender's room) without the server interpreting their payload.
- **Size caps.** Signaling relay payloads (`sdp`/`candidate`/`info`) are
  capped at 16KB serialized. Oversized payloads are rejected with `error` and
  never relayed. The WebSocket frame/message itself is additionally capped at
  64KB at the transport level — see [`security.md`](security.md) for the full
  rationale.
- **Rate limits.** One shared sliding-window counter covers all relay types
  on a connection combined (offer/answer/ICE/`stream-info`) so an attacker
  can't dodge a per-type limit by alternating message types. See
  [`security.md`](security.md) for the exact numbers and reasoning.
- **Unknown targets are silently dropped.** A `targetPeerId` that has already
  left is a normal race, not an error — the message is simply not relayed
  (logged at debug level).
- **Waiting arrivals cannot relay.** A peer sitting in the waiting room is
  not a participant and cannot send or receive relayed messages until
  admitted.
- **Permission-gated message types.** `share-start` is checked against the
  room's current `RoomSettings` for non-leader senders before being processed.
  Chat is no longer server-gated — it never reaches the server, so its
  `guestChat` permission is cooperative only (see
  [`permissions-and-leader.md`](permissions-and-leader.md)).
- **Screen-share ownership conflicts preempt, they don't reject.** A
  `share-start` while someone else already holds the screen replaces them
  instead of getting `share-rejected` — see
  [`permissions-and-leader.md` §7.1](permissions-and-leader.md#71-screen-sharing--server-enforced).

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

On process shutdown (`SIGTERM`), the server proactively broadcasts a
WebSocket `Close` (code `1012`, "Service Restart") to every open connection,
then pauses briefly (~500ms) to give that close frame a chance to flush,
before the process exits — instead of silently holding connections open
until `SIGKILL` cuts them. This turns a shutdown into an ordinary disconnect
from each client's point of view (same reconnect path as a network blip —
see [`self-hosting.md`](self-hosting.md) "Surviving a Restart/Redeploy"),
rather than a hung connection that only resolves once the heartbeat times
out or the OS forcibly kills the process. See
[`research-ops.md`](research-ops.md) §1.0/§1.6 for the reasoning.

## 8. Versioning & Backward Compatibility

The protocol is **additive only** within a major version: new fields and new
message types are added without removing or repurposing old ones, so a
client running older frontend code keeps working against a newer server
without a forced reload. This is what makes the reconnect-after-restart flow
safe (see [`self-hosting.md`](self-hosting.md)) — a client can reconnect
mid-session against a server that has since gained new message types it
simply never uses. The frontend surfaces an informational "a new version is
available" banner (via `/version.json`, see [§2.7](#27-get-versionjson)) but
never forces a reload on its own.
