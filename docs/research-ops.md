# Research: Zero-Downtime Deploy and Single-Instance Capacity

> Analysis only — this file doesn't change anything in the code/manifests/CI.
> The facts about how the project is currently structured come from
> `docs/self-hosting.md`, `docs/webrtc-mesh.md`, `docs/signaling-protocol.md`,
> `src/main.rs`, `src/ws.rs`, `src/state.rs`, `static/room.js`,
> `.github/workflows/deploy-prod.yml`, `deploy/manifests/*.yaml`,
> `deploy/README.md`. External figures (memory per WS connection, FD limits,
> etc.) come from web search, July 2026, sources at the end of each part.
> Where a figure isn't independently confirmed (e.g., the real process memory
> on a live server) it's explicitly marked as an estimate, not a fact.

<!-- toc -->

- [Part 1. A Fully Seamless Deploy of a New Version](#part-1-a-fully-seamless-deploy-of-a-new-version)
  - [1.0 What Happens Now](#10-what-happens-now)
  - [1.1 Option — Graceful Drain with a Parallel New Container](#11-option--graceful-drain-with-a-parallel-new-container)
  - [1.2 Option — Blue-Green with roomId Stickiness](#12-option--blue-green-with-roomid-stickiness)
  - [1.3 Option — SO_REUSEPORT / Passing the Listening Socket](#13-option--so_reuseport--passing-the-listening-socket)
  - [1.4 Option — State Handoff (Serializing Rooms into a New Process)](#14-option--state-handoff-serializing-rooms-into-a-new-process)
  - [1.5 Option — Do Nothing Beyond the Current Setup](#15-option--do-nothing-beyond-the-current-setup)
  - [1.6 Recommendation](#16-recommendation)
- [Part 2. Single-Instance Capacity](#part-2-single-instance-capacity)
  - [2.1 What a Room/Participant Costs (From the Code)](#21-what-a-roomparticipant-costs-from-the-code)
  - [2.2 CPU](#22-cpu)
  - [2.3 Ports and File Descriptors](#23-ports-and-file-descriptors)
  - [2.4 Network](#24-network)
  - [2.5 Summary Table by Instance Size](#25-summary-table-by-instance-size)
  - [2.6 Recommendation for MAX_ROOMS](#26-recommendation-for-max_rooms)
  - [2.7 Precise Memory Calculation: 10 / 100 / 1 000 / 1 000 000 Rooms × 3 Participants](#27-precise-memory-calculation-10--100--1-000--1-000-000-rooms--3-participants)
- [Sources](#sources)

<!-- /toc -->

---

## Part 1. A Fully Seamless Deploy of a New Version

### 1.0 What Happens Now

> Implemented 2026-07-16: an active broadcast of `Close` (code 1012) to all
> open WS connections on `SIGTERM` + a ~500ms pause to flush before the
> process terminates (see §1.6) — the description below of "WS connections
> survive SIGTERM until SIGKILL" refers to the state BEFORE this change.

**Pipeline.** A push to `main` → `.github/workflows/deploy-prod.yml`: the
`test` job (signaling protocol) and `e2e` job (browser tests) gate everything
else → the `deploy` job builds the image (`docker buildx`, tag
`prod-<short-sha>`) and **delivers it over SSH directly to the server, with
no registry** (`docker save | gzip | ssh …`) → the server-side `deployer`
(forced command) imports the image into containerd and runs
`kubectl set image deployment/chat '*=chat:<tag>'`, then waits for
`rollout status` (`deploy/README.md`). So the question "what physically
happens on an update" isn't really about a Docker restart directly, but about
how Kubernetes (specifically, single-node KubeSolo) rolls out a `Deployment`
with its already-configured strategy.

**The strategy is `Recreate`, not `RollingUpdate`, and it's deliberate.**
`deploy/manifests/deployment.yaml`: `replicas: 1`, `strategy.type: Recreate`,
`terminationGracePeriodSeconds: 30`. The comment in the manifest states the
reason directly: room state is a `HashMap` behind a `std::sync::Mutex` in the
memory of exactly one process (`src/state.rs`); two simultaneously-alive pods
would each see a different half of the participants and would never see each
other — this is the same "single replica" invariant described in
`docs/self-hosting.md` §7.1. So `Recreate` isn't an oversight but a direct
consequence of the state model: the old pod fully stops **before** the new
one starts coming up (unlike `RollingUpdate`, where they run in parallel for
a while).

**What actually happens, second by second (from the code, not measured live).**

1. Kubernetes sends `SIGTERM` to the old pod. `src/main.rs::shutdown_signal`
   catches it (or `SIGINT` locally) and passes it into
   `axum::serve(...).with_graceful_shutdown(...)`.
2. Graceful shutdown in axum/hyper stops **accepting new** connections on the
   listening socket and waits for already-accepted HTTP requests to finish —
   but by this point a WebSocket connection has long since been "upgraded"
   into a separate `tokio` task (`ws::handle_socket`, its own
   `tokio::select!` loop with a heartbeat), which hyper's graceful-shutdown
   mechanism does not manage: it keeps reading/writing its socket as if
   nothing happened. In other words — **the old pod's already-open WS
   connections survive SIGTERM and keep relaying signaling** until they're
   closed by either the client, or by their own heartbeat timeout
   (`PING_INTERVAL=20s`, `MAX_MISSED_PONGS=2` — `src/ws.rs`), or by
   `SIGKILL`.
3. Since an active call has a constant heartbeat and participants don't
   close the socket themselves, no natural termination occurs — the process
   keeps living and serving open sockets until
   `terminationGracePeriodSeconds` (30s) expires, after which Kubernetes
   sends `SIGKILL` and tears everything down at once.
4. Only **after** the old pod has fully terminated (naturally or via
   `SIGKILL`) does the `Recreate` strategy start bringing up the new pod —
   this is a sequential, not a parallel, process. The image was already
   imported into containerd during the delivery step (step 3 in
   `deploy/README.md`), so there's no pull delay; the `readinessProbe` hits
   `/healthz` every 3s (`periodSeconds: 3`), so the new pod typically
   becomes `Ready` within a few seconds of the binary itself starting.
5. As soon as the pod is removed from the `Service` (this happens almost
   immediately after `SIGTERM`, independent of the readiness probe), new
   connections to `chat-api.fedorov.it` simply find no backend — the
   Cloudflare Tunnel Ingress (`deploy/manifests/ingress.yaml`) sees an empty
   endpoint list until the new pod becomes `Ready`.

**Overall estimate of the signaling downtime window** (a conclusion from
reading the code, **not confirmed by a live test with an active call** — if
this figure matters operationally, it's worth explicitly verifying it with a
deploy during a real call):

- If there's at least one active call at the moment of deploy (open WS
  connections with a heartbeat) — the old pod most likely lives almost the
  full **30s** (grace period), then gets `SIGKILL`; plus ~5–10s for the new
  pod to start and pass its first successful readiness probe. **Total,
  roughly 35–40s**, during which: (a) nobody can either re-enter a room or
  enter one for the first time via a link, (b) already-connected participants
  can't go through an ICE restart/new pair setup if one happens to be needed
  exactly in this window.
- If there are no active calls at the moment of deploy — nothing stops the
  old process from terminating immediately on `SIGTERM` (no open sockets that
  need to be held), and the window shrinks to essentially the new pod's
  startup time (~5–10s).
- **An important protocol-level nuance that explains why options 1 and 2
  below are harder than they sound:** `GET /ws` doesn't accept `roomId`
  either in the path or in query parameters at all
  (`docs/signaling-protocol.md` §2.7) — `roomId` only appears **inside the
  first WS message**, `join-room`, **after** a successful upgrade. That means
  no L7 proxy routing by Host/path (including the one currently in front of
  this service — `cloudflare-tunnel-ingress-controller`, see below) can
  physically distinguish "this is a WS for room A" from "this is a WS for
  room B" before the connection has already been established with SOME
  backend.

**What sits in front of the server today.** Not "just a reverse proxy" —
specifically `cloudflare-tunnel-ingress-controller`, already deployed in the
cluster (`deploy/manifests/ingress.yaml`, an ordinary k8s `Ingress`, routing
by `Host: chat-api.fedorov.it` → `Service chat` → pod). This is a standard
Host/path-based L7 router on top of Cloudflare Tunnel — it **cannot** look
into the body of WS messages and isn't designed at all to route based on data
inside an already-established connection. Serving the frontend's static
assets moved to Cloudflare Pages as of July 2026 (S2, see `ingress.yaml`,
`README.md` "S2 Topology") — the backend itself now answers only on
`chat-api.fedorov.it`, for API/WS.

**What actually doesn't break — and this is the key fact for all of Part
1.** `docs/self-hosting.md` §7.2 states this directly: media and chat are
P2P and keep working through a signaling outage. `docs/webrtc-mesh.md` §4
explains the mechanics: the **first** handshake of a pair and any ICE
restart always go through the server, but **any subsequent** renegotiation
of an already-established pair (adding/removing a track, switching cameras)
goes over the data-channel bus directly between the two browsers, bypassing
the server entirely. That means, throughout the whole window from point 5
above:

- already-established mesh pairs keep transmitting video/audio/chat/files —
  they don't need the server for this;
- screen sharing already in progress continues as a media stream (the
  transfer itself is the same mesh pair, the server has nothing to do here);
  the frontend also re-establishes the "sharing" status itself after
  reconnecting (`self-hosting.md` §7.2: "presenter's client automatically
  resumes it");
- the client-side auto-reconnect (`static/room.js`) starts trying
  immediately (the first attempt has no delay), then backs off
  `1s→2s→4s→8s` (repeating at 8s) with a total budget of **120s**
  (`RECONNECT_BACKOFF_MS`, `RECONNECT_TOTAL_BUDGET_MS`) — comfortably
  covering the estimated 35–40s window;
- if the server no longer remembers the room after a restart (no memory
  left), the client restores it itself via `PUT /api/rooms/{roomId}` before
  re-sending `join-room` (`src/main.rs::restore_room`,
  `static/room.js::restoreRoomViaPut`) — but the restored room **does not
  remember** either the lobby/guest-permission settings or who was the
  leader (`leader_token: None`, the first person to join becomes leader) —
  this is the only thing lost on restart besides the signaling itself.

**Conclusion on "how close to seamless is this already".** For already-
established pairs that don't need renegotiation exactly during this window —
subjectively it's almost unnoticeable: a brief "Reconnecting…" banner, media
isn't interrupted. For those trying to enter a room for the first time, or
who suffer a real network drop exactly during this window — the signaling
outage is real and noticeable (~30–40s). What's irrevocably lost on every
deploy isn't the call itself, but the **server-side room settings** (lobby,
guest permissions, who's the leader) — these reset to defaults rather than
surviving the restart.

---

### 1.1 Option — Graceful Drain with a Parallel New Container

**Mechanics.** A new pod comes up alongside the old one; the old one stops
accepting NEW rooms/participants but keeps serving out the already-open ones
(up to `MAX_ROOM_LIFETIME_SECONDS`, default 3h); the proxy switches NEW
traffic to the new pod until the old one empties out or the timeout expires.

**What this adds over the current setup.** It fully removes the "nobody can
enter" window — new participants land on the new pod immediately, while
existing participants ride out their call on the old one.

**Complexity and risks — why this is an order of magnitude harder than it
sounds.** The key problem isn't "bring up a second pod" (that's trivial in
k8s), but **routing by `roomId`**, which the proxy in use physically doesn't
have (see §1.0: `roomId` isn't in the `/ws` URL, it's inside the first
message after the upgrade). For new rooms to land on the new pod while old
ones keep resolving to the old one, you need a **separate WS-aware proxy
layer** that itself terminates `/ws`, reads the first `join-room` frame,
looks at `roomId`, and ONLY THEN decides which backend to proxy the bytes to
— `cloudflare-tunnel-ingress-controller` doesn't do this and isn't meant to.
This is a separate project, not a configuration change:

- you need a table of "which `roomId` was created on which pod" (itself
  new shared state that has to be stored and synchronized somewhere —
  ironically, exactly what the project deliberately opted out of by keeping
  rooms only in the memory of a single process);
- on a drop and reconnect, the client must land on **the same** pod where
  its room was created, not on "whichever is currently active" — meaning even
  the proxy's reconnect logic must know about the room-to-pod binding;
- if you strictly wait for the old pod to empty out naturally, a single
  deploy cycle could stretch out to 3 hours (the call-duration ceiling) —
  acceptable only for infrequent, not frequent, deploys;
- two processes with independent room memory at the same time is exactly
  the split-brain scenario that `replicas: 1` + `Recreate` deliberately
  avoids (see the comment in `deployment.yaml` and `src/state.rs`); a routing
  bug means participants accidentally scattered across two pods who can't
  see each other.

**Estimate:** high complexity, roughly **5–10 person-days** just for the
WS-aware router itself, plus testing the switchover scenarios; split-brain
risk on any routing bug.

---

### 1.2 Option — Blue-Green with roomId Stickiness

**Mechanics.** Two full stacks (blue/green); new rooms go to the active one
("green"), old ones keep running out on the previous one ("blue") until they
empty out or `MAX_ROOM_LIFETIME_SECONDS` expires, then blue is switched off.

**What this adds over the current setup.** The same thing as option 1.1 —
eliminating the "can't enter" window for new participants, just by
duplicating the whole infrastructure instead of coordinating a single stack.

**Complexity and risks.** This is essentially the same as option 1.1: the
necessary building block is the same WS-aware sticky router keyed on
`roomId`, because the problem (the proxy can't see `roomId` before the
upgrade) doesn't depend on whether you call it "graceful drain" or
"blue-green". The differences are purely organizational:

- you don't need to wait for ONE pod to fully empty out before considering
  the deploy "finished" — you can just deploy green and gradually turn off
  blue whenever you see fit (still up to 3h if you want to strictly "leave
  nobody behind");
- the cost is double infrastructure during the overlap (two full
  backends, two DNS/ingress targets) instead of one coordinated stack;
- the same split-brain risks on a routing bug as in 1.1.

**Estimate:** the same order of complexity as 1.1 (**5–10 person-days** for
the router) **+1–2 days** for setting up a parallel full stack (DNS/ingress
for two backends) — overall no cheaper, in places more expensive than 1.1,
for the same unresolved architectural problem.

---

### 1.3 Option — SO_REUSEPORT / Passing the Listening Socket

**Mechanics.** The old and new process briefly listen on the same port at
the same time (`SO_REUSEPORT`, the kernel balances new `SYN`s between them),
or the listening file descriptor is passed directly to the new process
(`systemd` socket activation, `LISTEN_FDS`, a pattern like `tableflip`) — so
there's never a moment when nobody is listening on the port at all.

**How applicable this is to axum/tokio.** Technically applicable and well
documented in the ecosystem — the `socket2` crate can create a socket with
`SO_REUSEPORT` and hand it to `tokio::net::TcpListener::from_std`, or accept
an already-ready fd from `systemd` via `LISTEN_FDS`. There are no
fundamental obstacles on the axum/tokio side.

**What this gives you if state lives in memory anyway — conclusion: almost
nothing in this project.** The key observation from §1.0: the real downtime
here is **not** caused by "a moment when nobody listens on the port" — the
listening socket already closes almost instantly as the pod leaves the
`Service`, long before `terminationGracePeriodSeconds` expires. The real
delay is (a) waiting for `Recreate` to wait for the OLD pod to fully
terminate (up to 30s), and (b) the new one's cold start.
`SO_REUSEPORT`/fd-passing only solves problem (a)-like "gap between closing
the old listener and opening the new one" — and there's almost no such gap
here to begin with (the gap is microseconds, for as long as the process
itself is alive, but `Recreate` waits for the **whole** process anyway, not
just its listener, which kills the benefit of the technique). Even if you
perfect the listener handover, you'd still end up with TWO processes with
incompatible in-memory room maps at the moment of overlap — the same
problem as in 1.1/1.2, just without the payoff that would justify solving it
this particular way.

**Estimate:** a technically simple but **useless on its own** technique here
(it saves fractions of a second in a place where tens of seconds are lost
for an unrelated reason anyway) — it only makes sense as a small addition ON
TOP of the full router from 1.1/1.2, if those are ever built, not as a
standalone solution.

---

### 1.4 Option — State Handoff (Serializing Rooms into a New Process)

**Mechanics.** On `SIGTERM`, the old process serializes the
`HashMap<String, Room>` (or part of it) into the new process (via a
file/socket); the new process deserializes it and continues operating with
the same state.

**An honest assessment — this runs into the fact that the most important
part of `Room` can't be serialized.** `Participant::tx` (`src/state.rs`) is
an `mpsc::UnboundedSender` bound to a specific tokio task of a specific live
TCP connection **inside the owning process**. Neither the channel itself,
nor especially the established TCP/WebSocket connection, can be handed to
another process — this isn't a data-serialization problem, it's migrating an
established network connection, which in general isn't solved without a
dedicated proxy layer in front of the application (one that never itself
restarts) or MPTCP-level technology. So a "state handover" could in reality
only serialize metadata: names, `settings` (lobby/guest permissions),
`leader_id`, `screen_owner`, `created_at` — but not the connections
themselves. The client would still have to re-establish the WS from scratch
via the same `join-room` as today.

**Is it worth it given the existing client-side recovery — no.** The
difference from today's `PUT /api/rooms/{id}` restoration (which also
re-creates the room, just with default settings) is only that the
lobby/guest-permission/leadership settings would survive the restart instead
of resetting. This doesn't shrink the signaling downtime window by a single
second — the reconnect still follows the same path and takes the same time.
The payoff is narrow (preserving room configuration, not availability), and
how often anyone would actually complain about a lobby/leader reset on a
planned deploy (a rare event) is probably low.

**Estimate:** medium complexity (**2–4 person-days** for serializing/
deserializing `Room` without `tx` plus loading it at startup), but **not
recommended** — the cost/benefit isn't justified: it solves not the problem
that actually hurts (signaling downtime), but a different, fairly niche one
(loss of room configuration).

---

### 1.5 Option — Do Nothing Beyond the Current Setup

**Arguments for.** From §1.0: the real outage duration is on the order of
30–40s in the worst case (an active call in progress at deploy time),
noticeably less if there are no active calls. Throughout this whole time,
already-established mesh pairs keep transmitting media/chat/files without
the server's involvement (`webrtc-mesh.md` §4) — signaling is only needed
for (a) new participants, (b) an ICE restart of an already-established pair,
an event that doesn't necessarily coincide with the deploy window. The
client-side auto-reconnect (banner + backoff, 120s budget) fully covers the
estimated window — a user in an ongoing call sees a brief "Reconnecting…"
banner, not a dropped conversation. The deploy frequency for a project of
this scale (a personal/small self-hosted service, deploys gated by green
tests) isn't an event that happens several times a minute, but a rare,
planned action.

**A cheap improvement that requires no architectural changes (worth
considering separately from "do nothing" in its pure form).** The main
contributor to the 30-second window is that the old process does NOT
actively close the already-open WS sockets itself, but simply waits for
`SIGKILL` once the grace period expires (see point 2 in §1.0). Adding an
explicit broadcast of a `Close` frame (with a reason) to all open
connections to `shutdown_signal`, right when `SIGTERM` is received, instead
of passively waiting, would sharply cut this specific component of the
downtime (from ~30s to, probably, a fraction of a second for the broadcast
itself), without any of the split-brain risks that options 1.1–1.4 carry:
this is a single-process change, not coordination between two. It doesn't
remove the "new pod isn't ready yet" window (~5–10s of cold start), but it
removes the artificial wait for the grace period. Estimate: low complexity
(**~0.5–1 person-day**), worth considering INDEPENDENTLY of the final
decision on options 1.1–1.5 — it's a pure improvement with no new failure
modes.

**What's honestly left unresolved.** The ~5–10s cold-start window for the
new pod remains no matter what, as long as `Recreate` is used (see §1.3 —
why `SO_REUSEPORT` doesn't help here without a router). Anyone trying to
enter during exactly these seconds will get `room-not-found`/a timeout and
fall into the same client-side reconnect cycle as usual.

---

### 1.6 Recommendation

> Implemented 2026-07-16 (broadcast `Close` 1012 on `SIGTERM` + ~500ms to flush).

**Keep `Recreate` + the single-process model as they are**, adding the
cheap improvement from §1.5 (actively broadcasting `Close` on `SIGTERM`
instead of passively waiting for `SIGKILL`) — this is the only change out of
everything considered that delivers a measurable win (removing the wait for
the grace period where it's purely artificial today) at zero new risk and
less than a person-day of effort.

Options 1.1/1.2 (the only ones that actually close the "a new participant
can't enter" window) run into the same unresolved architectural question —
`roomId` is invisible to the proxy before the WS upgrade — and require
building a dedicated WS-aware sticky router (**5–10+ person-days**, plus a
new class of split-brain risks), which isn't justified for the project's
current scale (single-replica by design, infrequent deploys, self-healing
clients): the cost of the solution far exceeds the cost of the problem it
solves. Option 1.3 is useless on its own without 1.1/1.2. Option 1.4 solves
the wrong problem (room configuration, not signaling availability).

If the project grows to many simultaneously active rooms and a noticeable
deploy frequency within a day (not today's usage profile) — then, and only
then, does it make sense to come back to 1.1/1.2, because it's precisely the
deploy frequency that multiplies the one-time cost of the 30–40-second
window by the number of deploys per day.

---

## Part 2. Single-Instance Capacity

### 2.1 What a Room/Participant Costs (From the Code)

**Structures (`src/state.rs`).**

- `Participant { tx: PeerTx, name: Option<String>, epub: Option<String>, joined_at: Instant }` —
  `tx` is an `mpsc::UnboundedSender` handle (a few words' worth of pointers
  into a shared queue buffer; the buffer itself grows with the messages
  actually queued, it isn't preallocated); `name` is an encrypted blob up to
  `CHAT_NAME_MAX_CHARS`=512 characters (`src/ws.rs`), in practice noticeably
  shorter (base name + AES-GCM overhead + base64, realistically tens to a
  hundred bytes, not 512); `epub` is up to `EPUB_MAX_CHARS`=200 characters
  (real size ~87 characters, an ephemeral ECDH P-256 key); `joined_at` is an
  `Instant`, 16 bytes. **Estimate for one `Participant`: on the order of
  200–800 bytes** in the typical case (a couple hundred bytes of struct +
  heap allocations for strings), up to ~1–1.2KB in the worst case (name and
  epub at the upper bound of their limits).
- `PendingParticipant` — the same shape, the same order of magnitude; a
  limit of `MAX_PENDING`=10 waiting entrants per room (`src/state.rs`),
  separate from participants.
- `Room { participants: HashMap<...>, screen_owner: Option<String>, emptied_at: Option<Instant>, leader_id: Option<String>, leader_token: Option<String>, settings: RoomSettings, pending: HashMap<...>, created_at: Instant }` —
  the struct's own fields are small (a few `Option<String>`/`Instant`,
  `leader_token` is a UUID string ~36 bytes, `RoomSettings` is a handful of
  boolean flags). The bulk of a room's memory is its `participants`/
  `pending` `HashMap`s, i.e. the sum of the `Participant`s inside them (see
  above) plus the `HashMap`'s own overhead (the key is a `String` peerId,
  UUID ~36 bytes + bucket bookkeeping bytes).

**Estimate for one full room** (6 participants at the default
`DEFAULT_MAX_PARTICIPANTS`, no active lobby): on the order of **6 ×
~0.5–1KB + ~0.3–0.5KB for the `Room` struct/`HashMap` overhead itself ≈
3–6KB per room**. With a full lobby (10 waiting, `MAX_PENDING`) — plus
another ~5–10KB. This is noticeably less than the memory of the WS
connections themselves (below) — room state in this project is cheap almost
by definition: the server only stores identifiers, name blobs, and
timestamps, never media or chat history (`src/state.rs`, module doc comment:
"the chat server doesn't store anything at all").

**Memory per WS connection (server + buffers).** External sources cite a
range of **2–10KB for an idle connection and 10–100KB+ for an active one**
(with a non-empty message queue) for a typical tokio/axum-based WS server —
see [websocket.org][ws-limits]. An important detail specific to this
project: the server itself explicitly caps message/frame size at **64KB**
(`WS_MAX_MESSAGE_SIZE`/`WS_MAX_FRAME_SIZE`, `src/ws.rs`) — this is an upper
bound for the case of an attack, not a typical message size. This protocol's
actual messages are tiny: JSON events `join-room`/`peer-joined`/ping-pong
(tens to hundreds of bytes) and SDP/ICE relaying, capped at **16KB**
(`RELAY_MAX_BYTES`). So, for this specific protocol, realistic per-connection
consumption should sit at the **lower end** of the external range mentioned
(closer to 2–10KB, not 100KB) — this is a conclusion from code analysis, not
an independently measured figure; if an exact number is needed, it's worth
measuring the live process's `RSS` under load (`kubectl top pod` /
`docker stats`) rather than relying solely on this estimate.

**Base process memory.** The independent [Sharkbench][sharkbench] benchmark
gives **~6MB RSS** for a "hello world" on axum/tokio — this project is a bit
heavier (with `hmac`/`sha1`/`base64`/`uuid`/`tracing-subscriber` added, but
not a fundamentally different order of magnitude). The manifest author's own
estimate in `deploy/manifests/deployment.yaml` (`requests: { memory: 32Mi }`,
comment "Rust signaling server is lightweight") is an independent anchor of
the same order of magnitude: the operator already budgets base process
memory in the single-to-tens-of-MB range, not hundreds. **Overall working
estimate of base process memory (without connections/rooms): 10–30MB** — an
estimate, not a measurement; worth confirming with `kubectl top pod` on a
real instance if the figure is needed as a fact rather than a ballpark.

### 2.2 CPU

The server **neither decodes nor stores media** — from a CPU standpoint its
entire job is (a) the periodic heartbeat, (b) short relay bursts during
connection setup/rebuilding, (c) the reaper, (d) rate-limit checks.

- **Heartbeat:** `PING_INTERVAL`=20s per connection (`src/ws.rs`) — with `N`
  open connections that's `N/20` `Ping` frames per second, each a write of a
  few bytes into an already-open socket. Even at `N`=3000 (500 rooms × 6
  participants, the default `MAX_ROOMS` ceiling) that's 150 tiny writes/sec —
  far less than 1% of one core.
- **Connection setup:** from `docs/research-marketing.md` §9 (an internal
  source, the same figures already computed for the "load ≈ 0" marketing
  argument, used here as the basis for the CPU estimate) — one encrypted SDP
  blob is ~2–8KB, an ICE candidate ~0.5–1.5KB; filling a 6-participant room
  — full mesh, 15 pairs — is tens of KB up to a low hundred KB in total, ONE
  TIME ONLY. For every such message the server does: one
  `serde_json::from_str` (parsing), one `HashMap` lookup for the target
  peerId, one `serde_json::to_string` (serializing back), and one `mpsc`
  send — all in memory, with no I/O beyond the socket itself. That's
  microseconds of CPU per message on any modern processor. Even an
  unrealistic "perfect storm" — all 500 rooms filling up with 6 participants
  simultaneously within one second (an extreme case that doesn't occur in
  practice) — is on the order of 500×6×10 ≈ 30 000 tiny messages, i.e. low
  tens of milliseconds of total CPU time, spread out moreover over the real
  time it takes people to physically click links (seconds, not a single
  instant).
- **The rate limit itself bounds any possible burst:** `RELAY_RATE_LIMIT`=100
  messages/10s per connection, and separate per-IP limits on room creation
  (`ROOM_CREATION_IP_LIMIT`=3/60s) and lobby entry (`PENDING_JOIN_IP_LIMIT`=10/60s,
  `src/state.rs`) — a malicious or accidental burst from a single
  connection/IP hits these ceilings before it becomes noticeable to
  the CPU.
- **Reaper:** one tick/sec, a linear pass over the room map with no
  `.await` inside the lock (`state::reap_rooms`) — trivial at a scale of
  hundreds of entries.
- **TLS isn't on this process:** TLS termination happens at the Cloudflare
  Tunnel/reverse proxy in front of the server (`docs/self-hosting.md` §3),
  not in the Rust process itself — meaning the CPU cost typical of web
  servers for a TLS handshake on a new connection (external sources cite a
  typical ceiling on the order of **1000–3000 handshakes/sec per core**, see
  [websocket.org][ws-limits]) doesn't apply here at all — the `/ws` upgrade
  on this process is a plain HTTP `Upgrade`, with no cryptography.

**Conclusion: CPU practically never becomes the bottleneck** at any
realistic instance size — the ceiling is set by per-connection memory and
operator-configured limits (`MAX_ROOMS`/`MAX_PARTICIPANTS`), not by
"computation".

### 2.3 Ports and File Descriptors

**Debunking the common misconception that "ports will run out".** The
server has **one** listening port (`PORT`, default 3000 outside the
container / 8080 inside — `docs/self-hosting.md` §6), bound exactly once for
the entire lifetime of the process (`tokio::net::TcpListener::bind`,
`src/main.rs`). This port is never "consumed" by client connections — no
matter how many clients connect, there's still exactly one listening port.
Each accepted WS connection is a separate **file descriptor** (an accepted
socket, identified by the pair `(server_ip:server_port,
client_ip:client_port)`), not a separate port on the server: what's actually
limited to roughly ~64K is the range of **client-side** ephemeral ports, and
it isn't a bottleneck here, because each client opens one or two connections
to the server, not tens of thousands.

**The server has no outbound connections at all.** No database, no
external API, no HTTP client to anything — per `Cargo.toml`, there isn't a
single HTTP/DB client crate among the dependencies, only server-side ones
(`axum`, `tokio`, `uuid`, `hmac`/`sha1`/`base64` for TURN credentials — pure
computation, not network calls). So the process can, in principle, never run
out of its **own outbound** ephemeral ports — a problem that genuinely
occurs for proxy services/services making outbound calls to a backend, but
that structurally doesn't apply here.

**The real limiter is the process's `ulimit -n` / `LimitNOFILE`.** Modern
`containerd`/`systemd` defaults, per web search, are usually **1 048 576**
([devopsbeast/moby issue][fd-limits]), but old or non-standard systems
sometimes inherit the historical default of **1024** — this is **not
confirmed for this project's specific server (KubeSolo)** and is worth
explicitly checking (`cat /proc/<pid>/limits` inside the pod) rather than
assuming. If the limit turns out to be at the lower bound (1024), that would
cap the server at a maximum of ~1000 simultaneous connections (~166 rooms of
6 participants) — i.e. **below** the default `MAX_ROOMS=500` (which, fully
filled, would produce 3000 connections). This is a cheap check with a cheap
fix (an explicit `ulimit`/`securityContext` in the manifest) if `MAX_ROOMS`
ever needs to go above a few hundred rooms.

**In practice, with default settings, the limiter isn't FDs but `MAX_ROOMS`
itself.** 500 rooms × 6 participants = 3000 FDs in the worst case —
comfortably below even the pessimistic FD limit of 1024 (if it does turn out
that low, the threshold would kick in even before `MAX_ROOMS`; if the limit
is the modern default of a million, `MAX_ROOMS` remains the only real
ceiling).

### 2.4 Network

From §2.2 and `docs/research-marketing.md` §9: a one-time burst for filling
a single six-seat room is **tens of KB, in the worst case a low hundred
KB**, ONE TIME ONLY, on entry. The heartbeat is a couple of bytes of
`Ping`/`Pong` per connection every 20s: at 3000 connections that's ~150 tiny
frames/sec — the aggregate heartbeat traffic is vanishingly small (noticeably
less than 1KB/s in aggregate). The server's overall network profile consists
almost entirely of short pulses as participants join, not a continuous
stream — even the unrealistic scenario of "all 500 rooms filling up at
once" gives an upper bound of roughly 500×100KB = 50MB, spread over the real
time it takes people to click links, not as a genuine instantaneous spike —
achievable even on the cheapest VPS plan with a hundred Mbit/s.

### 2.5 Summary Table by Instance Size

Estimates are based on sections 2.1–2.4, with explicitly stated
assumptions: ~10–30MB base process, ~2–10KB per WS connection (the lower
part of the external range — the rationale is in §2.1), ~3–6KB for a full
6-seat room on top of the cost of its participants' connections themselves.

| Instance size | Memory available for rooms (after process base + ~20–30MB OS/k8s overhead) | Theoretical memory ceiling (participants) | Real bottleneck at defaults | Recommended `MAX_ROOMS` |
|---|---|---|---|---|
| 1 vCPU / 512MB | ≈480MB | ~48 000 participants (~8000 rooms of 6) | **`MAX_ROOMS`=500 (DoS limit), not memory/CPU** — at the default, <1% of available memory for connections is used; the FD limit needs to be checked if the ceiling is ever raised above a couple thousand connections | keep the default **500**; raise only after checking `ulimit -n` on the host |
| 1 vCPU / 1GB | ≈980MB | ~98 000 participants | Same conclusion — memory/CPU aren't engaged anywhere near their limit; if a "busier" instance is desired, this is the size where raising `MAX_ROOMS` starts to make sense | can be raised to **1000–2000** if a more populated public instance is needed — still far from physical limits, the limiter shifts to FD/ulimit and to how many simultaneous join bursts are considered acceptable |
| 2 vCPU / 4GB | ≈4000MB | ~400 000 participants | The CPU headroom (2 cores) adds resilience to churn (simultaneous connects/reconnects), but for this protocol churn isn't about TLS handshakes (TLS isn't on this process, see §2.2) — the practical ceiling here again isn't memory/CPU but the FD limit and the operator's willingness to hold that many rooms at once | can be raised to several thousand if a real use case appears (a busy public instance) — but re-check `LimitNOFILE` beforehand, it'll become the first real limiter |

### 2.6 Recommendation for MAX_ROOMS

The section's main conclusion: **across all three practical instance sizes,
the real limiter under default settings remains `MAX_ROOMS` itself (a
deliberate DoS limit, `DEFAULT_MAX_ROOMS`=500, `src/state.rs`), not a
physical shortage of memory, CPU, ports, or network** — the memory headroom
on even the cheapest plan considered (1 vCPU/512MB) exceeds by orders of
magnitude what the default configuration needs. Practical recommendation:

- For a personal/small self-hosted instance (the typical case for this
  project) — **keep the default of 500** on any of the three sizes: it was
  already chosen not because of resource constraints but as a conservative
  defense against flooding (H2, `docs/security.md` §4), and raising it
  without a real need brings no benefit.
- If there's a concrete reason to hold more rooms simultaneously (a busy
  public instance) — first check `ulimit -n`/`LimitNOFILE` inside the
  actually running pod (this is the one figure from section 2.3 not
  confirmed for the specific server), then raise `MAX_ROOMS` gradually,
  guided by actual memory usage (`kubectl top pod`), not by the estimates in
  this document.

### 2.7 Precise Memory Calculation: 10 / 100 / 1 000 / 1 000 000 Rooms × 3 Participants

Unlike §2.1 (an engineering back-of-the-envelope estimate), here structural
memory is measured, not eyeballed: a separate Rust binary (outside this
repository) was built with FULL copies of the `Participant`/
`PendingParticipant`/`Room` fields from `src/state.rs` (the same types:
`mpsc::UnboundedSender<T>`, `Option<String>`, `std::time::Instant`,
`std::collections::HashMap` — the same hashbrown as in prod, since Rust
1.36), under a global allocator wrapper that calls glibc
`malloc_usable_size` on every `alloc`/`dealloc` — i.e. it counts the bytes
the allocator ACTUALLY handed out (rounded to a size class), not the
declared `Layout::size()`. Built and run in `rust:slim-bookworm`
(`--platform linux/amd64`) — the same distro/glibc family as
`gcr.io/distroless/cc-debian12`, which the prod image is built on
(`Dockerfile`), so the allocator's behavior is representative of the real
deploy. `peerId` was generated literally as `generate_peer_id()`
(`Uuid::new_v4().to_string()`), `roomId` as `generate_room_id()` (8
characters from the same alphabet), `epub` as a string 87 characters long
(the real length of an ECDH P-256 base64url key, see `src/ws.rs`,
`EPUB_MAX_CHARS`=200 — capped well above the real size). Below are the
results of this run (not hypothetical, but actually measured numbers); where
a figure is not measured but external/reference (socket WS buffers), this is
explicitly marked.

**1) Exact type sizes (`std::mem::size_of`, x86_64 Linux/glibc, measured):**

| Type | Size | Comment |
|---|---|---|
| `String` | 24 bytes | ptr+len+cap, as expected (3 machine words) |
| `Option<String>` | 24 bytes | **no overhead** — the compiler uses niche optimization (`String`'s non-null pointer gives a free bit pattern for `None`), no extra tag |
| `Instant` | 16 bytes | on Linux — essentially a `timespec` (sec+nsec, 2×i64) |
| `Option<Instant>` | 16 bytes | also no overhead — the same niche trick applies here too on this platform (not an ABI guarantee across all targets, but a fact for x86_64 Linux) |
| `RoomSettings` (5×`bool`) | 5 bytes | `bool` align=1, no padding |
| `mpsc::UnboundedSender<T>` (`PeerTx`) | **8 bytes, ALWAYS** | verified for `T`=a 1-byte enum and `T`=a 4096-byte enum — the size is identical (8 bytes) in both cases: `Sender` is a thin pointer to a shared `Arc`-like `Chan`, its size does NOT depend on the size/type of the messages carried |
| `Participant` / `PendingParticipant` | 72 bytes | `tx`(8)+`name: Option<String>`(24)+`epub: Option<String>`(24)+`joined_at: Instant`(16) — no padding, exactly the sum of the fields |
| `Room` | 208 bytes | `participants` map(48)+`screen_owner`(24)+`emptied_at`(16)+`leader_id`(24)+`leader_token`(24)+`settings`(8 with padding)+`pending` map(48)+`created_at`(16) |
| `HashMap<K,V>` (empty, header only) | 48 bytes | the `RawTable`/pointers themselves, with not a single bucket — hashbrown allocates buckets lazily, on first insert |

**2) Real heap allocations for strings (measured via `malloc_usable_size`, including rounding to the allocator's size class):**

| String | Requested (chars/bytes) | Actually given by glibc | Allocator overhead |
|---|---|---|---|
| `roomId` (8 chars, `generate_room_id()`) | 8 | **24 bytes** | glibc's "floor": the minimum usable chunk size on x86_64 is ≈24 bytes (min chunk 32B minus 8B header) — for ANY string this small, it can't get any smaller, even if only 1 byte is actually needed |
| `peerId` (36-char UUID, `Uuid::new_v4().to_string()`) | 36 | **40 bytes** | (36+8)/16→3×16=48, 48-8=40 — glibc's typical rounding formula for this range |
| `epub` (87-char base64url ECDH key) | 87 | **88 bytes** | (87+8)/16→6×16=96, 96-8=88 |
| encrypted `name` blob (~48 chars, realistic size: iv 12B+ciphertext+tag 16B in base64) | 48 | **56 bytes** | (48+8)/16→4×16=64, 64-8=56 |

**3) One `Participant` in full, the realistic current protocol (v2: the
client always sends `name=null` in `join-room` — the server merely keeps
the field for backward compatibility with old clients, see the doc comment
in `src/protocol.rs` above `ClientMessage::JoinRoom`/`ServerMessage::PeerJoined`;
`epub` is present):**

- `sizeof(Participant)` (embedded in the `HashMap` slot, no separate allocation) = **72 bytes**
- `epub` heap = **88 bytes**
- `name` = `None` ⇒ **0 bytes heap** (a legacy client with a real name would
  add another ~56 bytes, see the table above)
- **Total for one `Participant` (v2, has `epub`, no `name`): 72 (struct) +
  88 (epub) = 160 bytes**, plus the `peerId` key in the map (40 bytes heap +
  24 bytes `String` header = 64 bytes) — meaning **one `(peerId →
  Participant)` entry in the HashMap ≈ 224 "raw" bytes** before the hash
  table's own overhead.

**4) `HashMap<String, Participant>` with 3 real entries (a full run: 3
`mpsc::unbounded_channel` channels + 3 `String` keys + 3 `epub` strings +
the hashbrown table itself) — measured as a whole: 2.45 KiB** (≈836
bytes/participant, meaning the hash table's own overhead plus the channel
add roughly 600 more bytes per entry on top of the "raw" 224 bytes). The main
contributor to those ~600 bytes isn't hashbrown itself (for 3 entries it has
at most ≤8 buckets of 1 control byte each — a handful of bytes; hashbrown's
maximum load factor is 7/8, [rounded to a power of two][hashbrown-lf]), but
the `tokio::sync::mpsc` channel's own internal allocation (the message-queue
block + semaphore + Receiver-side bookkeeping fields) — it's created once
per connection regardless of how many times the `Sender` is cloned, and this
is NOT a structure of our own code, but the cost of the tokio primitive that
our code has to pay for the mere fact that "one connection = one channel".

**5) A whole `Room` with 3 participants (our code's structural memory,
including `leader_id`, an empty `pending`, default `settings`) — measured as
a whole: 2.45 KiB** — matching (within rounding) the plain participant map
from point 4: `Room`'s remaining fields (`screen_owner=None`,
`leader_token=None` — the token is already burned by the time a call has
settled, `pending` — an empty map, `settings` — 5 bytes, no heap) add
essentially nothing on top for a typical 3-seat call.

**6) Scale measurement — NOT an extrapolation, but a literal run of N real
`Room`s inside a `HashMap<String, Room>` (the actual global `SharedRooms`):**

| N rooms | Connections (×3) | Structural memory (measured) | Bytes/room | Bytes/participant |
|---|---|---|---|---|
| 10 | 30 | 29.13 KiB | ~2 983 | ~994 |
| 100 | 300 | 282.45 KiB | ~2 892 | ~964 |
| 1 000 | 3 000 | 2.913 MiB | ~3 054 | ~1 018 |
| 10 000 | 30 000 | 27.99 MiB | ~2 935 | ~978 |
| 100 000 | 300 000 | 271.6 MiB | ~2 848 | ~949 |
| **1 000 000** | **3 000 000** | **2.586 GiB** | **~2 777** | **~926** |

The bytes/room figure stabilizes in a narrow band of **~2.8–3.1 KB/room
(~0.9–1.0 KB/participant)** across all orders of magnitude — growth from 10
to 1 000 000 rooms is linear, with no surprises like hashbrown degrading on
large tables.

**7) WS overhead (socket/tungstenite-tokio buffers per connection) is an
EXTERNAL figure, not measured in this run: it reuses the 2–10KB/idle
connection estimate already made in §2.1** (the lower part of the range
[websocket.org][ws-limits], the rationale for why the lower bound is more
realistic for THIS protocol is there too). As in §2.1: this is **an order of
magnitude larger than the structural memory per connection** (0.9–1KB of
structures versus 2–10KB of WS buffers) — meaning even here, with an exact
measurement of the structures, what dominates isn't this project's code but
the plain fact of holding an open TCP/WS socket.

**Summary table (structural memory — measured; WS overhead — external
estimate from §2.1; process base — a measured prod peak at near-zero load:
`working_set` 2.34 MiB / RSS 1.41 MiB, used as the lower anchor):**

| Rooms × 3 | Connections | Structural memory (measured) | + WS overhead (2–10KB×connections) | = Total without base | + process base (~2.34 MiB) | Total |
|---|---|---|---|---|---|---|
| 10 | 30 | 0.028 MiB | 0.06–0.29 MiB | 0.09–0.32 MiB | +2.34 MiB | **≈2.4–2.7 MiB** |
| 100 | 300 | 0.28 MiB | 0.59–2.93 MiB | 0.86–3.21 MiB | +2.34 MiB | **≈3.2–5.6 MiB** |
| 1 000 | 3 000 | 2.91 MiB | 5.86–29.30 MiB | 8.77–32.21 MiB | +2.34 MiB | **≈11.1–34.6 MiB** |
| **1 000 000** | **3 000 000** | **2.586 GiB** | **5.72–28.61 GiB** | **8.31–31.19 GiB** | +0.002 GiB (negligible) | **≈8.3–31.2 GiB** |

Notes on the table:

- **1 000 rooms already doubles `DEFAULT_MAX_ROOMS`=500** — with default
  settings the server will return `503` when creating the 501st room, long
  before memory even becomes a question (this is the same conclusion as in
  §2.6, just explicitly demonstrated here on a concrete figure from the
  problem statement).
- The measured process base (2.34 MiB working_set / 1.41 MiB RSS, a prod
  peak at near-zero load) is noticeably **smaller** than the "10–30MB"
  estimate in §2.1 — that estimate was built on external reference points
  (the Sharkbench benchmark, `requests: 32Mi` in the manifest) and turned
  out to be conservative; the real process is lighter. This isn't a
  contradiction but a refinement: §2.1 is deliberately left unrewritten (it
  was already marked as "an estimate, not a fact"), and this section
  provides a more precise lower anchor where one is available.
- Already at 1 000 rooms, structural memory (2.91 MiB) is **comparable to
  the process base itself** (2.34 MiB) — meaning at this scale the code's
  structures first become noticeable against the base, but are still
  smaller than the WS overhead.

**The main conclusion for 1 000 000 rooms: the bottleneck is NOT structural
memory.** 2.586 GiB of measured structural memory plus 5.7–28.6 GiB of WS
buffers give **~8.3–31.2 GiB in total** — this fits within the memory of one
large machine (tens of GB of RAM isn't exotic for a dedicated server),
meaning there's a chance memory itself could "just be bought". But in
reality you'd never get there, for three independent reasons, all stemming
from this project's code/configuration, not from abstract limits:

1. **File descriptors.** 3 000 000 simultaneous connections means
   3 000 000 FDs for the process. Even the generous modern default
   `LimitNOFILE`=1 048 576 ([fd-limits], already cited in §2.3) is **three
   times less** than what's needed — an explicit, specially raised ulimit
   far beyond typical defaults is required, it's not a case of "a modern
   system will just handle it".
2. **The reaper and a single global `Mutex`.** `state::reap_rooms`
   (`src/state.rs`) does a **linear pass over the ENTIRE**
   `HashMap<String, Room>` (`HashMap::retain`) once every
   `REAPER_INTERVAL`=1 second, under the very same `std::sync::Mutex` that
   also guards `join-room`/`leave`/relaying — at 1 000 000 entries (and
   3 000 000 nested participants, which the reaper also walks through for
   each room when checking whether it's empty), this is no longer a
   "negligibly cheap check" the way it is for hundreds of rooms (see its own
   doc comment and §2.2), but a full pass over a multi-million-entry data
   structure **every second**, holding the single lock that synchronizes
   literally everything else — a new, qualitatively different source of
   latency/contention that doesn't exist at the scale the server was
   written for (`DEFAULT_MAX_ROOMS`=500, "a handful of rooms" — see the doc
   comment of the `state.rs` module).
3. **`MAX_ROOMS` and the single-process model.** `DEFAULT_MAX_ROOMS`=500
   cuts all of this off 3 orders of magnitude before the question of memory
   even has a chance to come up — this is a deliberate DoS limit (§2.6), not
   a forgotten setting. And even if it were raised — the entire state lives
   in the `Arc<Mutex<HashMap>>` of ONE process (`SharedRooms`), and Part 1 of
   this document (§1.6) explicitly calls the current architecture
   "single-replica by design": there is no horizontal sharding of rooms
   across multiple instances. 1 000 000 rooms on one process isn't a
   question of "give it more RAM", but a question of **a different
   architecture** (sharding/clustering), which this project doesn't have and
   which this document doesn't design.

In short: the structures (`Participant`/`Room`/`HashMap`) are measurably
cheap (a few KB per room at any scale); the WS connection buffers dominate
them by an order of magnitude; and the real ceiling at 1 000 000 rooms is
the FD limit, the reaper's cost on the single lock, and `MAX_ROOMS` itself —
not a shortage of memory as such.

---

### 2.8 The Weakest Point of the CURRENT Server (Resource-Wise)

Measured characteristics of the current prod node (`contabo3858312`,
kubesolo, one node/one replica, 2026-07-16):

| Resource | Value | Headroom |
|---|---|---|
| CPU | 4 vCPU (amd64) | chat peak 24m = **0.6% of one core** |
| RAM | 7.9 GiB | chat peak 2.3 MiB working set — 3 orders of magnitude lower |
| FD (`nofile` for containers) | ~1 073 741 816 (≈1 billion) | not the 1024 default — generously configured; **not a bottleneck here** |
| `fs.file-max` | practically unlimited (2^63) | — |
| `net.core.somaxconn` | 4096 | accept queue; matters only under a burst of simultaneous connects |

The conclusion that matters more than all the figures from §2.1–2.7: **on
this server, the weakest point isn't the hardware, it's the single global
state lock.** All rooms live in an `Arc<Mutex<HashMap<String, Room>>>`
(`src/main.rs:203`, `std::sync::Mutex` — not even a `RwLock`). The same lock
is taken by:

- every relay of `offer`/`answer`/`ice-candidate`/`stream-info`/`name-announce`
  (`src/ws.rs`),
- every `join-room`/`approve`/`reject`, `POST`/`PUT /api/rooms`
  (`src/main.rs:348,434`),
- **the reaper — once a second, in a full pass over the entire room map**
  (`src/state.rs:218-222`, `REAPER_INTERVAL=1s`, `rooms.lock().unwrap()`).

Consequences as load grows (while RAM/FD/network are still bottomless):

1. **The lock serializes all signaling.** No matter how many cores there
   are (4 here), relay throughput is bounded by how fast **one** core can
   run through the critical sections in sequence. This is the theoretical
   weakest link: under a burst of connection setups/renegotiations,
   throughput is limited by the lock, not by the sum of the cores. CPU
   graphs, meanwhile, will show ~1 busy core out of 4 — the rest sit idle
   not from a lack of work, but from waiting on the lock.
2. **The reaper is a contention amplifier.** Its `O(rooms)` pass under the
   same lock, once a second, is still unnoticeable at hundreds-to-thousands
   of rooms (microseconds), but grows linearly, and at tens-to-hundreds of
   thousands of rooms it starts periodically "freezing" the entire relay for
   the duration of the pass, every second — sooner than RAM runs out.
3. **`somaxconn=4096`** — secondary: on a burst of >4096 simultaneously
   handshaking TCP connections (not already established, but exactly at the
   handshake moment), the excess gets rejected by the kernel before accept.
   Unreachable for legitimate traffic, but relevant as a burst vector.

The order of exhaustion on this hardware (4 vCPU / 8 GiB / generous FD):
**first, contention on the global `Mutex` (effectively a single-core ceiling
on signaling) → then the cost of the reaper on that same lock → and only
after that, way past `MAX_ROOMS=500`, RAM (~1 million connections, see
§2.7).** FDs and the network won't become a bottleneck on this node at any
realistic number of rooms.

What would unblock this (if it were ever needed — right now it isn't, the
load is negligible): sharding the room map into N independent `Mutex`es by a
hash of `roomId` (the classic sharded-map approach, which removes global
serialization almost for free), and/or a reaper working off a separate
deadline index instead of a full scan under the shared lock. Both changes
are "for the future" optimizations; at the current 0.6% of a core and
2.3 MiB, this is a purely theoretical ceiling, not a problem.

---

### 2.9 FD Limits in Practice and the Ceiling After Tuning (Measured 2026-07-16)

I checked the server process's real limits in prod (via the host, bypassing
the distroless pod — `crictl inspect` → `/proc/<pid>/limits`):

| Level | Limit | Conclusion |
|---|---|---|
| Chat process in the pod (`nofile` soft=hard) | **1 073 741 816** (~1 billion) | FDs are already, in practice, unbounded |
| FDs open right now | 129 | out of a billion |
| containerd `LimitNOFILE` | 1 073 741 816 | the pod inherits it — hence the billion in the pod |
| Node `fs.file-max` | 9.2×10^18 (2^63) | no system-wide ceiling |
| Node `fs.nr_open` | 1 073 741 816 | the upper bound per process |
| `fs.file-nr` (currently in use) | 4000 | whole node |
| `net.core.somaxconn` | 4096 | accept queue — moderate, tunable |
| `net.ipv4.tcp_max_syn_backlog` | 512 | SYN queue — low, tunable |
| `ip_local_port_range` | 32768–60999 | **irrelevant to the server**: it only accepts inbound connections on ONE port and makes no outbound ones — "running out of ports" doesn't concern it (§2.3) |
| Node RAM | 7.9 GiB (currently ~4.3 free, the rest is prometheus/other pods) | |
| CPU | 4 vCPU | |

**The main conclusion on FDs: there's nothing to tune — it's already
cranked to the max** (both containerd and the node give ~1 billion, 129 in
use). The only thing worth tuning at the network level is the accept queues
for burst arrivals: `somaxconn` 4096 → 65535 and `tcp_max_syn_backlog` 512 →
8192 (a one-line sysctl change; protects against dropped connections when
many thousands of clients connect at once, but doesn't affect holding
already-established ones).

#### How Much Can Be Held After Tuning — on THIS Hardware (4 vCPU / 8 GiB)

FDs are removed from the equation (effectively infinite), `MAX_ROOMS` is
just an env var that can be raised to any number. What remains are **two
different ceilings**, and they must not be conflated:

**(A) Statically holding already-established connections — bounded by RAM.**
The cost of one idle WS ≈ structure (~1 KB, §2.7) + tokio/tungstenite
buffers (~4–16 KB, estimate from §2.1). If chat is given ~4 GiB (actually
free right now) or ~7 GiB (if the node is chat-only):

| RAM budget for chat | At 8 KB/connection | At 16 KB/connection |
|---|---|---|
| 4 GiB | ~500 000 connections ≈ **~165 000 rooms ×3** | ~260 000 ≈ ~85 000 rooms |
| 7 GiB | ~900 000 connections ≈ **~300 000 rooms ×3** | ~450 000 ≈ ~150 000 rooms |

So, memory-wise, on this box, **hundreds of thousands of simultaneous
participants** are realistic (tens to hundreds of thousands of 3-person
rooms), provided the calls are already established and signaling is quiet.

**(B) Setup/renegotiation speed — bounded by the global `Mutex` (§2.8), not
by RAM.** All join/leave/relay operations are serialized by one lock onto
one core. So figure (A) is only reachable if connections are held for a long
time and generate almost no signaling after setup (a typical call is exactly
like that: a burst of SDP/ICE in the first seconds, then silence). Under
high churn (constant joins/leaves), the real ceiling is the **lock's
throughput in joins/sec**, and it will be hit far sooner than RAM: 4 cores
don't help here, effectively only one is doing the work.

**Practical bottom line:** after tuning (`somaxconn`/`syn_backlog` up,
`MAX_ROOMS` up — no need to touch FDs), this server would hold **roughly
100 000–300 000 simultaneous participants in established calls** (tens to
hundreds of thousands of 3-person rooms), limited by memory. But the
sustainable rate of *new* connections is limited by the single lock (§2.8)
— if the goal is specifically high churn load, room-map sharding (§2.8) is
needed first, not buying more RAM/cores. For the current real load (peak
2.3 MiB / 0.6% of a core, section above), both ceilings are unreachably far
away.

---

### 2.10 Pod Open Ports and Whether UDP Is Needed (Measured 2026-07-16)

I checked the real listening sockets (the pod's netns via `nsenter`, k8s
configs, the host firewall via `nft`):

**The chat server itself (the `screenshare` binary) listens ONLY on TCP
8080. Not a single UDP port.** It's a pure signaling relay over WebSocket on
top of TCP — it has no UDP ports and never had any. So "the many UDP ports I
had opened" are **not about chat** at all, but about a separate component.

**UDP is held by a separate `turn-server`** (namespace `turn`, image
`ghcr.io/mycrl/turn-server`, `hostNetwork=true`). The host firewall (`nft`)
opens the following for it:

| UDP port(s) | Who | Purpose |
|---|---|---|
| 3478 | turn-server | STUN/TURN control — "NAT punch-through" in its pure form |
| **49160–49999** (840 ports) | turn-server relay | TURN **relay** allocations (from `turn-config`: `port-range="49160..49999"`, `realm=fedorov.it`) |
| 51820 | WireGuard | VPN, unrelated to chat — a separate setup |

**Are they needed — yes, chat actively uses them.** The prod endpoint
`GET https://chat-api.fedorov.it/config` really does hand clients:
```
stun:stun.l.google.com:19302            (public STUN, fallback)
turn:chat-udp.fedorov.it:3478           (own TURN, HMAC-credential)
```
So every client gets this TURN server as an ICE fallback.

**But this is exactly the fork in the road that conflicts with the "server
only punches through NAT" principle:**
- **STUN (3478)** — this is exactly "punching through NAT": the server
  helps clients discover their external addresses, media does NOT flow
  through it. Cheap, fully in the spirit of the project's philosophy,
  covers ~80–90% of networks. Keep unconditionally.
- **TURN relay (49160–49999)** — this is no longer punching through NAT,
  it's **pumping media through your server** for that ~10–20% of cases
  (symmetric NAT, strict corporate/mobile networks) where direct P2P is
  fundamentally impossible. Without it, such calls simply **won't connect at
  all**. This is a deliberate trade-off: reliability for a minority of
  networks versus "the server relays nothing".

Privacy doesn't suffer here: even through TURN, media stays DTLS-encrypted
end-to-end (see `docs/privacy.md` — TURN carries opaque bytes and can't read
them). The cost of TURN relay is **VPS traffic** (relayed video goes through
the server's link, unlike P2P), and that's the only thing that really
"costs" anything on these 840 ports.

**Verdict on the UDP ports:**
1. **3478 (STUN)** — keep it, this is exactly "NAT punch-through", it
   doesn't touch media.
2. **49160–49999 (TURN relay)** — needed AS LONG AS a fallback for
   symmetric NAT is needed. If the server's role is strictly minimized to
   "punch-through only" and it's acceptable that ~10–20% of calls on
   awkward networks won't connect — this range and the entire turn-server
   can be removed, leaving only STUN. This is a product decision
   (reliability vs. purity of principle), not a technical necessity.
3. The range is **excessively wide for the current load**: 840 UDP ports =
   hundreds of simultaneous relay sessions. At current traffic, ~50–100
   ports would suffice (e.g. `49160..49260`); narrowing it is safe if less
   open surface is desired — but it's not urgent either.
4. **51820 (WireGuard)** — unrelated to chat, to be decided separately.

Important not to conflate: narrowing/closing these ports is about the
**turn-server**, not the chat server (which has no UDP at all). Chat won't
break if TURN is closed — only connectivity on difficult networks will
degrade (clients will fall back to STUN-only and direct P2P).

---

## Sources

Internal (this repository, current as of the research date):
`docs/self-hosting.md`, `docs/webrtc-mesh.md`, `docs/signaling-protocol.md`,
`docs/research-marketing.md` §9, `docs/security.md`, `src/main.rs`,
`src/ws.rs`, `src/state.rs`, `static/room.js`, `Cargo.toml`,
`.github/workflows/deploy-prod.yml`, `deploy/README.md`,
`deploy/manifests/deployment.yaml`, `deploy/manifests/ingress.yaml`,
`deploy/manifests/service.yaml`.

External (web search, July 2026):

- [ws-limits] [WebSocket Connection Limits: The Real Bottlenecks](https://websocket.org/guides/connection-limits/) —
  2–10KB per idle connection, 10–100KB+ per active one; FD limits,
  `somaxconn`, TLS handshakes/sec per core.
- [sharkbench] [Axum Benchmark — Sharkbench](https://sharkbench.dev/web/rust-axum) —
  ~6MB RSS for a minimal axum/tokio server.
- [fd-limits] [Default per-container ulimits are too generous · moby/moby #38814](https://github.com/moby/moby/issues/38814);
  general data on modern `containerd`/`systemd` `LimitNOFILE` defaults.
- General information about the overhead of a tokio task (tens to hundreds
  of bytes per task, versus megabytes of stack for an OS thread) — from the
  documentation and common sources in the tokio ecosystem, used as a
  qualitative, not quantitative, argument in §2.1/2.2.
- [hashbrown-lf] [`hashbrown::raw::RawTable`](https://rust-lang.github.io/hashbrown/hashbrown/raw/struct.RawTable.html) —
  maximum load factor 7/8, table size is a power of two; used in §2.7 as an
  explanation (not a measurement — that section has its own measurement, via
  `malloc_usable_size`) of why hash-table overhead is small relative to the
  `tokio::sync::mpsc` channel's overhead per entry.
- §2.7 (the precise memory calculation) is NOT a web source, but this
  research's own measurement: a separate Rust binary with copies of the
  `src/state.rs` types under a glibc `malloc_usable_size`-instrumented
  allocator, built and run in `rust:slim-bookworm --platform linux/amd64`
  (the same glibc family as the prod image `gcr.io/distroless/cc-debian12`,
  see `Dockerfile`).
</content>
