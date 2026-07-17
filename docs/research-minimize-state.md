# Research: What Can Be Purged From the Server — URL Fragment, RoomSettings, Room Memory, Ping

> Status: analysis only, **nothing has been implemented or changed in the
> code**. 2026-07-16.
> The client is reconsidering the project's philosophy ("the server sees the
> MINIMUM, ideally just signaling for NAT traversal") and is asking for an
> honest breakdown of four specific questions based on the actual code and
> docs, with complexity estimates for the changes in hours, but without
> making the changes themselves.
>
> Everything below has been verified against the actual `src/state.rs`,
> `src/ws.rs`, `src/protocol.rs`, `src/main.rs`, `static/room.js`,
> `static/landing.js`, `static/chat.js`, `docs/privacy.md`,
> `docs/permissions-and-leader.md`, `docs/e2e-encryption.md`,
> `docs/self-hosting.md`, `docs/research-p2p-key-handoff.md`,
> `docs/research-dos.md`, `deploy/manifests/ingress.yaml` — not from memory.

<!-- toc -->

- [1. What's in the URL Fragment](#1-whats-in-the-url-fragment)
- [2. RoomSettings — Why on the Server](#2-roomsettings--why-on-the-server)
- [3. Server Memory Inventory](#3-server-memory-inventory)
- [4. Ping Every 20 Seconds](#4-ping-every-20-seconds)
- [5. Conclusion: What to Move/Remove, What to Leave Alone](#5-conclusion-what-to-moveremove-what-to-leave-alone)

<!-- /toc -->

## 1. What's in the URL Fragment

The actual composition today (see `static/landing.js:110-112` and
`static/room.js:52-97`): `/r/<roomId>#lt=<token>&t=<token>&e=<expiry>&n=<name>`.

| Parameter | Who sets it | Who reads it | Cleared from the address bar? | In `buildShareLink()` / QR? |
|---|---|---|---|---|
| `lt` | `landing.js` on creation (from the `POST /api/rooms` response) | server (`ws.rs::handle_message JoinRoom.leader_token`, one-time, burned after use) | **Yes** — `room.js:73-84`, `history.replaceState` BEFORE anything is shown | **No** — a one-time secret, no reason to expose it |
| `t` | `landing.js` (`RoomCrypto.generateRoomToken()`, 16 random bytes) | `room.js` (`initCryptoIdentity`) → HKDF → `K_auth` | No | **Yes** |
| `e` | `landing.js` (`floor(now/1000)+lifetimeSeconds+300`) | `room.js` (`initCryptoIdentity`) → baked into the HKDF `info` for `K_auth` | No | **Yes** |
| `n` | `landing.js` (value of `#room-name-input`, pre-filled with `NameGen.roomName()`) | `room.js` (fragment parsing → `document.title`/`.room-logo` IMMEDIATELY, before `init()`) | No | **Yes** |

### 1.1 The Hypothesis About `n` (Room Name) — a Fork in the Road, Not a Decision

Important: the fact that `n` is currently in `buildShareLink()`/the QR code
is neither an accident nor a forgotten default. It is in fact the SECOND
reversal of a decision on this very question, documented directly in the
code itself and in `privacy.md`:

- **v1 (long ago)**: the room name lived only in the one-time `#lt` fragment
  — the creator lost it after the very first F5, and guests who joined via
  invite never saw the name at all.
- **v2 (current, a deliberate change)**: the comment at `room.js:41-51`
  states directly — "Previously... guests never saw it at all. Now `n` is
  PART of the invite link... the room name is visible to every participant."
  `privacy.md` §4 records this as a product commitment: *"A room's name is
  visible to every participant, but never becomes server-side state"* —
  explicitly stating that `n` stays in the `#t=...&e=...&n=...` fragment for
  EVERYONE, not just the creator, and that this is intentional.

Verified against the code: the client's hypothesis ("this is unnecessary,
it's only needed by the creator") technically contradicts an already-made
and documented decision of "visible to everyone" — not a bug, but a
reversal of a product requirement. What follows is both positions and their
consequences, without making the choice for the client.

**(a) Leave it as is — visible to everyone.**
Pros: the guest sees a meaningful room name in the tab title and header,
convenient when several calls are open at once; matches the client's
previous explicit request ("visible to ALL participants"); nothing needs to
change.
Cons: `n` is pre-filled but freely editable text, meaning it is potentially
the only human-readable piece of user content that travels in the link/QR
itself in plaintext (not encrypted — the server doesn't see it anyway, but
anyone with the link/QR sees it right away). This is not a new leak by
itself: whoever has `t`/`e` already has full access to the room — `n` does
not expand what a person can LEARN, only what they see IMMEDIATELY, without
joining. The link is slightly longer / the QR code slightly denser.

**(b) `n` only for the creator (in their URL, survives an F5), removed from
`buildShareLink()`/the QR — guests don't know the name.**
Technically: remove the `namePart` concatenation in `buildShareLink()`
(`room.js:3992-3994`) — `renderShareQr()` takes as ITS input exactly what
`buildShareLink()` returned (`openSharePopup()`: `const link =
buildShareLink(); renderShareQr(link);`), so removing `n` from a single
function removes it from both the copyable link and the QR in one change.
Parsing `n` out of the fragment and rendering it into `document.title`/
`.room-logo` on load (`room.js:93-97`) can stay as is — that's what gives
the creator "survives an F5."
What's lost: guests joining via invite will see the default title/header
instead of the room name — exactly what the client seems to want.
**An important technical caveat that must be said out loud**: in this
variant, `n` still physically sits in the address bar of the creator
THEMSELVES (after `history.replaceState` in `room.js`, their URL becomes
`#t=...&e=...&n=...` — the same shape of fragment as the "invite" one). If
the creator shares not through the "Share" button/QR but by manually
copying the browser's address bar contents, `n` travels along with the
rest. Distinguishing "copied via the Share popup" from "copied manually
from the URL bar" is programmatically impossible (it's the same string) —
meaning variant (b) only guarantees the intended path (the "Share"
button/QR), not an absolute one. This should honestly be flagged to the
client if they choose (b).

**(c) Compromises** (not mutually exclusive with (a)/(b)):
- Don't pre-fill `#room-name-input` with `NameGen.roomName()` — leave the
  field empty so the name is added only by the creator's explicit action,
  rather than "by default for everyone" (right now, pre-filling effectively
  means almost every room will have a name, even if the creator never
  thought about it).
- Show a short note in the "Share" popup: "The room name is visible to
  anyone who opens this link" — doesn't change the mechanics, resolves the
  "will the guest see this?" question at the UX level rather than the code
  level.
- A "full variant (b) without the caveat above" is also technically
  possible — move the creator's secret into a SEPARATE third parameter
  like `lt` that also survives an F5 (unlike `lt`, not burned on first
  use), but still never placed into `buildShareLink()`. This doesn't solve
  the "copied the URL bar manually" problem (that parameter would still be
  visible in the creator's address bar), so it makes no practical
  difference from (b) — not recommended as a separate move.

### 1.2 `e` (expiry) — Can It Be Removed From the URL

No — and this isn't a matter of taste. `e` isn't just read by the client on
join, it's **baked into the HKDF `info`** when deriving `K_auth =
HKDF-SHA256(ikm=t, salt=∅, info="auth-v2|"+e)` (`docs/e2e-encryption.md`
§2.2, implemented in `static/crypto.js: deriveAuthKey`, called from
`room.js: initCryptoIdentity` for EVERY participant, not just the creator).
All pairwise keys (`K_pair_sig`/`K_pair_meta`) are derived with `K_auth` as
the salt — if two participants have a different `e`, they'll derive a
different `K_auth` and, transitively, different pairwise keys, and
decrypting each other's messages simply won't work (see
`e2e-encryption.md` §2.2, `docs/research-p2p-key-handoff.md` §6.6). This
means `e` is needed **literally by everyone** who joins via the link, not
just the creator — removing it from the link for guests would mean giving
them a different (empty/default) `e`, they'd derive a different `K_auth`,
and the whole E2E model would break on the very first `offer`/`answer`.
This is confirmed by both the code and the docs, and it is the only
fragment parameter for which a firm "no, it cannot be removed" can be given
with no fork in the road at all — unlike `n`, there is no product choice
here, only cryptographic necessity.

`t` is necessary for everyone in the same spirit: it is the only HKDF input
that provides authentication (`K_auth`); without it, decoding won't match
up for anyone. Keeping both in the URL for all participants isn't
"excess," it's the only working way to survive an F5 without
localStorage/cookies (which are forbidden under the anonymity model, see
`privacy.md` §4).

### 1.3 Verdict and Complexity

- `lt` — already minimal and already cleared. Nothing to do. **0 hours.**
- `t`/`e` — structurally necessary for all participants, cannot be removed
  without breaking the E2E model. **Leave alone.**
- `n` — the only genuine candidate for reconsideration, and it's a fork in
  a product decision, not a technical bug. Variant (b) ("creator only,
  remove from `buildShareLink`/QR") — **1-2 hours** (one function +
  updating comments in `landing.js`/`room.js`/`privacy.md`, which currently
  document the present behavior directly as intentional, + a couple of
  lines in tests if they probe `buildShareLink`). Compromise (c) with a UI
  warning — **~1 hour**. Removing the `NameGen` pre-fill — **~0.5 hours**.
  There's little technical complexity here — the cost of the decision
  isn't in the implementation, it's in the fact that it reverses an
  already-made and documented product choice for the second time.

## 2. RoomSettings — Why on the Server, Can It Be Moved to the Creator

`RoomSettings` (`src/protocol.rs:41-52`): `lobbyEnabled` (default `false`),
`guestChat`/`guestAudio`/`guestVideo`/`guestScreen` (default `true` for all
four). Stored in `Room::settings` (`src/state.rs:139`) — entirely in
process memory, tied to the ROOM, not to any specific participant. Only the
leader can change it, via `update-settings` → `handle_update_settings`
(`src/ws.rs:574-614`) — as a whole, not a patch, with a check of
`room.leader_id.as_deref() != Some(ctx.peer_id...)` → otherwise `error`.
Broadcast to all participants as `settings-changed`, and to a new
participant in `joined`.

The document `docs/permissions-and-leader.md` §7 already honestly and
thoroughly classifies the enforcement for each field (verified against the
code that the description matches the facts):

### 2.1 Class I — the Server Must Enforce It Itself

- **`lobbyEnabled`** — structurally server-side. The server keeps a
  separate `Room::pending` map (not `participants`, with its own
  `MAX_PENDING` limit) and physically decides whether an incoming WS peer
  makes it into `room.participants` (and therefore whether `relay()` will
  route anything to/from them at all, see `src/ws.rs:826-833` — `relay()`
  silently refuses anyone not in `participants`). This isn't "enforcement
  out of politeness" — it's the same decision the server already has to
  make in order to relay signaling at all: membership is "entirely
  server-side truth" (`permissions-and-leader.md` §1, direct quote). This
  physically cannot be moved to the leader without the server ceasing to
  be the gateway into the room at all — that is, without abandoning the
  lobby feature itself.
- **`guestScreen`** — the server genuinely rejects it: `handle_share_start`
  (`src/ws.rs:683-712`) — a non-leader with `guest_screen=false` gets
  `ShareRejected{reason:"forbidden"}` sent back, the request is NOT
  applied. Moreover, the server itself tears down a guest's already-running
  share if the permission is revoked on the fly
  (`handle_update_settings:601-613`), without waiting for client
  cooperation. `screen_owner` is state shared across the multi-peer mesh
  ("who currently holds the screen"), and the server acts as the sole
  arbiter precisely because, without a single decision point, two
  simultaneous `share-start` calls from different participants would be
  resolved differently in different browsers (a race), rather than
  consistently for everyone — the server serializes them like any other
  room message (`ws.rs:145-161`, in the `ClientMessage::ShareStart`
  comment). A server-less version (leader as arbiter over the bus) is
  technically imaginable, but it would be deliberately WORSE: it replaces a
  hard consistency guarantee with "almost always correct, except during
  races," in exchange for a state-size win equal to ONE `Option<String>`
  per room — i.e., a practically zero gain against a real risk.

### 2.2 Class II — Already Just Client-Side Courtesy Today

Per the code (not the document — separately verified that the document
doesn't embellish):

- **`guestChat`** — the server has no involvement whatsoever in the chat
  path (chat travels exclusively over the mesh `RTCDataChannel`, see
  `docs/chat.md` §12, `docs/permissions-and-leader.md` §7.2). The server's
  only role is to store the value and broadcast `settings-changed`; it
  rejects nothing and cannot (it has no visibility into the chat channel
  at all). Verified in `static/chat.js:2108-2143`
  (`isIncomingEnvelopeAllowed`) — filtering of incoming
  `text`/`file-offer` from non-leaders when `guestChat=false` happens
  entirely on the receiving end, in client-side JS.
- **`guestAudio`/`guestVideo`** — the same thing, even further from the
  server: the server doesn't participate in media at all (pure P2P mesh),
  enforcement happens only on the RECEIVING END
  (`refreshMediaRenderingForPeer` in `room.js`, lines 1466-1496 — "whether
  to render an incoming track or not" is decided individually by each
  receiver). The sender also cooperatively mutes its own track
  (`applyGuestEnforcement`, `room.js:1435-1459`), but this is bypassable
  with a modified client — the document itself honestly calls this
  "cooperative only" (§7.3).

### 2.3 Can Class II Be Moved to the Leader + P2P Bus — What's Lost

Technically possible: the room already has ready-made infrastructure for
this — the `Bus` over the mesh `RTCDataChannel` (`static/bus.js`, used by
chat and SAS, see `room.js:414` `const bus = new Bus()`). The leader could
keep `guestChat/guestAudio/guestVideo` locally in tab memory and broadcast
over that same bus on change; a new participant would get them from the
leader on joining.

What is actually lost if this is done (honestly, not hypothetically):

1. **A race on join.** Today, `settings` arrive ATOMICALLY in `joined` —
   before even one P2P connection is established (see `admit_participant`,
   `src/ws.rs:542-551` — `settings: room.settings.clone()` is placed in the
   same response as `peer_id`/`peers`). If the LEADER distributed the
   value over the bus instead, a new participant would only learn the
   current settings AFTER their WebRTC connection specifically with the
   leader comes up (ICE + DTLS — real time, not zero) — until that moment
   the client either doesn't know the settings at all (has to pick a
   default guess), or temporarily renders/allows something the leader has
   already forbidden.
2. **Reconnect and a temporarily absent leader.** Today, `joined` on
   reconnect returns settings from SERVER memory regardless of whether the
   leader happens to be online at that moment (the room survives a
   temporary leader disconnect — see `docs/permissions-and-leader.md`
   §3-4). If settings were stored at the leader — should a new participant
   join/reconnect at exactly the moment the leader itself is
   offline/reconnecting, there would be nowhere at all to get the current
   settings from (the server no longer stores them).
3. **Leader handover.** Today, `room.settings` lives INDEPENDENTLY of who
   the leader is — the leader leaving doesn't touch `settings` in any way
   (`cleanup_peer`, `src/ws.rs:930-1016`, doesn't touch `room.settings`).
   If the settings lived "with the leader," the leader leaving would mean
   they have to be handed off to the NEW leader BEFORE the old one
   disappears — that is, reintroducing exactly the state-handover problem
   that the server solves for free today, by being a single source of
   truth tied to the ROOM rather than to a specific participant.
4. **Server restart.** Here there's an unexpected nuance in favor of
   moving this: today, `PUT /api/rooms/{id}`, when restoring a room after
   a restart, sets `settings: RoomSettings::default()` (`src/main.rs:460`)
   — meaning the settings **already don't survive a signaling restart even
   now**. If they lived at the leader, and mesh connections survive a
   signaling restart (`self-hosting.md` §7.2 — "Media and chat are
   peer-to-peer and keep working through a signaling outage"), the leader
   could in theory keep them alive BETTER than today's reset to default.
   This isn't a decisive argument (a realistic restart is seconds, and the
   default is almost always safe — "everything allowed" except the lobby),
   but to be fair: moving this here isn't unambiguously worse along this
   axis.

Conflict with `permissions-and-leader.md` §1 ("membership/role is
server-side truth"): there is no real conflict, if the concepts are
carefully separated — §1 talks about **membership and the leader role**,
not about the `guestChat/Audio/Video` values themselves. Membership
(`leader_id`, who the leader is, who's in the room) remains server-side
truth in any variant; the move concerns only three specific boolean fields
for which the server is already not the enforcement arbiter today, only
the storage and broadcast point.

**Assessment of the benefit of moving this**: it's philosophical, not
practical. Three boolean fields amount to a few bytes per room, there's no
sensitive information in them (`guestChat=true/false` isn't PII), and they
aren't logged to disk separately from the rest of the room's memory.
Moving them does NOT change the enforcement guarantee (there isn't one
today either — it's already "cooperative only"), while it introduces real
races/seams on join, reconnect, and leader handover, as analyzed above.

### 2.4 Verdict and Complexity

- **Class I (`lobbyEnabled`, `guestScreen`) — do not move.** This isn't
  about "hard to implement," it's about the move literally meaning giving
  up the hard guarantee these features provide today (the server really
  does refuse entry/screen-sharing). Estimating the complexity of the move
  has no practical meaning (it's not "more expensive," it's "the feature
  stops being what it is").
- **Class II (`guestChat`, `guestAudio`, `guestVideo`) — technically
  possible, not recommended.** Implementing "leader stores + sends over
  the bus + reconciliation on join/reconnect/leader handover, with
  graceful degradation while the bus isn't up yet" is estimated at
  **8-16 hours** (transmission over the `Bus` itself is cheap — the main
  cost is handling the join race before the mesh is ready, handling a
  temporarily absent leader during reconnect, handover on leader change,
  tests for all these scenarios, updating
  `permissions-and-leader.md`/`signaling-protocol.md`). The payoff is
  purely "three fewer fields on the server," with no change to the threat
  model and no privacy gain (these fields never held sensitive data
  anyway). Recommendation: don't do it, unless it becomes part of a larger
  refactor (e.g., if the whole "leader/lobby" feature set is ever
  revisited from scratch) — as a standalone task, the cost/benefit doesn't
  justify the race-condition risk.

## 3. What Else the Server Stores — Inventory and Reducibility

The complete list of what lives in process memory per room/participant
(`src/state.rs` only, not counting temporary local function variables):

| Where | Field | Needed for signaling/NAT traversal? | Can it be moved to the client? |
|---|---|---|---|
| `AppState` | `rooms: SharedRooms` | Yes — this is the room map itself; without it, relaying doesn't exist | No |
| `AppState` | `max_rooms`, `room_creation_ips`, `pending_join_ips` | Anti-DoS (H2/M3), not narrowly about signaling, but about the service's survival | See §3.1 below |
| `Room` | `participants: HashMap<peerId, Participant>` | **Yes, structurally** — the server relays `offer`/`answer`/`ice`/`stream-info`/`name-announce` by `targetPeerId`; without a "who's where" map, relaying doesn't work at all | No — this is literally the definition of the signaling task |
| `Room` | `screen_owner: Option<String>` | Needed for consistent arbitration of a single "screen holder" across the whole mesh (see §2.1) | Theoretically (Class I per §2), not recommended |
| `Room` | `emptied_at: Option<Instant>` | Not directly for NAT/relay, but yes for minimization: it's what provides ephemerality (empty-room TTL) | No point — this ACTIVELY helps minimization, not works against it |
| `Room` | `leader_id: Option<String>` | Needed as the sole source of truth for "who can change settings/approve the lobby" | No — removing it means anyone could claim to be the leader |
| `Room` | `leader_token: Option<String>` | A one-time secret determining who the leader is on first entry | No, but also not a problem — burned on first use, minimal by nature |
| `Room` | `settings: RoomSettings` | Partially — see §2 (Class I/II) | Partially (Class II — technically possible, see §2.3-2.4) |
| `Room` | `pending: HashMap<peerId, PendingParticipant>` | Yes — the same rationale as `participants`, but for the lobby | No |
| `Room` | `created_at: Instant` | Not for relaying, but for the "Meeting Duration Ceiling" — also a minimization measure (see `security.md` §8) | No point — removing it would INCREASE the worst-case metadata lifetime |
| `Participant`/`PendingParticipant` | `tx: PeerTx` | Yes — a live channel to the socket; without it the server can't send this peer anything | No, this isn't "data," it's a connection descriptor |
| `Participant`/`PendingParticipant` | `name: Option<String>` | **No** — always `null` for all v2 clients (see `protocol.rs:26-30`; the name now travels as a separate encrypted `name-announce`, the server never sees it at all) | Yes — a dead field, kept only for backward compatibility with old v1 clients |
| `Participant`/`PendingParticipant` | `epub: Option<String>` | Yes — the server must relay it so tabs can derive pairwise keys; the server itself doesn't parse it (opaque), and this is explicitly documented as harmless (`privacy.md` §2) | No — without the relay server, this key exchange simply wouldn't happen |
| `Participant`/`PendingParticipant` | `joined_at: Instant` | Yes — deterministic selection of a new leader (earliest join) and FIFO lobby ordering; without a shared reference point this would become a consensus problem between browsers | No |

### 3.1 Anti-DoS Maps (`room_creation_ips`/`pending_join_ips`) — an Honest Caveat

Formally, this is the one thing that isn't about "signaling for NAT" but
about the service's survival — a map of IP → timestamps over a sliding
window (`state.rs:155-158`). `privacy.md` §2 says "IP addresses and ports
are not logged or stored anywhere" — that statement is about **logs and
persistent storage**, not about this particular in-memory map: it does
hold IP strings, but (a) only within a short sliding window (60 seconds,
`ROOM_CREATION_IP_WINDOW`/`PENDING_JOIN_IP_WINDOW`), (b) self-cleans
(`check_ip_rate_limit` purges stale entries on every call), (c) never ends
up in any `tracing::info!`/`warn!` together with the actual IP address
beyond the mere fact of exceeding the limit. A detailed breakdown already
exists in `docs/research-dos.md` §1-2. This isn't a contradiction of
"minimal state," but an inevitable tension between "minimal" and
"protection against one IP hogging slots" — today's balance (60s window,
self-cleaning, not logged) is already reasonable; removing these maps
would mean bringing back the DoS risk analyzed separately in
`research-dos.md`.

### 3.2 How Close to the Ideal of "Server Only for NAT"

Already very close. What actually stands between the current state and the
pure ideal of "just packet routing" is not forgotten fields or
accidentally sprawling state, but **the product model itself** ("leader,"
"lobby," "guest permissions," "call duration limit") — that is, features
that BY DEFINITION require a single source of truth ("who's the leader,"
"who's approved in the lobby," "who holds the screen"), unless you want to
build a consensus protocol between browsers instead of one `HashMap` on
the server. Getting any closer to the ideal from here means not "cleaning
up code" but removing FEATURES (giving up the lobby, the single leader,
the server-side call timeout) — that's a product decision, not technical
cleanup.

> Implemented 2026-07-16: server-side storage of the `name` field in
> `Participant`/`PendingParticipant` has been removed; the protocol's
> wire fields remain (sent as `null`) for format backward compatibility.

The only finding that truly costs nothing and involves no product
trade-offs is the dead `name` field in `Participant`/`PendingParticipant`/
the protocol (always `null` for v2). Confirmed in the code:
`protocol.rs:26-30` explicitly states that this field is kept "as an
opaque [value] for backward compatibility with v1." There's no real gain
(in privacy or memory footprint) from removing it — it's already
`None`/`null`, storing and leaking nothing; this is purely protocol
hygiene.

### 3.3 Verdict and Complexity

- The server already doesn't store chat/media/files/names in plaintext —
  confirmed by `privacy.md` §1 and by the code (`name` is always `null`,
  chat never touches the server at all, media is P2P). The question
  really does come down only to membership/settings/leadership metadata.
- Removing the dead `name` field from the protocol/structs — **2-4 hours**
  (need to settle the question of backward compatibility with
  hypothetical v1 clients — if that guarantee is no longer needed, the
  field can be removed from the wire format entirely; if it is needed,
  leave it as is). The benefit is code hygiene only, not privacy or memory
  footprint (the field is already empty).
- Everything else in the table is either structurally necessary for
  relaying/NAT traversal, or actively WORKS toward minimization
  (TTL/duration limit), or is a necessary anti-DoS trade-off. **Leave
  alone.**

## 4. Ping Every 20 Seconds

`src/ws.rs:89-102`, `PING_INTERVAL = Duration::from_secs(20)`,
`MAX_MISSED_PONGS = 2`. Confirmed against the code (not from memory) —
this is:

- **The server pings the client**, not the other way around
  (`handle_socket`, `ping_interval.tick()` →
  `socket.send(Message::Ping(...))`, `src/ws.rs:186-194`). An incoming
  client `Ping` is also supported, but axum answers it with a `Pong` on
  its own, without any application code involved.
- These are **WS-level ping/pong frames**
  (`axum::extract::ws::Message::Ping/Pong`), not an application-level JSON
  message — no parsing, no room lock, a cheap control frame.
- Detection: every incoming frame of *any* kind (including `Pong`, but
  also `Text`) resets the `missed_pongs` counter to 0 (`src/ws.rs:230-237`).
  If `MAX_MISSED_PONGS=2` pings go out in a row with no response of any
  kind — the server itself tears down the connection
  (`src/ws.rs:186-190`). With a tick every 20s and the first tick "not
  counting," the real-world delay in detecting a dead peer is up to ~2
  intervals, i.e. on the order of 40-60 seconds in the worst case, not
  "seconds" as one might read the comment literally, but still orders of
  magnitude faster than an OS-level TCP timeout (minutes).

### 4.1 Why It's Needed — All the Actual Reasons, Not Just One

1. **Detecting dead TCP connections.** Right in the code comment
   (`src/ws.rs:90-97`): without active pinging, a disconnect without a
   FIN/RST (laptop sleep, dropped Wi-Fi, a NAT/load balancer that
   silently dropped state) isn't detected by `socket.recv()` for a very
   long time — minutes, per the OS timeout. Until the server knows a peer
   is dead, it keeps occupying: (a) a slot in `room.participants`
   (affects `MAX_PARTICIPANTS` — a "dead" participant keeps real people
   from joining while the room is formally "full"), (b) one `tokio` task
   and one `mpsc` channel in process memory.
2. **Keeping the WS alive through a proxy/tunnel with an idle timeout.**
   The production instance (`chat-api.fedorov.it`) genuinely sits behind
   a `cloudflare-tunnel-ingress-controller` (confirmed —
   `deploy/manifests/ingress.yaml:1-25`, `deploy/README.md:23-24`). Per
   current Cloudflare documentation (see sources below), **WS connections
   on the Free/Pro plan sit idle for no longer than 100 seconds** without
   data exchange in EITHER direction, after which Cloudflare itself
   silently tears down the connection; Enterprise can configure its own
   timeout, but that's not our plan. Sending a `Ping` frame every 20s
   (with the mandatory `Pong` response) keeps the connection "alive" from
   Cloudflare's point of view with a **5x** margin — a 20s interval
   against a 100s window.
3. There are no other documented reasons in the code — these are exactly
   two (dead-connection detection + anti-idle-timeout for the proxy),
   both confirmed both by the code and by the actual production topology.

### 4.2 Direct Answer: Is It Mandatory, What Breaks If Increased/Removed

- **Removing the ping entirely**: doesn't "break" the room functionally
  (the client's auto-reconnect with backoff still exists and will restore
  signaling after any disconnect, see `self-hosting.md` §7.2), but: (a)
  dead connections will linger in memory/occupy a participant slot until
  the OS TCP timeout (minutes, not tens of seconds) — for a room with a
  6-participant limit, this genuinely prevents new people from joining
  after someone "quietly" drops off; (b) behind Cloudflare Tunnel (or any
  other proxy with an idle timeout — this isn't Cloudflare-specific), a
  connection sitting idle without a single byte of traffic for more than
  ~100s will be silently killed — then every pause in signaling (nobody
  joining/leaving, nobody sharing a screen — i.e., most of a quiet call)
  ends with the WS dropping on its own, the client noticing via ITS OWN
  disconnect and entering a reconnect cycle — not a catastrophe
  (auto-recovery exists), but unnecessary "Reconnecting…" banners and
  unnecessary load on the reconnect logic for no reason.
- **Increasing the interval to 30-50s**: technically safe with margin in
  the 30-40s range (dead-peer detection slows to ~60-80s in the worst
  case, still leaving margin against the 100s CF timeout). At the 50s
  boundary the margin gets thin: with `MAX_MISSED_PONGS=2`, the
  worst-case idle time without a single byte of traffic creeps right up
  to 100s (last successful exchange + 2×50s ≈ 100s — with no margin left
  for network jitter, the latency of the Ping/Pong handshake itself
  through the tunnel, etc.). Recommendation, if lowering the frequency is
  desired: no higher than 30-40s, not 50s+.
- **Does the need depend on the topology (public behind Cloudflare vs.
  direct self-hosted)?** Yes, partly — a direct connection without a
  proxy has no infrastructure-side idle timeout at all (only an OS-level
  TCP timeout on both ends, usually very long), so for a PURELY
  self-hosted setup without a reverse proxy, reason #2
  (anti-idle-timeout) doesn't apply — only reason #1 remains
  (dead-connection detection), which is universal and doesn't depend on
  topology at all. But `docs/self-hosting.md` §3 itself recommends
  placing a reverse proxy/TLS terminator in front of the server in a real
  self-hosted deployment — and ANY such proxy (nginx, Caddy, an arbitrary
  ingress controller, not just Cloudflare) almost always has some idle
  timeout (typically anywhere from tens of seconds to several minutes
  depending on configuration) — meaning reason #2 generalizes far beyond
  Cloudflare specifically and is a universally cheap safeguard, not a
  Cloudflare-specific hack.

### 4.3 Verdict and Complexity

Recommendation: **leave it at 20 seconds as is.** The cost of the ping is
a control frame once every 20s per connection, with no JSON parsing and no
room lock (cheaper than almost any application message) — lowering the
frequency yields no measurable resource savings, while the 5x margin
against the current Cloudflare timeout (100s) is exactly the kind of
margin worth keeping deliberately (network jitter, future topology
changes, the simple fact that Cloudflare could revise its defaults).
Changing the constant is **~0.1 hours** technically (one line), but
there's no real reason to: there's no performance problem, nor any need
for the self-hosted case (which, if anything, is EVEN SAFER with a more
frequent ping rather than a less frequent one). If the client still wants
to lower the frequency for "less traffic" — 30s gives a noticeable margin
and remains safe everywhere; 50s+ is not recommended with the current
`MAX_MISSED_PONGS=2`.

## 5. Conclusion: What to Move/Remove, What to Leave Alone

### 5.1 Worth Considering (Priority by Cost/Benefit Ratio)

1. **`n` (room name) — decide the (a)/(b)/(c) fork from §1.1.** Not a
   technical task but a product decision for the client; if (b) is
   chosen — **1-2 hours** of implementation (remove one concatenation in
   `buildShareLink()`, update the invariant comments in the three files
   that currently document the present behavior directly as intentional).
   Honest caveat: (b) does not protect against the creator manually
   copying the URL bar instead of using the "Share" button — if that's
   unacceptable, variant (b) doesn't provide the full guarantee the
   client might expect.
2. **Remove the dead `name` field from `Participant`/`PendingParticipant`/
   the protocol** — pure code hygiene, **2-4 hours**, zero gain in
   privacy/memory (the field is already always empty for v2), but removes
   vestigial code and simplifies the protocol schema, if there's a
   willingness to formally give up backward compatibility with
   hypothetical v1 clients.
3. **`guestChat`/`guestAudio`/`guestVideo` — technically possible to move
   to the leader+bus, but not recommended.** **8-16 hours**, introduces
   real races on join/reconnect/leader handover (see §2.3) for a payoff
   limited to a few bytes per room and no change to the threat model
   (there's no enforcement there today either). Do this only if it's part
   of a broader overhaul of the entire permissions model, not as a
   standalone task.

### 5.2 Leave Alone, and Why

- **`t`/`e` in the URL fragment** — cryptographically necessary for ALL
  participants (baked into the `K_auth` derivation via HKDF), not "a
  convenience for the creator"; removing them breaks the entire E2E model
  on the very first message.
- **`lt`** — already minimal (one-time, burned, cleared from the address
  bar immediately). Nothing to do.
- **`lobbyEnabled`, `guestScreen` (RoomSettings, Class I)** — the server
  genuinely enforces these and structurally must (gating entry into
  `participants`, the sole arbiter of `screen_owner`). Moving them isn't
  "more expensive," it's giving up the very guarantee the feature
  provides.
- **`leader_id`/`leader_token`** — the sole source of truth for "who can
  change settings/approve the lobby"; removing it = letting anyone claim
  to be the leader.
- **The `participants`/`pending` maps + `tx` channels + `epub`** — this is
  the very definition of the "signaling for NAT traversal" task; without
  them the relay doesn't exist physically.
- **`created_at`/`emptied_at`** — actively WORK toward minimization (call
  duration limit, empty-room TTL); removing them would worsen, not
  improve, privacy.
- **Anti-DoS IP maps (`room_creation_ips`/`pending_join_ips`)** — a
  necessary trade-off with anti-DoS protection; bounded, self-cleaning,
  never logged/written to disk — an acceptable tension with the "minimal"
  ideal, not a violation of it.
- **The 20s ping** — cheap, provides a 5x margin against the current
  Cloudflare timeout (100s) and speeds up dead-peer detection from
  minutes to tens of seconds. No reason to change it.

### 5.3 Overall Conclusion on the Goal of "Server Only for NAT Traversal"

The project is already very close to this ideal: the server already
doesn't see chat/media/files/names in plaintext today (confirmed by the
code and `privacy.md`), and what remains on the server is almost entirely
either structurally necessary for the relaying task itself (the
participant map, `epub`, channels) or implements product features
("leader," "lobby," "call duration limit") that BY DEFINITION require a
single source of truth. Further movement toward the ideal isn't code
cleanup, it's revisiting the feature set itself, and that decision belongs
to the client, not to the implementation.

---

**Sources (external facts):**
- [WebSockets · Cloudflare Network settings docs](https://developers.cloudflare.com/network/websockets/) — Free/Pro plan: a WS connection idles for no longer than ~100 seconds without data exchange in either direction, after which Cloudflare closes it; Enterprise can configure its own timeout.
- [Cloudflare WebSockets: CDN, Workers & Durable Objects | WebSocket.org](https://websocket.org/guides/infrastructure/cloudflare/) — independent confirmation of the same threshold and a recommendation for client-side heartbeats on long-idle connections.
- [Connection limits · Cloudflare Fundamentals docs](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) — Cloudflare's general connection limits, context for the idle timeout.
