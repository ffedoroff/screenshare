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
// POST /api/rooms -> редирект на /r/<id>#lt=<token>&k=<key>) читается ДО ВСЕГО
// остального. Из адресной строки вычищается ТОЛЬКО одноразовый #lt (после
// первого join он сожжён сервером и бесполезен, светить его незачем).
//
// Ключ комнаты #k СОЗНАТЕЛЬНО ОСТАЁТСЯ в адресной строке: ссылка = ключ по
// самой модели (ей и делятся), а сохранение k в URL позволяет пережить F5 —
// иначе перезагрузка выбрасывала бы из комнаты («ссылка неполная»), при том
// что хранить ключ в storage запрещено (полная анонимность). Тот же паттерн
// у Excalidraw. Фрагмент никогда не уходит на сервер сам по себе.
//
// Ключ комнаты (Ш1, E2E-шифрование, см. static/crypto.js): `k` парсится ЗДЕСЬ
// ЖЕ — до того, как страница успела показать что-либо, и до какого-либо
// обращения к сигналингу; от него позже выводятся sigKey/metaKey/chatKey
// (см. deriveRoomKeys).
const { initialLeaderToken, roomKeyBase64url } = (() => {
  const hash = location.hash;
  const ltMatch = hash.match(/(?:^|[&#])lt=([^&]+)/);
  const kMatch = hash.match(/(?:^|[&#])k=([^&]+)/);
  const lt = ltMatch ? decodeURIComponent(ltMatch[1]) : null;
  // `k` — base64url, состоит только из URL-safe символов (A-Za-z0-9-_) —
  // decodeURIComponent не нужен (и вреден не был бы, но не нужен).
  const k = kMatch ? kMatch[1] : null;
  if (lt) {
    // Пересобираем фрагмент без lt, сохраняя k.
    history.replaceState(null, '', location.pathname + location.search + (k ? `#k=${k}` : ''));
  }
  return { initialLeaderToken: lt, roomKeyBase64url: k };
})();

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
const screenStageEl = document.getElementById('screen-stage');
const screenVideoEl = document.getElementById('screen-video');
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
const sharePopupCopyButtonEl = document.getElementById('share-popup-copy-button');
const reconnectBannerEl = document.getElementById('reconnect-banner');
const versionBannerEl = document.getElementById('version-banner');
const versionBannerReloadButtonEl = document.getElementById('version-banner-reload-button');

// --- DOM: права и лидер (см. README.md, «Права и лидер») ---
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
const settingsFallbackCountEl = document.getElementById('settings-fallback-count');

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
let chatKey = null; // K_chat — fallback-конверт чата через сервер
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

// --- Авто-reconnect сигналинга (переживает деплой/рестарт сервера) ---
//
// Ключевая идея: обрыв WS-сигналинга сам по себе НЕ должен рушить mesh
// (медиа/DataChannel-чат) — они физически не зависят от сигналинга и живут,
// пока живо само P2P-соединение (см. README.md, раздел про живучесть звонка
// при деплое). Поэтому неожиданный обрыв (не «Покинуть», не room-not-found/
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
// version-skew баннера, см. README.md).
let lastKnownVersion = null;

// peerId -> { rtc: RtcPeer, name, tile: {root, videoEl, placeholderEl, labelEl, crownEl} }
const peers = new Map();
// peerId -> имя (включая себя не храним — своё имя в myName).
const peerNames = new Map();
// Свой тайл (создаётся сразу после joined).
let ownTile = null;

// --- Права и лидер (см. README.md, «Права и лидер») ---
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
// анонимность, см. README.md) и переживает выключение/включение мика или
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
 * Вывести sigKey/metaKey/chatKey из roomKeyBase64url (см. верх файла).
 * Возвращает false при ЛЮБОЙ проблеме: `k` отсутствует в ссылке, не
 * декодируется как base64url, декодируется не в 32 байта, либо сам
 * HKDF/AES-GCM отказался (WebCrypto недоступен и т.п.) — вызывающая сторона
 * (см. init ниже) трактует false как «ссылка неполная».
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
    chatKey = keys.chat;
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
    title: 'Ссылка неполная',
    text: 'Попросите новую ссылку у участника комнаты.',
    actionLabel: 'На главную',
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

/** Ненавязчивый тост (смена лидера и т.п., см. README.md «Права и лидер») — отдельно от showRoomMessage (та зарезервирована под предупреждения/ошибки). */
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
    const res = await fetch('/version.json');
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

  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';
  const hue = hueFromPeerId(peerId);
  placeholder.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 45) % 360}, 70%, 32%))`;
  const letter = document.createElement('span');
  letter.className = 'tile-placeholder-letter';
  const trimmedName = (name || '').trim();
  letter.textContent = trimmedName ? trimmedName.charAt(0).toUpperCase() : '?';
  placeholder.appendChild(letter);

  const label = document.createElement('div');
  label.className = 'tile-name';
  label.textContent = isOwn ? `Вы${trimmedName ? ` (${trimmedName})` : ''}` : (trimmedName || 'Гость');

  // Корона лидера (см. README.md «Права и лидер») — скрыта по умолчанию,
  // показывается/прячется через setLeaderIndicator() при смене leaderId.
  const crown = document.createElement('span');
  crown.className = 'tile-crown hidden';
  crown.setAttribute('aria-hidden', 'true');
  crown.innerHTML = CROWN_ICON_SVG; // статичная разметка, не пользовательские данные

  // Индикатор «микрофон выключен/отсутствует» (см. static/style.css:
  // .tile-mic-off) — виден ПО УМОЛЧАНИЮ (не .hidden): до первого
  // включения/stream-info трека у этого участника действительно ещё нет,
  // что по заданию тоже показывает значок (см. setTileMicOff/applyMicEnabledUpdate).
  const micOff = document.createElement('span');
  micOff.className = 'tile-mic-off';
  micOff.setAttribute('aria-hidden', 'true');
  micOff.innerHTML = MIC_OFF_ICON_SVG; // статичная разметка, не пользовательские данные

  tile.appendChild(video);
  tile.appendChild(placeholder);
  tile.appendChild(label);
  tile.appendChild(crown);
  tile.appendChild(micOff);

  if (isOwn) {
    tilesGridEl.prepend(tile);
  } else {
    tilesGridEl.appendChild(tile);
  }

  return { root: tile, videoEl: video, placeholderEl: placeholder, labelEl: label, crownEl: crown, micOffEl: micOff };
}

/** Показать/скрыть значок «микрофон выключен» на конкретном объекте тайла (свой ownTile или peers.get(id).tile). */
function setTileMicOffIndicator(tile, micOff) {
  if (!tile) return;
  tile.micOffEl.classList.toggle('hidden', !micOff);
}

function updateParticipantCount() {
  const total = 1 + peers.size;
  participantCountEl.textContent = `Участников: ${total} / 6`;
  updateSoloState();
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

/** «Вы (имя)» + « (лидер)», если лидер — сам. Пересчитывается при любой смене leaderId. */
function updateOwnTileLabel() {
  if (!ownTile) return;
  const trimmedName = (myName || '').trim();
  let text = `Вы${trimmedName ? ` (${trimmedName})` : ''}`;
  if (isLeader) text += ' (лидер)';
  ownTile.labelEl.textContent = text;
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

function showTileVideo(peerId, show) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.tile.videoEl.classList.toggle('hidden', !show);
  entry.tile.placeholderEl.classList.toggle('hidden', show);
}

// ---------- Экран (главная зона) ----------

function updateScreenButtonState() {
  // Права гостей (см. README.md «Права и лидер»): guestScreen=false запрещает
  // гостю (не лидеру) даже пробовать — кнопка задизейблена независимо от
  // текущего состояния владения экраном. Лидера это ограничение не касается.
  if (!isLeader && roomSettings && !roomSettings.guestScreen) {
    screenButton.disabled = true;
    screenButton.title = 'Запрещено лидером';
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
    const name = peerNames.get(currentScreenOwnerPeerId) || 'другой участник';
    screenButton.disabled = true;
    screenButton.title = `Экран показывает ${name}`;
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
  screenCaptionEl.textContent = '';
  updateSoloState();
}

function showLocalScreenPreview() {
  showScreenStageContainer();
  screenVideoEl.srcObject = screenStream;
  screenVideoEl.muted = true; // не отдаём эхо собственного звука вкладки/системы
  safePlay(screenVideoEl);
  screenCaptionEl.textContent = `Экран: Вы${myName ? ` (${myName})` : ''}`;
}

function showRemoteScreenCaption(peerId) {
  showScreenStageContainer();
  screenCaptionEl.textContent = `Экран: ${peerNames.get(peerId) || 'Гость'}`;
}

// ---------- Права гостей: применение на своей стороне (отправитель) ----------
//
// Кооперативная защита (см. README.md «Права и лидер»): применяется на
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
  micButton.title = restrictAudio ? 'Запрещено лидером' : '';
  if (restrictAudio && micTrack && micTrack.enabled) {
    micTrack.enabled = false;
    setMicButtonOn(false);
    updateOwnMicIndicator();
    broadcastStreamEnabled(micStream, 'mic', false);
  }

  cameraButton.disabled = restrictVideo;
  cameraButton.title = restrictVideo ? 'Запрещено лидером' : '';
  if (restrictVideo && camTrack && camTrack.enabled) {
    camTrack.enabled = false;
    setCameraButtonOn(false);
    if (ownTile) {
      ownTile.videoEl.classList.add('hidden');
      ownTile.placeholderEl.classList.remove('hidden');
    }
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
// медиапотоки не видит и не может их запретить технически, см. README.md).

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
  name.textContent = req.name || 'Гость';

  const actions = document.createElement('div');
  actions.className = 'join-request-actions';

  const acceptButton = document.createElement('button');
  acceptButton.type = 'button';
  acceptButton.className = 'join-request-button join-request-button--accept';
  acceptButton.textContent = 'Принять';
  acceptButton.addEventListener('click', () => {
    signaling.send('approve', { peerId: req.peerId });
    removePendingRequest(req.peerId);
  });

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className = 'join-request-button join-request-button--reject';
  rejectButton.textContent = 'Отклонить';
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
  if (connectionSectionTimer) clearInterval(connectionSectionTimer);
  connectionSectionTimer = setInterval(refreshConnectionSection, CONNECTION_SECTION_REFRESH_MS);
  settingsPanelEl.classList.remove('hidden');
}

function closeSettingsPanel() {
  settingsPanelEl.classList.add('hidden');
  if (connectionSectionTimer) {
    clearInterval(connectionSectionTimer);
    connectionSectionTimer = null;
  }
}

// ---------- «Соединение и приватность»: режим по каждому пиру + что видит сервер ----------
//
// Видна ВСЕМ участникам (в отличие от #settings-room-section выше, только
// лидер) — задел задачи «показать, в каком режиме работаем и что уходит на
// сервер». Три части:
//   1) статичная строка шифрования — из RoomCrypto.getCryptoInfo(), НЕ
//      хардкодим текст алгоритма (см. static/crypto.js);
//   2) режим соединения с каждым пиром — P2P/TURN-релей/серверный fallback/
//      устанавливается — см. computePeerConnectionMode ниже;
//   3) статичный список того, что видит сервер, плюс счётчики за сессию
//      (см. static/common.js: ConnStats — инкрементируется в местах реальной
//      отправки через signaling.send в rtc.js/room.js/chat.js).
// Обновляется при открытии шита и раз в CONNECTION_SECTION_REFRESH_MS, пока
// шит открыт — таймер чистится в closeSettingsPanel() выше.

const CONNECTION_SECTION_REFRESH_MS = 5000;
let connectionSectionTimer = null;

const PEER_MODE_LABELS = {
  p2p: 'напрямую (P2P)',
  turn: 'через TURN-релей',
  fallback: 'через сервер (fallback)',
  connecting: 'устанавливается…',
};

/** Отрисовать строку шифрования из getCryptoInfo() — текст алгоритма НЕ хардкодится, кроме шаблона фразы. */
function renderCryptoInfo() {
  const info = RoomCrypto.getCryptoInfo();
  if (!info.active) {
    settingsCryptoRowEl.classList.add('settings-crypto-row--off');
    settingsCryptoTextEl.textContent = 'E2E-шифрование выключено — сервер может видеть содержимое';
    return;
  }
  settingsCryptoRowEl.classList.remove('settings-crypto-row--off');
  settingsCryptoTextEl.textContent =
    `E2E-шифрование: ${info.algorithm} · ключ ${info.keyBits} бит · ${info.kdf}`;
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
 * Режим соединения с одним пиром — приоритет ровно как в задании:
 *  1) есть selected candidate-pair -> 'p2p' (host/srflx/prflx с обеих
 *     сторон) или 'turn' (кто-то из пары — relay);
 *  2) пары ещё нет и DataChannel-шина к пиру не открыта -> 'fallback'
 *     (весь трафик до пира — через серверный релей: signaling.send для
 *     ещё не устаканившегося mesh);
 *  3) иначе (пары нет, но шина каким-то образом уже открыта — гоночный
 *     край, в норме недостижимо) -> 'connecting'.
 */
async function computePeerConnectionMode(peerId, entry) {
  const pc = entry.rtc && entry.rtc.pc;
  if (!pc) return 'connecting';
  try {
    const statsReport = await pc.getStats();
    const pair = findSelectedCandidatePair(statsReport);
    if (pair) return candidatePairMode(pair, statsReport);
  } catch (err) {
    console.warn(`[peer ${peerId}] getStats() для секции настроек не удался:`, err);
  }
  return bus.isOpen(peerId) ? 'connecting' : 'fallback';
}

/** Перерисовать список «Соединения с участниками» — режим у каждого пира считается асинхронно (getStats), поэтому вся отрисовка целиком после Promise.all, без мигания частично готового списка. */
async function renderPeerConnectionsList() {
  const entries = Array.from(peers.entries());
  if (entries.length === 0) {
    settingsPeersListEl.textContent = '';
    const li = document.createElement('li');
    li.className = 'settings-peer-row settings-peer-row--empty';
    li.textContent = 'Пока никого — вы одни в комнате.';
    settingsPeersListEl.appendChild(li);
    return;
  }

  const modes = await Promise.all(
    entries.map(([peerId, entry]) => computePeerConnectionMode(peerId, entry))
  );

  settingsPeersListEl.textContent = '';
  entries.forEach(([peerId], i) => {
    const mode = modes[i];
    const li = document.createElement('li');
    li.className = 'settings-peer-row';

    const dot = document.createElement('span');
    dot.className = `settings-peer-dot settings-peer-dot--${mode}`;
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'settings-peer-label';
    label.textContent = `${peerNames.get(peerId) || 'Гость'} — ${PEER_MODE_LABELS[mode]}`;

    li.appendChild(dot);
    li.appendChild(label);
    settingsPeersListEl.appendChild(li);
  });
}

/** Динамические счётчики «что видит сервер» — см. static/common.js: ConnStats. */
function renderServerCounters() {
  settingsSignalingCountEl.textContent = String(ConnStats.signalingRelayCount);
  settingsFallbackCountEl.textContent = String(ConnStats.fallbackChatCount);
}

function refreshConnectionSection() {
  renderCryptoInfo();
  renderServerCounters();
  renderPeerConnectionsList().catch((err) => {
    console.error('Не удалось обновить список соединений в настройках:', err);
  });
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
    'Микрофон'
  );
  fillDeviceSelect(
    settingCameraDeviceSelect,
    devices.filter((d) => d.kind === 'videoinput'),
    'Камера'
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
    onBusOpen: () => sendAllActiveStreamInfoTo(peerId),
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
  entry.rtc.close();
  entry.tile.root.remove();
  peers.delete(peerId);
  peerNames.delete(peerId);
  peerMediaRefs.delete(peerId);
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
  joinNameInputEl.focus();
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
  // всё равно ничего не заработает (см. README.md «Приватность»,
  // deriveRoomKeys выше). Та же семантика, что и при отказе расшифровки
  // первого входящего сообщения (см. showInvalidLinkOverlay).
  const keysOk = await deriveRoomKeys();
  if (!keysOk) {
    showInvalidLinkOverlay();
    return;
  }

  // Анонимность (см. README.md): имя спрашивается заново при КАЖДОМ заходе
  // этой модалкой — никакого localStorage. join-room уходит только после
  // клика «Войти» (см. onJoinModalSubmit). При авто-reconnect модалка не
  // показывается повторно — имя уже в памяти вкладки (myName), см.
  // attemptReconnectOnce/sendJoinAndWait ниже.
  showJoinModal();
}

async function connectAndJoin() {
  showOverlay({ title: 'Подключение…', spinner: true });

  iceServersCache = await fetchIceServers();
  lastKnownVersion = await fetchVersion();

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
    // DataChannel-чат) при этом жив (см. README.md), поэтому НЕ рушим
    // интерфейс сразу: тонкий баннер + авто-reconnect с бэкоффом, и только
    // если он исчерпает бюджет — терминальный оверлей «Соединение потеряно».
    startReconnectLoop();
  };

  try {
    await signaling.connect();
  } catch (err) {
    terminalState = true;
    showOverlay({
      title: 'Не удалось подключиться',
      text: 'Проверьте соединение с интернетом и обновите страницу.',
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
  signaling.on('joined', async ({ peerId, peers: otherPeers, screenOwner, leaderId: joinedLeaderId, settings, pending }) => {
    // Реконнект ждёт именно этот ответ (см. sendJoinAndWait) — репортуем ему
    // исход в дополнение к обычной обработке ниже (при первом входе
    // pendingJoinResolve никогда не взведён).
    if (pendingJoinResolve) pendingJoinResolve('joined');

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
        chatKey,
      });
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
    // Лидерство при реконнекте может смениться (см. README.md «Права и
    // лидер»: сервер мог уже удалить нас и назначить нового лидера) — pending
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
    // Лобби (см. README.md «Права и лидер»): вместо joined сначала приходит
    // это — ждём решения лидера. «Отменить» = leave + на главную (тот же
    // приём, что и у leaveButton ниже — intentionalDisconnect до leave).
    showOverlay({
      title: 'Ожидание одобрения…',
      text: myName ? `Вы вошли как «${myName}»` : 'Ждём решения лидера комнаты.',
      spinner: true,
      actionLabel: 'Отменить',
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
      title: 'Вход отклонён',
      text: 'Лидер комнаты отклонил вашу заявку на вход.',
      actionLabel: 'На главную',
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
      showToast('Вы стали лидером');
    } else {
      showToast(`Лидер теперь ${peerNames.get(newLeaderId) || 'Гость'}`);
    }
  });

  signaling.on('room-not-found', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-not-found');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Комната не найдена',
      text: 'Ссылка недействительна или комната уже удалена.',
      actionLabel: 'Создать новую',
    });
  });

  signaling.on('room-full', () => {
    if (pendingJoinResolve) {
      pendingJoinResolve('room-full');
      return;
    }
    terminalState = true;
    showOverlay({
      title: 'Комната заполнена',
      text: 'В этой комнате уже максимум участников (6). Попробуйте позже.',
    });
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
    currentScreenOwnerPeerId = peerId;
    if (peerId === myPeerId) {
      showLocalScreenPreview();
    } else {
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
      // переиграть share-start (см. reconcileScreenShareAfterReconnect), но
      // пока мы были офлайн, экран успел занять кто-то другой — корректно
      // останавливаем свой локальный захват (чужая сцена уже живёт по mesh,
      // ломать её не нужно).
      forceStopLocalScreenCapture();
    }
    if (reason === 'forbidden') {
      // Отказ по правам (guestScreen=false, см. README.md «Права и лидер»),
      // а не потому что экран занят — busyPeerId в этом случае не приходит.
      currentScreenOwnerPeerId = null;
      updateScreenButtonState();
      showRoomMessage('Лидер запретил показ экрана.');
    } else {
      currentScreenOwnerPeerId = busyPeerId;
      updateScreenButtonState();
      showRoomMessage(`Экран показывает ${peerNames.get(busyPeerId) || 'другой участник'}.`);
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
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PUT' });
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
  // успешного реконнекта (см. README.md).
  checkVersionSkew();
}

function giveUpReconnect() {
  reconnecting = false;
  hideReconnectBanner();
  terminalState = true;
  showOverlay({
    title: 'Соединение потеряно',
    text: 'Связь с сервером сигналинга прервалась. Обновите страницу.',
  });
  if (chat) chat.disableInput('Соединение потеряно.');
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
 *     share-start; сервер либо подтвердит (share-started), либо, если пока
 *     мы были офлайн, экран успел занять кто-то другой — откажет
 *     (share-rejected), тогда свой захват корректно останавливаем (см.
 *     обработчик share-rejected выше);
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
    showRoomMessage('Не удалось переключить микрофон.');
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
      showRoomMessage('Не удалось получить доступ к микрофону.');
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
    showRoomMessage('Не удалось переключить камеру.');
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
      showRoomMessage('Не удалось получить доступ к камере.');
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
      ownTile.videoEl.classList.remove('hidden');
      ownTile.placeholderEl.classList.add('hidden');
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
    if (ownTile) {
      ownTile.videoEl.classList.toggle('hidden', !camTrack.enabled);
      ownTile.placeholderEl.classList.toggle('hidden', camTrack.enabled);
    }
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
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    console.warn('getDisplayMedia отменён/отклонён:', err);
    signaling.send('share-stop'); // отпускаем захваченный замок
    showRoomMessage('Показ экрана отменён.');
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

/** Остановить локальный захват экрана (треки + отправку пирам), без share-stop серверу и без трогать UI сцены — используется и обычной остановкой (stopScreenShare), и реконнектом (см. обработчик share-rejected в registerSignalingHandlers). */
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
  if (!fn) return Promise.reject(new Error('Fullscreen API недоступен'));
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

function updateFullscreenButtonState() {
  const active = isFullscreenActive();
  screenFullscreenButtonEl.setAttribute('aria-pressed', String(active));
  screenFullscreenButtonEl.title = active ? 'Выйти из полноэкранного режима' : 'На весь экран';
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
 * файла) — НЕ из location.href, потому что тот к этому моменту уже вычищен
 * от фрагмента (см. init/history.replaceState) и leaderToken там в любом
 * случае никогда не было бы (он одноразовый и только для создателя). Вид:
 * `<origin>/r/<id>#k=<key>` — БЕЗ lt.
 */
function buildShareLink() {
  return `${location.origin}${location.pathname}#k=${roomKeyBase64url}`;
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
    sharePopupCopyButtonEl.textContent = 'Скопировано';
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
