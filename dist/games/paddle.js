import { BOLD, C, DIM, fit, pad, seatColor } from './term/canvas.js';
import { bigCenter, bigWidth } from './term/font.js';
// PADDLE PANIC — every player guards one wall of the court with a paddle.
// Let a ball past and you lose a life; lose them all and your wall turns
// solid. Hit the ball off the end of your paddle to angle it, catch the
// floating orbs for a bigger paddle or an extra ball, and survive the rising
// pace as more balls join in. Two players face off left/right; three or four
// take every wall.
//
// Physics runs in "units": one column wide, half a row tall, so a ball moves
// the same visual distance in every direction and can be drawn at half-row
// resolution with ▀/▄ blocks.
const TICK = 33;
const SEC = Math.round(1000 / TICK);
const LEFT = 0;
const RIGHT = 1;
const TOP = 2;
const BOTTOM = 3;
class PaddleGame {
    ctx;
    tickMs = TICK;
    done = false;
    W;
    H;
    U; // court height in units (2 per row)
    sides = [];
    balls = [];
    orb = null;
    rng;
    lives;
    maxBalls;
    baseSpeed;
    skill;
    phase = 'count';
    phaseT = 3 * SEC;
    t = 0;
    nextBall;
    nextOrb;
    placeNext;
    banner = 'GET READY';
    constructor(ctx) {
        this.ctx = ctx;
        const st = ctx.settings;
        this.rng = ctx.rng;
        this.lives = typeof st.lives === 'number' ? st.lives : 5;
        this.maxBalls = typeof st.balls === 'number' ? st.balls : 3;
        this.baseSpeed = st.pace === 'fast' ? 0.95 : st.pace === 'chill' ? 0.6 : 0.78;
        this.skill = st.bots === 'hard' ? 2 : st.bots === 'easy' ? 0 : 1;
        const n = ctx.players.length;
        const side = ctx.arena.cols >= 111;
        const availW = (side ? ctx.arena.cols - 31 : ctx.arena.cols) - 2;
        const availH = ctx.arena.rows - 4;
        if (n <= 2) {
            this.H = Math.max(14, Math.min(availH, 22));
            this.W = Math.max(40, Math.min(availW, Math.round(this.H * 3.2), 80));
        }
        else {
            this.H = Math.max(16, Math.min(availH, 26));
            this.W = Math.max(36, Math.min(availW, this.H * 2 + 6, 64));
        }
        this.U = this.H * 2;
        const order = n <= 2 ? [LEFT, RIGHT] : [LEFT, RIGHT, TOP, BOTTOM];
        for (let sd = 0; sd < 4; sd++) {
            const k = order.indexOf(sd);
            const p = k >= 0 ? ctx.players[k] : undefined;
            const len = this.baseLen(sd);
            this.sides.push({
                side: sd,
                slot: p ? p.slot : -1,
                nick: p ? p.nick : '',
                bot: p ? p.bot : false,
                pos: (this.axisMax(sd) + this.axisMin(sd) - len) / 2,
                target: (this.axisMax(sd) + this.axisMin(sd) - len) / 2,
                len,
                grow: 0,
                lives: p ? this.lives : 0,
                alive: !!p,
                out: false,
                hits: 0,
                place: 0,
                aimErr: 0,
                think: 0,
            });
        }
        this.placeNext = this.sides.filter((s) => s.alive).length;
        this.nextBall = 20 * SEC;
        this.nextOrb = 12 * SEC;
        this.serve(this.newBall(), 0);
    }
    // Along-axis range each paddle may travel (units for left/right, columns for top/bottom).
    axisMin(side) {
        return side === LEFT || side === RIGHT ? 4 : 3;
    }
    axisMax(side) {
        return side === LEFT || side === RIGHT ? this.U - 4 : this.W - 3;
    }
    baseLen(side) {
        return side === LEFT || side === RIGHT ? Math.max(6, Math.round(this.U * 0.2)) : Math.max(8, Math.round(this.W * 0.2));
    }
    newBall() {
        const b = { x: this.W / 2, y: this.U / 2, vx: 0, vy: 0, speed: this.baseSpeed, last: -1, wait: 0 };
        this.balls.push(b);
        return b;
    }
    /** Put a ball in the middle and send it toward a random player still in. */
    serve(b, delay) {
        const live = this.sides.filter((s) => s.alive);
        const to = live.length ? this.rng.pick(live).side : this.rng.int(2);
        const a = (this.rng.next() - 0.5) * (Math.PI / 2.6);
        b.x = this.W / 2 + (this.rng.next() - 0.5) * 4;
        b.y = this.U / 2 + (this.rng.next() - 0.5) * 4;
        b.speed = this.baseSpeed * (1 + Math.min(0.5, this.t / (SEC * 240)));
        b.last = -1;
        b.wait = delay;
        const along = Math.cos(a) * b.speed;
        const across = Math.sin(a) * b.speed;
        if (to === LEFT)
            [b.vx, b.vy] = [-along, across];
        else if (to === RIGHT)
            [b.vx, b.vy] = [along, across];
        else if (to === TOP)
            [b.vx, b.vy] = [across, -along];
        else
            [b.vx, b.vy] = [across, along];
    }
    // ---- input ----
    input(slot, data) {
        const sd = this.sides.find((s) => s.slot === slot && s.alive);
        if (!sd || sd.bot)
            return;
        const m = data?.m;
        if (m !== -1 && m !== 1)
            return;
        // Each press nudges the paddle's target; holding the key glides it.
        const step = sd.side === LEFT || sd.side === RIGHT ? 4 : 5;
        const base = Math.max(sd.pos - step / 2, Math.min(sd.pos + step / 2, sd.target));
        sd.target = this.clamp(sd, base + m * step);
    }
    clamp(sd, v) {
        return Math.max(this.axisMin(sd.side), Math.min(this.axisMax(sd.side) - sd.len, v));
    }
    drop(slot) {
        const sd = this.sides.find((s) => s.slot === slot);
        if (!sd || !sd.alive)
            return;
        sd.out = true;
        this.eliminate(sd, `${sd.nick} left — their wall goes solid`);
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
        if (this.phase === 'over') {
            // Hold the final court on screen for a moment before the results.
            if (--this.phaseT <= 0)
                this.done = true;
            return;
        }
        this.t++;
        for (const sd of this.sides) {
            if (!sd.alive)
                continue;
            if (sd.grow > 0 && --sd.grow === 0) {
                const center = sd.pos + sd.len / 2;
                sd.len = this.baseLen(sd.side);
                sd.pos = this.clamp(sd, center - sd.len / 2);
                sd.target = this.clamp(sd, sd.target);
            }
            if (sd.bot)
                this.think(sd);
            const maxV = sd.bot ? [0.9, 1.3, 1.7][this.skill] : sd.side === LEFT || sd.side === RIGHT ? 1.6 : 2;
            const d = sd.target - sd.pos;
            sd.pos = this.clamp(sd, sd.pos + Math.max(-maxV, Math.min(maxV, d)));
        }
        for (const b of [...this.balls])
            this.moveBall(b);
        if (this.t >= this.nextBall && this.balls.length < this.maxBalls) {
            this.serve(this.newBall(), SEC);
            this.ctx.feed('another ball joins the court!');
            this.nextBall = this.t + 25 * SEC;
        }
        this.updateOrb();
    }
    moveBall(b) {
        if (b.wait > 0) {
            b.wait--;
            return;
        }
        // Sub-step so fast balls never tunnel through a paddle.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy)) / 0.5));
        for (let i = 0; i < steps; i++) {
            b.x += b.vx / steps;
            b.y += b.vy / steps;
            if (this.collide(b))
                return;
        }
    }
    /** Bounce off walls and paddles; returns true if the ball left play. */
    collide(b) {
        const L = this.sides[LEFT];
        const R = this.sides[RIGHT];
        const T = this.sides[TOP];
        const B = this.sides[BOTTOM];
        if (b.vx < 0 && b.x <= 2) {
            if (L.alive && b.x > 1.2 && b.y >= L.pos - 1 && b.y <= L.pos + L.len + 1)
                this.hit(b, L, (b.y - (L.pos + L.len / 2)) / (L.len / 2 + 1));
            else if (!L.alive || b.y < this.axisMin(LEFT) || b.y > this.axisMax(LEFT)) {
                b.x = 2 + (2 - b.x);
                b.vx = -b.vx;
            }
            else if (b.x <= 0.5)
                return this.goal(b, L);
        }
        else if (b.vx > 0 && b.x >= this.W - 2) {
            if (R.alive && b.x < this.W - 1.2 && b.y >= R.pos - 1 && b.y <= R.pos + R.len + 1)
                this.hit(b, R, (b.y - (R.pos + R.len / 2)) / (R.len / 2 + 1));
            else if (!R.alive || b.y < this.axisMin(RIGHT) || b.y > this.axisMax(RIGHT)) {
                b.x = this.W - 2 - (b.x - (this.W - 2));
                b.vx = -b.vx;
            }
            else if (b.x >= this.W - 0.5)
                return this.goal(b, R);
        }
        if (b.vy < 0 && b.y <= 4) {
            if (T.alive && b.y > 2.5 && b.x >= T.pos - 0.5 && b.x <= T.pos + T.len + 0.5)
                this.hit(b, T, (b.x - (T.pos + T.len / 2)) / (T.len / 2 + 0.5));
            else if (!T.alive || b.x < this.axisMin(TOP) || b.x > this.axisMax(TOP)) {
                b.y = 4 + (4 - b.y);
                b.vy = -b.vy;
            }
            else if (b.y <= 1)
                return this.goal(b, T);
        }
        else if (b.vy > 0 && b.y >= this.U - 4) {
            if (B.alive && b.y < this.U - 2.5 && b.x >= B.pos - 0.5 && b.x <= B.pos + B.len + 0.5)
                this.hit(b, B, (b.x - (B.pos + B.len / 2)) / (B.len / 2 + 0.5));
            else if (!B.alive || b.x < this.axisMin(BOTTOM) || b.x > this.axisMax(BOTTOM)) {
                b.y = this.U - 4 - (b.y - (this.U - 4));
                b.vy = -b.vy;
            }
            else if (b.y >= this.U - 1)
                return this.goal(b, B);
        }
        if (this.orb && Math.abs(b.x - this.orb.x) < 1.5 && Math.abs(b.y - this.orb.y) < 2)
            this.takeOrb(b);
        return false;
    }
    /** Paddle hit: angle by where it struck, speed up a little. */
    hit(b, sd, offset) {
        const o = Math.max(-1, Math.min(1, offset));
        const ang = o * (Math.PI / 3.2);
        b.speed = Math.min(this.baseSpeed * 2.3, b.speed * 1.045);
        const along = Math.cos(ang) * b.speed;
        const across = Math.sin(ang) * b.speed;
        if (sd.side === LEFT)
            [b.vx, b.vy, b.x] = [along, across, 2.01];
        else if (sd.side === RIGHT)
            [b.vx, b.vy, b.x] = [-along, across, this.W - 2.01];
        else if (sd.side === TOP)
            [b.vx, b.vy, b.y] = [across, along, 4.01];
        else
            [b.vx, b.vy, b.y] = [across, -along, this.U - 4.01];
        b.last = sd.slot;
        sd.hits++;
    }
    goal(b, sd) {
        sd.lives--;
        const scorer = this.sides.find((s) => s.slot === b.last && s !== sd);
        this.ctx.feed(`${sd.nick} let one through${scorer ? ` (${scorer.nick}'s shot)` : ''} — ${Math.max(0, sd.lives)} left`, sd.slot);
        if (sd.lives <= 0)
            this.eliminate(sd, `${sd.nick} is out!`);
        if (this.phase === 'over')
            return true;
        // The ball goes back to the middle; extra balls beyond one just vanish.
        if (this.balls.length > 1)
            this.balls = this.balls.filter((x) => x !== b);
        else
            this.serve(b, Math.round(1.2 * SEC));
        return true;
    }
    eliminate(sd, msg) {
        if (!sd.alive)
            return;
        sd.alive = false;
        sd.lives = 0;
        sd.place = this.placeNext--;
        this.ctx.feed(msg, sd.slot);
        const live = this.sides.filter((s) => s.alive);
        if (live.length <= 1) {
            if (live[0]) {
                live[0].place = 1;
                this.banner = `${live[0].nick.toUpperCase()} WINS`;
                this.ctx.feed(`${live[0].nick} wins the court!`, live[0].slot);
            }
            else
                this.banner = 'GAME OVER';
            this.phase = 'over';
            this.phaseT = Math.round(2.5 * SEC);
        }
    }
    updateOrb() {
        if (this.orb) {
            if (--this.orb.ttl <= 0)
                this.orb = null;
            return;
        }
        if (this.t < this.nextOrb)
            return;
        this.nextOrb = this.t + (14 + this.rng.int(10)) * SEC;
        this.orb = {
            x: this.W / 2 + (this.rng.next() - 0.5) * this.W * 0.4,
            y: this.U / 2 + (this.rng.next() - 0.5) * this.U * 0.4,
            kind: this.balls.length < this.maxBalls + 1 && this.rng.chance(0.4) ? 1 : 0,
            ttl: 10 * SEC,
        };
    }
    takeOrb(b) {
        const orb = this.orb;
        this.orb = null;
        const owner = this.sides.find((s) => s.slot === b.last && s.alive);
        if (orb.kind === 1) {
            const nb = this.newBall();
            Object.assign(nb, { x: b.x, y: b.y, vx: -b.vy || b.speed, vy: b.vx, speed: b.speed, last: b.last });
            this.ctx.feed(`${owner ? owner.nick : 'someone'} split the ball in two!`, owner?.slot);
        }
        else if (owner) {
            const center = owner.pos + owner.len / 2;
            owner.len = Math.round(this.baseLen(owner.side) * 1.6);
            owner.pos = this.clamp(owner, center - owner.len / 2);
            owner.target = this.clamp(owner, owner.target);
            owner.grow = 12 * SEC;
            this.ctx.feed(`${owner.nick} grabbed a big paddle for 12s`, owner.slot);
        }
    }
    // ---- bots ----
    think(sd) {
        if (--sd.think > 0)
            return;
        sd.think = [7, 3, 1][this.skill];
        const vertical = sd.side === LEFT || sd.side === RIGHT;
        let best = null;
        for (const b of this.balls) {
            if (b.wait > 0)
                continue;
            const toward = sd.side === LEFT ? b.vx < 0 : sd.side === RIGHT ? b.vx > 0 : sd.side === TOP ? b.vy < 0 : b.vy > 0;
            if (!toward)
                continue;
            const dist = sd.side === LEFT ? b.x - 2 : sd.side === RIGHT ? this.W - 2 - b.x : sd.side === TOP ? b.y - 4 : this.U - 4 - b.y;
            const speed = Math.abs(vertical ? b.vx : b.vy) || 0.01;
            const t = dist / speed;
            // Where it crosses our line, folding in bounces off the side walls.
            const lo = vertical ? 4 : 3;
            const hi = vertical ? this.U - 4 : this.W - 3;
            let at = (vertical ? b.y : b.x) + (vertical ? b.vy : b.vx) * t;
            const span = hi - lo;
            at = ((((at - lo) % (2 * span)) + 2 * span) % (2 * span));
            at = lo + (at > span ? 2 * span - at : at);
            if (!best || t < best.t)
                best = { t, at };
        }
        if (sd.aimErr === 0 || this.rng.chance(0.05))
            sd.aimErr = (this.rng.next() - 0.5) * 2 * [5, 2, 0.6][this.skill];
        const center = best ? best.at + sd.aimErr : (this.axisMin(sd.side) + this.axisMax(sd.side)) / 2;
        sd.target = this.clamp(sd, center - sd.len / 2);
    }
    // ---- views ----
    view(_slot) {
        return {
            W: this.W,
            H: this.H,
            s: this.sides.map((s) => [s.side, s.slot, Math.round(s.pos * 10) / 10, s.len, s.lives, s.alive ? 1 : 0, s.hits, s.out ? 1 : 0, s.grow > 0 ? 1 : 0]),
            b: this.balls.filter((b) => b.wait <= 0 || Math.floor(b.wait / 4) % 2 === 0).map((b) => [Math.round(b.x * 10), Math.round(b.y * 10), b.last]),
            o: this.orb ? [Math.round(this.orb.x), Math.round(this.orb.y), this.orb.kind] : null,
            ph: this.phase,
            cd: this.phase === 'count' ? Math.ceil(this.phaseT / SEC) : 0,
            L: this.lives,
            m: this.banner,
        };
    }
    standings() {
        return this.sides
            .filter((s) => s.slot >= 0)
            .sort((a, b) => (a.place || 99) - (b.place || 99) || b.lives - a.lives || b.hits - a.hits)
            .map((s) => ({ slot: s.slot, nick: s.nick, score: s.lives, detail: `${s.hits} returns${s.out ? ' · left' : ''}` }));
    }
    summary() {
        const best = this.sides.filter((s) => s.slot >= 0).sort((a, b) => b.hits - a.hits)[0];
        return [`score = lives left`, ...(best ? [`iron wall: ${best.nick} (${best.hits} returns)`] : [])];
    }
}
// ---- client ----
function asView(f) {
    const v = f;
    if (!v || typeof v !== 'object' || !Array.isArray(v.s) || !Array.isArray(v.b))
        return null;
    if (!Number.isInteger(v.W) || !Number.isInteger(v.H) || v.W < 20 || v.H < 8 || v.W > 200 || v.H > 100)
        return null;
    return { ...v, s: v.s.slice(0, 4), b: v.b.slice(0, 32) }; // cap list sizes from the network
}
const SIDE_NAMES = ['left', 'right', 'top', 'bottom'];
class PaddleClient {
    measure(frame, aw, ah) {
        const v = asView(frame);
        if (!v)
            return null;
        return v.W <= aw && v.H <= ah ? { w: v.W, h: v.H } : null;
    }
    need(frame) {
        const v = asView(frame);
        return v ? { w: v.W, h: v.H } : { w: 60, h: 22 };
    }
    key(k) {
        if (k.ctrl || k.meta)
            return undefined;
        if (['up', 'left', 'w', 'a', 'k', 'h'].includes(k.name))
            return { m: -1 };
        if (['down', 'right', 's', 'd', 'j', 'l'].includes(k.name))
            return { m: 1 };
        return undefined;
    }
    help(frame, ctx) {
        const v = asView(frame);
        const mine = v?.s.find((r) => r[1] === ctx.me);
        if (!mine)
            return 'watching';
        const side = mine[0] ?? 0;
        return `you guard the ${SIDE_NAMES[side]} wall · ${side < 2 ? '↑↓ / W S' : '←→ / A D'} move (tap or hold)`;
    }
    status(frame) {
        const v = asView(frame);
        if (!v)
            return '';
        const n = v.s.filter((r) => r[5]).length;
        return `${n} still in · ${v.b.length} ball${v.b.length === 1 ? '' : 's'}`;
    }
    scoreboard(frame, ctx) {
        const v = asView(frame);
        if (!v)
            return [];
        const lines = [];
        for (const r of v.s) {
            const [side = 0, slot = -1, , , lives = 0, alive = 0, hits = 0, out = 0] = r;
            if (slot < 0)
                continue;
            lines.push({
                slot,
                text: `${pad(fit(ctx.nick(slot), 10), 10)} ${alive ? '♥'.repeat(Math.max(0, Math.min(lives, 10))) : out ? 'left' : 'OUT'}`,
                fg: slot === ctx.me ? C.bwhite : alive ? -1 : C.gray,
                at: slot === ctx.me ? BOLD : 0,
            });
            lines.push({ text: `   ${SIDE_NAMES[side]} · ${hits} returns`, fg: C.gray });
        }
        lines.push({ text: '' });
        lines.push({ text: '◊ big paddle   + extra ball', fg: C.gray });
        return lines;
    }
    draw(s, frame, ctx) {
        const v = asView(frame);
        if (!v)
            return;
        const W = v.W;
        const H = v.H;
        const blink = Math.floor(ctx.now / 250) % 2 === 0;
        const sides = new Map();
        for (const r of v.s)
            sides.set(r[0] ?? 0, r);
        // court lines: a goal line in the owner's color, or a solid wall
        const edge = (sd) => {
            const r = sides.get(sd);
            const slot = r?.[1] ?? -1;
            return { wall: !r || slot < 0 || !r[5], color: slot >= 0 ? seatColor(slot) : C.gray, me: slot === ctx.me };
        };
        const L = edge(0);
        const R = edge(1);
        const T = edge(2);
        const B = edge(3);
        for (let y = 1; y < H - 1; y++) {
            s.put(0, y, L.wall ? '█' : '│', L.wall ? C.gray : L.color, -1, L.wall ? 0 : DIM);
            s.put(W - 1, y, R.wall ? '█' : '│', R.wall ? C.gray : R.color, -1, R.wall ? 0 : DIM);
        }
        for (let x = 1; x < W - 1; x++) {
            s.put(x, 0, T.wall ? '▀' : '─', T.wall ? C.gray : T.color, -1, T.wall ? 0 : DIM);
            s.put(x, H - 1, B.wall ? '▄' : '─', B.wall ? C.gray : B.color, -1, B.wall ? 0 : DIM);
        }
        for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]])
            s.put(x, y, '█', C.gray, -1, 0);
        // corner posts (the ball bounces off them)
        if (!T.wall || !L.wall)
            s.text(1, 1, '▄▄', C.gray);
        if (!T.wall || !R.wall)
            s.text(W - 3, 1, '▄▄', C.gray);
        if (!B.wall || !L.wall)
            s.text(1, H - 2, '▀▀', C.gray);
        if (!B.wall || !R.wall)
            s.text(W - 3, H - 2, '▀▀', C.gray);
        // center mark
        const cx = W >> 1;
        for (let y = 2; y < H - 2; y += 2)
            s.put(cx, y, '·', C.gray, -1, DIM);
        // paddles
        for (const r of v.s) {
            const [side = 0, slot = -1, pos = 0, len = 0, , alive = 0, , , grow = 0] = r;
            if (slot < 0 || !alive)
                continue;
            const col = seatColor(slot);
            const mine = slot === ctx.me;
            const at = mine ? BOLD : 0;
            if (side === 0 || side === 1) {
                const x = side === 0 ? 1 : W - 2;
                this.vbar(s, x, pos, len, grow && blink ? C.bwhite : col, at);
                if (mine && v.ph === 'count')
                    s.text(side === 0 ? x + 2 : x - 5, Math.floor((pos + len / 2) / 2), side === 0 ? '◄YOU' : 'YOU►', C.black, C.bwhite, BOLD);
            }
            else {
                const y = side === 2 ? 1 : H - 2;
                const x0 = Math.max(0, Math.min(W, Math.round(pos)));
                const n = Math.max(1, Math.min(W - x0, Math.round(len)));
                for (let i = 0; i < n; i++)
                    s.put(x0 + i, y, side === 2 ? '▀' : '▄', grow && blink ? C.bwhite : col, -1, at);
                if (mine && v.ph === 'count')
                    s.text(x0 + (n >> 1) - 2, side === 2 ? y + 1 : y - 1, 'YOU', C.black, C.bwhite, BOLD);
            }
        }
        // orb
        if (v.o) {
            const [ox = 0, oy = 0, kind = 0] = v.o;
            s.put(ox, Math.floor(oy / 2), kind ? '+' : '◊', blink ? C.bmagenta : C.bwhite, -1, BOLD);
        }
        // balls, at half-row resolution
        for (const b of v.b) {
            const [bx = 0, by = 0, last = -1] = b;
            const x = Math.floor(bx / 10);
            const u = by / 10;
            const row = Math.floor(u / 2);
            const top = u - row * 2 < 1;
            s.put(x, row, ctx.color ? (top ? '▀' : '▄') : 'o', last >= 0 ? seatColor(last) : C.bwhite, -1, BOLD);
        }
        const mid = Math.floor(H / 2);
        if (v.ph === 'count') {
            if (H >= 11 && bigWidth(String(v.cd)) < W - 8)
                bigCenter(s, mid - 3, String(v.cd), C.bwhite);
            else
                s.center(mid, ` ${v.cd} `, C.black, C.bwhite, BOLD);
        }
        else if (v.ph === 'over')
            s.center(mid, ` ${fit(v.m, W - 6)} `, C.black, C.byellow, BOLD);
        else if (ctx.me !== null) {
            const mine = v.s.find((r) => r[1] === ctx.me);
            if (mine && !mine[5] && !mine[7])
                s.center(mid, ' you are out — your wall is solid now ', C.black, C.bred, BOLD);
        }
    }
    /** Vertical paddle at half-row resolution. */
    vbar(s, x, pos, len, col, at) {
        // Clamp to the court: a frame's numbers are not trusted to be sane.
        const a = Math.max(0, Math.min(s.h * 2, Math.round(pos)));
        const b = Math.max(a, Math.min(s.h * 2, Math.round(pos + len)));
        for (let u = a; u < b; u++) {
            const row = u >> 1;
            const top = u % 2 === 0;
            const both = top && u + 1 < b;
            if (both) {
                s.put(x, row, '█', col, -1, at);
                u++;
            }
            else
                s.put(x, row, top ? '▀' : '▄', col, -1, at);
        }
    }
}
export const paddleGame = {
    id: 'paddle',
    title: 'Paddle Panic',
    tag: 'guard your wall — every wall',
    genre: 'real-time',
    min: 2,
    max: 4,
    bots: true,
    accent: C.bcyan,
    about: 'Each player guards one wall of the court. Let a ball through and you lose a life; lose them all and your wall turns to stone. Hit the ball with the edge of your paddle to angle it, steer through ◊ orbs for a giant paddle or + orbs to split the ball, and keep up as more balls join and the pace climbs. Two players go left vs right; three or four fill every wall.',
    controls: ['↑↓ or W S      move (left/right walls)', '←→ or A D      move (top/bottom walls)', 'tap to nudge, hold to glide · T chat · Esc leave'],
    art: ['▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄', '█      ▀▀▀▀▀       █', '│█        ▄         ', '│█              ◊  █', '│     ·        ▀   █', '█     ▄▄▄▄▄▄       █'],
    settings: [
        { key: 'lives', label: 'Lives', choices: [{ v: 5, label: '5' }, { v: 3, label: '3' }, { v: 8, label: '8' }] },
        { key: 'balls', label: 'Max balls', choices: [{ v: 3, label: '3' }, { v: 2, label: '2' }, { v: 1, label: '1 (classic)' }, { v: 4, label: '4 (chaos)' }] },
        { key: 'pace', label: 'Pace', choices: [{ v: 'normal', label: 'Normal' }, { v: 'fast', label: 'Fast' }, { v: 'chill', label: 'Chill' }] },
        { key: 'bots', label: 'Bots', choices: [{ v: 'normal', label: 'Normal' }, { v: 'hard', label: 'Hard' }, { v: 'easy', label: 'Easy' }] },
    ],
    create: (ctx) => new PaddleGame(ctx),
    client: () => new PaddleClient(),
};
