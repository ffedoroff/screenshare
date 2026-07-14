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
| Recovering plaintext of a past meeting after the room key leaks | **Not mitigated** (signaling); **Partially mitigated** (fallback chat content/names, going forward from a membership change) | No forward secrecy for `K_sig`/signaling — see [`e2e-encryption.md` §6](e2e-encryption.md#6-known-limitations). Content keys (`K_chat`/`K_meta`) rotate when a participant leaves or is rejected at the lobby — see [`e2e-encryption.md` §7](e2e-encryption.md#7-forward-secrecy-for-content-on-membership-change-ш3) |
| A leaked/guessed room id or link granting access | Inherent to the model, mitigated by entropy | The link itself is the only credential; room ids are drawn from a large enough space that guessing one is impractical (see [`privacy.md`](privacy.md)) |

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
that actually delivered the data-channel message, or the peer id the server
itself attaches on the fallback path — before any rendering or authorship
check happens, for every envelope kind that carries authorship.

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
- **No forward secrecy for signaling** (`K_sig` is never rotated — see
  [`e2e-encryption.md` §7.7](e2e-encryption.md#77-what-this-does-and-doesnt-fix--stated-plainly)),
  and forward secrecy for content (`K_chat`/`K_meta`, rotated on membership
  change) is **partial**, not a general ratchet — see
  [`e2e-encryption.md` §7](e2e-encryption.md#7-forward-secrecy-for-content-on-membership-change-ш3)
  for exactly what it covers (fallback-relayed chat content and names, going
  forward from a departure/lobby rejection) and what it plainly doesn't
  (signaling, a newcomer's own name, post-compromise security).
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
