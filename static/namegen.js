// namegen.js — генератор красивых случайных имён для лендинга и модалки
// входа в комнату (см. static/landing.js, static/room.js).
//
// В отличие от SAS_EMOJI в static/crypto.js — тот словарь ЧАСТЬ ПРОТОКОЛА
// (фиксированный порядок из 64 символов, завязанный на 6-битную кодировку
// хэша), словари здесь — чисто декоративные. Их можно свободно менять,
// расширять, переставлять: это просто источник приятных человекочитаемых
// имён, никакой код на конкретный состав/порядок/длину не завязан.
//
// Форматы:
//   roomName() -> "<эмодзи> <Adjective> <Noun>"   напр. "🌊 Silver Harbor"
//   userName() -> "<эмодзи> <Adjective> <Animal>" напр. "🦊 Brave Fox"
//
// Почему у userName() эмодзи и животное — жёстко спарены (а не два
// независимых случайных выбора, как в roomName()): на тайле участника
// (static/room.js: createTile) буква-аватар рисуется как первый
// графем-кластер отображаемого имени (Intl.Segmenter, фолбэк [...str][0]).
// Если бы эмодзи выбирался отдельно от слова, юзер мог бы получить имя вида
// "🦊 Gentle Panda" — эмодзи лисы при имени "панда", что выглядит как баг.
// Спаривание [эмодзи, слово] в ANIMALS исключает этот разъезд по построению.
//
// Почему эмодзи в ANIMALS обязаны быть ОДНОКОДПОЙНТНЫМИ (без variation
// selector U+FE0F, без ZWJ-последовательностей, без флагов-суррогатных пар
// комбинаций): графемный кластер-фолбэк аватара — [...str][0] — корректно
// берёт ОДНУ юникод-код-точку (уже достаточно для эмодзи ВНЕ zero-width
// склеек), но многокодпойнтный эмодзи (напр. с VS16 или ZWJ) там, где
// Intl.Segmenter недоступен, может быть разорван на середине и отрисован
// как половина глифа. У эмодзи комнат (ROOM_EMOJI) такого ограничения нет —
// они никогда не идут через аватар-фолбэк, только текстом в шапке/заголовке.

'use strict';

const NameGen = (() => {
  // Равномерное целое число в [0, n) через crypto.getRandomValues с
  // rejection sampling (без modulo-смещения). Это НЕ криптография — просто
  // красивые имена, — но crypto.getRandomValues уже есть в любом браузере,
  // который умеет WebRTC, так что грех не взять честный источник энтропии.
  // Math.random — фолбэк на случай экзотического окружения без window.crypto.
  function randInt(n) {
    if (!Number.isInteger(n) || n <= 0) throw new Error('randInt: n must be a positive integer');
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      return Math.floor(Math.random() * n);
    }
    // Наибольшее кратное n, не превышающее 256 — значения из "хвоста"
    // [max, 256) отбрасываем и тянем новый байт, чтобы каждое значение из
    // [0, n) выпадало строго с равной вероятностью.
    const max = 256 - (256 % n);
    const buf = new Uint8Array(1);
    let v;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= max);
    return v % n;
  }

  function pick(list) {
    return list[randInt(list.length)];
  }

  // ~48 позитивных прилагательных без двойных смыслов.
  const ADJECTIVES = [
    'Amber', 'Autumn', 'Azure', 'Bold', 'Brave', 'Bright', 'Calm', 'Cheerful',
    'Clear', 'Cosy', 'Crystal', 'Dapper', 'Emerald', 'Gentle', 'Golden', 'Happy',
    'Hidden', 'Honest', 'Ivory', 'Jolly', 'Kind', 'Lively', 'Lucky', 'Lunar',
    'Mellow', 'Merry', 'Misty', 'Noble', 'Peaceful', 'Quiet', 'Radiant', 'Rosy',
    'Royal', 'Serene', 'Silent', 'Silver', 'Smooth', 'Solar', 'Spring', 'Sunny',
    'Swift', 'Tender', 'Velvet', 'Vivid', 'Warm', 'Wise', 'Witty', 'Zen',
  ];

  // ~48 существительных-мест/природы для имён комнат.
  const ROOM_NOUNS = [
    'Meadow', 'Harbor', 'Garden', 'Grove', 'Valley', 'River', 'Lake', 'Forest',
    'Island', 'Summit', 'Breeze', 'Cloud', 'Star', 'Moon', 'Aurora', 'Horizon',
    'Lagoon', 'Oasis', 'Prairie', 'Willow', 'Maple', 'Cedar', 'Fern', 'Lotus',
    'Pebble', 'Coral', 'Dune', 'Haven', 'Cove', 'Trail', 'Bridge', 'Lantern',
    'Ember', 'Cabin', 'Terrace', 'Nook', 'Bay', 'Creek', 'Glade', 'Ridge',
    'Canyon', 'Springs', 'Hollow', 'Peak', 'Shore', 'Reef', 'Orchard', 'Vale',
  ];

  // ~20 эмодзи для комнат — многокодпойнтные (с variation selector) тут
  // допустимы: эти эмодзи никогда не проходят через аватар-фолбэк
  // [...str][0], только показываются целиком в шапке/заголовке страницы.
  const ROOM_EMOJI = [
    '🌿', '🌸', '🌊', '🌙', '⭐', '🌈', '🍀', '🌻',
    '🌴', '🍁', '🔮', '🎈', '🎨', '🌷', '🫧', '🏔️',
    '🌺', '🕯️', '☀️', '🍉',
  ];

  // ~30 пар [эмодзи, животное] для имён участников. Эмодзи ЖЁСТКО
  // однокодпойнтные (без VS16/ZWJ) — см. комментарий в шапке файла про
  // аватар-фолбэк. Проверено скриптом (node -e), что [...emoji].length === 1
  // для каждой пары.
  const ANIMALS = [
    ['🦊', 'Fox'], ['🐼', 'Panda'], ['🐨', 'Koala'], ['🦁', 'Lion'],
    ['🐯', 'Tiger'], ['🐸', 'Frog'], ['🦉', 'Owl'], ['🐙', 'Octopus'],
    ['🐬', 'Dolphin'], ['🦋', 'Butterfly'], ['🐝', 'Bee'], ['🐢', 'Turtle'],
    ['🦜', 'Parrot'], ['🐺', 'Wolf'], ['🦄', 'Unicorn'], ['🐳', 'Whale'],
    ['🦥', 'Sloth'], ['🦔', 'Hedgehog'], ['🐹', 'Hamster'], ['🐧', 'Penguin'],
    ['🦩', 'Flamingo'], ['🦦', 'Otter'], ['🐰', 'Rabbit'], ['🦝', 'Raccoon'],
    ['🐻', 'Bear'], ['🦒', 'Giraffe'], ['🐘', 'Elephant'], ['🦭', 'Seal'],
    ['🐿', 'Squirrel'], ['🦌', 'Deer'],
  ];

  function roomName() {
    return `${pick(ROOM_EMOJI)} ${pick(ADJECTIVES)} ${pick(ROOM_NOUNS)}`;
  }

  function userName() {
    const [emoji, animal] = pick(ANIMALS);
    return `${emoji} ${pick(ADJECTIVES)} ${animal}`;
  }

  return { randInt, roomName, userName };
})();
