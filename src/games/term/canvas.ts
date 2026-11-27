// Cell-buffer drawing surface for the game screens.
//
// Every cell holds exactly one narrow character plus a foreground color, a
// background color and attribute bits. Anything that could break the grid —
// control characters (escape-sequence injection from a peer's nickname or chat
// text), combining marks, wide CJK/emoji — is replaced with '?' when drawn, so
// a frame always occupies exactly the cells it claims.

export const BOLD = 1;
export const DIM = 2;
export const UNDERLINE = 4;
export const REVERSE = 8;

/** The 16 ANSI colors (plus -1 = terminal default). */
export const C = {
  none: -1,
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  bred: 9,
  bgreen: 10,
  byellow: 11,
  bblue: 12,
  bmagenta: 13,
  bcyan: 14,
  bwhite: 15,
} as const;

/** Player colors by seat. Seats 8+ (party games) wrap onto darker shades. */
const SEAT_COLORS = [C.bgreen, C.bcyan, C.bmagenta, C.byellow, C.bred, C.bblue, C.bwhite, C.yellow, C.green, C.cyan, C.magenta, C.red];
export function seatColor(slot: number): number {
  return SEAT_COLORS[((slot % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length]!;
}

/** Replace anything that is not a single, narrow, printable character. */
export function safeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0x3f;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return '?';
  if (cp < 0x300) return ch; // ASCII, Latin-1, Latin Extended, IPA, spacing modifiers
  if (cp >= 0x370 && cp < 0x530) return ch; // Greek, Cyrillic
  if (cp >= 0x2010 && cp < 0x2028) return ch; // dashes, quotes, bullet, ellipsis
  if (cp >= 0x2030 && cp < 0x205f) return ch;
  if (cp >= 0x20a0 && cp < 0x20c0) return ch; // currency
  if (cp >= 0x2190 && cp < 0x2300) return ch; // arrows, math operators
  if (cp >= 0x2500 && cp < 0x2600) return ch; // box drawing, block elements, geometric shapes
  if (cp >= 0x2639 && cp <= 0x263c) return ch; // faces, sun
  if (cp >= 0x2660 && cp <= 0x266b) return ch; // card suits, notes
  return '?';
}

/** Make arbitrary (peer-supplied) text safe and at most `max` cells long. */
export function clean(s: string, max = 200): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    out += ch === '\t' || ch === '\n' || ch === '\r' ? ' ' : safeChar(ch);
    n++;
  }
  return out;
}

/** Cell width of a string once cleaned (one cell per code point). */
export function cells(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Truncate to `max` cells, ending in an ellipsis when cut. */
export function fit(s: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function pad(s: string, w: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const t = fit(s, w);
  const gap = w - cells(t);
  if (gap <= 0) return t;
  if (align === 'right') return ' '.repeat(gap) + t;
  if (align === 'center') return ' '.repeat(gap >> 1) + t + ' '.repeat(gap - (gap >> 1));
  return t + ' '.repeat(gap);
}

/** Word-wrap plain text into lines of at most `w` cells. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (cells(line) + 1 + cells(word) <= w) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
      while (cells(line) > w) {
        out.push([...line].slice(0, w).join(''));
        line = [...line].slice(w).join('');
      }
    }
    out.push(line);
  }
  return out;
}

const BOX = {
  single: ['┌', '┐', '└', '┘', '─', '│'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
} as const;

/** Anything that can be drawn on: the full canvas or a clipped region of it. */
export abstract class Surface {
  abstract readonly w: number;
  abstract readonly h: number;
  /** Raw cell write; `ch` must already be safe. Out-of-bounds writes are dropped. */
  abstract put(x: number, y: number, ch: string, fg: number, bg: number, at: number): void;

  set(x: number, y: number, ch: string, fg = -1, bg = -1, at = 0): void {
    this.put(x, y, safeChar(ch), fg, bg, at);
  }

  /** Draw a string left to right; returns the number of cells used. */
  text(x: number, y: number, s: string, fg = -1, bg = -1, at = 0, maxW = Infinity): number {
    let i = 0;
    for (const ch of s) {
      if (i >= maxW) break;
      this.put(x + i, y, ch === '\t' ? ' ' : safeChar(ch), fg, bg, at);
      i++;
    }
    return i;
  }

  /** Draw text centered in [x0, x0+w). */
  center(y: number, s: string, fg = -1, bg = -1, at = 0, x0 = 0, w = this.w): void {
    const t = fit(s, w);
    this.text(x0 + Math.max(0, (w - cells(t)) >> 1), y, t, fg, bg, at);
  }

  fill(x: number, y: number, w: number, h: number, ch = ' ', fg = -1, bg = -1, at = 0): void {
    const c = safeChar(ch);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c, fg, bg, at);
  }

  hline(x: number, y: number, w: number, ch = '─', fg = -1, bg = -1, at = 0): void {
    this.fill(x, y, w, 1, ch, fg, bg, at);
  }

  vline(x: number, y: number, h: number, ch = '│', fg = -1, bg = -1, at = 0): void {
    this.fill(x, y, 1, h, ch, fg, bg, at);
  }

  box(x: number, y: number, w: number, h: number, fg = -1, bg = -1, kind: keyof typeof BOX = 'single', title?: string, titleFg = fg): void {
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br, hz, vt] = BOX[kind];
    this.put(x, y, tl, fg, bg, 0);
    this.put(x + w - 1, y, tr, fg, bg, 0);
    this.put(x, y + h - 1, bl, fg, bg, 0);
    this.put(x + w - 1, y + h - 1, br, fg, bg, 0);
    this.hline(x + 1, y, w - 2, hz, fg, bg);
    this.hline(x + 1, y + h - 1, w - 2, hz, fg, bg);
    this.vline(x, y + 1, h - 2, vt, fg, bg);
    this.vline(x + w - 1, y + 1, h - 2, vt, fg, bg);
    if (title && w > 6) this.text(x + 2, y, ` ${fit(title, w - 6)} `, titleFg, bg, BOLD);
  }

  /** A clipped, translated view of this surface. */
  region(x: number, y: number, w: number, h: number): Region {
    return new Region(this, x, y, Math.max(0, w), Math.max(0, h));
  }
}

export class Region extends Surface {
  constructor(
    private readonly parent: Surface,
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
  ) {
    super();
  }

  put(x: number, y: number, ch: string, fg: number, bg: number, at: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.parent.put(this.x + x, this.y + y, ch, fg, bg, at);
  }
}

export class Canvas extends Surface {
  readonly ch: string[];
  readonly fg: Int8Array;
  readonly bg: Int8Array;
  readonly at: Uint8Array;

  constructor(readonly w: number, readonly h: number) {
    super();
    const n = Math.max(0, w * h);
    this.ch = new Array<string>(n).fill(' ');
    this.fg = new Int8Array(n).fill(-1);
    this.bg = new Int8Array(n).fill(-1);
    this.at = new Uint8Array(n);
  }

  clear(): void {
    this.ch.fill(' ');
    this.fg.fill(-1);
    this.bg.fill(-1);
    this.at.fill(0);
  }

  put(x: number, y: number, ch: string, fg: number, bg: number, at: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.at[i] = at;
  }

  /** Read back one row as plain text (tests, snapshots). */
  row(y: number): string {
    return this.ch.slice(y * this.w, (y + 1) * this.w).join('');
  }

  lines(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) out.push(this.row(y));
    return out;
  }
}
