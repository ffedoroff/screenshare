// crypto.js — E2E-шифрование комнаты (Ш1). Только WebCrypto (SubtleCrypto),
// никаких сторонних библиотек.
//
// Схема (см. docs/e2e-encryption.md и static/landing.js/room.js):
//   - Ключ комнаты `k` — 32 случайных байта, генерируется КЛИЕНТОМ при
//     создании комнаты (landing.js) и живёт только во фрагменте ссылки
//     (#k=...) — сервер его никогда не видит и не может увидеть (фрагмент не
//     уходит на сервер ни при какой навигации браузера).
//   - Из `k` через HKDF-SHA256 выводятся ТРИ независимых AES-256-GCM ключа —
//     по одному на каждое назначение (см. deriveKeys), с разными `info`, что
//     криптографически разделяет их: компрометация одного контекста не даёт
//     ничего для двух других контекстов, хотя все три выведены из одного `k`.
//       - "sig-v1"  — K_sig:  sdp/candidate/info в серверном релее (см.
//         static/rtc.js, static/room.js: sendStreamInfoTo/handleStreamInfo).
//       - "meta-v1" — K_meta: отображаемое имя участника в join-room (см.
//         static/room.js: encryptMyName/decryptPeerName).
//       - "chat-v1" — K_chat: fallback-конверт чата через сервер (см.
//         static/chat.js: sendEnvelopeToPeer/dispatchEnvelope).
//   - P2P-шина (mesh RTCDataChannel, см. static/bus.js/rtc.js) НЕ шифруется
//     этим модулем ВООБЩЕ — WebRTC DataChannel сам обязан идти поверх DTLS
//     (браузер не даёт этого не сделать), то есть он уже end-to-end
//     зашифрован между двумя конкретными пирами на транспортном уровне;
//     второй прикладной слой шифрования той же самой пары был бы чистой
//     тратой CPU без единого нового свойства безопасности. Шифруется только
//     то, что реально проходит ЧЕРЕЗ СЕРВЕР (сигналинг-релей и fallback чата)
//     — единственные точки, откуда сервер (или кто-то с доступом к нему/к
//     трафику до него) мог бы иначе прочитать SDP/ICE (и тем самым
//     подменить DTLS-отпечатки — см. docs/e2e-encryption.md, «Why This
//     Exists», зачем это вообще нужно) или содержимое.
//
//   - Ш3 (forward secrecy контента при смене состава, см.
//     docs/e2e-encryption.md §7): K_chat/K_meta не привязаны навечно к `k` —
//     лидер комнаты может сгенерировать НОВЫЙ случайный 32-байтный ключ
//     («эпоха») и вывести из него новую пару chat/meta через
//     deriveContentKeys() ниже (те же info-строки 'chat-v1'/'meta-v1', что и
//     в deriveKeys(), но с ДРУГИМ входным материалом) — модуль здесь остаётся
//     epoch-agnostic (просто выводит ключи из того, что дали), вся
//     логика "какая эпоха сейчас/кто её раздаёт/кому доверять" — в
//     static/room.js. K_sig НАРОЧНО не имеет эпох — deriveKeys() выше
//     остаётся единственным источником K_sig, привязанным к `k` на всю жизнь
//     комнаты (нужен неизменным для бутстрапа новичка).
//
// Формат зашифрованного значения для полей-JSON (`Value` в Rust, см.
// src/protocol.rs — sdp/candidate/info/chat-конверт): объект
// `{v:1, iv: base64, ct: base64}`, iv — 12 случайных байт (стандарт для
// AES-GCM), ct — шифртекст (уже включает GCM-тег, отдельно его не носим).
//
// Единственное поле, которое обязано остаться СТРОКОЙ на проводе (не
// объектом) — имя участника в join-room (`ClientMessage::JoinRoom.name:
// Option<String>`) — для него отдельная пара encryptToBase64/decryptFromBase64
// ниже: iv и шифртекст конкатенируются и целиком кодируются в одну
// base64-строку.

'use strict';

const RoomCrypto = (() => {
  const KEY_BYTES = 32; // 256 бит — размер сырого ключа комнаты `k`.
  const IV_BYTES = 12; // стандартный размер IV для AES-GCM.

  // --- base64 / base64url (без сторонних библиотек) ---

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** base64url (RFC4648 §5, без паддинга) — безопасно ложится во фрагмент ссылки без encodeURIComponent. */
  function bytesToBase64url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** Принимает base64url ЛИБО обычный base64 (на случай ручной вставки/ошибки) — не бросает исключение сама, некорректные символы даст отловить atob(). */
  function base64urlToBytes(str) {
    let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    return base64ToBytes(s);
  }

  // --- Ключ комнаты и вывод контекстных ключей ---

  /** Случайный сырой ключ комнаты (32 байта) — вызывается один раз при создании комнаты, см. static/landing.js. */
  function generateRoomKey() {
    return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  }

  function importBaseKey(rawKeyBytes) {
    return crypto.subtle.importKey('raw', rawKeyBytes, 'HKDF', false, ['deriveKey']);
  }

  /** Вывести один AES-256-GCM ключ под конкретный контекст (`info`) через HKDF-SHA256 из уже импортированного базового ключа. */
  async function deriveContextKey(baseKey, infoStr) {
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        // Соль намеренно пустая: единственный секретный входной материал —
        // это сам `k` (случайные 32 байта с достаточной энтропией), соль в
        // HKDF нужна для дополнительного разделения независимых источников
        // материала — здесь источник один, отдельного секрета для соли нет
        // и добавлять её было бы нечем (RFC5869 явно разрешает пустую соль).
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(infoStr),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Вывести все три контекстных ключа комнаты разом из сырых байт `k`.
   * Бросает исключение, если `rawKeyBytes` не 32-байтный (или WebCrypto
   * иначе откажется) — вызывающая сторона (см. static/room.js) трактует
   * любую ошибку здесь как «ключ невалиден» -> оверлей «Ссылка неполная».
   */
  async function deriveKeys(rawKeyBytes) {
    if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== KEY_BYTES) {
      throw new Error(`RoomCrypto.deriveKeys: ожидались ровно ${KEY_BYTES} байт ключа`);
    }
    const baseKey = await importBaseKey(rawKeyBytes);
    const [sig, meta, chat] = await Promise.all([
      deriveContextKey(baseKey, 'sig-v1'),
      deriveContextKey(baseKey, 'meta-v1'),
      deriveContextKey(baseKey, 'chat-v1'),
    ]);
    return { sig, meta, chat };
  }

  /**
   * Ш3 (forward secrecy контента, см. docs/e2e-encryption.md §7): вывести
   * ТОЛЬКО ДВА контентных ключа (chat/meta, БЕЗ sig) из произвольного
   * 32-байтного ключа — используется для ключей ЭПОХ >0 (сгенерированных
   * лидером при смене состава комнаты, см. static/room.js:
   * rotateContentKeysIfLeader), в отличие от deriveKeys() выше, который
   * выводит из `k` НЕИЗМЕНЯЕМУЮ на всю жизнь комнаты sig-эпоху 0. Те же
   * `info`-строки ('chat-v1'/'meta-v1'), что и в deriveKeys() — эпохи
   * различаются только ключевым материалом на входе HKDF, не схемой вывода:
   * K_sig НАРОЧНО не ротируется (нужен неизменным для бутстрапа новичка по
   * #k), поэтому у эпох >0 просто нет и не может быть своего sig.
   */
  async function deriveContentKeys(rawKeyBytes) {
    if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== KEY_BYTES) {
      throw new Error(`RoomCrypto.deriveContentKeys: ожидались ровно ${KEY_BYTES} байт ключа`);
    }
    const baseKey = await importBaseKey(rawKeyBytes);
    const [meta, chat] = await Promise.all([
      deriveContextKey(baseKey, 'meta-v1'),
      deriveContextKey(baseKey, 'chat-v1'),
    ]);
    return { meta, chat };
  }

  // --- Шифрование JSON-объектов в опаковый {v,iv,ct} (для полей-Value) ---

  /** Зашифровать произвольный JSON-сериализуемый `obj` под контекстный ключ `key`. */
  async function encrypt(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ctBuf)) };
  }

  /**
   * Расшифровать конверт `{v,iv,ct}` — честно бросает исключение при ЛЮБОЙ
   * проблеме: неверный формат, неверный ключ комнаты (GCM-тег не сойдётся —
   * `crypto.subtle.decrypt` сам откажет), повреждённый/подделанный ciphertext,
   * или невалидный JSON внутри (не должно случаться при корректном ключе, но
   * не должно и падать необработанным). Вызывающая сторона решает, что
   * делать с ошибкой (см. заголовки файлов static/room.js/chat.js).
   */
  async function decrypt(key, envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('RoomCrypto.decrypt: envelope не объект');
    }
    if (envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
      throw new Error('RoomCrypto.decrypt: неизвестный формат конверта');
    }
    const iv = base64ToBytes(envelope.iv);
    const ct = base64ToBytes(envelope.ct);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plaintextBuf);
    return JSON.parse(text);
  }

  // --- Шифрование в опаковую СТРОКУ (для полей, обязанных остаться String) ---

  /**
   * Тот же AES-256-GCM, что и encrypt(), но результат — ОДНА base64-строка
   * (iv и ciphertext конкатенированы) вместо JSON-объекта. Нужен там, где
   * протокольное поле типизировано как `String`, а не произвольный `Value`
   * (сейчас единственный случай — имя участника в join-room, см.
   * src/protocol.rs::ClientMessage::JoinRoom.name).
   */
  async function encryptToBase64(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const ctBytes = new Uint8Array(ctBuf);
    const combined = new Uint8Array(iv.length + ctBytes.length);
    combined.set(iv, 0);
    combined.set(ctBytes, iv.length);
    return bytesToBase64(combined);
  }

  /** Обратное к encryptToBase64 — та же честная политика исключений, что и decrypt(). */
  async function decryptFromBase64(key, str) {
    if (typeof str !== 'string' || str.length === 0) {
      throw new Error('RoomCrypto.decryptFromBase64: пустая или некорректная строка');
    }
    const combined = base64ToBytes(str);
    if (combined.length <= IV_BYTES) {
      throw new Error('RoomCrypto.decryptFromBase64: строка короче минимально возможной (iv+тег)');
    }
    const iv = combined.slice(0, IV_BYTES);
    const ct = combined.slice(IV_BYTES);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plaintextBuf);
    return JSON.parse(text);
  }

  /** Статичная информация об используемой криптосхеме — задел на будущий UI (индикатор шифрования и т.п.), см. задание фазы Ш1. */
  function getCryptoInfo() {
    return { algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', keyBits: 256, active: true };
  }

  return {
    generateRoomKey,
    deriveKeys,
    deriveContentKeys,
    encrypt,
    decrypt,
    encryptToBase64,
    decryptFromBase64,
    getCryptoInfo,
    bytesToBase64url,
    base64urlToBytes,
  };
})();
