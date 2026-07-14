// common.js — общие утилиты для static/room.js (протокол v2, единая страница
// комнаты): получение ICE-конфигурации и обёртка над WebSocket-сигналингом.

'use strict';

// Фоллбэк, если /config недоступен: только публичный STUN.
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Получить список ICE-серверов с бэкенда (`GET /config`).
 * При любой ошибке (сеть, парсинг, пустой ответ) — тихий фоллбэк на STUN.
 *
 * Ш2: бьём в `window.API_BASE` (см. static/config.js), а не в same-origin
 * `/config` напрямую — в split-origin деплое (см. docs/self-hosting.md,
 * «Split Origin (Frontend / Signaling Separated)») фронт и API живут на
 * разных хостах (the static origin / a separate API host), API_BASE —
 * единственная точка, знающая актуальный адрес бэкенда.
 */
async function fetchIceServers() {
  try {
    const res = await fetch(`${window.API_BASE}/config`);
    if (!res.ok) throw new Error(`/config ответил статусом ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
    return FALLBACK_ICE_SERVERS;
  } catch (err) {
    console.warn('Не удалось получить /config, используем STUN по умолчанию:', err);
    return FALLBACK_ICE_SERVERS;
  }
}

/**
 * Счётчики за сессию для секции настроек «Соединение и приватность» (см.
 * static/room.js: refreshConnectionSection) — сколько раз реально ушло
 * что-то ЧЕРЕЗ СЕРВЕР (не по P2P-шине). Общий top-level объект классического
 * скрипта (см. RoomCrypto в static/crypto.js — тот же приём), виден и в
 * rtc.js (offer/answer/ice-candidate — они ВСЕГДА идут через сигналинг,
 * шина ими же и устанавливается), и в room.js (stream-info-фоллбэк), и в
 * chat.js (фоллбэк чата). Начальный «бутстрап»-всплеск на пира неизбежен —
 * это честно показывается в счётчике, а не прячется (см. задание Ш1).
 */
const ConnStats = {
  signalingRelayCount: 0, // offer/answer/ice-candidate/stream-info(fallback) — через серверный релей
  fallbackChatCount: 0, // сообщения чата, ушедшие через сервер (P2P-шина к пиру не была открыта)

  incSignalingRelay() {
    this.signalingRelayCount++;
  },
  incFallbackChat() {
    this.fallbackChatCount++;
  },
};

/**
 * Обёртка над WebSocket-сигналингом.
 * — открывает соединение (ws:// или wss:// в зависимости от протокола страницы);
 * — отправляет/принимает JSON-сообщения вида { type, ...поля };
 * — диспетчеризует входящие сообщения подписчикам по `type` через `on()`.
 */
class Signaling {
  constructor() {
    this.ws = null;
    this._handlers = new Map();
    // Колбэки на закрытие/ошибку сокета — назначаются извне (static/room.js).
    this.onClose = null;
    this.onError = null;
  }

  /**
   * Открыть WebSocket-соединение с `/ws`. Промис резолвится после открытия.
   *
   * Ш2: адрес выводится из `window.API_BASE` (см. static/config.js), а не из
   * `location.host` — в split-origin деплое фронт и API на разных хостах,
   * `API_BASE.replace(/^http/, 'ws')` даёт `ws:`/`wss:` в зависимости от
   * того, http или https там прописан (см. docs/self-hosting.md, «Split
   * Origin (Frontend / Signaling Separated)»).
   */
  connect() {
    // Повторный вызов (авто-reconnect, см. static/room.js) НЕ должен оставлять
    // предыдущий сокет висеть: если тот успел реально открыться и всё ещё
    // жив на сервере (например, наша сторона просто устала ждать ответ и
    // затеяла новую попытку) — сервер продолжал бы считать нас участником
    // под СТАРЫМ peerId ещё и через старое соединение, и новый join-room с
    // тем же peerId получил бы отказ («занят») там, где должен был просто
    // переиспользовать его. Всегда явно закрываем прежний сокет перед тем,
    // как открыть новый.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    }

    return new Promise((resolve, reject) => {
      const url = `${window.API_BASE.replace(/^http/, 'ws')}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      // Промис должен settle'иться РОВНО один раз. Без этого флага
      // повторный вызов connect() (авто-reconnect, см. static/room.js) мог
      // зависнуть навсегда: если сокет закрывается ДО открытия (сервер ещё
      // не поднялся/уже недоступен) и при этом браузер почему-то не прислал
      // отдельного error-события — событие close без него не отклоняло
      // промис вообще, и `await signaling.connect()` висел бесконечно,
      // останавливая весь цикл переподключения (найдено эмпирически на
      // e2e-сценарии рестарта сервера, см. tests/e2e/resilience.spec.mjs).
      let settled = false;

      // Событие от УЖЕ ЗАМЕНЁННОГО сокета (не текущего this.ws) — игнорируем
      // целиком. Зачем: авто-reconnect (см. static/room.js) может дёрнуть
      // connect() повторно ещё до того, как СТАРЫЙ (уже неудавшийся/
      // подвисший) сокет пришлёт СВОЁ, отложенное браузером, close-событие —
      // без этой проверки такое запоздавшее событие от давно брошенного
      // сокета могло бы попасть в `this.onClose` уже ПОСЛЕ того, как новый
      // сокет успешно переподключился, и ошибочно запустить ещё один цикл
      // реконнекта поверх уже рабочего соединения (найдено эмпирически на
      // e2e-сценарии рестарта сервера, см. tests/e2e/resilience.spec.mjs).
      const isCurrent = () => this.ws === ws;

      ws.onopen = () => {
        if (!isCurrent()) return;
        settled = true;
        resolve();
      };

      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('Некорректный JSON от сервера сигналинга:', event.data, err);
          return;
        }
        this._dispatch(msg);
      };

      ws.onerror = (event) => {
        if (!isCurrent()) return;
        console.error('Ошибка WebSocket-соединения:', event);
        if (this.onError) this.onError(event);
        if (!settled) {
          settled = true;
          reject(event);
        }
      };

      ws.onclose = (event) => {
        if (!isCurrent()) return;
        console.log('WebSocket закрыт: код', event.code, 'причина', event.reason || '(нет)');
        if (!settled) {
          // Закрылся раньше, чем успел открыться — это неудача самого
          // connect(), а не закрытие уже открытого соединения.
          settled = true;
          reject(event);
        }
        if (this.onClose) this.onClose(event);
      };
    });
  }

  /** Подписаться на сообщения заданного `type`. Можно несколько обработчиков на тип. */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
  }

  /** Отправить сообщение серверу: `type` в kebab-case, остальные поля — camelCase. */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Попытка отправить сообщение при неоткрытом сокете:', type, payload);
      return;
    }
    this.ws.send(JSON.stringify({ type, ...payload }));
  }

  _dispatch(msg) {
    if (!msg || typeof msg.type !== 'string') {
      console.warn('Сообщение без поля type проигнорировано:', msg);
      return;
    }
    const handlers = this._handlers.get(msg.type);
    if (!handlers || handlers.length === 0) {
      console.debug('Нет подписчиков на сообщение типа', msg.type, msg);
      return;
    }
    for (const handler of handlers) handler(msg);
  }

  /** Закрыть соединение. Вызывающий код сам решает, как трактовать это закрытие в UI. */
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

/**
 * Определение «кто сейчас говорит» по входящим аудиотрекам микрофонов — общая
 * часть для всех входящих mic-треков в static/room.js (протокол v2: mesh,
 * каждый участник может включить микрофон). Никакой связи с сигналингом или
 * простым фактом «трек жив» — честный анализ громкости через Web Audio API
 * (AnalyserNode), поэтому корректно отличает `track.enabled = false` (тишина)
 * от реально живого, но молчащего микрофона.
 *
 * Диагноз (см. историю расследования, воспроизведено с реальным
 * getDisplayMedia): стрим экрана может нести системный аудиотрек, который
 * долетает до принимающей стороны ДО первого пользовательского клика по
 * странице. Мы
 * создаём общий AudioContext лениво при первом monitorTrack — он рождается
 * suspended. Старая версия резюмировала контекст ОДИН раз по первому
 * click/keydown и не проверяла результат — если жеста ещё не было, когда
 * пришёл трек, или resume() тихо не сработал, или сам контекст в этой среде
 * упал («The AudioContext encountered an error from the audio device or the
 * WebAudio renderer»), детектор навсегда оставался немым: индикатор
 * «Говорят» не загорался. Опытным путём установлено, что свежесозданный
 * AudioContext на тех же страницах слышит звук нормально (и resume() вне
 * жеста пользователя тут иногда срабатывает) — то есть лечит именно
 * пересоздание контекста, а не какая-то настройка анализатора.
 *
 * Поэтому ниже — реестр активных мониторов и самолечение: слушатели
 * click/keydown не одноразовые (висят, пока контекст suspended), сам
 * контекст отслеживается через statechange, и при поломке (closed/interrupted
 * или неудачный resume) все активные мониторы пересобираются на новом
 * AudioContext. Дополнительно опрос уровня следит за подозрительно долгой
 * тишиной при live-треке — это ловит «тихо умерший» рендерер, который не
 * дал о себе знать через statechange.
 */
const SpeakingDetection = (() => {
  // Порог RMS амплитуды сигнала, выше которого считаем, что источник говорит.
  // Подобран эмпирически: обычная речь через микрофон даёт RMS заметно выше,
  // фоновый шум/тишина — ниже.
  const RMS_THRESHOLD = 0.02;
  const POLL_INTERVAL_MS = 200;
  // Сколько подряд «мёртвых» (строго нулевых) замеров у живого немьютнутого
  // трека считаем поводом заподозрить тихо умерший рендерер аудио.
  const DEAD_SILENCE_STREAK = 15; // 15 * 200мс = 3с
  // Не пересобирать контекст чаще, чем раз в это время — иначе при системной
  // проблеме можно уйти в бесконечный цикл пересозданий.
  const REBUILD_COOLDOWN_MS = 10000;

  let audioCtx = null;
  // Слушатели click/keydown, которые пытаются резюмировать текущий контекст.
  // Храним ссылки, чтобы можно было снять их при пересборке контекста.
  let resumeListenersAttached = false;
  let lastRebuildAt = 0;

  // Активные мониторы: entry = { track, onChange, speaking, source, analyser,
  // buffer, timer, silentStreak }. Позволяет пересобрать Web Audio узлы на
  // новом AudioContext, не теряя setInterval-петли и колбэки вызывающего кода.
  const activeMonitors = new Set();

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener('click', tryResumeContext);
    document.addEventListener('keydown', tryResumeContext);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener('click', tryResumeContext);
    document.removeEventListener('keydown', tryResumeContext);
    resumeListenersAttached = false;
  }

  function tryResumeContext() {
    if (!audioCtx) return;
    if (audioCtx.state !== 'suspended') {
      // Контекст уже не suspended — жестовые слушатели больше не нужны.
      detachResumeListeners();
      return;
    }
    audioCtx.resume().then(() => {
      console.debug('SpeakingDetection: AudioContext резюмирован, state =', audioCtx && audioCtx.state);
      if (audioCtx && audioCtx.state === 'running') detachResumeListeners();
    }, (err) => {
      console.warn('SpeakingDetection: не удалось возобновить AudioContext:', err);
    });
  }

  function createAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor();
    console.debug('SpeakingDetection: создан новый AudioContext, начальное state =', ctx.state);

    ctx.addEventListener('statechange', () => {
      console.debug('SpeakingDetection: AudioContext statechange ->', ctx.state);
      if (ctx !== audioCtx) return; // событие от уже заменённого контекста
      if (ctx.state === 'closed' || ctx.state === 'interrupted') {
        rebuildAudioContext('statechange: ' + ctx.state);
      }
    });

    // Пробуем резюмировать сразу — по наблюдениям, в этой среде это иногда
    // срабатывает и вне пользовательского жеста.
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => {
        console.warn('SpeakingDetection: resume() сразу после создания не сработал:', err);
      });
      attachResumeListeners();
    }

    return ctx;
  }

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = createAudioContext();
    } else if (audioCtx.state === 'suspended') {
      // При каждом новом мониторе даём ещё один шанс — вдруг жест уже был.
      audioCtx.resume().catch(() => {});
      attachResumeListeners();
    }
    return audioCtx;
  }

  /** Подключить узлы Web Audio (source -> analyser) для одной записи реестра. */
  function connectMonitorNodes(entry, ctx) {
    entry.source = ctx.createMediaStreamSource(new MediaStream([entry.track]));
    entry.analyser = ctx.createAnalyser();
    entry.analyser.fftSize = 512;
    entry.source.connect(entry.analyser);
    entry.buffer = new Float32Array(entry.analyser.fftSize);
    entry.silentStreak = 0;
  }

  function disconnectMonitorNodes(entry) {
    try {
      if (entry.source) entry.source.disconnect();
    } catch (err) {
      // уже отключено — не страшно
    }
    entry.source = null;
    entry.analyser = null;
  }

  /**
   * Пересобрать AudioContext и все активные мониторы на нём. Вызывается и
   * из statechange-обработчика, и из петли опроса (при подозрении на тихо
   * умерший рендерер). Ограничена cooldown'ом, чтобы не зациклиться.
   */
  function rebuildAudioContext(reason) {
    const now = Date.now();
    if (now - lastRebuildAt < REBUILD_COOLDOWN_MS) {
      console.debug('SpeakingDetection: пересборка контекста пропущена (cooldown), причина:', reason);
      return;
    }
    lastRebuildAt = now;
    console.warn('SpeakingDetection: пересобираем AudioContext, причина:', reason);

    detachResumeListeners();
    const oldCtx = audioCtx;
    audioCtx = null;

    // Отключаем узлы на старом контексте, затем закрываем его best-effort.
    for (const entry of activeMonitors) disconnectMonitorNodes(entry);
    if (oldCtx) {
      try {
        oldCtx.close().catch(() => {});
      } catch (err) {
        // контекст мог быть уже закрыт/сломан — не страшно
      }
    }

    if (activeMonitors.size === 0) return; // некого пересобирать

    const newCtx = getAudioContext();
    for (const entry of activeMonitors) {
      connectMonitorNodes(entry, newCtx);
    }
  }

  /**
   * Начать мониторинг уровня звука одного аудиотрека. `onChange(speaking)`
   * вызывается только при смене состояния (не на каждый замер). Возвращает
   * функцию `stop()` — останавливает опрос и отключает узлы Web Audio;
   * если на момент остановки трек считался «говорящим», перед остановкой
   * будет вызван `onChange(false)`.
   */
  function monitorTrack(track, onChange) {
    const ctx = getAudioContext();

    const entry = {
      track,
      onChange,
      speaking: false,
      source: null,
      analyser: null,
      buffer: null,
      silentStreak: 0,
      timer: null,
    };
    connectMonitorNodes(entry, ctx);
    activeMonitors.add(entry);

    entry.timer = setInterval(() => {
      if (!entry.analyser) return; // между отключением и пересборкой узлов
      entry.analyser.getFloatTimeDomainData(entry.buffer);
      let sumSquares = 0;
      let allZero = true;
      for (let i = 0; i < entry.buffer.length; i++) {
        const v = entry.buffer[i];
        if (v !== 0) allZero = false;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / entry.buffer.length);
      const isSpeaking = rms > RMS_THRESHOLD;
      if (isSpeaking !== entry.speaking) {
        entry.speaking = isSpeaking;
        entry.onChange(entry.speaking);
      }

      // Страховка: живой немьютнутый трек, но буфер строго нулевой много
      // замеров подряд при "работающем" контексте — похоже на тихо умерший
      // рендерер (statechange не выстрелил). Инициируем пересборку.
      if (allZero && entry.track.readyState === 'live' && !entry.track.muted && audioCtx && audioCtx.state === 'running') {
        entry.silentStreak++;
        if (entry.silentStreak >= DEAD_SILENCE_STREAK) {
          entry.silentStreak = 0;
          rebuildAudioContext('подозрение на тихо умерший рендерер аудио');
        }
      } else {
        entry.silentStreak = 0;
      }
    }, POLL_INTERVAL_MS);

    return function stop() {
      clearInterval(entry.timer);
      disconnectMonitorNodes(entry);
      activeMonitors.delete(entry);
      if (entry.speaking) entry.onChange(false);
    };
  }

  return { monitorTrack };
})();
