// Things to draw in Doodle Guess, by how hard they are to get across in a
// few dozen terminal pixels.

export const EASY = `apple banana bed bell bird boat bone book bread bus cake candle car carrot cat
chair cheese clock cloud cookie cow crown cup dice dog door duck egg eye fish
flower fork frog ghost glasses hand hat heart house key kite ladder lamp leaf
lemon lion moon mouse mushroom nose octopus owl pencil phone pig pizza rain
rainbow ring robot rocket sandwich shark sheep shoe smile snake snowman sock
spider spoon star sun sword table tent tiger tomato tooth train tree turtle
umbrella whale wheel window zebra balloon cactus crab drum hammer heart igloo
jellyfish penguin scissors skull volcano worm snail bee cherry grapes`;

export const MEDIUM = `airplane anchor astronaut backpack bandage barn battery beach bicycle bridge
broom butterfly camera campfire castle caterpillar chimney compass dinosaur
dolphin dragon elephant envelope feather fireworks flashlight giraffe hamburger
helicopter hourglass kangaroo lighthouse magnet mermaid microphone mountain
ninja parachute peacock pirate popcorn pyramid saturn scarecrow skateboard
spaceship squirrel submarine sunflower teapot telescope tornado tractor
treasure trophy unicorn vampire waterfall windmill wizard ice-cream toothbrush
headphones lighthouse lollipop mailbox map pineapple pumpkin raccoon
rollerskate seahorse skeleton sloth snowflake spiderweb stapler swing
thermometer traffic-light trampoline volcano watermelon witch zipper`;

export const HARD = `alarm-clock avalanche black-hole blueprint bonfire bookworm camouflage catapult
chandelier crossword daydream earthquake electricity fingerprint gravity
handshake hibernate homework hurricane jet-lag karaoke labyrinth lullaby
meditation nightmare origami password quicksand recycle shadow sleepwalking
snowstorm spotlight stopwatch sunburn traffic-jam tsunami vacation wifi
wormhole echo reflection deadline teleport time-travel gossip jealousy
procrastination evolution friendship construction`;

// 18+ words, used only when the host turns them on in the lobby. Explicit on
// purpose, with Hinglish ones for laughs, and kept to words an Indian group
// knows and can draw. No slurs, and no words that are mainly insults.

export const ADULT_EASY = `dick cock penis pussy vagina tits boobs nipple balls ass butt boner
dildo condom thong bra naked handcuffs whip chut gaand lund lauda tatte jhaant
chuche nanga chaddi chumma nirodh`;

export const ADULT_MEDIUM = `blowjob handjob sixty-nine doggy-style erection threesome
strip-tease lap-dance stripper porn sex-toy vibrator love-bite spank lingerie
blindfold bondage chudai muth suhagraat pichwada`;

export const ADULT_HARD = `kama-sutra orgasm orgy masturbate foreplay wet-dream sexting
nude-selfie sex-tape horny virgin testicles tharki shilajit gaand-phati`;

/** Other ways people write a word. A guess that matches any of them counts. */
export const SPELLINGS: Record<string, string[]> = {
  'sixty nine': ['69'],
  'love bite': ['hickey'],
  chut: ['choot'],
  gaand: ['gand'],
  lund: ['lun', 'loond'],
  lauda: ['lawda', 'loda', 'lavda'],
  tatte: ['tatta', 'tattey'],
  jhaant: ['jhant', 'jhaat'],
  chuche: ['chuchi', 'chuchiyan', 'chuchiyaan'],
  nanga: ['nangi'],
  chaddi: ['chaddhi', 'chaddy'],
  chumma: ['chuma', 'chummi', 'chumi'],
  nirodh: ['nirod'],
  chudai: ['chudaai', 'chodai'],
  muth: ['mutth', 'mooth'],
  suhagraat: ['suhaagraat', 'suhagrat', 'suhaagrat'],
  pichwada: ['pichwara', 'pichhwada', 'pichhwara'],
  tharki: ['tharkee', 'tharky'],
  shilajit: ['shilajeet'],
  'gaand phati': ['gand phati', 'gaand fati', 'gand fati', 'gaand phat gayi', 'gand phat gayi'],
};

export function words(list: string): string[] {
  return [...new Set(list.split(/\s+/).filter(Boolean).map((w) => w.replace(/-/g, ' ')))];
}

/** Lower case, letters and digits only, single spaces. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const forms = (word: string): string[] => [word, ...(SPELLINGS[word] ?? [])].map(norm);
const single = (s: string): string => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s);

/**
 * Does a guess name the word? Case, punctuation, spacing, a plural "s" and
 * the listed spellings don't matter, and the word may sit inside a sentence.
 */
export function accepts(word: string, guess: string): boolean {
  const g = norm(guess);
  const gs = g.replace(/ /g, '');
  return forms(word).some((w) => {
    const ws = w.replace(/ /g, '');
    return g === w || gs === ws || ` ${g} `.includes(` ${w} `) || (ws.length > 3 && single(gs) === single(ws));
  });
}

/** One or two letters off: worth a private "close!" nudge. */
export function isClose(word: string, guess: string): boolean {
  const g = norm(guess);
  return forms(word).some((w) => w.length >= 4 && lev(g, w) <= (w.length >= 8 ? 2 : 1));
}
