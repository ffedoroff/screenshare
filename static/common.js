// common.js — общие утилиты для broadcaster.js и viewer.js:
// получение ICE-конфигурации и обёртка над WebSocket-сигналингом.

'use strict';

// Фоллбэк, если /config недоступен: только публичный STUN.
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Получить список ICE-серверов с бэкенда (`GET /config`).
 * При любой ошибке (сеть, парсинг, пустой ответ) — тихий фоллбэк на STUN.
 */
async function fetchIceServers() {
  try {
    const res = await fetch('/config');
    if (!res.ok) throw new Error(`/config ответил статусом ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
    return FALLBACK_ICE_SERVERS;
  } catch (err) {
    console.warn('Не удалось получить /config, используем STUN по умолчанию:', err);
    return FALLBACK_ICE_SERVERS;
  }
}

/**
 * Обёртка над WebSocket-сигналингом.
 * — открывает соединение (ws:// или wss:// в зависимости от протокола страницы);
 * — отправляет/принимает JSON-сообщения вида { type, ...поля };
 * — диспетчеризует входящие сообщения подписчикам по `type` через `on()`.
 */
class Signaling {
  constructor() {
    this.ws = null;
    this._handlers = new Map();
    // Колбэки на закрытие/ошибку сокета — назначаются извне (broadcaster.js/viewer.js).
    this.onClose = null;
    this.onError = null;
  }

  /** Открыть WebSocket-соединение с `/ws`. Промис резолвится после открытия. */
  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => resolve();

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('Некорректный JSON от сервера сигналинга:', event.data, err);
          return;
        }
        this._dispatch(msg);
      };

      ws.onerror = (event) => {
        console.error('Ошибка WebSocket-соединения:', event);
        if (this.onError) this.onError(event);
        reject(event);
      };

      ws.onclose = (event) => {
        console.log('WebSocket закрыт: код', event.code, 'причина', event.reason || '(нет)');
        if (this.onClose) this.onClose(event);
      };
    });
  }

  /** Подписаться на сообщения заданного `type`. Можно несколько обработчиков на тип. */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
  }

  /** Отправить сообщение серверу: `type` в kebab-case, остальные поля — camelCase. */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Попытка отправить сообщение при неоткрытом сокете:', type, payload);
      return;
    }
    this.ws.send(JSON.stringify({ type, ...payload }));
  }

  _dispatch(msg) {
    if (!msg || typeof msg.type !== 'string') {
      console.warn('Сообщение без поля type проигнорировано:', msg);
      return;
    }
    const handlers = this._handlers.get(msg.type);
    if (!handlers || handlers.length === 0) {
      console.debug('Нет подписчиков на сообщение типа', msg.type, msg);
      return;
    }
    for (const handler of handlers) handler(msg);
  }

  /** Закрыть соединение. Вызывающий код сам решает, как трактовать это закрытие в UI. */
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}
