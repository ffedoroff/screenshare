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
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(`сервер ответил статусом ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.roomId !== 'string' || !data.roomId) {
      throw new Error('в ответе нет roomId');
    }
    if (typeof data.leaderToken !== 'string' || !data.leaderToken) {
      throw new Error('в ответе нет leaderToken');
    }
    location.href = `/r/${data.roomId}#lt=${encodeURIComponent(data.leaderToken)}`;
  } catch (err) {
    console.error('Не удалось создать комнату:', err);
    showMessage('Не удалось создать комнату. Проверьте соединение и попробуйте снова.');
    createButton.disabled = false;
  }
});
