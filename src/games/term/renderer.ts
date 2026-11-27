import { BOLD, DIM, REVERSE, UNDERLINE, type Canvas } from './canvas.js';

// Flicker-free terminal output for the game screens.
//
// The game view lives on the terminal's alternate screen, so the chat
// scrollback underneath is left untouched and reappears intact when the player
// returns to chat. Each flush diffs the new canvas against what is already on
// screen and writes only the cells that changed, as one write() call — the
// same delta-buffer idea terminal-kit's ScreenBuffer uses, kept dependency-free
// so it can share stdin/stdout with the chat's readline prompt.

export interface TermOut {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[0m\x1b[2J\x1b[H';
const LEAVE = '\x1b[0m\x1b[2J\x1b[H\x1b[?7h\x1b[?25h\x1b[?1049l';

export class TermRenderer {
  private prevCh: string[] = [];
  private prevFg = new Int8Array(0);
  private prevBg = new Int8Array(0);
  private prevAt = new Uint8Array(0);
  private prevW = -1;
  private prevH = -1;
  private readonly sgrCache = new Map<number, string>();
  active = false;

  constructor(
    private readonly out: TermOut,
    private readonly color: boolean,
  ) {}

  enter(): void {
    this.out.write(ENTER);
    this.active = true;
    this.invalidate();
  }

  leave(): void {
    if (!this.active) return;
    this.out.write(LEAVE);
    this.active = false;
    this.invalidate();
  }

  /** Forget what is on screen; the next flush repaints everything. */
  invalidate(): void {
    this.prevW = -1;
    this.prevH = -1;
  }

  /** Blank the screen (panic key) without leaving the alternate buffer. */
  blank(): void {
    this.out.write('\x1b[0m\x1b[2J\x1b[H');
    this.invalidate();
  }

  private sgr(fg: number, bg: number, at: number): string {
    const key = ((fg + 1) << 16) | ((bg + 1) << 8) | at;
    const hit = this.sgrCache.get(key);
    if (hit !== undefined) return hit;
    let s = '\x1b[0';
    if (at & BOLD) s += ';1';
    if (at & DIM) s += ';2';
    if (at & UNDERLINE) s += ';4';
    if (at & REVERSE) s += ';7';
    if (this.color) {
      if (fg >= 0) s += fg < 8 ? `;${30 + fg}` : `;${90 + fg - 8}`;
      if (bg >= 0) s += bg < 8 ? `;${40 + bg}` : `;${100 + bg - 8}`;
    }
    s += 'm';
    this.sgrCache.set(key, s);
    return s;
  }

  /** Paint `c`, writing only what differs from the previous frame. */
  flush(c: Canvas): void {
    if (!this.active) return;
    const { w, h } = c;
    const full = w !== this.prevW || h !== this.prevH;
    let s = full ? '\x1b[0m\x1b[2J' : '';
    let cx = -1;
    let cy = -1;
    let cur = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // The bottom-right cell is never written: on terminals that ignore
        // the no-autowrap mode, printing there scrolls the whole screen.
        if (y === h - 1 && x === w - 1) continue;
        const i = y * w + x;
        const ch = c.ch[i]!;
        const fg = c.fg[i]!;
        const bg = c.bg[i]!;
        const at = c.at[i]!;
        if (!full && ch === this.prevCh[i] && fg === this.prevFg[i] && bg === this.prevBg[i] && at === this.prevAt[i]) continue;
        if (cy !== y || cx !== x) s += `\x1b[${y + 1};${x + 1}H`;
        const g = this.sgr(fg, bg, at);
        if (g !== cur) {
          s += g;
          cur = g;
        }
        s += ch;
        cx = x + 1;
        cy = y;
      }
    }
    if (s) this.out.write(s + '\x1b[0m');
    if (full) {
      this.prevCh = c.ch.slice();
      this.prevFg = c.fg.slice();
      this.prevBg = c.bg.slice();
      this.prevAt = c.at.slice();
      this.prevW = w;
      this.prevH = h;
    } else {
      for (let i = 0; i < c.ch.length; i++) this.prevCh[i] = c.ch[i]!;
      this.prevFg.set(c.fg);
      this.prevBg.set(c.bg);
      this.prevAt.set(c.at);
    }
  }
}
