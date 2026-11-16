// Kaomoji-style text faces (emojicombos style). Plain text characters only —
// no modern colorful emoji like 😀 — so they render identically on every
// terminal. Longest keys are matched first so ':)' doesn't steal from ':-)'.
export const ASCII_EMOJI: Record<string, string> = {
  // happy / cute
  ':)': '(˶˃ ᵕ ˂˶)',
  ':-)': '(˶˃ ᵕ ˂˶)',
  ':]': '(˶˃ ᵕ ˂˶)',
  '=)': '(˶˃ ᵕ ˂˶)',
  ':D': '(๑˃ᴗ˂)ﻭ',
  ':-D': '(๑˃ᴗ˂)ﻭ',
  '=D': '(๑˃ᴗ˂)ﻭ',
  ':p': '(っ˘ω˘ς)',
  ':-p': '(っ˘ω˘ς)',
  ':P': '(っ˘ω˘ς)',
  ':-P': '(っ˘ω˘ς)',
  '=P': '(っ˘ω˘ς)',
  // sad / cry
  ':(': '(っ˘ڡ˘ς)',
  ':-(': '(っ˘ڡ˘ς)',
  '=[)': '(っ˘ڡ˘ς)',
  '=(': '(っ˘ڡ˘ς)',
  // shock / surprise
  ':O': '(⊙_⊙)',
  ':-O': '(⊙_⊙)',
  ':o': '(⊙_⊙)',
  ':-o': '(⊙_⊙)',
  // wink
  ';)': '(¬‿¬)',
  ';-)': '(¬‿¬)',
  // kiss / love
  ':*': '(｡♥‿♥｡)',
  // neutral / meh
  ':|': '(¬_¬)',
  ':-|': '(¬_¬)',
  // confused
  ':S': '(¬_¬)',
  ':-S': '(¬_¬)',
  ':s': '(¬_¬)',
  ':-s': '(¬_¬)',
  // extra combos
  ':love:': '(｡♥‿♥｡)',
  ':hug:': '(っ˘з(˘⌣˘c)',
  ':pout:': '(˶‾᷄ືང ᵕ ˷᷅ືང˶)',
  ':angry:': '(｡•́︿•̀｡)',
};

// Named combos you can insert with /combo <name>. Plain text faces — copy &
// paste any you like from emojicombos.com too, they all work as message text.
export const COMBOS: Record<string, string> = {
  happy: '(˶˃ ᵕ ˂˶)',
  excited: '(๑˃ᴗ˂)ﻭ',
  kiss: '(っ˘ω˘ς)',
  sad: '(っ˘ڡ˘ς)',
  shock: '(⊙_⊙)',
  wink: '(¬‿¬)',
  love: '(｡♥‿♥｡)',
  hug: '(っ˘з(˘⌣˘c)',
  pout: '(˶‾᷄ືང ᵕ ˷᷅ືང˶)',
  angry: '(｡•́︿•̀｡)',
  cry: '(ಥ﹏ಥ)',
  smile: '(｡◕‿◕｡)',
  shy: '(๑•́ﻌ•̀๑)',
  derp: '(°_°)',
  bunny: '(ˆ⌣ˆԅ)',
  bear: '(ฅ´ω`ฅ)',
  cat: '(=^･ω･^=)',
  dog: '(ᵔᴥᵔ)',
  thumbsup: '(╯°□°)╯',
  tableflip: '┻━┻ ︵ヽ(`Д´)ﾉ︵┻━┻',
  shrug: '¯\_(ツ)_/¯',
};

const ASCII_EMOJI_KEYS = Object.keys(ASCII_EMOJI).sort((a, b) => b.length - a.length);

// Replace ASCII emoticons with kaomoji faces. Longest keys first.
export function asciiEmoji(body: string): string {
  let out = body;
  for (const key of ASCII_EMOJI_KEYS) {
    const re = new RegExp(escapeRegExp(key), 'g');
    out = out.replace(re, ASCII_EMOJI[key]!);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
