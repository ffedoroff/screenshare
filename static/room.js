// room.js — единая страница комнаты, протокол v2 (симметричная комната).
//
// Все участники равноправны и соединяются mesh: на каждого другого участника
// заводится свой RtcPeer (см. rtc.js, perfect negotiation). Роль
// polite/impolite не привязана к типу участника (broadcaster/viewer больше
// нет) — она детерминированно выводится из сравнения peerId: у кого peerId
// лексикографически БОЛЬШЕ, тот polite. Обе стороны считают одно и то же
// сравнение над одной и той же парой id, поэтому ровно один из двух получает
// polite=true — коллизии офферов разрешаются как обычно (см. rtc.js).
//
// roomId берём из URL (последний сегмент pathname), как и раньше у viewer.js.

'use strict';

// --- Анонимность: leaderToken из фрагмента ссылки (см. static/landing.js —
// POST /api/rooms -> редирект на /r/<id>#lt=<token>&k=<key>&n=<имя>) читается
// ДО ВСЕГО остального. Из адресной строки вычищается ТОЛЬКО одноразовый #lt
// (после первого join он сожжён сервером и бесполезен, светить его незачем).
// `#n` (имя комнаты) вычищать не нужно — оно теперь ЧАСТЬ инвайт-ссылки (см.
// ниже) и остаётся в адресной строке у всех участников.
//
// Ключ комнаты #k СОЗНАТЕЛЬНО ОСТАЁТСЯ в адресной строке: ссылка = ключ по
// самой модели (ей и делятся), а сохранение k в URL позволяет пережить F5 —
// иначе перезагрузка выбрасывала бы из комнаты («ссылка неполная»), при том
// что хранить ключ в storage запрещено (полная анонимность). Тот же паттерн
// у Excalidraw. Фрагмент никогда не уходит на сервер сам по себе.
//
// Ключ комнаты (Ш1, E2E-шифрование, см. static/crypto.js): `k` парсится ЗДЕСЬ
// ЖЕ — до того, как страница успела показать что-либо, и до какого-либо
// обращения к сигналингу; от него выводятся sigKey (сигналинг) и metaKey
// (имя участника) — см. deriveRoomKeys. Оба неизменны на всю жизнь комнаты.
//
// `n` — имя комнаты, которое ввёл СОЗДАТЕЛЬ на лендинге (см. static/landing.js,
// static/namegen.js). Раньше жило только в одноразовом #lt-фрагменте и
// пропадало у создателя после первого F5, а гости его не видели вовсе.
// Теперь `n` — ЧАСТЬ инвайт-ссылки (buildShareLink кладёт его туда) и
// остаётся в адресной строке (`#k=...&n=...`) у ВСЕХ, кто зашёл по ссылке —
// имя комнаты видят все участники, оно переживает F5. Ключевой инвариант не
// изменился: сервер фрагмент не видит (он никогда не уходит по сети), так что
// название комнаты и для сервера остаётся неизвестным. Битый percent-encoding
// (напр. от ручного редактирования URL) не должен ронять страницу —
// decodeURIComponent в try/catch, при ошибке имя просто отсутствует (null).
const { initialLeaderToken, roomKeyBase64url, initialRoomName } = (() => {
  const hash = location.hash;
  const ltMatch = hash.match(/(?:^|[&#])lt=([^&]+)/);
  const kMatch = hash.match(/(?:^|[&#])k=([^&]+)/);
  const nMatch = hash.match(/(?:^|[&#])n=([^&]+)/);
  const lt = ltMatch ? decodeURIComponent(ltMatch[1]) : null;
  // `k` — base64url, состоит только из URL-safe символов (A-Za-z0-9-_) —
  // decodeURIComponent не нужен (и вреден не был бы, но не нужен).
  const k = kMatch ? kMatch[1] : null;
  let n = null;
  if (nMatch) {
    try {
      n = decodeURIComponent(nMatch[1]);
    } catch (err) {
      n = null; // битый percent-encoding — просто без имени, страницу не роняем
    }
  }
  if (lt) {
    // Пересобираем фрагмент без lt (одноразовый секрет — светить его в
    // адресной строке незачем), сохраняя k и n. `n` берём из уже
    // раскодированного `n` и энкодим заново (а не переносим nMatch[1] как
    // есть) — так гарантированно нет ни двойного кодирования, ни устаревшего
    // percent-encoding из невалидного/ручного URL.
    const parts = [];
    if (k) parts.push(`k=${k}`);
    if (n) parts.push(`n=${encodeURIComponent(n)}`);
    history.replaceState(null, '', location.pathname + location.search + (parts.length ? `#${parts.join('&')}` : ''));
  }
  return { initialLeaderToken: lt, roomKeyBase64url: k, initialRoomName: n };
})();

// --- Локальный рендер имени комнаты (видно ВСЕМ участникам, зашедшим по
// инвайт-ссылке с `n` — см. комментарий выше) — делаем это СРАЗУ, до init(),
// чтобы заголовок вкладки и шапка не мигали дефолтным текстом. Если в
// ссылке `n` не было (например, ссылка без имени комнаты), .room-logo/title
// остаются дефолтными.
if (initialRoomName) {
  document.title = `${initialRoomName} — video call`;
  const roomLogoEl = document.querySelector('.room-logo');
  if (roomLogoEl) roomLogoEl.textContent = initialRoomName;
}

// --- DOM ---
const joinModalEl = document.getElementById('join-modal');
const joinNameInputEl = document.getElementById('join-name-input');
const joinModalButtonEl = document.getElementById('join-modal-button');
const toastEl = document.getElementById('toast');
const overlayEl = document.getElementById('overlay');
const overlaySpinnerEl = document.getElementById('overlay-spinner');
const overlayTitleEl = document.getElementById('overlay-title');
const overlayTextEl = document.getElementById('overlay-text');
const overlayActionButtonEl = document.getElementById('overlay-action-button');
const participantCountEl = document.getElementById('participant-count');
const roomTimerEl = document.getElementById('room-timer');
const topbarSasEl = document.getElementById('topbar-sas');
const topbarSasPopupEl = document.getElementById('topbar-sas-popup');
const topbarSasPopupBackdropEl = document.getElementById('topbar-sas-popup-backdrop');
const topbarSasPopupEmojiEl = document.getElementById('topbar-sas-popup-emoji');
const topbarSasPopupTextEl = document.getElementById('topbar-sas-popup-text');
const topbarSasPopupHexEl = document.getElementById('topbar-sas-popup-hex');
const screenStageEl = document.getElementById('screen-stage');
const screenVideoEl = document.getElementById('screen-video');
const screenSelfPlaceholderEl = document.getElementById('screen-self-placeholder');
const screenCaptionEl = document.getElementById('screen-caption');
const tilesGridEl = document.getElementById('tiles-grid');
const roomMessageEl = document.getElementById('room-message');
const inviteCtaEl = document.getElementById('invite-cta');
const inviteCtaButtonEl = document.getElementById('invite-cta-button');
const micButton = document.getElementById('mic-button');
const cameraButton = document.getElementById('camera-button');
const screenButton = document.getElementById('screen-button');
const shareButton = document.getElementById('share-button');
const chatButton = document.getElementById('chat-button');
const leaveButton = document.getElementById('leave-button');
const sharePopupEl = document.getElementById('share-popup');
const sharePopupBackdropEl = document.getElementById('share-popup-backdrop');
const sharePopupCloseEl = document.getElementById('share-popup-close');
const sharePopupQrEl = document.getElementById('share-popup-qr');
const sharePopupLinkEl = document.getElementById('share-popup-link');
const sharePopupBuildEl = document.getElementById('share-popup-build');
const sharePopupBuildShortEl = document.getElementById('share-popup-build-short');
const sharePopupBuildFullEl = document.getElementById('share-popup-build-full');
const sharePopupCopyButtonEl = document.getElementById('share-popup-copy-button');
const reconnectBannerEl = document.getElementById('reconnect-banner');
const versionBannerEl = document.getElementById('version-banner');
const versionBannerReloadButtonEl = document.getElementById('version-banner-reload-button');

// --- DOM: права и лидер (см. docs/permissions-and-leader.md) ---
const settingsButton = document.getElementById('settings-button');
const settingsBadgeEl = document.getElementById('settings-badge');
const joinRequestsEl = document.getElementById('join-requests');
const settingsPanelEl = document.getElementById('settings-panel');
const settingsPanelBackdropEl = document.getElementById('settings-panel-backdrop');
const settingsPanelCloseEl = document.getElementById('settings-panel-close');
const settingsRoomSectionEl = document.getElementById('settings-room-section');
const settingLobbyInput = document.getElementById('setting-lobby');
const settingGuestChatInput = document.getElementById('setting-guest-chat');
const settingGuestAudioInput = document.getElementById('setting-guest-audio');
const settingGuestVideoInput = document.getElementById('setting-guest-video');
const settingGuestScreenInput = document.getElementById('setting-guest-screen');

// --- DOM: «Соединение и приватность» (см. раздел ниже) — видно ВСЕМ участникам ---
const settingsCryptoRowEl = document.getElementById('settings-crypto-row');
const settingsCryptoTextEl = document.getElementById('settings-crypto-text');
const settingsPeersListEl = document.getElementById('settings-peers-list');
const settingsSignalingCountEl = document.getElementById('settings-signaling-count');
const settingsServerTrafficEl = document.getElementById('settings-server-traffic');
const settingsBuildRowEl = document.getElementById('settings-build-row');
const settingsBuildTextEl = document.getElementById('settings-build-text');

// --- DOM: устройства (см. заголовок раздела «Выбор камеры и микрофона» ниже) — видно ВСЕМ участникам, не только лидеру ---
const settingMicDeviceSelect = document.getElementById('setting-mic-device');
const settingCameraDeviceSelect = document.getElementById('setting-camera-device');

// --- DOM: fullscreen кнопки сцены шаринга экрана ---
const screenFullscreenButtonEl = document.getElementById('screen-fullscreen-button');

// Статичная разметка (не зависит от пользовательских данных) — безопасна для innerHTML.
const CROWN_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 19h18l-1.6-9.6-5.2 3.6L12 5l-2.2 8-5.2-3.6L3 19z"/></svg>';

// Значок перечёркнутого микрофона на тайле (см. раздел «Индикатор
// «микрофон выключен»» ниже) — тоже статичная разметка.
const MIC_OFF_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="11" rx="3"></rect>' +
  '<path d="M5 10a7 7 0 0 0 14 0"></path>' +
  '<line x1="12" y1="19" x2="12" y2="22"></line>' +
  '<line x1="8" y1="22" x2="16" y2="22"></line>' +
  '<line x1="3" y1="3" x2="21" y2="21"></line>' +
  '</svg>';

// roomId — последний сегмент пути, например /r/abc123 -> "abc123".
const roomId = location.pathname.split('/').filter(Boolean).pop();

// Мобильные браузеры (Android Chrome, iOS Safari) не реализуют
// getDisplayMedia — нативного захвата экрана из веба на них нет вообще (это
// не вопрос разрешений, метода просто нет в API). Кнопку «Экран» в таком
// случае не дизейблим (это подразумевало бы «временно недоступно»), а прячем
// совсем — не обещаем функциональность, которой на этом устройстве не
// существует в принципе.
const screenShareSupported = !!(
  navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'
);
if (!screenShareSupported) {
  screenButton.classList.add('hidden');
}

// --- Ш1: криптографические ключи комнаты (см. static/crypto.js) ---
// Выводятся один раз при старте страницы из roomKeyBase64url (см. init/
// deriveRoomKeys ниже) — null, пока вывод не завершился (или не начинался).
let sigKey = null; // K_sig — sdp/candidate/info в серверном релее
let metaKey = null; // K_meta — отображаемое имя участника в join-room
// Взводится один раз на первую же неудачную расшифровку входящего
// (SDP/ICE/stream-info с серверного релея) — почти всегда значит, что ключ
// комнаты неверный (см. handleCryptoFailureOnce). Отдельно от terminalState,
// чтобы не показать оверлей дважды при параллельных отказах нескольких
// пиров сразу.
let cryptoFailureHandled = false;

// --- Общее состояние комнаты/сигналинга ---
let signaling = null;
let myPeerId = null;
let myName = null;
let joinedOnce = false;
// Как только показан «финальный» оверлей (ошибка/обрыв), больше не
// перетираем его сообщениями о попутных проблемах.
let terminalState = false;
// ICE-серверы, полученные один раз при первой загрузке страницы — переиспользуются
// при создании пиров как при обычных peer-joined, так и при реконнект-сверке.
let iceServersCache = null;

// --- SAS: человекоудобная проверка ключа (см. static/crypto.js: deriveSas,
// docs/security.md «SAS / MITM») ---
//
// ОДИН DTLS-сертификат на всю сессию, переиспользуемый во всех
// RTCPeerConnection этого участника (передаётся в RtcPeer через certificate)
// — чтобы у нас был единственный стабильный фингерпринт, одинаково видимый
// всеми пирами. Иначе браузер сгенерировал бы новый сертификат на каждое
// соединение и «отпечаток комнаты» не сошёлся бы. Генерируется один раз в
// connectAndJoin (ensureSessionCertificate) и переживает reconnect.
let sessionCertificate = null;
let ownCertFingerprint = null; // фингерпринт нашего sessionCertificate (нормализуется в crypto.js)

// --- SAS v2: commit-before-reveal раунд (см. docs/sas-verification.md) ---
//
// Раунд идентифицируется roundId = hash(состав по peerId ‖ их фингерпринты).
// Смена состава ИЛИ любого фингерпринта -> новый roundId -> свежий раунд с
// новыми нонсами (это и закрывает грайнд сертификата после ревила, §7.2).
let sasCurrentRoundId = null; // roundId текущего раунда, либо null
let sasRoundMembers = null; // снапшот [{peerId, fingerprint}] на старте раунда (фиксированный ожидаемый состав)
let sasMyNonce = null; // наш нонс текущего раунда (Uint8Array 32)
let sasCommits = new Map(); // peerId -> commitHex (свой + принятые с шины)
let sasReveals = new Map(); // peerId -> nonce (Uint8Array), свой + принятые и (позже) проверяемые
let sasRevealed = false; // раскрыли ли мы уже свой нонс в этом раунде (гейт: только после всех коммитов)
let sasState = 'hidden'; // hidden | unavailable | verifying | ok | mismatch
let sasResult = null; // { emoji:[...], hex } когда state==='ok'
let sasRefreshTimer = null;
const SAS_REFRESH_MS = 3000;

// --- Авто-reconnect сигналинга (переживает деплой/рестарт сервера) ---
//
// Ключевая идея: обрыв WS-сигналинга сам по себе НЕ должен рушить mesh
// (медиа/DataChannel-чат) — они физически не зависят от сигналинга и живут,
// пока живо само P2P-соединение (см. docs/self-hosting.md, «Surviving a
// Restart/Redeploy»). Поэтому неожиданный обрыв (не «Покинуть», не room-not-found/
// room-full — те уже терминальны сами по себе) запускает цикл
// переподключения с экспоненциальным бэкоффом вместо немедленного
// «Соединение потеряно».
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000]; // 1с→2с→4с→8с, дальше повторяется 8с (cap)
const RECONNECT_TOTAL_BUDGET_MS = 120_000; // суммарный бюджет попыток — около 2 минут
const RECONNECT_JOIN_TIMEOUT_MS = 8000; // сколько ждём ответ на join-room одной попытки
// Сколько ждём отставшего пира/владельца экрана после успешного реконнекта,
// прежде чем считать его окончательно ушедшим — остальные участники тоже
// переподключаются вразнобой, им нужно время на собственный реконнект.
const RECONNECT_PEER_GRACE_MS = 13_000;

let reconnecting = false;
let reconnectAttempt = 0;
let reconnectDeadline = 0;
let reconnectTimer = null;
// Взводится перед намеренным закрытием сокета самим пользователем (кнопка
// «Покинуть») — такое закрытие не должно триггерить авто-reconnect.
let intentionalDisconnect = false;
// Резолвер текущей попытки join-room в процессе реконнекта (см.
// waitForJoinOutcome/sendJoinAndWait) — обычные обработчики joined/
// room-not-found/room-full дополнительно репортят сюда исход, если он
// взведён, вместо (или в дополнение к) обычной обработки.
let pendingJoinResolve = null;
// peerId -> id таймера отложенного удаления пира, который не нашёлся в
// свежем joined.peers сразу после реконнекта (см. reconcileAfterReconnect).
const pendingPeerRemovals = new Map();
// Таймер грейс-периода для владельца экрана, который сам ещё не ре-джойнился
// после реконнекта (см. reconcileScreenShareAfterReconnect).
let screenOwnerGraceTimer = null;
// Версия приложения (см. GET /version.json), с которой была загружена эта
// страница — сверяется заново после каждого успешного реконнекта (стандарт
// version-skew баннера, см. docs/signaling-protocol.md, «GET /version.json»).
let lastKnownVersion = null;

// --- Лимит длительности созвона (3 часа, см. docs/security.md, «Meeting
// Duration Ceiling») ---
//
// Сервер сам считает и присылает остаток жизни комнаты в `joined.expiresInSeconds`
// (см. src/ws.rs::room_expires_in_seconds) — на КАЖДОМ joined, и при первом
// входе, и при реконнекте (после реконнекта остаток мог заметно измениться,
// если реконнект был долгим, поэтому дедлайн всегда пересчитывается заново из
// свежего значения, а не переживает реконнект как есть, см. startRoomTimer).
// Когда время истекает, сервер сам рассылает `room-expired` всем участникам
// (и ожидающим в лобби) и закрывает сокет — см. signaling.on('room-expired')
// в registerSignalingHandlers ниже.
const ROOM_TIMER_WARNING_MS = 10 * 60 * 1000; // последние 10 минут — жёлтый
const ROOM_TIMER_CRITICAL_MS = 60 * 1000; // последняя минута — красный
let roomExpiresAtMs = null; // Date.now() на момент joined + expiresInSeconds*1000, null до первого joined
let roomTimerInterval = null;

/** Ч:ММ:СС из миллисекунд (не может быть отрицательным — вызывающая сторона зажимает снизу в 0). */
function formatRoomTimer(remainingMs) {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Раз в секунду — пересчитать остаток и перекрасить пилюлю таймера по порогам (см. ROOM_TIMER_*_MS). */
function updateRoomTimerDisplay() {
  if (roomExpiresAtMs === null) return;
  const remainingMs = roomExpiresAtMs - Date.now();
  roomTimerEl.textContent = formatRoomTimer(remainingMs);
  roomTimerEl.classList.toggle('room-timer--warning', remainingMs <= ROOM_TIMER_WARNING_MS && remainingMs > ROOM_TIMER_CRITICAL_MS);
  roomTimerEl.classList.toggle('room-timer--critical', remainingMs <= ROOM_TIMER_CRITICAL_MS);
  roomTimerEl.classList.remove('hidden');
}

/** Вызывается на КАЖДОМ joined (первый вход и реконнект) — пересчитывает дедлайн из свежего expiresInSeconds. */
function startRoomTimer(expiresInSeconds) {
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds)) return;
  roomExpiresAtMs = Date.now() + expiresInSeconds * 1000;
  updateRoomTimerDisplay();
  if (!roomTimerInterval) {
    roomTimerInterval = setInterval(updateRoomTimerDisplay, 1000);
  }
}

/** Комната истекла (room-expired) — таймер больше не идёт, дальше показывать нечего. */
function stopRoomTimer() {
  if (roomTimerInterval) {
    clearInterval(roomTimerInterval);
    roomTimerInterval = null;
  }
  roomExpiresAtMs = null;
  roomTimerEl.classList.add('hidden');
}

// peerId -> { rtc: RtcPeer, name, tile: {root, videoEl, placeholderEl, labelEl, crownEl} }
const peers = new Map();
// peerId -> имя (включая себя не храним — своё имя в myName).
const peerNames = new Map();
// peerId -> { bytesSent, bytesReceived, ts } — снимок счётчиков transport-статы
// с ПРЕДЫДУЩЕГО тика единого поллера скоростей (PEER_STATS_REFRESH_MS, см.
// pollPeerStats/computePeerConnectionStats дальше в файле) — точка отсчёта
// для расчёта скорости in/out между тиками. Чистим запись при уходе пира
// (removeRemotePeer) — иначе, если тот же peerId переиспользуется в новом
// соединении, скорость на первом тике посчиталась бы от чужих старых байт.
const peerStatsHistory = new Map();
// { bytesSent, bytesReceived, ts } с ПРЕДЫДУЩЕГО вызова renderServerCounters —
// точка отсчёта для скорости строки «Server relay traffic» в секции
// «Соединение и приватность». Тот же приём, что peerStatsHistory выше, только
// для агрегированного счётчика серверного WS (static/common.js: ConnStats),
// а не per-peer WebRTC-транспорта — и, в отличие от peerStatsHistory, здесь
// нет getStats(), поэтому обновляется прямо в рендере (см. formatPeerStatsLine
// ниже), а не в едином поллере. null до первого вызова.
let serverBytesHistory = null;
// Свой тайл (создаётся сразу после joined).
let ownTile = null;
// Объект тайла (как из createTile), сейчас развёрнутый на всю страницу
// кликом (см. maximizeTile/unmaximizeTile), либо null. Одновременно
// максимизирован только один тайл — свой или чужой.
let maximizedTile = null;

// --- Права и лидер (см. docs/permissions-and-leader.md) ---
let leaderId = null;
let isLeader = false;
// RoomSettings с сервера (см. src/protocol.rs::RoomSettings) — null до первого joined.
let roomSettings = null;
// Заявки лобби, видимые ТОЛЬКО лидеру: [{ peerId, name }].
let pendingRequests = [];
let toastTimer = null;
// peerId -> { mic: {stream, track} | null, camera: {stream, track, enabled} | null } —
// храним ссылки на входящие треки гостей НЕЗАВИСИМО от того, разрешено ли их
// сейчас рендерить, чтобы можно было ретроактивно показать/скрыть при смене
// guestAudio/guestVideo на лету (см. refreshMediaRenderingForPeer).
const peerMediaRefs = new Map();

// Ф0: шина комнаты поверх mesh RTCDataChannel (см. bus.js/rtc.js) — общая
// для чата (chat.js) и будущих фич, живёт на протяжении всей сессии в
// комнате (пира регистрируем/снимаем синхронно с peers, см.
// createRemotePeer/removeRemotePeer).
const bus = new Bus();

// --- Локальные медиа ---
let micStream = null;
let micTrack = null;
let micRequestInProgress = false;

let camStream = null;
let camTrack = null;
let camRequestInProgress = false;

// --- Выбор устройств (см. раздел «Камера и микрофон» ниже) ---
//
// Выбор пользователя живёт ТОЛЬКО в памяти вкладки (никакого localStorage —
// анонимность, см. docs/privacy.md, «Anonymity») и переживает выключение/включение мика или
// камеры кнопкой, но не reload/переход в другую комнату.
// selected*DeviceId — то, что выбрано в селекте прямо сейчас (желаемое);
// current*DeviceId — deviceId, реально стоящий за активным треком (что
// сейчас физически захвачено). Они расходятся, когда пользователь выбрал
// устройство, ПОКА мик/камера выключены кнопкой — реальное переключение
// тогда откладывается до следующего включения (см. micButton/cameraButton
// click).
let selectedMicDeviceId = null;
let selectedCamDeviceId = null;
let currentMicDeviceId = null;
let currentCamDeviceId = null;

let screenStream = null;
// peerId текущего владельца экрана (может быть myPeerId) или null.
let currentScreenOwnerPeerId = null;
// Резолвер ожидания решения сервера на share-start (see screenButton click).
let pendingShareDecision = null;

// --- Маршрутизация входящих треков по stream-info ---
// streamId -> { kind: 'mic'|'camera'|'screen', name }
const streamInfoMap = new Map();
// streamId -> [{ peerId, stream, track }] — треки, для которых ontrack уже
// случился, а соответствующий stream-info ещё не пришёл (гонка реальна).
const pendingTracks = new Map();

// peerId -> <audio> со скрытым входящим микрофоном.
const micAudioEls = new Map();
// peerId -> функция stop() монитора уровня звука (см. common.js: SpeakingDetection).
const micMonitors = new Map();
// streamId -> peerId, чей это входящий поток камеры — нужно, чтобы применить
// обновление `enabled` из повторного stream-info (см. broadcastStreamEnabled).
const cameraStreamOwner = new Map();
// То же самое для потоков микрофона — нужно применять обновление `enabled`
// к индикатору «микрофон выключен» на тайле (см. applyMicEnabledUpdate).
const micStreamOwner = new Map();

let chat = null;

// ---------- Оверлей ----------

// `onAction` — необязательный колбэк для кнопки оверлея; по умолчанию (не
// передан) кнопка ведёт на главную (см. overlayActionButtonEl ниже) — так
// работали «Комната не найдена»/«Комната заполнена» и раньше. Лобби
// («Ожидание одобрения…») переопределяет его на «Отменить» = leave + на
// главную (см. registerSignalingHandlers: signaling.on('waiting', ...)).
let overlayActionHandler = null;

function showOverlay({ title, text = '', spinner = false, actionLabel = null, onAction = null }) {
  overlayEl.classList.remove('hidden');
  overlayTitleEl.textContent = title;
  overlayTextEl.textContent = text;
  overlaySpinnerEl.classList.toggle('hidden', !spinner);
  overlayActionHandler = onAction;
  if (actionLabel) {
    overlayActionButtonEl.textContent = actionLabel;
    overlayActionButtonEl.classList.remove('hidden');
  } else {
    overlayActionButtonEl.classList.add('hidden');
  }
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

overlayActionButtonEl.addEventListener('click', () => {
  if (overlayActionHandler) {
    overlayActionHandler();
  } else {
    location.href = '/';
  }
});

// ---------- Ш1: криптографические ключи комнаты ----------

/**
 * Вывести sigKey/metaKey/эпоху 0 контентных ключей из roomKeyBase64url (см.
 * верх файла). Возвращает false при ЛЮБОЙ проблеме: `k` отсутствует в
 * ссылке, не декодируется как base64url, декодируется не в 32 байта, либо
 * сам HKDF/AES-GCM отказался (WebCrypto недоступен и т.п.) — вызывающая
 * сторона (см. init ниже) трактует false как «ссылка неполная».
 */
async function deriveRoomKeys() {
  if (!roomKeyBase64url) return false;
  let rawKey;
  try {
    rawKey = RoomCrypto.base64urlToBytes(roomKeyBase64url);
  } catch (err) {
    console.error('Не удалось декодировать ключ комнаты из ссылки:', err);
    return false;
  }
  try {
    const keys = await RoomCrypto.deriveKeys(rawKey);
    sigKey = keys.sig;
    metaKey = keys.meta;
    return true;
  } catch (err) {
    console.error('Не удалось вывести криптографические ключи комнаты:', err);
    return false;
  }
}

/** Оверлей «ссылка неполная» — вход без валидного `k` ИЛИ первая же неудачная расшифровка входящего (см. handleCryptoFailureOnce) трактуются одинаково: с этим ключом (или без него) в комнате всё равно ничего не заработает. */
function showInvalidLinkOverlay() {
  terminalState = true;
  // join-modal видна ПО УМОЛЧАНИЮ (в разметке room.html у неё нет класса
  // .hidden — её прячет/показывает только JS, см. showJoinModal/hideJoinModal
  // ниже) и её z-index ВЫШЕ, чем у #overlay (см. static/style.css) — если её
  // явно не спрятать здесь, она осталась бы поверх этого оверлея (и
  // технически кликабельной) в сценарии «ключ невалиден ещё до входа»,
  // когда showJoinModal() вообще не успел выполниться.
  hideJoinModal();
  showOverlay({
    title: 'Link is invalid',
    text: 'Ask a room participant for a new link.',
    actionLabel: 'Go home',
  });
}

/**
 * Первая неудачная расшифровка входящего с серверного релея (SDP/ICE/
 * stream-info — см. static/rtc.js: onCryptoFailure, и signaling.on('stream-info')
 * ниже) — почти наверняка означает, что ключ комнаты у нас неверный
 * (испорчен при копировании, урезан и т.п.): с правильным ключом GCM-тег
 * почти никогда не собьётся сам по себе. Показываем тот же оверлей, что и
 * при отсутствующем `k` — с точки зрения пользователя разница не важна,
 * результат один и тот же («эта ссылка не работает, нужна новая»).
 */
function handleCryptoFailureOnce(err) {
  if (cryptoFailureHandled || terminalState) return;
  cryptoFailureHandled = true;
  console.error('Похоже, ключ комнаты неверен (не удалось расшифровать входящее сообщение):', err);
  showInvalidLinkOverlay();
  if (signaling) signaling.close();
}

/** Зашифровать собственное имя (см. K_meta) для поля `name` в join-room — см. src/protocol.rs::ClientMessage::JoinRoom, поле остаётся String на проводе. */
function encryptMyName() {
  return RoomCrypto.encryptToBase64(metaKey, { name: myName || null });
}

/**
 * Расшифровать имя ДРУГОГО участника (K_meta) — используется для peers из
 * joined/peer-joined/join-request. Любая проблема (отсутствует, невалидный
 * блоб, неверный ключ) -> null, что везде по коду трактуется как «Гость»
 * (см. displayName в static/chat.js и label тайла в createTile ниже) —
 * намеренно мягкий отказ: одно нерасшифровавшееся имя не должно ронять всю
 * остальную комнату (в отличие от отказа расшифровки SDP, см.
 * handleCryptoFailureOnce выше).
 */
async function decryptPeerName(cipherName) {
  if (!cipherName) return null;
  try {
    const obj = await RoomCrypto.decryptFromBase64(metaKey, cipherName);
    return obj && typeof obj.name === 'string' && obj.name ? obj.name : null;
  } catch (err) {
    console.warn('Не удалось расшифровать имя участника — показываем «Гость»:', err);
    return null;
  }
}

// SAS v2 (см. docs/sas-verification.md, стейт-машина ниже). fromPeerId —
// АУТЕНТИФИЦИРОВАННЫЙ транспортный отправитель (bus зовёт обработчики с ним,
// см. H3 в docs/security.md): сообщения не несут self-declared id, подмена
// автора невозможна. Сообщения не своего раунда игнорируются.
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'sas-commit') return;
  if (obj.round !== sasCurrentRoundId || typeof obj.commit !== 'string') return;
  if (!sasCommits.has(fromPeerId)) sasCommits.set(fromPeerId, obj.commit);
  sasTryComplete().catch((err) => console.warn('SAS: обработка sas-commit не удалась:', err));
});
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'sas-reveal') return;
  if (obj.round !== sasCurrentRoundId || typeof obj.nonce !== 'string') return;
  try {
    sasReveals.set(fromPeerId, RoomCrypto.base64urlToBytes(obj.nonce));
  } catch {
    return;
  }
  sasTryComplete().catch((err) => console.warn('SAS: обработка sas-reveal не удалась:', err));
});

// ---------- Ненавязчивые сообщения ----------

let roomMessageTimer = null;
function showRoomMessage(text) {
  roomMessageEl.textContent = text;
  roomMessageEl.classList.remove('hidden');
  if (roomMessageTimer) clearTimeout(roomMessageTimer);
  roomMessageTimer = setTimeout(() => {
    roomMessageEl.classList.add('hidden');
  }, 4000);
}

/** Ненавязчивый тост (смена лидера и т.п., см. docs/permissions-and-leader.md) — отдельно от showRoomMessage (та зарезервирована под предупреждения/ошибки). */
function showToast(text, ms = 3000) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, ms);
}

// ---------- Баннер переподключения сигналинга ----------

function showReconnectBanner() {
  reconnectBannerEl.classList.remove('hidden');
}

function hideReconnectBanner() {
  reconnectBannerEl.classList.add('hidden');
}

// ---------- Баннер version-skew ----------

async function fetchVersion() {
  try {
    // Ш2: через window.API_BASE (см. static/config.js) — /version.json живёт
    // на API-хосте, не обязательно совпадающем с origin этой страницы.
    const res = await fetch(`${window.API_BASE}/version.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.version) || null;
  } catch (err) {
    return null;
  }
}

/** Сравнить текущую серверную версию с той, с которой была загружена страница. Никогда не «забывает» уже показанное расхождение. */
async function checkVersionSkew() {
  const current = await fetchVersion();
  if (current && lastKnownVersion && current !== lastKnownVersion) {
    versionBannerEl.classList.remove('hidden');
  }
}

versionBannerReloadButtonEl.addEventListener('click', () => {
  location.reload();
});

// ---------- Build-хэш опубликованной статики (форензический якорь, см.
// docs/security.md, «Published Build Hash») ----------
//
// /build-hash.json лежит РЯДОМ со страницей — корень бандла на Cloudflare
// Pages (см. .github/workflows/deploy-prod.yml, job deploy-pages), same-origin
// fetch, НЕ через window.API_BASE (в отличие от /version.json выше — тот
// живёт на сигналинг-хосте, этот — на хосте статики, см. Ш2 в
// docs/self-hosting.md §1.2). В dev/self-hosted сборке файла нет вообще
// (нет такого маршрута на сервере, см. src/main.rs) — тогда все три места
// показа (лендинг, попап «Поделиться», настройки) остаются скрытыми,
// ничего не падает. Кэш — только в памяти вкладки (fetch ровно один раз),
// без localStorage — анонимность страницы не нарушается.
//
// ВАЖНО: это НЕ криптогарантия (см. docs/security.md §10.4) — хостер
// статики теоретически может подменить и сам build-hash.json заодно с
// остальным бандлом. Настоящая сверка — с GitHub Release, независимым
// каналом, а не с тем, что показывает эта же страница.
let buildHashInfo = null;
let buildHashPromise = null;

function fetchBuildHashOnce() {
  if (!buildHashPromise) {
    buildHashPromise = (async () => {
      try {
        const res = await fetch('/build-hash.json');
        if (!res.ok) return null; // dev/self-hosted без build-hash.json — штатно
        const data = await res.json();
        if (!data || typeof data.hash !== 'string' || !data.hash) return null;
        return data;
      } catch (err) {
        return null;
      }
    })().then((data) => {
      buildHashInfo = data;
      return data;
    });
  }
  return buildHashPromise;
}

/**
 * Строка «build: <короткий хэш>… + verify» в попапе «Поделиться» — рядом со
 * ссылкой/QR, НЕ внутри них (см. static/room.html). Формат — как в подвале
 * лендинга (static/index.html/landing.js: loadBuildHash): 10 символов хэша +
 * многоточие в summary, полный хэш — по раскрытию (details) и в title,
 * ссылка «verify» ведёт на тот же GitHub Releases.
 */
function renderShareBuildLine() {
  if (!buildHashInfo) {
    sharePopupBuildEl.classList.add('hidden');
    sharePopupBuildShortEl.textContent = '';
    sharePopupBuildFullEl.textContent = '';
    sharePopupBuildEl.title = '';
    return;
  }
  sharePopupBuildShortEl.textContent = `${buildHashInfo.hash.slice(0, 10)}…`;
  sharePopupBuildFullEl.textContent = buildHashInfo.hash;
  sharePopupBuildEl.title = buildHashInfo.hash;
  sharePopupBuildEl.classList.remove('hidden');
}

/** Необязательная строка в «Соединение и приватность» — тот же хэш, для тех, кто туда заглядывает вместо попапа «Поделиться». */
function renderSettingsBuildRow() {
  if (!buildHashInfo) {
    settingsBuildRowEl.classList.add('hidden');
    return;
  }
  settingsBuildTextEl.textContent = `Build: ${buildHashInfo.hash.slice(0, 12)}…`;
  settingsBuildTextEl.title = buildHashInfo.hash;
  settingsBuildRowEl.classList.remove('hidden');
}

fetchBuildHashOnce().then(() => {
  renderShareBuildLine();
  renderSettingsBuildRow();
});

// ---------- Воспроизведение с фоллбэком на mute при блокировке автовоспроизведения ----------

function safePlay(el) {
  const p = el.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      if (!el.muted) {
        el.muted = true;
        el.play().catch(() => {});
      }
    });
  }
}

// ---------- Тайлы участников ----------

/**
 * Детерминированный оттенок из peerId — чтобы заглушки без камеры отличались
 * друг от друга живым цветом, а не были одинаковыми синими кругами. Тот же
 * peerId всегда даёт тот же градиент (в т.ч. между перезаходами), т.к. хэш
 * чисто строковый, без случайности.
 */
function hueFromPeerId(peerId) {
  let hash = 0;
  const str = String(peerId || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

// ---------- Best-fit раскладка грида тайлов ----------
//
// Цель (см. задание): тайлы должны занимать максимум доступного места сцены
// с сохранением фиксированной пропорции 16:9 (см. .tile: aspect-ratio в
// static/style.css), а не жить в узком фиксированном диапазоне ширины
// колонки (было: grid-template-columns: repeat(auto-fit, minmax(220px,260px))
// — тайлы почти никогда не росли больше 260px, даже если сцена огромна).
//
// Алгоритм: перебираем число колонок 1..N (N — число тайлов), для каждого
// варианта считаем МАКСИМАЛЬНЫЙ размер тайла с аспектом 16:9, который влезает
// и по ширине (containerWidth, поделённой на колонки с учётом зазоров), и по
// высоте (containerHeight, поделённой на получившееся число строк) —
// сначала пробуем «упереться» в ширину колонки, и если высота при таком
// масштабе не влезает в строку — масштабируем по высоте вместо ширины (тайл
// всегда останется 16:9, лишнее место просто остаётся пустым по краю). Из
// всех вариантов cols выбираем тот, что даёт МАКСИМАЛЬНУЮ площадь одного
// тайла — это и есть «лучше всего заполняет сцену».
//
// Результат применяется ОДНИМ инлайн grid-template-columns с явной шириной
// колонки в px (а не через --tile-w/--tile-h переменные) — этого достаточно:
// .tile уже имеет aspect-ratio: 16/9 в CSS, поэтому высота тайла следует из
// проставленной ширины трека автоматически, без отдельного управления
// высотой. Единственный побочный эффект — этот инлайн-стиль имеет более
// высокий приоритет, чем любые CSS-правила grid-template-columns (в т.ч.
// .tiles-grid--solo и мобильный @media), так что best-fit сознательно
// подменяет их собой везде, где он применяется (то есть везде, кроме
// --compact/--spotlight — см. layoutTilesGrid).
const TILE_ASPECT_RATIO = 16 / 9;

/**
 * Перебор числа колонок — возвращает { cols, tileWidth, tileHeight } с
 * максимальной площадью тайла, либо null, если контейнер/список тайлов пуст.
 */
function computeBestFitTileLayout(containerWidth, containerHeight, tileCount, gapPx) {
  if (tileCount <= 0 || containerWidth <= 0 || containerHeight <= 0) return null;
  let best = null;
  for (let cols = 1; cols <= tileCount; cols++) {
    const rows = Math.ceil(tileCount / cols);
    const cellWidth = (containerWidth - gapPx * (cols - 1)) / cols;
    const cellHeight = (containerHeight - gapPx * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    let tileWidth = cellWidth;
    let tileHeight = tileWidth / TILE_ASPECT_RATIO;
    if (tileHeight > cellHeight) {
      // Ширина колонки позволила бы тайл выше строки — масштабируем по
      // высоте вместо этого (аспект 16:9 сохраняется в любом случае).
      tileHeight = cellHeight;
      tileWidth = tileHeight * TILE_ASPECT_RATIO;
    }
    const area = tileWidth * tileHeight;
    if (!best || area > best.area) best = { cols, tileWidth, tileHeight, area };
  }
  return best;
}

/**
 * Доступное место для #tiles-grid внутри .room-stage — сцена делится с
 * другими видимыми детьми (главным образом #screen-stage, когда кто-то
 * шарит экран, и #invite-cta в одиночной комнате), поэтому из полного
 * content-box .room-stage вычитаем высоту+gap каждого другого ВИДИМОГО
 * прямого ребёнка (общий подход, не привязанный к тому, что это именно
 * screen-stage — если появится ещё один сосед, учтётся автоматически).
 */
function computeAvailableGridBox() {
  const stage = tilesGridEl.parentElement;
  if (!stage) return { width: 0, height: 0 };
  const stageRect = stage.getBoundingClientRect();
  const cs = getComputedStyle(stage);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const stageGap = parseFloat(cs.rowGap || cs.gap) || 0;

  let width = stageRect.width - padLeft - padRight;
  let height = stageRect.height - padTop - padBottom;

  for (const sibling of stage.children) {
    if (sibling === tilesGridEl || sibling.classList.contains('hidden')) continue;
    const h = sibling.getBoundingClientRect().height;
    if (h > 0) height -= h + stageGap;
  }

  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Пересчитать и применить best-fit раскладку — вызывается при изменении
 * числа тайлов (см. updateSoloState, вызывается из updateParticipantCount),
 * при тоггле --compact (showScreenStageContainer/hideScreenStage — через тот
 * же updateSoloState) и на resize окна (см. слушатель ниже). Не трогает
 * --compact (лента при шаринге экрана — своя flex-раскладка с фиксированной
 * шириной тайла, см. static/style.css) и --spotlight (лента максимизации —
 * тоже своя CSS-раскладка, см. updateSpotlightMode) — там best-fit был бы не
 * к месту и конфликтовал бы с их собственной геометрией.
 */
function layoutTilesGrid() {
  if (tilesGridEl.classList.contains('tiles-grid--compact')) return;
  if (tilesGridEl.classList.contains('tiles-grid--spotlight')) return;
  const tileCount = tilesGridEl.children.length;
  if (tileCount === 0) return;
  const { width, height } = computeAvailableGridBox();
  const gapPx = parseFloat(getComputedStyle(tilesGridEl).columnGap) || 0;
  const best = computeBestFitTileLayout(width, height, tileCount, gapPx);
  if (!best) return;
  tilesGridEl.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.tileWidth)}px)`;
}

// Ресайз окна (поворот телефона, изменение размера окна десктоп-браузера,
// DevTools) — единственный из трёх триггеров пересчёта (см. комментарий
// layoutTilesGrid), который не проходит уже через updateSoloState.
window.addEventListener('resize', layoutTilesGrid);

function createTile(peerId, name, isOwn) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isOwn ? ' tile--own' : '');
  tile.dataset.peerId = peerId;
  tile.dataset.name = name || '';

  const video = document.createElement('video');
  video.className = 'tile-video hidden';
  video.autoplay = true;
  video.playsInline = true;
  if (isOwn) {
    video.muted = true;
    video.classList.add('tile-video--mirror');
  }

  // Заглушка без видео: аватар-круг (буква/эмодзи) + имя КРУПНО под ним (см.
  // требование «в 2 раза крупнее» — .tile-placeholder-avatar/-letter в
  // static/style.css). .tile-placeholder — теперь просто flex-контейнер на
  // весь тайл, круг с градиентом переехал в отдельный .tile-placeholder-avatar
  // (раньше градиент/форма круга жили прямо на .tile-placeholder).
  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';

  const avatar = document.createElement('div');
  avatar.className = 'tile-placeholder-avatar';
  const hue = hueFromPeerId(peerId);
  avatar.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 45) % 360}, 70%, 32%))`;

  const letter = document.createElement('span');
  letter.className = 'tile-placeholder-letter';
  const trimmedName = (name || '').trim();
  // Первый графем-кластер, а не charAt(0): на имени, начинающемся с эмоджи
  // (см. static/namegen.js: userName()), charAt(0) вернул бы половину
  // суррогатной пары («�»). Intl.Segmenter — точный способ; фолбэк [...str][0]
  // берёт первую код-точку целиком (корректно для однокодпойнтных эмодзи
  // ANIMALS, см. namegen.js). toUpperCase() на эмодзи — no-op, это ок.
  const firstGrapheme = trimmedName
    ? (typeof Intl !== 'undefined' && Intl.Segmenter
        ? [...new Intl.Segmenter().segment(trimmedName)][0]?.segment
        : [...trimmedName][0])
    : null;
  letter.textContent = firstGrapheme ? firstGrapheme.toUpperCase() : '?';
  avatar.appendChild(letter);
  placeholder.appendChild(avatar);

  const placeholderName = document.createElement('div');
  placeholderName.className = 'tile-placeholder-name';
  placeholder.appendChild(placeholderName);

  // Угловая подпись (видна только когда идёт видео — см. setTileVideoVisible
  // ниже: на заглушке имя уже крупно показано по центру, дублировать его в
  // углу незачем). Корона лидера теперь ВНУТРИ этой же плашки, инлайн перед
  // именем (раньше была отдельным абсолютно позиционированным элементом в
  // верхнем левом углу — там же, где теперь и имя, см. static/style.css).
  const label = document.createElement('div');
  label.className = 'tile-name hidden';

  const crown = document.createElement('span');
  crown.className = 'tile-crown hidden';
  crown.setAttribute('aria-hidden', 'true');
  crown.innerHTML = CROWN_ICON_SVG; // статичная разметка, не пользовательские данные
  label.appendChild(crown);

  const labelText = document.createElement('span');
  labelText.className = 'tile-name-text';
  label.appendChild(labelText);

  const labelValue = isOwn ? `You${trimmedName ? ` (${trimmedName})` : ''}` : (trimmedName || 'Guest');
  labelText.textContent = labelValue;
  placeholderName.textContent = labelValue;

  // Индикатор «микрофон выключен/отсутствует» (см. static/style.css:
  // .tile-mic-off) — виден ПО УМОЛЧАНИЮ (не .hidden): до первого
  // включения/stream-info трека у этого участника действительно ещё нет,
  // что по заданию тоже показывает значок (см. setTileMicOff/applyMicEnabledUpdate).
  const micOff = document.createElement('span');
  micOff.className = 'tile-mic-off';
  micOff.setAttribute('aria-hidden', 'true');
  micOff.innerHTML = MIC_OFF_ICON_SVG; // статичная разметка, не пользовательские данные

  // Бейдж скорости (см. static/style.css: .tile-speed, static/room.js:
  // updateTileSpeedBadges) — скрыт по умолчанию: скорость известна не раньше
  // первого тика поллера скоростей, где для этого пира уже набралось два
  // снимка трафика (см. pollPeerStats). Свободный угол — правый нижний
  // (верхние заняты именем/короной и микрофоном, см. static/style.css).
  const speed = document.createElement('span');
  speed.className = 'tile-speed hidden';
  speed.setAttribute('aria-hidden', 'true');

  tile.appendChild(video);
  tile.appendChild(placeholder);
  tile.appendChild(label);
  tile.appendChild(micOff);
  tile.appendChild(speed);

  if (isOwn) {
    tilesGridEl.prepend(tile);
  } else {
    tilesGridEl.appendChild(tile);
  }

  const tileObj = {
    root: tile,
    videoEl: video,
    placeholderEl: placeholder,
    labelEl: label,
    labelTextEl: labelText,
    placeholderNameEl: placeholderName,
    crownEl: crown,
    micOffEl: micOff,
    speedEl: speed,
  };

  // Клик по тайлу — тоггл «на всю страницу» (см. maximizeTile/unmaximizeTile
  // и .tile--maximized/.tiles-grid--spotlight в style.css). Вешаем один раз
  // тут, а не глобальным делегированием на #tiles-grid, — у тайла и так уже
  // есть замыкание на свои videoEl/tileObj, лишний обход DOM не нужен.
  // closest('button') — на будущее: если внутри тайла появятся кнопки, клик
  // по ним не должен тоглить максимизацию. Клик по УЖЕ максимизированному
  // (в т.ч. по спотлайту) тайлу снимает режим; клик по ЛЮБОМУ ДРУГОМУ тайлу с
  // живым видео (в т.ч. по мелкому в ленте спотлайта) — maximizeTile сама
  // снимает предыдущий и ставит новый максимизированный («последний клик
  // побеждает»).
  tile.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (maximizedTile === tileObj) {
      unmaximizeTile();
    } else if (!video.classList.contains('hidden')) {
      // Максимизировать есть смысл только когда видео реально показывается —
      // на голой заглушке (аватар-плейсхолдер) разворачивать нечего.
      maximizeTile(tileObj);
    }
  });

  return tileObj;
}

/**
 * Развернуть тайл на всю страницу поверх всего интерфейса. Сознательно
 * простой fixed-оверлей (см. .tile--maximized), а НЕ Fullscreen API:
 * во-первых, по заданию это тоггл «на всю страницу» (в пределах вкладки), а
 * не «на весь экран» — F11-подобный режим не нужен и был бы неожиданным для
 * пользователя; во-вторых, полноэкранный показ шаринга экрана
 * (#screen-fullscreen-button/requestFullscreenCompat) — это ДРУГАЯ сцена и
 * другой механизм (настоящий Fullscreen API), им незачем пересекаться:
 * fixed-оверлей просто рисуется поверх (z-index выше всего остального) и не
 * лезет в top-layer браузера.
 *
 * «Спотлайт»: если помимо максимизируемого тайла в комнате есть другие
 * (см. updateSpotlightMode) — они не пропадают, а становятся мелкой лентой
 * рядом (справа на десктопе, снизу на мобильном — см. .tiles-grid--spotlight
 * в static/style.css). Это ЧИСТО CSS-эффект: ноды тайлов не перемещаются
 * (иначе видео в них перезапустилось бы), максимизированный тайл — та же
 * .tile--maximized, просто её position:fixed-геометрия сокращена под ленту,
 * а остальные тайлы — обычные дети грида, который на время спотлайта сам
 * превращается в flex-контейнер ленты (см. updateSpotlightMode).
 */
function maximizeTile(tile) {
  if (maximizedTile === tile) return;
  if (maximizedTile) unmaximizeTile(); // защита: максимизированным может быть только один тайл одновременно
  maximizedTile = tile;
  tile.root.classList.add('tile--maximized');
  updateSpotlightMode();
  document.addEventListener('keydown', onMaximizedTileKeydown);
}

/** Свернуть текущий максимизированный тайл обратно в грид. */
function unmaximizeTile() {
  if (!maximizedTile) return;
  maximizedTile.root.classList.remove('tile--maximized');
  maximizedTile = null;
  updateSpotlightMode();
  document.removeEventListener('keydown', onMaximizedTileKeydown);
}

function onMaximizedTileKeydown(event) {
  if (event.key === 'Escape') unmaximizeTile();
}

/**
 * Включить/выключить класс ленты спотлайта на гриде (см. .tiles-grid--spotlight
 * в static/style.css) — вызывается из maximizeTile/unmaximizeTile И из
 * updateParticipantCount (состав может меняться, пока кто-то максимизирован:
 * подключился новый участник — должен появиться в ленте; последний другой
 * участник ушёл — лента больше не нужна, максимизированный тайл занимает весь
 * экран как раньше). Лента включается только если, кроме максимизированного,
 * есть хоть один другой тайл — иначе (максимизировали единственный тайл в
 * пустой комнате) показывать пустую полосу ленты незачем.
 */
function updateSpotlightMode() {
  const hasOthers = maximizedTile !== null && 1 + peers.size > 1;
  tilesGridEl.classList.toggle('tiles-grid--spotlight', hasOthers);
}

/**
 * Авто-выход из максимизации, если у ЭТОГО тайла видео только что скрылось
 * (выключили камеру/трек пропал), пока тайл был развёрнут — иначе останется
 * чёрный полноэкранный оверлей без картинки, из которого обычный пользователь
 * без Esc не выйдет. Вызывается из всех мест, где скрывается video конкретного
 * тайла — showTileVideo(peerId, false) для чужих тайлов и ручные тоглы
 * ownTile.videoEl (кнопка камеры, guest enforcement) для своего.
 */
function exitMaximizeIfHidden(tile, show) {
  if (!show && maximizedTile === tile) unmaximizeTile();
}

/** Показать/скрыть значок «микрофон выключен» на конкретном объекте тайла (свой ownTile или peers.get(id).tile). */
function setTileMicOffIndicator(tile, micOff) {
  if (!tile) return;
  tile.micOffEl.classList.toggle('hidden', !micOff);
}

function updateParticipantCount() {
  const total = 1 + peers.size;
  participantCountEl.textContent = `Participants: ${total} / 6`;
  updateSoloState();
  // Состав мог измениться, пока кто-то максимизирован — лента спотлайта
  // должна появиться/пропасть синхронно (см. updateSpotlightMode).
  updateSpotlightMode();
}

/**
 * Комната из одного человека (только свой тайл, экран никто не шарит) —
 * собственный тайл крупнее и по центру, под ним — ненавязчивый призыв
 * позвать кого-то (см. .tiles-grid--solo/.invite-cta в style.css).
 */
function updateSoloState() {
  const solo = peers.size === 0 && screenStageEl.classList.contains('hidden');
  tilesGridEl.classList.toggle('tiles-grid--solo', solo);
  inviteCtaEl.classList.toggle('hidden', !solo);
  // Число тайлов и/или режим --compact могли измениться — пересчитать
  // best-fit раскладку (см. layoutTilesGrid ниже; она сама не делает ничего
  // в --compact/--spotlight, у них своя CSS-логика).
  layoutTilesGrid();
}

// ---------- Лидер: корона на тайле, подпись своего тайла, видимость шестерёнки ----------

function isPeerLeader(peerId) {
  return leaderId !== null && peerId === leaderId;
}

/** Обновить корону на тайлах (своём и всех текущих peers) под новый leaderId + подпись своего тайла. */
function setLeaderIndicator(newLeaderId) {
  leaderId = newLeaderId || null;
  isLeader = myPeerId !== null && myPeerId === leaderId;
  if (ownTile) ownTile.crownEl.classList.toggle('hidden', leaderId !== myPeerId);
  for (const [peerId, entry] of peers) {
    entry.tile.crownEl.classList.toggle('hidden', leaderId !== peerId);
  }
  updateOwnTileLabel();
}

/** «Вы (имя)» + « (лидер)», если лидер — сам. Пересчитывается при любой смене leaderId. Пишем и в угловую подпись, и в подпись под аватаром заглушки — обе несут один и тот же текст (см. createTile). */
function updateOwnTileLabel() {
  if (!ownTile) return;
  const trimmedName = (myName || '').trim();
  let text = `You${trimmedName ? ` (${trimmedName})` : ''}`;
  if (isLeader) text += ' (Leader)';
  ownTile.labelTextEl.textContent = text;
  ownTile.placeholderNameEl.textContent = text;
}

/**
 * Шестерёнка настроек видна ВСЕМ (секция «Устройства» — выбор микрофона/
 * камеры — общая возможность). Секция «Комната» (лобби + права гостей)
 * внутри панели видна только лидеру — потеряв лидерство, прячем её и
 * список заявок (они больше не наши), но саму панель НЕ закрываем: гость
 * вполне мог в этот момент выбирать устройство.
 */
function updateSettingsButtonVisibility() {
  settingsRoomSectionEl.classList.toggle('hidden', !isLeader);
  if (!isLeader) {
    pendingRequests = [];
    renderJoinRequests();
  }
}

function setTileSpeaking(peerId, speaking) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.tile.root.classList.toggle('tile--speaking', speaking);
}

/**
 * Единая точка переключения видео/заглушки/угловой подписи тайла — держит
 * все три синхронными (свой тайл ownTile или чужой peers.get(id).tile) и
 * сама вызывает авто-выход из максимизации. Угловая подпись .tile-name видна
 * ТОЛЬКО когда идёт видео — на заглушке имя уже крупно показано по центру
 * (см. createTile/.tile-placeholder-name), дублировать его в углу незачем.
 */
function setTileVideoVisible(tile, show) {
  tile.videoEl.classList.toggle('hidden', !show);
  tile.placeholderEl.classList.toggle('hidden', show);
  tile.labelEl.classList.toggle('hidden', !show);
  exitMaximizeIfHidden(tile, show);
}

function showTileVideo(peerId, show) {
  const entry = peers.get(peerId);
  if (!entry) return;
  setTileVideoVisible(entry.tile, show);
}

// ---------- Экран (главная зона) ----------

function updateScreenButtonState() {
  // Права гостей (см. docs/permissions-and-leader.md, «Screen Sharing —
  // Server-Enforced»): guestScreen=false запрещает
  // гостю (не лидеру) даже пробовать — кнопка задизейблена независимо от
  // текущего состояния владения экраном. Лидера это ограничение не касается.
  if (!isLeader && roomSettings && !roomSettings.guestScreen) {
    screenButton.disabled = true;
    screenButton.title = 'Disabled by the leader';
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
    return;
  }
  if (currentScreenOwnerPeerId === null) {
    screenButton.disabled = false;
    screenButton.title = '';
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
  } else if (currentScreenOwnerPeerId === myPeerId) {
    screenButton.disabled = false;
    screenButton.title = '';
    screenButton.classList.add('control-button--on');
    screenButton.setAttribute('aria-pressed', 'true');
  } else {
    // Кто-то другой уже шарит — кнопка ОСТАЁТСЯ активной (см.
    // docs/permissions-and-leader.md, «перехват шаринга»): клик не заблокирован,
    // а перехватывает экран у текущего владельца («последний победил», см.
    // src/ws.rs::handle_share_start) — сама отправка share-start ниже уже это
    // умеет, здесь только отражаем состояние в подсказке кнопки.
    const name = peerNames.get(currentScreenOwnerPeerId) || 'another participant';
    screenButton.disabled = false;
    screenButton.title = `${name} is sharing their screen — click to take over`;
    screenButton.classList.remove('control-button--on');
    screenButton.setAttribute('aria-pressed', 'false');
  }
}

function showScreenStageContainer() {
  screenStageEl.classList.remove('hidden');
  tilesGridEl.classList.add('tiles-grid--compact');
  updateSoloState();
}

function hideScreenStage() {
  screenStageEl.classList.add('hidden');
  tilesGridEl.classList.remove('tiles-grid--compact');
  screenVideoEl.srcObject = null;
  screenVideoEl.classList.remove('hidden'); // сброс на случай, если сцену прятали во время своего же показа (см. showLocalScreenPreview)
  screenSelfPlaceholderEl.classList.add('hidden');
  screenCaptionEl.textContent = '';
  updateFullscreenButtonState(); // сцена скрыта целиком, но состояние кнопки не должно остаться от предыдущего показа
  updateSoloState();
}

/**
 * Заглушка вместо живого превью СОБСТВЕННОГО захвата — НЕ подключаем
 * screenStream к <video> на своей же сцене. Причина: при захвате «всего
 * экрана» это превью само попадает в кадр захвата — рекурсивный self-capture
 * («зеркальный коридор»/hall of mirrors, тот же эффект, из-за которого
 * Meet/Zoom никогда не показывают шарящему живое превью его же экрана),
 * который на macOS усугубляется до видимой заморозки буфера и шлейфа из
 * курсоров, особенно в fullscreen (см. requestFullscreenCompat ниже). Вместо
 * видео — статичная заглушка (см. #screen-self-placeholder в room.html).
 * У зрителей (attachScreenVideo) ничего не меняется — они всегда видят чужой
 * поток, для которого этой проблемы не существует.
 */
function showLocalScreenPreview() {
  showScreenStageContainer();
  screenVideoEl.srcObject = null;
  screenVideoEl.classList.add('hidden');
  screenSelfPlaceholderEl.classList.remove('hidden');
  screenCaptionEl.textContent = `Screen: You${myName ? ` (${myName})` : ''}`;
  updateFullscreenButtonState(); // фулскринить собственную заглушку смысла нет — кнопка прячется
}

function showRemoteScreenCaption(peerId) {
  showScreenStageContainer();
  // Перехват экрана (см. iAmPreempted в registerSignalingHandlers:
  // share-started) может застать сцену в состоянии «показываю заглушку
  // своего показа» — теперь владелец другой, возвращаем обычный вид с видео.
  screenSelfPlaceholderEl.classList.add('hidden');
  screenVideoEl.classList.remove('hidden');
  screenCaptionEl.textContent = `Screen: ${peerNames.get(peerId) || 'Guest'}`;
  updateFullscreenButtonState();
}

// ---------- Права гостей: применение на своей стороне (отправитель) ----------
//
// Кооперативная защита (см. docs/permissions-and-leader.md, §7): применяется на
// СВОЕЙ стороне (кнопки мик/камера/экран, инпут чата) при получении
// settings-changed/joined. Обходится модифицированным клиентом — сервер это
// и не пытается предотвратить технически (медиа/чат — P2P), только не
// показывает лишних возможностей честному клиенту. Симметричная защита на
// стороне ПОЛУЧАТЕЛЯ — см. refreshMediaRenderingForPeer ниже и
// ChatPanel.isIncomingEnvelopeAllowed в chat.js.
function applyGuestEnforcement() {
  if (!roomSettings) return;
  const restrictAudio = !isLeader && !roomSettings.guestAudio;
  const restrictVideo = !isLeader && !roomSettings.guestVideo;
  const restrictChat = !isLeader && !roomSettings.guestChat;

  micButton.disabled = restrictAudio;
  micButton.title = restrictAudio ? 'Disabled by the leader' : '';
  if (restrictAudio && micTrack && micTrack.enabled) {
    micTrack.enabled = false;
    setMicButtonOn(false);
    updateOwnMicIndicator();
    broadcastStreamEnabled(micStream, 'mic', false);
  }

  cameraButton.disabled = restrictVideo;
  cameraButton.title = restrictVideo ? 'Disabled by the leader' : '';
  if (restrictVideo && camTrack && camTrack.enabled) {
    camTrack.enabled = false;
    setCameraButtonOn(false);
    if (ownTile) setTileVideoVisible(ownTile, false);
    broadcastStreamEnabled(camStream, 'camera', false);
  }

  updateScreenButtonState(); // сам проверяет guestScreen/isLeader

  if (chat) chat.setChatForbidden(restrictChat);
}

// ---------- Права гостей: применение на стороне ПОЛУЧАТЕЛЯ (рендер чужих треков) ----------
//
// guestAudio/guestVideo=false — получатели не рендерят соответствующий трек
// ГОСТЕЙ (не лидера), независимо от того, отключил ли сам гость трек кнопкой
// (см. applyGuestEnforcement выше — защита именно кооперативная: сервер
// медиапотоки не видит и не может их запретить технически, см.
// docs/permissions-and-leader.md, «Audio & Video — Receiver-Enforced Only»).

function getOrCreateMediaRefs(peerId) {
  let refs = peerMediaRefs.get(peerId);
  if (!refs) {
    refs = { mic: null, camera: null };
    peerMediaRefs.set(peerId, refs);
  }
  return refs;
}

/** Пересчитать рендер входящих мик/камера треков одного пира под текущие roomSettings/leaderId. */
function refreshMediaRenderingForPeer(peerId) {
  const refs = peerMediaRefs.get(peerId);
  if (!refs || !roomSettings) return;
  const exempt = isPeerLeader(peerId); // лидера ограничения не касаются

  if (refs.mic) {
    if (exempt || roomSettings.guestAudio) {
      attachMicAudio(peerId, refs.mic.stream, refs.mic.track);
    } else {
      cleanupMicAudio(peerId);
    }
  }

  if (refs.camera) {
    if (exempt || roomSettings.guestVideo) {
      attachCameraVideo(peerId, refs.camera.stream, refs.camera.track, refs.camera.enabled);
    } else {
      showTileVideo(peerId, false);
      const entry = peers.get(peerId);
      if (entry) entry.tile.videoEl.srcObject = null;
    }
  }
}

function refreshMediaRenderingForAllPeers() {
  for (const peerId of peers.keys()) refreshMediaRenderingForPeer(peerId);
}

// ---------- Лобби: заявки на вход (только у лидера) ----------

function renderJoinRequests() {
  joinRequestsEl.textContent = '';
  if (pendingRequests.length === 0) {
    joinRequestsEl.classList.add('hidden');
  } else {
    joinRequestsEl.classList.remove('hidden');
    for (const req of pendingRequests) {
      joinRequestsEl.appendChild(buildJoinRequestCardEl(req));
    }
  }
  updateSettingsBadge();
}

function buildJoinRequestCardEl(req) {
  const card = document.createElement('div');
  card.className = 'join-request-card';
  card.dataset.peerId = req.peerId;

  const name = document.createElement('span');
  name.className = 'join-request-name';
  name.textContent = req.name || 'Guest';

  const actions = document.createElement('div');
  actions.className = 'join-request-actions';

  const acceptButton = document.createElement('button');
  acceptButton.type = 'button';
  acceptButton.className = 'join-request-button join-request-button--accept';
  acceptButton.textContent = 'Accept';
  acceptButton.addEventListener('click', () => {
    signaling.send('approve', { peerId: req.peerId });
    removePendingRequest(req.peerId);
  });

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className = 'join-request-button join-request-button--reject';
  rejectButton.textContent = 'Decline';
  rejectButton.addEventListener('click', () => {
    signaling.send('reject', { peerId: req.peerId });
    removePendingRequest(req.peerId);
  });

  actions.appendChild(acceptButton);
  actions.appendChild(rejectButton);
  card.appendChild(name);
  card.appendChild(actions);
  return card;
}

function updateSettingsBadge() {
  settingsBadgeEl.textContent = String(pendingRequests.length);
  settingsBadgeEl.classList.toggle('hidden', pendingRequests.length === 0);
}

function addPendingRequest(peerId, name) {
  if (pendingRequests.some((r) => r.peerId === peerId)) return;
  pendingRequests.push({ peerId, name: name || null });
  renderJoinRequests();
}

function removePendingRequest(peerId) {
  pendingRequests = pendingRequests.filter((r) => r.peerId !== peerId);
  renderJoinRequests();
}

// ---------- Настройки комнаты (только лидер): попап/bottom-sheet ----------

function syncSettingsPanelInputs() {
  if (!roomSettings) return;
  settingLobbyInput.checked = !!roomSettings.lobbyEnabled;
  settingGuestChatInput.checked = !!roomSettings.guestChat;
  settingGuestAudioInput.checked = !!roomSettings.guestAudio;
  settingGuestVideoInput.checked = !!roomSettings.guestVideo;
  settingGuestScreenInput.checked = !!roomSettings.guestScreen;
}

function openSettingsPanel() {
  syncSettingsPanelInputs();
  refreshDeviceLists();
  refreshConnectionSection();
  // Список пиров — сразу из кеша поллера скоростей (см. PEER_STATS_REFRESH_MS/
  // pollPeerStats), не дожидаясь его следующего тика: поллер тикает постоянно
  // и независимо от панели, но между появлением пира и первым тиком кеш мог
  // быть ещё пуст (renderPeerConnectionsList сама учитывает это, показывая
  // «устанавливается»). Пока панель открыта, дальше всё обновляет тик поллера
  // (и refreshConnectionSection, и список пиров) — отдельного таймера у
  // панели нет, весь ритм страницы — единый, раз в 3 секунды.
  renderPeerConnectionsList();
  settingsPanelEl.classList.remove('hidden');
}

function closeSettingsPanel() {
  settingsPanelEl.classList.add('hidden');
}

// ---------- «Соединение и приватность»: режим по каждому пиру + что видит сервер ----------
//
// Видна ВСЕМ участникам (в отличие от #settings-room-section выше, только
// лидер) — задел задачи «показать, в каком режиме работаем и что уходит на
// сервер». Три части:
//   1) статичная строка шифрования — из RoomCrypto.getCryptoInfo(), НЕ
//      хардкодим текст алгоритма (см. static/crypto.js);
//   2) режим соединения с каждым пиром — P2P/TURN-релей/серверный fallback/
//      устанавливается — см. computePeerConnectionStats ниже (там же —
//      трафик in/out и RTT из того же statsReport);
//   3) статичный список того, что видит сервер, плюс счётчики за сессию
//      (см. static/common.js: ConnStats — инкрементируется в местах реальной
//      отправки через signaling.send в rtc.js/room.js/chat.js).
//
// Обновляется вся секция ЕДИНЫМ поллером скоростей (PEER_STATS_REFRESH_MS,
// см. ниже, у renderPeerConnectionsList) — раз в 3 секунды, других
// периодических таймеров у панели настроек нет. Поллер тикает ВСЕГДА, а не
// только пока открыта эта панель: те же цифры нужны бейджам скорости на
// тайлах (см. updateTileSpeedBadges), которые видны независимо от настроек.
// При открытой панели тик дополнительно перерисовывает и дешёвые части (1 и 3
// — refreshConnectionSection, без getStats), и список пиров (2).
// renderPeerConnectionsList() при этом не дёргает getStats() сама — только
// читает готовый кеш поллера (peerLastStats), так что на одного пира за тик
// существует ровно один вызов getStats(), даже если панель настроек открыта.

const PEER_MODE_LABELS = {
  p2p: 'direct (P2P)',
  turn: 'via TURN relay',
  fallback: 'via server (fallback)',
  connecting: 'connecting…',
};

/** Отрисовать строку шифрования из getCryptoInfo() — текст алгоритма НЕ хардкодится, кроме шаблона фразы. */
function renderCryptoInfo() {
  const info = RoomCrypto.getCryptoInfo();
  if (!info.active) {
    settingsCryptoRowEl.classList.add('settings-crypto-row--off');
    settingsCryptoTextEl.textContent = 'E2E encryption is off — the server can see the content';
    return;
  }
  settingsCryptoRowEl.classList.remove('settings-crypto-row--off');
  settingsCryptoTextEl.textContent =
    `E2E encryption: ${info.algorithm} · ${info.keyBits}-bit key · ${info.kdf}`;
}

/**
 * Selected candidate-pair из отчёта pc.getStats() — спек-путь через
 * `transport.selectedCandidatePairId` (см. https://www.w3.org/TR/webrtc-stats/),
 * с фоллбэком на легаси-признаки (`selected`/`nominated`+`succeeded`
 * непосредственно на candidate-pair) для браузеров, где transport-статы
 * этого поля не несут.
 */
function findSelectedCandidatePair(statsReport) {
  for (const stat of statsReport.values()) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      const pair = statsReport.get(stat.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  for (const stat of statsReport.values()) {
    if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) {
      return stat;
    }
  }
  return null;
}

/** 'p2p' или 'turn' по типам локального/удалённого кандидата уже выбранной пары. */
function candidatePairMode(pair, statsReport) {
  const local = statsReport.get(pair.localCandidateId);
  const remote = statsReport.get(pair.remoteCandidateId);
  const localType = local && local.candidateType;
  const remoteType = remote && remote.candidateType;
  return localType === 'relay' || remoteType === 'relay' ? 'turn' : 'p2p';
}

/**
 * Байтовый счётчик транспорта пары (peerConnection, а не одного кандидата) —
 * запись type==='transport' покрывает ВЕСЬ DTLS-трафик соединения: медиа
 * (audio/video RTP) И датаканалы (файлы, чат, бас-протокол), поэтому это
 * честный in/out для пира. Если браузер такую запись не отдал (старый
 * Firefox), фоллбэк — сумма outbound-rtp/inbound-rtp записей, это только
 * медиа без датаканалов, но лучше, чем ничего.
 */
function findTransportBytes(statsReport) {
  for (const stat of statsReport.values()) {
    if (stat.type === 'transport' && (typeof stat.bytesSent === 'number' || typeof stat.bytesReceived === 'number')) {
      return { bytesSent: stat.bytesSent || 0, bytesReceived: stat.bytesReceived || 0 };
    }
  }
  let bytesSent = null;
  let bytesReceived = null;
  for (const stat of statsReport.values()) {
    if (stat.type === 'outbound-rtp' && typeof stat.bytesSent === 'number') {
      bytesSent = (bytesSent || 0) + stat.bytesSent;
    } else if (stat.type === 'inbound-rtp' && typeof stat.bytesReceived === 'number') {
      bytesReceived = (bytesReceived || 0) + stat.bytesReceived;
    }
  }
  return { bytesSent, bytesReceived };
}

/**
 * Режим + трафик + RTT соединения с одним пиром — единый обход ОДНОГО
 * statsReport (второй getStats() на пира не делаем, дорогая операция).
 * Режим — приоритет ровно как в задании:
 *  1) есть selected candidate-pair -> 'p2p' (host/srflx/prflx с обеих
 *     сторон) или 'turn' (кто-то из пары — relay); тут же берём RTT —
 *     currentRoundTripTime у candidate-pair, секунды -> мс;
 *  2) пары ещё нет и DataChannel-шина к пиру не открыта -> 'fallback'
 *     (весь трафик до пира — через серверный релей: signaling.send для
 *     ещё не устаканившегося mesh);
 *  3) иначе (пары нет, но шина каким-то образом уже открыта — гоночный
 *     край, в норме недостижимо) -> 'connecting'.
 * bytesSent/bytesReceived — null, если статы получить не удалось вовсе
 * (см. catch) или транспорт/rtp-записей не нашлось.
 */
async function computePeerConnectionStats(peerId, entry) {
  const pc = entry.rtc && entry.rtc.pc;
  if (!pc) return { mode: 'connecting', rtt: null, bytesSent: null, bytesReceived: null };
  try {
    const statsReport = await pc.getStats();
    const pair = findSelectedCandidatePair(statsReport);
    const { bytesSent, bytesReceived } = findTransportBytes(statsReport);
    const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
    const mode = pair ? candidatePairMode(pair, statsReport) : (bus.isOpen(peerId) ? 'connecting' : 'fallback');
    return { mode, rtt, bytesSent, bytesReceived };
  } catch (err) {
    console.warn(`[peer ${peerId}] getStats() для секции настроек не удался:`, err);
  }
  return { mode: bus.isOpen(peerId) ? 'connecting' : 'fallback', rtt: null, bytesSent: null, bytesReceived: null };
}

/**
 * Адаптивный формат размера: B / KB / MB (база 1024). Целые байты и целые
 * КБ — без дробной части (округление до 1 KB: дробные килобайты избыточная
 * точность что для бейджей на тайлах, что для строк в настройках), МБ — с
 * одним знаком после запятой (там дробная часть — не шум, а разница в разы).
 * Используется и для накопленного объёма (`formatBytesCompact(4404019)` ->
 * «4.2 MB»), и — с дописанным «/s» — для скорости (см. formatPeerStatsLine).
 */
function formatBytesCompact(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  if (abs < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Скорость для БЕЙДЖА НА ТАЙЛЕ (см. updateTileSpeedBadges) — в отличие от
 * formatBytesCompact выше (тот честно печатает и мелкие «3 B», это годится
 * для настроек, где рядом есть контекст), на тайле поверх видео нужен
 * компактный порядок величины, а не точные байты в секунду — до 1 KB/s
 * печатаем фиксированную «<1 KB/s».
 */
function formatSpeedBadge(bytesPerSec) {
  if (bytesPerSec < 1024) return '<1 KB/s';
  return `${formatBytesCompact(bytesPerSec)}/s`;
}

/**
 * Строка статы под именем пира: «↓ 320 KB/s ↑ 12 KB/s · 45 ms».
 *
 * Скорость — это ВСЕГДА дельта байт между двумя тиками секции (WebRTC не
 * отдаёт мгновенный throughput, только монотонно растущие счётчики с начала
 * соединения), поэтому нужна точка отсчёта — prevSnapshot из
 * peerStatsHistory. На первом тике после открытия панели (или после
 * появления transport-статы у только что подключившегося пира) точки
 * отсчёта ещё нет: показываем накопленный с начала соединения итог
 * (префикс «∑») — это честнее прочерков (данные реальные, просто не
 * скорость) и не требует у пользователя ждать «пустой» тик.
 */
function formatPeerStatsLine(prevSnapshot, stats, nowMs) {
  if (stats.bytesSent == null || stats.bytesReceived == null) return null; // ни transport-, ни rtp-статы не нашлось — нечего показывать
  const rttPart = typeof stats.rtt === 'number' ? ` · ${Math.round(stats.rtt)} ms` : '';

  if (!prevSnapshot) {
    return `∑ ↓ ${formatBytesCompact(stats.bytesReceived)} ↑ ${formatBytesCompact(stats.bytesSent)}${rttPart}`;
  }
  const dtSec = Math.max(0.001, (nowMs - prevSnapshot.ts) / 1000);
  // Math.max(0, …) — счётчики могут «просесть», если пара пересобралась
  // (ICE restart / смена transport'а с p2p на turn) и статистика начала
  // отсчёт заново; отрицательную дельту в такой момент лучше показать как 0,
  // чем как «минус трафик».
  const downRate = Math.max(0, (stats.bytesReceived - prevSnapshot.bytesReceived) / dtSec);
  const upRate = Math.max(0, (stats.bytesSent - prevSnapshot.bytesSent) / dtSec);
  return `↓ ${formatBytesCompact(downRate)}/s ↑ ${formatBytesCompact(upRate)}/s${rttPart}`;
}

/**
 * Перерисовать список «Соединения с участниками» — ЧИТАЕТ кеш peerLastStats,
 * НИКАКИХ собственных getStats(): цифры считает единый поллер скоростей (см.
 * pollPeerStats ниже), который тикает независимо от того, открыта ли эта
 * панель. Синхронна (раньше была async из-за собственного Promise.all по
 * getStats) — рендер мгновенный, мигания частично готового списка не было и
 * не стало.
 */
function renderPeerConnectionsList() {
  const entries = Array.from(peers.entries());
  if (entries.length === 0) {
    settingsPeersListEl.textContent = '';
    const li = document.createElement('li');
    li.className = 'settings-peer-row settings-peer-row--empty';
    li.textContent = 'No one else here yet — you are alone in the room.';
    settingsPeersListEl.appendChild(li);
    return;
  }

  settingsPeersListEl.textContent = '';
  for (const [peerId] of entries) {
    // До первого тика поллера после появления пира кеша ещё нет — тот же
    // фоллбэк-режим, что раньше отдавал сам computePeerConnectionStats на
    // пире без готового pc.
    const cached = peerLastStats.get(peerId);
    const mode = cached ? cached.mode : 'connecting';
    const li = document.createElement('li');
    li.className = 'settings-peer-row';

    const dot = document.createElement('span');
    dot.className = `settings-peer-dot settings-peer-dot--${mode}`;
    dot.setAttribute('aria-hidden', 'true');

    const info = document.createElement('span');
    info.className = 'settings-peer-info';

    const label = document.createElement('span');
    label.className = 'settings-peer-label';
    label.textContent = `${peerNames.get(peerId) || 'Guest'} — ${PEER_MODE_LABELS[mode]}`;
    info.appendChild(label);

    if (cached && cached.statsLine) {
      const statsEl = document.createElement('span');
      statsEl.className = 'settings-peer-stats';
      statsEl.textContent = cached.statsLine;
      info.appendChild(statsEl);
    }

    li.appendChild(dot);
    li.appendChild(info);
    settingsPeersListEl.appendChild(li);
  }
}

// ---------- Единый поллер скоростей (см. верхний комментарий раздела «Соединение и приватность») ----------
//
// Раз в PEER_STATS_REFRESH_MS, ВСЕГДА (не только при открытых настройках) —
// по одному getStats() на каждого пира считает режим/RTT/трафик, обновляет
// peerStatsHistory (точка отсчёта для следующего тика, см. formatPeerStatsLine
// выше) и кеширует готовый результат в peerLastStats. Этим кешем пользуются и
// renderPeerConnectionsList (если открыта панель настроек), и бейджи скорости
// на тайлах (updateTileSpeedBadges) — второго обхода getStats() ни для панели,
// ни для бейджей нет.
const PEER_STATS_REFRESH_MS = 3000;
let peerStatsTimer = null;
// peerId -> { mode, rtt, statsLine, downRate, upRate } — готовый результат
// последнего тика поллера. downRate/upRate — null, пока для этого пира не
// набралось хотя бы двух снимков (первый тик после подключения/после
// пересборки пары) — тот же гейт, что у formatPeerStatsLine («∑ …» вместо
// «…/s»), но отдельно от готовой строки: бейджам нужны сами числа.
const peerLastStats = new Map();

/** Один тик поллера — см. комментарий раздела выше. */
async function pollPeerStats() {
  const nowMs = Date.now();
  for (const [peerId, entry] of peers) {
    const stats = await computePeerConnectionStats(peerId, entry);
    const prev = peerStatsHistory.get(peerId);
    const statsLine = formatPeerStatsLine(prev, stats, nowMs);

    let downRate = null;
    let upRate = null;
    if (prev && stats.bytesSent != null && stats.bytesReceived != null) {
      const dtSec = Math.max(0.001, (nowMs - prev.ts) / 1000);
      // Math.max(0, …) — та же защита от «просевших» счётчиков после
      // пересборки пары (ICE restart/смена transport'а), что и в
      // formatPeerStatsLine.
      downRate = Math.max(0, (stats.bytesReceived - prev.bytesReceived) / dtSec);
      upRate = Math.max(0, (stats.bytesSent - prev.bytesSent) / dtSec);
    }

    // Точка отсчёта для скорости на СЛЕДУЮЩЕМ тике. Если статы недоступны в
    // этот раз (bytes === null) — запись не обновляем/удаляем, чтобы
    // временный сбой getStats() не сбросил уже накопленную точку отсчёта.
    if (stats.bytesSent != null && stats.bytesReceived != null) {
      peerStatsHistory.set(peerId, { bytesSent: stats.bytesSent, bytesReceived: stats.bytesReceived, ts: nowMs });
    }

    peerLastStats.set(peerId, { mode: stats.mode, rtt: stats.rtt, statsLine, downRate, upRate });
  }

  updateTileSpeedBadges();
  // Панель настроек может быть открыта прямо сейчас — перерисовываем всю
  // секцию «Соединение и приватность» тут же: список пиров из уже готового
  // кеша (без лишнего getStats(), см. renderPeerConnectionsList) и дешёвые
  // части (refreshConnectionSection). Отдельного таймера у панели нет —
  // это единственный периодический механизм её обновления.
  if (!settingsPanelEl.classList.contains('hidden')) {
    refreshConnectionSection();
    renderPeerConnectionsList();
  }
}

/**
 * Запустить поллер (идемпотентно) — вызывается при входе в комнату (первый
 * joined, см. registerSignalingHandlers, рядом со startSasUpdates) и тикает
 * дальше всю сессию: тик без пиров — почти no-op (for…of по пустой Map), а
 * refreshConnectionSection с тика нужен и одинокому участнику с открытой
 * панелью. Поэтому не останавливаем/не перезапускаем его на каждый
 * join/leave — только на терминальном teardown (см. stopPeerStatsPolling).
 */
function startPeerStatsPolling() {
  if (peerStatsTimer) return;
  peerStatsTimer = setInterval(() => {
    pollPeerStats().catch((err) => console.warn('Поллер скоростей пиров не удался:', err));
  }, PEER_STATS_REFRESH_MS);
}

/** Остановить поллер — терминальный teardown (см. teardownMeshMediaChat). */
function stopPeerStatsPolling() {
  if (peerStatsTimer) {
    clearInterval(peerStatsTimer);
    peerStatsTimer = null;
  }
}

/**
 * Бейджи скорости на тайлах (.tile-speed, см. createTile/static/style.css) —
 * вызывается из pollPeerStats на каждом тике. На тайле ЧУЖОГО пира — его
 * ВХОДЯЩАЯ скорость (его медиа К НАМ): это честная «скорость его видео у
 * меня», которую и хочет видеть смотрящий на конкретный тайл (а не то, с
 * какой скоростью МЫ ему отдаём). На СВОЁМ тайле — суммарная ИСХОДЯЩАЯ
 * скорость по всем пирам (с «↑»): в mesh мы шлём n отдельных копий своего
 * медиа, ровно по копии на каждого участника, и честная «моя отдача» — это
 * сумма по всем, а не скорость к одному произвольному пиру. Пока скорость не
 * посчитана (первый тик после подключения пира — downRate/upRate ещё null)
 * — бейдж остаётся/становится скрытым.
 */
function updateTileSpeedBadges() {
  let totalUpRate = null;
  for (const [peerId, entry] of peers) {
    const cached = peerLastStats.get(peerId);
    const downRate = cached ? cached.downRate : null;
    if (downRate == null) {
      entry.tile.speedEl.classList.add('hidden');
    } else {
      entry.tile.speedEl.textContent = formatSpeedBadge(downRate);
      entry.tile.speedEl.classList.remove('hidden');
    }
    if (cached && cached.upRate != null) {
      totalUpRate = (totalUpRate || 0) + cached.upRate;
    }
  }

  if (!ownTile) return;
  if (totalUpRate == null) {
    ownTile.speedEl.classList.add('hidden');
  } else {
    ownTile.speedEl.textContent = `↑ ${formatSpeedBadge(totalUpRate)}`;
    ownTile.speedEl.classList.remove('hidden');
  }
}

/**
 * Динамические счётчики «что видит сервер» — см. static/common.js: ConnStats.
 * Строка трафика — тот же формат, что per-peer статы (formatPeerStatsLine
 * выше): накопленный итог с «∑» на первый вызов (нет точки отсчёта), скорость
 * между вызовами дальше. Вызывается и при открытии панели (openSettingsPanel),
 * и с каждого тика единого поллера, пока панель открыта (refreshConnectionSection)
 * — тот же ритм, что у остальной секции.
 */
function renderServerCounters() {
  settingsSignalingCountEl.textContent = String(ConnStats.signalingRelayCount);

  const nowMs = Date.now();
  const stats = { bytesSent: ConnStats.bytesSent, bytesReceived: ConnStats.bytesReceived, rtt: null };
  settingsServerTrafficEl.textContent = formatPeerStatsLine(serverBytesHistory, stats, nowMs);
  serverBytesHistory = { bytesSent: stats.bytesSent, bytesReceived: stats.bytesReceived, ts: nowMs };
}

/**
 * Один раз за сессию сгенерировать сессионный DTLS-сертификат для SAS (см.
 * блок объявления sessionCertificate выше). Идемпотентна и не бросает: при
 * отказе просто оставляет sessionCertificate=null (звонок работает, SAS не
 * показывается). ECDSA P-256 — тот же дефолт, что браузер выбирает сам, так
 * что на совместимость соединений влияния нет.
 */
async function ensureSessionCertificate() {
  if (sessionCertificate) return;
  try {
    sessionCertificate = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    });
    const fps = sessionCertificate.getFingerprints ? sessionCertificate.getFingerprints() : [];
    const sha256 = fps.find((f) => f.algorithm === 'sha-256') || fps[0];
    ownCertFingerprint = sha256 ? sha256.value : null;
  } catch (err) {
    console.warn('Не удалось сгенерировать сессионный сертификат для SAS:', err);
    sessionCertificate = null;
    ownCertFingerprint = null;
  }
}

// ---------- SAS v2: стейт-машина commit-before-reveal ----------
//
// Полная спецификация — docs/sas-verification.md. Управляется таймером
// (sasRefresh) плюс входящими sas-commit/sas-reveal (обработчики выше).
// Инвариант: раунд определяется снапшотом sasRoundMembers, зафиксированным на
// старте; сообщения не своего roundId игнорируются; showing 'ok' только когда
// от ВСЕХ ожидаемых участников пришли и проверены reveal'ы.

/** Отрисовать текущее состояние SAS в топ-баре главного окна — единственное место в UI (см. docs/sas-verification.md §9). Идемпотентна. */
function renderRoomSas() {
  renderTopbarSas(sasState, sasResult);
}

/**
 * SAS «отпечаток комнаты» в топ-баре: компактный бейдж, видимый без
 * открытия чата (когда-то дублировался в шапке чат-панели — убрано, теперь
 * единственный источник, см. docs/sas-verification.md §9). Клик по бейджу
 * открывает #topbar-sas-popup с подробностями (openTopbarSasPopup /
 * renderTopbarSasPopupContent); если попап уже открыт в момент смены
 * состояния (напр. verifying -> ok), тоже обновляем его содержимое, чтобы не
 * показывать устаревший текст.
 */
function renderTopbarSas(state, result) {
  if (!topbarSasEl) return;
  topbarSasEl.classList.remove(
    'topbar-sas--ok',
    'topbar-sas--verifying',
    'topbar-sas--mismatch',
    'topbar-sas--unavailable'
  );
  topbarSasEl.title = '';

  if (!state || state === 'hidden') {
    // Одиноки в комнате — нечего и не с кем сверять (см. docs/sas-verification.md
    // §9). Единственное состояние, где бейджа вовсе нет — значит и попапу
    // открытым оставаться не с чем, закрываем его, если был открыт.
    topbarSasEl.classList.add('hidden');
    topbarSasEl.textContent = '';
    closeTopbarSasPopup();
    return;
  }
  topbarSasEl.classList.remove('hidden');

  if (state === 'ok' && result && Array.isArray(result.emoji)) {
    topbarSasEl.classList.add('topbar-sas--ok');
    topbarSasEl.textContent = result.emoji.join(' ');
    topbarSasEl.title = result.hex ? `Text code: ${result.hex}` : 'Room verification code';
  } else if (state === 'mismatch') {
    topbarSasEl.classList.add('topbar-sas--mismatch');
    topbarSasEl.textContent = '⚠️ verification failed';
    topbarSasEl.title = 'Room verification failed — codes do not match';
  } else if (state === 'unavailable') {
    topbarSasEl.classList.add('topbar-sas--unavailable');
    topbarSasEl.textContent = 'not verified';
    topbarSasEl.title = 'Verification unavailable — no direct connection';
  } else {
    // verifying
    topbarSasEl.classList.add('topbar-sas--verifying');
    topbarSasEl.textContent = 'verifying…';
    topbarSasEl.title = 'Verifying room…';
  }

  // Попап уже открыт (напр. verifying -> ok сменился, пока пользователь его
  // читает) — обновляем содержимое, иначе он показал бы устаревший текст.
  if (!topbarSasPopupEl.classList.contains('hidden')) renderTopbarSasPopupContent(state, result);
}

/**
 * Заполнить содержимое попапа подробностей SAS под текущее состояние — те же
 * формулировки, что раньше жили в static/chat.js: setRoomSas/.chat-sas-note
 * (перенесены сюда при удалении SAS из шапки чат-панели). Не трогает
 * hidden-класс самого попапа — только его контент.
 */
function renderTopbarSasPopupContent(state, result) {
  if (state === 'ok' && result && Array.isArray(result.emoji)) {
    topbarSasPopupEmojiEl.textContent = result.emoji.join(' ');
    topbarSasPopupEmojiEl.classList.remove('hidden');
    topbarSasPopupTextEl.textContent =
      "These emoji are a fingerprint of this call's encryption key. Compare them out loud before discussing anything sensitive: if everyone sees the same emoji, no one is intercepting the call. If they differ, someone may have handed you a tampered link.";
    topbarSasPopupHexEl.textContent = result.hex ? `Text code: ${result.hex}` : '';
  } else if (state === 'mismatch') {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent =
      'Room verification failed — the codes do not match. This can mean someone is intercepting the call; do not discuss anything sensitive until this is resolved.';
    topbarSasPopupHexEl.textContent = '';
  } else if (state === 'unavailable') {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent =
      'Verification unavailable — there is no direct peer-to-peer connection to verify yet.';
    topbarSasPopupHexEl.textContent = '';
  } else {
    topbarSasPopupEmojiEl.textContent = '';
    topbarSasPopupEmojiEl.classList.add('hidden');
    topbarSasPopupTextEl.textContent = 'Verifying the room…';
    topbarSasPopupHexEl.textContent = '';
  }
}

function onTopbarSasPopupKeydown(event) {
  if (event.key === 'Escape') closeTopbarSasPopup();
}

/** Открыть попап подробностей SAS (по образцу openSharePopup). Ничего не делает, если бейдж скрыт (state hidden — нечего показывать). */
function openTopbarSasPopup() {
  if (topbarSasEl.classList.contains('hidden')) return;
  renderTopbarSasPopupContent(sasState, sasResult);
  topbarSasPopupEl.classList.remove('hidden');
  document.addEventListener('keydown', onTopbarSasPopupKeydown);
}

function closeTopbarSasPopup() {
  topbarSasPopupEl.classList.add('hidden');
  document.removeEventListener('keydown', onTopbarSasPopupKeydown);
}

/** Клик по бейджу переключает попап (см. static/style.css: .topbar-sas — z-index явно выше backdrop-а попапа, так что бейдж остаётся кликабельным напрямую и повторный клик закрывает попап тем же путём, каким открыл). */
function toggleTopbarSasPopup() {
  if (topbarSasPopupEl.classList.contains('hidden')) openTopbarSasPopup();
  else closeTopbarSasPopup();
}

topbarSasEl.addEventListener('click', toggleTopbarSasPopup);
// Клик мимо (по прозрачному полноэкранному backdrop-у) — закрывает (тот же
// приём, что у .share-popup-backdrop/openSharePopup).
topbarSasPopupBackdropEl.addEventListener('click', closeTopbarSasPopup);

function sasSetState(state) {
  if (state !== 'ok') sasResult = null;
  sasState = state;
  renderRoomSas();
}

/** Сбросить состояние раунда (уходим в hidden/unavailable — сверять не с кем). */
function sasResetRound(state) {
  sasCurrentRoundId = null;
  sasRoundMembers = null;
  sasMyNonce = null;
  sasCommits = new Map();
  sasReveals = new Map();
  sasRevealed = false;
  sasSetState(state);
}

/** Начать новый раунд над снапшотом состава `members` ([{peerId, fingerprint}]) с идентификатором `rid`. */
function sasStartRound(rid, members) {
  sasCurrentRoundId = rid;
  sasRoundMembers = members;
  sasMyNonce = RoomCrypto.generateSasNonce();
  sasCommits = new Map();
  sasReveals = new Map([[myPeerId, sasMyNonce]]); // свой нонс сразу известен
  sasRevealed = false;
  sasSetState('verifying');
  RoomCrypto.sasCommit(rid, myPeerId, sasMyNonce)
    .then((commit) => {
      if (rid !== sasCurrentRoundId) return; // раунд успел смениться
      sasCommits.set(myPeerId, commit);
      bus.broadcast({ kind: 'sas-commit', round: rid, commit });
      return sasTryComplete();
    })
    .catch((err) => console.warn('SAS: старт раунда не удался:', err));
}

/** Повторно разослать свой commit (и reveal, если уже раскрылись) — покрывает пиров, чья шина открылась после первой рассылки. */
function sasRebroadcast() {
  const commit = sasCommits.get(myPeerId);
  if (commit) bus.broadcast({ kind: 'sas-commit', round: sasCurrentRoundId, commit });
  if (sasRevealed && sasMyNonce) {
    bus.broadcast({
      kind: 'sas-reveal',
      round: sasCurrentRoundId,
      nonce: RoomCrypto.bytesToBase64url(sasMyNonce),
    });
  }
}

/**
 * Продвинуть текущий раунд: гейт ревила (раскрываемся только собрав ВСЕ
 * коммиты), проверка reveal'ов против коммитов, вывод SAS. Идемпотентна;
 * безопасна при параллельных вызовах (проверяет, не сменился ли раунд).
 */
async function sasTryComplete() {
  const rid = sasCurrentRoundId;
  if (!rid || !sasRoundMembers) return;
  const expected = sasRoundMembers.map((m) => m.peerId);

  // 1. Ждём коммиты от всех ожидаемых участников.
  if (!expected.every((p) => sasCommits.has(p))) {
    sasSetState('verifying');
    return;
  }
  // 2. Гейт: все коммиты собраны — можно раскрыть свой нонс.
  if (!sasRevealed) {
    sasRevealed = true;
    bus.broadcast({ kind: 'sas-reveal', round: rid, nonce: RoomCrypto.bytesToBase64url(sasMyNonce) });
  }
  // 3. Ждём reveal'ы от всех.
  if (!expected.every((p) => sasReveals.has(p))) {
    sasSetState('verifying');
    return;
  }
  // 4. Проверяем каждый чужой reveal против его коммита.
  for (const m of sasRoundMembers) {
    if (m.peerId === myPeerId) continue; // свой нонс доверяем
    const commit = await RoomCrypto.sasCommit(rid, m.peerId, sasReveals.get(m.peerId));
    if (rid !== sasCurrentRoundId) return; // раунд сменился во время await
    if (commit !== sasCommits.get(m.peerId)) {
      sasSetState('mismatch');
      return;
    }
  }
  // 5. Всё сошлось — выводим SAS.
  const entries = sasRoundMembers.map((m) => ({
    peerId: m.peerId,
    fingerprint: m.fingerprint,
    nonce: sasReveals.get(m.peerId),
  }));
  const result = await RoomCrypto.deriveSas(entries);
  if (rid !== sasCurrentRoundId) return;
  sasResult = result;
  sasSetState('ok');
}

/**
 * Периодический тик: собрать актуальный состав (свой + пиры с ОТКРЫТОЙ шиной и
 * известным DTLS-фингерпринтом), вычислить roundId (включает фингерпринты) и
 * при его смене — начать свежий раунд. Иначе — добить текущий. Состояния:
 *  - один в комнате -> hidden (сверять не с кем);
 *  - есть пиры, но ни к кому нет верифицируемого P2P-пути -> unavailable
 *    (медиа-пути тоже нет — см. docs/sas-verification.md §8/§9).
 */
async function sasRefresh() {
  if (!ownCertFingerprint || !myPeerId) return; // сертификат не готов — SAS недоступен молча
  const peerEntries = Array.from(peers.entries());
  if (peerEntries.length === 0) {
    if (sasState !== 'hidden') sasResetRound('hidden');
    return;
  }
  const members = [{ peerId: myPeerId, fingerprint: ownCertFingerprint }];
  for (const [pid, entry] of peerEntries) {
    if (!bus.isOpen(pid)) continue;
    const fp = await entry.rtc.getRemoteCertificateFingerprint();
    if (fp) members.push({ peerId: pid, fingerprint: fp });
  }
  if (members.length < 2) {
    if (sasState !== 'unavailable') sasResetRound('unavailable');
    return;
  }
  const rid = await RoomCrypto.sasRoundId(members);
  if (rid !== sasCurrentRoundId) {
    sasStartRound(rid, members);
  } else {
    sasRebroadcast();
    await sasTryComplete();
  }
}

/** Запустить периодический SAS-тик (идемпотентно, переживает reconnect). */
function startSasUpdates() {
  const tick = () => sasRefresh().catch((err) => console.warn('SAS-тик не удался:', err));
  tick();
  if (!sasRefreshTimer) sasRefreshTimer = setInterval(tick, SAS_REFRESH_MS);
}

/**
 * Крипто-строка/счётчики сигналинга/build-хэш — дешёвые части секции
 * «Соединение и приватность» (без getStats). Вызывается при открытии панели
 * (openSettingsPanel) и с каждого тика единого 3-секундного поллера скоростей,
 * пока панель открыта (см. PEER_STATS_REFRESH_MS/pollPeerStats выше) — своего
 * таймера у секции нет. Список пиров сюда не входит — его рисует
 * renderPeerConnectionsList, из тех же мест.
 */
function refreshConnectionSection() {
  renderCryptoInfo();
  renderServerCounters();
  renderSettingsBuildRow();
}

// ---------- Устройства: селекты микрофона/камеры (видно всем участникам) ----------
//
// enumerateDevices() отдаёт человекочитаемые label ТОЛЬКО после того, как
// пользователь хоть раз выдал разрешение на mic/camera в этой вкладке (до
// этого — пустая строка у всех устройств, спецификация намеренно не палит
// железо без разрешения) — поэтому до первого разрешения показываем
// пронумерованный фоллбэк «Микрофон 1», «Камера 2» и т.п. Список
// перестраивается при каждом открытии панели и по событию devicechange
// (см. ниже) — воткнули/вынули устройство, список должен обновиться, даже
// если панель уже открыта.
async function refreshDeviceLists() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    console.warn('enumerateDevices не удался:', err);
    return;
  }
  fillDeviceSelect(
    settingMicDeviceSelect,
    devices.filter((d) => d.kind === 'audioinput'),
    'Microphone'
  );
  fillDeviceSelect(
    settingCameraDeviceSelect,
    devices.filter((d) => d.kind === 'videoinput'),
    'Camera'
  );
}

function fillDeviceSelect(selectEl, list, labelPrefix) {
  // Сохраняем текущий выбор селекта (пользователь мог уже выбрать устройство
  // в этой же сессии до перестройки списка, см. selected*DeviceId) — приоритет
  // у него, иначе оставляем то, что уже стояло в самом селекте.
  const wantId = selectEl.dataset.selectedDeviceId || selectEl.value || '';
  selectEl.textContent = '';
  list.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${labelPrefix} ${i + 1}`;
    selectEl.appendChild(opt);
  });
  if (wantId && list.some((d) => d.deviceId === wantId)) {
    selectEl.value = wantId;
  }
}

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', refreshDeviceLists);
}

settingMicDeviceSelect.addEventListener('change', () => {
  settingMicDeviceSelect.dataset.selectedDeviceId = settingMicDeviceSelect.value;
  applyMicDeviceChange(settingMicDeviceSelect.value || null);
});

settingCameraDeviceSelect.addEventListener('change', () => {
  settingCameraDeviceSelect.dataset.selectedDeviceId = settingCameraDeviceSelect.value;
  applyCameraDeviceChange(settingCameraDeviceSelect.value || null);
});

/** Шлёт update-settings ЦЕЛИКОМ (не патч, см. src/protocol.rs) — сервер рассылает settings-changed всем, включая нас (см. registerSignalingHandlers). */
function sendSettingsUpdate(partial) {
  if (!roomSettings) return;
  const next = { ...roomSettings, ...partial };
  signaling.send('update-settings', { settings: next });
}

function wireSettingToggle(inputEl, key) {
  inputEl.addEventListener('change', () => {
    sendSettingsUpdate({ [key]: inputEl.checked });
  });
}

settingsButton.addEventListener('click', openSettingsPanel);
settingsPanelCloseEl.addEventListener('click', closeSettingsPanel);
settingsPanelBackdropEl.addEventListener('click', closeSettingsPanel);
wireSettingToggle(settingLobbyInput, 'lobbyEnabled');
wireSettingToggle(settingGuestChatInput, 'guestChat');
wireSettingToggle(settingGuestAudioInput, 'guestAudio');
wireSettingToggle(settingGuestVideoInput, 'guestVideo');
wireSettingToggle(settingGuestScreenInput, 'guestScreen');

// ---------- Локальные потоки: рассылка новым и уже существующим пирам ----------

/**
 * Отправить stream-info одному пиру: если DataChannel-шина до него уже
 * открыта — через неё (см. bus.js/rtc.js, Ф2), иначе — серверный релей как
 * раньше (fallback: пока mesh только устанавливается, шины ещё нет).
 * Формат сообщения на приёме единый для обоих путей — см. handleStreamInfo.
 *
 * Ш1 (E2E-шифрование): по шине `info` уходит КАК ЕСТЬ (P2P DataChannel уже
 * E2E за счёт DTLS, см. static/crypto.js/rtc.js) — а вот серверный fallback
 * шифрует `info` целиком под K_sig, сервер видит только {v,iv,ct}.
 */
function sendStreamInfoTo(peerId, info) {
  if (bus.isOpen(peerId)) {
    bus.sendToPeer(peerId, { kind: 'stream-info', info });
  } else {
    RoomCrypto.encrypt(sigKey, info).then((encInfo) => {
      signaling.send('stream-info', { targetPeerId: peerId, info: encInfo });
      ConnStats.incSignalingRelay();
    });
  }
}

/** Добавить трек(и) `stream` во все существующие PeerConnection и разослать stream-info. */
function broadcastLocalStream(stream, kind) {
  const info = { [stream.id]: { kind, name: myName || null, enabled: true } };
  for (const [peerId, entry] of peers) {
    for (const track of stream.getTracks()) {
      entry.rtc.pc.addTrack(track, stream);
    }
    sendStreamInfoTo(peerId, info);
  }
}

/**
 * Сообщить всем пирам, что локальный поток переключил enabled (камера
 * toggle кнопкой). `stream-info` — опаковый для сервера JSON, поэтому это
 * чисто клиентское расширение протокола, а не отдельное сообщение.
 *
 * Зачем это вообще нужно (грабли, обнаружены эмпирически): по спецификации
 * WebRTC можно было бы понадеяться, что `track.enabled = false` на
 * отправителе приведёт к событию `mute` у соответствующего трека на
 * приёмнике — так ведёт себя MediaStreamTrack при локальном рендере. На
 * практике же в Chrome сендер при `enabled = false` продолжает слать чёрные
 * кадры (аналогично тишине у аудио — см. комментарий в истории проекта про
 * счётчик микрофонов), поэтому `mute`/`unmute` на приёмнике НЕ происходит:
 * трек остаётся live и «немьютнутым», просто с чёрным содержимым. Поэтому
 * `track.onmute`/`onunmute` в attachCameraVideo оставлены только страховкой
 * (вдруг другой браузер поведёт себя иначе), а основной путь — этот явный
 * сигнал через stream-info.
 */
function broadcastStreamEnabled(stream, kind, enabled) {
  const info = { [stream.id]: { kind, name: myName || null, enabled } };
  for (const peerId of peers.keys()) {
    sendStreamInfoTo(peerId, info);
  }
}

/** Убрать все треки `stream` из всех PeerConnection (используется при остановке шаринга экрана). */
function removeLocalStreamFromAllPeers(stream) {
  const tracks = stream.getTracks();
  for (const entry of peers.values()) {
    for (const sender of entry.rtc.pc.getSenders()) {
      if (sender.track && tracks.includes(sender.track)) {
        try {
          entry.rtc.pc.removeTrack(sender);
        } catch (err) {
          console.warn('Не удалось убрать локальный трек у пира:', err);
        }
      }
    }
  }
}

/**
 * Сообщить конкретному пиру обо всех своих активных потоках (снапшот) —
 * вызывается ДВАЖДЫ за жизнь пары (см. createRemotePeer):
 *   1) сразу при создании пира — шина ещё не открыта, уйдёт через серверный
 *      релей (обычный bootstrap-путь, пока mesh только устанавливается);
 *   2) повторно в момент открытия шины к этому пиру (onBusOpen) — на этот
 *      раз уйдёт уже по шине (sendStreamInfoTo видит bus.isOpen() === true).
 * Повтор №2 закрывает гонку «оффер с треками ушёл раньше, чем открылась
 * шина»: даже если сервер потерял/задержал первую посылку, актуальное
 * состояние гарантированно долетит по P2P-каналу сразу же, как только он
 * готов — после этого точечные обновления (broadcastLocalStream/
 * broadcastStreamEnabled) уже почти всегда идут по шине.
 */
function sendAllActiveStreamInfoTo(peerId) {
  const info = {};
  if (micStream) info[micStream.id] = { kind: 'mic', name: myName || null, enabled: micTrack ? micTrack.enabled : true };
  if (camStream) info[camStream.id] = { kind: 'camera', name: myName || null, enabled: camTrack ? camTrack.enabled : true };
  if (screenStream) info[screenStream.id] = { kind: 'screen', name: myName || null, enabled: true };
  if (Object.keys(info).length > 0) {
    sendStreamInfoTo(peerId, info);
  }
}

// ---------- Входящие треки: маршрутизация по stream-info ----------

/**
 * Единая точка приёма stream-info — не важно, пришёл ли он по DataChannel-
 * шине (см. bus.onMessage ниже) или по серверному релею-фоллбэку (см.
 * signaling.on('stream-info', ...) в registerSignalingHandlers): формат
 * `info` в обоих случаях один и тот же (см. sendStreamInfoTo), поэтому вся
 * логика маршрутизации/дедупликации живёт здесь один раз.
 */
function handleStreamInfo(info) {
  if (!info || typeof info !== 'object') return;
  for (const [streamId, meta] of Object.entries(info)) {
    const hadMetaBefore = streamInfoMap.has(streamId);
    streamInfoMap.set(streamId, meta);
    const queue = pendingTracks.get(streamId);
    if (queue) {
      pendingTracks.delete(streamId);
      for (const item of queue) {
        routeRemoteTrack(item.peerId, streamId, item.stream, item.track, meta);
      }
    } else if (hadMetaBefore && meta.kind === 'camera' && typeof meta.enabled === 'boolean') {
      // Повторный stream-info для уже подключённого потока камеры — это
      // toggle enabled (см. broadcastStreamEnabled), а не новый трек.
      applyCameraEnabledUpdate(streamId, meta.enabled);
    } else if (hadMetaBefore && meta.kind === 'mic' && typeof meta.enabled === 'boolean') {
      // Тот же toggle enabled, но для микрофона — двигает индикатор
      // «микрофон выключен» на тайле (см. applyMicEnabledUpdate).
      applyMicEnabledUpdate(streamId, meta.enabled);
    }
  }
}

// Приём stream-info с шины (Ф2) — обычный путь, как только mesh-пара
// установлена; обработчик общий с сервером-фоллбэком (handleStreamInfo
// выше). Сообщения чата и прочих фич шины (см. chat.js: dispatchEnvelope,
// envelope.kind) сюда не попадают — фильтруем по kind: 'stream-info'.
bus.onMessage((_fromPeerId, obj) => {
  if (obj && obj.kind === 'stream-info') handleStreamInfo(obj.info);
});

// Ф3: приём повторных offer/answer/ice ПО ШИНЕ (см. static/rtc.js —
// RtcPeer._trySendBusSignal на стороне отправителя, sigCrypto там уже не
// участвует, payload приходит в чистом виде). Маршрутизируется в ТОТ ЖЕ
// RtcPeer, что и прислал сообщение (bus._dispatch зовёт обработчики с
// fromPeerId — см. bus.js/rtc.js: onBusMessage), поэтому здесь просто нужен
// сам RtcPeer конкретного пира — bus.getPeer(fromPeerId), а не полноценный
// bus-транспорт (rtc-signal — не сообщение чата/фичи, ему нужен доступ к
// handleBusSignal, которого у Bus API нет и не должно быть).
bus.onMessage((fromPeerId, obj) => {
  if (!obj || obj.kind !== 'rtc-signal') return;
  const rtc = bus.getPeer(fromPeerId);
  if (rtc) rtc.handleBusSignal(obj.payload);
});

function handleRemoteTrack(peerId, event) {
  const track = event.track;
  const stream = event.streams[0] || new MediaStream([track]);
  const streamId = stream.id;

  const meta = streamInfoMap.get(streamId);
  if (meta) {
    routeRemoteTrack(peerId, streamId, stream, track, meta);
    return;
  }
  let queue = pendingTracks.get(streamId);
  if (!queue) {
    queue = [];
    pendingTracks.set(streamId, queue);
  }
  queue.push({ peerId, stream, track });
}

function routeRemoteTrack(peerId, streamId, stream, track, meta) {
  if (!peers.has(peerId)) return; // пир уже ушёл, пока летела информация
  if (meta.kind === 'mic') {
    micStreamOwner.set(streamId, peerId);
    // Ссылку храним всегда (см. заголовок раздела «Права гостей: применение
    // на стороне получателя») — рендерим только если разрешено прямо сейчас.
    const enabled = meta.enabled !== false;
    getOrCreateMediaRefs(peerId).mic = { stream, track, enabled };
    refreshMediaRenderingForPeer(peerId);
    setTileMicOffIndicator(peers.get(peerId).tile, !enabled);
  } else if (meta.kind === 'camera') {
    cameraStreamOwner.set(streamId, peerId);
    getOrCreateMediaRefs(peerId).camera = { stream, track, enabled: meta.enabled !== false };
    refreshMediaRenderingForPeer(peerId);
  } else if (meta.kind === 'screen') {
    attachScreenVideo(peerId, stream);
  }
}

function attachMicAudio(peerId, stream, track) {
  let audioEl = micAudioEls.get(peerId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.dataset.peerId = peerId;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    micAudioEls.set(peerId, audioEl);
  }
  if (audioEl.srcObject !== stream) {
    audioEl.srcObject = stream;
    safePlay(audioEl);
  }

  if (!micMonitors.has(peerId)) {
    const stop = SpeakingDetection.monitorTrack(track, (speaking) => setTileSpeaking(peerId, speaking));
    micMonitors.set(peerId, stop);
  }

  // Грабли из старого viewer.js: removeTrack у отправителя на этой стороне
  // даёт mute, а НЕ ended — надёжный сигнал ухода трека это removetrack на
  // самой MediaStream (см. комментарий там же).
  stream.onremovetrack = () => {
    if (stream.getAudioTracks().length === 0) {
      cleanupMicAudio(peerId);
    }
  };
  track.onended = () => cleanupMicAudio(peerId);
}

function cleanupMicAudio(peerId) {
  const audioEl = micAudioEls.get(peerId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    micAudioEls.delete(peerId);
  }
  const stop = micMonitors.get(peerId);
  if (stop) {
    stop();
    micMonitors.delete(peerId);
  }
  setTileSpeaking(peerId, false);
}

function attachCameraVideo(peerId, stream, track, initiallyEnabled = true) {
  const entry = peers.get(peerId);
  if (!entry) return;
  const videoEl = entry.tile.videoEl;
  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
    safePlay(videoEl);
  }
  showTileVideo(peerId, initiallyEnabled);

  // Выключение камеры кнопкой — это track.enabled=false на стороне
  // отправителя, трек не удаляется. Основной сигнал об этом — явное
  // обновление stream-info с полем enabled (см. broadcastStreamEnabled и
  // applyCameraEnabledUpdate) — мьют/анмьют трека здесь оставлены только
  // страховкой на случай другого браузера/поведения: эмпирически в Chrome
  // при enabled=false сендер продолжает слать чёрные кадры, mute не наступает.
  track.onmute = () => showTileVideo(peerId, false);
  track.onunmute = () => showTileVideo(peerId, true);

  // Страховка на случай реального удаления трека (сейчас камера никогда не
  // removeTrack'ается явно, но если браузер всё же пришлёт это — не залипаем
  // на последнем кадре).
  stream.onremovetrack = () => {
    if (stream.getVideoTracks().length === 0) {
      showTileVideo(peerId, false);
      videoEl.srcObject = null;
    }
  };
  track.onended = () => {
    showTileVideo(peerId, false);
    videoEl.srcObject = null;
  };
}

function attachScreenVideo(peerId, stream) {
  // Владелец и подпись уже выставлены обработчиком `share-started` — здесь
  // только подключаем сам видеопоток, как только он реально прибыл (может
  // случиться чуть позже самого share-started — WebRTC-негоциация не мгновенна).
  showScreenStageContainer();
  if (screenVideoEl.srcObject !== stream) {
    screenVideoEl.srcObject = stream;
    screenVideoEl.muted = false;
    safePlay(screenVideoEl);
  }
  if (peerId !== myPeerId) {
    showRemoteScreenCaption(peerId);
  }
}

/** Применить обновление `enabled` для уже подключённого потока камеры (toggle). */
function applyCameraEnabledUpdate(streamId, enabled) {
  const peerId = cameraStreamOwner.get(streamId);
  if (!peerId) return;
  const refs = peerMediaRefs.get(peerId);
  if (refs && refs.camera) refs.camera.enabled = enabled;
  // Если рендер сейчас запрещён правами гостя (см. refreshMediaRenderingForPeer)
  // — видео и так не подключено, трогать элемент не нужно (иначе показали бы
  // пустой/протухший кадр).
  const allowed = isPeerLeader(peerId) || (roomSettings && roomSettings.guestVideo);
  if (allowed) showTileVideo(peerId, enabled);
}

/** Применить обновление `enabled` для уже подключённого потока микрофона (toggle) — двигает индикатор «микрофон выключен» на тайле (см. static/style.css: .tile-mic-off), независимо от прав гостя на рендер аудио. */
function applyMicEnabledUpdate(streamId, enabled) {
  const peerId = micStreamOwner.get(streamId);
  if (!peerId) return;
  const refs = peerMediaRefs.get(peerId);
  if (refs && refs.mic) refs.mic.enabled = enabled;
  const entry = peers.get(peerId);
  if (entry) setTileMicOffIndicator(entry.tile, !enabled);
}

// ---------- Пиры: создание/удаление ----------

function createRemotePeer(peerId, name, iceServers) {
  const rtc = new RtcPeer({
    iceServers,
    polite: myPeerId > peerId,
    signaling,
    targetPeerId: peerId,
    // SAS: один сессионный сертификат на все соединения (см.
    // ensureSessionCertificate, static/crypto.js: deriveSas). Может быть null,
    // если генерация не удалась — тогда браузер сам выпустит сертификат, а SAS
    // просто не покажется.
    certificate: sessionCertificate,
    // Ш1 (E2E-шифрование): offer/answer/ice-candidate к ЭТОМУ пиру всегда
    // идут через серверный сигналинг-релей — RtcPeer шифрует/расшифровывает
    // их сам под K_sig (см. static/rtc.js), room.js только выдаёт функции.
    sigCrypto: {
      encrypt: (obj) => RoomCrypto.encrypt(sigKey, obj),
      decrypt: (blob) => RoomCrypto.decrypt(sigKey, blob),
    },
    onCryptoFailure: handleCryptoFailureOnce,
    onTrack: (event) => handleRemoteTrack(peerId, event),
    onStateChange: () => {},
    onBusMessage: (obj) => bus._dispatch(peerId, obj),
    // Ф2: как только шина к этому пиру открылась — сразу переслать ему по
    // ней снапшот всех наших актуальных stream-info (см.
    // sendAllActiveStreamInfoTo, там же почему это нужно ВТОРЫМ разом).
    onBusOpen: () => {
      sendAllActiveStreamInfoTo(peerId);
      // SAS: шина к пиру открылась — состав/фингерпринты могли измениться,
      // пересобираем раунд не дожидаясь таймера (см. sasRefresh).
      if (sasRefreshTimer) sasRefresh().catch(() => {});
      // Чат: слить локальную очередь исходящего, ждавшего открытия шины (пришло
      // на смену серверному fallback-релею, см. static/chat.js: notifyBusOpen).
      if (chat && typeof chat.notifyBusOpen === 'function') chat.notifyBusOpen(peerId);
    },
    // Ф3: входящий файловый DataChannel — маршрутизируем в ChatPanel (там
    // живёт протокол передачи файлов, см. static/chat.js). `chat` в момент
    // регистрации этого колбэка может быть ещё не создан (для первых пиров
    // ChatPanel.create() вызывается позже, см. joined ниже) — читаем
    // переменную в момент самого вызова колбэка, а не при регистрации.
    onFileChannel: (channel) => {
      if (chat) chat.handleIncomingFileChannel(peerId, channel);
    },
  });
  bus.addPeer(peerId, rtc);

  const tile = createTile(peerId, name, false);
  tile.crownEl.classList.toggle('hidden', leaderId !== peerId); // leaderId уже мог быть известен (peer-joined/реконнект)
  peers.set(peerId, { rtc, name, tile });

  // Локальные активные треки — сразу в новый pc (коалесцируются в один offer).
  if (micStream) rtc.pc.addTrack(micTrack, micStream);
  if (camStream) rtc.pc.addTrack(camTrack, camStream);
  if (screenStream) {
    for (const track of screenStream.getTracks()) rtc.pc.addTrack(track, screenStream);
  }
  sendAllActiveStreamInfoTo(peerId);
}

function removeRemotePeer(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  if (maximizedTile === entry.tile) unmaximizeTile(); // пир ушёл — показывать крупно больше нечего
  entry.rtc.close();
  entry.tile.root.remove();
  peers.delete(peerId);
  peerNames.delete(peerId);
  peerMediaRefs.delete(peerId);
  peerStatsHistory.delete(peerId); // иначе новое соединение с тем же peerId унаследует чужую точку отсчёта скорости
  peerLastStats.delete(peerId); // тот же принцип — кеш скорости не должен пережить peerId
  bus.removePeer(peerId);
  cleanupMicAudio(peerId);
  for (const [streamId, ownerPeerId] of cameraStreamOwner) {
    if (ownerPeerId === peerId) cameraStreamOwner.delete(streamId);
  }
  for (const [streamId, ownerPeerId] of micStreamOwner) {
    if (ownerPeerId === peerId) micStreamOwner.delete(streamId);
  }

  if (currentScreenOwnerPeerId === peerId) {
    currentScreenOwnerPeerId = null;
    hideScreenStage();
    updateScreenButtonState();
  }

  // SAS: состав изменился — пересобрать раунд (иначе останется старый roundId).
  if (sasRefreshTimer) sasRefresh().catch(() => {});
}

/**
 * Полный локальный teardown mesh/медиа/чата — используется терминальными
 * состояниями, после которых восстанавливать соединение бессмысленно (см.
 * signaling.on('room-expired') в registerSignalingHandlers: комната на
 * сервере уже удалена). В отличие от giveUpReconnect (там сокет сигналинга
 * умер, но mesh/DataChannel-чат физически могут пережить это и оставлены как
 * есть — см. docs/self-hosting.md, «Surviving a Restart/Redeploy»), здесь причина
 * терминальна ПО СУТИ (не «сервер моргнул», а «время вышло») — оставлять
 * висеть P2P-соединения и захваченные mic/camera/screen треки браузера
 * незачем, останавливаем их сразу.
 */
function teardownMeshMediaChat(reason) {
  // Свой камера-трек ниже останавливается напрямую (не через showTileVideo/
  // кнопку камеры) — если в этот момент был максимизирован именно свой
  // тайл, exitMaximizeIfHidden тут не сработает сама, поэтому сворачиваем
  // явно (иначе останется зависший чёрный оверлей после terminal-teardown).
  unmaximizeTile();
  // Единый поллер скоростей (см. startPeerStatsPolling) переживал бы этот
  // teardown сам — тикать на пустых peers дёшево, но комната больше не
  // восстановится (см. комментарий функции выше), поэтому останавливаем явно,
  // как и roomTimerInterval (см. stopRoomTimer в signaling.on('room-expired')).
  stopPeerStatsPolling();
  for (const peerId of Array.from(peers.keys())) {
    removeRemotePeer(peerId);
  }
  if (micTrack) micTrack.stop();
  micStream = null;
  micTrack = null;
  if (camTrack) camTrack.stop();
  camStream = null;
  camTrack = null;
  forceStopLocalScreenCapture();
  if (chat) chat.disableInput(reason);
}

// ---------- Реконнект: грейс-период для отставших пиров/владельца экрана ----------

/**
 * После успешного реконнекта пир может на время выпасть из свежего
 * joined.peers (сервер после рестарта ничего не помнит, пока участник сам не
 * переподключится) — вместо немедленного удаления даём ему
 * RECONNECT_PEER_GRACE_MS на переподключение. Если за это время придёт
 * peer-joined с тем же peerId — таймер снимается (см. cancelPendingPeerRemoval
 * в обработчике peer-joined), mesh-пир и не удалялся.
 */
function schedulePeerRemoval(peerId) {
  if (pendingPeerRemovals.has(peerId)) return;
  const timer = setTimeout(() => {
    pendingPeerRemovals.delete(peerId);
    removeRemotePeer(peerId);
    updateParticipantCount();
  }, RECONNECT_PEER_GRACE_MS);
  pendingPeerRemovals.set(peerId, timer);
}

function cancelPendingPeerRemoval(peerId) {
  const timer = pendingPeerRemovals.get(peerId);
  if (timer) {
    clearTimeout(timer);
    pendingPeerRemovals.delete(peerId);
  }
}

/** Симметричный грейс для владельца экрана, который сам ещё не ре-джойнился (см. reconcileScreenShareAfterReconnect). */
function scheduleScreenOwnerGrace(ownerPeerId) {
  if (screenOwnerGraceTimer) return;
  screenOwnerGraceTimer = setTimeout(() => {
    screenOwnerGraceTimer = null;
    if (currentScreenOwnerPeerId === ownerPeerId) {
      // Владелец так и не ре-джойнился в отведённый срок — сцена честно уходит.
      currentScreenOwnerPeerId = null;
      hideScreenStage();
      updateScreenButtonState();
    }
  }, RECONNECT_PEER_GRACE_MS);
}

function cancelScreenOwnerGrace() {
  if (screenOwnerGraceTimer) {
    clearTimeout(screenOwnerGraceTimer);
    screenOwnerGraceTimer = null;
  }
}

// ---------- Сигналинг ----------

// ---------- Модалка входа: показывается ПЕРВОЙ, join-room уходит только после клика ----------

function showJoinModal() {
  joinModalEl.classList.remove('hidden');
  // Предзаполняем сгенерированным именем (см. static/namegen.js: userName())
  // — жмёшь «Войти» и всё, спрашивать не обязательно. Пользователь может
  // стереть поле → как и раньше, останется анонимом (onJoinModalSubmit:
  // trim() + `|| null`). !value — на случай, если поле уже что-то содержит
  // (не должно к этому моменту, но не перетираем на всякий случай).
  if (!joinNameInputEl.value) joinNameInputEl.value = NameGen.userName();
  joinNameInputEl.focus();
  joinNameInputEl.select();
}

function hideJoinModal() {
  joinModalEl.classList.add('hidden');
}

let joinSubmitInProgress = false;

async function onJoinModalSubmit() {
  if (joinSubmitInProgress) return;
  joinSubmitInProgress = true;
  // Клик — user-gesture, полезный заодно и для AudioContext (см.
  // static/common.js: SpeakingDetection пытается резюмировать AudioContext
  // по click/keydown).
  const raw = joinNameInputEl.value.trim();
  myName = raw || null;
  hideJoinModal();
  await connectAndJoin();
}

joinModalButtonEl.addEventListener('click', onJoinModalSubmit);
joinNameInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    onJoinModalSubmit();
  }
});

async function init() {
  // Ш1 (E2E-шифрование): ключ комнаты обязателен ДО показа чего-либо
  // связанного с реальным входом — без него нет смысла даже спрашивать имя,
  // всё равно ничего не заработает (см. docs/e2e-encryption.md,
  // deriveRoomKeys выше). Та же семантика, что и при отказе расшифровки
  // первого входящего сообщения (см. showInvalidLinkOverlay).
  const keysOk = await deriveRoomKeys();
  if (!keysOk) {
    showInvalidLinkOverlay();
    return;
  }

  // Анонимность (см. docs/privacy.md, «Anonymity»): имя спрашивается заново при КАЖДОМ заходе
  // этой модалкой — никакого localStorage. Поле предзаполнено сгенерированным
  // именем (см. showJoinModal: NameGen.userName()), чтобы можно было просто
  // нажать «Войти» без ввода, но пользователь может стереть его — тогда
  // останется анонимом, как и раньше. join-room уходит только после
  // клика «Войти» (см. onJoinModalSubmit). При авто-reconnect модалка не
  // показывается повторно — имя уже в памяти вкладки (myName), см.
  // attemptReconnectOnce/sendJoinAndWait ниже.
  showJoinModal();
}

async function connectAndJoin() {
  showOverlay({ title: 'Connecting…', spinner: true });

  iceServersCache = await fetchIceServers();
  lastKnownVersion = await fetchVersion();
  await ensureSessionCertificate();

  signaling = new Signaling();
  signaling.onError = (event) => {
    console.error('Ошибка сигналинга:', event);
  };
  signaling.onClose = () => {
    // Уже переподключаемся (этот close — от неудавшейся попытки внутри
    // самого цикла реконнекта) — цикл сам разберётся, повторно не запускаем.
    if (reconnecting) return;
    // Пользователь сам вышел, или уже показан терминальный оверлей
    // (room-not-found/room-full до первого joined, либо разрыв ещё до
    // первого joined) — реконнект тут неуместен.
    if (intentionalDisconnect || terminalState || !joinedOnce) return;

    // Неожиданный обрыв сигналинга после успешного входа — mesh (медиа,
    // DataChannel-чат) при этом жив (см. docs/self-hosting.md, «Surviving a
    // Restart/Redeploy»), поэтому НЕ рушим
    // интерфейс сразу: тонкий баннер + авто-reconnect с бэкоффом, и только
    // если он исчерпает бюджет — терминальный оверлей «Соединение потеряно».
    startReconnectLoop();
  };

  try {
    await signaling.connect();
  } catch (err) {
    terminalState = true;
    showOverlay({
      title: 'Could not connect',
      text: 'Check your internet connection and refresh the page.',
    });
    return;
  }

  registerSignalingHandlers(iceServersCache);
  // Ш1: имя шифруется под K_meta ВСЕГДА (даже пустое/null) — присутствие
  // самого поля больше не сигнализирует ничего, сервер и так его не читает
  // (см. static/crypto.js: encryptToBase64).
  const encName = await encryptMyName();
  signaling.send('join-room', {
    roomId,
    name: encName,
    ...(initialLeaderToken ? { leaderToken: initialLeaderToken } : {}),
  });
}

function registerSignalingHandlers(iceServers) {
  signaling.on('joined', async ({ peerId, peers: otherPeers, screenOwner, leaderId: joinedLeaderId, settings, pending, expiresInSeconds }) => {
    // Реконнект ждёт именно этот ответ (см. sendJoinAndWait) — репортуем ему
    // исход в дополнение к обычной обработке ниже (при первом входе
    // pendingJoinResolve никогда не взведён).
    if (pendingJoinResolve) pendingJoinResolve('joined');

    // Лимит длительности созвона: пересчитываем дедлайн из свежего
    // expiresInSeconds на КАЖДОМ joined — и при первом входе, и при
    // реконнекте (см. startRoomTimer выше и docs/security.md, «Meeting
    // Duration Ceiling»).
    startRoomTimer(expiresInSeconds);

    if (!joinedOnce) {
      // --- Первый вход в комнату (не реконнект) ---
      joinedOnce = true;
      myPeerId = peerId;
      hideOverlay();

      ownTile = createTile(peerId, myName, true);

      // Ш1: имена остальных участников приходят зашифрованными под K_meta
      // (см. src/protocol.rs::PeerInfo.name) — расшифровываем перед любым
      // отображением; не расшифровалось -> «Гость» (см. decryptPeerName).
      for (const p of otherPeers) {
        const decodedName = await decryptPeerName(p.name);
        peerNames.set(p.peerId, decodedName);
        createRemotePeer(p.peerId, decodedName, iceServers);
      }

      currentScreenOwnerPeerId = screenOwner || null;
      if (currentScreenOwnerPeerId && currentScreenOwnerPeerId !== myPeerId) {
        showRemoteScreenCaption(currentScreenOwnerPeerId);
      }

      roomSettings = settings;
      pendingRequests = await Promise.all(
        (pending || []).map(async (p) => ({ peerId: p.peerId, name: await decryptPeerName(p.name) }))
      );
      setLeaderIndicator(joinedLeaderId);
      updateSettingsButtonVisibility();
      renderJoinRequests();
      applyGuestEnforcement();

      updateScreenButtonState();
      updateParticipantCount();

      chat = ChatPanel.create({
        signaling,
        bus,
        peerId,
        name: myName,
        variant: 'room',
        toggleButton: chatButton,
        getPeerIds: () => Array.from(peers.keys()),
        initialPeerIds: otherPeers.map((p) => p.peerId),
        getLeaderId: () => leaderId,
        getGuestChatAllowed: () => (roomSettings ? roomSettings.guestChat : true),
      });
      startSasUpdates();
      // Единый поллер скоростей (см. PEER_STATS_REFRESH_MS/pollPeerStats) —
      // стартует при входе в комнату и тикает всю сессию, независимо от
      // числа пиров и открытости панели настроек.
      startPeerStatsPolling();
      return;
    }

    // --- Реконнект: сверяем состояние комнаты с тем, что у нас уже есть ---
    // (mesh/медиа/чат уже жили всё это время, ничего из этого не пересоздаём
    // — см. reconcileAfterReconnect). peerId сервер обычно возвращает тот же
    // (см. src/ws.rs::JoinRoom { peer_id }), но подстрахуемся и на случай,
    // если он всё же сменился.
    myPeerId = peerId;
    roomSettings = settings;
    setLeaderIndicator(joinedLeaderId);
    updateSettingsButtonVisibility();
    // Лидерство при реконнекте может смениться (см.
    // docs/permissions-and-leader.md, «Reconnecting With the Same Peer Id»:
    // сервер мог уже удалить нас и назначить нового лидера) — pending
    // видим заново, только если после реконнекта лидер снова мы.
    pendingRequests = isLeader
      ? await Promise.all((pending || []).map(async (p) => ({ peerId: p.peerId, name: await decryptPeerName(p.name) })))
      : [];
    renderJoinRequests();
    applyGuestEnforcement();
    await reconcileAfterReconnect(otherPeers, screenOwner);
    refreshMediaRenderingForAllPeers();
  });

  signaling.on('waiting', () => {
    // Лобби (см. docs/permissions-and-leader.md, «The Waiting Room
    // (Lobby)»): вместо joined сначала приходит
    // это — ждём решения лидера. «Отменить» = leave + на главную (тот же
    // приём, что и у leaveButton ниже — intentionalDisconnect до leave).
    showOverlay({
      title: 'Waiting for approval…',
      text: myName ? `You joined as "${myName}"` : 'Waiting for the room leader to respond.',
      spinner: true,
      actionLabel: 'Cancel',
      onAction: () => {
        intentionalDisconnect = true;
        if (signaling) signaling.send('leave');
        location.href = '/';
      },
    });
  });

  signaling.on('join-request', async ({ peerId, name }) => {
    addPendingRequest(peerId, await decryptPeerName(name));
  });

  signaling.on('join-request-cancelled', ({ peerId }) => {
    removePendingRequest(peerId);
  });

  signaling.on('join-rejected', () => {
    terminalState = true;
    showOverlay({
      title: 'Access denied',
      text: 'The room leader declined your join request.',
      actionLabel: 'Go home',
    });
  });

  signaling.on('settings-changed', ({ settings }) => {
    roomSettings = settings;
    if (!settingsPanelEl.classList.contains('hidden')) syncSettingsPanelInputs();
    applyGuestEnforcement();
    refreshMediaRenderingForAllPeers();
  });

  signaling.on('leader-changed', ({ leaderId: newLeaderId }) => {
    setLeaderIndicator(newLeaderId);
    updateSettingsButtonVisibility();
    applyGuestEnforcement();
    refreshMediaRenderingForAllPeers();
    if (newLeaderId === myPeerId) {
      showToast('You are now the leader');
    } else {
      showToast(`${peerNames.get(newLeaderId) || 'Guest'} is now the leader`);
    }
  });

  signaling.on('room-not-found', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-not-found');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Room not found',
      text: 'The link is invalid or the room has already been deleted.',
      actionLabel: 'Create a new one',
    });
  });

  signaling.on('room-full', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-full');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Room is full',
      text: 'This room already has the maximum of 6 participants. Please try again later.',
    });
  });

  // Лимит длительности созвона (3 часа, см. docs/security.md, «Meeting
  // Duration Ceiling», и startRoomTimer выше):
  // сервер сам решает, что время вышло — рассылает это всем участникам И
  // ожидающим в лобби, и сам закрывает сокет сразу следом (см. src/ws.rs::
  // reap_rooms, src/state.rs). terminalState=true ставим СИНХРОННО здесь же
  // (до того, как придёт сам close) — это тот же приём, что и у
  // room-not-found/room-full/join-rejected выше: signaling.onClose проверяет
  // terminalState и не запускает авто-reconnect, не перетирает этот оверлей
  // «Соединением потеряно» (см. connectAndJoin: signaling.onClose). Терминально
  // и безвозвратно — комната на сервере уже удалена, реконнект в неё
  // технически ничего не восстановит (в отличие от рестарта сервера, см.
  // restoreRoomViaPut — здесь восстанавливать нечего, лимит истёк осознанно).
  signaling.on('room-expired', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-expired');
    }
    if (terminalState) return; // оверлей уже показан (двойная доставка/гонка) — не перетираем
    terminalState = true;
    stopRoomTimer();
    showOverlay({
      title: 'Meeting time is up (3 hours)',
      text: 'The room is closed — the meeting duration limit was reached.',
      actionLabel: 'Create a new one',
    });
    teardownMeshMediaChat('Meeting time is up.');
  });

  signaling.on('peer-joined', async ({ peerId, name }) => {
    const decodedName = await decryptPeerName(name);
    peerNames.set(peerId, decodedName);
    if (peers.has(peerId)) {
      // Уже знаем этого пира — mesh пережил обрыв сигналинга (наш или его),
      // это просто повторный peer-joined от его собственного реконнекта.
      // Идемпотентно: существующий RtcPeer НЕ пересоздаём.
      cancelPendingPeerRemoval(peerId);
      return;
    }
    createRemotePeer(peerId, decodedName, iceServers);
    updateParticipantCount();
  });

  signaling.on('peer-left', ({ peerId }) => {
    removeRemotePeer(peerId);
    updateParticipantCount();
  });

  signaling.on('offer', async ({ fromPeerId, sdp }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) {
      console.warn('offer от неизвестного пира:', fromPeerId);
      return;
    }
    await entry.rtc.handleDescription(sdp);
  });

  signaling.on('answer', async ({ fromPeerId, sdp }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) return;
    await entry.rtc.handleDescription(sdp);
  });

  signaling.on('ice-candidate', async ({ fromPeerId, candidate }) => {
    const entry = peers.get(fromPeerId);
    if (!entry) return;
    await entry.rtc.handleCandidate(candidate);
  });

  // Серверный релей-фоллбэк (см. sendStreamInfoTo) — актуален, пока шина к
  // конкретному пиру ещё не открыта (в основном bootstrap-окно сразу после
  // входа в комнату); дальше основной путь — bus.onMessage выше, этот
  // обработчик становится редким (см. handleStreamInfo — общая точка входа).
  // Ш1: `info` с этого пути приходит зашифрованным под K_sig (см.
  // sendStreamInfoTo) — по шине (bus.onMessage выше) info остаётся
  // как есть, не завёрнутым.
  signaling.on('stream-info', ({ info }) => {
    RoomCrypto.decrypt(sigKey, info)
      .then((plainInfo) => handleStreamInfo(plainInfo))
      .catch((err) => handleCryptoFailureOnce(err));
  });

  signaling.on('share-started', ({ peerId }) => {
    cancelScreenOwnerGrace(); // владелец подтверждён сервером — грейс больше не нужен
    // Перехват экрана (см. docs/permissions-and-leader.md, «last wins»): если
    // до этого сообщения ВЛАДЕЛЬЦЕМ был я (currentScreenOwnerPeerId===myPeerId)
    // и мой локальный захват (getDisplayMedia) ещё жив, а peerId в этом
    // broadcast — уже не мой, значит меня только что перехватили. Сервер не
    // шлёт для этого отдельное сообщение — он рассылает share-started всем,
    // включая прежнего владельца, и это же сообщение служит ему сигналом
    // остановить свой захват.
    const iAmPreempted = currentScreenOwnerPeerId === myPeerId && screenStream && peerId !== myPeerId;
    currentScreenOwnerPeerId = peerId;
    if (peerId === myPeerId) {
      showLocalScreenPreview();
    } else {
      if (iAmPreempted) {
        forceStopLocalScreenCapture();
      }
      showRemoteScreenCaption(peerId);
    }
    updateScreenButtonState();
    if (pendingShareDecision && peerId === myPeerId) {
      pendingShareDecision.resolve(true);
      pendingShareDecision = null;
    }
  });

  signaling.on('share-stopped', ({ peerId }) => {
    cancelScreenOwnerGrace();
    if (currentScreenOwnerPeerId === peerId) {
      currentScreenOwnerPeerId = null;
    }
    hideScreenStage();
    updateScreenButtonState();
  });

  signaling.on('share-rejected', ({ busyPeerId, reason }) => {
    cancelScreenOwnerGrace();
    if (screenStream && currentScreenOwnerPeerId === myPeerId) {
      // Мы шарили экран до обрыва сигналинга и после реконнекта попытались
      // переиграть share-start (см. reconcileScreenShareAfterReconnect). Занятость
      // экрана больше не отклоняется (перехват при конфликте владения — см.
      // handle_share_start), так что единственная причина реального отказа
      // здесь — потеря прав (лидер выключил guestScreen, пока мы были офлайн,
      // см. ветку reason==='forbidden' ниже) — корректно останавливаем свой
      // локальный захват.
      forceStopLocalScreenCapture();
    }
    if (reason === 'forbidden') {
      // Отказ по правам (guestScreen=false, см. docs/permissions-and-leader.md,
      // «Screen Sharing — Server-Enforced»),
      // а не потому что экран занят — busyPeerId в этом случае не приходит.
      currentScreenOwnerPeerId = null;
      updateScreenButtonState();
      showRoomMessage('The leader has disabled screen sharing.');
    } else {
      // Сервер больше никогда не шлёт "занято" (см. src/protocol.rs::ShareRejected) —
      // эта ветка на практике мёртвая, оставлена только как защитная
      // синхронизация состояния на случай непредвиденной причины отказа.
      currentScreenOwnerPeerId = busyPeerId || null;
      updateScreenButtonState();
      if (busyPeerId) {
        showRoomMessage(`${peerNames.get(busyPeerId) || 'Another participant'} is already sharing their screen.`);
      }
    }
    if (pendingShareDecision) {
      pendingShareDecision.resolve(false);
      pendingShareDecision = null;
    }
  });

  signaling.on('error', ({ message }) => {
    console.error('Сервер сигналинга сообщил об ошибке:', message);
  });
}

// ---------- Реконнект: цикл переподключения ----------

/** Дождаться исхода ОДНОЙ попытки join-room: 'joined' | 'room-not-found' | 'room-full' | 'timeout'. */
function waitForJoinOutcome(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      pendingJoinResolve = null;
      resolve(status);
    };
    pendingJoinResolve = finish;
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** Отправить join-room со своим прежним peerId (см. src/protocol.rs) и дождаться исхода. */
async function sendJoinAndWait() {
  const promise = waitForJoinOutcome(RECONNECT_JOIN_TIMEOUT_MS);
  const encName = await encryptMyName(); // Ш1: то же самое K_meta-шифрование имени, что и при первом входе (см. connectAndJoin)
  signaling.send('join-room', {
    roomId,
    name: encName,
    ...(myPeerId ? { peerId: myPeerId } : {}),
  });
  return promise;
}

/** PUT /api/rooms/<roomId> — восстановить комнату, если реапер/рестарт её убрали (см. src/main.rs::restore_room). */
async function restoreRoomViaPut() {
  try {
    // Ш2: через window.API_BASE — см. fetchVersion выше и static/config.js.
    const res = await fetch(`${window.API_BASE}/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PUT' });
    return res.ok; // 200 (уже была) или 201 (создана) — оба ок
  } catch (err) {
    return false;
  }
}

/** Одна попытка реконнекта целиком: открыть WS -> join-room -> (если room-not-found) PUT restore -> join-room ещё раз. */
async function attemptReconnectOnce() {
  try {
    await signaling.connect();
  } catch (err) {
    return false;
  }

  const outcome = await sendJoinAndWait();
  if (outcome === 'joined') return true;

  if (outcome === 'room-not-found') {
    const restored = await restoreRoomViaPut();
    if (!restored) return false;
    // Сервер сам закрывает сокет сразу после отказа room-not-found (см.
    // src/ws.rs: «после отказа сервер сам закрывает сокет») — повторный
    // join-room на ТОМ ЖЕ сокете уйдёт в никуда (см. Signaling.send: тихо
    // не отправит на неоткрытом сокете), поэтому перед повторной попыткой
    // открываем НОВОЕ соединение.
    try {
      await signaling.connect();
    } catch (err) {
      return false;
    }
    const outcome2 = await sendJoinAndWait();
    return outcome2 === 'joined';
  }

  // 'room-full' (маловероятно — наше место освобождается почти сразу после
  // обрыва) или 'timeout' — считаем попытку неудачной, цикл повторит с бэкоффом.
  return false;
}

function startReconnectLoop() {
  if (reconnecting) return;
  reconnecting = true;
  reconnectAttempt = 0;
  reconnectDeadline = Date.now() + RECONNECT_TOTAL_BUDGET_MS;
  showReconnectBanner();
  scheduleNextReconnectAttempt(0);
}

function scheduleNextReconnectAttempt(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    const ok = await attemptReconnectOnce();
    if (ok) {
      finishReconnectSuccess();
      return;
    }
    if (Date.now() >= reconnectDeadline) {
      giveUpReconnect();
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    scheduleNextReconnectAttempt(delay);
  }, delayMs);
}

function finishReconnectSuccess() {
  reconnecting = false;
  hideReconnectBanner();
  // Стандарт version-skew баннера: перечитать /version.json после каждого
  // успешного реконнекта (см. docs/signaling-protocol.md, «GET /version.json»).
  checkVersionSkew();
}

function giveUpReconnect() {
  reconnecting = false;
  hideReconnectBanner();
  terminalState = true;
  showOverlay({
    title: 'Connection lost',
    text: 'Lost the connection to the signaling server. Please refresh the page.',
  });
  if (chat) chat.disableInput('Connection lost.');
}

// ---------- Реконнект: сверка состояния комнаты после успешного join ----------

/**
 * После реконнекта сервер может знать о комнате МЕНЬШЕ, чем знаем мы сами
 * (если он рестартовал — комната воссоздана пустой через PUT restore и
 * заново наполняется по мере того, как остальные участники тоже
 * переподключаются). НЕ пересоздаём то, что уже есть (mesh, тайлы, чат) —
 * только сверяем: новые для нас peers — создаём, тех, кого больше нет в
 * свежем списке — не удаляем сразу, а даём грейс-период (см.
 * schedulePeerRemoval) на случай, что они просто ещё не успели ре-джойниться.
 */
async function reconcileAfterReconnect(otherPeers, screenOwner) {
  const freshIds = new Set(otherPeers.map((p) => p.peerId));

  for (const p of otherPeers) {
    const decodedName = await decryptPeerName(p.name); // Ш1: тот же K_meta, что и в joined/peer-joined
    peerNames.set(p.peerId, decodedName);
    if (peers.has(p.peerId)) {
      cancelPendingPeerRemoval(p.peerId);
    } else {
      createRemotePeer(p.peerId, decodedName, iceServersCache);
    }
  }

  for (const peerId of Array.from(peers.keys())) {
    if (!freshIds.has(peerId)) {
      schedulePeerRemoval(peerId);
    }
  }

  updateParticipantCount();
  reconcileScreenShareAfterReconnect(screenOwner);
}

/**
 * Сверка состояния шаринга экрана после реконнекта:
 *   - если ДО обрыва шарили мы сами (и захват всё ещё жив локально —
 *     mesh/getDisplayMedia не зависят от сигналинга) — переигрываем
 *     share-start; занятость экрана сервер больше не отклоняет (перехват
 *     вместо отказа — см. handle_share_start), так что это либо подтвердится
 *     (share-started, при необходимости само же и перехватит того, кто занял
 *     экран пока мы были офлайн), либо, если лидер успел отобрать guestScreen
 *     — придёт share-rejected {reason: forbidden}, тогда свой захват
 *     корректно останавливаем (см. обработчик share-rejected выше);
 *   - если шарил кто-то другой и сервер после рестарта его уже знает
 *     (screenOwner пришёл) — просто синхронизируем метку;
 *   - если шарил кто-то другой, но сервер о нём пока не знает (owner ещё не
 *     ре-джойнился, screenOwner=null) — сцена и так жива по mesh, НЕ рушим
 *     её немедленно, даём тот же грейс-период, что и пирам;
 *   - если никто не шарил — просто снимаем метку.
 */
function reconcileScreenShareAfterReconnect(screenOwner) {
  if (currentScreenOwnerPeerId === myPeerId && screenStream) {
    pendingShareDecision = null; // на случай зависшего резолвера от старой попытки
    signaling.send('share-start');
    return;
  }

  if (screenOwner) {
    currentScreenOwnerPeerId = screenOwner;
    if (screenOwner !== myPeerId) {
      showRemoteScreenCaption(screenOwner);
    }
    updateScreenButtonState();
  } else if (currentScreenOwnerPeerId && currentScreenOwnerPeerId !== myPeerId) {
    scheduleScreenOwnerGrace(currentScreenOwnerPeerId);
  } else {
    currentScreenOwnerPeerId = null;
    updateScreenButtonState();
  }
}

// ---------- Микрофон ----------

function setMicButtonOn(on) {
  micButton.classList.toggle('control-button--on', on);
  micButton.setAttribute('aria-pressed', String(on));
}

/** Индикатор «микрофон выключен» на своём тайле — по факту наличия и enabled текущего micTrack. */
function updateOwnMicIndicator() {
  setTileMicOffIndicator(ownTile, !(micTrack && micTrack.enabled));
}

/**
 * Живая замена устройства микрофона БЕЗ ренегоциации: новый getUserMedia ->
 * RTCRtpSender.replaceTrack на всех уже существующих соединениях (спецификация
 * гарантирует, что replaceTrack не триггерит onnegotiationneeded — приёмники
 * не видят нового ontrack, тот же remote-трек просто начинает нести другое
 * содержимое) -> старый трек останавливаем. `enabledValue` — состояние
 * (включён/выключен), которое должен получить новый трек: вызывающая сторона
 * решает (при обычном переключении «на лету» сохраняем текущее, при
 * отложенном включении после смены устройства, пока мик молчал — то, что
 * получилось бы обычным кликом «включить»).
 */
async function liveSwitchMicTrack(deviceId, enabledValue) {
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (err) {
    console.warn('Не удалось переключить микрофон:', err);
    showRoomMessage('Could not switch microphone.');
    return;
  }
  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = enabledValue;
  for (const entry of peers.values()) {
    const sender = entry.rtc.pc.getSenders().find((s) => s.track === micTrack);
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        console.warn('replaceTrack(mic) не удался:', err);
      }
    }
  }
  const oldTrack = micTrack;
  micStream.removeTrack(oldTrack);
  micStream.addTrack(newTrack);
  oldTrack.stop();
  micTrack = newTrack;
  currentMicDeviceId = deviceId || null;
}

/** Выбор устройства в селекте (см. static/room.html: #setting-mic-device). */
async function applyMicDeviceChange(deviceId) {
  selectedMicDeviceId = deviceId || null;
  // Мик сейчас реально включён — переключаем немедленно (см. задание, п.1).
  // Иначе (выключен кнопкой или ещё ни разу не запрошен) — только запомнили
  // выбор, реальное переключение случится при следующем включении (см.
  // micButton click ниже).
  if (!micTrack || !micTrack.enabled) return;
  await liveSwitchMicTrack(selectedMicDeviceId, true);
  updateOwnMicIndicator();
}

micButton.addEventListener('click', async () => {
  if (micRequestInProgress) return;

  if (!micTrack) {
    micRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicDeviceId ? { deviceId: { exact: selectedMicDeviceId } } : true,
      });
    } catch (err) {
      console.warn('Доступ к микрофону отклонён:', err);
      showRoomMessage('Could not access the microphone.');
      micRequestInProgress = false;
      return;
    }
    micRequestInProgress = false;

    micStream = stream;
    micTrack = stream.getAudioTracks()[0];
    currentMicDeviceId = selectedMicDeviceId;
    broadcastLocalStream(stream, 'mic');
    setMicButtonOn(true);
    updateOwnMicIndicator();
    refreshDeviceLists(); // разрешение получено — у enumerateDevices теперь есть labels
  } else {
    const turningOn = !micTrack.enabled;
    if (turningOn && selectedMicDeviceId && selectedMicDeviceId !== currentMicDeviceId) {
      // Пока молчали, выбрали другое устройство в настройках — подхватываем
      // его именно сейчас, при включении (см. задание, «при выключенном —
      // запомнить и использовать при следующем включении»).
      await liveSwitchMicTrack(selectedMicDeviceId, true);
    } else {
      micTrack.enabled = turningOn;
    }
    setMicButtonOn(micTrack.enabled);
    updateOwnMicIndicator();
    broadcastStreamEnabled(micStream, 'mic', micTrack.enabled);
  }
});

// ---------- Камера ----------

function setCameraButtonOn(on) {
  cameraButton.classList.toggle('control-button--on', on);
  cameraButton.setAttribute('aria-pressed', String(on));
}

function cameraConstraintsFor(deviceId) {
  return {
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 15 },
    // deviceId и facingMode вместе не нужны — конкретное устройство уже
    // однозначно выбрано; facingMode (фронтальная по умолчанию на телефоне)
    // остаётся только фоллбэком, пока пользователь ничего не выбрал сам.
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  };
}

/** Живая замена устройства камеры БЕЗ ренегоциации — см. liveSwitchMicTrack, тот же приём для video. */
async function liveSwitchCamTrack(deviceId, enabledValue) {
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraintsFor(deviceId) });
  } catch (err) {
    console.warn('Не удалось переключить камеру:', err);
    showRoomMessage('Could not switch camera.');
    return;
  }
  const newTrack = newStream.getVideoTracks()[0];
  newTrack.enabled = enabledValue;
  for (const entry of peers.values()) {
    const sender = entry.rtc.pc.getSenders().find((s) => s.track === camTrack);
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        console.warn('replaceTrack(camera) не удался:', err);
      }
    }
  }
  const oldTrack = camTrack;
  camStream.removeTrack(oldTrack);
  camStream.addTrack(newTrack);
  oldTrack.stop();
  camTrack = newTrack;
  currentCamDeviceId = deviceId || null;
  if (ownTile) {
    ownTile.videoEl.srcObject = camStream;
    safePlay(ownTile.videoEl);
  }
}

/** Выбор устройства в селекте (см. static/room.html: #setting-camera-device). */
async function applyCameraDeviceChange(deviceId) {
  selectedCamDeviceId = deviceId || null;
  if (!camTrack || !camTrack.enabled) return;
  await liveSwitchCamTrack(selectedCamDeviceId, true);
}

cameraButton.addEventListener('click', async () => {
  if (camRequestInProgress) return;

  if (!camTrack) {
    camRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraintsFor(selectedCamDeviceId) });
    } catch (err) {
      console.warn('Доступ к камере отклонён:', err);
      showRoomMessage('Could not access the camera.');
      camRequestInProgress = false;
      return;
    }
    camRequestInProgress = false;

    camStream = stream;
    camTrack = stream.getVideoTracks()[0];
    currentCamDeviceId = selectedCamDeviceId;
    broadcastLocalStream(stream, 'camera');

    if (ownTile) {
      ownTile.videoEl.srcObject = stream;
      safePlay(ownTile.videoEl);
      setTileVideoVisible(ownTile, true);
    }
    setCameraButtonOn(true);
    refreshDeviceLists(); // разрешение получено — у enumerateDevices теперь есть labels
  } else {
    const turningOn = !camTrack.enabled;
    if (turningOn && selectedCamDeviceId && selectedCamDeviceId !== currentCamDeviceId) {
      await liveSwitchCamTrack(selectedCamDeviceId, true);
    } else {
      camTrack.enabled = turningOn;
    }
    setCameraButtonOn(camTrack.enabled);
    if (ownTile) setTileVideoVisible(ownTile, camTrack.enabled);
    broadcastStreamEnabled(camStream, 'camera', camTrack.enabled);
  }
});

// ---------- Экран (кнопка) ----------

screenButton.addEventListener('click', async () => {
  if (screenButton.disabled) return;

  if (currentScreenOwnerPeerId === myPeerId) {
    stopScreenShare();
    return;
  }

  screenButton.disabled = true; // не даём кликнуть повторно, пока ждём решение сервера
  const granted = await new Promise((resolve) => {
    pendingShareDecision = { resolve };
    signaling.send('share-start');
  });

  if (!granted) {
    updateScreenButtonState();
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      // Defense-in-depth к заглушке в showLocalScreenPreview (основной фикс
      // «зеркального коридора» — см. её комментарий): selfBrowserSurface
      // убирает СВОЮ же вкладку из пикера захвата (для варианта «весь экран»
      // не спасает — это поля первого уровня опций getDisplayMedia, не
      // video-constraints; браузеры без их поддержки безопасно игнорируют).
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    console.warn('getDisplayMedia отменён/отклонён:', err);
    signaling.send('share-stop'); // отпускаем захваченный замок
    showRoomMessage('Screen sharing was cancelled.');
    updateScreenButtonState();
    return;
  }

  if (currentScreenOwnerPeerId !== myPeerId) {
    // Гонка (см. docs/permissions-and-leader.md, «перехват шаринга»): пока мы
    // ждали решение ОС/браузера в getDisplayMedia (реальная асинхронная пауза
    // — единственное окно, где это возможно), кто-то другой успел прислать
    // свой share-start и перехватить экран раньше нас (обработчик
    // share-started выше уже обновил currentScreenOwnerPeerId и сцену).
    // Наш захват уже никому не нужен — сразу останавливаем, не показывая
    // свою сцену и не трогая чужую.
    for (const track of stream.getTracks()) track.stop();
    updateScreenButtonState();
    return;
  }

  screenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      console.log('Видеотрек экрана завершён браузером (нативная плашка «Прекратить показ») — останавливаем шаринг');
      stopScreenShare();
    };
  }

  broadcastLocalStream(stream, 'screen');
  showLocalScreenPreview();
  updateScreenButtonState();
});

/** Остановить локальный захват экрана (треки + отправку пирам), без share-stop серверу и без трогать UI сцены — используется обычной остановкой (stopScreenShare), реконнектом (см. обработчик share-rejected в registerSignalingHandlers) и перехватом экрана другим участником (см. обработчик share-started там же). */
function forceStopLocalScreenCapture() {
  if (!screenStream) return;
  removeLocalStreamFromAllPeers(screenStream);
  for (const track of screenStream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  screenStream = null;
}

function stopScreenShare() {
  if (!screenStream) return;
  forceStopLocalScreenCapture();
  signaling.send('share-stop');
  hideScreenStage();
  currentScreenOwnerPeerId = null;
  updateScreenButtonState();
}

// ---------- Fullscreen сцены шаринга экрана ----------
//
// Fullscreen API у современных Chrome/Safari не требует webkit-префикса на
// десктопе, но iOS Safari (даже актуальные версии на момент написания —
// см. caniyouse.com/fullscreen) поддерживает requestFullscreen() на
// произвольном элементе не везде так же надёжно, как webkitRequestFullscreen
// — поэтому пробуем стандартный метод первым и откатываемся на webkit-версию
// как на iOS-фоллбэк. Тот же приём для exitFullscreen/fullscreenElement.
function requestFullscreenCompat(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error('Fullscreen API is not available'));
  return fn.call(el);
}

function exitFullscreenCompat() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (!fn) return Promise.resolve();
  return fn.call(document);
}

function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Помимо обычного aria-pressed/title по фактическому состоянию Fullscreen
 * API, прячет и дизейблит кнопку, когда экран сейчас шарю я сам —
 * фулскринить свою же статичную заглушку «You are sharing your screen» (см.
 * showLocalScreenPreview) смысла нет, там нет живого видео. Пересчитывается
 * из showLocalScreenPreview/showRemoteScreenCaption/hideScreenStage (владение
 * сценой могло смениться, в т.ч. перехватом) и штатно на fullscreenchange.
 */
function updateFullscreenButtonState() {
  const selfSharing = currentScreenOwnerPeerId === myPeerId;
  screenFullscreenButtonEl.classList.toggle('hidden', selfSharing);
  screenFullscreenButtonEl.disabled = selfSharing;
  if (selfSharing) {
    screenFullscreenButtonEl.title = 'Not available while sharing your own screen';
    screenFullscreenButtonEl.setAttribute('aria-label', screenFullscreenButtonEl.title);
    return;
  }
  const active = isFullscreenActive();
  screenFullscreenButtonEl.setAttribute('aria-pressed', String(active));
  screenFullscreenButtonEl.title = active ? 'Exit fullscreen' : 'Fullscreen';
  screenFullscreenButtonEl.setAttribute('aria-label', screenFullscreenButtonEl.title);
}

screenFullscreenButtonEl.addEventListener('click', async () => {
  try {
    if (isFullscreenActive()) {
      await exitFullscreenCompat();
    } else {
      await requestFullscreenCompat(screenStageEl);
    }
  } catch (err) {
    // Fullscreen может быть недоступен (headless-браузер, запрет окружения и
    // т.п.) — не ломаем остальной UI, просто логируем.
    console.warn('Fullscreen недоступен:', err);
  }
});

document.addEventListener('fullscreenchange', updateFullscreenButtonState);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);

// ---------- Поделиться (попап с QR + ссылка) ----------

/** Скопировать текст в буфер обмена с фоллбэком для окружений без Clipboard API. */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const tmpInput = document.createElement('input');
      tmpInput.value = text;
      tmpInput.style.position = 'fixed';
      tmpInput.style.opacity = '0';
      document.body.appendChild(tmpInput);
      tmpInput.focus();
      tmpInput.select();
      tmpInput.setSelectionRange(0, text.length);
      const success = document.execCommand('copy');
      tmpInput.remove();
      return success;
    } catch (execErr) {
      console.error('Не удалось скопировать ссылку:', execErr);
      return false;
    }
  }
}

function onSharePopupKeydown(event) {
  if (event.key === 'Escape') closeSharePopup();
}

/**
 * Ссылка «Поделиться» (Ш1): собирается ЗАНОВО из location.pathname + ключа
 * комнаты, запомненного при старте страницы (roomKeyBase64url, см. верх
 * файла) — НЕ из location.href, потому что leaderToken там в любом случае
 * никогда не было бы (он одноразовый и только для создателя). Вид:
 * `<origin>/r/<id>#k=<key>&n=<имя>` — БЕЗ lt. `n` добавляется только если имя
 * комнаты известно (initialRoomName) — так название комнаты едет в
 * инвайт-ссылке и становится видно всем, кто по ней перешёл (см. рендер
 * initialRoomName и парсинг фрагмента выше); сервер это имя всё равно не
 * увидит — фрагмент на сервер не уходит.
 */
function buildShareLink() {
  const namePart = initialRoomName ? `&n=${encodeURIComponent(initialRoomName)}` : '';
  return `${location.origin}${location.pathname}#k=${roomKeyBase64url}${namePart}`;
}

/**
 * Отрисовать QR ЛОКАЛЬНО в браузере (см. static/vendor/qrcode.js —
 * kazuhikoarase/qrcode-generator, MIT) вместо похода на сервер: ссылка
 * комнаты несёт секретный ключ (#k) и не должна покидать вкладку ради
 * картинки. `qrcode(0, 'M')` — typeNumber=0 значит авто-подбор версии QR под
 * длину текста, 'M' — стандартный уровень коррекции ошибок. createSvgTag
 * строит SVG из чистых числовых координат (сам текст ссылки в разметку не
 * попадает как HTML) — безопасно вставлять через innerHTML.
 */
function renderShareQr(text) {
  sharePopupQrEl.textContent = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    sharePopupQrEl.innerHTML = qr.createSvgTag(4, 12);
  } catch (err) {
    console.error('Не удалось построить QR-код комнаты:', err);
  }
}

function openSharePopup() {
  const link = buildShareLink();
  renderShareQr(link);
  sharePopupLinkEl.textContent = link;
  renderShareBuildLine(); // не блокирует открытие — если хэш ещё не подтянулся, fetchBuildHashOnce().then() выше обновит строку сам, когда придёт
  sharePopupEl.classList.remove('hidden');
  document.addEventListener('keydown', onSharePopupKeydown);
}

function closeSharePopup() {
  sharePopupEl.classList.add('hidden');
  document.removeEventListener('keydown', onSharePopupKeydown);
}

shareButton.addEventListener('click', openSharePopup);
inviteCtaButtonEl.addEventListener('click', openSharePopup);
sharePopupCloseEl.addEventListener('click', closeSharePopup);
sharePopupBackdropEl.addEventListener('click', closeSharePopup);

sharePopupCopyButtonEl.addEventListener('click', async () => {
  const success = await copyTextToClipboard(buildShareLink());
  if (success) {
    const original = sharePopupCopyButtonEl.textContent;
    sharePopupCopyButtonEl.textContent = 'Copied';
    setTimeout(() => {
      sharePopupCopyButtonEl.textContent = original;
    }, 1500);
  }
});

// ---------- Покинуть комнату ----------

// Вкладка закрывается/уходит со страницы (крестик, навигация, reload) — WS
// оборвётся сам собой через мгновение, но это НЕ обрыв сигналинга, который
// нужно чинить: страница всё равно исчезает, реконнект-цикл (даже одна его
// успевшая стартовать попытка) в этот момент только продлил бы жизнь
// комнаты на сервере лишним повторным join-room от умирающей вкладки.
// `pagehide` срабатывает раньше фактического разрыва соединения при
// закрытии/навигации/reload — успеваем взвести флаг до onClose.
window.addEventListener('pagehide', () => {
  intentionalDisconnect = true;
});

leaveButton.addEventListener('click', () => {
  // Намеренный выход — закрытие сокета, которое за этим последует, НЕ должно
  // триггерить авто-reconnect (см. signaling.onClose в init()).
  intentionalDisconnect = true;
  if (signaling) {
    signaling.send('leave');
  }
  location.href = '/';
});

init();
