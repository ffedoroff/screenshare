# Design Record: Embedding TURN Into the Chat Binary

> Status: implemented (`embedded-turn` Cargo feature, off by default). This
> is a design record, not a live proposal — it exists to keep the reasoning
> behind the decision (and its alternatives) findable in one place, next to
> the code it explains. See [`self-hosting.md` §5.2](self-hosting.md#52-embedded-turn-single-binary)
> for the operator-facing how-to; this document is the "why," not the
> "how."

## 1. The Question

This project's own production instance runs **split**: the chat signaling
server (this repo, Rust/axum) and a TURN relay
([`turn-rs`](https://github.com/mycrl/turn-rs), upstream `mycrl/turn-rs`)
as two separate deployments (see
[`../deploy/manifests/turn.yaml`](../deploy/manifests/turn.yaml)). That's
the right shape for a real deployment: independent restart/scaling/failure
domains, a dedicated TURN config surface, no reason to couple the two.

Self-hosting is a different audience. Someone spinning this project up on a
single VPS for their own small group doesn't want to run, configure, and
keep alive two separate long-running services (and reverse-engineer how
their secrets need to line up) just to get a working TURN fallback for
participants behind restrictive NATs. The question this record answers:
**should the two servers be merged for that audience, and if so, how?**

## 2. Options Considered

1. **Do nothing — split only, self-host operators run their own TURN
   server (or none).** The status quo before this feature. Cheapest to
   maintain, but pushes real operational work (running, securing, and
   keeping two services' shared secrets in sync) onto exactly the audience
   least equipped to want that — self-host operators optimizing for
   simplicity.
2. **Process supervisor in one container** (e.g. `s6-overlay`,
   `supervisord`, a shell entrypoint that backgrounds both binaries). Keeps
   turn-rs as a wholly separate process/binary, just packaged into one
   container image. Rejected: still two separate metrics endpoints/formats
   to reconcile (turn-rs's own Prometheus exporter vs. this project's), two
   independent processes whose logs interleave without correlation, and a
   supervisor layer to maintain that buys nothing over just running two
   containers (which self-host operators can already do with
   `docker-compose.yml` + `deploy/manifests/turn.yaml`-equivalent). It
   doesn't actually reduce operational surface, just visually packs it into
   one image.
3. **Embed turn-rs as a library, in-process** (the option taken). Since
   `turn-rs` is itself a Rust crate exposing a programmatic
   `turn_server::start_server(Config)` entry point (not just a CLI
   binary), it can be pulled in as a dependency and spawned as a background
   `tokio` task inside this project's own `main()` — see
   [`../src/embedded_turn.rs`](../src/embedded_turn.rs). One binary, one
   container, one process tree, one set of logs, one `/metrics`. Chosen
   because it's the only option that actually collapses the operational
   surface rather than relocating it.

Option 3 was made **strictly additive and opt-in**: an off-by-default
Cargo feature (`embedded-turn`, gating both the `mod embedded_turn;` in
[`../src/main.rs`](../src/main.rs) and the `turn-server` dependency itself
in [`../Cargo.toml`](../Cargo.toml)). The default, split-production build
never compiles the fork's code in at all and never pulls its dependency
tree (`aws-lc-rs` and friends) into the binary. This preserves the split
topology as the unchanged default and recommended production setup — see
[`self-hosting.md` §5](self-hosting.md#5-turn-optional) — while giving
self-host operators a single-binary alternative in
[§5.2](self-hosting.md#52-embedded-turn-single-binary).

## 3. Why a Fork, and Why This Rev

Upstream `mycrl/turn-rs` exposes its own metrics through its own
Prometheus exporter/axum server and its own gRPC control-plane API (its
`prometheus`/`api` Cargo features), each with its own listener and its own
registry — bringing either of those in as-is would mean a **second**
`/metrics` endpoint and a **second** Prometheus registry living alongside
this project's own (see [`../src/metrics.rs`](../src/metrics.rs)), which
directly defeats the point of embedding (one binary should mean one
observability surface, not two glued together).

The fork used here,
[`ffedoroff/turn-rs`](https://github.com/ffedoroff/turn-rs) at
`95bc72188ba01ce447cf438e635b083a49516889`, patches that: it adds a
`metrics-facade` feature that emits turn-rs's metrics through the
[`metrics`](https://docs.rs/metrics) **facade** crate — the same facade
crate this project already installs a global recorder for at startup
(`PrometheusBuilder::install_recorder()`, in `main()`) — instead of
running its own exporter. Because both sides speak to the same facade,
turn-rs's counters/gauges land directly in this project's existing global
recorder with zero extra wiring: no second registry, no second endpoint,
no second port to scrape. The dependency in
[`../Cargo.toml`](../Cargo.toml) is built with
`default-features = false` and only `["udp", "tcp", "metrics-facade"]` —
explicitly excluding upstream's own `api` (gRPC control plane) and `ssl`
features, which this embedding has no use for and which the split,
production build must not gain a transitive dependency on at all.

The metric **names** the fork emits
(`turn_relay_allocations`, `turn_relayed_bytes_total`,
`turn_relayed_packets_total`, `turn_relay_errors_total`) are owned by the
fork's own `metrics_facade` module, not by this repo — this project only
pre-registers their HELP text on startup (`describe_embedded_turn()` in
[`../src/metrics.rs`](../src/metrics.rs), gated behind the same feature)
so they appear in `/metrics` immediately at boot rather than only after
the first relay allocation. `turn_relay_allocations` in particular is
worth calling out: it's a gauge of currently active relay
allocations/sessions — in plain terms, "how many connections are being
proxied through this server right now" — which is the one number an
operator watching this dashboard actually cares about for embedded TURN.

Pinning to an exact commit (rather than a branch or a published crate
version) is deliberate: this is a third-party fork with no stability
guarantee of its own, so the dependency in `Cargo.toml` names an immutable
rev — any update to picking up further upstream/fork changes is a
conscious, reviewed `Cargo.toml` edit, not something that can silently
drift.

## 4. Configuration and Credential Agreement

The embedded server is configured entirely from this process's **own**
environment (see [`../src/embedded_turn.rs`](../src/embedded_turn.rs)) —
there is deliberately no separate turn-rs config file to keep in sync.
Critically, `TURN_STATIC_SECRET` is the **same** variable this project
already reads to compute the ephemeral TURN credentials it hands out via
`GET /config` (see `main.rs::ice_config`, and
[`security.md` §3](security.md#3-h1--ephemeral-turn-credentials)) — so
credentials issued to clients and credentials verified by the embedded
relay can never drift out of sync with each other the way two genuinely
separate processes/secrets could. If the variable is unset, the embedded
server does not start at all (logged as a warning, not treated as a
startup failure, since compiling the feature in without configuring it is
a supported, intentional state — e.g. an operator who built the embedded
image but wants STUN-only for now).

## 5. Signal/Shutdown Behavior

This project already has a single actively-driven shutdown path on
SIGTERM/SIGINT: it broadcasts a close signal to every open WebSocket
connection rather than passively waiting out
`terminationGracePeriodSeconds` (see `main.rs::shutdown_signal`, and the
rationale in `docs/research-ops.md` §1.5/§1.6 for why a *full* graceful
drain was deliberately not built). The embedded TURN task is folded into
that same shutdown path: its `AbortHandle` is cancelled alongside the
WebSocket broadcast, with no separate drain ceremony of its own — turn-rs
has no in-flight HTTP requests to finish (unlike the main axum server), so
abandoning in-progress UDP relay sessions at shutdown is an acceptable
loss, not a correctness problem. `SIGKILL` remains uninterceptable by
anything in the process, embedded TURN included, same as every other
Rust/tokio process.

## 6. Consequences (Accepted Trade-offs)

- **Fate-sharing.** One process now means one crash/OOM takes both
  signaling and TURN down together. Acceptable for a single self-hosted
  node (the whole point is minimizing moving parts for that audience);
  not acceptable for the production instance, which is exactly why
  production stays on the split topology and this feature stays
  off-by-default.
- **`hostNetwork`/`--network host` is now a hard requirement** for the
  embedded build, for the same reason it already was for the split
  turn-rs deployment (see
  [`../deploy/manifests/turn.yaml`](../deploy/manifests/turn.yaml)): TURN
  relay candidates must reflect the host's real, externally reachable
  address and ports, which container-network NAT/port-mapping schemes
  don't preserve transparently. See
  [`self-hosting.md` §5.2](self-hosting.md#52-embedded-turn-single-binary)
  and the worked example at
  [`../deploy/examples/docker-compose.embedded.yml`](../deploy/examples/docker-compose.embedded.yml).
- **No independent scaling/restart of TURN.** A deliberate non-goal for
  this audience — if that ever becomes a real need for a given
  self-hoster, the answer is "run the split topology instead," not "add
  more knobs to the embedded one."
- **One observability surface, genuinely.** The metrics-facade patch is
  what makes this trade-off worth taking at all — without it, "embedded"
  would still mean two `/metrics` to reconcile, which would have defeated
  the purpose closely enough that it likely wouldn't have been worth
  building.
