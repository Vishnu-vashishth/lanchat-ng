import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, clean, safeChar } from '../src/games/term/canvas.js';
import { TermRenderer } from '../src/games/term/renderer.js';
import { isGameMsg, readTable } from '../src/games/proto.js';
import { makeRng } from '../src/games/rng.js';
import { GAMES, findGame, gameById } from '../src/games/registry.js';
import type { GameDef, GameLogic, Player, Settings } from '../src/games/types.js';

// Rules and safety checks for the arcade, below the network layer.

function start(id: string, players: Player[], settings: Settings = {}, seed = 1): { logic: GameLogic; feed: string[] } {
  const def = gameById(id) as GameDef;
  const st: Settings = {};
  for (const s of def.settings) st[s.key] = s.choices[s.def ?? 0]!.v;
  Object.assign(st, settings);
  const feed: string[] = [];
  const logic = def.create({ players, settings: st, arena: { cols: 120, rows: 36 }, rng: makeRng(seed), feed: (t) => feed.push(t) });
  return { logic, feed };
}

const humans = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ slot: i, nick: `p${i}`, bot: false }));
const bots = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ slot: i, nick: `b${i}`, bot: true }));
// Reach into a game's private state to set up exact positions.
const inner = <T>(x: unknown) => x as T;

test('drawing never lets peer text break the grid or inject escapes', () => {
  assert.equal(safeChar('\x1b'), '?');
  assert.equal(safeChar('\x07'), '?');
  assert.equal(safeChar('字'), '?'); // wide CJK would shift every later cell
  assert.equal(safeChar('😀'), '?');
  assert.equal(safeChar('é'), 'é');
  assert.equal(safeChar('♥'), '♥');
  assert.equal(clean('evil\x1b]0;pwned\x07nick'), 'evil?]0;pwned?nick');
  const c = new Canvas(10, 1);
  c.text(0, 0, 'a\x1b[2Jb');
  assert.equal(c.row(0), 'a?[2Jb    ');
});

test('renderer repaints only cells that changed', () => {
  let out = '';
  const r = new TermRenderer({ write: (s: string) => (out += s) }, true);
  r.enter();
  const c = new Canvas(20, 5);
  c.text(0, 0, 'hello');
  r.flush(c);
  out = '';
  r.flush(c);
  assert.equal(out, '', 'identical frame writes nothing');
  c.text(0, 2, 'X');
  r.flush(c);
  assert.match(out, /\x1b\[3;1H/);
  assert.ok(out.includes('X') && !out.includes('hello'));
});

test('game messages are validated before use', () => {
  assert.equal(isGameMsg({ t: 'game', room: 'lobby', gid: 'abc123', op: 'join' }), true);
  assert.equal(isGameMsg({ t: 'game', room: 'lobby', gid: 'ZZZ', op: 'join' }), false);
  assert.equal(isGameMsg({ t: 'game', room: 'lobby', gid: 'abc', op: 'hack' }), false);
  assert.equal(isGameMsg({ t: 'game', room: '', gid: 'abc', op: 'ad' }), false);
  const t = readTable({ kind: 'snake', phase: 'lobby', members: [{ slot: 999, nick: 'x'.repeat(500) }], you: -5, settings: { a: { evil: 1 }, b: 2 } });
  assert.ok(t);
  assert.equal(t.members[0]!.slot, 63);
  assert.equal(t.members[0]!.nick.length, 32);
  assert.equal(t.you, 0);
  assert.deepEqual(t.settings, { b: 2 });
  assert.equal(readTable({ kind: 'snake', phase: 'bogus' }), null);
});

test('every game has a playable definition and is findable by name', () => {
  assert.ok(GAMES.length >= 5);
  for (const g of GAMES) {
    assert.ok(g.min >= 1 && g.max >= g.min, g.id);
    assert.equal(findGame(g.id), g);
    assert.equal(findGame(g.title.toLowerCase()), g);
  }
  assert.equal(findGame('snak')?.id, 'snake');
  assert.equal(findGame('cards'), undefined);
});

test('every game plays a full bot match to the end and ranks everyone', () => {
  for (const g of GAMES) {
    const n = Math.min(g.max, 4);
    const { logic } = start(g.id, g.bots ? bots(n) : humans(n), {}, 7);
    let ticks = 0;
    const limit = (30 * 60 * 1000) / logic.tickMs;
    while (!logic.done && ticks < limit) {
      logic.tick();
      ticks++;
    }
    assert.ok(logic.done, `${g.id} should finish`);
    const s = logic.standings();
    assert.equal(s.length, n, g.id);
    for (const slot of [0, 1]) JSON.stringify(logic.view(slot));
  }
});

test('snake: a longer snake wins a head-on, equal lengths both die', () => {
  for (const [lenA, lenB, aLives, bLives] of [[6, 4, true, false], [4, 4, false, false]] as const) {
    const { logic } = start('snake', humans(2), { map: 'open' });
    type S = { body: number[]; dir: number; alive: boolean; queue: number[] };
    const g = inner<{ snakes: S[]; W: number; phase: string; t: number; items: Map<number, unknown> }>(logic);
    g.phase = 'play';
    g.items.clear();
    const y = 5;
    const at = (x: number) => y * g.W + x;
    // A heads right from x=10, B heads left from x=12: both reach x=11 together.
    g.snakes[0]!.body = Array.from({ length: lenA }, (_, k) => at(10 - k));
    g.snakes[0]!.dir = 1;
    g.snakes[1]!.body = Array.from({ length: lenB }, (_, k) => at(12 + k));
    g.snakes[1]!.dir = 3;
    g.t = 1; // next tick is a move tick
    logic.tick();
    assert.equal(g.snakes[0]!.alive, aLives, `A (${lenA}) vs B (${lenB})`);
    assert.equal(g.snakes[1]!.alive, bLives);
  }
});

test('snake: turning back on yourself is ignored, turns are buffered', () => {
  const { logic } = start('snake', humans(1), { map: 'open' });
  const g = inner<{ snakes: { dir: number; queue: number[] }[] }>(logic);
  const s = g.snakes[0]!;
  logic.input(0, { d: (s.dir + 1) % 4 });
  logic.input(0, { d: s.dir });
  assert.equal(s.queue.length, 2);
  logic.input(0, { d: 'nope' });
  logic.input(0, { d: 9 });
  assert.equal(s.queue.length, 2);
});

test('blast: bombs set each other off, crates break, a shield saves you once', () => {
  const { logic } = start('blast', humans(2));
  type P = { x: number; y: number; alive: boolean; shield: boolean; invuln: number };
  const g = inner<{
    players: P[];
    bombs: { x: number; y: number; fuse: number; owner: number; power: number }[];
    grid: Uint8Array;
    W: number;
    phase: string;
  }>(logic);
  g.phase = 'play';
  const W = g.W;
  for (let i = 0; i < g.grid.length; i++) if (g.grid[i] === 2) g.grid[i] = 0; // clear crates, keep walls
  g.grid[3 * W + 5] = 2; // one crate at (5,3)
  // A goes off now; B sits in A's blast, C in B's: one chain. C's arm hits the crate.
  g.bombs = [
    { x: 1, y: 1, fuse: 1, owner: 0, power: 2 },
    { x: 3, y: 1, fuse: 40, owner: 1, power: 2 },
    { x: 5, y: 1, fuse: 40, owner: 1, power: 2 },
  ];
  Object.assign(g.players[0]!, { x: 7, y: 9, alive: true, shield: false });
  Object.assign(g.players[1]!, { x: 5, y: 2, alive: true, shield: true, invuln: 0 });
  logic.tick();
  assert.equal(g.bombs.length, 0, 'all three bombs chained');
  assert.equal(g.grid[3 * W + 5], 0, 'crate destroyed');
  assert.equal(g.players[1]!.alive, true, 'shield absorbed the blast');
  assert.equal(g.players[1]!.shield, false);
});

test('blast: starting corners are dealt every round, not by seat', () => {
  type G = { players: { x: number; y: number }[]; W: number; H: number; newRound(): void };
  // Three players: every seat gets every corner over time, so nobody is always
  // the one starting between both rivals.
  const g3 = inner<G>(start('blast', humans(3), {}, 5).logic);
  const seen = [new Set<string>(), new Set<string>(), new Set<string>()];
  for (let r = 0; r < 60; r++) {
    g3.newRound();
    g3.players.forEach((p, k) => seen[k]!.add(`${p.x},${p.y}`));
  }
  for (const s of seen) assert.equal(s.size, 4, 'each seat starts in all four corners');
  // Two players always start in opposite corners.
  const g2 = inner<G>(start('blast', humans(2), {}, 5).logic);
  for (let r = 0; r < 20; r++) {
    g2.newRound();
    const [a, b] = g2.players;
    assert.equal(a!.x + b!.x, g2.W - 1);
    assert.equal(a!.y + b!.y, g2.H - 1);
  }
});

test('paddle: a ball past an open goal costs a life; a paddle sends it back', () => {
  const { logic } = start('paddle', humans(2));
  type Side = { pos: number; target: number; len: number; lives: number; alive: boolean };
  type Ball = { x: number; y: number; vx: number; vy: number; speed: number; last: number; wait: number };
  const g = inner<{ sides: Side[]; balls: Ball[]; phase: string; U: number }>(logic);
  g.phase = 'play';
  const L = g.sides[0]!;
  const lives = L.lives;
  // aimed well away from the left paddle
  L.pos = L.target = 4;
  g.balls = [{ x: 3, y: g.U - 8, vx: -0.8, vy: 0, speed: 0.8, last: -1, wait: 0 }];
  for (let i = 0; i < 10; i++) logic.tick();
  assert.equal(L.lives, lives - 1);
  // straight at the paddle
  L.pos = L.target = 10;
  g.balls = [{ x: 4, y: 10 + L.len / 2, vx: -0.8, vy: 0, speed: 0.8, last: -1, wait: 0 }];
  for (let i = 0; i < 4; i++) logic.tick();
  assert.equal(L.lives, lives - 1, 'no further life lost');
  assert.ok(g.balls[0]!.vx > 0, 'ball bounced back');
});

test('doodle: only the artist sees the word; guesses score; near-misses stay private', () => {
  const { logic } = start('doodle', humans(3), { hints: 'off' });
  const v0 = logic.view(0) as { dr: number; o: string[] };
  const artist = v0.dr;
  const [g1, g2] = [0, 1, 2].filter((s) => s !== artist) as [number, number];
  const choices = (logic.view(artist) as { o: string[] }).o;
  assert.equal(choices.length, 3);
  assert.deepEqual((logic.view(g1) as { o: string[] }).o, [], 'guessers do not see the choices');
  logic.input(g1, { a: 'pick', i: 0 }); // not the artist: ignored
  logic.input(artist, { a: 'pick', i: 0 });
  const word = (logic.view(artist) as { w: string }).w;
  assert.equal(word, choices[0]);
  const gv = logic.view(g1) as { w: string; h: string };
  assert.equal(gv.w, '', 'guessers never receive the word');
  assert.match(gv.h, /^[_ ]+$/, 'hint shows only blanks');
  assert.equal(gv.h.length, word.length);
  if (word.length >= 4) {
    logic.input(g1, { a: 'guess', t: word.slice(0, -1) });
    const mine = (logic.view(g1) as { log: [number, string, number][] }).log.filter((e) => e[2] === 2);
    const theirs = (logic.view(g2) as { log: [number, string, number][] }).log.filter((e) => e[2] === 2);
    assert.equal(mine.length, 1, 'the guesser hears it was close');
    assert.equal(theirs.length, 0, 'nobody else does');
  }
  logic.input(g2, { a: 'guess', t: word.toUpperCase() });
  const after = logic.view(g2) as { w: string; sc: number[][] };
  assert.equal(after.w, word, 'a solver may now see the word');
  assert.ok((after.sc.find((r) => r[0] === g2)?.[1] ?? 0) > 0);
  assert.ok((after.sc.find((r) => r[0] === artist)?.[1] ?? 0) > 0, 'the artist scores too');
  // a solver's chat is hidden from people still guessing
  logic.input(g2, { a: 'guess', t: `it is ${word}` });
  const stillGuessing = logic.view(g1) as { log: [number, string, number][] };
  assert.ok(!stillGuessing.log.some((e) => e[1].includes(word)), 'no leaks to people still guessing');
});

test('eights: you only ever see your own hand, and the rules hold', () => {
  const { logic } = start('eights', humans(3), { actions: 'on' });
  type V = { me: string[]; ok: number[]; turn: number; top: string; suit: string; pend: number };
  const g = inner<{ seats: { hand: string[] }[]; pending: number; suit: string; discard: string[] }>(logic);
  for (const slot of [0, 1, 2]) {
    const v = logic.view(slot) as V;
    assert.deepEqual(v.me, g.seats[slot]!.hand, 'own hand');
    const blob = JSON.stringify(v);
    for (const other of [0, 1, 2].filter((x) => x !== slot)) {
      for (const card of g.seats[other]!.hand) if (!g.seats[slot]!.hand.includes(card) && card !== v.top) assert.ok(!blob.includes(`"${card}"`), `seat ${slot} must not see ${card}`);
    }
  }
  const v = logic.view(0) as V;
  const mover = v.turn;
  const notMover = [0, 1, 2].find((x) => x !== mover)!;
  const before = g.seats[notMover]!.hand.length;
  logic.input(notMover, { a: 'draw' });
  assert.equal(g.seats[notMover]!.hand.length, before, 'out-of-turn input is ignored');
  // An eight needs a suit; with one it is always playable.
  g.seats[mover]!.hand.push('8h');
  logic.input(mover, { a: 'play', c: '8h' });
  assert.ok(g.seats[mover]!.hand.includes('8h'), 'eight without a suit is refused');
  logic.input(mover, { a: 'play', c: '8h', s: 'c' });
  assert.ok(!g.seats[mover]!.hand.includes('8h'));
  assert.equal(g.suit, 'c');
  // A two stacks a draw penalty on the next player.
  const next = (logic.view(0) as V).turn;
  g.suit = 'd';
  g.seats[next]!.hand.push('2d');
  logic.input(next, { a: 'play', c: '2d' });
  assert.equal(g.pending, 2);
  const victim = (logic.view(0) as V).turn;
  const vb = g.seats[victim]!.hand.filter((c) => c[0] !== '2');
  g.seats[victim]!.hand = vb;
  const n0 = vb.length;
  logic.input(victim, { a: 'draw' });
  assert.equal(g.seats[victim]!.hand.length, n0 + 2, 'took the two');
  assert.equal(g.pending, 0);
});
