# screenshare

A browser-based meeting room with screen sharing, video, voice, and text
chat — no sign-up, no accounts, no recording. Everyone in a room is an equal
peer connected over a WebRTC full mesh; media and chat flow **directly between
browsers**, never through the server. Room content is end-to-end encrypted and
fully ephemeral — nothing is stored anywhere once the meeting ends.

**Live demo: https://chat.fedorov.it** — create a room, share the link, done.

## Key features

- **Meeting rooms up to 6 people** — create a room in one click, share a short
  link (or QR code), others join instantly. No registration.
- **Screen sharing, camera, and microphone** for every participant, with
  instant mute/unmute; one screen share at a time.
- **Peer-to-peer text chat** with formatting, replies, reactions, message
  edit/delete, and file/image/audio transfer — sent directly between
  participants, never stored on the server.
- **End-to-end encrypted** — the room key lives only in the link fragment
  (`#k`), never reaches the server; signaling, names, and fallback chat are
  AES-256-GCM. A compromised server can neither read the traffic nor tamper
  with it.
- **Moderation** — one participant is the room leader (waiting room / admit
  guests, toggle guest chat / audio / video / screen).
- **Anonymous & ephemeral** — no cookies, no localStorage; rooms, names, and
  chat live only in memory and vanish when the room empties. Hard 3-hour cap
  per meeting.
- **Mobile-first** and installable as a PWA.

## Self-hosting

The whole thing is a single Rust binary that serves both the signaling relay
and the static frontend from one origin — easy to run anywhere.

**On one machine (simplest):**

```
docker compose up -d
```

Then open **http://localhost:3000**. On `localhost`, camera/mic/screen work
over plain HTTP (browsers treat it as a secure context).

**On your own domain:** put it behind a reverse proxy that terminates TLS
(Caddy gives automatic HTTPS in two lines; nginx + certbot also works) and
forwards both HTTP and the `/ws` WebSocket to the container. HTTPS is required —
browsers block camera/mic/screen on anything but `localhost` or `https://`.

**On a local network** (other devices by LAN IP): you still need HTTPS —
`http://192.168.x.x` is *not* a secure context, so camera/mic/screen are
blocked there. Use the domain/TLS setup above, a self-signed cert (e.g.
`mkcert`), or a tunnel.

TURN is optional (STUN alone covers most networks); add one only if some users
sit behind symmetric NAT. Full guide, environment variables, and reverse-proxy
examples: **[docs/self-hosting.md](docs/self-hosting.md)**.

## Documentation

- **[docs/PRD.md](docs/PRD.md)** — what the product is and does (business
  requirements).
- **[docs/DESIGN.md](docs/DESIGN.md)** — technical design overview and a map to
  the detailed docs.
- **[docs/](docs/)** — deep dives: signaling protocol, WebRTC mesh, end-to-end
  encryption, chat, permissions & leader, security, privacy, self-hosting.

## Development

```
cargo run                        # serves on http://localhost:3000
node tests/signaling.test.mjs    # signaling protocol tests (no browser)
cd tests/e2e && npm install && node basic.spec.mjs   # browser e2e (needs Chrome)
```

## License

[MIT](LICENSE) © 2026 Roman Fedorov
