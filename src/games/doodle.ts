import { BOLD, C, REVERSE, cells, clean, fit, pad, seatColor, type Surface } from './term/canvas.js';
import { bigText, bigWidth } from './term/font.js';
import type { Key } from './term/keys.js';
import type { GameClient, GameDef, GameLogic, HostCtx, Player, SideLine, Standing, ViewCtx } from './types.js';
import type { Rng } from './rng.js';
import { ADULT_EASY, ADULT_HARD, ADULT_MEDIUM, EASY, HARD, MEDIUM, accepts, isClose, words } from './words.js';

// DOODLE GUESS — one player draws a secret word on a shared canvas while
// everyone else races to guess it. The canvas is drawn with half-block
// characters, so every terminal cell holds two square pixels; the artist
// moves a brush with the arrow keys, picks colors with 1-9, and has fill,
// undo and brush sizes. Faster guesses score more, the artist scores for
// every correct guess, and letters get revealed as time runs out. Anyone who
// walks up mid-game is dealt straight in.

const TICK = 100;
const SEC = 10;
const PAPER = 15;
const PALETTE = [0, 9, 3, 11, 10, 12, 5, 13, 8]; // keys 1-9
const ERASER = -1;
const HEX = '0123456789abcdef';
const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];

interface Artist {
  slot: number;
  nick: string;
  score: number;
  gain: number;
  solved: boolean;
  solvedIn: number;
  guessed: number;
  drawPoints: number;
  out: boolean;
}

interface LogEntry {
  slot: number;
  text: string;
  kind: 0 | 1 | 2 | 3; // 0 guess/chat, 1 solved notice, 2 "close!" (private), 3 system
  to?: number; // private to this seat
  inner?: boolean; // only the artist and those who solved can read it
}

export interface DoodleView {
  cw: number; // canvas width (pixels = columns)
  ch: number; // canvas height (pixels = 2 per row)
  px: string; // run-length encoded pixels
  cur: number[]; // [x, y, pen, color, size]
  ph: 'choose' | 'draw' | 'reveal' | 'over';
  t: number;
  dr: number; // artist's seat
  w: string; // the word, when this viewer may see it
  h: string; // hint pattern for guessers
  o: string[]; // word choices (artist, while choosing)
  sv: number[]; // seats that solved it
  log: [number, string, number][];
  sc: number[][]; // [slot, score, gain, solved, out]
  r: number;
  R: number;
  a?: number; // 1 when 18+ words are on
}

/** Word lists for the three choices an artist gets each turn. */
type Pool = { easy: string[]; medium: string[]; hard: string[] };

class DoodleGame implements GameLogic {
  readonly tickMs = TICK;
  done = false;
  private readonly CW: number;
  private readonly CH: number;
  private px: Uint8Array;
  private readonly cur = { x: 0, y: 0, pen: false, color: 0, size: 1 };
  private undo: Uint8Array[] = [];
  private readonly players: Artist[];
  private order: number[];
  private turn = -1;
  private round = 1;
  private readonly rounds: number;
  private readonly drawTime: number;
  private readonly hints: boolean;
  private readonly pool: Pool;
  /** "Mixed in": 18+ words, one of which is offered every turn. */
  private readonly spicy: Pool | null;
  private readonly adult: boolean;
  private readonly used = new Set<string>();
  private phase: DoodleView['ph'] = 'choose';
  private phaseT = 0;
  private drawer = -1;
  private word = '';
  private opts: string[] = [];
  private revealed = new Set<number>();
  private log: LogEntry[] = [];
  private readonly rng: Rng;
  private rle = '';
  private dirty = true;
  private fastest: { nick: string; secs: number } | null = null;

  constructor(private readonly ctx: HostCtx) {
    const st = ctx.settings;
    this.rng = ctx.rng;
    this.rounds = typeof st.rounds === 'number' ? st.rounds : 2;
    this.drawTime = (typeof st.time === 'number' ? st.time : 80) * SEC;
    this.hints = st.hints !== 'off';
    const pack = st.words === 'easy' ? 'easy' : st.words === 'hard' ? 'hard' : 'mixed';
    const tiers = (e: string[], m: string[], h: string[]): Pool =>
      pack === 'easy' ? { easy: e, medium: e, hard: m } : pack === 'hard' ? { easy: m, medium: h, hard: h } : { easy: e, medium: m, hard: h };
    const adult = st.adult === 'mix' || st.adult === 'only' ? st.adult : 'off';
    const clean = tiers(words(EASY), words(MEDIUM), words(HARD));
    const spicy = tiers(words(ADULT_EASY), words(ADULT_MEDIUM), words(ADULT_HARD));
    this.pool = adult === 'only' ? spicy : clean;
    this.spicy = adult === 'mix' ? spicy : null;
    this.adult = adult !== 'off';
    const side = ctx.arena.cols >= 111;
    const availW = (side ? ctx.arena.cols - 31 : ctx.arena.cols) - 2;
    const availRows = ctx.arena.rows - 2 - 4;
    this.CW = Math.max(40, Math.min(availW, 76));
    this.CH = Math.max(10, Math.min(availRows, 20)) * 2;
    this.px = new Uint8Array(this.CW * this.CH).fill(PAPER);
    this.players = ctx.players.map((p) => ({ slot: p.slot, nick: p.nick, score: 0, gain: 0, solved: false, solvedIn: 0, guessed: 0, drawPoints: 0, out: false }));
    this.order = this.rng.shuffle(ctx.players.map((p) => p.slot));
    // Said in the table chat, which every version shows, so nobody is surprised.
    if (this.adult) ctx.feed(adult === 'only' ? '18+ words only this match' : '18+ words are mixed in this match');
    this.nextTurn();
  }

  // ---- turns ----

  private active(): Artist[] {
    return this.players.filter((p) => !p.out);
  }

  private nextTurn(): void {
    if (this.active().length < 2) {
      this.finish();
      return;
    }
    for (;;) {
      this.turn++;
      if (this.turn >= this.order.length) {
        this.turn = 0;
        this.round++;
        if (this.round > this.rounds) {
          this.finish();
          return;
        }
      }
      const slot = this.order[this.turn]!;
      if (this.players.find((p) => p.slot === slot && !p.out)) break;
    }
    this.drawer = this.order[this.turn]!;
    this.phase = 'choose';
    this.phaseT = 15 * SEC;
    this.word = '';
    this.revealed.clear();
    this.opts = this.pickWords();
    this.px.fill(PAPER);
    this.undo = [];
    this.dirty = true;
    Object.assign(this.cur, { x: this.CW >> 1, y: this.CH >> 1, pen: false, color: 0, size: 1 });
    for (const p of this.players) {
      p.solved = false;
      p.gain = 0;
    }
    this.log = this.log.slice(-6);
    this.say(`round ${this.round}/${this.rounds} · ${this.nick(this.drawer)} is up`, 3);
  }

  private pickWords(): string[] {
    const out: string[] = [];
    const lists = [this.pool.easy, this.pool.medium, this.pool.hard];
    if (this.spicy) {
      const k = this.rng.int(3); // one of the three choices is an 18+ word
      lists[k] = [this.spicy.easy, this.spicy.medium, this.spicy.hard][k]!;
    }
    for (const list of lists) {
      const fresh = list.filter((w) => !this.used.has(w) && !out.includes(w));
      const from = fresh.length ? fresh : list.filter((w) => !out.includes(w));
      if (from.length) out.push(this.rng.pick(from));
    }
    return out;
  }

  private choose(i: number): void {
    const w = this.opts[i] ?? this.opts[0];
    if (!w || this.phase !== 'choose') return;
    this.word = w;
    this.used.add(w);
    this.phase = 'draw';
    this.phaseT = this.drawTime;
    this.ctx.feed(`${this.nick(this.drawer)} is drawing — type your guesses!`, this.drawer);
  }

  private revealTurn(why: string): void {
    this.phase = 'reveal';
    this.phaseT = 6 * SEC;
    const solvers = this.players.filter((p) => p.solved).length;
    const guessers = this.active().filter((p) => p.slot !== this.drawer).length;
    const artist = this.players.find((p) => p.slot === this.drawer);
    if (artist && solvers > 0 && solvers === guessers && guessers > 1) {
      artist.score += 30;
      artist.gain += 30;
      artist.drawPoints += 30;
    }
    this.say(`${why} — the word was "${this.word}"`, 3);
    this.ctx.feed(`the word was "${this.word}" (${solvers}/${guessers} got it)`);
  }

  private finish(): void {
    this.phase = 'over';
    this.done = true;
  }

  private nick(slot: number): string {
    return this.players.find((p) => p.slot === slot)?.nick ?? '?';
  }

  private say(text: string, kind: LogEntry['kind'], slot = -1, extra: Partial<LogEntry> = {}): void {
    this.log.push({ slot, text: text.slice(0, 80), kind, ...extra });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  // ---- players coming and going ----

  addPlayer(p: Player): boolean {
    if (this.players.some((x) => x.slot === p.slot)) return false;
    this.players.push({ slot: p.slot, nick: p.nick, score: 0, gain: 0, solved: false, solvedIn: 0, guessed: 0, drawPoints: 0, out: false });
    this.order.push(p.slot);
    this.say(`${p.nick} joined — they draw later this round`, 3);
    return true;
  }

  drop(slot: number): void {
    const p = this.players.find((x) => x.slot === slot);
    if (!p || p.out) return;
    p.out = true;
    if (this.active().length < 2) {
      this.finish();
      return;
    }
    if (slot === this.drawer && (this.phase === 'choose' || this.phase === 'draw')) {
      if (this.phase === 'choose') this.nextTurn();
      else this.revealTurn(`${p.nick} left mid-drawing`);
    } else this.checkAllSolved();
  }

  // ---- simulation ----

  tick(): void {
    if (this.done) return;
    this.phaseT--;
    if (this.phase === 'choose') {
      if (this.phaseT <= 0) this.choose(this.rng.int(this.opts.length));
    } else if (this.phase === 'draw') {
      const used = this.drawTime - this.phaseT;
      if (this.hints && (used === Math.floor(this.drawTime * 0.5) || used === Math.floor(this.drawTime * 0.75))) this.revealLetter();
      if (this.phaseT <= 0) this.revealTurn('time is up');
    } else if (this.phase === 'reveal') {
      if (this.phaseT <= 0) this.nextTurn();
    }
  }

  private revealLetter(): void {
    const hidden = [...this.word].map((c, i) => (/[a-z]/i.test(c) && !this.revealed.has(i) ? i : -1)).filter((i) => i >= 0);
    if (hidden.length <= 2) return; // never give the whole word away
    this.revealed.add(this.rng.pick(hidden));
    this.say('hint: a letter was revealed', 3);
  }

  input(slot: number, data: unknown): void {
    const p = this.players.find((x) => x.slot === slot && !x.out);
    const o = data as Record<string, unknown> | null;
    if (!p || !o || typeof o !== 'object' || typeof o.a !== 'string') return;
    if (o.a === 'guess') {
      if (typeof o.t === 'string') this.guess(p, o.t);
      return;
    }
    if (slot !== this.drawer) return;
    if (o.a === 'pick') {
      if (typeof o.i === 'number') this.choose(Math.floor(o.i));
      return;
    }
    if (this.phase !== 'draw') return;
    const c = this.cur;
    switch (o.a) {
      case 'mv': {
        const d = DIRS[typeof o.d === 'number' ? o.d : -1];
        if (!d) return;
        c.x = Math.max(0, Math.min(this.CW - 1, c.x + d[0]));
        c.y = Math.max(0, Math.min(this.CH - 1, c.y + d[1]));
        if (c.pen) this.stamp();
        break;
      }
      case 'pen':
        c.pen = !c.pen;
        if (c.pen) {
          this.snapshot();
          this.stamp();
        }
        break;
      case 'col':
        if (o.c === ERASER) c.color = ERASER;
        else if (typeof o.c === 'number' && o.c >= 0 && o.c < PALETTE.length) c.color = Math.floor(o.c);
        break;
      case 'size':
        if (o.s === 1 || o.s === -1) c.size = Math.max(1, Math.min(3, c.size + o.s));
        break;
      case 'fill':
        this.snapshot();
        this.fill();
        break;
      case 'undo': {
        const prev = this.undo.pop();
        if (prev) {
          this.px = prev;
          this.dirty = true;
        }
        break;
      }
      case 'clear':
        this.snapshot();
        this.px.fill(PAPER);
        this.dirty = true;
        break;
      default:
        break;
    }
  }

  private ink(): number {
    return this.cur.color === ERASER ? PAPER : PALETTE[this.cur.color]!;
  }

  private snapshot(): void {
    this.undo.push(this.px.slice());
    if (this.undo.length > 25) this.undo.shift();
  }

  private stamp(): void {
    const r = this.cur.size - 1;
    const col = this.ink();
    for (let y = this.cur.y - r; y <= this.cur.y + r; y++)
      for (let x = this.cur.x - r; x <= this.cur.x + r; x++)
        if (x >= 0 && y >= 0 && x < this.CW && y < this.CH) this.px[y * this.CW + x] = col;
    this.dirty = true;
  }

  private fill(): void {
    const start = this.cur.y * this.CW + this.cur.x;
    const from = this.px[start]!;
    const to = this.ink();
    if (from === to) return;
    const q = [start];
    this.px[start] = to;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!;
      const x = i % this.CW;
      const y = Math.floor(i / this.CW);
      for (const [dx, dy] of DIRS.slice(0, 4)) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.CW || ny >= this.CH) continue;
        const n = ny * this.CW + nx;
        if (this.px[n] !== from) continue;
        this.px[n] = to;
        q.push(n);
      }
    }
    this.dirty = true;
  }

  private guess(p: Artist, raw: string): void {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) return;
    const drawing = this.phase === 'draw';
    if (!drawing || p.slot === this.drawer || p.solved) {
      // Chat. While a word is live, solvers and the artist talk among themselves.
      this.say(text, 0, p.slot, { inner: drawing && (p.solved || p.slot === this.drawer) });
      return;
    }
    if (accepts(this.word, text)) {
      this.solve(p);
      return;
    }
    if (isClose(this.word, text)) this.say(`"${text}" is close!`, 2, p.slot, { to: p.slot });
    this.say(text, 0, p.slot);
  }

  private solve(p: Artist): void {
    const order = this.players.filter((x) => x.solved).length;
    const left = Math.max(0, this.phaseT) / this.drawTime;
    const pts = 50 + Math.round(150 * left) + (order === 0 ? 40 : order === 1 ? 20 : 0);
    p.solved = true;
    p.solvedIn = Math.round((this.drawTime - this.phaseT) / SEC);
    p.score += pts;
    p.gain += pts;
    p.guessed++;
    if (!this.fastest || p.solvedIn < this.fastest.secs) this.fastest = { nick: p.nick, secs: p.solvedIn };
    const artist = this.players.find((x) => x.slot === this.drawer);
    if (artist) {
      artist.score += 35;
      artist.gain += 35;
      artist.drawPoints += 35;
    }
    this.say(`${p.nick} guessed it! (+${pts})`, 1, p.slot);
    this.ctx.feed(`${p.nick} guessed the word (+${pts})`, p.slot);
    // Don't let the clock drag once most people have it.
    if (order === 0 && this.phaseT > 25 * SEC) this.phaseT = Math.max(25 * SEC, Math.floor(this.phaseT * 0.7));
    this.checkAllSolved();
  }

  private checkAllSolved(): void {
    if (this.phase !== 'draw') return;
    const guessers = this.active().filter((p) => p.slot !== this.drawer);
    if (guessers.length && guessers.every((p) => p.solved)) this.revealTurn('everyone got it');
  }

  // ---- views ----

  private encode(): string {
    if (!this.dirty) return this.rle;
    const out: string[] = [];
    let run = 1;
    for (let i = 1; i <= this.px.length; i++) {
      if (i < this.px.length && this.px[i] === this.px[i - 1]) {
        run++;
        continue;
      }
      out.push(HEX[this.px[i - 1]!]! + (run > 1 ? run.toString(36) : ''));
      run = 1;
    }
    this.rle = out.join(',');
    this.dirty = false;
    return this.rle;
  }

  private hint(): string {
    return [...this.word].map((c, i) => (/[a-z]/i.test(c) ? (this.revealed.has(i) ? c : '_') : c)).join('');
  }

  view(slot: number | null): DoodleView {
    const me = this.players.find((p) => p.slot === slot);
    const isArtist = slot !== null && slot === this.drawer;
    const insider = isArtist || !!me?.solved || this.phase === 'reveal' || this.phase === 'over';
    const log = this.log
      .filter((e) => (e.to === undefined || e.to === slot) && (!e.inner || insider))
      .slice(-14)
      .map((e): [number, string, number] => [e.slot, e.text, e.kind]);
    return {
      cw: this.CW,
      ch: this.CH,
      px: this.encode(),
      cur: [this.cur.x, this.cur.y, this.cur.pen ? 1 : 0, this.cur.color, this.cur.size],
      ph: this.phase,
      t: Math.max(0, Math.ceil(this.phaseT / SEC)),
      dr: this.drawer,
      w: (this.phase === 'draw' && insider) || this.phase === 'reveal' || this.phase === 'over' ? this.word : '',
      h: this.phase === 'draw' ? this.hint() : '',
      o: this.phase === 'choose' && isArtist ? this.opts : [],
      sv: this.players.filter((p) => p.solved).map((p) => p.slot),
      log,
      sc: this.players.map((p) => [p.slot, p.score, p.gain, p.solved ? 1 : 0, p.out ? 1 : 0]),
      r: Math.min(this.round, this.rounds),
      R: this.rounds,
      ...(this.adult ? { a: 1 } : {}),
    };
  }

  standings(): Standing[] {
    return [...this.players]
      .sort((a, b) => Number(a.out) - Number(b.out) || b.score - a.score)
      .map((p) => ({ slot: p.slot, nick: p.nick, score: p.score, detail: `${p.guessed} guessed · ${p.drawPoints} pts from drawing${p.out ? ' · left' : ''}` }));
  }

  summary(): string[] {
    const lines: string[] = [];
    if (this.fastest) lines.push(`quickest guess: ${this.fastest.nick} in ${this.fastest.secs}s`);
    const artist = [...this.players].sort((a, b) => b.drawPoints - a.drawPoints)[0];
    if (artist && artist.drawPoints) lines.push(`best artist: ${artist.nick} (+${artist.drawPoints} from drawings)`);
    return lines;
  }
}

// ---- client ----

function asView(f: unknown): DoodleView | null {
  const v = f as DoodleView;
  if (!v || typeof v !== 'object' || typeof v.px !== 'string' || !Array.isArray(v.cur) || !Array.isArray(v.sc)) return null;
  if (!Number.isInteger(v.cw) || !Number.isInteger(v.ch) || v.cw < 8 || v.ch < 4 || v.cw > 160 || v.ch > 100) return null;
  return { ...v, sc: v.sc.slice(0, 16), log: Array.isArray(v.log) ? v.log.slice(-20) : [], sv: Array.isArray(v.sv) ? v.sv.slice(0, 16) : [], o: Array.isArray(v.o) ? v.o.slice(0, 3) : [] }; // cap list sizes from the network
}

function decode(rle: string, n: number): Uint8Array {
  const px = new Uint8Array(n).fill(PAPER);
  let i = 0;
  for (const run of rle.split(',')) {
    if (!run) continue;
    const col = HEX.indexOf(run[0]!);
    const len = run.length > 1 ? parseInt(run.slice(1), 36) : 1;
    if (col < 0 || !Number.isFinite(len)) break;
    px.fill(col, i, Math.min(n, i + len));
    i += len;
    if (i >= n) break;
  }
  return px;
}

class DoodleClient implements GameClient {
  private sel = 0;
  private cache: { rle: string; n: number; px: Uint8Array } = { rle: "", n: 0, px: new Uint8Array(0) };

  measure(frame: unknown, aw: number, ah: number): { w: number; h: number } | null {
    const v = asView(frame);
    if (!v) return null;
    const w = v.cw + 2;
    const h = v.ch / 2 + 4;
    return w <= aw && h <= ah ? { w, h } : null;
  }

  need(frame: unknown): { w: number; h: number } {
    const v = asView(frame);
    return v ? { w: v.cw + 2, h: v.ch / 2 + 4 } : { w: 60, h: 24 };
  }

  private artist(v: DoodleView, ctx: ViewCtx): boolean {
    return ctx.me !== null && v.dr === ctx.me;
  }

  prompt(frame: unknown, ctx: ViewCtx): string | null {
    const v = asView(frame);
    if (!v || ctx.me === null || v.ph === 'over') return null;
    if (this.artist(v, ctx)) return null;
    if (v.ph === 'draw') return v.sv.includes(ctx.me) ? 'chat (only solvers see it)' : 'guess';
    return 'chat';
  }

  submit(text: string): unknown {
    return { a: 'guess', t: text.slice(0, 60) };
  }

  key(k: Key, frame: unknown, ctx: ViewCtx): unknown {
    const v = asView(frame);
    if (!v || !this.artist(v, ctx) || k.ctrl || k.meta) return undefined;
    if (v.ph === 'choose') {
      const n = v.o.length || 1;
      if (k.name === 'up' || k.name === 'left') {
        this.sel = (this.sel - 1 + n) % n;
        return null;
      }
      if (k.name === 'down' || k.name === 'right') {
        this.sel = (this.sel + 1) % n;
        return null;
      }
      if (k.name === 'enter' || k.name === 'space') return { a: 'pick', i: this.sel };
      if (['1', '2', '3'].includes(k.name)) return { a: 'pick', i: Number(k.name) - 1 };
      return undefined;
    }
    if (v.ph !== 'draw') return undefined;
    const move: Record<string, number> = { up: 0, right: 1, down: 2, left: 3, home: 4, pageup: 5, end: 6, pagedown: 7 };
    if (k.name in move) return { a: 'mv', d: move[k.name] };
    if (k.name === 'space') return { a: 'pen' };
    if (/^[1-9]$/.test(k.name)) return { a: 'col', c: Number(k.name) - 1 };
    if (k.name === '0' || k.name === 'e') return { a: 'col', c: ERASER };
    if (k.name === '+' || k.name === '=' || k.name === ']') return { a: 'size', s: 1 };
    if (k.name === '-' || k.name === '[') return { a: 'size', s: -1 };
    if (k.name === 'f') return { a: 'fill' };
    if (k.name === 'u' || k.name === 'z') return { a: 'undo' };
    if (k.name === 'c') return { a: 'clear' };
    return undefined;
  }

  help(frame: unknown, ctx: ViewCtx): string {
    const v = asView(frame);
    if (!v) return '';
    if (this.artist(v, ctx)) {
      if (v.ph === 'choose') return '↑↓ pick a word · Enter confirm (or 1 2 3)';
      if (v.ph === 'draw') return 'arrows draw · Space pen · 1-9 color · 0 erase · +/- size · F fill · U undo · C clear';
    }
    return 'type to guess · Enter send';
  }

  status(frame: unknown): string {
    const v = asView(frame);
    if (!v) return '';
    return `round ${v.r}/${v.R} · ${v.ph === 'choose' ? 'picking' : v.ph === 'draw' ? 'drawing' : 'reveal'} · ${v.t}s${v.a ? ' · 18+' : ''}`;
  }

  scoreboard(frame: unknown, ctx: ViewCtx): SideLine[] {
    const v = asView(frame);
    if (!v) return [];
    const lines: SideLine[] = [];
    for (const r of [...v.sc].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
      const [slot = 0, score = 0, gain = 0, solved = 0, out = 0] = r;
      const tag = slot === v.dr ? ' (art)' : solved ? ' √' : out ? ' (left)' : '';
      lines.push({
        slot,
        text: `${pad(fit(ctx.nick(slot), 11), 11)} ${pad(String(score), 4, 'right')}${v.ph === 'reveal' && gain ? ` +${gain}` : ''}${tag}`,
        fg: slot === ctx.me ? C.bwhite : solved ? C.bgreen : out ? C.gray : -1,
        at: slot === ctx.me ? BOLD : 0,
      });
    }
    lines.push({ text: '' });
    // The game's own guess feed.
    for (const [slot, text, kind] of v.log.slice(-10)) {
      const who = slot >= 0 ? `${fit(ctx.nick(slot), 10)}: ` : '';
      if (kind === 1) lines.push({ text: `* ${text}`, fg: C.bgreen, at: BOLD });
      else if (kind === 2) lines.push({ text, fg: C.byellow, at: BOLD });
      else if (kind === 3) lines.push({ text: `· ${text}`, fg: C.gray });
      else lines.push({ text: `${who}${text}`, fg: slot >= 0 ? seatColor(slot) : -1 });
    }
    return lines;
  }

  draw(s: Surface, frame: unknown, ctx: ViewCtx): void {
    const v = asView(frame);
    if (!v) return;
    const W = v.cw;
    const rows = v.ch / 2;
    const n = v.cw * v.ch;
    if (this.cache.rle !== v.px || this.cache.n !== n) this.cache = { rle: v.px, n, px: decode(v.px, n) };
    const px = this.cache.px;
    const artist = this.artist(v, ctx);
    const blink = Math.floor(ctx.now / 300) % 2 === 0;
    const accent = seatColor(v.dr);
    // word / hint line
    s.fill(0, 0, s.w, 1, ' ', -1, -1);
    if (v.ph === 'draw') {
      if (artist) s.text(0, 0, ` DRAW: ${v.w.toUpperCase()} `, C.black, C.byellow, BOLD);
      else if (v.w) s.text(0, 0, ` YOU GOT IT: ${v.w.toUpperCase()} `, C.black, C.bgreen, BOLD);
      else {
        const pattern = [...v.h].map((c) => (c === ' ' ? '  ' : c + ' ')).join('').trim();
        s.text(0, 0, `${ctx.nick(v.dr)} draws: `, accent, -1, BOLD);
        s.text(cells(`${ctx.nick(v.dr)} draws: `), 0, fit(pattern, s.w - 30), C.bwhite, -1, BOLD);
        s.text(cells(`${ctx.nick(v.dr)} draws: `) + Math.min(cells(pattern), s.w - 30) + 1, 0, `(${v.h.replace(/[^a-z_]/gi, '').length})`, C.gray);
      }
    } else if (v.ph === 'choose') s.text(0, 0, artist ? ' YOUR TURN — pick something to draw ' : `${ctx.nick(v.dr)} is picking a word…`, artist ? C.black : accent, artist ? C.byellow : -1, BOLD);
    else s.text(0, 0, ` the word was: ${v.w.toUpperCase()} `, C.black, C.bcyan, BOLD);
    const clock = `${v.t}s`;
    s.text(s.w - cells(clock) - 1, 0, clock, v.t <= 10 && v.ph === 'draw' ? (blink ? C.bred : C.bwhite) : C.bwhite, -1, BOLD);
    // canvas
    s.box(0, 1, W + 2, rows + 2, accent, -1, 'single');
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < W; x++) {
        const top = px[r * 2 * W + x]!;
        const bot = px[(r * 2 + 1) * W + x]!;
        if (ctx.color) {
          if (top === bot) s.put(1 + x, 2 + r, '█', top, -1, 0);
          else s.put(1 + x, 2 + r, '▀', top, bot, 0);
        } else {
          const t = top !== PAPER;
          const b = bot !== PAPER;
          s.put(1 + x, 2 + r, t && b ? '█' : t ? '▀' : b ? '▄' : ' ', -1, -1, 0);
        }
      }
    }
    // the brush, visible to everyone so the artist can point at things
    const [cx = 0, cy = 0, pen = 0, color = 0, size = 1] = v.cur;
    if (v.ph === 'draw') {
      const ink = color === ERASER ? PAPER : PALETTE[color] ?? 0;
      const r = Math.floor(cy / 2);
      const under = px[(cy % 2 ? cy - 1 : cy + 1) * W + cx] ?? PAPER;
      const mark = pen ? ink : blink ? 0 : 9;
      if (ctx.color) {
        if (cy % 2 === 0) s.put(1 + cx, 2 + r, '▀', mark, under, 0);
        else s.put(1 + cx, 2 + r, '▄', mark, under, 0);
      } else s.put(1 + cx, 2 + r, pen ? '●' : '+', -1, -1, REVERSE);
    }
    // toolbar
    const ty = rows + 3;
    if (artist && v.ph === 'draw') {
      let x = 0;
      PALETTE.forEach((c, i) => {
        const on = color === i;
        x += s.text(x, ty, `${i + 1}`, on ? C.bwhite : C.gray, -1, on ? BOLD | REVERSE : 0);
        x += s.text(x, ty, '██', c, -1, 0);
        x += 1;
      });
      x += s.text(x, ty, '0', color === ERASER ? C.bwhite : C.gray, -1, color === ERASER ? BOLD | REVERSE : 0);
      x += s.text(x, ty, '░░', C.bwhite) + 2;
      x += s.text(x, ty, `size ${'■'.repeat(Math.max(1, Math.min(3, size)))}${'□'.repeat(3 - Math.max(1, Math.min(3, size)))}`, C.bwhite) + 2;
      s.text(x, ty, pen ? 'PEN DOWN' : 'pen up', pen ? C.black : C.gray, pen ? C.bgreen : -1, BOLD);
    } else if (v.ph === 'draw') {
      const solved = v.sv.length;
      const guessers = v.sc.filter((r) => !r[4] && r[0] !== v.dr).length;
      s.text(0, ty, `${ctx.nick(v.dr)} is drawing · ${solved}/${guessers} guessed`, C.gray);
    }
    // overlays
    if (v.ph === 'choose' && artist && v.o.length) this.chooser(s, v, rows);
    if (v.ph === 'reveal') this.revealBox(s, v, rows, ctx);
    const me = ctx.me;
    const close = me !== null ? v.log.slice(-3).filter((e) => e[2] === 2).slice(-1)[0] : undefined;
    if (close && v.ph === 'draw' && !artist) s.text(1, rows + 1, ` ${fit(String(close[1]), W - 2)} `, C.black, C.byellow, BOLD);
  }

  private chooser(s: Surface, v: DoodleView, rows: number): void {
    const w = Math.min(s.w - 6, 40);
    const h = v.o.length + 4;
    const x = (s.w - w) >> 1;
    const y = 2 + Math.max(0, (rows - h) >> 1);
    s.fill(x, y, w, h, ' ', -1, C.black);
    s.box(x, y, w, h, C.byellow, C.black, 'double', 'PICK A WORD', C.byellow);
    const tags = ['easy', 'medium', 'hard'];
    v.o.forEach((word, i) => {
      const on = i === this.sel;
      const line = `${i + 1}  ${pad(word, w - 16)} ${tags[i] ?? ''}`;
      s.text(x + 2, y + 2 + i, pad(line, w - 4), on ? C.black : C.bwhite, on ? C.byellow : C.black, BOLD);
    });
  }

  private revealBox(s: Surface, v: DoodleView, rows: number, ctx: ViewCtx): void {
    const word = v.w.toUpperCase();
    const gains = v.sc.filter((r) => (r[2] ?? 0) > 0).sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0));
    const fitsBig = /^[A-Z0-9 !:-]+$/.test(word) && bigWidth(word, 'half') + 6 < s.w;
    const w = Math.min(s.w - 4, Math.max(30, fitsBig ? bigWidth(word, 'half') + 6 : word.length + 8));
    const h = Math.min(rows, 6 + Math.min(gains.length, 5));
    const x = (s.w - w) >> 1;
    const y = 2 + Math.max(0, (rows - h) >> 1);
    s.fill(x, y, w, h, ' ', -1, C.black);
    s.box(x, y, w, h, C.bcyan, C.black, 'double', 'THE WORD WAS', C.bcyan);
    if (fitsBig) bigText(s, x + ((w - bigWidth(word, 'half')) >> 1), y + 1, word, C.bwhite, 'half');
    else s.center(y + 2, word, C.bwhite, C.black, BOLD, x, w);
    gains.slice(0, Math.max(0, h - 6)).forEach((r, i) => {
      const [slot = 0, , gain = 0] = r;
      s.text(x + 3, y + 5 + i, `${pad(fit(ctx.nick(slot), 14), 14)} +${gain}`, seatColor(slot), C.black, BOLD);
    });
  }
}

export const doodleGame: GameDef = {
  id: 'doodle',
  title: 'Doodle Guess',
  tag: 'draw it, they guess it',
  genre: 'party',
  min: 2,
  max: 12,
  bots: false,
  accent: C.bmagenta,
  about:
    'Take turns drawing a secret word on a shared canvas while everyone else types guesses. The quicker you guess, the more you score, and the artist earns points for every right answer. Close guesses get a private nudge and letters are revealed as the clock runs down. People who walk up mid-game are dealt straight in. The host can turn on 18+ words.',
  controls: ['artist: arrows move the brush · Space pen up/down', '        1-9 colors · 0 eraser · +/- size · F fill · U undo', 'guessers: just type and press Enter'],
  art: ['┌────────────────────┐', '│███████▀▀▀▀▀▀▀██████│', '│█████▀  ▄▄▄  ▀██████│', '│████   █   █   █████│', '│█████▄  ▀▀▀  ▄██████│', '└────────────────────┘'],
  settings: [
    { key: 'rounds', label: 'Rounds', choices: [{ v: 2, label: '2 (everyone draws twice)' }, { v: 3, label: '3' }, { v: 1, label: '1' }] },
    { key: 'time', label: 'Draw time', choices: [{ v: 80, label: '80 seconds' }, { v: 60, label: '60 seconds' }, { v: 100, label: '100 seconds' }] },
    { key: 'words', label: 'Words', choices: [{ v: 'mixed', label: 'Mixed' }, { v: 'easy', label: 'Easy' }, { v: 'hard', label: 'Hard' }] },
    { key: 'hints', label: 'Letter hints', choices: [{ v: 'on', label: 'On' }, { v: 'off', label: 'Off' }] },
    { key: 'adult', label: '18+ words', choices: [{ v: 'off', label: 'Off' }, { v: 'mix', label: 'Mixed in' }, { v: 'only', label: 'Only 18+' }] },
  ],
  create: (ctx) => new DoodleGame(ctx),
  client: () => new DoodleClient(),
};
