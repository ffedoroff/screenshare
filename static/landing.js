// landing.js — логика главной страницы: создание комнаты.
//
// Анонимность: никакого localStorage/sessionStorage/cookies нигде на этой
// странице. Имя участника здесь больше не спрашивается вовсе — его спросит
// модалка входа в самой комнате (см. static/room.js), при КАЖДОМ заходе
// заново, а не один раз здесь. `POST /api/rooms` возвращает {roomId,
// leaderToken} — leaderToken кладём во фрагмент ссылки (#lt=...), а не в путь
// и не в query: фрагмент никогда не уходит на сервер ни при обычной
// навигации браузера, ни в Referer — токен долетает только до room.js на
// этой же странице (см. там же — читается и сразу вычищается из адресной
// строки через history.replaceState, прежде чем показать что-либо ещё).
//
// Ключ комнаты (Ш1, E2E-шифрование — см. static/crypto.js/room.js): здесь же,
// рядом с leaderToken, генерируется случайный `k` (32 байта, base64url) и
// кладётся ВТОРЫМ параметром того же фрагмента (#lt=...&k=...) — сервер его
// не видит и вообще не участвует в его создании, это чисто клиентский
// секрет. room.js парсит оба параметра фрагмента разом и точно так же
// вычищает их из адресной строки. Из `k` room.js выводит ключи, которыми
// шифруется всё, что проходит через серверный релей (SDP/ICE/имя участника/
// fallback-чат) — см. docs/e2e-encryption.md, «Key Model».
//
// Третий (необязательный) параметр фрагмента — `n` — имя комнаты, введённое
// в #room-name-input (предзаполнен NameGen.roomName(), см. static/namegen.js;
// свободно редактируется). Это имя видит ТОЛЬКО создатель комнаты: оно
// кладётся ПОСЛЕДНИМ параметром того же фрагмента (#lt=...&k=...&n=...) и
// точно так же, как lt, не уходит на сервер и вычищается room.js из адресной
// строки при первом парсинге (history.replaceState). В отличие от `k`, оно
// НЕ участвует в buildShareLink() (room.js) — invite-ссылка для гостей
// собирается заново только из `k`, так что гости имя создателя никогда не
// видят. Побочный эффект вычистки из адресной строки, симметричный
// одноразовому `lt`: после F5 у создателя имя комнаты пропадает (шапка/
// заголовок вернутся к дефолту) — осознанный trade-off, а не баг.

'use strict';

const createButton = document.getElementById('create-room-button');
const messageEl = document.getElementById('landing-message');
const buildFooterEl = document.getElementById('landing-build-footer');
const buildShortEl = document.getElementById('landing-build-short');
const buildFullEl = document.getElementById('landing-build-full');
const roomNameInputEl = document.getElementById('room-name-input');

// Предзаполняем красивым сгенерированным именем (см. static/namegen.js) —
// пользователь может им и ограничиться (просто нажать Create room), либо
// стереть/отредактировать перед созданием комнаты.
roomNameInputEl.value = NameGen.roomName();

function showMessage(text, isError = true) {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  showMessage('');

  try {
    // Ш2: через window.API_BASE (см. static/config.js) — на Cloudflare Pages
    // фронт и API живут на разных хостах, same-origin '/api/rooms' бил бы
    // в сам Pages-хост, где такого пути нет.
    const res = await fetch(`${window.API_BASE}/api/rooms`, { method: 'POST' });
    if (!res.ok) throw new Error(`server responded with status ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.roomId !== 'string' || !data.roomId) {
      throw new Error('response is missing roomId');
    }
    if (typeof data.leaderToken !== 'string' || !data.leaderToken) {
      throw new Error('response is missing leaderToken');
    }
    const roomKey = RoomCrypto.generateRoomKey();
    const roomKeyB64 = RoomCrypto.bytesToBase64url(roomKey);

    // maxlength=40 режет по UTF-16-единицам, а не по code point —
    // вставка/автозамена может располовинить суррогатную пару эмодзи и
    // оставить одинокий суррогат. toWellFormed() (там, где есть) чинит это
    // штатно; на движках без него — ручная regex-вычистка одиноких
    // суррогатов (высокий без низкого следом / низкий без высокого перед).
    const rawRoomName = roomNameInputEl.value.trim();
    const roomName = rawRoomName
      ? (typeof rawRoomName.toWellFormed === 'function'
          ? rawRoomName.toWellFormed()
          : rawRoomName.replace(
              /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
              '$1',
            ))
      : '';

    location.href =
      `/r/${data.roomId}#lt=${encodeURIComponent(data.leaderToken)}&k=${roomKeyB64}` +
      (roomName ? `&n=${encodeURIComponent(roomName)}` : '');
  } catch (err) {
    console.error('Failed to create room:', err);
    showMessage('Failed to create room. Check your connection and try again.');
    createButton.disabled = false;
  }
});

// --- Build-хэш опубликованной статики (форензический якорь, см.
// docs/security.md, «Published Build Hash») ---
//
// /build-hash.json лежит РЯДОМ со страницей — корень бандла на Cloudflare
// Pages (см. .github/workflows/deploy-prod.yml, job deploy-pages), same-origin
// fetch, никакого window.API_BASE. В dev/self-hosted сборке файла нет
// вообще (сервер отдаёт 404 — там просто нет такого маршрута, см.
// src/main.rs) — тогда footer молча остаётся скрытым, ничего не падает.
// Хэш живёт только в памяти вкладки (обычная переменная, без
// localStorage/sessionStorage — анонимность страницы это не нарушает,
// значение не привязано к пользователю).
//
// ВАЖНО: хэш — НЕ криптогарантия (см. docs/security.md, §10.4) — хостер
// статики теоретически может подменить и сам build-hash.json. Реальная
// сверка — с GitHub Release (ссылка «verify» ниже), а не с тем, что
// показывает эта же страница.
async function loadBuildHash() {
  try {
    const res = await fetch('/build-hash.json');
    if (!res.ok) return; // dev/self-hosted без build-hash.json — штатно, footer остаётся скрытым
    const data = await res.json();
    if (!data || typeof data.hash !== 'string' || !data.hash) return;
    buildShortEl.textContent = `${data.hash.slice(0, 12)}…`;
    buildFullEl.textContent = data.hash;
    buildFooterEl.title = data.hash;
    buildFooterEl.classList.remove('hidden');
  } catch (err) {
    // Сеть/парсинг — тихо: это ненавязчивый индикатор, а не критичная часть UI.
    console.warn('Не удалось загрузить build-hash.json:', err);
  }
}

loadBuildHash();
