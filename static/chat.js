// chat.js — панель текстового чата комнаты (Ф1: чат на mesh RTCDataChannel).
//
// Транспорт:
//   основной путь — шина (см. bus.js/rtc.js): broadcast конверта всем пирам
//   с открытым DataChannel;
//   fallback — пирам БЕЗ открытого канала конверт уходит через сервер
//   адресно: signaling.send('chat', { targetPeerId, envelope }), сервер
//   релеит как 'chat' { fromPeerId, envelope } и содержимое не разбирает и
//   не хранит (см. src/ws.rs).
//
// Конверт сообщения (РАСШИРЯЕМЫЙ — реакции/реплаи/файлы будущими волнами
// должны лечь без ломки формата):
//   { v: 1, id, lamport, from, name, kind: 'text', text, replyTo, ts }
// `ts` — клиентское время создания (мс, Date.now()), поле не входит в
// протокольный минимум, добавлено сверх него исключительно для отображения
// времени в ленте (та же функция, что была у серверного ts раньше) — сервер
// его не трогает, это чисто клиентское расширение внутри уже опакового для
// сервера конверта.
// Служебные kind этой фазы: 'history-request' (без доп. полей) и
// 'history-response' { messages: [конверты] }. Неизвестный kind — молча
// игнорируется (forward-compat).
//
// Lamport-часы: на отправку — свой счётчик +1; на приём — max(свой,
// полученный)+1. Порядок в ленте — сортировка по (lamport, from), поэтому
// одинаков у всех участников независимо от порядка доставки по сети.
//
// Своё сообщение рендерится сразу локально (оптимистично, без ожидания
// эха — эха от сервера больше нет в принципе, весь путь P2P).
//
// История: буфер последних 50 сообщений в памяти вкладки (не персистентный,
// живёт до закрытия/перезагрузки страницы). Новичок после joined запрашивает
// историю у первого пира в joined.peers; если за 3с канал к нему не
// открылся или ответа нет — пробует следующего. Пустая комната (никого в
// joined.peers) — пустая история, спрашивать не у кого.
//
// Rate-limit — клиентский, мягкий: не чаще 10 сообщений за 10с, блокирует
// отправку с сообщением в панели (серверный rate-limit — отдельно, только
// для fallback-пути, см. src/ws.rs).
//
// Панель — синглтон на страницу: DOM создаётся один раз при первом вызове
// ChatPanel.create(), повторные вызовы переиспользуют ту же разметку, но
// сбрасывают историю и перевешивают обработчики на новую сессию (новый
// signaling/bus/peerId — например, после page.reload()).
//
// Кнопка-тогл (открыть/закрыть чат, значок непрочитанных) — часть разметки
// пилюли управления (#chat-button в room.html), а не создаётся здесь: её
// элемент передаётся в ChatPanel.create({ toggleButton }) вызывающей
// стороной. Сама панель (.chat-panel) по-прежнему создаётся и живёт в body.

'use strict';

const ChatPanel = (() => {
  const NAME_STORAGE_KEY = 'screenshare-name';
  const NEAR_BOTTOM_THRESHOLD = 32; // px
  const HISTORY_CAP = 50;
  const HISTORY_REQUEST_TIMEOUT_MS = 3000;
  const RATE_LIMIT_COUNT = 10;
  const RATE_LIMIT_WINDOW_MS = 10_000;

  /** Прочитать сохранённое имя участника (или null, если не задано/пусто). */
  function getSavedName() {
    try {
      const raw = localStorage.getItem(NAME_STORAGE_KEY);
      const trimmed = raw ? raw.trim() : '';
      return trimmed || null;
    } catch (err) {
      console.warn('Не удалось прочитать имя из localStorage:', err);
      return null;
    }
  }

  function saveName(name) {
    try {
      localStorage.setItem(NAME_STORAGE_KEY, name.trim());
    } catch (err) {
      console.warn('Не удалось сохранить имя в localStorage:', err);
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function displayName(msg) {
    if (msg.name) return msg.name;
    const suffix = (msg.from || '').slice(-4);
    return `Гость-${suffix}`;
  }

  /** uuid v4 (crypto.randomUUID — везде, где живёт RTCPeerConnection, доступен). */
  function genId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Фоллбэк на случай окружения без crypto.randomUUID — не криптостойкий,
    // но здесь важна лишь уникальность в пределах комнаты, не секретность.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Порядок в ленте: (lamport, from) — стабильный и одинаковый у всех. */
  function compareOrder(a, b) {
    if (a.lamport !== b.lamport) return a.lamport - b.lamport;
    if (a.from < b.from) return -1;
    if (a.from > b.from) return 1;
    return 0;
  }

  // Единственный экземпляр панели на страницу (DOM переиспользуется между
  // подключениями, см. attach()).
  let singleton = null;

  function buildDom(variant, toggleButton) {
    const panel = document.createElement('div');
    panel.className = `chat-panel chat-panel--${variant} hidden`;
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Чат</span>
        <input type="text" class="chat-name-input" placeholder="Ваше имя" maxlength="40" />
        <button type="button" class="chat-collapse-button" aria-label="Свернуть чат" title="Свернуть чат">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="5" y1="5" x2="19" y2="19"></line>
            <line x1="19" y1="5" x2="5" y2="19"></line>
          </svg>
        </button>
      </div>
      <div class="chat-messages"></div>
      <div class="chat-error-banner hidden"></div>
      <div class="chat-input-row">
        <textarea class="chat-text-input" rows="1" placeholder="Сообщение…" maxlength="2000"></textarea>
        <button type="button" class="chat-send-button" aria-label="Отправить" title="Отправить">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    return {
      toggleButton,
      panel,
      unreadBadge: toggleButton.querySelector('.chat-unread-badge'),
      nameInput: panel.querySelector('.chat-name-input'),
      collapseButton: panel.querySelector('.chat-collapse-button'),
      messagesEl: panel.querySelector('.chat-messages'),
      errorBanner: panel.querySelector('.chat-error-banner'),
      textInput: panel.querySelector('.chat-text-input'),
      sendButton: panel.querySelector('.chat-send-button'),
    };
  }

  /**
   * @param {object} opts
   * @param {object} opts.signaling — Signaling (см. common.js), для fallback-релея и приёма его.
   * @param {object} opts.bus — Bus (см. bus.js), основной P2P-транспорт.
   * @param {string} opts.peerId — свой peerId.
   * @param {?string} opts.name — своё отображаемое имя (фиксируется на сессию, как раньше).
   * @param {string} opts.variant
   * @param {HTMLElement} opts.toggleButton
   * @param {() => string[]} opts.getPeerIds — актуальный список peerId остальных участников (для рассылки).
   * @param {string[]} opts.initialPeerIds — peerId остальных участников на момент joined, в порядке из joined.peers (для запроса истории).
   */
  function create({ signaling, bus, peerId, name, variant, toggleButton, getPeerIds, initialPeerIds }) {
    if (!singleton) {
      const dom = buildDom(variant, toggleButton);
      singleton = createController(dom);
    }
    singleton.attach({ signaling, bus, peerId, name, getPeerIds, initialPeerIds });
    return singleton.publicApi;
  }

  function createController(dom) {
    const {
      toggleButton,
      panel,
      unreadBadge,
      nameInput,
      collapseButton,
      messagesEl,
      errorBanner,
      textInput,
      sendButton,
    } = dom;

    let signaling = null;
    let bus = null;
    let peerId = null;
    let myName = null;
    let getPeerIds = () => [];
    let unreadCount = 0;
    let errorTimer = null;

    // --- Состояние протокола чата (Ф1) ---
    let lamportClock = 0;
    let messages = []; // отсортировано по compareOrder, максимум HISTORY_CAP
    let seenIds = new Set();
    let sendTimes = []; // клиентский rate-limit: метки времени своих отправок
    let historyResponseWaiters = new Map(); // peerId -> resolve(messages[])

    nameInput.value = getSavedName() || '';
    nameInput.addEventListener('input', () => {
      saveName(nameInput.value);
    });

    function isNearBottom() {
      return (
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
        NEAR_BOTTOM_THRESHOLD
      );
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderMessageEl(msg) {
      const own = msg.from === peerId;

      const item = document.createElement('div');
      item.className = 'chat-message' + (own ? ' chat-message--own' : '');

      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName(msg);
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(msg.ts || Date.now());
      meta.appendChild(nameSpan);
      meta.appendChild(timeSpan);

      const text = document.createElement('div');
      text.className = 'chat-message-text';
      text.textContent = msg.text;

      item.appendChild(meta);
      item.appendChild(text);
      messagesEl.appendChild(item);
    }

    /** Перерисовать всю ленту из `messages` (буфер маленький — до 50, полная перерисовка дешевле инкрементальной вставки в середину). */
    function renderAll(forceScrollBottom) {
      const wasNearBottom = isNearBottom();
      messagesEl.textContent = '';
      for (const msg of messages) renderMessageEl(msg);
      if (forceScrollBottom || wasNearBottom) scrollToBottom();
    }

    /** Вставить сообщение с дедупом по id и сортировкой по (lamport, from); капает буфер до HISTORY_CAP. Возвращает true, если реально вставлено (не дубликат). */
    function insertMessage(msg) {
      if (seenIds.has(msg.id)) return false;
      seenIds.add(msg.id);
      let idx = messages.length;
      while (idx > 0 && compareOrder(messages[idx - 1], msg) > 0) idx--;
      messages.splice(idx, 0, msg);
      while (messages.length > HISTORY_CAP) {
        const removed = messages.shift();
        seenIds.delete(removed.id);
      }
      return true;
    }

    function clearMessages() {
      messagesEl.textContent = '';
      messages = [];
      seenIds = new Set();
      lamportClock = 0;
      sendTimes = [];
      historyResponseWaiters = new Map();
    }

    function setCollapsed(collapsed) {
      panel.classList.toggle('hidden', collapsed);
      toggleButton.classList.toggle('control-button--on', !collapsed);
      toggleButton.setAttribute('aria-pressed', String(!collapsed));
      if (!collapsed) {
        unreadCount = 0;
        updateUnreadBadge();
        scrollToBottom();
        textInput.focus();
      }
    }

    function updateUnreadBadge() {
      unreadBadge.textContent = String(unreadCount);
      unreadBadge.classList.toggle('hidden', unreadCount === 0);
    }

    function showError(message) {
      errorBanner.textContent = message;
      errorBanner.classList.remove('hidden');
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        errorBanner.classList.add('hidden');
      }, 4000);
    }

    // --- Rate-limit (клиентский, мягкий) ---
    function checkClientRateLimit() {
      const now = Date.now();
      while (sendTimes.length && now - sendTimes[0] > RATE_LIMIT_WINDOW_MS) sendTimes.shift();
      if (sendTimes.length >= RATE_LIMIT_COUNT) return false;
      sendTimes.push(now);
      return true;
    }

    // --- Транспорт: broadcast конверта всем пирам (шина, где открыта; сервер-фоллбэк — где нет) ---
    function broadcastEnvelope(envelope) {
      for (const targetPeerId of getPeerIds()) {
        if (bus.isOpen(targetPeerId)) {
          bus.sendToPeer(targetPeerId, envelope);
        } else {
          signaling.send('chat', { targetPeerId, envelope });
        }
      }
    }

    // --- Приём: единая точка для сообщений с шины И с fallback-релея сервера ---
    function dispatchEnvelope(fromPeerId, envelope) {
      if (!envelope || typeof envelope !== 'object' || typeof envelope.kind !== 'string') return;
      switch (envelope.kind) {
        case 'text':
          handleIncomingText(envelope);
          break;
        case 'history-request':
          handleHistoryRequest(fromPeerId);
          break;
        case 'history-response':
          handleHistoryResponse(fromPeerId, envelope);
          break;
        default:
          // Неизвестный kind (будущие волны — реакции/реплаи/файлы) — молча игнорируем.
          break;
      }
    }

    function bumpLamportOnReceive(receivedLamport) {
      lamportClock = Math.max(lamportClock, receivedLamport || 0) + 1;
    }

    function handleIncomingText(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      renderAll(false);
      if (panel.classList.contains('hidden')) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    }

    function handleHistoryRequest(fromPeerId) {
      bus.sendToPeer(fromPeerId, {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'history-response',
        messages: messages.slice(),
      });
    }

    function handleHistoryResponse(fromPeerId, envelope) {
      const waiter = historyResponseWaiters.get(fromPeerId);
      if (!waiter) return; // не ждали ответа от этого пира (или уже дождались) — игнорируем
      waiter(Array.isArray(envelope.messages) ? envelope.messages : []);
    }

    function mergeHistory(historyMessages) {
      let insertedAny = false;
      for (const msg of historyMessages) {
        if (!msg || typeof msg !== 'object' || msg.kind !== 'text') continue;
        bumpLamportOnReceive(msg.lamport);
        if (insertMessage(msg)) insertedAny = true;
      }
      if (insertedAny) renderAll(true);
    }

    // --- Запрос истории у соседей при входе в комнату ---
    function waitForBusOpen(targetPeerId, timeoutMs) {
      return new Promise((resolve) => {
        if (bus.isOpen(targetPeerId)) {
          resolve(true);
          return;
        }
        const deadline = Date.now() + timeoutMs;
        const iv = setInterval(() => {
          if (bus.isOpen(targetPeerId)) {
            clearInterval(iv);
            resolve(true);
          } else if (Date.now() >= deadline) {
            clearInterval(iv);
            resolve(false);
          }
        }, 50);
      });
    }

    async function requestHistoryFrom(targetPeerId, timeoutMs) {
      const start = Date.now();
      const opened = await waitForBusOpen(targetPeerId, timeoutMs);
      if (!opened) return null;
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          historyResponseWaiters.delete(targetPeerId);
          resolve(null);
        }, remaining);
        historyResponseWaiters.set(targetPeerId, (msgs) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          historyResponseWaiters.delete(targetPeerId);
          resolve(msgs);
        });
        bus.sendToPeer(targetPeerId, {
          v: 1,
          id: genId(),
          lamport: lamportClock,
          from: peerId,
          name: myName || null,
          kind: 'history-request',
        });
      });
    }

    async function requestHistorySequential(candidatePeerIds) {
      for (const targetPeerId of candidatePeerIds) {
        const msgs = await requestHistoryFrom(targetPeerId, HISTORY_REQUEST_TIMEOUT_MS);
        if (msgs !== null) {
          mergeHistory(msgs);
          return;
        }
      }
      // Все кандидаты исчерпаны (никто не ответил вовремя) — история
      // остаётся пустой у новичка, как и было бы в пустой комнате.
    }

    function sendCurrentText() {
      const text = textInput.value.trim();
      if (!text) return;
      if (!signaling || !bus) return;

      if (!checkClientRateLimit()) {
        showError('Слишком много сообщений подряд — подождите немного.');
        return;
      }

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'text',
        text,
        replyTo: null,
        ts: Date.now(),
      };
      textInput.value = '';

      // Своё сообщение — сразу и локально, оптимистично (эха от сервера
      // больше нет: путь целиком P2P).
      insertMessage(envelope);
      renderAll(true);

      broadcastEnvelope(envelope);
    }

    toggleButton.addEventListener('click', () => {
      const isOpen = !panel.classList.contains('hidden');
      setCollapsed(isOpen);
    });
    collapseButton.addEventListener('click', () => setCollapsed(true));

    sendButton.addEventListener('click', sendCurrentText);
    textInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCurrentText();
      }
    });

    function enableInput() {
      textInput.disabled = false;
      sendButton.disabled = false;
      textInput.placeholder = 'Сообщение…';
    }

    function disableInput(reason) {
      textInput.disabled = true;
      sendButton.disabled = true;
      textInput.placeholder = reason || 'Чат недоступен';
    }

    const publicApi = { disableInput, enableInput };

    function handleServerError({ message }) {
      // Ошибки fallback-релея сервера (envelope > 8KB, серверный rate-limit
      // на fallback-пути) — тоже показываем в панели, тем же баннером.
      if (message) showError(message);
    }

    function attach({ signaling: newSignaling, bus: newBus, peerId: newPeerId, name, getPeerIds: newGetPeerIds, initialPeerIds }) {
      signaling = newSignaling;
      bus = newBus;
      peerId = newPeerId;
      myName = name || null;
      getPeerIds = typeof newGetPeerIds === 'function' ? newGetPeerIds : () => [];

      clearMessages();
      unreadCount = 0;
      updateUnreadBadge();
      errorBanner.classList.add('hidden');
      enableInput();
      setCollapsed(true);

      bus.onMessage(dispatchEnvelope);
      signaling.on('chat', ({ fromPeerId, envelope }) => dispatchEnvelope(fromPeerId, envelope));
      signaling.on('error', handleServerError);

      const candidates = Array.isArray(initialPeerIds) ? initialPeerIds.slice() : [];
      if (candidates.length > 0) {
        requestHistorySequential(candidates);
      }
      // Пустая комната (candidates пуст) — спрашивать не у кого, история пуста.
    }

    return { attach, publicApi };
  }

  return { create, getSavedName };
})();
