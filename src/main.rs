//! Entry point: HTTP server on axum.
//!
//! The backend does exactly three things (per the spec):
//!   1. Signaling relay over WebSocket (`/ws`) — see `ws.rs`. Room text chat
//!      never reaches here at all: it travels exclusively directly between
//!      participants over the mesh RTCDataChannel (see `static/chat.js`,
//!      docs/chat.md §12) — the server does not participate in this path
//!      and never sees a single byte of chat content.
//!   2. Serving the frontend's static assets (`/`, `/r/{id}`, `/static/...`).
//!   3. A tiny `/config` with ICE servers from environment variables.
//!
//! Media still never passes through the server.
//!
//! Phase 1 (E2E encryption, see static/crypto.js): the server relays
//! sdp/candidate/info/participant name already ENCRYPTED by the client with
//! pairwise keys derived from the `t`/`e` secret in the URL fragment (the
//! server has never seen it and never will) — from the point of view of
//! this file and `ws.rs`, nothing has changed, they relayed opaque
//! JSON/strings before and still do. The QR code (formerly `GET /qr.svg`)
//! is now rendered LOCALLY in the browser (see `static/vendor/qrcode.js`,
//! `static/room.js`), so that the link with secret `#t`/`#e` doesn't go to
//! the server just for an image — this endpoint has been removed entirely.
//!
//! Privacy: nothing is left on disk — no client IPs/ports (tracing logs
//! only carry room/peer id), no chat content (the server never sees or
//! stores it at all — see above), no session information of any kind. When
//! a room dies, all its memory dies with it (participants, names).
//!
//! Phase 2 (trust separation, see docs/self-hosting.md, "Split Origin
//! (Frontend / Signaling Separated)", and docs/e2e-encryption.md, "Trust
//! Split"): the frontend's static assets can move to a separate static
//! hosting service, this server remains ONLY the API/WS on a separate host
//! (a separate API host) — frontend and backend CAN live on different
//! origins. Hence: CORS on cross-origin HTTP endpoints (`cors_middleware`
//! below, enabled via env `CORS_ORIGIN`) and an optional `Origin` check on
//! `/ws` (see `ws.rs::ws_handler`) — both disabled (no headers, no check) by
//! default, until `CORS_ORIGIN` is set, so that local dev and current
//! production (static assets and API still on one host) behave exactly as
//! before.

#[cfg(feature = "embedded-turn")]
mod embedded_turn;
mod metrics;
mod protocol;
mod state;
mod ws;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use axum::Router;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use serde_json::json;
use sha1::Sha1;
use tracing::{info, warn};
use uuid::Uuid;

use crate::protocol::RoomSettings;
use crate::state::{
    check_ip_rate_limit, extract_client_ip, AppState, Room, DEFAULT_JOIN_ROOM_IP_LIMIT,
    DEFAULT_MAX_PARTICIPANTS, DEFAULT_MAX_ROOMS, DEFAULT_MAX_ROOM_LIFETIME_SECONDS,
    DEFAULT_ROOM_CREATION_IP_LIMIT, ROOM_CREATION_IP_WINDOW,
};

/// Directory with frontend static assets. Configurable via env `STATIC_DIR`
/// (in a container — e.g. `/app/static`), and for `cargo run` without the
/// variable set, we fall back to a path next to Cargo.toml, fixed at
/// compile time.
static STATIC_DIR: LazyLock<String> = LazyLock::new(|| {
    std::env::var("STATIC_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/static").to_string())
});

/// Phase 2 (trust separation — static assets move to a separate static
/// hosting service, this server remains only API/WS on a separate host, see
/// docs/self-hosting.md, "Split Origin (Frontend / Signaling Separated)"):
/// the allowed cross-origin for CORS, from env `CORS_ORIGIN` (e.g.
/// `https://your-domain.example`). Empty/unset (the default — local dev and
/// single-host deployment, where frontend and API are still on one host)
/// means "CORS is disabled entirely": not a single Access-Control-* header
/// is sent (see `cors_middleware`) — from the browser's point of view
/// nothing has changed compared to how the server behaved before.
pub(crate) static CORS_ORIGIN: LazyLock<Option<String>> = LazyLock::new(|| {
    std::env::var("CORS_ORIGIN")
        .ok()
        .filter(|v| !v.is_empty())
});

/// Call duration limit (see docs/security.md, "Meeting Duration Ceiling"): a
/// room older than this age is deleted entirely by the reaper
/// (`state::reap_rooms`), even if it has live participants — they get sent
/// `room-expired` right before that. Env `MAX_ROOM_LIFETIME_SECONDS`,
/// default 3 hours (`DEFAULT_MAX_ROOM_LIFETIME_SECONDS`). `LazyLock` (like
/// `CORS_ORIGIN` above) reads the env once on first access — that's enough,
/// the value doesn't change on the fly; used both here when spawning the
/// reaper and in `ws.rs` (`room_expires_in_seconds`) when computing the
/// remainder for `Joined`.
pub(crate) static MAX_ROOM_LIFETIME: LazyLock<Duration> = LazyLock::new(|| {
    let secs: u64 = std::env::var("MAX_ROOM_LIFETIME_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_ROOM_LIFETIME_SECONDS);
    Duration::from_secs(secs)
});

/// Ceiling on the number of participants in a room at once (see
/// `docs/self-hosting.md`, §6): env `MAX_PARTICIPANTS`, default 6
/// (`DEFAULT_MAX_PARTICIPANTS`). This is a RECOMMENDED default for a full
/// mesh topology, not a hard protocol limit — a room is a full WebRTC mesh
/// (everyone sends media to everyone else directly), so it's possible to go
/// above the default, but each client's outgoing traffic grows (n-1
/// copies) — the server itself isn't affected, it only relays signaling.
/// `LazyLock` (like `MAX_ROOM_LIFETIME` above) reads the env once on first
/// access; used in `ws.rs` when checking room-full (`join-room` and
/// `approve`).
pub(crate) static MAX_PARTICIPANTS: LazyLock<usize> = LazyLock::new(|| {
    std::env::var("MAX_PARTICIPANTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_PARTICIPANTS)
});

/// Per-IP limit on a direct `join-room` into a room (H2, docs/research-dos.md
/// §3.2 — see the detailed rationale at `state::DEFAULT_JOIN_ROOM_IP_LIMIT`
/// for why exactly THIS limit, unlike its "neighbors"
/// (`ROOM_CREATION_IP_LIMIT`/`PENDING_JOIN_IP_LIMIT`), is made configurable
/// via env — testability of the WS handshake, which has no way to set an
/// arbitrary `CF-Connecting-IP` the way HTTP can). Env `JOIN_ROOM_IP_LIMIT`,
/// default `DEFAULT_JOIN_ROOM_IP_LIMIT` (20). `LazyLock` — the same trick
/// as `MAX_PARTICIPANTS` above.
pub(crate) static JOIN_ROOM_IP_LIMIT: LazyLock<usize> = LazyLock::new(|| {
    std::env::var("JOIN_ROOM_IP_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_JOIN_ROOM_IP_LIMIT)
});

/// Per-IP limit on `POST /api/rooms` (and, sharing its budget, `PUT
/// /api/rooms/{id}`, see `restore_room`) — H2, DoS protection. The
/// production default is tightened to 3/60s (see the detailed rationale at
/// `state::DEFAULT_ROOM_CREATION_IP_LIMIT`): creating a room is a rare
/// action for a legitimate user, unlike `JOIN_ROOM_IP_LIMIT` above.
/// Configurable via env `ROOM_CREATION_IP_LIMIT` for the same reason as
/// `JOIN_ROOM_IP_LIMIT` — testability (signaling.test.mjs and the e2e tests
/// create lots of rooms from a single IP per run and would hit the strict
/// production default). `LazyLock` — the same trick as
/// `JOIN_ROOM_IP_LIMIT` above.
pub(crate) static ROOM_CREATION_IP_LIMIT: LazyLock<usize> = LazyLock::new(|| {
    std::env::var("ROOM_CREATION_IP_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_ROOM_CREATION_IP_LIMIT)
});

/// CORS by hand, without tower-http: we only have three cross-origin HTTP
/// paths (`/api/rooms` (+`/api/rooms/{id}`), `/config`, `/version.json`) —
/// pulling in a separate crate (extra compilation, extra surface) just for
/// headers on three handlers seemed like overkill; the CORS protocol itself
/// is trivial here (no credentials/cookies, one static allow-list origin
/// from env). Applied pointedly via `.route_layer()` only to these routes
/// (see main()) — the rest (static assets, `/`, `/r/{id}`, `/ws`) don't pay
/// anything for it.
///
/// Preflight `OPTIONS` is intercepted RIGHT HERE too, before the route
/// handler is called (those handlers don't have the OPTIONS method
/// registered at all) — we respond with `204` and the same headers. If
/// `CORS_ORIGIN` isn't set, no Access-Control-* headers are added at all
/// (see `CORS_ORIGIN` above) — but the server still returns the `204`
/// response to OPTIONS regardless; this has no practical effect since
/// same-origin requests don't trigger preflight.
async fn cors_middleware(req: Request, next: Next) -> Response {
    let mut response = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };

    if let Some(origin) = CORS_ORIGIN.as_deref() {
        let headers = response.headers_mut();
        match HeaderValue::from_str(origin) {
            Ok(v) => {
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            }
            Err(e) => warn!("CORS_ORIGIN={origin:?} is not a valid header value: {e}"),
        }
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
    }

    // M2 (security headers on API responses): applied on the same routes as
    // CORS above (`/api/rooms`, `/config`, `/version.json` — see
    // `.route_layer(cors...)` in `main()`), REGARDLESS of whether
    // `CORS_ORIGIN` is set — these are purely response headers, not about
    // cross-origin. Pages (`page()`/`static_file()`) don't get them — this
    // middleware isn't attached to them at all (see main()), the frontend
    // static assets move to Cloudflare Pages and it configures page headers
    // itself via `_headers`.
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));

    response
}

/// Stub handler for the `OPTIONS` method on CORS routes. The body is NEVER
/// executed: `cors_middleware` intercepts `OPTIONS` before `next.run()` is
/// called and responds itself. It still has to exist: axum's
/// `MethodRouter`, without a registered `OPTIONS`, short-circuits an
/// unrecognized method straight to `405 Method Not Allowed` — BEFORE the
/// request even reaches the `route_layer` middleware (its `.route_layer()`
/// wrapping only covers methods already registered on this MethodRouter,
/// not the 405 fallback) — without this stub, preflight OPTIONS would never
/// see the CORS headers.
async fn options_stub() -> StatusCode {
    StatusCode::NO_CONTENT
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,screenshare=debug".into()),
        )
        .init();

    // Prometheus metrics (see src/metrics.rs) — the same pattern/crate as
    // code-ranker-backend (see `code-ranker-private/backend/src/main.rs`):
    // a separate management server on its own port with `/metrics`, NOT on
    // the main 8080 and NOT in the Service/ingress (see
    // deploy/manifests/deployment.yaml) — the same `MGMT_PORT` as
    // code-ranker, default 8081. We install the recorder and bring up the
    // listener BEFORE everything else (roles/rooms/main server) — if
    // something in the initialization below panics, it's better to already
    // see it in the management port's metrics/logs than to have nothing at
    // all.
    let prometheus = PrometheusBuilder::new()
        .install_recorder()
        .expect("failed to install the Prometheus recorder");
    metrics::describe();
    #[cfg(feature = "embedded-turn")]
    metrics::describe_embedded_turn();
    spawn_metrics_server(prometheus).await;

    // Embedded TURN (optional, `embedded-turn` Cargo feature — see
    // `embedded_turn` module and docs/self-hosting.md, "TURN (Optional)"):
    // in the default (split) build this is always `None` at zero cost — the
    // `turn-server` crate isn't even in the dependency graph. Started next
    // to the metrics server and before the main listener for the same
    // reason as `spawn_metrics_server` above: if it fails to come up, we'd
    // rather see that early than have it silently missing later.
    let turn_abort_handle = spawn_embedded_turn();

    let rooms = Arc::new(Mutex::new(HashMap::new()));

    // How long an empty room (nobody connected / everyone left) lives
    // before the reaper deletes it. Default 120s — time for the creator to
    // follow the link; set much shorter in tests.
    let empty_room_ttl_secs: u64 = std::env::var("EMPTY_ROOM_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let empty_room_ttl = Duration::from_secs(empty_room_ttl_secs);
    // Call duration limit (see docs/security.md, "Meeting Duration
    // Ceiling") — read right away (forcing the LazyLock), so the value is
    // fixed before the reaper is spawned and the first request arrives.
    let max_room_lifetime = *MAX_ROOM_LIFETIME;
    tokio::spawn(state::reap_rooms(rooms.clone(), empty_room_ttl, max_room_lifetime));

    // H2 (DoS protection): ceiling on the number of rooms at once — env
    // `MAX_ROOMS`, default `DEFAULT_MAX_ROOMS`.
    let max_rooms: usize = std::env::var("MAX_ROOMS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_ROOMS);

    // C (docs/research-ops.md §1.0/§1.6): channel for actively broadcasting
    // WS shutdown on SIGTERM/SIGINT — see `shutdown_signal` below and
    // `AppState::shutdown`. We don't need the initial receiver from
    // `channel()` (subscribers are created later via `subscribe()`, one per
    // WS connection) — we drop it right away by destructuring.
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);

    let state = AppState {
        rooms,
        max_rooms,
        room_creation_ips: Arc::new(Mutex::new(HashMap::new())),
        pending_join_ips: Arc::new(Mutex::new(HashMap::new())),
        join_room_ips: Arc::new(Mutex::new(HashMap::new())),
        shutdown: shutdown_tx.clone(),
    };

    // Phase 2: the CORS middleware is attached POINTEDLY only to
    // cross-origin HTTP endpoints (see cors_middleware above) — static
    // assets/pages/`/ws` never see it at all.
    let cors = middleware::from_fn(cors_middleware);

    let app = Router::new()
        // Landing/entry page.
        .route("/", get(|| page("index.html")))
        // Room page: the frontend reads roomId from the URL itself.
        .route("/r/{room_id}", get(|_: Path<String>| page("room.html")))
        .route(
            "/api/rooms",
            post(create_room)
                .options(options_stub)
                .route_layer(cors.clone()),
        )
        .route(
            "/api/rooms/{room_id}",
            put(restore_room)
                .options(options_stub)
                .route_layer(cors.clone()),
        )
        .route(
            "/config",
            get(ice_config).options(options_stub).route_layer(cors.clone()),
        )
        .route("/healthz", get(healthz))
        .route(
            "/version.json",
            get(version_json).options(options_stub).route_layer(cors),
        )
        .route("/ws", get(ws::ws_handler))
        .route("/static/{*path}", get(static_file))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    info!("server listening on http://localhost:{port}");
    // `with_connect_info`: needed for `ConnectInfo<SocketAddr>` in
    // `ws::ws_handler`/`create_room` — fallback source of the client IP for
    // per-IP limits (H2/M3) when neither `CF-Connecting-IP` nor
    // `X-Forwarded-For` was sent (direct connection without a proxy).
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal(shutdown_tx, turn_abort_handle))
        .await
        .expect("server ended unexpectedly");
}

/// Spawns the embedded TURN server (see `embedded_turn::spawn`) when built
/// with `--features embedded-turn`, otherwise a zero-cost `None` — kept as a
/// plain function (rather than inlining `#[cfg]` blocks into `main()`) so
/// the rest of `main()`/`shutdown_signal` doesn't need to know which build
/// it's in: they just carry an `Option<AbortHandle>` either way.
#[cfg(feature = "embedded-turn")]
fn spawn_embedded_turn() -> Option<tokio::task::AbortHandle> {
    embedded_turn::spawn()
}

#[cfg(not(feature = "embedded-turn"))]
fn spawn_embedded_turn() -> Option<tokio::task::AbortHandle> {
    None
}

/// Waits for SIGTERM (the standard stop signal in k8s) or SIGINT (Ctrl+C
/// locally). On either, the server stops accepting new connections
/// (`axum::serve`'s `with_graceful_shutdown` stops the listener and waits
/// for already-accepted HTTP requests to finish) — but, as honestly noted
/// in docs/research-ops.md §1.0, this does NOT close already-upgraded WS
/// connections: they live in their own `tokio` tasks (`ws::handle_socket`)
/// outside hyper's visibility and used to passively live until
/// `terminationGracePeriodSeconds` (30s in the k8s manifest) and the
/// subsequent `SIGKILL` — meaning signaling downtime during an active call
/// at deploy time was ~30-40s.
///
/// C (§1.5/§1.6 of the same document, "cheap improvement"): instead of
/// waiting passively, we broadcast to ALL open WS connections (via
/// `AppState::shutdown`, a broadcast subscription in each `handle_socket`)
/// a signal to actively close their own socket right away (a `Close`
/// frame) — the client catches the closure immediately and starts its usual
/// auto-reconnect (`static/room.js`), instead of the server holding onto a
/// signaling connection that's effectively dead for another few dozen
/// seconds. This is NOT a full graceful drain (options 1.1-1.4 of that
/// research, deliberately not implemented — see their verdict: they carry a
/// split-brain risk disproportionate to the benefit for this project's
/// single-process in-memory model) — a minimal measure: a short pause (not
/// `terminationGracePeriodSeconds`, but specifically "give the tasks time
/// to push one more Close frame onto their socket before the process tries
/// to exit"), see `SHUTDOWN_FLUSH_GRACE`.
///
/// `turn_abort_handle`: the embedded TURN server's task (see
/// `spawn_embedded_turn`/`embedded_turn::spawn`), `None` in the default
/// (split) build or when the feature is compiled in but unconfigured. It's
/// aborted here too, alongside the WS Close broadcast — turn-rs doesn't need
/// a graceful drain of its own (no in-flight HTTP requests, unlike the main
/// server; abandoning in-progress UDP relay sessions on shutdown is fine),
/// so a plain `abort()` is enough to make sure the process doesn't hang on
/// it past `SHUTDOWN_FLUSH_GRACE`.
async fn shutdown_signal(
    shutdown_tx: state::ShutdownSignal,
    turn_abort_handle: Option<tokio::task::AbortHandle>,
) {
    let sigterm = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to subscribe to SIGTERM")
            .recv()
            .await;
    };
    let sigint = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to subscribe to SIGINT");
    };
    tokio::select! {
        _ = sigterm => info!("received SIGTERM — actively closing open WS connections"),
        _ = sigint => info!("received SIGINT — actively closing open WS connections"),
    }
    // There may be no receivers at all (not a single open WS at the
    // moment) — `send` will then simply return an error, which we
    // deliberately ignore: this is a normal case, not a failure.
    let _ = shutdown_tx.send(());
    if let Some(handle) = turn_abort_handle {
        info!("aborting the embedded TURN server task");
        handle.abort();
    }
    // Give the now-woken `handle_socket` tasks time to reach
    // `socket.send(Message::Close(...))` and actually push the frame onto
    // TCP, before `axum::serve(...)` returns from `.await` and the process
    // exits (at which point the runtime silently drops the remaining
    // tasks, anything not yet sent won't get through). NOT a full
    // `terminationGracePeriodSeconds` (30s) — orders of magnitude smaller,
    // with plenty of margin for tokio's cooperative scheduler to simply get
    // a chance to run these tasks at least once.
    tokio::time::sleep(SHUTDOWN_FLUSH_GRACE).await;
}

/// See `shutdown_signal`.
const SHUTDOWN_FLUSH_GRACE: Duration = Duration::from_millis(500);

/// Brings up the management server (for now just `/metrics`) on ITS OWN
/// port, SEPARATE from the main one — the same pattern as
/// `code-ranker-backend` (see `code-ranker-private/backend/src/main.rs`):
/// `/metrics` isn't mixed into the main 8080 (which sits behind a
/// `Service`/`Ingress`, see `deploy/manifests/service.yaml`/`ingress.yaml`)
/// — the management port is deliberately NOT exposed in the `Service` (see
/// `deploy/manifests/deployment.yaml`), Prometheus scrapes it directly by
/// pod IP via `kubernetes_sd_config` + `prometheus.io/scrape|port|path`
/// annotations on the pod itself (see the same manifest,
/// `simple-deploy/standards/observability/metrics.md`, § "Target
/// autodiscovery").
///
/// Unlike `/healthz` (which stays on the main port 8080 — this endpoint is
/// already used by the readiness/liveness probes in
/// `deploy/manifests/deployment.yaml`, there was no reason to touch them) —
/// `/metrics` is set up fresh, only on the management port, nothing
/// existing is moved or broken.
///
/// Does NOT participate in the main server's graceful shutdown
/// (`shutdown_signal` below): this is an internal scrape endpoint with no
/// user-facing state — there's no need for a separate shutdown ceremony for
/// it, it simply stops responding along with the process exiting.
///
/// A bind error (port taken/unavailable) is not fatal to the whole process:
/// metrics are an auxiliary capability, not the reason the server exists in
/// the first place (WS signaling/static assets) — we log it and continue
/// without them, rather than panicking.
async fn spawn_metrics_server(handle: PrometheusHandle) {
    let mgmt_port: u16 = std::env::var("MGMT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8081);
    let mgmt_router = Router::new().route(
        "/metrics",
        get(move || {
            let handle = handle.clone();
            async move { render_metrics(handle) }
        }),
    );
    let addr = format!("0.0.0.0:{mgmt_port}");
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            info!("management server (metrics) listening on http://localhost:{mgmt_port}");
            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, mgmt_router).await {
                    tracing::error!("management server crashed: {e}");
                }
            });
        }
        Err(e) => {
            tracing::error!("failed to bind management port {addr}: {e} — metrics unavailable, main server continues without them");
        }
    }
}

/// Prometheus exposition (`text/plain; version=0.0.4`) — rendered on
/// request from the recorder installed at startup (see `main()`), with no
/// buffer/cache of its own: `PrometheusHandle::render()` is itself cheap
/// enough at our scale (a handful of metrics, no RED-histogram overhead —
/// see `crate::metrics`).
fn render_metrics(handle: PrometheusHandle) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], handle.render())
}

/// `POST /api/rooms`: create a new EMPTY room (protocol v2 — a room is set
/// up separately from joining it, so the creator has time to copy and open
/// the link). The request body is optional and currently unused (a hook for
/// the future — e.g. a room name), so it's deliberately not parsed at all.
///
/// A room with no participants lives for `EMPTY_ROOM_TTL_SECONDS` — if
/// nobody connects within that time, the reaper (`state::reap_rooms`)
/// deletes it.
///
/// Returns, along with `roomId`, a one-time `leaderToken` (see
/// docs/permissions-and-leader.md): the creator presents it in their own
/// `join-room` to become the room's leader — the token is burned on the
/// first successful presentation (matching the stored one). If nobody
/// presents the token, whoever joins first becomes the leader as usual.
///
/// Also returns `lifetimeSeconds` — the same `MAX_ROOM_LIFETIME` the server
/// uses to cap call duration (see `MAX_ROOM_LIFETIME`, docs/security.md,
/// "Meeting Duration Ceiling"). Needed by the E2E v2 client (see
/// docs/research-p2p-key-handoff.md §6.5–6.6): the link's expiry (`e` in the
/// URL fragment) is baked into key derivation by the client at room
/// creation time, not looked up again on every join — so the client needs
/// to learn the limit exactly at creation time.
async fn create_room(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // H2 (DoS protection): per-IP limit — no more than ROOM_CREATION_IP_LIMIT
    // requests per ROOM_CREATION_IP_WINDOW from a single IP (see its
    // comment in state.rs for why the budget is separate from the lobby's).
    let ip = extract_client_ip(&headers, Some(peer_addr));
    if !check_ip_rate_limit(&state.room_creation_ips, &ip, *ROOM_CREATION_IP_LIMIT, ROOM_CREATION_IP_WINDOW) {
        warn!(%ip, "per-IP room creation limit exceeded — 429");
        return (StatusCode::TOO_MANY_REQUESTS, "too many rooms created, slow down").into_response();
    }

    let room_id = state::generate_room_id();
    let leader_token = Uuid::new_v4().to_string();

    let mut rooms_guard = state.rooms.lock().unwrap();
    // H2 (DoS protection): the global ceiling on the number of rooms — we
    // check it under the SAME lock as the insert below, otherwise a race
    // between two concurrent create_room calls could let both pass the
    // check and together exceed the ceiling.
    if rooms_guard.len() >= state.max_rooms {
        drop(rooms_guard);
        warn!(max_rooms = state.max_rooms, "room count ceiling reached — 503");
        return (StatusCode::SERVICE_UNAVAILABLE, "server busy").into_response();
    }
    // A collision of an 8-character id is astronomically unlikely (32^8
    // possibilities); in the theoretical losing case we simply refuse — the
    // client retries the request.
    if rooms_guard.contains_key(&room_id) {
        drop(rooms_guard);
        warn!(room = %room_id, "roomId collision on creation — refusing");
        return (StatusCode::INTERNAL_SERVER_ERROR, "try again").into_response();
    }
    rooms_guard.insert(
        room_id.clone(),
        Room {
            participants: HashMap::new(),
            screen_owner: None,
            // Marked "empty" right away: if nobody connects within the TTL,
            // the reaper deletes it.
            emptied_at: Some(Instant::now()),
            leader_id: None,
            leader_token: Some(leader_token.clone()),
            settings: RoomSettings::default(),
            pending: HashMap::new(),
            created_at: Instant::now(),
            first_joined_at: None,
        },
    );
    drop(rooms_guard);
    // `::metrics` (leading `::`) — the external `metrics` crate, not our
    // own `crate::metrics` module (see `mod metrics;` below) — both happen
    // to be named the same.
    ::metrics::counter!(crate::metrics::ROOMS_CREATED_TOTAL).increment(1);
    info!(room = %room_id, "room created (empty)");

    (
        StatusCode::CREATED,
        Json(json!({
            "roomId": room_id,
            "leaderToken": leader_token,
            "lifetimeSeconds": MAX_ROOM_LIFETIME.as_secs(),
        })),
    )
        .into_response()
}

/// `PUT /api/rooms/{room_id}`: idempotent room restoration after a server
/// restart (see docs/self-hosting.md, "Surviving a Restart/Redeploy") — all
/// room memory lives entirely in the process, so a restart wipes it without
/// a trace, and clients auto-reconnecting may run into `room-not-found` for
/// a room they were just in. Rather than that being a dead end, the
/// frontend (see `static/room.js`), in response to `room-not-found` while
/// reconnecting, first hits this endpoint with the REMEMBERED `roomId`,
/// then retries `join-room`.
///
/// Idempotency semantics:
///   - `room_id` doesn't match the format (`^[a-z0-9]{8}$`, see
///     `is_valid_room_id`) — `400`;
///   - no room with that id exists — create an empty one (like `POST
///     /api/rooms`, but with a given id rather than a random one) — `201`;
///   - the room already exists (whether empty or with participants) —
///     touch nothing, just confirm — `200`.
///
/// In both success cases (`200`/`201`) the response additionally carries the
/// same `lifetimeSeconds` as `POST /api/rooms` — for API symmetry; in
/// practice the E2E v2 client doesn't need it here (the `e` expiry is
/// already baked into the address bar when restoring the same tab, see
/// docs/research-p2p-key-handoff.md §6.5–6.6).
///
/// On the security of restoring by a known id: rooms in this project are
/// ephemeral and have no separate access control — the only secret is the
/// `roomId` itself in the link (see docs/privacy.md). Restoring by an id
/// already known to the client expands access NOTHING — whoever knew the
/// link before the restart could, after the restart, just as well get
/// `room-not-found` and create THEIR OWN new room with a different id; this
/// endpoint merely saves whoever knows the link from having to create a new
/// one and redistribute it to the other participants. Whoever didn't know
/// the link can't brute-force a `room_id` (8 characters from a limited
/// alphabet) in any practical way, neither through this endpoint nor
/// through `POST /api/rooms`.
async fn restore_room(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Response {
    if !is_valid_room_id(&room_id) {
        return (StatusCode::BAD_REQUEST, "invalid room id").into_response();
    }

    // H2 (DoS protection, docs/research-dos.md §3.1): PUT previously didn't
    // check the per-IP limit at all — the only "create-like" route (creates
    // a record in `rooms` if there wasn't one) with no IP accounting.
    // Shares its budget with `POST /api/rooms` (the same
    // `ROOM_CREATION_IP_LIMIT`/`room_creation_ips`) — not a separate
    // counter: for the purposes of this limit it doesn't matter which of
    // the two paths the caller uses to set up a room record, what matters
    // is HOW MANY records a single IP sets up in total over the window.
    // We check unconditionally (even if a room with this `room_id` already
    // exists and the branch below returns `200` without creating anything)
    // — a single simple check point for the whole handler, not just the
    // "actual" creation branch.
    let ip = extract_client_ip(&headers, Some(peer_addr));
    if !check_ip_rate_limit(&state.room_creation_ips, &ip, *ROOM_CREATION_IP_LIMIT, ROOM_CREATION_IP_WINDOW) {
        warn!(%ip, "per-IP room creation/restoration limit exceeded — 429 (PUT)");
        return (StatusCode::TOO_MANY_REQUESTS, "too many rooms created, slow down").into_response();
    }

    let mut rooms_guard = state.rooms.lock().unwrap();
    if rooms_guard.contains_key(&room_id) {
        drop(rooms_guard);
        return (
            StatusCode::OK,
            Json(json!({ "roomId": room_id, "lifetimeSeconds": MAX_ROOM_LIFETIME.as_secs() })),
        )
            .into_response();
    }
    // H2 (DoS protection): the same global ceiling as in create_room, under
    // the same lock — restoring a NONEXISTENT room also creates a record.
    if rooms_guard.len() >= state.max_rooms {
        drop(rooms_guard);
        warn!(max_rooms = state.max_rooms, "room count ceiling reached — 503 (restore)");
        return (StatusCode::SERVICE_UNAVAILABLE, "server busy").into_response();
    }
    rooms_guard.insert(
        room_id.clone(),
        Room {
            participants: HashMap::new(),
            screen_owner: None,
            emptied_at: Some(Instant::now()),
            // A restored room doesn't issue a leader token — whoever joins
            // first becomes the leader (see docs/permissions-and-leader.md).
            leader_id: None,
            leader_token: None,
            settings: RoomSettings::default(),
            pending: HashMap::new(),
            // The call duration limit countdown starts from the moment of
            // restoration, not from some original creation (memory of that
            // doesn't survive a server restart) — see the comment on
            // Room::created_at.
            created_at: Instant::now(),
            // Like created_at — doesn't survive a restart, the room's age
            // countdown for roomAgeSeconds will start over from the first
            // join after restoration (see the comment on
            // Room::first_joined_at).
            first_joined_at: None,
        },
    );
    drop(rooms_guard);
    // An actual record creation (unlike the idempotent 200-branch above,
    // which creates nothing and never reaches here) — counted in
    // chat_rooms_created_total on par with POST /api/rooms.
    ::metrics::counter!(crate::metrics::ROOMS_CREATED_TOTAL).increment(1);
    info!(room = %room_id, "room restored after restart (PUT /api/rooms/{{id}})");

    (
        StatusCode::CREATED,
        Json(json!({ "roomId": room_id, "lifetimeSeconds": MAX_ROOM_LIFETIME.as_secs() })),
    )
        .into_response()
}

/// Readiness/liveness probe for k8s: if the process responds over HTTP, it's
/// alive.
async fn healthz() -> &'static str {
    "ok"
}

/// Version of the deployed artifact (versioning-release.md standard):
/// APP_VERSION/GIT_COMMIT/BUILD_DATE are baked in by CI via Dockerfile
/// build-args. Clients can compare the version to detect version-skew (a
/// "refresh the page" banner — a hook for the future). A local `cargo run`
/// returns "dev".
async fn version_json() -> Json<serde_json::Value> {
    let env_or = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    Json(json!({
        "version": env_or("APP_VERSION", "dev"),
        "commit": env_or("GIT_COMMIT", "unknown"),
        "buildDate": env_or("BUILD_DATE", "unknown"),
    }))
}

/// Disallow caching of pages and static assets. Without this, Cloudflare
/// caches .css/.js at the edge by extension (the origin sent no
/// Cache-Control), and after a deploy browsers got OLD static assets paired
/// with new markup — pages looked broken until the edge TTL expired (caught
/// by a live check of production on 2026-07-12). The files are tiny,
/// unconditional no-cache is cheaper and more reliable than ETag machinery.
const NO_CACHE: (header::HeaderName, &str) = (header::CACHE_CONTROL, "no-cache");

/// Serve an HTML page from static/.
async fn page(name: &str) -> Response {
    match tokio::fs::read_to_string(format!("{}/{name}", *STATIC_DIR)).await {
        Ok(body) => ([NO_CACHE], Html(body)).into_response(),
        Err(e) => {
            tracing::error!("missing static file {name}: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "static file missing").into_response()
        }
    }
}

/// Serve an asset from static/ (js/css). No third-party crates: there are
/// only a handful of files, a full-blown ServeDir isn't needed.
async fn static_file(Path(path): Path<String>) -> Response {
    // Protection against escaping the directory.
    if path.contains("..") || path.contains('\\') {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }
    let content_type = match path.rsplit('.').next() {
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(format!("{}/{path}", *STATIC_DIR)).await {
        Ok(body) => ([(header::CONTENT_TYPE, content_type), (NO_CACHE.0, NO_CACHE.1)], body).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// H1 (ephemeral TURN credentials, see docs/security.md, "H1 — Ephemeral
/// TURN Credentials", and docs/self-hosting.md, "TURN (Optional)"): the
/// lifetime of each username/credential pair handed out by `/config` — an
/// hour is enough for a call (see `MAX_ROOM_LIFETIME` — rooms already don't
/// live longer than 3h by default anyway, and the call itself shouldn't
/// re-establish ICE every hour: once a TURN allocation is set up, the
/// client keeps refreshing it with the same credential it got at join
/// time). NOT enforced by the turn-rs server (see the caveat in
/// `ice_config` below) — the real lifetime bound of a leaked pair is set by
/// rotating `TURN_STATIC_SECRET`, not by this number.
const TURN_CRED_TTL_SECONDS: u64 = 3600;

/// Current unix time in seconds. `unwrap_or_default()` in case the clock is
/// before the epoch (shouldn't happen on a real server) — degrades to `0`,
/// which for TTL computation means "already expired", not a panic.
fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// `credential = base64(HMAC-SHA1(secret, username))` — exactly the TURN
/// REST API scheme (coturn-style long-term credentials,
/// draft-uberti-behave-turn-rest-00 §2.2) that turn-rs understands via
/// `auth.static-auth-secret` (verified against its source,
/// `codec::crypto::static_auth_secret` in mycrl/turn-rs, computes literally
/// the same thing before deriving the long-lived key
/// `MD5(username:realm:password)` from the result).
fn turn_hmac_credential(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC-SHA1 accepts a key of any length");
    mac.update(username.as_bytes());
    BASE64_STANDARD.encode(mac.finalize().into_bytes())
}

/// ICE configuration for the client: STUN always, TURN — if `TURN_URL` is
/// set (the turn-rs server runs separately, see
/// `deploy/manifests/turn.yaml`). With `embedded-turn` (see
/// `embedded_turn` module, docs/self-hosting.md "TURN (Optional)"), nothing
/// here changes: the operator simply points `TURN_URL` at this same host's
/// public IP on port 3478 — the embedded server IS the turn-rs this URL
/// resolves to, so credentials issued below (from `TURN_STATIC_SECRET`,
/// shared with `embedded_turn::spawn`) always match it.
///
/// H1 (formerly — an open relay): the server used to hand out a STATIC
/// `TURN_USERNAME`/`TURN_PASSWORD` to whoever called `/config` — the pair
/// was valid indefinitely, until an admin changed it by hand in two places
/// at once (turn-rs's Secret and this server's Secret) and restarted both —
/// anyone who grabbed it once could ride our TURN for their own traffic for
/// as long as they liked (stealing our hoster's bandwidth).
///
/// Now, if `TURN_STATIC_SECRET` is set, every call to `/config` gets its
/// OWN, separately computed pair:
///   - `username = "<unix-expiry-time>:chat"`;
///   - `credential = base64(HMAC-SHA1(TURN_STATIC_SECRET, username))`
///     (see `turn_hmac_credential`).
///
/// IMPORTANT, to be honest: turn-rs itself does NOT check this timestamp
/// baked into `username` — per its source
/// (`codec::crypto::static_auth_secret`), the comment there says outright
/// that the RFC doesn't require checking the timestamp and that keeping it
/// current is the external service's responsibility. So the TTL here is NOT
/// a hard boundary on the TURN server's side (a pair expired by its
/// timestamp will still pass HMAC verification and will still be able to
/// refresh an existing allocation, or even create a new one): it's (a) a
/// marker for auditing in turn-rs logs (`get_password: username=...`), and
/// (b) a unit synchronized with the PERIODIC ROTATION of
/// `TURN_STATIC_SECRET` — it's the secret rotation (not the embedded
/// timestamp) that, in one action, invalidates all previously issued pairs
/// at once, and now that only takes changing ONE value in ONE Secret,
/// rather than a login and password in two different places in sync. A
/// real server-side expiry check (turn-rs can do this too —
/// `auth.enable-hooks-auth` + `hooks.endpoint`, calling OUR webhook on every
/// `get_password`) is a separate phase, not done here.
///
/// Backward compatibility: if `TURN_STATIC_SECRET` isn't set, but the old
/// `TURN_USERNAME`/`TURN_PASSWORD` are — we hand those out as before (the
/// same static risk, we just haven't migrated to the secret yet). If
/// nothing at all is set — the client only gets STUN, as before.
async fn ice_config() -> Json<serde_json::Value> {
    let mut servers = vec![json!({ "urls": "stun:stun.l.google.com:19302" })];
    let static_secret = std::env::var("TURN_STATIC_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    if let Ok(url) = std::env::var("TURN_URL") {
        if !url.is_empty() {
            let mut turn = json!({ "urls": url });
            if let Some(secret) = &static_secret {
                let expiry = unix_now_secs() + TURN_CRED_TTL_SECONDS;
                let username = format!("{expiry}:chat");
                let credential = turn_hmac_credential(secret, &username);
                turn["username"] = json!(username);
                turn["credential"] = json!(credential);
            } else {
                // Backward-compatibility fallback — the old static pair.
                if let Ok(user) = std::env::var("TURN_USERNAME") {
                    turn["username"] = json!(user);
                }
                if let Ok(pass) = std::env::var("TURN_PASSWORD") {
                    turn["credential"] = json!(pass);
                }
            }
            servers.push(turn);
        }
    }
    // TURN over TLS on port 443 (TURNS/443) — the only path that works for
    // "443-only" networks (airport/hotel Wi-Fi that blocks everything but
    // outbound TCP 443; see docs/network-profiles.md, "Sofia Airport"). This
    // is additive to `TURN_URL` above: it's the same TURN realm/auth, just a
    // different transport/port, so it reuses the SAME `TURN_STATIC_SECRET`
    // and produces the SAME HMAC username/credential pair (recomputed here
    // since the expiry timestamp is embedded in the username and we want a
    // fresh one, but it's the identical secret + identical derivation as the
    // plain TURN entry above). Pushed last so the browser only falls back to
    // it after trying STUN and the regular TURN listener (udp/tcp) first.
    if let Ok(tls_url) = std::env::var("TURN_TLS_URL") {
        if !tls_url.is_empty() {
            let mut turn_tls = json!({ "urls": tls_url });
            if let Some(secret) = &static_secret {
                let expiry = unix_now_secs() + TURN_CRED_TTL_SECONDS;
                let username = format!("{expiry}:chat");
                let credential = turn_hmac_credential(secret, &username);
                turn_tls["username"] = json!(username);
                turn_tls["credential"] = json!(credential);
            } else {
                // Backward-compatibility fallback — the old static pair.
                if let Ok(user) = std::env::var("TURN_USERNAME") {
                    turn_tls["username"] = json!(user);
                }
                if let Ok(pass) = std::env::var("TURN_PASSWORD") {
                    turn_tls["credential"] = json!(pass);
                }
            }
            servers.push(turn_tls);
        }
    }
    Json(json!({ "iceServers": servers }))
}

/// `room` is valid per `^[a-z0-9]{8}$` (the same character set that
/// `state::generate_room_id` generates, plus digits 0/1, which the
/// generator doesn't use but which it doesn't hurt to accept in input
/// validation).
fn is_valid_room_id(room: &str) -> bool {
    room.len() == 8 && room.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// H1 (ephemeral TURN credentials): unit check of `turn_hmac_credential` and
/// the `username` format, without bringing up a server/turn-rs (for an
/// end-to-end check of the `/config` response format see docs/security.md,
/// "H1 — Ephemeral TURN Credentials" — curl a locally running server with a
/// test `TURN_STATIC_SECRET`).
#[cfg(test)]
mod turn_credential_tests {
    use super::*;

    #[test]
    fn hmac_credential_is_deterministic_valid_base64_and_input_sensitive() {
        let secret = "test-secret";
        let username = "1234567890:chat";

        let cred1 = turn_hmac_credential(secret, username);
        let cred2 = turn_hmac_credential(secret, username);
        assert_eq!(cred1, cred2, "the same input should produce the same credential");
        assert!(!cred1.is_empty());
        assert!(
            BASE64_STANDARD.decode(&cred1).is_ok(),
            "credential should be valid base64: {cred1:?}"
        );

        let cred_other_username = turn_hmac_credential(secret, "1234567891:chat");
        assert_ne!(
            cred1, cred_other_username,
            "a different username should produce a different credential"
        );

        let cred_other_secret = turn_hmac_credential("different-secret", username);
        assert_ne!(
            cred1, cred_other_secret,
            "a different secret should produce a different credential"
        );
    }

    #[test]
    fn username_format_is_expiry_colon_label_and_expiry_is_in_the_future() {
        let now = unix_now_secs();
        let expiry = now + TURN_CRED_TTL_SECONDS;
        let username = format!("{expiry}:chat");

        let (ts_part, label) = username
            .split_once(':')
            .expect("username should be of the form '<unix_ts>:label'");
        let ts: u64 = ts_part
            .parse()
            .expect("the part before ':' should parse as a unix timestamp");

        assert_eq!(label, "chat");
        assert!(ts > now, "expiry should be in the future relative to the generation moment");
        assert_eq!(ts - now, TURN_CRED_TTL_SECONDS);
    }
}
