// crypto.js — E2E-шифрование комнаты, модель v2 («вариант E», см.
// docs/research-p2p-key-handoff.md §6.5–6.6). Только WebCrypto (SubtleCrypto),
// никаких сторонних библиотек.
//
// Схема (см. docs/e2e-encryption.md и static/landing.js/room.js):
//   - Ссылка несёт СТАТИЧЕСКИЙ секрет `t` — 16 случайных байт, генерируется
//     КЛИЕНТОМ при создании комнаты (landing.js) и живёт во фрагменте ссылки
//     (#t=...&e=...) — сервер его никогда не видит (фрагмент не уходит на
//     сервер ни при какой навигации браузера). НО в отличие от прежней
//     модели (`k`, room-wide AES-ключ), `t` теперь НИКОГДА напрямую не
//     шифрует трафик — он только АУТЕНТИФИЦИРУЕТ. Реальные ключи шифрования
//     — эфемерные, попарные (см. ниже), и живут только в памяти вкладки.
//   - `e` — unix-время истечения ссылки (base36-строка, см. static/room.js),
//     зашито прямо в деривацию K_auth (см. deriveAuthKey): подменить/отрезать
//     `e` невозможно — другая строка `e` даёт другой K_auth и, транзитивно,
//     другие попарные ключи у обеих сторон, что немедленно проваливает
//     GCM-проверку (см. ниже, «Почему это даёт аутентификацию»).
//   - K_auth = HKDF(ikm=t, salt=∅, info="auth-v2|"+e) — 32 байта. K_auth САМ
//     НИЧЕГО не шифрует, он используется только как HKDF-`salt` при выводе
//     попарных ключей (deriveAuthKey возвращает сырые байты именно по этой
//     причине — HKDF-`salt` в WebCrypto принимает BufferSource, не CryptoKey).
//   - Каждая вкладка при входе в комнату генерирует ОДНОРАЗОВУЮ (per-tab-
//     session) эфемерную пару ECDH P-256 (см. generateEphemeralKeyPair) и
//     публикует публичную часть (`epub`) через сигналинг — сервер её видит
//     (это необходимо для доставки), но приватная часть НИКУДА не уходит.
//     Пара не сохраняется ни в какое хранилище — закрыл вкладку/обновил
//     страницу без t/e в URL — ключи потеряны навсегда, PFS (Perfect Forward
//     Secrecy): захват сервера/трафика ПОСЛЕ сессии не расшифровывает то, что
//     шло ВО ВРЕМЯ неё, даже если атакующий узнал `t`.
//   - Для каждой пары участников X,Y выводится ОБЩИЙ секрет через ECDH
//     (deriveBits) и из него — два независимых AES-256-GCM ключа (см.
//     derivePairKeys), с разными `info`, что криптографически разделяет их:
//       - K_pair_sig  ("pairsig-v2|...")  — sdp/candidate/info в серверном
//         релее (см. static/rtc.js, static/room.js: encryptSigFor/decryptSigFrom).
//       - K_pair_meta ("pairmeta-v2|...") — отображаемое имя участника,
//         анонсируется отдельным сообщением `name-announce` (см. static/room.js).
//     Оба вывода посолены K_auth (см. выше) — это несущее свойство всей
//     схемы:
//
//     ПОЧЕМУ PSK-в-salt даёт аутентификацию без явных confirm-сообщений.
//     ECDH сам по себе аутентифицирует ТОЛЬКО владение приватным ключом —
//     сервер-MITM может провести отдельный ECDH-обмен с каждой стороной пары
//     (классическая атака "человек посередине" на голый DH) и молча
//     ретранслировать/подменять трафик под двумя разными общими секретами.
//     Но K_auth, посчитанный из `t`, — это HKDF-`salt` ОБОИХ производных
//     ключей: у MITM нет `t` (это секрет ИЗ ССЫЛКИ, а не с провода), поэтому
//     его K_auth отличается от настоящего, и через HKDF отличается ЛЮБОЙ его
//     K_pair_sig/K_pair_meta от настоящего — даже если сам ECDH-обмен MITM
//     провёл технически корректно. Первое же сообщение, зашифрованное под
//     неправильным ключом, не проходит проверку тега AES-GCM у честной
//     стороны — `crypto.subtle.decrypt` сам бросает исключение (см.
//     static/room.js: handleCryptoFailureOnce) — отдельного протокольного
//     шага подтверждения ("правильно ли мы поняли друг друга?") не нужно,
//     он встроен в саму криптографию.
//
//     ПОЧЕМУ `e` в info у K_auth нельзя "отрезать". Если бы срок действия
//     ссылки проверялся только НА КЛИЕНТЕ (см. static/room.js: сравнение
//     `now` с `e`), а сама криптография от `e` не зависела бы, злоумышленник
//     с урезанной/модифицированной копией клиента мог бы просто не делать эту
//     проверку и продолжать пользоваться `t` после истечения ссылки. Раз `e`
//     — часть `info` в выводе K_auth, а K_auth — часть выводов ЛЮБОГО
//     попарного ключа, "истечение" на самом деле не проверка, а КРИПТО-
//     ГРАНИЦА: клиент с другим (например, продлённым задним числом) `e`
//     получит другой K_auth и не сможет расшифровать ничего от честных
//     участников, использующих настоящий `e` из настоящей ссылки — независимо
//     от того, проверяет ли он сам срок действия.
//
// P2P-шина (mesh RTCDataChannel, см. static/bus.js/rtc.js) НЕ шифруется этим
// модулем ВООБЩЕ — WebRTC DataChannel сам обязан идти поверх DTLS (браузер не
// даёт этого не сделать), то есть он уже end-to-end зашифрован между двумя
// конкретными пирами на транспортном уровне; второй прикладной слой
// шифрования той же самой пары был бы чистой тратой CPU без единого нового
// свойства безопасности. Шифруется только то, что реально проходит ЧЕРЕЗ
// СЕРВЕР (сигналинг-релей: sdp/candidate/info/имя) — единственные точки,
// откуда сервер (или кто-то с доступом к нему/к трафику до него) мог бы иначе
// прочитать SDP/ICE (и тем самым подменить DTLS-отпечатки — см.
// docs/e2e-encryption.md, «Why This Exists») или содержимое. Чат и медиа
// через сервер не идут вовсе.
//
// Формат зашифрованного значения для полей-JSON (`Value` в Rust, см.
// src/protocol.rs — sdp/candidate/info): объект `{v:2, iv: base64, ct:
// base64}` (v поднят с 1: старая room-wide схема и новая попарная несовместимы
// по формату производных ключей, бамп ловит случайное смешение версий при
// раскатке) — iv 12 случайных байт (стандарт для AES-GCM), ct — шифртекст
// (уже включает GCM-тег, отдельно его не носим). encryptJson/decryptJson ниже
// — пара функций именно под этот формат; decryptJson честно проверяет `v`.
//
// Отдельная пара encryptToBase64/decryptFromBase64 — результат ОДНА
// base64-строка (iv и ciphertext конкатенированы) — нужна там, где
// протокольное поле типизировано как `String`, а не произвольный `Value`:
// сейчас единственный случай — payload сообщения `name-announce` (см.
// src/protocol.rs::ClientMessage::NameAnnounce / ServerMessage::NameAnnounce).
// Поле `name` в самом `join-room`/`peer-joined` v2-клиенты всегда шлют/видят
// `null` — имя ходит ТОЛЬКО через name-announce под попарным K_pair_meta.
//
// Room-wide `deriveKeys`/K_sig("sig-v1")/K_meta("meta-v1") модели v1 —
// УДАЛЕНЫ целиком вместе с `generateRoomKey` (32-байтный ключ комнаты в
// ссылке): весь релей теперь идёт под эфемерными попарными ключами (см. выше).

'use strict';

const RoomCrypto = (() => {
  const TOKEN_BYTES = 16; // размер статического PSK-токена ссылки `t` — только аутентифицирует, никогда не шифрует.
  const IV_BYTES = 12; // стандартный размер IV для AES-GCM.
  const EPUB_RAW_BYTES = 65; // несжатая точка ECDH P-256 в формате 'raw' (0x04 + 32 + 32 байт).

  // --- SAS: человекоудобная проверка ключа (Short Authentication String) ---
  //
  // Словарь РОВНО из 64 эмодзи (степень двойки) — чтобы каждый символ нёс
  // ровно 6 бит без modulo-смещения (byte & 0x3f). Подобраны визуально
  // различимые, однокодпойнтовые (без variation-selector/ZWJ) символы,
  // одинаково отображающиеся на всех платформах. Порядок и состав словаря —
  // ЧАСТЬ ПРОТОКОЛА (info-строка 'sas-v2'): менять их — значит расходить SAS
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
  // 5 символов × 6 бит = 30 бит энтропии SAS (было 6 символов/36 бит — см.
  // docs/sas-verification.md §5.7/§10). deriveSas() усекает HKDF-выход до
  // SAS_EMOJI_COUNT*8 бит С НАЧАЛА (deriveBits(N) — это всегда ПРЕФИКС
  // полного потока, не независимый вывод), поэтому смена этой константы не
  // требует смены info-строки: старый клиент во время недокатанного деплоя
  // увидит 6 эмодзи, новый — 5, но первые 5 у обоих совпадут (общий префикс)
  // — это НЕ признак MITM, просто кратковременный разъезд версий на время
  // деплоя, а не расхождение самого SAS.
  const SAS_EMOJI_COUNT = 5;

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

  const _enc = new TextEncoder();

  // --- Токен ссылки `t` и K_auth ---

  /** Случайный статический PSK-токен ссылки (16 байт) — вызывается один раз при создании комнаты, см. static/landing.js. НИКОГДА не шифрует трафик сам — только аутентифицирует через K_auth (см. deriveAuthKey и шапку файла). */
  function generateRoomToken() {
    return crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  }

  /**
   * K_auth = HKDF-SHA256(ikm=tokenBytes, salt=∅, info="auth-v2|"+expiryString)
   * — 32 сырых байта (не CryptoKey: используется ниже как HKDF-`salt` при
   * выводе попарных ключей, а `salt` в WebCrypto — BufferSource, не ключ).
   * `expiryString` — РОВНО та base36-строка `e` из фрагмента ссылки (см.
   * static/room.js) — включена в `info`, поэтому подмена/отрезание `e`
   * меняет K_auth и транзитивно ломает любой попарный ключ (см. шапку файла,
   * «Почему `e` нельзя отрезать»).
   */
  async function deriveAuthKey(tokenBytes, expiryString) {
    const ikmKey = await crypto.subtle.importKey('raw', tokenBytes, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: _enc.encode(`auth-v2|${expiryString}`),
      },
      ikmKey,
      256
    );
    return new Uint8Array(bits);
  }

  // --- Эфемерные попарные ключи (ECDH P-256 + HKDF, посолено K_auth) ---

  /**
   * Одноразовая (per-tab-session) пара ECDH P-256 — генерируется ОДИН раз при
   * входе в комнату (см. static/room.js: init), никогда не сохраняется вне
   * памяти вкладки — основа PFS этой схемы (см. шапку файла). extractable=
   * false: в WebCrypto флаг относится только к ПРИВАТНОЙ части (публичная
   * экспортируема всегда — exportEpub работает независимо), так что приватный
   * ключ дополнительно неизвлекаем даже собственным кодом вкладки.
   */
  function generateEphemeralKeyPair() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }

  /** Публичный ключ -> base64url(raw) — то, что летит на проводе как `epub` (65 байт -> 87 симв., см. src/protocol.rs). */
  async function exportEpub(pub) {
    const raw = await crypto.subtle.exportKey('raw', pub);
    return bytesToBase64url(new Uint8Array(raw));
  }

  /**
   * Импортировать чужой `epub` обратно в CryptoKey — честно возвращает
   * `null` при ЛЮБОЙ проблеме (не декодируется как base64url, не ровно
   * EPUB_RAW_BYTES байт после декода, WebCrypto отказалась импортировать как
   * точку P-256) вместо исключения: вызывающая сторона (derivePairKeys ниже)
   * трактует `null` как невозможность вывести пару для этого пира —
   * ОДНОЗНАЧНО криптографический отказ (см. static/room.js:
   * handleCryptoFailureOnce), а не тихий пропуск.
   */
  async function importEpub(str) {
    try {
      const bytes = base64urlToBytes(str);
      if (bytes.length !== EPUB_RAW_BYTES) return null;
      return await crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, [], []);
    } catch (err) {
      return null;
    }
  }

  /**
   * Вывести попарные ключи (K_pair_sig, K_pair_meta) для одной пары
   * участников X (мы), Y (собеседник) — см. шапку файла и
   * docs/e2e-encryption.md. Аргументы:
   *   - myPriv — наша эфемерная приватная ECDH-пара (см. generateEphemeralKeyPair);
   *   - theirEpubStr — их `epub` строкой (с провода — join-room/joined.peers/
   *     peer-joined/join-request/waiting.leaderEpub);
   *   - myPeerId/theirPeerId — peerId обеих сторон;
   *   - myEpubStr — наш собственный экспортированный `epub` (для транскрипта —
   *     он строится из ОБЕИХ сторон одинаково, независимо от того, кто его
   *     считает);
   *   - roomId — из URL;
   *   - expiryString — `e` из ссылки (см. deriveAuthKey);
   *   - kAuthBytes — K_auth (см. deriveAuthKey) — используется как HKDF-salt.
   * Транскрипт TH и обе HKDF-деривации — см. docs/e2e-encryption.md.
   * Бросает исключение, если `theirEpubStr` невалиден (importEpub -> null)
   * или WebCrypto иначе откажется — вызывающая сторона трактует это как
   * криптографический отказ пары (см. static/room.js).
   */
  async function derivePairKeys({ myPriv, theirEpubStr, myPeerId, theirPeerId, myEpubStr, roomId, expiryString, kAuthBytes }) {
    const theirPub = await importEpub(theirEpubStr);
    if (!theirPub) {
      throw new Error(`RoomCrypto.derivePairKeys: invalid epub for peer ${theirPeerId}`);
    }

    // Попарный транскрипт — независим от того, кто (X или Y) его считает:
    // обе стороны сортируют СВОЮ и ЧУЖУЮ member-строку одинаково.
    const sMine = `${myPeerId}:${myEpubStr}`;
    const sTheirs = `${theirPeerId}:${theirEpubStr}`;
    const sMin = sMine < sTheirs ? sMine : sTheirs;
    const sMax = sMine < sTheirs ? sTheirs : sMine;
    const thDigest = await crypto.subtle.digest(
      'SHA-256',
      _enc.encode(`pair-v2|${roomId}|${sMin}|${sMax}|${expiryString}`)
    );
    const thB64 = bytesToBase64url(new Uint8Array(thDigest));

    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
    const sharedKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

    const [sigKey, metaKey] = await Promise.all([
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: kAuthBytes, info: _enc.encode(`pairsig-v2|${thB64}`) },
        sharedKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      ),
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: kAuthBytes, info: _enc.encode(`pairmeta-v2|${thB64}`) },
        sharedKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      ),
    ]);
    return { sigKey, metaKey };
  }

  // --- Шифрование JSON-объектов в опаковый {v,iv,ct} (для полей-Value) ---

  /** Зашифровать произвольный JSON-сериализуемый `obj` под ключ `key` (попарный K_pair_sig — см. static/room.js: encryptSigFor). */
  async function encryptJson(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { v: 2, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ctBuf)) };
  }

  /**
   * Расшифровать конверт `{v,iv,ct}` — честно бросает исключение при ЛЮБОЙ
   * проблеме: неверный формат, чужой/несовпадающий попарный ключ (GCM-тег не
   * сойдётся — `crypto.subtle.decrypt` сам откажет), повреждённый/
   * подделанный ciphertext, невалидный JSON внутри, либо `v !== 2` (смешение
   * с v1-конвертом или чужой версией протокола). Вызывающая сторона решает,
   * что делать с ошибкой (см. static/room.js: handleCryptoFailureOnce).
   */
  async function decryptJson(key, envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('RoomCrypto.decryptJson: envelope is not an object');
    }
    if (envelope.v !== 2 || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
      throw new Error('RoomCrypto.decryptJson: unknown envelope format');
    }
    const iv = base64ToBytes(envelope.iv);
    const ct = base64ToBytes(envelope.ct);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plaintextBuf);
    return JSON.parse(text);
  }

  // --- Шифрование в опаковую СТРОКУ (для полей, обязанных остаться String) ---

  /**
   * Тот же AES-256-GCM, что и encryptJson(), но результат — ОДНА base64-
   * строка (iv и ciphertext конкатенированы) вместо JSON-объекта. Нужен там,
   * где протокольное поле типизировано как `String`, а не произвольный
   * `Value` — сейчас единственный случай: payload `name-announce` (под
   * попарным K_pair_meta, см. src/protocol.rs::ClientMessage::NameAnnounce).
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

  /** Обратное к encryptToBase64 — та же честная политика исключений, что и decryptJson(). */
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
  // базовая крипта аутентифицирует всё владением `t` (см. шапку файла), но НЕ
  // закрывает активный MITM, отравляющий саму ссылку (разные `t` разным
  // сторонам + мост). SAS закрывает это человеком: 5 эмодзи, которые сходятся
  // у честных участников ТОЛЬКО если сессия не размоста́вана. Наивный
  // HKDF(k, fingerprints) ломался birthday-грайндом за ~0.35с — здесь грайнда
  // нет благодаря commit-reveal нонсов, привязанному к DTLS-фингерпринтам.
  //
  // ВСЕ входы в хеши — hex-строки фиксированного алфавита (peerId хешируется в
  // peerTag, фингерпринт нормализуется в lower-hex), поэтому разделители
  // '|'/':' однозначны даже если враждебный релей пришлёт peerId с этими
  // символами (docs/sas-verification.md §5.1).

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
   * Возвращает { emoji:[...5], hex:'<10 hex>' } — hex как текстовый фолбэк для
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
    generateRoomToken,
    deriveAuthKey,
    generateEphemeralKeyPair,
    exportEpub,
    importEpub,
    derivePairKeys,
    encryptJson,
    decryptJson,
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
