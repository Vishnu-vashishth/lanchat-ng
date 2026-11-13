import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatNode } from '../src/core/node.js';
import { createIdentity } from '../src/crypto/identity.js';
import { TrustStore } from '../src/core/trust.js';
import { History } from '../src/core/history.js';
import type { Peer } from '../src/core/peer.js';
import type { ChatMsg, ReceiptMsg } from '../src/protocol/messages.js';

function makeNode(nick: string): ChatNode {
  const dir = join(tmpdir(), `lcng-test-${nick}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ChatNode({
    identity: createIdentity(),
    nick,
    port: 0, // ephemeral
    trust: new TrustStore(join(dir, 'trust.json')),
    history: new History(null), // memory only
    discovery: false,
    discoveryPort: 0,
    autoConnect: true,
  });
}

test('two nodes connect, exchange an encrypted chat, and ack delivery', async () => {
  const alice = makeNode('alice');
  const bob = makeNode('bob');
  await alice.start();
  await bob.start();

  try {
    const gotChat = once(alice, 'chat') as Promise<[Peer, ChatMsg]>;
    const gotReceipt = once(bob, 'receipt') as Promise<[Peer, ReceiptMsg]>;
    const bobSawAlice = once(bob, 'peer-connect');

    await bob.connect('127.0.0.1', alice.boundPort);
    await bobSawAlice; // bob now knows alice's rooms (shares default 'lobby')

    const sent = bob.sendChat('lobby', 'hi alice, this is encrypted');

    const [fromPeer, msg] = await gotChat;
    assert.equal(msg.body, 'hi alice, this is encrypted');
    assert.equal(msg.id, sent.id);
    assert.equal(fromPeer.nick, 'bob');

    const [, receipt] = await gotReceipt;
    assert.equal(receipt.kind, 'delivered');
    assert.deepEqual(receipt.ids, [sent.id]);
  } finally {
    alice.stop();
    bob.stop();
  }
});
