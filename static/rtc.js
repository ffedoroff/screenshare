// rtc.js — обёртка над RTCPeerConnection, реализующая канонический паттерн
// perfect negotiation (Jan-Ivar Bruaroey / MDN):
// https://developer.chrome.com/blog/perfect-negotiation/
// https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
//
// Роли (важно, зафиксировано намеренно):
//   - broadcaster — ВСЕГДА impolite (polite: false). Он единственный, кто
//     добавляет треки и на практике инициирует первый оффер, поэтому в
//     коллизиях офферов побеждает его версия.
//   - viewer — ВСЕГДА polite (polite: true). Viewer может добавить свой
//     микрофон (см. static/viewer.js: pc.addTrack при первом включении
//     кнопки «Микрофон») — это триггерит его собственный onnegotiationneeded
//     и он инициирует offer сам. Сервер релеит offer/answer/ice-candidate в
//     обе стороны без ограничений (см. src/ws.rs relay()), поэтому viewer
//     технически может прислать offer одновременно с broadcaster'ом — и как
//     polite-пир он должен уступать broadcaster'у при коллизии, а не наоборот.
//
// Флаги:
//   - makingOffer — true между началом onnegotiationneeded и отправкой offer;
//   - ignoreOffer — true, если impolite-пир решил проигнорировать чужой offer
//     из-за коллизии (см. handleDescription);
//   - isSettingRemoteAnswerPending — true во время setRemoteDescription(answer)
//     (зафиксировано для полного соответствия референсному паттерну).
//
// Откат локального оффера при коллизии на polite-стороне НЕ делается явно
// через setLocalDescription({type:'rollback'}) — современные браузеры делают
// неявный rollback внутри setRemoteDescription(offer), если signalingState
// был "have-local-offer".

'use strict';

class RtcPeer {
  constructor({ iceServers, polite, signaling, targetPeerId, onTrack, onStateChange }) {
    this.signaling = signaling;
    this.targetPeerId = targetPeerId;
    this.polite = polite;

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;

    // Кандидаты, пришедшие раньше, чем применён remoteDescription — как и в
    // прежней ручной реализации, копим в очередь и сбрасываем после
    // setRemoteDescription.
    this.remoteSet = false;
    this.candidateQueue = [];

    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        signaling.send('offer', { targetPeerId, sdp: pc.localDescription });
      } catch (err) {
        console.error(`[peer ${targetPeerId}] Ошибка onnegotiationneeded:`, err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.send('ice-candidate', {
          targetPeerId,
          candidate: event.candidate.toJSON(),
        });
      }
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
   * Приём SDP-описания от удалённого пира — offer ИЛИ answer, разбираются по
   * description.type. Реализует детект и разрешение коллизии офферов.
   */
  async handleDescription(description) {
    const pc = this.pc;
    const isOffer = description.type === 'offer';

    const offerCollision =
      isOffer && (this.makingOffer || pc.signalingState !== 'stable');

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      console.warn(
        `[peer ${this.targetPeerId}] Коллизия офферов — impolite-пир игнорирует чужой offer`
      );
      return;
    }

    try {
      this.isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      this.isSettingRemoteAnswerPending = false;
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Ошибка setRemoteDescription:`, err);
      return;
    }

    this.remoteSet = true;
    this._flushCandidateQueue();

    if (isOffer) {
      try {
        await pc.setLocalDescription();
        this.signaling.send('answer', {
          targetPeerId: this.targetPeerId,
          sdp: pc.localDescription,
        });
      } catch (err) {
        console.error(`[peer ${this.targetPeerId}] Ошибка setLocalDescription (answer):`, err);
      }
    }
  }

  /** Приём ICE-кандидата от удалённого пира (trickle). */
  async handleCandidate(candidate) {
    if (!this.remoteSet) {
      this.candidateQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // Как в референсном паттерне: если кандидат относится к офферу, который
      // мы только что проигнорировали (ignoreOffer), ошибка ожидаема — глотаем.
      if (!this.ignoreOffer) {
        console.error(`[peer ${this.targetPeerId}] Ошибка addIceCandidate:`, err);
      }
    }
  }

  _flushCandidateQueue() {
    const queue = this.candidateQueue;
    this.candidateQueue = [];
    for (const candidate of queue) {
      this.pc.addIceCandidate(candidate).catch((err) => {
        if (!this.ignoreOffer) {
          console.error(`[peer ${this.targetPeerId}] Ошибка addIceCandidate (из очереди):`, err);
        }
      });
    }
  }

  close() {
    this.pc.close();
  }
}
