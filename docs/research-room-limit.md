# Research: Leader-Set Per-Room Participant Limit

> Status: analysis only, nothing implemented. 2026-07-16.
> Question: is there a need for an additional limit on the number of room
> participants **on top of** the server ceiling
> (`MAX_PARTICIPANTS`, env, default 6 — `src/state.rs::DEFAULT_MAX_PARTICIPANTS`),
> one that the leader sets themselves via `update-settings`, following the
> pattern of `lobbyEnabled`.

<!-- toc -->

- [1. Why This Might Be Needed](#1-why-this-might-be-needed)
- [2. Design](#2-design)
- [3. Security/Privacy](#3-securityprivacy)
- [4. Interaction With Other Features](#4-interaction-with-other-features)
- [5. Verdict](#5-verdict)

<!-- /toc -->

## 1. Why This Might Be Needed

Three claimed scenarios — and an honest comparison of each against what the
waiting room (`lobbyEnabled`, see
[`permissions-and-leader.md` §6](permissions-and-leader.md#6-the-waiting-room-lobby))
already provides today:

| Scenario | Value of the limit | Does it duplicate the waiting room? |
|---|---|---|
| **A 1-on-1 call that a third person can't break into even with the link** | Medium-high. The waiting room solves the same problem, but requires the leader to **be at the screen and personally decline** every third arrival — if they step away (grab coffee, switch windows) at the moment someone knocks with a leaked/guessed link, the waiting room doesn't save the situation automatically: the request just sits there until the leader sees it, and while they're silent, the third participant is neither in the room nor declined — the state is left hanging. A `maxParticipants=2` limit closes the door automatically and immediately, with no human involved. | No, it doesn't duplicate it — the reaction time differs: the waiting room = a per-case decision **in the moment**, the limit = a rule that **holds forever, unsupervised**. |
| **A "three-way webinar"** | Low-medium. This is a special case of the 1-on-1 scenario, just with a threshold of N instead of 2. The value follows the same logic: comfortably "closing the door" at a specific number without having to decline each person personally. | No — same reasoning as above, just a different N. |
| **Saving mobile participants' bandwidth** (the leader knows the audience makeup in advance) | Low. The problem is real (mesh — each client's upload traffic grows as *n*-1, see the `src/state.rs` comment next to `DEFAULT_MAX_PARTICIPANTS`), but a participant limit solves it very crudely — either the Nth person is let in or not, with no regard for whose connection is weak. The leader has no way to know in advance who will join from mobile versus desktop anyway: the limit applies to **join order**, not to any given person's network quality. | Doesn't compete with the waiting room at all — it's a different axis (bandwidth, not admission). |
| **A polite "room is full" instead of surprise guests** | Medium, purely UX. Today an "unexpected guest" either gets `room-full` (if the server ceiling is already hit — a rare event at the default of 6) or simply walks in (if the waiting room is disabled) — apart from the server ceiling, there's no "surprise" scenario anyway **when the waiting room is disabled**, because nobody is checked at all. The limit turns "anyone can walk in" into "anyone can walk in until N slots are taken" — a controllable version of the same thing without manual oversight. | No — with the waiting room disabled, this is the ONLY headcount control mechanism at all, besides the server ceiling. |

**Bottom line on value**: the limit doesn't duplicate the waiting room — they
solve different facets of one problem ("who can get in" vs. "how many can
there be in total"), and the difference is fundamental: **the waiting room
requires a live decision from the leader for every request, the limit works
unsupervised**. The strongest scenario is a 1-on-1 call with
`lobbyEnabled=false` (usually exactly what's wanted: nobody wants to manually
approve their one and only counterpart) and a ceiling of exactly 2 — meaning
**the limit is most needed precisely where people don't want to turn the
waiting room on**. Bandwidth savings is the weakest motivation of the four
and deserves minimal weight in prioritization.

## 2. Design

### 2.1 A Field in `RoomSettings`

```rust
// src/protocol.rs
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    #[serde(default)]
    pub lobby_enabled: bool,
    #[serde(default)]
    pub max_participants: Option<usize>,   // None = "server ceiling" (tracks it automatically)
    // ...guest_* as before
}
```

`Option<usize>` with `None` as the default, rather than "a number fixed at
room-creation time" — this is deliberate: `MAX_PARTICIPANTS` is read from the
env once per process (`LazyLock`, `src/main.rs`), but if the server is
restarted with a different env value and a room survives the restart via
`PUT /api/rooms/{id}` (`restore_room`, `src/main.rs:449-466`), it gets a fresh
`RoomSettings::default()` anyway (see [§4](#4-interaction-with-other-features)
on restarts) — `None` correctly "follows" the new ceiling automatically,
whereas a baked-in number would silently become wrong (and invalid, if the
new ceiling is lower than the old baked-in number).

Validation happens only in `handle_update_settings` (`src/ws.rs:574-614`),
while processing `update-settings`: if `settings.max_participants` is present
and is **not** in `2..=*crate::MAX_PARTICIPANTS` — reject it (`error`, the
settings are not applied), with no partial application of the remaining
fields (preserving the current "all or nothing" mechanics — `settings` is
already applied atomically via a single `room.settings =
settings.clone()`). The lower bound is 2, not 1: a room with a limit of 1
makes no sense (the leader themselves couldn't let anyone in, including
themselves — they already occupy the only slot) — 1 is simply rejected as
invalid input, not treated as a special "solo room" case.

### 2.2 What to Do if Current Participants Already Exceed the New Limit

**Don't kick anyone out** — this agrees with the task's intuition. Rationale:
the server has no effective "soft" way to remove one specific participant
anyway (there's no `kick`/`ban` in the protocol at all — that's a separate,
unimplemented feature), and forcibly dropping someone's WebRTC connection
without warning is far worse UX than "the limit now purely blocks future
newcomers." The practical consequence: when checking `join-room` and
`approve`, `room.settings.max_participants` is compared **not** against
`room.participants.len() >= *crate::MAX_PARTICIPANTS` (as it is today,
`src/ws.rs:390` and `:638`), but against the effective limit:

```rust
fn effective_max_participants(&self) -> usize {
    self.settings.max_participants.unwrap_or(*crate::MAX_PARTICIPANTS)
}
```

If `participants.len() > effective_max_participants()` (the leader lowered
the limit below current occupancy) — this simply means that **all** further
`join-room`/`approve` calls from anyone (including people already approved
from the waiting room) will get `room-full`, until the roster thins out
naturally (someone leaves). No special "over capacity" state is introduced —
the `>=` comparison already handles both `==` and `>` correctly with no extra
code.

### 2.3 UI

Following the pattern of the guest-permission toggles in the leader's
settings panel (`static/room.html:290-360`, `static/room.js` —
`wireSettingToggle`, `static/room.js:2368-2372`, called for every
`<input type="checkbox">` in `syncSettingsPanelInputs`,
`static/room.js:1589-1596`): an analogous `wireSettingSelect` function, but on
`<select id="setting-max-participants">` rather than on a checkbox. Options
range from 2 up to the current `maxParticipants` (the server ceiling, which
the client already knows from `joined.maxParticipants`,
`static/room.js:329`); the top item is labeled "No limit (server max: N)" and
is encoded on the wire as `null`/an absent field, not the number N — this
matters because if the server is later restarted with a different ceiling, a
number N previously set by the client would remain incorrectly fixed,
whereas `null`/`None` continues to mean "no own limit" and correctly picks up
the new ceiling (see [§2.1](#21-a-field-in-roomsettings)).

A required point, separate from the checkboxes: `settings-changed`
(`static/room.js:3178-3183`) today only updates `roomSettings`, but the
`maxParticipants` variable (`static/room.js:329`, read by the participant
counter at `static/room.js:1249` and by the `room-full` overlay text at
`static/room.js:3223`) is a **separate** top-level variable, not linked to
`roomSettings` in any way. Without an explicit change to the
`settings-changed` handler (adding `maxParticipants = settings.maxParticipants
?? SERVER_MAX; updateParticipantCount();`), the counter and the "Room is
full" text **will not update** in real time when the leader changes the
limit during a call — this is not a "minor detail" but a separate, easily
forgotten point that needs fixing.

### 2.4 What Happens to `pending` Waiting-Room Requests When the Limit Is Lowered

No special handling is needed — waiting-room requests **already today** are
not checked against `MAX_PARTICIPANTS` at the moment they're queued
(`src/ws.rs`, the `lobby_enabled` branch in `JoinRoom`, lines 334-388) — only
against the separate `MAX_PENDING` (10, a generous, independent waiting-queue
limit). The check against the participant ceiling only happens at the moment
of `approve` (`src/ws.rs:621-646`) — if by that point the room has run out of
room (including because the leader LOWERED the limit while the request was
pending), `approve` today already responds to both the person waiting
(`RoomFull`) and the leader (`error: room is full, cannot approve`) without
breaking any invariant. The only change is that this code must compare
against `effective_max_participants()` rather than against the constant
directly (see
[§2.2](#22-what-to-do-if-current-participants-already-exceed-the-new-limit));
pending requests themselves don't "expire" or get auto-declined when the
limit changes — the leader still decides on each one by hand as before,
except now `approve` will reject some of them.

### 2.5 Protocol Changes and Scope of Work

All changes are additive (a new `Option` field with `#[serde(default)]`; old
clients simply won't send it — it's interpreted as `None`/"no own limit,"
i.e. they behave exactly as they do today):

| File | Change | Estimate |
|---|---|---|
| `src/protocol.rs` | `max_participants: Option<usize>` field in `RoomSettings` | 0.5h |
| `src/state.rs` | `Room::effective_max_participants()` | 0.5h |
| `src/ws.rs` | Validation in `handle_update_settings`; replace the constant check with the effective limit in `JoinRoom` (:390) and `handle_approve` (:638) | 1.5h |
| `static/room.html` | `<select>` in the settings panel next to the existing toggles | 0.5h |
| `static/room.js` | `wireSettingSelect`, update `syncSettingsPanelInputs`, **fix the `settings-changed` handler** (see [§2.3](#23-ui)), populate the select's options from `joined.maxParticipants` | 1.5–2h |
| `docs/permissions-and-leader.md`, `docs/signaling-protocol.md` | Document the new field and the "blocks newcomers, doesn't remove existing participants" rule | 1h |
| Tests (Rust unit/integration + manual UI verification) | Boundary validation (1, 2, N, N+1, server ceiling+1), "a limit below current occupancy doesn't remove anyone," leader changes the limit mid-call → guests' counter updates | 2–2.5h |

**Roughly 7.5–9 hours total** — a modest, fully additive feature with no
migration cost (room memory doesn't survive a restart anyway, and no old
serialized form of `RoomSettings` exists anywhere on disk).

## 3. Security/Privacy

- **Server-side truth, same as membership** (`permissions-and-leader.md` §1):
  yes, and this isn't a new compromise. The server is already today the sole
  source of truth both for `room-full` relative to the server ceiling and for
  who the leader is, who's a participant, and who's in the waiting room. The
  leader's limit simply adds one more number that the server applies through
  exactly the same code path (`join-room`/`approve`) that already applies
  `crate::MAX_PARTICIPANTS`. If one considers "the server could ignore the
  leader's limit" a compromise, then by the same reasoning the server "could
  ignore" literally any of its own checks (including today's `room-full`) —
  that's a tautology about a trusted server, not a new vulnerability: the
  project's self-hosting model (see `docs/self-hosting.md`) already assumes
  that the server operator is **trusted by definition** (they see SDP/ICE
  before TLS-level transport encryption, etc.). No additional trust is
  required here beyond what participants already extend today.
- **The E2E model is unaffected**: confirmed in the code — `RoomSettings` as
  a whole travels as plaintext JSON, and already does today
  (`guestChat`/`guestAudio`/... in `settings-changed`/`joined` — none of them
  are encrypted, unlike `name`, which under E2E v1/v2 is encrypted separately
  via `name-announce`, see the `src/protocol.rs` module comment and
  `docs/e2e-encryption.md`). The participant count isn't a secret today
  either (`Joined::max_participants` is already delivered in the clear,
  `src/protocol.rs:178-185`); adding one more plaintext number alongside it
  changes nothing in the encryption threat model.
- **The DoS angle — there is a real, not entirely obvious effect here, and it
  doesn't favor the feature**: the limit **worsens**, rather than eases, the
  "an attacker with the link occupies slots ahead of legitimate guests"
  attack. With a server ceiling of 6, an attacker needs 6 parasitic
  connections to fill the room for everyone; with a leader limit of 2 (the
  flagship scenario from §1 — "1-on-1, that can't be broken into"), just
  **one** parasitic connection is enough to fill the room against the second
  legitimate participant — meaning the smaller the configured limit, the
  **cheaper** a denial-of-service attack becomes for anyone who knows (or
  guessed/glimpsed over someone's shoulder) the link. The waiting room
  (`lobbyEnabled`) is already today the only real answer to this vector (it
  prevents a slot from being taken without a leader decision at all,
  regardless of the number of slots); the limit neither strengthens nor
  replaces it. Practical conclusion for UI/documentation: **if a leader sets
  a small `maxParticipants` for the sake of 1-on-1 privacy, they should be
  explicitly advised to also enable the waiting room** — otherwise a small
  limit without the waiting room makes the room *more* vulnerable to capture
  of its one and only slot than a room with no limit at all (which simply
  has more "spare" slots). This should be stated explicitly in the UI (a
  tooltip/hint next to the select) and in `docs/security.md` (section
  H2/M3), not only in this file.

## 4. Interaction With Other Features

- **Leader succession**: the limit is part of `Room::settings`, and is in no
  way tied to `Room::leader_id` — it survives leader succession
  automatically, without a single line of special-case code (`cleanup_peer`,
  `src/ws.rs:930-1017`, doesn't touch `room.settings` at all).
- **Reconnects are the one genuinely subtle point, and it's exactly the one
  that hits the flagship 1-on-1 scenario.** A client's `peer_id` is accepted
  again on `join-room` only if it's **not already occupied** in either
  `participants` or `pending` for that room (`src/ws.rs:308-315`, the comment
  explicitly documents this). A WS-signaling drop isn't detected instantly
  by the server — the heartbeat (`PING_INTERVAL=20s` + `MAX_MISSED_PONGS=2`,
  `src/ws.rs:98-102`) gives a window of up to ~40-60 seconds during which the
  "stale" old participant record **still occupies a slot** in
  `room.participants`, even though the socket is already dead. The
  front-end's auto-reconnect (`static/room.js`, `RECONNECT_BACKOFF_MS`) tries
  to reconnect within 1-8 seconds — that is, **faster** than the server
  manages to evict the stale old record. Today, with the default of 6
  participants, this almost never surfaces (one extra "zombie" slot against
  5 free ones isn't a problem). But precisely in the flagship **1-on-1 with
  `maxParticipants=2`** scenario, this becomes a real problem: if participant
  A loses signaling for a second (not media — the mesh survives a signaling
  drop, see `docs/self-hosting.md`, "Surviving a Restart/Redeploy") and the
  client tries to reconnect while its old record hasn't yet been cleaned up
  by the reaper/heartbeat, the room is formally already "full" (zombie-A +
  live B = 2/2), and a new `join-room` from A will get **`room-full`** — from
  that very same person. The reconnect logic in this same code already tries
  to pass the previous `peer_id` for exactly this kind of case (comment at
  `src/ws.rs:308-315`), but the slot-occupancy check is still based on the
  number of *records*, not the number of unique people — with a small limit,
  this discrepancy becomes noticeable in practice. **Recommendation**: if the
  feature is implemented, separately test reconnects specifically in a room
  with `maxParticipants=2` and, possibly, either (a) document this as a known
  limitation, or (b) consider a more aggressive heartbeat for small rooms, or
  (c) a special reconnect path that explicitly terminates the old record on a
  matching `peer_id, room_id` before the heartbeat times out — this is a
  nontrivial change with concurrency implications (two sockets temporarily
  claiming the same `peer_id`) and is **not included** in the §2.5 estimate —
  if you decide to build the limit, budget for a separate investigation into
  this.
- **Waiting room / `MAX_PENDING`**: fully independent limits already exist
  today (see
  [§2.4](#24-what-happens-to-pending-waiting-room-requests-when-the-limit-is-lowered))
  — `MAX_PENDING=10` bounds the waiting queue itself and has no tie to
  `maxParticipants`/`MAX_PARTICIPANTS`. No changes are needed to this
  mechanism, other than that the `approve`-time comparison must use the
  room's effective limit rather than the constant.
- **Room recovery after a server restart (`PUT /api/rooms/{id}`)**: verified
  — `restore_room` (`src/main.rs:425-475`), when no record exists, creates a
  `Room` with `settings: RoomSettings::default()` (`src/main.rs:459`) —
  **this is already true today for ALL `RoomSettings` fields, not just the
  future `max_participants`**: `lobbyEnabled`, `guestChat`, and the other
  settings the leader configured before the restart **do not survive the
  restart at all** — a recovered room always starts from a clean default,
  regardless of what was configured before. This isn't a new problem
  introduced by the limit but existing, documented behavior (in-memory
  state, `docs/self-hosting.md` §7.1) — `max_participants` simply inherits it
  on equal footing with the other fields, requiring no additional code for
  this case, but it's worth explicitly mentioning in the documentation next
  to the field's description, so as not to create a false expectation that
  "the limit will survive a restart, unlike everything else in this project
  which doesn't."
- **`maxParticipants` in the counter UI**: today `Joined::max_participants`
  (`src/protocol.rs:178-185`) is already meant as "show `N / <this value>`,"
  not a hardcoded `/6` — the natural extension is for the same field to
  start carrying not the server ceiling but the room's *effective* limit
  (which, before this feature, always coincided with the server ceiling) —
  no renaming or adding a new wire field is required, just a change to what
  the server puts there (`admit_participant`, `src/ws.rs:542-551`, replacing
  `*crate::MAX_PARTICIPANTS` with `room.effective_max_participants()`). The
  only thing required is not forgetting to keep this in sync with
  `settings-changed` (see [§2.3](#23-ui)) — otherwise already-connected
  participants' counter won't update when the limit changes mid-call.

## 5. Verdict

> Implemented 2026-07-16 (the minimum viable variant from this section:
> the server-side part + a `<select>` in the leader's settings panel).

**Worth doing, but not as a priority.** The value is real and doesn't
duplicate the waiting room — the combination "small limit + no waiting room"
covers a specific, frequently requested video-call use case ("a call for
just the two of us, no manual approval"), which today has no way to be
expressed at all, other than asking an uninvited guest to leave by voice
after they've already joined. But:

- The implementation is **cheap** (7.5-9h, fully additive, no migrations) —
  a strong argument for doing it when the time comes, rather than deferring
  it indefinitely.
- It **exposes** a previously minor reconnect-behavior defect (a zombie slot
  caused by heartbeat delay) precisely in the most valuable use case
  (1-on-1) — this isn't a blocker, but it requires separate attention during
  implementation, not just "add a field and validation."
- It creates a **new framing of DoS risk** ("a small limit without the
  waiting room makes it easier to capture the one and only slot"), which
  needs to be explicitly communicated to the user in the UI and documented
  in `security.md`, rather than silently left unaddressed.

**Minimum viable variant**, if building it now: just the server-side part +
a `<select>` in the settings panel (without a separate DoS-risk hint and
without a dedicated fix for the reconnect problem) covers 80% of the value
for a smaller share of the estimate — but then it's **mandatory** to
accompany it with documentation (and, possibly, a UI tooltip) explicitly
stating "a small limit by itself doesn't protect against slot capture — use
it together with the Waiting Room," so as not to create a false sense of
privacy for users in a place where only the waiting room provides real
protection.

**Timing**: it makes sense to build this after the project gains some form
of `kick`/`ban` mechanism (if that's on the roadmap at all) — because at
that point the "limit below current occupancy" question would also
naturally resolve itself (the leader could be offered the option to
explicitly shrink the roster, rather than only blocking future arrivals),
with no separate workaround needed. If no such feature is planned, then
`maxParticipants` can be built right now as a standalone, independent
feature.
