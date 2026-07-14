// crypto.js — E2E-шифрование комнаты (Ш1). Только WebCrypto (SubtleCrypto),
// никаких сторонних библиотек.
//
// Схема (см. docs/e2e-encryption.md и static/landing.js/room.js):
//   - Ключ комнаты `k` — 32 случайных байта, генерируется КЛИЕНТОМ при
//     создании комнаты (landing.js) и живёт только во фрагменте ссылки
//     (#k=...) — сервер его никогда не видит и не может увидеть (фрагмент не
//     уходит на сервер ни при какой навигации браузера).
//   - Из `k` через HKDF-SHA256 выводятся ДВА независимых AES-256-GCM ключа —
//     по одному на назначение (см. deriveKeys), с разными `info`, что
//     криптографически разделяет их: компрометация одного контекста не даёт
//     ничего для другого, хотя оба выведены из одного `k`.
//       - "sig-v1"  — K_sig:  sdp/candidate/info в серверном релее (см.
//         static/rtc.js, static/room.js: sendStreamInfoTo/handleStreamInfo).
//       - "meta-v1" — K_meta: отображаемое имя участника в join-room (см.
//         static/room.js: encryptMyName/decryptPeerName).
//   - P2P-шина (mesh RTCDataChannel, см. static/bus.js/rtc.js) НЕ шифруется
//     этим модулем ВООБЩЕ — WebRTC DataChannel сам обязан идти поверх DTLS
//     (браузер не даёт этого не сделать), то есть он уже end-to-end
//     зашифрован между двумя конкретными пирами на транспортном уровне;
//     второй прикладной слой шифрования той же самой пары был бы чистой
//     тратой CPU без единого нового свойства безопасности. Шифруется только
//     то, что реально проходит ЧЕРЕЗ СЕРВЕР (сигналинг-релей: sdp/candidate/
//     info + имя в join-room) — единственные точки, откуда сервер (или кто-то
//     с доступом к нему/к трафику до него) мог бы иначе прочитать SDP/ICE (и
//     тем самым подменить DTLS-отпечатки — см. docs/e2e-encryption.md, «Why
//     This Exists») или содержимое. Чат и медиа через сервер не идут вовсе.
//
//     Прежний K_chat и ротация контентных ключей по эпохам (Ш3) удалены
//     вместе с серверным fallback-чатом — они защищали только его (см.
//     docs/chat.md §12). K_sig/K_meta привязаны к `k` на всю жизнь комнаты.
//
// Формат зашифрованного значения для полей-JSON (`Value` в Rust, см.
// src/protocol.rs — sdp/candidate/info): объект
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

  // --- SAS: человекоудобная проверка ключа (Short Authentication String) ---
  //
  // Словарь РОВНО из 64 эмодзи (степень двойки) — чтобы каждый символ нёс
  // ровно 6 бит без modulo-смещения (byte & 0x3f). Подобраны визуально
  // различимые, однокодпойнтовые (без variation-selector/ZWJ) символы,
  // одинаково отображающиеся на всех платформах. Порядок и состав словаря —
  // ЧАСТЬ ПРОТОКОЛА (info-строка 'sas-v1'): менять их — значит расходить SAS
  // у клиентов разных версий, поэтому это фиксированная таблица.
  const SAS_EMOJI = [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
    '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
    '🐧', '🦆', '🦉', '🐺', '🐴', '🦄', '🐝', '🦋',
    '🐌', '🐞', '🐢', '🐍', '🐙', '🦀', '🐬', '🐳',
    '🐟', '🐊', '🐘', '🐪', '🦒', '🐎', '🐑', '🐐',
    '🌵', '🌲', '🌴', '🌸', '🌻', '🌹', '🍄', '🐚',
    '⭐', '🌙', '🔥', '💧', '🍎', '🍋', '🍉', '🍓',
    '🍒', '🍑', '🍍', '🥝', '🥕', '🌽', '🍔', '🍕',
  ];
  const SAS_EMOJI_COUNT = 6; // 6 символов × 6 бит = 36 бит энтропии SAS.

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
   * Вывести контекстные ключи комнаты из сырых байт `k`:
   *  - K_sig ('sig-v1')  — sdp/candidate/info в серверном сигналинг-релее;
   *  - K_meta ('meta-v1') — отображаемое имя участника в join-room.
   * Чат по шине уже E2E за счёт DTLS и прикладного ключа не требует (прежний
   * K_chat удалён вместе с серверным fallback-чатом, см. docs/chat.md §12).
   * Бросает исключение, если `rawKeyBytes` не 32-байтный (или WebCrypto иначе
   * откажется) — вызывающая сторона (см. static/room.js) трактует любую ошибку
   * здесь как «ключ невалиден» -> оверлей «Ссылка неполная».
   */
  async function deriveKeys(rawKeyBytes) {
    if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== KEY_BYTES) {
      throw new Error(`RoomCrypto.deriveKeys: expected exactly ${KEY_BYTES} key bytes`);
    }
    const baseKey = await importBaseKey(rawKeyBytes);
    const [sig, meta] = await Promise.all([
      deriveContextKey(baseKey, 'sig-v1'),
      deriveContextKey(baseKey, 'meta-v1'),
    ]);
    return { sig, meta };
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
      throw new Error('RoomCrypto.decrypt: envelope is not an object');
    }
    if (envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
      throw new Error('RoomCrypto.decrypt: unknown envelope format');
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
      throw new Error('RoomCrypto.decryptFromBase64: empty or invalid string');
    }
    const combined = base64ToBytes(str);
    if (combined.length <= IV_BYTES) {
      throw new Error('RoomCrypto.decryptFromBase64: string shorter than the minimum possible (iv+tag)');
    }
    const iv = combined.slice(0, IV_BYTES);
    const ct = combined.slice(IV_BYTES);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plaintextBuf);
    return JSON.parse(text);
  }

  // === SAS v2 — commit-before-reveal верификация против активного MITM ===
  //
  // Полная модель, атака и доказательство — docs/sas-verification.md. Коротко:
  // базовая крипта аутентифицирует всё владением `k`, но НЕ закрывает активный
  // MITM, отравляющий саму ссылку (разные `k` разным сторонам + мост). SAS
  // закрывает это человеком: 6 эмодзи, которые сходятся у честных участников
  // ТОЛЬКО если сессия не размоста́вана. Наивный HKDF(k, fingerprints) ломался
  // birthday-грайндом за ~0.35с — здесь грайнда нет благодаря commit-reveal
  // нонсов, привязанному к DTLS-фингерпринтам.
  //
  // ВСЕ входы в хеши — hex-строки фиксированного алфавита (peerId хешируется в
  // peerTag, фингерпринт нормализуется в lower-hex), поэтому разделители
  // '|'/':' однозначны даже если враждебный релей пришлёт peerId с этими
  // символами (docs/sas-verification.md §5.1).

  const _enc = new TextEncoder();

  function _bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  /** SHA-256 от строки ИЛИ Uint8Array -> hex. */
  async function _sha256Hex(input) {
    const data = input instanceof Uint8Array ? input : _enc.encode(String(input));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return _bytesToHex(new Uint8Array(digest));
  }

  /** Фингерпринт DTLS -> чистый lower-hex (убираем всё, кроме [0-9a-f]): getFingerprints() и remote-certificate из getStats() дают разный регистр/разделители в разных браузерах. */
  function sasNormalizeFingerprint(fp) {
    return String(fp == null ? '' : fp)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '');
  }

  /** Стабильный тег участника = SHA-256(peerId) hex. Фиксированная ширина и алфавит — устраняет инъекцию разделителем со стороны враждебного сервера (peerId он выдаёт сам). */
  function sasPeerTag(peerId) {
    return _sha256Hex(String(peerId == null ? '' : peerId));
  }

  /** Свежий 32-байтный нонс участника для одного раунда. */
  function generateSasNonce() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  /**
   * Канонический список участников -> отсортированные member-строки
   * `peerTag:normFp`. Сортировка делает результат независимым от порядка
   * перечисления; у всех честных участников множество совпадает. Возвращает
   * массив member-строк (используется и для roundId, и как ключ сортировки в
   * deriveSas). `members` — [{peerId, fingerprint}].
   */
  async function _sasMembers(members) {
    const tagged = await Promise.all(
      (members || []).map(async (m) => ({
        member: `${await sasPeerTag(m.peerId)}:${sasNormalizeFingerprint(m.fingerprint)}`,
        raw: m,
      }))
    );
    tagged.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
    return tagged;
  }

  /**
   * roundId = SHA-256('sas-round-v2|' + sorted(peerTag:fingerprint).join('|')).
   * ВКЛЮЧАЕТ фингерпринты, а не только peerId — это несущее свойство: смена
   * сертификата = другой раунд, поэтому его нельзя гриндить против уже
   * раскрытых нонсов (docs/sas-verification.md §5.1, §7.2).
   */
  async function sasRoundId(members) {
    const sorted = await _sasMembers(members);
    return _sha256Hex(`sas-round-v2|${sorted.map((t) => t.member).join('|')}`);
  }

  /** commit = SHA-256('sas-commit-v2|'+roundId+'|'+peerTag+'|'+nonceHex). Домен-разделён по раунду и автору; через roundId транзитивно связан и с сертификатами. */
  async function sasCommit(roundId, peerId, nonceBytes) {
    const peerTag = await sasPeerTag(peerId);
    return _sha256Hex(`sas-commit-v2|${roundId}|${peerTag}|${_bytesToHex(nonceBytes)}`);
  }

  /**
   * Вывести SAS из полного транскрипта раунда. `entries` — [{peerId,
   * fingerprint, nonce:Uint8Array}] (свой + все пиры). Порядок нонсов в IKM и
   * полей в info — по member-строке (peerTag:fp), одинаково у всех.
   *   IKM  = конкатенация 32-байтных нонсов (фикс. ширина -> без разделителя)
   *   info = 'sas-v2|' + join('|', peerTag:normFp)
   * Возвращает { emoji:[...6], hex:'<12 hex>' } — hex как текстовый фолбэк для
   * сверки, когда эмодзи рендерятся неоднозначно (docs §5.7, §9).
   */
  async function deriveSas(entries) {
    const list = entries || [];
    if (list.length < 2) {
      throw new Error('RoomCrypto.deriveSas: need at least 2 participants (self + one peer)');
    }
    const tagged = await Promise.all(
      list.map(async (e) => ({
        member: `${await sasPeerTag(e.peerId)}:${sasNormalizeFingerprint(e.fingerprint)}`,
        nonce: e.nonce,
      }))
    );
    tagged.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

    let ikmLen = 0;
    for (const t of tagged) {
      if (!(t.nonce instanceof Uint8Array) || t.nonce.length !== 32) {
        throw new Error('RoomCrypto.deriveSas: each entry needs a 32-byte nonce');
      }
      ikmLen += 32;
    }
    const ikm = new Uint8Array(ikmLen);
    let off = 0;
    for (const t of tagged) {
      ikm.set(t.nonce, off);
      off += 32;
    }
    const info = _enc.encode(`sas-v2|${tagged.map((t) => t.member).join('|')}`);

    const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bitsBuf = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
      baseKey,
      SAS_EMOJI_COUNT * 8
    );
    const bytes = new Uint8Array(bitsBuf);
    const emoji = [];
    for (let i = 0; i < SAS_EMOJI_COUNT; i++) {
      emoji.push(SAS_EMOJI[bytes[i] & 0x3f]); // словарь ровно 64 -> чистые 6 бит, без modulo-bias
    }
    return { emoji, hex: _bytesToHex(bytes.slice(0, SAS_EMOJI_COUNT)) };
  }

  /** Статичная информация об используемой криптосхеме — задел на будущий UI (индикатор шифрования и т.п.), см. задание фазы Ш1. */
  function getCryptoInfo() {
    return { algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', keyBits: 256, active: true };
  }

  return {
    generateRoomKey,
    deriveKeys,
    encrypt,
    decrypt,
    encryptToBase64,
    decryptFromBase64,
    deriveSas,
    sasRoundId,
    sasCommit,
    sasPeerTag,
    sasNormalizeFingerprint,
    generateSasNonce,
    getCryptoInfo,
    bytesToBase64url,
    base64urlToBytes,
    SAS_EMOJI_COUNT,
  };
})();
