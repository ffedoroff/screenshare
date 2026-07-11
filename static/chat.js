// chat.js — общая панель текстового чата для broadcaster.js и viewer.js.
//
// Контракт с сервером:
//   отправка: { type: 'chat', text }
//   приём:    'chat' { fromPeerId, name, text, ts }
//             'chat-history' { messages: [{ fromPeerId, name, text, ts }, ...] }
//             'error' { message }
//
// Панель — синглтон на страницу: DOM создаётся один раз при первом вызове
// ChatPanel.create(), повторные вызовы (например, при повторном старте
// трансляции) переиспользуют ту же разметку, но сбрасывают историю и
// перевешивают обработчики на новый Signaling.

'use strict';

const ChatPanel = (() => {
  const NAME_STORAGE_KEY = 'screenshare-name';
  const NEAR_BOTTOM_THRESHOLD = 32; // px

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
    const suffix = (msg.fromPeerId || '').slice(-4);
    return `Гость-${suffix}`;
  }

  // Единственный экземпляр панели на страницу (DOM переиспользуется между
  // подключениями, см. attach()).
  let singleton = null;

  function buildDom(variant) {
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'chat-toggle-button hidden';
    toggleButton.setAttribute('aria-label', 'Открыть чат');
    toggleButton.innerHTML =
      '💬<span class="chat-unread-badge hidden"></span>';

    const panel = document.createElement('div');
    panel.className = `chat-panel chat-panel--${variant} hidden`;
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Чат</span>
        <input type="text" class="chat-name-input" placeholder="Ваше имя" maxlength="40" />
        <button type="button" class="chat-collapse-button" aria-label="Свернуть чат">✕</button>
      </div>
      <div class="chat-messages"></div>
      <div class="chat-error-banner hidden"></div>
      <div class="chat-input-row">
        <textarea class="chat-text-input" rows="1" placeholder="Сообщение…" maxlength="2000"></textarea>
        <button type="button" class="chat-send-button">Отправить</button>
      </div>
    `;

    document.body.appendChild(panel);
    document.body.appendChild(toggleButton);

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

  function create({ signaling, peerId, variant }) {
    if (!singleton) {
      const dom = buildDom(variant);
      singleton = createController(dom);
    }
    singleton.attach(signaling, peerId);
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
    let peerId = null;
    let unreadCount = 0;
    let errorTimer = null;

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

    function renderMessage(msg) {
      const wasNearBottom = isNearBottom();
      const own = msg.fromPeerId === peerId;

      const item = document.createElement('div');
      item.className = 'chat-message' + (own ? ' chat-message--own' : '');

      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName(msg);
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(msg.ts);
      meta.appendChild(nameSpan);
      meta.appendChild(timeSpan);

      const text = document.createElement('div');
      text.className = 'chat-message-text';
      text.textContent = msg.text;

      item.appendChild(meta);
      item.appendChild(text);
      messagesEl.appendChild(item);

      if (wasNearBottom) scrollToBottom();
    }

    function clearMessages() {
      messagesEl.textContent = '';
    }

    function setCollapsed(collapsed) {
      panel.classList.toggle('hidden', collapsed);
      toggleButton.classList.toggle('hidden', !collapsed);
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

    function handleChat(msg) {
      renderMessage(msg);
      if (panel.classList.contains('hidden')) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    }

    function handleHistory({ messages }) {
      if (!Array.isArray(messages)) return;
      for (const msg of messages) renderMessage(msg);
    }

    function handleError({ message }) {
      if (message) showError(message);
    }

    function sendCurrentText() {
      const text = textInput.value.trim();
      if (!text) return;
      if (!signaling) return;
      signaling.send('chat', { text });
      textInput.value = '';
    }

    toggleButton.addEventListener('click', () => setCollapsed(false));
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

    function attach(newSignaling, newPeerId) {
      signaling = newSignaling;
      peerId = newPeerId;

      clearMessages();
      unreadCount = 0;
      updateUnreadBadge();
      errorBanner.classList.add('hidden');
      enableInput();
      setCollapsed(true);

      signaling.on('chat', handleChat);
      signaling.on('chat-history', handleHistory);
      signaling.on('error', handleError);
    }

    return { attach, publicApi };
  }

  return { create, getSavedName };
})();
