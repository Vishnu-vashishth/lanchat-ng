import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { readSize } from './proto.js';
import { makeRng } from './rng.js';
const BOT_NAMES = ['Noodle', 'Pixel', 'Ziggy', 'Byte', 'Glitch', 'Blip', 'Nova', 'Fizz', 'Sprocket', 'Widget', 'Echo', 'Turbo'];
const MAX_MEMBERS = 32;
const FLUSH_GAP_MS = 15;
export class TableHost {
    def;
    room;
    link;
    hostNick;
    gid;
    phase = 'lobby';
    settings = {};
    closed = false;
    members = new Map();
    logic = null;
    results = null;
    loopTimer;
    flushTimer;
    lastFlush = 0;
    acc = 0;
    last = 0;
    botSeq = 0;
    constructor(def, room, link, hostNick, hostSize, gid = bytesToHex(randomBytes(8))) {
        this.def = def;
        this.room = room;
        this.link = link;
        this.hostNick = hostNick;
        this.gid = gid;
        for (const s of def.settings)
            this.settings[s.key] = s.choices[s.def ?? 0].v;
        this.members.set(link.selfId, { id: link.selfId, slot: 0, nick: hostNick, bot: false, spec: false, size: hostSize, lastFrame: '' });
    }
    // ---- roster ----
    get playerCount() {
        let n = 0;
        for (const m of this.members.values())
            if (!m.spec)
                n++;
        return n;
    }
    roster() {
        return [...this.members.values()]
            .filter((m) => !m.spec)
            .sort((a, b) => a.slot - b.slot)
            .map((m) => ({ slot: m.slot, nick: m.nick, bot: m.bot }));
    }
    freeSlot() {
        const used = new Set();
        for (const m of this.members.values())
            if (!m.spec)
                used.add(m.slot);
        for (let s = 0; s < this.def.max; s++)
            if (!used.has(s))
                return s;
        return -1;
    }
    /** Seat a peer: a player while the lobby has room, otherwise a spectator. */
    join(id, nick, size) {
        if (this.closed)
            return;
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
            if (free >= 0 && this.logic.addPlayer({ slot: free, nick: nick.slice(0, 32), bot: false }))
                slot = free;
        }
        this.members.set(id, { id, slot, nick: nick.slice(0, 32), bot: false, spec: slot < 0, size, lastFrame: '' });
        this.feed(slot < 0 ? `${nick} is watching` : `${nick} joined`);
        this.changed();
    }
    leave(id) {
        if (id === this.link.selfId) {
            this.close('the host closed the table');
            return;
        }
        const m = this.members.get(id);
        if (!m)
            return;
        this.members.delete(id);
        if (this.logic && !m.spec)
            this.logic.drop(m.slot);
        this.feed(`${m.nick} left`);
        this.changed();
        this.requestFlush();
    }
    rename(id, nick) {
        const m = this.members.get(id);
        if (!m || m.nick === nick)
            return;
        m.nick = nick.slice(0, 32);
        if (id === this.link.selfId)
            this.hostNick = m.nick;
        this.changed();
    }
    resize(id, size) {
        const m = this.members.get(id);
        if (m)
            m.size = size;
    }
    addBot() {
        if (!this.def.bots || this.phase === 'playing')
            return false;
        const slot = this.freeSlot();
        if (slot < 0)
            return false;
        const taken = new Set([...this.members.values()].map((m) => m.nick));
        let nick = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot${this.botSeq + 1}`;
        if (taken.has(nick))
            nick = `${nick}${this.botSeq}`;
        const id = `bot:${++this.botSeq}`;
        this.members.set(id, { id, slot, nick, bot: true, spec: false, size: { cols: 999, rows: 999 }, lastFrame: '' });
        this.changed();
        return true;
    }
    removeBot() {
        if (this.phase === 'playing')
            return false;
        const bots = [...this.members.values()].filter((m) => m.bot).sort((a, b) => b.slot - a.slot);
        if (!bots[0])
            return false;
        this.members.delete(bots[0].id);
        this.promoteSpectators(); // someone waiting gets the seat
        this.changed();
        return true;
    }
    /** Step a lobby setting to its next/previous choice. */
    cycle(key, dir) {
        if (this.phase === 'playing')
            return;
        const def = this.def.settings.find((s) => s.key === key);
        if (!def)
            return;
        const i = def.choices.findIndex((c) => c.v === this.settings[key]);
        const n = def.choices.length;
        this.settings[key] = def.choices[(((i < 0 ? 0 : i) + dir) % n + n) % n].v;
        this.changed();
    }
    canStart() {
        return this.phase !== 'playing' && this.playerCount >= this.def.min;
    }
    // ---- match lifecycle ----
    start() {
        if (!this.canStart())
            return false;
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
        for (const m of this.members.values())
            m.lastFrame = '';
        this.changed();
        this.startLoop();
        this.flushFrames();
        return true;
    }
    /** From the results screen back to the lobby, keeping everyone seated. */
    toLobby() {
        if (this.phase !== 'results')
            return;
        this.phase = 'lobby';
        this.results = null;
        this.promoteSpectators();
        this.changed();
    }
    /** Abort a running match (host only) and return to the lobby. */
    abort() {
        if (this.phase !== 'playing')
            return;
        this.stopLoop();
        this.logic = null;
        this.phase = 'lobby';
        this.feed('the host ended the match');
        this.promoteSpectators();
        this.changed();
    }
    promoteSpectators() {
        for (const m of this.members.values()) {
            if (!m.spec)
                continue;
            const slot = this.freeSlot();
            if (slot < 0)
                break;
            m.slot = slot;
            m.spec = false;
        }
    }
    input(id, data) {
        const m = this.members.get(id);
        if (!m || m.spec || !this.logic || this.phase !== 'playing')
            return;
        try {
            this.logic.input(m.slot, data);
        }
        catch {
            return; // a malformed input must never take the table down
        }
        this.requestFlush();
    }
    startLoop() {
        this.stopLoop();
        const tick = Math.max(5, this.logic?.tickMs ?? 50);
        this.acc = 0;
        this.last = performance.now();
        this.loopTimer = setInterval(() => this.step(), Math.max(4, Math.min(16, Math.floor(tick / 3))));
    }
    stopLoop() {
        if (this.loopTimer)
            clearInterval(this.loopTimer);
        this.loopTimer = undefined;
    }
    step() {
        const logic = this.logic;
        if (!logic)
            return;
        const now = performance.now();
        this.acc += Math.min(now - this.last, 250);
        this.last = now;
        let ran = 0;
        try {
            while (this.acc >= logic.tickMs && ran < 8) {
                logic.tick();
                this.acc -= logic.tickMs;
                ran++;
                if (logic.done)
                    break;
            }
        }
        catch (err) {
            // A bug in one game must never take the chat down with it.
            this.stopLoop();
            this.logic = null;
            this.phase = 'lobby';
            this.feed(`the match crashed and was stopped (${String(err).slice(0, 60)})`);
            this.changed();
            return;
        }
        if (!ran)
            return;
        if (logic.done)
            this.finish();
        else
            this.requestFlush();
    }
    finish() {
        const logic = this.logic;
        if (!logic)
            return;
        this.stopLoop();
        this.flushFrames();
        this.results = { standings: logic.standings(), lines: logic.summary?.() ?? [] };
        this.logic = null;
        this.phase = 'results';
        this.changed();
    }
    close(reason) {
        if (this.closed)
            return;
        this.closed = true;
        this.stopLoop();
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.logic = null;
        for (const m of this.members.values()) {
            if (m.bot)
                continue;
            const msg = this.msg('close', { reason });
            if (m.id === this.link.selfId)
                this.link.local(msg);
            else
                this.link.send(m.id, msg);
        }
        this.link.advertise(this.msg('close', { reason }));
    }
    /** Messages from remote peers addressed to this table. */
    handle(id, nick, msg) {
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
    msg(op, d) {
        return { t: 'game', room: this.room, gid: this.gid, op, d };
    }
    adData() {
        return { kind: this.def.id, title: this.def.title, host: this.hostNick, n: this.playerCount, max: this.def.max, phase: this.phase };
    }
    advertise(to) {
        if (!this.closed)
            this.link.advertise(this.msg('ad', this.adData()), to);
    }
    changed() {
        this.sendTables();
        this.advertise();
    }
    /** Send the opening roster to members and the first ad to the room. */
    announce() {
        this.changed();
    }
    tableFor(me) {
        const members = [...this.members.values()]
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
    deliver(m, msg) {
        if (m.bot)
            return;
        if (m.id === this.link.selfId)
            this.link.local(msg);
        else
            this.link.send(m.id, msg);
    }
    sendTables() {
        for (const m of this.members.values())
            this.deliver(m, this.msg('table', this.tableFor(m)));
    }
    feed(text, slot) {
        for (const m of this.members.values())
            this.deliver(m, this.msg('feed', { text: text.slice(0, 200), slot }));
    }
    requestFlush() {
        if (this.flushTimer || this.closed)
            return;
        const wait = Math.max(0, FLUSH_GAP_MS - (performance.now() - this.lastFlush));
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flushFrames();
        }, wait);
    }
    flushFrames() {
        const logic = this.logic;
        if (!logic)
            return;
        this.lastFlush = performance.now();
        for (const m of this.members.values()) {
            if (m.bot)
                continue;
            let view;
            let json;
            try {
                view = logic.view(m.spec ? null : m.slot);
                json = JSON.stringify(view);
            }
            catch {
                continue;
            }
            if (json === m.lastFrame)
                continue;
            m.lastFrame = json;
            // Our own client gets a copy, never a live reference into game state.
            if (m.id === this.link.selfId)
                this.link.local(this.msg('frame', JSON.parse(json)));
            else
                this.link.send(m.id, this.msg('frame', view));
        }
    }
    /** The id of the member in a seat (for tests and the host UI). */
    memberIds() {
        return [...this.members.keys()];
    }
}
