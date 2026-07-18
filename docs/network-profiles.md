# Field network profiles (egress snapshots)

Real-world snapshots of what restrictive networks let out, and what that means
for connectivity. WebRTC needs either UDP egress (for direct P2P / STUN) or a
reachable TURN fallback; when a network allows neither, the call cannot connect
even though signaling (WSS on 443) succeeds and users still see each other in
the room. These snapshots explain the connectivity problems users hit and drive
the TURN-over-TLS-on-443 recommendation.

> How to reproduce a snapshot: run the egress probe (TCP connect tests, a raw
> STUN Binding request over UDP, direct UDP:53 DNS, captive-portal check, and a
> TLS handshake to the signaling host). It only tests **outbound** connectivity
> from the machine you are on — standard network diagnostics, nothing intrusive.

---

## Sofia Airport (SOF) — public Wi-Fi — 2026-07-17

**Egress policy: strict per-port allowlist. No captive portal. No TLS interception.**

| Class | Result |
|---|---|
| TCP 80 / 443 | **open** (e.g. google.com:443 41ms, chat-api.fedorov.it:443 open, TLS 1.3 clean) |
| TCP everything else | **blocked** — 22, 3478 (TURN/TCP), 5349 (TURNS), 8080, 587, 993, 995, 123, 853, 3389, 1194, 9999 all time out (confirmed port-based: google.com:443 open but google.com:993/587/123 blocked) |
| UDP 53 (DNS) | **open** (direct UDP:53 to 1.1.1.1 and 8.8.8.8 works) |
| UDP everything else | **blocked** — STUN over UDP 3478 / 19302 to Google and to our own TURN all time out |
| Captive portal | none (`generate_204` → 204, `captive.apple.com` → Success) |
| DNS | resolves normally |

**Effect on the app on this network:**
- Signaling (WSS on 443 via Cloudflare) works → users load the page, join the
  room, and see each other's tiles and names.
- All ICE paths fail: direct P2P (UDP) blocked, STUN (UDP 3478/19302) blocked,
  TURN/UDP 3478 blocked, TURN/TCP 3478 blocked, TURNS 5349 blocked.
- Result: **the call does not connect at all** — no video, no audio, and no P2P
  text chat / file transfer either (they ride the same peer connection / DTLS).
  The room and participant list appear, but the mesh never establishes.

**What would make it work here:** TURN over TLS on **TCP 443** (TURNS/443).
Port 443 is the only reliably open path; TURNS/443 multiplexes with normal
HTTPS and is the standard fallback for "443-only" networks (airports, hotels,
corporate guest Wi-Fi). Our TURN does not currently listen on 443 (its host
firewall opens only UDP 3478 + the relay range), so this path is unavailable —
see the TURN section of `self-hosting.md` and the merge/embed design record
(`research-merge-servers.md`) for where a 443 listener would slot in.

> **Status (2026-07-18): in progress.** TURNS/443 support is being added —
> see [`self-hosting.md` §5.3](self-hosting.md#53-turns443-tls-fallback-for-443-only-networks)
> for the listener/cert/env-var setup once it lands.

> This is a single point-in-time snapshot of one network; other networks are
> less restrictive. But the "TCP 80/443 + UDP 53 only" profile is common, so
> supporting it (TURNS/443) is worthwhile.
