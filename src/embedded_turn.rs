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
use turn_server::config::{Auth, Config, Interface, Server, Ssl};
use turn_server::service::session::ports::PortRange;

/// Fixed UDP relay port for the embedded server. Not currently configurable
/// (unlike `TURN_URL` for the split deployment) — self-host operators who
/// need a different port can still run the split setup instead.
const TURN_UDP_PORT: u16 = 3478;

/// Fixed port for the optional TURNS/TCP-over-TLS interface (see
/// `tls_interface` below) — 443 specifically, because it's the one port
/// that stays open on "443-only" networks (airport/hotel Wi-Fi that blocks
/// every other outbound port; see docs/network-profiles.md, "Sofia
/// Airport"), which is the whole point of this fallback. Like
/// `TURN_UDP_PORT`, not currently configurable.
const TURN_TLS_PORT: u16 = 443;

/// Resolves the external (publicly reachable) address advertised to
/// clients for a data-plane interface listening on `0.0.0.0:{port}`, from
/// `TURN_EXTERNAL_IP` — shared by both the UDP interface (port
/// `TURN_UDP_PORT`) and the optional TURNS/443 interface (port
/// `TURN_TLS_PORT`): both are the same host, so one env var covers both.
/// Falls back to `listen` itself (with a `warn!`) if the env var is unset
/// or invalid — relay candidates advertised in that case won't be reachable
/// from outside this host, but the interface still comes up rather than
/// failing startup outright.
fn external_addr(port: u16, listen: SocketAddr) -> SocketAddr {
    match std::env::var("TURN_EXTERNAL_IP") {
        Ok(ip) if !ip.is_empty() => format!("{ip}:{port}").parse().unwrap_or_else(|e| {
            warn!(
                %ip, error = %e,
                "invalid TURN_EXTERNAL_IP — embedded TURN will still start on 0.0.0.0:{port}, \
                 but relay candidates advertised to clients won't be reachable from outside this host"
            );
            listen
        }),
        _ => {
            warn!(
                "TURN_EXTERNAL_IP is not set — embedded TURN starting on 0.0.0.0:{port} \
                 anyway, but relay candidates won't be usable from outside this host; \
                 self-host operators should set it to this host's public IP \
                 (see docs/self-hosting.md, \"TURN (Optional)\")"
            );
            listen
        }
    }
}

/// Builds the optional TURNS/443 (TURN-over-TLS-over-TCP) interface, for
/// self-host operators who want the same "443-only network" fallback that
/// the split deployment gets via `TURN_TLS_URL` (see `main.rs::ice_config`).
/// Additive and off by default: returns `None` (no warning — this is simply
/// an unconfigured, supported state) unless BOTH `TURN_TLS_CERT` and
/// `TURN_TLS_KEY` are set, pointing at a PEM certificate chain and private
/// key respectively. Requires the fork's `ssl` Cargo feature (see
/// Cargo.toml) to actually terminate TLS — the `ssl` field on
/// `Interface::Tcp` is what turns a plain TCP interface into a TLS one.
fn tls_interface() -> Option<Interface> {
    let cert = std::env::var("TURN_TLS_CERT")
        .ok()
        .filter(|s| !s.is_empty());
    let key = std::env::var("TURN_TLS_KEY").ok().filter(|s| !s.is_empty());

    let (certificate_chain, private_key) = match (cert, key) {
        (Some(cert), Some(key)) => (cert, key),
        (None, None) => return None,
        _ => {
            warn!(
                "only one of TURN_TLS_CERT/TURN_TLS_KEY is set — both are required to enable \
                 the embedded TURNS/443 interface; NOT starting it"
            );
            return None;
        }
    };

    let listen = SocketAddr::from(([0, 0, 0, 0], TURN_TLS_PORT));
    let external = external_addr(TURN_TLS_PORT, listen);

    Some(Interface::Tcp {
        listen,
        external,
        idle_timeout: 20,
        ssl: Some(Ssl {
            private_key,
            certificate_chain,
        }),
    })
}

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
    let external = external_addr(TURN_UDP_PORT, listen);

    let mut interfaces = vec![Interface::Udp {
        listen,
        external,
        idle_timeout: 20,
        mtu: 1500,
    }];
    // Optional TURNS/443 (TCP-over-TLS) interface, additive on top of the
    // always-on UDP one above — see `tls_interface`'s doc comment for the
    // "443-only network" motivation and the env vars that gate it.
    if let Some(tls) = tls_interface() {
        interfaces.push(tls);
    }

    let server = Server {
        realm,
        interfaces,
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
