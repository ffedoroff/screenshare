// broadcaster.js — логика страницы вещающего.
//
// Состояния: idle (исходное) -> live (трансляция идёт) -> обратно в idle при остановке.
// Инициатор WebRTC-оффера — всегда broadcaster: по каждому peer-joined создаётся
// новый RTCPeerConnection, треки добавляются, createOffer уходит конкретному зрителю.

'use strict';

// --- DOM ---
const startButton = document.getElementById('start-button');
const stopButton = document.getElementById('stop-button');
const liveSection = document.getElementById('live-section');
const previewVideo = document.getElementById('preview-video');
const roomLinkInput = document.getElementById('room-link-input');
const copyButton = document.getElementById('copy-button');
const viewerCountEl = document.getElementById('viewer-count');
const statusMessageEl = document.getElementById('status-message');

// --- Состояние ---
let state = 'idle'; // 'idle' | 'live'
let localStream = null;
let signaling = null;
let iceServersConfig = [FALLBACK_ICE_SERVERS[0]];
// peerId -> { pc, remoteSet, candidateQueue }
const peers = new Map();
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

  signaling.on('peer-joined', async ({ peerId }) => {
    console.log('Новый зритель подключился:', peerId);
    const peerState = createPeerConnection(peerId);
    peers.set(peerId, peerState);
    updateViewerCount();

    try {
      const offer = await peerState.pc.createOffer();
      await peerState.pc.setLocalDescription(offer);
      signaling.send('offer', { targetPeerId: peerId, sdp: peerState.pc.localDescription });
    } catch (err) {
      console.error('Не удалось создать/отправить offer для', peerId, err);
    }
  });

  signaling.on('answer', async ({ fromPeerId, sdp }) => {
    const peerState = peers.get(fromPeerId);
    if (!peerState) {
      console.warn('answer от неизвестного пира:', fromPeerId);
      return;
    }
    try {
      await peerState.pc.setRemoteDescription(sdp);
      peerState.remoteSet = true;
      flushCandidateQueue(peerState);
    } catch (err) {
      console.error('Ошибка setRemoteDescription (answer) для', fromPeerId, err);
    }
  });

  signaling.on('ice-candidate', async ({ fromPeerId, candidate }) => {
    const peerState = peers.get(fromPeerId);
    if (!peerState) return;
    if (peerState.remoteSet) {
      try {
        await peerState.pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('Ошибка addIceCandidate для', fromPeerId, err);
      }
    } else {
      // remoteDescription ещё не установлен — копим кандидатов в очередь.
      peerState.candidateQueue.push(candidate);
    }
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
  const pc = new RTCPeerConnection({ iceServers: iceServersConfig });

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signaling.send('ice-candidate', {
        targetPeerId: peerId,
        candidate: event.candidate.toJSON(),
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[peer ${peerId}] connectionState -> ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      removePeer(peerId);
      updateViewerCount();
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[peer ${peerId}] iceConnectionState -> ${pc.iceConnectionState}`);
  };

  return { pc, remoteSet: false, candidateQueue: [] };
}

function flushCandidateQueue(peerState) {
  const queue = peerState.candidateQueue;
  peerState.candidateQueue = [];
  for (const candidate of queue) {
    peerState.pc.addIceCandidate(candidate).catch((err) => {
      console.error('Ошибка addIceCandidate (из очереди):', err);
    });
  }
}

function removePeer(peerId) {
  const peerState = peers.get(peerId);
  if (peerState) {
    peerState.pc.close();
    peers.delete(peerId);
  }
}

function updateViewerCount() {
  viewerCountEl.textContent = String(peers.size);
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
