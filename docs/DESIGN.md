# Technical Design — Chat

<!-- toc -->

- [1. Architecture Overview](#1-architecture-overview)
  - [1.1 Architectural Vision](#11-architectural-vision)
  - [1.2 Trust Split](#12-trust-split)
- [2. Principles & Constraints](#2-principles--constraints)
  - [2.1 Design Principles](#21-design-principles)
  - [2.2 Constraints](#22-constraints)
  - [2.3 Observability](#23-observability)
- [3. Component Model](#3-component-model)
- [4. Technology Stack](#4-technology-stack)
- [5. Where to Find What](#5-where-to-find-what)
- [6. Traceability](#6-traceability)

<!-- /toc -->

> **Map, not territory.** This document gives the shape of the system and
> points to the technical document that actually specifies each part. It
> deliberately does not repeat protocol fields, cryptographic derivations, or
> deployment procedures — those live in the linked documents and in the
> source files they cite. If this document and a linked technical document
> disagree, the technical document (and, failing that, the code) wins.

## 1. Architecture Overview

### 1.1 Architectural Vision

Chat is a **full-mesh, peer-to-peer video meeting** built around a
deliberately thin signaling backend:

- **Every participant connects directly to every other participant.** There
  is no media server and no selective forwarding unit (SFU) — audio, video,
  and chat all travel browser-to-browser once a connection is established.
  This bounds the product to small meetings by design (see
  [`PRD.md` §4](PRD.md#4-scope)) in exchange for the server never seeing
  media content at all.
- **The signaling backend does exactly three things**: hand out short-lived
  room identifiers, relay the small amount of connection-setup traffic
  (offers/answers/ICE candidates) and moderation messages between
  participants over WebSocket, and serve the frontend's static files (in the
  current topology; see [§1.2](#12-trust-split)). It holds all room state in
  process memory — no database, no disk.
- **One participant per meeting is the leader**, a signaling-level role (not
  a media role) used purely for moderation: guest permissions and an
  optional waiting room. See [`permissions-and-leader.md`](permissions-and-leader.md).
- **Screen sharing is a transient room state**, not a role: any participant
  may claim it, and at most one holds it at a time.
- **The link's fragment carries a symmetric key the server never sees**,
  which every client uses to encrypt everything it sends through the
  signaling relay. See [`e2e-encryption.md`](e2e-encryption.md).

### 1.2 Trust Split

The frontend (static HTML/CSS/JS) and the signaling backend (API + WebSocket)
support being deployed as two independent origins with two independent
operators' worth of trust: a static origin serves the frontend, and the
signaling server serves only `/api/*`, `/config`, `/version.json`, and
`/ws`. This means compromising the signaling server alone does not let an
attacker serve tampered client code — see
[`e2e-encryption.md` §4](e2e-encryption.md) for why that matters. This split
is optional: the same backend can also serve the static files itself for a
single-origin, single-binary deployment — see
[`self-hosting.md`](self-hosting.md).

## 2. Principles & Constraints

### 2.1 Design Principles

#### Peer-to-Peer First

- [x] `p1` - **ID**: `cpt-chat-principle-p2p-first`

Media (audio/video) and chat content MUST travel directly between
participants' browsers. The signaling backend is a bootstrap and moderation
channel, never a data path for meeting content. See
[`webrtc-mesh.md`](webrtc-mesh.md) and [`chat.md`](chat.md).

#### Ephemeral by Construction

- [x] `p1` - **ID**: `cpt-chat-principle-ephemeral`

No component MUST persist meeting state to disk or to any store that
survives a process restart. All room state lives in an in-memory map behind
a single mutex; a server restart or a reaper sweep erases it completely. See
[`privacy.md`](privacy.md) and [`state.rs`](../src/state.rs).

#### Anonymous by Default

- [x] `p1` - **ID**: `cpt-chat-principle-anonymous`

The product MUST NOT use cookies, `localStorage`, or any other
cross-session identifier. A display name is supplied fresh per join — the
join modal pre-fills a locally generated suggestion, but nothing is
persisted or remembered between visits — and lives only in the tab's memory.
See [`privacy.md`](privacy.md).

#### Encrypted Signaling, Not Just Encrypted Media

- [x] `p1` - **ID**: `cpt-chat-principle-e2e`

WebRTC already encrypts media and data-channel traffic in transit (DTLS)
between the two peers exchanging it. What is *not* inherently protected is
the signaling relay itself: unencrypted SDP/ICE traffic would let a
compromised or coerced backend read connection metadata and, more
seriously, tamper with DTLS fingerprints to sit in the middle of a
connection. Every field the client sends through the signaling relay is
therefore encrypted client-side under a key the server never has. See
[`e2e-encryption.md`](e2e-encryption.md). This contains a *relaying* server;
the residual case of an active MITM that poisons the link itself (handing
different keys to different participants) is caught by human comparison of a
Short Authentication String — see [`sas-verification.md`](sas-verification.md).

### 2.2 Constraints

#### No Server-Side Media Stack

- [x] `p1` - **ID**: `cpt-chat-constraint-no-server-media`

The backend MUST NOT implement or depend on a WebRTC media stack. All
`RTCPeerConnection`/`getUserMedia`/`getDisplayMedia` logic lives in the
browser frontend. This keeps the backend small, portable, and structurally
incapable of touching media content.

#### Single-Process, In-Memory State

- [x] `p1` - **ID**: `cpt-chat-constraint-single-process`

Room state MUST be held in a single process's memory (no external cache or
database), which in turn means the backend runs as exactly one replica.
See [`self-hosting.md`](self-hosting.md) for the consequence this has on
deploys (no rolling update / no horizontal scaling).

### 2.3 Observability

The backend exposes Prometheus metrics on a separate management port
(`GET /metrics`, `MGMT_PORT`, default `8081` — deliberately **not** the main
signaling port, so the scrape endpoint never shares a listener with
user-facing traffic; see [`self-hosting.md` §6](self-hosting.md#6-environment-variables)
and [`signaling-protocol.md` §2.8](signaling-protocol.md#28-get-metrics-management-port)).
The metrics are aggregate gauges/counters only — current room/participant/
pending-lobby counts and a lifetime room-creation counter (see
[`../src/metrics.rs`](../src/metrics.rs)) — never a room id, peer id, or any
other identifier as a label, which keeps this consistent with the
minimal-server-state principle in [§2.1](#21-design-principles) and the
guarantees in [`privacy.md`](privacy.md). A ready-made Grafana dashboard
ships at [`../deploy/monitoring/grafana-dashboard-chat.yaml`](../deploy/monitoring/grafana-dashboard-chat.yaml).

## 3. Component Model

| Component | Responsibility | Where specified |
|-----------|-----------------|------------------|
| Frontend SPA (`static/*.js`, plain HTML/CSS, no build step) | UI, WebRTC mesh, encryption/decryption, chat logic, permission enforcement on the receiving side | [`webrtc-mesh.md`](webrtc-mesh.md), [`e2e-encryption.md`](e2e-encryption.md), [`chat.md`](chat.md) |
| Signaling server (Rust/axum, `src/`) | Room lifecycle, membership, leader/lobby state, message relay, rate limiting, TURN credential issuance, optionally serving the static frontend too | [`signaling-protocol.md`](signaling-protocol.md), [`permissions-and-leader.md`](permissions-and-leader.md), [`security.md`](security.md) |
| TURN server (third-party, e.g. `coturn`/`turn-rs`) | Optional fallback media relay when a direct peer connection fails | [`webrtc-mesh.md`](webrtc-mesh.md), [`self-hosting.md`](self-hosting.md) |
| Static origin (optional, separate from the signaling server) | Serves the frontend from an origin independent of the signaling server, for deployments that want the trust split in [§1.2](#12-trust-split) | [`self-hosting.md`](self-hosting.md) |

## 4. Technology Stack

| Layer | Technology |
|-------|------------|
| Backend HTTP/WebSocket server | Rust, `axum`, `tokio` |
| Backend state | In-memory `HashMap` behind `std::sync::Mutex` — no database, no disk |
| Frontend | Vanilla JavaScript (no framework, no bundler/build step), `SubtleCrypto` (WebCrypto) for encryption |
| Real-time transport | WebRTC (`RTCPeerConnection`, `RTCDataChannel`), STUN (public), TURN (any RFC 5766-compatible server, optional) |
| Deployment | A single container image (backend binary + static assets); can run as one process behind any reverse proxy, or split across a container orchestrator and a static host — see [`self-hosting.md`](self-hosting.md) |
| CI/CD (this repository's own pipeline) | Protocol and browser end-to-end tests gate the image build; deployment mechanics are left to the operator — see [`self-hosting.md`](self-hosting.md) |

## 5. Where to Find What

| Topic | Document |
|-------|----------|
| Every HTTP endpoint and WebSocket message, field by field | [`signaling-protocol.md`](signaling-protocol.md) |
| Mesh topology, perfect negotiation, the data-channel bus, ICE/TURN | [`webrtc-mesh.md`](webrtc-mesh.md) |
| Key derivation, what is encrypted vs. visible to the server, threat model | [`e2e-encryption.md`](e2e-encryption.md) |
| Chat envelope format, ordering, reactions/replies/edit/delete, file transfer | [`chat.md`](chat.md) |
| Leader election/succession, room settings, waiting room, enforcement boundaries | [`permissions-and-leader.md`](permissions-and-leader.md) |
| Full threat model and DoS mitigations | [`security.md`](security.md) |
| Human-checkable MITM protection: the commit-before-reveal SAS (emoji) protocol | [`sas-verification.md`](sas-verification.md) |
| Running your own instance: single-binary vs. split deployment, reverse proxy/TLS, TURN, environment variables | [`self-hosting.md`](self-hosting.md) |
| What the server can and cannot see, retention/TTL behavior | [`privacy.md`](privacy.md) |
| Prometheus metrics, management port, Grafana dashboard | [`self-hosting.md` §7.4](self-hosting.md#74-metrics--dashboard), [`signaling-protocol.md` §2.8](signaling-protocol.md#28-get-metrics-management-port) |

## 6. Traceability

| PRD Requirement | Implemented In | Tech Doc |
|------------------|-----------------|----------|
| `cpt-chat-fr-create-meeting` | `POST /api/rooms` | [`signaling-protocol.md`](signaling-protocol.md) |
| `cpt-chat-fr-share-link` | Client-generated auth token + expiry in the URL fragment; QR rendered locally | [`e2e-encryption.md`](e2e-encryption.md) |
| `cpt-chat-fr-join-meeting` | `join-room` WebSocket message, room size cap | [`signaling-protocol.md`](signaling-protocol.md) |
| `cpt-chat-fr-av-mute` | Local track enable/disable, no renegotiation | [`webrtc-mesh.md`](webrtc-mesh.md) |
| `cpt-chat-fr-screen-share` | `share-start`/`share-stop`/`share-started`/`share-rejected`, server-held single-owner lock, last-wins preemption on conflict | [`signaling-protocol.md`](signaling-protocol.md), [`permissions-and-leader.md`](permissions-and-leader.md) |
| `cpt-chat-fr-chat` | Mesh `RTCDataChannel` chat bus, message envelope, lamport ordering | [`chat.md`](chat.md) |
| `cpt-chat-fr-file-share` | Per-file `RTCDataChannel`, chunked transfer with backpressure | [`chat.md`](chat.md) |
| `cpt-chat-fr-leader-role` | `leaderToken`, deterministic succession by earliest `joined_at` | [`permissions-and-leader.md`](permissions-and-leader.md) |
| `cpt-chat-fr-guest-permissions` | `RoomSettings`, `update-settings`/`settings-changed` | [`permissions-and-leader.md`](permissions-and-leader.md) |
| `cpt-chat-fr-waiting-room` | `lobbyEnabled`, `join-request`/`approve`/`reject` | [`permissions-and-leader.md`](permissions-and-leader.md) |
| `cpt-chat-fr-anonymity` | No cookies/`localStorage`; name entered per join, encrypted in transit | [`privacy.md`](privacy.md), [`e2e-encryption.md`](e2e-encryption.md) |
| `cpt-chat-nfr-privacy` | Client-side encryption of everything relayed by the server; server never holds chat content | [`e2e-encryption.md`](e2e-encryption.md), [`privacy.md`](privacy.md) |
| `cpt-chat-nfr-ephemerality` | In-memory-only state, empty-room TTL reaper, max meeting lifetime reaper | [`privacy.md`](privacy.md), [`security.md`](security.md) |
| `cpt-chat-nfr-no-install` / `cpt-chat-nfr-mobile` | Browser-only WebRTC/WebCrypto frontend, responsive layout, capability detection (e.g. hiding screen share where unsupported) | [`webrtc-mesh.md`](webrtc-mesh.md) |
