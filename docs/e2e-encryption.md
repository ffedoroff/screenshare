# End-to-End Encryption of Signaling

<!-- toc -->

- [1. Why This Exists](#1-why-this-exists)
- [2. Key Model](#2-key-model)
  - [2.1 The Room Key](#21-the-room-key)
  - [2.2 Key Derivation (HKDF-SHA256 → Three AES-256-GCM Keys)](#22-key-derivation-hkdf-sha256--three-aes-256-gcm-keys)
- [3. What Is Encrypted, What Isn't](#3-what-is-encrypted-what-isnt)
  - [3.1 Encrypted Under a Derived Key](#31-encrypted-under-a-derived-key)
  - [3.2 Never Touched by This Layer (Already E2E via DTLS)](#32-never-touched-by-this-layer-already-e2e-via-dtls)
  - [3.3 What Remains Visible to the Server Regardless](#33-what-remains-visible-to-the-server-regardless)
- [4. Trust Split (Static Origin vs. Signaling Server)](#4-trust-split-static-origin-vs-signaling-server)
- [5. Threat Model](#5-threat-model)
- [6. Known Limitations](#6-known-limitations)

<!-- /toc -->

> Source of truth: [`../static/crypto.js`](../static/crypto.js) (key
> derivation, encrypt/decrypt), [`../static/rtc.js`](../static/rtc.js) (where
> signaling ciphertext is produced/consumed), [`../static/landing.js`](../static/landing.js)
> (room-key generation at room creation). Wire-level field shapes are in
> [`signaling-protocol.md`](signaling-protocol.md).

## 1. Why This Exists

Before this layer existed, the signaling server saw SDP offers/answers and
ICE candidates in plaintext. It had no legitimate reason to parse them (and
didn't — it only relayed them), but nothing *structurally* prevented a
compromised or coerced server (or anyone with access to traffic reaching it)
from reading them, and — more seriously — from rewriting the DTLS
fingerprints embedded in the SDP to insert itself as a man-in-the-middle of
a WebRTC connection, even though the media itself travels peer-to-peer. This
phase removes that capability structurally rather than by policy: the
signaling server never has the key needed to read or tamper with what it
relays.

## 2. Key Model

### 2.1 The Room Key

The room key, `k`, is 32 random bytes generated **client-side** when a
meeting is created (see [`../static/landing.js`](../static/landing.js)) and
carried only in the URL **fragment** of the meeting link (`#k=...`). The
fragment is never sent to any server by the browser under any normal
navigation, so the signaling server never sees `k` and plays no part in
generating it. Sharing the link is therefore the entire key-distribution
mechanism — see [`privacy.md`](privacy.md) for what this implies about who
can read a meeting.

### 2.2 Key Derivation (HKDF-SHA256 → Three AES-256-GCM Keys)

From `k`, three independent AES-256-GCM keys are derived via HKDF-SHA256
(see [`../static/crypto.js`](../static/crypto.js): `deriveKeys`), one per
purpose, each with a distinct HKDF `info` string:

| Context | `info` string | Used for |
|---|---|---|
| `K_sig` | `"sig-v1"` | `sdp` / `candidate` / `info` fields relayed through the signaling server |
| `K_meta` | `"meta-v1"` | The participant's display name in `join-room` |
| `K_chat` | `"chat-v1"` | The addressed fallback chat envelope relayed through the server (see [`chat.md`](chat.md)) |

Deriving three separate keys from one `k` means compromising one context
(e.g., somehow recovering `K_chat`) gives no help recovering the other two.
The HKDF salt is intentionally empty: the only secret input material is `k`
itself (32 random bytes with adequate entropy) — HKDF's salt exists to
separate *independent* sources of key material, and there is only one source
here, with nothing else available to use as a salt (RFC 5869 explicitly
permits an empty salt).

Two wire encodings are used, both AES-256-GCM with a random 12-byte IV:

- **Opaque object form**, for JSON-typed protocol fields (`sdp`, `candidate`,
  `info`, the chat fallback envelope): `{ v: 1, iv: base64, ct: base64 }`.
- **Opaque string form**, for the one protocol field that must stay a plain
  string rather than an object — the participant's `name` in `join-room`:
  IV and ciphertext are concatenated and the whole thing base64-encoded into
  one string.

## 3. What Is Encrypted, What Isn't

### 3.1 Encrypted Under a Derived Key

- `sdp` / `candidate` / `info` in `offer` / `answer` / `ice-candidate` /
  `stream-info` — the server sees only `{v, iv, ct}`, never a real SDP body
  or its DTLS fingerprints.
- The participant's display name in `join-room` — a ciphertext string
  instead of plaintext; a peer that fails to decrypt it (wrong room key)
  falls back to showing a generic placeholder name rather than erroring.
- The addressed fallback chat envelope, wrapped whole as `{enc: {v, iv, ct}}`
  (see [`chat.md`](chat.md)).

### 3.2 Never Touched by This Layer (Already E2E via DTLS)

The mesh data-channel bus (chat, `stream-info` snapshots once the bus is
open — see [`webrtc-mesh.md`](webrtc-mesh.md)) and media tracks are **not**
encrypted by this layer: WebRTC is required to carry both over DTLS between
the two specific browsers involved, which is already a complete end-to-end
guarantee for that pair. A second application-level encryption pass over
traffic that already has this property would add no new security guarantee,
only CPU cost.

### 3.3 What Remains Visible to the Server Regardless

Even with this layer fully in place, the signaling server (and anyone with
equivalent access to it) still sees: participants' IP addresses (at the
transport level — see [`privacy.md`](privacy.md) on what is and isn't
logged), the room id, each participant's peer id, the timing of
connections/messages, and the bare fact that some set of peer ids is sharing
a room. None of the *content* (what was said, how someone is named, what
video is playing) is visible — but this metadata is not, and cannot be
without a fundamentally different architecture (see
[`webrtc-mesh.md` §1](webrtc-mesh.md#1-topology) on why a server-mediated
architecture was rejected).

## 4. Trust Split (Static Origin vs. Signaling Server)

Before this layer's server/frontend trust split, the same operator served
both the client JavaScript (including the encryption code itself) and the
signaling server — a compromised or coerced backend could in principle have
served tampered client code and defeated the whole scheme at its root. A
deployment that serves the static frontend from an origin independent of the
signaling server (see [`self-hosting.md`](self-hosting.md) and
[`DESIGN.md` §1.2](DESIGN.md#12-trust-split)) closes that gap: one operator
no longer needs to simultaneously control both the code the client runs and
the signaling channel that code talks to. This split is optional — a
single-origin deployment (one process serving both) remains supported and is
the simpler default, at the cost of reintroducing that single point of
trust.

## 5. Threat Model

What this layer defends against:

- **A passive observer of signaling traffic** (the server operator, or
  anyone with access to traffic reaching the signaling server) reading SDP
  bodies, ICE candidates, participant names, or fallback chat content.
- **An active signaling server tampering with DTLS fingerprints** in transit
  to man-in-the-middle a WebRTC connection — it cannot construct a valid
  ciphertext without the room key, so a tampered SDP fails to decrypt rather
  than silently succeeding with attacker-controlled fingerprints.

What it does **not** defend against (see [§6](#6-known-limitations) and
[`security.md`](security.md) for the fuller threat catalog):

- Anyone who has the meeting link has the room key and can decrypt
  everything relayed through the server for that room — the link **is**
  the credential; there is no separate per-participant authentication.
- Metadata visible to the server regardless of this layer (see
  [§3.3](#33-what-remains-visible-to-the-server-regardless)).
- The media and chat content once it's flowing over the mesh — that's
  protected by DTLS/WebRTC itself, a different (and, for that traffic,
  sufficient) mechanism.

## 6. Known Limitations

- **No forward secrecy.** The three derived keys live for the lifetime of
  the room key `k`, which itself lives for the lifetime of the meeting link.
  There is no ratcheting or per-message key rotation — recovering `k` at any
  point (for example, from a browser history or a leaked link) lets someone
  decrypt everything relayed through the server for that meeting,
  retroactively, for as long as they have access to that relayed traffic.
  A forward-secret ratchet was considered out of scope for this phase.
- **Trust between room participants is assumed, not verified.** Anyone who
  has the link can derive the same keys as everyone else; there is no
  per-participant identity or signature layer distinguishing "a legitimate
  invitee" from "anyone who obtained the link." This is consistent with the
  product's anonymity goals (see [`PRD.md` §5.5](PRD.md#55-anonymity)) but
  means the encryption protects against the *server*, not against another
  room participant who might misbehave.
- **The trust split in [§4](#4-trust-split-static-origin-vs-signaling-server)
  is opt-in at the deployment level.** A single-origin deployment does not
  get that property automatically — see [`self-hosting.md`](self-hosting.md).
