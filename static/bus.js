// bus.js — API шины сообщений комнаты поверх RTCDataChannel (Ф0).
//
// Сама механика канала (negotiated DataChannel id=0, очередь исходящих до
// открытия, JSON-сериализация с try/catch) живёт в RtcPeer (см. rtc.js:
// sendBus/isBusOpen/onBusMessage) — по одному каналу на пира, соответствует
// топологии mesh. Bus здесь — тонкая прослойка над картой пиров комнаты:
// room.js регистрирует/снимает пиров по мере их появления/ухода
// (createRemotePeer/removeRemotePeer), а потребители шины (chat.js и любые
// будущие фичи) работают только с этим API, не трогая RtcPeer напрямую:
//   - sendToPeer(peerId, obj) — отправить одному конкретному пиру;
//   - broadcast(obj) — отправить всем известным Bus пирам;
//   - onMessage(cb(fromPeerId, obj)) — подписаться на входящие (можно
//     несколько подписчиков, как в Signaling.on);
//   - isOpen(peerId) — открыт ли канал до конкретного пира прямо сейчас.
//
// Bus не решает, ЧТО делать с сообщением не открытому пиру (fallback через
// сервер и т.п.) — это уже забота вызывающего кода (chat.js), Bus — только
// транспорт до тех пиров, с кем канал открыт.

'use strict';

class Bus {
  constructor() {
    this._peers = new Map(); // peerId -> RtcPeer
    this._handlers = [];
  }

  /** Зарегистрировать пира в шине — обычно сразу после создания RtcPeer. */
  addPeer(peerId, rtcPeer) {
    this._peers.set(peerId, rtcPeer);
  }

  /** Снять пира с учёта (ушёл из комнаты) — дальнейшие sendToPeer/broadcast его не видят. */
  removePeer(peerId) {
    this._peers.delete(peerId);
  }

  /** Открыт ли DataChannel-канал до `peerId` прямо сейчас. */
  isOpen(peerId) {
    const rtc = this._peers.get(peerId);
    return !!rtc && rtc.isBusOpen();
  }

  /** Отправить `obj` конкретному пиру (если канал ещё не открыт — уйдёт в очередь и будет отправлен по open). */
  sendToPeer(peerId, obj) {
    const rtc = this._peers.get(peerId);
    if (!rtc) return;
    rtc.sendBus(obj);
  }

  /** Отправить `obj` всем известным Bus пирам (каждому — своя очередь/канал). */
  broadcast(obj) {
    for (const rtc of this._peers.values()) {
      rtc.sendBus(obj);
    }
  }

  /** Подписаться на входящие сообщения шины: cb(fromPeerId, obj). */
  onMessage(cb) {
    this._handlers.push(cb);
  }

  /** Вызывается из RtcPeer.onBusMessage при получении сообщения от конкретного пира. */
  _dispatch(peerId, obj) {
    for (const cb of this._handlers) cb(peerId, obj);
  }
}
