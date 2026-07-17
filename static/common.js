// common.js — shared utilities for static/room.js (protocol v2, single-page
// room): ICE configuration retrieval and a wrapper over WebSocket signaling.

'use strict';

// Fallback if /config is unavailable: public STUN only.
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Get the list of ICE servers from the backend (`GET /config`).
 * On any error (network, parsing, empty response) — silent fallback to STUN.
 *
 * S2: we hit `window.API_BASE` (see static/config.js) rather than the
 * same-origin `/config` directly — in a split-origin deployment (see
 * docs/self-hosting.md, "Split Origin (Frontend / Signaling Separated)")
 * the frontend and API live on different hosts (the static origin / a
 * separate API host), and API_BASE is the single place that knows the
 * actual backend address.
 */
async function fetchIceServers() {
  try {
    const res = await fetch(`${window.API_BASE}/config`);
    if (!res.ok) throw new Error(`/config responded with status ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
    return FALLBACK_ICE_SERVERS;
  } catch (err) {
    console.warn('Failed to fetch /config, using default STUN:', err);
    return FALLBACK_ICE_SERVERS;
  }
}

// A single cached TextEncoder for counting UTF-8 bytes of server WS traffic
// (ConnStats.bytesSent/bytesReceived below) — signaling itself is infrequent
// (offer/answer/ice-candidate/join, etc.), so there's no need to recreate a
// TextEncoder for every message, but a single instance for the whole page is
// also cheaper than creating one at every measurement point.
const byteCounterEncoder = new TextEncoder();

/** Size of a string in UTF-8 bytes (as it will actually go out/come in over the WS frame). */
function utf8ByteLength(str) {
  return byteCounterEncoder.encode(str).length;
}

/**
 * Session counters for the "Connection & Privacy" settings section (see
 * static/room.js: refreshConnectionSection) — how many times something
 * actually went THROUGH THE SERVER (rather than over the P2P bus), and how
 * many bytes of traffic that amounted to. A shared top-level object of the
 * classic script (see RoomCrypto in static/crypto.js — the same approach),
 * visible both in rtc.js (offer/answer/ice-candidate — these ALWAYS go
 * through signaling, and the bus itself is established the same way), and
 * in room.js (stream-info fallback), and in chat.js (chat fallback). An
 * initial "bootstrap" spike on the peer is unavoidable — this is honestly
 * shown in the counter rather than hidden (see the S1 task).
 *
 * bytesSent/bytesReceived are counted at the SINGLE send/receive points
 * below (Signaling.send()/ws.onmessage) — the same place where the actual
 * byte-on-the-wire fact is measured, rather than at every call site
 * (rtc.js/room.js/chat.js), unlike incSignalingRelay(), which counts
 * SEMANTIC messages and is called from the places that send them. The
 * counters are cumulative FOR THE ENTIRE TAB SESSION and are deliberately
 * NOT reset on auto-reconnect (Signaling.connect() only recreates
 * this.ws, ConnStats is a shared top-level object, and reconnect doesn't
 * touch it): the user is interested in the total "what leaked through the
 * server", not just since the last disconnect.
 */
const ConnStats = {
  signalingRelayCount: 0, // offer/answer/ice-candidate/stream-info(fallback) — via the server relay
  bytesSent: 0, // UTF-8 bytes actually sent to the socket (see Signaling.send)
  bytesReceived: 0, // UTF-8 bytes actually received from the socket (see ws.onmessage)

  incSignalingRelay() {
    this.signalingRelayCount++;
  },

  addBytesSent(n) {
    this.bytesSent += n;
  },

  addBytesReceived(n) {
    this.bytesReceived += n;
  },
};

/**
 * Wrapper over WebSocket signaling.
 * — opens a connection (ws:// or wss:// depending on the page protocol);
 * — sends/receives JSON messages of the form { type, ...fields };
 * — dispatches incoming messages to subscribers by `type` via `on()`.
 */
class Signaling {
  constructor() {
    this.ws = null;
    this._handlers = new Map();
    // Socket close/error callbacks — assigned from outside (static/room.js).
    this.onClose = null;
    this.onError = null;
  }

  /**
   * Open a WebSocket connection to `/ws`. The promise resolves once opened.
   *
   * S2: the address is derived from `window.API_BASE` (see static/config.js)
   * rather than from `location.host` — in a split-origin deployment the
   * frontend and API are on different hosts, and
   * `API_BASE.replace(/^http/, 'ws')` yields `ws:`/`wss:` depending on
   * whether http or https is specified there (see docs/self-hosting.md,
   * "Split Origin (Frontend / Signaling Separated)").
   */
  connect() {
    // A repeated call (auto-reconnect, see static/room.js) must NOT leave
    // the previous socket hanging: if it actually managed to open and is
    // still alive on the server (e.g. our side simply got tired of waiting
    // for a response and started a new attempt) — the server would keep
    // counting us as a participant under the OLD peerId via the old
    // connection too, and a new join-room with the same peerId would get
    // rejected ("busy") in a case where it should have simply reused it.
    // Always explicitly close the previous socket before opening a new one.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    }

    return new Promise((resolve, reject) => {
      const url = `${window.API_BASE.replace(/^http/, 'ws')}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      // The promise must settle EXACTLY once. Without this flag, a repeated
      // call to connect() (auto-reconnect, see static/room.js) could hang
      // forever: if the socket closes BEFORE opening (the server hasn't come
      // up yet / is already unreachable) and the browser for some reason
      // doesn't send a separate error event — the close event without it
      // wouldn't reject the promise at all, and `await signaling.connect()`
      // would hang indefinitely, stopping the whole reconnect cycle (found
      // empirically in the server-restart e2e scenario, see
      // tests/e2e/resilience.spec.mjs).
      let settled = false;

      // An event from an ALREADY REPLACED socket (not the current this.ws)
      // — ignored entirely. Why: auto-reconnect (see static/room.js) may
      // trigger connect() again before the OLD (already failed/stuck)
      // socket sends ITS OWN close event, delayed by the browser — without
      // this check, such a late event from a long-abandoned socket could
      // land in `this.onClose` AFTER the new socket has already
      // successfully reconnected, mistakenly starting another reconnect
      // cycle on top of an already-working connection (found empirically
      // in the server-restart e2e scenario, see
      // tests/e2e/resilience.spec.mjs).
      const isCurrent = () => this.ws === ws;

      ws.onopen = () => {
        if (!isCurrent()) return;
        settled = true;
        resolve();
      };

      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        // Count bytes BEFORE parsing — this is wire traffic, not
        // successfully recognized messages (see ConnStats.bytesReceived
        // above).
        ConnStats.addBytesReceived(utf8ByteLength(event.data));
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('Malformed JSON from the signaling server:', event.data, err);
          return;
        }
        this._dispatch(msg);
      };

      ws.onerror = (event) => {
        if (!isCurrent()) return;
        console.error('WebSocket connection error:', event);
        if (this.onError) this.onError(event);
        if (!settled) {
          settled = true;
          reject(event);
        }
      };

      ws.onclose = (event) => {
        if (!isCurrent()) return;
        console.log('WebSocket closed: code', event.code, 'reason', event.reason || '(none)');
        if (!settled) {
          // Closed before it managed to open — this is a failure of
          // connect() itself, not the closing of an already-open
          // connection.
          settled = true;
          reject(event);
        }
        if (this.onClose) this.onClose(event);
      };
    });
  }

  /** Subscribe to messages of the given `type`. Multiple handlers per type are allowed. */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
  }

  /** Send a message to the server: `type` in kebab-case, other fields — camelCase. */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Attempted to send a message while the socket is not open:', type, payload);
      return;
    }
    const json = JSON.stringify({ type, ...payload });
    // The same byte count that will actually go into the WS frame (see
    // ConnStats.bytesSent above).
    ConnStats.addBytesSent(utf8ByteLength(json));
    this.ws.send(json);
  }

  _dispatch(msg) {
    if (!msg || typeof msg.type !== 'string') {
      console.warn('Message without a type field ignored:', msg);
      return;
    }
    const handlers = this._handlers.get(msg.type);
    if (!handlers || handlers.length === 0) {
      console.debug('No subscribers for message type', msg.type, msg);
      return;
    }
    for (const handler of handlers) handler(msg);
  }

  /** Close the connection. The caller decides how to treat this closure in the UI. */
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

/**
 * Determining "who is speaking right now" from incoming microphone audio
 * tracks — shared logic for all incoming mic tracks in static/room.js
 * (protocol v2: mesh, every participant can turn on a microphone). No
 * relation to signaling or the mere fact that "the track is alive" — an
 * honest volume analysis via the Web Audio API (AnalyserNode), so it
 * correctly distinguishes `track.enabled = false` (silence) from a
 * genuinely live but silent microphone.
 *
 * Diagnosis (see the investigation history, reproduced with real
 * getDisplayMedia): a screen-share stream can carry a system audio track
 * that arrives at the receiving side BEFORE the first user click on the
 * page. We create a shared AudioContext lazily on the first monitorTrack —
 * it is born suspended. The old version resumed the context ONCE on the
 * first click/keydown and didn't check the result — if the gesture hadn't
 * happened yet when the track arrived, or resume() silently failed, or the
 * context itself crashed in this environment ("The AudioContext
 * encountered an error from the audio device or the WebAudio renderer"),
 * the detector remained mute forever: the "Speaking" indicator never lit
 * up. It was found empirically that a freshly created AudioContext on the
 * same pages hears sound normally (and resume() outside a user gesture
 * sometimes works here too) — meaning it's specifically recreating the
 * context that fixes it, not some analyser setting.
 *
 * Hence the registry of active monitors below and self-healing: click/
 * keydown listeners are not one-shot (they stay attached while the context
 * is suspended), the context itself is tracked via statechange, and on
 * breakage (closed/interrupted or a failed resume) all active monitors are
 * rebuilt on a new AudioContext. Additionally, the level polling watches
 * for suspiciously long silence on a live track — this catches a "silently
 * died" renderer that didn't announce itself via statechange.
 */
const SpeakingDetection = (() => {
  // RMS amplitude threshold above which we consider the source to be
  // speaking. Picked empirically: normal speech through a microphone gives
  // an RMS noticeably higher than background noise/silence.
  const RMS_THRESHOLD = 0.02;
  const POLL_INTERVAL_MS = 200;
  // How many consecutive "dead" (strictly zero) readings on a live, unmuted
  // track we consider grounds to suspect a silently died audio renderer.
  const DEAD_SILENCE_STREAK = 15; // 15 * 200ms = 3s
  // Don't rebuild the context more often than this — otherwise a systemic
  // issue could cause an infinite rebuild loop.
  const REBUILD_COOLDOWN_MS = 10000;

  let audioCtx = null;
  // click/keydown listeners that attempt to resume the current context.
  // We keep references so they can be detached when the context is rebuilt.
  let resumeListenersAttached = false;
  let lastRebuildAt = 0;

  // Active monitors: entry = { track, onChange, speaking, source, analyser,
  // buffer, timer, silentStreak }. Allows rebuilding the Web Audio nodes on
  // a new AudioContext without losing the setInterval loops and the
  // caller's callbacks.
  const activeMonitors = new Set();

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener('click', tryResumeContext);
    document.addEventListener('keydown', tryResumeContext);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener('click', tryResumeContext);
    document.removeEventListener('keydown', tryResumeContext);
    resumeListenersAttached = false;
  }

  function tryResumeContext() {
    if (!audioCtx) return;
    if (audioCtx.state !== 'suspended') {
      // The context is no longer suspended — gesture listeners are no longer needed.
      detachResumeListeners();
      return;
    }
    audioCtx.resume().then(() => {
      console.debug('SpeakingDetection: AudioContext resumed, state =', audioCtx && audioCtx.state);
      if (audioCtx && audioCtx.state === 'running') detachResumeListeners();
    }, (err) => {
      console.warn('SpeakingDetection: failed to resume AudioContext:', err);
    });
  }

  function createAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor();
    console.debug('SpeakingDetection: created a new AudioContext, initial state =', ctx.state);

    ctx.addEventListener('statechange', () => {
      console.debug('SpeakingDetection: AudioContext statechange ->', ctx.state);
      if (ctx !== audioCtx) return; // event from an already-replaced context
      if (ctx.state === 'closed' || ctx.state === 'interrupted') {
        rebuildAudioContext('statechange: ' + ctx.state);
      }
    });

    // Try to resume right away — observations show that in this environment
    // this sometimes works even outside a user gesture.
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => {
        console.warn('SpeakingDetection: resume() right after creation failed:', err);
      });
      attachResumeListeners();
    }

    return ctx;
  }

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = createAudioContext();
    } else if (audioCtx.state === 'suspended') {
      // On every new monitor, give it one more chance — maybe a gesture already happened.
      audioCtx.resume().catch(() => {});
      attachResumeListeners();
    }
    return audioCtx;
  }

  /** Connect the Web Audio nodes (source -> analyser) for one registry entry. */
  function connectMonitorNodes(entry, ctx) {
    entry.source = ctx.createMediaStreamSource(new MediaStream([entry.track]));
    entry.analyser = ctx.createAnalyser();
    entry.analyser.fftSize = 512;
    entry.source.connect(entry.analyser);
    entry.buffer = new Float32Array(entry.analyser.fftSize);
    entry.silentStreak = 0;
  }

  function disconnectMonitorNodes(entry) {
    try {
      if (entry.source) entry.source.disconnect();
    } catch (err) {
      // already disconnected — not a problem
    }
    entry.source = null;
    entry.analyser = null;
  }

  /**
   * Rebuild the AudioContext and all active monitors on it. Called both
   * from the statechange handler and from the polling loop (on suspicion
   * of a silently died renderer). Limited by a cooldown to avoid looping.
   */
  function rebuildAudioContext(reason) {
    const now = Date.now();
    if (now - lastRebuildAt < REBUILD_COOLDOWN_MS) {
      console.debug('SpeakingDetection: context rebuild skipped (cooldown), reason:', reason);
      return;
    }
    lastRebuildAt = now;
    console.warn('SpeakingDetection: rebuilding AudioContext, reason:', reason);

    detachResumeListeners();
    const oldCtx = audioCtx;
    audioCtx = null;

    // Disconnect the nodes on the old context, then close it best-effort.
    for (const entry of activeMonitors) disconnectMonitorNodes(entry);
    if (oldCtx) {
      try {
        oldCtx.close().catch(() => {});
      } catch (err) {
        // the context may already be closed/broken — not a problem
      }
    }

    if (activeMonitors.size === 0) return; // nothing to rebuild

    const newCtx = getAudioContext();
    for (const entry of activeMonitors) {
      connectMonitorNodes(entry, newCtx);
    }
  }

  /**
   * Start monitoring the sound level of one audio track. `onChange(speaking)`
   * is called only when the state changes (not on every reading). Returns a
   * `stop()` function — stops polling and disconnects the Web Audio nodes;
   * if the track was considered "speaking" at the time of stopping,
   * `onChange(false)` will be called before stopping.
   */
  function monitorTrack(track, onChange) {
    const ctx = getAudioContext();

    const entry = {
      track,
      onChange,
      speaking: false,
      source: null,
      analyser: null,
      buffer: null,
      silentStreak: 0,
      timer: null,
    };
    connectMonitorNodes(entry, ctx);
    activeMonitors.add(entry);

    entry.timer = setInterval(() => {
      if (!entry.analyser) return; // between disconnecting and rebuilding the nodes
      entry.analyser.getFloatTimeDomainData(entry.buffer);
      let sumSquares = 0;
      let allZero = true;
      for (let i = 0; i < entry.buffer.length; i++) {
        const v = entry.buffer[i];
        if (v !== 0) allZero = false;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / entry.buffer.length);
      const isSpeaking = rms > RMS_THRESHOLD;
      if (isSpeaking !== entry.speaking) {
        entry.speaking = isSpeaking;
        entry.onChange(entry.speaking);
      }

      // Safety net: a live, unmuted track, but the buffer is strictly zero
      // for many readings in a row while the context is "running" — looks
      // like a silently died audio renderer (statechange didn't fire).
      // Trigger a rebuild.
      if (allZero && entry.track.readyState === 'live' && !entry.track.muted && audioCtx && audioCtx.state === 'running') {
        entry.silentStreak++;
        if (entry.silentStreak >= DEAD_SILENCE_STREAK) {
          entry.silentStreak = 0;
          rebuildAudioContext('suspected silently died audio renderer');
        }
      } else {
        entry.silentStreak = 0;
      }
    }, POLL_INTERVAL_MS);

    return function stop() {
      clearInterval(entry.timer);
      disconnectMonitorNodes(entry);
      activeMonitors.delete(entry);
      if (entry.speaking) entry.onChange(false);
    };
  }

  return { monitorTrack };
})();
