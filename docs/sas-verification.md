# SAS Verification — Human-Checkable MITM Protection

<!-- toc -->

- [1. Why This Exists — The Gap the Link Token Doesn't Close](#1-why-this-exists--the-gap-the-link-token-doesnt-close)
- [2. The Attack, Precisely](#2-the-attack-precisely)
- [3. Why the Obvious SAS Is Broken (and Why More Emoji Won't Save It)](#3-why-the-obvious-sas-is-broken-and-why-more-emoji-wont-save-it)
- [4. The Fix: Commit-Before-Reveal](#4-the-fix-commit-before-reveal)
- [5. Protocol Specification](#5-protocol-specification)
  - [5.1 Preconditions & Round Identity](#51-preconditions--round-identity)
  - [5.2 Phase 1 — Commit](#52-phase-1--commit)
  - [5.3 Phase 2 — Reveal](#53-phase-2--reveal)
  - [5.4 Phase 3 — Verify & Derive](#54-phase-3--verify--derive)
  - [5.5 Binding to the DTLS Fingerprints](#55-binding-to-the-dtls-fingerprints)
  - [5.6 Wire Format](#56-wire-format)
  - [5.7 The Emoji Encoding](#57-the-emoji-encoding)
- [6. Membership Changes, Churn, and Reconnects](#6-membership-changes-churn-and-reconnects)
- [7. Security Analysis](#7-security-analysis)
  - [7.1 Why There Is No Grind](#71-why-there-is-no-grind)
  - [7.2 Why the Fingerprint Binding Can't Be Ground Either](#72-why-the-fingerprint-binding-cant-be-ground-either)
  - [7.3 Equivocation Is Detected](#73-equivocation-is-detected)
  - [7.4 Comparison to ZRTP, and Why This Is Application-Layer](#74-comparison-to-zrtp-and-why-this-is-application-layer)
- [8. Threat Model — Stated Plainly](#8-threat-model--stated-plainly)
- [9. UI States](#9-ui-states)
- [10. Parameter Summary](#10-parameter-summary)

<!-- /toc -->

> Source of truth (once implemented): [`../static/crypto.js`](../static/crypto.js)
> (`deriveSas`, the `SAS_EMOJI` table, the commit hash helper) and
> [`../static/room.js`](../static/room.js) (the commit-reveal round state
> machine, `sessionCertificate`, the `sas-commit`/`sas-reveal` bus handlers,
> and `renderTopbarSas`/`openTopbarSasPopup`, the top-bar badge and its
> click-to-expand details popup — the SAS lives ONLY in the main window's top
> bar, `#topbar-sas`; there used to also be a copy in the chat panel's header,
> removed). This document is the specification the code implements; where the
> two disagree, the code is authoritative and this file is a bug.

## 1. Why This Exists — The Gap the Link Token Doesn't Close

The end-to-end signaling encryption ([`e2e-encryption.md`](e2e-encryption.md))
makes one guarantee very well: the **signaling server cannot read or tamper
with** what it relays, because everything sensitive it carries (SDP, ICE
candidates, names) is encrypted under pairwise keys derived from the link
token `t`, and `t` lives only in the link fragment and never reaches the
server (chat isn't even in this list — it never touches the server at all).
The browser itself then refuses any DTLS connection whose certificate doesn't
match the fingerprint carried in that (authenticated) SDP. So a **passive**
server, and an **active** server that only relays, are both fully contained:
the media path is authenticated by possession of `t`.

There is exactly one thing that chain does **not** cover, because the chain's
entire root of trust is *the link itself*:

> **What if the attacker controls how the link reaches you?**

The link token is distributed by sharing a URL. If an adversary sits on that
distribution channel — or fully controls the signaling relay and is willing to
run an active bridge rather than merely relay — they can hand **different
tokens `t` to different participants** and stitch the two halves together in
the middle. Each half is then perfectly, honestly encrypted… to the attacker. No
ciphertext fails to decrypt, no browser DTLS check fires, because within each
half everything is internally consistent. The cryptography did its job; the
*trust anchor was poisoned before the cryptography began*.

This is the classic man-in-the-middle, and no amount of transport encryption
removes it — TLS has the same problem, which is why it needs a CA system.
This project deliberately has **no** identity/PKI layer (see the anonymity
goals in [`PRD.md` §5.5](PRD.md#55-anonymity)), so it closes the gap the same
way secure phone systems do: a **Short Authentication String (SAS)** that
humans compare out-of-band. It is, in one line, **a human-friendly checksum of
the encryption key and the media path** — five emoji instead of 43 characters
of base64.

## 2. The Attack, Precisely

Two honest participants, Alice and Bob. An active MITM, Mallory, who controls
link distribution or the relay.

1. Mallory gives Alice a link carrying `t_A` and Bob a link carrying `t_B`
   (`t_A ≠ t_B`, both chosen by Mallory).
2. Alice's browser sets up a WebRTC session that is really **Alice ↔ Mallory**,
   encrypted under keys derived from `t_A`. Bob's is really **Bob ↔ Mallory**,
   under keys derived from `t_B`.
3. Mallory decrypts everything from Alice, re-encrypts to Bob, and vice versa.
   She sees and can alter all media and chat.
4. Alice and Bob each see a working call with the expected other person. No
   error fires anywhere.

A SAS defeats this because the value Alice sees is derived from **Alice's
half** (her key, the certificates on her leg) and Bob's from **Bob's half**.
If the two halves are the same real session, the values match. If Mallory is in
the middle, the two halves are different sessions and the values differ — *as
long as Mallory cannot force them to collide*. That last clause is the entire
ballgame, and it is where a naive design fails.

## 3. Why the Obvious SAS Is Broken (and Why More Emoji Won't Save It)

The obvious construction is: `SAS = HKDF(t, sorted DTLS fingerprints) → emoji`.
It is **broken**, and it is worth documenting exactly why, because the failure
is subtle and the instinctive fix (more emoji) does not work.

Mallory controls, *independently on each leg*, both `t` (she issued the links)
and her own DTLS certificate (she generates it). So:

- Alice displays `SAS_A = f(t_A, {fp_Alice, fp_Mallory→Alice})`.
- Bob displays `SAS_B = f(t_B, {fp_Bob, fp_Mallory→Bob})`.

Mallory doesn't need to hit a *fixed target* — she only needs `SAS_A == SAS_B`,
any value. So she does a **birthday attack**: vary `t_A` to build a table of
`SAS_A` values, vary `t_B` for a table of `SAS_B` values, look for any
collision. For an `n`-bit SAS this costs `~2^(n/2)` work instead of `2^n`, and
varying `t` is just a cheap HKDF recomputation.

For the 30-bit SAS this project uses (five emoji from a 64-symbol alphabet),
birthday work is `~2^16 ≈ 6.5×10^4` HKDF evaluations — **well under a tenth
of a second on a single laptop core**, in real time during call setup, before
the humans have finished reading the emoji aloud. Concretely:

| Attack path | Work | One CPU core |
|---|---|---|
| Grind `t` (HKDF), birthday | 2^16 | **~0.04 s** |
| Grind certificates, birthday | 2^16 | ~seconds, embarrassingly parallel |
| Grind `t` (HKDF), fixed-target preimage | 2^30 | ~12 min (but this isn't the attack Mallory needs) |

Making the string longer barely helps while the grind exists: because birthday
halves the exponent, reaching "years even on an ASIC" would need roughly **25
emoji** — hopelessly long for a human to compare. **The length is not the
problem. The free, adaptive grind is the problem.** The fix must remove the
grind, not lengthen the code.

## 4. The Fix: Commit-Before-Reveal

The grind works because Mallory chooses her contribution *after* seeing
everyone else's, and can try again as often as she likes. Remove both freedoms
and the attack collapses to a single blind guess.

The mechanism is **contributory randomness with a commitment**, the same core
idea ZRTP uses:

1. Every participant picks a fresh random nonce and publishes a **commitment**
   (a hash) to it — binding themselves to a value they cannot later change.
2. Only **after** collecting everyone's commitment does anyone **reveal** their
   nonce.
3. The SAS is derived from the full set of revealed nonces (plus the DTLS
   fingerprints, see [§5.5](#55-binding-to-the-dtls-fingerprints)).

Because Mallory must commit her nonces on both legs *before* she learns any
honest nonce, she cannot bias the result, and cannot retry without redoing the
whole handshake. Her probability of forcing `SAS_A == SAS_B` drops to a single
blind `2^-30 ≈ 9.3×10^-10` per call attempt — and now the 30-bit length is
entirely adequate, exactly as it is for ZRTP.

Note we do **not** need a shared secret (Diffie-Hellman) for this. We need a
common random value that **no party can control after the fact**. Committed
nonces deliver precisely that, and are dramatically simpler to audit than a
group DH agreement. (An ephemeral ECDH would also work and would additionally
yield a shared secret, but the SAS has no use for that secret, so the extra
machinery would be pure attack surface. We use nonces.)

## 5. Protocol Specification

### 5.1 Preconditions & Round Identity

A **round** runs over a fixed set of participants and produces one SAS. It
starts only once the mesh is *stable enough to bind to*: for the local
participant and every peer it counts as present, there must be **both** an open
data-channel bus **and** a known remote DTLS certificate fingerprint (read from
`RTCPeerConnection.getStats()`, `type: "remote-certificate"`). Fingerprints are
what tie the SAS to the real media transport, so a peer without one yet is not
included in the round.

The participant set is the local peer plus those peers. A round is identified
by both **who is present and which certificate each of them presents**:

```
peerTag_j = SHA-256(peerId_j)               // fixed-width hex, see below on why
member_j  = peerTag_j + ":" + normFp_j      // both pure lowercase hex → ":" is safe
roundId   = SHA-256( "sas-round-v2" + "|" + sortedMembers.join("|") )
```

Including the fingerprints in `roundId` — not just the peer ids — is
**load-bearing, not decorative**. If the round were keyed on peer ids alone, an
attacker could renegotiate her DTLS certificate *after* the reveal phase (a new
certificate does not change a peer id, which the signaling server assigns
independently) and grind the new fingerprint against the now-public nonces,
resurrecting exactly the birthday attack of
[§3](#3-why-the-obvious-sas-is-broken-and-why-more-emoji-wont-save-it). Binding
fingerprints into `roundId` makes **any** fingerprint change a new round with
fresh, freshly-committed nonces (see [§6](#6-membership-changes-churn-and-reconnects)
and [§7.2](#72-why-the-fingerprint-binding-cant-be-ground-either)), so there is
never a window in which a certificate can be ground against a revealed nonce.

**Canonical, injection-proof encoding.** Peer ids are, in the honest
deployment, UUIDs (the server rejects anything else — see
[`../src/ws.rs`](../src/ws.rs)), but the threat model for this whole feature is
a *malicious* relay, which is free to hand a client a peer id containing the
`|` or `:` delimiters and shift the field boundaries to make two different
membership sets encode to the same string. So we never concatenate raw peer ids:
each is first hashed to a fixed-width 64-hex-char `peerTag`, and fingerprints
are already normalized to pure lowercase hex ([§5.4](#54-phase-3--verify--derive)).
Every field fed into a hash is therefore a fixed-alphabet hex string in which
the `|`/`:` separators cannot occur — the encoding is unambiguous regardless of
what the server sends.

Using the *set itself* (identities + certificates) as the round identity means
no coordinator is needed: every participant who observes the same membership and
the same certificates computes the same `roundId` and runs the same round. When
membership **or any certificate** changes, `roundId` changes and a fresh round
begins automatically. Every protocol message carries its `roundId`; a message
whose `roundId` does not match the receiver's current round is ignored (it
belongs to a membership/transport the receiver has already moved on from).

Each participant reuses **one DTLS certificate for the whole session** across
all of its mesh connections (generated once at join, see
`sessionCertificate` in [`../static/room.js`](../static/room.js)). Without
this, a browser mints a fresh certificate per `RTCPeerConnection`, every peer
would observe a *different* fingerprint for the same person, and the
fingerprint set would never agree. One certificate per session ⇒ one stable
fingerprint per person, observed identically by everyone.

### 5.2 Phase 1 — Commit

Each participant `i`:

1. Generates a fresh 32-byte random nonce `N_i`.
2. Computes `commit_i = SHA-256( "sas-commit-v2" ‖ roundId ‖ peerTag_i ‖ N_i )`
   (all inputs hex; see [§5.1](#51-preconditions--round-identity) on `peerTag`).
   Binding `roundId` and `peerTag_i` into the hash domain-separates commitments
   across rounds and pins each commitment to its author. Because `roundId`
   already includes every fingerprint, the commitment is transitively bound to
   the certificates too.
3. Broadcasts `sas-commit` (see [§5.6](#56-wire-format)) over the P2P bus to
   every peer in the round.

### 5.3 Phase 2 — Reveal

A participant broadcasts its `sas-reveal` (carrying `N_i`) **only after it has
received and stored a `sas-commit` from every other participant in the round.**

This ordering is the security-critical step. Revealing your nonce before you
hold everyone else's commitment would let an attacker wait, observe your nonce,
and only then choose (and commit) theirs — restoring exactly the adaptive
freedom [§4](#4-the-fix-commit-before-reveal) removes. **Reveal is gated on
holding all commitments.**

### 5.4 Phase 3 — Verify & Derive

On receiving a `sas-reveal` with `N_j` from peer `j`, the receiver checks:

```
SHA-256( "sas-commit-v2" ‖ roundId ‖ peerTag_j ‖ N_j ) == commit_j   (stored in phase 1)
```

- **Mismatch** (or a reveal for which no commitment was stored) ⇒ the round is
  marked **failed**: the UI shows the ⚠️ mismatch state ([§9](#9-ui-states)).
  A mismatch means someone equivocated or a message was tampered with — either
  way the SAS cannot be trusted and must not be shown as if it were.
- **All reveals present and verified** ⇒ derive the SAS.

The SAS is derived from the round transcript, using the same injection-proof
encoding as `roundId` ([§5.1](#51-preconditions--round-identity)) — participants
ordered canonically by `peerTag`:

```
IKM  = concat, in peerTag order, of the raw 32-byte nonces N_j   (contributory randomness;
                                                                  fixed width ⇒ unambiguous)
info = "sas-v2" + "|" + join("|", for each in peerTag order: peerTag_j + ":" + normFp_j)
SAS  = HKDF-SHA256(IKM, salt = ∅, info) → 5 bytes → 5 emoji       (see §5.7)
```

where `normFp_j` is peer `j`'s DTLS fingerprint normalized to lowercase hex
with all non-hex characters stripped (so `"sha-256 AB:CD"`, `"ab:cd"`, and
`"AB CD"` all collapse to the same string — different browsers format
`getStats` fingerprints differently), and `peerTag_j = SHA-256(peerId_j)` in
hex. The nonces are fixed 32-byte blocks, so `IKM` needs no delimiter; `info`
contains only hex fields, so its `|`/`:` separators are unambiguous. Because
every honest participant sees the same nonce set and the same fingerprint set
and sorts both identically, they all compute an identical SAS.

### 5.5 Binding to the DTLS Fingerprints

The nonces alone would authenticate "we all ran one un-bridged commit-reveal
round," but not "…over the same media transport." An attacker could, in
principle, forward the nonce round faithfully end-to-end while still bridging
the actual DTLS media. Mixing each participant's **DTLS certificate
fingerprint** into `info` closes that: the SAS now also depends on the exact
certificates presented on the real media path.

Crucially, certificates are fixed during the DTLS handshake, which completes
*before* the bus opens, which is *before* any commit or reveal. So an
attacker's certificate on each leg is locked in before she learns a single
honest nonce — she cannot grind certificates against the revealed transcript
(see [§7.2](#72-why-the-fingerprint-binding-cant-be-ground-either)).

### 5.6 Wire Format

Two new bus message kinds, both broadcast over the P2P data-channel bus (see
[`webrtc-mesh.md`](webrtc-mesh.md)). **Neither is ever relayed through the
server**, so this feature adds exactly zero new information to what the server
can observe:

```jsonc
// Phase 1
{ "kind": "sas-commit", "round": "<roundId hex>", "commit": "<base64 SHA-256>" }

// Phase 2
{ "kind": "sas-reveal", "round": "<roundId hex>", "nonce":  "<base64 32 bytes>" }
```

Both messages are tiny (well under 100 bytes) and are sent once per participant
per round. A receiver keys them by `(round, senderPeerId)`; the sender's
identity is the authenticated transport sender (`fromPeerId`), never a
self-declared field — the same identity-binding rule chat uses (see
[`security.md` §5](security.md#5-h3--chat-identity-binding)).

### 5.7 The Emoji Encoding

The alphabet is a fixed table of **exactly 64 emoji** (`SAS_EMOJI` in
[`../static/crypto.js`](../static/crypto.js)): 64 is a power of two, so each
symbol carries exactly 6 bits with no modulo bias (`byte & 0x3f`). Symbols are
chosen to be single-codepoint, visually distinct, and rendered consistently
across platforms (no variation selectors or ZWJ sequences). The table's
contents and order are **part of the protocol** (the `info` string is versioned
`sas-v2`): changing them would desynchronize clients of different versions, so
the table is frozen per version.

The SAS is `5` emoji = `30` bits. With the grind eliminated
([§4](#4-the-fix-commit-before-reveal), [§7](#7-security-analysis)) this is
ample: the only remaining attack is a blind `2^-30` guess per call.

Note the truncation direction matters for one benign edge case: `deriveBits`
is asked for exactly `SAS_EMOJI_COUNT * 8` bits, and HKDF's output is a
byte-stream whose first N bytes never change when N grows — the output is
always a *prefix* of the longer stream, never an independent re-derivation.
So during a rolling deploy where an old client (`SAS_EMOJI_COUNT = 6`) and a
new client (`SAS_EMOJI_COUNT = 5`) briefly coexist in the same room, they
don't derive unrelated codes: the new client's 5 emoji are exactly the first
5 of what the old client displays as 6. That's a harmless, transient version
skew — not a sign of MITM — and resolves itself once both sides are on the
same deployed version.

## 6. Membership Changes, Churn, and Reconnects

Both membership **and** the certificate set are encoded into `roundId`
([§5.1](#51-preconditions--round-identity)), which makes churn self-healing
without any coordinator:

- **Someone joins or leaves** ⇒ the participant set changes ⇒ every peer
  computes a new `roundId` ⇒ a fresh round begins with fresh nonces. The
  previous round's state is discarded.
- **A certificate changes** (a peer's remote fingerprint differs from what the
  current round was built on — whether from a legitimate reconnect that minted a
  new certificate, or an attacker renegotiating DTLS) ⇒ `roundId` changes for
  the same reason, so a fresh round runs with fresh nonces committed *after* the
  new certificate exists. This is what denies the post-reveal certificate grind
  ([§7.2](#72-why-the-fingerprint-binding-cant-be-ground-either)); the state
  machine must therefore recompute `roundId` whenever it re-reads fingerprints,
  never splice a changed fingerprint into an in-flight round.
- **Transient disagreement during churn** (peers briefly seeing different
  sets/certificates) ⇒ they compute different `roundId`s and simply don't mix
  messages; mismatched-round messages are ignored. When the view settles,
  everyone converges on one `roundId` and that round completes.
- **A peer drops mid-round** ⇒ its departure changes the set, which starts a
  new round; the stalled old round is abandoned (its reveals never all
  arrive, but nothing waits on it once the set has moved on).
- **Signaling reconnect** (server restart/redeploy, see
  [`self-hosting.md`](self-hosting.md)) ⇒ the mesh and its certificates
  survive, so fingerprints and `sessionCertificate` are unchanged and the
  `roundId` is unchanged; the existing SAS stands.

While a round is in progress and no verified SAS exists yet, the UI shows the
**verifying** state; once a round completes it shows the emoji; a new round
after a membership or certificate change transiently returns to **verifying**
and then to the new emoji. A changed SAS after someone joins/leaves is expected
and benign — the note in the UI says so, so it isn't mistaken for an attack.

## 7. Security Analysis

### 7.1 Why There Is No Grind

An attacker forcing an undetected MITM must make the honest parties' displayed
SAS values equal. Both the nonce inputs and the fingerprint inputs are locked
before the attacker learns the honest contributions:

- **Nonces:** committed (hashed) in phase 1; the binding property of SHA-256
  means the attacker cannot open a commitment to a different nonce. She must
  commit on both legs before any reveal, hence before she knows any honest
  nonce.
- **No retry:** the nonces are fresh per round and per session; a "retry" means
  a whole new connection/round, i.e. a fresh single attempt, not another draw
  against a fixed target.

So the attacker gets one blind attempt per call: `2^-30`. The birthday
shortcut of [§3](#3-why-the-obvious-sas-is-broken-and-why-more-emoji-wont-save-it)
is gone, because it required varying inputs adaptively, which the commitment
forbids.

### 7.2 Why the Fingerprint Binding Can't Be Ground Either

The one remaining adaptive knob an attacker might hope for is her own DTLS
certificate. It's neutralized by binding the fingerprints into `roundId`
([§5.1](#51-preconditions--round-identity)): a certificate's fingerprint is
part of the round's identity, so **changing a certificate defines a different
round**, and a different round requires fresh commitments before any reveal.
Concretely — the DTLS handshake fixes certificates before the bus opens, hence
before the commit phase, so within a round an attacker's certificates are
locked before the first reveal. And if she renegotiates DTLS to try a new
certificate *after* seeing the revealed nonces, the fingerprint change flips
`roundId`, discarding the old round and forcing her to commit a fresh nonce
before she learns the new round's honest nonces. Either way she never gets to
grind a certificate against a known nonce: one fresh blind attempt, never a
grind. (This is precisely the failure the earlier peer-id-only round identity
would have had; see [§6](#6-membership-changes-churn-and-reconnects).)

### 7.3 Equivocation Is Detected

A malicious *participant* (not a relay) might try to send different commitments
to different peers ("equivocation"). This does not help them force a match: any
inconsistency makes at least one honest peer's commitment-check fail, or makes
honest peers derive different SAS values from each other, which surfaces as a
mismatch the moment humans compare. Equivocation is detected, not exploited.

### 7.4 Comparison to ZRTP, and Why This Is Application-Layer

ZRTP binds its SAS to the ephemeral Diffie-Hellman secret of the **media**
channel, with a hash commitment so neither side can bias it. The natural
browser analogue would be to bind to the DTLS master secret — but the WebRTC
API deliberately gives JavaScript **no access to DTLS keying material**, so a
literal ZRTP port is impossible in a browser.

We get the same guarantee a different way: run the commit-before-reveal round
**at the application layer** over the authenticated data-channel bus, and
**bind it to the DTLS certificate fingerprints** — which JavaScript *can* read
(via `getStats`) even though it can't read the keys. The commitment supplies
ZRTP's anti-bias property; the fingerprint binding ties the human-verified
value to the actual media transport. No DTLS key access required.

## 8. Threat Model — Stated Plainly

**Defends against:** a real-time active man-in-the-middle — including a fully
malicious signaling relay, or an attacker who controls how the link reaches a
participant — who hands different tokens `t` to different participants and
bridges the halves. Such an attacker cannot make the displayed SAS agree across
the honest participants except by a `2^-30` blind guess.

**Does not defend against, and is not meant to:**

- **Whoever serves the frontend JavaScript — the single biggest boundary.** SAS
  runs *inside* the client code. Whoever ships that code can defeat it
  completely and invisibly: read `t` directly, disable the check, or just paint
  the *same* fake emoji in both victims' headers. In a single-origin deployment
  the signaling server also serves the JS, so **trusting the SAS means trusting
  the server operator** — the very party SAS is otherwise meant to guard
  against. This is not a contradiction to be hidden; it is the reason the real
  guarantees live elsewhere: the split-origin trust separation, the reproducible
  published **build hash** ([`security.md` §10](security.md#10-published-build-hash--verifying-served-static)),
  and ultimately **self-hosting**. SAS is a defense *given honest client code*;
  it does not establish that the code is honest.
- **Humans who don't actually compare the code.** The protocol makes the six
  emoji *trustworthy*; it cannot make anyone look at them. Verification is a
  human act over an out-of-band authenticated channel — recognizing each
  other's voice or face — and it must happen **before** anything sensitive is
  said, since a MITM is already relaying whatever is spoken before the check.
  No comparison, no protection. This is inherent to every SAS scheme, ZRTP
  included.
- **Suppression / downgrade.** SAS only runs once the P2P data-channel bus is
  up. An attacker who prevents that bus from establishing (blocking direct P2P
  and TURN) keeps the session from ever reaching a verifiable state — but note
  this also means there is *no media path at all* (the server carries no media),
  so the call simply fails rather than proceeding unverified. To keep the
  *absence* of a code from being mistaken for success, the UI distinguishes
  "verifying…" (a round is running) from "verification unavailable" (no bus to
  run it over) — see [§9](#9-ui-states).
- **Identity.** The SAS proves "we are all in one un-bridged session over the
  same media path," not *who* anyone is. Anyone legitimately holding the link
  is still a trusted participant — consistent with the anonymity model
  ([`PRD.md` §5.5](PRD.md#55-anonymity)).
- **Prevention.** On a mismatch the UI *warns*; whether to hang up is the
  human's decision. The tool detects, it does not enforce.
- **A compromised endpoint.** If a participant's own device or browser is
  compromised, SAS offers nothing — it runs inside the very code that is
  assumed honest (same root issue as the first bullet).

## 9. UI States

The SAS lives ONLY in the main window's **top bar** (`#topbar-sas`, rendered by
`renderTopbarSas` in [`../static/room.js`](../static/room.js)) — there used to
also be a copy in the chat panel's header, removed so there is exactly one
place to look. The top-bar element is a compact badge/button; clicking it
opens `#topbar-sas-popup` (`openTopbarSasPopup`/`renderTopbarSasPopupContent`
in [`../static/room.js`](../static/room.js)), which expands an explanation of
how to use it — including the instruction to compare *before* speaking — and,
in the `ok` state, a plain-text fallback (`Text code: <hex>`) for when two
platforms draw the same emoji differently enough to cause doubt. Verification
never requires opening the chat panel:

| State | When | Badge shows | Popup (click badge) shows |
|---|---|---|---|
| hidden | alone in the room (no peer to verify with) | nothing (badge hidden) | n/a — badge isn't clickable |
| unavailable | ≥1 peer present but no P2P bus to any of them (media path never formed) | a muted "not verified" note, no emoji | explanation that no direct connection exists yet |
| verifying | a round is in progress, no verified SAS yet | a "verifying…" placeholder | "verifying the room…" note |
| ok | a round completed and all commitments verified | the five emoji | the five emoji (large), the `Text code:` hex fallback, and the compare-out-loud explanation |
| mismatch | a commitment failed to verify in the current round | a ⚠️ warning, no emoji | explanation that verification failed and the codes don't match |

Showing nothing when alone is deliberate: a lone participant has nothing and
no one to check against, and displaying a code there would imply a verification
that isn't happening. Distinguishing **unavailable** from **verifying** matters
for the downgrade concern in [§8](#8-threat-model--stated-plainly): a stuck
"verifying…" would look the same as a slow connection, whereas "verification
unavailable" says plainly that no un-bridged media path was ever established, so
the absence of a code isn't quietly mistaken for success.

## 10. Parameter Summary

| Parameter | Value | Rationale |
|---|---|---|
| Emoji alphabet size | 64 | Power of two ⇒ 6 clean bits/symbol, no modulo bias |
| SAS length | 5 emoji = 30 bits | Ample once the grind is removed; matches ZRTP-class SAS strength |
| Nonce size | 32 bytes | Commitment collisions/second-preimages infeasible |
| Commitment | SHA-256("sas-commit-v2" ‖ roundId ‖ peerTag ‖ nonce) | Binding; domain-separated per round and author; hex inputs |
| KDF | HKDF-SHA256, empty salt | Same primitive family as the rest of the key schedule ([`e2e-encryption.md` §2.3](e2e-encryption.md#23-ephemeral-per-tab-keys--pairwise-derivation-forward-secrecy)) — unlike `K_pair_sig`/`K_pair_meta`, which are salted with `K_auth`, the SAS derivation uses an empty salt since the nonces themselves already supply per-round randomness |
| Round identity | SHA-256 of sorted (peerTag:fingerprint) | Coordinator-free; self-healing; **binds certificates** so a cert change can't be ground (§7.2) |
| Canonical encoding | peerId hashed to fixed-width hex; hex-only fields | Injection-proof even if a malicious relay supplies crafted peer ids (§5.1) |
| Transport | P2P bus only | Server learns nothing new from this feature |
| Residual attack | `2^-30` blind guess per call | No grind, no birthday shortcut |
