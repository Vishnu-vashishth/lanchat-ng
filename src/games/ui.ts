import { BOLD, C, Canvas, DIM, REVERSE, cells, clean, fit, pad, seatColor, wrap, type Surface } from './term/canvas.js';
import { TermRenderer, type TermOut } from './term/renderer.js';
import { LOGO, bigCenter, bigWidth } from './term/font.js';
import type { Key } from './term/keys.js';
import { GAMES } from './registry.js';
import type { Ad, GameHub } from './hub.js';
import type { TableClient } from './client.js';
import type { GameDef, Player, SideLine, ViewCtx } from './types.js';
import type { FeedData, TableData } from './proto.js';

// The full-screen game UI: the arcade menu, a table's lobby, the live match
// (board + scoreboard + chat side panel) and the results screen. The chat
// never goes away — room messages scroll in the side panel and T opens a
// chat line, so trash talk keeps flowing while you play.

export interface ScreenEnv {
  out: TermOut;
  color: boolean;
  nick(): string;
  /** The chat room the user is looking at. */
  room(): string;
  peopleIn(room: string): number;
  /** Send a chat message to a room (and record it like any other). */
  say(room: string, text: string): void;
  /** Recent chat in a room, oldest first, to fill the chat panel. */
  recent(room: string): { nick: string; text: string; self: boolean }[];
  /** Return to the chat prompt. */
  exit(): void;
}

export type ScreenStart = { kind: 'arcade' } | { kind: 'host'; game: string } | { kind: 'join'; gid: string };

interface LogLine {
  kind: 'chat' | 'feed';
  nick?: string;
  nickFg?: number;
  text: string;
  fg: number;
  at: number;
}

type Entry = { kind: 'table'; ad: Ad } | { kind: 'game'; def: GameDef };

interface Dialog {
  title: string;
  lines: string[];
  options: { key: string; label: string; run: () => void }[];
}

const SIDE_W = 30;
const LOG_MAX = 200;
const MIN_W = 60;
const MIN_H = 18;
const ARCADE_ART_COLORS = [C.bred, C.byellow, C.bgreen, C.bcyan, C.bblue, C.bmagenta];

export class GameScreen {
  private readonly renderer: TermRenderer;
  private canvas = new Canvas(1, 1);
  private view: 'arcade' | 'table' = 'arcade';
  private sel = 0;
  private selKey: string | null = null;
  private lobbySel = 0;
  private readonly log: LogLine[] = [];
  private typing: string | null = null;
  private promptBuf = '';
  private dialog: Dialog | null = null;
  private toastMsg: { text: string; until: number } | null = null;
  private hidden = false;
  private active = false;
  private renderTimer: NodeJS.Timeout | undefined;
  private uiTimer: NodeJS.Timeout | undefined;
  private lastRender = 0;
  private lastSize = '';

  constructor(
    private readonly env: ScreenEnv,
    private readonly hub: GameHub,
  ) {
    this.renderer = new TermRenderer(env.out, env.color);
  }

  // ---- lifecycle ----

  get isOpen(): boolean {
    return this.active;
  }

  open(start: ScreenStart): void {
    if (!this.active) {
      if (!this.log.length) for (const m of this.env.recent(this.env.room())) this.chat(this.env.room(), m.nick, m.text, m.self);
      this.active = true;
      this.hub.on('change', this.requestRender);
      this.hub.on('feed', this.onFeed);
      this.renderer.enter();
      this.uiTimer = setInterval(() => this.tickUi(), 150);
    }
    this.dialog = null;
    this.typing = null;
    if (start.kind !== 'arcade') {
      // A new table: drop the previous table's event lines, keep the chat.
      const chat = this.log.filter((l) => l.kind === 'chat');
      this.log.length = 0;
      this.log.push(...chat);
    }
    if (start.kind === 'host') {
      const c = this.hub.host(start.game, this.env.room(), this.size());
      this.view = c ? 'table' : 'arcade';
      if (c) this.note(`you opened a ${c.def.title} table in #${c.room}`);
    } else if (start.kind === 'join') {
      const c = this.hub.join(start.gid, this.size());
      this.view = c ? 'table' : 'arcade';
      if (!c) this.toast('that table is gone');
    } else {
      this.view = 'arcade';
    }
    this.render();
  }

  /** Restore the terminal. Does not leave the table — see exitToChat(). */
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.hub.off('change', this.requestRender);
    this.hub.off('feed', this.onFeed);
    if (this.uiTimer) clearInterval(this.uiTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.uiTimer = undefined;
    this.renderTimer = undefined;
    this.renderer.leave();
  }

  private exitToChat(): void {
    this.hub.leave();
    this.close();
    this.env.exit();
  }

  private size(): { cols: number; rows: number } {
    return { cols: this.env.out.columns || 80, rows: this.env.out.rows || 24 };
  }

  resized(): void {
    this.renderer.invalidate();
    this.hub.client?.resize(this.size());
    this.render();
  }

  /** Panic key: blank the screen until pressed again. */
  setHidden(on: boolean): void {
    this.hidden = on;
    if (on) this.renderer.blank();
    else {
      this.renderer.invalidate();
      this.render();
    }
  }

  private tickUi(): void {
    const c = this.hub.client;
    // Re-render for clocks, blinking and timeouts; frames drive the rest.
    if (this.view === 'arcade' || !c || c.closed || !c.table || c.table.phase !== 'playing' || Date.now() - c.frameAt > 120) this.requestRender();
  }

  // ---- incoming chat / feed ----

  chat(room: string, nick: string, body: string, self: boolean): void {
    const c = this.hub.client;
    const watching = c && !c.closed ? c.room : this.env.room();
    if (room !== watching) return;
    const slot = this.slotOfNick(nick);
    this.push({ kind: 'chat', nick: clean(nick, 32), nickFg: self ? C.bgreen : slot >= 0 ? seatColor(slot) : C.byellow, text: clean(body, 400), fg: -1, at: 0 });
  }

  note(text: string): void {
    this.push({ kind: 'feed', text: `· ${clean(text, 300)}`, fg: C.gray, at: 0 });
  }

  private onFeed = (f: FeedData): void => {
    this.push({ kind: 'feed', text: `· ${clean(f.text, 300)}`, fg: f.slot !== undefined ? seatColor(f.slot) : C.gray, at: 0 });
  };

  private push(l: LogLine): void {
    this.log.push(l);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    this.requestRender();
  }

  private slotOfNick(nick: string): number {
    const m = this.hub.client?.table?.members.find((x) => x.nick === nick && !x.spec);
    return m ? m.slot : -1;
  }

  private toast(text: string): void {
    this.toastMsg = { text, until: Date.now() + 2200 };
    this.requestRender();
  }

  // ---- keys ----

  key(k: Key): void {
    if (this.hidden || !this.active) return;
    try {
      this.handleKey(k);
    } catch {
      // A malformed frame from a (possibly hostile) host must not take the chat down.
      this.toast('ignored a bad update from the host');
    }
    this.render();
  }

  private handleKey(k: Key): void {
    if (this.dialog) {
      const opt = this.dialog.options.find((o) => o.key === k.name);
      if (opt) {
        this.dialog = null;
        opt.run();
      } else if (k.name === 'escape' || k.name === 'n') this.dialog = null;
      return;
    }
    if (this.typing !== null) {
      this.typeKey(k);
      return;
    }
    if (this.view === 'arcade') this.arcadeKey(k);
    else this.tableKey(k);
  }

  private typeKey(k: Key): void {
    if (k.name === 'escape') this.typing = null;
    else if (k.name === 'enter') {
      const text = (this.typing ?? '').trim();
      this.typing = null;
      if (text) {
        const c = this.hub.client;
        const room = c && !c.closed ? c.room : this.env.room();
        this.env.say(room, text);
        this.chat(room, this.env.nick(), text, true);
      }
    } else if (k.name === 'backspace') this.typing = [...(this.typing ?? '')].slice(0, -1).join('');
    else if (k.ctrl && k.name === 'u') this.typing = '';
    else if (k.ch && cells(this.typing ?? '') < 300) this.typing = (this.typing ?? '') + k.ch;
  }

  private entries(): Entry[] {
    const tables: Entry[] = this.hub.tables().map((ad) => ({ kind: 'table', ad }));
    return [...tables, ...GAMES.map((def): Entry => ({ kind: 'game', def }))];
  }

  private static entryKey(e: Entry): string {
    return e.kind === 'table' ? `table:${e.ad.gid}` : `game:${e.def.id}`;
  }

  /** Index of the highlighted entry. The highlight follows the entry itself, so a
   *  table appearing or closing never moves it onto something else. */
  private selIndex(list: Entry[]): number {
    const at = this.selKey ? list.findIndex((e) => GameScreen.entryKey(e) === this.selKey) : -1;
    this.sel = at >= 0 ? at : Math.max(0, Math.min(this.sel, list.length - 1));
    const e = list[this.sel];
    this.selKey = e ? GameScreen.entryKey(e) : null;
    return this.sel;
  }

  private arcadeKey(k: Key): void {
    const list = this.entries();
    const n = Math.max(1, list.length);
    const cur = this.selIndex(list);
    const move = (i: number) => {
      const e = list[i];
      this.sel = i;
      this.selKey = e ? GameScreen.entryKey(e) : null;
    };
    if (k.name === 'up' || k.name === 'w' || k.name === 'k') move((cur - 1 + n) % n);
    else if (k.name === 'down' || k.name === 's' || k.name === 'j') move((cur + 1) % n);
    else if (k.name === 'enter' || k.name === 'space') {
      const e = list[cur];
      if (!e) return;
      if (e.kind === 'table') this.open({ kind: 'join', gid: e.ad.gid });
      else this.open({ kind: 'host', game: e.def.id });
    } else if (k.name === 't' || k.name === 'tab') this.typing = '';
    else if (k.name === 'escape' || k.name === 'q' || (k.ctrl && k.name === 'c')) this.exitToChat();
  }

  private tableKey(k: Key): void {
    const c = this.hub.client;
    if (!c) {
      this.view = 'arcade';
      return;
    }
    if (c.closed) {
      // Any key acknowledges a closed table and goes back to the menu.
      this.hub.leave();
      this.view = 'arcade';
      return;
    }
    const t = c.table;
    const leave = k.name === 'escape' || (k.ctrl && k.name === 'c');
    if (leave && (k.ctrl || !t || t.phase !== 'playing' || c.frame === null)) {
      this.confirmLeave(c);
      return;
    }
    if (!t) return;
    if (t.phase === 'playing' && c.frame !== null) {
      const ctx = this.ctx(c, t);
      const prompt = this.safe(() => c.game.prompt?.(c.frame, ctx) ?? null, null);
      if (prompt) {
        // Free-typing mode (guessing games): letters go to the prompt box.
        if (k.name === 'enter') {
          const text = this.promptBuf.trim();
          this.promptBuf = '';
          if (text) c.input(this.safe(() => c.game.submit?.(text, c.frame, ctx), undefined));
          return;
        }
        if (k.name === 'backspace') {
          this.promptBuf = [...this.promptBuf].slice(0, -1).join('');
          return;
        }
        if (k.ch && cells(this.promptBuf) < 60) {
          this.promptBuf += k.ch;
          return;
        }
      }
      // The game gets first refusal (Esc closes its own pickers); otherwise Esc leaves.
      const out = this.safe(() => c.game.key(k, c.frame, ctx), undefined);
      if (out !== undefined) {
        if (out !== null) c.input(out);
        return;
      }
      if (leave) this.confirmLeave(c);
      else if (k.name === 't' || k.name === 'tab') this.typing = '';
      return;
    }
    if (k.name === 't' || k.name === 'tab') {
      this.typing = '';
      return;
    }
    const h = this.hub.hosted;
    if (t.phase === 'lobby' && h && c.hosting) {
      const defs = c.def.settings;
      if (k.name === 'up' || k.name === 'w') this.lobbySel = (this.lobbySel - 1 + defs.length) % Math.max(1, defs.length);
      else if (k.name === 'down' || k.name === 's') this.lobbySel = (this.lobbySel + 1) % Math.max(1, defs.length);
      else if ((k.name === 'left' || k.name === 'a' || k.name === 'right' || k.name === 'd') && defs[this.lobbySel]) {
        h.cycle(defs[this.lobbySel]!.key, k.name === 'left' || k.name === 'a' ? -1 : 1);
      } else if (k.name === 'b' || k.name === '+') {
        if (!c.def.bots) this.toast(`${c.def.title} has no bots — it needs real people`);
        else if (!h.addBot()) this.toast('no free seat for a bot');
      } else if (k.name === 'x' || k.name === '-' || k.name === 'delete') {
        if (!h.removeBot()) this.toast('no bots to remove');
      } else if (k.name === 'enter') {
        if (!h.start()) this.toast(`need at least ${c.def.min} players${c.def.bots ? ' — press B to add a bot' : ''}`);
      }
    } else if (t.phase === 'results' && h && c.hosting) {
      if (k.name === 'enter') h.toLobby();
    }
  }

  private confirmLeave(c: TableClient): void {
    const toMenu = () => {
      this.hub.leave();
      this.view = 'arcade';
    };
    if (c.hosting && c.table?.phase === 'playing') {
      this.dialog = {
        title: 'End the match?',
        lines: ['You are hosting this table.'],
        options: [
          { key: 'e', label: 'E  end the match, back to the lobby', run: () => this.hub.hosted?.abort() },
          { key: 'y', label: 'Y  close the table for everyone', run: toMenu },
          { key: 'n', label: 'N  keep playing', run: () => undefined },
        ],
      };
    } else if (c.hosting) {
      this.dialog = {
        title: 'Close this table?',
        lines: ['Everyone seated here goes back to the arcade.'],
        options: [
          { key: 'y', label: 'Y  close it', run: toMenu },
          { key: 'n', label: 'N  stay', run: () => undefined },
        ],
      };
    } else {
      this.dialog = {
        title: 'Leave this table?',
        lines: [],
        options: [
          { key: 'y', label: 'Y  leave', run: toMenu },
          { key: 'n', label: 'N  stay', run: () => undefined },
        ],
      };
    }
  }

  // ---- rendering ----

  requestRender = (): void => {
    if (this.renderTimer || !this.active) return;
    const wait = Math.max(0, 16 - (Date.now() - this.lastRender));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, wait);
  };

  render(): void {
    if (!this.active || this.hidden) return;
    this.lastRender = Date.now();
    const { cols, rows } = this.size();
    const sizeKey = `${cols}x${rows}`;
    if (sizeKey !== this.lastSize || this.canvas.w !== cols || this.canvas.h !== rows) {
      this.canvas = new Canvas(cols, rows);
      this.lastSize = sizeKey;
    } else this.canvas.clear();
    const s = this.canvas;
    if (cols < MIN_W || rows < MIN_H) {
      s.center(Math.floor(rows / 2) - 1, 'LAN ARCADE', C.bcyan, -1, BOLD);
      s.center(Math.floor(rows / 2), `make this window at least ${MIN_W}x${MIN_H}`, C.byellow);
      s.center(Math.floor(rows / 2) + 1, `(now ${cols}x${rows}) · Esc to go back`, C.gray);
    } else {
      try {
        if (this.view === 'arcade') this.drawArcade(s);
        else this.drawTable(s);
      } catch {
        // Never let a malformed frame (or a game bug) escape a render timer.
        s.clear();
        s.center(Math.floor(rows / 2) - 1, 'the host sent an update this screen could not draw', C.byellow);
        s.center(Math.floor(rows / 2), 'Esc to leave the table', C.gray);
      }
    }
    if (this.dialog) this.drawDialog(s, this.dialog);
    if (this.toastMsg) {
      if (Date.now() > this.toastMsg.until) this.toastMsg = null;
      else {
        const t = ` ${fit(this.toastMsg.text, cols - 6)} `;
        const x = Math.max(0, cols - cells(t) - 2);
        s.text(x, rows - 3, t, C.black, C.byellow, BOLD);
      }
    }
    this.renderer.flush(s);
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  private ctx(c: TableClient, t: TableData): ViewCtx {
    const players: Player[] = t.members.filter((m) => !m.spec).map((m) => ({ slot: m.slot, nick: m.nick, bot: m.bot }));
    return {
      me: t.you,
      players,
      nick: (slot) => clean(players.find((p) => p.slot === slot)?.nick ?? `P${slot + 1}`, 32),
      color: this.env.color,
      now: Date.now(),
    };
  }

  private footer(s: Surface, text: string): void {
    const y = s.h - 1;
    s.fill(0, y, s.w, 1, ' ', -1, C.black);
    if (this.typing !== null) {
      const label = ' say › ';
      s.text(0, y, label, C.black, C.bcyan, BOLD);
      const room = this.hub.client && !this.hub.client.closed ? this.hub.client.room : this.env.room();
      const hint = `  Enter send to #${room} · Esc cancel `;
      const avail = s.w - cells(label) - cells(hint) - 1;
      const shown = [...this.typing].slice(-Math.max(1, avail)).join('');
      const x = s.text(cells(label), y, shown, C.bwhite, C.black);
      s.set(cells(label) + x, y, '█', C.bcyan, C.black);
      s.text(s.w - cells(hint) - 1, y, hint, C.gray, C.black);
      return;
    }
    s.text(1, y, fit(text, s.w - 2), C.gray, C.black);
  }

  // ---- arcade menu ----

  private drawArcade(s: Surface): void {
    const W = s.w;
    const H = s.h;
    const room = this.env.room();
    const logoW = cells(LOGO[0]!);
    const lx = Math.max(0, (W - logoW) >> 1);
    for (let r = 0; r < LOGO.length; r++) {
      let i = 0;
      for (const ch of LOGO[r]!) {
        const color = ARCADE_ART_COLORS[Math.floor(i / 4) % ARCADE_ART_COLORS.length]!;
        if (ch !== ' ') s.put(lx + i, 1 + r, ch, color, -1, BOLD);
        i++;
      }
    }
    const people = this.env.peopleIn(room);
    s.center(3, `multiplayer terminal games over your encrypted chat · #${room} · ${people} other${people === 1 ? '' : 's'} here`, C.gray);

    const list = this.entries();
    this.selIndex(list);
    const top = 5;
    const bottom = H - 2;
    const leftW = Math.min(44, Math.max(34, Math.floor(W * 0.42)));
    const twoCol = W >= 90;
    const listW = twoCol ? leftW : W - 4;
    const L = s.region(2, top, listW, bottom - top);
    let y = 0;
    L.text(0, y++, 'OPEN TABLES', C.bwhite, -1, BOLD);
    const tables = list.filter((e) => e.kind === 'table');
    if (!tables.length) L.text(2, y++, `none in your rooms yet — host one below`, C.gray);
    list.forEach((e, i) => {
      if (e.kind !== 'table') return;
      const ad = e.ad;
      const on = i === this.sel;
      const label = `${ad.title} · ${clean(ad.host, 16)}`;
      const right = `${ad.n}/${ad.max} ${ad.phase === 'lobby' ? 'open' : ad.phase === 'playing' ? 'playing' : 'results'}`;
      this.listRow(L, y++, listW, label, right, on, ad.phase === 'lobby' ? C.bgreen : C.byellow);
    });
    y++;
    L.text(0, y++, 'START A NEW GAME', C.bwhite, -1, BOLD);
    list.forEach((e, i) => {
      if (e.kind !== 'game') return;
      const on = i === this.sel;
      this.listRow(L, y++, listW, e.def.title, `${e.def.min}-${e.def.max} · ${e.def.genre}`, on, e.def.accent);
    });

    // detail panel
    const chosen = list[this.sel];
    let dx: number;
    let dy: number;
    let dw: number;
    let dh: number;
    if (twoCol) {
      dx = 2 + leftW + 2;
      dy = top;
      dw = W - dx - 2;
      dh = bottom - top;
    } else {
      dx = 2;
      dy = top + y + 1;
      dw = W - 4;
      dh = bottom - dy;
    }
    if (chosen && dh >= 6) this.drawDetail(s.region(dx, dy, dw, dh), chosen, room);

    // recent chat under the list, if there is room
    if (twoCol) {
      const chatTop = y + 2;
      const chatH = bottom - top - chatTop;
      if (chatH >= 4) {
        const R = L.region(0, chatTop, listW, chatH);
        R.box(0, 0, listW, chatH, C.gray, -1, 'single', `chat #${room}`, C.gray);
        this.drawLog(R.region(1, 1, listW - 2, chatH - 2));
      }
    }
    this.footer(s, '↑↓ choose · Enter play/join · T chat · Esc back to chat');
  }

  private listRow(s: Surface, y: number, w: number, label: string, right: string, on: boolean, accent: number): void {
    if (on) s.fill(0, y, w, 1, ' ', -1, C.black);
    s.text(0, y, on ? '▶' : ' ', accent, on ? C.black : -1, BOLD);
    const rw = cells(right);
    s.text(2, y, fit(label, w - rw - 4), on ? C.bwhite : -1, on ? C.black : -1, on ? BOLD : 0);
    s.text(w - rw, y, right, on ? accent : C.gray, on ? C.black : -1, on && this.env.color ? 0 : on ? REVERSE : 0);
  }

  private drawDetail(s: Surface, e: Entry, room: string): void {
    const def = e.kind === 'game' ? e.def : GAMES.find((g) => g.id === e.ad.kind);
    s.box(0, 0, s.w, s.h, def?.accent ?? C.gray, -1, 'double', def ? def.title.toUpperCase() : 'UNKNOWN GAME', def?.accent ?? C.gray);
    const I = s.region(2, 1, s.w - 4, s.h - 2);
    if (!def) {
      I.text(0, 0, 'This table runs a game your version does not know.', C.byellow);
      I.text(0, 1, 'Update with /selfupdate to join it.', C.gray);
      return;
    }
    let y = 0;
    I.text(0, y++, `${def.genre} · ${def.min === def.max ? def.min : `${def.min}-${def.max}`} players${def.bots ? ' · bots available' : ''}`, C.gray);
    y++;
    const artW = Math.max(...def.art.map((l) => cells(l)));
    if (I.h - y > def.art.length + 6 && artW <= I.w) {
      for (const line of def.art) I.text(Math.max(0, (I.w - artW) >> 1), y++, line, def.accent);
      y++;
    }
    for (const line of wrap(def.about, I.w)) {
      if (y >= I.h - 3) break;
      I.text(0, y++, line);
    }
    y++;
    for (const line of def.controls) {
      if (y >= I.h - 2) break;
      I.text(0, y++, fit(line, I.w), C.bcyan);
    }
    const action =
      e.kind === 'table'
        ? `Enter  join ${clean(e.ad.host, 16)}'s table in #${e.ad.room}${e.ad.phase !== 'lobby' ? ' (watch until the next round)' : ''}`
        : `Enter  open a table in #${room} — everyone there gets an invite`;
    I.text(0, I.h - 1, fit(action, I.w), C.bgreen, -1, BOLD);
  }

  // ---- table views ----

  private drawTable(s: Surface): void {
    const c = this.hub.client;
    if (!c) {
      this.view = 'arcade';
      this.drawArcade(s);
      return;
    }
    const t = c.table;
    const def = c.def;
    // header bar
    s.fill(0, 0, s.w, 1, ' ', C.black, def.accent, BOLD);
    let hx = s.text(1, 0, `◆ ${def.title.toUpperCase()}`, C.black, def.accent, BOLD) + 2;
    hx += s.text(hx, 0, ` #${c.room} `, C.black, def.accent) + 1;
    if (t) hx += s.text(hx, 0, ` host ${clean(t.host, 16)} `, C.black, def.accent);
    let status = '';
    if (t?.phase === 'playing' && c.frame !== null && t) status = this.safe(() => c.game.status?.(c.frame, this.ctx(c, t)) ?? '', '');
    else if (t?.phase === 'lobby') status = `lobby · ${t.members.filter((m) => !m.spec).length}/${t.max}`;
    else if (t?.phase === 'results') status = 'results';
    if (t?.spec) status = `watching · ${status}`;
    if (status) {
      const st = fit(status, Math.max(0, s.w - hx - 3));
      s.text(s.w - cells(st) - 2, 0, st, C.black, def.accent, BOLD);
    }
    const body = s.region(0, 1, s.w, s.h - 2);
    if (c.closed) {
      this.drawMessage(body, ['TABLE CLOSED', c.closed, '', 'press any key for the arcade'], def.accent);
      this.footer(s, 'any key · back to the arcade');
      return;
    }
    if (!t) {
      const waited = Date.now() - c.openedAt;
      this.drawMessage(
        body,
        waited > 7000 ? ['NO ANSWER', 'the host did not respond', '', 'Esc to go back'] : ['JOINING', `asking the host for a seat${'.'.repeat(1 + (Math.floor(waited / 300) % 3))}`],
        def.accent,
      );
      this.footer(s, 'Esc leave');
      return;
    }
    if (t.phase === 'lobby') this.drawLobby(body, c, t);
    else if (t.phase === 'results') this.drawResults(body, c, t);
    else this.drawPlaying(body, c, t);
  }

  private drawMessage(s: Surface, lines: string[], accent: number): void {
    const y0 = Math.max(0, (s.h - lines.length - 2) >> 1);
    lines.forEach((l, i) => {
      if (i === 0) s.center(y0, `  ${l}  `, C.black, accent, BOLD);
      else s.center(y0 + 1 + i, l, i === 1 ? C.bwhite : C.gray);
    });
  }

  private sidebar(s: Surface, lines: SideLine[], title: string): void {
    s.box(0, 0, s.w, s.h, C.gray, -1, 'single', title, C.bwhite);
    const I = s.region(2, 1, s.w - 3, s.h - 2);
    let y = 0;
    for (const l of lines) {
      if (y >= I.h - 4) break;
      let x = 0;
      if (l.slot !== undefined) {
        I.text(0, y, this.env.color ? '██' : `${l.slot + 1}:`, seatColor(l.slot));
        x = 3;
      }
      I.text(x, y, fit(String(l.text ?? ''), I.w - x), typeof l.fg === 'number' ? l.fg : -1, -1, typeof l.at === 'number' ? l.at : 0);
      y++;
    }
    y++;
    if (I.h - y >= 3) {
      I.hline(-1, y, I.w + 1, '─', C.gray);
      I.text(0, y, ' chat ', C.gray);
      this.drawLog(I.region(0, y + 1, I.w, I.h - y - 1));
    }
  }

  private drawLog(s: Surface): void {
    if (s.h <= 0 || s.w <= 4) return;
    const rows: { parts: { text: string; fg: number; at: number }[] }[] = [];
    for (let i = this.log.length - 1; i >= 0 && rows.length < s.h; i--) {
      const l = this.log[i]!;
      const prefix = l.nick ? `${l.nick}: ` : '';
      const lines = wrap(prefix + l.text, s.w);
      for (let j = lines.length - 1; j >= 0 && rows.length < s.h; j--) {
        const line = lines[j]!;
        if (j === 0 && l.nick) {
          const n = Math.min(cells(prefix), cells(line));
          rows.push({
            parts: [
              { text: [...line].slice(0, n).join(''), fg: l.nickFg ?? C.byellow, at: BOLD },
              { text: [...line].slice(n).join(''), fg: l.fg, at: l.at },
            ],
          });
        } else rows.push({ parts: [{ text: line, fg: l.fg, at: l.at }] });
      }
    }
    rows.reverse();
    const y0 = s.h - rows.length;
    rows.forEach((r, i) => {
      let x = 0;
      for (const p of r.parts) x += s.text(x, y0 + i, p.text, p.fg, -1, p.at);
    });
  }

  private rosterLines(t: TableData): SideLine[] {
    const lines: SideLine[] = [];
    for (const m of t.members) {
      if (m.spec) continue;
      lines.push({ slot: m.slot, text: `${clean(m.nick, 20)}${m.bot ? ' ·bot' : ''}${m.host ? ' ·host' : ''}${m.slot === t.you ? ' (you)' : ''}`, fg: m.slot === t.you ? C.bwhite : -1 });
    }
    const watchers = t.members.filter((m) => m.spec);
    if (watchers.length) lines.push({ text: `watching: ${watchers.map((m) => clean(m.nick, 12)).join(', ')}`, fg: C.gray });
    return lines;
  }

  private drawLobby(s: Surface, c: TableClient, t: TableData): void {
    const def = c.def;
    const host = c.hosting;
    const W = s.w;
    const seated = t.members.filter((m) => !m.spec);
    const leftW = Math.min(36, Math.floor((W - 6) / 2));
    const rightW = W - leftW - 6;
    const boxH = Math.max(6, Math.min(s.h - 8, Math.max(seated.length + 3, def.settings.length + 3, 8)));
    // players
    const P = s.region(2, 1, leftW, boxH);
    P.box(0, 0, leftW, boxH, def.accent, -1, 'single', `PLAYERS ${seated.length}/${t.max}`, C.bwhite);
    let y = 1;
    for (const line of this.rosterLines(t)) {
      if (y >= boxH - 1) break;
      if (line.slot !== undefined) P.text(2, y, this.env.color ? '██' : `${line.slot + 1}:`, seatColor(line.slot));
      P.text(line.slot !== undefined ? 5 : 2, y, fit(line.text, leftW - 7), line.fg ?? -1);
      y++;
    }
    const need = Math.max(0, def.min - seated.length);
    if (need > 0 && y < boxH - 1) P.text(2, boxH - 2, fit(`need ${need} more${def.bots ? ' (B adds a bot)' : ''}`, leftW - 4), C.byellow);
    // settings
    const S = s.region(4 + leftW, 1, rightW, boxH);
    S.box(0, 0, rightW, boxH, def.accent, -1, 'single', host ? 'SETTINGS  ↑↓ ←→' : 'SETTINGS', C.bwhite);
    const labelW = Math.max(6, ...def.settings.map((d) => cells(d.label))) + 2;
    def.settings.forEach((d, i) => {
      const yy = 1 + i;
      if (yy >= boxH - 1) return;
      const on = host && i === this.lobbySel;
      const val = d.choices.find((ch) => ch.v === t.settings[d.key])?.label ?? String(t.settings[d.key] ?? '?');
      S.text(2, yy, on ? '▶' : ' ', def.accent, -1, BOLD);
      S.text(4, yy, pad(d.label, labelW), on ? C.bwhite : C.gray, -1, on ? BOLD : 0);
      const v = host ? `◀ ${val} ▶` : val;
      S.text(4 + labelW, yy, fit(v, rightW - labelW - 6), on ? C.black : C.bwhite, on ? def.accent : -1, BOLD);
    });
    if (!def.settings.length) S.text(2, 1, 'no options for this game', C.gray);
    // about + controls
    let yy = boxH + 2;
    const infoW = W - 4;
    for (const line of wrap(def.about, infoW)) {
      if (yy >= s.h - 6) break;
      s.text(2, yy++, line, C.gray);
    }
    yy++;
    for (const line of def.controls) {
      if (yy >= s.h - 5) break;
      s.text(2, yy++, fit(line, infoW), C.bcyan);
    }
    // chat panel
    const logTop = yy + 1;
    const logH = s.h - logTop;
    if (logH >= 3) {
      s.box(2, logTop, W - 4, logH, C.gray, -1, 'single', 'chat', C.gray);
      this.drawLog(s.region(3, logTop + 1, W - 6, logH - 2));
    }
    const help = host
      ? `Enter start · ↑↓←→ settings${def.bots ? ' · B/X add/drop bot' : ''} · T chat · Esc close`
      : `waiting for ${clean(t.host, 16)} to start · T chat · Esc leave`;
    this.footer(this.canvas, help);
  }

  private drawPlaying(s: Surface, c: TableClient, t: TableData): void {
    const frame = c.frame;
    if (frame === null) {
      this.drawMessage(s, ['GET READY', 'waiting for the first frame…'], c.def.accent);
      this.footer(this.canvas, 'T chat · Esc leave');
      return;
    }
    const ctx = this.ctx(c, t);
    const g = c.game;
    let side = s.w >= 80 + SIDE_W;
    let availW = side ? s.w - SIDE_W - 1 : s.w;
    let m = this.safe(() => g.measure(frame, availW, s.h), null);
    if (!m && side) {
      side = false;
      availW = s.w;
      m = this.safe(() => g.measure(frame, availW, s.h), null);
    }
    if (m && !side && s.w - m.w >= SIDE_W + 1) {
      side = true;
      availW = s.w - SIDE_W - 1;
    }
    if (!m) {
      const need = this.safe(() => g.need(frame), { w: 80, h: 24 });
      this.drawMessage(s, ['TOO SMALL', `this board needs a ${need.w}x${need.h + 2} terminal`, `yours is ${this.canvas.w}x${this.canvas.h} — enlarge it or zoom out`], c.def.accent);
      this.footer(this.canvas, 'T chat · Esc leave');
      return;
    }
    const bx = Math.max(0, (availW - m.w) >> 1);
    const by = Math.max(0, (s.h - m.h) >> 1);
    const board = s.region(bx, by, m.w, m.h);
    this.safe(() => g.draw(board, frame, ctx), undefined);
    if (side) {
      const lines = this.safe(() => g.scoreboard?.(frame, ctx) ?? this.rosterLines(t), this.rosterLines(t));
      this.sidebar(s.region(s.w - SIDE_W, 0, SIDE_W, s.h), lines, 'SCORES');
    } else {
      // No room for the side panel: show the newest chat line under the board.
      const spare = s.h - (by + m.h);
      if (spare >= 1) this.drawLog(s.region(1, by + m.h, s.w - 2, Math.min(2, spare)));
    }
    const prompt = this.safe(() => g.prompt?.(frame, ctx) ?? null, null);
    if (prompt && this.typing === null) {
      const y = this.canvas.h - 1;
      this.canvas.fill(0, y, this.canvas.w, 1, ' ', -1, C.black);
      const label = ` ${prompt} › `;
      this.canvas.text(0, y, label, C.black, C.byellow, BOLD);
      const x = this.canvas.text(cells(label), y, this.promptBuf, C.bwhite, C.black);
      this.canvas.set(cells(label) + x, y, '█', C.byellow, C.black);
      const hint = ' Enter submit · Esc leave ';
      this.canvas.text(this.canvas.w - cells(hint) - 1, y, hint, C.gray, C.black);
      return;
    }
    this.footer(this.canvas, `${this.safe(() => g.help(frame, ctx), '')} · T chat · Esc leave`);
  }

  private drawResults(s: Surface, c: TableClient, t: TableData): void {
    const def = c.def;
    const r = t.results;
    const side = s.w >= 90;
    const mainW = side ? s.w - SIDE_W - 1 : s.w;
    const M = s.region(0, 0, mainW, s.h);
    let y = 1;
    const winner = r?.standings[0];
    const title = winner ? 'WINNER' : 'GAME OVER';
    if (M.h >= 20 && bigWidth(title) <= mainW - 4) {
      bigCenter(M, y, title, def.accent);
      y += 6;
    } else {
      M.center(y, `★ ${title} ★`, def.accent, -1, BOLD);
      y += 2;
    }
    if (winner) {
      M.center(y, clean(winner.nick, 24), seatColor(winner.slot), -1, BOLD);
      y += 2;
    }
    const medals = ['1st', '2nd', '3rd'];
    const rowW = Math.min(mainW - 4, 56);
    const x0 = Math.max(2, (mainW - rowW) >> 1);
    for (const [i, st] of (r?.standings ?? []).entries()) {
      if (y >= M.h - (r?.lines.length ? 4 : 2)) break;
      const place = medals[i] ?? `${i + 1}th`;
      const fg = i === 0 ? C.byellow : i === 1 ? C.bwhite : i === 2 ? C.yellow : C.gray;
      M.text(x0, y, pad(place, 5), fg, -1, BOLD);
      M.text(x0 + 5, y, this.env.color ? '██' : `${st.slot + 1}:`, seatColor(st.slot));
      M.text(x0 + 8, y, pad(clean(st.nick, 18), 19), st.slot === t.you ? C.bwhite : -1, -1, st.slot === t.you ? BOLD : 0);
      M.text(x0 + 27, y, pad(String(st.score), 6, 'right'), fg, -1, BOLD);
      if (st.detail) M.text(x0 + 35, y, fit(clean(st.detail, 60), rowW - 35), C.gray);
      y++;
    }
    y++;
    for (const line of r?.lines ?? []) {
      if (y >= M.h - 1) break;
      M.center(y++, clean(line, 120), C.bcyan);
    }
    if (side) this.sidebar(s.region(s.w - SIDE_W, 0, SIDE_W, s.h), this.rosterLines(t), 'TABLE');
    this.footer(
      this.canvas,
      c.hosting ? 'Enter back to the lobby for a rematch · T chat · Esc close table' : `waiting for ${clean(t.host, 16)} · T chat · Esc leave`,
    );
  }

  private drawDialog(s: Surface, d: Dialog): void {
    const w = Math.min(s.w - 4, Math.max(36, cells(d.title) + 8, ...d.lines.map((l) => cells(l) + 6), ...d.options.map((o) => cells(o.label) + 6)));
    const h = d.lines.length + d.options.length + 4;
    const x = (s.w - w) >> 1;
    const y = (s.h - h) >> 1;
    s.fill(x, y, w, h, ' ', -1, C.black);
    s.box(x, y, w, h, C.byellow, C.black, 'double', d.title, C.byellow);
    let yy = y + 2;
    for (const l of d.lines) s.text(x + 3, yy++, fit(l, w - 6), C.bwhite, C.black);
    if (d.lines.length) yy++;
    else yy = y + 2;
    for (const o of d.options) s.text(x + 3, yy++, fit(o.label, w - 6), C.bcyan, C.black, BOLD);
  }
}
