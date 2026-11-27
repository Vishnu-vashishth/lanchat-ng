import { PassThrough, Writable } from 'node:stream';

// Test-only terminal: a fake TTY pair (keyboard in, screen out) plus a small
// VT100 emulator, so tests can drive the real chat + game UI and then read the
// screen exactly as a person would see it.

const PALETTE = ['#000', '#c33', '#3b3', '#c90', '#36c', '#c3c', '#3bb', '#ccc', '#777', '#f55', '#5f5', '#ff5', '#77f', '#f7f', '#5ff', '#fff'];

interface Cell {
  ch: string;
  fg: number;
  bg: number;
}

class Buffer2D {
  cells: Cell[][];
  constructor(
    public w: number,
    public h: number,
  ) {
    this.cells = Array.from({ length: h }, () => this.blankRow());
  }
  blankRow(): Cell[] {
    return Array.from({ length: this.w }, () => ({ ch: ' ', fg: -1, bg: -1 }));
  }
}

export class VirtualTerminal {
  private main: Buffer2D;
  private alt: Buffer2D;
  private buf: Buffer2D;
  private x = 0;
  private y = 0;
  private fg = -1;
  private bg = -1;
  altActive = false;
  cursorHidden = false;
  private pending = '';

  constructor(
    public cols: number,
    public rows: number,
  ) {
    this.main = new Buffer2D(cols, rows);
    this.alt = new Buffer2D(cols, rows);
    this.buf = this.main;
  }

  /** Change the screen size, keeping what fits (like a real terminal window). */
  resize(cols: number, rows: number): void {
    const fitTo = (b: Buffer2D) => {
      const n = new Buffer2D(cols, rows);
      for (let r = 0; r < Math.min(rows, b.h); r++) for (let c = 0; c < Math.min(cols, b.w); c++) n.cells[r]![c] = b.cells[r]![c]!;
      return n;
    };
    const wasAlt = this.buf === this.alt;
    this.main = fitTo(this.main);
    this.alt = fitTo(this.alt);
    this.buf = wasAlt ? this.alt : this.main;
    this.cols = cols;
    this.rows = rows;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.min(this.y, rows - 1);
  }

  private scroll(): void {
    this.buf.cells.shift();
    this.buf.cells.push(this.buf.blankRow());
  }

  write(data: string): void {
    const s = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        const m = /^\x1b\[([?]?)([0-9;]*)([A-Za-z@])/.exec(s.slice(i));
        if (!m) {
          if (s.length - i < 16) {
            this.pending = s.slice(i);
            return;
          }
          i++;
          continue;
        }
        this.csi(m[1]!, m[2]!, m[3]!);
        i += m[0].length;
        continue;
      }
      if (ch === '\n') {
        this.y++;
        if (this.y >= this.rows) {
          this.scroll();
          this.y = this.rows - 1;
        }
      } else if (ch === '\r') this.x = 0;
      else if (ch === '\b') this.x = Math.max(0, this.x - 1);
      else if (ch >= ' ') {
        const cp = s.codePointAt(i)!;
        const glyph = String.fromCodePoint(cp);
        if (this.x >= this.cols) {
          this.x = 0;
          this.y++;
          if (this.y >= this.rows) {
            this.scroll();
            this.y = this.rows - 1;
          }
        }
        this.buf.cells[this.y]![this.x] = { ch: glyph, fg: this.fg, bg: this.bg };
        this.x++;
        i += glyph.length;
        continue;
      }
      i++;
    }
  }

  private csi(priv: string, params: string, cmd: string): void {
    const nums = params ? params.split(';').map((p) => Number(p || 0)) : [];
    const n = nums[0] || 1;
    if (priv === '?') {
      if (params === '1049') {
        if (cmd === 'h' && !this.altActive) {
          this.altActive = true;
          this.alt = new Buffer2D(this.cols, this.rows);
          this.buf = this.alt;
        } else if (cmd === 'l' && this.altActive) {
          this.altActive = false;
          this.buf = this.main;
        }
      } else if (params === '25') this.cursorHidden = cmd === 'l';
      return;
    }
    switch (cmd) {
      case 'H':
        this.y = Math.min(this.rows - 1, Math.max(0, (nums[0] || 1) - 1));
        this.x = Math.min(this.cols - 1, Math.max(0, (nums[1] || 1) - 1));
        break;
      case 'A':
        this.y = Math.max(0, this.y - n);
        break;
      case 'B':
        this.y = Math.min(this.rows - 1, this.y + n);
        break;
      case 'C':
        this.x = Math.min(this.cols - 1, this.x + n);
        break;
      case 'D':
        this.x = Math.max(0, this.x - n);
        break;
      case 'G':
        this.x = Math.max(0, (nums[0] || 1) - 1);
        break;
      case 'J':
        if (nums[0] === 2 || nums[0] === 3) for (let r = 0; r < this.rows; r++) this.buf.cells[r] = this.buf.blankRow();
        else if (!nums[0]) for (let r = this.y; r < this.rows; r++) this.buf.cells[r] = this.buf.blankRow();
        break;
      case 'K': {
        const row = this.buf.cells[this.y]!;
        const mode = nums[0] ?? 0;
        for (let c = 0; c < this.cols; c++) if (mode === 2 || (mode === 0 && c >= this.x) || (mode === 1 && c <= this.x)) row[c] = { ch: ' ', fg: -1, bg: -1 };
        break;
      }
      case 'M':
        this.buf.cells.splice(this.y, 1);
        this.buf.cells.push(this.buf.blankRow());
        break;
      case 'm': {
        const list = nums.length ? nums : [0];
        for (const p of list) {
          if (p === 0) {
            this.fg = -1;
            this.bg = -1;
          } else if (p >= 30 && p <= 37) this.fg = p - 30;
          else if (p >= 90 && p <= 97) this.fg = p - 90 + 8;
          else if (p >= 40 && p <= 47) this.bg = p - 40;
          else if (p >= 100 && p <= 107) this.bg = p - 100 + 8;
          else if (p === 39) this.fg = -1;
          else if (p === 49) this.bg = -1;
        }
        break;
      }
      default:
        break;
    }
  }

  lines(): string[] {
    return this.buf.cells.map((r) => r.map((c) => c.ch).join('').replace(/\s+$/, ''));
  }

  text(): string {
    return this.lines().join('\n');
  }

  html(): string {
    let out = '<pre style="background:#101010;color:#ccc;font:15px/1.2 Consolas,Menlo,monospace;padding:10px;display:inline-block">';
    for (const row of this.buf.cells) {
      for (const c of row) {
        const ch = c.ch === '<' ? '&lt;' : c.ch === '&' ? '&amp;' : c.ch;
        const style = `${c.fg >= 0 ? `color:${PALETTE[c.fg]};` : ''}${c.bg >= 0 ? `background:${PALETTE[c.bg]};` : ''}`;
        out += style ? `<span style="${style}">${ch}</span>` : ch;
      }
      out += '\n';
    }
    return out + '</pre>';
  }
}

/** A fake interactive terminal: write keys to `keys`, read the screen from `vt`. */
export function fakeTty(cols = 120, rows = 36): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  vt: VirtualTerminal;
  type(s: string): void;
  resize(cols: number, rows: number): void;
} {
  const vt = new VirtualTerminal(cols, rows);
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
  });
  const output = new Writable({
    write(chunk, _enc, cb) {
      vt.write(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: cols, rows, getColorDepth: () => 8, hasColors: () => true });
  return {
    input,
    output,
    vt,
    type: (s: string) => {
      (input as unknown as PassThrough).write(s);
    },
    resize: (c: number, r: number) => {
      Object.assign(output, { columns: c, rows: r });
      vt.resize(c, r);
      output.emit('resize');
    },
  };
}

export const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  backspace: '\x7f',
  tab: '\t',
} as const;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` is truthy (or fail after `ms`). */
export async function until(fn: () => unknown, ms = 4000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
