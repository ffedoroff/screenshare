// bus.js — room message bus API on top of RTCDataChannel (F0).
//
// The channel mechanics themselves (negotiated DataChannel id=0, outgoing
// queue until open, JSON serialization with try/catch) live in RtcPeer (see
// rtc.js: sendBus/isBusOpen/onBusMessage) — one channel per peer, matching
// the mesh topology. Bus here is a thin layer over the room's peer map:
// room.js registers/unregisters peers as they appear/leave
// (createRemotePeer/removeRemotePeer), and bus consumers (chat.js and any
// future features) only work with this API, without touching RtcPeer
// directly:
//   - sendToPeer(peerId, obj) — send to one specific peer;
//   - broadcast(obj) — send to all known Bus peers;
//   - onMessage(cb(fromPeerId, obj)) — subscribe to incoming messages (can
//     have multiple subscribers, as in Signaling.on);
//   - isOpen(peerId) — whether the channel to a specific peer is open right
//     now.
//
// Bus doesn't decide WHAT to do with a message to a peer that isn't open
// (fallback via the server, etc.) — that's already the caller's concern
// (chat.js); Bus is only the transport to the peers it has an open channel
// with.
//
// F3 (file transfer, see static/chat.js): besides the 'bus' bus channel,
// peer pairs exchange files over SEPARATE DataChannels (one per
// file×recipient, see RtcPeer.createFileChannel/onFileChannel in rtc.js) —
// Bus doesn't manage these channels directly, but gives access to the raw
// RtcPeer of a specific peer via getPeer(peerId), since creating/receiving
// such a channel requires the RTCPeerConnection itself, not just the JSON
// transport of sendToPeer/broadcast.

'use strict';

class Bus {
  constructor() {
    this._peers = new Map(); // peerId -> RtcPeer
    this._handlers = [];
  }

  /** Register a peer with the bus — usually right after creating an RtcPeer. */
  addPeer(peerId, rtcPeer) {
    this._peers.set(peerId, rtcPeer);
  }

  /** Unregister a peer (left the room) — subsequent sendToPeer/broadcast won't see it. */
  removePeer(peerId) {
    this._peers.delete(peerId);
  }

  /** Whether the DataChannel channel to `peerId` is open right now. */
  isOpen(peerId) {
    const rtc = this._peers.get(peerId);
    return !!rtc && rtc.isBusOpen();
  }

  /** Raw RtcPeer for `peerId` (or null) — needed for file DataChannels (see file header). */
  getPeer(peerId) {
    return this._peers.get(peerId) || null;
  }

  /** Send `obj` to a specific peer (if the channel isn't open yet — it'll be queued and sent on open). */
  sendToPeer(peerId, obj) {
    const rtc = this._peers.get(peerId);
    if (!rtc) return;
    rtc.sendBus(obj);
  }

  /** Send `obj` to all known Bus peers (each with its own queue/channel). */
  broadcast(obj) {
    for (const rtc of this._peers.values()) {
      rtc.sendBus(obj);
    }
  }

  /** Subscribe to incoming bus messages: cb(fromPeerId, obj). */
  onMessage(cb) {
    this._handlers.push(cb);
  }

  /** Called from RtcPeer.onBusMessage when a message from a specific peer is received. */
  _dispatch(peerId, obj) {
    for (const cb of this._handlers) cb(peerId, obj);
  }
}
