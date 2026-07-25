# PRD — Chat (Private Video Meetings)

<!-- toc -->

- [1. Overview](#1-overview)
  - [1.1 Purpose](#11-purpose)
  - [1.2 Background / Problem Statement](#12-background--problem-statement)
  - [1.3 Goals (Business Outcomes)](#13-goals-business-outcomes)
  - [1.4 Glossary](#14-glossary)
- [2. Actors](#2-actors)
  - [2.1 Human Actors](#21-human-actors)
  - [2.2 System Actors](#22-system-actors)
- [3. Operational Concept & Workflow](#3-operational-concept--workflow)
- [4. Scope](#4-scope)
  - [4.1 In Scope](#41-in-scope)
  - [4.2 Out of Scope](#42-out-of-scope)
- [5. Functional Requirements](#5-functional-requirements)
  - [5.1 Meeting Creation & Joining](#51-meeting-creation--joining)
  - [5.2 Live Media](#52-live-media)
  - [5.3 Chat](#53-chat)
  - [5.4 Moderation & Access Control](#54-moderation--access-control)
  - [5.5 Anonymity](#55-anonymity)
- [6. Non-Functional Requirements](#6-non-functional-requirements)
  - [6.1 NFR Inclusions](#61-nfr-inclusions)
  - [6.2 NFR Exclusions](#62-nfr-exclusions)
- [7. Use Cases](#7-use-cases)
  - [UC-001 Quick Call From a Shared Link](#uc-001-quick-call-from-a-shared-link)
  - [UC-002 Screen Presentation](#uc-002-screen-presentation)
  - [UC-003 Moderated Room With a Waiting Room](#uc-003-moderated-room-with-a-waiting-room)
  - [UC-004 File Exchange During a Call](#uc-004-file-exchange-during-a-call)
- [8. Acceptance Criteria](#8-acceptance-criteria)
- [9. Assumptions](#9-assumptions)
- [10. Out of Scope (All Versions)](#10-out-of-scope-all-versions)

<!-- /toc -->

> **Companion document.** This PRD defines *what* the product does and for
> whom, in business language only. For *how* it is built — architecture,
> protocols, encryption, deployment — see [`DESIGN.md`](DESIGN.md) and the
> technical documents it links to.

## 1. Overview

### 1.1 Purpose

Chat is a browser-based meeting product for small, spontaneous video calls:
one participant creates a meeting and shares a link; everyone who opens that
link joins the same room with video, audio, screen sharing, and text chat —
no account, no install, no recording. The product's defining promise is that
the operator running the service cannot see or store what happens in a
meeting, and that nothing about a meeting survives after it ends.

### 1.2 Background / Problem Statement

Mainstream meeting products require an account, install a client, or default
to storing chat history and metadata on a server the user does not control.
For quick, informal calls — a pair debugging session, a small team huddle, a
family video chat — that overhead and that exposure are both unwarranted.
People want to click one button, share one link, talk, and have the meeting
leave no trace once it is over.

**Target Users**:

- Anyone who wants to start an ad-hoc video call in seconds, without asking
  participants to sign up or install anything
- Small groups (up to a handful of people) who value not having their
  conversation, files, or presence logged anywhere
- A meeting organizer who occasionally needs to control who gets in (a
  waiting room) and what guests are allowed to do

**Key Problems Solved**:

- Starting a call requires no registration, no account, and no prior
  relationship between participants beyond a shared link
- Meeting content (video, audio, chat, files) is not observable or storable
  by the service operator
- Nothing about who attended, what was said, or what was shared remains
  discoverable after the meeting ends

### 1.3 Goals (Business Outcomes)

**Success Criteria**:

- A new meeting can be created and its link shared in a single action, with
  no form to fill in
- A participant on a phone or a laptop, using an unmodified mainstream
  browser, can join a shared link and be seeing/hearing other participants
  within a few seconds, with no software to install
- After a meeting ends, no operator-accessible record of its content (chat
  messages, file contents, participant names) remains anywhere

**Capabilities**:

- One-click meeting creation with an immediately shareable link and QR code
- Live video, audio, and screen sharing among all participants, each
  independently mutable
- Text chat with reactions, replies, editing, deletion, and file/image/audio
  sharing
- A meeting organizer role that can restrict guest capabilities and gate
  entry through a waiting room
- Full anonymity: no account, no persisted name, no history retained between
  visits

### 1.4 Glossary

| Term | Definition |
|------|------------|
| Meeting (Room) | A single video call identified by a shareable link; exists from creation until everyone leaves and a short grace period elapses, or until it hits its maximum duration |
| Host / Leader | The one participant per meeting with moderation authority: change guest permissions, run the waiting room |
| Guest | Any participant who is not the current leader |
| Waiting Room | An optional holding area a guest is placed in on arrival until the leader admits or declines them |
| Meeting Link | The URL that grants access to a meeting; possessing it is the only "credential" needed to join |
| Anonymity | No account, no persisted identifier, and no login is ever required or offered; a display name is entered fresh each time a participant joins |
| Ephemerality | The property that a meeting's data (participants, chat, files, name) does not outlive the meeting itself, and is never written to durable storage |

## 2. Actors

### 2.1 Human Actors

#### Meeting Creator / Leader

**ID**: `cpt-chat-actor-leader`

**Role**: Starts a meeting, receives its shareable link, and — by presenting
that link's one-time credential on arrival — becomes the meeting's leader.
Can change guest permissions and moderate the waiting room for the lifetime
of the meeting or until leadership passes to someone else.

**Needs**: A single action to start a meeting; confidence that the link is
the only thing needed to invite others; the ability to keep unwanted people
out and to restrict what guests can do, without any setup step.

#### Guest

**ID**: `cpt-chat-actor-guest`

**Role**: Opens a shared meeting link, enters a display name, and
participates with video, audio, chat, and (if allowed) screen sharing and
file exchange. May become the new leader automatically if the leader leaves.

**Needs**: To join instantly from a link on any device without installing
anything; confidence that their presence and words are not being recorded
anywhere beyond the call itself.

### 2.2 System Actors

#### Signaling Service

**ID**: `cpt-chat-actor-signaling-service`

**Role**: The always-on service that lets participants find each other,
establishes membership and roles for a meeting, and carries the small amount
of coordination traffic (who's in the room, who's presenting, moderation
decisions) needed to set up direct connections between participants. It does
not carry — and is designed so it cannot make sense of — the actual video,
audio, or chat content.

**Needs**: To operate without persistent storage; to enforce meeting size,
duration, and abuse limits without needing to inspect content.

#### Relay Service (Fallback Path)

**ID**: `cpt-chat-actor-relay-service`

**Role**: An optional network helper used only when two participants' devices
cannot reach each other directly (e.g., restrictive networks). It forwards
encrypted media between them without being able to read it.

**Needs**: To be invoked only when direct connection fails, and to hold no
long-lived credentials.

## 3. Operational Concept & Workflow

A typical meeting follows five steps:

```
Step 1 ─ Create      →   Step 2 ─ Share   →   Step 3 ─ Join      →   Step 4 ─ Meet    →   Step 5 ─ End
(one click, then a        (link / QR)          (preview + name)      (video/audio/        (leave / limit
 name/preview screen)                                                 screen/chat)          reached)
```

**Step 1 — Create**: The meeting creator opens the product and creates a
meeting with a single click. No form, no title, no settings are required up
front. The meeting is created empty and the creator is taken straight into
it, where one screen lets them preview their own camera/microphone, give the
meeting a name (pre-filled with a friendly generated suggestion), and choose
a display name — starting the meeting from there makes them its leader
automatically.

**Step 2 — Share**: The creator shares the meeting's link (copy/paste, or a
QR code shown in-app for scanning on another device) with the people they
want to invite; this sharing view opens on its own the first time the
creator starts a meeting, so sharing is the obvious next action rather than
something they have to go looking for. No separate invitation flow, email,
or calendar integration exists or is needed.

**Step 3 — Join**: Anyone who opens the link lands on that same kind of
screen — a live preview of their own camera/microphone (already on, granted
through a single permission prompt), the meeting's name and a sense of who's
already there, and a display name field pre-filled with a friendly generated
suggestion, which they may keep, edit, or clear — before joining. If the
leader has turned on the waiting room, the new arrival instead waits, still
seeing their own live preview, until the leader admits or declines them.

**Step 4 — Meet**: All participants see and hear each other. Any participant
can mute/unmute their own audio or video at will. Any participant (subject to
the leader's permission settings) can share their screen — only one
participant's screen is shown at a time. Any participant can use text chat:
send messages, react, reply, edit or delete their own messages, and share
files, images, or audio clips. The leader can adjust who is allowed to do
what, and can moderate the waiting room, at any point during the meeting.

**Step 5 — End**: The meeting ends when everyone leaves (after a short grace
period, in case the last remaining tab reloads) or when the meeting hits its
maximum allowed duration, whichever comes first. Once ended, nothing about
its content is retained anywhere.

## 4. Scope

### 4.1 In Scope

- Meetings of up to a small, fixed number of simultaneous participants
- A per-meeting maximum duration (on the order of a few hours), after which
  the meeting ends automatically for everyone
- Instant meeting creation with a shareable link and an in-app QR code
- Live video and audio for every participant, each independently mutable
- Screen sharing, restricted to one presenter at a time, available to any
  participant unless the leader restricts it
- A persistent-for-the-meeting text chat with reactions, replies, editing,
  deletion, and file/image/audio attachments
- A leader role with the ability to restrict guest capabilities (chat,
  audio, video, screen sharing) and to run an optional waiting room
- No accounts, no registration, no login of any kind
- No recording of the meeting by the product
- No server-side history: nothing about a meeting's participants or content
  is discoverable once the meeting has ended
- Usable from a mobile browser as well as a desktop browser, without
  installing an app

### 4.2 Out of Scope

See [§10](#10-out-of-scope-all-versions) for the consolidated list.

## 5. Functional Requirements

### 5.1 Meeting Creation & Joining

#### One-Click Meeting Creation

- [x] `p1` - **ID**: `cpt-chat-fr-create-meeting`

Any visitor MUST be able to create a new, empty meeting with a single action
and no form fields. The product MUST immediately produce a shareable link
for that meeting and take the creator into it. The creator MUST automatically
receive the leader role for that meeting (see
`cpt-chat-fr-leader-role`) as long as they are the first to actually enter it.

**Rationale**: Removing every step between "I want to start a call" and
"I'm in a call with a link to share" is the core value proposition.

**Actors**: `cpt-chat-actor-leader`

#### Shareable Link & QR Code

- [x] `p1` - **ID**: `cpt-chat-fr-share-link`

The product MUST let the creator share the meeting via a copyable link and
via a QR code rendered for scanning, so a second device can join without
retyping anything. Generating and displaying the QR code MUST NOT require
any additional round trip to the signaling service beyond what joining
already requires — see `cpt-chat-nfr-privacy` for why.

**Rationale**: A link is the only artifact that should be needed to invite
someone; a QR code covers the common case of inviting a nearby device.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

#### Join by Link, With a Live Preview

- [x] `p1` - **ID**: `cpt-chat-fr-join-meeting`

Anyone opening a meeting link MUST be shown a live preview of their own
camera and microphone before joining, and MUST be asked for nothing beyond
that but a display name (pre-filled with a locally generated suggestion,
freely editable, not validated against any identity). No account,
credential, or other identifying information MUST be required. If the
meeting has already reached its participant limit, the arrival MUST be told
the meeting is full rather than silently failing — surfaced as early as
possible, ideally before they even reach the preview.

**Rationale**: The link itself is the only credential; a display name is a
courtesy to other participants, not an identity claim. Letting someone see
and adjust their own camera/microphone before they are visible to anyone
else removes the awkwardness of arriving unprepared.

**Actors**: `cpt-chat-actor-guest`

### 5.2 Live Media

#### Independent Audio/Video Mute

- [x] `p1` - **ID**: `cpt-chat-fr-av-mute`

Every participant MUST be able to turn their own microphone and camera on
and off independently, at any time, with effect visible to other
participants immediately (no perceptible negotiation delay).

**Rationale**: Instant, no-friction mute/unmute is table stakes for a video
call product and directly affects how comfortable people feel joining
without preparation.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

#### Screen Sharing, One Presenter at a Time

- [x] `p1` - **ID**: `cpt-chat-fr-screen-share`

Any participant MUST be able to start sharing their screen, unless the
leader has restricted the capability for guests (see
`cpt-chat-fr-guest-permissions`). Only one participant's screen MUST be
shown at any given moment; an attempt to share while someone else is already
presenting MUST be rejected with a clear reason, and the screen MUST become
available again as soon as the current presenter stops or leaves.

**Rationale**: A single shared "stage" avoids confusing overlapping
presentations and matches how small-group screen sharing is actually used.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

### 5.3 Chat

#### Text Chat With Rich Interactions

- [x] `p1` - **ID**: `cpt-chat-fr-chat`

The product MUST provide a persistent-for-the-meeting text chat panel
supporting: plain text messages with a small set of text styling
conventions (bold/italic/strikethrough/quote), emoji reactions on any
message, replies that reference and quote an earlier message, and editing or
deleting one's own messages (with a visible marker that a message was edited,
and a placeholder where a message was deleted). A participant who joins
after messages were already exchanged MUST still be able to see the recent
history of the conversation, provided at least one other participant remains
to supply it.

**Rationale**: Chat is a first-class channel alongside video/audio for a
small-group call, and the interactions listed are what users expect from any
modern chat surface.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

#### File, Image & Audio Sharing

- [x] `p1` - **ID**: `cpt-chat-fr-file-share`

Participants MUST be able to attach and send files, images, and audio clips
through chat, up to a defined size ceiling per file. Every attachment,
regardless of type or size, MUST require an explicit download action from
the recipient — nothing is fetched over the wire on their behalf until they
ask for it. A recipient who cannot reach the sender directly MUST see the
attachment marked as unavailable rather than have the product silently
proxy the file's bytes through the service operator's infrastructure (see
`cpt-chat-nfr-privacy`).

**Rationale**: Sharing a screenshot, a small document, or a voice note is a
routine need in ad-hoc calls; the product's privacy promise requires that
these bytes never become visible to the operator, even as a fallback.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

### 5.4 Moderation & Access Control

#### Leader Role and Succession

- [x] `p1` - **ID**: `cpt-chat-fr-leader-role`

Every meeting MUST have exactly one leader at any time once at least one
participant has joined. If the leader leaves, the product MUST automatically
assign leadership to another participant (deterministically, without
requiring any vote or manual action) so the meeting is never left without a
leader while people remain in it.

**Rationale**: Someone must be able to moderate a meeting, but requiring an
election or a manual hand-off would add friction to what is meant to be an
instant, no-setup product.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

#### Guest Permission Controls

- [x] `p1` - **ID**: `cpt-chat-fr-guest-permissions`

The leader MUST be able to independently allow or restrict, for all guests
at once: chat, microphone use, camera use, and screen sharing. A change MUST
take effect for guests currently in the meeting, not only for future
arrivals; if a guest is presenting their screen when sharing is restricted,
the product MUST end that share automatically.

**Rationale**: A leader hosting a larger or less trusted group needs a
lightweight way to keep a meeting orderly without ejecting people.

**Actors**: `cpt-chat-actor-leader`

#### Waiting Room

- [x] `p1` - **ID**: `cpt-chat-fr-waiting-room`

The leader MUST be able to turn on a waiting room for the meeting. While it
is on, anyone arriving (other than the leader) MUST be held in a pending
state and MUST NOT be able to see or affect the meeting until the leader
explicitly admits or declines them. The leader MUST see who is waiting and
be able to act on each request individually.

**Rationale**: Some meetings need a gate — the leader deciding, one by one,
who is let in — without turning the product into an account-based system.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

### 5.5 Anonymity

#### No Accounts, No Persisted Identity

- [x] `p1` - **ID**: `cpt-chat-fr-anonymity`

The product MUST NOT offer or require account creation, login, or any
persisted identifier across visits. A participant's display name MUST be
entered fresh at the start of each visit and MUST NOT be remembered by the
product between sessions.

**Rationale**: Anonymity by default is central to the product's trust
proposition — there is no account to compromise and no identity to
correlate across meetings.

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

## 6. Non-Functional Requirements

### 6.1 NFR Inclusions

#### Privacy by Construction

- [x] `p1` - **ID**: `cpt-chat-nfr-privacy`

The service operator MUST NOT be able to observe the content of a meeting —
what is said, shown, typed, or shared — as a normal consequence of running
the service, not merely as a policy promise. This applies to video, audio,
chat text, reactions, file contents, and display names alike.

**Threshold**: Zero content fields readable by the operator in the normal
operation of the service (see `docs/e2e-encryption.md` and `docs/privacy.md`
for exactly what this covers and its edges).

**Rationale**: This is the product's core differentiator versus mainstream
meeting tools, and it must hold structurally, not by policy.

#### Ephemerality

- [x] `p1` - **ID**: `cpt-chat-nfr-ephemerality`

Once a meeting ends, no record of its participants, chat content, or shared
files MUST remain retrievable anywhere in the service. A meeting MUST also
have a hard maximum duration, after which it ends automatically regardless
of whether people are still using it.

**Threshold**: Meeting duration capped at a bounded number of hours (product
default: three); zero durable records survive a meeting ending or the
service restarting.

**Rationale**: "Nothing is stored" must be true even in the failure case of
a service restart, not only in the happy path of an orderly end of meeting.

#### No Installation Required

- [x] `p1` - **ID**: `cpt-chat-nfr-no-install`

A participant MUST be able to join and fully use a meeting (video, audio,
chat) from an unmodified, mainstream desktop or mobile browser, without
installing any application, extension, or plugin.

**Threshold**: Joining a meeting requires opening a link and nothing else.

**Rationale**: Removing install friction is what makes "click a link, be in
the call" possible.

#### Mobile Support

- [x] `p1` - **ID**: `cpt-chat-nfr-mobile`

The product MUST be usable on mobile browsers for joining, viewing, audio,
video, and chat. Where a mobile platform's browser does not support a
capability (for example, screen sharing on some mobile browsers), the
product MUST degrade gracefully by hiding that capability rather than
offering a control that fails.

**Threshold**: Core call participation (join, see/hear others, mute,
chat) works on mainstream mobile browsers.

**Rationale**: Ad-hoc calls are frequently joined from a phone; the product
must not assume a desktop.

### 6.2 NFR Exclusions

- **Large meetings**: Not addressed — see [§10](#10-out-of-scope-all-versions)
  for the participant ceiling.
- **Accessibility**: Not a defined requirement for the initial release.
- **Internationalization**: Not a defined requirement for the initial
  release.
- **Compliance / regulated data handling**: Not applicable — the product is
  designed to hold no content or personal data after a meeting ends, which
  is the intended mitigation rather than a compliance program.

## 7. Use Cases

### UC-001 Quick Call From a Shared Link

**ID**: `cpt-chat-usecase-quick-call`

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

**Preconditions**: None — no account, no prior setup.

**Main Flow**:

1. Creator opens the product and creates a meeting with one click
2. Creator is taken straight into the (still empty) meeting, previews their
   own camera/microphone, optionally renames the meeting, and starts it,
   becoming its leader
3. Creator copies the meeting link and sends it to a guest by whatever
   channel they prefer (chat app, email, verbally)
4. Guest opens the link, previews their own camera/microphone, enters a
   display name, and joins
5. Both participants see and hear each other; either can mute/unmute at will

**Postconditions**: A live call is in progress with no account or
registration having occurred for either party.

**Alternative Flows**:

- **Meeting full**: A guest arriving after the participant ceiling is
  reached is told the meeting is full instead of being let in.

### UC-002 Screen Presentation

**ID**: `cpt-chat-usecase-screen-share`

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

**Preconditions**: A meeting is in progress with at least two participants;
screen sharing is not restricted for the presenter's role.

**Main Flow**:

1. A participant starts sharing their screen
2. All other participants see the shared screen full-size
3. The presenter stops sharing when done, and the screen becomes available
   to anyone else

**Postconditions**: The meeting continues with everyone back on their
camera view.

**Alternative Flows**:

- **Someone else is already presenting**: The request to share is granted
  anyway and takes over — the previous presenter's share stops automatically
  the moment the new one starts, with no separate warning to either party
  (see [`permissions-and-leader.md` §7.1](permissions-and-leader.md#71-screen-sharing--server-enforced)).
- **Guest screen sharing is restricted**: A guest's request is declined
  regardless of whether the screen is currently free.

### UC-003 Moderated Room With a Waiting Room

**ID**: `cpt-chat-usecase-moderated-room`

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

**Preconditions**: A meeting exists; the leader has turned on the waiting
room.

**Main Flow**:

1. A guest opens the meeting link and is placed in the waiting room instead
   of joining directly
2. The leader sees the pending request (with the guest's chosen display
   name) and admits them
3. The guest is now a full participant with video, audio, and chat
4. Later, the leader restricts guest chat; guests currently in the meeting
   immediately lose the ability to send chat messages

**Postconditions**: Only leader-approved participants are in the meeting;
guest capabilities reflect the leader's current settings at all times.

**Alternative Flows**:

- **Leader declines**: The waiting guest is told they were not admitted and
  is disconnected.
- **Guest gives up waiting**: If the guest leaves before a decision, the
  leader's pending list updates to reflect the withdrawal.

### UC-004 File Exchange During a Call

**ID**: `cpt-chat-usecase-file-exchange`

**Actors**: `cpt-chat-actor-leader`, `cpt-chat-actor-guest`

**Preconditions**: A meeting is in progress; guest chat (and therefore file
sharing) is not restricted.

**Main Flow**:

1. A participant attaches a small image to a chat message and sends it
2. Recipients who are directly reachable see a card with the image's name
   and size and a download action; clicking it retrieves and previews the
   image inline
3. A participant attaches a larger document; recipients see the same kind
   of card and use its download action to retrieve the file

**Postconditions**: The file has moved directly between the participants'
devices; the service operator never had access to its bytes.

**Alternative Flows**:

- **Recipient not directly reachable**: That recipient sees the attachment
  marked as unavailable rather than the product falling back to routing the
  file's bytes through the service.

## 8. Acceptance Criteria

- [x] A new meeting can be created and entered in one action, with a
  shareable link and an in-app QR code produced immediately
  (`cpt-chat-fr-create-meeting`, `cpt-chat-fr-share-link`)
- [x] Joining a meeting requires only opening the link, previewing your own
  camera/microphone, and entering a display name — no account or credential
  (`cpt-chat-fr-join-meeting`)
- [x] Every participant can independently mute/unmute audio and video with
  no perceptible delay (`cpt-chat-fr-av-mute`)
- [x] Exactly one participant can share their screen at a time, with a clear
  rejection and automatic hand-off when the presenter stops
  (`cpt-chat-fr-screen-share`)
- [x] Chat supports send, react, reply, edit, and delete, and a participant
  joining mid-meeting can see recent history from a peer
  (`cpt-chat-fr-chat`)
- [x] Files, images, and audio clips can be attached and sent through chat,
  with automatic preview for small images (`cpt-chat-fr-file-share`)
- [x] A meeting always has exactly one leader while it has participants, and
  leadership transfers automatically if the leader leaves
  (`cpt-chat-fr-leader-role`)
- [x] The leader can restrict guest chat/audio/video/screen sharing, with
  restrictions applying immediately to current participants
  (`cpt-chat-fr-guest-permissions`)
- [x] The leader can enable a waiting room and individually admit or decline
  each arrival (`cpt-chat-fr-waiting-room`)
- [x] No account, login, or persisted identity is ever required
  (`cpt-chat-fr-anonymity`)
- [x] A meeting ends automatically after its maximum duration, and no
  content or participant record is retrievable after a meeting ends
  (`cpt-chat-nfr-ephemerality`)
- [x] Joining and using the product requires no installation on desktop or
  mobile (`cpt-chat-nfr-no-install`, `cpt-chat-nfr-mobile`)

## 9. Assumptions

- Participants are using a modern, mainstream browser on desktop or mobile
  that supports real-time video/audio calling and encrypted peer-to-peer
  data exchange
- The meeting link is treated by users as a shared secret — anyone who has
  it can join (subject to the waiting room, if enabled)
- Group sizes stay within a small ceiling suited to a mesh of direct
  connections rather than a broadcast-style, large-audience event
- Participants have a reasonably capable network connection for real-time
  video; where direct connection between two participants is not possible,
  a relay path exists as a fallback

## 10. Out of Scope (All Versions)

- Meetings above a small, fixed participant ceiling, or any broadcast-style
  "many viewers, few presenters" format
- Recording of meetings, in any form, by the product
- User accounts, login, contact lists, or any persisted identity across
  visits
- Server-side chat or meeting history of any kind
- Scheduling, calendar integration, or invitations sent by the product
  itself (only a link/QR code the creator shares themselves)
- Content moderation beyond the leader's own permission controls and
  waiting room (no automated moderation of what is said or shown)
