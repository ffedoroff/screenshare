# Research: Defending Against DoS "Hammering" of Rooms/Slots from a Single IP

> Status: analysis, nothing implemented. 2026-07-16.
> Question: what anti-DoS mechanisms already exist in the code (`src/state.rs`, `src/ws.rs`,
> `src/main.rs`), how well do they close off the scenario "an attacker hammers
> rooms/slots from a single IP" (and its variations — distributed, IP
> spoofing, zombie connections), and what's worth improving — at the
> application level and at the Cloudflare level, which already sits in front
> of the prod instance today
> (`chat.fedorov.it` / `chat-api.fedorov.it`, see `docs/self-hosting.md`).

<!-- toc -->

- [1. Inventory: What's Already in the Code](#1-inventory-whats-already-in-the-code)
- [2. Determining the Client IP and Its Reliability](#2-determining-the-client-ip-and-its-reliability)
- [3. "Hammering" Vectors — In Increasing Order of Sophistication](#3-hammering-vectors--in-increasing-order-of-sophistication)
- [4. Defenses by Layer](#4-defenses-by-layer)
- [5. Prioritized Recommendations](#5-prioritized-recommendations)
- [6. Self-Hosted vs. Public Instance](#6-self-hosted-vs-public-instance)
- [7. Conclusions at a Glance](#7-conclusions-at-a-glance)

<!-- /toc -->

## 1. Inventory: What's Already in the Code

All the numbers and locations here were verified against the actual `src/state.rs`/`src/ws.rs`/`src/main.rs`
at the time of writing, not invented. See also `docs/security.md` §4 (H2)/§7
(M3)/§8/§9 — this section largely retells the same facts, but with precise
coordinates and a focus specifically on "hammering slots from a single IP,"
which isn't a separate section in `security.md`.

### 1.1 Room Creation Limit (H2) — `ROOM_CREATION_IP_LIMIT`/`ROOM_CREATION_IP_WINDOW`

- **Values**: 3 requests per 60 seconds from a single IP (`src/state.rs:62-63`).
- **Where it's applied**: only `POST /api/rooms` (`create_room`, `src/main.rs:339`)
  — `PUT /api/rooms/{id}` (restoring after a restart, `restore_room`,
  `src/main.rs:425`) doesn't check this limit **at all** (only the global
  `MAX_ROOMS`, see below) — not a bug, but a deliberate choice: restoring by an
  already-known id gives an attacker no new capability beyond what `POST`
  already gives (see the comment at `src/main.rs:415-424`), but for
  completeness it's worth noting: `PUT` can theoretically be hit as often as
  desired from a single IP with no per-IP limit at all, if the attacker
  knows/guesses format-valid `room_id`s (8 chars from a limited alphabet —
  guessing a specific existing one is practically infeasible, but the absence
  of a limit is worth keeping in mind).
- **How it's implemented**: a sliding window (`VecDeque<Instant>`) in a shared
  map `IpRateLimitMap` (`type IpRateLimitMap = Arc<Mutex<HashMap<String,
  VecDeque<Instant>>>>`, `src/state.rs:158`), function `check_ip_rate_limit`
  (`src/state.rs:286-305`): purges stale timestamps for this IP, denies if
  there are already `>= limit` within the window, otherwise records a new one
  and allows the request. The map additionally **self-cleans** IPs whose every
  timestamp has expired (same pass, `retain` on line 289) — it doesn't grow
  unbounded with every address that has ever knocked.
- **A separate budget** from the lobby-entry limit (see 1.2) — its own map
  `AppState::room_creation_ips` (`src/state.rs:172`), not shared.

### 1.2 Lobby Entry Limit (M3) — `PENDING_JOIN_IP_LIMIT`/`PENDING_JOIN_IP_WINDOW`

- **Values**: 10 requests per 60 seconds (`src/state.rs:75-76`) — no longer
  the same numbers as 1.1 now that `ROOM_CREATION_IP_LIMIT` has been
  tightened to 3/60s, but this was never the same mechanism as 1.1 to begin
  with — a separate map `AppState::pending_join_ips`
  (`src/state.rs:175`), a separate budget. The rationale for keeping them
  separate is in the comment at `src/state.rs:65-74`: creating your own room
  and requesting to join someone else's (via a link) are different in nature
  even for the same IP (e.g. a NAT with several people behind it) — a shared
  budget would hurt legitimate use.
- **Where it's applied**: only when a room has `lobby_enabled=true`
  (`src/ws.rs:334-388`, checked on line 345) — **`lobby_enabled: false` by
  default** (`src/protocol.rs:61`), meaning this limit doesn't factor into a
  room's defense at all unless the leader explicitly turns the lobby on. This
  is a key fact for §3.2 below.
- **Scope — global per IP, not per room**: there's one map for the whole
  `AppState`, meaning 10 attempts to enter ANY lobby of ANY room within 60s
  total from one IP, not 10 per room individually. Separately from this
  — `MAX_PENDING=10` (`src/state.rs:42`) — the queue ceiling for **one
  specific room's** waiting room (not an IP budget).

### 1.3 Global Room Count Ceiling — `MAX_ROOMS`

- **Value**: env `MAX_ROOMS`, default 500 (`DEFAULT_MAX_ROOMS`,
  `src/state.rs:54`). Read once via a plain variable (not a
  `LazyLock`, unlike `MAX_PARTICIPANTS`/`MAX_ROOM_LIFETIME`) and stored in
  `AppState::max_rooms` at startup (`src/main.rs:220-223, 227`).
- **Where it's applied**: `create_room` (`src/main.rs:351`) and `restore_room`
  (`src/main.rs:444`) — both checks under the same `rooms` lock as the
  insertion, explicitly so a race between two simultaneous requests can't slip
  past both checks and exceed the ceiling together (comment at
  `src/main.rs:348-350`). Once reached — `503 Service Unavailable` for
  **everyone**, not just the offending IP — this is a shared global resource,
  hitting honest and malicious room creators alike.

### 1.4 `MAX_PARTICIPANTS` and `MAX_PENDING`

- `MAX_PARTICIPANTS`: env, default 6 (`DEFAULT_MAX_PARTICIPANTS`,
  `src/state.rs:37`, read via `LazyLock` in `src/main.rs:119-124`) — the
  ceiling on live participants in **one** room. Checked in `JoinRoom`
  (`src/ws.rs:390`) and in `handle_approve` (`src/ws.rs:638`).
- `MAX_PENDING`: constant 10 (`src/state.rs:42`) — the ceiling on **one**
  room's lobby queue (not per-IP, see 1.2).
- **Important**: neither `JoinRoom` (direct entry, bypassing the lobby — i.e.
  the **default path**, since `lobby_enabled=false` by default) nor
  `handle_approve` has any per-IP limit whatsoever — the only protection for a
  room's slots is that specific room's `MAX_PARTICIPANTS` ceiling itself.
  The consequences are examined in §3.2 (the "hijacking a stranger's room
  slots" vector), the main hole documented in this file.

### 1.5 Relay Rate Limit and Payload Caps — and a Notable Inaccuracy in the Code/Docs

- **Relay rate limit**: `RELAY_RATE_LIMIT=100` messages per
  `RELAY_RATE_WINDOW=10` seconds (`src/ws.rs:78-79`) — one shared counter PER
  CONNECTION (not per IP), covering `Offer`/`Answer`/`IceCandidate`/
  `StreamInfo`/`NameAnnounce` combined (`check_relay_rate_limit`,
  `src/ws.rs:753-755`, called from every relevant branch of
  `handle_message`, e.g. `src/ws.rs:410, 422, 434, 446`, and in
  `handle_name_announce`, `src/ws.rs:868`).
- **Payload caps**: `RELAY_MAX_BYTES=16*1024` (16KB, `src/ws.rs:64`) for
  `sdp`/`candidate`/`info`; `NAME_ANNOUNCE_MAX_BYTES=2*1024` (2KB,
  `src/ws.rs:57`) for the encrypted name announcement; `WS_MAX_MESSAGE_SIZE`/
  `WS_MAX_FRAME_SIZE=64*1024` (64KB, `src/ws.rs:86-87`) — a transport-level
  cap, applied via `WebSocketUpgrade::max_message_size`/
  `max_frame_size` (`src/ws.rs:153-154`), verified against the axum 0.8 API.
- **Discrepancy with the task and with `docs/security.md`**: the task and
  `docs/security.md` §4/§6 mention a "chat 10/10s" and an "8KB chat cap" as a
  separate, stricter limit specifically for chat messages. **This doesn't
  match the current code**: the comment at `src/ws.rs:73-77` does indeed
  mention a nonexistent constant `CHAT_RATE_LIMIT` ("chat additionally
  is ADDITIONALLY subject to a stricter, chat-specific limit
  (`CHAT_RATE_LIMIT`, 10/10s)"), but:
  - `ClientMessage` (`src/protocol.rs:73` onward) has **no `Chat` variant at
    all** — only `JoinRoom`/`Offer`/`Answer`/`IceCandidate`/`StreamInfo`/
    `ShareStart`/`ShareStop`/`UpdateSettings`/`Approve`/`Reject`/`Leave`/
    `NameAnnounce`;
  - the module-level comment at `src/protocol.rs:10-15` states directly:
    "Protocol v3+ (F0/F1): chat travels EXCLUSIVELY over the mesh
    RTCDataChannel... The former addressed server-relay fallback for chat has
    been removed";
  - `grep -rn "CHAT_RATE_LIMIT\|ClientMessage::Chat"` across all of `src/`
    finds exactly one mention — that same stale comment at
    `src/ws.rs:74`, and nothing else.

  Bottom line: the server today doesn't relay chat **at all** (not a single
  byte of chat content ever passes through the signaling server) — the "8KB
  chat"/"chat 10/10s" mentioned in the task is **code that was removed with a
  forgotten comment**, not an active mechanism. For a DoS analysis this is
  good news (no separate chat-relay flood vector — it's physically absent),
  but the stale comment/documentation is worth cleaning up at some point (out
  of scope for this analysis — just noting the finding).

### 1.6 The Reaper — `EMPTY_ROOM_TTL`/`MAX_ROOM_LIFETIME`/`REAPER_INTERVAL`

- **`EMPTY_ROOM_TTL_SECONDS`**: env, default 120 seconds (`src/main.rs:207-210`)
  — how long a room lives with zero participants (including one just created
  via `POST` that no one connected to) before deletion.
- **`MAX_ROOM_LIFETIME_SECONDS`**: env, default 10800s = 3 hours
  (`DEFAULT_MAX_ROOM_LIFETIME_SECONDS`, `src/state.rs:58`, `LazyLock` in
  `src/main.rs:102-108`) — a hard ceiling on a room's lifetime **regardless**
  of whether it has live participants; on reaching it, every participant and
  every lobby entrant is sent `room-expired`, then the room is deleted
  (`reap_rooms`, `src/state.rs:218-242`, branch at `src/state.rs:224-233`).
- **`REAPER_INTERVAL`**: constant 1 second (`src/state.rs:50`) — how often the
  background check ticks; the pass over all rooms is synchronous, under a
  short lock, with no `.await` inside the critical section.
- Cleaning up empty rooms and cleaning up "expired by age" rooms are **the
  same** background task (`reap_rooms`), not two separate mechanisms.

### 1.7 Heartbeat (Ping/Pong) — What It Protects Against, and What It Doesn't

- `PING_INTERVAL=20`s, `MAX_MISSED_PONGS=2` (`src/ws.rs:98-102`) — the server
  itself pings every 20s; after two consecutive pings with no reply at all
  (and no incoming message of ANY kind from the client), it closes the
  connection itself, without waiting for the OS's TCP timeout (minutes).
- **Critical for the DoS analysis**: this defends against connections that
  **silently died** (Wi-Fi dropped, laptop went to sleep), not against an
  **active** attacker. A client that deliberately wants to hold onto a slot
  longer simply answers the pings (or axum answers `Pong` on its behalf
  automatically for the pings themselves, and an incoming `Pong` reply to OUR
  `Ping` also resets the counter, `src/ws.rs:230-237`) — the heartbeat
  **cannot distinguish** "a person honestly sitting in the room" from "a
  script holding the connection open to occupy a slot." Hence: the heartbeat
  provides no protection whatsoever against deliberate slot-holding — only
  against accidentally dropped connections. An important premise for §3
  (vectors 2 and 6).

### 1.8 `extract_client_ip` — The Source of the Client IP

Covered separately and in detail in §2 below (this is a separate, cross-cutting
question relevant to all per-IP limits at once).

---

## 2. Determining the Client IP and Its Reliability

The function `extract_client_ip` (`src/state.rs:252-273`), used both in
`create_room` (`src/main.rs:338`) and in `ws_handler`→`handle_message`
(`src/ws.rs:149`, then passed as `ip: &str` into every check):

1. `CF-Connecting-IP` — if the header is present and non-empty, use it;
2. otherwise the first address from `X-Forwarded-For` (if present);
3. otherwise — the socket peer address (`peer_addr`, from
   `ConnectInfo<SocketAddr>` — a direct TCP connection with no proxy,
   available thanks to
   `into_make_service_with_connect_info::<SocketAddr>()`, `src/main.rs:280`).

**Prod topology today** (per `registry/domains/fedorov.it.md` and
`registry/projects/chat.md`): `chat-api.fedorov.it` — a **proxied** CNAME
(orange cloud) to a Cloudflare Tunnel (`kubesolo-ingress`) inside
`contabo3858312`. This matters for assessing reliability:

- **A Cloudflare Tunnel opens no inbound port on the origin at all** —
  `cloudflared` inside the cluster itself initiates an OUTBOUND connection to
  Cloudflare; there's structurally no way for an external client to reach the
  backend while bypassing the Cloudflare edge (unlike a classic
  reverse-proxy + publicly exposed origin port setup, where a direct bypass is
  possible if the host's IP is known). With this topology,
  `CF-Connecting-IP` **is set by the Cloudflare edge itself** and cannot be
  spoofed by a client "from outside" — Cloudflare rewrites this header as
  traffic passes through its network, regardless of what the client sent.
- **But the code doesn't verify this, and can't** — `extract_client_ip`
  unconditionally trusts the `CF-Connecting-IP`/`X-Forwarded-For` header if
  it's simply present, **having no idea** who the actual immediate TCP peer
  is (Cloudflare itself, or something else). Today this is safe purely thanks
  to the topology (the only path to the origin goes through the Cloudflare
  Tunnel), not thanks to the code. If the topology ever changes (e.g. someone
  temporarily opens a NodePort/LoadBalancer with a public IP for the same
  service for debugging, or a self-hoster puts their own nginx in front of
  the server without explicitly scrubbing client-supplied headers) — the
  anti-spoofing protection disappears silently, with not a single line of
  code to notice or warn about it.
- **A general (not topology-specific) risk, already acknowledged in
  `docs/security.md` §9**: "Per-IP rate limiting is not attacker-proof... a
  sufficiently motivated attacker behind a spoofable or absent proxy chain
  could evade it" — this document confirms and sharpens that disclaimer: the
  risk is real not abstractly, but specifically because `extract_client_ip`
  performs absolutely no check of "did this header come from a trusted
  proxy" (no allow-list of Cloudflare IP ranges, no verification that the
  immediate socket peer is a known Cloudflare/local-reverse-proxy node).
- **Self-hosted without Cloudflare or with a different proxy** — the risk is
  far more real: if an operator runs the server behind a plain nginx (or with
  no proxy at all, directly), and nginx is configured naively
  (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` without
  trimming an already-present value, or the reverse proxy passes headers
  through as-is), an external client can simply send
  `CF-Connecting-IP: 1.2.3.4` (random on every request) — and ALL per-IP
  limits (1.1, 1.2) are bypassed for free: `check_ip_rate_limit` faithfully
  treats every "new" IP as fresh and unrestricted.

**Conclusion for §2**: today, for the actual prod topology (Cloudflare
Tunnel), spoofing `CF-Connecting-IP` as an external client is practically
impossible — Cloudflare physically sits in the path of every request and
sets this header itself. But this is protection "by virtue of network
topology," not "by virtue of the code" — the code trusts the header equally
in prod (where it's safe) and in a hypothetical self-hosted deployment behind
a naive proxy (where it is NOT safe). Concrete hardening options are
discussed in §4.2/§4.3.

---

## 3. "Hammering" Vectors — In Increasing Order of Sophistication

### 3.1 A Single IP Creates a Bunch of Rooms (`POST /api/rooms`) — THE CUSTOMER'S TOP-PRIORITY QUESTION

> The `PUT` gap (at the end of this section) was closed on 2026-07-16 — see recommendation 3b in §5.

> The customer clarified: what they're primarily interested in is
> **hammering via room creation** from a single IP, not seizing slots via
> joining (§3.2). Good news: of all the vectors in this document, room
> creation is protected **best of all** — the only one where a lone attacker
> with one IP structurally can't cause harm (calculation below). The
> remaining risk here is only the distributed variant (§3.4) and the small
> `PUT` gap (at the end of this section).

- **What gets exhausted**: in the limit — the global `MAX_ROOMS` (503 for
  everyone); in practice it barely uses any memory (an empty `Room` is a few
  dozen bytes, 500 rooms is not a problem in itself).
- **Does the current defense catch it**: yes, `ROOM_CREATION_IP_LIMIT=3/60s` (§1.1).
- **Calculation for the scenario asked about in the task**: the maximum with
  perfect "pressing" against the sliding-window limit — 3 requests every 60s
  sustained = **up to 180 rooms/hour** from one IP theoretically. But:
  - every room created and never filled dies after
    `EMPTY_ROOM_TTL=120`s (§1.6);
  - by Little's Law: the average number of simultaneously live (unfilled)
    rooms from ONE such attacking IP ≈ creation rate × lifetime =
    (3 rooms / 60s) × 120s = **≈ 6 rooms at once**, even if the attacker
    presses the limit forever and never joins any of them;
  - for a single IP to fill the entire `MAX_ROOMS=500` with nothing but empty
    rooms would require a creation rate **~83 times higher** than what's
    allowed — meaning **the reaper, solo against one IP, clears rooms faster
    than the attacker can ramp up toward the global ceiling**: with current
    settings there's no realistic way for a single IP to "eat" `MAX_ROOMS` on
    its own, as long as both `ROOM_CREATION_IP_LIMIT` and `EMPTY_ROOM_TTL`
    remain in effect.
- **What could be improved**: nothing needed for a single IP — the defense is
  sufficient. The only real threat is the distributed version (see §3.4): to
  fill 500 slots, a distributed attacker needs only **about ~83 distinct
  IPs**, each pressing its own limit forever (500 / 6 ≈ 83) — cheap for
  anyone with a handful of VPS instances/proxies, and per-IP limiting is
  structurally powerless here (see §3.4).
- Additionally: `PUT /api/rooms/{id}` doesn't check `ROOM_CREATION_IP_LIMIT`
  at all (§1.1) — a theoretical, not practical, hole (you'd need to
  know/guess a format-valid id, which doesn't give real control over the
  number of restored rooms beyond `MAX_ROOMS`, the same lock and the same
  ceiling check on line `src/main.rs:444`). Still, for symmetry with the
  creation path it's worth putting the same per-IP limit on `PUT` too (see
  §5, recommendation 3b) — cheap, and it closes the one "create-like" route
  that ignores IP.

**Bottom line for the top-priority vector (single-IP creation):** there's no
realistic threat — `ROOM_CREATION_IP_LIMIT` + `EMPTY_ROOM_TTL` + `MAX_ROOMS`
together already make solo creation-flooding pointless (the reaper frees
capacity faster than a single IP can ramp up). What's still worth adding on
this route: (1) close the `PUT` route with the same limit, (2) duplicate the
limit at the Cloudflare edge for the public instance, so the flood is
absorbed BEFORE it reaches the origin, and (3) keep `MAX_ROOMS` as the last
line of defense against the distributed variant. The
`ROOM_CREATION_IP_LIMIT=3/60s` value itself already reflects a deliberate
tightening — for a legitimate user, creating more than 3 rooms a minute
isn't a typical scenario, and it leaves an attacker very little room to
maneuver; the constant is trivial to adjust further (a single value) without
breaking backward compatibility, should an even tighter bound ever be
needed.

### 3.2 A Single IP Occupies a Stranger's Room's Slots via a Link (Joining Up to `MAX_PARTICIPANTS`) — THE MAIN HOLE

> Implemented on 2026-07-16 — see recommendation 1 in §5.

- **What gets exhausted**: the slots of a **specific** room
  (`MAX_PARTICIPANTS`, default 6) — not a global resource, but a targeted
  denial of service against specific legitimate guests who know the link.
- **Does the current defense catch it**: **no, if `lobby_enabled=false`
  (the default)**. As shown in §1.4: the direct-join branch (`JoinRoom`
  without a lobby, `src/ws.rs:390-398`) never calls `check_ip_rate_limit` in
  any form — the only check is
  `room.participants.len() >= *crate::MAX_PARTICIPANTS` (a plain, non-per-IP
  counter). If the leader left the settings at their default (and that
  default is exactly this, `src/protocol.rs:61`), an attacker with a single
  IP who knows (or picked up over someone's shoulder, or from a leak) the
  link can:
  1. open `MAX_PARTICIPANTS` (typically 6) WS connections;
  2. send a `join-room` on each with a freshly generated `peer_id`;
  3. **all 6 of the room's slots are taken within a fraction of a second**,
     without tripping a single rate limit — join-flooding is subject to
     neither `RELAY_RATE_LIMIT` (which only counts
     `Offer`/`Answer`/`IceCandidate`/`StreamInfo`/`NameAnnounce`, not
     `JoinRoom`), nor `PENDING_JOIN_IP_LIMIT` (lobby only);
  4. from there, the attacker only needs to **honestly answer ping/pong**
     (§1.7) to hold the slots indefinitely — the heartbeat structurally
     cannot distinguish a live attacker from a live human;
  5. real guests following the same link later get `RoomFull` from the
     server (`src/ws.rs:391`) — the room is unavailable to everyone it was
     created for, while from the server's point of view this all looks like
     ordinary, legitimate load.
  The cost of the attack is **six ordinary WebSocket connections from one
  IP**, zero special tools, zero bypassing of any check (there simply are
  none on this path).
- **If `lobby_enabled=true`** — the picture is different, and noticeably
  better: requests go through `pending`, where `PENDING_JOIN_IP_LIMIT=10/60s`
  (§1.2) applies — the same attacker can queue at most 10 requests per
  attempt (and even that's shared across any rooms, one global budget), but
  **can't seize real slots themselves** — the leader approves them manually.
  The lobby is already, today, the only real barrier against this vector,
  not some theoretical recommendation — this is confirmed by the code, not
  just intuition.
- **Made worse by the "leader-set limit" feature** (see
  `docs/research-room-limit.md` §3, the "DoS angle" section — already noted
  and correctly assessed there, not duplicating the full analysis here): if
  the leader sets a small custom `maxParticipants` (e.g. 2, for a private
  one-on-one conversation) WITHOUT enabling the lobby, this same vector
  becomes **several times cheaper** — a single parasitic connection is
  enough to permanently occupy the sole remaining "third" slot. That
  document explicitly recommends a UI hint that "a small limit without a
  lobby doesn't give you privacy" — agreed, and not repeating it here; it's
  just worth noting that the root cause isn't the leader-limit feature
  itself, but the fact that basic join-flooding WITHOUT a per-IP limit
  already exists today, regardless of whether the feature from
  `research-room-limit.md` ever ships.
- **What could be improved**: add a per-IP limit directly on
  `JoinRoom`-into-a-room (not just on entering the pending lobby) — details
  in §4.2.

### 3.3 A Single IP Opens a Bunch of WS Connections Without Joining a Room

- **What gets exhausted**: the process's file descriptors, memory (one
  `tokio::task` + `mpsc::UnboundedSender/Receiver` per connection) — the
  server's own resources, not any specific room's.
- **Does the current defense catch it**: **not at all, in any form.**
  `ws_handler` (`src/ws.rs:136-156`) only (optionally) checks `Origin`
  against `CORS_ORIGIN`, if one is set (by default — none is set, so no
  check happens) — no per-IP limit on the rate of WS handshakes, nor on the
  number of connections simultaneously open from one IP. The router in
  `main.rs` doesn't apply `tower::limit::ConcurrencyLimitLayer` or any other
  overall connection-count limit either — the only practical ceiling is the
  process's `ulimit -n` and the OS's memory. A WS connection that does
  nothing (never sends `join-room`) doesn't touch a single existing
  counter — it doesn't even register in `room_creation_ips` or
  `pending_join_ips`.
- **What could be improved**: a per-IP ceiling on the number of
  SIMULTANEOUSLY open (not yet joined to a room) WS connections — a simple
  gauge counter, incremented on upgrade, decremented in `cleanup`/on exit
  from `handle_socket`; or, more bluntly — a general rate limit on the mere
  fact of a WS upgrade per IP (the same mechanism as 1.1/1.2, a third map).
  Details in §4.2.

### 3.4 Many IPs (Botnet/Distributed)

- **What gets exhausted**: the same as in 3.1-3.3, but per-IP limits are
  powerless almost by definition — they count by IP, and there are many IPs.
- **What defenses remain**: the only mechanisms NOT tied to IP are the
  global `MAX_ROOMS=500` (§1.3, stops room-creation flooding, but at the
  cost of denial for everyone once reached — effectively turning a
  "hammer the rooms" attack into "take the service down for all new
  users" — a 503 that's no more selective than the attack itself) and the
  time-based reaper (§1.6, bounds the worst-case duration of accumulated
  damage, but not the fact of temporary unavailability itself). For vector
  3.2 (seizing a specific room's slots), the attacker doesn't even need to
  be distributed — there's no per-IP limit there anyway (see 3.2), and
  `MAX_PARTICIPANTS` isn't a per-IP quantity at all.
- **Conclusion**: at the application level, a distributed attack fundamentally
  cannot be solved with per-IP mechanisms — that's a structural ceiling of
  the approach, not a shortcoming. The only realistic line of defense
  against a botnet is the network layer IN FRONT OF the server (Cloudflare
  WAF/rate limiting/Bot Fight Mode/Turnstile, discussed in §4.3) — there,
  large botnets are visible through patterns (geography, fingerprint, IP
  reputation across Cloudflare's whole network) that our own server simply
  doesn't have and can't have at its current scale and architecture.

### 3.5 Spoofing `CF-Connecting-IP`/`X-Forwarded-For` to Bypass Per-IP Limits

Detailed analysis — §2. Short conclusion here: **for the actual prod
topology (Cloudflare Tunnel) — the risk is low**, because there's no path to
the origin bypassing the Cloudflare edge, which sets the header itself.
**For self-hosted without Cloudflare or with a naive proxy in front of the
server — the risk is real and total**: the code trusts the header
unconditionally, with no check that it came from a trusted node (no
allow-list of Cloudflare IP ranges, no verification of the header's origin)
— this erases the effect of literally every per-IP limit (§1.1, 1.2, and any
future ones from §4.2) down to zero, at nearly zero cost to the attacker.

### 3.6 Slow/Zombie Connections, Holding a Slot Within the Heartbeat Window

Briefly (the full analysis of the reconnect-specific case is in
`docs/research-room-limit.md`, the section on reconnect zombies, not
duplicating it here): the heartbeat (§1.7) only detects connections that
**died silently**, within 20-40s; a connection actively held open by an
attacker (one that answers pings) isn't detected at all, for as long as the
attacker likes — up to `MAX_ROOM_LIFETIME` (3 hours), when the reaper kills
**the entire room** (not just the attacker). Separately — there's a ~40-60s
window (`PING_INTERVAL × MAX_MISSED_PONGS` plus the delay until the next
tick) between a client actually disappearing and their slot being freed: for
the default `MAX_PARTICIPANTS=6` this is minor (plenty of spare slots), but
it amplifies vector 3.2 in small/limited rooms — an attacker can "twitch" the
connection (open-close-open), and each cycle guarantees them up to a minute
of an occupied slot almost for free, with no need to keep the connection
alive continuously.

---

## 4. Defenses by Layer

### 4.1 Already in the Code — Assessment of Sufficiency

| Mechanism | Values | Sufficiency |
|---|---|---|
| `ROOM_CREATION_IP_LIMIT` | 3/60s, per IP | Sufficient for a single IP (§3.1); powerless against a botnet (§3.4) |
| `PENDING_JOIN_IP_LIMIT` | 10/60s, per IP, global budget | Sufficient, but only applies when `lobby_enabled=true` (not the default) |
| `MAX_ROOMS` | 500, global | Stops unbounded growth, but itself becomes a single point of failure for everyone once reached |
| `MAX_PARTICIPANTS`/`MAX_PENDING` | 6 / 10, per room | Limit the damage a single room can suffer, don't prevent the attack from inflicting it |
| Relay rate limit + payload caps | 100/10s, 16KB/2KB/64KB | Sufficient against signaling flooding; doesn't cover join-flooding (a different code path) |
| Reaper (`EMPTY_ROOM_TTL`/`MAX_ROOM_LIFETIME`) | 120s / 3h | Effectively bounds accumulation of GARBAGE (empty rooms), doesn't protect occupied slots |
| Heartbeat | 20s × 2 | Protects against silent disconnects, NOT against deliberate holding (§1.7, §3.6) |
| `extract_client_ip` | CF-Connecting-IP → XFF → socket | Reliable in the current topology (CF Tunnel), not verified explicitly by the code (§2) |
| **Joining-a-room (not the lobby)** | **none at all** | **A hole — §3.2, this document's main finding** |
| **Limit on simultaneous "empty" WS connections per IP** | **none at all** | **A hole — §3.3** |

### 4.2 Cheap Application-Level Improvements

All of these are small, additive changes following the pattern of mechanisms
that already exist (no new dependencies needed, they reuse the existing
`IpRateLimitMap`/`check_ip_rate_limit`):

1. **A per-IP limit on `JoinRoom`-into-a-room (not just on pending)** — the
   highest priority. A third map in `AppState` (`room_join_ips`, or an
   extension of the existing `pending_join_ips` so the budget is SHARED
   between "enter pending" and "join directly via `join-room`" — they solve
   the same class of problem — but that's a separate architectural decision,
   not necessarily worth merging) with the same sliding window, invoked on
   the direct-join branch `src/ws.rs:390` BEFORE the check
   `room.participants.len() >= *crate::MAX_PARTICIPANTS`, following the
   pattern of the existing check on line 345 for the lobby. Estimate:
   ~1 hour (code) + documentation.
2. **A limit on simultaneous "empty" WS connections per IP** — a gauge
   counter (`Arc<Mutex<HashMap<String, usize>>>`, a separate structure from
   `IpRateLimitMap`, since this is a current count, not a sliding window),
   incremented on upgrade, decremented on `handle_socket` closing; if the
   counter for an IP exceeds a reasonable ceiling (e.g. 10-20), reject before
   the upgrade. Estimate: ~1.5-2 hours (needs to carefully guarantee the
   decrement on every exit path — a Drop guard or an explicit call at the
   end of `handle_socket`, which the function's structure already partly
   covers).
3. **Faster reaping of zombie connections** — shrinking `PING_INTERVAL`
   (e.g. to 10s) and/or `MAX_MISSED_PONGS` (e.g. to 1) cuts the §3.6 window
   by half to a third, but does NOT solve the underlying problem (a
   deliberately held connection will keep answering pings) — this only
   reduces the damage from the "twitching" variant of the attack, not from
   sustained holding. Cost — trivial (constants), but it helps little
   relative to vector 3.2 — low priority specifically for DoS purposes
   (though useful in its own right for fast-reconnect UX).
4. **Exponential backoff on repeated denials** — e.g. an IP that regularly
   hits `ROOM_CREATION_IP_LIMIT`/a future join limit gets a progressively
   longer denial window (rather than a fixed sliding window). More complex
   to implement correctly (needs separate per-IP "penalty" state, not just a
   window of attempts) and yields a fairly modest gain relative to the
   complexity — see §4.4 "what not to do."
5. **A trusted IP source** — at the code level: if the server explicitly
   expects to run only behind Cloudflare (the current prod setup), it could
   (a) check the immediate socket peer (`peer_addr`) against Cloudflare's
   published IP ranges (https://www.cloudflare.com/ips/) and only trust
   `CF-Connecting-IP`/`X-Forwarded-For` if the request genuinely came from
   one of those ranges, falling back to `peer_addr` otherwise; or (b) simpler
   still — the Cloudflare Tunnel already guarantees this at the network
   level anyway (§2), so for THIS specific deployment, (a) is redundant
   work. But if the server is meant to be a reusable self-hosted artifact
   (which it is, see `docs/self-hosting.md`), it's worth at least explicitly
   documenting (not in code, but in `self-hosting.md`) the requirement
   "either keep Cloudflare (or another trusted proxy) in front of the
   server, or don't count on per-IP limits protecting you from anything" —
   this is cheaper than code, and more honest toward independent operators.

### 4.3 Infrastructure Layer — Cloudflare in Front of `chat.fedorov.it`/`chat-api.fedorov.it`

Verified via web search (2026), with sources:

- **Rate Limiting Rules (WAF)**: on the Free plan — **1 rule**, on Pro — 2, on
  Business — 5, on Enterprise — 100 ([Cloudflare docs, Rate limiting
  rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)). Even
  one rule is already useful: you can limit exactly `POST /api/rooms` (or
  the mere fact of a GET request to `/ws` — the initial WS handshake is an
  ordinary HTTP GET with an `Upgrade` header, which passes through the WAF
  BEFORE the upgrade) by path + a per-IP counter — this duplicates §1.1 at
  the edge, BEFORE the traffic even reaches the Rust process (reducing load
  on the origin itself during a flood, not just limiting the effect). The
  Free plan can match on `Path` and count by `IP` — that's enough for this
  purpose.
- **Turnstile (CAPTCHA)**: free on all plans, with no limit on the number of
  requests/site keys (up to 20 widgets per account), with no "wall" at
  10,000 verifications ([Cloudflare Turnstile
  plans](https://developers.cloudflare.com/turnstile/plans/)). It could be
  attached to the room-creation button (`POST /api/rooms`) on the frontend —
  requires changes both to the frontend (the widget) and the backend
  (verifying `siteverify` before creating a room, a new outbound HTTP call
  to Cloudflare from the Rust service) — not free in terms of effort, even
  though it's free financially.
- **Bot Fight Mode**: free on the Free plan. **An important practical
  caveat, specific to this project**: Cloudflare explicitly documents that
  Bot Fight Mode/Super Bot Fight Mode can **break legitimate traffic through
  a Cloudflare Tunnel** ("websocket: bad handshake") if the
  `Definitely Automated` rule isn't set to `Allow` — meaning enabling Bot
  Fight Mode outright on a zone where `chat-api.fedorov.it` goes through a
  tunnel and a WS upgrade could **break the WS handshake for real users**,
  not just bots. If this feature is ever enabled for this domain — an
  exception for our own traffic must be configured first (or it should be
  tested very carefully on a staging subdomain), this isn't "flip it on and
  forget it."
- **Bottom line for CF**: a realistic, cheap set for a public prod instance —
  1 rate-limiting rule on `POST /api/rooms` (and optionally a second one, if
  ever upgrading to Pro, on the `/ws` handshake itself) plus, if desired,
  Turnstile before room creation. Bot Fight Mode — enable with caution and
  testing, specifically because of the Tunnel-specific fragility.

### 4.4 What NOT to Do (Over-Engineering for This Scale)

- **A full-blown WAF/ML anomaly detector on our own side** — at this
  project's scale (a personal server, single-to-low-tens of concurrent
  users, rooms held in memory with no DB) this is categorically excessive;
  everything "smart" needed for pattern detection is already available from
  Cloudflare for free at the edge — no need to reimplement it inside the
  Rust process.
- **A distributed rate limit (Redis/etcd) instead of `Mutex<HashMap>`** —
  with a single replica (`Recreate` deployment, see the project's registry
  card), in-memory structures are entirely sufficient; preparing for
  horizontal scaling of a stateful signaling server is a separate, much
  larger architectural topic (session affinity/sticky routing, or moving
  room state out-of-process), unrelated to DoS defense as such.
- **CAPTCHA on EVERY action** (joining, not just creating) — would break the
  product's core UX pitch ("a call via link in seconds, with no friction,"
  see `docs/PRD.md`) in exchange for defending against a threat that, for
  joining, is already cheaper and more precisely closed off by the lobby
  (§3.2) — not a proportionate cost.
- **Exponential backoff with complex penalty state** (see §4.2 item 4) —
  complicates the code noticeably more than a sliding window, for a modest
  gain in protection — lower priority than closing hole 3.2/3.3 first.
- **Checking Cloudflare IP ranges in the code** (§4.2 item 5a) — only
  justified if the project genuinely targets many independent self-hosted
  installations behind different providers; with the current single prod
  deployment behind a Cloudflare Tunnel, the network topology already gives
  the same guarantee for free (§2); a code-level check would be additional
  "future-proofing," not something removing a current risk.

---

## 5. Prioritized Recommendations

1. **[High priority, cheap] Per-IP limit on direct `JoinRoom`-into-a-room**
   (§4.2 item 1) — closes the most real and cheapest-for-the-attacker hole in
   this document (§3.2): today ANY room with default settings
   (`lobby_enabled=false`) can be hammered by six ordinary connections from
   one IP, with no check whatsoever. ~1 hour of work, reuses the existing
   `check_ip_rate_limit` mechanism unchanged.
   > Implemented on 2026-07-16 (`JOIN_ROOM_IP_LIMIT`, default 20/60s).
2. **[Medium priority, cheap] A limit on simultaneous "empty" WS connections
   per IP** (§4.2 item 2) — closes the FD/memory exhaustion vector (§3.3),
   which today has no protection whatsoever, in any form. ~1.5-2 hours.
3. **[Medium priority, infrastructure, nearly free in terms of time] One
   Cloudflare Rate Limiting rule on `POST /api/rooms`** (§4.3) — duplicates
   §1.1 at the edge, reducing load on the origin BEFORE a flood reaches it;
   free on the Free plan, takes 10 minutes to configure in the dashboard.
   This is a key defense against the customer's top-priority vector, room
   creation (§3.1), especially against the distributed variant (§3.4), where
   a per-IP limit in the code is structurally powerless, while the edge can
   filter on aggregate signals (ASN, IP reputation, Bot Score).
3b. **[Low priority, cheap] Extend `ROOM_CREATION_IP_LIMIT` to
   `PUT /api/rooms/{id}`** (§3.1) — currently the only create-like route that
   ignores IP; ~15 minutes, reusing `check_ip_rate_limit`. Optionally
   tighten the constant to 5/60s there too.
   > Implemented on 2026-07-16; the constant has since been tightened to 3/60s
   > (matching the current `ROOM_CREATION_IP_LIMIT` default).
4. **[Low priority] Explicit documentation about trusting `CF-Connecting-IP`
   in `self-hosting.md`** (§4.2 item 5b) — not code, but a paragraph for
   future self-hosted operators: "per-IP limits rely on a trusted proxy in
   front of the server setting this header itself — without one, they're
   useless against even a minimally motivated attacker." Half an hour of
   work, closes the risk of misunderstanding, not the risk itself.
5. **[Low priority, optional] Turnstile on room creation** (§4.3) — only if
   automated flooding of `POST /api/rooms` is actually observed beyond what
   §1.1 + recommendation 3 already absorb; for the project's current scale —
   more of a "nice to have in your back pocket" than something to do now.
6. **Don't touch** the heartbeat constants, and don't build backoff machinery
   for this specific threat (§4.4) — the effort there is disproportionate to
   the payoff relative to items 1-2.

---

## 6. Self-Hosted vs. Public Instance

| | Public instance (current prod, `chat.fedorov.it` behind Cloudflare) | Self-hosted (an arbitrary operator, `docs/self-hosting.md`) |
|---|---|---|
| Reliability of `extract_client_ip` | High — the Cloudflare Tunnel physically rules out bypassing the edge (§2) | Depends entirely on what the operator put in front of the server — by default (no proxy) `peer_addr` is reliable, but easily broken with a naive proxy |
| Availability of the infrastructure layer (§4.3) | Yes, already there, free on the Free plan, worth enabling (recommendation 3) | Not by default — the self-hoster must set up Cloudflare (or another WAF) in front of the server themselves for the same level of protection; this isn't part of the "out of the box" experience |
| Priority of hole 3.2 (join-flooding) | Just as real as anywhere — the lobby/limit from recommendation 1 are needed regardless of Cloudflare (Cloudflare can't distinguish a legitimate `join-room` from a parasitic one — that's application logic, not an HTTP pattern) | The same |
| Is it fine to "offload" protection onto infrastructure | Yes — Cloudflare is already part of the project's architecture (see `registry/projects/chat.md`, S2), it makes sense to use what's already there for free | No default assumption — the self-hosting documentation should explicitly call the "out of the box" level of protection (only §1, without §4.3) the baseline, with an external WAF/rate limit as a strongly recommended, but optional, hardening step, not something implied |

Practical conclusion: recommendations 1-2 from §5 (application level) are
needed **regardless of** infrastructure — they close a hole that no WAF will
ever see (join-flooding looks like ordinary traffic at the HTTP/WS level).
Recommendation 3 (Cloudflare rate limit) is a bonus, available to this
specific prod deployment today at essentially no cost, but it doesn't
replace items 1-2, and the self-hosting documentation shouldn't give
operators without Cloudflare the false impression that every threat in this
document is already closed off.

---

## 7. Conclusions at a Glance

**The main hole**: with default settings (`lobby_enabled=false`, i.e. in most
real-world rooms), anyone who knows a room's link can occupy all
`MAX_PARTICIPANTS` (typically 6) slots with six ordinary WebSocket
connections from one IP — the server today **checks no per-IP limit on
direct entry into a room** (only on entering the lobby, and the lobby is off
by default). The attack is cheap (a handful of sockets, zero special tools),
and holding the slots is effectively indefinite (the heartbeat can't tell an
attacker from an honest participant, §1.7/§3.6), and it gets even cheaper
if/when a leader can set their own small `maxParticipants` (see
`docs/research-room-limit.md`).

**Top 3 recommendations**:

1. Add a per-IP limit on direct `JoinRoom`-into-a-room (not just on entering
   the pending lobby) — the same `check_ip_rate_limit` mechanism already
   used for the lobby and for room creation, just on a new code path.
   ~1 hour.
2. Add a limit on the number of simultaneous "empty" (not joined to a room)
   WS connections per IP — today there's no limit whatsoever besides the
   OS's `ulimit`. ~1.5-2 hours.
3. Enable one free Cloudflare Rate Limiting rule on `POST
   /api/rooms` (the Free plan gives 1 rule) — duplicates the existing
   application-level defense at the edge, free and fast, but doesn't replace
   items 1-2.

Sources:
- [Rate limiting rules · Cloudflare WAF docs](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)
- [Get started with Bot Fight Mode · Cloudflare bot solutions docs](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
