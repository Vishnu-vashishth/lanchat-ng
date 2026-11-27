import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatNode } from '../src/core/node.js';
import { createIdentity } from '../src/crypto/identity.js';
import { TrustStore } from '../src/core/trust.js';
import { History } from '../src/core/history.js';
import { Tui } from '../src/ui/tui.js';
import { GameHub } from '../src/games/hub.js';
import { TableHost } from '../src/games/host.js';
import { Canvas } from '../src/games/term/canvas.js';
import { gameById } from '../src/games/registry.js';
import { makeRng } from '../src/games/rng.js';
import type { GameDef, Settings } from '../src/games/types.js';
import type { GameMsg } from '../src/games/proto.js';
import { fakeTty, KEY, until, wait } from './vt.js';

// Regressions for bugs found in review: hostile frames, a lone survivor, seats
// for latecomers, the suit picker, stale invites, and the arcade highlight.

function makeNode(nick: string): ChatNode {
  const dir = join(tmpdir(), `lcng-reg-${nick}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ChatNode({
    identity: createIdentity(),
    nick,
    port: 0,
    trust: new TrustStore(join(dir, 'trust.json')),
    history: new History(null),
    discovery: false,
    discoveryPort: 0,
    autoConnect: true,
  });
}

function makeUi(node: ChatNode, tty: ReturnType<typeof fakeTty>): Tui {
  const ui = new Tui(node, { quiet: true, notifyBody: false, color: true }, new History(null), join(tmpdir(), 'unused'), { input: tty.input, output: tty.output });
  ui.banner(node.fingerprint, node.boundPort, { discovery: false, history: false });
  return ui;
}

async function pair(): Promise<{ alice: ChatNode; bob: ChatNode; ta: ReturnType<typeof fakeTty>; tb: ReturnType<typeof fakeTty>; ua: Tui; ub: Tui; done: () => void }> {
  const alice = makeNode('alice');
  const bob = makeNode('bob');
  await alice.start();
  await bob.start();
  const ta = fakeTty(120, 36);
  const tb = fakeTty(120, 36);
  const ua = makeUi(alice, ta);
  const ub = makeUi(bob, tb);
  await bob.connect('127.0.0.1', alice.boundPort);
  await until(() => bob.listPeers()[0]?.nick === 'alice' && alice.listPeers()[0]?.nick === 'bob', 4000, 'hello');
  return { alice, bob, ta, tb, ua, ub, done: () => { ua.close(); ub.close(); alice.stop(); bob.stop(); } };
}

test('a hostile host cannot crash or freeze a player with malformed frames', async () => {
  const { ta, tb, ub, done } = await pair();
  try {
    ta.type('/play eights\r');
    await until(() => tb.vt.text().includes('opened a Crazy Eights table'), 4000, 'invite');
    tb.type('/play\r');
    await until(() => ta.vt.text().includes('PLAYERS 2/6'), 4000, 'seated');
    ta.type(KEY.enter);
    await until(() => !!ub.games.client?.frame, 4000, 'playing');
    const c = ub.games.client!;
    const forge = (d: unknown) => {
      c.receive({ t: 'game', room: c.room, gid: c.gid, op: 'frame', d } as GameMsg);
      ub.games.emit('change');
    };
    const good = c.frame as Record<string, unknown>;
    forge({ ...good, log: [42, null, { x: 1 }] }); // non-string log lines
    await wait(80);
    forge({ ...good, seats: [[0, 1e9, -5, 0]], me: ['xx'], top: 'zz' }); // nonsense numbers
    await wait(80);
    forge({ bogus: true }); // not a view at all
    await wait(80);
    assert.ok(tb.vt.altActive, 'still in the game screen, process alive');
    forge(good);
    await until(() => tb.vt.text().includes('CRAZY EIGHTS'), 2000, 'recovers on the next good frame');
  } finally {
    done();
  }
});

test('paddle frames with absurd paddle sizes draw instantly', () => {
  const def = gameById('paddle')!;
  const client = def.client();
  const frame = { W: 60, H: 22, s: [[0, 0, 4, 1e15, 3, 1, 0, 0, 0], [2, 1, -1e9, 4e8, 3, 1, 0, 0, 0]], b: [[300, 200, 0]], o: null, ph: 'play', cd: 0, L: 5, m: '' };
  const players = [{ slot: 0, nick: 'a', bot: false }, { slot: 1, nick: 'b', bot: false }];
  const t0 = Date.now();
  client.draw(new Canvas(60, 22), frame, { me: 0, players, nick: () => 'x', color: true, now: 0 });
  assert.ok(Date.now() - t0 < 200, 'no runaway loop');
});

function startLogic(id: string, n: number, bots: boolean, settings: Settings = {}) {
  const def = gameById(id) as GameDef;
  const st: Settings = {};
  for (const s of def.settings) st[s.key] = s.choices[s.def ?? 0]!.v;
  Object.assign(st, settings);
  const players = Array.from({ length: n }, (_, i) => ({ slot: i, nick: `p${i}`, bot: bots }));
  return def.create({ players, settings: st, arena: { cols: 120, rows: 36 }, rng: makeRng(3), feed: () => undefined });
}

test('when everyone else leaves, the last player wins and the match ends', () => {
  for (const id of ['blast', 'snake', 'paddle', 'eights']) {
    const logic = startLogic(id, 2, false);
    for (let i = 0; i < 80; i++) logic.tick(); // past the countdown
    logic.drop(1);
    let ticks = 0;
    while (!logic.done && ticks < (60 * 1000) / logic.tickMs) {
      logic.tick();
      ticks++;
    }
    assert.ok(logic.done, `${id} ends`);
    assert.equal(logic.standings()[0]!.slot, 0, `${id}: the one who stayed ranks first`);
  }
});

test('a latecomer gets a seat in a party game even after someone left', () => {
  const sent: { id: string; m: GameMsg }[] = [];
  const host = new TableHost(gameById('doodle')!, 'lobby', { selfId: 'host', send: (id, m) => sent.push({ id, m }), local: () => undefined, advertise: () => undefined }, 'host', { cols: 120, rows: 36 });
  host.join('bob', 'bob', { cols: 120, rows: 36 });
  host.join('carol', 'carol', { cols: 120, rows: 36 });
  assert.ok(host.start());
  host.leave('bob'); // bob's seat is still on the scoreboard
  host.join('eve', 'eve', { cols: 120, rows: 36 });
  const eves = sent.filter((x) => x.id === 'eve' && x.m.op === 'table').map((x) => x.m.d as { you: number | null; spec: boolean });
  const last = eves[eves.length - 1]!;
  assert.equal(last.spec, false, 'eve plays, she is not stuck watching');
  assert.notEqual(last.you, null);
  host.close('done');
});

test('eights: Esc closes the suit picker and the picker never outlives the turn', () => {
  const client = gameById('eights')!.client();
  const ctx = { me: 0, players: [{ slot: 0, nick: 'a', bot: false }, { slot: 1, nick: 'b', bot: false }], nick: () => 'x', color: true, now: 0 };
  const frame = { me: ['8h', '3c'], ok: [0], top: '3s', suit: 's', turn: 0, dir: 1, pend: 0, drew: 0, pile: 30, seats: [[0, 2, 0, 0], [1, 7, 0, 0]], t: 20, ph: 'play', hand: 1, H: 3, log: [], msg: '', act: 1 };
  const k = (name: string) => ({ name, ch: '', ctrl: false, meta: false, shift: false });
  assert.equal(client.key(k('enter'), frame, ctx), null, 'Enter on an eight opens the picker');
  assert.match(client.help(frame, ctx), /suit/);
  assert.equal(client.key(k('escape'), frame, ctx), null, 'Esc is handled by the picker');
  assert.doesNotMatch(client.help(frame, ctx), /suit/);
  client.key(k('enter'), frame, ctx);
  client.draw(new Canvas(92, 24), { ...frame, turn: 1 }, ctx); // turn passed (e.g. timed out)
  assert.doesNotMatch(client.help(frame, ctx), /suit/, 'picker dropped once it is not our move');
});

test('leaving a room forgets its tables; joining a vanished table fails fast', async () => {
  const alice = makeNode('alice');
  const bob = makeNode('bob');
  await alice.start();
  await bob.start();
  const ha = new GameHub(alice);
  const hb = new GameHub(bob);
  try {
    await bob.connect('127.0.0.1', alice.boundPort);
    await until(() => alice.listPeers()[0]?.nick === 'bob' && bob.listPeers()[0]?.nick === 'alice', 4000, 'hello');
    ha.host('snake', 'lobby', { cols: 120, rows: 36 });
    await until(() => hb.tables().length === 1, 4000, 'ad');
    const gid = hb.tables()[0]!.gid;
    bob.leave('lobby');
    assert.equal(hb.tables().length, 0);
    ha.leave();
    bob.join('lobby');
    await wait(200);
    assert.equal(hb.tables().length, 0, 'no stale invite after coming back');
    // A join for a table that is gone gets an immediate answer.
    hb.ads.set(gid, { gid, room: 'lobby', hostId: alice.fingerprint, seen: Date.now(), kind: 'snake', title: 'Snake Arena', host: 'alice', n: 1, max: 8, phase: 'lobby' });
    const c = hb.join(gid, { cols: 120, rows: 36 })!;
    await until(() => !!c.closed, 3000, 'closed reply');
    assert.match(c.closed!, /gone/);
  } finally {
    ha.stop();
    hb.stop();
    alice.stop();
    bob.stop();
  }
});

test('the arcade highlight stays on its game when a new table appears', async () => {
  const { ta, tb, ua, done } = await pair();
  try {
    ta.type('/games\r');
    await until(() => ta.vt.text().includes('START A NEW GAME'), 2000, 'arcade');
    ta.type(KEY.down); // Snake -> Blast
    await until(() => ta.vt.lines().some((l) => l.includes('▶ Blast Yard')), 2000, 'blast highlighted');
    tb.type('/play snake\r'); // bob's table pushes a new entry onto the top of the list
    await until(() => ua.games.tables().length === 1 && ta.vt.text().includes('OPEN TABLES') && ta.vt.text().includes('Snake Arena · bob'), 4000, 'ad listed');
    ta.type(KEY.enter);
    await until(() => ta.vt.text().includes('BLAST YARD'), 2000, 'hosted Blast, not joined Snake');
    assert.equal(ua.games.hosted?.def.id, 'blast');
  } finally {
    done();
  }
});
