// chat.js — панель текстового чата комнаты (Ф1: чат на mesh RTCDataChannel;
// Ф2: форматирование текста, реплаи и реакции — см. ниже).
//
// Транспорт:
//   основной путь — шина (см. bus.js/rtc.js): broadcast конверта всем пирам
//   с открытым DataChannel;
//   fallback — пирам БЕЗ открытого канала конверт уходит через сервер
//   адресно: signaling.send('chat', { targetPeerId, envelope }), сервер
//   релеит как 'chat' { fromPeerId, envelope } и содержимое не разбирает и
//   не хранит (см. src/ws.rs).
//
// Конверт сообщения (РАСШИРЯЕМЫЙ — расширения будущих волн должны лечь без
// ломки формата):
//   { v: 1, id, lamport, from, name, kind: 'text', text, replyTo, ts }
// `replyTo` — id сообщения, на которое отвечают (null, если не реплай).
// `ts` — клиентское время создания (мс, Date.now()), поле не входит в
// протокольный минимум, добавлено сверх него исключительно для отображения
// времени в ленте (та же функция, что была у серверного ts раньше) — сервер
// его не трогает, это чисто клиентское расширение внутри уже опакового для
// сервера конверта.
//
// Реакции (Ф2) — отдельный kind, тот же транспорт (broadcast по шине +
// fallback через сервер), тот же общий буфер истории, что и текстовые
// сообщения:
//   { v: 1, id, lamport, from, name, kind: 'reaction', target, emoji, op, ts }
// `target` — id сообщения, к которому относится реакция; `emoji` — один из
// фиксированного набора (см. REACTION_EMOJIS); `op` — 'add'|'remove'
// (повторный клик своей же реакции шлёт 'remove' — toggle на стороне
// отправителя, применяется у всех одинаково по (lamport, from)).
//
// Служебные kind этой фазы: 'history-request' (без доп. полей) и
// 'history-response' { messages: [конверты] }. Неизвестный kind — молча
// игнорируется (forward-compat). Буфер истории (см. HISTORY_CAP) хранит
// вперемешку и text-, и reaction-конверты — состояние реакций (map msgId ->
// emoji -> Set<peerId>) всегда пересчитывается заново по всему буферу в
// порядке (lamport, from), поэтому результат не зависит от порядка доставки
// по сети (см. recomputeReactions).
//
// Lamport-часы: на отправку — свой счётчик +1; на приём — max(свой,
// полученный)+1. Порядок в ленте — сортировка по (lamport, from), поэтому
// одинаков у всех участников независимо от порядка доставки по сети.
//
// Своё сообщение рендерится сразу локально (оптимистично, без ожидания
// эха — эха от сервера больше нет в принципе, весь путь P2P).
//
// История: буфер последних 50 конвертов (text+reaction) в памяти вкладки (не
// персистентный, живёт до закрытия/перезагрузки страницы). Новичок после
// joined запрашивает историю у первого пира в joined.peers; если за 3с канал
// к нему не открылся или ответа нет — пробует следующего. Пустая комната
// (никого в joined.peers) — пустая история, спрашивать не у кого.
//
// Rate-limit — клиентский, мягкий: не чаще 10 сообщений за 10с, блокирует
// отправку с сообщением в панели (серверный rate-limit — отдельно, только
// для fallback-пути, см. src/ws.rs). Реакции этим лимитом не ограничены —
// это лёгкие toggle-события, не полноценные сообщения.
//
// Форматирование текста (kind=text) — см. renderMessageBody/appendInlineNodes
// ниже: подмножество markdown (**жирный**, *курсив*, ~~зачёркнутый~~, "> "
// в начале строки — блок-цитата, http(s)-ссылки кликабельны без
// карточек-превью — никаких сетевых запросов по ссылке ради приватности).
// КРИТИЧНО: рендер строит DOM-ноды через createElement/textContent —
// никакого innerHTML с пользовательскими данными нигде в этом файле
// (innerHTML используется только для статичной, не зависящей от
// пользовательского ввода разметки — сама панель и попап реакций).
//
// Реплаи — кнопка «⤺ ответить» на каждом сообщении (см. .chat-message-action)
// открывает компактную плашку над инпутом; отправка кладёт replyTo в
// конверт. Сообщение с replyTo рендерит над текстом цитату оригинала (имя +
// обрезанный текст) из локального буфера; клик по цитате — плавный скролл к
// оригиналу с кратким подсвечиванием (см. scrollToMessageAndHighlight).
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
  const REPLY_PREVIEW_MAX_LEN = 60;
  const HIGHLIGHT_DURATION_MS = 1200;
  const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '😮', '😢'];

  // Статичная, не зависящая от пользовательских данных разметка — безопасна
  // для innerHTML (см. критичное требование к рендеру сообщений выше, оно
  // касается ТОЛЬКО пользовательского текста).
  const REPLY_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="9 14 4 9 9 4"></polyline>
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H13"></path>
  </svg>`;

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

  function truncateText(text, maxLen) {
    const str = String(text || '');
    return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
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

  // --- Рендер markdown-подмножества в тексте сообщения ---
  //
  // Только createElement/textContent — никакого innerHTML с пользовательским
  // текстом (см. заголовок файла). Вложенность инлайн-разметки не нужна
  // (жирный внутри цитаты — работает, т.к. цитата прогоняется через тот же
  // инлайн-парсер; жирный внутри курсива — не обязателен и не поддержан).
  //
  // Порядок альтернатив в регэкспе важен: на каждой стартовой позиции regex
  // пробует альтернативы слева направо, поэтому "**" (жирный) проверяется
  // раньше одиночного "*" (курсив) — иначе жирный никогда бы не совпал.
  // Символ-маркер исключён из содержимого класса символов ([^*]/[^~]) — это
  // не только упрощает жадность, но и не даёт одиночному "*" случайно
  // "прыгнуть" через границу уже распознанного **...**. Лукэхеды/лукбихайнды
  // на пробел у краёв (*(?!\s)...(?<!\s)*) отсекают самый частый ложный
  // срабатывающий случай — одиночные "*" как умножение/разделитель
  // ("5 * 3 * 2"), не образующие настоящей пары курсива.
  const INLINE_MD_RE =
    /\*\*(?!\s)([^*]+?)(?<!\s)\*\*|~~(?!\s)([^~]+?)(?<!\s)~~|\*(?!\s)([^*]+?)(?<!\s)\*|(https?:\/\/[^\s<>"')]+)/g;

  /** Разобрать одну строку (без переводов строк) на текстовые узлы + инлайн-элементы и добавить их в `parent`. */
  function appendInlineNodes(parent, line) {
    if (line === '') return;
    INLINE_MD_RE.lastIndex = 0;
    let lastIndex = 0;
    let match;
    while ((match = INLINE_MD_RE.exec(line))) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      if (match[1] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        parent.appendChild(strong);
      } else if (match[2] !== undefined) {
        const del = document.createElement('del');
        del.textContent = match[2];
        parent.appendChild(del);
      } else if (match[3] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[3];
        parent.appendChild(em);
      } else if (match[4] !== undefined) {
        const a = document.createElement('a');
        a.href = match[4];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[4];
        parent.appendChild(a);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) {
      parent.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
  }

  /**
   * Отрендерить полное тело сообщения в `container` (обычно .chat-message-text).
   * Строки, начинающиеся ровно с "> ", группируются в блок-цитату (левая
   * полоска, см. .chat-md-quote в style.css); остальные строки — обычный
   * инлайн-форматированный текст. Переводы строк между блоками — <br>.
   */
  function renderMessageBody(container, text) {
    const lines = String(text || '').split('\n');
    let firstBlock = true;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('> ')) {
        const quoteLines = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].slice(2));
          i++;
        }
        if (!firstBlock) container.appendChild(document.createElement('br'));
        const block = document.createElement('div');
        block.className = 'chat-md-quote';
        quoteLines.forEach((qLine, idx) => {
          if (idx > 0) block.appendChild(document.createElement('br'));
          appendInlineNodes(block, qLine);
        });
        container.appendChild(block);
        firstBlock = false;
      } else {
        if (!firstBlock) container.appendChild(document.createElement('br'));
        appendInlineNodes(container, line);
        firstBlock = false;
        i++;
      }
    }
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
      <div class="chat-reply-bar hidden">
        <span class="chat-reply-bar-text"></span>
        <button type="button" class="chat-reply-bar-close" aria-label="Отменить ответ" title="Отменить ответ">×</button>
      </div>
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

    // Попап-палитра реакций — общий на панель (не по одному на сообщение),
    // позиционируется абсолютно относительно панели при открытии (см.
    // openReactionPopover). Набор эмодзи фиксирован и статичен — безопасно
    // строить через innerHTML/textContent, это не пользовательские данные.
    const reactionPopover = document.createElement('div');
    reactionPopover.className = 'chat-reaction-popover hidden';
    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-reaction-popover-emoji';
      btn.dataset.emoji = emoji;
      btn.textContent = emoji;
      reactionPopover.appendChild(btn);
    }
    panel.appendChild(reactionPopover);

    document.body.appendChild(panel);

    return {
      toggleButton,
      panel,
      unreadBadge: toggleButton.querySelector('.chat-unread-badge'),
      nameInput: panel.querySelector('.chat-name-input'),
      collapseButton: panel.querySelector('.chat-collapse-button'),
      messagesEl: panel.querySelector('.chat-messages'),
      errorBanner: panel.querySelector('.chat-error-banner'),
      replyBar: panel.querySelector('.chat-reply-bar'),
      replyBarText: panel.querySelector('.chat-reply-bar-text'),
      replyBarClose: panel.querySelector('.chat-reply-bar-close'),
      reactionPopover,
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
      replyBar,
      replyBarText,
      replyBarClose,
      reactionPopover,
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

    // --- Состояние протокола чата ---
    let lamportClock = 0;
    // Единый буфер истории (капается до HISTORY_CAP) — хранит вперемешку
    // конверты kind='text' и kind='reaction', отсортирован по compareOrder.
    // Именно этот массив целиком уходит в history-response (см.
    // handleHistoryRequest) и целиком пересчитывает reactions при любом
    // изменении (см. recomputeReactions).
    let messages = [];
    let seenIds = new Set();
    // msgId -> Map(emoji -> Set<peerId>) — производное состояние, всегда
    // пересчитывается заново из `messages` (см. recomputeReactions), поэтому
    // не зависит от порядка доставки/реплея истории.
    let reactions = new Map();
    let sendTimes = []; // клиентский rate-limit: метки времени своих отправок
    let historyResponseWaiters = new Map(); // peerId -> resolve(messages[])
    let replyTarget = null; // конверт сообщения, на которое сейчас отвечаем (или null)
    let activeReactionTarget = null; // msgId, для которого сейчас открыт попап реакций (или null)

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

    /** Найти текстовое сообщение по id в текущем буфере (для рендера цитаты реплая). */
    function findMessageById(id) {
      for (const msg of messages) {
        if (msg.kind === 'text' && msg.id === id) return msg;
      }
      return null;
    }

    /** Пересчитать map реакций с нуля из `messages`, применяя op'ы в порядке (lamport, from) — буфер уже так отсортирован. */
    function recomputeReactions() {
      const next = new Map();
      for (const msg of messages) {
        if (msg.kind !== 'reaction') continue;
        if (!msg.target || typeof msg.emoji !== 'string' || !msg.from) continue;
        let byEmoji = next.get(msg.target);
        if (!byEmoji) {
          byEmoji = new Map();
          next.set(msg.target, byEmoji);
        }
        let peers = byEmoji.get(msg.emoji);
        if (!peers) {
          peers = new Set();
          byEmoji.set(msg.emoji, peers);
        }
        if (msg.op === 'add') peers.add(msg.from);
        else if (msg.op === 'remove') peers.delete(msg.from);
      }
      reactions = next;
    }

    function buildReplyQuoteEl(targetId) {
      const quote = document.createElement('div');
      quote.className = 'chat-reply-quote';
      const original = findMessageById(targetId);
      if (!original) {
        quote.classList.add('chat-reply-quote--missing');
        quote.textContent = 'сообщение недоступно';
        return quote;
      }
      const nameEl = document.createElement('span');
      nameEl.className = 'chat-reply-quote-name';
      nameEl.textContent = displayName(original);
      const textEl = document.createElement('span');
      textEl.className = 'chat-reply-quote-text';
      textEl.textContent = truncateText(original.text, REPLY_PREVIEW_MAX_LEN);
      quote.appendChild(nameEl);
      quote.appendChild(textEl);
      quote.addEventListener('click', () => scrollToMessageAndHighlight(targetId));
      return quote;
    }

    function buildReactionsRowEl(msgId) {
      const byEmoji = reactions.get(msgId);
      if (!byEmoji || byEmoji.size === 0) return null;
      const row = document.createElement('div');
      row.className = 'chat-message-reactions';
      let any = false;
      for (const emoji of REACTION_EMOJIS) {
        const peersSet = byEmoji.get(emoji);
        if (!peersSet || peersSet.size === 0) continue;
        any = true;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chat-reaction-chip' + (peersSet.has(peerId) ? ' chat-reaction-chip--own' : '');
        chip.textContent = `${emoji} ${peersSet.size}`;
        chip.title = peersSet.has(peerId) ? 'Убрать реакцию' : 'Поставить реакцию';
        chip.addEventListener('click', () => sendReactionToggle(msgId, emoji));
        row.appendChild(chip);
      }
      return any ? row : null;
    }

    function scrollToMessageAndHighlight(targetId) {
      const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetId) : targetId;
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${safeId}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const textEl = el.querySelector('.chat-message-text');
      if (textEl) {
        textEl.classList.add('chat-message-text--flash');
        setTimeout(() => textEl.classList.remove('chat-message-text--flash'), HIGHLIGHT_DURATION_MS);
      }
    }

    function renderMessageEl(msg) {
      const own = msg.from === peerId;

      const item = document.createElement('div');
      item.className = 'chat-message' + (own ? ' chat-message--own' : '');
      item.dataset.msgId = msg.id;

      const actions = document.createElement('div');
      actions.className = 'chat-message-actions';

      const replyButton = document.createElement('button');
      replyButton.type = 'button';
      replyButton.className = 'chat-message-action chat-message-action--reply';
      replyButton.setAttribute('aria-label', 'Ответить');
      replyButton.title = 'Ответить';
      replyButton.innerHTML = REPLY_ICON_SVG; // статичная разметка, не пользовательские данные
      replyButton.addEventListener('click', () => startReply(msg));
      actions.appendChild(replyButton);

      const reactButton = document.createElement('button');
      reactButton.type = 'button';
      reactButton.className = 'chat-message-action chat-message-action--react';
      reactButton.setAttribute('aria-label', 'Добавить реакцию');
      reactButton.title = 'Реакция';
      reactButton.textContent = '☺+';
      reactButton.addEventListener('click', () => toggleReactionPopover(reactButton, msg.id));
      actions.appendChild(reactButton);

      item.appendChild(actions);

      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName(msg);
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(msg.ts || Date.now());
      meta.appendChild(nameSpan);
      meta.appendChild(timeSpan);
      item.appendChild(meta);

      if (msg.replyTo) {
        item.appendChild(buildReplyQuoteEl(msg.replyTo));
      }

      const text = document.createElement('div');
      text.className = 'chat-message-text';
      renderMessageBody(text, msg.text);
      item.appendChild(text);

      const reactionsRow = buildReactionsRowEl(msg.id);
      if (reactionsRow) item.appendChild(reactionsRow);

      messagesEl.appendChild(item);
    }

    /** Перерисовать всю ленту из `messages` (буфер маленький — до 50, полная перерисовка дешевле инкрементальной вставки в середину). Реакции — не самостоятельные пузыри в ленте, только текстовые сообщения. */
    function renderAll(forceScrollBottom) {
      const wasNearBottom = isNearBottom();
      messagesEl.textContent = '';
      for (const msg of messages) {
        if (msg.kind === 'text') renderMessageEl(msg);
      }
      if (forceScrollBottom || wasNearBottom) scrollToBottom();
    }

    /** Вставить конверт (text или reaction) с дедупом по id и сортировкой по (lamport, from); капает буфер до HISTORY_CAP. Возвращает true, если реально вставлено (не дубликат). */
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
      reactions = new Map();
      lamportClock = 0;
      sendTimes = [];
      historyResponseWaiters = new Map();
      cancelReply();
      closeReactionPopover();
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

    // --- Реплаи: компактная плашка над инпутом ---
    function startReply(msg) {
      replyTarget = msg;
      replyBarText.textContent = `Ответ ${displayName(msg)}: ${truncateText(msg.text, REPLY_PREVIEW_MAX_LEN)}`;
      replyBar.classList.remove('hidden');
      closeReactionPopover();
      textInput.focus();
    }

    function cancelReply() {
      replyTarget = null;
      replyBar.classList.add('hidden');
    }

    replyBarClose.addEventListener('click', cancelReply);

    // --- Реакции: общий попап-палитра, позиционируется под кнопкой сообщения ---
    function openReactionPopover(anchorEl, msgId) {
      activeReactionTarget = msgId;
      reactionPopover.classList.remove('hidden');
      const panelRect = panel.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverRect = reactionPopover.getBoundingClientRect();

      let left = anchorRect.left - panelRect.left;
      const maxLeft = Math.max(4, panelRect.width - popoverRect.width - 4);
      left = Math.max(4, Math.min(left, maxLeft));

      let top = anchorRect.bottom - panelRect.top + 4;
      if (top + popoverRect.height > panelRect.height - 4) {
        // Не помещается снизу (мало места до конца панели) — раскрываем вверх от кнопки.
        top = anchorRect.top - panelRect.top - popoverRect.height - 4;
      }
      top = Math.max(4, top);

      reactionPopover.style.left = `${left}px`;
      reactionPopover.style.top = `${top}px`;
    }

    function closeReactionPopover() {
      activeReactionTarget = null;
      reactionPopover.classList.add('hidden');
    }

    function toggleReactionPopover(anchorEl, msgId) {
      if (activeReactionTarget === msgId && !reactionPopover.classList.contains('hidden')) {
        closeReactionPopover();
        return;
      }
      cancelReply();
      openReactionPopover(anchorEl, msgId);
    }

    reactionPopover.querySelectorAll('.chat-reaction-popover-emoji').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        const targetId = activeReactionTarget;
        closeReactionPopover();
        if (targetId && emoji) sendReactionToggle(targetId, emoji);
      });
    });

    document.addEventListener('click', (event) => {
      if (reactionPopover.classList.contains('hidden')) return;
      if (reactionPopover.contains(event.target)) return;
      if (event.target.closest && event.target.closest('.chat-message-action--react')) return;
      closeReactionPopover();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !reactionPopover.classList.contains('hidden')) closeReactionPopover();
    });

    // --- Rate-limit (клиентский, мягкий) — только для текстовых сообщений ---
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
        case 'reaction':
          handleIncomingReaction(envelope);
          break;
        case 'history-request':
          handleHistoryRequest(fromPeerId);
          break;
        case 'history-response':
          handleHistoryResponse(fromPeerId, envelope);
          break;
        default:
          // Неизвестный kind (будущие волны — файлы и т.п.) — молча игнорируем.
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

    function handleIncomingReaction(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      recomputeReactions();
      renderAll(false);
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
        if (!msg || typeof msg !== 'object') continue;
        if (msg.kind !== 'text' && msg.kind !== 'reaction') continue;
        bumpLamportOnReceive(msg.lamport);
        if (insertMessage(msg)) insertedAny = true;
      }
      if (insertedAny) {
        recomputeReactions();
        renderAll(true);
      }
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
        replyTo: replyTarget ? replyTarget.id : null,
        ts: Date.now(),
      };
      textInput.value = '';
      cancelReply();

      // Своё сообщение — сразу и локально, оптимистично (эха от сервера
      // больше нет: путь целиком P2P).
      insertMessage(envelope);
      renderAll(true);

      broadcastEnvelope(envelope);
    }

    function sendReactionToggle(targetMsgId, emoji) {
      if (!signaling || !bus) return;
      const already = reactions.get(targetMsgId)?.get(emoji)?.has(peerId) || false;
      const op = already ? 'remove' : 'add';

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'reaction',
        target: targetMsgId,
        emoji,
        op,
        ts: Date.now(),
      };

      if (insertMessage(envelope)) {
        recomputeReactions();
        renderAll(false);
      }

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
