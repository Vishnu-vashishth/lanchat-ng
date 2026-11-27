import { BOLD, C, fit, pad, seatColor } from './term/canvas.js';
import { bigCenter, bigWidth } from './term/font.js';
import { DX, DY, dirOf } from './term/keys.js';
// BLAST YARD — a bomb-maze battle. Walk the yard, drop bombs, blow crates open
// for power-ups (more bombs, bigger blasts, speed, a one-hit shield) and catch
// the others in the cross-shaped blasts. Bombs set each other off, so one
// careless drop can chain across the whole yard. Last one standing takes the
// round; first to N rounds wins. If a round drags on, blocks start falling in a
// spiral from the edges.
const TICK = 50;
const SEC = 1000 / TICK;
const FUSE = Math.round(2.5 * SEC);
const FLAME = Math.round(0.55 * SEC);
const SPEEDS = [4, 3, 2]; // ticks per step
const INF = 32000;
// grid cells
const FLOOR = 0;
const PILLAR = 1;
const CRATE = 2;
const OUTER = 3;
class BlastGame {
    ctx;
    tickMs = TICK;
    done = false;
    W;
    H;
    grid;
    items = new Map();
    pending = new Map();
    flames;
    flameKind; // 1 center, 2 horizontal, 3 vertical
    flameOwner;
    bombs = [];
    players;
    rng;
    phase = 'count';
    phaseT = 3 * SEC;
    round = 1;
    target;
    crateDensity;
    dropChance;
    limit;
    skill;
    roundT = 0;
    spiral = [];
    hurryIdx = 0;
    banner = '';
    constructor(ctx) {
        this.ctx = ctx;
        const st = ctx.settings;
        this.rng = ctx.rng;
        this.target = typeof st.wins === 'number' ? st.wins : 3;
        this.crateDensity = st.crates === 'dense' ? 0.78 : st.crates === 'sparse' ? 0.45 : 0.64;
        this.dropChance = st.drops === 'lots' ? 0.45 : st.drops === 'few' ? 0.17 : 0.3;
        this.limit = (typeof st.time === 'number' ? st.time : 120) * SEC;
        this.skill = st.bots === 'hard' ? 2 : st.bots === 'easy' ? 0 : 1;
        const n = ctx.players.length;
        [this.W, this.H] = n <= 4 ? [15, 11] : n <= 6 ? [17, 13] : [19, 13];
        const size = this.W * this.H;
        this.grid = new Uint8Array(size);
        this.flames = new Uint8Array(size);
        this.flameKind = new Uint8Array(size);
        this.flameOwner = new Int8Array(size).fill(-1);
        this.players = ctx.players.map((p) => ({
            slot: p.slot,
            nick: p.nick,
            bot: p.bot,
            x: 1,
            y: 1,
            alive: false,
            out: false,
            bombs: 1,
            power: 2,
            speed: 0,
            shield: false,
            invuln: 0,
            cool: 0,
            want: -1,
            wantT: 0,
            wantBomb: false,
            wins: 0,
            kills: 0,
            deaths: 0,
            crates: 0,
            deadT: 0,
            think: 0,
        }));
        this.newRound();
    }
    idx(x, y) {
        return y * this.W + x;
    }
    spawns() {
        const { W, H } = this;
        const mx = W >> 1;
        const my = H >> 1;
        return [
            [1, 1],
            [W - 2, H - 2],
            [W - 2, 1],
            [1, H - 2],
            [mx, 1],
            [mx, H - 2],
            [1, my],
            [W - 2, my],
        ];
    }
    newRound() {
        const { W, H } = this;
        this.grid.fill(FLOOR);
        this.flames.fill(0);
        this.flameKind.fill(0);
        this.items.clear();
        this.pending.clear();
        this.bombs = [];
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const i = this.idx(x, y);
                if (x === 0 || y === 0 || x === W - 1 || y === H - 1)
                    this.grid[i] = OUTER;
                else if (x % 2 === 0 && y % 2 === 0)
                    this.grid[i] = PILLAR;
            }
        const spawns = this.spawns();
        const live = this.players.filter((p) => !p.out);
        const near = (x, y) => live.some((_, k) => {
            const s = spawns[k % spawns.length];
            return Math.abs(s[0] - x) + Math.abs(s[1] - y) <= 2;
        });
        for (let y = 1; y < H - 1; y++)
            for (let x = 1; x < W - 1; x++) {
                const i = this.idx(x, y);
                if (this.grid[i] === FLOOR && !near(x, y) && this.rng.chance(this.crateDensity))
                    this.grid[i] = CRATE;
            }
        live.forEach((p, k) => {
            const [x, y] = spawns[k % spawns.length];
            Object.assign(p, { x, y, alive: true, bombs: 1, power: 2, speed: 0, shield: false, invuln: 0, cool: 0, want: -1, wantT: 0, wantBomb: false, deadT: 0, think: this.rng.int(4) });
        });
        for (const p of this.players)
            if (p.out)
                p.alive = false;
        this.roundT = 0;
        this.hurryIdx = 0;
        this.spiral = this.makeSpiral();
        this.banner = `ROUND ${this.round}`;
    }
    /** Inner cells from the outside ring inward, clockwise — the hurry-up order. */
    makeSpiral() {
        const out = [];
        let x0 = 1;
        let y0 = 1;
        let x1 = this.W - 2;
        let y1 = this.H - 2;
        while (x0 <= x1 && y0 <= y1 && out.length < (this.W * this.H) / 2) {
            for (let x = x0; x <= x1; x++)
                out.push(this.idx(x, y0));
            for (let y = y0 + 1; y <= y1; y++)
                out.push(this.idx(x1, y));
            if (y1 > y0)
                for (let x = x1 - 1; x >= x0; x--)
                    out.push(this.idx(x, y1));
            if (x1 > x0)
                for (let y = y1 - 1; y > y0; y--)
                    out.push(this.idx(x0, y));
            x0++;
            y0++;
            x1--;
            y1--;
        }
        // Leave a small arena in the middle so the squeeze ends in a showdown.
        return out.slice(0, Math.max(0, out.length - 15));
    }
    // ---- inputs ----
    input(slot, data) {
        const p = this.players.find((x) => x.slot === slot);
        if (!p || !p.alive || p.bot)
            return;
        const o = data;
        if (!o || typeof o !== 'object')
            return;
        if (o.d === 0 || o.d === 1 || o.d === 2 || o.d === 3) {
            p.want = o.d;
            p.wantT = 6;
        }
        if (o.b === 1)
            p.wantBomb = true;
    }
    drop(slot) {
        const p = this.players.find((x) => x.slot === slot);
        if (!p || p.out)
            return;
        p.out = true;
        p.alive = false;
    }
    // ---- simulation ----
    tick() {
        if (this.done)
            return;
        if (this.phase === 'count') {
            if (--this.phaseT <= 0) {
                this.phase = 'play';
                this.banner = '';
            }
            return;
        }
        if (this.phase === 'round') {
            if (--this.phaseT <= 0) {
                if (this.players.some((p) => p.wins >= this.target) || this.round >= this.target * 3) {
                    this.phase = 'over';
                    this.done = true;
                }
                else {
                    this.round++;
                    this.newRound();
                    this.phase = 'count';
                    this.phaseT = 3 * SEC;
                }
            }
            return;
        }
        this.roundT++;
        // Nobody wants to watch bots circle for two minutes: once every human is
        // out of the round, skip straight to the falling blocks.
        if (this.roundT < this.limit && this.humansOut())
            this.roundT = this.limit;
        for (let i = 0; i < this.flames.length; i++) {
            if (!this.flames[i])
                continue;
            if (--this.flames[i] === 0) {
                this.flameKind[i] = 0;
                const item = this.pending.get(i);
                if (item) {
                    this.items.set(i, item);
                    this.pending.delete(i);
                }
            }
        }
        for (const p of this.players) {
            if (!p.alive) {
                p.deadT++;
                continue;
            }
            if (p.invuln > 0)
                p.invuln--;
            if (p.cool > 0)
                p.cool--;
            if (p.bot && --p.think <= 0)
                this.think(p);
        }
        for (const p of this.players) {
            if (!p.alive)
                continue;
            if (p.wantBomb) {
                p.wantBomb = false;
                this.placeBomb(p);
            }
            if (p.want >= 0 && p.cool === 0) {
                const d = p.want;
                const nx = p.x + DX[d];
                const ny = p.y + DY[d];
                if (this.walkable(nx, ny)) {
                    p.x = nx;
                    p.y = ny;
                    p.cool = SPEEDS[p.speed];
                    p.want = -1;
                    this.pickup(p);
                }
            }
            if (p.want >= 0 && --p.wantT <= 0)
                p.want = -1;
        }
        for (const b of this.bombs)
            b.fuse--;
        const ripe = this.bombs.filter((b) => b.fuse <= 0);
        for (const b of ripe)
            if (this.bombs.includes(b))
                this.explode(b);
        this.burnPlayers();
        if (this.roundT >= this.limit)
            this.hurry();
        const live = this.players.filter((p) => !p.out);
        const alive = live.filter((p) => p.alive);
        if (alive.length <= (live.length >= 2 ? 1 : 0))
            this.endRound(alive[0]);
    }
    walkable(x, y) {
        if (x < 0 || y < 0 || x >= this.W || y >= this.H)
            return false;
        if (this.grid[this.idx(x, y)] !== FLOOR)
            return false;
        return !this.bombs.some((b) => b.x === x && b.y === y);
    }
    placeBomb(p) {
        const active = this.bombs.filter((b) => b.owner === p.slot).length;
        if (active >= p.bombs || this.bombs.some((b) => b.x === p.x && b.y === p.y))
            return;
        this.bombs.push({ x: p.x, y: p.y, fuse: FUSE, owner: p.slot, power: p.power });
    }
    pickup(p) {
        const i = this.idx(p.x, p.y);
        const it = this.items.get(i);
        if (!it)
            return;
        this.items.delete(i);
        if (it === 'B')
            p.bombs = Math.min(8, p.bombs + 1);
        else if (it === 'F')
            p.power = Math.min(9, p.power + 1);
        else if (it === 'S')
            p.speed = Math.min(SPEEDS.length - 1, p.speed + 1);
        else if (it === 'H') {
            if (!p.shield)
                this.ctx.feed(`${p.nick} picked up a shield`, p.slot);
            p.shield = true;
        }
    }
    /** Cells a bomb's blast covers: the center plus four arms that stop at walls and crates. */
    blastCells(b) {
        const out = [{ i: this.idx(b.x, b.y), kind: 1 }];
        for (let d = 0; d < 4; d++) {
            for (let k = 1; k <= b.power; k++) {
                const x = b.x + DX[d] * k;
                const y = b.y + DY[d] * k;
                const i = this.idx(x, y);
                const g = this.grid[i];
                if (g === PILLAR || g === OUTER)
                    break;
                out.push({ i, kind: d % 2 ? 2 : 3 });
                if (g === CRATE || this.items.has(i) || this.bombs.some((o) => o !== b && o.x === x && o.y === y))
                    break;
            }
        }
        return out;
    }
    explode(first) {
        const queue = [first];
        const done = new Set();
        while (queue.length) {
            const b = queue.shift();
            if (done.has(b))
                continue;
            done.add(b);
            for (const { i, kind } of this.blastCells(b)) {
                this.flames[i] = FLAME;
                this.flameKind[i] = this.flameKind[i] && this.flameKind[i] !== kind ? 1 : kind;
                this.flameOwner[i] = b.owner;
                if (this.grid[i] === CRATE) {
                    this.grid[i] = FLOOR;
                    const owner = this.players.find((p) => p.slot === b.owner);
                    if (owner)
                        owner.crates++;
                    if (this.rng.chance(this.dropChance)) {
                        const r = this.rng.next();
                        this.pending.set(i, r < 0.36 ? 'B' : r < 0.72 ? 'F' : r < 0.88 ? 'S' : 'H');
                    }
                }
                else if (this.items.has(i))
                    this.items.delete(i);
                const x = i % this.W;
                const y = Math.floor(i / this.W);
                for (const o of this.bombs)
                    if (!done.has(o) && o.x === x && o.y === y)
                        queue.push(o);
            }
        }
        this.bombs = this.bombs.filter((b) => !done.has(b));
    }
    burnPlayers() {
        for (const p of this.players) {
            if (!p.alive)
                continue;
            const i = this.idx(p.x, p.y);
            if (!this.flames[i] || p.invuln > 0)
                continue;
            if (p.shield) {
                p.shield = false;
                p.invuln = Math.round(1.2 * SEC);
                this.ctx.feed(`${p.nick}'s shield soaked a blast`, p.slot);
                continue;
            }
            this.kill(p, this.flameOwner[i], 'was blasted');
        }
    }
    kill(p, by, how) {
        p.alive = false;
        p.deaths++;
        p.deadT = 0;
        const killer = this.players.find((k) => k.slot === by);
        if (killer && killer !== p) {
            killer.kills++;
            this.ctx.feed(`${p.nick} ${how} by ${killer.nick}`, killer.slot);
        }
        else if (killer === p)
            this.ctx.feed(`${p.nick} walked into their own blast`, p.slot);
        else
            this.ctx.feed(`${p.nick} ${how}`, p.slot);
    }
    /** True when humans are playing but none is still alive this round. */
    humansOut() {
        const humans = this.players.filter((p) => !p.bot && !p.out);
        return humans.length > 0 && humans.every((p) => !p.alive);
    }
    hurry() {
        if (this.roundT === this.limit)
            this.ctx.feed('HURRY UP — the yard is closing in!');
        const every = this.humansOut() ? 2 : 4;
        if ((this.roundT - this.limit) % every !== 0 || this.hurryIdx >= this.spiral.length)
            return;
        const i = this.spiral[this.hurryIdx++];
        if (this.grid[i] === PILLAR)
            return;
        this.grid[i] = PILLAR;
        this.items.delete(i);
        this.pending.delete(i);
        const x = i % this.W;
        const y = Math.floor(i / this.W);
        this.bombs = this.bombs.filter((b) => b.x !== x || b.y !== y);
        for (const p of this.players)
            if (p.alive && p.x === x && p.y === y)
                this.kill(p, -1, 'was crushed by a falling block');
    }
    endRound(winner) {
        if (winner) {
            winner.wins++;
            this.banner = `${winner.nick.toUpperCase()} WINS ROUND ${this.round}`;
            this.ctx.feed(`${winner.nick} wins round ${this.round} (${winner.wins}/${this.target})`, winner.slot);
        }
        else {
            this.banner = `ROUND ${this.round} IS A DRAW`;
            this.ctx.feed(`round ${this.round}: nobody survived`);
        }
        this.phase = 'round';
        this.phaseT = 3 * SEC;
    }
    // ---- bots ----
    /** Ticks until each cell is in flames (0 = burning now), chains included. */
    dangerMap(extra) {
        const D = new Int16Array(this.W * this.H).fill(INF);
        for (let i = 0; i < D.length; i++)
            if (this.flames[i])
                D[i] = 0;
        const bombs = extra ? [...this.bombs, extra] : this.bombs;
        const eff = bombs.map((b) => b.fuse);
        const cells = bombs.map((b) => this.blastCells(b).map((c) => c.i));
        const at = bombs.map((b) => this.idx(b.x, b.y));
        // A bomb caught in another's blast goes off with it: relax until stable.
        for (let pass = 0; pass < bombs.length; pass++) {
            let changed = false;
            for (let ai = 0; ai < bombs.length; ai++) {
                for (const c of cells[ai]) {
                    for (let bi = 0; bi < bombs.length; bi++) {
                        if (bi !== ai && at[bi] === c && eff[bi] > eff[ai]) {
                            eff[bi] = eff[ai];
                            changed = true;
                        }
                    }
                }
            }
            if (!changed)
                break;
        }
        cells.forEach((list, bi) => {
            for (const c of list)
                D[c] = Math.min(D[c], eff[bi]);
        });
        return D;
    }
    /** BFS over walkable cells that are safe when we'd step on them. */
    route(p, D, goal, maxSteps = 40) {
        const start = this.idx(p.x, p.y);
        const step = SPEEDS[p.speed];
        const first = new Int8Array(this.W * this.H).fill(-1);
        const dist = new Int16Array(this.W * this.H).fill(-1);
        dist[start] = 0;
        const q = [start];
        if (goal(start, 0))
            return -2; // already there
        for (let h = 0; h < q.length; h++) {
            const c = q[h];
            if (dist[c] >= maxSteps)
                continue;
            const cx = c % this.W;
            const cy = Math.floor(c / this.W);
            for (let d = 0; d < 4; d++) {
                const nx = cx + DX[d];
                const ny = cy + DY[d];
                if (!this.walkable(nx, ny))
                    continue;
                const n = this.idx(nx, ny);
                if (dist[n] >= 0)
                    continue;
                const arrive = (dist[c] + 1) * step + p.cool;
                const danger = D[n];
                if (danger <= arrive + 2 && danger + FLAME + 1 >= arrive)
                    continue; // burning when we'd be there
                dist[n] = dist[c] + 1;
                first[n] = c === start ? d : first[c];
                if (goal(n, dist[n]))
                    return first[n];
                q.push(n);
            }
        }
        return -1;
    }
    enemiesInLine(p, power) {
        for (let d = 0; d < 4; d++) {
            for (let k = 1; k <= power; k++) {
                const x = p.x + DX[d] * k;
                const y = p.y + DY[d] * k;
                const g = this.grid[this.idx(x, y)];
                if (g !== FLOOR)
                    break;
                if (this.players.some((o) => o !== p && o.alive && o.x === x && o.y === y))
                    return true;
            }
        }
        return false;
    }
    cratesInReach(p) {
        let n = 0;
        for (let d = 0; d < 4; d++) {
            for (let k = 1; k <= p.power; k++) {
                const g = this.grid[this.idx(p.x + DX[d] * k, p.y + DY[d] * k)];
                if (g === CRATE)
                    n++;
                if (g !== FLOOR)
                    break;
            }
        }
        return n;
    }
    think(p) {
        p.think = [5, 3, 1][this.skill];
        const D = this.dangerMap();
        const here = this.idx(p.x, p.y);
        const safe = (i) => D[i] === INF;
        // 1. Get out of any blast that is coming.
        if (!safe(here)) {
            const d = this.route(p, D, (i) => safe(i), 30);
            if (d >= 0)
                this.botMove(p, d);
            return;
        }
        if (p.cool > 0)
            return;
        // 2. Bomb when it pays and there is a way out.
        const active = this.bombs.filter((b) => b.owner === p.slot).length;
        if (active < p.bombs && !this.bombs.some((b) => b.x === p.x && b.y === p.y)) {
            const worth = this.cratesInReach(p) > 0 || this.enemiesInLine(p, p.power);
            const eager = [0.35, 0.8, 1][this.skill];
            if (worth && this.rng.chance(eager)) {
                const mine = { x: p.x, y: p.y, fuse: FUSE, owner: p.slot, power: p.power };
                const D2 = this.dangerMap(mine);
                if (this.route(p, D2, (i) => D2[i] === INF, 12) >= 0) {
                    p.wantBomb = true;
                    return;
                }
            }
        }
        // 3. Head for loot, then for a spot to bomb crates, then for the nearest rival.
        const goals = [
            (i, s) => this.items.has(i) && s <= 7,
            (i) => {
                const x = i % this.W;
                const y = Math.floor(i / this.W);
                for (let d = 0; d < 4; d++)
                    if (this.grid[this.idx(x + DX[d], y + DY[d])] === CRATE)
                        return safe(i);
                return false;
            },
            (i) => {
                const x = i % this.W;
                const y = Math.floor(i / this.W);
                return safe(i) && this.players.some((o) => o !== p && o.alive && Math.abs(o.x - x) + Math.abs(o.y - y) <= 2);
            },
        ];
        for (const g of goals) {
            const d = this.route(p, D, g, 40);
            if (d === -2)
                continue;
            if (d >= 0) {
                this.botMove(p, d);
                return;
            }
        }
        // 4. Wander somewhere safe.
        const opts = [0, 1, 2, 3].filter((d) => this.walkable(p.x + DX[d], p.y + DY[d]) && safe(this.idx(p.x + DX[d], p.y + DY[d])));
        if (opts.length && this.rng.chance(0.3))
            this.botMove(p, this.rng.pick(opts));
    }
    botMove(p, d) {
        if (this.skill === 0 && this.rng.chance(0.08))
            return; // easy bots hesitate
        p.want = d;
        p.wantT = 4;
    }
    // ---- views ----
    view(_slot) {
        const g = [];
        const f = [];
        for (let i = 0; i < this.grid.length; i++) {
            const c = this.grid[i];
            g.push(c === OUTER ? '#' : c === PILLAR ? 'X' : c === CRATE ? '%' : this.items.get(i) ?? ' ');
            const k = this.flameKind[i];
            const fresh = this.flames[i] > FLAME / 2;
            f.push(!this.flames[i] ? ' ' : k === 1 ? (fresh ? 'C' : 'c') : k === 2 ? (fresh ? 'H' : 'h') : fresh ? 'V' : 'v');
        }
        const left = Math.ceil((this.limit - this.roundT) / SEC);
        return {
            w: this.W,
            h: this.H,
            g: g.join(''),
            f: f.join(''),
            b: this.bombs.map((b) => [b.x, b.y, b.fuse, b.owner]),
            p: this.players.map((p) => [p.slot, p.x, p.y, p.alive ? 1 : 0, p.bombs, p.power, p.speed, p.shield ? 1 : 0, p.wins, p.kills, p.out ? 1 : 0, Math.min(p.deadT, 99), p.invuln > 0 ? 1 : 0]),
            ph: this.phase,
            cd: this.phase === 'count' ? Math.ceil(this.phaseT / SEC) : 0,
            r: this.round,
            T: this.target,
            tl: left > 0 ? left : -1,
            m: this.banner,
        };
    }
    standings() {
        return [...this.players]
            .sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths)
            .map((p) => ({
            slot: p.slot,
            nick: p.nick,
            score: p.wins,
            detail: `${p.kills} blast${p.kills === 1 ? '' : 's'} · ${p.crates} crates · ${p.deaths} death${p.deaths === 1 ? '' : 's'}${p.out ? ' · left' : ''}`,
        }));
    }
    summary() {
        const lines = [`${this.round} round${this.round === 1 ? '' : 's'} played · score = rounds won`];
        const k = [...this.players].sort((a, b) => b.kills - a.kills)[0];
        if (k && k.kills)
            lines.push(`demolition expert: ${k.nick} (${k.kills} blasts)`);
        const c = [...this.players].sort((a, b) => b.crates - a.crates)[0];
        if (c && c.crates)
            lines.push(`crate crusher: ${c.nick} (${c.crates} crates)`);
        return lines;
    }
}
// ---- client ----
function asView(f) {
    const v = f;
    if (!v || typeof v !== 'object' || typeof v.g !== 'string' || typeof v.f !== 'string')
        return null;
    if (!Number.isInteger(v.w) || !Number.isInteger(v.h) || v.w < 5 || v.h < 5 || v.w > 41 || v.h > 41)
        return null;
    if (v.g.length !== v.w * v.h || v.f.length !== v.w * v.h || !Array.isArray(v.b) || !Array.isArray(v.p))
        return null;
    return v;
}
const ITEM = {
    B: { top: ' +1 ', label: 'BOMB', bg: C.blue, short: 'b+' },
    F: { top: ' +1 ', label: 'FIRE', bg: C.red, short: 'f+' },
    S: { top: ' >> ', label: 'FAST', bg: C.green, short: 's+' },
    H: { top: ' () ', label: 'SHLD', bg: C.cyan, short: 'sh' },
};
class BlastClient {
    big = true;
    measure(frame, aw, ah) {
        const v = asView(frame);
        if (!v)
            return null;
        if (v.w * 4 <= aw && v.h * 2 <= ah) {
            this.big = true;
            return { w: v.w * 4, h: v.h * 2 };
        }
        if (v.w * 2 <= aw && v.h <= ah) {
            this.big = false;
            return { w: v.w * 2, h: v.h };
        }
        return null;
    }
    need(frame) {
        const v = asView(frame);
        return v ? { w: v.w * 2, h: v.h } : { w: 40, h: 15 };
    }
    key(k) {
        if (k.name === 'space' || k.name === 'enter' || k.name === 'b' || k.name === 'x')
            return { b: 1 };
        const d = dirOf(k);
        return d < 0 ? undefined : { d };
    }
    help() {
        return '←↑↓→ / WASD move · Space drop a bomb';
    }
    status(frame) {
        const v = asView(frame);
        if (!v)
            return '';
        const clock = v.tl < 0 ? 'HURRY UP!' : `${Math.floor(v.tl / 60)}:${String(v.tl % 60).padStart(2, '0')}`;
        return `round ${v.r} · first to ${v.T} · ${clock}`;
    }
    scoreboard(frame, ctx) {
        const v = asView(frame);
        if (!v)
            return [];
        const rows = [...v.p].sort((a, b) => (b[8] ?? 0) - (a[8] ?? 0) || (b[9] ?? 0) - (a[9] ?? 0));
        const lines = [];
        for (const r of rows) {
            const [slot = 0, , , alive = 0, bombs = 1, power = 2, speed = 0, shield = 0, wins = 0, , out = 0] = r;
            const name = fit(ctx.nick(slot), 11);
            lines.push({
                slot,
                text: `${pad(name, 11)} ${'♦'.repeat(Math.min(wins, 6)) || '·'}${out ? ' left' : alive ? '' : ' ×'}`,
                fg: slot === ctx.me ? C.bwhite : alive ? -1 : C.gray,
                at: slot === ctx.me ? BOLD : 0,
            });
            if (alive)
                lines.push({ text: `   bombs ${bombs} · fire ${power}${speed ? ` · ${'»'.repeat(speed)}` : ''}${shield ? ' · ()' : ''}`, fg: C.gray });
        }
        lines.push({ text: '' });
        lines.push({ text: 'crates hide power-ups:', fg: C.gray });
        lines.push({ text: 'BOMB FIRE FAST SHLD', fg: C.gray });
        return lines;
    }
    draw(s, frame, ctx) {
        const v = asView(frame);
        if (!v)
            return;
        const cw = this.big ? 4 : 2;
        const ch = this.big ? 2 : 1;
        const blink = Math.floor(ctx.now / 200) % 2 === 0;
        const bombs = new Map();
        for (const b of v.b)
            bombs.set((b[1] ?? 0) * v.w + (b[0] ?? 0), b);
        for (let y = 0; y < v.h; y++) {
            for (let x = 0; x < v.w; x++) {
                const i = y * v.w + x;
                const px = x * cw;
                const py = y * ch;
                const g = v.g[i];
                const fl = v.f[i];
                if (fl !== ' ')
                    this.flame(s, px, py, fl, blink);
                else if (g === '#' || g === 'X')
                    this.block(s, px, py, g === '#' ? C.gray : C.white);
                else if (g === '%')
                    this.crate(s, px, py);
                else if (ITEM[g])
                    this.item(s, px, py, g, blink);
                const bomb = bombs.get(i);
                if (bomb && fl === ' ')
                    this.bomb(s, px, py, bomb[2] ?? 0, blink);
            }
        }
        for (const r of v.p) {
            const [slot = 0, x = 0, y = 0, alive = 0, , , , shield = 0, , , out = 0, deadT = 0, invuln = 0] = r;
            if (out || (!alive && deadT > 30))
                continue;
            this.player(s, x * cw, y * ch, slot, !!alive, !!shield, !!invuln && blink, slot === ctx.me, (x + y) % 2 === 0, ctx);
        }
        this.overlay(s, v, ctx);
    }
    block(s, x, y, fg) {
        if (this.big) {
            s.text(x, y, '█▀▀█', fg);
            s.text(x, y + 1, '█▄▄█', fg);
        }
        else
            s.text(x, y, '██', fg);
    }
    crate(s, x, y) {
        if (this.big) {
            s.text(x, y, '╔══╗', C.yellow);
            s.text(x, y + 1, '╚══╝', C.yellow);
        }
        else
            s.text(x, y, '▒▒', C.yellow);
    }
    item(s, x, y, k, blink) {
        const it = ITEM[k];
        if (this.big) {
            s.text(x, y, it.top, C.bwhite, it.bg, BOLD);
            s.text(x, y + 1, it.label, blink ? C.bwhite : C.byellow, it.bg, BOLD);
        }
        else
            s.text(x, y, it.short, C.bwhite, it.bg, BOLD);
    }
    bomb(s, x, y, fuse, blink) {
        const col = fuse > 30 ? C.bwhite : fuse > 14 ? C.byellow : blink ? C.bred : C.bwhite;
        if (this.big) {
            s.text(x, y, ' ▄▄', col);
            s.set(x + 3, y, '*', blink ? C.byellow : C.bred, -1, BOLD);
            s.text(x, y + 1, '▐██▌', col);
        }
        else
            s.text(x, y, '()', col, -1, BOLD);
    }
    flame(s, x, y, kind, blink) {
        const fresh = kind === kind.toUpperCase();
        const k = kind.toUpperCase();
        const hot = blink ? C.byellow : C.bwhite;
        if (!this.big) {
            s.text(x, y, fresh ? '▓▓' : '░░', fresh ? hot : C.byellow, fresh ? C.red : -1);
            return;
        }
        if (k === 'C') {
            // the core of the blast
            s.text(x, y, fresh ? '▓▓▓▓' : '░░░░', fresh ? hot : C.byellow, fresh ? C.red : -1);
            s.text(x, y + 1, fresh ? '▓▓▓▓' : '░░░░', fresh ? hot : C.byellow, fresh ? C.red : -1);
        }
        else if (k === 'H') {
            // a band through the middle of the tile
            s.text(x, y, '▄▄▄▄', fresh ? C.byellow : C.red);
            s.text(x, y + 1, '▀▀▀▀', fresh ? C.byellow : C.red);
        }
        else {
            s.text(x, y, fresh ? ' ██ ' : ' ▒▒ ', fresh ? C.byellow : C.red);
            s.text(x, y + 1, fresh ? ' ██ ' : ' ▒▒ ', fresh ? C.byellow : C.red);
        }
    }
    player(s, x, y, slot, alive, shield, flash, me, step, ctx) {
        const col = alive ? seatColor(slot) : C.gray;
        if (!ctx.color) {
            const tag = String(slot + 1);
            if (this.big) {
                s.text(x, y, alive ? `(${tag}${tag})`.slice(0, 4) : '(xx)', -1, -1, me ? BOLD : 0);
                s.text(x, y + 1, alive ? ' /\\ ' : '▀▀▀▀');
            }
            else
                s.text(x, y, alive ? `@${tag}` : 'xx', -1, -1, BOLD);
            return;
        }
        const bg = flash ? C.bwhite : col;
        if (this.big) {
            s.text(x, y, alive ? (shield ? '[••]' : ' •• ') : ' xx ', C.black, bg, BOLD);
            s.text(x, y + 1, alive ? (step ? '▀  ▀' : ' ▀▀ ') : '▀▀▀▀', col, -1);
        }
        else
            s.text(x, y, alive ? (me ? '◘◘' : '••') : 'xx', C.black, bg, BOLD);
    }
    overlay(s, v, ctx) {
        const mid = Math.floor(s.h / 2);
        if (v.ph === 'count') {
            const big = s.h >= 13 && bigWidth(String(v.cd)) + 6 < s.w;
            const boxW = Math.min(s.w - 2, Math.max(18, v.m.length + 6));
            const boxH = big ? 9 : 4;
            const bx = (s.w - boxW) >> 1;
            const by = Math.max(0, mid - (boxH >> 1));
            s.fill(bx, by, boxW, boxH, ' ', -1, C.black);
            s.box(bx, by, boxW, boxH, C.byellow, C.black, 'single');
            s.center(by + 1, v.m, C.byellow, C.black, BOLD, bx + 1, boxW - 2);
            if (big)
                bigCenter(s, by + 3, String(v.cd), C.bwhite, 'big', bx, boxW);
            else
                s.center(by + 2, `starts in ${v.cd}`, C.bwhite, C.black, BOLD, bx + 1, boxW - 2);
            const me = v.p.find((r) => r[0] === ctx.me);
            if (me && this.big) {
                // Tag our bomber so everyone knows which one is theirs.
                const hx = (me[1] ?? 0) * 4;
                const hy = (me[2] ?? 0) * 2;
                const below = hy + 2 < s.h;
                s.text(Math.max(0, Math.min(s.w - 7, hx - 1)), below ? hy + 2 : hy - 1, below ? ' YOU ▲ ' : ' YOU ▼ ', C.black, C.bwhite, BOLD);
            }
        }
        else if (v.ph === 'round' || v.ph === 'over') {
            s.center(mid, ` ${fit(v.m, s.w - 4)} `, C.black, C.byellow, BOLD);
        }
        else if (v.tl < 0 && v.tl > -5) {
            s.center(1, ' HURRY UP! ', C.bwhite, C.red, BOLD);
        }
        else if (ctx.me !== null) {
            const me = v.p.find((r) => r[0] === ctx.me);
            if (me && !me[3] && !me[10])
                s.center(s.h - 1, ' you were blasted — watch the rest of the round ', C.black, C.bred, BOLD);
        }
        if (ctx.me === null && v.ph === 'play')
            s.center(s.h - 1, ' spectating — you join next match ', C.gray, C.black);
    }
}
export const blastGame = {
    id: 'blast',
    title: 'Blast Yard',
    tag: 'bombs, crates and chain reactions',
    genre: 'real-time',
    min: 2,
    max: 8,
    bots: true,
    accent: C.byellow,
    about: 'Drop bombs to blow open crates and trap your rivals in cross-shaped blasts. Crates hide power-ups: BOMB carries an extra bomb, FIRE stretches the blast, FAST speeds you up, SHLD survives one hit. Bombs set each other off, so chains can sweep the yard. Last one standing wins the round; drag it out and the blocks start falling.',
    controls: ['←↑↓→ or WASD   move one tile per press (hold to run)', 'Space or B     drop a bomb', 'T chat · Esc leave'],
    art: ['█▀▀█╔══╗    ╔══╗█▀▀█', '█▄▄█╚══╝ ▄▄*╚══╝█▄▄█', '     •• ▐██▌▓▓▓▓▓▓▓▓', '    ▀  ▀    ▓▓▓▓▓▓▓▓', '█▀▀█ +1 ╔══╗ •• █▀▀█', '█▄▄█BOMB╚══╝▀  ▀█▄▄█'],
    settings: [
        { key: 'wins', label: 'Win at', choices: [{ v: 3, label: '3 rounds' }, { v: 5, label: '5 rounds' }, { v: 1, label: '1 round' }] },
        { key: 'crates', label: 'Crates', choices: [{ v: 'normal', label: 'Normal' }, { v: 'dense', label: 'Packed' }, { v: 'sparse', label: 'Sparse' }] },
        { key: 'drops', label: 'Power-ups', choices: [{ v: 'normal', label: 'Normal' }, { v: 'lots', label: 'Plenty' }, { v: 'few', label: 'Rare' }] },
        { key: 'time', label: 'Hurry-up', choices: [{ v: 120, label: 'after 2:00' }, { v: 90, label: 'after 1:30' }, { v: 180, label: 'after 3:00' }] },
        { key: 'bots', label: 'Bots', choices: [{ v: 'normal', label: 'Normal' }, { v: 'hard', label: 'Hard' }, { v: 'easy', label: 'Easy' }] },
    ],
    create: (ctx) => new BlastGame(ctx),
    client: () => new BlastClient(),
};
