# WebRTC Mesh

<!-- toc -->

- [1. Topology](#1-topology)
- [2. Perfect Negotiation](#2-perfect-negotiation)
- [3. The Data-Channel Bus](#3-the-data-channel-bus)
  - [3.1 Why an Asymmetric `createDataChannel`, Not `negotiated`](#31-why-an-asymmetric-createdatachannel-not-negotiated)
  - [3.2 Bus Message Kinds](#32-bus-message-kinds)
- [4. Renegotiation Over the Bus](#4-renegotiation-over-the-bus)
- [5. Track Routing via `stream-info`](#5-track-routing-via-stream-info)
- [6. STUN, TURN & ICE](#6-stun-turn--ice)
- [7. Connection Mode Detection](#7-connection-mode-detection)
- [8. Screen Sharing](#8-screen-sharing)
- [9. Mobile Capability Detection](#9-mobile-capability-detection)

<!-- /toc -->

> Source of truth: [`../static/rtc.js`](../static/rtc.js) (peer connection
> wrapper, perfect negotiation, bus wiring),
> [`../static/bus.js`](../static/bus.js) (bus API over the peer map),
> [`../static/room.js`](../static/room.js) (mesh assembly, track handling,
> connection-mode UI). Message-level detail on what travels the WebSocket
> signaling relay is in [`signaling-protocol.md`](signaling-protocol.md).

## 1. Topology

Chat is a **full mesh**: every participant holds one direct
`RTCPeerConnection` to every other participant in the room — there is no
media server and no selective forwarding. For a room of *n* participants,
each browser maintains *n − 1* peer connections. This is a deliberate,
explicit trade-off (see [`DESIGN.md` §2.1](DESIGN.md#21-design-principles)):
it keeps the server structurally incapable of touching media, at the cost of
bounding practical room size to a small number of participants (see
[`PRD.md` §4](PRD.md#4-scope)) — per-participant upload bandwidth and CPU
both scale with the number of other participants.

There is no broadcaster/viewer distinction of any kind. Any participant can
add a microphone/camera/screen track and thereby trigger negotiation with
every peer independently.

## 2. Perfect Negotiation

Each `RtcPeer` implements the canonical **perfect negotiation** pattern
(the same pattern documented by the WebRTC working group and browser
vendors): each side is deterministically assigned `polite` or `impolite` by
comparing the two participants' peer ids lexicographically (the side with
the lexicographically greater peer id is polite) — both sides compare the
same pair of ids, so exactly one side ends up polite.

- `makingOffer` is `true` between the start of `onnegotiationneeded` and the
  offer actually being sent.
- `ignoreOffer` is set when the impolite side detects an offer collision
  (see below) and drops the incoming offer rather than processing it.
- On collision, the **polite** side lets the browser's implicit rollback
  (triggered inside `setRemoteDescription(offer)` when the local signaling
  state was `have-local-offer`) handle backing out its own outstanding
  offer, rather than calling `setLocalDescription({type: 'rollback'})`
  explicitly.

Either side may be first to add a track (microphone, camera, or screen
share) and thereby initiate an offer; perfect negotiation resolves the
resulting collisions symmetrically regardless of who initiated.

## 3. The Data-Channel Bus

Every peer pair also carries one `RTCDataChannel`, the **bus**, used first
by chat (see [`chat.md`](chat.md)) and by renegotiation signaling (see
[§4](#4-renegotiation-over-the-bus)). It opens as soon as both sides join the
room — before either side has enabled any media — because it is created
alongside the peer connection itself, not on a user gesture.

### 3.1 Why an Asymmetric `createDataChannel`, Not `negotiated`

The bus channel is opened by the **impolite** side with an ordinary
`pc.createDataChannel('bus')`; the polite side receives its half via
`pc.ondatachannel`. This is a deliberate choice over a symmetric
`negotiated: true, id: 0` channel that both sides create identically:
empirically, in one testing environment, creating several
`RTCPeerConnection`s on one page in quick succession sometimes caused the
browser to never fire `onnegotiationneeded` for one of the connections at
all (not a perfect-negotiation bug — the other pairs reached
stable/connected normally; the affected pair's negotiation simply never
started, from either side). The plain, asymmetric
`createDataChannel → onnegotiationneeded → offer` chain is the same one
already proven reliable for media tracks, so the bus reuses it rather than
the symmetric variant.

One consequence: creating the bus channel synchronously in the constructor
(rather than on a user gesture, as media tracks are) means the offer
collision that used to only happen when both sides started audio/video
simultaneously can now happen from the mere fact of joining the room — still
handled by the same perfect-negotiation logic.

**Incoming data channels are dispatched by label**, not by polite/impolite
role: `'bus'` → the bus; a label starting with `'file-'` → an incoming file
transfer channel (see [`chat.md`](chat.md)). The file-channel case must be
handled regardless of role because either side of a pair may be the one
holding a file someone requested — unlike the bus, it isn't tied to who is
polite. Adding a channel to an already-established connection doesn't
require a new SDP negotiation (the SCTP association already exists), so
`onnegotiationneeded` normally doesn't fire again for it.

### 3.2 Bus Message Kinds

The bus carries JSON objects with a `kind` field. Two kinds are defined at
the transport level:

- `rtc-signal` — a renegotiation signal riding the bus instead of the server
  (see [§4](#4-renegotiation-over-the-bus)): `{ kind: 'rtc-signal', payload: { type: 'offer'|'answer'|'ice', data } }`.
- Everything chat-related (`text`, `reaction`, `file-offer`, …) — see
  [`chat.md`](chat.md) for the full envelope catalog; from the bus's point
  of view these are opaque payloads dispatched to registered message
  handlers.

## 4. Renegotiation Over the Bus

The **first** handshake of a pair (the bus doesn't exist yet — signaling
can't ride a channel it is itself establishing) and any ICE
restart/reconnect **always** go through the server-relayed signaling path
with encryption (see [`e2e-encryption.md`](e2e-encryption.md)). But **every
subsequent** renegotiation of an already-connected pair — adding/removing a
track, switching camera/microphone with a real renegotiation, and so on — is
sent directly over the bus once it has opened, as an `rtc-signal` message,
**without** the signaling-relay encryption layer: the data channel itself
already runs over DTLS, which is already end-to-end between exactly these
two peers, so a second application-layer encryption pass over the same pair
would add no additional security property.

The decision of *which* path to use for a given offer/answer/ICE candidate is
made fresh, synchronously, right before sending: the bus is used only if it
is open **and** `pc.connectionState === 'connected'`. Otherwise (bootstrap,
or the pair is mid-reconnect/ICE-restart, where `connectionState` is by
definition not `'connected'`) the message goes through the server as before.
Because the check and the `channel.send()` happen with no `await` between
them, there is no race window where the state could change between deciding
and sending.

**Known fragility, accepted as-is**: the bus lives on the very
`RTCPeerConnection` that a renegotiation might be modifying. If that specific
renegotiation breaks the connection (ICE fails to re-establish, DTLS drops,
etc. — rare but possible), the bus dies with it, and any offer/answer/ICE
sent over it simply never arrives — `DataChannel.send()` may not surface any
failure at all in that case (the message may have already been queued in the
SCTP buffer, or the channel may already have closed synchronously; see the
try/catch around bus sends). No acknowledgment or retry scheme is layered on
top of this — the risk was judged not to justify the added complexity.

## 5. Track Routing via `stream-info`

Incoming media tracks (`pc.ontrack`) need to be associated with *which*
logical stream they belong to (camera vs. screen share, for instance) and
with a human-facing label. `stream-info` carries this association as an
opaque JSON payload from one peer to another. It travelled over the
server-relayed signaling channel (encrypted, see
[`e2e-encryption.md`](e2e-encryption.md)) historically; once a pair's bus is
open, it moves to the bus like other post-bootstrap signaling (see
[§4](#4-renegotiation-over-the-bus)) — the server is only ever involved in
the bootstrap window before a pair's channel opens.

## 6. STUN, TURN & ICE

- **STUN** is always available — a public STUN server is included in every
  `/config` response with no configuration required (see
  [`signaling-protocol.md` §2.4](signaling-protocol.md#24-get-config)).
- **TURN** is optional and configured per deployment (see
  [`self-hosting.md`](self-hosting.md)) — needed when two participants
  cannot establish a direct path (for example, both behind symmetric NAT).
  When configured, the backend hands out **short-lived, per-request
  credentials** rather than one static, indefinitely valid username/password
  pair — see [`security.md`](security.md) for why the static form was a
  vulnerability and exactly what the short-lived scheme does and does not
  guarantee.
- **Trickle ICE**: candidates are exchanged as they're discovered
  (`ice-candidate` messages), not batched into the offer/answer — queued
  locally on the receiving side until the remote description has been
  applied, then flushed.
- Media relayed through TURN is still end-to-end encrypted between the two
  peers (DTLS-SRTP) — the relay only ever sees ciphertext bytes and IP
  addresses, never plaintext media.

## 7. Connection Mode Detection

The frontend's "Connection & Privacy" panel (see [`privacy.md`](privacy.md))
shows, per peer, one of four states, computed from `pc.getStats()`:

1. If a **selected candidate pair** exists, its local/remote candidate types
   determine the mode: `p2p` if neither side is a `relay` candidate, `turn`
   otherwise.
2. If there's no selected pair yet and the bus to that peer isn't open
   either, the mode is `fallback` — connection **setup** (offer/answer/ICE/
   `stream-info`) is currently going through the server-relayed signaling
   path. Chat does **not** use this path: it waits in a local queue until the
   bus opens (see [`chat.md` §12](chat.md#12-no-server-fallback)).
3. Otherwise (no pair yet, but the bus is somehow already open — a race that
   shouldn't normally be reachable), the mode shown is `connecting`.

The selected pair is read from the spec-defined
`transport.selectedCandidatePairId` path, with a fallback to legacy
`candidate-pair` flags (`selected` / `nominated` + `succeeded`) for browsers
whose transport stats don't carry that field.

## 8. Screen Sharing

Screen sharing is server-arbitrated room state, not a peer-to-peer
negotiation detail: exactly one participant may hold it at a time, enforced
by the signaling server (`share-start`/`share-stop`/`share-started`/
`share-rejected` — see [`signaling-protocol.md`](signaling-protocol.md) and
[`permissions-and-leader.md`](permissions-and-leader.md) for the permission
checks). Once a share is granted, the actual screen-capture track flows
through the same mesh peer connections as camera/microphone tracks — no
separate transport.

## 9. Mobile Capability Detection

Mobile browsers that don't implement `getDisplayMedia()` (screen capture)
simply never see the "share screen" control — the frontend detects support
and hides the button rather than offering a control that would fail. This is
a client-side capability check, not a server-enforced permission (contrast
with [`permissions-and-leader.md`](permissions-and-leader.md), where the
server does arbitrate who may share).
