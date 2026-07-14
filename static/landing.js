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

'use strict';

const createButton = document.getElementById('create-room-button');
const messageEl = document.getElementById('landing-message');

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
    if (!res.ok) throw new Error(`сервер ответил статусом ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.roomId !== 'string' || !data.roomId) {
      throw new Error('в ответе нет roomId');
    }
    if (typeof data.leaderToken !== 'string' || !data.leaderToken) {
      throw new Error('в ответе нет leaderToken');
    }
    const roomKey = RoomCrypto.generateRoomKey();
    const roomKeyB64 = RoomCrypto.bytesToBase64url(roomKey);
    location.href = `/r/${data.roomId}#lt=${encodeURIComponent(data.leaderToken)}&k=${roomKeyB64}`;
  } catch (err) {
    console.error('Не удалось создать комнату:', err);
    showMessage('Не удалось создать комнату. Проверьте соединение и попробуйте снова.');
    createButton.disabled = false;
  }
});
