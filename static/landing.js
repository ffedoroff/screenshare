// landing.js — логика главной страницы: ввод имени + создание комнаты.
//
// Имя хранится в localStorage под тем же ключом, что использует chat.js
// (NAME_STORAGE_KEY = 'screenshare-name') — так что заданное здесь имя
// подхватится room.js при входе в комнату и панелью чата.

'use strict';

const NAME_STORAGE_KEY = 'screenshare-name';

const nameInput = document.getElementById('name-input');
const createButton = document.getElementById('create-room-button');
const messageEl = document.getElementById('landing-message');

function getSavedName() {
  try {
    const raw = localStorage.getItem(NAME_STORAGE_KEY);
    return raw ? raw.trim() : '';
  } catch (err) {
    console.warn('Не удалось прочитать имя из localStorage:', err);
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name.trim());
  } catch (err) {
    console.warn('Не удалось сохранить имя в localStorage:', err);
  }
}

nameInput.value = getSavedName();
nameInput.addEventListener('input', () => saveName(nameInput.value));

function showMessage(text, isError = true) {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  showMessage('');
  saveName(nameInput.value);

  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(`сервер ответил статусом ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.roomId !== 'string' || !data.roomId) {
      throw new Error('в ответе нет roomId');
    }
    location.href = `/r/${data.roomId}`;
  } catch (err) {
    console.error('Не удалось создать комнату:', err);
    showMessage('Не удалось создать комнату. Проверьте соединение и попробуйте снова.');
    createButton.disabled = false;
  }
});
