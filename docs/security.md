# Security: Threat Model & Mitigations

<!-- toc -->

- [1. Scope of This Document](#1-scope-of-this-document)
- [2. Threat Catalog](#2-threat-catalog)
- [3. H1 — Ephemeral TURN Credentials](#3-h1--ephemeral-turn-credentials)
- [4. H2 — Denial of Service Limits](#4-h2--denial-of-service-limits)
- [5. H3 — Chat Identity Binding](#5-h3--chat-identity-binding)
- [6. M2 — Security Headers & CSP](#6-m2--security-headers--csp)
- [7. M3 — Waiting Room Flood Protection](#7-m3--waiting-room-flood-protection)
- [8. Meeting Duration Ceiling](#8-meeting-duration-ceiling)
- [9. Known Boundaries](#9-known-boundaries)
- [10. Published Build Hash — Verifying Served Static](#10-published-build-hash--verifying-served-static)
- [11. SAS Verification — Human-Checkable MITM Protection](#11-sas-verification--human-checkable-mitm-protection)
  - [10.1 What Gets Published, and Where](#101-what-gets-published-and-where)
  - [10.2 Recomputing the Hash Yourself](#102-recomputing-the-hash-yourself)
  - [10.3 Not in the Link, Not in the QR](#103-not-in-the-link-not-in-the-qr)
  - [10.4 What This Doesn't Protect Against](#104-what-this-doesnt-protect-against)

<!-- /toc -->

> Source of truth: [`../src/ws.rs`](../src/ws.rs) (rate limits, size caps,
> heartbeat), [`../src/state.rs`](../src/state.rs) (per-IP limiters, reaper),
> [`../src/main.rs`](../src/main.rs) (TURN credential issuance, CORS/security
> headers). This document assumes the reader has [`signaling-protocol.md`](signaling-protocol.md)
> and [`e2e-encryption.md`](e2e-encryption.md) as background.

## 1. Scope of This Document

This is the consolidated threat model: what an attacker could try against
the signaling server, and what mitigates it today. It intentionally
distinguishes **server-enforced** mitigations from **cooperative** ones (a
theme carried through from [`permissions-and-leader.md`](permissions-and-leader.md))
and states known gaps plainly rather than implying full coverage.

## 2. Threat Catalog

| Vector | Status | Mitigation |
|---|---|---|
| Stealing the TURN relay for unrelated traffic (open-relay abuse) | Mitigated | Short-lived, per-request TURN credentials (H1, [§3](#3-h1--ephemeral-turn-credentials)) |
| Flooding the signaling relay with oversized messages | Mitigated | Per-message-type payload size caps + a hard WebSocket frame/message size ceiling (H2, [§4](#4-h2--denial-of-service-limits)) |
| Flooding the signaling relay with a high message rate | Mitigated | Shared sliding-window rate limit across all relay types per connection, plus a stricter chat-specific limit (H2, [§4](#4-h2--denial-of-service-limits)) |
| Exhausting server memory with unbounded rooms | Mitigated | Global room-count ceiling, checked under the same lock as room insertion (H2, [§4](#4-h2--denial-of-service-limits)) |
| One source hammering room creation | Mitigated | Per-IP sliding-window rate limit on `POST /api/rooms` (H2, [§4](#4-h2--denial-of-service-limits)) |
| Flooding a room's waiting list from one source | Mitigated | Separate per-IP sliding-window rate limit on lobby joins, plus a per-room pending cap (M3, [§7](#7-m3--waiting-room-flood-protection)) |
| Silently dead connections accumulating server-side | Mitigated | Active ping/pong heartbeat tears down unresponsive connections in seconds-to-tens-of-seconds rather than waiting on an OS-level TCP timeout |
| Impersonating another participant in chat (identity spoofing) | Mitigated | `envelope.from` normalized to the true transport sender before any processing (H3, [§5](#5-h3--chat-identity-binding)) |
| Clickjacking / framing the app in a hostile page | Mitigated | `frame-ancestors 'none'` (CSP) + `X-Frame-Options: DENY` (M2, [§6](#6-m2--security-headers--csp)) |
| A hostile origin reading camera/microphone/screen through an embedded frame | Mitigated | `Permissions-Policy` restricts capture APIs to `self` (M2, [§6](#6-m2--security-headers--csp)) |
| A meeting running indefinitely, accumulating state forever | Mitigated | Hard maximum meeting lifetime, enforced by a background reaper regardless of live participants ([§8](#8-meeting-duration-ceiling)) |
| A guest bypassing a chat/audio/video restriction via a modified client | **Not fully mitigated — cooperative only** | See [`permissions-and-leader.md` §7](permissions-and-leader.md#7-guest-permissions--how-theyre-actually-enforced) and [§9](#9-known-boundaries) below |
| Recovering plaintext of a past meeting after the room key leaks | **Not mitigated** | No forward secrecy — `K_sig`/`K_meta` are derived from `k` once and never rotated (see [`e2e-encryption.md` §6](e2e-encryption.md#6-known-limitations)). Chat/media never touch the server (P2P, DTLS-E2E — nothing server-side to recover); the former content-key epoch rotation was removed with the chat fallback (see [`chat.md` §12](chat.md#12-no-server-fallback)) |
| A leaked/guessed room id or link granting access | Inherent to the model, mitigated by entropy | The link itself is the only credential; room ids are drawn from a large enough space that guessing one is impractical (see [`privacy.md`](privacy.md)) |
| A compromised/malicious static-file host (Ш2 split-origin, [`self-hosting.md` §1.2](self-hosting.md#12-split-origin-frontend--signaling-separated)) silently serving tampered frontend JS | **Forensic checkpoint only, not preventive** | Reproducible SHA-256 of the deployed bundle, published to an independent channel (GitHub Release) the static host doesn't control (§10, [§10.4](#104-what-this-doesnt-protect-against) for exactly what this doesn't cover) |
| An active MITM (malicious relay, or an attacker controlling link delivery) handing different room keys to different participants and bridging the halves | **Detected by human out-of-band comparison** | Commit-before-reveal SAS: five emoji per room that agree across honest participants unless bridged; residual attack is a `2^-30` blind guess (§11, [`sas-verification.md`](sas-verification.md)) |

## 3. H1 — Ephemeral TURN Credentials

**Before**: `/config` handed out a **static** TURN username/password pair to
anyone who called it — valid indefinitely, until an operator manually
rotated it in two places at once (the TURN server's config and the
signaling server's config) and restarted both. Anyone who captured that pair
once (trivially, just by opening the site and inspecting `/config` in dev
tools) could route their own traffic through the deployment's TURN relay
indefinitely — an open relay, and a bandwidth-theft vector against whoever
is paying for it.

**Now**: if a TURN shared secret is configured, each call to `/config`
computes a **fresh** username/credential pair:

- `username = "<unix-expiry-timestamp>:chat"` (a configurable TTL, default
  one hour)
- `credential = base64(HMAC-SHA1(shared_secret, username))`

This is the standard **TURN REST API** long-term-credential scheme
(`draft-uberti-behave-turn-rest-00` §2.2, the same mechanism `coturn` and
`turn-rs`-family servers support via a static-auth-secret setting) — see
[`self-hosting.md`](self-hosting.md) for how to configure it.

**Known limitation, stated plainly**: the TTL embedded in `username` is
**not enforced by the TURN server itself** — most TURN REST API
implementations validate the HMAC but leave timestamp freshness to the
issuer, by design (the RFC draft does not mandate it). This means a
credential pair, once issued, will pass the TURN server's HMAC check even
after its embedded expiry has passed — the TTL is not a hard boundary
enforced at the TURN server. The real boundary on a leaked credential's
useful life is **rotating the shared secret**: the moment it changes (in
both the TURN server's config and the signaling server's config, which must
agree), every previously issued credential stops validating, regardless of
its embedded timestamp — and that rotation is now a single value changed in
one place, not a username *and* password that must be changed in two
systems in lockstep. A TURN server that supports an authentication webhook
per request can additionally enforce the timestamp server-side; wiring that
up is a further hardening step this project does not currently implement.

Even with that limitation, this is a substantial improvement: previously, a
single leaked pair meant indefinite, unattributable access with zero action
required by an operator to notice or limit it; now, the only lever needed to
invalidate every outstanding credential is one secret rotation, and the
issued timestamp gives an operator's TURN server logs a signal for
detecting anomalous reuse.

**This makes periodic secret rotation a required operational practice for
this scheme, not an optional future hardening step**: without it, a leaked
credential is effectively as long-lived as the secret itself, since nothing
else expires it. See [`self-hosting.md` §5.1](self-hosting.md#51-rotating-the-shared-secret)
for the rotation procedure and the runnable example at
[`../scripts/rotate-turn-secret.example.sh`](../scripts/rotate-turn-secret.example.sh).

## 4. H2 — Denial of Service Limits

All of the following are enforced synchronously, without ever holding the
room-state lock across an `.await` point — every check below is cheap and
non-blocking by construction.

- **WebSocket frame/message size**: capped at the transport level (64KB).
  The largest legitimate frame (a multi-media-line SDP offer) is an order of
  magnitude smaller; anything larger than the cap never reaches the
  application at all.
- **Relay payload size**: `offer`/`answer`/`ice-candidate`/`stream-info`
  payloads capped at 16KB serialized (the server doesn't parse `sdp` /
  `candidate` / `info`, but must still bound their size); `chat` has its own,
  tighter 8KB cap on the envelope.
- **Relay rate limit**: one shared sliding-window counter per connection
  covers **all** relay types combined (100 messages / 10 seconds) —
  deliberately not split per message type, since separate per-type counters
  would let an attacker dodge the limit simply by alternating types. `chat`
  additionally has its own, stricter limit (10 / 10 seconds) on top of the
  shared one.
- **Room count ceiling**: a configurable maximum number of simultaneous
  rooms; `POST`/`PUT` room creation/restoration return `503` once reached,
  checked under the same lock as the insertion itself so a race between
  concurrent requests can't exceed the ceiling.
- **Per-IP room-creation rate limit**: a sliding window per source IP,
  independent of the lobby-join limit in [§7](#7-m3--waiting-room-flood-protection)
  (see there for why the budgets are kept separate rather than shared).
  Client IP is read from a proxy-supplied header first (with a direct
  fallback to the socket peer address) — not a strong defense against a
  determined header-spoofer, but sufficient to cut off blunt, single-source
  flooding.
- **Heartbeat**: an active ping every 20 seconds; two consecutive
  unanswered pings (nothing at all back from the client) and the server
  tears the connection down itself, rather than accumulating dead sockets
  until an OS-level TCP timeout (which can take minutes) catches them.

## 5. H3 — Chat Identity Binding

See [`chat.md` §6](chat.md#6-identity-binding-who-really-sent-this) for the
full mechanism: `envelope.from` is a self-asserted field, so before this
mitigation, a participant could set it to another participant's peer id and
have a message (or an edit/delete of someone else's message) render, or be
authorized, as if it came from that other person. The fix normalizes
`envelope.from` to the message's true transport-level sender — the peer id
that actually delivered the data-channel message (chat only ever travels over
the P2P bus now; there is no server relay path for it) — before any rendering
or authorship check happens, for every envelope kind that carries authorship.

## 6. M2 — Security Headers & CSP

Two layers of headers:

- **On API responses** (`/api/rooms`, `/config`, `/version.json`):
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`,
  applied unconditionally (independent of whether cross-origin support is
  configured — see [`self-hosting.md`](self-hosting.md)).
- **On the served frontend pages** (wherever they're hosted — see
  [`self-hosting.md`](self-hosting.md) for the two supported topologies): a
  Content-Security-Policy restricting script/style to `'self'` with **no**
  `'unsafe-inline'` (the frontend has no inline `<script>`/`<style>`/`style="..."`
  anywhere — targeted CSSOM mutations like `element.style.foo = ...`, used
  for things like drag-gradient tiles and file-transfer progress bars, don't
  go through the `style` attribute and so aren't affected by `style-src`),
  `frame-ancestors 'none'` (paired with `X-Frame-Options: DENY` for older
  browsers) against clickjacking, `img-src`/`media-src` allowing `data:`/
  `blob:` (needed for inline file/image previews and downloaded-blob object
  URLs in chat), and a `Permissions-Policy` restricting camera/microphone/
  display-capture to `self` — so no embedding third-party frame could ever
  be granted those capabilities.

## 7. M3 — Waiting Room Flood Protection

A separate per-IP sliding-window rate limit — its own map, its own budget,
independent of the room-creation limit in [§4](#4-h2--denial-of-service-limits)
— caps how often one source IP can land in *any* room's waiting list. The
two are kept separate deliberately: creating a room and requesting entry
into someone else's room (via a link) are different in kind — for example,
several people behind the same NAT opening multiple tabs to join one invite
shouldn't be able to accidentally exhaust the same IP's budget for creating
their *own* unrelated rooms. The numeric limits happen to be equal, not
because the mechanism is shared, but because the same degree of generosity
was judged reasonable for both cases independently. A per-room cap on the
pending list (separate from, and more generous than, the participant
ceiling) remains in place regardless.

## 8. Meeting Duration Ceiling

A room, regardless of whether it currently has live participants, cannot
exist longer than a configurable maximum lifetime (default: three hours). A
background reaper deletes it outright once that lifetime elapses, sending
`room-expired` to every participant *and* every waiting-room arrival first;
each connection's writer delivers that message and then closes the socket
itself. This bounds the worst case for both resource accumulation and (see
[`privacy.md`](privacy.md)) how long any given meeting's metadata persists
in server memory.

## 9. Known Boundaries

Stated plainly, not buried:

- **Guest permission enforcement for chat/audio/video is cooperative, not
  server-enforced**, because the server structurally cannot see mesh
  peer-to-peer traffic at all (see
  [`permissions-and-leader.md` §7](permissions-and-leader.md#7-guest-permissions--how-theyre-actually-enforced)).
  A modified client can choose not to honor these restrictions; there is no
  mechanism, even in principle, for the server to detect or prevent that
  without becoming a media/data relay itself — which would contradict the
  product's core privacy property (see [`PRD.md` §6.1](PRD.md#61-nfr-inclusions)).
- **No forward secrecy.** `K_sig`/`K_meta` are derived from `k` once and never
  rotated (see [`e2e-encryption.md` §6](e2e-encryption.md#6-known-limitations)).
  The former content-key epoch rotation only ever protected the server-relayed
  chat fallback and was removed with it (chat is P2P/DTLS only now) — see
  [`chat.md` §12](chat.md#12-no-server-fallback).
- **Per-IP rate limiting is not attacker-proof.** Client IP is inferred from
  proxy headers with a direct-connection fallback; a sufficiently motivated
  attacker behind a spoofable or absent proxy chain could evade it. The goal
  is blunting casual flooding, not withstanding a targeted, sophisticated
  attacker.
- **The room link is the entire access control.** Anyone who has it can
  join (subject to the waiting room, if the leader has enabled it) and can
  derive the same encryption keys as any other participant (see
  [`e2e-encryption.md`](e2e-encryption.md)). There is no per-participant
  authentication layered on top, by design (see
  [`PRD.md` §5.5](PRD.md#55-anonymity)).

## 10. Published Build Hash — Verifying Served Static

**What this is, stated plainly upfront**: a **forensic checkpoint**, not a
cryptographic guarantee. It gives anyone who suspects the deployed frontend
has been tampered with (by whoever operates the static host — the Ш2
split-origin topology, [`self-hosting.md` §1.2](self-hosting.md#12-split-origin-frontend--signaling-separated))
a way to compare what's actually being served against a value published
through an **independent channel**: a GitHub Release, created by CI, that
the static host has no ability to write to. It is not, and cannot be, a
substitute for the actual guarantee — running your own instance (see
[`self-hosting.md`](self-hosting.md)) — because the same host serving a
tampered bundle could just as easily serve a tampered `/build-hash.json`
alongside it. See [§10.4](#104-what-this-doesnt-protect-against).

**Why not SRI / SXG instead** — the two standard web-platform mechanisms for
verifying delivered content, both considered and rejected for this purpose:

- **Subresource Integrity (SRI)** lets a parent HTML document pin a hash for
  each `<script>`/`<link>` it loads, so the *browser itself* refuses a
  tampered script. But the `integrity="..."` attribute lives in that same
  HTML document, served by the same host being distrusted here — a host
  willing to tamper with the JS is equally free to strip or rewrite the
  attribute (or the hash it names) in the HTML it serves alongside it. SRI
  only buys something when the *parent document* arrives over a channel
  trusted independently of the resource it pins (e.g., a CDN script
  referenced from an app you ship yourself) — that's not this deployment's
  shape, where the static host serves the HTML too.
- **Signed HTTP Exchanges (SXG)** let a publisher cryptographically sign a
  response so a *different* distributor can serve it while the browser still
  attributes it to the publisher's origin. That only helps if the signer is
  independent of the host doing the serving — here the same CI pipeline that
  builds the bundle would also have to hold the signing key, collapsing the
  intended separation — on top of requiring a CA-issued signing certificate,
  narrow (and shrinking) browser support, and real operational complexity,
  for what a documented hash in a GitHub Release already achieves for this
  project's threat model: a durable, independently-timestamped, publicly
  diffable record of what was built.

A plain, reproducible hash published somewhere the hosting provider cannot
edit is cheaper, has no browser-support caveats, and — stated honestly —
offers the same fundamental property SXG or SRI would here: a comparison
point outside the host's control, not an in-browser enforcement mechanism.
None of the three stop a compromised host from serving something different
to end users in real time; all three only let a suspicious party *notice*
after the fact, by fetching the independent record and comparing.

### 10.1 What Gets Published, and Where

On every `main` deploy ([`../.github/workflows/deploy-prod.yml`](../.github/workflows/deploy-prod.yml),
job `deploy-pages`), after `pages-dist/` is assembled (the exact tree
Cloudflare Pages serves) and before it's pushed to Cloudflare:

1. A single SHA-256 is computed over **every file in the bundle** (HTML, JS,
   CSS, SVG/PNG, `manifest.webmanifest`, `_redirects`, `_headers` — anything
   actually served) **except `build-hash.json` itself**, which doesn't exist
   yet at hashing time (see the exact command in [§10.2](#102-recomputing-the-hash-yourself)).
2. `pages-dist/build-hash.json` is written —
   `{"hash", "commit", "buildDate"}`, the same `commit`/`buildDate` as
   `/version.json` on the signaling origin — and only **then** included in
   what's deployed, so it never hashes itself.
3. The hash, commit, and build date are published as a **GitHub Release**
   tagged `pages-<short-sha>`, whose body includes the exact recomputation
   command. This is the independent channel: creating it requires the
   repo's `GITHUB_TOKEN` (scoped `contents: write` on just that one CI job),
   not anything the Cloudflare Pages host can touch.
4. The frontend fetches `/build-hash.json` itself (same-origin, once per
   tab, never persisted to `localStorage`) and shows the hash in three
   places: the landing page footer, the "Share" popup inside a room, and
   (best-effort) the "Connection & Privacy" settings panel. In a
   dev/self-hosted build — where no such route or file exists (see
   [`self-hosting.md`](self-hosting.md)) — the fetch simply 404s and all
   three stay hidden; nothing breaks.

### 10.2 Recomputing the Hash Yourself

From the root of an extracted/rebuilt `pages-dist/` (i.e., after running the
same steps the workflow does — see the "Собрать pages-dist/" step in
[`../.github/workflows/deploy-prod.yml`](../.github/workflows/deploy-prod.yml)),
run:

```bash
cd pages-dist
find . -type f ! -name build-hash.json | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1
```

(macOS ships no `sha256sum` by default — `shasum -a 256` is a drop-in
replacement: same algorithm, same output format, so substituting it into the
command above gives the identical hash.)

Two details matter for reproducibility:

- **Paths must be relative to `pages-dist/`** — hence `cd` into it first. An
  absolute-path prefix would make the hash depend on where the bundle
  happens to sit on disk, breaking reproducibility for anyone checking out
  or rebuilding it in a different location.
- **`LC_ALL=C sort`** fixes the ordering independent of the checking
  machine's locale — a locale-aware sort can order punctuation/case
  differently across systems, which would silently change the combined hash
  even though no file actually differs.

Compare the result against the `hash` field in the GitHub Release for the
commit in question, and against what `/build-hash.json` on the live site
currently reports (see [§10.4](#104-what-this-doesnt-protect-against) for
why the Release is the value that actually matters, not the page's own
claim).

### 10.3 Not in the Link, Not in the QR

The room link (`<origin>/r/<id>#k=<key>`) and the QR code rendered from it
(see [`e2e-encryption.md`](e2e-encryption.md) for what `#k` is) carry
**only** the room URL — the build hash is never appended to either, and the
QR-rendering code (`static/room.js`: `renderShareQr`/`buildShareLink`) is
untouched by this feature. It's shown as a separate line of plain text next
to the link and QR in the "Share" popup, precisely so that copying the link
or scanning the QR can never accidentally include, depend on, or be
lengthened by the build hash.

### 10.4 What This Doesn't Protect Against

Stated plainly, not buried:

- **A host that tampers with everything, consistently.** If the static host
  (or anyone with write access to it) serves a modified bundle, it can just
  as easily serve a modified `/build-hash.json` right alongside it that
  "confirms" the tampered bundle. The on-page display is a convenience, not
  the proof — the actual check requires comparing against the **GitHub
  Release** independently (or recomputing from source per
  [§10.2](#102-recomputing-the-hash-yourself)), never trusting whatever hash
  the page itself happens to claim.
- **No detection at request time.** This is a forensic/audit anchor, checked
  after the fact by someone who goes and looks — nothing here stops a
  compromised host from serving different content to different users, or
  from serving the honest bundle again the moment someone happens to check.
- **The real guarantee is self-hosting.** Running your own instance (see
  [`self-hosting.md`](self-hosting.md)) removes the split-trust problem
  entirely — there's no third-party static host whose honesty needs
  checking in the first place. Everything in this section exists for the
  split-origin (Ш2) topology in
  [`self-hosting.md` §1.2](self-hosting.md#12-split-origin-frontend--signaling-separated),
  where the operator has intentionally chosen not to run their own static
  hosting.

## 11. SAS Verification — Human-Checkable MITM Protection

The end-to-end signaling encryption ([`e2e-encryption.md`](e2e-encryption.md))
contains a passive server, and an active server that only relays: neither can
read or forge what it carries without the room key `k`, and the browser refuses
any DTLS connection whose certificate doesn't match the (authenticated) SDP.
The one scenario that chain cannot cover is an active man-in-the-middle who
**poisons the trust anchor itself** — the link. An attacker who controls link
delivery, or who fully controls the relay and is willing to run an active
bridge, can hand *different* room keys to different participants and stitch the
two encrypted halves together. Every ciphertext still decrypts cleanly, because
each half is internally consistent; the cryptography worked, but against a key
the attacker chose.

Because the product deliberately has no identity/PKI layer (see
[`e2e-encryption.md` §6](e2e-encryption.md#6-known-limitations) on trust between
participants), it closes this gap the way secure phone systems do: a **Short
Authentication String** — five emoji derived from a **commit-before-reveal**
round bound to the DTLS fingerprints — that participants compare out-of-band. A
naive `HKDF(k, fingerprints)` SAS would be worthless here (a birthday grind
forces a collision in a fraction of a second); the commitment removes the
grind, leaving only a `2^-30` blind guess per call. The full attack analysis, protocol, wire
format, and threat model are in **[`sas-verification.md`](sas-verification.md)**.

**Boundary, stated plainly:** this only works if humans *actually compare* the
emoji over a channel where they recognize each other (voice/face). It
authenticates "one un-bridged session over the same media path," not identity,
and it detects rather than prevents — on a mismatch the UI warns, and hanging
up is the human's call.
