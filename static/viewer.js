// viewer.js — логика страницы зрителя.
//
// roomId берём из URL (последний сегмент pathname). Дальше: join-room -> ждём
// offer от broadcaster'а -> отвечаем answer -> обмен ICE -> показываем поток.
// WebRTC-соединение строится через rtc.js (perfect negotiation, см. static/rtc.js):
// viewer — polite-пир. Изначально он треков не добавляет и offer не шлёт, но
// при первом включении микрофона (кнопка «Микрофон») добавляет аудиотрек в
// существующий RtcPeer — это триггерит onnegotiationneeded и viewer сам
// инициирует offer; как polite-пир он уступает broadcaster'у при коллизии.

'use strict';

// --- DOM ---
const remoteVideo = document.getElementById('remote-video');
const overlay = document.getElementById('overlay');
const overlaySpinner = document.getElementById('overlay-spinner');
const overlayTitle = document.getElementById('overlay-title');
const overlayText = document.getElementById('overlay-text');
const playButton = document.getElementById('play-button');
const micButton = document.getElementById('mic-button');
const micMessageEl = document.getElementById('mic-message');

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

// --- Микрофон зрителя ---
// micStream/micTrack — не null только после успешного getUserMedia. Трек не
// удаляем из PeerConnection при выключении — просто track.enabled = false,
// чтобы не плодить лишние ренегоциации (см. addTrack ниже — ренегоциация
// нужна только один раз, при первом включении).
let micStream = null;
let micTrack = null;
let micRequestInProgress = false;
let micMessageTimer = null;

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

  // Ответ broadcaster'а на ренегоциацию, которую инициировал сам viewer
  // (добавление трека микрофона триггерит onnegotiationneeded -> offer от
  // viewer'а -> вот этот answer в ответ). До появления микрофона у viewer'а
  // не было своих офферов, поэтому этот обработчик раньше не требовался.
  signaling.on('answer', async ({ sdp }) => {
    if (!peer) return;
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
      // Кнопка микрофона видна только после успешного подключения к трансляции.
      micButton.classList.remove('hidden');
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
  stopMic();
}

function cleanupAll() {
  cleanupPeer();
  if (signaling) {
    signaling.close();
    signaling = null;
  }
}

// --- Микрофон зрителя ---

function setMicButtonOn(on) {
  micButton.classList.toggle('mic-button--on', on);
  micButton.textContent = on ? '🎤 Микрофон' : '🔇 Микрофон';
  micButton.setAttribute('aria-pressed', String(on));
}

function showMicMessage(text) {
  micMessageEl.textContent = text;
  micMessageEl.classList.remove('hidden');
  if (micMessageTimer) clearTimeout(micMessageTimer);
  micMessageTimer = setTimeout(() => {
    micMessageEl.classList.add('hidden');
  }, 4000);
}

function stopMic() {
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
  }
  micStream = null;
  micTrack = null;
  micButton.classList.add('hidden');
  setMicButtonOn(false);
}

micButton.addEventListener('click', async () => {
  if (micRequestInProgress) return;

  if (!micTrack) {
    // Первое включение — запрашиваем доступ к микрофону.
    micRequestInProgress = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Доступ к микрофону отклонён:', err);
      showMicMessage('Не удалось получить доступ к микрофону.');
      micRequestInProgress = false;
      return;
    }
    micRequestInProgress = false;

    if (!peer) {
      // Соединение успело закрыться, пока ждали разрешение пользователя.
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    micStream = stream;
    micTrack = stream.getAudioTracks()[0];
    // pc.addTrack триггерит onnegotiationneeded внутри RtcPeer — offer уйдёт
    // сам (viewer теперь тоже может инициировать оффер; polite-роль разрулит
    // возможную коллизию с офферами broadcaster'а, см. rtc.js).
    peer.pc.addTrack(micTrack, micStream);
    setMicButtonOn(true);
  } else {
    // Повторные клики — просто toggle track.enabled, трек не удаляем, чтобы
    // не плодить лишние ренегоциации.
    micTrack.enabled = !micTrack.enabled;
    setMicButtonOn(micTrack.enabled);
  }
});

init();
