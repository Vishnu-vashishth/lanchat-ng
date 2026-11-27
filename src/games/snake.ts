import * as ROT from 'rot-js';
import { BOLD, C, DIM, REVERSE, fit, pad, seatColor, type Surface } from './term/canvas.js';
import { bigCenter, bigWidth } from './term/font.js';
import { DX, DY, dirOf, type Dir, type Key } from './term/keys.js';
import type { GameClient, GameDef, GameLogic, HostCtx, SideLine, Standing, ViewCtx } from './types.js';
import type { Rng } from './rng.js';

// SNAKE ARENA — every player steers a snake in one shared arena. Eat to grow,
// make others crash into you, outlast everyone. Survival mode plays rounds
// (last snake standing; the walls close in if a round drags on); Frenzy is a
// timed free-for-all with respawns. Dead snakes burst into food, so every
// crash sets off a scramble. Arenas are generated per round with rot.js
// (cellular-automaton caves, braided labyrinths) or laid out by hand.

type Item = 'food' | 'gold' | 'ghost' | 'turbo';
const ITEM_CODE: Record<Item, string> = { food: 'o', gold: '*', ghost: 'g', turbo: 't' };

interface Snake {
  slot: number;
  nick: string;
  bot: boolean;
  body: number[]; // cell indexes, head first
  dir: Dir;
  queue: Dir[];
  alive: boolean;
  out: boolean; // left the table
  grow: number;
  score: number;
  kills: number;
  deaths: number;
  wins: number;
  eaten: number;
  best: number;
  ghost: number; // ticks of pass-through left
  turbo: number; // ticks of double speed left
  shield: number; // spawn protection ticks
  respawn: number; // ticks until respawn (frenzy)
  corpse: number[];
  corpseT: number;
}

export interface SnakeView {
  w: number;
  h: number;
  wrap: boolean;
  g: string; // w*h cell codes
  s: number[][]; // [slot, alive, len, score, dir, ghost, turbo, shield, respawnSecs, wins, kills]
  ph: 'count' | 'play' | 'round' | 'over';
  cd: number;
  r: number;
  R: number;
  mode: 'survival' | 'frenzy';
  tl: number; // frenzy seconds left
  sd: number; // walls closing
  b: string; // banner
}

const MAPS = ['open', 'pillars', 'caves', 'maze'] as const;
type MapKind = (typeof MAPS)[number];

class SnakeGame implements GameLogic {
  readonly tickMs: number;
  done = false;
  private readonly W: number;
  private readonly H: number;
  private readonly wrap: boolean;
  private readonly mode: 'survival' | 'frenzy';
  private readonly rounds: number;
  private readonly wall: Uint8Array;
  private readonly closing: Uint8Array;
  private readonly items = new Map<number, { kind: Item; ttl: number }>();
  private readonly snakes: Snake[];
  private readonly rng: Rng;
  private readonly sec: number; // ticks per second
  private phase: SnakeView['ph'] = 'count';
  private phaseT: number;
  private round = 1;
  private t = 0;
  private roundT = 0;
  private timeLeft: number;
  private ring = 0;
  private ringAt = 0;
  private warning = false;
  private banner = '';
  private lastPower = 0;
  private readonly botNoise: number;
  private readonly botSlip: number;
  private dist: Int16Array;

  constructor(private readonly ctx: HostCtx) {
    const st = ctx.settings;
    this.rng = ctx.rng;
    const speed = typeof st.speed === 'number' ? st.speed : 9;
    this.tickMs = Math.round(1000 / (speed * 2));
    this.sec = Math.round(1000 / this.tickMs);
    this.mode = st.mode === 'frenzy' ? 'frenzy' : 'survival';
    const len = typeof st.length === 'number' ? st.length : 3;
    this.rounds = this.mode === 'survival' ? len : 1;
    this.timeLeft = (len === 1 ? 60 : len === 5 ? 180 : 120) * this.sec;
    this.wrap = st.edges === 'wrap';
    const skill = st.bots === 'hard' ? 2 : st.bots === 'easy' ? 0 : 1;
    this.botNoise = [30, 8, 1][skill]!;
    this.botSlip = [0.14, 0.03, 0][skill]!;

    const n = ctx.players.length;
    const side = ctx.arena.cols >= 111;
    const availW = Math.floor(((side ? ctx.arena.cols - 31 : ctx.arena.cols) - 2) / 2);
    const availH = ctx.arena.rows - 4;
    this.W = Math.max(16, Math.min(availW, 26 + 3 * n, 52));
    this.H = Math.max(10, Math.min(availH, 14 + Math.ceil(1.5 * n), 28));
    this.wall = new Uint8Array(this.W * this.H);
    this.closing = new Uint8Array(this.W * this.H);
    this.dist = new Int16Array(this.W * this.H);
    this.snakes = ctx.players.map((p) => ({
      slot: p.slot,
      nick: p.nick,
      bot: p.bot,
      body: [],
      dir: 1 as Dir,
      queue: [],
      alive: false,
      out: false,
      grow: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      wins: 0,
      eaten: 0,
      best: 0,
      ghost: 0,
      turbo: 0,
      shield: 0,
      respawn: 0,
      corpse: [],
      corpseT: 0,
    }));
    this.phaseT = 3 * this.sec;
    this.newRound();
  }

  private get mapKind(): MapKind {
    const m = this.ctx.settings.map;
    if (m === 'open' || m === 'pillars' || m === 'caves' || m === 'maze') return m;
    // "random": a different layout every round, starting gentle.
    return this.round === 1 ? (this.rng.chance(0.5) ? 'open' : 'pillars') : this.rng.pick(MAPS);
  }

  // ---- arena ----

  private idx(x: number, y: number): number {
    return y * this.W + x;
  }

  /** Neighbor cell in a direction, or -1 when that leaves a walled arena. */
  private stepCell(i: number, d: Dir): number {
    let x = (i % this.W) + DX[d];
    let y = Math.floor(i / this.W) + DY[d];
    if (this.wrap) {
      x = (x + this.W) % this.W;
      y = (y + this.H) % this.H;
    } else if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
    return this.idx(x, y);
  }

  private buildMap(kind: MapKind): void {
    const { W, H } = this;
    this.wall.fill(0);
    this.closing.fill(0);
    if (kind === 'pillars') {
      for (let y = 3, row = 0; y < H - 4; y += 6, row++) {
        for (let x = row % 2 ? 9 : 5; x < W - 5; x += 9) {
          this.wall[this.idx(x, y)] = 1;
          this.wall[this.idx(x + 1, y)] = 1;
          this.wall[this.idx(x, y + 1)] = 1;
          this.wall[this.idx(x + 1, y + 1)] = 1;
        }
      }
    } else if (kind === 'caves') {
      this.rng.withRot(() => {
        const m = new ROT.Map.Cellular(W, H, { born: [5, 6, 7, 8], survive: [4, 5, 6, 7, 8] });
        m.randomize(0.4);
        for (let i = 0; i < 4; i++) m.create();
        m.create((x, y, v) => {
          if (v && x > 1 && y > 1 && x < W - 2 && y < H - 2) this.wall[this.idx(x, y)] = 1;
        });
      });
    } else if (kind === 'maze') {
      // A rot.js perfect maze, scaled to 3-wide corridors, then braided so
      // there are loops and few dead ends.
      const cw = Math.max(2, Math.floor((W - 1) / 4));
      const ch = Math.max(2, Math.floor((H - 1) / 4));
      const ox = Math.floor((W - (cw * 4 + 1)) / 2);
      const oy = Math.floor((H - (ch * 4 + 1)) / 2);
      const cells: [number, number][] = [];
      this.rng.withRot(() => {
        const m = new ROT.Map.DividedMaze(cw * 2 + 1, ch * 2 + 1);
        m.create((x, y, v) => {
          if (v) cells.push([x, y]);
        });
      });
      for (const [mx, my] of cells) {
        const border = mx === 0 || my === 0 || mx === cw * 2 || my === ch * 2;
        if (border) continue; // the arena edge is already a wall (or wraps)
        const interior = mx % 2 === 1 || my % 2 === 1; // a wall segment between two corridors
        if (interior && this.rng.chance(0.45)) continue; // braid
        const x0 = ox + Math.floor(mx / 2) * 4 + (mx % 2 ? 1 : 0);
        const y0 = oy + Math.floor(my / 2) * 4 + (my % 2 ? 1 : 0);
        const w = mx % 2 ? 3 : 1;
        const h = my % 2 ? 3 : 1;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < W && y < H) this.wall[this.idx(x, y)] = 1;
      }
    }
    this.keepLargestRegion();
  }

  /** Wall off any pocket not reachable from the biggest open area. */
  private keepLargestRegion(): void {
    const n = this.W * this.H;
    const seen = new Int32Array(n).fill(-1);
    let best = -1;
    let bestSize = 0;
    let id = 0;
    for (let i = 0; i < n; i++) {
      if (this.wall[i] || seen[i]! >= 0) continue;
      let size = 0;
      const stack = [i];
      seen[i] = id;
      while (stack.length) {
        const c = stack.pop()!;
        size++;
        for (let d = 0; d < 4; d++) {
          const nb = this.stepCell(c, d as Dir);
          if (nb >= 0 && !this.wall[nb] && seen[nb]! < 0) {
            seen[nb] = id;
            stack.push(nb);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = id;
      }
      id++;
    }
    for (let i = 0; i < n; i++) if (!this.wall[i] && seen[i] !== best) this.wall[i] = 1;
  }

  private occupancy(): Int16Array {
    const occ = new Int16Array(this.W * this.H).fill(-1);
    for (const s of this.snakes) for (const c of s.body) occ[c] = s.slot;
    return occ;
  }

  private free(i: number, occ: Int16Array): boolean {
    return !this.wall[i] && !this.closing[i] && occ[i]! < 0 && !this.items.has(i);
  }

  // ---- rounds and spawning ----

  private newRound(): void {
    this.buildMap(this.mapKind);
    this.items.clear();
    this.ring = 0;
    this.roundT = 0;
    this.ringAt = 0;
    this.warning = false;
    this.banner = this.mode === 'survival' ? `ROUND ${this.round}` : 'FRENZY';
    for (const s of this.snakes) {
      s.body = [];
      s.corpse = [];
      s.queue = [];
      s.ghost = s.turbo = s.shield = s.respawn = 0;
      s.alive = false;
    }
    const live = this.snakes.filter((s) => !s.out);
    const n = live.length;
    live.forEach((s, i) => {
      const a = (Math.PI * 2 * i) / Math.max(1, n) - Math.PI / 2;
      const px = Math.round(this.W / 2 + Math.cos(a) * this.W * 0.3);
      const py = Math.round(this.H / 2 + Math.sin(a) * this.H * 0.3);
      // Head clockwise around the ring so nobody starts nose to nose.
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      const dir: Dir = Math.abs(tx) * 2 > Math.abs(ty) ? (tx > 0 ? 1 : 3) : ty > 0 ? 2 : 0;
      this.place(s, n === 1 ? Math.floor(this.W / 3) : px, n === 1 ? Math.floor(this.H / 2) : py, n === 1 ? 1 : dir, 4);
    });
    this.fillItems();
  }

  /** Put a snake down near (x, y) facing `dir`, searching outward for room. */
  private place(s: Snake, x: number, y: number, dir: Dir, len: number): boolean {
    const occ = this.occupancy();
    const ok = (hx: number, hy: number, d: Dir): number[] | null => {
      const cells: number[] = [];
      const back = ((d + 2) % 4) as Dir;
      let c = this.idx(hx, hy);
      // the head, the body behind it, and a clear runway ahead
      for (let k = 0; k < len; k++) {
        if (c < 0 || this.wall[c] || this.closing[c] || occ[c]! >= 0) return null;
        cells.push(c);
        c = this.stepCell(c, back);
      }
      let a = this.idx(hx, hy);
      for (let k = 0; k < 4; k++) {
        a = this.stepCell(a, d);
        if (a < 0 || this.wall[a] || occ[a]! >= 0) return null;
      }
      return cells;
    };
    for (let r = 0; r < Math.max(this.W, this.H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const hx = x + dx;
          const hy = y + dy;
          if (hx < 1 || hy < 1 || hx >= this.W - 1 || hy >= this.H - 1) continue;
          for (let t = 0; t < 4; t++) {
            const d = ((dir + t) % 4) as Dir;
            const cells = ok(hx, hy, d);
            if (!cells) continue;
            s.body = cells;
            s.dir = d;
            s.queue = [];
            s.alive = true;
            s.grow = 0;
            for (const c of cells) this.items.delete(c);
            return true;
          }
        }
      }
    }
    return false;
  }

  private randomFree(minHeadDist = 3): number {
    const occ = this.occupancy();
    const heads = this.snakes.filter((s) => s.alive).map((s) => s.body[0]!);
    for (let tries = 0; tries < 400; tries++) {
      const i = this.rng.int(this.W * this.H);
      if (!this.free(i, occ)) continue;
      const x = i % this.W;
      const y = Math.floor(i / this.W);
      if (heads.some((h) => Math.abs((h % this.W) - x) + Math.abs(Math.floor(h / this.W) - y) < minHeadDist)) continue;
      return i;
    }
    return -1;
  }

  private fillItems(): void {
    const alive = this.snakes.filter((s) => !s.out).length;
    let food = 0;
    for (const it of this.items.values()) if (it.kind === 'food') food++;
    const want = 2 + Math.ceil(alive * 0.8);
    while (food < want) {
      const i = this.randomFree();
      if (i < 0) break;
      this.items.set(i, { kind: 'food', ttl: -1 });
      food++;
    }
  }

  // ---- simulation ----

  input(slot: number, data: unknown): void {
    const s = this.snakes.find((x) => x.slot === slot);
    if (!s || !s.alive || s.bot) return;
    const d = (data as { d?: unknown } | null)?.d;
    if (d !== 0 && d !== 1 && d !== 2 && d !== 3) return;
    const last = s.queue.length ? s.queue[s.queue.length - 1]! : s.dir;
    if (d === last || s.queue.length >= 3) return;
    s.queue.push(d);
  }

  drop(slot: number): void {
    const s = this.snakes.find((x) => x.slot === slot);
    if (!s || s.out) return;
    if (s.alive) this.kill(s, -1, 'left the game');
    s.out = true;
    s.respawn = 0;
  }

  tick(): void {
    if (this.done) return;
    this.t++;
    if (this.phase === 'count') {
      if (--this.phaseT <= 0) {
        this.phase = 'play';
        this.banner = '';
      }
      return;
    }
    if (this.phase === 'round') {
      if (--this.phaseT <= 0) {
        if (this.round >= this.rounds) this.finish();
        else {
          this.round++;
          this.newRound();
          this.phase = 'count';
          this.phaseT = 3 * this.sec;
        }
      }
      return;
    }
    this.play();
  }

  private play(): void {
    this.roundT++;
    for (const s of this.snakes) {
      if (s.ghost > 0) s.ghost--;
      if (s.turbo > 0) s.turbo--;
      if (s.shield > 0) s.shield--;
      if (!s.alive && !s.out && s.respawn > 0 && --s.respawn === 0) this.respawn(s);
      if (s.corpseT > 0 && --s.corpseT === 0) this.dropCorpse(s);
    }
    for (const [i, it] of this.items) if (it.ttl > 0 && --it.ttl === 0) this.items.delete(i);
    this.spawnSpecials();
    if (this.mode === 'survival') this.closeWalls();

    const movers = this.snakes.filter((s) => s.alive && (this.t % 2 === 0 || s.turbo > 0));
    if (movers.length) this.move(movers);
    this.fillItems();

    if (this.mode === 'frenzy') {
      if (--this.timeLeft <= 0) this.finish();
      return;
    }
    const live = this.snakes.filter((s) => !s.out);
    const alive = live.filter((s) => s.alive);
    if ((live.length >= 2 && alive.length <= 1) || (live.length < 2 && alive.length === 0)) this.endRound(alive[0]);
    // Hard stop for a round that outlasts the squeeze: the longest snake takes it.
    else if (this.roundT > 150 * this.sec) this.endRound([...alive].sort((a, b) => b.body.length - a.body.length)[0]);
  }

  private move(movers: Snake[]): void {
    this.computeDistances();
    for (const s of movers) {
      if (s.bot) {
        const d = this.think(s);
        s.queue = d === s.dir ? [] : [d];
      }
      while (s.queue.length) {
        const d = s.queue.shift()!;
        if (d !== s.dir && d !== (s.dir + 2) % 4) {
          s.dir = d;
          break;
        }
      }
    }
    const next = new Map<Snake, number>();
    for (const s of movers) next.set(s, this.stepCell(s.body[0]!, s.dir));
    // Tails that move out of the way this tick no longer block anyone.
    const occ = new Int16Array(this.W * this.H).fill(-1);
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const leaving = next.has(s) && s.grow === 0 ? 1 : 0;
      for (let k = 0; k < s.body.length - leaving; k++) occ[s.body[k]!] = s.slot;
    }
    const intangible = (s: Snake) => s.ghost > 0 || s.shield > 0;
    const bySlot = new Map(this.snakes.map((s) => [s.slot, s]));
    const dead = new Map<Snake, { by: number; why: string }>();
    for (const s of movers) {
      const n = next.get(s)!;
      if (n < 0 || this.wall[n]) {
        dead.set(s, { by: -1, why: 'hit a wall' });
        continue;
      }
      const o = occ[n]!;
      if (o >= 0) {
        const other = bySlot.get(o)!;
        // Two heads swapping cells is a head-on, settled below by length.
        const swap = other !== s && next.has(other) && other.body[0] === n && next.get(other) === s.body[0];
        if (!swap && !intangible(s) && !intangible(other)) dead.set(s, { by: o === s.slot ? -1 : o, why: o === s.slot ? 'bit their own tail' : `crashed into ${other.nick}` });
      }
    }
    // Head-on: the longer snake wins, a tie kills both.
    const heads = new Map<number, Snake[]>();
    for (const s of movers) {
      const n = next.get(s)!;
      if (n < 0 || intangible(s)) continue;
      heads.set(n, [...(heads.get(n) ?? []), s]);
    }
    for (const s of movers) {
      for (const o of movers) {
        if (s === o || intangible(s) || intangible(o)) continue;
        if (next.get(s) === o.body[0] && next.get(o) === s.body[0]) heads.set(-2 - s.slot * 16 - o.slot, [s, o]);
      }
    }
    for (const group of heads.values()) {
      if (group.length < 2) continue;
      const maxLen = Math.max(...group.map((s) => s.body.length));
      const top = group.filter((s) => s.body.length === maxLen);
      for (const s of group) {
        if (top.length === 1 && s === top[0]) continue;
        const winner = top.length === 1 ? top[0]! : null;
        dead.set(s, { by: winner ? winner.slot : -1, why: winner ? `lost a head-on with ${winner.nick}` : 'died in a head-on' });
      }
    }
    for (const s of movers) {
      if (dead.has(s)) continue;
      const n = next.get(s)!;
      s.body.unshift(n);
      if (s.grow > 0) s.grow--;
      else s.body.pop();
      s.best = Math.max(s.best, s.body.length);
      this.eat(s, n);
    }
    for (const [s, why] of dead) this.kill(s, why.by, why.why);
  }

  private eat(s: Snake, cell: number): void {
    const it = this.items.get(cell);
    if (!it) return;
    this.items.delete(cell);
    switch (it.kind) {
      case 'food':
        s.grow += 1;
        s.score += 1;
        s.eaten++;
        break;
      case 'gold':
        s.grow += 3;
        s.score += 3;
        s.eaten++;
        this.ctx.feed(`${s.nick} grabbed a golden apple (+3)`, s.slot);
        break;
      case 'ghost':
        s.ghost = 5 * this.sec;
        this.ctx.feed(`${s.nick} turned ghost — passes through snakes for 5s`, s.slot);
        break;
      case 'turbo':
        s.turbo = 4 * this.sec;
        this.ctx.feed(`${s.nick} hit turbo — double speed for 4s`, s.slot);
        break;
    }
  }

  private kill(s: Snake, by: number, why: string): void {
    if (!s.alive) return;
    s.alive = false;
    s.deaths++;
    s.corpse = s.body;
    s.corpseT = Math.round(this.sec * 0.6);
    s.body = [];
    s.queue = [];
    s.ghost = s.turbo = 0;
    const killer = by >= 0 ? this.snakes.find((x) => x.slot === by) : undefined;
    if (killer && killer !== s) {
      killer.kills++;
      killer.score += this.mode === 'frenzy' ? 5 : 2;
    }
    if (why !== 'left the game') this.ctx.feed(`${s.nick} ${why}${killer && killer !== s ? ` (+${this.mode === 'frenzy' ? 5 : 2} ${killer.nick})` : ''}`, s.slot);
    if (this.mode === 'frenzy' && !s.out) s.respawn = Math.round(2.5 * this.sec);
  }

  /** A crashed snake bursts into food along its old body. */
  private dropCorpse(s: Snake): void {
    let food = 0;
    for (const it of this.items.values()) if (it.kind === 'food') food++;
    const occ = this.occupancy();
    s.corpse.forEach((c, k) => {
      if (k % 2 === 1 || food >= 60) return;
      if (this.free(c, occ)) {
        this.items.set(c, { kind: 'food', ttl: 20 * this.sec });
        food++;
      }
    });
    s.corpse = [];
  }

  private respawn(s: Snake): void {
    const i = this.randomFree(6);
    const x = i >= 0 ? i % this.W : this.W >> 1;
    const y = i >= 0 ? Math.floor(i / this.W) : this.H >> 1;
    if (this.place(s, x, y, this.rng.int(4) as Dir, 4)) s.shield = 2 * this.sec;
    else s.respawn = this.sec; // no room right now; try again shortly
  }

  private spawnSpecials(): void {
    let gold = false;
    let power = false;
    for (const it of this.items.values()) {
      if (it.kind === 'gold') gold = true;
      if (it.kind === 'ghost' || it.kind === 'turbo') power = true;
    }
    if (!gold && this.rng.chance(1 / (9 * this.sec))) {
      const i = this.randomFree(5);
      if (i >= 0) this.items.set(i, { kind: 'gold', ttl: 7 * this.sec });
    }
    if (!power && this.t - this.lastPower > 12 * this.sec && this.rng.chance(1 / (4 * this.sec))) {
      const i = this.randomFree(5);
      if (i >= 0) {
        this.items.set(i, { kind: this.rng.chance(0.5) ? 'ghost' : 'turbo', ttl: 9 * this.sec });
        this.lastPower = this.t;
      }
    }
  }

  /** Survival rounds that drag on get squeezed: one ring of wall at a time. */
  private closeWalls(): void {
    const start = 75 * this.sec;
    // Once every human has crashed, squeeze the bots out quickly instead of
    // making people watch them circle.
    const humans = this.snakes.filter((s) => !s.bot && !s.out);
    const humansOut = humans.length > 0 && humans.every((s) => !s.alive);
    if (humansOut && this.roundT < start) this.roundT = start;
    if (this.roundT < start) return;
    const r = this.ring;
    if (r * 2 + 6 >= Math.min(this.W, this.H)) return;
    if (!this.warning) {
      if (this.roundT < this.ringAt) return;
      // Flash the next ring as a warning before it turns solid.
      for (let y = r; y < this.H - r; y++)
        for (let x = r; x < this.W - r; x++) if (x === r || y === r || x === this.W - 1 - r || y === this.H - 1 - r) this.closing[this.idx(x, y)] = 1;
      if (r === 0) this.ctx.feed('the walls are closing in!');
      this.warning = true;
      this.ringAt = this.roundT + Math.round((humansOut ? 0.8 : 1.5) * this.sec);
      return;
    }
    if (this.roundT < this.ringAt) return;
    for (let i = 0; i < this.closing.length; i++) {
      if (!this.closing[i]) continue;
      this.closing[i] = 0;
      this.wall[i] = 1;
      this.items.delete(i);
    }
    for (const s of this.snakes) if (s.alive && s.body.some((c) => this.wall[c])) this.kill(s, -1, 'was crushed by the walls');
    this.ring++;
    this.warning = false;
    this.ringAt = this.roundT + Math.round((humansOut ? 0.4 : 1) * this.sec);
  }

  private endRound(survivor: Snake | undefined): void {
    if (survivor) {
      survivor.wins++;
      survivor.score += 5;
      this.banner = `${survivor.nick.toUpperCase()} WINS ROUND ${this.round}`;
      this.ctx.feed(`${survivor.nick} wins round ${this.round} (+5)`, survivor.slot);
    } else {
      this.banner = `NOBODY SURVIVED ROUND ${this.round}`;
      this.ctx.feed(`round ${this.round}: nobody survived`);
    }
    this.phase = 'round';
    this.phaseT = 3 * this.sec;
  }

  private finish(): void {
    this.phase = 'over';
    this.done = true;
  }

  // ---- bots ----

  /** Multi-source BFS from every item over open cells: distance to the nearest snack. */
  private computeDistances(): void {
    const occ = this.occupancy();
    this.dist.fill(-1);
    const q: number[] = [];
    for (const i of this.items.keys()) {
      this.dist[i] = 0;
      q.push(i);
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h]!;
      for (let d = 0; d < 4; d++) {
        const n = this.stepCell(c, d as Dir);
        if (n < 0 || this.dist[n]! >= 0 || this.wall[n] || occ[n]! >= 0) continue;
        this.dist[n] = this.dist[c]! + 1;
        q.push(n);
      }
    }
  }

  private think(s: Snake): Dir {
    const occ = this.occupancy();
    const tail = s.body[s.body.length - 1];
    if (tail !== undefined && s.grow === 0) occ[tail] = -1;
    const options: { d: Dir; score: number }[] = [];
    for (const d of [s.dir, (s.dir + 1) % 4, (s.dir + 3) % 4] as Dir[]) {
      const n = this.stepCell(s.body[0]!, d);
      if (n < 0 || this.wall[n] || this.closing[n]) continue;
      if (occ[n]! >= 0 && s.ghost === 0) continue;
      let score = 0;
      const space = this.flood(n, occ, s.body.length + 12);
      if (space < s.body.length + 3) score -= 1000 - space * 10;
      const dist = this.dist[n]!;
      score -= dist < 0 ? 60 : dist * 3;
      for (const o of this.snakes) {
        if (o === s || !o.alive || o.body.length < s.body.length) continue;
        const oh = o.body[0]!;
        for (let k = 0; k < 4; k++) if (this.stepCell(oh, k as Dir) === n) score -= 350;
      }
      if (d === s.dir) score += 2;
      score += this.rng.next() * this.botNoise;
      options.push({ d, score });
    }
    if (!options.length) return s.dir;
    if (this.rng.chance(this.botSlip)) return this.rng.pick(options).d;
    options.sort((a, b) => b.score - a.score);
    return options[0]!.d;
  }

  private flood(from: number, occ: Int16Array, cap: number): number {
    const seen = new Set<number>([from]);
    const q = [from];
    for (let h = 0; h < q.length && seen.size < cap; h++) {
      for (let d = 0; d < 4; d++) {
        const n = this.stepCell(q[h]!, d as Dir);
        if (n < 0 || seen.has(n) || this.wall[n] || occ[n]! >= 0) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return seen.size;
  }

  // ---- views ----

  view(_slot: number | null): SnakeView {
    const g: string[] = new Array<string>(this.W * this.H).fill(' ');
    for (let i = 0; i < g.length; i++) {
      if (this.wall[i]) g[i] = '#';
      else if (this.closing[i]) g[i] = '+';
    }
    for (const [i, it] of this.items) g[i] = ITEM_CODE[it.kind];
    for (const s of this.snakes) for (const c of s.corpse) g[c] = String.fromCharCode(48 + s.slot);
    for (const s of this.snakes) {
      s.body.forEach((c, k) => {
        g[c] = String.fromCharCode((k === 0 ? 97 : 65) + s.slot);
      });
    }
    return {
      w: this.W,
      h: this.H,
      wrap: this.wrap,
      g: g.join(''),
      s: this.snakes.map((s) => [
        s.slot,
        s.alive ? 1 : 0,
        s.body.length,
        s.score,
        s.dir,
        s.ghost > 0 ? 1 : 0,
        s.turbo > 0 ? 1 : 0,
        s.shield > 0 ? 1 : 0,
        s.respawn > 0 ? Math.ceil(s.respawn / this.sec) : 0,
        s.wins,
        s.kills,
        s.out ? 1 : 0,
      ]),
      ph: this.phase,
      cd: this.phase === 'count' ? Math.ceil(this.phaseT / this.sec) : 0,
      r: this.round,
      R: this.rounds,
      mode: this.mode,
      tl: Math.ceil(this.timeLeft / this.sec),
      sd: this.ring > 0 || this.closing.some((v) => v === 1) ? 1 : 0,
      b: this.banner,
    };
  }

  standings(): Standing[] {
    return [...this.snakes]
      .sort((a, b) => b.score - a.score || b.wins - a.wins || b.kills - a.kills || b.best - a.best)
      .map((s) => ({
        slot: s.slot,
        nick: s.nick,
        score: s.score,
        detail: `${this.mode === 'survival' ? `${s.wins} round${s.wins === 1 ? '' : 's'} · ` : ''}${s.kills} kill${s.kills === 1 ? '' : 's'} · longest ${s.best}${s.out ? ' · left' : ''}`,
      }));
  }

  summary(): string[] {
    const lines: string[] = [];
    const longest = [...this.snakes].sort((a, b) => b.best - a.best)[0];
    if (longest && longest.best > 0) lines.push(`longest snake: ${longest.nick} (${longest.best})`);
    const killer = [...this.snakes].sort((a, b) => b.kills - a.kills)[0];
    if (killer && killer.kills > 0) lines.push(`most crashes caused: ${killer.nick} (${killer.kills})`);
    const eater = [...this.snakes].sort((a, b) => b.eaten - a.eaten)[0];
    if (eater && eater.eaten > 0) lines.push(`hungriest: ${eater.nick} (${eater.eaten} apples)`);
    return lines;
  }
}

// ---- client ----

function asView(f: unknown): SnakeView | null {
  const v = f as SnakeView;
  if (!v || typeof v !== 'object' || typeof v.g !== 'string' || !Array.isArray(v.s)) return null;
  if (!Number.isInteger(v.w) || !Number.isInteger(v.h) || v.w < 4 || v.h < 4 || v.w > 200 || v.h > 200 || v.g.length !== v.w * v.h) return null;
  return v;
}

const MONO_BODY = ['##', '@@', '%%', '&&', '$$', '**', '++', '=='];

class SnakeClient implements GameClient {
  measure(frame: unknown, aw: number, ah: number): { w: number; h: number } | null {
    const v = asView(frame);
    if (!v) return null;
    const w = v.w * 2 + 2;
    const h = v.h + 2;
    return w <= aw && h <= ah ? { w, h } : null;
  }

  need(frame: unknown): { w: number; h: number } {
    const v = asView(frame);
    return v ? { w: v.w * 2 + 2, h: v.h + 2 } : { w: 80, h: 24 };
  }

  key(k: Key): unknown {
    const d = dirOf(k);
    return d < 0 ? undefined : { d };
  }

  help(): string {
    return '←↑↓→ / WASD steer';
  }

  status(frame: unknown): string {
    const v = asView(frame);
    if (!v) return '';
    if (v.mode === 'frenzy') return `frenzy · ${Math.floor(v.tl / 60)}:${String(v.tl % 60).padStart(2, '0')} left`;
    return `round ${v.r}/${v.R}${v.sd ? ' · WALLS CLOSING' : ''}`;
  }

  scoreboard(frame: unknown, ctx: ViewCtx): SideLine[] {
    const v = asView(frame);
    if (!v) return [];
    const rows = [...v.s].sort((a, b) => (b[3] ?? 0) - (a[3] ?? 0));
    const lines: SideLine[] = rows.map((r) => {
      const [slot = 0, alive = 0, len = 0, score = 0, , , , , resp = 0, wins = 0, , out = 0] = r;
      const state = out ? 'left' : alive ? `len ${len}` : resp ? `back ${resp}s` : 'out';
      const name = fit(ctx.nick(slot), 10);
      const mark = v.mode === 'survival' && wins ? ' ' + '♦'.repeat(Math.min(wins, 5)) : '';
      return {
        slot,
        text: `${pad(name, 10)} ${pad(String(score), 3, 'right')} ${state}${mark}`,
        fg: slot === ctx.me ? C.bwhite : alive ? -1 : C.gray,
        at: slot === ctx.me ? BOLD : 0,
      };
    });
    lines.push({ text: '' });
    lines.push({ text: '▐▌ +1  ◄► +3 gold', fg: C.gray });
    lines.push({ text: '≈≈ ghost  »» turbo', fg: C.gray });
    return lines;
  }

  draw(s: Surface, frame: unknown, ctx: ViewCtx): void {
    const v = asView(frame);
    if (!v) return;
    const color = ctx.color;
    const blink = Math.floor(ctx.now / 250) % 2 === 0;
    s.box(0, 0, s.w, s.h, v.wrap ? C.gray : C.white, -1, v.wrap ? 'single' : 'double');
    if (v.wrap) for (let x = 2; x < s.w - 2; x += 4) {
      s.set(x, 0, ' ');
      s.set(x, s.h - 1, ' ');
    }
    const info = new Map<number, number[]>();
    for (const r of v.s) info.set(r[0] ?? 0, r);
    for (let y = 0; y < v.h; y++) {
      for (let x = 0; x < v.w; x++) {
        const c = v.g[y * v.w + x]!;
        const px = 1 + x * 2;
        const py = 1 + y;
        const code = c.charCodeAt(0);
        if (c === ' ') {
          if (x % 3 === 1 && y % 2 === 1) s.put(px, py, '·', C.gray, -1, DIM);
        } else if (c === '#') {
          s.put(px, py, '▓', C.gray, -1, 0);
          s.put(px + 1, py, '▓', C.gray, -1, 0);
        } else if (c === '+') {
          s.put(px, py, blink ? '░' : '▒', C.bred, -1, 0);
          s.put(px + 1, py, blink ? '░' : '▒', C.bred, -1, 0);
        } else if (c === 'o') {
          s.put(px, py, '▐', C.bred, -1, 0);
          s.put(px + 1, py, '▌', C.bred, -1, 0);
        } else if (c === '*') {
          s.put(px, py, '◄', blink ? C.byellow : C.bwhite, -1, BOLD);
          s.put(px + 1, py, '►', blink ? C.byellow : C.bwhite, -1, BOLD);
        } else if (c === 'g') {
          s.put(px, py, '≈', C.bcyan, -1, BOLD);
          s.put(px + 1, py, '≈', C.bcyan, -1, BOLD);
        } else if (c === 't') {
          s.put(px, py, '»', C.bmagenta, -1, BOLD);
          s.put(px + 1, py, '»', C.bmagenta, -1, BOLD);
        } else if (code >= 48 && code < 56) {
          const col = seatColor(code - 48);
          s.put(px, py, '▒', col, -1, DIM);
          s.put(px + 1, py, '▒', col, -1, DIM);
        } else if (code >= 65 && code < 73) {
          const slot = code - 65;
          const r = info.get(slot);
          const ghost = r?.[5] === 1;
          const shield = r?.[7] === 1;
          const col = seatColor(slot);
          const glyph = !color ? MONO_BODY[slot]! : ghost ? '░░' : shield && !blink ? '▒▒' : '██';
          s.put(px, py, glyph[0]!, col, -1, 0);
          s.put(px + 1, py, glyph[1]!, col, -1, 0);
        } else if (code >= 97 && code < 105) {
          const slot = code - 97;
          const r = info.get(slot);
          const turbo = r?.[6] === 1;
          const col = seatColor(slot);
          const mine = slot === ctx.me;
          if (color) {
            const bg = turbo && blink ? C.bwhite : col;
            s.put(px, py, '•', C.black, bg, BOLD);
            s.put(px + 1, py, '•', C.black, bg, BOLD);
          } else {
            const ch = String.fromCharCode(65 + slot);
            s.put(px, py, ch, -1, -1, mine ? REVERSE | BOLD : BOLD);
            s.put(px + 1, py, ch, -1, -1, mine ? REVERSE | BOLD : BOLD);
          }
        }
      }
    }
    // Where am I? Point at our head while the round is starting.
    const me = ctx.me;
    if (me !== null && (v.ph === 'count' || (v.ph === 'play' && blink && this.justStarted(v)))) {
      const hi = v.g.indexOf(String.fromCharCode(97 + me));
      if (hi >= 0) {
        // A tag right above (or below) our head, so it never hides the snake.
        const hx = 1 + (hi % v.w) * 2;
        const hy = 1 + Math.floor(hi / v.w);
        const above = hy > 1;
        const label = above ? ' YOU ▼ ' : ' YOU ▲ ';
        const lx = Math.max(1, Math.min(s.w - 1 - label.length, hx - 4));
        s.text(lx, above ? hy - 1 : hy + 1, label, C.black, C.bwhite, BOLD);
      }
    }
    const mid = Math.floor(s.h / 2);
    if (v.ph === 'count') {
      const big = s.h >= 11 && bigWidth(String(v.cd)) + 6 < s.w;
      const boxW = Math.min(s.w - 4, Math.max(16, (v.b ? v.b.length : 0) + 6));
      const boxH = big ? 9 : 4;
      const bx = (s.w - boxW) >> 1;
      const by = Math.max(1, mid - (boxH >> 1));
      s.fill(bx, by, boxW, boxH, ' ', -1, C.black);
      s.box(bx, by, boxW, boxH, C.bwhite, C.black, 'single');
      if (v.b) s.center(by + 1, v.b, C.byellow, C.black, BOLD, bx + 1, boxW - 2);
      if (big) bigCenter(s, by + 3, String(v.cd), C.bwhite, 'big', bx, boxW);
      else s.center(by + 2, `starts in ${v.cd}`, C.bwhite, C.black, BOLD, bx + 1, boxW - 2);
    } else if (v.ph === 'round' || v.ph === 'over') {
      s.center(mid, ` ${fit(v.b, s.w - 6)} `, C.black, C.byellow, BOLD);
    } else if (me !== null) {
      const mine = v.s.find((r) => r[0] === me);
      if (mine && !mine[1]) {
        const msg = mine[11] ? '' : v.mode === 'frenzy' ? ` respawning in ${mine[8]}… ` : ' you crashed — watch the rest of the round ';
        if (msg) s.center(s.h - 2, msg, C.black, C.bred, BOLD);
      }
    }
    if (me === null && v.ph === 'play') s.center(s.h - 1, ' spectating — you join next match ', C.gray, -1, 0);
  }

  private startedAt = 0;
  private lastRound = -1;
  private justStarted(v: SnakeView): boolean {
    if (v.r !== this.lastRound) {
      this.lastRound = v.r;
      this.startedAt = Date.now();
    }
    return Date.now() - this.startedAt < 1500;
  }
}

export const snakeGame: GameDef = {
  id: 'snake',
  title: 'Snake Arena',
  tag: 'eat, grow and make everyone else crash',
  genre: 'real-time',
  min: 1,
  max: 8,
  bots: true,
  accent: C.bgreen,
  about:
    'Everyone steers a snake in one arena. Apples grow you, golden apples grow you fast, and anyone who runs into your body is out. Crashed snakes burst into food, so every crash starts a scramble. Grab ≈≈ to pass through snakes or »» for a burst of speed. Survival plays rounds; Frenzy is a timed brawl with respawns.',
  controls: ['←↑↓→ or WASD   steer (turns are buffered)', 'T              chat while you play', 'Esc            leave the table'],
  art: ['╔══════════════════════╗', '║  ██████••    ▐▌      ║', '║       ██   ◄►    ≈≈  ║', '║  ▐▌   ██████████••   ║', '║                 ▐▌   ║', '╚══════════════════════╝'],
  settings: [
    { key: 'mode', label: 'Mode', choices: [{ v: 'survival', label: 'Survival (rounds)' }, { v: 'frenzy', label: 'Frenzy (timed)' }] },
    { key: 'length', label: 'Length', choices: [{ v: 3, label: '3 rounds · 2 min' }, { v: 5, label: '5 rounds · 3 min' }, { v: 1, label: '1 round · 1 min' }] },
    { key: 'speed', label: 'Speed', choices: [{ v: 9, label: 'Normal' }, { v: 12, label: 'Fast' }, { v: 15, label: 'Insane' }, { v: 7, label: 'Chill' }] },
    { key: 'map', label: 'Arena', choices: [{ v: 'random', label: 'Random each round' }, { v: 'open', label: 'Open field' }, { v: 'pillars', label: 'Pillars' }, { v: 'caves', label: 'Caves' }, { v: 'maze', label: 'Labyrinth' }] },
    { key: 'edges', label: 'Edges', choices: [{ v: 'solid', label: 'Solid walls' }, { v: 'wrap', label: 'Wrap around' }] },
    { key: 'bots', label: 'Bots', choices: [{ v: 'normal', label: 'Normal' }, { v: 'hard', label: 'Hard' }, { v: 'easy', label: 'Easy' }] },
  ],
  create: (ctx) => new SnakeGame(ctx),
  client: () => new SnakeClient(),
};
