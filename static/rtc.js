// rtc.js — обёртка над RTCPeerConnection, реализующая канонический паттерн
// perfect negotiation (Jan-Ivar Bruaroey / MDN):
// https://developer.chrome.com/blog/perfect-negotiation/
// https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
//
// Протокол v2: симметричная комната, mesh — на каждого другого участника
// заводится свой RtcPeer. Роли broadcaster/viewer больше нет: polite/impolite
// выводится детерминированно из сравнения peerId обеих сторон (см.
// static/room.js: polite = мой peerId > peerId собеседника, лексикографически)
// — обе стороны сравнивают одну и ту же пару id, поэтому ровно один получает
// polite=true. Любая сторона может первой добавить трек (getUserMedia на
// микрофон/камеру, getDisplayMedia на шаринг экрана) и тем самым
// инициировать offer — коллизии разрешает perfect negotiation ниже.
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
//
// Ф0: шина комнаты (см. static/bus.js) поверх RTCDataChannel — обычный
// (НЕ negotiated) канал: заводит его ТОЛЬКО impolite-сторона обычным
// pc.createDataChannel('bus'), polite-сторона получает свою половину через
// pc.ondatachannel. Симметричный negotiated-канал (обе стороны создают
// одинаковый id=0 сразу в конструкторе) эмпирически оказался хрупок в
// этой headless Chrome песочнице: при создании нескольких
// RTCPeerConnection на одной странице почти одновременно браузер иногда
// вовсе не вызывал onnegotiationneeded для одного из соединений (не баг
// perfect negotiation — у остальных пар всё штатно доходило до
// stable/connected, а для сломанной пары негоциация не начиналась вообще
// ни с одной стороны). У обычного одностороннего createDataChannel('bus')
// та же самая цепочка (createDataChannel -> onnegotiationneeded -> offer)
// уже была многократно проверена штатной работой этого файла для
// addTrack() (медиа) до Ф0 — воспроизвести ту же хрупкость с ней не
// удалось, поэтому шина использует именно эту, уже проверенную схему.
// Единственное отличие от медиа: канал создаётся сразу в конструкторе (а не
// по клику пользователя), поэтому та же самая коллизия офферов, что раньше
// возникала только при одновременном старте видео/аудио с двух сторон,
// теперь возможна и от одного самого факта входа в комнату — perfect
// negotiation ниже её штатно разруливает.

'use strict';

class RtcPeer {
  constructor({ iceServers, polite, signaling, targetPeerId, onTrack, onStateChange, onBusMessage }) {
    this.signaling = signaling;
    this.targetPeerId = targetPeerId;
    this.polite = polite;
    this.onBusMessage = onBusMessage || null;

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;

    // Кандидаты, пришедшие раньше, чем применён remoteDescription — как и в
    // прежней ручной реализации, копим в очередь и сбрасываем после
    // setRemoteDescription.
    this.remoteSet = false;
    this.candidateQueue = [];

    // busChannel появляется не сразу: у impolite-стороны — синхронно здесь
    // же (createDataChannel), у polite-стороны — асинхронно, когда придёт
    // pc.ondatachannel. sendBus() должен уметь копить исходящее и до этого
    // момента тоже, поэтому busQueue — это очередь СТРОК JSON, а не что-то
    // завязанное на конкретный channel.
    this.busChannel = null;
    this.busQueue = [];

    const pc = new RTCPeerConnection({ iceServers });
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
            console.error(`[peer ${targetPeerId}] Ошибка отправки в шину (флаш очереди):`, err);
          }
        }
      };

      channel.onmessage = (event) => {
        let obj;
        try {
          obj = JSON.parse(event.data);
        } catch (err) {
          console.error(`[peer ${targetPeerId}] Некорректный JSON в шине:`, event.data, err);
          return;
        }
        if (this.onBusMessage) this.onBusMessage(obj);
      };

      channel.onerror = (event) => {
        console.error(`[peer ${targetPeerId}] Ошибка DataChannel-шины:`, event);
      };
    };

    if (!polite) {
      // impolite создаёт канал — само создание триггерит onnegotiationneeded
      // ниже (если для этой пары ещё не было ни одной SCTP-негоциации).
      setupBusChannel(pc.createDataChannel('bus'));
    } else {
      // polite ничего не создаёт сама — ждёт канал от impolite-стороны.
      pc.ondatachannel = (event) => {
        if (event.channel.label === 'bus') setupBusChannel(event.channel);
      };
    }

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

  /**
   * Отправить объект в шину этого пира: JSON.stringify + try/catch на сам
   * send. Пока канал не создан/не открыт — копится в очереди (см.
   * setupBusChannel/channel.onopen в конструкторе).
   */
  sendBus(obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Не удалось сериализовать сообщение шины:`, err);
      return;
    }
    if (this.busChannel && this.busChannel.readyState === 'open') {
      try {
        this.busChannel.send(text);
      } catch (err) {
        console.error(`[peer ${this.targetPeerId}] Ошибка отправки в шину:`, err);
      }
    } else {
      this.busQueue.push(text);
    }
  }

  isBusOpen() {
    return !!this.busChannel && this.busChannel.readyState === 'open';
  }

  close() {
    this.pc.close();
  }
}
