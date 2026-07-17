//! Signaling message types (JSON over WebSocket).
//!
//! The server does NOT parse the contents of `sdp` / `candidate` — these are
//! opaque JSON values that are merely routed between peers.
//!
//! Protocol v2: symmetric room — all participants are equal (no
//! broadcaster/viewer), connect mesh-style, screen sharing is transient
//! room state (at most one sharer at a time).
//!
//! Protocol v3+ (F0/F1): chat travels EXCLUSIVELY over the mesh
//! RTCDataChannel directly between participants (see `static/rtc.js`/
//! `static/bus.js`/`static/chat.js`) — the server does not participate in
//! this path at all. The former addressed fallback chat relay through the
//! server has been removed (see docs/chat.md): chat is only possible once a
//! P2P/TURN connection is established, and until the bus opens, outgoing
//! messages wait in the client's local queue rather than going through the
//! server.
//!
//! Protocol v4 (permission system): a room now has a leader (`leaderId`) and
//! `settings` (guest permissions), optionally a wait room (`lobby_enabled`) —
//! see docs/permissions-and-leader.md for the model details.
//!
//! E2E model v2 ("variant E", see docs/research-p2p-key-handoff.md §6.5–6.6):
//! additive on top of the versions above. Each peer generates an ephemeral
//! ECDH key pair per tab and sends the public part (`epub`) in `join-room` —
//! the server does not parse it (opaque, like `sdp`/`candidate`), only caps
//! its length (see `crate::ws::sanitize_epub`) and relays it to the others
//! via `peers[]`/`peer-joined`/`join-request`/`waiting.leaderEpub`, so peers
//! can derive pairwise keys (forward secrecy). The participant's name now
//! travels as a SEPARATE encrypted `name-announce` message (rather than the
//! `name` field in `join-room`/`peer-joined` — that field is always sent/seen
//! as `null` by v2 clients, but is kept in the schema as an opaque value for
//! backward compatibility with v1).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Room settings: guest permissions + wait room toggle. Only the leader can
/// change these (`update-settings`), broadcast to all participants
/// (`settings-changed`) and to a new participant in `joined`. Everything is
/// allowed by default except the wait room (`lobby_enabled=false` — anyone
/// can enter without approval).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    #[serde(default)]
    pub lobby_enabled: bool,
    #[serde(default = "default_true")]
    pub guest_chat: bool,
    #[serde(default = "default_true")]
    pub guest_audio: bool,
    #[serde(default = "default_true")]
    pub guest_video: bool,
    #[serde(default = "default_true")]
    pub guest_screen: bool,
    /// The leader's own participant-count limit override (see
    /// docs/research-room-limit.md) — `None` (the default; old clients
    /// simply don't send it) means "follow the server-wide cap"
    /// (`crate::MAX_PARTICIPANTS`), which stays in effect alongside it
    /// anyway (see `crate::state::Room::effective_max_participants`).
    /// Validation happens only in `crate::ws::handle_update_settings`:
    /// `Some(n)` is accepted only if `2 <= n <= crate::MAX_PARTICIPANTS`,
    /// otherwise the whole `update-settings` is rejected entirely (`error`,
    /// nothing is applied) — the lower bound is 2, not 1, because a room
    /// with a limit of 1 would be pointless (the leader couldn't even let
    /// in a second person, themselves). Lowering the limit below the room's
    /// current occupancy does NOT kick out those already in — it only
    /// blocks subsequent `join-room`/`approve` calls (see
    /// `Room::effective_max_participants`).
    #[serde(default)]
    pub max_participants: Option<usize>,
}

fn default_true() -> bool {
    true
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self {
            lobby_enabled: false,
            guest_chat: true,
            guest_audio: true,
            guest_video: true,
            guest_screen: true,
            max_participants: None,
        }
    }
}

/// Client → server messages.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// A participant entering an already-existing room (the room is created
    /// ahead of time via `POST /api/rooms`). `name` is NOT used and NOT
    /// stored by the server (see docs/research-minimize-state.md §3,
    /// `crate::ws::handle_message` — the field is accepted and immediately
    /// dropped via `name: _`) — kept in the wire protocol schema only for
    /// deserialization backward compatibility (including with hypothetical
    /// old clients that still send it); for v2 clients the name travels as a
    /// separate encrypted `name-announce` (see the module comment above).
    ///
    /// `peer_id` — optional: the client passes its PREVIOUS peerId if
    /// reconnecting after a signaling drop (see the frontend auto-reconnect
    /// in `static/room.js`) — the other participants' mesh connections to
    /// this peerId are already set up and survive a signaling drop, so
    /// keeping the same id avoids having to rebuild the mesh. The server
    /// accepts it only if it's a valid UUID; if it's already held by an
    /// ACTIVE participant of the same room — this is a reconnect (see
    /// `crate::ws::reconnect_participant`), otherwise (not provided,
    /// invalid, or held by someone waiting in the lobby) it generates a new
    /// one as usual — so this extension is fully backward compatible with
    /// old clients and safe for new ones on collision.
    JoinRoom {
        room_id: String,
        #[serde(default)]
        #[allow(dead_code)] // dead field on the wire for compatibility, see comment above
        name: Option<String>,
        #[serde(default)]
        peer_id: Option<String>,
        /// One-time leader token issued by `POST /api/rooms` (see
        /// `AppState`/`main.rs::create_room`). If it matches the one stored
        /// in the room, the joining peer becomes the leader and the token is
        /// burned. `PUT /api/rooms/{id}` never issues a token at all — a
        /// restored room hands leadership to whoever joins first (see
        /// docs/permissions-and-leader.md).
        #[serde(default)]
        leader_token: Option<String>,
        /// E2E v2: this tab's ephemeral peer public key (ECDH P-256,
        /// base64url raw, ~87 chars) — opaque to the server, only relayed to
        /// the others (see the module comment above). Effectively mandatory
        /// for v2 clients, but the field is `Option` so an old client
        /// (without it) doesn't break the protocol — additive-only.
        #[serde(default)]
        epub: Option<String>,
    },
    /// SDP offer to any other peer in one's room.
    Offer { target_peer_id: String, sdp: Value },
    /// SDP answer to any other peer in one's room.
    Answer { target_peer_id: String, sdp: Value },
    /// ICE candidate (trickle) to any peer in one's room.
    IceCandidate { target_peer_id: String, candidate: Value },
    /// Opaque JSON; the server does not parse the contents of `info`, only
    /// relays it like an offer/answer/ICE — used by the frontend for
    /// auxiliary information between peers (e.g. matching audio tracks to
    /// names).
    StreamInfo { target_peer_id: String, info: Value },
    /// Request to start screen sharing: "last one wins" — if the screen is
    /// already held by someone else, the request is NOT rejected, it
    /// replaces the current owner (see `handle_share_start` in
    /// `src/ws.rs`); a room supports at most one sharer at a time, but it
    /// becomes whoever's request was processed by the server last. Guest
    /// permission (`guest_screen`) is checked as before — a permission
    /// denial is still a denial, the replacement logic only concerns
    /// ownership conflicts.
    ShareStart,
    /// Release the screen — accepted only from the current owner, silently
    /// ignored from anyone else.
    ShareStop,
    /// Change room settings (guest permissions + lobby). Leader only —
    /// `error` from anyone else. Applied wholesale (not a patch), broadcast
    /// to all participants as `settings-changed`.
    UpdateSettings { settings: RoomSettings },
    /// Let someone waiting into the room (lobby). Leader only.
    Approve { peer_id: String },
    /// Reject someone waiting — they get `join-rejected` and the server
    /// closes their socket. Leader only.
    Reject { peer_id: String },
    /// Explicit leave (equivalent to closing the socket).
    Leave,
    /// E2E v2: encrypted name announcement to a specific peer `to` — the
    /// server does not parse the contents of `payload` (opaque, like `sdp`),
    /// only relays it to the target as `ServerMessage::NameAnnounce`.
    /// Permissions (see `crate::ws::handle_name_announce`): a regular
    /// participant may send to any participant in their room; someone
    /// waiting in the lobby may send ONLY to the current leader (they have
    /// no access to the other participants at all). Caps: `payload` ≤ 2KB,
    /// counted against the common relay rate limit (the same one used for
    /// offer/answer/ICE/stream-info).
    NameAnnounce { to: String, payload: String },
}

/// Server → client messages.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// Reply to a participant on a successful `join-room`. `peers` — the
    /// OTHER already-connected participants of the room, `screen_owner` —
    /// who is currently sharing their screen (if anyone is).
    Joined {
        peer_id: String,
        peers: Vec<PeerInfo>,
        screen_owner: Option<String>,
        /// peerId of the room's current leader (see
        /// docs/permissions-and-leader.md).
        leader_id: String,
        /// Current room settings (guest permissions + lobby).
        settings: RoomSettings,
        /// Waiting for lobby approval — populated ONLY for the leader
        /// themselves (so they can immediately see who to approve/reject);
        /// everyone else gets an empty list.
        pending: Vec<PendingInfo>,
        /// Remaining lifetime of the room in seconds at the moment of
        /// joining (call duration limit — see docs/security.md, "Meeting
        /// Duration Ceiling"): `MAX_ROOM_LIFETIME_SECONDS` minus the room's
        /// age, clamped at 0 from below. The server measures age with a
        /// monotonic clock (`Instant`), so we send the client the REMAINDER
        /// rather than an absolute expiration time — the client has no way
        /// to map the server's `Instant` to its own clock.
        expires_in_seconds: u64,
        /// An additive field (does not replace `expires_in_seconds` above,
        /// both are present at the same time): how many seconds have passed
        /// since the moment the FIRST participant ever joined the room (see
        /// `crate::state::Room::first_joined_at`) — the source for the
        /// client's "how long has this call been going" count-up timer, as
        /// opposed to `expires_in_seconds` (a countdown to the duration
        /// limit). For the very first person to join, this is always `0`
        /// (the server sets `first_joined_at` immediately before computing
        /// this field, in the same call — see
        /// `crate::ws::admit_participant`). Old clients simply don't read
        /// this field.
        room_age_seconds: u64,
        /// The EFFECTIVE participant-count ceiling for THIS room (see
        /// `crate::state::Room::effective_max_participants`,
        /// docs/research-room-limit.md): either the server-wide ceiling (env
        /// `MAX_PARTICIPANTS`, recommended default 6 — see
        /// `crate::MAX_PARTICIPANTS` in `main.rs`), or, if the leader set
        /// their own (`RoomSettings::max_participants`), that value — the
        /// client displays both cases the same way, "Participants: N /
        /// <this value>" (see `static/room.js`), rather than a hardcoded
        /// "/ 6". Old clients simply don't read this field — doesn't change
        /// their behavior.
        max_participants: usize,
    },
    /// To the rest of the room's participants: a new participant connected.
    /// The server NO LONGER STORES `name` and always fills in `null` (see
    /// docs/research-minimize-state.md §3 — dead field, the name travels as
    /// a separate encrypted `name-announce`, see the module comment above);
    /// the field is kept on the wire for deserialization backward
    /// compatibility. `epub` — their ephemeral public key.
    PeerJoined {
        peer_id: String,
        name: Option<String>,
        epub: Option<String>,
    },
    /// To the rest of the room's participants: a participant left.
    PeerLeft { peer_id: String },
    /// To the target peer: an offer from another peer.
    Offer { from_peer_id: String, sdp: Value },
    /// To the target peer: an answer from another peer.
    Answer { from_peer_id: String, sdp: Value },
    /// To the target peer: an ICE candidate from another peer.
    IceCandidate { from_peer_id: String, candidate: Value },
    /// To the target peer: audio stream information from another peer
    /// (relay of `stream-info`, see `ClientMessage::StreamInfo`).
    StreamInfo { from_peer_id: String, info: Value },
    /// To all participants of the room (including the initiator — a single
    /// render path): screen sharing has started. If the screen was
    /// previously held by someone else, this same message is a takeover
    /// signal for THEM: the client compares `peer_id` against its own and,
    /// if it still has a live local screen capture, stops it itself (see
    /// `static/room.js`) — no separate message to the previous owner is
    /// needed, the broadcast already reaches everyone.
    ShareStarted { peer_id: String },
    /// To the `share-start` initiator only: the request was rejected due to
    /// permissions (`reason: "forbidden"` — the guest is not allowed
    /// `guest_screen` in the room settings). `busy_peer_id` is kept in the
    /// message shape for backward compatibility, but the server NEVER
    /// populates it anymore — a screen-ownership conflict is no longer
    /// rejected, it replaces the owner instead (see
    /// `ShareStart`/`ShareStarted`).
    ShareRejected {
        #[serde(skip_serializing_if = "Option::is_none")]
        busy_peer_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// To all participants of the room: screen sharing has ended (either an
    /// explicit `share-stop` by the owner or their disconnect).
    ShareStopped { peer_id: String },
    /// To a participant: the room already has the maximum number of
    /// participants.
    RoomFull,
    /// To a participant: the room doesn't exist (never created, not yet
    /// created, or already removed by the reaper after the empty room's TTL
    /// expired).
    RoomNotFound,
    /// To the sender: malformed request.
    Error { message: String },
    /// To someone waiting in the lobby (see `RoomSettings::lobby_enabled`):
    /// the join request was accepted by the server, awaiting the leader's
    /// decision (`approve`/`reject`). `leader_peer_id`/`leader_epub` (E2E
    /// v2) — the room's current leader and their ephemeral public key
    /// (nullable — the leader may not have sent an `epub`, e.g. an old
    /// client), so the waiting peer can encrypt a `name-announce` to them.
    /// On a leader change, while the request is still pending, the server
    /// sends the waiting peer a FRESH `waiting` with the new leader (see
    /// `crate::ws::cleanup_peer`) — the old key doesn't work for the new
    /// leader.
    Waiting {
        leader_peer_id: String,
        leader_epub: Option<String>,
    },
    /// To the leader: a new request to join a room with the lobby enabled.
    /// The server NO LONGER STORES `name` and always fills in `null` (see
    /// docs/research-minimize-state.md §3, the same dead wire tail as
    /// `PeerJoined::name`); `epub` — the waiting peer's ephemeral public key
    /// (E2E v2), needed by the leader to decrypt their `name-announce`.
    JoinRequest {
        peer_id: String,
        name: Option<String>,
        epub: Option<String>,
    },
    /// To the leader: someone waiting dropped off (closed the tab/socket)
    /// without waiting for a decision — the request was withdrawn on its
    /// own.
    JoinRequestCancelled { peer_id: String },
    /// To the waiting peer: the leader rejected the request — the server
    /// closes the socket immediately after this message.
    JoinRejected {},
    /// To all participants of the room: the leader changed the room
    /// settings.
    SettingsChanged { settings: RoomSettings },
    /// To all participants of the room: the leader changed (the previous
    /// one left, the server deterministically assigned the participant with
    /// the earliest `joined_at`).
    LeaderChanged { leader_id: String },
    /// To all participants AND those waiting in the lobby: the room has
    /// lived longer than `MAX_ROOM_LIFETIME_SECONDS` (see docs/security.md,
    /// "Meeting Duration Ceiling") — the reaper (`state::reap_rooms`) sends
    /// this message to everyone, then deletes the room entirely, regardless
    /// of whether it still has live participants. Like
    /// `room-full`/`room-not-found`/`join-rejected` — the server itself
    /// closes the socket immediately after this message (see
    /// `handle_socket`).
    RoomExpired {},
    /// To the target peer: a name announcement from another peer (relay of
    /// `name-announce`, see `ClientMessage::NameAnnounce`) — `payload` is an
    /// opaque ciphertext, the server does not parse it, only fills in
    /// `from`.
    NameAnnounce { from: String, payload: String },
}

/// One other participant of the room in the `Joined::peers` list. The
/// server NO LONGER STORES `name` (see docs/research-minimize-state.md §3)
/// — always `null`, the field is kept on the wire for deserialization
/// backward compatibility. `epub` (E2E v2) — their ephemeral public key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub name: Option<String>,
    pub epub: Option<String>,
}

/// One person waiting for lobby approval — in the `Joined::pending` list
/// (leader only); `JoinRequest` is a separate `ServerMessage` variant with
/// fields of the same meaning (doesn't reuse this struct directly, but
/// carries the same `epub`). `name` — the same dead wire tail as
/// `PeerInfo::name`, always `null`. `epub` (E2E v2) — the waiting peer's
/// ephemeral public key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInfo {
    pub peer_id: String,
    pub name: Option<String>,
    pub epub: Option<String>,
}
