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
//
// Ш1 (E2E-шифрование, см. static/crypto.js): offer/answer/ice-candidate ВСЕГДА
// идут через серверный сигналинг-релей (это как раз то сообщение, которым
// P2P-соединение только устанавливается — по определению не может пойти по
// ещё не существующей шине), поэтому sdp/candidate шифруются под K_sig
// безусловно, на каждый такой обмен — см. sigCrypto в конструкторе и
// handleDescription/handleCandidate ниже. Сама P2P-шина (DataChannel 'bus')
// и медиатреки НЕ шифруются этим слоем — WebRTC обязан гнать их поверх DTLS,
// это уже полноценный E2E между двумя конкретными пирами, второй прикладной
// слой шифрования той же пары ничего не добавил бы к безопасности.
//
// Ф3: файловые DataChannel (см. static/chat.js — протокол передачи файлов).
// В отличие от шины ('bus', одна на пару, создаётся один раз при входе),
// файловый канал создаётся ПО ЗАПРОСУ, отдельный на каждую пару
// (fileId, получатель), и инициатором может быть ЛЮБАЯ из сторон пары (кто
// держит файл — не обязательно impolite), поэтому pc.ondatachannel должен
// уметь ловить входящий канал НЕЗАВИСИМО от роли polite/impolite —
// диспетчеризуется по префиксу label ('bus' -> шина, 'file-' -> файл).
// Создание дополнительного DataChannel на уже установленном соединении не
// требует новой SDP-негоциации (SCTP-ассоциация уже есть) — onnegotiationneeded
// в норме не срабатывает повторно.
//
// Ф3 (повторные offer/answer/ice по шине): ПЕРВОЕ рукопожатие пары (когда
// шина ещё не существует — курица-яйцо, см. Ш1 выше) и ICE-restart/реконнект
// ВСЕГДА идут через серверный релей с шифрованием, как и раньше. Но КАЖДАЯ
// ПОСЛЕДУЮЩАЯ ренегоциация той же пары (добавление/снятие трека, смена
// камеры с реальной ренегоциацией и т.п.) — уже после того, как шина к этому
// пиру открылась — гоняется прямо по ней: kind: 'rtc-signal', payload
// {type: 'offer'|'answer'|'ice', data}, БЕЗ шифрования этим слоем (DataChannel
// уже идёт поверх DTLS — это и есть E2E между этими двумя конкретными
// пирами, второй прикладной слой шифрования той же пары ничего не добавил
// бы, см. рассуждение про P2P-шину/медиатреки в комментарии Ш1 выше).
// sigCrypto остаётся нужен ТОЛЬКО для серверного пути.
//
// ТОНКОЕ МЕСТО: сама шина живёт на том же RTCPeerConnection, который сейчас
// ренегоциируется — если именно ЭТА ренегоциация сломает pc (редко, но
// возможно — ICE не сойдётся заново, DTLS отвалится и т.п.), шина умрёт
// вместе с ним, и offer/answer/ice, отправленные по ней, просто не доедут
// (никакого отдельного failure-сигнала от DataChannel.send() при этом может
// и не быть — сообщение либо ушло в буфер SCTP, либо канал уже закрылся
// синхронно, см. try/catch ниже). Никаких подтверждений/ретраев здесь
// сознательно не заводим (усложнение несоразмерно риску) — вместо этого
// простое и дешёвое правило проверяется НЕПОСРЕДСТВЕННО перед каждой
// отправкой: канал открыт И pc.connectionState === 'connected' -> шина;
// иначе (в частности — весь путь ICE-restart/реконнекта, где connectionState
// заведомо не 'connected') -> сервер, как и раньше. Проверка и сам
// channel.send() — синхронный код без await между ними, гонка «состояние
// изменилось между проверкой и отправкой» исключена.

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
  }) {
    this.signaling = signaling;
    this.targetPeerId = targetPeerId;
    this.polite = polite;
    this.onBusMessage = onBusMessage || null;
    // Ш1 (E2E-шифрование, см. static/crypto.js): sdp/candidate идут через
    // серверный сигналинг-релей (offer/answer/ice-candidate НИКОГДА не
    // ходят по P2P-шине — сама шина устанавливается ЭТИМИ сообщениями,
    // курица-яйцо), поэтому шифруются ВСЕГДА, а не только опционально.
    // `sigCrypto` — { encrypt(obj) -> Promise<blob>, decrypt(blob) -> Promise<obj> },
    // выданный вызывающей стороной (см. static/room.js: createRemotePeer) —
    // сам RtcPeer ничего не знает про устройство ключа комнаты, только
    // вызывает эти две функции. `onCryptoFailure` — колбэк на случай, если
    // decrypt() отказал (см. handleDescription/handleCandidate ниже) —
    // почти всегда означает неверный ключ комнаты у одной из сторон.
    this.sigCrypto = sigCrypto;
    this.onCryptoFailure = onCryptoFailure || null;
    // Ф2: колбэк на момент, когда шина к этому пиру открылась (после флаша
    // очереди) — используется для рассылки снапшота актуального состояния
    // (см. static/room.js: sendAllActiveStreamInfoTo) сразу по шине, закрывая
    // гонку «оффер с треками ушёл раньше, чем открылась шина».
    this.onBusOpen = onBusOpen || null;
    // Ф3: колбэк на входящий файловый DataChannel (label начинается с
    // 'file-') — см. createFileChannel ниже и static/chat.js.
    this.onFileChannel = onFileChannel || null;

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
        if (this.onBusOpen) this.onBusOpen();
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
    }
    // pc.ondatachannel вешаем БЕЗУСЛОВНО с обеих сторон (не только у polite):
    // 'bus' — только polite реально его тут дождётся (impolite создал канал
    // сам, ей ondatachannel на него никогда не прилетит); входящий файловый
    // канал ('file-...', см. заголовок файла) может прийти к ЛЮБОЙ из сторон
    // независимо от polite/impolite, поэтому диспетчеризация по label здесь
    // общая для обеих ролей.
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
        // Ф3: шина к этому пиру уже открыта и pc в порядке -> гоним offer по
        // ней напрямую (см. заголовок файла); иначе — прежний серверный путь
        // с шифрованием под K_sig (сервер видит только непрозрачный
        // {v,iv,ct} вместо настоящего SDP и его DTLS-отпечатков, см.
        // заголовок static/crypto.js).
        if (!this._trySendBusSignal('offer', offer)) {
          const encSdp = await this.sigCrypto.encrypt(offer);
          signaling.send('offer', { targetPeerId, sdp: encSdp });
          ConnStats.incSignalingRelay();
        }
      } catch (err) {
        console.error(`[peer ${targetPeerId}] Ошибка onnegotiationneeded:`, err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidateJson = event.candidate.toJSON();
      // Ф3: тот же выбор пути, что и у offer/answer выше — см. _trySendBusSignal.
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
   * Приём SDP-описания от удалённого пира ЧЕРЕЗ СЕРВЕРНЫЙ РЕЛЕЙ — offer ИЛИ
   * answer, разбираются по description.type. `encryptedDescription` —
   * зашифрованный блоб {v,iv,ct} (см. K_sig в static/crypto.js) —
   * расшифровывается ПЕРВЫМ делом, до какой-либо иной обработки; отказ
   * расшифровки почти всегда значит, что у одной из сторон неверный ключ
   * комнаты (см. onCryptoFailure). Сама обработка (perfect negotiation) —
   * в _applyRemoteDescription, общей с приёмом по шине (см. handleBusSignal).
   */
  async handleDescription(encryptedDescription) {
    let description;
    try {
      description = await this.sigCrypto.decrypt(encryptedDescription);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Не удалось расшифровать SDP (неверный ключ комнаты?):`, err);
      if (this.onCryptoFailure) this.onCryptoFailure(err);
      return;
    }
    await this._applyRemoteDescription(description);
  }

  /** Приём ICE-кандидата от удалённого пира ЧЕРЕЗ СЕРВЕРНЫЙ РЕЛЕЙ (trickle). `encryptedCandidate` — блоб {v,iv,ct}, расшифровывается первым делом (см. handleDescription про onCryptoFailure). */
  async handleCandidate(encryptedCandidate) {
    let candidate;
    try {
      candidate = await this.sigCrypto.decrypt(encryptedCandidate);
    } catch (err) {
      console.error(`[peer ${this.targetPeerId}] Не удалось расшифровать ICE-кандидат (неверный ключ комнаты?):`, err);
      if (this.onCryptoFailure) this.onCryptoFailure(err);
      return;
    }
    await this._applyRemoteCandidate(candidate);
  }

  /**
   * Ф3: приём rtc-signal с P2P-шины (см. room.js: bus.onMessage — уже
   * маршрутизирует по kind и зовёт это для соответствующего RtcPeer).
   * `payload` — {type: 'offer'|'answer'|'ice', data} — данные УЖЕ в чистом
   * виде (не зашифрованы этим слоем, см. заголовок файла), поэтому просто
   * заводятся в те же _applyRemoteDescription/_applyRemoteCandidate, что и
   * серверный путь — вся логика perfect negotiation/очереди кандидатов не
   * дублируется.
   */
  async handleBusSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'ice') {
      await this._applyRemoteCandidate(payload.data);
    } else {
      await this._applyRemoteDescription(payload.data);
    }
  }

  /** Общая обработка удалённого SDP-описания (offer/answer) — детект и разрешение коллизии офферов, применение remoteDescription, ответный answer при offer. Не завязана на транспорт (сервер/шина) — см. handleDescription/handleBusSignal. */
  async _applyRemoteDescription(description) {
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
        const answer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
        // Ф3: тот же выбор пути (шина/сервер), что и у offer/ice — см.
        // _trySendBusSignal и заголовок файла про ТОНКОЕ МЕСТО ренегоциации
        // поверх той же самой шины.
        if (!this._trySendBusSignal('answer', answer)) {
          const encAnswer = await this.sigCrypto.encrypt(answer);
          this.signaling.send('answer', {
            targetPeerId: this.targetPeerId,
            sdp: encAnswer,
          });
          ConnStats.incSignalingRelay();
        }
      } catch (err) {
        console.error(`[peer ${this.targetPeerId}] Ошибка setLocalDescription (answer):`, err);
      }
    }
  }

  /** Общая обработка удалённого ICE-кандидата (trickle, очередь до remoteDescription) — не завязана на транспорт, см. handleCandidate/handleBusSignal. */
  async _applyRemoteCandidate(candidate) {
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

  /**
   * Ф3: можно ли прямо СЕЙЧАС гонять offer/answer/ice по шине этой пары —
   * простое правило без подтверждений/ретраев (см. заголовок файла,
   * «ТОНКОЕ МЕСТО»): канал открыт И pc уже 'connected'. Если пара ещё
   * устанавливается (bootstrap, шина не открылась) или разваливается/
   * переустанавливается (ICE-restart, реконнект после падения канала —
   * connectionState тогда не 'connected') — сигналы обязаны идти сервером.
   */
  _canUseBus() {
    return this.isBusOpen() && this.pc.connectionState === 'connected';
  }

  /**
   * Попытаться отправить один сигнал ('offer'|'answer'|'ice') по шине этой
   * пары. Возвращает true, если реально ушло по шине (вызывающая сторона
   * тогда НЕ шлёт тем же сигналом ещё и через сервер и НЕ инкрементирует
   * ConnStats.incSignalingRelay — см. static/room.js, п.4 задания), false —
   * если бус недоступен или send() синхронно отказал (тогда вызывающая
   * сторона обязана откатиться на серверный путь сама).
   *
   * Намеренно НЕ используется sendBus() (тот копит недоставленное в очередь
   * до следующего открытия канала) — если именно эта ренегоциация сломала
   * pc, канал, скорее всего, никогда больше не откроется, и offer застрял бы
   * в очереди навсегда вместо честного немедленного отката на сервер.
   * Проверка _canUseBus() и сам channel.send() — синхронный код без await
   * между ними, поэтому гонка «состояние изменилось между проверкой и
   * отправкой» здесь исключена.
   */
  _trySendBusSignal(type, data) {
    if (!this._canUseBus()) return false;
    try {
      this.busChannel.send(JSON.stringify({ kind: 'rtc-signal', payload: { type, data } }));
      return true;
    } catch (err) {
      console.warn(`[peer ${this.targetPeerId}] Не удалось отправить ${type} по шине — откат на серверный релей:`, err);
      return false;
    }
  }

  /**
   * Открыть НОВЫЙ отдельный DataChannel для передачи одного файла одному
   * конкретному получателю (см. static/chat.js). `label` должен быть вида
   * `file-${fileId}-${получатель}` — получатель заранее знает ожидаемый
   * label целиком (сам его сконструировал) и матчит входящий канал по
   * точному совпадению строки, парсинг label на составные части не нужен.
   */
  createFileChannel(label) {
    return this.pc.createDataChannel(label);
  }

  close() {
    this.pc.close();
  }
}
