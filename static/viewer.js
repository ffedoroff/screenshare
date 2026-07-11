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
const speakingIndicatorEl = document.getElementById('speaking-indicator');

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

// --- Аудио-хаб: чужие ретранслированные микрофоны + индикатор "кто говорит" ---
// Ключ '__broadcaster__' — фиксированный ключ для трека самого вещающего (его
// стрим отличаем не по id, а по наличию видеодорожки — см. handleAudioTrack).
const BROADCASTER_KEY = '__broadcaster__';
// streamId -> <audio> со скрытым ретранслированным микрофоном другого зрителя.
const relayedAudioEls = new Map();
// ключ (streamId либо BROADCASTER_KEY) -> функция stop() монитора уровня звука.
const speakingMonitors = new Map();
// ключи (streamId либо BROADCASTER_KEY), которые сейчас "говорят".
const speakingKeys = new Set();
// streamId -> { peerId, name } из stream-info (заполняется независимо от
// порядка появления самого трека — подписи разрешаются в момент рендера).
const streamInfoMap = new Map();

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

  // Аудио-хаб: вещающий присылает соответствие streamId -> {peerId, name} для
  // ретранслируемых чужих микрофонов. Может прийти раньше или позже самого
  // ontrack — подписи разрешаются лениво в момент рендера индикатора, так что
  // порядок не важен (см. speakerLabel).
  signaling.on('stream-info', ({ info }) => {
    if (!info || typeof info !== 'object') return;
    for (const [streamId, meta] of Object.entries(info)) {
      streamInfoMap.set(streamId, meta);
    }
    renderSpeakingIndicator();
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
      const track = event.track;

      if (track.kind === 'video') {
        hideOverlay();
        if (remoteVideo.srcObject !== event.streams[0]) {
          remoteVideo.srcObject = event.streams[0];
        }
        attemptPlay();
        // Кнопка микрофона видна только после успешного подключения к трансляции.
        micButton.classList.remove('hidden');
        return;
      }

      if (track.kind === 'audio') {
        handleAudioTrack(event.streams[0] || null, track);
      }
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

// Входящий аудиотрек через RtcPeer с broadcaster'ом — это либо звук самого
// вещающего (та же MediaStream, что несёт видео — узнаём по наличию видеодорожки
// в стриме, а не по конкретному id: порядок ontrack video/audio не гарантирован),
// либо чужой микрофон, ретранслированный через аудио-хаб (у него всегда своя
// отдельная MediaStream). В обоих случаях подключаем детектор уровня звука; для
// чужого микрофона дополнительно заводим скрытый <audio autoplay>, чтобы его
// вообще было слышно (звук вещающего и так слышен через <video>).
//
// Чистка скрытого <audio> и монитора уровня — по совокупности сигналов, не
// только по track.onended. Когда вещающий убирает ретранслированный трек
// через pc.removeTrack (broadcaster.js: unrelayAudioTrack), Chrome на этой
// стороне НЕ шлёт 'ended' у трека — только 'mute' (track.muted = true,
// readyState остаётся 'live', проверено эмпирически, см. resilience.spec.mjs).
// 'removetrack' на самом MediaStream, наоборот, срабатывает надёжно в этом
// случае — это и есть основной сигнал. mute сам по себе НЕ повод удалять:
// он бывает и транзиентным (кратковременная потеря пакетов), поэтому только
// логируется. ended остаётся как страховка на случай, если браузер всё же
// его пришлёт (другой браузер/другой сценарий обрыва).
function handleAudioTrack(stream, track) {
  const streamId = stream ? stream.id : track.id;
  const isBroadcasterTrack = !!(stream && stream.getVideoTracks().length > 0);
  const key = isBroadcasterTrack ? BROADCASTER_KEY : streamId;

  if (!isBroadcasterTrack) {
    let audioEl = relayedAudioEls.get(streamId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.dataset.streamId = streamId;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      relayedAudioEls.set(streamId, audioEl);
    }
    const audioStream = stream || new MediaStream([track]);
    if (audioEl.srcObject !== audioStream) {
      audioEl.srcObject = audioStream;
      const playPromise = audioEl.play();
      if (playPromise) {
        playPromise.catch((err) => console.warn('Не удалось запустить ретранслированное аудио:', err));
      }
    }

    // Основной сигнал ухода трека в этом сценарии: MediaStream лишился всех
    // аудиодорожек (removeTrack на стороне вещающего доходит сюда именно так).
    if (stream) {
      stream.onremovetrack = () => {
        if (stream.getAudioTracks().length === 0) {
          removeRelayedAudio(streamId);
          stopSpeakingMonitor(key);
        }
      };
    }
  }

  if (!speakingMonitors.has(key)) {
    const stop = SpeakingDetection.monitorTrack(track, (speaking) => setSpeakingKey(key, speaking));
    speakingMonitors.set(key, stop);
  }

  // Страховка: если браузер всё же пришлёт 'ended' (например, другой обрыв,
  // не через removeTrack) — чистим и по нему, тем же путём.
  track.onended = () => {
    if (!isBroadcasterTrack) removeRelayedAudio(streamId);
    stopSpeakingMonitor(key);
  };

  // mute транзиентный — не удаляем сразу, только для диагностики.
  track.onmute = () => {
    console.debug(`[audio ${key}] трек замьючен (mute) — не удаляем сразу, ждём removetrack/ended`);
  };
}

function removeRelayedAudio(streamId) {
  const audioEl = relayedAudioEls.get(streamId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    relayedAudioEls.delete(streamId);
  }
}

function stopSpeakingMonitor(key) {
  const stop = speakingMonitors.get(key);
  if (stop) {
    stop();
    speakingMonitors.delete(key);
  }
  speakingKeys.delete(key);
  renderSpeakingIndicator();
}

function setSpeakingKey(key, speaking) {
  if (speaking) speakingKeys.add(key);
  else speakingKeys.delete(key);
  renderSpeakingIndicator();
}

function speakerLabel(key) {
  if (key === BROADCASTER_KEY) return 'Вещающий';
  const info = streamInfoMap.get(key);
  if (info && info.name) return info.name;
  if (info && info.peerId) return `Гость-${info.peerId.slice(-4)}`;
  return 'Гость';
}

function renderSpeakingIndicator() {
  if (speakingKeys.size === 0) {
    speakingIndicatorEl.textContent = '';
    speakingIndicatorEl.classList.add('hidden');
    return;
  }
  const names = Array.from(speakingKeys, speakerLabel);
  speakingIndicatorEl.textContent = `Говорят: ${names.join(', ')}`;
  speakingIndicatorEl.classList.remove('hidden');
}

function cleanupPeer() {
  if (peer) {
    peer.close();
    peer = null;
  }
  stopMic();

  for (const stop of speakingMonitors.values()) stop();
  speakingMonitors.clear();
  speakingKeys.clear();
  for (const streamId of Array.from(relayedAudioEls.keys())) removeRelayedAudio(streamId);
  streamInfoMap.clear();
  renderSpeakingIndicator();
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
