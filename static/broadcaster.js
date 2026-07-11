// broadcaster.js — логика страницы вещающего.
//
// Состояния: idle (исходное) -> live (трансляция идёт) -> обратно в idle при остановке.
// WebRTC-соединения строятся через rtc.js (perfect negotiation, см. static/rtc.js):
// по каждому peer-joined создаётся обёртка RtcPeer (роль broadcaster — impolite),
// треки добавляются сразу — это триггерит onnegotiationneeded и первый offer
// уходит конкретному зрителю сам, без явного createOffer.

'use strict';

// --- DOM ---
const startButton = document.getElementById('start-button');
const stopButton = document.getElementById('stop-button');
const liveSection = document.getElementById('live-section');
const previewVideo = document.getElementById('preview-video');
const roomLinkInput = document.getElementById('room-link-input');
const copyButton = document.getElementById('copy-button');
const viewerCountEl = document.getElementById('viewer-count');
const micIndicatorEl = document.getElementById('mic-indicator');
const statusMessageEl = document.getElementById('status-message');

// --- Состояние ---
let state = 'idle'; // 'idle' | 'live'
let localStream = null;
let signaling = null;
let iceServersConfig = [FALLBACK_ICE_SERVERS[0]];
// peerId -> RtcPeer
const peers = new Map();
// peerId -> <audio> с входящим микрофоном этого зрителя (см. handleIncomingTrack).
const micAudioEls = new Map();
let chat = null;

function showStatus(text, isError = false) {
  statusMessageEl.textContent = text;
  statusMessageEl.classList.toggle('error', isError);
}

function clearStatus() {
  statusMessageEl.textContent = '';
  statusMessageEl.classList.remove('error');
}

// --- Запуск трансляции ---

startButton.addEventListener('click', startBroadcast);

async function startBroadcast() {
  startButton.disabled = true;
  clearStatus();

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    // Пользователь отменил диалог выбора источника (или доступ отклонён) —
    // возвращаем UI в исходное состояние, комнату не создаём, сокет не открываем.
    console.warn('getDisplayMedia отменён/отклонён:', err);
    showStatus('Выбор источника экрана отменён.');
    startButton.disabled = false;
    return;
  }

  localStream = stream;
  previewVideo.srcObject = localStream;

  // Остановка шеринга средствами браузера (крестик в системной плашке) =
  // полноценная остановка трансляции.
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      console.log('Видеотрек завершён браузером — останавливаем трансляцию');
      stopBroadcast();
    };
  }

  iceServersConfig = await fetchIceServers();

  signaling = new Signaling();
  signaling.onError = (event) => {
    console.error('Ошибка сигналинга:', event);
  };
  signaling.onClose = () => {
    if (state === 'live') {
      showStatus('Соединение с сервером сигналинга потеряно.', true);
      stopBroadcast({ notifyServer: false });
    }
  };

  try {
    await signaling.connect();
  } catch (err) {
    showStatus('Не удалось подключиться к серверу сигналинга.', true);
    stopLocalStreamOnly();
    startButton.disabled = false;
    return;
  }

  registerSignalingHandlers();
  const savedName = ChatPanel.getSavedName();
  signaling.send('create-room', savedName ? { name: savedName } : {});
}

function registerSignalingHandlers() {
  signaling.on('room-created', ({ roomId, peerId }) => {
    const link = `${location.origin}/room/${roomId}`;
    roomLinkInput.value = link;
    state = 'live';
    startButton.classList.add('hidden');
    liveSection.classList.remove('hidden');
    stopButton.disabled = false;
    updateViewerCount();
    clearStatus();
    console.log('Комната создана:', roomId, 'peerId:', peerId);
    chat = ChatPanel.create({ signaling, peerId, variant: 'broadcaster' });
  });

  signaling.on('peer-joined', ({ peerId }) => {
    console.log('Новый зритель подключился:', peerId);
    const peer = createPeerConnection(peerId);
    peers.set(peerId, peer);
    updateViewerCount();

    // Добавление треков триггерит onnegotiationneeded внутри RtcPeer — offer
    // зрителю уйдёт сам, явный createOffer больше не нужен.
    for (const track of localStream.getTracks()) {
      peer.pc.addTrack(track, localStream);
    }
  });

  signaling.on('answer', async ({ fromPeerId, sdp }) => {
    const peer = peers.get(fromPeerId);
    if (!peer) {
      console.warn('answer от неизвестного пира:', fromPeerId);
      return;
    }
    await peer.handleDescription(sdp);
  });

  // Оффер от зрителя — раньше зрители офферов не слали, теперь появление
  // микрофона у зрителя триггерит его onnegotiationneeded (см. viewer.js:
  // pc.addTrack при первом включении микрофона).
  signaling.on('offer', async ({ fromPeerId, sdp }) => {
    const peer = peers.get(fromPeerId);
    if (!peer) {
      console.warn('offer от неизвестного пира:', fromPeerId);
      return;
    }
    await peer.handleDescription(sdp);
  });

  signaling.on('ice-candidate', async ({ fromPeerId, candidate }) => {
    const peer = peers.get(fromPeerId);
    if (!peer) return;
    await peer.handleCandidate(candidate);
  });

  signaling.on('peer-left', ({ peerId }) => {
    console.log('Зритель отключился:', peerId);
    removePeer(peerId);
    updateViewerCount();
  });

  signaling.on('error', ({ message }) => {
    console.error('Сервер сигналинга сообщил об ошибке:', message);
  });
}

function createPeerConnection(peerId) {
  // Broadcaster — impolite: единственный источник треков, в коллизиях
  // офферов его версия побеждает (см. static/rtc.js).
  return new RtcPeer({
    iceServers: iceServersConfig,
    polite: false,
    signaling,
    targetPeerId: peerId,
    onTrack: (event) => handleIncomingTrack(peerId, event),
    onStateChange: (connectionState) => {
      if (connectionState === 'failed') {
        removePeer(peerId);
        updateViewerCount();
      }
    },
  });
}

// Микрофон зрителя приходит как входящий аудиотрек на его RtcPeer. На peerId
// заводим один скрытый <audio autoplay> и проигрываем в него.
//
// Индикатор «микрофонов: M» — это НЕ «кто сейчас говорит»: честно определить
// активность звука без анализа аудиоданных нельзя. У зрителя track.enabled =
// false (выключение микрофона кнопкой) не останавливает трек — на приёмнике
// он остаётся live, просто отдаёт тишину. Поэтому M здесь — количество живых
// входящих аудиотреков (уменьшается только когда трек реально ended, т.е.
// зритель отключился или его peer-connection закрылся).
function handleIncomingTrack(peerId, event) {
  const track = event.track;
  if (track.kind !== 'audio') return;

  let audioEl = micAudioEls.get(peerId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.dataset.peerId = peerId;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    micAudioEls.set(peerId, audioEl);
  }

  const stream = event.streams[0] || new MediaStream([track]);
  if (audioEl.srcObject !== stream) {
    audioEl.srcObject = stream;
    const playPromise = audioEl.play();
    if (playPromise) {
      playPromise.catch((err) => console.warn(`Не удалось запустить аудио зрителя ${peerId}:`, err));
    }
  }

  track.onended = () => {
    removeMicAudio(peerId);
    updateViewerCount();
  };

  updateViewerCount();
}

function removeMicAudio(peerId) {
  const audioEl = micAudioEls.get(peerId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    micAudioEls.delete(peerId);
  }
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.close();
    peers.delete(peerId);
  }
  removeMicAudio(peerId);
}

function updateViewerCount() {
  viewerCountEl.textContent = String(peers.size);

  const micCount = micAudioEls.size;
  if (micCount > 0) {
    micIndicatorEl.textContent = ` · микрофонов: ${micCount}`;
    micIndicatorEl.classList.remove('hidden');
  } else {
    micIndicatorEl.textContent = '';
    micIndicatorEl.classList.add('hidden');
  }
}

// --- Остановка трансляции ---

stopButton.addEventListener('click', () => stopBroadcast());

function stopBroadcast(options = {}) {
  const { notifyServer = true } = options;

  for (const peerId of Array.from(peers.keys())) {
    removePeer(peerId);
  }

  if (chat) {
    chat.disableInput('Трансляция завершена.');
  }

  stopLocalStreamOnly();

  if (signaling) {
    if (notifyServer) {
      signaling.send('leave');
    }
    signaling.close();
    signaling = null;
  }

  resetUi();
  state = 'idle';
}

function stopLocalStreamOnly() {
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    localStream = null;
  }
  previewVideo.srcObject = null;
}

function resetUi() {
  startButton.classList.remove('hidden');
  startButton.disabled = false;
  liveSection.classList.add('hidden');
  roomLinkInput.value = '';
  viewerCountEl.textContent = '0';
  micIndicatorEl.textContent = '';
  micIndicatorEl.classList.add('hidden');
  copyButton.textContent = 'Скопировать';
  copyButton.classList.remove('copied');
}

// --- Копирование ссылки ---

copyButton.addEventListener('click', async () => {
  const text = roomLinkInput.value;
  if (!text) return;

  let success = false;
  try {
    await navigator.clipboard.writeText(text);
    success = true;
  } catch (err) {
    // Фоллбэк для окружений без Clipboard API / без разрешения.
    try {
      roomLinkInput.focus();
      roomLinkInput.select();
      roomLinkInput.setSelectionRange(0, text.length);
      success = document.execCommand('copy');
    } catch (execErr) {
      console.error('Не удалось скопировать ссылку:', execErr);
    }
  }

  if (success) {
    copyButton.textContent = 'Скопировано';
    copyButton.classList.add('copied');
    setTimeout(() => {
      copyButton.textContent = 'Скопировать';
      copyButton.classList.remove('copied');
    }, 1500);
  }
});
