# End-to-End Encryption of Signaling

<!-- toc -->

- [1. Why This Exists](#1-why-this-exists)
- [2. Key Model](#2-key-model)
  - [2.1 The Link Token `t` — Authentication Only, Never Encryption](#21-the-link-token-t--authentication-only-never-encryption)
  - [2.2 Expiry `e` — A Cryptographic Boundary, Not a Runtime Check](#22-expiry-e--a-cryptographic-boundary-not-a-runtime-check)
  - [2.3 Ephemeral Per-Tab Keys & Pairwise Derivation (Forward Secrecy)](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy)
  - [2.4 Wire Format](#24-wire-format)
- [3. What Is Encrypted, What Isn't](#3-what-is-encrypted-what-isnt)
  - [3.1 Encrypted Under a Pairwise Key](#31-encrypted-under-a-pairwise-key)
  - [3.2 Never Touched by This Layer (Already E2E via DTLS)](#32-never-touched-by-this-layer-already-e2e-via-dtls)
  - [3.3 What Remains Visible to the Server Regardless](#33-what-remains-visible-to-the-server-regardless)
- [4. Trust Split (Static Origin vs. Signaling Server)](#4-trust-split-static-origin-vs-signaling-server)
- [5. Threat Model](#5-threat-model)
- [6. Known Limitations](#6-known-limitations)

<!-- /toc -->

> Source of truth: [`../static/crypto.js`](../static/crypto.js) (token/expiry
> derivation, ephemeral keypairs, pairwise key derivation, encrypt/decrypt —
> its file header walks through the whole model in detail), [`../static/rtc.js`](../static/rtc.js)
> (where signaling ciphertext is produced/consumed), [`../static/room.js`](../static/room.js)
> (per-tab crypto identity, pairwise key cache, name-announce),
> [`../static/landing.js`](../static/landing.js) (token/expiry generation at
> room creation). Wire-level field shapes are in
> [`signaling-protocol.md`](signaling-protocol.md). This is the "v2" key
> model (internally "variant E"); see
> [`research-p2p-key-handoff.md` §6.5–6.6](research-p2p-key-handoff.md) for
> the design rationale and the v1 model it replaced.

## 1. Why This Exists

Before this layer existed, the signaling server saw SDP offers/answers and
ICE candidates in plaintext. It had no legitimate reason to parse them (and
didn't — it only relayed them), but nothing *structurally* prevented a
compromised or coerced server (or anyone with access to traffic reaching it)
from reading them, and — more seriously — from rewriting the DTLS
fingerprints embedded in the SDP to insert itself as a man-in-the-middle of
a WebRTC connection, even though the media itself travels peer-to-peer. This
phase removes that capability structurally rather than by policy: the
signaling server never has a key that can read or tamper with what it
relays.

The v2 model adds a second property on top of the original one: **forward
secrecy for the relay layer**. A link is a piece of text that gets copied
into chats, pasted into calendar invites, and generally outlives the meeting
it was for. Under the original (v1) design, the same secret that lived in
the link *was* the encryption key — anyone who obtained that link later,
even long after the call ended, could decrypt every SDP/ICE/name blob they
had recorded from the relay while it happened. v2 keeps the link exactly as
convenient as before (same "paste it, done" UX, same survival across
reload/late-join/empty-room) while making sure a **later** link leak can't
unlock a **past** session — see [§2.3](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy).

## 2. Key Model

### 2.1 The Link Token `t` — Authentication Only, Never Encryption

The link carries a static secret, `t` — 16 random bytes generated
**client-side** when a meeting is created (see
[`../static/landing.js`](../static/landing.js): `RoomCrypto.generateRoomToken()`),
base64url-encoded (22 characters, no padding) into the URL **fragment**
(`#t=...`). As before, the fragment is never sent to any server by the
browser under any normal navigation, so the signaling server never sees `t`.

The load-bearing difference from v1: `t` itself **never encrypts a single
byte of traffic**. It only feeds an HKDF that produces `K_auth` (see
[§2.2](#22-expiry-e--a-cryptographic-boundary-not-a-runtime-check)), which in
turn is used only as an HKDF **salt** — never directly as an AES key — for
the real, ephemeral, per-pair encryption keys described in
[§2.3](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy).
"Sharing the link is the entire key-distribution mechanism" remains true —
`t` (plus the room id in the path) is still everything a participant needs
to authenticate into the session — but the thing being distributed is now an
*authenticator*, not a *decryption key*. See [`privacy.md`](privacy.md) for
what this implies about who can read a meeting, and
[§6](#6-known-limitations) for what leaking `t` still grants.

### 2.2 Expiry `e` — A Cryptographic Boundary, Not a Runtime Check

The link also carries `e` — a base36-encoded unix timestamp — computed at
room creation as `floor(Date.now()/1000) + lifetimeSeconds + 300`
(`lifetimeSeconds` comes from the `POST /api/rooms` response, i.e. the
server's own `MAX_ROOM_LIFETIME_SECONDS`; +300 is a 5-minute grace window
for clock skew between client and server — see
[`../static/landing.js`](../static/landing.js)).

```
K_auth = HKDF-SHA256(ikm = t, salt = ∅, info = "auth-v2|" + e)   // 32 raw bytes
```

`e` is not merely checked by the client before joining (though it is, once,
at entry — see [`../static/room.js`](../static/room.js): `initCryptoIdentity`)
— it is baked directly into the `info` string used to derive `K_auth`. This
makes expiry a **cryptographic boundary, not a policy check**: a client
running modified code that skips the client-side expiry check gains nothing,
because a different `e` produces a different `K_auth` and, transitively, a
different pairwise key from every honest participant's — decryption simply
fails (see [§2.3](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy)
on how that failure surfaces). The runtime check exists purely for a better
error message ("Link expired" vs. a generic crypto failure); it is
deliberately **not** re-checked mid-call, so a participant's clock skew can
never kick them out of a call already in progress — the server's own
`MAX_ROOM_LIFETIME_SECONDS`/`room-expired` remains the thing that actually
bounds a room's runtime lifetime (see [`security.md` §8](security.md#8-meeting-duration-ceiling)).

### 2.3 Ephemeral Per-Tab Keys & Pairwise Derivation (Forward Secrecy)

Every tab, on entering a room, generates a **one-time, per-tab-session**
ECDH P-256 keypair (see
[`../static/crypto.js`](../static/crypto.js): `generateEphemeralKeyPair`) —
before it even sends `join-room`. This keypair is never persisted anywhere
(no storage of any kind — see [`privacy.md`](privacy.md)); it lives only in
that tab's memory and is gone the moment the tab closes or reloads. The
public half (`epub`, the raw P-256 point base64url-encoded, ~87 characters)
is sent over signaling — the server sees it, and *needs* to, purely to relay
it to other participants so they can derive pairwise keys; it isn't secret
and carries no risk by being server-visible (see
[`signaling-protocol.md`](signaling-protocol.md) for exactly where `epub`
appears on the wire).

For every pair of participants X, Y, both sides independently compute the
same **pairwise transcript**:

```
s_X = peerId_X + ":" + epub_X
s_Y = peerId_Y + ":" + epub_Y
TH  = SHA-256("pair-v2|" + roomId + "|" + min(s_X, s_Y) + "|" + max(s_X, s_Y) + "|" + e)
```

(sorted lexicographically so both sides land on the identical string
regardless of who computes it first), then run ECDH between their own
private key and the other side's `epub` to get a raw shared secret, and
derive two independent AES-256-GCM keys from it, **salted with `K_auth`**:

```
K_pair_sig  = HKDF-SHA256(ikm = shared, salt = K_auth, info = "pairsig-v2|"  + TH)
K_pair_meta = HKDF-SHA256(ikm = shared, salt = K_auth, info = "pairmeta-v2|" + TH)
```

`K_pair_sig` encrypts `sdp`/`candidate`/`info` relayed for that pair;
`K_pair_meta` encrypts that pair's `name-announce` payload (see
[§3.1](#31-encrypted-under-a-pairwise-key)). Every pair of participants gets
its own independent pair of keys — there is no longer a single room-wide key
that, if somehow recovered, would expose every relayed message in the room
at once.

**Why the PSK-in-salt gives authentication with no explicit confirm
messages.** ECDH by itself only authenticates possession of a private key —
a MITM server can run a *separate* ECDH exchange with each side of a pair
(the textbook DH man-in-the-middle) and silently relay/rewrite traffic under
two different shared secrets, exactly as it could under v1's raw signaling.
But `K_auth` — derived from `t`, a secret that never crosses the wire — is
the HKDF *salt* of both derived keys: an attacker without `t` gets a
different `K_auth`, and therefore, through HKDF, a different
`K_pair_sig`/`K_pair_meta` from the real one on every leg, even if her ECDH
exchange was technically flawless on both sides. The very first message
encrypted under the wrong key fails the honest side's AES-GCM tag check —
`crypto.subtle.decrypt` throws by itself (see
[`../static/room.js`](../static/room.js): `handleCryptoFailureOnce`) — so no
separate protocol round of "did we derive the same key?" is needed; the
confirmation is the cryptography itself.

**Forward secrecy, concretely.** Because the ephemeral keypair never leaves
tab memory and is never written anywhere, obtaining `t`/`e` *after* a
session has ended — the link leaked later, a chat log with the invite in it
surfaces months afterward — gives an attacker no way to recover the private
half of any past ephemeral keypair, and therefore no way to redo the ECDH
that produced any past `K_pair_sig`/`K_pair_meta`. Whatever `sdp`/`candidate`/
`info`/name ciphertext a server operator recorded from the relay during that
call — which includes participants' IP addresses (via ICE candidates), SDP
bodies, and display names — stays unreadable. This closes exactly the gap
`t`'s static nature would otherwise leave open; see
[§6](#6-known-limitations) for what a leak **during** a live session still
grants (unchanged from v1: full access, same as anyone else in the room).

### 2.4 Wire Format

- **Opaque object form**, for JSON-typed protocol fields (`sdp`, `candidate`,
  `info`): `{ v: 2, iv: base64, ct: base64 }` (`v` bumped from `1`: the v1
  room-wide scheme and v2's pairwise scheme derive incompatible keys, and the
  version bump is a deliberate tripwire against silently mixing them during a
  rollout — see [`../static/crypto.js`](../static/crypto.js):
  `encryptJson`/`decryptJson`).
- **Opaque string form**, for the one protocol field that must stay a plain
  string rather than an object — the `payload` of `name-announce` (see
  [§3.1](#31-encrypted-under-a-pairwise-key)): IV and ciphertext are
  concatenated and the whole thing base64-encoded into one string (see
  `encryptToBase64`/`decryptFromBase64`).

Both forms use AES-256-GCM with a random 12-byte IV. The `name` field still
present in `join-room`/`peer-joined` (kept in the schema for backward
compatibility — see [`signaling-protocol.md`](signaling-protocol.md)) is
always `null` from a v2 client: a display name now travels **only** as a
`name-announce` payload under the recipient's `K_pair_meta`, never as a
value directly on `join-room`/`peer-joined`.

## 3. What Is Encrypted, What Isn't

### 3.1 Encrypted Under a Pairwise Key

- `sdp` / `candidate` / `info` in `offer` / `answer` / `ice-candidate` /
  `stream-info` — the server sees only `{v, iv, ct}`, never a real SDP body
  or its DTLS fingerprints. Encrypted under the sender/recipient pair's
  `K_pair_sig`.
- The participant's display name — sent as a separate `name-announce`
  message's `payload`, encrypted under the sender/recipient pair's
  `K_pair_meta`, as one base64 string (see
  [§2.4](#24-wire-format)). Unlike v1 (where a decryption failure on the name
  silently fell back to a placeholder), a v2 `name-announce` that fails to
  decrypt is treated the same as any other pairwise crypto failure — see
  [`../static/room.js`](../static/room.js): `decryptNameAnnouncePayload`. A
  tile simply shows the generic "Guest" placeholder until a name-announce is
  received and decrypts successfully, which is indistinguishable from "this
  participant hasn't sent a name yet."

Chat is **not** in this list: it travels only over the P2P bus, already E2E
via DTLS, so nothing chat-related is encrypted by this layer (the former
server-relayed chat fallback and its `K_chat` were removed — see
[`chat.md` §12](chat.md#12-no-server-fallback)).

### 3.2 Never Touched by This Layer (Already E2E via DTLS)

The mesh data-channel bus (chat, `stream-info` snapshots once the bus is
open — see [`webrtc-mesh.md`](webrtc-mesh.md)) and media tracks are **not**
encrypted by this layer: WebRTC is required to carry both over DTLS between
the two specific browsers involved, which is already a complete end-to-end
guarantee for that pair — and, unlike the relay layer before v2, that DTLS
transport already had forward secrecy from its own ephemeral handshake keys.
A second application-level encryption pass over traffic that already has
this property would add no new security guarantee, only CPU cost.

### 3.3 What Remains Visible to the Server Regardless

Even with this layer fully in place, the signaling server (and anyone with
equivalent access to it) still sees: participants' IP addresses (at the
transport level — see [`privacy.md`](privacy.md) on what is and isn't
logged), the room id, each participant's peer id and ephemeral public key
(`epub` — harmless to expose; see [§2.3](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy)),
the timing of connections/messages, and the bare fact that some set of peer
ids is sharing a room. None of the *content* (what was said, how someone is
named, what video is playing) is visible — but this metadata is not, and
cannot be without a fundamentally different architecture (see
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
  ciphertext without deriving the correct pairwise key, which requires `t`,
  so a tampered SDP fails to decrypt rather than silently succeeding with
  attacker-controlled fingerprints.
- **Recovering a past session's relayed content from a link that leaks
  later.** Because the encryption keys are ephemeral and pairwise (see
  [§2.3](#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy)),
  possessing `t`/`e` after the fact is not enough — the ephemeral private
  keys that produced the actual AES keys are gone.

What it does **not** defend against (see [§6](#6-known-limitations) and
[`security.md`](security.md) for the fuller threat catalog):

- Anyone who has the meeting link has `t` and can authenticate into the room
  and derive pairwise keys with every other current participant — the link
  **is** the credential; there is no separate per-participant authentication.
  This is unchanged from v1: a link leaking **during** the room's life grants
  full access, exactly as before.
- **An active MITM that poisons the link itself.** The "active server
  tampering with fingerprints" defense above holds only while the server
  *relays* — it cannot forge a valid ciphertext without `t`. It does **not**
  cover an attacker who controls how the link reaches a participant (or who
  fully controls the relay and runs an active bridge): such an attacker can
  hand *different* tokens `t` to different participants and stitch the
  halves, and every ciphertext still decrypts cleanly because each half is
  internally consistent (each side derives its own, internally-consistent
  `K_auth` and pairwise keys from the token it was handed). Transport
  encryption can't close this (neither can TLS, hence CAs); with no PKI
  here, it's closed by human out-of-band comparison of a Short
  Authentication String — see [`sas-verification.md`](sas-verification.md).
- Metadata visible to the server regardless of this layer (see
  [§3.3](#33-what-remains-visible-to-the-server-regardless)).
- The media and chat content once it's flowing over the mesh — that's
  protected by DTLS/WebRTC itself, a different (and, for that traffic,
  sufficient) mechanism.

## 6. Known Limitations

- **A link leaking *during* the room's live session is exactly as bad as
  before.** Forward secrecy protects the *past* — it means nothing about the
  *present*. Anyone who obtains a working `t`/`e` while the room is still
  live can join and derive pairwise keys with everyone in it, same as any
  other participant. This is inherent to the model (see
  [`PRD.md` §5.5](PRD.md#55-anonymity)) and is not something v2 changes or
  claims to change.
- **Trust between room participants is assumed, not verified.** Anyone who
  has the link can authenticate the same way as everyone else; there is no
  per-participant identity or signature layer distinguishing "a legitimate
  invitee" from "anyone who obtained the link." This is consistent with the
  product's anonymity goals (see [`PRD.md` §5.5](PRD.md#55-anonymity)) but
  means the encryption protects against the *server*, not against another
  room participant who might misbehave. What participants *can* verify, with
  no identity layer, is that they share **one un-bridged session** — the
  commit-before-reveal SAS in [`sas-verification.md`](sas-verification.md),
  which now detects "different `t` handed to different sides" rather than
  "different room key handed to different sides," but closes the identical
  gap.
- **The trust split in [§4](#4-trust-split-static-origin-vs-signaling-server)
  is opt-in at the deployment level.** A single-origin deployment does not
  get that property automatically — see [`self-hosting.md`](self-hosting.md).
