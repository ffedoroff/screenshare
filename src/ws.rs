//! Handling WebSocket connections: signaling relay and room lifecycle.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::protocol::{ClientMessage, PeerInfo, PendingInfo, RoomSettings, ServerMessage};
use crate::state::{
    check_ip_rate_limit, extract_client_ip, generate_peer_id, send_to, AppState, IpRateLimitMap,
    PendingParticipant, Participant, PeerTx, Room, SharedRooms, JOIN_ROOM_IP_WINDOW, MAX_PENDING,
    PENDING_JOIN_IP_LIMIT, PENDING_JOIN_IP_WINDOW,
};

/// E2E v2 (see docs/research-p2p-key-handoff.md §6.5–6.6): maximum length of
/// `epub` (the peer's ephemeral public key, ECDH P-256, base64url raw) in
/// characters. The server does NOT parse it (opaque, like `sdp`) — it only
/// caps the size: a real `epub` fits in ~87 chars (65 raw bytes in
/// base64url), 200 is a generous margin for a future curve/format change
/// without an immediate server-side fix. A too-long value isn't truncated
/// (a truncated key is meaningless and still won't let you derive the
/// correct shared secret) — it's dropped entirely, as if the client hadn't
/// sent `epub` at all (see `sanitize_epub`).
const EPUB_MAX_CHARS: usize = 200;

/// E2E v2: maximum size of a single `name-announce`'s `payload` in bytes —
/// the encrypted name (base64: iv + AES-256-GCM ciphertext), with a large
/// margin even for long names at the input's upper `maxlength` bound (see
/// static/room.html) — 2KB is clearly excessive for a single name, but
/// doesn't open a channel for pumping arbitrary amounts of data under the
/// guise of a name announcement.
const NAME_ANNOUNCE_MAX_BYTES: usize = 2 * 1024;

/// H2 (DoS protection): maximum size of a single offer/answer/ice-candidate/
/// stream-info relay's serialized payload (`sdp`/`candidate`/`info`
/// respectively) in bytes. The server doesn't parse these fields (opaque
/// JSON), but must still cap their size — otherwise the relay turns into a
/// free channel for pumping arbitrary amounts of data through the server
/// under the guise of signaling.
const RELAY_MAX_BYTES: usize = 16 * 1024;

/// H2 (DoS protection): a sliding rate-limit window for ALL relays of a
/// single connection combined — offer/answer/ice-candidate/stream-info
/// together, one shared counter. Rationale for combining them (rather than
/// a separate counter per type): the attack vector is the same (flooding
/// messages from a single connection) regardless of which relay type is
/// used — separate counters would let an attacker bypass one type's limit
/// simply by alternating message types. Chat isn't counted here at all —
/// the server doesn't participate in chat, it travels only over the mesh
/// RTCDataChannel directly between participants (see `crate::protocol`,
/// docs/chat.md §12). This limit (100/10s) primarily guards against
/// flooding with ICE candidates (there can legitimately be many of them
/// while a connection is being set up — 100 per 10s should comfortably
/// cover normal trickle-ICE).
const RELAY_RATE_LIMIT: usize = 100;
const RELAY_RATE_WINDOW: Duration = Duration::from_secs(10);

/// H2 (DoS protection): limits on the WS frame/message itself — independent
/// of the application-level limits above, at the protocol level. Our
/// largest legitimate frame — an offer with several media lines — comes in
/// an order of magnitude under this limit; anything larger is treated as an
/// attack, and axum itself tears down the connection without letting the
/// frame reach the application.
const WS_MAX_MESSAGE_SIZE: usize = 64 * 1024;
const WS_MAX_FRAME_SIZE: usize = 64 * 1024;

/// Server-side ping/pong heartbeat: how often we ping the client ourselves.
///
/// Why: a TCP connection can drop silently, with no FIN/RST (the client's
/// Wi-Fi died, the laptop went to sleep, there's a NAT/load balancer between
/// us and the client that silently dropped its state) — `socket.recv()` in
/// that case won't return an error or `None` for a very long time: the drop
/// only gets detected via the operating system's TCP timeout, which is
/// minutes. An active ping/pong catches such a drop within seconds to a few
/// dozen seconds instead of minutes — the existing `cleanup_peer` then
/// takes care of the cleanup (the room is freed up, the other peers find
/// out).
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// If `MAX_MISSED_PONGS` pings in a row have been sent with NOT A SINGLE
/// pong received in response (and nothing at all from the client during
/// that time) — we consider the connection dead and tear it down ourselves.
const MAX_MISSED_PONGS: u32 = 2;

/// What this connection is registered as in the room.
#[derive(Debug, Clone)]
struct PeerCtx {
    room_id: String,
    peer_id: String,
}

/// RAII guard for the `chat_websocket_connections` gauge (see
/// `crate::metrics`): increment in `new()` (on WS upgrade), guaranteed
/// decrement in `Drop` — the same trick described at
/// `crate::metrics::WEBSOCKET_CONNECTIONS` and used for
/// `code_ranker_sse_clients` in code-ranker-backend (RAII rather than a
/// paired manual increment/decrement, so an early `return`/panic in
/// `handle_socket` doesn't leave the gauge permanently inflated).
struct WsConnectionGaugeGuard;

impl WsConnectionGaugeGuard {
    fn new() -> Self {
        ::metrics::gauge!(crate::metrics::WEBSOCKET_CONNECTIONS).increment(1.0);
        Self
    }
}

impl Drop for WsConnectionGaugeGuard {
    fn drop(&mut self) {
        ::metrics::gauge!(crate::metrics::WEBSOCKET_CONNECTIONS).decrement(1.0);
    }
}

/// Sliding rate-limit window for a single connection — shared across all
/// relays combined (`RELAY_RATE_LIMIT`). Kept in a struct (rather than a
/// bare field) so it's easy to add more windows here later if needed.
#[derive(Default)]
struct RateLimits {
    relay_times: VecDeque<Instant>,
}

/// What to do with the connection after handling a message.
#[derive(PartialEq)]
enum Flow {
    Continue,
    /// Close the socket (after the writer has flushed everything queued).
    Stop,
}

/// Phase 2 (see src/main.rs, "Phase 2 topology"): cross-origin WebSocket
/// works even WITHOUT a single CORS header (browsers don't apply
/// same-origin policy to a WS handshake the way they do to fetch) — but
/// since the frontend and API CAN now live on different hosts, it doesn't
/// hurt to optionally check against the same allow-list `CORS_ORIGIN` as
/// the HTTP endpoints (see `crate::CORS_ORIGIN`, `crate::cors_middleware`).
/// If `CORS_ORIGIN` isn't set (the default — local dev and current
/// production, frontend and API still on one host) — there's no check at
/// all, behavior as before. If it is set and the incoming `Origin` doesn't
/// match — `403`, no upgrade.
pub async fn ws_handler(
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    if let Some(allowed) = crate::CORS_ORIGIN.as_deref() {
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if origin != Some(allowed) {
            warn!(?origin, allowed, "WS handshake with a mismatched Origin rejected");
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    let ip = extract_client_ip(&headers, Some(peer_addr));
    // H2 (DoS protection): a cap on WS message/frame size — see
    // WS_MAX_MESSAGE_SIZE above. Verified against axum 0.8's actual API
    // (`WebSocketUpgrade::max_message_size`/`max_frame_size`,
    // src/extract/ws.rs) — not made up.
    ws.max_message_size(WS_MAX_MESSAGE_SIZE)
        .max_frame_size(WS_MAX_FRAME_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, state, ip))
}

/// One WS connection = one tokio task. Outgoing messages to the peer travel
/// through an mpsc channel: other tasks push into the channel, while only
/// this task ever writes to the socket (the select below) — this rules out
/// write races.
async fn handle_socket(mut socket: WebSocket, state: AppState, ip: String) {
    // `chat_websocket_connections` (see `crate::metrics`): increment/
    // decrement directly here, rather than via a periodic sampler (like
    // `chat_rooms`/`chat_participants`/`chat_pending`, see
    // `state::reap_rooms`) — this is a connection, not a room, there's no
    // separate lock on shared state here, and the event (connect/
    // disconnect) is rare relative to the WS messages themselves, so it
    // doesn't add meaningful contention. `guard()` fires the decrement on
    // `Drop` (including on any early `return`/panic further down the
    // function) — we don't rely on an explicit decrement at the end.
    let _ws_gauge_guard = WsConnectionGaugeGuard::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    // This connection's room/peer; None until join-room.
    let mut me: Option<PeerCtx> = None;
    // Set when the outgoing queue needs to be flushed and the socket closed.
    let mut closing = false;
    // Both sliding rate-limit windows for this connection (chat-specific
    // and the shared relay one) are grouped into a single struct — see
    // `RateLimits`.
    let mut rate_limits = RateLimits::default();

    // C (docs/research-ops.md §1.0/§1.6, see `crate::shutdown_signal`):
    // subscription to the shutdown broadcast notification — on SIGTERM/
    // SIGINT the server itself actively closes this connection (see the
    // select below), instead of passively living until
    // `terminationGracePeriodSeconds`/`SIGKILL`.
    let mut shutdown_rx = state.shutdown.subscribe();

    // Heartbeat: ticks every PING_INTERVAL, sends Message::Ping. axum
    // itself replies with a Pong to INCOMING Pings (we don't need to do
    // anything for that), while incoming Pongs (a reply to OUR ping)
    // arrive in socket.recv() below as Message::Pong — we count those.
    // missed_pongs grows on every ping sent and resets to 0 on any incoming
    // message from the client (including a pong) — meaning the client is
    // alive, whatever it responds with.
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.tick().await; // the first tick is instant, doesn't count
    let mut missed_pongs: u32 = 0;

    loop {
        tokio::select! {
            // C: the server is going down on SIGTERM/SIGINT — close the
            // socket actively RIGHT NOW, rather than passively waiting for
            // `terminationGracePeriodSeconds` (30s)/`SIGKILL` (see
            // docs/research-ops.md §1.0/§1.6). The client catches the
            // `Close` immediately and goes into its usual auto-reconnect.
            // The result of `recv()` (Ok/Err/Lagged) doesn't matter —
            // either way it's time to shut down; `Err` is only possible if
            // the sender has already been dropped (the server is already
            // nearly stopped) — also a signal to shut down.
            _ = shutdown_rx.recv() => {
                debug!("shutdown signal received — actively closing the WS");
                let _ = socket.send(Message::Close(Some(CloseFrame {
                    code: axum::extract::ws::close_code::RESTART,
                    reason: "server restarting, please reconnect".into(),
                }))).await;
                break;
            }

            // Heartbeat: once every PING_INTERVAL. If two pings in a row
            // went out with not a single reply (neither a pong nor
            // anything at all from the client) — we consider the
            // connection dead and tear it down ourselves, without waiting
            // for the TCP timeout.
            _ = ping_interval.tick() => {
                if missed_pongs >= MAX_MISSED_PONGS {
                    debug!("client not responding to pings ({missed_pongs} in a row with no reply) — considering the connection dead");
                    break;
                }
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break; // socket is already dead — cleanup below
                }
                missed_pongs += 1;
            }

            // Outgoing messages to this peer.
            out = rx.recv() => {
                // None is impossible while our own `tx` is alive, but we
                // handle it gracefully anyway.
                let Some(msg) = out else { break };
                // After a rejection, the server closes the socket itself
                // (edge case #3/#4; JoinRejected — the leader's rejection
                // of someone waiting in the lobby).
                let reject = matches!(
                    msg,
                    ServerMessage::RoomFull
                        | ServerMessage::RoomNotFound
                        | ServerMessage::JoinRejected {}
                        | ServerMessage::RoomExpired {}
                );
                let text = match serde_json::to_string(&msg) {
                    Ok(t) => t,
                    Err(e) => { warn!("ServerMessage serialization: {e}"); continue }
                };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break; // socket died — cleanup below
                }
                if reject {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                // An explicit `leave`: we've flushed everything that was
                // queued, now exit.
                if closing && rx.is_empty() {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }

            // Incoming messages from the client.
            inbound = socket.recv() => {
                // Any incoming message is a sign the client is alive: reset
                // the missed-pong counter. This applies to Message::Pong
                // (a reply to our ping, axum hands it to us here as an
                // ordinary frame) as well as everything else (Text/Binary/
                // the client's own incoming Ping, etc.).
                if matches!(inbound, Some(Ok(_))) {
                    missed_pongs = 0;
                }
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(msg) => {
                                let flow = handle_message(
                                    msg, &mut me, &tx, &state.rooms, &mut rate_limits,
                                    &ip, &state.pending_join_ips, &state.join_room_ips,
                                );
                                if flow == Flow::Stop {
                                    // Don't tear it down right away: let the
                                    // writer flush the queue first.
                                    closing = true;
                                    if rx.is_empty() {
                                        let _ = socket.send(Message::Close(None)).await;
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                debug!("malformed client message: {e}");
                                send_to(&tx, ServerMessage::Error {
                                    message: format!("bad message: {e}"),
                                });
                            }
                        }
                    }
                    // Socket closed or dropped (edge case #8).
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // An incoming Ping from the client — axum replies with
                    // a Pong itself, we don't need to do anything. A
                    // Message::Pong (reply to OUR heartbeat ping) has
                    // already been accounted for by resetting missed_pongs
                    // above — here, like binary frames further on, it's
                    // simply ignored.
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    // Cleanup on any outcome: leave, close, drop. `&tx` — see
    // `cleanup_peer`: needed to distinguish "this connection still owns its
    // slot" from "the slot has already been taken over by another
    // connection's reconnect" (see `reconnect_participant`/tasks A/D).
    if let Some(ctx) = me {
        cleanup_peer(&ctx, &state.rooms, &tx);
    }
}

/// Handling of a single client message. Entirely synchronous: all state is
/// in memory under a `std::sync::Mutex`, no I/O to disk or external
/// storage.
fn handle_message(
    msg: ClientMessage,
    me: &mut Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    rate_limits: &mut RateLimits,
    ip: &str,
    pending_join_ips: &IpRateLimitMap,
    join_room_ips: &IpRateLimitMap,
) -> Flow {
    match msg {
        // `name` is deliberately not bound (`name: _`): the server no
        // longer stores or uses it — see docs/research-minimize-state.md
        // §3, the comment at `crate::state::Participant`. The field remains
        // in the protocol schema only for deserialization backward
        // compatibility.
        ClientMessage::JoinRoom { room_id, name: _, peer_id, leader_token, epub } => {
            if me.is_some() {
                send_to(tx, err("already in a room"));
                return Flow::Continue;
            }
            let epub = sanitize_epub(epub);

            let mut rooms_guard = rooms.lock().unwrap();
            let Some(room) = rooms_guard.get_mut(&room_id) else {
                send_to(tx, ServerMessage::RoomNotFound); // room was never created or already removed by the reaper
                return Flow::Continue; // the writer will close the socket
            };

            // A/D: a reconnect with ONE'S OWN previous peerId, which is
            // RIGHT NOW holding a full-participant slot in this same room —
            // see `reconnect_participant` for the detailed rationale.
            // Handled BEFORE the join-room per-IP limit (A) and BEFORE
            // room-full/effective-limit (D): this is not a new entry, but
            // the same participant with a new signaling connection, so it
            // shouldn't spend anyone's budget nor trip over a limit it's
            // already occupying a slot of.
            if let Some(id) = peer_id.as_deref() {
                if Uuid::parse_str(id).is_ok() && room.participants.contains_key(id) {
                    let peer_id = id.to_string();
                    reconnect_participant(room, &room_id, &peer_id, tx.clone());
                    drop(rooms_guard);
                    *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
                    return Flow::Continue;
                }
            }

            // A (H2, DoS protection, docs/research-dos.md §3.2 — "the main
            // hole"): a per-IP limit on the very act of JoinRoom, a budget
            // separate from ROOM_CREATION_IP_LIMIT/PENDING_JOIN_IP_LIMIT
            // (see DEFAULT_JOIN_ROOM_IP_LIMIT in state.rs). Checked here,
            // BEFORE branching into lobby/direct entry — so entering the
            // lobby spends both this budget and PENDING_JOIN_IP_LIMIT
            // below; that's not a bug, it's a deliberately redundant
            // safeguard (separate maps, they don't share a counter) in
            // favor of a single simple check point.
            if !check_ip_rate_limit(join_room_ips, ip, *crate::JOIN_ROOM_IP_LIMIT, JOIN_ROOM_IP_WINDOW) {
                send_to(tx, err("too many join attempts from your network, try again later"));
                drop(rooms_guard);
                return Flow::Stop;
            }

            // The client-supplied peerId (reconnecting after a signaling
            // drop, see ClientMessage::JoinRoom) — accepted only if it's a
            // valid UUID and still free in this room (neither among
            // participants nor among those waiting in the lobby; one
            // already held by a participant is already handled above as a
            // reconnect); otherwise, as before, we generate a new one.
            let peer_id = peer_id
                .filter(|id| Uuid::parse_str(id).is_ok())
                .filter(|id| !room.participants.contains_key(id) && !room.pending.contains_key(id))
                .unwrap_or_else(generate_peer_id);

            // Leadership: a presented token matching the stored one is
            // burned and makes the joiner the leader; otherwise — if the
            // room right now has no leader (freshly created/restored/
            // just-emptied room) — whoever joins first becomes the leader.
            let mut becomes_leader = false;
            if let Some(token) = &leader_token {
                if room.leader_token.as_deref() == Some(token.as_str()) {
                    becomes_leader = true;
                    room.leader_token = None; // one-time — burn it
                }
            }
            if !becomes_leader && room.leader_id.is_none() {
                becomes_leader = true;
            }

            // The lobby (wait room) only applies to a NON-leader: the
            // leader always enters directly, bypassing the wait.
            if !becomes_leader && room.settings.lobby_enabled {
                if room.pending.len() >= MAX_PENDING {
                    send_to(tx, err("waiting room is full, try again later"));
                    drop(rooms_guard);
                    return Flow::Stop;
                }
                // M3 (keeping the lobby from being flooded): a per-IP limit
                // on entering pending, a budget separate from the room
                // creation limit (see `PENDING_JOIN_IP_LIMIT`) — keeps a
                // single IP from flooding the lobby at once with many
                // connections, even if this particular room's MAX_PENDING
                // isn't formally exhausted.
                if !check_ip_rate_limit(pending_join_ips, ip, PENDING_JOIN_IP_LIMIT, PENDING_JOIN_IP_WINDOW) {
                    send_to(tx, err("too many join attempts from your network, try again later"));
                    drop(rooms_guard);
                    return Flow::Stop;
                }
                room.pending.insert(
                    peer_id.clone(),
                    PendingParticipant {
                        tx: tx.clone(),
                        epub: epub.clone(),
                        joined_at: Instant::now(),
                    },
                );
                info!(room = %room_id, peer = %peer_id, "participant waiting for lobby approval");
                // Invariant: up to this point, `!becomes_leader` when
                // entering the lobby means the room definitely already has
                // a leader (see the branch above: `becomes_leader` would
                // otherwise have become `true` on its own — "if the room
                // right now has no leader... whoever joins first becomes
                // the leader"), so `room.leader_id` is always `Some` here.
                // `unwrap_or_default()` — not a panic, in case this
                // invariant is ever violated.
                let leader_id = room.leader_id.clone();
                let leader_epub = leader_id
                    .as_ref()
                    .and_then(|id| room.participants.get(id))
                    .and_then(|p| p.epub.clone());
                send_to(tx, ServerMessage::Waiting {
                    leader_peer_id: leader_id.clone().unwrap_or_default(),
                    leader_epub,
                });
                if let Some(leader_id) = leader_id {
                    if let Some(leader) = room.participants.get(&leader_id) {
                        send_to(&leader.tx, ServerMessage::JoinRequest {
                            peer_id: peer_id.clone(),
                            name: None, // dead field, see the comment in the protocol.rs module
                            epub: epub.clone(),
                        });
                    }
                }
                drop(rooms_guard);
                *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
                return Flow::Continue;
            }

            // D (docs/research-room-limit.md §2.2): the room's effective
            // limit — the leader's own if set, otherwise the server-wide
            // ceiling (see `Room::effective_max_participants`) — used
            // EVERYWHERE instead of comparing directly against
            // `crate::MAX_PARTICIPANTS`.
            if room.participants.len() >= room.effective_max_participants() {
                send_to(tx, ServerMessage::RoomFull);
                return Flow::Continue;
            }

            admit_participant(room, &room_id, peer_id.clone(), epub.clone(), tx.clone(), becomes_leader);

            drop(rooms_guard);
            *me = Some(PeerCtx { room_id: room_id.clone(), peer_id });
        }

        // Relay: we don't parse the content, we only route it within the
        // sender's room (to any other participant), filling in
        // fromPeerId. H2 (DoS protection): every relay first goes through
        // the shared frequency counter (RELAY_RATE_LIMIT, combined across
        // all relay types for this connection — see its comment), then the
        // payload-size cap (RELAY_MAX_BYTES) — in this order, so that an
        // attempt to push a huge payload also spends the frequency budget,
        // rather than bypassing the rate limit for free.
        ClientMessage::Offer { target_peer_id, sdp } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&sdp) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Offer {
                    from_peer_id: from,
                    sdp,
                });
            }
        }
        ClientMessage::Answer { target_peer_id, sdp } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&sdp) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::Answer {
                    from_peer_id: from,
                    sdp,
                });
            }
        }
        ClientMessage::IceCandidate { target_peer_id, candidate } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&candidate) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::IceCandidate {
                    from_peer_id: from,
                    candidate,
                });
            }
        }
        ClientMessage::StreamInfo { target_peer_id, info } => {
            if !check_relay_rate_limit(&mut rate_limits.relay_times) {
                send_to(tx, err("too many messages, slow down"));
            } else if relay_payload_too_large(&info) {
                send_to(tx, err("payload too large (max 16KB)"));
            } else {
                relay(me, rooms, tx, &target_peer_id, |from| ServerMessage::StreamInfo {
                    from_peer_id: from,
                    info,
                });
            }
        }

        ClientMessage::ShareStart => {
            handle_share_start(me, tx, rooms);
        }
        ClientMessage::ShareStop => {
            handle_share_stop(me, rooms);
        }

        ClientMessage::UpdateSettings { settings } => {
            handle_update_settings(settings, me, tx, rooms);
        }
        ClientMessage::Approve { peer_id } => {
            handle_approve(peer_id, me, tx, rooms);
        }
        ClientMessage::Reject { peer_id } => {
            handle_reject(peer_id, me, tx, rooms);
        }

        ClientMessage::Leave => return Flow::Stop,

        ClientMessage::NameAnnounce { to, payload } => {
            handle_name_announce(to, payload, me, tx, rooms, rate_limits);
        }
    }
    Flow::Continue
}

/// The shared part of admitting a participant into a room directly
/// (bypassing the lobby): either because they became the leader, or
/// because the lobby is disabled (or wasn't applied for this entry).
/// Inserts the participant, assigns the leader (if they became one),
/// notifies the others via `peer-joined`, and sends the joiner their own
/// `joined` — with the current pending requests ONLY if they're the
/// leader, otherwise with an empty list.
///
/// `name` is no longer a parameter (it used to be a dead field — the
/// server doesn't store it, see docs/research-minimize-state.md §3): both
/// in `peers[]` and in `peer-joined`, `None`/`null` is filled in
/// unconditionally.
fn admit_participant(
    room: &mut Room,
    room_id: &str,
    peer_id: String,
    epub: Option<String>,
    tx: PeerTx,
    becomes_leader: bool,
) {
    // The other already-connected participants — before inserting the new
    // one.
    let peers: Vec<PeerInfo> = room
        .participants
        .iter()
        .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect();
    let screen_owner = room.screen_owner.clone();

    // The server-side timer field (see
    // `crate::state::Room::first_joined_at`): set EXACTLY ONCE, at the
    // moment the first participant over the whole life of the room joins
    // (the room is still empty right now, BEFORE the insert below, and the
    // mark hasn't been set yet) — never touched afterward, even if the
    // room becomes empty and fills up again within the empty-room TTL.
    if room.participants.is_empty() && room.first_joined_at.is_none() {
        room.first_joined_at = Some(Instant::now());
    }

    room.participants.insert(
        peer_id.clone(),
        Participant { tx: tx.clone(), epub: epub.clone(), joined_at: Instant::now() },
    );
    // Joining an emptied-but-still-alive room clears the TTL mark.
    room.emptied_at = None;

    if becomes_leader {
        room.leader_id = Some(peer_id.clone());
    }
    let leader_id = room.leader_id.clone().unwrap_or_else(|| peer_id.clone());

    let count = room.participants.len();
    info!(room = %room_id, peer = %peer_id, count, "participant connected");

    // Notify the others about the new participant; the new participant
    // themselves learns about them via the `peers` list in their own
    // `joined`.
    for (id, p) in room.participants.iter() {
        if id != &peer_id {
            send_to(&p.tx, ServerMessage::PeerJoined {
                peer_id: peer_id.clone(),
                name: None,
                epub: epub.clone(),
            });
        }
    }

    // Those waiting in the lobby are visible ONLY to the leader themselves
    // — everyone else gets an empty list. Order — by request time
    // (`joined_at`), oldest first.
    let pending = if becomes_leader {
        pending_sorted_by_arrival(room)
    } else {
        Vec::new()
    };

    send_to(&tx, ServerMessage::Joined {
        peer_id,
        peers,
        screen_owner,
        leader_id,
        settings: room.settings.clone(),
        pending,
        expires_in_seconds: room_expires_in_seconds(room),
        room_age_seconds: room_age_seconds(room),
        // D: the room's effective limit (the leader's if set, otherwise
        // the server-wide ceiling), see `Room::effective_max_participants`.
        max_participants: room.effective_max_participants(),
    });

    // The server no longer sends chat history to a newcomer: chat lives
    // entirely on the mesh RTCDataChannel, a newcomer requests history
    // themselves from their neighbors on the bus (see `static/chat.js`) —
    // the server doesn't store it.
}

/// The current lobby requests, sorted by arrival time (`joined_at`, oldest
/// first) — used both for the leader's `Joined::pending` and when
/// transferring requests to a new leader after a change (see
/// `cleanup_peer`). `name` is no longer stored by the server — always
/// `None` (see the module comment in protocol.rs).
fn pending_sorted_by_arrival(room: &Room) -> Vec<PendingInfo> {
    let mut items: Vec<_> = room.pending.iter().collect();
    items.sort_by_key(|(_, p)| p.joined_at);
    items
        .into_iter()
        .map(|(id, p)| PendingInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect()
}

/// A/D: a reconnect with ONE'S OWN previous `peerId`, which is right now
/// holding a full-participant slot in this same room. The typical cause —
/// the client lost only the signaling WS (not the mesh, see
/// docs/self-hosting.md §7.2) and managed to reconnect faster than the
/// server's heartbeat (up to `PING_INTERVAL * MAX_MISSED_PONGS`, ~40-60s)
/// detected the old connection's drop: the old `Participant` record has
/// been a "zombie" this whole time — still marked occupied, but nobody's
/// reading its `tx` on the other end anymore. Setting up a NEW slot for
/// such a reconnect (as before — a peerId collision simply generated a new
/// one) would mean: (a) a false `room-full`/`effective_max_participants`
/// specifically in rooms with a small leader-set limit (see
/// docs/research-room-limit.md §4 — this is exactly the "subtle point"
/// explicitly flagged there), (b) spending the per-IP
/// `JOIN_ROOM_IP_LIMIT` budget on a legitimate action.
///
/// What we do: replace `tx` in the EXISTING record with the new channel.
/// `joined_at` is NOT touched — otherwise a reconnect would jump the queue
/// for leadership ahead of participants who joined before it, but after
/// its own original join. `epub` is also NOT touched: the other
/// participants have already received `peer-joined` with this peer's
/// PREVIOUS `epub` and derived pairwise E2E keys from it (see
/// docs/e2e-encryption.md) — swapping the value now would desync keys with
/// participants already seated; broadcasting a fresh `peer-joined` for
/// someone who, from their point of view, never left, isn't needed either
/// — membership hasn't changed for them.
///
/// We don't touch the old (superseded) connection itself — its own
/// `handle_socket` loop will eventually finish on its own (heartbeat or
/// just a drop), and at that point its `cleanup_peer` must NOT tear down
/// someone else's slot that's already been taken over — see the
/// `same_channel` check there.
///
/// Trust in this reuse: the only check is that the `peerId` itself
/// matches, and it's a `Uuid::new_v4()` (128 bits of cryptographic
/// randomness, see `generate_peer_id`) — guessing someone else's is
/// practically impossible, the same level of trust already placed in
/// `leaderToken`. If it's somehow guessed anyway — the victim (if their
/// connection is still alive) keeps receiving messages over the old
/// channel until it dies on its own, while NEW messages addressed to them
/// by others go to the hijacker instead: a noticeable signaling glitch for
/// that specific pair, but not a silent content leak (SDP/ICE are
/// encrypted with a pairwise key derived from `epub`, which the hijacker
/// doesn't know).
///
/// We send the reconnecting peer a FULL fresh `joined` (as on a normal
/// entry) — not a no-op: while signaling was down, the room's state could
/// have changed (settings, lobby, screen owner, effective limit) — a fresh
/// `joined` gives the client the same resync that `waiting` already does on
/// a leader change (see `cleanup_peer`). We broadcast NOTHING to the other
/// participants — from their point of view this peerId never left
/// (`peer-joined`/`peer-left` neither happened nor will).
fn reconnect_participant(room: &mut Room, room_id: &str, peer_id: &str, tx: PeerTx) {
    match room.participants.get_mut(peer_id) {
        Some(participant) => participant.tx = tx.clone(),
        None => return,
    }
    info!(room = %room_id, peer = %peer_id, "existing participant reconnected (signaling re-established)");

    let peers: Vec<PeerInfo> = room
        .participants
        .iter()
        .filter(|(id, _)| id.as_str() != peer_id)
        .map(|(id, p)| PeerInfo { peer_id: id.clone(), name: None, epub: p.epub.clone() })
        .collect();
    let is_leader = room.leader_id.as_deref() == Some(peer_id);
    let pending = if is_leader { pending_sorted_by_arrival(room) } else { Vec::new() };

    send_to(&tx, ServerMessage::Joined {
        peer_id: peer_id.to_string(),
        peers,
        screen_owner: room.screen_owner.clone(),
        leader_id: room.leader_id.clone().unwrap_or_else(|| peer_id.to_string()),
        settings: room.settings.clone(),
        pending,
        expires_in_seconds: room_expires_in_seconds(room),
        room_age_seconds: room_age_seconds(room),
        max_participants: room.effective_max_participants(),
    });
}

/// `update-settings`: applies the new settings wholesale (not a patch) —
/// leader only, otherwise `error`. Broadcasts `settings-changed` to all
/// participants. If `guest_screen` was just revoked and the current screen
/// owner isn't the leader, the server itself stops their sharing
/// (`share-stopped` to everyone).
///
/// D (docs/research-room-limit.md §2.1): `settings.max_participants`, if
/// `Some(n)`, is validated — `n` must be `2..=crate::MAX_PARTICIPANTS`,
/// otherwise the whole `update-settings` is rejected ENTIRELY (`error`,
/// nothing is applied — the same "all or nothing" mechanics as the other
/// `settings` fields). The lower bound is 2 (not 1) — a room with a limit
/// of 1 makes no sense: the leader couldn't even let in a second person,
/// themselves.
fn handle_update_settings(
    settings: RoomSettings,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can change settings"));
        return;
    }
    if let Some(n) = settings.max_participants {
        if !(2..=*crate::MAX_PARTICIPANTS).contains(&n) {
            send_to(tx, err(&format!(
                "maxParticipants must be between 2 and {} (server limit)",
                *crate::MAX_PARTICIPANTS,
            )));
            return;
        }
    }

    let guest_screen_was_allowed = room.settings.guest_screen;
    room.settings = settings.clone();

    let changed_msg = ServerMessage::SettingsChanged { settings };
    for p in room.participants.values() {
        send_to(&p.tx, changed_msg.clone());
    }

    // Guest screen-sharing permission was revoked while a guest (not the
    // leader) is sharing — the server stops it itself.
    if guest_screen_was_allowed && !room.settings.guest_screen {
        if let Some(owner) = room.screen_owner.clone() {
            if room.leader_id.as_deref() != Some(owner.as_str()) {
                room.screen_owner = None;
                let stop_msg = ServerMessage::ShareStopped { peer_id: owner };
                for p in room.participants.values() {
                    send_to(&p.tx, stop_msg.clone());
                }
            }
        }
    }
}

/// `approve {peerId}`: leader only, only for a request still active in
/// `room.pending`. Moves the waiting peer into participants (with the same
/// `tx`), sends them a full `joined` and `peer-joined` to the others. If
/// the room happened to fill up while the request was waiting — it's
/// rejected separately (so as not to exceed the room's effective limit,
/// see `Room::effective_max_participants` — D).
fn handle_approve(target: String, me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can approve"));
        return;
    }
    let Some(pending) = room.pending.remove(&target) else {
        send_to(tx, err("no such pending join request"));
        return;
    };
    if room.participants.len() >= room.effective_max_participants() {
        send_to(&pending.tx, ServerMessage::RoomFull);
        send_to(tx, err("room is full, cannot approve"));
        return;
    }

    let room_id = ctx.room_id.clone();
    admit_participant(room, &room_id, target, pending.epub, pending.tx, false);
}

/// `reject {peerId}`: leader only, only for a request still active. The
/// waiting peer gets `join-rejected`, and their connection's writer closes
/// the socket itself right after this message (see `reject` in
/// `handle_socket`).
fn handle_reject(target: String, me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.leader_id.as_deref() != Some(ctx.peer_id.as_str()) {
        send_to(tx, err("only the room leader can reject"));
        return;
    }
    let Some(pending) = room.pending.remove(&target) else {
        send_to(tx, err("no such pending join request"));
        return;
    };
    send_to(&pending.tx, ServerMessage::JoinRejected {});
}

/// A screen-share request: "last one wins". If the screen is free — the
/// initiator becomes the owner as before; if someone else already holds it,
/// the request is NOT rejected, it replaces the owner instead — the screen
/// passes to the initiator, and `share-started` goes out to all
/// participants, including the previous owner. The previous owner learns
/// of the takeover from this same broadcast (the peerId in it is no longer
/// theirs) and stops their own local capture themselves (see
/// `static/room.js`) — a separate message to them isn't needed. A repeat
/// request from the CURRENT owner is a no-op (nothing changes, nothing is
/// re-broadcast). For a non-leader with `guest_screen=false` — a rejection
/// with `reason: "forbidden"` (without `busyPeerId`, which is no longer
/// used at all — see `ServerMessage::ShareRejected`), regardless of
/// whether the screen is free or held.
fn handle_share_start(me: &Option<PeerCtx>, tx: &PeerTx, rooms: &SharedRooms) {
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if !room.participants.contains_key(&ctx.peer_id) {
        send_to(tx, err("not in a room"));
        return;
    }
    let is_leader = room.leader_id.as_deref() == Some(ctx.peer_id.as_str());
    if !is_leader && !room.settings.guest_screen {
        send_to(tx, ServerMessage::ShareRejected { busy_peer_id: None, reason: Some("forbidden".to_string()) });
        return;
    }
    if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
        // Already owns the screen — the request is redundant, nothing to
        // change.
        return;
    }
    // Free or held by someone else — either way the initiator becomes the
    // new owner ("last one wins"); the broadcast is the same in both
    // cases.
    room.screen_owner = Some(ctx.peer_id.clone());
    let msg = ServerMessage::ShareStarted { peer_id: ctx.peer_id.clone() };
    for p in room.participants.values() {
        send_to(&p.tx, msg.clone());
    }
}

/// Releasing the screen. Accepted only from the current owner — a request
/// from someone else is silently ignored (the screen stays held as it
/// was).
fn handle_share_stop(me: &Option<PeerCtx>, rooms: &SharedRooms) {
    let Some(ctx) = me else { return };
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else {
        return;
    };
    if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
        room.screen_owner = None;
        let msg = ServerMessage::ShareStopped { peer_id: ctx.peer_id.clone() };
        for p in room.participants.values() {
            send_to(&p.tx, msg.clone());
        }
    }
}

/// A sliding window shared between the chat limit and the relay limit (see
/// `check_rate_limit`/`check_relay_rate_limit`): no more than `limit` marks
/// per `window`. Returns `true` if one more mark is allowed (and, if so,
/// registers it).
fn sliding_window_ok(times: &mut VecDeque<Instant>, limit: usize, window: Duration) -> bool {
    let now = Instant::now();
    while let Some(&oldest) = times.front() {
        if now.duration_since(oldest) > window {
            times.pop_front();
        } else {
            break;
        }
    }
    if times.len() >= limit {
        return false;
    }
    times.push_back(now);
    true
}

/// H2 (DoS protection): the shared sliding counter across ALL of a
/// connection's relays combined (offer/answer/ice-candidate/stream-info) —
/// see `RELAY_RATE_LIMIT`.
fn check_relay_rate_limit(relay_times: &mut VecDeque<Instant>) -> bool {
    sliding_window_ok(relay_times, RELAY_RATE_LIMIT, RELAY_RATE_WINDOW)
}

/// H2 (DoS protection): does the serialized payload size of a relay
/// (`sdp`/`candidate`/`info`) exceed `RELAY_MAX_BYTES`? The server doesn't
/// parse these values, but must still cap their size — see
/// `RELAY_MAX_BYTES`.
fn relay_payload_too_large(value: &Value) -> bool {
    let size = serde_json::to_string(value).map(|s| s.len()).unwrap_or(usize::MAX);
    size > RELAY_MAX_BYTES
}

/// Remaining lifetime of the room in seconds at the current moment (the
/// call duration limit, see docs/security.md, "Meeting Duration Ceiling")
/// — `MAX_ROOM_LIFETIME` minus the room's age, clamped at 0 from below.
/// Used in `Joined` so the client can show its own countdown/warning.
fn room_expires_in_seconds(room: &Room) -> u64 {
    crate::MAX_ROOM_LIFETIME
        .checked_sub(room.created_at.elapsed())
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

/// How many seconds have passed since the FIRST participant, over the
/// whole life of the room, joined (see `Room::first_joined_at`) — the
/// source for the server-side `Joined::room_age_seconds` field, for the
/// client's count-up timer. `0` if `first_joined_at` somehow isn't set yet
/// (shouldn't happen at the moment `Joined` is sent — both places that
/// build this message, `admit_participant`/`reconnect_participant`, are
/// called only AFTER the participant has definitely been inserted into
/// `room.participants`, meaning the mark has definitely been set too — see
/// the call in `admit_participant`), but we degrade to `0` rather than
/// panicking, in case the invariants ever get out of sync.
fn room_age_seconds(room: &Room) -> u64 {
    room.first_joined_at
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0)
}

/// `epub` (E2E v2): a non-empty string after trimming, no longer than
/// `EPUB_MAX_CHARS` characters — otherwise (empty, absent entirely, or too
/// long) `None`. The server does NOT parse the content (opaque, like
/// `sdp`/`candidate`) — its only concern is not letting through a blatantly
/// unreasonable size. We do NOT truncate a too-long value, we drop it
/// entirely: a truncated public key won't match any valid key, so an
/// "almost correct but truncated" ephemeral epub is useless and only masks
/// a client bug.
///
/// (`name` in `join-room` is no longer sanitized/stored at all — see
/// docs/research-minimize-state.md §3 and the comment at
/// `crate::state::Participant`: the field is dead for all v2 clients, the
/// server simply ignores whatever value is sent entirely.)
fn sanitize_epub(epub: Option<String>) -> Option<String> {
    let raw = epub?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > EPUB_MAX_CHARS {
        return None;
    }
    Some(trimmed.to_string())
}

/// Deliver a message to peer `target` in the sender's room (any other
/// participant — the topology is symmetric, mesh).
/// An unknown targetPeerId is silently ignored: this is a normal race — the
/// peer may have dropped off while the message was in flight.
fn relay<F>(me: &Option<PeerCtx>, rooms: &SharedRooms, tx: &PeerTx, target: &str, build: F)
where
    F: FnOnce(String) -> ServerMessage,
{
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let rooms = rooms.lock().unwrap();
    let Some(room) = rooms.get(&ctx.room_id) else {
        debug!(room = %ctx.room_id, "relay into an already-removed room — ignoring");
        return;
    };
    // Someone waiting for lobby approval (see `Room::pending`) isn't a
    // participant yet, the relay isn't available to them (neither as
    // sender nor as target — there's no need to check the latter here,
    // they won't turn up in `room.participants`).
    if !room.participants.contains_key(&ctx.peer_id) {
        send_to(tx, err("not in a room"));
        return;
    }
    match room.participants.get(target) {
        Some(p) => send_to(&p.tx, build(ctx.peer_id.clone())),
        None => debug!(target = %target, "relay to an unknown peerId — ignoring"),
    }
}

/// `name-announce` (E2E v2, see the module comment in `protocol.rs`): relay
/// of an encrypted name announcement to peer `to`. Unlike `relay()` above,
/// the sender CAN be not just a full participant but also someone waiting
/// in the lobby (`Room::pending`) — the only case in the whole protocol
/// where a pending peer can itself initiate a relay, rather than only
/// passively receiving `waiting`/`join-rejected` etc. Permissions:
///   - a room participant → any other participant of the same room (like a
///     regular `relay()`); an unknown `to` — silently ignored (the same
///     race as in `relay()` — the target peer may have already dropped
///     off);
///   - someone waiting in the lobby → ONLY the room's current leader (they
///     have no visibility into the other participants anyway) — a
///     different `to` isn't a race but a permissions violation, hence an
///     explicit `error` to the sender (the same pattern as
///     `update-settings`/`approve`/`reject` from a non-leader), rather than
///     a silent drop;
///   - neither a participant nor pending (the socket has already fallen
///     out of the room in both senses, shouldn't happen during normal
///     operation) — `error`, like `relay()`.
///
/// Caps (H2, DoS protection): the shared relay rate limit (the same
/// counter as offer/answer/ICE/stream-info) and `NAME_ANNOUNCE_MAX_BYTES`
/// on the size of `payload` — in this order, for the same reasons as
/// `relay_payload_too_large` in `handle_message`.
fn handle_name_announce(
    to: String,
    payload: String,
    me: &Option<PeerCtx>,
    tx: &PeerTx,
    rooms: &SharedRooms,
    rate_limits: &mut RateLimits,
) {
    if !check_relay_rate_limit(&mut rate_limits.relay_times) {
        send_to(tx, err("too many messages, slow down"));
        return;
    }
    if payload.len() > NAME_ANNOUNCE_MAX_BYTES {
        send_to(tx, err("payload too large (max 2KB)"));
        return;
    }
    let Some(ctx) = me else {
        send_to(tx, err("not in a room"));
        return;
    };
    let rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get(&ctx.room_id) else {
        debug!(room = %ctx.room_id, "name-announce into an already-removed room — ignoring");
        return;
    };

    if room.participants.contains_key(&ctx.peer_id) {
        match room.participants.get(&to) {
            Some(p) => send_to(&p.tx, ServerMessage::NameAnnounce { from: ctx.peer_id.clone(), payload }),
            None => debug!(target = %to, "name-announce to an unknown peerId — ignoring"),
        }
        return;
    }

    if room.pending.contains_key(&ctx.peer_id) {
        if room.leader_id.as_deref() == Some(to.as_str()) {
            match room.leader_id.as_ref().and_then(|id| room.participants.get(id)) {
                Some(leader) => send_to(&leader.tx, ServerMessage::NameAnnounce { from: ctx.peer_id.clone(), payload }),
                // The leader is recorded in `room.leader_id`, but not found
                // among the participants — shouldn't happen in practice (a
                // leader leaving clears `leader_id` synchronously, see
                // `cleanup_peer`), but we don't panic if the invariants
                // ever get out of sync.
                None => debug!(leader = %to, "name-announce to a leader not found among the participants — ignoring"),
            }
        } else {
            send_to(tx, err("pending participants can only send name-announce to the room leader"));
        }
        return;
    }

    send_to(tx, err("not in a room"));
}

/// Remove a peer from the room and notify the others. The peer could have
/// been either a full participant or someone waiting for lobby approval
/// (`Room::pending`) — these are mutually exclusive maps, handled one after
/// the other.
///
/// For a participant: if they were sharing their screen — `share-stopped`
/// to everyone remaining first; if they were the leader — the server
/// deterministically assigns a new one (the participant with the earliest
/// `joined_at`) and broadcasts `leader-changed`, and re-forwards the
/// accumulated lobby requests to the new leader (a `join-request` for
/// each); then (if anyone is left) `peer-left`. If the room becomes empty —
/// it's not deleted right away, instead the moment of emptying is marked:
/// the reaper will delete it later, if nobody connects before the TTL
/// expires (see `state::reap_rooms`); any lobby requests still alive at
/// this point are rejected (`join-rejected` + closing the socket) — there's
/// nobody left to approve them.
///
/// For someone waiting in the lobby: simply removed from `pending` and, if
/// a leader still exists, they're notified via
/// `join-request-cancelled`.
///
/// `tx` — the channel of EXACTLY THIS (closing) connection (see A/D,
/// `reconnect_participant`): a reconnect may have ALREADY taken over
/// `ctx.peer_id`, replacing the `tx` in `room.participants` with the
/// channel of a newer, more recent connection, while the OLD (this)
/// connection simply hasn't yet finished its own `handle_socket` loop
/// (the heartbeat doesn't expire instantly). If that happened — the slot no
/// longer belongs to this call: don't touch the participant at all (no
/// removal, no `peer-left`/`leader-changed` for someone else's already-live
/// connection) — compare channels via `same_channel`
/// (`tokio::sync::mpsc::UnboundedSender::same_channel`), rather than just
/// the presence of a record.
fn cleanup_peer(ctx: &PeerCtx, rooms: &SharedRooms, tx: &PeerTx) {
    let mut rooms_guard = rooms.lock().unwrap();
    let Some(room) = rooms_guard.get_mut(&ctx.room_id) else { return };

    if let Some(participant) = room.participants.get(&ctx.peer_id) {
        if !participant.tx.same_channel(tx) {
            debug!(room = %ctx.room_id, peer = %ctx.peer_id,
                "a connection already superseded by a reconnect is closing — leaving the slot alone");
            return;
        }
    }

    if room.participants.remove(&ctx.peer_id).is_some() {
        if room.screen_owner.as_deref() == Some(ctx.peer_id.as_str()) {
            room.screen_owner = None;
            let msg = ServerMessage::ShareStopped { peer_id: ctx.peer_id.clone() };
            for p in room.participants.values() {
                send_to(&p.tx, msg.clone());
            }
        }

        let was_leader = room.leader_id.as_deref() == Some(ctx.peer_id.as_str());
        if was_leader {
            let new_leader = room
                .participants
                .iter()
                .min_by_key(|(_, p)| p.joined_at)
                .map(|(id, _)| id.clone());
            room.leader_id = new_leader.clone();
            if let Some(new_leader_id) = new_leader {
                info!(room = %ctx.room_id, leader = %new_leader_id, "leader left — a new one was assigned");
                let msg = ServerMessage::LeaderChanged { leader_id: new_leader_id.clone() };
                for p in room.participants.values() {
                    send_to(&p.tx, msg.clone());
                }
                // Lobby requests are inherited by the new leader — we
                // re-forward them (in submission order), they haven't seen
                // them yet. At the same time (E2E v2, see
                // `ServerMessage::Waiting`), every pending peer gets sent a
                // FRESH `waiting` with the new leader and their `epub` —
                // the old key, derived against the previous leader, doesn't
                // work for the new one, and without a fresh `waiting` a
                // pending peer wouldn't know who to forward their
                // `name-announce` to.
                if !room.pending.is_empty() {
                    let new_leader_epub = room
                        .participants
                        .get(&new_leader_id)
                        .and_then(|p| p.epub.clone());
                    let waiting_msg = ServerMessage::Waiting {
                        leader_peer_id: new_leader_id.clone(),
                        leader_epub: new_leader_epub,
                    };
                    for p in room.pending.values() {
                        send_to(&p.tx, waiting_msg.clone());
                    }

                    let pending = pending_sorted_by_arrival(room);
                    if let Some(new_leader) = room.participants.get(&new_leader_id) {
                        for p in pending {
                            send_to(&new_leader.tx, ServerMessage::JoinRequest {
                                peer_id: p.peer_id,
                                name: p.name,
                                epub: p.epub,
                            });
                        }
                    }
                }
            }
        }

        if room.participants.is_empty() {
            room.emptied_at = Some(Instant::now());
            // Nobody left to approve — reject everyone still waiting.
            for (_, pend) in room.pending.drain() {
                send_to(&pend.tx, ServerMessage::JoinRejected {});
            }
            info!(room = %ctx.room_id, "room emptied, waiting for TTL before deletion");
        } else {
            info!(room = %ctx.room_id, peer = %ctx.peer_id, "participant disconnected");
            let msg = ServerMessage::PeerLeft { peer_id: ctx.peer_id.clone() };
            for p in room.participants.values() {
                send_to(&p.tx, msg.clone());
            }
        }
        return;
    }

    if room.pending.remove(&ctx.peer_id).is_some() {
        info!(room = %ctx.room_id, peer = %ctx.peer_id, "waiting peer dropped off, request withdrawn");
        if let Some(leader_id) = room.leader_id.clone() {
            if let Some(leader) = room.participants.get(&leader_id) {
                send_to(&leader.tx, ServerMessage::JoinRequestCancelled { peer_id: ctx.peer_id.clone() });
            }
        }
    }
    // Otherwise the peer is no longer in the room in any form — nothing to
    // do.
}

fn err(message: &str) -> ServerMessage {
    ServerMessage::Error { message: message.to_string() }
}
