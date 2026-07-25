//! Room state, entirely in process memory. No storage on disk:
//! everything (participants, settings) lives exactly as long as the process
//! and the room itself are alive — a reaper pass or a restart wipes
//! everything without a trace. Chat (see `static/chat.js`) is not stored by
//! the server at all — history lives only in participants' tab memory,
//! there's no field or buffer for it here. Participant names aren't stored
//! by the server either (see `Participant`/`PendingParticipant` below,
//! docs/research-minimize-state.md §3) — the name travels as a separate
//! encrypted `name-announce` directly between peers.
//!
//! Synchronization choice: `std::sync::Mutex` over a `HashMap`, not a tokio
//! mutex and not an actor scheme. Rationale: all critical sections are short
//! and contain no `.await` (sending on an `UnboundedSender` is synchronous
//! and doesn't block, and removing stale rooms in the reaper is also a
//! purely synchronous operation over a `HashMap`), so a plain mutex is
//! simpler and faster than an async one, and contention at our scale (a
//! handful of rooms with ≤`MAX_PARTICIPANTS` participants each, default 6)
//! is negligible.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;

use crate::protocol::{RoomSettings, ServerMessage};

/// Ceiling on the number of participants in a room at once, if the env var
/// `MAX_PARTICIPANTS` isn't set (see `crate::MAX_PARTICIPANTS` in
/// `main.rs` — a `LazyLock`, the same trick as `MAX_ROOM_LIFETIME`/
/// `MAX_ROOMS`). This is a RECOMMENDED default, not a hard protocol ceiling
/// (protocol v2: symmetric room, the broadcaster/viewer roles no longer
/// exist, there can be as many participants as the server cares to allow) —
/// 6 was chosen because a room is a full WebRTC mesh (everyone sends media
/// to everyone else directly), and this is a reasonable comfort zone for
/// traffic/CPU ON THE CLIENT SIDE (n-1 outgoing copies for each) — the
/// server itself isn't strained by this number at all, it only relays
/// signaling. See docs/self-hosting.md, §6.
pub const DEFAULT_MAX_PARTICIPANTS: usize = 6;

/// Maximum number waiting for lobby approval at once (see
/// `RoomSettings::lobby_enabled`) — not room participants, a separate, more
/// generous limit so people aren't locked out in a crowd before a call
/// starts.
pub const MAX_PENDING: usize = 10;

/// How often the reaper checks rooms for staleness. Deliberately more often
/// than "once every 5 seconds" might seem to be enough: the empty-room TTL
/// in tests is 2 seconds, and with a less frequent tick, deletion easily
/// overruns the wait time tests allot for it. The overhead is negligible —
/// there are only a handful of rooms, and the check itself is a linear pass
/// over a `HashMap` under a short lock with not a single `.await`.
pub const REAPER_INTERVAL: Duration = Duration::from_secs(1);

/// Ceiling on the number of rooms at once, if the env var `MAX_ROOMS` isn't
/// set (H2, DoS protection: without a ceiling the rooms `HashMap` could grow
/// unbounded).
pub const DEFAULT_MAX_ROOMS: usize = 500;

/// Default call-duration limit, if the env var
/// `MAX_ROOM_LIFETIME_SECONDS` isn't set: 3 hours. See docs/security.md,
/// "Meeting Duration Ceiling".
pub const DEFAULT_MAX_ROOM_LIFETIME_SECONDS: u64 = 10800;

/// Per-IP limit on `POST /api/rooms` (and, sharing its budget, `PUT
/// /api/rooms/{id}` — see `main.rs::restore_room`): no more than this many
/// requests per window from a single IP. Production default — 3/60s
/// (deliberately strict: creating a room is a rare action for a legitimate
/// user, unlike, say, join-room; see also `PENDING_JOIN_IP_LIMIT` below for
/// why semantically adjacent limits have separate budgets).
///
/// The value is read from the env var `ROOM_CREATION_IP_LIMIT` in
/// `main.rs` (`crate::ROOM_CREATION_IP_LIMIT`, the same `LazyLock` trick as
/// `crate::JOIN_ROOM_IP_LIMIT`) — configurability here, as with
/// `JOIN_ROOM_IP_LIMIT`, exists for testability: signaling.test.mjs and the
/// e2e tests create lots of rooms from a single IP (localhost) per run and
/// would easily hit the strict production default of 3/60s — test servers
/// raise the limit via env far beyond what a file is capable of flooding,
/// and the production default itself is checked by a separate, isolated
/// server process with the real value (see the corresponding section of
/// signaling.test.mjs). `ROOM_CREATION_IP_WINDOW`, unlike the limit, is not
/// configurable — nobody asked to change the window, the raised limit is
/// enough for test servers.
pub const DEFAULT_ROOM_CREATION_IP_LIMIT: usize = 3;
pub const ROOM_CREATION_IP_WINDOW: Duration = Duration::from_secs(60);

/// Per-IP limit on entering the lobby (M3): its own map and budget, separate
/// from `ROOM_CREATION_IP_LIMIT` — rationale: creating a room and requesting
/// to join someone else's room (via a shared link) are actions of a
/// different nature for the same IP (e.g. one participant behind a shared
/// NAT opens several tabs with an invite) — a shared budget with room
/// creation would mean that someone storming one room's lobby could
/// accidentally exhaust the limit for creating THEIR OWN rooms as the same
/// person behind the same NAT, which is an excessive hit to legitimate use.
/// The numbers are the same (10 per 60s) — not because the mechanism is
/// shared, but because the same degree of "generosity" is reasonable for
/// both cases.
pub const PENDING_JOIN_IP_LIMIT: usize = 10;
pub const PENDING_JOIN_IP_WINDOW: Duration = Duration::from_secs(60);

/// Per-IP limit on a direct `join-room` INTO A ROOM (H2, DoS protection,
/// docs/research-dos.md §3.2 — "the main hole"): before this fix, a direct
/// join (lobby disabled, the default) wasn't checked at all — the only
/// check was the overall, NOT per-IP, room capacity
/// (`room.participants.len() >= MAX_PARTICIPANTS`), so a single IP could
/// open `MAX_PARTICIPANTS` WS connections and fill someone else's room via a
/// link in a fraction of a second, without formally violating anything. Its
/// own SEPARATE map and budget — the same rationale for separateness as
/// `PENDING_JOIN_IP_LIMIT` above: create-room/enter-lobby/direct-room-entry
/// are actions of a different nature for the same IP, a shared budget would
/// hit legitimate use of one of them when another is being flooded.
///
/// The value is read from the env var `JOIN_ROOM_IP_LIMIT` in `main.rs`
/// (`crate::JOIN_ROOM_IP_LIMIT`, the same `LazyLock` trick as
/// `crate::MAX_PARTICIPANTS`) — unlike `PENDING_JOIN_IP_LIMIT` below (still
/// hardcoded), configurability here is deliberately NOT for production
/// flexibility, but for testability: the test client can isolate the HTTP
/// endpoints (`POST`/`PUT /api/rooms`) by IP via the `CF-Connecting-IP`
/// header on each individual request (see `createRoom()` in
/// tests/signaling.test.mjs), while a WS handshake via the runtime's global
/// `WebSocket` (with no third-party packages) doesn't support arbitrary
/// headers at all — the only way to keep this limit from colliding with the
/// OTHER sections of the same file (which all share the same IP — the
/// socket peer address) is to raise the limit for the main test process via
/// env, and actually verify the limit itself in a separate, isolated server
/// process with the default value. `JOIN_ROOM_IP_WINDOW`, unlike the limit,
/// is not configurable — the raised limit is enough for the main test
/// process, the window doesn't matter as long as the limit is unreachable.
///
/// IMPORTANT — a reconnect does NOT count as a join for the purposes of
/// this budget: see `crate::ws::reconnect_participant` and the comment in
/// the `ClientMessage::JoinRoom` handler — if the presented `peerId`
/// already holds a full-participant slot of THIS SAME room (the typical
/// case — a client merely lost signaling briefly and reconnects faster than
/// the server's heartbeat detected the drop, see
/// docs/research-room-limit.md §4), this is handled via a separate path
/// BEFORE checking this limit and doesn't spend a single unit of it —
/// otherwise a legitimate reconnect could push itself out in a rare but
/// real case of rapid repeated signaling drops.
pub const DEFAULT_JOIN_ROOM_IP_LIMIT: usize = 20;
pub const JOIN_ROOM_IP_WINDOW: Duration = Duration::from_secs(60);

/// Per-IP limit on `GET /api/rooms/{id}` (the pre-join room preview — see
/// `main.rs::room_status`): its own map and budget, separate from all three
/// limits above, for the same reason they're separate from each other — this
/// is an action of a different nature again. Unlike room creation/joining,
/// this is a READ with no side effects, and the frontend is expected to poll
/// it roughly every 5 seconds while someone sits on the pre-join screen
/// deciding whether to enter (see docs on the pre-join UI) — reusing
/// `ROOM_CREATION_IP_LIMIT`'s budget (3/60s in production) would exhaust it
/// after a single poll or two and lock the same IP out of actually creating a
/// room. 240/60s (4/s) was picked as deliberately generous: it comfortably
/// covers 5s polling from several tabs/devices behind the same NAT at once
/// (a dozen tabs polling every 5s is still only ~144/60s), while still being
/// bounded enough that this endpoint can't be turned into an unthrottled
/// room-id probe (it reveals only occupancy/capacity/age, not anything
/// sensitive — see `room_status`'s doc comment — but even a yes/no
/// "does this room exist" oracle is worth rate-limiting).
///
/// The value is read from the env var `ROOM_STATUS_IP_LIMIT` in `main.rs`
/// (`crate::ROOM_STATUS_IP_LIMIT`, the same `LazyLock` trick as
/// `crate::JOIN_ROOM_IP_LIMIT`/`crate::ROOM_CREATION_IP_LIMIT`) —
/// configurability exists for the same testability reason as its neighbors.
/// `ROOM_STATUS_IP_WINDOW`, unlike the limit, is not configurable.
pub const DEFAULT_ROOM_STATUS_IP_LIMIT: usize = 240;
pub const ROOM_STATUS_IP_WINDOW: Duration = Duration::from_secs(60);

/// Channel for sending messages to a specific WebSocket connection. The
/// socket's writer reads from the paired `UnboundedReceiver`.
pub type PeerTx = mpsc::UnboundedSender<ServerMessage>;

/// One room participant: a channel for sending them messages + the moment
/// they joined (for deterministic selection of a new leader — see
/// `Room::leader_id` — when the previous leader leaves, the participant
/// with the earliest `joined_at` becomes leader) + an ephemeral public key
/// (E2E v2, see docs/research-p2p-key-handoff.md §6.5–6.6) — opaque to the
/// server, stored only so it can be handed to the other participants
/// (`peers[]`/`peer-joined`/`waiting.leaderEpub`); the server itself doesn't
/// parse or use it.
///
/// There is no longer a `name` field here (in v2 it was always
/// `None`/`null` — the name travels as a separate encrypted
/// `name-announce`, see the `protocol.rs` module comment; removed as dead
/// state, see docs/research-minimize-state.md §3). The wire fields
/// (`ClientMessage::JoinRoom::name`, `PeerInfo::name`,
/// `ServerMessage::PeerJoined::name`) remain in the protocol schema for
/// deserialization backward compatibility — the server no longer stores
/// them and always fills in `None`/`null` when building outgoing messages
/// (see `crate::ws::admit_participant`).
pub struct Participant {
    pub tx: PeerTx,
    pub epub: Option<String>,
    pub joined_at: Instant,
}

/// One person waiting for lobby approval (see
/// `RoomSettings::lobby_enabled`) — NOT a room participant (doesn't count
/// against the participant limit, lives in a separate map, `Room::pending`,
/// with its own limit `MAX_PENDING`). `epub` — same meaning as
/// `Participant::epub` (E2E v2) — handed to the leader in `join-request` so
/// they can accept a `name-announce` from the waiting peer.
///
/// `name` is also removed here — same rationale as `Participant` above.
pub struct PendingParticipant {
    pub tx: PeerTx,
    pub epub: Option<String>,
    pub joined_at: Instant,
}

/// A room: up to `crate::MAX_PARTICIPANTS` (env `MAX_PARTICIPANTS`,
/// recommended default 6 — see `DEFAULT_MAX_PARTICIPANTS`) equal
/// participants connecting mesh-style (the server itself doesn't touch
/// media — only signaling). At most one of the participants can be sharing
/// their screen at a time (`screen_owner`).
///
/// Permissions and leader (see docs/permissions-and-leader.md): exactly one
/// participant is the leader (`leader_id`); when they leave, the server
/// itself deterministically assigns a new one (the participant with the
/// earliest `joined_at`) — no quorum needed, membership and join order are
/// entirely server-side. `leader_token` — a one-time token from `POST
/// /api/rooms`; whoever presents it first in `join-room` becomes the leader
/// and burns the token; `PUT /api/rooms/{id}` never issues a token at all
/// (whoever joins a restored room first is the leader).
pub struct Room {
    pub participants: HashMap<String, Participant>,
    /// peerId of the participant currently sharing their screen (if anyone
    /// is).
    pub screen_owner: Option<String>,
    /// When the room became empty (the last participant left), or when it
    /// was created empty via `POST /api/rooms`. `None` as long as the room
    /// has at least one participant. The reaper deletes the room if it has
    /// been empty for longer than `EMPTY_ROOM_TTL` from this moment; a new
    /// `join-room` into a live (but marked) room clears the mark.
    pub emptied_at: Option<Instant>,
    /// peerId of the current leader. `None` only while the room has no
    /// participants at all (freshly created/restored/just-emptied room) —
    /// as soon as someone joins, a leader is assigned.
    pub leader_id: Option<String>,
    /// One-time leader token. `Some` until first presented with a valid
    /// `join-room.leaderToken` (burned immediately), or `None` from the
    /// start (room restored via `PUT`, without a token).
    pub leader_token: Option<String>,
    /// Room settings (guest permissions + lobby), only the leader changes
    /// them.
    pub settings: RoomSettings,
    /// Waiting for the leader's approval (lobby), by peerId. NOT room
    /// participants.
    pub pending: HashMap<String, PendingParticipant>,
    /// Moment the room was created/restored (call duration limit, see
    /// docs/security.md, "Meeting Duration Ceiling") — set on `POST
    /// /api/rooms` and on `PUT` restoration. For a restored room, the
    /// countdown runs from the moment of restoration, not from some
    /// original creation (memory of that doesn't survive a server restart)
    /// — this deliberately "extends" the room's life across a restart, the
    /// same trade-off as `emptied_at`/the empty-room TTL.
    pub created_at: Instant,
    /// Moment the FIRST participant, over the whole life of the room,
    /// joined — the source for the server-side `Joined::room_age_seconds`
    /// field (the frontend's "how long has this call been going" count-up
    /// timer, see `crate::ws::room_age_seconds`). `None` while nobody has
    /// joined the room yet; set EXACTLY ONCE (see
    /// `crate::ws::admit_participant`) and never changes afterward — even
    /// if the room becomes completely empty and fills up again within the
    /// empty-room TTL, the age countdown continues from the original first
    /// join rather than resetting: from the user's point of view it's the
    /// same (not recreated) room, and "how long have we been here" is
    /// reasonably measured from the first time anyone actually showed up,
    /// not from someone temporarily leaving and coming back. Like
    /// `created_at`, this moment doesn't survive a server restart — the room
    /// is recreated (`PUT /api/rooms/{id}`) from a blank slate, and the age
    /// countdown starts over from the first join after the restart — the
    /// same trade-off already described for `created_at`/`emptied_at`
    /// (ephemeral state, nothing to worry about).
    pub first_joined_at: Option<Instant>,
}

impl Room {
    /// Effective participant-count ceiling for THIS room (see
    /// docs/research-room-limit.md §2.2): the leader's own limit
    /// (`settings.max_participants`, `Some`), if they set one, otherwise —
    /// the server-wide ceiling (`crate::MAX_PARTICIPANTS`). Used EVERYWHERE
    /// instead of comparing directly against `crate::MAX_PARTICIPANTS` — on
    /// `join-room` (`src/ws.rs`), on `approve` (`handle_approve`), and in
    /// `Joined::max_participants` (`admit_participant`). If the leader
    /// lowered the limit below current occupancy — this isn't some separate
    /// state, it just means that ANY subsequent entry
    /// (`join-room`/`approve`) will be rejected until the roster naturally
    /// thins out on its own (see research §2.2 — the server never kicks out
    /// those already in).
    pub fn effective_max_participants(&self) -> usize {
        self.settings.max_participants.unwrap_or(*crate::MAX_PARTICIPANTS)
    }

    /// Seconds since this room was created (or last restored via `PUT
    /// /api/rooms/{id}`) — i.e. `created_at.elapsed()`. Used by `GET
    /// /api/rooms/{id}` (`main.rs::room_status`, the pre-join preview) as the
    /// room's "age" shown to someone who hasn't joined yet.
    ///
    /// Deliberately NOT the same notion of age as
    /// `crate::ws::room_age_seconds` (which backs `Joined::room_age_seconds`,
    /// the in-room count-up timer): that one counts from `first_joined_at`
    /// and reads `0` for as long as nobody has ever joined — exactly wrong
    /// for a pre-join preview, whose whole point is to show something
    /// meaningful (and ticking) for a room that's sitting empty right after
    /// `POST /api/rooms`, before anyone has joined at all. This method uses
    /// `created_at` instead, which is set the moment the room record itself
    /// is created/restored, so it starts advancing immediately. Once someone
    /// has actually joined, the two numbers are close (they diverge only by
    /// however long the room sat empty before its first participant showed
    /// up) but are still answering different questions on purpose — this one
    /// intentionally is NOT merged with `room_age_seconds` in ws.rs.
    pub fn age_seconds(&self) -> u64 {
        self.created_at.elapsed().as_secs()
    }
}

/// Shared state of all rooms.
pub type SharedRooms = Arc<Mutex<HashMap<String, Room>>>;

/// Sliding window of timestamps by IP: how many times this IP has knocked
/// in the last `window`. A shared type for both per-IP limits (room
/// creation, lobby requests) — see `check_ip_rate_limit`.
pub type IpRateLimitMap = Arc<Mutex<HashMap<String, VecDeque<Instant>>>>;

/// Application state, shared between all axum handlers: rooms entirely in
/// memory, no external storage.
#[derive(Clone)]
pub struct AppState {
    pub rooms: SharedRooms,
    /// Ceiling on the number of rooms at once (H2, DoS protection) — env
    /// `MAX_ROOMS`, default see `DEFAULT_MAX_ROOMS`. `POST /api/rooms` and
    /// `PUT` restoration respond with `503` once it's reached.
    pub max_rooms: usize,
    /// Per-IP limit on `POST /api/rooms` (H2, DoS protection): its own map
    /// and budget, separate from `pending_join_ips` — see the comment on
    /// `PENDING_JOIN_IP_LIMIT` for why the budgets aren't shared.
    pub room_creation_ips: IpRateLimitMap,
    /// Per-IP limit on entering the lobby (M3, so the lobby can't be
    /// flooded) — its own map, a budget separate from `room_creation_ips`.
    pub pending_join_ips: IpRateLimitMap,
    /// Per-IP limit on directly `join-room`-ing into a room (H2,
    /// docs/research-dos.md §3.2 — "the main hole") — its own map, a budget
    /// separate from both `room_creation_ips` and `pending_join_ips` (see
    /// `DEFAULT_JOIN_ROOM_IP_LIMIT` above).
    pub join_room_ips: IpRateLimitMap,
    /// Per-IP limit on `GET /api/rooms/{id}` (the pre-join room preview) —
    /// its own map, a deliberately generous budget separate from all three
    /// above (see `DEFAULT_ROOM_STATUS_IP_LIMIT` for why this endpoint can't
    /// share any of their budgets: it's polled every few seconds from the
    /// pre-join screen, before the visitor has done anything else).
    pub room_status_ips: IpRateLimitMap,
    /// Channel for the active shutdown broadcast notification (SIGTERM/
    /// SIGINT, see `crate::shutdown_signal`) — every `ws::handle_socket`
    /// subscribes to it at startup (`subscribe()`) and, upon receiving the
    /// signal, sends a `Close` on its own socket and ends its loop, instead
    /// of passively living until `terminationGracePeriodSeconds`/`SIGKILL`
    /// (see docs/research-ops.md §1.0/§1.6 — a "cheap improvement", ~30-40s
    /// of signaling downtime during an active call at deploy time is cut
    /// down to a fraction of a second). `broadcast`, not `watch`/`Notify`:
    /// what's needed is a one-time "time to shut down" notification for
    /// every subscriber, not current state.
    pub shutdown: ShutdownSignal,
}

/// See `AppState::shutdown`.
pub type ShutdownSignal = tokio::sync::broadcast::Sender<()>;

/// Send a message to a peer; an error (the peer already dropped off) is
/// deliberately ignored — its own socket handler will do the cleanup.
pub fn send_to(tx: &PeerTx, msg: ServerMessage) {
    let _ = tx.send(msg);
}

/// Internal peer identifier — a plain UUID.
pub fn generate_peer_id() -> String {
    Uuid::new_v4().to_string()
}

/// Short human-readable roomId for URLs: 8 characters from an alphabet with
/// no look-alike characters (no 0/o, 1/l/i). Entropy is drawn from a
/// UUIDv4, to avoid pulling in a separate rand crate.
pub fn generate_room_id() -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Background task: once every `REAPER_INTERVAL`, walks all rooms and
/// deletes:
///   - any room older than `max_lifetime` (the call duration limit, see
///     docs/security.md, "Meeting Duration Ceiling") — REGARDLESS of
///     whether it has participants: before deleting it, sends
///     `room-expired` to all participants AND everyone waiting in the lobby
///     (their socket's writer will close the connection itself right after
///     this message, see `ws.rs::handle_socket`);
///   - rooms that are empty (no participants at all) for longer than
///     `empty_ttl` — as before, without a broadcast (there are no
///     participants left there, and `pending` is already empty at this
///     point — see `ws::cleanup_peer`, it's drained when the room becomes
///     empty).
///
/// Concurrency invariant: the whole pass over the rooms is synchronous
/// (`HashMap::retain`), the lock is held only for the duration of the pass
/// itself, with no `.await` inside the critical section (the `send_to`
/// broadcast is just an `UnboundedSender::send`, it doesn't block or wait).
///
/// While at it (after `retain`, under the same lock — see the rationale
/// below), it also recomputes and sets the `chat_rooms`/`chat_participants`/
/// `chat_pending` gauges (see `crate::metrics`). Doing it HERE rather than
/// on every `create_room`/`join-room`/`cleanup_peer`: the reaper already
/// takes the lock on the whole set of rooms once every `REAPER_INTERVAL`
/// and does a linear pass over all of it — tallying up
/// `participants.len()`/`pending.len()` sums over already-open records
/// costs essentially nothing extra, whereas updating three gauges on every
/// single connect/disconnect would mean an extra `metrics::gauge!` (an
/// atomic operation, but there are many of them) on a much hotter path, with
/// no visible benefit: Prometheus scrapes every few seconds regardless, and
/// a one-second update delay from `REAPER_INTERVAL` (1s) is imperceptible
/// for a dashboard.
pub async fn reap_rooms(rooms: SharedRooms, empty_ttl: Duration, max_lifetime: Duration) {
    let mut interval = tokio::time::interval(REAPER_INTERVAL);
    loop {
        interval.tick().await;
        let mut rooms_guard = rooms.lock().unwrap();
        rooms_guard.retain(|room_id, room| {
            if room.created_at.elapsed() >= max_lifetime {
                info!(room = %room_id, "room older than the call duration limit — removed by reaper (room-expired)");
                for p in room.participants.values() {
                    send_to(&p.tx, ServerMessage::RoomExpired {});
                }
                for p in room.pending.values() {
                    send_to(&p.tx, ServerMessage::RoomExpired {});
                }
                return false;
            }
            let expired_empty = room.participants.is_empty()
                && room.emptied_at.is_some_and(|t| t.elapsed() >= empty_ttl);
            if expired_empty {
                info!(room = %room_id, "room empty longer than TTL — removed by reaper");
            }
            !expired_empty
        });

        let mut participants_total = 0usize;
        let mut pending_total = 0usize;
        for room in rooms_guard.values() {
            participants_total += room.participants.len();
            pending_total += room.pending.len();
        }
        ::metrics::gauge!(crate::metrics::ROOMS).set(rooms_guard.len() as f64);
        ::metrics::gauge!(crate::metrics::PARTICIPANTS).set(participants_total as f64);
        ::metrics::gauge!(crate::metrics::PENDING).set(pending_total as f64);
    }
}

/// Client IP for per-IP limits (H2/M3): `CF-Connecting-IP` (Cloudflare
/// fills in the real client IP even through its own proxy/tunnel) →
/// fallback to the first address in `X-Forwarded-For` (in case of another
/// reverse proxy in front of the server) → fallback to the socket peer
/// address (direct connection without a proxy — e.g. a local run). Not a
/// strict defense against spoofing (a client or an untrusted proxy can send
/// any `CF-Connecting-IP`), but that's enough for a rate limit — the goal
/// isn't authentication, just cutting off crude flooding from a single
/// address.
pub fn extract_client_ip(headers: &HeaderMap, peer_addr: Option<SocketAddr>) -> String {
    if let Some(ip) = headers
        .get("CF-Connecting-IP")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return ip.to_string();
    }
    if let Some(ip) = headers
        .get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return ip.to_string();
    }
    peer_addr
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Sliding counter by IP: no more than `limit` hits per `window` from a
/// single IP. The same trick as the chat rate limit in `ws.rs`
/// (`VecDeque<Instant>`), but at the level of the whole `AppState` rather
/// than a single connection, and indexed by IP rather than by connection —
/// used for `POST /api/rooms` (`room_creation_ips`) and entering the lobby
/// (`pending_join_ips`).
///
/// While at it, also cleans the map of IPs whose timestamps have all gone
/// stale — otherwise it would grow forever in the number of DISTINCT IPs
/// that have ever knocked even once. A full pass over the map on every call
/// is a deliberately simple choice: at this project's scale (a personal
/// server, a handful to a few dozen concurrent IPs) it's cheaper than a
/// separate background cleanup task.
pub fn check_ip_rate_limit(map: &IpRateLimitMap, ip: &str, limit: usize, window: Duration) -> bool {
    let now = Instant::now();
    let mut guard = map.lock().unwrap();
    guard.retain(|_, times| {
        while let Some(&oldest) = times.front() {
            if now.duration_since(oldest) > window {
                times.pop_front();
            } else {
                break;
            }
        }
        !times.is_empty()
    });
    let times = guard.entry(ip.to_string()).or_default();
    if times.len() >= limit {
        return false;
    }
    times.push_back(now);
    true
}
