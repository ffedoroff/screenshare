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
// {enc:{v,iv,ct}, epoch} (см. sendEnvelopeToPeer/attach ниже) — сервер видит
// только непрозрачный блоб + номер эпохи, как и остальной сигналинг-релей.
//
// Ш3 (forward secrecy контента при смене состава, см.
// docs/e2e-encryption.md §7): K_chat не один статичный ключ на всю сессию —
// лидер комнаты может выпустить НОВУЮ эпоху (при уходе участника/отказе в
// лобби), после чего этот fallback-путь шифрует ИСХОДЯЩЕЕ под новой эпохой, а
// ВХОДЯЩЕЕ расшифровывает ключом ТОЙ эпохи, что указана в самом конверте
// (`epoch`, открытым текстом рядом с `enc` — иначе получателю нечем было бы
// выбрать нужный ключ ДО расшифровки). Участник, уже покинувший комнату (или
// отклонённый в лобби), никогда не получает ключ новой эпохи (раздача —
// строго по P2P-шине, см. static/room.js: rotateContentKeysIfLeader) — вот
// он, весь выигрыш: то, что отправлено в fallback-путь ПОСЛЕ его ухода, он
// прочитать не может, даже если бы каким-то образом снова слушал трафик
// сервера. P2P-путь по шине этим слоем не защищается и не нуждается в этом —
// см. заголовок выше про DTLS.
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
// ниже (Ф4, Telegram-подобный синтаксис, двойные маркеры): **жирный**,
// __курсив__ И *курсив* (обе формы), ~~зачёркнутый~~, ||спойлер|| (блюр,
// раскрытие по клику/Enter/Space — класс .revealed), `инлайн-код` (не
// разбирается дальше), тройные бэктики ```[lang]\n...\n``` — блок кода
// (<pre><code>, метка языка, кнопка «копировать», внутри тоже не
// разбирается), "> " в начале строки — блок-цитата (уже было), http(s)-ссылки
// и именованные [текст](url)-ссылки кликабельны без карточек-превью — никаких
// сетевых запросов по ссылке ради приватности. Вложенность — где осмысленно
// (форматирование внутри цитаты и внутри спойлера — оба рекурсивно прогоняют
// свой контент через appendInlineNodes), но НЕ внутри инлайн-кода/код-блока
// (код есть код). КРИТИЧНО: рендер строит DOM-ноды через
// createElement/textContent — никакого innerHTML с пользовательскими данными
// нигде в этом файле (innerHTML используется только для статичной, не
// зависящей от пользовательского ввода разметки — сама панель и попап
// реакций). Десктопные горячие клавиши для этих же маркеров — см.
// wrapSelectionWithMarkers/handleFormattingShortcut ниже (Cmd/Ctrl+B/I,
// Cmd/Ctrl+Shift+X/P/M/K); мобильный тулбар по выделению — следующая волна,
// не здесь.
//
// Реплаи — пункт «Ответить» в попапе действий сообщения (см. заголовок ниже,
// раздел про попап) открывает компактную плашку над инпутом; отправка кладёт
// replyTo в конверт. Сообщение с replyTo рендерит над текстом цитату
// оригинала (имя + обрезанный текст) из локального буфера; клик по цитате —
// плавный скролл к оригиналу с кратким подсвечиванием (см.
// scrollToMessageAndHighlight).
//
// Попап действий сообщения (волна 13, заменяет on-tap action-row и
// hover-кнопки прошлых волн целиком, и на мобильном, и на десктопе) — строка
// сообщения в ленте несёт ТОЛЬКО текст/время/чипы реакций, никаких кнопок.
// Клик/тап по самому сообщению открывает единый попап (см.
// openMessagePopover/closeMessagePopover/toggleMessagePopover): на мобильном
// — bottom-sheet снизу экрана, на десктопе — компактная карточка у
// сообщения (см. positionMessagePopoverDesktop). Внутри — палитра
// эмодзи-реакций (тап ставит/снимает реакцию и закрывает попап), разбор
// «кто/чем/когда» уже поставленных реакций (см. buildPopoverReactionsList —
// имя участника берётся тем же способом, что и подпись сообщения, см.
// displayName), и список действий (Ответить/Редактировать[своё,
// text]/Удалить[своё]/Копировать текст, см. populatePopoverActions).
// Одновременно открыт попап только для одного сообщения — activePopoverMsgId.
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
  // Автоувеличение инпута (волна 13, требование «как в Telegram»): textarea
  // растёт по мере строк до этого предела, дальше — внутренний скролл (см.
  // autoGrowTextInput).
  const MAX_INPUT_LINES = 13;
  // Та же граница, что и в style.css (@media (max-width: 640px)) — мобильный
  // UX волны 11 (полноэкранный чат, тап-активация действий сообщения,
  // мобильный тулбар форматирования, см. isMobileLayout/applyVisualViewportSizing
  // ниже) переключается ровно по ней, чтобы JS-состояние и CSS-разметка не
  // расходились на границе ширины.
  const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

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

  // Действие «Копировать текст» в попапе сообщения (см. buildCopyButton).
  const COPY_ICON_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
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
  const FILE_ICON_VIDEO_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="23 7 16 12 23 17 23 7"></polygon>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
  </svg>`;
  const FILE_ICON_GENERIC_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>`;

  function fileIconSvgForMime(mime) {
    const m = String(mime || '');
    if (m.startsWith('image/')) return FILE_ICON_IMAGE_SVG;
    if (m.startsWith('audio/')) return FILE_ICON_AUDIO_SVG;
    if (m.startsWith('video/')) return FILE_ICON_VIDEO_SVG;
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
   * Убрать markdown-маркеры (**жирный**, __курсив__/*курсив*, ~~зачёркнутый~~,
   * ||спойлер||, `код`, ```код-блок```, "> " цитата, [текст](url)) из текста
   * для PLAIN-TEXT превью — реплай-плашка над инпутом (startReply) и цитата
   * оригинала в самом сообщении (buildReplyQuoteEl) не рендерят разметку
   * (места мало, важнее компактность), поэтому маркеры не должны "протекать"
   * в них сырыми звёздочками. Тот же синтаксис, что renderMessageBody/
   * INLINE_MD_RE рендерят полноценно — здесь просто снятие маркеров, без
   * построения DOM. Спойлер намеренно заменяется словом «спойлер», а не
   * своим (скрытым) содержимым — превью не должно "спойлерить" раньше клика
   * пользователя по самому сообщению. Код-блок заменяется своим текстом
   * (переводы строк внутри схлопываются в пробел, как и переводы строк между
   * блоками сообщения) — превью однострочное.
   */
  function stripMarkdownForPreview(text) {
    let result = String(text || '').replace(/```[^\n`]*\n([\s\S]*?)```/g, (_, code) =>
      code.replace(/\n/g, ' ').trim()
    );
    result = result
      .split('\n')
      .map((line) => (line.startsWith('> ') ? line.slice(2) : line))
      .join(' ');
    return result
      .replace(/\|\|(?!\s)([^|]+?)(?<!\s)\|\|/g, 'спойлер')
      .replace(/`([^`]+?)`/g, '$1')
      .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, '$1')
      .replace(/__(?!\s)([^_]+?)(?<!\s)__/g, '$1')
      .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '$1')
      .replace(/\[([^\]\n]+)\]\((?:https?:\/\/[^\s)]+)\)/g, '$1')
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

  /** Человекочитаемая длительность (аудио/видео, из `loadedmetadata` уже полученного blob) в формате "М:СС". */
  function humanDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
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

  /**
   * Мобильный layout прямо сейчас (та же граница, что и style.css: см.
   * MOBILE_BREAKPOINT_QUERY выше) — используется, чтобы JS-поведение
   * (тап-активация действий сообщения, VisualViewport-подгонка панели,
   * видимость мобильного тулбара форматирования) применялось РОВНО там же,
   * где CSS переключает вёрстку на полноэкранный мобильный вид, а не по
   * отдельному, потенциально рассинхронизированному порогу. matchMedia
   * недоступен только в совсем экзотических/тестовых окружениях без DOM —
   * тогда просто считаем layout десктопным (безопасный дефолт: ничего не
   * меняется относительно поведения до этой волны).
   */
  function isMobileLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  }

  // --- Рендер markdown-подмножества в тексте сообщения ---
  //
  // Только createElement/textContent — никакого innerHTML с пользовательскими
  // данными (см. заголовок файла). Вложенность инлайн-разметки — только там,
  // где осмысленно: цитата (buildReplyQuoteEl/renderMessageBody) и спойлер
  // (buildSpoilerEl) рекурсивно прогоняют СВОЁ содержимое через
  // appendInlineNodes — то есть **жирный** внутри "> цитаты" или внутри
  // ||спойлера|| рендерится полноценно. Инлайн-код и код-блок — НЕ
  // прогоняются повторно никогда (код есть код, см. buildCodeBlockEl).
  //
  // Порядок альтернатив в регэкспе важен: на каждой стартовой позиции regex
  // пробует альтернативы слева направо. Инлайн-код проверяется ПЕРВЫМ — его
  // содержимое должно достаться целиком одному матчу, не быть растащенным
  // другими маркерами. "**" (жирный) и "__" (курсив-подчёркивание) проверяются
  // раньше одиночного "*" (курсив) — иначе жирный никогда бы не совпал.
  // Именованная ссылка "[текст](url)" проверяется раньше голой ссылки, иначе
  // голая альтернатива забрала бы "url)" без скобок. Символ-маркер исключён
  // из содержимого класса символов ([^*]/[^_]/[^~]/[^|]) — это не только
  // упрощает жадность, но и не даёт одиночному "*" случайно "прыгнуть" через
  // границу уже распознанного **...**. Лукэхеды/лукбихайнды на пробел у краёв
  // (*(?!\s)...(?<!\s)*) отсекают самый частый ложный срабатывающий случай —
  // одиночные "*" как умножение/разделитель ("5 * 3 * 2"), не образующие
  // настоящей пары курсива.
  const INLINE_MD_RE =
    /`([^`]+?)`|\*\*(?!\s)([^*]+?)(?<!\s)\*\*|__(?!\s)([^_]+?)(?<!\s)__|~~(?!\s)([^~]+?)(?<!\s)~~|\|\|(?!\s)([^|]+?)(?<!\s)\|\||\*(?!\s)([^*]+?)(?<!\s)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')]+)/g;

  /**
   * Разобрать одну строку (без переводов строк) на текстовые узлы +
   * инлайн-элементы и добавить их в `parent`. Спойлер (см. buildSpoilerEl)
   * рекурсивно вызывает ЭТУ ЖЕ функцию, находясь ВНУТРИ тела текущего цикла
   * — если бы регэксп был одним общим объектом с мутируемым lastIndex
   * (как было раньше), рекурсивный вызов сбросил бы lastIndex ИЗ-ПОД
   * внешнего цикла, который на следующей итерации начал бы матчиться заново
   * с начала строки и НИКОГДА не дошёл бы до конца line — вечный цикл,
   * замораживающий вкладку (обнаружено эмпирически: клик «Отправить» с
   * сообщением вида "||спойлер||" вешал страницу намертво). Поэтому здесь —
   * СВОЙ экземпляр RegExp на каждый вызов (в т.ч. рекурсивный), никакого
   * общего мутируемого состояния между уровнями рекурсии.
   */
  function appendInlineNodes(parent, line) {
    if (line === '') return;
    const inlineRe = new RegExp(INLINE_MD_RE.source, 'g');
    let lastIndex = 0;
    let match;
    while ((match = inlineRe.exec(line))) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      if (match[1] !== undefined) {
        // Инлайн-код — textContent напрямую, БЕЗ рекурсии (см. заголовок).
        const code = document.createElement('code');
        code.className = 'chat-inline-code';
        code.textContent = match[1];
        parent.appendChild(code);
      } else if (match[2] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[2];
        parent.appendChild(strong);
      } else if (match[3] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[3];
        parent.appendChild(em);
      } else if (match[4] !== undefined) {
        const del = document.createElement('del');
        del.textContent = match[4];
        parent.appendChild(del);
      } else if (match[5] !== undefined) {
        parent.appendChild(buildSpoilerEl(match[5]));
      } else if (match[6] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[6];
        parent.appendChild(em);
      } else if (match[7] !== undefined && match[8] !== undefined) {
        const a = document.createElement('a');
        a.href = match[8];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[7];
        parent.appendChild(a);
      } else if (match[9] !== undefined) {
        const a = document.createElement('a');
        a.href = match[9];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match[9];
        parent.appendChild(a);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) {
      parent.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
  }

  /**
   * Спойлер (||...||) — размыт до клика/Enter/Space (см. .chat-md-spoiler в
   * style.css), раскрывается НАВСЕГДА в рамках отрендеренного элемента (класс
   * .revealed добавляется, не убирается обратно — как в клиенте Telegram).
   * Содержимое рендерится РЕКУРСИВНО через appendInlineNodes (см. заголовок
   * файла выше) — форматирование под спойлером (например **жирный**) тоже
   * работает. role="button"+tabindex — доступность с клавиатуры (только
   * десктопный ввод в этой волне, мобильный тулбар — следующая).
   */
  function buildSpoilerEl(content) {
    const span = document.createElement('span');
    span.className = 'chat-md-spoiler';
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-label', 'Спойлер, нажмите, чтобы показать');
    appendInlineNodes(span, content);
    const reveal = () => span.classList.add('revealed');
    span.addEventListener('click', reveal);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    return span;
  }

  /**
   * Скопировать произвольный текст в буфер обмена — сперва через
   * navigator.clipboard (нужен secure-контекст, у нас всегда https/
   * localhost), фоллбэк — скрытый textarea + document.execCommand('copy')
   * для окружений без Clipboard API. Общая для кнопки «Копировать» код-блока
   * (см. copyCodeToClipboard/buildCodeBlockEl) и действия «Копировать текст»
   * в попапе сообщения (см. buildCopyButton) — обе просто различаются
   * визуальной обратной связью на СВОЕЙ кнопке, сам механизм копирования один.
   */
  function copyTextToClipboard(text, onDone) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onDone).catch(() => fallbackCopyToClipboard(text, onDone));
    } else {
      fallbackCopyToClipboard(text, onDone);
    }
  }

  /** Кнопка «Копировать» код-блока (см. buildCodeBlockEl) — обёртка над copyTextToClipboard с визуальной обратной связью на этой конкретной кнопке. */
  function copyCodeToClipboard(code, buttonEl) {
    const showCopied = () => {
      const prevText = buttonEl.textContent;
      buttonEl.classList.add('chat-code-block-copy--done');
      buttonEl.textContent = 'Скопировано';
      setTimeout(() => {
        buttonEl.classList.remove('chat-code-block-copy--done');
        buttonEl.textContent = prevText;
      }, 1500);
    };
    copyTextToClipboard(code, showCopied);
  }

  function fallbackCopyToClipboard(code, onDone) {
    const textarea = document.createElement('textarea');
    textarea.value = code;
    // Вне видимой области, но не display:none (Safari не копирует из
    // невидимых/нерендерящихся элементов) — offset-позиционирование через
    // CSSOM (element.style), не инлайн-атрибут — CSP это не нарушает (см.
    // заголовок файла: то же допущение, что и у .style.width полосы прогресса).
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.warn('Не удалось скопировать код блока (ни Clipboard API, ни execCommand):', err);
    }
    document.body.removeChild(textarea);
    onDone();
  }

  /**
   * Блок кода (```[lang]\n...\n```, см. renderMessageBody) — <pre><code>
   * моноширинным шрифтом, метка языка (если указан) и кнопка «копировать».
   * `code` — textContent напрямую, БЕЗ appendInlineNodes (код есть код, см.
   * заголовок файла) — символы-маркеры внутри не интерпретируются.
   */
  function buildCodeBlockEl(lang, code) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-code-block';

    const header = document.createElement('div');
    header.className = 'chat-code-block-header';

    const langEl = document.createElement('span');
    langEl.className = 'chat-code-block-lang';
    langEl.textContent = lang || '';
    header.appendChild(langEl);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chat-code-block-copy';
    copyBtn.textContent = 'Копировать';
    copyBtn.addEventListener('click', () => copyCodeToClipboard(code, copyBtn));
    header.appendChild(copyBtn);

    wrap.appendChild(header);

    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrap.appendChild(pre);

    return wrap;
  }

  /**
   * Отрендерить полное тело сообщения в `container` (обычно .chat-message-text).
   * Блочные конструкции распознаются построчно СВЕРХУ ВНИЗ, до инлайн-парсера:
   * тройные бэктики ```[lang]``` … ``` — блок кода (см. buildCodeBlockEl,
   * содержимое НЕ прогоняется через инлайн-парсер — код есть код); строки,
   * начинающиеся ровно с "> ", группируются в блок-цитату (левая полоска, см.
   * .chat-md-quote в style.css, содержимое прогоняется через
   * appendInlineNodes — жирный/курсив и т.п. внутри цитаты работают);
   * остальные строки — обычный инлайн-форматированный текст. Переводы строк
   * между блоками — <br>.
   */
  function renderMessageBody(container, text) {
    const lines = String(text || '').split('\n');
    let firstBlock = true;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fenceMatch = /^```(\S*)$/.exec(line.replace(/\s+$/, ''));
      if (fenceMatch) {
        // Ищем закрывающую тройку бэктиков среди СЛЕДУЮЩИХ строк. Не нашли
        // до конца сообщения — незакрытый фенс, откатываемся и рендерим эту
        // строку как обычный текст (а не проглатываем всё до конца).
        let j = i + 1;
        const codeLines = [];
        let closed = false;
        while (j < lines.length) {
          if (lines[j].replace(/\s+$/, '') === '```') {
            closed = true;
            break;
          }
          codeLines.push(lines[j]);
          j++;
        }
        if (closed) {
          if (!firstBlock) container.appendChild(document.createElement('br'));
          container.appendChild(buildCodeBlockEl(fenceMatch[1], codeLines.join('\n')));
          firstBlock = false;
          i = j + 1;
          continue;
        }
      }
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
      <div class="chat-format-toolbar hidden">
        <button type="button" class="chat-format-btn chat-format-btn--bold" data-format="bold" aria-label="Жирный" title="Жирный">Ж</button>
        <button type="button" class="chat-format-btn chat-format-btn--italic" data-format="italic" aria-label="Курсив" title="Курсив">К</button>
        <button type="button" class="chat-format-btn chat-format-btn--strike" data-format="strike" aria-label="Зачёркнутый" title="Зачёркнутый">З</button>
        <button type="button" class="chat-format-btn chat-format-btn--spoiler" data-format="spoiler" aria-label="Спойлер" title="Спойлер">🙈</button>
        <button type="button" class="chat-format-btn chat-format-btn--code" data-format="code" aria-label="Код" title="Код">&lt;/&gt;</button>
        <button type="button" class="chat-format-btn chat-format-btn--link" data-format="link" aria-label="Ссылка" title="Ссылка">🔗</button>
      </div>
      <div class="chat-input-row">
        <textarea class="chat-text-input" rows="1" placeholder="Сообщение…" maxlength="2000"></textarea>
        <div class="chat-input-actions">
          <button type="button" class="chat-attach-button" aria-label="Прикрепить файл" title="Прикрепить файл"></button>
          <input type="file" class="chat-file-input" multiple hidden />
          <button type="button" class="chat-format-toggle-button" aria-label="Форматирование текста" title="Форматирование текста" aria-pressed="false">Aa</button>
          <button type="button" class="chat-send-button" aria-label="Отправить" title="Отправить">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    `;
    panel.querySelector('.chat-attach-button').innerHTML = ATTACH_ICON_SVG; // статичная разметка

    // Попап действий сообщения (волна 13) — ЕДИНАЯ точка входа для всех
    // действий (ответить/реакция/редактировать/удалить/копировать) и разбора
    // реакций «кто/чем/когда»; открывается тапом/кликом по самому сообщению
    // (см. messagesEl click-делегирование ниже). Общий на панель (синглтон,
    // не по одному на сообщение) — на мобильном раскрывается bottom-sheet'ом
    // снизу (см. style.css: @media max-width:640px), на десктопе —
    // компактным поповером у сообщения (см. positionMessagePopoverDesktop).
    // Ряд эмодзи-реакций строится один раз (статичный, фиксированный набор —
    // безопасно строить через textContent), список действий и разбор
    // реакций — каждый раз заново при открытии (зависят от конкретного msg).
    const messagePopover = document.createElement('div');
    messagePopover.className = 'chat-message-popover hidden';
    messagePopover.innerHTML = `
      <div class="chat-message-popover-backdrop"></div>
      <div class="chat-message-popover-card" role="dialog" aria-modal="true">
        <div class="chat-message-popover-handle" aria-hidden="true"></div>
        <button type="button" class="chat-message-popover-close" aria-label="Закрыть" title="Закрыть">×</button>
        <div class="chat-message-popover-emojis"></div>
        <div class="chat-message-popover-reactions hidden">
          <div class="chat-message-popover-reactions-title">Реакции</div>
          <div class="chat-message-popover-reactions-list"></div>
        </div>
        <div class="chat-message-popover-actions"></div>
      </div>
    `;
    const popoverEmojisEl = messagePopover.querySelector('.chat-message-popover-emojis');
    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-message-popover-emoji';
      btn.dataset.emoji = emoji;
      btn.textContent = emoji;
      popoverEmojisEl.appendChild(btn);
    }
    panel.appendChild(messagePopover);

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
      messagePopover,
      popoverBackdrop: messagePopover.querySelector('.chat-message-popover-backdrop'),
      popoverCard: messagePopover.querySelector('.chat-message-popover-card'),
      popoverClose: messagePopover.querySelector('.chat-message-popover-close'),
      popoverEmojisEl,
      popoverReactionsEl: messagePopover.querySelector('.chat-message-popover-reactions'),
      popoverReactionsListEl: messagePopover.querySelector('.chat-message-popover-reactions-list'),
      popoverActionsEl: messagePopover.querySelector('.chat-message-popover-actions'),
      inputRow: panel.querySelector('.chat-input-row'),
      textInput: panel.querySelector('.chat-text-input'),
      sendButton: panel.querySelector('.chat-send-button'),
      attachButton: panel.querySelector('.chat-attach-button'),
      fileInput: panel.querySelector('.chat-file-input'),
      formatToolbar: panel.querySelector('.chat-format-toolbar'),
      formatToggleButton: panel.querySelector('.chat-format-toggle-button'),
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
    getChatKeyForEpoch,
    getCurrentContentEpoch,
    isContentEpochReady,
  }) {
    if (!singleton) {
      const dom = buildDom(variant, toggleButton);
      singleton = createController(dom);
    }
    singleton.attach({
      signaling,
      bus,
      peerId,
      name,
      getPeerIds,
      initialPeerIds,
      getLeaderId,
      getGuestChatAllowed,
      getChatKeyForEpoch,
      getCurrentContentEpoch,
      isContentEpochReady,
    });
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
      messagePopover,
      popoverBackdrop,
      popoverCard,
      popoverClose,
      popoverEmojisEl,
      popoverReactionsEl,
      popoverReactionsListEl,
      popoverActionsEl,
      inputRow,
      textInput,
      sendButton,
      attachButton,
      fileInput,
      formatToolbar,
      formatToggleButton,
    } = dom;

    let signaling = null;
    let bus = null;
    let peerId = null;
    let myName = null;
    // Ш1/Ш3 (E2E-шифрование + forward secrecy контента, см.
    // static/crypto.js/room.js): K_chat используется ТОЛЬКО для серверного
    // fallback-релея (см. sendEnvelopeToPeer/attach ниже) — по шине конверт
    // не шифруется этим слоем вовсе. Ключ больше не статичен на всю сессию
    // (см. docs/e2e-encryption.md §7): комната может пережить смену эпохи
    // (лидер ротирует K_chat/K_meta при уходе участника), поэтому вместо
    // одного сохранённого CryptoKey здесь — колбэки room.js, читающие ЖИВОЕ
    // состояние contentEpochs на момент вызова:
    //   - getChatKeyForEpoch(epoch) -> CryptoKey чата этой эпохи, или null,
    //     если эпоха нам неизвестна (не должно случаться при корректной
    //     раздаче — см. заголовок файла и signaling.on('chat', ...) ниже);
    //   - getCurrentContentEpoch() -> номер эпохи, которой шифруем ИСХОДЯЩИЙ
    //     fallback-конверт прямо сейчас;
    //   - isContentEpochReady() -> false у новичка, пока текущая эпоха ещё
    //     не подтверждена по шине (см. room.js: contentEpochReady) — пока
    //     false, исходящий fallback-конверт СТАВИТСЯ В ОЧЕРЕДЬ
    //     (pendingFallbackSends), а не шифруется устаревшей эпохой 0.
    let getChatKeyForEpoch = () => null;
    let getCurrentContentEpoch = () => 0;
    let isContentEpochReady = () => true;
    // Очередь исходящих fallback-отправок, накопленная, пока
    // isContentEpochReady() возвращал false — сливается разом в
    // notifyContentEpochReady() (room.js зовёт её из markContentEpochReady).
    let pendingFallbackSends = [];
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
    // Попап действий сообщения (волна 13, заменяет on-tap action-row и
    // hover-кнопки прошлых волн) — msgId сообщения, для которого сейчас
    // открыт попап (ответить/реакция/редактировать/удалить/копировать +
    // разбор реакций), или null. Не более одного одновременно — открытие
    // для нового сообщения переиспользует тот же DOM-синглтон (см.
    // openMessagePopover). Работает ОДИНАКОВО на мобильном (bottom-sheet) и
    // десктопе (компактный поповер у сообщения) — единая точка входа, без
    // отдельного hover-состояния.
    let activePopoverMsgId = null;
    // Мобильный тулбар форматирования (волна 11) — принудительно открыт
    // кнопкой «Aa» (см. formatToggleButton ниже); помимо этого тулбар также
    // показывается САМ, пока в textInput есть непустое выделение (см.
    // updateFormatToolbarVisibility/document 'selectionchange').
    let formatToolbarForcedOpen = false;

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

    /**
     * Текст превью для реплая/цитаты (волна 13: реплай теперь доступен из
     * попапа на ЛЮБОМ сообщении, включая file-offer, — см.
     * populatePopoverActions/buildReplyActionButton, у file-offer текста нет
     * вовсе, поэтому превью строится из имени файла со скрепкой).
     */
    function replyPreviewBodyText(msg) {
      if (msg.kind === 'file-offer') return `📎 ${msg.fileName}`;
      return msg.text;
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

    /**
     * Пересчитать map реакций с нуля из `messages`, применяя op'ы в порядке
     * (lamport, from) — буфер уже так отсортирован. Значение на нижнем
     * уровне — Map(peerId -> {name, ts}), а не просто Set<peerId>: имя и
     * время нужны для разбора «кто/чем/когда» в попапе действий (см.
     * buildPopoverReactionsList) — тем не менее Map поддерживает те же
     * .has()/.size, что и Set, поэтому весь остальной код (чипы реакций,
     * toggle) не меняется вовсе.
     */
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
          peers = new Map();
          byEmoji.set(msg.emoji, peers);
        }
        if (msg.op === 'add') peers.set(msg.from, { name: msg.name || null, ts: msg.ts || Date.now() });
        else if (msg.op === 'remove') peers.delete(msg.from);
      }
      reactions = next;
    }

    function buildReplyQuoteEl(targetId) {
      const quote = document.createElement('div');
      quote.className = 'chat-reply-quote';
      const original = findEditableOriginalById(targetId);
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
        const bodyText =
          overlay && typeof overlay.editText === 'string' ? overlay.editText : replyPreviewBodyText(original);
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
        'chat-message' +
        (own ? ' chat-message--own' : '') +
        (isDeleted ? ' chat-message--deleted' : '') +
        (msg.id === activePopoverMsgId ? ' chat-message--popover-open' : '');
      item.dataset.msgId = msg.id;

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

    /** Строка попапа действий: иконка (статичный SVG) + подпись — единый вид для всех пунктов (см. populatePopoverActions). */
    function buildPopoverActionRow(iconSvg, label) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const icon = document.createElement('span');
      icon.className = 'chat-message-action-icon';
      icon.innerHTML = iconSvg; // статичная разметка, не пользовательские данные
      const labelEl = document.createElement('span');
      labelEl.className = 'chat-message-action-label';
      labelEl.textContent = label;
      btn.appendChild(icon);
      btn.appendChild(labelEl);
      return { btn, labelEl };
    }

    /** Карандаш — только на СВОИХ text-сообщениях (см. populatePopoverActions); file-offer редактировать нельзя. */
    function buildEditButton(msg) {
      const { btn } = buildPopoverActionRow(EDIT_ICON_SVG, 'Редактировать');
      btn.className = 'chat-message-action chat-message-action--edit';
      btn.setAttribute('aria-label', 'Редактировать');
      btn.title = 'Редактировать';
      btn.addEventListener('click', () => startEdit(msg));
      return btn;
    }

    /**
     * Корзина — на СВОИХ text- и file-offer-сообщениях. Первый клик переводит
     * кнопку в состояние подтверждения («Точно удалить?») на
     * DELETE_CONFIRM_MS; второй клик в этом окне шлёт delete; таймаут без
     * второго клика — откат в исходную подпись без отправки чего-либо.
     */
    function buildDeleteButton(msg) {
      const { btn, labelEl } = buildPopoverActionRow(DELETE_ICON_SVG, 'Удалить');
      btn.className = 'chat-message-action chat-message-action--delete';
      btn.setAttribute('aria-label', 'Удалить');
      btn.title = 'Удалить';
      let confirmTimer = null;

      function resetToIdle() {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        btn.classList.remove('chat-message-action--confirm');
        labelEl.textContent = 'Удалить';
        btn.setAttribute('aria-label', 'Удалить');
        btn.title = 'Удалить';
      }

      btn.addEventListener('click', () => {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
          sendDeleteMessage(msg.id);
          closeMessagePopover();
          return;
        }
        btn.classList.add('chat-message-action--confirm');
        labelEl.textContent = 'Точно удалить?';
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
        (isDeleted ? ' chat-message--deleted' : '') +
        (msg.id === activePopoverMsgId ? ' chat-message--popover-open' : '');
      item.dataset.msgId = msg.id;

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

    /**
     * Строка меты под инлайн-медиа (картинка/видео/аудио) готовой карточки:
     * имя файла + размер (+ пустой узел под длительность — заполняется
     * позже событием loadedmetadata, см. вызывающий код) + кнопка «Скачать»
     * из уже полученного objectUrl (сеть повторно не дёргаем — см. заголовок
     * файла про Ф3: сервер байты не видит и не хранит, а сам файл уже у нас
     * в виде Blob/ObjectURL).
     */
    function buildFileMetaRow(msg) {
      const meta = document.createElement('div');
      meta.className = 'chat-file-meta-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'chat-file-meta-name';
      nameEl.textContent = msg.fileName;
      nameEl.title = msg.fileName;
      meta.appendChild(nameEl);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'chat-file-meta-size';
      sizeEl.textContent = humanFileSize(msg.size);
      meta.appendChild(sizeEl);

      return meta;
    }

    /** Пустой узел под длительность — текст проставляется по loadedmetadata (см. renderFileDoneBody). */
    function buildFileMetaDurationEl() {
      const durationEl = document.createElement('span');
      durationEl.className = 'chat-file-meta-duration';
      return durationEl;
    }

    /** Компактная кнопка-ссылка «Скачать» из уже полученного objectUrl (см. buildFileMetaRow). */
    function buildFileMetaDownloadLink(msg, state) {
      const link = document.createElement('a');
      link.className = 'chat-file-download-link chat-file-download-link--compact';
      link.href = state.objectUrl;
      link.download = msg.fileName;
      link.textContent = 'Скачать';
      return link;
    }

    /**
     * Финальный вид готовой (status='done') карточки — по mime полученного
     * файла (см. заголовок файла, раздел B):
     *  - image/* — инлайн-превью (клик по картинке — оригинал в новой
     *    вкладке, как и было), под ней мета-строка (имя, размер, «Скачать»);
     *  - video/* — <video controls preload=metadata>, длительность
     *    проставляется по loadedmetadata (М:СС, см. humanDuration) —
     *    невалидный/непроигрываемый контейнер просто не пришлёт это событие,
     *    строка меты тогда остаётся без длительности (не ошибка);
     *  - audio/* — <audio controls>, длительность так же по loadedmetadata;
     *  - остальное — карточка-заголовок (иконка/имя/размер) + отдельная
     *    ссылка-кнопка «Скачать» (как было раньше).
     * objectUrl НЕ создаётся здесь заново на каждый ререндер — он уже лежит
     * в fileStates (см. beginReceivingFile: URL.createObjectURL вызывается
     * РОВНО ОДИН РАЗ при получении Blob), сюда просто передаётся `state`.
     */
    function renderFileDoneBody(card, msg, state) {
      const mime = msg.mime || '';

      if (mime.startsWith('image/')) {
        const link = document.createElement('a');
        link.href = state.objectUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'chat-file-media-link';
        const img = document.createElement('img');
        img.className = 'chat-file-image';
        img.src = state.objectUrl;
        img.alt = msg.fileName;
        link.appendChild(img);
        card.appendChild(link);

        const meta = buildFileMetaRow(msg);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);
        return;
      }

      if (mime.startsWith('video/')) {
        const video = document.createElement('video');
        video.className = 'chat-file-video';
        video.controls = true;
        video.preload = 'metadata';
        video.src = state.objectUrl;
        card.appendChild(video);

        const meta = buildFileMetaRow(msg);
        const durationEl = buildFileMetaDurationEl();
        meta.appendChild(durationEl);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);

        video.addEventListener(
          'loadedmetadata',
          () => {
            if (Number.isFinite(video.duration)) durationEl.textContent = humanDuration(video.duration);
          },
          { once: true }
        );
        return;
      }

      if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.className = 'chat-file-audio';
        audio.controls = true;
        audio.src = state.objectUrl;
        card.appendChild(audio);

        const meta = buildFileMetaRow(msg);
        const durationEl = buildFileMetaDurationEl();
        meta.appendChild(durationEl);
        meta.appendChild(buildFileMetaDownloadLink(msg, state));
        card.appendChild(meta);

        audio.addEventListener(
          'loadedmetadata',
          () => {
            if (Number.isFinite(audio.duration)) durationEl.textContent = humanDuration(audio.duration);
          },
          { once: true }
        );
        return;
      }

      // Прочее — карточка-заголовок (иконка по mime/имя/размер) + ссылка-кнопка.
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
      pendingFallbackSends = [];
      cancelReply();
      cancelEditAndClear();
      closeMessagePopover();
      formatToolbarForcedOpen = false;
      updateFormatToolbarVisibility();
      autoGrowTextInput();
    }

    /**
     * VisualViewport-подгонка полноэкранной мобильной панели чата (жалоба
     * владельца: системная клавиатура перекрывала часть чата и добавляла
     * лишний скролл страницы вместо того, чтобы чат ужался в видимую
     * область, см. style.css: @media (max-width:640px) .chat-panel, 100dvh).
     * 100dvh реагирует на смену адресной строки/ориентации, но НЕ на
     * появление клавиатуры на iOS — основной путь здесь поэтому
     * VisualViewport API: пока чат открыт на мобильном layout, высота панели
     * = visualViewport.height, верх панели = visualViewport.offsetTop (сдвиг
     * видимой области относительно layout-вьюпорта) — так инпут (прижатый к
     * низу панели) остаётся НАД клавиатурой, а не уезжает под неё. Список
     * сообщений сам ужимается (flex:1 на .chat-messages) — здесь только
     * подскролливаем его к низу, чтобы последнее сообщение оставалось
     * видимым после сжатия видимой области.
     *
     * Фоллбэк (нет window.visualViewport — старые браузеры): сбрасываем
     * инлайн-стили в пустую строку, дальше работает только CSS (100dvh) — не
     * хуже поведения до этой волны.
     *
     * .chat-mobile-scroll-lock на body (см. style.css) — пока чат открыт на
     * мобильном, страница НЕ скроллится ни при каких обстоятельствах: панель
     * и так перекрывает весь вьюпорт (position:fixed; inset:0), но фокус
     * textarea рядом с открывающейся клавиатурой на части браузеров
     * провоцирует попытку "проскроллить поле в видимую область" на уровне
     * документа — лок гарантированно её глушит.
     */
    function syncMobileChatViewport() {
      const isOpen = !panel.classList.contains('hidden');
      const mobile = isOpen && isMobileLayout();
      document.body.classList.toggle('chat-mobile-scroll-lock', mobile);
      if (!mobile || !window.visualViewport) {
        panel.style.top = '';
        panel.style.height = '';
        return;
      }
      const vv = window.visualViewport;
      panel.style.top = `${vv.offsetTop}px`;
      panel.style.height = `${vv.height}px`;
      scrollToBottom();
    }

    // Слушатели VisualViewport ставятся РОВНО ОДИН РАЗ (createController —
    // синглтон на страницу, см. заголовок файла) — 'resize' срабатывает и на
    // появление/исчезновение клавиатуры, и на pinch-zoom; 'scroll' — когда
    // видимая область сдвигается относительно layout-вьюпорта (например,
    // браузер докручивает фокусированное поле в видимую часть). window
    // 'resize'/'orientationchange' — фоллбэк-путь и смена ориентации:
    // window.visualViewport в части браузеров тоже эмитит на это resize, но
    // не везде гарантированно, поэтому подписываемся отдельно ещё и на них.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncMobileChatViewport);
      window.visualViewport.addEventListener('scroll', syncMobileChatViewport);
    }
    window.addEventListener('resize', () => {
      syncMobileChatViewport();
      updateFormatToolbarVisibility();
      // Ресайз десктоп<->мобайл (поворот/DevTools) — переположить открытый
      // попап под новый layout (мобильный bottom-sheet <-> десктопный
      // поповер у сообщения).
      if (activePopoverMsgId && !messagePopover.classList.contains('hidden')) {
        const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(activePopoverMsgId)}"]`);
        positionMessagePopoverDesktop(el || panel);
      }
    });
    window.addEventListener('orientationchange', syncMobileChatViewport);

    function setCollapsed(collapsed) {
      panel.classList.toggle('hidden', collapsed);
      toggleButton.classList.toggle('control-button--on', !collapsed);
      toggleButton.setAttribute('aria-pressed', String(!collapsed));
      if (!collapsed) {
        unreadCount = 0;
        updateUnreadBadge();
        // Панель (и textarea внутри неё) до этого момента могла быть
        // display:none (см. .chat-panel.hidden) — scrollHeight скрытого
        // элемента всегда 0, поэтому autoGrowTextInput(), вызванный РАНЬШЕ
        // (например, из clearMessages() при attach, панель тогда ещё
        // закрыта), мог посчитать и проставить неверную (нулевую) высоту.
        // Пересчитываем заново теперь, когда панель точно видима.
        autoGrowTextInput();
        scrollToBottom();
        textInput.focus();
      } else {
        closeMessagePopover();
        formatToolbarForcedOpen = false;
        updateFormatToolbarVisibility();
      }
      syncMobileChatViewport();
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
      replyBarText.textContent = `Ответ ${displayName(msg)}: ${truncateText(stripMarkdownForPreview(replyPreviewBodyText(msg)), REPLY_PREVIEW_MAX_LEN)}`;
      replyBar.classList.remove('hidden');
      closeMessagePopover();
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
      autoGrowTextInput();
      closeMessagePopover();
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
      if (wasEditing) {
        textInput.value = '';
        autoGrowTextInput();
      }
    }

    editBarClose.addEventListener('click', cancelEditAndClear);

    /**
     * Есть ли в пути распространения события элемент, подходящий под
     * `selector` — то же самое, что `event.target.closest(selector)`, НО
     * устойчиво к тому, что сам `event.target` мог быть отсоединён от DOM
     * ДРУГИМ обработчиком ЭТОГО ЖЕ события до того, как оно добубнило сюда
     * (обнаружено эмпирически: клик по кнопке удаления — buildDeleteButton
     * на первом клике синхронно делает `btn.textContent = '✓?'`, заменяя
     * дочерний SVG-элемент — если event.target был именно этим SVG
     * (обычная ситуация: клик приходится на иконку внутри кнопки), то к
     * моменту, когда bubbling добирается до messagesEl/document,
     * `event.target.closest(...)` возвращает null — SVG уже отсоединён от
     * родителя). `event.composedPath()` — снимок пути НА МОМЕНТ
     * ДИСПЕТЧЕРИЗАЦИИ события, снятый ДО того, как какой-либо обработчик
     * успел что-либо изменить в DOM, поэтому не подвержен этой проблеме.
     */
    function eventPathMatches(event, selector) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (node instanceof Element && node.matches(selector)) return true;
      }
      return false;
    }

    // --- Попап действий сообщения (волна 13) ---
    //
    // Заменяет ЦЕЛИКОМ и on-tap action-row мобильного UX прошлой волны, и
    // hover-кнопки десктопа: единственный способ добраться до действий
    // сообщения (ответить/реакция/редактировать/удалить/копировать) теперь —
    // тап/клик по самому сообщению, ОДИНАКОВО на мобильном и десктопе (см.
    // messagesEl click-делегирование ниже). В строке сообщения по умолчанию
    // не остаётся вообще никаких кнопок — ни постоянных, ни по hover (жалоба
    // владельца из прошлой волны была именно на визуальный шум действий,
    // эта волна убирает его целиком, а не просто прячет за тапом).

    /** Найти ЛЮБОЕ сообщение (text или file-offer) по id — то же самое, что findEditableOriginalById, отдельное имя для читаемости в контексте попапа. */
    function findAnyMessageById(id) {
      return findEditableOriginalById(id);
    }

    /** Построить разбор реакций «кто/чем/когда» — список по эмодзи (в порядке REACTION_EMOJIS), внутри каждой группы — по времени реакции. */
    function buildPopoverReactionsList(msgId) {
      popoverReactionsListEl.textContent = '';
      const byEmoji = reactions.get(msgId);
      let any = false;
      if (byEmoji) {
        for (const emoji of REACTION_EMOJIS) {
          const peers = byEmoji.get(emoji);
          if (!peers || peers.size === 0) continue;
          const entries = Array.from(peers.entries()).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
          for (const [reactorPeerId, info] of entries) {
            any = true;
            const row = document.createElement('div');
            row.className = 'chat-message-popover-reaction-row';

            const emojiEl = document.createElement('span');
            emojiEl.className = 'chat-message-popover-reaction-emoji';
            emojiEl.textContent = emoji;

            const nameEl = document.createElement('span');
            nameEl.className = 'chat-message-popover-reaction-name';
            nameEl.textContent = displayName({ from: reactorPeerId, name: info.name });

            const timeEl = document.createElement('span');
            timeEl.className = 'chat-message-popover-reaction-time';
            timeEl.textContent = formatTime(info.ts || Date.now());

            row.appendChild(emojiEl);
            row.appendChild(nameEl);
            row.appendChild(timeEl);
            popoverReactionsListEl.appendChild(row);
          }
        }
      }
      popoverReactionsEl.classList.toggle('hidden', !any);
    }

    /** Скопировать ТЕКУЩИЙ (с учётом правки) текст сообщения в буфер обмена — действие «Копировать» в попапе. */
    function buildCopyButton(msg, overlay) {
      const { btn, labelEl } = buildPopoverActionRow(COPY_ICON_SVG, 'Копировать текст');
      btn.className = 'chat-message-action chat-message-action--copy';
      btn.addEventListener('click', () => {
        const bodyText = overlay && typeof overlay.editText === 'string' ? overlay.editText : msg.text;
        copyTextToClipboard(String(bodyText || ''), () => {
          labelEl.textContent = 'Скопировано';
          setTimeout(() => {
            labelEl.textContent = 'Копировать текст';
          }, 1200);
        });
      });
      return btn;
    }

    function buildReplyActionButton(msg) {
      const { btn } = buildPopoverActionRow(REPLY_ICON_SVG, 'Ответить');
      btn.className = 'chat-message-action chat-message-action--reply';
      btn.addEventListener('click', () => {
        closeMessagePopover();
        startReply(msg);
      });
      return btn;
    }

    /** Заполнить `.chat-message-popover-actions` действиями, подходящими под конкретное сообщение (own/kind/deleted). */
    function populatePopoverActions(msg, overlay) {
      popoverActionsEl.textContent = '';
      const own = msg.from === peerId;
      popoverActionsEl.appendChild(buildReplyActionButton(msg));
      if (own && msg.kind === 'text') {
        const editBtn = buildEditButton(msg);
        editBtn.addEventListener('click', closeMessagePopover);
        popoverActionsEl.appendChild(editBtn);
      }
      if (own) {
        popoverActionsEl.appendChild(buildDeleteButton(msg));
      }
      if (msg.kind === 'text') {
        popoverActionsEl.appendChild(buildCopyButton(msg, overlay));
      }
    }

    /**
     * Позиционирование ТОЛЬКО для десктопа (>640px) — компактный поповер у
     * сообщения. `.chat-message-popover` задуман как position:fixed;inset:0
     * (см. style.css) — ПОЧТИ всегда containing block для абсолютно
     * позиционированной `.chat-message-popover-card` оказывается вьюпортом
     * целиком, НО не гарантированно: `.chat-panel--room` использует
     * `backdrop-filter` (см. style.css), а filter/backdrop-filter на
     * ПРЕДКЕ по спеке сами создают containing block для fixed-потомков —
     * тогда `.chat-message-popover` фактически оказывается зажат в рамки
     * `.chat-panel`, а не вьюпорта (обнаружено эмпирически при визуальной
     * самопроверке: попап рендерился на сотни пикселей правее, чем ожидалось
     * — карточка позиционировалась от границ ПАНЕЛИ, а расчёт координат
     * предполагал границы ВЬЮПОРТА). Чтобы не зависеть от того, какой именно
     * containing block достался в конкретном браузере/раскладке, координаты
     * считаются относительно РЕАЛЬНОГО bounding rect самого
     * `.chat-message-popover` (messagePopover.getBoundingClientRect()) — она
     * и есть фактический containing block для absolute-карточки, кем бы он
     * ни оказался. На мобильном (bottom-sheet) позицию целиком берёт на себя
     * CSS — здесь инлайн-стили сбрасываются, чтобы не конфликтовать.
     */
    function positionMessagePopoverDesktop(anchorEl) {
      if (isMobileLayout()) {
        popoverCard.style.left = '';
        popoverCard.style.top = '';
        return;
      }
      const containingRect = messagePopover.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      const cardRect = popoverCard.getBoundingClientRect();

      let left = anchorRect.left - containingRect.left;
      const maxLeft = Math.max(4, containingRect.width - cardRect.width - 4);
      left = Math.max(4, Math.min(left, maxLeft));

      let top = anchorRect.bottom - containingRect.top + 4;
      if (top + cardRect.height > containingRect.height - 4) {
        top = anchorRect.top - containingRect.top - cardRect.height - 4;
      }
      top = Math.max(4, top);

      popoverCard.style.left = `${left}px`;
      popoverCard.style.top = `${top}px`;
    }

    function openMessagePopover(msgId, anchorEl) {
      const msg = findAnyMessageById(msgId);
      if (!msg) return;
      const overlay = messageOverlays.get(msgId);
      if (overlay && overlay.deleted) return; // тумбстоуну действия не положены

      const prevId = activePopoverMsgId;
      activePopoverMsgId = msgId;
      if (prevId && prevId !== msgId) {
        const prevEl = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(prevId)}"]`);
        if (prevEl) prevEl.classList.remove('chat-message--popover-open');
      }
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(msgId)}"]`);
      if (el) el.classList.add('chat-message--popover-open');

      buildPopoverReactionsList(msgId);
      populatePopoverActions(msg, overlay);

      messagePopover.classList.remove('hidden');
      positionMessagePopoverDesktop(anchorEl || el || panel);
    }

    function closeMessagePopover() {
      if (!activePopoverMsgId) {
        messagePopover.classList.add('hidden');
        return;
      }
      const el = messagesEl.querySelector(`.chat-message[data-msg-id="${escapeForSelector(activePopoverMsgId)}"]`);
      if (el) el.classList.remove('chat-message--popover-open');
      activePopoverMsgId = null;
      messagePopover.classList.add('hidden');
    }

    function toggleMessagePopover(msgId, anchorEl) {
      if (activePopoverMsgId === msgId && !messagePopover.classList.contains('hidden')) {
        closeMessagePopover();
        return;
      }
      cancelReply();
      openMessagePopover(msgId, anchorEl);
    }

    // Эмодзи-палитра внутри попапа — тап/клик по эмодзи ставит/снимает
    // реакцию (toggle, см. sendReactionToggle) и закрывает весь попап
    // (Telegram: выбор реакции — финальное действие, не промежуточный шаг).
    popoverEmojisEl.querySelectorAll('.chat-message-popover-emoji').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        const targetId = activePopoverMsgId;
        closeMessagePopover();
        if (targetId && emoji) sendReactionToggle(targetId, emoji);
      });
    });

    popoverClose.addEventListener('click', closeMessagePopover);
    popoverBackdrop.addEventListener('click', closeMessagePopover);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!messagePopover.classList.contains('hidden')) {
        closeMessagePopover();
        return;
      }
      if (!editBar.classList.contains('hidden')) {
        cancelEditAndClear();
      }
    });

    // Клик по телу сообщения открывает попап действий (повторный клик по
    // уже открытому — закрывает, см. toggleMessagePopover). Клики по
    // элементам с собственной клик-логикой (чип реакции, цитата реплая,
    // ссылка, спойлер, кнопка/медиа-контрол внутри карточки файла) НЕ
    // открывают попап дополнительно — тот же приём, что и в прошлой волне
    // (см. eventPathMatches выше). Тумбстоуны (удалённые сообщения) действий
    // не имеют — openMessagePopover сама не откроется (см. проверку overlay
    // внутри), но и клик-делегирование их не запускает тоже, для ясности.
    messagesEl.addEventListener('click', (event) => {
      if (
        eventPathMatches(
          event,
          '.chat-reaction-chip, .chat-reply-quote, a, button, video, audio, .chat-md-spoiler'
        )
      ) {
        return;
      }
      const item = event.target.closest ? event.target.closest('.chat-message') : null;
      if (!item) return;
      if (item.classList.contains('chat-message--deleted')) return;
      toggleMessagePopover(item.dataset.msgId, item);
    });

    // Клик МИМО любого сообщения и мимо самого попапа закрывает попап (тап
    // по шапке чата, пустому месту ленты, инпуту и т.п.). Клики ВНУТРИ
    // сообщения обрабатывает messagesEl-делегирование выше (toggle) — сюда
    // они тоже долетают по всплытию, но исключены явной проверкой ниже,
    // иначе этот обработчик немедленно закрывал бы только что открытый попап.
    document.addEventListener('click', (event) => {
      if (messagePopover.classList.contains('hidden')) return;
      if (eventPathMatches(event, '.chat-message-popover') || eventPathMatches(event, '.chat-message')) return;
      closeMessagePopover();
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
     * под K_chat ТЕКУЩЕЙ эпохи, сервер видит только {enc:{v,iv,ct}, epoch}
     * вместо содержимого.
     *
     * Ш3 (forward secrecy, см. docs/e2e-encryption.md §7): эпоха проставляется
     * ТОЛЬКО на fallback-пути (по шине конверт и так не шифрован этим слоем —
     * ему эпоха ни для чего не нужна, см. static/room.js: bus уже DTLS-E2E).
     * Пока isContentEpochReady() ложно (новичок ещё ждёт key-rotate от
     * лидера, см. room.js: contentEpochReady) — отправку ЭТОГО конкретного
     * конверта в fallback-путь НЕЛЬЗЯ шифровать устаревшей эпохой 0 (именно
     * так ушедший участник мог бы её прочитать, раз уже держит K_chat_0) —
     * поэтому конверт копится в pendingFallbackSends и уходит позже, разом,
     * через notifyContentEpochReady().
     */
    function sendEnvelopeToPeer(targetPeerId, envelope) {
      if (bus.isOpen(targetPeerId)) {
        bus.sendToPeer(targetPeerId, envelope);
        return;
      }
      if (!isContentEpochReady()) {
        pendingFallbackSends.push({ targetPeerId, envelope });
        return;
      }
      const epoch = getCurrentContentEpoch();
      const key = getChatKeyForEpoch(epoch);
      if (!key) {
        // Не должно случаться при корректной раздаче (см. заголовок файла) —
        // своя ЖЕ текущая эпоха всегда должна быть у нас в карте контентных
        // ключей. Молча не отправляем, а не шифруем под чем попало.
        console.error(`Ш3: нет ключа для собственной текущей эпохи ${epoch} — fallback-конверт не отправлен`);
        return;
      }
      RoomCrypto.encrypt(key, envelope).then((enc) => {
        signaling.send('chat', { targetPeerId, envelope: { enc, epoch } });
        ConnStats.incFallbackChat();
      });
    }

    /** Слить очередь fallback-отправок, накопленную, пока эпоха не была подтверждена (см. sendEnvelopeToPeer/isContentEpochReady) — вызывается room.js через publicApi.notifyContentEpochReady, как только эпоха наконец известна. */
    function flushPendingFallbackSends() {
      if (pendingFallbackSends.length === 0) return;
      const queued = pendingFallbackSends;
      pendingFallbackSends = [];
      for (const { targetPeerId, envelope } of queued) {
        sendEnvelopeToPeer(targetPeerId, envelope);
      }
    }

    /** Вызывается room.js (см. markContentEpochReady), когда текущая эпоха контентных ключей наконец точно известна — отпускает очередь исходящего fallback-чата. */
    function notifyContentEpochReady() {
      flushPendingFallbackSends();
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
      autoGrowTextInput();
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
      autoGrowTextInput();
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
    // Требование владельца («Telegram-подобно»): Enter — ВСЕГДА перенос
    // строки, и на мобильном, и на десктопе — отправка только кнопкой
    // (самолётик). Cmd/Ctrl+Enter — десктопное удобство для отправки, не
    // заменяет одиночный Enter. Одиночный Enter здесь намеренно НЕ
    // перехватывается (без event.preventDefault()) — обычный перенос строки
    // остаётся полностью браузерным поведением textarea.
    textInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendCurrentText();
        return;
      }
      handleFormattingShortcut(event);
    });

    /**
     * Автоувеличение textarea по числу строк (волна 13, «как в Telegram») —
     * растёт до MAX_INPUT_LINES, дальше — внутренний скролл самой textarea
     * (overflow-y:auto), панель ввода при этом не уезжает (растёт только
     * сама textarea, кнопки прижаты снизу через align-items:flex-end на
     * .chat-input-row, см. style.css). Пересчитывается на каждое input-
     * событие и везде, где value меняется программно (edit/отправка/отмена
     * редактирования/форматирующие горячие клавиши) — см. вызовы ниже.
     * Высота считается через временный сброс в 'auto' (чтобы scrollHeight
     * отражал РЕАЛЬНОЕ содержимое, а не текущую растянутую высоту) — border
     * учитывается отдельно (scrollHeight не включает border, а
     * box-sizing:border-box у .chat-text-input предполагает высоту ВМЕСТЕ с
     * border, см. style.css).
     *
     * Раскладка строки ввода (волна 14): пока textarea умещается в одну
     * строку — компактный горизонтальный ряд [📎][Aa][textarea][➤] (как и
     * раньше). Как только она вырастает больше чем на одну строку, кнопки
     * (📎/Aa/➤, обёрнутые в .chat-input-actions — см. buildDom) перестраиваются
     * в вертикальную колонку справа от textarea, прижатую к низу: см.
     * .chat-input-row--expanded в style.css (там же — почему это работает
     * без переноса кнопок в DOM: .chat-input-actions в обычном режиме —
     * display:contents, в expanded — настоящий flex-column). Число строк
     * считаем от содержимого (scrollHeight за вычетом паддингов), а не от
     * итоговой (уже ограниченной MAX_INPUT_LINES) высоты.
     */
    function autoGrowTextInput() {
      const style = getComputedStyle(textInput);
      const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const lineHeight = parseFloat(style.lineHeight) || 20;
      textInput.style.height = 'auto';
      const desired = textInput.scrollHeight + borderY;
      const maxHeight = Math.round(lineHeight * MAX_INPUT_LINES + paddingY + borderY);
      textInput.style.height = `${Math.min(desired, maxHeight)}px`;
      textInput.style.overflowY = desired > maxHeight ? 'auto' : 'hidden';

      const numLines = Math.round((textInput.scrollHeight - paddingY) / lineHeight);
      inputRow.classList.toggle('chat-input-row--expanded', numLines > 1);
    }

    textInput.addEventListener('input', () => {
      const wasNearBottom = isNearBottom();
      autoGrowTextInput();
      if (wasNearBottom) scrollToBottom();
    });

    // --- Десктопные горячие клавиши форматирования (см. заголовок файла) ---
    // Мобильный тулбар (по выделению/по кнопке «Aa») — см. блок ниже, после
    // handleFormattingShortcut, переиспользует ЭТИ ЖЕ функции-обёртки.
    /**
     * Обернуть текущее выделение textInput парой маркеров (**, __, ~~, ||,
     * `); нет выделения — вставить пустую пару и поставить курсор МЕЖДУ
     * маркерами (а не оставлять плейсхолдер), как и требует спека горячих
     * клавиш.
     */
    function wrapSelectionWithMarkers(before, after) {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      const value = textInput.value;
      const selected = value.slice(start, end);
      textInput.value = value.slice(0, start) + before + selected + after + value.slice(end);
      const cursor = selected
        ? start + before.length + selected.length + after.length
        : start + before.length;
      textInput.setSelectionRange(cursor, cursor);
      textInput.focus();
      autoGrowTextInput();
    }

    /**
     * Cmd/Ctrl+Shift+K — обернуть выделение в markdown-ссылку [текст](url) с
     * подстановкой URL через window.prompt (нет выделения — плейсхолдер
     * «ссылка» вместо текста). Отмена промпта (null/пусто) — no-op, ничего не
     * вставляем.
     */
    function insertLinkMarkdown() {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      const value = textInput.value;
      const selected = value.slice(start, end);
      const url = window.prompt('Ссылка (URL):', 'https://');
      if (!url) {
        textInput.focus();
        return;
      }
      const inserted = `[${selected || 'ссылка'}](${url})`;
      textInput.value = value.slice(0, start) + inserted + value.slice(end);
      const cursor = start + inserted.length;
      textInput.setSelectionRange(cursor, cursor);
      textInput.focus();
      autoGrowTextInput();
    }

    /**
     * Cmd/Ctrl+B/I — жирный/курсив без Shift; Cmd/Ctrl+Shift+X/P/M/K —
     * зачёркнутый/спойлер/инлайн-код/ссылка. metaKey — Mac (Cmd), ctrlKey —
     * Windows/Linux (Ctrl); оба ловятся одинаково, реального смысла их
     * различать для этих сочетаний нет (ни одно не занято браузером в
     * обычном <textarea>).
     */
    function handleFormattingShortcut(event) {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === 'b') {
        event.preventDefault();
        wrapSelectionWithMarkers('**', '**');
      } else if (!event.shiftKey && key === 'i') {
        event.preventDefault();
        wrapSelectionWithMarkers('__', '__');
      } else if (event.shiftKey && key === 'x') {
        event.preventDefault();
        wrapSelectionWithMarkers('~~', '~~');
      } else if (event.shiftKey && key === 'p') {
        event.preventDefault();
        wrapSelectionWithMarkers('||', '||');
      } else if (event.shiftKey && key === 'm') {
        event.preventDefault();
        wrapSelectionWithMarkers('`', '`');
      } else if (event.shiftKey && key === 'k') {
        event.preventDefault();
        insertLinkMarkdown();
      }
    }

    // --- Мобильный тулбар форматирования (волна 11) ---
    //
    // Набирать "**"/"||" руками на телефоне неудобно — десктопные горячие
    // клавиши (Cmd/Ctrl+B/I/Shift+X/P/M/K, см. выше) на мобильной
    // виртуальной клавиатуре либо недоступны, либо неочевидны. Два триггера
    // показа ОДНОГО и того же тулбара (переиспользует wrapSelectionWithMarkers/
    // insertLinkMarkdown — ту же логику, что и десктопные хоткеи, никакого
    // отдельного форматирующего кода):
    //   1) «по выделению» — выделили текст в textarea на мобильном layout —
    //      тулбар появляется сам (см. document 'selectionchange' ниже);
    //   2) «по кнопке» — кнопка «Aa» рядом с инпутом (см. formatToggleButton,
    //      видна только на мобильном layout, см. style.css) открывает тот же
    //      тулбар вручную (работает и без выделения — тогда кнопки вставляют
    //      пустую пару маркеров с курсором между ними, тот же фоллбэк
    //      поведения, что и у десктопных хоткеев без выделения).
    // Оба состояния независимы и складываются через ИЛИ — см.
    // updateFormatToolbarVisibility: тулбар виден, если открыт вручную (Aa)
    // ИЛИ прямо сейчас есть непустое выделение, и только на мобильном layout
    // (десктоп продолжает жить на горячих клавишах, без этого тулбара).
    function updateFormatToolbarVisibility() {
      const mobile = isMobileLayout();
      const hasSelection =
        mobile && document.activeElement === textInput && textInput.selectionStart !== textInput.selectionEnd;
      const shouldShow = mobile && (formatToolbarForcedOpen || hasSelection);
      formatToolbar.classList.toggle('hidden', !shouldShow);
      formatToggleButton.classList.toggle('chat-format-toggle-button--on', formatToolbarForcedOpen);
      formatToggleButton.setAttribute('aria-pressed', String(formatToolbarForcedOpen));
    }

    formatToggleButton.addEventListener('click', () => {
      formatToolbarForcedOpen = !formatToolbarForcedOpen;
      if (formatToolbarForcedOpen) textInput.focus();
      updateFormatToolbarVisibility();
    });

    // 'selectionchange' — глобальное DOM-событие (не у конкретного элемента):
    // фильтруем по activeElement внутри updateFormatToolbarVisibility. Ловит
    // и выделение свайпом/долгим тапом на телефоне, и программные изменения
    // выделения (в т.ч. textInput.setSelectionRange из самих же
    // wrapSelectionWithMarkers/insertLinkMarkdown после применения
    // форматирования — выделение схлопывается в курсор, hasSelection
    // становится false, и тулбар сам скрывается, если не закреплён кнопкой
    // «Aa»).
    document.addEventListener('selectionchange', () => {
      if (!isMobileLayout()) return;
      updateFormatToolbarVisibility();
    });

    // Кнопки тулбара: mousedown с preventDefault — чтобы тап по кнопке НЕ
    // забирал фокус (и вместе с ним выделение) у textarea ДО того, как
    // click-обработчик ниже успеет прочитать textInput.selectionStart/End
    // (по факту selectionStart/End не сбрасываются при потере фокуса — это
    // просто свойства DOM-элемента — но preventDefault на mousedown это
    // распространённый и более надёжный приём для тулбаров форматирования,
    // не полагающийся на данную деталь реализации браузера). click всё равно
    // срабатывает как обычно — preventDefault на mousedown отменяет только
    // фокусировку/выделение самой кнопки, не последующий click.
    formatToolbar.querySelectorAll('.chat-format-btn').forEach((btn) => {
      btn.addEventListener('mousedown', (event) => event.preventDefault());
      btn.addEventListener('click', () => {
        switch (btn.dataset.format) {
          case 'bold':
            wrapSelectionWithMarkers('**', '**');
            break;
          case 'italic':
            wrapSelectionWithMarkers('__', '__');
            break;
          case 'strike':
            wrapSelectionWithMarkers('~~', '~~');
            break;
          case 'spoiler':
            wrapSelectionWithMarkers('||', '||');
            break;
          case 'code':
            wrapSelectionWithMarkers('`', '`');
            break;
          case 'link':
            insertLinkMarkdown();
            break;
          default:
            break;
        }
        updateFormatToolbarVisibility();
      });
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

    const publicApi = {
      disableInput,
      enableInput,
      setChatForbidden,
      handleIncomingFileChannel,
      notifyContentEpochReady,
    };

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
      getChatKeyForEpoch: newGetChatKeyForEpoch,
      getCurrentContentEpoch: newGetCurrentContentEpoch,
      isContentEpochReady: newIsContentEpochReady,
    }) {
      signaling = newSignaling;
      bus = newBus;
      peerId = newPeerId;
      myName = name || null;
      getPeerIds = typeof newGetPeerIds === 'function' ? newGetPeerIds : () => [];
      getLeaderId = typeof newGetLeaderId === 'function' ? newGetLeaderId : () => null;
      getGuestChatAllowed = typeof newGetGuestChatAllowed === 'function' ? newGetGuestChatAllowed : () => true;
      getChatKeyForEpoch = typeof newGetChatKeyForEpoch === 'function' ? newGetChatKeyForEpoch : () => null;
      getCurrentContentEpoch = typeof newGetCurrentContentEpoch === 'function' ? newGetCurrentContentEpoch : () => 0;
      isContentEpochReady = typeof newIsContentEpochReady === 'function' ? newIsContentEpochReady : () => true;

      clearMessages();
      unreadCount = 0;
      updateUnreadBadge();
      errorBanner.classList.add('hidden');
      connectionLost = false;
      forbiddenByLeader = false;
      applyInputState();
      setCollapsed(true);

      bus.onMessage(dispatchEnvelope);
      // Ш1/Ш3 (E2E-шифрование + forward secrecy, см. static/crypto.js/room.js):
      // фоллбэк-релей сервера несёт конверт как {enc:{v,iv,ct}, epoch} (см.
      // sendEnvelopeToPeer выше) — расшифровываем ключом ИМЕННО той эпохи,
      // под которой конверт был зашифрован (не обязательно текущей — история/
      // запоздавшие сообщения могут быть под более старой), ПЕРЕД
      // dispatchEnvelope; по шине конверт приходит как обычно (не завёрнут,
      // эпоха ему не нужна — см. заголовок файла). Отсутствующее поле epoch
      // трактуется как эпоха 0 (обратная совместимость формата, хотя вживую
      // после этой волны такого конверта прийти уже не должно). Неверный
      // ключ/эпоха нам неизвестна/повреждённый блоб — тихо логируем и
      // игнорируем это одно сообщение (не валим всю панель чата — соседние
      // конверты по шине продолжают работать как ни в чём не бывало).
      signaling.on('chat', ({ fromPeerId, envelope }) => {
        if (envelope && typeof envelope === 'object' && envelope.enc) {
          const epoch = typeof envelope.epoch === 'number' ? envelope.epoch : 0;
          const key = getChatKeyForEpoch(epoch);
          if (!key) {
            console.warn(
              `Ш3: неизвестная эпоха ${epoch} контентного ключа — fallback-конверт чата проигнорирован (не должно случаться при корректной раздаче, см. docs/e2e-encryption.md)`
            );
            return;
          }
          RoomCrypto.decrypt(key, envelope.enc)
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
