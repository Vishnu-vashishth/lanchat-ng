import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// Message history. Memory-only by default (privacy-first): nothing touches disk
// unless history is explicitly enabled. When enabled, records are appended as
// JSON lines. `burn()` wipes both the in-memory ring and the on-disk file.
export class History {
    path;
    max;
    mem = [];
    constructor(path, max = 1000) {
        this.path = path;
        this.max = max;
        if (this.path)
            this.loadFromDisk();
    }
    get persistent() {
        return this.path !== null;
    }
    loadFromDisk() {
        if (!this.path || !existsSync(this.path))
            return;
        try {
            for (const line of readFileSync(this.path, 'utf8').split('\n')) {
                if (!line.trim())
                    continue;
                this.mem.push(JSON.parse(line));
            }
            while (this.mem.length > this.max)
                this.mem.shift();
        }
        catch {
            /* ignore corrupt history */
        }
    }
    append(rec) {
        this.mem.push(rec);
        if (this.mem.length > this.max)
            this.mem.shift();
        if (this.path) {
            try {
                mkdirSync(dirname(this.path), { recursive: true });
                appendFileSync(this.path, JSON.stringify(rec) + '\n');
            }
            catch {
                /* best-effort */
            }
        }
    }
    recent(room, n = 20) {
        return this.mem.filter((r) => r.room === room).slice(-n);
    }
    enable(path) {
        if (this.path === path)
            return;
        this.path = path;
        try {
            mkdirSync(dirname(path), { recursive: true });
            for (const r of this.mem)
                appendFileSync(path, JSON.stringify(r) + '\n');
        }
        catch {
            /* best-effort */
        }
    }
    disable() {
        this.path = null;
    }
    burn() {
        this.mem.length = 0;
        if (this.path) {
            try {
                unlinkSync(this.path);
            }
            catch {
                /* already gone */
            }
        }
    }
}
