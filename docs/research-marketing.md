# Marketing Research: 4 User Segments

> Research for the **chat** product (P2P video chat, MIT, self-hosting = one Rust
> binary + static files, public instance — chat.fedorov.it). Facts about the
> product are taken from `README.md`, `docs/PRD.md`, `docs/DESIGN.md`,
> `docs/privacy.md`, `docs/security.md`, `docs/self-hosting.md` — no invented
> features. Facts about competitors — from web search, July 2026, links in each
> section and in the combined source list at the end.
>
> This file does not change anything in the code/README/landing page — it is
> input material for future work on the landing page/README.

<!-- toc -->

- [0. Product: What We Actually Have (for Fact-Checking, Not Marketing)](#0-product-what-we-actually-have-for-fact-checking-not-marketing)
- [1. Segment 1 — Non-Technical Users](#1-segment-1--non-technical-users)
- [2. Segment 2 — Technical Users Tired of Free-Tier Limits](#2-segment-2--technical-users-tired-of-free-tier-limits)
- [3. Segment 3 — Paranoid Technical Users / Self-Hosters](#3-segment-3--paranoid-technical-users--self-hosters)
- [4. Segment 4 — Integrators](#4-segment-4--integrators)
- [5. Competitor and Limits Summary Table (2026)](#5-competitor-and-limits-summary-table-2026)
- [6. One Landing Page / README for All Segments: Message Hierarchy](#6-one-landing-page--readme-for-all-segments-message-hierarchy)
- [7. Segment Prioritization](#7-segment-prioritization)
- [8. Combined List of "What We Can't Honestly Promise"](#8-combined-list-of-what-we-cant-honestly-promise)
- [9. Server Load ≈ 0 (Argument for Segments 3 and 4)](#9-server-load--0-argument-for-segments-3-and-4)
- [Sources](#sources)

<!-- /toc -->

## 0. Product: What We Actually Have (for Fact-Checking, Not Marketing)

So that not a single point below turns into fiction, here is a hard fact
sheet that every statement in this document is bound to:

- **Recommended default — 6 participants** (env `MAX_PARTICIPANTS`, the
  product itself has no hard ceiling — any value on self-host), full
  WebRTC mesh (everyone connects directly to everyone else), no SFU and no
  media server — `DESIGN.md` §1.1, §2.2, `src/state.rs::DEFAULT_MAX_PARTICIPANTS`,
  `self-hosting.md` §6.
- **The product has no call duration limit.** Room auto-close is a
  recommended default (env `MAX_ROOM_LIFETIME_SECONDS`, any value on
  self-host); on the PUBLIC instance chat.fedorov.it, the operator has
  configured a default (3 hours) — `security.md` §8, `self-hosting.md` §6.
  It's important to distinguish the product (no limit) from a specific
  instance (a limit exists because the operator configured it that way).
- **Video/audio/chat/files never go through the server** — not in the main
  path, not as a fallback, EVEN when a direct P2P connection can't be
  established (files are never proxied through the server, under any
  circumstances whatsoever — `privacy.md` §1, `chat.md` §10); the signaling
  server only ever sees encrypted SDP/ICE blobs and service messages —
  `privacy.md` §1–2. See [§9](#9-server-load--0-argument-for-segments-3-and-4):
  it follows that server load during the call itself is ≈ 0.
- **E2E encryption of signaling with forward secrecy**: each tab has a
  fresh ephemeral ECDH key per session, never persisted; a link leaking
  *after* the call does not expose past traffic — `privacy.md` §3.6,
  `security.md` (threat table).
- **No accounts, cookies, localStorage** — no cross-session identifier of
  any kind whatsoever — `privacy.md` §4.
- **SAS verification** — 5 emoji, commit-before-reveal, protection against
  active MITM, detectable by a human — `security.md` §11.
- **Peers see each other's IP** (this is an unavoidable property of direct
  P2P: ICE requires exchanging real addresses) — the server, on the other
  hand, does not log or store IPs — `privacy.md` §2. This is a key, honest
  point of difference from server-mediated solutions (see §8).
- **A published build hash** for the deployment (GitHub Release, an
  independent channel) — a forensic checkpoint, not a cryptographic
  guarantee — `security.md` §10.
- **MIT license**, one Rust binary + static files, `docker compose up -d`,
  self-host also supports split-origin mode (front end and signaling
  served separately) — `README.md`, `self-hosting.md` §1.
- **No call recording, no history after the room closes, no mobile apps**
  (browser / PWA only), **single process, single replica** (in-memory
  state, no database) — `PRD.md` §10, `self-hosting.md` §7.1.
- **No independent third-party security audit** — only an internal threat
  model document (`security.md`) and open code (~2.3k lines of Rust in
  `src/`). This needs to be honestly acknowledged to the paranoid segment
  (see §3).

---

## 1. Segment 1 — Non-Technical Users

### 1.1 Profile and Scenarios

- A family scattered across cities/countries, calling "just to talk."
- Two friends who want to have a one-off call, and neither wants to create
  a Zoom account for a 15-minute conversation.
- A person who, as a matter of principle, doesn't want to "hand over" yet
  another email/phone number to yet another service — has seen enough news
  about leaks and surveillance, but isn't technical themselves and won't
  figure out Jitsi.
- A user for whom it matters that no trace is physically left behind: a
  conversation with a doctor, a lawyer, a therapist, or simply a personal
  conversation they don't want "sitting" on Meta's or Google's servers.

This segment's motive isn't "I want cryptography" but "I don't want to
register and I don't want this stored anywhere" — one abstraction layer
down, emotional, not technical.

### 1.2 Where They Hang Out

This segment **doesn't live on HN/r/selfhosted** — they arrive via
recommendations:

- Posts like "10 private alternatives to Zoom" on general tech media (not
  niche ones) — Lifehacker-style sites, YouTube reviews.
- General-audience subreddits (r/privacytoolsIO — more general than
  r/privacy), privacy-focused Telegram channels aimed at a broad audience.
- Word of mouth: if one technical person in a group of friends/family sends
  a link, everyone else just clicks through without reading what it is.
- The App Store/Play Store doesn't work as a channel (there are no apps) —
  the only entry point is the call link itself, so for this segment the
  distribution channel IS the product: if the link "just works," that's
  already a viral effect.

### 1.3 What They Use Now

WhatsApp video (up to 32 participants), FaceTime (up to 32 on Apple),
Telegram (up to 30 active, up to 1000 viewers), plain Zoom "via a link from
someone I know." All of them require either a phone number (WhatsApp,
Telegram, Signal), an Apple ID (FaceTime), or an account (Zoom for the
organizer) — that is, all of them have a point of identification, even if
the call itself feels "free and simple" [WhatsApp][wa-32],
[FaceTime][facetime-32], [Telegram][tg-1000].

### 1.4 Their Pain Points With Current Solutions

- At least someone in the call (usually the organizer) needs a
  phone/email/account.
- A feeling (often correct) that the correspondence/history is stored
  somewhere on the company's server.
- Installing an app — for a one-off call this is friction and an extra
  permission on the phone.
- They don't understand and shouldn't have to understand terms like "E2E,"
  "forward secrecy" — they need a translation into human language: "no one
  but the person you're talking to can read this."

### 1.5 How to Sell to Them Specifically

**Key message (one phrase):**

> "Open a link, talk, nothing is left behind — not even by us."

**3–5 supporting points:**

1. No registration whatsoever — no phone, no email, no password. Just a
   link.
2. Nothing is saved — no messages, no files, not even the fact that you
   had a call at all; after the call, nothing remains, either with us or
   anywhere else.
3. The conversation goes directly between your devices, not through
   anyone's server — the other person only sees your IP address, and
   nothing else.
4. Open source code (you can verify it, not just take our word for it).
5. Works in the browser on phone and computer — nothing to install.

**Which features to show first:**

- One "Create a call" button → immediately a link/QR code.
- A simple join modal: just a name (with a suggested placeholder), nothing
  else.
- A plain-language version of the privacy panel: "here's what the server
  sees, and here's what it never sees" (already present in the UI as
  "Connection & Privacy").

**Which limitations to honestly acknowledge:**

- Recommended default is up to 6 people (full mesh, everyone sends video
  directly to everyone else) — if a large family/class reunion call is
  planned, it needs to be said outright that this isn't for 20+ people:
  mesh isn't technically built for that scale, even if the limit can
  formally be raised.
- On chat.fedorov.it, the room automatically closes after 3 hours (this is
  a setting configured by the operator of this specific instance, not a
  product limit) — long hangout sessions on it will need to be recreated;
  on self-host, the limit can be set to anything.
- No call recording — if someone wants a recording "as a keepsake," that
  doesn't exist and won't (this is a product philosophy, not a missing
  feature).

**Distribution channels:** word of mouth via technical friends → the link
itself as the product; general "privacy-friendly apps" roundups; no paid
channels at launch, organic growth through UX simplicity.

### 1.6 What Can't Be Honestly Promised

- Can't promise "like Zoom, but better" in terms of reliability for large
  calls — Zoom/Meet hold hundreds of participants on an SFU/media server,
  we have full mesh with a recommended default of six (formally more is
  possible, but each participant pays for it in bandwidth/CPU, not the
  server).
- Can't promise anonymity from the other participant: the other person
  sees your IP (this is not Tor and not a VPN — regular WebRTC P2P).
- Can't promise "works without internet/on any network" — behind symmetric
  NAT a TURN relay is needed (optionally configurable on self-host, but on
  the public instance it will be enabled by default only if the operator
  set it up).

### 1.7 EN Drafts (for the landing page/README, short section for this segment)

```
No sign-up. No app to install. Just a link.
Create a room, share the link, talk — video, voice, and chat,
end-to-end encrypted between your devices. When you're done,
there's nothing left: no account, no history, nothing we could
hand over even if we wanted to.
```

---

## 2. Segment 2 — Technical Users Tired of Free-Tier Limits

### 2.1 Profile and Scenarios

- A developer/team lead of a small team (2–6 people) who regularly needs a
  quick call longer than 40 minutes but doesn't want to pay for Zoom
  Pro/Google Workspace — usually because these are one-off/irregular
  calls, not a daily work tool.
- A freelancer/consultant who calls clients and doesn't want the call to
  cut off at minute 40 when the client is on free Zoom.
- A small open-source project / reading club / community, where no one
  pays for corporate tiers, but long discussions are needed regularly.

### 2.2 Where They Hang Out

Hacker News, r/webdev, r/programming, developer-tools-focused Telegram
chats, Twitter/X influencers about productivity and tools for small teams,
Indie Hackers.

### 2.3 What They Use Now, and Current Limits (2026, verified by search)

| Service | Free tier limit | Source |
|---|---|---|
| **Zoom Basic** | Group (3+) — **40 minutes**, then forced termination (10-min warning); 1:1 with no time limit | [Zoom support][zoom-40] |
| **Google Meet (personal account)** | Group (3+) — **60 minutes**, warning at minute 50, call cuts off with no grace period; 1:1 — up to 24 hours | [itsconvo][meet-60] |
| **Microsoft Teams (free)** | Group — **60 minutes**, up to **100 participants**, limit determined by the organizer's license | [Microsoft Learn][teams-limits] |

Bottom line: all three mainstream players have a hard time limit on group
calls (40–60 minutes), specifically tuned to convert users into paid
subscriptions.

### 2.4 Their Pain Points With Current Solutions

- The upgrade-timer trigger — the limit mechanism exists specifically to
  sell a subscription, not because it's technically necessary.
- Working around the limit ("recreate the call every 40 minutes") — a
  functional but annoying, conversation-breaking hack that people actually
  use (the top of the search results for "how to get around the Zoom
  limit" is all about this).
- For one-off/irregular calls, paying for an annual subscription isn't
  economically justified.
- Discord — a free alternative with no time limit, but it requires an
  account, a server, an install (for many), and by default isn't meant for
  one-off external calls with people outside your Discord circle.

### 2.5 How to Sell to Them Specifically

**Key message:**

> "No 40-minute wall — ever. The product itself has no duration cap. Our own free public instance defaults to a generous 3-hour auto-close (a config value, not a hard limit) — still miles ahead of Zoom's 40 minutes or Meet's 60, which you can't change no matter what you do."

**3–5 supporting points:**

1. The product has no call duration limit at all (env
   `MAX_ROOM_LIFETIME_SECONDS`, any value on your own self-host); on our
   public instance — a generous **3-hour** default, not the hard 40/60
   minutes that you can't change in Zoom/Meet no matter how much you want
   to.
2. No account — no need to ask the other person to "sign up so I can call
   you for free for longer than an hour."
3. Self-host is free, forever, with no "free tier" that can be cut — one
   `docker compose up`.
4. E2E encryption of signaling out of the box, with no toggle and no
   disabled features (unlike many SFU-based solutions, where E2EE is an
   optional checkbox).
5. Open source code — not "trust us," but "verify it yourself."

**Which features to show first:**

- A direct timer comparison: "Zoom: 40 min, can't be changed. Meet: 60
  min, can't be changed. Us: 3 hours on the public instance — and that's a
  config value, not a product ceiling."
- Speed of entry: link → straight into the call, no sign-up form.
- The public chat.fedorov.it as "just try it right now," no install.

**Which limitations to honestly acknowledge:**

- Recommended default of 6 people (mesh architecture) — this isn't a
  replacement for Zoom/Teams for a big meeting/webinar; technically more
  can be allowed, but each participant's traffic/CPU grows linearly (not
  the server's).
- No recording — if a call archive is needed, this isn't the right tool.
- On our public instance, 3 hours is a real practical ceiling for a
  regular user (they don't change the value there themselves), so for
  this instance it's "not unlimited" — honestly, like MiroTalk P2P (see
  §3), which has no limit at all. But the product itself, unlike
  Zoom/Meet, structurally has no limit: self-hosting with any
  `MAX_ROOM_LIFETIME_SECONDS` fully resolves the issue.

**Distribution channels:** Show HN / Hacker News (this segment's audience
lives there and clearly responds to "no signup, P2P, disposable" posts —
historical examples below), Twitter threads about "tools for small teams,"
Indie Hackers, r/webdev.

Historical examples of this pitch working on HN — similar "no-signup P2P
video chat" products regularly hit the top:

- "Free, P2P, disposable group video calling app for the web" — [HN
  discussion][hn-disposable]
- "Show HN: Group video chat with no signups or downloads" — [HN
  discussion][hn-nosignup]
- "Show HN: Briefing – Anonymous, secure, open source WebRTC group video
  chat" — [HN discussion][hn-briefing]

### 2.6 What Can't Be Honestly Promised

- Can't say "unlimited" about our PUBLIC instance — it runs on an
  operator-configured default (3 hours / recommended 6 people), just more
  generous than competitors, and along different axes (we give time, they
  give reach). About the PRODUCT itself it's honest to say "there is no
  limit" — self-hosting with any `MAX_ROOM_LIFETIME_SECONDS`/
  `MAX_PARTICIPANTS` fully resolves the question; don't conflate these two
  statements in the same piece of text.
- Can't promise calendar/Outlook integrations — this doesn't exist and
  won't (see `PRD.md` §10, "Out of Scope").
- Can't promise recording to review the meeting later — deliberately
  absent.

### 2.7 EN Drafts

```
Zoom cuts you off at 40 minutes, no matter what you do. Google Meet at 60.
We don't cap call duration at all — our own free public instance defaults
to a generous 3 hours (that's a config value, not a wall), and self-hosting
it yourself lets you set that to whatever you want. No account, no credit
card, no "upgrade to continue" banner, ever.
```

---

## 3. Segment 3 — Paranoid Technical Users / Self-Hosters

### 3.1 Profile and Scenarios

- A person who already self-hosts Nextcloud/Immich/Vaultwarden and by
  default distrusts SaaS with other people's data.
- A small NGO/legal/journalism team that needs to control its entire
  infrastructure (jurisdiction, no intermediary contractor).
- A r/selfhosted / r/privacy member who, before installing anything, reads
  the threat model and checks what's visible on `strace`/in server logs.

### 3.2 Where They Hang Out

r/selfhosted, r/privacy, r/degoogle, the Awesome-Selfhosted forum /
LibreSelfhosted directories, HN (the same audience as in §2, partly
overlapping), Matrix/Telegram chats about self-hosting, Lemmy/Fediverse.

### 3.3 What They Use Now

| Tool | Model | Key characteristic | Source |
|---|---|---|---|
| **Jitsi Meet** (self-hosted) | Server + SFU (Jitsi Videobridge) | By default the server **sees decrypted** media (terminates DTLS-SRTP at the videobridge, though doesn't store it); there's an optional E2EE toggle, but only for Chromium-based browsers, and it **disables** recording/streaming/dial-in | [jitsi.org][jitsi-e2ee], [Jitsi self-hosting handbook][jitsi-handbook] |
| **Element Call / Matrix** | Matrix homeserver + LiveKit SFU | A full self-host requires standing up Synapse/Dendrite **and** LiveKit — noticeably more infrastructure than "one binary"; the group call also goes through an SFU, not pure mesh | [element-call GitHub][element-call], [Element blog][element-sovereignty] |
| **Signal** | Centralized service, P2P/relay calls | Up to **75** participants in a group, but: Signal's server is closed source (the server side can't be fully self-hosted for calls), a phone number is required, a separate app is required | [aboutsignal.com][signal-75] |
| **Jami** | Fully decentralized P2P (OpenDHT), no server at all | GNU project, GPLv3, calls/chat are P2P with no central server in principle — but requires **installing a native app**, doesn't work "via a browser link" | [jami.net][jami], [Wikipedia][jami-wiki] |
| **MiroTalk P2P** | Self-hosted P2P (no SFU), browser | Similar architecture to our product: no time limit, no room limit — but **AGPLv3** (copyleft: a fork with modifications must be open), not MIT | [GitHub][mirotalk] |
| **Galène** | Self-hosted, Go + Pion, SFU | Lightweight, portable (even to OpenWRT), but scales quadratically for many-to-many: ~20 participants per core — not a problem for us at a ceiling of 6, but it illustrates that even "lightweight" SFUs are heavier than pure mesh | [galene.org][galene], [GitHub][galene-gh] |

### 3.4 Their Pain Points With Current Solutions

- **Jitsi** — "self-hosting is not trivial," in the words of Jitsi's own
  documentation (needs a domain, a certificate, a separate SFU component —
  videobridge, XMPP-prosody, Jicofo — several services, not one binary);
  and even after that, the server sees decrypted media by default unless
  the E2EE toggle is enabled manually (which itself disables some
  features) [jitsi-handbook], [jitsi-e2ee].
- **Element/Matrix** — its strength (decentralization, federation) turns
  into weight: a homeserver + LiveKit is required, this is organizational
  infrastructure, not "spun up in 2 minutes for a one-off call."
- **Signal** — the server itself is closed source, self-hosting isn't
  possible "turnkey"; just to make a call, a phone number and an app
  install on all sides are required.
- **Jami** — architecturally the closest in spirit to "no server at all,"
  but requires installing a native client for all participants — not
  "click a link."
- **LiveKit/Daily/mediasoup-based self-host solutions** — by default the
  SFU sees a decrypted media stream on the server (an explicit E2E layer
  on top is needed, which is rarely enabled by default) — the same caveats
  as Jitsi.
- General pain point: "open source" doesn't mean "the server sees
  nothing" — in most self-hosted solutions the server physically passes
  through the decrypted media stream (SFU architecture), and only in
  mesh-based solutions (us, MiroTalk P2P, Jami) is the server
  **structurally** unable to see the media, rather than "able to, but
  promising not to look."

### 3.5 How to Sell to Them Specifically

**Key message:**

> "The server can't see your call — not because we promise not to look, but because there's structurally nothing to look at: media never touches it."

**3–5 supporting points:**

1. Full mesh, no SFU — the server doesn't decode, doesn't store, and
   cannot technically read video, audio, or chat under any circumstances
   (unlike Jitsi/most self-hosted solutions, where E2EE is an optional
   toggle, not the default architecture).
2. One Rust binary + static files — `docker compose up -d`, no XMPP
   server, no separate SFU, no homeserver, no coordination across multiple
   components.
3. Zero telemetry, zero cookies, zero localStorage, IP not logged — check
   `src/ws.rs`, that's literally 2.3k lines of code.
4. A published build hash of the deployment via an independent channel
   (GitHub Release) — you can verify that exactly the code that's in the
   repo is what's being served.
5. SAS verification (5 emoji) — protection against active MITM without
   PKI/accounts.
6. **Server load during a call ≈ 0** (see
   [§9](#9-server-load--0-argument-for-segments-3-and-4)) — the server only
   relays small encrypted blobs while a connection is being set up; the
   rest of the call the server does practically nothing — which is why it
   really does run on the cheapest VPS (1 vCPU/512MB), rather than needing
   beefy hardware "just in case."

**Which features to show first:**

- A link to `src/` and the size of the codebase — "small, you can read the
  whole thing in an evening."
- `docs/security.md` and `docs/e2e-encryption.md` as they are — this
  segment actually reads the threat model, not just the marketing.
- The build hash / verification instructions (`security.md` §10.2).
- SAS verification as a feature, not "fine print."
- The traffic estimate from
  [§9](#9-server-load--0-argument-for-segments-3-and-4) — specific numbers
  (KB per room, hundreds to thousands of rooms on a cheap VPS) convince
  this segment better than generic words like "lightweight."

**Which limitations to honestly acknowledge:**

- **No independent third-party security audit** — this is an open project
  by a single developer, not BigBlueButton/Jitsi with institutional
  backing. It's worth saying outright: "small, readable code is a
  reasonable substitute for an audit, but not the same thing as an audit."
- Guest permissions (blocking chat/camera for guests) — this is a
  cooperative measure, not a server-enforced one: a modified client can
  ignore it (see `security.md` §9). For a paranoid user this is an
  important detail, and hiding it is a bad idea — they'll work it out from
  the architecture anyway.
- Single-replica, in-memory — when the server restarts, all current rooms
  lose their signaling state (though P2P media keeps working) — this isn't
  "high availability" in the enterprise sense.
- Recommended default — up to 6 participants (env `MAX_PARTICIPANTS`) —
  the server itself doesn't structurally cap the number of participants
  beyond this (the default can be raised), but as the number of
  participants grows, outgoing traffic/CPU on EVERY client grows linearly
  (you send n-1 copies directly to each) — this is a real technical
  ceiling of mesh on the participants' devices, not the server, and that's
  exactly why the default shouldn't be pushed up endlessly — switching to
  an SFU would contradict the whole architectural idea (the server would
  then see the media).

**Distribution channels:**

- **r/selfhosted** — the most direct channel, specifically a self-hosting
  post ("I built a P2P video chat where the server literally can't see the
  media — single Rust binary, MIT").
- The **awesome-selfhosted** list — the formal requirements are simple
  (source code, license, a working link) and we satisfy them; getting into
  the list provides long-running organic traffic [awesome-selfhosted].
- **r/privacy**, r/degoogle — with an emphasis on the architectural
  difference from Jitsi (see above), not a generic privacy pitch.
- HN Show HN — the same post as in §2.6, but focused on architecture, not
  Zoom's limits.

### 3.6 What Can't Be Honestly Promised

- Can't say "more private than Jitsi with E2EE enabled" in an absolute
  sense — with Jitsi E2EE enabled, media is also inaccessible to the
  server; the honest difference is that for us this is **the default,
  always**, without a toggle and without losing features, not that the
  cryptographic outcome is fundamentally different.
- Can't promise anonymity within the call from **other participants** —
  they see your IP (in Jitsi, via the SFU, participants' IPs are hidden
  from each other — the server sees all IPs, but participants don't see
  each other directly). This is a real trade-off of mesh architecture, not
  only an advantage.
- Can't promise the absence of metadata on the server altogether — room
  id, peer id, public keys, join/leave timings — the server sees these by
  construction (`privacy.md` §2). Zero-knowledge applies only to content,
  not to the fact that a call took place.
- Can't promise federation/decentralization at the level of Matrix/Jami —
  we still need one signaling server (even though it doesn't see content).
- Can't promise a formal audit — only readable code and openness.

### 3.7 EN Drafts

```
Most "private" video tools route your call through a server that
merely promises not to look. Ours has nothing to look at: no SFU, no
media server — every peer connects directly to every other peer. One
Rust binary, no database, MIT-licensed, ~2,000 lines of server code you
can read in an evening. Not independently audited (yet) — but small
enough that you don't have to take our word for it.
```

---

## 4. Segment 4 — Integrators

### 4.1 Profile and Scenarios

- A developer of a SaaS product (telemedicine, edtech, consulting, an
  internal company tool) who needs a video call as a *feature inside their
  own product*, not as a separate service.
- An early-stage startup with no budget for per-minute billing from
  LiveKit Cloud/Daily/Twilio, but that needs a working video chat right
  now.
- An indie developer who wants to embed video in their open or closed
  project and doesn't want to write a WebRTC stack from scratch.

### 4.2 Where They Hang Out

Hacker News (Show HN for infrastructure tools), r/webdev, r/programming,
Product Hunt (Developer Tools category), Indie Hackers, WebRTC-focused
Discord/Slack communities (webrtcHacks, WebRTC Ventures community),
Twitter/X infrastructure developers.

### 4.3 What They Use Now and Their Terms (2026, verified by search)

| Solution | Model | Terms / pricing | Source |
|---|---|---|---|
| **Jitsi Meet iframe API / Jitsi as a Service (8x8)** | Iframe embed or self-host | Free to self-host, but requires standing up several components (videobridge, prosody, jicofo); the managed option is paid | [Jitsi handbook][jitsi-handbook] |
| **LiveKit** | Open-source SFU (Go/Pion) + managed Cloud | **Fully free to self-host** (Apache 2.0) — you only pay for your own infrastructure; Cloud: Free/Build tier, Ship $50/mo, Scale $500/mo, then usage-based (agent minutes $0.01/min, WebRTC minutes $0.0004–0.0005/min, bandwidth $0.10–0.12/GB) | [livekit.com/pricing][livekit-pricing], [self-hosting docs][livekit-selfhost] |
| **Daily.co** | Managed API/SDK | 10,000 free participant-minutes/month, then $0.004/participant-minute; recording billed separately | [daily.co pricing][daily-pricing] |
| **Twilio Video** | Managed API | In March 2024 announced EOL for December 2024, but **reversed the decision in October 2024** — the product remains standalone; status as of 2026 — alive, but with a history of a nerve-wracking announcement that integrators remember | [Twilio changelog][twilio-reversal], [bloggeek.me][twilio-sunset] |
| **Whereby Embedded** | Managed iframe/SDK | Explore — free tier, Build — $9.99/mo, Grow — custom; usage-based billing on top | [whereby.com/pricing][whereby-pricing] |
| **mediasoup / Pion** | "Bare" libraries (Node.js/Go) | Free and open source, but these are **low-level engines**: no UI, no signaling out of the box — the integrator writes everything themselves | [mediasoup/Pion comparison][sfu-comparison] |
| **MiroTalk P2P** | Self-hosted P2P, ready-made UI | Free, but **AGPLv3** — if embedded into a closed product with modifications, you must open-source the changes | [GitHub][mirotalk] |

### 4.4 Their Pain Points With Current Solutions

- **Per-minute billing** is unpredictable at launch: Daily/LiveKit
  Cloud/Whereby's "pay for what you use" model is great at scale, but
  worrying for an MVP with no predictable traffic.
- **Bare libraries** (mediasoup, Pion) give control, but require
  implementing signaling, UI, TURN plumbing, a permissions model — weeks
  of work before there's anything to show a user.
- **Licensing traps**: AGPL solutions (MiroTalk P2P and many self-hosted
  alternatives) require disclosing changes when embedded into SaaS — for a
  closed product this is often a red flag during a lawyer's due diligence.
- **Anxiety around a product's fate**: the Twilio Video story (EOL
  announcement → reversal 7 months later) is a live example of how a
  managed API can one day shut down, and migrating away from a proprietary
  protocol is expensive.
- **Overkill for small use cases**: if a product needs a 1:1 or small-group
  video call (a consultation, an appointment, a small-team call), a full
  SFU stack (Jitsi, LiveKit self-host) is excess infrastructure for
  functionality that mesh already covers.

### 4.5 How to Sell to Them Specifically

**Key message:**

> "MIT-licensed, single binary, no per-minute billing ever — fork it, brand it, ship it inside your product."

**3–5 supporting points:**

1. **MIT**, not AGPL/copyleft — can be embedded into a closed commercial
   product with no obligation to open-source your code.
2. A single binary with no external dependencies (no database, no Redis,
   no separate SFU cluster) — deploys in minutes, not like a Jitsi/Matrix
   stack made of several services.
3. A ready-made signaling protocol + WebRTC-mesh front-end logic out of the
   box — not a low-level library like mediasoup/Pion, where all of that
   would have to be written yourself.
4. No per-minute usage fee, because there's no billing model at all —
   self-host = your infrastructure, your costs, predictable in advance.
5. Split-origin mode (front end and signaling on different domains/
   operators) — convenient for embedding under your own domain/brand,
   without being tied to ours.
6. **The server never touches the media at all** (see
   [§9](#9-server-load--0-argument-for-segments-3-and-4)) — so your
   infrastructure cost barely grows with the number of simultaneous calls,
   unlike Daily/LiveKit Cloud/Whereby, whose billing is calculated by
   participant-minutes/media traffic precisely because their server
   physically passes that media stream through itself.

**Which features to show first:**

- The MIT license — prominently, in the very first second (this is often
  the first question a lawyer/CTO asks).
- `docker compose up -d` → a working instance in a couple of minutes —
  time to first impression is critical for this segment.
- `docs/signaling-protocol.md` and `docs/self-hosting.md` (env vars,
  `CORS_ORIGIN`, split-origin) — an integrator wants to see the protocol
  and configuration before they start integrating.
- The "no per-minute fee" angle, with an explicit comparison against
  Daily/LiveKit Cloud/Whereby billing.

**Which limitations to honestly acknowledge:**

- Recommended default — up to 6 participants (env `MAX_PARTICIPANTS`,
  mesh architecture); formally it can be raised, but the price is
  traffic/CPU on EVERY client, not the server. For a product that needs
  dozens/hundreds of participants in one room (webinars, large trainings),
  mesh still isn't architecturally suited — LiveKit/mediasoup/Jitsi are
  still a better fit there, and it's honest to point such integrators in
  that direction.
- No built-in recording/streaming — if the product needs "call + recording
  for compliance," that's not us (and by design this is deliberate: the
  server doesn't see the media, so it can't record it itself).
- Single-replica, in-memory — an integrator who needs horizontal
  scaling/rolling deploys with no downtime will need to account for this
  in their own infrastructure (a redeploy = a few seconds of signaling
  disruption, P2P media doesn't drop).
- A young project with no public track record of large integrations —
  unlike LiveKit/Daily with a history of enterprise customers, here it's
  currently "try it and judge for yourself," not "hundreds of companies
  already use it."

**Distribution channels:** Show HN (a title along the lines of
"MIT-licensed P2P video chat you can embed — no per-minute billing"),
Product Hunt in the Developer Tools category, r/webdev, publication in
roundups like "open source alternatives to Daily/Twilio Video," an
upstream PR/mention in awesome-webrtc-style lists, a technical article on
dev.to/a personal blog with a benchmark of "time to first working call:
us vs. mediasoup vs. Jitsi self-host."

### 4.6 What Can't Be Honestly Promised

- Can't promise "a replacement for LiveKit/mediasoup at scale" — mesh
  physically can't handle many participants; honestly, this is a niche
  tool for small-group video inside a product, not a universal video
  stack.
- Can't promise SLA/support at the level of a managed vendor (Daily/
  LiveKit Cloud maintain their own infrastructure and are responsible for
  uptime) — self-host = your responsibility for deployment and
  monitoring.
- Can't promise a recording/streaming API "just add a flag" — this doesn't
  exist and architecturally can't appear without compromising privacy (the
  server would have to gain access to the media).
- Can't promise ready-made SDKs for native iOS/Android apps — browser/
  WebView only; for a mobile SaaS with a native client this is a
  significant limitation.

### 4.7 EN Drafts

```
MIT-licensed. One binary. Fork it, put your logo on it, run it behind
your own domain — no usage-based billing, no per-minute meter, ever,
because the server never touches your media in the first place. Best
fit for small-group calls (recommended default: up to 6, configurable)
baked into your own product; not a replacement for a full SFU stack if
you need dozens of participants in one room.
```

---

## 5. Competitor and Limits Summary Table (2026)

| Product | Type | Free/basic tier limit | Server sees media? | License | Self-host? |
|---|---|---|---|---|---|
| Zoom Basic | Mainstream SaaS | 40 min (group 3+), unlimited 1:1 [zoom-40] | Yes (centralized) | Proprietary | No |
| Google Meet (personal) | Mainstream SaaS | 60 min (group 3+) [meet-60] | Yes | Proprietary | No |
| Microsoft Teams (free) | Mainstream SaaS | 60 min, up to 100 participants [teams-limits] | Yes | Proprietary | No |
| WhatsApp | Messenger | up to 32 video participants [wa-32] | Metadata yes, content E2E | Proprietary | No |
| Telegram | Messenger | 30 active / 1000 viewers [tg-1000] | Yes (calls not E2E by default in groups) | Proprietary (client partly open) | No |
| Signal | Messenger | 75 group call participants [signal-75] | No (E2E), but Signal's server is closed source | Open client, closed server | No (server side) |
| Jitsi Meet | Self-hosted, SaaS-style | No formal limit; server = SFU | Yes by default (terminates DTLS-SRTP at videobridge); E2EE is an optional toggle, Chromium-only, disables recording/streaming [jitsi-e2ee] | Apache 2.0 | Yes, but several components [jitsi-handbook] |
| Element Call / Matrix | Self-hosted, federated | No limit; scales via LiveKit SFU | Via LiveKit SFU — like Jitsi | Apache 2.0 (Element Call) | Yes, but homeserver + LiveKit [element-call] |
| Jami | P2P, decentralized | No limit | No — no server at all | GPLv3 (GNU project) | N/A (serverless by design) [jami] |
| MiroTalk P2P | Self-hosted P2P | No time/room limit | No (mesh, like us) | **AGPLv3** | Yes, single service [mirotalk] |
| Galène | Self-hosted SFU | ~20 participants/core in many-to-many | Yes (SFU) | MIT | Yes, single binary (Go) [galene] |
| **Our chat** | Self-hosted P2P mesh + public instance | **Recommended default 6 participants / auto-close after 3h on the public instance (both are config: `MAX_PARTICIPANTS`/`MAX_ROOM_LIFETIME_SECONDS`; the product itself has no limit)** | **No — structurally impossible** | **MIT** | Yes, single Rust binary |
| LiveKit (self-host) | Open-source SFU | No limit (your own infra) | Yes (SFU), unless an E2E layer is added | Apache 2.0 | Yes [livekit-selfhost] |
| LiveKit Cloud | Managed | Free/Build tier → $0.01/min agent, $0.0004–5/min media [livekit-pricing] | Yes | — | No |
| Daily.co | Managed | 10,000 free participant-minutes/mo → $0.004/min [daily-pricing] | Yes | — | No |
| Whereby Embedded | Managed | Explore free → Build $9.99/mo → Grow custom [whereby-pricing] | Yes | — | No |
| Twilio Video | Managed | Paid from the start; EOL announced 2024, reversed the same year [twilio-reversal] | Yes | — | No |
| mediasoup / Pion | Library | No limit — but no UI/signaling out of the box either | Depends on what you build | ISC (mediasoup) / MIT (Pion) | Yes, but you have to build it yourself [sfu-comparison] |

---

## 6. One Landing Page / README for All Segments: Message Hierarchy

All four segments don't contradict each other — they simply read the
landing page at different depths. The right hierarchy is **one headline
for everyone, sections that go deeper for each segment**, not four
separate landing pages.

### 6.1 Headline (for everyone, 3 seconds to read)

```
A video call the server can't see, and remembers nothing.
No sign-up. Six people, three hours by default — then it's gone.
```

This simultaneously:
- is understandable to a non-technical user ("no registration needed,"
  "the server doesn't see it"),
- answers the technical user with limits ("three hours by default, not a
  product ceiling" — a contrast against the hard 40/60 minutes of
  Zoom/Meet, which can't be changed no matter what, and which they already
  know from painful experience),
- hints to the paranoid user at the architecture ("the server can't see
  it," not "the server promises not to look"),
- hints to the integrator that this is an open tool, not just a SaaS
  (via a link to GitHub in the header/footer).

### 6.2 First Screen (a single demonstration of action)

A **"Start a call"** button → immediately a link + QR code. One click — a
common anchor for all segments: this is the exact UX that sells itself to
a non-technical user and simultaneously demonstrates "no signup" to a
technical user without a single word.

### 6.3 Sections Below, by Segment (order — by priority, see §7)

1. **"No account, ever."** (non-technical users + paranoid users) — in
   simple words: what the server sees / doesn't see, a link to the privacy
   panel in the app.
2. **"Free, and we mean it — 3 hours, not 40 minutes."** (technical users
   tired of limits) — a direct comparison table with Zoom/Meet/Teams.
3. **"The server structurally can't see your call."** (paranoid users) —
   an architecture diagram of mesh vs. SFU, a link to `docs/security.md`,
   build hash, SAS emoji.
4. **"MIT. One binary. Embed it."** (integrators) — a block at the very
   bottom or a separate `/self-hosting` and `/for-developers` page, a link
   to `docs/self-hosting.md` and `docs/signaling-protocol.md`.

### 6.4 General Rule of Wording

- Never lie about the limits — everywhere "6 people" or "3 hours" is
  mentioned, right next to it (not somewhere else on the page) — the
  honest reason AND the config status: "mesh architecture, by design —
  configurable, this is our recommended default / this instance's
  setting" — turns the limitation into a signal of deliberate design, not
  a hidden downside, and doesn't pass off a configured default as a hard
  product ceiling.
- The word "privacy" doesn't sell to a non-technical user — "nothing is
  saved" / "no sign-up" does. The word "open source" doesn't sell to a
  non-technical user — it sells to the paranoid user and the integrator.
  Keep these words in separate sections, don't mix them in the headline.

---

## 7. Segment Prioritization

**Cheapest to acquire → most organic growth for the least effort:**

1. **Segment 3 (paranoid users/self-hosters)** — the cheapest channel: one
   good r/selfhosted post + getting into awesome-selfhosted delivers
   long-term organic traffic almost for free, and this audience actively
   shares findings further on its own (on r/privacy, in Telegram chats).
   They are also the most demanding critics, so a successful launch here
   validates the product before the other segments.
2. **Segment 2 (technical users tired of limits)** — also cheap (Show HN,
   Twitter), and this is the segment with the strongest everyday motive of
   "I need this right now" — conversion from visit to actual use is higher
   than for paranoid users (who read the threat model first, then try it).
3. **Segment 1 (non-technical users)** — the largest TAM, but the most
   expensive channel (no dedicated community channels, only word of mouth
   through technical people from segments 2–3) — **grows as a side effect
   of success with 2 and 3**, not as a separate marketing campaign at
   launch.
4. **Segment 4 (integrators)** — the longest decision cycle (needs time
   for evaluation, license due diligence), but the highest potential
   "leverage" — one product that embeds us can bring many end users not
   through direct marketing, but through distribution of someone else's
   product. It's worth investing in documentation for this segment early
   (`self-hosting.md`, `signaling-protocol.md` are already in good shape),
   but not expecting a fast conversion.

**Recommended launch order:** r/selfhosted + Show HN simultaneously
(segments 2 and 3 read the same channels) → in 2–4 weeks an
awesome-selfhosted PR → a month later a light pitch toward integrators
(Product Hunt Developer Tools, a dev.to article) → segment 1 growth
happens passively throughout, no separate channel needed.

---

## 8. Combined List of "What We Can't Honestly Promise"

The points from sections 1–4, collected in one place — so that no
marketing text "drifts" toward exaggeration:

| Can't promise | Why | Honest alternative wording |
|---|---|---|
| "Unlimited" (about our PUBLIC instance) | On chat.fedorov.it a default of 3 hours / recommended 6 people is configured — this is that instance's operator config, not a product ceiling | "On our instance — 3 hours and 6 people, more generous than Zoom/Meet; the product itself sets no limit — self-host with any `MAX_ROOM_LIFETIME_SECONDS`/`MAX_PARTICIPANTS`" |
| "Anonymity from other participants" | In P2P, participants see each other's real IP | "The other person only sees your IP address — and nothing else" |
| "More private than Jitsi with E2EE enabled" | With Jitsi E2EE enabled, the result is cryptographically similar | "For us this is the default, always, with no toggle and no loss of features" |
| "Audited by an independent team" | No audit exists, only an internal threat model | "A small, readable codebase — check it yourself" |
| "A replacement for Zoom/Teams for large meetings" | Mesh doesn't scale beyond small groups | "For small, spontaneous calls — not for webinars with 100+ people" |
| "You can record the call" | Architecturally the server doesn't see the media → can't record it | "No recording — this is a deliberate trade-off for privacy" |
| "Works like a native mobile app" | Browser/PWA only, no App Store/Play Store presence | "Mobile browser, installable as a PWA — no app store" |
| "Enforced guest restrictions" | Guest permissions are a cooperative measure, not server-enforced | "Moderation works for honest clients; this is not protection against a modified client" |
| "SLA / guaranteed uptime" (for integrators) | Self-host = the operator's responsibility, single-replica | "Your infrastructure, your uptime — we are not a managed vendor" |
| "No metadata at all" | The server sees room id, peer id, join/leave timings | "Content is never visible; the fact of the call and its timing are visible, honestly" |
| "The more people on the call, the higher the server load" | Incorrect: mesh media is P2P and never touches the server; the server only participates in signaling while the connection is being set up (see [§9](#9-server-load--0-argument-for-segments-3-and-4)) | "Server load during the call itself is ≈ 0, regardless of the number of participants" |

---

## 9. Server Load ≈ 0 (Argument for Segments 3 and 4)

A separate section, because this is a strong, concrete (not "lightweight,"
but actual numbers) argument specifically for paranoid self-hosters (§3 —
"what can I run this on") and integrators (§4 — "how much will this cost
in infrastructure"), and it hadn't been explicitly spelled out in the
existing sections before.

### 9.1 What the Server ACTUALLY Does, Traffic-Wise

Only signaling — and the list below is exhaustive (`src/ws.rs`,
`src/state.rs`):

- Holds rooms in the process's memory (participants, leader, settings) —
  this is RAM, not traffic.
- Relays small ENCRYPTED SDP offer/answer blobs and ICE candidates between
  pairs of participants — ONLY while a connection is being established
  (at the moment of joining a room and during ICE renegotiation), not for
  the whole duration of the call. The server doesn't parse or store them —
  it just routes opaque bytes from one peerId to another (`privacy.md`
  §1–2). The server itself caps each such message — no more than 16KB
  (`RELAY_MAX_BYTES`, see `security.md` §4).
- Service events: `join-room`/`peer-joined`/`peer-left`, an encrypted
  `name-announce` (no more than 2KB per message), leader changes, room
  setting changes, screen-share start/stop — all of these are short JSON
  messages, single-digit-to-kilobyte in size, not tied to the duration of
  the call (mostly join/leave events, not a continuous stream).
- A WebSocket ping/pong heartbeat every 20 seconds per connection
  (`PING_INTERVAL`, `src/ws.rs`) — a few bytes per frame, to keep the
  connection alive and catch a network drop earlier than the OS's TCP
  timeout.

### 9.2 What NEVER Goes Through the Server

Video, audio, chat — travel over a direct WebRTC mesh between browsers,
the server doesn't participate in this path at all (`privacy.md` §1).
Files deserve a special mention: they too travel over a dedicated P2P data
channel and are NOT proxied through the server under ANY circumstances,
including the case where a direct connection cannot be established
(`privacy.md` §1, `chat.md` §10 "No Server Fallback") — meaning that even
in the worst-case network scenario, the server never becomes a file
relay, unlike many other server architectures with a server-side
fallback.

### 9.3 Consequence: Server Traffic for a Room ≈ 0 During the Call

The only traffic the server carries over the entire life of a room is a
short burst while mesh connections are being established (as participants
join) and rare short events (join/leave/setting changes/leader changes).
The conversation itself — no matter how long it runs — does NOT create
growing server traffic: a 3-hour call and a 3-minute call load the server
almost identically, because the load is tied to the number of connection-
establishment EVENTS, not to time or media volume.

**A rough order-of-magnitude estimate** (not an exact budget):

- One encrypted SDP blob (offer/answer, base64 + AES-GCM overhead) is
  roughly **2–8 KB**; an ICE candidate is noticeably smaller, around
  0.5–1.5 KB, and there are usually several of these per pair during
  connection setup.
- A room of 6 participants is a full mesh, i.e. **15 pairs**
  (C(6,2) = 15) — each pair exchanges one offer, one answer, and a few ICE
  candidates through the server, once, during setup.
- In total, setting up an ENTIRE room of 6 people comes out, by a rough
  estimate, to **on the order of tens of KB, up to, in the worst case, a
  modest hundred KB** total, ONE TIME, as all participants join — and
  that's the entire server traffic for the whole life of the room,
  whether it lasts 5 minutes or the full configured 3 hours. For
  comparison: one second of 720p video turned on in the mesh is already
  hundreds of KB PER SECOND, but that data never goes through the server
  at all.

### 9.4 Consequence: It's Cheap to Hold Many Rooms at Once

Since server load barely depends on how many participants are talking or
for how long, a tiny VPS (1 vCPU / 512 MB RAM) has no trouble holding
hundreds to thousands of parallel rooms — the bottleneck isn't
CPU/signaling traffic, it's the default ceiling `MAX_ROOMS=500`
(`DEFAULT_MAX_ROOMS`, `self-hosting.md` §6), which by itself is simply a
conservative DoS protection measure (H2, see `security.md` §4), not a
reflection of real resource constraints — the operator can raise it higher
on the same cheap VPS if more simultaneous rooms are needed.

### 9.5 How to Use This in Pitches

- **Segment 3 (paranoid users/self-hosters, §3.5):** "runs on the
  cheapest VPS" — not a generic slogan, but a direct consequence of the
  server physically never seeing or passing the media stream through
  itself; these numbers can be shown right on the landing page as proof,
  rather than just asserted.
- **Segment 4 (integrators, §4.5):** "no per-minute costs" — because the
  server's load physically doesn't scale with call activity (only with
  the NUMBER of simultaneous ROOMS, which is not the same thing) — unlike
  Daily/LiveKit Cloud/Whereby, whose billing is calculated precisely by
  participant-minutes/GB of media traffic because their server physically
  passes that traffic through itself.

---

## Sources

- [zoom-40] Zoom: [Understanding time limits for Zoom Meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067966); [Is Zoom Free? Free Plan Limits & Upgrade Triggers (2026)](https://costbench.com/software/communication/zoom/free-plan/)
- [meet-60] Google Meet: [Google Meet Time Limit: Free vs Paid Plans (2026)](https://www.itsconvo.com/guides/google-meet-time-limit); [Google Meet Time Limit (2026)](https://meetgeek.ai/blog/google-meet-time-limit)
- [teams-limits] Microsoft: [Limits and specifications for Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/limits-specifications-teams); [Microsoft Teams Meeting Limits: Length & Participants (2026)](https://www.usecarly.com/blog/teams-meeting-limit/)
- [twilio-reversal] [Twilio Video Will Remain a Standalone Product](https://www.twilio.com/en-us/changelog/-twilio-video-will-remain-a-standalone-product); [Programmable Video End of Life Notice](https://help.twilio.com/articles/20950630029595-Programmable-Video-End-of-Life-Notice)
- [twilio-sunset] [Twilio exits video APIs, further focusing on voice, SMS and Segment](https://bloggeek.me/twilio-programmable-video-sunset/)
- [livekit-pricing] [LiveKit Pricing](https://livekit.com/pricing)
- [livekit-selfhost] [Self-hosting overview | LiveKit Documentation](https://docs.livekit.io/transport/self-hosting/)
- [daily-pricing] [Daily.co Pricing](https://www.daily.co/pricing/video-sdk/); [Our new pricing](https://www.daily.co/blog/announcing-our-new-pricing/)
- [jitsi-handbook] [Jitsi Meet Self-Hosting Guide](https://jitsi.github.io/handbook/docs/devops-guide/)
- [jitsi-e2ee] [Does Jitsi support end-to-end encryption?](https://jitsi.org/e2ee-in-jitsi/); [How encryption works on Jitsi meet](https://meetrix.io/blog/webrtc/jitsi/end-to-end-encryption-on-jitsi.html)
- [galene] [Galène videoconference server](https://galene.org/)
- [galene-gh] [GitHub - jech/galene](https://github.com/jech/galene/)
- [mirotalk] [GitHub - miroslavpejic85/mirotalk](https://github.com/miroslavpejic85/mirotalk)
- [jami] [Jami](https://jami.net/)
- [jami-wiki] [Jami (software) - Wikipedia](https://en.wikipedia.org/wiki/Jami_(software))
- [whereby-pricing] [Video Conferencing API Pricing | Whereby Embedded](https://whereby.com/information/embedded/pricing)
- [sfu-comparison] [mediasoup, Janus, LiveKit, Jitsi Videobridge, Pion: Choosing an SFU](https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion)
- [awesome-selfhosted] [awesome-selfhosted/awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted)
- [signal-75] [Signal raises limit for audio and video calls to 75 participants](https://aboutsignal.com/news/signal-raises-limit-for-audio-and-video-calls-to-75-participants/)
- [element-call] [GitHub - element-hq/element-call](https://github.com/element-hq/element-call)
- [element-sovereignty] [Element Call: Redefining conferencing for privacy, scale and sovereignty](https://element.io/blog/element-call-redefining-conferencing-for-privacy-scale-and-sovereignty/)
- [wa-32] [WhatsApp expands the number of participants for a video call to 32](https://www.techzine.eu/news/collaboration/121169/whatsapp-expands-the-number-of-participants-for-a-video-call-to-32/)
- [facetime-32] [Make a Group FaceTime call on iPhone](https://support.apple.com/guide/iphone/make-a-group-facetime-call-iph405ab67de/ios)
- [tg-1000] [Telegram: Video Calls with up to 1000 Viewers](https://telegram.org/blog/video-1000)
- [hn-disposable] [Free, P2P, disposable group video calling app for the web | Hacker News](https://news.ycombinator.com/item?id=34107240)
- [hn-nosignup] [Show HN: Group video chat with no signups or downloads | Hacker News](https://news.ycombinator.com/item?id=18447957)
- [hn-briefing] [Show HN: Briefing – Anonymous, secure, open source WebRTC group video chat | Hacker News](https://news.ycombinator.com/item?id=23523830)

Internal sources for product facts: `README.md`, `docs/PRD.md`,
`docs/DESIGN.md`, `docs/privacy.md`, `docs/security.md`,
`docs/self-hosting.md` (all — in this repository, current as of the time
of the research).
