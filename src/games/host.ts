import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { GameDef, GameLogic, Phase, Player, Settings } from './types.js';
import { readSize, type GameMsg, type MemberInfo, type SizeData, type TableData } from './proto.js';
import { makeRng } from './rng.js';

// The host side of a table: seats players, runs the lobby, and drives the
// match with a fixed-timestep loop (inputs are applied the moment they arrive;
// the simulation advances in exact ticks no matter how the OS schedules
// timers). After every tick or input, each member gets their own view, and
// only when it actually changed.

export interface HostLink {
  /** Our own fingerprint — the host is always a member of its table. */
  readonly selfId: string;
  /** Deliver to a remote member (dropped silently if they are gone). */
  send(id: string, msg: GameMsg): void;
  /** Deliver to our own client. */
  local(msg: GameMsg): void;
  /** Announce to peers in the table's room (or to one peer). */
  advertise(msg: GameMsg, to?: string): void;
}

interface Member {
  id: string;
  slot: number; // -1 while spectating
  nick: string;
  bot: boolean;
  spec: boolean;
  size: SizeData;
  lastFrame: string;
}

const BOT_NAMES = ['Noodle', 'Pixel', 'Ziggy', 'Byte', 'Glitch', 'Blip', 'Nova', 'Fizz', 'Sprocket', 'Widget', 'Echo', 'Turbo'];
const MAX_MEMBERS = 32;
const FLUSH_GAP_MS = 15;

export class TableHost {
  readonly gid: string;
  phase: Phase = 'lobby';
  readonly settings: Settings = {};
  closed = false;
  private readonly members = new Map<string, Member>();
  private logic: GameLogic | null = null;
  private results: TableData['results'] = null;
  private loopTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private lastFlush = 0;
  private acc = 0;
  private last = 0;
  private botSeq = 0;

  constructor(
    readonly def: GameDef,
    readonly room: string,
    private readonly link: HostLink,
    private hostNick: string,
    hostSize: SizeData,
    gid: string = bytesToHex(randomBytes(8)),
  ) {
    this.gid = gid;
    for (const s of def.settings) this.settings[s.key] = s.choices[s.def ?? 0]!.v;
    this.members.set(link.selfId, { id: link.selfId, slot: 0, nick: hostNick, bot: false, spec: false, size: hostSize, lastFrame: '' });
  }

  // ---- roster ----

  get playerCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.spec) n++;
    return n;
  }

  roster(): Player[] {
    return [...this.members.values()]
      .filter((m) => !m.spec)
      .sort((a, b) => a.slot - b.slot)
      .map((m) => ({ slot: m.slot, nick: m.nick, bot: m.bot }));
  }

  private freeSlot(): number {
    const used = new Set<number>();
    for (const m of this.members.values()) if (!m.spec) used.add(m.slot);
    for (let s = 0; s < this.def.max; s++) if (!used.has(s)) return s;
    return -1;
  }

  /** Seat a peer: a player while the lobby has room, otherwise a spectator. */
  join(id: string, nick: string, size: SizeData): void {
    if (this.closed) return;
    const existing = this.members.get(id);
    if (existing) {
      existing.size = size;
      existing.lastFrame = '';
      this.sendTables();
      return;
    }
    if (this.members.size >= MAX_MEMBERS) {
      this.link.send(id, this.msg('deny', { reason: 'table is full' }));
      return;
    }
    let slot = this.phase === 'lobby' ? this.freeSlot() : -1;
    // Party games can take a new player mid-match; the rest seat them next match.
    if (this.phase === 'playing' && this.logic?.addPlayer) {
      const free = this.freeSlot();
      if (free >= 0 && this.logic.addPlayer({ slot: free, nick: nick.slice(0, 32), bot: false })) slot = free;
    }
    this.members.set(id, { id, slot, nick: nick.slice(0, 32), bot: false, spec: slot < 0, size, lastFrame: '' });
    this.feed(slot < 0 ? `${nick} is watching` : `${nick} joined`);
    this.changed();
  }

  leave(id: string): void {
    if (id === this.link.selfId) {
      this.close('the host closed the table');
      return;
    }
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.logic && !m.spec) this.logic.drop(m.slot);
    this.feed(`${m.nick} left`);
    this.changed();
    this.requestFlush();
  }

  rename(id: string, nick: string): void {
    const m = this.members.get(id);
    if (!m || m.nick === nick) return;
    m.nick = nick.slice(0, 32);
    if (id === this.link.selfId) this.hostNick = m.nick;
    this.changed();
  }

  resize(id: string, size: SizeData): void {
    const m = this.members.get(id);
    if (m) m.size = size;
  }

  addBot(): boolean {
    if (!this.def.bots || this.phase === 'playing') return false;
    const slot = this.freeSlot();
    if (slot < 0) return false;
    const taken = new Set([...this.members.values()].map((m) => m.nick));
    let nick = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot${this.botSeq + 1}`;
    if (taken.has(nick)) nick = `${nick}${this.botSeq}`;
    const id = `bot:${++this.botSeq}`;
    this.members.set(id, { id, slot, nick, bot: true, spec: false, size: { cols: 999, rows: 999 }, lastFrame: '' });
    this.changed();
    return true;
  }

  removeBot(): boolean {
    if (this.phase === 'playing') return false;
    const bots = [...this.members.values()].filter((m) => m.bot).sort((a, b) => b.slot - a.slot);
    if (!bots[0]) return false;
    this.members.delete(bots[0].id);
    this.promoteSpectators(); // someone waiting gets the seat
    this.changed();
    return true;
  }

  /** Step a lobby setting to its next/previous choice. */
  cycle(key: string, dir: 1 | -1): void {
    if (this.phase === 'playing') return;
    const def = this.def.settings.find((s) => s.key === key);
    if (!def) return;
    const i = def.choices.findIndex((c) => c.v === this.settings[key]);
    const n = def.choices.length;
    this.settings[key] = def.choices[(((i < 0 ? 0 : i) + dir) % n + n) % n]!.v;
    this.changed();
  }

  canStart(): boolean {
    return this.phase !== 'playing' && this.playerCount >= this.def.min;
  }

  // ---- match lifecycle ----

  start(): boolean {
    if (!this.canStart()) return false;
    this.promoteSpectators();
    const players = this.roster();
    const humans = [...this.members.values()].filter((m) => !m.bot && !m.spec);
    const arena = {
      cols: Math.min(...humans.map((m) => m.size.cols)),
      rows: Math.min(...humans.map((m) => m.size.rows)),
    };
    this.logic = this.def.create({
      players,
      settings: { ...this.settings },
      arena,
      rng: makeRng(),
      feed: (text, slot) => this.feed(text, slot),
    });
    this.results = null;
    this.phase = 'playing';
    for (const m of this.members.values()) m.lastFrame = '';
    this.changed();
    this.startLoop();
    this.flushFrames();
    return true;
  }

  /** From the results screen back to the lobby, keeping everyone seated. */
  toLobby(): void {
    if (this.phase !== 'results') return;
    this.phase = 'lobby';
    this.results = null;
    this.promoteSpectators();
    this.changed();
  }

  /** Abort a running match (host only) and return to the lobby. */
  abort(): void {
    if (this.phase !== 'playing') return;
    this.stopLoop();
    this.logic = null;
    this.phase = 'lobby';
    this.feed('the host ended the match');
    this.promoteSpectators();
    this.changed();
  }

  private promoteSpectators(): void {
    for (const m of this.members.values()) {
      if (!m.spec) continue;
      const slot = this.freeSlot();
      if (slot < 0) break;
      m.slot = slot;
      m.spec = false;
    }
  }

  input(id: string, data: unknown): void {
    const m = this.members.get(id);
    if (!m || m.spec || !this.logic || this.phase !== 'playing') return;
    try {
      this.logic.input(m.slot, data);
    } catch {
      return; // a malformed input must never take the table down
    }
    this.requestFlush();
  }

  private startLoop(): void {
    this.stopLoop();
    const tick = Math.max(5, this.logic?.tickMs ?? 50);
    this.acc = 0;
    this.last = performance.now();
    this.loopTimer = setInterval(() => this.step(), Math.max(4, Math.min(16, Math.floor(tick / 3))));
  }

  private stopLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
  }

  private step(): void {
    const logic = this.logic;
    if (!logic) return;
    const now = performance.now();
    this.acc += Math.min(now - this.last, 250);
    this.last = now;
    let ran = 0;
    try {
      while (this.acc >= logic.tickMs && ran < 8) {
        logic.tick();
        this.acc -= logic.tickMs;
        ran++;
        if (logic.done) break;
      }
    } catch (err) {
      // A bug in one game must never take the chat down with it.
      this.stopLoop();
      this.logic = null;
      this.phase = 'lobby';
      this.feed(`the match crashed and was stopped (${String(err).slice(0, 60)})`);
      this.changed();
      return;
    }
    if (!ran) return;
    if (logic.done) this.finish();
    else this.requestFlush();
  }

  private finish(): void {
    const logic = this.logic;
    if (!logic) return;
    this.stopLoop();
    this.flushFrames();
    this.results = { standings: logic.standings(), lines: logic.summary?.() ?? [] };
    this.logic = null;
    this.phase = 'results';
    this.changed();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLoop();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.logic = null;
    for (const m of this.members.values()) {
      if (m.bot) continue;
      const msg = this.msg('close', { reason });
      if (m.id === this.link.selfId) this.link.local(msg);
      else this.link.send(m.id, msg);
    }
    this.link.advertise(this.msg('close', { reason }));
  }

  /** Messages from remote peers addressed to this table. */
  handle(id: string, nick: string, msg: GameMsg): void {
    switch (msg.op) {
      case 'join':
        this.join(id, nick, readSize(msg.d));
        break;
      case 'leave':
        this.leave(id);
        break;
      case 'input':
        this.input(id, msg.d);
        break;
      case 'size':
        this.resize(id, readSize(msg.d));
        break;
      default:
        break;
    }
  }

  // ---- outbound ----

  private msg(op: GameMsg['op'], d?: unknown): GameMsg {
    return { t: 'game', room: this.room, gid: this.gid, op, d };
  }

  adData(): { kind: string; title: string; host: string; n: number; max: number; phase: Phase } {
    return { kind: this.def.id, title: this.def.title, host: this.hostNick, n: this.playerCount, max: this.def.max, phase: this.phase };
  }

  advertise(to?: string): void {
    if (!this.closed) this.link.advertise(this.msg('ad', this.adData()), to);
  }

  private changed(): void {
    this.sendTables();
    this.advertise();
  }

  /** Send the opening roster to members and the first ad to the room. */
  announce(): void {
    this.changed();
  }

  private tableFor(me: Member): TableData {
    const members: MemberInfo[] = [...this.members.values()]
      .sort((a, b) => (a.spec === b.spec ? a.slot - b.slot : a.spec ? 1 : -1))
      .map((m) => ({ slot: m.slot, nick: m.nick, bot: m.bot, spec: m.spec, host: m.id === this.link.selfId }));
    return {
      kind: this.def.id,
      host: this.hostNick,
      phase: this.phase,
      you: me.spec ? null : me.slot,
      spec: me.spec,
      min: this.def.min,
      max: this.def.max,
      members,
      settings: { ...this.settings },
      results: this.results,
    };
  }

  private deliver(m: Member, msg: GameMsg): void {
    if (m.bot) return;
    if (m.id === this.link.selfId) this.link.local(msg);
    else this.link.send(m.id, msg);
  }

  private sendTables(): void {
    for (const m of this.members.values()) this.deliver(m, this.msg('table', this.tableFor(m)));
  }

  private feed(text: string, slot?: number): void {
    for (const m of this.members.values()) this.deliver(m, this.msg('feed', { text: text.slice(0, 200), slot }));
  }

  private requestFlush(): void {
    if (this.flushTimer || this.closed) return;
    const wait = Math.max(0, FLUSH_GAP_MS - (performance.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushFrames();
    }, wait);
  }

  private flushFrames(): void {
    const logic = this.logic;
    if (!logic) return;
    this.lastFlush = performance.now();
    for (const m of this.members.values()) {
      if (m.bot) continue;
      let view: unknown;
      let json: string;
      try {
        view = logic.view(m.spec ? null : m.slot);
        json = JSON.stringify(view);
      } catch {
        continue;
      }
      if (json === m.lastFrame) continue;
      m.lastFrame = json;
      // Our own client gets a copy, never a live reference into game state.
      if (m.id === this.link.selfId) this.link.local(this.msg('frame', JSON.parse(json)));
      else this.link.send(m.id, this.msg('frame', view));
    }
  }

  /** The id of the member in a seat (for tests and the host UI). */
  memberIds(): string[] {
    return [...this.members.keys()];
  }
}
