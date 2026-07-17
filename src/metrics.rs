//! Prometheus metric names + their pre-registration.
//!
//! Same pattern as `code-ranker-backend` (see
//! `code-ranker-private/backend/src/metrics.rs`): each name is declared here
//! ONCE as a `pub const`, so a typo in the string literal doesn't silently
//! start a new, unrequested series instead of causing a compile error.
//! [`describe`] pre-registers each metric (name + HELP text) at startup
//! via `describe_gauge!`/`describe_counter!`, so `/metrics` carries
//! `# HELP`/`# TYPE` already before the first event — otherwise Grafana
//! panels show "No data" until the first matching event happens (relevant
//! mainly for gauges, which are only populated by the periodic sampler
//! below, see `crate::state::reap_rooms`).
//!
//! Units and cardinality follow
//! `simple-deploy/standards/observability/metrics.md`: name of the form
//! `chat_<what>_<unit>[_total]`, no labels with unbounded values
//! (roomId/peerId never end up here — the server has units of rooms anyway,
//! not thousands, a per-room breakdown isn't needed and isn't needed for
//! DoS protection either, only process-wide summary gauges).

use metrics::{describe_counter, describe_gauge, Unit};

/// Gauge. Current number of rooms in process memory (both alive and emptied
/// but not yet removed by the reaper). Updated by the sampler in
/// `state::reap_rooms` after each pass over the rooms (see its comment) —
/// not on every HTTP/WS request, so as not to add extra contention on the
/// hot path of `create_room`/`join-room`.
pub const ROOMS: &str = "chat_rooms";

/// Gauge. Total number of FULL participants across all rooms combined (not
/// counting those waiting in the lobby — see `PENDING` below). Same sampler
/// as `ROOMS`.
pub const PARTICIPANTS: &str = "chat_participants";

/// Gauge. Total number of participants waiting for approval in the lobby
/// across all rooms combined (`Room::pending`). Same sampler as
/// `ROOMS`/`PARTICIPANTS`.
pub const PENDING: &str = "chat_pending";

/// Counter. How many rooms were created over the process lifetime — both via
/// `POST /api/rooms` and via `PUT /api/rooms/{id}` when a room with that id
/// didn't exist yet (an actual record creation, not an idempotent
/// confirmation of one that already exists — see
/// `main.rs::create_room`/`restore_room`).
pub const ROOMS_CREATED_TOTAL: &str = "chat_rooms_created_total";

/// Gauge. Current number of open WS connections (see `ws::handle_socket`) —
/// counted BEFORE entering a room and after leaving it too (a connection may
/// be open but not yet have sent `join-room`, or may have already left the
/// room but not yet closed the socket) — that is, this is not the same as
/// `PARTICIPANTS`: the number of WS connections at any moment can be
/// somewhat higher than the number of room participants (lobby, `join-room`
/// not yet sent, disconnect after `leave`).
pub const WEBSOCKET_CONNECTIONS: &str = "chat_websocket_connections";

/// Pre-registers all the metrics above (name + HELP text) in the global
/// recorder. Called once at startup, BEFORE the first
/// `gauge!`/`counter!` — see the module comment.
pub fn describe() {
    describe_gauge!(ROOMS, Unit::Count, "Current number of rooms in process memory.");
    describe_gauge!(
        PARTICIPANTS,
        Unit::Count,
        "Total number of participants across all rooms combined."
    );
    describe_gauge!(
        PENDING,
        Unit::Count,
        "Total number of participants waiting for lobby approval across all rooms combined."
    );
    describe_counter!(
        ROOMS_CREATED_TOTAL,
        Unit::Count,
        "How many rooms were actually created (POST /api/rooms + PUT-restoration of a nonexistent one) over the process lifetime."
    );
    describe_gauge!(
        WEBSOCKET_CONNECTIONS,
        Unit::Count,
        "Current number of open WS connections (not the same as room participants)."
    );
}

/// Embedded TURN (optional, `embedded-turn` Cargo feature — see
/// `crate::embedded_turn`, docs/self-hosting.md "TURN (Optional)"):
/// pre-registers the forked turn-rs's own metric names (name + HELP text)
/// so `/metrics` carries them right away at startup — same rationale as
/// [`describe`] above. The metric NAMES themselves are owned by the
/// turn-rs fork (see its `metrics_facade.rs`, feature `metrics-facade`), not
/// declared here as `pub const`s like the ones above — they're emitted from
/// inside that crate, not from our own code, so there's no local call site
/// where a typo'd string literal could cause a silent new series the same
/// way `describe()`'s consts guard against.
///
/// `turn_relay_allocations` is a gauge that the fork only registers lazily,
/// on the first allocation/session (see `metrics_facade::on_register`) — we
/// additionally set it to `0.0` here so it's visible in `/metrics` even
/// before that happens, not just described.
#[cfg(feature = "embedded-turn")]
pub fn describe_embedded_turn() {
    describe_gauge!(
        "turn_relay_allocations",
        Unit::Count,
        "Number of currently active embedded TURN relay allocations/sessions."
    );
    describe_counter!(
        "turn_relayed_bytes_total",
        Unit::Bytes,
        "Bytes relayed by the embedded TURN server, labeled by transport and direction."
    );
    describe_counter!(
        "turn_relayed_packets_total",
        Unit::Count,
        "Packets relayed by the embedded TURN server, labeled by transport and direction."
    );
    describe_counter!(
        "turn_relay_errors_total",
        Unit::Count,
        "Packet-level errors in the embedded TURN server, labeled by transport."
    );
    metrics::gauge!("turn_relay_allocations").set(0.0);
}
