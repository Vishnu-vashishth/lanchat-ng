const OPS = new Set(['ad', 'close', 'join', 'leave', 'deny', 'table', 'frame', 'feed', 'input', 'size']);
const PHASES = new Set(['lobby', 'playing', 'results']);
function obj(x) {
    return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}
export function str(x, max, def = '') {
    return typeof x === 'string' ? x.slice(0, max) : def;
}
export function int(x, lo, hi, def) {
    if (typeof x !== 'number' || !Number.isFinite(x))
        return def;
    return Math.min(hi, Math.max(lo, Math.round(x)));
}
export function isGameMsg(x) {
    const o = obj(x);
    return (!!o &&
        o.t === 'game' &&
        typeof o.room === 'string' &&
        o.room.length > 0 &&
        o.room.length <= 64 &&
        typeof o.gid === 'string' &&
        /^[0-9a-f]{1,32}$/.test(o.gid) &&
        typeof o.op === 'string' &&
        OPS.has(o.op));
}
export function readAd(d) {
    const o = obj(d);
    if (!o || typeof o.kind !== 'string')
        return null;
    const phase = typeof o.phase === 'string' && PHASES.has(o.phase) ? o.phase : 'lobby';
    return {
        kind: str(o.kind, 24),
        title: str(o.title, 40, o.kind),
        host: str(o.host, 32, '?'),
        n: int(o.n, 0, 99, 0),
        max: int(o.max, 1, 99, 8),
        phase,
    };
}
export function readSize(d) {
    const o = obj(d) ?? {};
    return { cols: int(o.cols, 20, 500, 80), rows: int(o.rows, 8, 300, 24) };
}
export function readFeed(d) {
    const o = obj(d);
    if (!o || typeof o.text !== 'string')
        return null;
    return { text: str(o.text, 200), slot: typeof o.slot === 'number' ? int(o.slot, 0, 63, 0) : undefined };
}
export function readTable(d) {
    const o = obj(d);
    if (!o || typeof o.kind !== 'string' || typeof o.phase !== 'string' || !PHASES.has(o.phase))
        return null;
    const members = [];
    if (Array.isArray(o.members)) {
        for (const m of o.members.slice(0, 64)) {
            const mo = obj(m);
            if (!mo)
                continue;
            members.push({
                slot: int(mo.slot, -1, 63, -1),
                nick: str(mo.nick, 32, '?'),
                bot: mo.bot === true,
                spec: mo.spec === true,
                host: mo.host === true,
            });
        }
    }
    const settings = {};
    const so = obj(o.settings);
    if (so) {
        for (const [k, v] of Object.entries(so).slice(0, 32)) {
            if (typeof v === 'string')
                settings[k.slice(0, 24)] = v.slice(0, 32);
            else if (typeof v === 'number' && Number.isFinite(v))
                settings[k.slice(0, 24)] = v;
        }
    }
    let results = null;
    const ro = obj(o.results);
    if (ro) {
        const standings = [];
        if (Array.isArray(ro.standings)) {
            for (const s of ro.standings.slice(0, 64)) {
                const so2 = obj(s);
                if (!so2)
                    continue;
                standings.push({
                    slot: int(so2.slot, 0, 63, 0),
                    nick: str(so2.nick, 32, '?'),
                    score: int(so2.score, -1e9, 1e9, 0),
                    detail: typeof so2.detail === 'string' ? so2.detail.slice(0, 60) : undefined,
                });
            }
        }
        const lines = Array.isArray(ro.lines) ? ro.lines.filter((l) => typeof l === 'string').slice(0, 12).map((l) => l.slice(0, 120)) : [];
        results = { standings, lines };
    }
    return {
        kind: str(o.kind, 24),
        host: str(o.host, 32, '?'),
        phase: o.phase,
        you: typeof o.you === 'number' ? int(o.you, 0, 63, 0) : null,
        spec: o.spec === true,
        min: int(o.min, 1, 99, 1),
        max: int(o.max, 1, 99, 8),
        members,
        settings,
        results,
    };
}
