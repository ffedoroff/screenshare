// namegen.js — generator of nice random names for the landing page and the
// room-entry modal (see static/landing.js, static/room.js).
//
// Unlike SAS_EMOJI in static/crypto.js — that dictionary is PART OF THE
// PROTOCOL (a fixed order of 64 symbols tied to a 6-bit hash encoding), the
// word lists here are purely decorative. They can be freely changed,
// extended, reordered: this is just a source of pleasant human-readable
// names, with no code tied to any specific composition/order/length.
//
// Formats:
//   roomName() -> "<emoji> <Adjective> <Noun>"   e.g. "🌊 Silver Harbor"
//   userName() -> "<emoji> <Adjective> <Animal>" e.g. "🦊 Brave Fox"
//
// Why userName()'s emoji and animal are rigidly paired (rather than two
// independent random picks, as in roomName()): on the participant tile
// (static/room.js: createTile) the avatar letter is drawn as the first
// grapheme cluster of the displayed name (Intl.Segmenter, fallback
// [...str][0]). If the emoji were picked separately from the word, a user
// could end up with a name like "🦊 Gentle Panda" — a fox emoji with the
// name "panda", which looks like a bug. Pairing [emoji, word] in ANIMALS
// rules out this mismatch by construction.
//
// Why the emoji in ANIMALS must be SINGLE-CODEPOINT (no variation selector
// U+FE0F, no ZWJ sequences, no flag surrogate-pair combinations): the
// avatar's grapheme-cluster fallback — [...str][0] — correctly takes ONE
// Unicode code point (already enough for emoji OUTSIDE zero-width joins),
// but a multi-codepoint emoji (e.g. with VS16 or ZWJ), where Intl.Segmenter
// is unavailable, can get torn in the middle and rendered as half a glyph.
// Room emoji (ROOM_EMOJI) have no such restriction — they never go through
// the avatar fallback, only appear as text in the header/title.

'use strict';

const NameGen = (() => {
  // A uniform random integer in [0, n) via crypto.getRandomValues with
  // rejection sampling (no modulo bias). This is NOT cryptography — just
  // nice names — but crypto.getRandomValues is already available in any
  // browser that supports WebRTC, so there's no reason not to use an
  // honest source of entropy. Math.random is a fallback for the exotic
  // case of an environment without window.crypto.
  function randInt(n) {
    if (!Number.isInteger(n) || n <= 0) throw new Error('randInt: n must be a positive integer');
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      return Math.floor(Math.random() * n);
    }
    // The largest multiple of n not exceeding 256 — values from the "tail"
    // [max, 256) are discarded and a new byte is drawn, so that every value
    // in [0, n) comes up with strictly equal probability.
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

  // ~48 positive adjectives with no double meanings.
  const ADJECTIVES = [
    'Amber', 'Autumn', 'Azure', 'Bold', 'Brave', 'Bright', 'Calm', 'Cheerful',
    'Clear', 'Cosy', 'Crystal', 'Dapper', 'Emerald', 'Gentle', 'Golden', 'Happy',
    'Hidden', 'Honest', 'Ivory', 'Jolly', 'Kind', 'Lively', 'Lucky', 'Lunar',
    'Mellow', 'Merry', 'Misty', 'Noble', 'Peaceful', 'Quiet', 'Radiant', 'Rosy',
    'Royal', 'Serene', 'Silent', 'Silver', 'Smooth', 'Solar', 'Spring', 'Sunny',
    'Swift', 'Tender', 'Velvet', 'Vivid', 'Warm', 'Wise', 'Witty', 'Zen',
  ];

  // ~48 place/nature nouns for room names.
  const ROOM_NOUNS = [
    'Meadow', 'Harbor', 'Garden', 'Grove', 'Valley', 'River', 'Lake', 'Forest',
    'Island', 'Summit', 'Breeze', 'Cloud', 'Star', 'Moon', 'Aurora', 'Horizon',
    'Lagoon', 'Oasis', 'Prairie', 'Willow', 'Maple', 'Cedar', 'Fern', 'Lotus',
    'Pebble', 'Coral', 'Dune', 'Haven', 'Cove', 'Trail', 'Bridge', 'Lantern',
    'Ember', 'Cabin', 'Terrace', 'Nook', 'Bay', 'Creek', 'Glade', 'Ridge',
    'Canyon', 'Springs', 'Hollow', 'Peak', 'Shore', 'Reef', 'Orchard', 'Vale',
  ];

  // ~20 emoji for rooms — multi-codepoint ones (with a variation selector)
  // are fine here: these emoji never go through the avatar fallback, only
  // shown in full in the page header/title.
  const ROOM_EMOJI = [
    '🌿', '🌸', '🌊', '🌙', '⭐', '🌈', '🍀', '🌻',
    '🌴', '🍁', '🔮', '🎈', '🎨', '🌷', '🌵', '🏔️',
    '🌺', '🕯️', '☀️', '🍉',
  ];

  // ~30 [emoji, animal] pairs for participant names. Emoji are STRICTLY
  // single-codepoint (no VS16/ZWJ) — see the file header comment about the
  // avatar fallback. Verified with a script (node -e) that
  // [...emoji].length === 1 for every pair.
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
