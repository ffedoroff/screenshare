//! Embedded TURN (optional, `embedded-turn` Cargo feature — see
//! docs/self-hosting.md, "TURN (Optional)"). This whole module only exists
//! in binaries built with `--features embedded-turn`; the default (split,
//! production) build never compiles it and never pulls in the `turn-server`
//! crate at all (see the `optional = true` dependency + feature gate in
//! Cargo.toml).
//!
//! Builds a `turn_server::config::Config` programmatically from this
//! process's OWN env vars (no separate turn-rs config file) and spawns the
//! forked turn-rs server (see Cargo.toml for the fork/rev) as a background
//! tokio task, so a self-host operator can run ONE binary/container instead
//! of a separate turn-rs deployment (see deploy/manifests/turn.yaml for the
//! split alternative). The fork emits its metrics through the `metrics`
//! facade crate (see its `metrics-facade` feature and `src/metrics.rs`
//! here), so they land in the SAME global recorder/registry this process
//! already installs in `main()` — no second Prometheus registry, no second
//! `/metrics` endpoint.

use std::net::SocketAddr;

use tokio::task::AbortHandle;
use tracing::warn;
use turn_server::config::{Auth, Config, Interface, Server};
use turn_server::service::session::ports::PortRange;

/// Fixed UDP relay port for the embedded server. Not currently configurable
/// (unlike `TURN_URL` for the split deployment) — self-host operators who
/// need a different port can still run the split setup instead.
const TURN_UDP_PORT: u16 = 3478;

/// Parses `TURN_PORT_RANGE` in the "START-END" form (e.g. "49160-49999") —
/// deliberately a single dash, matching how the value is documented for
/// operators, NOT turn-rs's own `Display`/`FromStr` format ("START..END"),
/// which is an internal implementation detail of the fork we don't want to
/// leak into our env var contract.
fn parse_port_range(s: &str) -> Option<PortRange> {
    let (start, end) = s.split_once('-')?;
    let start: u16 = start.trim().parse().ok()?;
    let end: u16 = end.trim().parse().ok()?;
    (start <= end).then(|| PortRange::from(start..end))
}

/// Builds the embedded TURN server's config from env and spawns it as a
/// background task, returning its `AbortHandle` so `main()` can cancel it on
/// shutdown (see `shutdown_signal` in main.rs) — turn-rs doesn't need a
/// graceful drain of its own (no in-flight HTTP requests to finish, unlike
/// the main axum server; abandoning in-progress UDP relay sessions on
/// shutdown is fine).
///
/// Returns `None` (logging a warning, not an error — the feature is compiled
/// in but simply unconfigured, which is a supported state, not a startup
/// failure) when `TURN_STATIC_SECRET` is unset: without it the embedded
/// server would still come up, but would issue/verify credentials that never
/// match what `/config` hands out to clients (see `main.rs::ice_config` —
/// both are deliberately driven by the exact same env var, so they always
/// agree).
pub fn spawn() -> Option<AbortHandle> {
    let static_auth_secret = std::env::var("TURN_STATIC_SECRET")
        .ok()
        .filter(|s| !s.is_empty());

    let Some(static_auth_secret) = static_auth_secret else {
        warn!(
            "embedded-turn is compiled in but TURN_STATIC_SECRET is not set — \
             NOT starting the embedded TURN server (it would issue/verify \
             credentials that never match /config's, see main.rs::ice_config)"
        );
        return None;
    };

    let realm = std::env::var("TURN_REALM")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost".to_string());

    let port_range = std::env::var("TURN_PORT_RANGE")
        .ok()
        .filter(|s| !s.is_empty())
        .and_then(|raw| match parse_port_range(&raw) {
            Some(range) => Some(range),
            None => {
                warn!(value = %raw, "invalid TURN_PORT_RANGE (expected \"START-END\", e.g. \"49160-49999\") — using turn-rs's own default");
                None
            }
        })
        .unwrap_or_default();

    let listen = SocketAddr::from(([0, 0, 0, 0], TURN_UDP_PORT));
    let external = match std::env::var("TURN_EXTERNAL_IP") {
        Ok(ip) if !ip.is_empty() => format!("{ip}:{TURN_UDP_PORT}").parse().unwrap_or_else(|e| {
            warn!(
                %ip, error = %e,
                "invalid TURN_EXTERNAL_IP — embedded TURN will still start on 0.0.0.0, \
                 but relay candidates advertised to clients won't be reachable from outside this host"
            );
            listen
        }),
        _ => {
            warn!(
                "TURN_EXTERNAL_IP is not set — embedded TURN starting on 0.0.0.0:{TURN_UDP_PORT} \
                 anyway, but relay candidates won't be usable from outside this host; \
                 self-host operators should set it to this host's public IP \
                 (see docs/self-hosting.md, \"TURN (Optional)\")"
            );
            listen
        }
    };

    let server = Server {
        realm,
        interfaces: vec![Interface::Udp {
            listen,
            external,
            idle_timeout: 20,
            mtu: 1500,
        }],
        port_range,
        ..Server::default()
    };

    let auth = Auth {
        static_auth_secret: Some(static_auth_secret),
        ..Auth::default()
    };

    // `prometheus: None` / `api: None` (via `..Config::default()`): we don't
    // want the fork's own axum exporter or gRPC control plane — see the
    // module doc above and Cargo.toml (neither the `prometheus` nor the
    // `api` upstream feature is enabled on the `turn-server` dependency).
    let config = Config {
        server,
        auth,
        ..Config::default()
    };

    let join_handle = tokio::spawn(async move {
        if let Err(e) = turn_server::start_server(config).await {
            tracing::error!("embedded TURN server crashed: {e}");
        }
    });

    Some(join_handle.abort_handle())
}
