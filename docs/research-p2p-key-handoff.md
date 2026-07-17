# Research: Handing Off the Room Secret P2P Instead of via URL

> Status: analysis only, nothing implemented. 2026-07-16.
> Question: can the secret be removed from the URL (leaving only a short but
> unguessable room id), with the room key `k` handed from the creator to a
> participant over P2P — either to approved arrivals (with a lobby) or to
> anyone who knocks (without a lobby) — **with zero compromise** relative to
> the current model.

## 1. What `#k` in the URL Does Today — Three Roles of One Secret

Today's `k` (32 bytes in the link fragment) simultaneously performs three
functions:

| Role | Mechanism |
|---|---|
| **Admission** | Possession of the link = the right to enter. A bearer capability; no other authentication exists — deliberately (security.md §9). |
| **Root of authentication against MITM** | SDP/ICE are encrypted under K_sig=HKDF(k). The relay server cannot substitute DTLS fingerprints: a forgery won't decrypt (the GCM tag). This works **only because the two sides share the secret BEFORE the first network exchange**. |
| **Confidentiality bootstrap** | K_meta (names), the root anchor of the whole E2E model. |

The key fact underlying everything that follows: **the URL is an
out-of-band channel** (the creator hands it to the guest directly — via
messenger, voice, QR code) that the server does not control. It is
precisely this that makes MITM protection possible.

## 2. The Fundamental Limitation

Two parties who share neither a secret nor each other's authentic public
key **cannot** establish a secure channel through an intermediary that
controls all of their traffic (the classic case: unauthenticated DH is
broken by an active MITM). When a guest enters a room, ALL of the guest's
traffic (WS signaling, ICE, and therefore the establishment of any "P2P"
channel) goes through the server.

Consequence: **something authenticating must reach the guest outside the
server — that is, in the link**. The question is not "can everything be
removed from the URL" (it cannot — that would itself be the compromise),
but "what is the shortest, least-secret thing the URL can carry without
security degrading."

This immediately yields two verdicts on the ideas from the brief:

### 2.1. "The URL carries only a server-visible id, the server knows id→creator" — REJECT

If the link contains nothing but an id that the server sees (path/API),
then:
- **Without a lobby**: "hand `k` to anyone who knocks with a valid id" —
  the server knows every id ⇒ the server can knock itself and get `k`.
  Today the server cannot cryptographically enter a room under any
  circumstances. A straightforward weakening.
- **With a lobby**: approval is a human decision based on a self-reported
  name. The server knocks as "Bob from work," the creator approves.
  Today's admission rule ("possession of the link") is replaced by
  "ability to talk the creator into it" — a weakening.
- MITM: the server doesn't even need to knock — it can insert itself into
  the middle of the guest↔creator handshake, because the guest has no way
  to verify that it's really the creator answering.

### 2.2. "The creator's IP address in the id / id→IP pairs on the server" — REJECT

- Technically dead on arrival: a browser cannot accept incoming
  connections (no listening sockets); WebRTC requires mutual signaling
  through a rendezvous server regardless, given NAT/CGNAT/mobile networks.
  There is nowhere in a browser to "reach by IP."
- Worse for privacy: today only the server sees participants' IP
  addresses, at the transport level (and doesn't store them —
  privacy.md §2). An IP in the link, or served up by an id lookup,
  exposes the creator's IP to everyone holding the link and to every
  intermediate log. A regression.
- A "digital signature of the secret" in the id: a signature doesn't hide
  the secret and doesn't replace its delivery; but **binding the
  creator's public key to the link** is a workable idea — that's variant B
  below.

## 3. Viable Options

The common scheme across all of them: URL = short routing id (path,
server-visible) + a compact authenticator in the **fragment** (never
visible to the server). The guest finds the room via the server by id,
establishes an authenticated ephemeral handshake with one of the
participants (ECDH over the WS relay and/or a DataChannel), proves
possession of the link, and that participant hands over `k` inside this
channel (immediately — without a lobby; after approval — with a lobby).
The server still neither stores nor sees `k` or the authenticator.

The options differ in **what lives in the fragment**:

### Variant B — Public Verifier of the Creator's Key (Recommended)

Fragment: `#a=<hash(room_pubkey)>`, 96–128 bits (16–22 base64url
characters).

- When a room is created, the creator's client generates an ephemeral
  keypair (ECDSA P-256 / Ed25519 — available in WebCrypto). The link
  carries the hash of the public key.
- The guest checks the pubkey presented during the handshake against the
  hash from the link ⇒ an MITM server would have to present a key with
  the same hash ⇒ an offline search of ≥2^96.
- The guest proves possession of the link by binding knowledge of `a`
  into the transcript (HMAC/HKDF of `a`) ⇒ a server that never saw the
  fragment cannot knock ⇒ admission remains "by possession of the link,"
  as today. The lobby is an optional human layer on top, exactly as now.
- **Philosophically clean: the fragment no longer holds a secret at
  all** — only a public verifier. A URL leaking into logs/screenshots
  after the meeting yields nothing (see §5 on forward secrecy).
- So that handing out keys isn't limited to the creator: along with `k`,
  every admitted participant also receives the room's private key —
  then anyone online can serve the next arrival (see §6 on
  availability).

### Variant D — Symmetric Bootstrap Token (Simpler to Engineer)

Fragment: `#t=<96–128-bit token>`. Handshake: ephemeral ECDH, the
transcript signed with HMAC(HKDF(t)) on both sides — the token plays the
same role as today's `k`, but **only at the moment of the handshake**;
the room key itself is delivered inside that channel.

- Implemented entirely on WebCrypto (ECDH + HKDF + HMAC), minimal new
  code.
- Downside: the URL formally still carries a secret (shorter and more
  single-use in spirit, but a secret). A passive observer of the
  handshake can check token candidates offline against the HMAC tags ⇒
  it cannot be shortened below ~96 bits.
- This is the smallest deviation from the letter of the brief ("no secret
  via the URL" — not achieved; "no encryption key via the URL" —
  achieved).

### Variant C — PAKE (Shortest Link, Most Expensive to Implement)

Fragment: a short code (6–10 characters is feasible, even ~40 bits). The
guest and the creator run a PAKE (CPace/SPAKE2) through the relay: an
offline attack on the short code is impossible by construction, an active
MITM gets exactly one online guess at the code per handshake attempt, and
every failure is visible to the creator (so it can be hard rate-limited).

- The only way to get a link noticeably shorter than a 16+ character
  authenticator **without** reducing strength.
- Downsides: WebCrypto has no PAKE and no hash-to-curve; this would
  require either a careful from-scratch implementation on top of
  X25519/P-256 (a cryptographic risk, contradicting the project's
  principle of "WebCrypto only, no libraries") or an external audited
  library (contradicting "no build, no deps"). For a project whose main
  feature is a verifiably simple crypto layer, this is a serious argument
  against it.

### Comparison

| | Today (`#k`) | B (verifier) | D (token) | C (PAKE) |
|---|---|---|---|---|
| Encryption secret in the URL | **yes, forever** | no | no | no |
| Any secret at all in the URL | yes | **no (public hash)** | yes (bootstrap) | yes (short code) |
| Fragment length | 43 chars | 16–22 | 16–22 | 6–10 |
| Passive server | ✔ | ✔ | ✔ | ✔ |
| Active relay server (SDP substitution) | ✔ | ✔ | ✔ | ✔ |
| Server knocks and gets `k` | impossible | impossible | impossible | impossible |
| Retroactive decryption of recorded traffic on a later link leak | **possible** | no (PFS) | no (PFS) | no (PFS) |
| Attack on the link-delivery channel | SAS | SAS | SAS | SAS |
| New cryptography | — | ECDSA/ECDH (WebCrypto) | ECDH+HMAC (WebCrypto) | PAKE (not in WebCrypto) |
| New code/protocol | — | medium | little | a lot |

In all three variants, SAS remains and is needed for exactly the same
reason as today: an attacker who controls the link-delivery channel
itself is still outside the `k` model (and outside the `a`/`t` model) —
this is not a regression, it's the same known gap (sas-verification.md
§8). In variant B, SAS could in the future additionally be bound to the
room key (a minor, optional strengthening).

## 4. Entropy Requirements ("Short but Unguessable")

Two distinct quantities that must not be conflated:

1. **The routing id** (path, server-visible): protects only against an
   outsider's online brute-force. Today's 8 characters ≈ 39.6 bits plus
   rate limits are sufficient, including under the new scheme (failed
   "knocks" are additionally visible to participants). It can be left
   as-is.
2. **The authenticator in the fragment**: an **offline** attack is
   possible against it (searching keypairs against the hash in B;
   searching the token against intercepted HMACs in D) ⇒ a minimum of
   ~96 bits, comfortably 128. Cutting below that is already a compromise,
   except for variant C, where PAKE removes the whole offline-attack
   class.

A neat trick for "the URL carries only an id": **id = a truncated hash of
the authenticator** (`roomId = H(a)[..8]`), a link of the form
`/j#<one 22-character token>` — the page itself computes the routing id
and sends only that to the server. The URL has exactly one short
component; the server sees a derived value and never sees the fragment.

## 5. What the New Scheme Gives ON TOP OF Today's

- **Forward secrecy**: today `k` is static and sits in the link forever —
  whoever recorded the encrypted relay traffic and later obtained the
  link (a messenger history, a screenshot) can decrypt it retroactively.
  In B/D/C the key is delivered via an ephemeral ECDH: a link leak after
  the meeting yields nothing.
- In B, the secret disappears from the URL as a class: the link can be
  exposed in logs/the address bar with no consequence for confidentiality
  (admission into a live room is a separate matter, handled by the
  lobby).
- Cryptographic binding of admission: today a malicious server can "let
  in" anyone at the membership level (though it still can't decrypt
  anything); in the new scheme this is equally pointless — `k` is not
  handed out without proof of possessing the link.

## 6. The Cost: Availability and UX (An Honest List)

These are not compromises in cryptographic strength, but real changes in
behavior:

1. **A live participant must hand out the key.** Entering an empty (but
   still TTL-alive) room becomes impossible: you can knock, but there's
   no one to get `k` from — you have to wait for a participant. Today a
   guest with the link enters an empty room freely.
2. **An F5 by the last participant kills the room.** Today `#k` in the
   address bar survives a reload; in the new scheme `k` lives only in the
   tab's memory, and if the last key holder reloads — including the
   creator themselves — there's no one left to hand out `k`. The room
   would have to be re-created. There is no mitigation that doesn't
   violate the "no storage" principle (sessionStorage would violate
   privacy.md's documented promises). This is partly mitigated by having
   ALL participants hand out keys (not just the creator) — the room only
   dies if everyone leaves at once.
3. **+1–2 RTT and dependency on the key-granter being online** on every
   entry (including a reconnect with a new peerId after a guest's F5).
4. **More protocol means more surface area**: knocking, granting,
   delegating keys to new participants, anti-DoS on knocks (a ready-made
   template is the lobby with its `MAX_PENDING=10` and per-IP limits).
   Every new line of crypto code works against the project's main asset
   (a small, verifiable crypto layer).
5. **The link's semantics change**, and this needs to be honestly
   rewritten in privacy.md/README: "the link is the key" becomes "the
   link is the right to knock; live participants hand out keys." With a
   lobby this is strictly better in the event of a link leak; without a
   lobby it's equivalent to today.

## 6.5. Variant E — PFS **and** Surviving F5 at the Same Time (2026-07-16 Addendum)

**Implemented 2026-07-16** — see [`e2e-encryption.md`](e2e-encryption.md).

Requiring the pair "forward secrecy + F5 survives" reveals that the
conflict in §6 was not between PFS and reloading, but between PFS and
**the absence of a secret in the URL**. If only the latter is relaxed —
leaving a static secret in the URL but forbidding it from encrypting
traffic directly — both properties become achievable at once.

### 6.5.1. Clarification: What Exactly Gets Decrypted Retroactively Today

Media and chat already have PFS: they travel P2P over DTLS/DTLS-SRTP,
whose keys are derived from the ephemeral ECDHE of the DTLS handshake
itself — recorded P2P traffic is **not** exposed by a later link leak,
even today. Only the relay layer under the static K_sig/K_meta is
retroactively vulnerable: **SDP (including DTLS fingerprints), ICE
candidates (i.e., participants' IP addresses), stream-info, and display
names**. This is metadata, but sensitive metadata (IPs!). It's exactly
this that needs to be moved onto PFS.

### 6.5.2. The Scheme

The fragment keeps a static token `t` (like today's `k`, 128 bits / 22
characters works), but it becomes **purely authenticational**: by itself
it no longer decrypts anything.

- On every entry, the tab generates an ephemeral ECDH keypair. The
  ephemeral public key is not secret; it can travel directly in
  `join-room` / `joined` / `peer-joined` (the server sees it — harmless).
- For every pair of participants (A,B), the signaling session keys are
  derived from an ephemeral ECDH(A,B), and the transcript (roomId, the
  peerIds, both ephemeral keys) is confirmed with HMAC under
  K_auth = HKDF(t, "auth-v1"). This is the classic Noise-with-PSK / SIGMA
  pattern: the PSK gives mutual authentication (a server without `t` can
  neither insert itself nor knock), ECDHE gives PFS. Implemented entirely
  on WebCrypto (ECDH P-256/X25519 + HKDF + HMAC), no new primitives.
- SDP/ICE/stream-info are encrypted with pairwise session keys instead of
  the shared K_sig. The relay is already pairwise anyway (an offer from A
  to B) — no group key is needed.
- A participant's name: instead of the room-wide K_meta, encrypt to the
  recipient's "announced" ephemeral key (delivered to the leader in the
  lobby's `waiting`/`join-request` plumbing; to ordinary peers in
  `peer-joined`). The PFS granularity for names is the lifetime of the
  recipient's tab; that's sufficient.
- Once a tab closes, the ephemeral keys die → recorded relay traffic is
  not exposed even under a full leak of `t`.

### 6.5.3. Properties

| | Today (`#k`) | E (`#t` + ephemeral sessions) |
|---|---|---|
| F5 / empty room / late entry / "live key holder" | ✔ | ✔ identical to today |
| Passive server / active relay MITM | ✔ | ✔ (PSK authentication) |
| Server knocks / enters | impossible | impossible (doesn't see `t`) |
| Retroactive decryption of recorded relay traffic on a late link leak | IP, SDP, names | **nothing (PFS)** |
| Link leak during the room's lifetime | full access | full access (equivalent, deliberately) |
| Media/chat retroactively | already PFS (DTLS) | already PFS (DTLS) |
| Secret in the URL | yes, decrypting | yes, but **authenticating only** |
| Fragment length | 43 chars | 22 chars |
| Extra RTT on entry | — | ~0 (ephemeral keys ride in existing join messages) |
| SAS | needed against attacks on the link-delivery channel | unchanged |

Variant E is a strict Pareto improvement over the current model: no
property gets worse, retroactive relay privacy (IP/SDP/names) is gained,
the link is halved in length, and the UX doesn't change at all. The cost
is protocol work: pairwise sessions instead of a single room-wide key
(handshake plumbing in the join flow, replacing K_sig/K_meta, format
migration, a transcript against replay/cross-room — all textbook
Noise-PSK).

Variant B from §3 is not thereby ruled out: it's an orthogonal further
step ("no secret in the URL at all") that could someday be offered as an
option for rooms where the cost of a "live key holder" (§6) is
acceptable. But it is variant E that satisfies the "PFS + F5"
requirement.

## 6.6. Lifetime Embedded in the Token (Addendum)

**Implemented 2026-07-16** — see [`e2e-encryption.md` §2.2](e2e-encryption.md#22-expiry-e--a-cryptographic-boundary-not-a-runtime-check).

Question: does embedding an expiry into the token/secret ("after 3 hours
this token can no longer be used to join") buy anything?

The key point: expiry is a **policy, not cryptography**. Time cannot be
enforced cryptographically without a trusted party: someone's code will
check it against someone's clock. Three consequences follow:

1. **Useless against retroactive decryption.** Recorded ciphertext
   doesn't ask whether the token is still "valid": if the key is derived
   from the token (today's `k`), a later leak decrypts the recording
   regardless of any timestamps. Only an ephemeral DH (variant E) gives
   retroactive privacy, not expiry.
2. **Redundant against late entry.** The server already hard-kills a room
   after 3 hours (MAX_ROOM_LIFETIME) and an empty one after 120 seconds;
   a dead roomId doesn't route, so the link is useless anyway. Expiry in
   the token duplicates this.
3. **The one real gain is an E2E backstop against the server itself.**
   Today the room's lifetime limit rests solely on the server's honesty:
   a malicious/broken server could keep a room alive indefinitely,
   stretching the entry window for a leaked link. If the expiry is baked
   into the token and checked by **clients** (in variant E, this is
   free: fold expiry into the HKDF info, `K_auth = HKDF(t, "auth-v1" ‖
   expiry)`; no separate signature is needed — a party with a different
   expiry simply fails to agree on a key, and the timestamp can't be
   "clipped off"), then honest participants will refuse the handshake
   past the deadline no matter what the server thinks. This matches the
   project's "don't trust the server" philosophy, but protects only a
   narrow scenario: a leaked link + a server maliciously extending the
   room + honest participants still inside.

Costs: client clock skew (false rejections), a slightly longer URL (the
timestamp has to ride in the fragment), and the risk of a false sense of
security ("the link has expired, so a leak is nothing to worry about" —
wrong with respect to retroactive decryption, see point 1).

Verdict: as a standalone measure it's a useless addition (duplicates the
server-side limit, gives nothing cryptographically). As a nearly-free
strengthening inside variant E (expiry folded into the HKDF info), it's a
meaningful E2E backstop against a misbehaving server; it's only worth
adopting in this form. It would become genuinely useful on its own if
persistent/recurring rooms ever appear — there, short-lived invite
tokens, separated from the room secret, would become a full-fledged
mechanism.

## 7. Recommendation

0. If the requirement is "forward secrecy + surviving a page reload"
   (per the requester's 2026-07-16 clarification): **variant E (§6.5)** —
   the only one that delivers both properties at once, and a Pareto
   improvement over the current model with no UX changes. The remaining
   points below are for the original brief, "no secret in the URL
   whatsoever."
1. If the goal is "the encryption key is never in the URL, security is no
   lower, and the link is noticeably shorter": **variant B** (a public
   verifier in the fragment, all participants hand out keys, the lobby
   is an option on top). This is the only variant where the URL stops
   carrying secrets entirely, and it delivers forward secrecy as a bonus.
   Link shape: `https://…/j#Ab3xK9…22chars` (roughly half the length of
   today's).
2. If the goal is a minimal diff plus PFS, and the letter of "no secret
   in the URL" isn't essential: **variant D** (a link of the same
   length, a much simpler protocol).
3. Keep **variant C (PAKE)** as a longer-range target for an
   "~8-character link" — it's cryptographically honest, but requires a
   PAKE primitive that WebCrypto doesn't have; for this project, the
   cost in complexity/trust in the implementation currently outweighs
   the benefit.
4. The ideas of "id→creator's IP" and "a bare server-visible id" —
   reject (see §2.1–2.2): the first is infrastructurally impossible in a
   browser and worsens privacy; the second is strictly weaker than the
   current model in both modes (with and without a lobby).

The main trade-off of the solution overall is §6.1–6.2: the room starts
requiring a live key holder. If that's unacceptable for the "sent the
link, people trickle in whenever they can" scenario, the current `#k`
model remains optimal, and B's gains come down to "shorter link + PFS"
versus "the room dies along with the last tab."
