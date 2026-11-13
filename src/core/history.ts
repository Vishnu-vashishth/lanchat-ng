import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ChatRecord {
  id: string;
  room: string;
  from: string;
  fp: string;
  body: string;
  ts: number;
  self?: boolean;
}

// Message history. Memory-only by default (privacy-first): nothing touches disk
// unless history is explicitly enabled. When enabled, records are appended as
// JSON lines. `burn()` wipes both the in-memory ring and the on-disk file.
export class History {
  private readonly mem: ChatRecord[] = [];

  constructor(private path: string | null, private readonly max = 1000) {
    if (this.path) this.loadFromDisk();
  }

  get persistent(): boolean {
    return this.path !== null;
  }

  private loadFromDisk(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        this.mem.push(JSON.parse(line) as ChatRecord);
      }
      while (this.mem.length > this.max) this.mem.shift();
    } catch {
      /* ignore corrupt history */
    }
  }

  append(rec: ChatRecord): void {
    this.mem.push(rec);
    if (this.mem.length > this.max) this.mem.shift();
    if (this.path) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, JSON.stringify(rec) + '\n');
      } catch {
        /* best-effort */
      }
    }
  }

  recent(room: string, n = 20): ChatRecord[] {
    return this.mem.filter((r) => r.room === room).slice(-n);
  }

  enable(path: string): void {
    if (this.path === path) return;
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      for (const r of this.mem) appendFileSync(path, JSON.stringify(r) + '\n');
    } catch {
      /* best-effort */
    }
  }

  disable(): void {
    this.path = null;
  }

  burn(): void {
    this.mem.length = 0;
    if (this.path) {
      try {
        unlinkSync(this.path);
      } catch {
        /* already gone */
      }
    }
  }
}
