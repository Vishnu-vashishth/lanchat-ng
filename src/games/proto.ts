import type { Phase, Settings, Standing } from './types.js';

// Wire format for games. Every game message rides the existing encrypted peer
// session as one more application message type:
//
//   { t: 'game', room, gid, op, d? }
//
// `gid` names a table (a game lobby + match) and `room` scopes it: tables are
// only advertised to, and only joinable by, peers admitted to that room.
// Everything below arrives from the network, so it is validated before use.

export type GameOp =
  | 'ad' // host -> room: a table exists (also updates player count/phase)
  | 'close' // host -> room/members: the table is gone
  | 'join' // player -> host: seat me (d: SizeData)
  | 'leave' // player -> host
  | 'deny' // host -> player: join refused (d: { reason })
  | 'table' // host -> member: roster, settings, phase, results
  | 'frame' // host -> member: the game view for that member's seat
  | 'feed' // host -> members: one event-feed line
  | 'input' // player -> host: game input (d: game-specific)
  | 'size'; // player -> host: my terminal was resized (d: SizeData)

const OPS: ReadonlySet<string> = new Set<GameOp>(['ad', 'close', 'join', 'leave', 'deny', 'table', 'frame', 'feed', 'input', 'size']);

export interface GameMsg {
  t: 'game';
  room: string;
  gid: string;
  op: GameOp;
  d?: unknown;
}

export interface AdData {
  kind: string;
  title: string;
  host: string;
  n: number;
  max: number;
  phase: Phase;
}

export interface SizeData {
  cols: number;
  rows: number;
}

export interface MemberInfo {
  slot: number;
  nick: string;
  bot: boolean;
  spec: boolean;
  host: boolean;
}

export interface TableData {
  kind: string;
  host: string;
  phase: Phase;
  you: number | null;
  spec: boolean;
  min: number;
  max: number;
  members: MemberInfo[];
  settings: Settings;
  results: { standings: Standing[]; lines: string[] } | null;
}

export interface FeedData {
  text: string;
  slot?: number;
}

const PHASES: ReadonlySet<string> = new Set(['lobby', 'playing', 'results']);

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

export function str(x: unknown, max: number, def = ''): string {
  return typeof x === 'string' ? x.slice(0, max) : def;
}

export function int(x: unknown, lo: number, hi: number, def: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return def;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

export function isGameMsg(x: unknown): x is GameMsg {
  const o = obj(x);
  return (
    !!o &&
    o.t === 'game' &&
    typeof o.room === 'string' &&
    o.room.length > 0 &&
    o.room.length <= 64 &&
    typeof o.gid === 'string' &&
    /^[0-9a-f]{1,32}$/.test(o.gid) &&
    typeof o.op === 'string' &&
    OPS.has(o.op)
  );
}

export function readAd(d: unknown): AdData | null {
  const o = obj(d);
  if (!o || typeof o.kind !== 'string') return null;
  const phase = typeof o.phase === 'string' && PHASES.has(o.phase) ? (o.phase as Phase) : 'lobby';
  return {
    kind: str(o.kind, 24),
    title: str(o.title, 40, o.kind as string),
    host: str(o.host, 32, '?'),
    n: int(o.n, 0, 99, 0),
    max: int(o.max, 1, 99, 8),
    phase,
  };
}

export function readSize(d: unknown): SizeData {
  const o = obj(d) ?? {};
  return { cols: int(o.cols, 20, 500, 80), rows: int(o.rows, 8, 300, 24) };
}

export function readFeed(d: unknown): FeedData | null {
  const o = obj(d);
  if (!o || typeof o.text !== 'string') return null;
  return { text: str(o.text, 200), slot: typeof o.slot === 'number' ? int(o.slot, 0, 63, 0) : undefined };
}

export function readTable(d: unknown): TableData | null {
  const o = obj(d);
  if (!o || typeof o.kind !== 'string' || typeof o.phase !== 'string' || !PHASES.has(o.phase)) return null;
  const members: MemberInfo[] = [];
  if (Array.isArray(o.members)) {
    for (const m of o.members.slice(0, 64)) {
      const mo = obj(m);
      if (!mo) continue;
      members.push({
        slot: int(mo.slot, -1, 63, -1),
        nick: str(mo.nick, 32, '?'),
        bot: mo.bot === true,
        spec: mo.spec === true,
        host: mo.host === true,
      });
    }
  }
  const settings: Settings = {};
  const so = obj(o.settings);
  if (so) {
    for (const [k, v] of Object.entries(so).slice(0, 32)) {
      if (typeof v === 'string') settings[k.slice(0, 24)] = v.slice(0, 32);
      else if (typeof v === 'number' && Number.isFinite(v)) settings[k.slice(0, 24)] = v;
    }
  }
  let results: TableData['results'] = null;
  const ro = obj(o.results);
  if (ro) {
    const standings: Standing[] = [];
    if (Array.isArray(ro.standings)) {
      for (const s of ro.standings.slice(0, 64)) {
        const so2 = obj(s);
        if (!so2) continue;
        standings.push({
          slot: int(so2.slot, 0, 63, 0),
          nick: str(so2.nick, 32, '?'),
          score: int(so2.score, -1e9, 1e9, 0),
          detail: typeof so2.detail === 'string' ? so2.detail.slice(0, 60) : undefined,
        });
      }
    }
    const lines = Array.isArray(ro.lines) ? ro.lines.filter((l): l is string => typeof l === 'string').slice(0, 12).map((l) => l.slice(0, 120)) : [];
    results = { standings, lines };
  }
  return {
    kind: str(o.kind, 24),
    host: str(o.host, 32, '?'),
    phase: o.phase as Phase,
    you: typeof o.you === 'number' ? int(o.you, 0, 63, 0) : null,
    spec: o.spec === true,
    min: int(o.min, 1, 99, 1),
    max: int(o.max, 1, 99, 8),
    members,
    settings,
    results,
  };
}
