import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// Trust-on-first-use store, keyed by fingerprint (= identity). Because the
// fingerprint IS the public key's digest, there is no "key changed for this
// peer" ambiguity as in IP-keyed schemes: a different key is simply a different
// identity, surfaced to the user as a new first-contact.
export class TrustStore {
    path;
    map = new Map();
    constructor(path) {
        this.path = path;
        this.load();
    }
    load() {
        if (!existsSync(this.path))
            return;
        try {
            const obj = JSON.parse(readFileSync(this.path, 'utf8'));
            for (const [fp, rec] of Object.entries(obj))
                this.map.set(fp, rec);
        }
        catch {
            /* ignore corrupt store */
        }
    }
    save() {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map), null, 2));
        }
        catch {
            /* best-effort */
        }
    }
    /** Record a sighting; returns whether this fingerprint was never seen before. */
    record(fp, nick) {
        const now = Date.now();
        const existing = this.map.get(fp);
        if (existing) {
            existing.lastSeen = now;
            if (nick)
                existing.nick = nick;
            this.save();
            return { isNew: false };
        }
        this.map.set(fp, { nick, firstSeen: now, lastSeen: now });
        this.save();
        return { isNew: true };
    }
    known(fp) {
        return this.map.get(fp);
    }
}
