# Self-Hosting

<!-- toc -->

- [1. Two Supported Topologies](#1-two-supported-topologies)
  - [1.1 Single Origin (Simplest)](#11-single-origin-simplest)
  - [1.2 Split Origin (Frontend / Signaling Separated)](#12-split-origin-frontend--signaling-separated)
- [2. Running the Container](#2-running-the-container)
- [3. Reverse Proxy & TLS](#3-reverse-proxy--tls)
- [4. The `localhost` vs. LAN/Domain Secure-Context Nuance](#4-the-localhost-vs-landomain-secure-context-nuance)
- [5. TURN (Optional)](#5-turn-optional)
  - [5.1 Rotating the Shared Secret](#51-rotating-the-shared-secret)
- [6. Environment Variables](#6-environment-variables)
- [7. Operational Notes](#7-operational-notes)
  - [7.1 Single Replica, In-Memory State](#71-single-replica-in-memory-state)
  - [7.2 Surviving a Restart/Redeploy](#72-surviving-a-restartredeploy)
  - [7.3 Health Checks](#73-health-checks)
- [8. Keeping Deployment Private (Two-Repo Pattern)](#8-keeping-deployment-private-two-repo-pattern)

<!-- /toc -->

> This document describes how to run your **own** instance of this project.
> It intentionally names no specific hosting provider, domain, or
> infrastructure — everywhere a host or domain is needed below, substitute
> your own (shown as `example.com` / `your-server`). See
> [`../Dockerfile`](../Dockerfile) and [`../src/main.rs`](../src/main.rs) for
> the underlying implementation of everything described here.

## 1. Two Supported Topologies

### 1.1 Single Origin (Simplest)

The backend binary can serve **both** the API/WebSocket endpoints and the
static frontend files itself, from one process, on one origin. This is the
default the project ships with (`STATIC_DIR` points at the bundled
`static/` directory — see [`../Dockerfile`](../Dockerfile)) and needs no
cross-origin configuration at all: `window.API_BASE` defaults to
same-origin (see [`../static/config.js`](../static/config.js)), so the
frontend simply talks to whatever host served it.

This is the right choice for a straightforward self-hosted instance: one
container, one domain, one TLS certificate.

### 1.2 Split Origin (Frontend / Signaling Separated)

The frontend's static files can instead be served from a **separate**
origin (any static host) while the backend serves only `/api/*`, `/config`,
`/version.json`, and `/ws`. This is what [`e2e-encryption.md` §4](e2e-encryption.md#4-trust-split-static-origin-vs-signaling-server)
calls the trust split: no single operator then simultaneously controls both
the client code served to a browser and the signaling channel that code
talks to.

To run this way:

1. Deploy the backend on its own host/domain (e.g. `api.example.com`).
2. Copy `static/` to your static host of choice, and overwrite
   [`static/config.js`](../static/config.js) in that copy with:
   ```js
   window.API_BASE = 'https://api.example.com';
   ```
3. On the backend, set `CORS_ORIGIN` to the frontend's origin (e.g.
   `https://example.com`) — see [§6](#6-environment-variables). This enables
   CORS on the three cross-origin HTTP endpoints and turns on `Origin`
   validation on the WebSocket upgrade, so only that configured frontend
   origin can talk to your backend.
4. Serve the frontend copy with a security-headers configuration
   appropriate to your static host (CSP, `X-Frame-Options`,
   `Permissions-Policy` — see [`security.md` §6](security.md#6-m2--security-headers--csp)
   for exactly what's recommended and why).

If `CORS_ORIGIN` is left unset (the default), none of this is enabled —
cross-origin requests are simply not accepted, which is correct for the
single-origin topology in [§1.1](#11-single-origin-simplest).

## 2. Running the Container

The provided [`../Dockerfile`](../Dockerfile) builds a small, self-contained
image (Rust binary + the bundled `static/` directory, no shell, no package
manager inside the image). Build and run it directly:

```bash
docker build -t chat .
docker run -p 8080:8080 chat
```

The server listens on `PORT` (default `3000` when run outside the container
image, `8080` inside it — see [§6](#6-environment-variables)) and serves
everything over plain HTTP; TLS termination is expected to happen in front
of it (see [§3](#3-reverse-proxy--tls)).

Without any `--build-arg`s, the image reports `version: "dev"` from
`/version.json` — the build only needs `APP_VERSION`/`GIT_COMMIT`/
`BUILD_DATE` build args if you want a real version string surfaced to
clients for the version-skew banner (see
[`signaling-protocol.md` §2.6](signaling-protocol.md#26-get-versionjson)).

## 3. Reverse Proxy & TLS

Run the container behind any TLS-terminating reverse proxy (a general-purpose
proxy/load balancer, or a tunnel-based ingress if your hosting environment
provides one) bound to your domain (`example.com`). The proxy needs to:

- Forward ordinary HTTP requests to the backend's `PORT`.
- Forward WebSocket upgrades (`GET /ws`) through unmodified — no proxy-level
  buffering or timeout shorter than a real meeting's duration.
- Optionally set a real client-IP header (`X-Forwarded-For`, or your
  proxy's equivalent) if you want the backend's per-IP rate limits (see
  [`security.md` §4](security.md#4-h2--denial-of-service-limits)) to key
  off genuine client addresses rather than the proxy's own address. The
  backend also recognizes `CF-Connecting-IP` if your proxy sets it, ahead of
  `X-Forwarded-For` — see [`../src/state.rs`](../src/state.rs)
  (`extract_client_ip`).

WebRTC media itself does **not** go through this proxy at all — it's
peer-to-peer (see [`webrtc-mesh.md`](webrtc-mesh.md)); the reverse proxy only
ever carries the small signaling/API traffic.

## 4. The `localhost` vs. LAN/Domain Secure-Context Nuance

Browsers only allow camera/microphone/screen capture APIs
(`getUserMedia`/`getDisplayMedia`) in a "secure context." `localhost` is
treated as a secure context automatically, so running the project locally
with `cargo run` and opening `http://localhost:3000` works with no TLS setup
at all — useful for development and for a quick two-tab test on one machine.

The moment you access the server by any other address — a LAN IP, a
hostname other than `localhost`, or a real domain — the browser requires
HTTPS for those same capture APIs to work. This means a self-hosted instance
reachable by anyone other than the machine it's running on needs TLS (see
[§3](#3-reverse-proxy--tls)) before video/audio/screen sharing will actually
function for those users; joining and using chat-only features may still
appear to work without it, but camera/microphone/screen capture will
silently fail.

## 5. TURN (Optional)

STUN is built in (a public STUN server is always included in `/config`) and
is enough for most direct connections. Add a TURN server only if
participants behind restrictive/symmetric NATs are failing to connect
directly — any RFC 5766-compatible TURN server works (for example,
`coturn` or `turn-rs`).

Recommended setup — a shared-secret (TURN REST API-style) credential scheme,
**not** a static username/password:

1. Configure your TURN server with a shared secret (e.g. `coturn`'s
   `use-auth-secret` + `static-auth-secret`, or the equivalent
   `static-auth-secret` setting on a `turn-rs`-style server).
2. Set `TURN_URL` and `TURN_STATIC_SECRET` (the **same** secret value) on
   this project's backend — see [§6](#6-environment-variables). The backend
   then computes a fresh, short-lived credential pair on every `/config`
   call rather than handing out one static pair forever — see
   [`security.md` §3](security.md#3-h1--ephemeral-turn-credentials) for why
   this matters and what its limits are.
3. If you can't use a shared secret yet, `TURN_USERNAME`/`TURN_PASSWORD`
   remain supported as a static fallback — understand that this reintroduces
   the open-relay risk described in [`security.md` §3](security.md#3-h1--ephemeral-turn-credentials)
   until you migrate to the shared-secret scheme.

### 5.1 Rotating the Shared Secret

The TURN REST API scheme in [§5](#5-turn-optional) only delivers real
ephemerality if you **rotate `TURN_STATIC_SECRET` periodically**. As
explained in [`security.md` §3](security.md#3-h1--ephemeral-turn-credentials),
the expiry timestamp embedded in the credential's `username` is a
convention this project's issuer follows — it is **not enforced by the
TURN server itself**. Your TURN server's static-auth-secret setting (e.g.
`coturn`'s `use-auth-secret`/`static-auth-secret`, or `turn-rs`'s
`static-auth-secret`) only checks the HMAC, not the timestamp, so a
credential pair keeps validating past its embedded expiry for as long as
the secret that produced it stays unchanged. Rotating that one secret is
therefore the actual mechanism that bounds how long a leaked credential
stays usable — not the TTL in `/config`'s response.

Procedure (see the runnable example at
[`../scripts/rotate-turn-secret.example.sh`](../scripts/rotate-turn-secret.example.sh)):

1. **Generate a new secret** — any high-entropy random value works, e.g.:
   ```bash
   openssl rand -hex 32
   ```
2. **Update it in both places at once.** The TURN server's static-auth-secret
   setting and this project's `TURN_STATIC_SECRET` env var must hold the
   **same** value — update your TURN server's config and the application's
   env simultaneously (e.g. both entries in your secret store, config
   management, or `docker-compose.yml` override).
3. **Restart both.** The TURN server needs to reload/restart to pick up its
   new static-auth-secret; this application only reads `TURN_STATIC_SECRET`
   at process start ([§6](#6-environment-variables)), so it needs a restart
   too. Expect a brief interruption of the TURN relay during the restart —
   this affects only participants who need the relay (those behind
   restrictive/symmetric NATs); it does **not** affect direct peer-to-peer
   connections, which are the majority case (see
   [`webrtc-mesh.md`](webrtc-mesh.md)).
4. **Do this on a schedule.** How often is a trade-off you choose — e.g.
   weekly or monthly, ideally outside your busiest hours. The more
   frequently you rotate, the shorter the window a single leaked credential
   stays useful. Automating this with a scheduler in your own
   infrastructure (cron, a Kubernetes `CronJob`, a systemd timer, or
   whatever your deployment already uses) is worthwhile once you're doing
   it regularly — this is exactly the kind of deployment-specific
   automation that's a good fit for keeping your infra separate from the
   public code repo (see [§8](#8-keeping-deployment-private-two-repo-pattern)).

A stronger, optional alternative: if your TURN server supports an
authentication webhook per allocation request, it can validate the
timestamp itself and reject expired credentials outright — making the TTL
a real, server-enforced boundary rather than a convention. That's more
setup than the static-secret scheme above and isn't required to get the
main benefit (bounding a leak's lifetime via rotation); it's worth
considering if your TURN server supports it and you want the TTL to be a
hard guarantee rather than an operational habit.

## 6. Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` (Dockerfile sets `8080`) | HTTP/WebSocket listen port |
| `STATIC_DIR` | no | `static/` next to the binary | Where to serve the frontend from (single-origin topology, [§1.1](#11-single-origin-simplest)) |
| `EMPTY_ROOM_TTL_SECONDS` | no | `120` | How long an empty room (nobody has joined yet, or everyone left) survives before the background reaper deletes it |
| `MAX_ROOM_LIFETIME_SECONDS` | no | `10800` (3 hours) | Hard ceiling on a meeting's duration — see [`security.md` §8](security.md#8-meeting-duration-ceiling) |
| `MAX_ROOMS` | no | `500` | Global ceiling on simultaneous rooms — see [`security.md` §4](security.md#4-h2--denial-of-service-limits) |
| `MAX_PARTICIPANTS` | no | `6` | Ceiling on participants in one room. Not a protocol limit or a server cost — it's a recommended default for the mesh topology: every participant sends media directly to every other one, so raising this only grows *each client's* own outgoing bandwidth/CPU (n-1 copies to send), never the server's — the server only ever relays signaling either way |
| `JOIN_ROOM_IP_LIMIT` | no | `20` (per 60s) | Per-IP rate limit on direct `join-room` (anti-DoS: without it, one IP could open `MAX_PARTICIPANTS` connections and fill a room it doesn't own, locking out legitimate guests who have the link) — see [`security.md` §4](security.md#4-h2--denial-of-service-limits) |
| `CORS_ORIGIN` | no | unset (CORS off entirely) | The frontend's origin, if running the split topology ([§1.2](#12-split-origin-frontend--signaling-separated)); also enables `Origin` validation on the WebSocket upgrade |
| `TURN_URL` | no | unset | TURN server address, e.g. `turn:your-server:3478` |
| `TURN_STATIC_SECRET` | no (recommended if using TURN) | unset | Shared secret for computing short-lived TURN credentials — see [§5](#5-turn-optional) |
| `TURN_USERNAME` / `TURN_PASSWORD` | no | unset | Static TURN credential fallback, ignored once `TURN_STATIC_SECRET` is set |
| `APP_VERSION` / `GIT_COMMIT` / `BUILD_DATE` | no (build args, not runtime env) | `dev` / `unknown` / `unknown` | Baked in at image build time, surfaced via `/version.json` |

If `TURN_URL` is unset, clients get STUN only from `/config` — fine unless
participants are behind NATs that prevent direct connection.

## 7. Operational Notes

### 7.1 Single Replica, In-Memory State

All room state lives in one process's memory (see
[`DESIGN.md` §2.2](DESIGN.md#22-constraints) and
[`privacy.md`](privacy.md)) — this project is designed to run as **exactly
one replica**. Running multiple replicas behind a load balancer would split
participants across processes that can't see each other's rooms at all.
If you deploy on an orchestrator that defaults to rolling updates across
multiple replicas, pin this to a single-replica, recreate-on-deploy strategy
instead of the usual zero-downtime rolling-update pattern.

### 7.2 Surviving a Restart/Redeploy

A restart (deliberate redeploy, or crash-and-restart) drops all in-memory
room state and briefly interrupts the signaling channel for everyone — but
does **not** end an in-progress meeting outright:

- Media and chat are peer-to-peer and keep working through a signaling
  outage (see [`webrtc-mesh.md`](webrtc-mesh.md), [`chat.md`](chat.md)).
- The frontend auto-reconnects with backoff, restores the room via
  `PUT /api/rooms/{roomId}` if needed (see
  [`signaling-protocol.md` §2.2](signaling-protocol.md#22-put-apiroomsroomid)),
  and rejoins with the same peer id so existing peer connections aren't
  torn down and rebuilt.
- A brief "Reconnecting…" banner is shown instead of a hard failure; if a
  screen share was active, the presenter's client automatically resumes it
  after reconnecting.

Expect a few seconds of signaling unavailability on every deploy — this is
inherent to the single-replica model in [§7.1](#71-single-replica-in-memory-state),
not a bug to route around.

### 7.3 Health Checks

`GET /healthz` returns `200 "ok"` whenever the process is up — wire it to
whatever liveness/readiness probe your runtime environment expects. There is
no separate startup dependency (no database, no external service) to wait
on.

## 8. Keeping Deployment Private (Two-Repo Pattern)

This is an optional pattern for operators who want to run a public
open-source instance while keeping their **own** infrastructure and CI
credentials private. Nothing in the application requires it — it is purely a
repository/CI arrangement.

**Two repositories:**

- **Public code repo** (this one) — application source, docs, `Dockerfile`,
  `docker-compose.yml`, generic self-hosting. Its CI runs only build and
  tests (signaling + browser e2e); it holds **no** deployment secrets and
  references **no** specific host, domain, or cluster. This keeps the
  open-source repository clean and safe to publish.
- **Private infra repo** — deployment manifests, reverse-proxy / TLS config,
  TURN configuration, and all deployment secrets (SSH keys, CDN/API tokens),
  living only in that private repo's CI secret store.

**Event-driven deploy.** The private repo deploys **only after the public
repo's build and tests succeed on the main branch** — i.e. after a
successful build/release of the main repo, not on every raw commit. Two ways
to wire the trigger:

1. **Dispatch (event-driven, immediate).** The public repo's CI, once its
   `test`/`e2e` jobs pass on `main`, emits a cross-repo event (e.g. GitHub
   `repository_dispatch`) to the private repo, passing the released commit
   SHA. The private repo's workflow then checks out the public repo at that
   SHA, builds the image, and deploys. This requires a single narrowly-scoped
   token in the public repo's CI secrets (able only to trigger the private
   repo) — it lives in the encrypted secret store, never in tracked files.
2. **Poll (no secret in the public repo).** The private repo periodically
   checks the public repo's main branch for a new released SHA and deploys
   when it changes. Zero coupling and zero secrets in the public repo, at the
   cost of a short polling delay.

Either way, the private repo checks out the public source at the released
commit and owns the entire deploy: image build, delivery to the server, and
static-frontend publishing. The public repo never learns anything about where
or how the instance is hosted.

> Status: planned arrangement for this project's own hosted instance — not
> yet implemented in these repositories.
