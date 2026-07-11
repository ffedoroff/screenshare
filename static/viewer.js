// viewer.js — логика страницы зрителя.
//
// roomId берём из URL (последний сегмент pathname). Дальше: join-room -> ждём
// offer от broadcaster'а -> отвечаем answer -> обмен ICE -> показываем поток.
// WebRTC-соединение строится через rtc.js (perfect negotiation, см. static/rtc.js):
// viewer — polite-пир. Он сейчас не добавляет треков и не шлёт offer сам
// (onnegotiationneeded у него не сработает), но обёртка одинакова для обеих
// сторон — это подготовка к будущей ренегоциации (например, микрофон зрителя).

'use strict';

// --- DOM ---
const remoteVideo = document.getElementById('remote-video');
const overlay = document.getElementById('overlay');
const overlaySpinner = document.getElementById('overlay-spinner');
const overlayTitle = document.getElementById('overlay-title');
const overlayText = document.getElementById('overlay-text');
const playButton = document.getElementById('play-button');

// roomId — последний сегмент пути, например /room/abc123 -> "abc123".
const roomId = location.pathname.split('/').filter(Boolean).pop();

// --- Состояние ---
let signaling = null;
let peer = null; // RtcPeer
let broadcasterId = null;
let chat = null;
// Как только показан «финальный» оверлей (ошибка/завершение), больше не
// перетираем его сообщениями о попутных обрывах соединения.
let terminalState = false;

function showOverlay({ title, text = '', spinner = false, showPlayButton = false }) {
  overlay.classList.remove('hidden');
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlaySpinner.classList.toggle('hidden', !spinner);
  playButton.classList.toggle('hidden', !showPlayButton);
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

async function init() {
  showOverlay({ title: 'Подключение…', spinner: true });

  const iceServers = await fetchIceServers();

  signaling = new Signaling();
  signaling.onError = (event) => {
    console.error('Ошибка сигналинга:', event);
  };
  signaling.onClose = () => {
    if (!terminalState) {
      terminalState = true;
      showOverlay({
        title: 'Соединение потеряно',
        text: 'Связь с сервером сигналинга прервалась. Обновите страницу.',
      });
      if (chat) {
        chat.disableInput('Соединение потеряно.');
      }
      cleanupPeer();
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
  const savedName = ChatPanel.getSavedName();
  signaling.send('join-room', {
    roomId,
    role: 'viewer',
    ...(savedName ? { name: savedName } : {}),
  });
}

function registerSignalingHandlers(iceServers) {
  signaling.on('joined', ({ broadcasterId: bId, peerId }) => {
    broadcasterId = bId;
    showOverlay({ title: 'Ожидание вещающего…', spinner: true, text: 'Трансляция вот-вот начнётся.' });
    peer = createPeerConnection(iceServers, bId);
    console.log('Успешно присоединились к комнате, broadcasterId:', bId);
    chat = ChatPanel.create({ signaling, peerId, variant: 'viewer' });
  });

  signaling.on('room-not-found', () => {
    terminalState = true;
    showOverlay({
      title: 'Трансляция не найдена',
      text: 'Ссылка недействительна или трансляция уже завершена.',
    });
    cleanupAll();
  });

  signaling.on('room-full', () => {
    terminalState = true;
    showOverlay({
      title: 'Комната заполнена',
      text: 'В этой комнате уже максимум зрителей (5). Попробуйте позже.',
    });
    cleanupAll();
  });

  signaling.on('offer', async ({ fromPeerId, sdp }) => {
    if (!peer) {
      console.warn('offer получен раньше, чем создан RTCPeerConnection — игнорируем');
      return;
    }
    await peer.handleDescription(sdp);
  });

  signaling.on('ice-candidate', async ({ candidate }) => {
    if (!peer) return;
    await peer.handleCandidate(candidate);
  });

  signaling.on('broadcaster-left', () => {
    terminalState = true;
    showOverlay({ title: 'Трансляция завершена', text: 'Вещающий закончил трансляцию.' });
    if (chat) {
      chat.disableInput('Вещающий закончил трансляцию.');
    }
    cleanupAll();
  });

  signaling.on('error', ({ message }) => {
    console.error('Сервер сигналинга сообщил об ошибке:', message);
  });
}

function createPeerConnection(iceServers, broadcasterPeerId) {
  // Viewer — polite: сейчас треков не добавляет и offer не шлёт (см. rtc.js),
  // но при коллизии офферов в будущем должен уступать broadcaster'у.
  return new RtcPeer({
    iceServers,
    polite: true,
    signaling,
    targetPeerId: broadcasterPeerId,
    onTrack: (event) => {
      hideOverlay();
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      }
      attemptPlay();
    },
    onStateChange: (connectionState) => {
      if (connectionState === 'failed' && !terminalState) {
        showOverlay({
          title: 'Соединение потеряно',
          text: 'Не удалось установить соединение с вещающим.',
        });
      }
    },
  });
}

// Политика автовоспроизведения: если браузер отклонил play() без явного
// пользовательского жеста — просим нажать кнопку.
function attemptPlay() {
  const playPromise = remoteVideo.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      console.warn('Автовоспроизведение отклонено браузером:', err);
      showOverlay({
        title: 'Видео готово к просмотру',
        text: 'Браузер заблокировал автовоспроизведение.',
        showPlayButton: true,
      });
    });
  }
}

playButton.addEventListener('click', () => {
  hideOverlay();
  remoteVideo.play().catch((err) => {
    console.error('Не удалось запустить воспроизведение по клику:', err);
  });
});

function cleanupPeer() {
  if (peer) {
    peer.close();
    peer = null;
  }
}

function cleanupAll() {
  cleanupPeer();
  if (signaling) {
    signaling.close();
    signaling = null;
  }
}

init();
