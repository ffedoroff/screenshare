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

// --- DOM ---
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

// --- Общее состояние комнаты/сигналинга ---
let signaling = null;
let myPeerId = null;
let myName = null;
let joinedOnce = false;
// Как только показан «финальный» оверлей (ошибка/обрыв), больше не
// перетираем его сообщениями о попутных проблемах.
let terminalState = false;

// peerId -> { rtc: RtcPeer, name, tile: {root, videoEl, placeholderEl, labelEl} }
const peers = new Map();
// peerId -> имя (включая себя не храним — своё имя в myName).
const peerNames = new Map();
// Свой тайл (создаётся сразу после joined).
let ownTile = null;

// --- Локальные медиа ---
let micStream = null;
let micTrack = null;
let micRequestInProgress = false;

let camStream = null;
let camTrack = null;
let camRequestInProgress = false;

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

let chat = null;

// ---------- Оверлей ----------

function showOverlay({ title, text = '', spinner = false, actionLabel = null }) {
  overlayEl.classList.remove('hidden');
  overlayTitleEl.textContent = title;
  overlayTextEl.textContent = text;
  overlaySpinnerEl.classList.toggle('hidden', !spinner);
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
  location.href = '/';
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

  tile.appendChild(video);
  tile.appendChild(placeholder);
  tile.appendChild(label);

  if (isOwn) {
    tilesGridEl.prepend(tile);
  } else {
    tilesGridEl.appendChild(tile);
  }

  return { root: tile, videoEl: video, placeholderEl: placeholder, labelEl: label };
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

// ---------- Локальные потоки: рассылка новым и уже существующим пирам ----------

/** Добавить трек(и) `stream` во все существующие PeerConnection и разослать stream-info. */
function broadcastLocalStream(stream, kind) {
  const info = { [stream.id]: { kind, name: myName || null, enabled: true } };
  for (const [peerId, entry] of peers) {
    for (const track of stream.getTracks()) {
      entry.rtc.pc.addTrack(track, stream);
    }
    signaling.send('stream-info', { targetPeerId: peerId, info });
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
    signaling.send('stream-info', { targetPeerId: peerId, info });
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

/** Сообщить конкретному (обычно только что появившемуся) пиру обо всех своих активных потоках. */
function sendAllActiveStreamInfoTo(peerId) {
  const info = {};
  if (micStream) info[micStream.id] = { kind: 'mic', name: myName || null, enabled: micTrack ? micTrack.enabled : true };
  if (camStream) info[camStream.id] = { kind: 'camera', name: myName || null, enabled: camTrack ? camTrack.enabled : true };
  if (screenStream) info[screenStream.id] = { kind: 'screen', name: myName || null, enabled: true };
  if (Object.keys(info).length > 0) {
    signaling.send('stream-info', { targetPeerId: peerId, info });
  }
}

// ---------- Входящие треки: маршрутизация по stream-info ----------

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
    attachMicAudio(peerId, stream, track);
  } else if (meta.kind === 'camera') {
    cameraStreamOwner.set(streamId, peerId);
    attachCameraVideo(peerId, stream, track, meta.enabled !== false);
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
  showTileVideo(peerId, enabled);
}

// ---------- Пиры: создание/удаление ----------

function createRemotePeer(peerId, name, iceServers) {
  const rtc = new RtcPeer({
    iceServers,
    polite: myPeerId > peerId,
    signaling,
    targetPeerId: peerId,
    onTrack: (event) => handleRemoteTrack(peerId, event),
    onStateChange: () => {},
  });

  const tile = createTile(peerId, name, false);
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
  cleanupMicAudio(peerId);
  for (const [streamId, ownerPeerId] of cameraStreamOwner) {
    if (ownerPeerId === peerId) cameraStreamOwner.delete(streamId);
  }

  if (currentScreenOwnerPeerId === peerId) {
    currentScreenOwnerPeerId = null;
    hideScreenStage();
    updateScreenButtonState();
  }
}

// ---------- Сигналинг ----------

async function init() {
  showOverlay({ title: 'Подключение…', spinner: true });

  const iceServers = await fetchIceServers();

  signaling = new Signaling();
  signaling.onError = (event) => {
    console.error('Ошибка сигналинга:', event);
  };
  signaling.onClose = () => {
    if (joinedOnce && !terminalState) {
      terminalState = true;
      showOverlay({
        title: 'Соединение потеряно',
        text: 'Связь с сервером сигналинга прервалась. Обновите страницу.',
      });
      if (chat) chat.disableInput('Соединение потеряно.');
    }
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

  registerSignalingHandlers(iceServers);
  myName = ChatPanel.getSavedName();
  signaling.send('join-room', { roomId, ...(myName ? { name: myName } : {}) });
}

function registerSignalingHandlers(iceServers) {
  signaling.on('joined', ({ peerId, peers: otherPeers, screenOwner }) => {
    joinedOnce = true;
    myPeerId = peerId;
    hideOverlay();

    ownTile = createTile(peerId, myName, true);

    for (const p of otherPeers) {
      peerNames.set(p.peerId, p.name || null);
      createRemotePeer(p.peerId, p.name, iceServers);
    }

    currentScreenOwnerPeerId = screenOwner || null;
    if (currentScreenOwnerPeerId && currentScreenOwnerPeerId !== myPeerId) {
      showRemoteScreenCaption(currentScreenOwnerPeerId);
    }
    updateScreenButtonState();
    updateParticipantCount();

    chat = ChatPanel.create({ signaling, peerId, variant: 'room', toggleButton: chatButton });
  });

  signaling.on('room-not-found', () => {
    terminalState = true;
    showOverlay({
      title: 'Комната не найдена',
      text: 'Ссылка недействительна или комната уже удалена.',
      actionLabel: 'Создать новую',
    });
  });

  signaling.on('room-full', () => {
    terminalState = true;
    showOverlay({
      title: 'Комната заполнена',
      text: 'В этой комнате уже максимум участников (6). Попробуйте позже.',
    });
  });

  signaling.on('peer-joined', ({ peerId, name }) => {
    peerNames.set(peerId, name || null);
    createRemotePeer(peerId, name, iceServers);
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

  signaling.on('stream-info', ({ info }) => {
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
      }
    }
  });

  signaling.on('share-started', ({ peerId }) => {
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
    if (currentScreenOwnerPeerId === peerId) {
      currentScreenOwnerPeerId = null;
    }
    hideScreenStage();
    updateScreenButtonState();
  });

  signaling.on('share-rejected', ({ busyPeerId }) => {
    currentScreenOwnerPeerId = busyPeerId;
    updateScreenButtonState();
    showRoomMessage(`Экран показывает ${peerNames.get(busyPeerId) || 'другой участник'}.`);
    if (pendingShareDecision) {
      pendingShareDecision.resolve(false);
      pendingShareDecision = null;
    }
  });

  signaling.on('error', ({ message }) => {
    console.error('Сервер сигналинга сообщил об ошибке:', message);
  });
}

// ---------- Микрофон ----------

function setMicButtonOn(on) {
  micButton.classList.toggle('control-button--on', on);
  micButton.setAttribute('aria-pressed', String(on));
}

micButton.addEventListener('click', async () => {
  if (micRequestInProgress) return;

  if (!micTrack) {
    micRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Доступ к микрофону отклонён:', err);
      showRoomMessage('Не удалось получить доступ к микрофону.');
      micRequestInProgress = false;
      return;
    }
    micRequestInProgress = false;

    micStream = stream;
    micTrack = stream.getAudioTracks()[0];
    broadcastLocalStream(stream, 'mic');
    setMicButtonOn(true);
  } else {
    micTrack.enabled = !micTrack.enabled;
    setMicButtonOn(micTrack.enabled);
  }
});

// ---------- Камера ----------

function setCameraButtonOn(on) {
  cameraButton.classList.toggle('control-button--on', on);
  cameraButton.setAttribute('aria-pressed', String(on));
}

cameraButton.addEventListener('click', async () => {
  if (camRequestInProgress) return;

  if (!camTrack) {
    camRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15 },
          facingMode: 'user', // на телефоне — фронтальная камера по умолчанию
        },
      });
    } catch (err) {
      console.warn('Доступ к камере отклонён:', err);
      showRoomMessage('Не удалось получить доступ к камере.');
      camRequestInProgress = false;
      return;
    }
    camRequestInProgress = false;

    camStream = stream;
    camTrack = stream.getVideoTracks()[0];
    broadcastLocalStream(stream, 'camera');

    if (ownTile) {
      ownTile.videoEl.srcObject = stream;
      safePlay(ownTile.videoEl);
      ownTile.videoEl.classList.remove('hidden');
      ownTile.placeholderEl.classList.add('hidden');
    }
    setCameraButtonOn(true);
  } else {
    camTrack.enabled = !camTrack.enabled;
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

function stopScreenShare() {
  if (!screenStream) return;
  removeLocalStreamFromAllPeers(screenStream);
  for (const track of screenStream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  screenStream = null;
  signaling.send('share-stop');
  hideScreenStage();
  currentScreenOwnerPeerId = null;
  updateScreenButtonState();
}

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

function openSharePopup() {
  const link = location.href;
  // QR — серверный SVG (см. GET /qr.svg?room=<id> в src/main.rs), кодирует ту
  // же короткую ссылку /r/<roomId>.
  sharePopupQrEl.src = `/qr.svg?room=${encodeURIComponent(roomId)}`;
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
  const success = await copyTextToClipboard(location.href);
  if (success) {
    const original = sharePopupCopyButtonEl.textContent;
    sharePopupCopyButtonEl.textContent = 'Скопировано';
    setTimeout(() => {
      sharePopupCopyButtonEl.textContent = original;
    }, 1500);
  }
});

// ---------- Покинуть комнату ----------

leaveButton.addEventListener('click', () => {
  if (signaling) {
    signaling.send('leave');
  }
  location.href = '/';
});

init();
