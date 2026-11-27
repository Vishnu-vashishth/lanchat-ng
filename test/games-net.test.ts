import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatNode } from '../src/core/node.js';
import { createIdentity } from '../src/crypto/identity.js';
import { TrustStore } from '../src/core/trust.js';
import { History } from '../src/core/history.js';
import { GameHub } from '../src/games/hub.js';
import { until } from './vt.js';

// Tables over the real encrypted mesh, without any UI: invites only reach the
// room, every seat gets only its own cards, latecomers watch, a vanished
// player is dropped, and closing the table reaches everyone.

function makeNode(nick: string): ChatNode {
  const dir = join(tmpdir(), `lcng-net-${nick}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const size = { cols: 120, rows: 36 };

test('a card table over the mesh: private hands, spectators, drop-outs, closing', async () => {
  const nodes = ['alice', 'bob', 'carol', 'dave', 'eve'].map(makeNode);
  const [alice, bob, carol, dave, eve] = nodes as [ChatNode, ChatNode, ChatNode, ChatNode, ChatNode];
  for (const n of nodes) await n.start();
  const hubs = new Map(nodes.map((n) => [n, new GameHub(n)]));
  const hub = (n: ChatNode) => hubs.get(n)!;
  try {
    // eve is connected but sits in another room, so she must never hear of the table.
    eve.leave('lobby');
    eve.join('quiet');
    // Ephemeral test ports are not gossiped, so dial every pair directly.
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) await nodes[j]!.connect('127.0.0.1', nodes[i]!.boundPort);
    await until(() => nodes.every((n) => n.listPeers().length === 4), 6000, 'full mesh');
    await until(() => alice.listPeers().every((p) => p.nick !== '(unknown)'), 4000, 'hellos');

    const host = hub(alice).host('eights', 'lobby', size);
    assert.ok(host);
    const gid = host.gid;
    await until(() => [bob, carol, dave].every((n) => hub(n).ads.has(gid)), 4000, 'invites');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hub(eve).ads.size, 0, 'no invite outside the room');

    const bc = hub(bob).join(gid, size)!;
    const cc = hub(carol).join(gid, size)!;
    await until(() => hub(alice).hosted!.playerCount === 3, 4000, 'seated');
    assert.ok(hub(alice).hosted!.start());
    await until(() => !!bc.frame && !!cc.frame, 4000, 'first frames');

    // Each player holds exactly their own hand, and no one else's card codes.
    const game = (hub(alice).hosted as unknown as { logic: { seats: { slot: number; hand: string[] }[] } }).logic;
    const hands = new Map(game.seats.map((s) => [s.slot, s.hand]));
    for (const c of [bc, cc]) {
      const f = c.frame as { me: string[] };
      const me = c.table!.you!;
      assert.deepEqual(f.me, hands.get(me));
      const blob = JSON.stringify(f);
      for (const [slot, hand] of hands) if (slot !== me) for (const card of hand) assert.ok(!blob.includes(`"${card}"`), `seat ${me} saw ${card}`);
    }

    // Dave walks up mid-game: he watches, with no hand.
    const dc = hub(dave).join(gid, size)!;
    await until(() => !!dc.table && !!dc.frame, 4000, 'spectator frames');
    assert.equal(dc.table!.spec, true);
    assert.deepEqual((dc.frame as { me: string[] }).me, []);

    // Carol's machine drops off the network: the table goes on without her.
    carol.stop();
    await until(() => hub(alice).hosted!.playerCount === 2, 6000, 'carol dropped');
    assert.equal(hub(alice).hosted!.phase, 'playing');

    // Inputs from someone who is not seated are ignored; the host closes the table.
    hub(alice).leave();
    await until(() => !!bc.closed && !!dc.closed, 4000, 'closed for everyone');
    await until(() => !hub(bob).ads.has(gid), 4000, 'ad withdrawn');
  } finally {
    for (const h of hubs.values()) h.stop();
    for (const n of nodes) n.stop();
  }
});
