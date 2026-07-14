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
// Ш1 (E2E-шифрование, см. static/crypto.js): по шине конверт уходит КАК ЕСТЬ
// (P2P DataChannel уже E2E за счёт DTLS) — а вот в fallback-пути через
// сервер конверт целиком шифруется под K_chat, выведенный из ключа комнаты
// (см. static/room.js): на проводе вместо открытого конверта уходит
// {enc:{v,iv,ct}} (см. sendEnvelopeToPeer/attach ниже) — сервер видит только
// непрозрачный блоб, как и остальной сигналинг-релей.
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
// Редактирование и удаление — тем же приёмом (производное состояние,
// пересчитываемое из буфера), тот же общий буфер истории/транспорт:
//   { v: 1, id, lamport, from, name, kind: 'edit', target, text, ts }
//   { v: 1, id, lamport, from, name, kind: 'delete', target, ts }
// `target` — id сообщения (text или file-offer), которое правят/удаляют.
// Конверт применяется, ТОЛЬКО ЕСЛИ envelope.from совпадает с `from`
// оригинального сообщения (иначе молча игнорируется — см.
// recomputeMessageMeta); оригинал ищется в том же буфере `messages`, поэтому
// если он уже вытеснен из HISTORY_CAP, авторство проверить нечем и правка/
// удаление тоже игнорируются (безопасный дефолт). 'edit' применим только к
// kind='text' (у file-offer текста нет, редактировать нечего). Несколько
// edit-конвертов на один target — побеждает последний в порядке (lamport,
// from), т.к. `messages` уже отсортирован этим же компаратором и пересчёт
// просто идёт по порядку, перезаписывая предыдущее значение (тот же приём,
// что и в recomputeReactions). 'delete' на target — финальное состояние:
// как только валидный delete применён, ПОСЛЕДУЮЩИЕ (с бОльшим lamport) edit
// на тот же target больше не применяются — удаление их не отменяет.
// edit/delete-конверты хранятся в общем буфере 50 наравне с text/reaction/
// file-offer и точно так же уезжают опоздавшим в history-response —
// опоздавший пересчитывает то же самое messageOverlays по всему реплею и
// поэтому сразу видит финальное состояние (отредактированный текст или
// тумбстоун), а не оригинал.
//
// Передача файлов (Ф3) — строго P2P, сервер байты файла никогда не видит:
//   { v: 1, id, lamport, from, name, kind: 'file-offer', fileId, fileName,
//     size, mime, ts }
// Оффер — обычный конверт по тому же транспорту (broadcast по шине +
// fallback через сервер) и в том же общем буфере истории, что text/reaction
// — опоздавший видит карточку файла из реплея истории точно так же, как
// историческое текстовое сообщение (см. mergeHistory). Сам файл (File-объект)
// живёт только у отправителя, в памяти вкладки (fileSendMap: fileId -> File)
// — сервер и буфер истории носят только метаданные, не содержимое.
//
// Получатель, чтобы реально скачать файл, шлёт АДРЕСНЫЙ (не broadcast)
// конверт отправителю:
//   { v: 1, id, lamport, from, name, kind: 'file-request', fileId, ts }
// Этот kind никогда не попадает в буфер истории (транзитный, как
// history-request/response). Получив его, отправитель (если ещё держит File
// с таким fileId) открывает ОТДЕЛЬНЫЙ DataChannel на существующем
// RTCPeerConnection этой пары — pc.createDataChannel(`file-${fileId}-${кому}`)
// — получатель ловит его через pc.ondatachannel по точному совпадению label
// (см. RtcPeer.createFileChannel/onFileChannel в rtc.js). Первым сообщением
// канала идёт JSON-мета { fileId, size, mime, name }, дальше — бинарные чанки
// по FILE_CHUNK_SIZE байт (ArrayBuffer), с backpressure по bufferedAmount;
// отправитель закрывает канал по завершении, получатель собирает Blob и
// сверяет итоговый размер. Оффер без P2P-канала до отправителя (fallback-пара
// или отправитель уже вышел) — карточка честно показывает недоступность
// вместо попытки скачивания через сервер (сервер байты файла не гоняет
// НИКОГДА — см. handleFileRequest/requestFileDownload/beginSendingFile/
// beginReceivingFile ниже).
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
//
// Анонимность: поля ввода имени в шапке чата больше нет — имя фиксируется
// один раз за сессию модалкой входа комнаты (см. static/room.js) и передаётся
// сюда параметром `name` в ChatPanel.create()/attach(). Никакого
// localStorage/sessionStorage здесь и во всём файле нет.
//
// Права гостей (см. docs/permissions-and-leader.md, «Chat — Partially
// Server-Enforced»): при `guestChat=false` инпут дизейблится (см. room.js:
// ChatPanel.setChatForbidden) и получатели игнорируют входящие
// 'text'/'file-offer' конверты от НЕ-лидеров (см. dispatchEnvelope ниже) —
// и по шине, и по серверному fallback, единая точка входа. Это кооперативная
// защита: модифицированный клиент получателя может её игнорировать и
// отрендерить конверт всё равно (сервер P2P-трафик не видит и проверить не
// может) — так и задумано, см. docs/permissions-and-leader.md.
//
// H3 — привязка личности (identity binding): envelope.from — САМОЗАЯВЛЕННОЕ
// поле, отправитель волен вписать туда что угодно (в т.ч. чужой peerId).
// Транспорт (и шина, и серверный fallback-релей) при этом ЗНАЕТ истинного
// отправителя независимо от содержимого конверта: по шине это peerId той
// самой пары RtcPeer, чей DataChannel принёс сообщение (см. bus.js:
// _dispatch(peerId, obj), room.js: onBusMessage), по fallback — peerId,
// который сервер сам проставляет из идентичности WS-соединения (см.
// src/ws.rs: relay(), поле `from` в ServerMessage::Chat строится из
// `ctx.peer_id` контекста подключения, а не из чего-либо, присланного
// клиентом) — в обоих случаях `fromPeerId`, приходящий в dispatchEnvelope
// НИЖЕ, подделать нельзя (не самозаявленный, а транспортный факт).
// Без сверки этих двух источников правды ЛЮБОЙ участник мог бы прислать
// text/reaction/edit/delete/file-offer с envelope.from = чужой peerId и
// отрендериться (или отредактировать/удалить чужое сообщение — см.
// recomputeMessageMeta) от чужого имени: рендер и проверка авторства
// edit/delete брали именно envelope.from, а сверки с истинным отправителем
// не было вовсе. Решение — НОРМАЛИЗАЦИЯ, а не отказ: dispatchEnvelope
// принудительно перезаписывает envelope.from = fromPeerId (транспортный,
// истинный) ДО какой-либо обработки, для всех kind, несущих авторство (см.
// SELF_ASSERTED_FROM_KINDS ниже) — так самозаявленное поле физически не
// может разойтись с истиной к моменту, когда до него дотянется рендер или
// recomputeMessageMeta/recomputeReactions. Отказ (reject) был бы проще, но
// нормализация надёжнее: она чинит поле для ВСЕХ последующих потребителей
// (истории, реплаев, "own"-классификации в renderMessageEl) одним изменением
// в одной точке входа, а не заставляет каждого потребителя дублировать
// сверку самостоятельно.
//
// history-response — намеренное ИСКЛЮЧЕНИЕ из этой нормализации: сам конверт
// history-response несёт `from` ответившего (это нормализуется как обычно —
// он kind='history-response', не входит в SELF_ASSERTED_FROM_KINDS, но и не
// нуждается: авторство самого ответа проверяется отдельно, см.
// handleHistoryResponse — resolve срабатывает только для fromPeerId, которого
// мы САМИ запросили, см. historyResponseWaiters), а вот `messages` внутри —
// чужие исторические конверты, вложенные как ДАННЫЕ, а не как "письмо от
// меня": тот, кто отвечает на history-request, не является их автором, и
// нормализовать их `from` на fromPeerId ответившего было бы неверно —
// потеряли бы разницу между "кто ответил" и "кто написал". mergeHistory (см.
// ниже) поэтому НЕ проверяет авторство вложенных сообщений против транспорта
// — это известное, осознанное ограничение кооперативной модели (тот, кто
// отвечает на history-request, технически может вложить исторический
// конверт с любым `from`, включая чужой) — того же порядка допущение, что и
// остальные кооперативные защиты этого файла (модифицированный клиент может
// солгать, сервер P2P-байты не видит и не проверяет).

'use strict';

const ChatPanel = (() => {
  const NEAR_BOTTOM_THRESHOLD = 32; // px
  const HISTORY_CAP = 50;
  const HISTORY_REQUEST_TIMEOUT_MS = 3000;
  const RATE_LIMIT_COUNT = 10;
  const RATE_LIMIT_WINDOW_MS = 10_000;
  const REPLY_PREVIEW_MAX_LEN = 60;
  const HIGHLIGHT_DURATION_MS = 1200;
  const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '😮', '😢'];

  // --- Передача файлов (Ф3) ---
  const FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024; // 25МБ — жёсткий лимит на файл
  const FILE_CHUNK_SIZE = 16 * 1024; // 16КБ на чанк
  const FILE_BUFFERED_LOW_THRESHOLD = 256 * 1024; // bufferedamountlow срабатывает ниже этого
  const FILE_BUFFERED_HIGH_WATERMARK = 1024 * 1024; // ждём слива, если накопилось больше
  const AUTO_DOWNLOAD_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // авто-скачивание картинок ≤2МБ
  const FILE_REQUEST_TIMEOUT_MS = 8000; // сколько ждём открытия файлового канала после запроса

  // Статичная, не зависящая от пользовательских данных разметка — безопасна
  // для innerHTML (см. критичное требование к рендеру сообщений выше, оно
  // касается ТОЛЬКО пользовательского текста).
  const REPLY_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="9 14 4 9 9 4"></polyline>
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H13"></path>
  </svg>`;

  const ATTACH_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
  </svg>`;

  // Редактирование/удаление своих сообщений — кнопки в .chat-message-actions
  // (см. renderMessageEl/renderFileOfferEl), тот же стиль SVG-иконок, что и
  // REPLY_ICON_SVG выше.
  const EDIT_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>`;
  const DELETE_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    <line x1="10" y1="11" x2="10" y2="17"></line>
    <line x1="14" y1="11" x2="14" y2="17"></line>
  </svg>`;
  // Сколько ждём второй (подтверждающий) клик по кнопке удаления, прежде чем
  // откатить её обратно в исходное состояние (см. buildDeleteButton).
  const DELETE_CONFIRM_MS = 3000;

  // Иконки файловой карточки по категории mime — статичная разметка, не
  // зависит от пользовательских данных, безопасна для innerHTML.
  const FILE_ICON_IMAGE_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <path d="M21 15l-5-5L5 21"></path>
  </svg>`;
  const FILE_ICON_AUDIO_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13"></path>
    <circle cx="6" cy="18" r="3"></circle>
    <circle cx="18" cy="16" r="3"></circle>
  </svg>`;
  const FILE_ICON_GENERIC_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>`;

  function fileIconSvgForMime(mime) {
    const m = String(mime || '');
    if (m.startsWith('image/')) return FILE_ICON_IMAGE_SVG;
    if (m.startsWith('audio/')) return FILE_ICON_AUDIO_SVG;
    return FILE_ICON_GENERIC_SVG;
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

  /**
   * Убрать markdown-маркеры (**жирный**, *курсив*, ~~зачёркнутый~~, "> "
   * цитата) из текста для PLAIN-TEXT превью — реплай-плашка над инпутом
   * (startReply) и цитата оригинала в самом сообщении (buildReplyQuoteEl) не
   * рендерят разметку (места мало, важнее компактность), поэтому маркеры не
   * должны "протекать" в них сырыми звёздочками. Тот же синтаксис, что
   * renderMessageBody/INLINE_MD_RE рендерят полноценно — здесь просто снятие
   * маркеров, без построения DOM. Переводы строк схлопываются в пробел —
   * превью однострочное.
   */
  function stripMarkdownForPreview(text) {
    return String(text || '')
      .split('\n')
      .map((line) => (line.startsWith('> ') ? line.slice(2) : line))
      .join(' ')
      .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, '$1')
      .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '$1')
      .replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, '$1');
  }

  /** CSS.escape с фоллбэком — как в scrollToMessageAndHighlight, вынесено сюда для переиспользования файловыми карточками. */
  function escapeForSelector(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
  }

  /** Человекочитаемый размер файла: "512 Б", "12.3 КБ", "1.4 МБ" и т.п. */
  function humanFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} Б`;
    const units = ['КБ', 'МБ', 'ГБ'];
    let value = n / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
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
      <div class="chat-edit-bar hidden">
        <span class="chat-edit-bar-label">Редактирование</span>
        <button type="button" class="chat-edit-bar-close" aria-label="Отменить редактирование" title="Отменить редактирование">×</button>
      </div>
      <div class="chat-input-row">
        <button type="button" class="chat-attach-button" aria-label="Прикрепить файл" title="Прикрепить файл"></button>
        <input type="file" class="chat-file-input" multiple hidden />
        <textarea class="chat-text-input" rows="1" placeholder="Сообщение…" maxlength="2000"></textarea>
        <button type="button" class="chat-send-button" aria-label="Отправить" title="Отправить">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    `;
    panel.querySelector('.chat-attach-button').innerHTML = ATTACH_ICON_SVG; // статичная разметка

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
      collapseButton: panel.querySelector('.chat-collapse-button'),
      messagesEl: panel.querySelector('.chat-messages'),
      errorBanner: panel.querySelector('.chat-error-banner'),
      replyBar: panel.querySelector('.chat-reply-bar'),
      replyBarText: panel.querySelector('.chat-reply-bar-text'),
      replyBarClose: panel.querySelector('.chat-reply-bar-close'),
      editBar: panel.querySelector('.chat-edit-bar'),
      editBarClose: panel.querySelector('.chat-edit-bar-close'),
      reactionPopover,
      textInput: panel.querySelector('.chat-text-input'),
      sendButton: panel.querySelector('.chat-send-button'),
      attachButton: panel.querySelector('.chat-attach-button'),
      fileInput: panel.querySelector('.chat-file-input'),
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
  function create({
    signaling,
    bus,
    peerId,
    name,
    variant,
    toggleButton,
    getPeerIds,
    initialPeerIds,
    getLeaderId,
    getGuestChatAllowed,
    chatKey,
  }) {
    if (!singleton) {
      const dom = buildDom(variant, toggleButton);
      singleton = createController(dom);
    }
    singleton.attach({ signaling, bus, peerId, name, getPeerIds, initialPeerIds, getLeaderId, getGuestChatAllowed, chatKey });
    return singleton.publicApi;
  }

  function createController(dom) {
    const {
      toggleButton,
      panel,
      unreadBadge,
      collapseButton,
      messagesEl,
      errorBanner,
      replyBar,
      replyBarText,
      replyBarClose,
      editBar,
      editBarClose,
      reactionPopover,
      textInput,
      sendButton,
      attachButton,
      fileInput,
    } = dom;

    let signaling = null;
    let bus = null;
    let peerId = null;
    let myName = null;
    // Ш1 (E2E-шифрование): K_chat, выведенный из ключа комнаты (см.
    // static/crypto.js/room.js) — используется ТОЛЬКО для серверного
    // fallback-релея (см. sendEnvelopeToPeer/attach ниже), по шине конверт
    // не шифруется этим слоем.
    let chatKey = null;
    let getPeerIds = () => [];
    // Права гостей (см. docs/permissions-and-leader.md, «Chat — Partially
    // Server-Enforced»): getLeaderId/getGuestChatAllowed
    // — колбэки room.js, читающие ЖИВЫЕ leaderId/roomSettings.guestChat на
    // момент вызова (не снимок на момент attach) — используются в
    // isIncomingEnvelopeAllowed ниже для игнорирования входящих text/file-offer
    // конвертов от не-лидеров, когда guestChat=false (см. заголовок файла).
    let getLeaderId = () => null;
    let getGuestChatAllowed = () => true;
    let unreadCount = 0;
    let errorTimer = null;
    // Отправку (СВОЙ инпут) дизейблит room.js через publicApi.setChatForbidden
    // при guestChat=false — независимо от connectionLost (см. disableInput/
    // enableInput ниже), оба состояния учитываются вместе в applyInputState.
    let connectionLost = false;
    let forbiddenByLeader = false;

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
    // msgId -> { deleted: boolean, editText: string|null } — производное
    // состояние редактирования/удаления, тоже всегда пересчитывается заново
    // из `messages` (см. recomputeMessageMeta), см. комментарий в шапке файла.
    let messageOverlays = new Map();
    let sendTimes = []; // клиентский rate-limit: метки времени своих отправок
    let historyResponseWaiters = new Map(); // peerId -> resolve(messages[])
    let replyTarget = null; // конверт сообщения, на которое сейчас отвечаем (или null)
    let editTarget = null; // конверт СВОЕГО сообщения, которое сейчас редактируем (или null) — взаимоисключается с replyTarget
    let activeReactionTarget = null; // msgId, для которого сейчас открыт попап реакций (или null)

    // --- Состояние передачи файлов (Ф3) ---
    // fileId -> File — файлы, которые МЫ отправили (держим, пока живёт вкладка/сессия),
    // чтобы ответить на file-request отправкой по отдельному DataChannel.
    let fileSendMap = new Map();
    // fileId -> { status, progress, objectUrl, blobSize } — производное состояние
    // карточки файла (и как отправителя, и как получателя), не хранится в конверте.
    // status: 'offer' | 'requesting' | 'transferring' | 'sending' | 'sent' | 'done'
    //       | 'unavailable' | 'no-p2p' | 'failed'.
    let fileStates = new Map();
    // fileId -> { targetPeerId, expectedLabel, mime, name, size } — запрос на
    // скачивание, которого мы ждём (открытия входящего файлового DataChannel).
    let pendingFileRequests = new Map();

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

    /** Найти ЛЮБОЕ редактируемое/удаляемое сообщение (text или file-offer) по id — для проверки авторства edit/delete. */
    function findEditableOriginalById(id) {
      for (const msg of messages) {
        if ((msg.kind === 'text' || msg.kind === 'file-offer') && msg.id === id) return msg;
      }
      return null;
    }

    /**
     * Пересчитать map редактирования/удаления с нуля из `messages` — тот же
     * приём, что и recomputeReactions: буфер уже отсортирован по (lamport,
     * from), поэтому просто идём по порядку и перезаписываем состояние
     * последним валидным edit/delete на каждый target (см. заголовок файла).
     * Валидация авторства — envelope.from должен совпасть с from оригинала;
     * оригинал не найден (уже вытеснен из HISTORY_CAP) — конверт игнорируется
     * (безопасный дефолт, см. заголовок файла). Как только на target применён
     * delete — последующие (с бОльшим lamport) edit больше не рассматриваются:
     * удаление финально и не отменяется правками.
     */
    function recomputeMessageMeta() {
      const next = new Map();
      for (const msg of messages) {
        if (msg.kind !== 'edit' && msg.kind !== 'delete') continue;
        if (!msg.target || !msg.from) continue;
        const original = findEditableOriginalById(msg.target);
        if (!original || original.from !== msg.from) continue; // не автор оригинала (или оригинал уже недоступен) — игнор
        let overlay = next.get(msg.target);
        if (!overlay) {
          overlay = { deleted: false, editText: null };
          next.set(msg.target, overlay);
        }
        if (overlay.deleted) continue; // удаление уже применено — последующие правки его не отменяют
        if (msg.kind === 'delete') {
          overlay.deleted = true;
          overlay.editText = null;
        } else if (original.kind === 'text' && typeof msg.text === 'string') {
          // 'edit' применим только к тексту — у file-offer текста нет.
          overlay.editText = msg.text;
        }
      }
      messageOverlays = next;
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
      const overlay = messageOverlays.get(targetId);
      const nameEl = document.createElement('span');
      nameEl.className = 'chat-reply-quote-name';
      nameEl.textContent = displayName(original);
      const textEl = document.createElement('span');
      textEl.className = 'chat-reply-quote-text';
      if (overlay && overlay.deleted) {
        textEl.textContent = 'Сообщение удалено';
      } else {
        const bodyText = overlay && typeof overlay.editText === 'string' ? overlay.editText : original.text;
        textEl.textContent = truncateText(stripMarkdownForPreview(bodyText), REPLY_PREVIEW_MAX_LEN);
      }
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

    /** `overlay` — messageOverlays.get(msg.id), передаётся вызывающей стороной, чтобы не пересчитывать/переискать здесь. */
    function buildMetaEl(msg, overlay) {
      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName(msg);
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(msg.ts || Date.now());
      meta.appendChild(nameSpan);
      meta.appendChild(timeSpan);
      if (overlay && !overlay.deleted && typeof overlay.editText === 'string') {
        const editedSpan = document.createElement('span');
        editedSpan.className = 'chat-message-meta-edited';
        editedSpan.textContent = '(изменено)';
        meta.appendChild(editedSpan);
      }
      return meta;
    }

    function renderMessageEl(msg) {
      const own = msg.from === peerId;
      const overlay = messageOverlays.get(msg.id);
      const isDeleted = !!(overlay && overlay.deleted);

      const item = document.createElement('div');
      item.className =
        'chat-message' + (own ? ' chat-message--own' : '') + (isDeleted ? ' chat-message--deleted' : '');
      item.dataset.msgId = msg.id;

      // Тумбстоуну действия (ответить/реакция/редактировать/удалить) не положены.
      if (!isDeleted) {
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

        if (own) {
          actions.appendChild(buildEditButton(msg));
          actions.appendChild(buildDeleteButton(msg));
        }

        item.appendChild(actions);
      }

      item.appendChild(buildMetaEl(msg, overlay));

      if (msg.replyTo) {
        item.appendChild(buildReplyQuoteEl(msg.replyTo));
      }

      const text = document.createElement('div');
      text.className = 'chat-message-text';
      if (isDeleted) {
        text.classList.add('chat-message-text--deleted');
        text.textContent = 'Сообщение удалено';
      } else {
        const bodyText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
        renderMessageBody(text, bodyText);
      }
      item.appendChild(text);

      if (!isDeleted) {
        const reactionsRow = buildReactionsRowEl(msg.id);
        if (reactionsRow) item.appendChild(reactionsRow);
      }

      messagesEl.appendChild(item);
    }

    /** Карандаш — только на СВОИХ text-сообщениях (см. renderMessageEl); file-offer редактировать нельзя. */
    function buildEditButton(msg) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-message-action chat-message-action--edit';
      btn.setAttribute('aria-label', 'Редактировать');
      btn.title = 'Редактировать';
      btn.innerHTML = EDIT_ICON_SVG; // статичная разметка, не пользовательские данные
      btn.addEventListener('click', () => startEdit(msg));
      return btn;
    }

    /**
     * Корзина — на СВОИХ text- и file-offer-сообщениях. Первый клик переводит
     * кнопку в состояние подтверждения («✓?») на DELETE_CONFIRM_MS; второй
     * клик в этом окне шлёт delete; таймаут без второго клика — откат в
     * исходную иконку без отправки чего-либо.
     */
    function buildDeleteButton(msg) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-message-action chat-message-action--delete';
      btn.setAttribute('aria-label', 'Удалить');
      btn.title = 'Удалить';
      btn.innerHTML = DELETE_ICON_SVG; // статичная разметка, не пользовательские данные
      let confirmTimer = null;

      function resetToIdle() {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        btn.classList.remove('chat-message-action--confirm');
        btn.innerHTML = DELETE_ICON_SVG;
        btn.setAttribute('aria-label', 'Удалить');
        btn.title = 'Удалить';
      }

      btn.addEventListener('click', () => {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
          sendDeleteMessage(msg.id);
          return;
        }
        btn.classList.add('chat-message-action--confirm');
        btn.textContent = '✓?';
        btn.setAttribute('aria-label', 'Подтвердите удаление');
        btn.title = 'Нажмите ещё раз, чтобы подтвердить удаление';
        confirmTimer = setTimeout(resetToIdle, DELETE_CONFIRM_MS);
      });

      return btn;
    }

    // --- Рендер карточки файла (Ф3) — kind='file-offer' ---
    //
    // В отличие от текстовых сообщений, тело карточки зависит не только от
    // самого конверта (он неизменен), но и от производного состояния
    // fileStates (запрошен ли файл, идёт ли передача, готов ли Blob) —
    // поэтому тело строит отдельная renderFileCardBody(), вызываемая и при
    // первом рендере, и при каждом смене статуса (см. setFileStatus).
    // Прогресс внутри одного статуса обновляется точечно (setFileProgress),
    // без пересборки DOM — иначе на каждый чанк (их могут быть сотни) была
    // бы дорогая полная пересборка карточки.
    function renderFileOfferEl(msg) {
      const own = msg.from === peerId;
      const overlay = messageOverlays.get(msg.id);
      const isDeleted = !!(overlay && overlay.deleted);

      const item = document.createElement('div');
      item.className =
        'chat-message chat-message--file' +
        (own ? ' chat-message--own' : '') +
        (isDeleted ? ' chat-message--deleted' : '');
      item.dataset.msgId = msg.id;

      // Файловые офферы удалять можно (тумбстоун ниже), редактировать —
      // нет (см. заголовок файла), поэтому в actions только корзина, и
      // только пока не удалено.
      if (!isDeleted && own) {
        const actions = document.createElement('div');
        actions.className = 'chat-message-actions';
        actions.appendChild(buildDeleteButton(msg));
        item.appendChild(actions);
      }

      item.appendChild(buildMetaEl(msg, overlay));

      if (isDeleted) {
        // Тумбстоун вместо карточки. ВАЖНО: удаление офера — это только
        // сокрытие карточки в ленте, оно НЕ отзывает уже переданные/принятые
        // копии файла — получатели, успевшие скачать (Blob/objectUrl) до
        // удаления, сохраняют доступ к своей локальной копии; это ожидаемое
        // поведение строго P2P-модели (сервер файл не хранит и отозвать
        // нечего, см. заголовок файла про Ф3).
        const text = document.createElement('div');
        text.className = 'chat-message-text chat-message-text--deleted';
        text.textContent = 'Сообщение удалено';
        item.appendChild(text);
        messagesEl.appendChild(item);
        return;
      }

      const card = document.createElement('div');
      card.className = 'chat-file-card';
      item.appendChild(card);
      renderFileCardBody(card, msg, own);

      messagesEl.appendChild(item);
    }

    /** Найти конверт file-offer по fileId в текущем буфере (для точечных обновлений статуса/прогресса). */
    function findFileOfferByFileId(fileId) {
      for (const msg of messages) {
        if (msg.kind === 'file-offer' && msg.fileId === fileId) return msg;
      }
      return null;
    }

    function fileCardHeaderEl(msg) {
      const header = document.createElement('div');
      header.className = 'chat-file-header';

      const icon = document.createElement('span');
      icon.className = 'chat-file-icon';
      icon.innerHTML = fileIconSvgForMime(msg.mime); // статичный набор SVG по категории mime, не пользовательские данные

      const info = document.createElement('div');
      info.className = 'chat-file-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'chat-file-name';
      nameEl.textContent = msg.fileName;
      nameEl.title = msg.fileName;
      const sizeEl = document.createElement('div');
      sizeEl.className = 'chat-file-size';
      sizeEl.textContent = humanFileSize(msg.size);
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      header.appendChild(icon);
      header.appendChild(info);
      return header;
    }

    function fileProgressEl(fileId, fraction) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-file-progress';
      const bar = document.createElement('div');
      bar.className = 'chat-file-progress-bar';
      bar.dataset.fileId = fileId;
      bar.style.width = `${Math.round((fraction || 0) * 100)}%`;
      wrap.appendChild(bar);
      return wrap;
    }

    /** Перестроить содержимое карточки `card` из msg + текущего fileStates.get(msg.fileId). */
    function renderFileCardBody(card, msg, own) {
      card.textContent = '';
      const state = fileStates.get(msg.fileId) || { status: 'offer', progress: 0 };

      if (state.status === 'done' && state.objectUrl) {
        renderFileDoneBody(card, msg, state);
        return;
      }

      card.appendChild(fileCardHeaderEl(msg));

      if (state.status === 'requesting' || state.status === 'transferring' || state.status === 'sending') {
        card.appendChild(fileProgressEl(msg.fileId, state.progress));
        return;
      }

      if (state.status === 'unavailable') {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Отправитель недоступен';
        card.appendChild(note);
        return;
      }

      if (state.status === 'failed') {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Не удалось получить файл';
        card.appendChild(note);
        if (!own) {
          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'chat-file-download-button';
          retryButton.textContent = 'Повторить';
          retryButton.addEventListener('click', () => requestFileDownload(msg));
          card.appendChild(retryButton);
        }
        return;
      }

      // status === 'offer' (или 'sent'/начальное состояние без записи) —
      // ничего не запрошено/отправлено ещё: своя карточка — просто
      // информация, чужая — кнопка «Скачать» (либо пояснение недоступности).
      if (own) return;

      if (!getPeerIds().includes(msg.from)) {
        const note = document.createElement('div');
        note.className = 'chat-file-note';
        note.textContent = 'Отправитель недоступен';
        card.appendChild(note);
        return;
      }

      if (!bus.isOpen(msg.from)) {
        const note = document.createElement('div');
        note.className = 'chat-file-download-button chat-file-download-button--disabled';
        note.textContent = 'Недоступно: нет прямого соединения';
        note.title = 'Между вами и отправителем нет прямого P2P-соединения — передача файлов работает только напрямую, через сервер файлы не передаются.';
        card.appendChild(note);
        return;
      }

      const downloadButton = document.createElement('button');
      downloadButton.type = 'button';
      downloadButton.className = 'chat-file-download-button';
      downloadButton.textContent = 'Скачать';
      downloadButton.addEventListener('click', () => requestFileDownload(msg));
      card.appendChild(downloadButton);
    }

    /** Финальный вид готовой (status='done') карточки: превью картинки / audio-плеер / ссылка-скачивание. */
    function renderFileDoneBody(card, msg, state) {
      const mime = msg.mime || '';
      if (mime.startsWith('image/')) {
        const link = document.createElement('a');
        link.href = state.objectUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.className = 'chat-file-image';
        img.src = state.objectUrl;
        img.alt = msg.fileName;
        link.appendChild(img);
        card.appendChild(link);
        return;
      }
      if (mime.startsWith('audio/')) {
        card.appendChild(fileCardHeaderEl(msg));
        const audio = document.createElement('audio');
        audio.className = 'chat-file-audio';
        audio.controls = true;
        audio.src = state.objectUrl;
        card.appendChild(audio);
        return;
      }
      card.appendChild(fileCardHeaderEl(msg));
      const link = document.createElement('a');
      link.className = 'chat-file-download-link';
      link.href = state.objectUrl;
      link.download = msg.fileName;
      link.textContent = 'Скачать';
      card.appendChild(link);
    }

    /** Точечно обновить только полосу прогресса (без пересборки карточки) — вызывается часто (на каждый чанк). */
    function setFileProgress(fileId, fraction) {
      const state = fileStates.get(fileId);
      if (!state) return;
      state.progress = fraction;
      const bar = messagesEl.querySelector(
        `.chat-file-progress-bar[data-file-id="${escapeForSelector(fileId)}"]`
      );
      if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    }

    /** Сменить статус карточки файла и пересобрать её тело (структурное изменение — не только прогресс). */
    function setFileStatus(fileId, status, extra) {
      const prev = fileStates.get(fileId) || { progress: 0 };
      const next = Object.assign({}, prev, { status }, extra || {});
      fileStates.set(fileId, next);
      const msg = findFileOfferByFileId(fileId);
      if (!msg) return;
      const safeMsgId = escapeForSelector(msg.id);
      const item = messagesEl.querySelector(`.chat-message[data-msg-id="${safeMsgId}"]`);
      if (!item) return; // сейчас не отрисована (например, ушла из HISTORY_CAP) — не страшно
      const card = item.querySelector('.chat-file-card');
      if (card) renderFileCardBody(card, msg, msg.from === peerId);
    }

    /** Перерисовать всю ленту из `messages` (буфер маленький — до 50, полная перерисовка дешевле инкрементальной вставки в середину). Реакции — не самостоятельные пузыри в ленте, только текстовые сообщения и карточки файлов. */
    function renderAll(forceScrollBottom) {
      const wasNearBottom = isNearBottom();
      messagesEl.textContent = '';
      for (const msg of messages) {
        if (msg.kind === 'text') renderMessageEl(msg);
        else if (msg.kind === 'file-offer') renderFileOfferEl(msg);
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
      messageOverlays = new Map();
      lamportClock = 0;
      sendTimes = [];
      historyResponseWaiters = new Map();
      fileSendMap = new Map();
      fileStates = new Map();
      pendingFileRequests = new Map();
      cancelReply();
      cancelEditAndClear();
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
      cancelEditAndClear(); // реплай и редактирование взаимоисключаются (см. заголовок файла)
      replyTarget = msg;
      replyBarText.textContent = `Ответ ${displayName(msg)}: ${truncateText(stripMarkdownForPreview(msg.text), REPLY_PREVIEW_MAX_LEN)}`;
      replyBar.classList.remove('hidden');
      closeReactionPopover();
      textInput.focus();
    }

    function cancelReply() {
      replyTarget = null;
      replyBar.classList.add('hidden');
    }

    replyBarClose.addEventListener('click', cancelReply);

    // --- Редактирование своего сообщения: плашка над инпутом, по образцу
    // реплай-плашки выше, взаимоисключается с ней (см. заголовок файла). ---
    function startEdit(msg) {
      cancelReply();
      editTarget = msg;
      const overlay = messageOverlays.get(msg.id);
      const currentText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
      textInput.value = currentText;
      editBar.classList.remove('hidden');
      closeReactionPopover();
      textInput.focus();
      const len = textInput.value.length;
      textInput.setSelectionRange(len, len); // курсор в конец — иначе браузер ставит его в начало при программной установке value
    }

    function cancelEdit() {
      editTarget = null;
      editBar.classList.add('hidden');
    }

    /** Esc/крестик — отменяет редактирование И очищает textarea (в отличие от cancelReply, который поле ввода не трогает). */
    function cancelEditAndClear() {
      const wasEditing = !!editTarget;
      cancelEdit();
      if (wasEditing) textInput.value = '';
    }

    editBarClose.addEventListener('click', cancelEditAndClear);

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
      if (event.key !== 'Escape') return;
      if (!reactionPopover.classList.contains('hidden')) {
        closeReactionPopover();
        return;
      }
      if (!editBar.classList.contains('hidden')) {
        cancelEditAndClear();
      }
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
        sendEnvelopeToPeer(targetPeerId, envelope);
      }
    }

    /**
     * Отправить конверт ОДНОМУ конкретному пиру (адресно) — та же логика
     * шина/фоллбэк, что и в broadcastEnvelope, но для одного адресата
     * (используется file-request). Ш1 (E2E-шифрование, см. static/crypto.js):
     * по шине конверт уходит КАК ЕСТЬ (P2P DataChannel уже E2E за счёт DTLS,
     * см. static/rtc.js) — а вот серверный fallback шифрует конверт ЦЕЛИКОМ
     * под K_chat, сервер видит только {enc:{v,iv,ct}} вместо содержимого.
     */
    function sendEnvelopeToPeer(targetPeerId, envelope) {
      if (bus.isOpen(targetPeerId)) {
        bus.sendToPeer(targetPeerId, envelope);
      } else {
        RoomCrypto.encrypt(chatKey, envelope).then((enc) => {
          signaling.send('chat', { targetPeerId, envelope: { enc } });
          ConnStats.incFallbackChat();
        });
      }
    }

    /**
     * Права гостей на стороне ПОЛУЧАТЕЛЯ (см. docs/permissions-and-leader.md,
     * «Chat — Partially Server-Enforced», и заголовок файла): при
     * `guestChat=false` входящие 'text'/'file-offer' от
     * кого угодно, кроме текущего лидера, молча игнорируются — и по шине, и
     * по fallback-релею сервера (единая точка входа — dispatchEnvelope).
     * Остальные kind (reaction/edit/delete/history-*) этим ограничением не
     * затрагиваются: это лёгкие производные операции над уже показанными
     * сообщениями, не самостоятельный текст.
     *
     * Кооперативная защита: модифицированный клиент получателя может этот
     * фильтр не применять и отрендерить конверт всё равно — сервер P2P-байты
     * не видит и запретить их доставку физически не может (см.
     * docs/permissions-and-leader.md, «Chat — Partially Server-Enforced»).
     */
    function isIncomingEnvelopeAllowed(fromPeerId, envelope) {
      if (envelope.kind !== 'text' && envelope.kind !== 'file-offer') return true;
      if (getGuestChatAllowed()) return true;
      return fromPeerId === getLeaderId();
    }

    // H3: kind, несущие самозаявленное авторство (envelope.from) — см.
    // разбор в заголовке файла. file-request сюда намеренно НЕ входит: его
    // обработчик (handleFileRequest) и так использует транспортный
    // fromPeerId, а не envelope.from, для решения, кому открывать файловый
    // канал — подмена envelope.from там ничего не даёт злоумышленнику.
    const SELF_ASSERTED_FROM_KINDS = new Set(['text', 'reaction', 'edit', 'delete', 'file-offer']);

    // --- Приём: единая точка для сообщений с шины И с fallback-релея сервера ---
    function dispatchEnvelope(fromPeerId, envelope) {
      if (!envelope || typeof envelope !== 'object' || typeof envelope.kind !== 'string') return;
      // H3: нельзя доверять самозаявленному envelope.from — транспорт знает
      // истину (см. заголовок файла). Перезаписываем ДО isIncomingEnvelopeAllowed
      // и до switch ниже, чтобы ни рендер, ни проверка авторства edit/delete,
      // ни "own"-классификация сообщения не могли увидеть подделанное значение.
      if (SELF_ASSERTED_FROM_KINDS.has(envelope.kind) && typeof fromPeerId === 'string') {
        envelope.from = fromPeerId;
      }
      if (!isIncomingEnvelopeAllowed(fromPeerId, envelope)) return;
      switch (envelope.kind) {
        case 'text':
          handleIncomingText(envelope);
          break;
        case 'reaction':
          handleIncomingReaction(envelope);
          break;
        case 'edit':
        case 'delete':
          handleIncomingEditOrDelete(envelope);
          break;
        case 'file-offer':
          handleIncomingFileOffer(envelope);
          break;
        case 'file-request':
          handleFileRequest(fromPeerId, envelope);
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

    /** kind='edit'|'delete' — авторство проверяется внутри recomputeMessageMeta (см. её заголовок и заголовок файла); чужой from на конверте молча не применится. */
    function handleIncomingEditOrDelete(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      recomputeMessageMeta();
      renderAll(false);
    }

    // --- Передача файлов (Ф3) ---

    function handleIncomingFileOffer(envelope) {
      bumpLamportOnReceive(envelope.lamport);
      const inserted = insertMessage(envelope);
      if (!inserted) return;
      renderAll(false);
      if (panel.classList.contains('hidden')) {
        unreadCount += 1;
        updateUnreadBadge();
      }
      maybeAutoDownloadImage(envelope);
    }

    /** Картинки ≤2МБ скачиваются сами, без клика — только для ЖИВОГО оффера (не для реплея истории у опоздавшего). */
    function maybeAutoDownloadImage(msg) {
      if (msg.from === peerId) return;
      const mime = msg.mime || '';
      if (!mime.startsWith('image/')) return;
      if (!(msg.size <= AUTO_DOWNLOAD_IMAGE_MAX_BYTES)) return;
      requestFileDownload(msg);
    }

    /**
     * Получатель жмёт «Скачать» (или авто для картинок) — шлём адресный
     * file-request отправителю и ждём, что он откроет файловый DataChannel.
     * Идемпотентно: повторный вызов, пока уже что-то происходит/готово, — no-op.
     */
    function requestFileDownload(msg) {
      const fileId = msg.fileId;
      const existing = fileStates.get(fileId);
      if (existing && ['requesting', 'transferring', 'done'].includes(existing.status)) return;

      if (!getPeerIds().includes(msg.from)) {
        setFileStatus(fileId, 'unavailable');
        return;
      }

      const expectedLabel = `file-${fileId}-${peerId}`;
      pendingFileRequests.set(fileId, {
        targetPeerId: msg.from,
        expectedLabel,
        mime: msg.mime,
        name: msg.fileName,
        size: msg.size,
      });
      setFileStatus(fileId, 'requesting', { progress: 0 });

      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'file-request',
        fileId,
        ts: Date.now(),
      };
      sendEnvelopeToPeer(msg.from, envelope);

      setTimeout(() => {
        const state = fileStates.get(fileId);
        if (state && state.status === 'requesting') {
          pendingFileRequests.delete(fileId);
          setFileStatus(fileId, 'unavailable');
        }
      }, FILE_REQUEST_TIMEOUT_MS);
    }

    /** Отправитель получил адресный file-request — если файл ещё у нас, открываем файловый канал этому пиру. */
    function handleFileRequest(fromPeerId, envelope) {
      const file = fileSendMap.get(envelope.fileId);
      if (!file) return; // не мы держим этот файл (или уже неактуально) — молча игнорируем
      beginSendingFile(fromPeerId, file, envelope.fileId);
    }

    function waitForBufferedAmountLow(channel) {
      return new Promise((resolve) => {
        const onLow = () => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
      });
    }

    /**
     * Дождаться, пока весь буфер отправки СЛИТ (bufferedAmount === 0), перед
     * закрытием канала. Грабли (обнаружены эмпирически на файле ~300КБ):
     * channel.close() сразу после серии send() НЕ гарантирует, что уже
     * поставленные в очередь, но ещё физически не отправленные байты долетят
     * до собеседника — при достаточно большом файле (когда синхронный цикл
     * send() успевает поставить в очередь больше одного SCTP-пакета) закрытие
     * обрывает "хвост" данных: получатель стабильно видит receivedBytes=0
     * (закрытие канала успевает раньше самого первого сообщения). Небольшие
     * файлы (умещаются в один пакет) внешне "работали" и без этого ожидания —
     * что и маскировало баг. 'bufferedamountlow' — событие ФРОНТА (срабатывает
     * на переход через порог), поэтому если bufferedAmount успел стать 0 ДО
     * того, как мы подписались, событие уже не придёт — опрашиваем сам
     * bufferedAmount явно, а не полагаемся только на событие.
     */
    function waitForBufferedAmountZero(channel) {
      return new Promise((resolve) => {
        if (channel.bufferedAmount === 0) {
          resolve();
          return;
        }
        const iv = setInterval(() => {
          if (channel.bufferedAmount === 0) {
            clearInterval(iv);
            resolve();
          }
        }, 30);
      });
    }

    /** Отправитель: открыть файловый DataChannel конкретному запросившему пиру и прогнать файл чанками с backpressure. */
    function beginSendingFile(requesterPeerId, file, fileId) {
      const rtc = bus.getPeer(requesterPeerId);
      if (!rtc) return; // пир уже ушёл между запросом и открытием канала

      const label = `file-${fileId}-${requesterPeerId}`;
      let channel;
      try {
        channel = rtc.createFileChannel(label);
      } catch (err) {
        console.error(`Не удалось открыть файловый DataChannel (${label}):`, err);
        return;
      }
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = FILE_BUFFERED_LOW_THRESHOLD;

      setFileStatus(fileId, 'sending', { progress: 0 });

      channel.onerror = (event) => {
        console.error(`Ошибка файлового DataChannel (отдача, fileId=${fileId}):`, event);
      };

      channel.onopen = async () => {
        try {
          channel.send(
            JSON.stringify({
              fileId,
              size: file.size,
              mime: file.type || 'application/octet-stream',
              name: file.name,
            })
          );

          let offset = 0;
          while (offset < file.size) {
            if (channel.bufferedAmount > FILE_BUFFERED_HIGH_WATERMARK) {
              await waitForBufferedAmountLow(channel);
            }
            const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
            const buf = await slice.arrayBuffer();
            channel.send(buf);
            offset += buf.byteLength;
            setFileProgress(fileId, file.size === 0 ? 1 : Math.min(1, offset / file.size));
          }
          setFileStatus(fileId, 'sent', { progress: 1 });
        } catch (err) {
          console.error(`Ошибка отправки файла (fileId=${fileId}):`, err);
        } finally {
          try {
            await waitForBufferedAmountZero(channel);
            channel.close();
          } catch (err) {
            // канал мог уже закрыться/сломаться — не страшно
          }
        }
      };
    }

    /**
     * Получатель: пришёл входящий файловый DataChannel (см. onFileChannel в
     * rtc.js, диспетчеризуется room.js -> publicApi.handleIncomingFileChannel).
     * Матчим по ТОЧНОМУ совпадению label с тем, что сами же и ожидали
     * (сконструирован в requestFileDownload) — парсить fileId/peerId из
     * строки label не нужно (оба id — uuid с дефисами, наивный split был бы
     * неоднозначным).
     */
    function handleIncomingFileChannel(fromPeerId, channel) {
      for (const [fileId, req] of pendingFileRequests) {
        if (req.expectedLabel === channel.label) {
          pendingFileRequests.delete(fileId);
          beginReceivingFile(fileId, channel, req);
          return;
        }
      }
      console.warn('Получен файловый DataChannel без ожидающего запроса, label=', channel.label);
    }

    function beginReceivingFile(fileId, channel, req) {
      channel.binaryType = 'arraybuffer';
      let meta = null;
      const chunks = [];
      let receivedBytes = 0;

      setFileStatus(fileId, 'transferring', { progress: 0 });

      channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            meta = JSON.parse(event.data);
          } catch (err) {
            console.error(`Некорректная JSON-мета файлового канала (fileId=${fileId}):`, event.data, err);
          }
          return;
        }
        const buf = event.data;
        chunks.push(buf);
        receivedBytes += buf.byteLength;
        const total = (meta && meta.size) || req.size || 0;
        setFileProgress(fileId, total > 0 ? Math.min(1, receivedBytes / total) : 0);
      };

      channel.onerror = (event) => {
        console.error(`Ошибка файлового DataChannel (приём, fileId=${fileId}):`, event);
      };

      channel.onclose = () => {
        const total = typeof (meta && meta.size) === 'number' ? meta.size : req.size;
        if (typeof total === 'number' && receivedBytes < total) {
          // Канал закрылся раньше, чем пришли все байты — почти всегда потому,
          // что отправитель вышел из комнаты посреди передачи.
          setFileStatus(fileId, 'unavailable');
          return;
        }
        const blob = new Blob(chunks, { type: (meta && meta.mime) || req.mime || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        setFileStatus(fileId, 'done', { objectUrl, blobSize: blob.size, progress: 1 });
      };
    }

    /** Выбор файлов (скрепка/drag&drop/paste) — проверка лимита размера, оптимистичная своя карточка, broadcast оффера. */
    function handleFilesSelected(fileList) {
      if (!signaling || !bus) return;
      const files = Array.from(fileList || []);
      for (const file of files) {
        if (file.size > FILE_SIZE_LIMIT_BYTES) {
          showError(`Файл «${file.name}» больше 25МБ — не отправлен.`);
          continue;
        }

        const fileId = genId();
        fileSendMap.set(fileId, file);

        lamportClock += 1;
        const envelope = {
          v: 1,
          id: genId(),
          lamport: lamportClock,
          from: peerId,
          name: myName || null,
          kind: 'file-offer',
          fileId,
          fileName: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          ts: Date.now(),
        };

        insertMessage(envelope);
        renderAll(true);
        broadcastEnvelope(envelope);
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

    const KNOWN_HISTORY_KINDS = new Set(['text', 'reaction', 'file-offer', 'edit', 'delete']);

    function mergeHistory(historyMessages) {
      let insertedAny = false;
      for (const msg of historyMessages) {
        if (!msg || typeof msg !== 'object') continue;
        if (!KNOWN_HISTORY_KINDS.has(msg.kind)) continue;
        bumpLamportOnReceive(msg.lamport);
        if (insertMessage(msg)) insertedAny = true;
      }
      if (insertedAny) {
        recomputeReactions();
        recomputeMessageMeta();
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

      // Плашка редактирования открыта — эта отправка правит существующее
      // сообщение (kind='edit'), а не создаёт новое (см. startEdit).
      if (editTarget) {
        sendEditMessage(text);
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

    /** Rate-limit уже проверен в sendCurrentText — единый счётчик на текст и правки. */
    function sendEditMessage(text) {
      const targetId = editTarget.id;
      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'edit',
        target: targetId,
        text,
        ts: Date.now(),
      };
      textInput.value = '';
      cancelEdit();

      if (insertMessage(envelope)) {
        recomputeMessageMeta();
        renderAll(true);
      }
      broadcastEnvelope(envelope);
    }

    /**
     * Вызывается из buildDeleteButton по второму (подтверждающему) клику.
     * Не через клиентский rate-limit (см. заголовок файла: reaction-подобное
     * лёгкое действие с собственным 3-секундным подтверждением через UI, а не
     * полноценная отправка текста).
     */
    function sendDeleteMessage(targetId) {
      lamportClock += 1;
      const envelope = {
        v: 1,
        id: genId(),
        lamport: lamportClock,
        from: peerId,
        name: myName || null,
        kind: 'delete',
        target: targetId,
        ts: Date.now(),
      };

      // Удаляем то, что прямо сейчас редактируем — закрываем плашку и чистим ввод.
      if (editTarget && editTarget.id === targetId) cancelEditAndClear();

      if (insertMessage(envelope)) {
        recomputeMessageMeta();
        renderAll(false);
      }
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

    // --- UI отправки файлов: скрепка, drag&drop, paste картинки из буфера ---
    attachButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      handleFilesSelected(fileInput.files);
      fileInput.value = ''; // сброс — иначе повторный выбор ТОГО ЖЕ файла не даст change
    });

    panel.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    panel.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length > 0) handleFilesSelected(files);
    });

    textInput.addEventListener('paste', (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        handleFilesSelected(files);
      }
    });

    /**
     * Единая точка применения состояния инпута — учитывает ОБА независимых
     * повода дизейблить отправку одновременно (обрыв соединения и запрет
     * лидера, см. заголовок конструктора controller): connectionLost имеет
     * приоритет над forbiddenByLeader просто по порядку проверки (оба и так
     * дают одинаковый визуальный эффект — задизейбленный инпут с поясняющим
     * placeholder).
     */
    function applyInputState() {
      if (connectionLost) {
        textInput.disabled = true;
        sendButton.disabled = true;
        attachButton.disabled = true;
        textInput.placeholder = 'Соединение потеряно.';
        return;
      }
      if (forbiddenByLeader) {
        textInput.disabled = true;
        sendButton.disabled = true;
        attachButton.disabled = true;
        textInput.placeholder = 'Чат запрещён лидером';
        return;
      }
      textInput.disabled = false;
      sendButton.disabled = false;
      attachButton.disabled = false;
      textInput.placeholder = 'Сообщение…';
    }

    function enableInput() {
      connectionLost = false;
      applyInputState();
    }

    function disableInput(reason) {
      connectionLost = true;
      applyInputState();
    }

    /** room.js вызывает при applyGuestEnforcement()/settings-changed (см. docs/permissions-and-leader.md). */
    function setChatForbidden(forbidden) {
      forbiddenByLeader = forbidden;
      applyInputState();
    }

    const publicApi = { disableInput, enableInput, setChatForbidden, handleIncomingFileChannel };

    function handleServerError({ message }) {
      // Ошибки fallback-релея сервера (envelope > 8KB, серверный rate-limit
      // на fallback-пути) — тоже показываем в панели, тем же баннером.
      if (message) showError(message);
    }

    function attach({
      signaling: newSignaling,
      bus: newBus,
      peerId: newPeerId,
      name,
      getPeerIds: newGetPeerIds,
      initialPeerIds,
      getLeaderId: newGetLeaderId,
      getGuestChatAllowed: newGetGuestChatAllowed,
      chatKey: newChatKey,
    }) {
      signaling = newSignaling;
      bus = newBus;
      peerId = newPeerId;
      myName = name || null;
      chatKey = newChatKey || null;
      getPeerIds = typeof newGetPeerIds === 'function' ? newGetPeerIds : () => [];
      getLeaderId = typeof newGetLeaderId === 'function' ? newGetLeaderId : () => null;
      getGuestChatAllowed = typeof newGetGuestChatAllowed === 'function' ? newGetGuestChatAllowed : () => true;

      clearMessages();
      unreadCount = 0;
      updateUnreadBadge();
      errorBanner.classList.add('hidden');
      connectionLost = false;
      forbiddenByLeader = false;
      applyInputState();
      setCollapsed(true);

      bus.onMessage(dispatchEnvelope);
      // Ш1 (E2E-шифрование): фоллбэк-релей сервера несёт конверт как
      // {enc:{v,iv,ct}} (см. sendEnvelopeToPeer выше) — расшифровываем ПЕРЕД
      // dispatchEnvelope; по шине конверт приходит как обычно (не завёрнут).
      // Неверный ключ комнаты/повреждённый блоб — тихо логируем и
      // игнорируем это одно сообщение (не валим всю панель чата — соседние
      // конверты по шине продолжают работать как ни в чём не бывало).
      signaling.on('chat', ({ fromPeerId, envelope }) => {
        if (envelope && typeof envelope === 'object' && envelope.enc) {
          RoomCrypto.decrypt(chatKey, envelope.enc)
            .then((plain) => dispatchEnvelope(fromPeerId, plain))
            .catch((err) => {
              console.warn('Не удалось расшифровать fallback-конверт чата (неверный ключ комнаты?):', err);
            });
        } else {
          dispatchEnvelope(fromPeerId, envelope);
        }
      });
      signaling.on('error', handleServerError);

      const candidates = Array.isArray(initialPeerIds) ? initialPeerIds.slice() : [];
      if (candidates.length > 0) {
        requestHistorySequential(candidates);
      }
      // Пустая комната (candidates пуст) — спрашивать не у кого, история пуста.
    }

    return { attach, publicApi };
  }

  return { create };
})();
