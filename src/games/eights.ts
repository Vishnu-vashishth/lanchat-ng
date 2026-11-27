import { BOLD, C, DIM, cells, fit, pad, seatColor, type Surface } from './term/canvas.js';
import type { Key } from './term/keys.js';
import type { GameClient, GameDef, GameLogic, HostCtx, SideLine, Standing, ViewCtx } from './types.js';
import type { Rng } from './rng.js';

// CRAZY EIGHTS — the classic shedding game. Match the top card by suit or
// rank, eights are wild (you name the next suit), first to empty their hand
// takes the points left in everyone else's. With action cards on, a 2 makes
// the next player draw two (stackable), a Jack skips them and an Ace reverses
// the order. Each player only ever receives their own hand.

const TICK = 100;
const SEC = 10;
const RANKS = 'A23456789TJQK';
const SUITS = 'shdc';
const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_NAME: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

const rankOf = (c: string) => c[0]!;
const suitOf = (c: string) => c[1]!;
const label = (c: string) => (rankOf(c) === 'T' ? '10' : rankOf(c));
const value = (c: string) => {
  const r = rankOf(c);
  if (r === '8') return 50;
  if (r === 'A') return 1;
  if ('TJQK'.includes(r)) return 10;
  return Number(r);
};

interface Seat {
  slot: number;
  nick: string;
  bot: boolean;
  hand: string[];
  score: number;
  won: number;
  out: boolean;
  botWait: number;
}

export interface EightsView {
  me: string[]; // my hand
  ok: number[]; // indexes of my playable cards
  top: string;
  suit: string;
  turn: number; // slot to move
  dir: number;
  pend: number; // cards the next draw must take
  drew: number; // the player to move has already drawn this turn
  pile: number;
  seats: number[][]; // [slot, cards, score, out]
  t: number; // seconds left on the turn
  ph: 'play' | 'hand' | 'over';
  hand: number;
  H: number;
  log: string[];
  msg: string;
  act: number; // action cards on
}

class EightsGame implements GameLogic {
  readonly tickMs = TICK;
  done = false;
  private deck: string[] = [];
  private discard: string[] = [];
  private readonly seats: Seat[];
  private cur = 0;
  private dir = 1;
  private suit = 's';
  private pending = 0;
  private drew = false;
  private turnT = 0;
  private readonly turnLimit: number;
  private readonly actions: boolean;
  private readonly hands: number;
  private handNo = 1;
  private starter = 0;
  private phase: EightsView['ph'] = 'play';
  private phaseT = 0;
  private log: string[] = [];
  private msg = '';
  private readonly rng: Rng;

  constructor(private readonly ctx: HostCtx) {
    const st = ctx.settings;
    this.rng = ctx.rng;
    this.actions = st.actions !== 'off';
    this.hands = typeof st.hands === 'number' ? st.hands : 3;
    this.turnLimit = (typeof st.turn === 'number' ? st.turn : 30) * SEC;
    this.seats = ctx.players.map((p) => ({ slot: p.slot, nick: p.nick, bot: p.bot, hand: [], score: 0, won: 0, out: false, botWait: 0 }));
    this.starter = this.rng.int(this.seats.length);
    this.deal();
  }

  // ---- deck and dealing ----

  private deal(): void {
    this.deck = this.rng.shuffle([...RANKS].flatMap((r) => [...SUITS].map((s) => r + s)));
    this.discard = [];
    const per = this.live().length <= 4 ? 7 : 5;
    for (const s of this.seats) s.hand = s.out ? [] : this.deck.splice(0, per);
    // Never start on an eight.
    let i = this.deck.findIndex((c) => rankOf(c) !== '8' && (!this.actions || !'2JA'.includes(rankOf(c))));
    if (i < 0) i = 0;
    const [first] = this.deck.splice(i, 1);
    this.discard.push(first!);
    this.suit = suitOf(first!);
    this.dir = 1;
    this.pending = 0;
    this.cur = this.nextLive(this.starter - 1, 1);
    this.startTurn();
    this.say(`hand ${this.handNo}: ${this.seat().nick} starts`);
  }

  private live(): Seat[] {
    return this.seats.filter((s) => !s.out);
  }

  private seat(): Seat {
    return this.seats[this.cur]!;
  }

  private nextLive(from: number, dir: number): number {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (!this.seats[i]!.out) return i;
    }
    return from;
  }

  private draw(n: number): string[] {
    const got: string[] = [];
    for (let k = 0; k < n; k++) {
      if (!this.deck.length) {
        // Reshuffle everything but the top card back into the stock.
        const top = this.discard.pop()!;
        this.deck = this.rng.shuffle(this.discard);
        this.discard = [top];
        if (!this.deck.length) break;
      }
      got.push(this.deck.pop()!);
    }
    return got;
  }

  private top(): string {
    return this.discard[this.discard.length - 1]!;
  }

  private playable(card: string): boolean {
    if (this.pending > 0) return rankOf(card) === '2';
    return rankOf(card) === '8' || suitOf(card) === this.suit || rankOf(card) === rankOf(this.top());
  }

  private say(line: string): void {
    this.log.push(line.slice(0, 80));
    if (this.log.length > 30) this.log.shift();
  }

  // ---- turns ----

  private startTurn(): void {
    this.drew = false;
    this.turnT = this.turnLimit;
    const s = this.seat();
    s.botWait = s.bot ? 6 + this.rng.int(8) : 0;
  }

  private advance(skip = false): void {
    this.cur = this.nextLive(this.cur, this.dir);
    if (skip) this.cur = this.nextLive(this.cur, this.dir);
    this.startTurn();
  }

  private play(s: Seat, idx: number, suit?: string): boolean {
    const card = s.hand[idx];
    if (!card || !this.playable(card)) return false;
    const r = rankOf(card);
    if (r === '8' && (!suit || !SUITS.includes(suit))) return false;
    s.hand.splice(idx, 1);
    this.discard.push(card);
    this.suit = r === '8' ? suit! : suitOf(card);
    let note = `${s.nick} played ${label(card)}${SUIT_GLYPH[suitOf(card)]}`;
    if (r === '8') note += ` → ${SUIT_GLYPH[this.suit]} ${SUIT_NAME[this.suit]}`;
    let skip = false;
    if (this.actions) {
      if (r === '2') {
        this.pending += 2;
        note += ` (+${this.pending} next!)`;
      } else if (r === 'J') {
        skip = true;
        note += ' (skip)';
      } else if (r === 'A') {
        if (this.live().length === 2) skip = true;
        else this.dir = -this.dir;
        note += ' (reverse)';
      }
    }
    this.say(note);
    if (s.hand.length === 1) this.ctx.feed(`${s.nick} is down to their last card!`, s.slot);
    if (!s.hand.length) {
      this.endHand(s);
      return true;
    }
    this.advance(skip);
    return true;
  }

  private takeDraw(s: Seat): void {
    if (this.pending > 0) {
      const n = this.pending;
      s.hand.push(...this.draw(n));
      this.pending = 0;
      this.say(`${s.nick} drew ${n}`);
      this.advance();
      return;
    }
    if (this.drew) return;
    const got = this.draw(1);
    s.hand.push(...got);
    this.drew = true;
    this.say(`${s.nick} drew a card`);
    // Can't use it? The turn passes on its own.
    if (!got[0] || !this.playable(got[0])) this.advance();
  }

  private endHand(winner: Seat): void {
    const pts = this.seats.filter((s) => s !== winner).reduce((n, s) => n + s.hand.reduce((m, c) => m + value(c), 0), 0);
    winner.score += pts;
    winner.won++;
    this.msg = `${winner.nick.toUpperCase()} WENT OUT  +${pts}`;
    this.say(`${winner.nick} went out and scores ${pts}`);
    this.ctx.feed(`${winner.nick} wins hand ${this.handNo} (+${pts})`, winner.slot);
    this.phase = 'hand';
    this.phaseT = 6 * SEC;
  }

  input(slot: number, data: unknown): void {
    if (this.phase !== 'play') return;
    const s = this.seat();
    if (s.slot !== slot || s.bot) return;
    const o = data as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return;
    if (o.a === 'play' && typeof o.c === 'string') {
      const idx = s.hand.indexOf(o.c);
      if (idx >= 0) this.play(s, idx, typeof o.s === 'string' ? o.s : undefined);
    } else if (o.a === 'draw') this.takeDraw(s);
    else if (o.a === 'pass' && this.drew) {
      this.say(`${s.nick} passed`);
      this.advance();
    }
  }

  drop(slot: number): void {
    const s = this.seats.find((x) => x.slot === slot);
    if (!s || s.out) return;
    const wasTurn = this.seat() === s;
    s.out = true;
    // Their cards go to the bottom of the stock.
    this.deck.unshift(...s.hand);
    s.hand = [];
    this.say(`${s.nick} left the table`);
    if (this.live().length < 2) {
      const last = this.live()[0];
      if (last && this.phase === 'play') this.endHand(last);
      this.handNo = this.hands;
      return;
    }
    if (wasTurn && this.phase === 'play') this.advance();
  }

  tick(): void {
    if (this.done) return;
    if (this.phase === 'hand') {
      if (--this.phaseT > 0) return;
      if (this.handNo >= this.hands || this.live().length < 2) {
        this.phase = 'over';
        this.done = true;
        return;
      }
      this.handNo++;
      this.starter = (this.starter + 1) % this.seats.length;
      this.msg = '';
      this.phase = 'play';
      this.deal();
      return;
    }
    const s = this.seat();
    if (s.bot) {
      if (--s.botWait <= 0) this.botMove(s);
      return;
    }
    if (--this.turnT <= 0) {
      // Out of time: take the penalty or a card, and move on.
      this.say(`${s.nick} ran out of time`);
      if (this.pending > 0 || !this.drew) this.takeDraw(s);
      if (this.seat() === s) this.advance();
    }
  }

  // ---- bots ----

  private botMove(s: Seat): void {
    const options = s.hand.map((c, i) => ({ c, i })).filter((o) => this.playable(o.c));
    if (!options.length) {
      const before = this.cur;
      this.takeDraw(s);
      if (this.cur === before && this.seat() === s) s.botWait = 5; // drew something playable; think again
      return;
    }
    const count = (suit: string) => s.hand.filter((c) => suitOf(c) === suit && rankOf(c) !== '8').length;
    const next = this.seats[this.nextLive(this.cur, this.dir)]!;
    const score = (c: string) => {
      const r = rankOf(c);
      let v = count(suitOf(c)) * 2 + value(c) / 10;
      if (r === '8') v -= s.hand.length > 2 ? 20 : -5; // save eights for when they're needed
      if (this.actions && '2J'.includes(r)) v += next.hand.length <= 2 ? 15 : 2;
      return v + this.rng.next();
    };
    options.sort((a, b) => score(b.c) - score(a.c));
    const pick = options[0]!;
    const best = [...SUITS].sort((a, b) => count(b) - count(a))[0]!;
    this.play(s, pick.i, best);
  }

  // ---- views ----

  view(slot: number | null): EightsView {
    const mine = this.seats.find((s) => s.slot === slot);
    const myTurn = !!mine && this.seat() === mine && this.phase === 'play';
    const hand = mine ? [...mine.hand] : [];
    return {
      me: hand,
      ok: myTurn ? hand.map((c, i) => (this.playable(c) ? i : -1)).filter((i) => i >= 0) : [],
      top: this.top(),
      suit: this.suit,
      turn: this.seat().slot,
      dir: this.dir,
      pend: this.pending,
      drew: this.drew ? 1 : 0,
      pile: this.deck.length,
      seats: this.seats.map((s) => [s.slot, s.hand.length, s.score, s.out ? 1 : 0]),
      t: Math.ceil(this.turnT / SEC),
      ph: this.phase,
      hand: this.handNo,
      H: this.hands,
      log: this.log.slice(-8),
      msg: this.msg,
      act: this.actions ? 1 : 0,
    };
  }

  standings(): Standing[] {
    return [...this.seats]
      .sort((a, b) => b.score - a.score || b.won - a.won)
      .map((s) => ({ slot: s.slot, nick: s.nick, score: s.score, detail: `${s.won} hand${s.won === 1 ? '' : 's'} won${s.out ? ' · left' : ''}` }));
  }

  summary(): string[] {
    return [`${this.handNo} hand${this.handNo === 1 ? '' : 's'} played · going out scores everyone else's cards (8 = 50, faces = 10)`];
  }
}

// ---- client ----

function asView(f: unknown): EightsView | null {
  const v = f as EightsView;
  if (!v || typeof v !== 'object' || !Array.isArray(v.me) || !Array.isArray(v.seats) || typeof v.top !== 'string') return null;
  if (v.me.length > 120 || !v.me.every((c) => typeof c === 'string' && c.length === 2)) return null;
  return v;
}

const red = (c: string) => suitOf(c) === 'h' || suitOf(c) === 'd';

class EightsClient implements GameClient {
  private sel = 0;
  private picking: string | null = null; // the eight waiting for a suit
  private suitSel = 0;

  measure(_frame: unknown, aw: number, ah: number): { w: number; h: number } | null {
    if (aw < 56 || ah < 20) return null;
    return { w: Math.min(aw, 92), h: Math.min(ah, 24) };
  }

  need(): { w: number; h: number } {
    return { w: 56, h: 20 };
  }

  key(k: Key, frame: unknown, ctx: ViewCtx): unknown {
    const v = asView(frame);
    if (!v || ctx.me === null || k.ctrl || k.meta) return undefined;
    const n = v.me.length;
    if (this.sel >= n) this.sel = Math.max(0, n - 1);
    if (this.picking) {
      if (k.name === 'left' || k.name === 'a' || k.name === 'up') this.suitSel = (this.suitSel + 3) % 4;
      else if (k.name === 'right' || k.name === 'd' || k.name === 'down') this.suitSel = (this.suitSel + 1) % 4;
      else if (k.name === 'escape' || k.name === 'backspace') this.picking = null;
      else if (k.name === 'enter' || k.name === 'space' || ['s', 'h', 'c', '1', '2', '3', '4'].includes(k.name)) {
        const map: Record<string, number> = { s: 0, h: 1, c: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
        const pickIdx = k.name in map ? map[k.name]! : this.suitSel;
        const card = this.picking;
        this.picking = null;
        return { a: 'play', c: card, s: SUITS[pickIdx] };
      } else return undefined;
      return null;
    }
    if (k.name === 'left' || k.name === 'a' || k.name === 'h') {
      this.sel = (this.sel - 1 + n) % Math.max(1, n);
      return null;
    }
    if (k.name === 'right' || k.name === 'd' || k.name === 'l') {
      this.sel = (this.sel + 1) % Math.max(1, n);
      return null;
    }
    if (k.name === 'home') {
      this.sel = 0;
      return null;
    }
    if (k.name === 'end') {
      this.sel = Math.max(0, n - 1);
      return null;
    }
    const myTurn = v.turn === ctx.me && v.ph === 'play';
    if (!myTurn) return undefined;
    if (k.name === 'enter' || k.name === 'space' || k.name === 'up' || k.name === 'w') {
      const card = v.me[this.sel];
      if (!card || !v.ok.includes(this.sel)) return null;
      if (rankOf(card) === '8') {
        this.picking = card;
        const counts = [...SUITS].map((s) => v.me.filter((c) => suitOf(c) === s && c !== card).length);
        this.suitSel = counts.indexOf(Math.max(...counts));
        return null;
      }
      return { a: 'play', c: card };
    }
    if (k.name === 'down' || k.name === 's' || k.name === 'x' || k.name === 'g') return v.drew && !v.pend ? null : { a: 'draw' };
    if (k.name === 'p' || k.name === 'n') return v.drew ? { a: 'pass' } : null;
    return undefined;
  }

  help(frame: unknown, ctx: ViewCtx): string {
    const v = asView(frame);
    if (!v || ctx.me === null) return 'watching';
    if (this.picking) return '←→ choose a suit · Enter confirm · Esc cancel';
    if (v.turn !== ctx.me) return '←→ look through your hand · waiting for your turn';
    if (v.pend) return `←→ pick · Enter play a 2 to pass it on · ↓ draw ${v.pend}`;
    return v.drew ? '←→ pick · Enter play the card you drew · P pass' : '←→ pick · Enter play · ↓ draw a card';
  }

  status(frame: unknown, ctx: ViewCtx): string {
    const v = asView(frame);
    if (!v) return '';
    const whose = v.turn === ctx.me ? 'YOUR TURN' : `${ctx.nick(v.turn)}'s turn`;
    return `hand ${v.hand}/${v.H} · ${whose} · ${v.t}s`;
  }

  scoreboard(frame: unknown, ctx: ViewCtx): SideLine[] {
    const v = asView(frame);
    if (!v) return [];
    const lines: SideLine[] = [];
    for (const [slot = 0, n = 0, score = 0, out = 0] of [...v.seats].sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0))) {
      lines.push({
        slot,
        text: `${pad(fit(ctx.nick(slot), 10), 10)} ${pad(String(score), 4, 'right')}  ${out ? 'left' : `${n} card${n === 1 ? '' : 's'}`}`,
        fg: slot === v.turn ? C.byellow : slot === ctx.me ? C.bwhite : -1,
        at: slot === v.turn ? BOLD : 0,
      });
    }
    lines.push({ text: '' });
    for (const l of v.log.slice(-7)) lines.push({ text: l, fg: C.gray });
    return lines;
  }

  draw(s: Surface, frame: unknown, ctx: ViewCtx): void {
    const v = asView(frame);
    if (!v) return;
    const W = s.w;
    const blink = Math.floor(ctx.now / 400) % 2 === 0;
    // opponents across the top
    const others = v.seats.filter((r) => r[0] !== ctx.me);
    const colW = Math.max(14, Math.floor(W / Math.max(1, others.length)));
    others.forEach(([slot = 0, n = 0, , out = 0], i) => {
      const x = i * colW;
      const turn = slot === v.turn && v.ph === 'play';
      s.text(x, 0, fit(`${turn ? '▶ ' : '  '}${ctx.nick(slot)}`, colW - 1), turn ? C.byellow : seatColor(slot), -1, BOLD);
      if (out) s.text(x + 2, 1, 'left', C.gray);
      else {
        const shown = Math.min(n, Math.floor((colW - 8) / 1));
        s.text(x + 2, 1, '▐' + '█'.repeat(Math.max(0, Math.min(shown, 10) - 1)), C.blue);
        s.text(x + 2 + Math.min(shown, 10) + 1, 1, `${n}`, n === 1 ? (blink ? C.bred : C.bwhite) : C.bwhite, -1, BOLD);
        if (n === 1) s.text(x + 2, 2, 'LAST CARD!', C.bred, -1, BOLD);
      }
    });
    // table: stock and discard
    const cy = 4;
    const cx = (W >> 1) - 10;
    this.back(s, cx, cy, 7, 5);
    s.center(cy + 5, `${v.pile} left`, C.gray, -1, 0, cx - 2, 11);
    this.bigCard(s, cx + 11, cy, v.top);
    // current suit and direction
    const sx = cx + 21;
    s.text(sx, cy, 'suit', C.gray);
    s.text(sx, cy + 1, ` ${SUIT_GLYPH[v.suit] ?? '?'} ${SUIT_NAME[v.suit] ?? ''} `, red(`x${v.suit}`) ? C.bred : C.black, C.bwhite, BOLD);
    s.text(sx, cy + 3, v.dir > 0 ? 'order ↻' : 'order ↺', C.gray);
    if (v.pend) s.text(sx, cy + 4, ` +${v.pend} pending! `, C.bwhite, C.red, BOLD);
    // banner line
    const by = cy + 7;
    if (v.ph === 'hand' || v.ph === 'over') s.center(by, ` ${v.msg} `, C.black, C.byellow, BOLD);
    else if (ctx.me !== null && v.turn === ctx.me) {
      const what = v.pend ? `stack a 2 or draw ${v.pend}` : v.drew ? 'play the card you drew, or P to pass' : `match ${SUIT_GLYPH[v.suit]} or ${label(v.top)}, play an 8, or draw`;
      s.center(by, ` YOUR TURN — ${what} `, C.black, blink ? C.bgreen : C.green, BOLD);
    } else s.center(by, `${ctx.nick(v.turn)} is thinking… ${v.t}s`, seatColor(v.turn));
    // my hand
    if (ctx.me === null) {
      s.center(s.h - 3, 'spectating — you get a seat next match', C.gray);
      return;
    }
    this.hand(s, v, ctx, s.h - 6);
    if (this.picking) this.suitPicker(s);
  }

  private hand(s: Surface, v: EightsView, ctx: ViewCtx, y: number): void {
    const n = v.me.length;
    if (this.sel >= n) this.sel = Math.max(0, n - 1);
    const cardW = 7;
    const avail = s.w - 2;
    const step = n <= 1 ? cardW : Math.max(2, Math.min(cardW + 1, Math.floor((avail - cardW) / (n - 1))));
    const total = (n - 1) * step + cardW;
    const x0 = Math.max(0, (s.w - total) >> 1);
    const myTurn = v.turn === ctx.me && v.ph === 'play';
    v.me.forEach((c, i) => {
      if (i === this.sel) return; // the selected card is drawn last, raised
      this.handCard(s, x0 + i * step, y + 1, c, myTurn && v.ok.includes(i), false, myTurn);
    });
    const c = v.me[this.sel];
    if (c) this.handCard(s, x0 + this.sel * step, y, c, myTurn && v.ok.includes(this.sel), true, myTurn);
    s.center(y + 5, `${n} card${n === 1 ? '' : 's'}${myTurn ? ` · ${v.ok.length} playable` : ''}`, C.gray);
  }

  private handCard(s: Surface, x: number, y: number, c: string, playable: boolean, selected: boolean, myTurn: boolean): void {
    const ink = red(c) ? C.red : C.black;
    const dim = myTurn && !playable;
    const bg = dim ? C.white : C.bwhite;
    const border = selected ? (playable || !myTurn ? C.byellow : C.bred) : C.gray;
    const r = label(c);
    const g = SUIT_GLYPH[suitOf(c)]!;
    s.text(x, y, '┌─────┐', border, bg, selected ? BOLD : 0);
    s.text(x, y + 1, '│', border, bg);
    s.text(x + 1, y + 1, pad(r + g, 5), ink, bg, BOLD);
    s.text(x + 6, y + 1, '│', border, bg);
    s.text(x, y + 2, '│', border, bg);
    s.text(x + 1, y + 2, pad(g, 5, 'center'), ink, bg, dim ? DIM : BOLD);
    s.text(x + 6, y + 2, '│', border, bg);
    s.text(x, y + 3, '└─────┘', border, bg, selected ? BOLD : 0);
  }

  private bigCard(s: Surface, x: number, y: number, c: string): void {
    const ink = red(c) ? C.red : C.black;
    const r = label(c);
    const g = SUIT_GLYPH[suitOf(c)]!;
    s.fill(x, y, 9, 6, ' ', ink, C.bwhite);
    s.box(x, y, 9, 6, C.gray, C.bwhite, 'single');
    s.text(x + 1, y + 1, r, ink, C.bwhite, BOLD);
    s.text(x + 4, y + 2, g, ink, C.bwhite, BOLD);
    s.text(x + 3, y + 3, `${g} ${g}`.slice(0, 3), ink, C.bwhite, BOLD);
    s.text(x + 8 - cells(r), y + 4, r, ink, C.bwhite, BOLD);
  }

  private back(s: Surface, x: number, y: number, w: number, h: number): void {
    s.fill(x, y, w, h, '░', C.bblue, C.blue);
    s.box(x, y, w, h, C.bwhite, C.blue, 'single');
  }

  private suitPicker(s: Surface): void {
    const w = 34;
    const h = 5;
    const x = (s.w - w) >> 1;
    const y = 6;
    s.fill(x, y, w, h, ' ', -1, C.black);
    s.box(x, y, w, h, C.byellow, C.black, 'double', 'NAME THE NEXT SUIT', C.byellow);
    [...SUITS].forEach((su, i) => {
      const on = i === this.suitSel;
      s.text(x + 3 + i * 7, y + 2, ` ${SUIT_GLYPH[su]} ${i + 1} `, red(`x${su}`) ? C.bred : C.bwhite, on ? C.blue : C.black, BOLD);
    });
  }
}

export const eightsGame: GameDef = {
  id: 'eights',
  title: 'Crazy Eights',
  tag: 'the classic shedding card game',
  genre: 'cards',
  min: 2,
  max: 6,
  bots: true,
  accent: C.bred,
  about:
    'Match the top card by suit or rank and be the first to empty your hand. Eights are wild: play one any time and name the next suit. With action cards on, a 2 makes the next player draw two (stack another 2 to pass it on), a Jack skips them and an Ace reverses the order. Going out scores the cards left in everyone else\'s hands.',
  controls: ['←→ choose a card · Enter play it · ↓ draw', 'P pass after drawing · when you play an 8, pick a suit', 'T chat · Esc leave'],
  art: ['┌─────┐┌─────┐ ┌───────┐', '│8♠   ││K♥   │ │7      │', '│  ♠  ││  ♥  │ │   ♦   │', '└─────┘└─────┘ │      7│', '  ▐█████ 5     └───────┘'],
  settings: [
    { key: 'hands', label: 'Hands', choices: [{ v: 3, label: '3' }, { v: 5, label: '5' }, { v: 1, label: '1' }] },
    { key: 'actions', label: 'Action cards', choices: [{ v: 'on', label: 'On (2 draw · J skip · A reverse)' }, { v: 'off', label: 'Off (classic)' }] },
    { key: 'turn', label: 'Turn timer', choices: [{ v: 30, label: '30 seconds' }, { v: 20, label: '20 seconds' }, { v: 60, label: '60 seconds' }] },
  ],
  create: (ctx) => new EightsGame(ctx),
  client: () => new EightsClient(),
};
