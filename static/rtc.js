// rtc.js — wrapper around RTCPeerConnection implementing the canonical
// perfect negotiation pattern (Jan-Ivar Bruaroey / MDN):
// https://developer.chrome.com/blog/perfect-negotiation/
// https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
//
// Protocol v2: symmetric room, mesh — each other participant gets its own
// RtcPeer. There's no more broadcaster/viewer role: polite/impolite is
// derived deterministically by comparing the peerId of both sides (see
// static/room.js: polite = my peerId > the other peer's peerId, lexicographically)
// — both sides compare the same pair of ids, so exactly one of them gets
// polite=true. Either side may be the first to add a track (getUserMedia for
// microphone/camera, getDisplayMedia for screen sharing) and thereby
// initiate an offer — collisions are resolved by perfect negotiation below.
//
// Flags:
//   - makingOffer — true between the start of onnegotiationneeded and sending
//     the offer;
//   - ignoreOffer — true if the impolite peer decided to ignore the other
//     side's offer due to a collision (see handleDescription);
//   - isSettingRemoteAnswerPending — true during setRemoteDescription(answer)
//     (kept to fully match the reference pattern).
//
// Rolling back the local offer on collision on the polite side is NOT done
// explicitly via setLocalDescription({type:'rollback'}) — modern browsers
// perform an implicit rollback inside setRemoteDescription(offer) if
// signalingState was "have-local-offer".
//
// F0: the room bus (see static/bus.js) on top of RTCDataChannel — a plain
// (NOT negotiated) channel: it is opened ONLY by the impolite side via a
// plain pc.createDataChannel('bus'), the polite side gets its half through
// pc.ondatachannel. A symmetric negotiated channel (both sides create the
// same id=0 right in the constructor) turned out empirically to be fragile
// in this headless Chrome sandbox: when several RTCPeerConnections were
// created on one page almost simultaneously, the browser sometimes never
// called onnegotiationneeded for one of the connections at all (not a bug
// in perfect negotiation — other pairs reliably reached stable/connected,
// while for the broken pair negotiation never started on either side at
// all). With the plain one-sided createDataChannel('bus') the exact same
// chain (createDataChannel -> onnegotiationneeded -> offer) had already been
// repeatedly verified to work reliably in this file for addTrack() (media)
// before F0 — reproducing the same fragility with it did not succeed, so
// the bus uses this already-proven scheme. The only difference from media:
// the channel is created immediately in the constructor (rather than on a
// user click), so the same offer collision that previously only happened
// when video/audio started simultaneously on both sides is now also
// possible from the mere fact of entering the room — perfect negotiation
// below resolves it the same way as usual.
//
// S1 (E2E encryption, see static/crypto.js): offer/answer/ice-candidate
// ALWAYS go through the server signaling relay (this is precisely the
// message that establishes the P2P connection in the first place — by
// definition it cannot travel over a bus that doesn't exist yet), so
// sdp/candidate are unconditionally encrypted, for every such exchange,
// under the PAIRWISE key K_pair_sig of this specific pair of participants
// (E2E v2 — ephemeral ECDH keys + the PSK token `t` from the link, see
// docs/e2e-encryption.md; no longer a single room-wide K_sig) — see
// sigCrypto in the constructor and handleDescription/handleCandidate below.
// The P2P bus itself (DataChannel 'bus') and media tracks are NOT encrypted
// by this layer — WebRTC is required to run them over DTLS, which is
// already full E2E between the two specific peers, and a second application
// layer of encryption for the same pair would add nothing to security.
//
// F3: file DataChannels (see static/chat.js — file transfer protocol).
// Unlike the bus ('bus', one per pair, created once on entry), the file
// channel is created ON DEMAND, a separate one for each pair (fileId,
// recipient), and the initiator can be EITHER side of the pair (whoever
// holds the file — not necessarily the impolite one), so pc.ondatachannel
// must be able to catch the incoming channel REGARDLESS of the
// polite/impolite role — it dispatches on the label prefix ('bus' -> bus,
// 'file-' -> file). Creating an additional DataChannel on an already
// established connection does not require a new SDP negotiation (the SCTP
// association already exists) — onnegotiationneeded normally doesn't fire
// again.
//
// F3 (repeated offer/answer/ice over the bus): the FIRST handshake of a
// pair (when the bus doesn't exist yet — chicken-and-egg, see S1 above) and
// ICE-restart/reconnect ALWAYS go through the server relay with encryption,
// as before. But EVERY SUBSEQUENT renegotiation of the same pair
// (adding/removing a track, switching camera with an actual renegotiation,
// etc.) — once the bus to that peer has already opened — travels directly
// over it: kind: 'rtc-signal', payload {type: 'offer'|'answer'|'ice', data},
// WITHOUT encryption at this layer (the DataChannel already runs over DTLS
// — that already is E2E between these two specific peers, a second
// application layer of encryption for the same pair would add nothing, see
// the reasoning about the P2P bus/media tracks in the S1 comment above).
// sigCrypto remains needed ONLY for the server path.
//
// SUBTLE POINT: the bus itself lives on the same RTCPeerConnection that is
// currently being renegotiated — if THIS renegotiation breaks the pc
// (rare, but possible — ICE fails to re-converge, DTLS drops, etc.), the
// bus will die along with it, and any offer/answer/ice sent over it will
// simply never arrive (there may be no separate failure signal from
// DataChannel.send() in this case — the message either went into the SCTP
// buffer or the channel already closed synchronously, see try/catch below).
// We deliberately don't add any acknowledgments/retries here (the added
// complexity would be disproportionate to the risk) — instead a simple and
// cheap rule is checked IMMEDIATELY before each send: channel is open AND
// pc.connectionState === 'connected' -> bus; otherwise (in particular — the
// entire ICE-restart/reconnect path, where connectionState is definitely
// not 'connected') -> server, same as before. The check and the
// channel.send() itself are synchronous code with no await in between, so
// the race "state changed between the check and the send" is excluded.

'use strict';

class RtcPeer {
  constructor({
    iceServers,
    polite,
    signaling,
    targetPeerId,
    onTrack,
    onStateChange,
    onBusMessage,
    onBusOpen,
    onFileChannel,
    sigCrypto,
    onCryptoFailure,
    certificate,
  }) {
    this.signaling = signaling;
    this.targetPeerId = targetPeerId;
    this.polite = polite;
    this.onBusMessage = onBusMessage || null;
    // S1 (E2E encryption, see static/crypto.js): sdp/candidate travel through
    // the server signaling relay (offer/answer/ice-candidate NEVER travel
    // over the P2P bus — the bus itself is established BY these messages,
    // chicken-and-egg), so they are ALWAYS encrypted, not just optionally.
    // `sigCrypto` — { encrypt(obj) -> Promise<blob>, decrypt(blob) -> Promise<obj> },
    // supplied by the caller (see static/room.js: createRemotePeer) —
    // RtcPeer itself knows nothing about how the room key is derived, it
    // just calls these two functions. `onCryptoFailure` — a callback for
    // when decrypt() fails (see handleDescription/handleCandidate below) —
    // almost always means one of the sides has the wrong room key.
    this.sigCrypto = sigCrypto;
    this.onCryptoFailure = onCryptoFailure || null;
    // F2: a callback for the moment the bus to this peer opens (after
    // flushing the queue) — used to broadcast a snapshot of the current
    // state (see static/room.js: sendAllActiveStreamInfoTo) right over the
    // bus, closing the race "the offer with tracks went out before the bus
    // opened".
    this.onBusOpen = onBusOpen || null;
    // F3: a callback for an incoming file DataChannel (label starts with
    // 'file-') — see createFileChannel below and static/chat.js.
    this.onFileChannel = onFileChannel || null;

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;

    // Candidates that arrive before remoteDescription has been applied —
    // just like in the previous manual implementation, we queue them and
    // flush after setRemoteDescription.
    this.remoteSet = false;
    this.candidateQueue = [];

    // busChannel doesn't appear right away: on the impolite side —
    // synchronously right here (createDataChannel), on the polite side —
    // asynchronously, when pc.ondatachannel fires. sendBus() must be able
    // to queue outgoing messages before that moment too, so busQueue is a
    // queue of JSON STRINGS, not something tied to a specific channel.
    this.busChannel = null;
    this.busQueue = [];

    // SAS (see static/crypto.js: deriveSas): so that a participant has ONE
    // stable DTLS fingerprint across all their connections in the mesh,
    // room.js generates a single RTCCertificate per session and passes it
    // in here — otherwise the browser would generate a new certificate for
    // each RTCPeerConnection, and the "room fingerprint" would not match
    // across different peers.
    const pcConfig = { iceServers };
    if (certificate) pcConfig.certificates = [certificate];
    const pc = new RTCPeerConnection(pcConfig);
    this.pc = pc;

    const setupBusChannel = (channel) => {
      this.busChannel = channel;

      channel.onopen = () => {
        const queue = this.busQueue;
        this.busQueue = [];
        for (const text of queue) {
          try {
            channel.send(text);
          } catch (err) {
            console.error(`[peer ${targetPeerId}] Error sending to bus (queue flush):`, err);
          }
        }
        if (this.onBusOpen) this.onBusOpen();
      };

      channel.onmessage = (event) => {
        let obj;
        try {
          obj = JSON.parse(event.data);
        } catch (err) {
          console.error(`[peer ${targetPeerId}] Invalid JSON on the bus:`, event.data, err);
          return;
        }
        if (this.onBusMessage) this.onBusMessage(obj);
      };

      channel.onerror = (event) => {
        console.error(`[peer ${targetPeerId}] Bus DataChannel error:`, event);
      };
    };

    if (!polite) {
      // impolite creates the channel — the creation itself triggers
      // onnegotiationneeded below (if this pair hasn't had any SCTP
      // negotiation yet).
      setupBusChannel(pc.createDataChannel('bus'));
    }
    // pc.ondatachannel is attached UNCONDITIONALLY on both sides (not just
    // polite): 'bus' — only polite will actually receive it here (impolite
    // created the channel itself, its ondatachannel will never fire for
    // it); an incoming file channel ('file-...', see the file header) can
    // arrive on EITHER side regardless of polite/impolite, so dispatching
    // by label here is shared between both roles.
    pc.ondatachannel = (event) => {
      const { channel } = event;
      if (channel.label === 'bus') {
        setupBusChannel(channel);
      } else if (channel.label.startsWith('file-')) {
        if (this.onFileChannel) this.onFileChannel(channel);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
        // F3: if the bus to this peer is already open and pc is fine -> send
        // the offer directly over it (see the file header); otherwise — the
        // old server path with encryption under this pair's pairwise
        // K_pair_sig (the server only sees the opaque {v,iv,ct} instead of
        // the real SDP and its DTLS fingerprints, see the header of
        // static/crypto.js).
        if (!this._trySendBusSignal('offer', offer)) {
          const encSdp = await this.sigCrypto.encrypt(offer);
          signaling.send('offer', { targetPeerId, sdp: encSdp });
          ConnStats.incSignalingRelay();
        }
      } catch (err) {
        console.error(`[peer ${targetPeerId}] onnegotiationneeded error:`, err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidateJson = event.candidate.toJSON();
      // F3: the same path choice as for offer/answer above — see _trySendBusSignal.
      if (this._trySendBusSignal('ice', candidateJson)) return;
      this.sigCrypto.encrypt(candidateJson).then((encCandidate) => {
        signaling.send('ice-candidate', {
          targetPeerId,
          candidate: encCandidate,
        });
        ConnStats.incSignalingRelay();
      });
    };

    pc.ontrack = (event) => {
      if (onTrack) onTrack(event);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[peer ${targetPeerId}] connectionState -> ${pc.connectionState}`);
      if (onStateChange) onStateChange(pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[peer ${targetPeerId}] iceConnectionState -> ${pc.iceConnectionState}`);
    };
  }

  /**
   * Receiving an SDP description from the remote peer THROUGH THE SERVER
   * RELAY — offer OR answer, distinguished by description.type.
   * `encryptedDescription` — an encrypted blob {v,iv,ct} under this pair's
   * pairwise K_pair_sig (see derivePairKeys in static/crypto.js) — decrypted
   * FIRST, before any other processing; a decryption failure almost always
   * means one of the sides has a wrong/mismatched link token `t`/`e` (see
   * onCryptoFailure). The actual processing (perfect negotiation) is in
   * _applyRemoteDescription, shared with receiving over the bus (see
   * handleBusSignal).
   */
  async handleDescription(encryptedDescription) {
    let description;
    try {
      description = await this.sigCrypto.decrypt(encryptedDescription);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Failed to decrypt SDP (wrong room key?):`, err);
      if (this.onCryptoFailure) this.onCryptoFailure(err);
      return;
    }
    await this._applyRemoteDescription(description);
  }

  /** Receiving an ICE candidate from the remote peer THROUGH THE SERVER RELAY (trickle). `encryptedCandidate` — a blob {v,iv,ct}, decrypted first (see handleDescription regarding onCryptoFailure). */
  async handleCandidate(encryptedCandidate) {
    let candidate;
    try {
      candidate = await this.sigCrypto.decrypt(encryptedCandidate);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Failed to decrypt ICE candidate (wrong room key?):`, err);
      if (this.onCryptoFailure) this.onCryptoFailure(err);
      return;
    }
    await this._applyRemoteCandidate(candidate);
  }

  /**
   * F3: receiving an rtc-signal from the P2P bus (see room.js: bus.onMessage
   * — it already routes by kind and calls this for the corresponding
   * RtcPeer). `payload` — {type: 'offer'|'answer'|'ice', data} — the data is
   * ALREADY in plain form (not encrypted by this layer, see the file
   * header), so it's simply fed into the same
   * _applyRemoteDescription/_applyRemoteCandidate as the server path — all
   * the perfect negotiation/candidate queue logic is not duplicated.
   */
  async handleBusSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'ice') {
      await this._applyRemoteCandidate(payload.data);
    } else {
      await this._applyRemoteDescription(payload.data);
    }
  }

  /** Shared handling of a remote SDP description (offer/answer) — detecting and resolving offer collisions, applying remoteDescription, sending an answer back on offer. Not tied to the transport (server/bus) — see handleDescription/handleBusSignal. */
  async _applyRemoteDescription(description) {
    const pc = this.pc;
    const isOffer = description.type === 'offer';

    const offerCollision =
      isOffer && (this.makingOffer || pc.signalingState !== 'stable');

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      console.warn(
        `[peer ${this.targetPeerId}] Offer collision — impolite peer is ignoring the other side's offer`
      );
      return;
    }

    try {
      this.isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      this.isSettingRemoteAnswerPending = false;
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] setRemoteDescription error:`, err);
      return;
    }

    this.remoteSet = true;
    this._flushCandidateQueue();

    if (isOffer) {
      try {
        await pc.setLocalDescription();
        const answer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
        // F3: the same path choice (bus/server) as for offer/ice — see
        // _trySendBusSignal and the file header on the SUBTLE POINT of
        // renegotiating over this very same bus.
        if (!this._trySendBusSignal('answer', answer)) {
          const encAnswer = await this.sigCrypto.encrypt(answer);
          this.signaling.send('answer', {
            targetPeerId: this.targetPeerId,
            sdp: encAnswer,
          });
          ConnStats.incSignalingRelay();
        }
      } catch (err) {
        console.error(`[peer ${this.targetPeerId}] setLocalDescription (answer) error:`, err);
      }
    }
  }

  /** Shared handling of a remote ICE candidate (trickle, queued until remoteDescription) — not tied to the transport, see handleCandidate/handleBusSignal. */
  async _applyRemoteCandidate(candidate) {
    if (!this.remoteSet) {
      this.candidateQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // As in the reference pattern: if the candidate belongs to an offer we
      // just ignored (ignoreOffer), the error is expected — swallow it.
      if (!this.ignoreOffer) {
        console.error(`[peer ${this.targetPeerId}] addIceCandidate error:`, err);
      }
    }
  }

  _flushCandidateQueue() {
    const queue = this.candidateQueue;
    this.candidateQueue = [];
    for (const candidate of queue) {
      this.pc.addIceCandidate(candidate).catch((err) => {
        if (!this.ignoreOffer) {
          console.error(`[peer ${this.targetPeerId}] addIceCandidate error (from queue):`, err);
        }
      });
    }
  }

  /**
   * Send an object to this peer's bus: JSON.stringify + try/catch around
   * the send itself. While the channel isn't created/open yet — it queues
   * up (see setupBusChannel/channel.onopen in the constructor).
   */
  sendBus(obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Failed to serialize bus message:`, err);
      return;
    }
    if (this.busChannel && this.busChannel.readyState === 'open') {
      try {
        this.busChannel.send(text);
      } catch (err) {
        console.error(`[peer ${this.targetPeerId}] Error sending to bus:`, err);
      }
    } else {
      this.busQueue.push(text);
    }
  }

  isBusOpen() {
    return !!this.busChannel && this.busChannel.readyState === 'open';
  }

  /**
   * F3: whether offer/answer/ice can be sent over this pair's bus RIGHT NOW
   * — a simple rule with no acknowledgments/retries (see the file header,
   * "SUBTLE POINT"): the channel is open AND pc is already 'connected'. If
   * the pair is still being established (bootstrap, bus hasn't opened) or
   * is falling apart/being re-established (ICE-restart, reconnect after the
   * channel died — connectionState then isn't 'connected') — signals must
   * go through the server.
   */
  _canUseBus() {
    return this.isBusOpen() && this.pc.connectionState === 'connected';
  }

  /**
   * Try to send a single signal ('offer'|'answer'|'ice') over this pair's
   * bus. Returns true if it actually went out over the bus (in that case
   * the caller must NOT also send the same signal through the server and
   * must NOT increment ConnStats.incSignalingRelay — see static/room.js,
   * task item 4), false if the bus is unavailable or send() failed
   * synchronously (in that case the caller must fall back to the server
   * path itself).
   *
   * Deliberately does NOT use sendBus() (which queues undelivered messages
   * until the channel next opens) — if this very renegotiation broke pc,
   * the channel will most likely never open again, and the offer would get
   * stuck in the queue forever instead of honestly falling back to the
   * server immediately. The _canUseBus() check and the channel.send() call
   * itself are synchronous code with no await in between, so the race
   * "state changed between the check and the send" is excluded here.
   */
  _trySendBusSignal(type, data) {
    if (!this._canUseBus()) return false;
    try {
      this.busChannel.send(JSON.stringify({ kind: 'rtc-signal', payload: { type, data } }));
      return true;
    } catch (err) {
      console.warn(`[peer ${this.targetPeerId}] Failed to send ${type} over the bus — falling back to the server relay:`, err);
      return false;
    }
  }

  /**
   * Open a NEW separate DataChannel to transfer one file to one specific
   * recipient (see static/chat.js). `label` must have the form
   * `file-${fileId}-${recipient}` — the recipient already knows the entire
   * expected label in advance (it constructed it itself) and matches the
   * incoming channel by exact string match, so parsing the label into its
   * component parts isn't needed.
   */
  createFileChannel(label) {
    return this.pc.createDataChannel(label);
  }

  /**
   * The fingerprint of the CERTIFICATE that the remote peer actually
   * presented in the DTLS handshake (not the one "promised" in the SDP, but
   * the one actually used) — read from pc.getStats() from the
   * type==='remote-certificate' record. Needed for SAS (see
   * static/room.js: recomputeRoomSas, static/crypto.js: deriveSas). Returns
   * the fingerprint string or null if DTLS hasn't been established yet /
   * stats are unavailable.
   */
  async getRemoteCertificateFingerprint() {
    try {
      const report = await this.pc.getStats();
      // Spec path (webrtc-stats): transport -> remoteCertificateId -> a
      // type:'certificate' record with a fingerprint field. This is the
      // peer's certificate as actually presented in DTLS (not the one
      // "promised" in the SDP).
      for (const stat of report.values()) {
        if (stat.type === 'transport' && stat.remoteCertificateId) {
          const cert = report.get(stat.remoteCertificateId);
          if (cert && cert.fingerprint) return cert.fingerprint;
        }
      }
      // Fallback to the non-standard type, in case it's ever encountered.
      for (const stat of report.values()) {
        if (stat.type === 'remote-certificate' && stat.fingerprint) return stat.fingerprint;
      }
    } catch (err) {
      console.warn(`[peer ${this.targetPeerId}] getStats() for SAS failed:`, err);
    }
    return null;
  }

  close() {
    this.pc.close();
  }
}
