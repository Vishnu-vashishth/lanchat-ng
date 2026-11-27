import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatNode } from '../src/core/node.js';
import { createIdentity } from '../src/crypto/identity.js';
import { TrustStore } from '../src/core/trust.js';
import { History } from '../src/core/history.js';
import { Tui } from '../src/ui/tui.js';
import { fakeTty, KEY, until as untilRaw, wait } from './vt.js';

// On a timeout, show both screens: the failure is usually obvious from them.
const screens: [string, ReturnType<typeof fakeTty>][] = [];
async function until(fn: () => unknown, ms?: number, what?: string): Promise<void> {
  try {
    await untilRaw(fn, ms, what);
  } catch (err) {
    for (const [name, t] of screens) console.log(`---- ${name}'s screen ----\n${t.vt.text()}`);
    throw err;
  }
}

// End to end through the real chat UI: two people on two encrypted nodes,
// each with their own (fake) terminal. One hosts a game from the chat prompt,
// the other gets the invite in chat, joins, plays, trash-talks from inside the
// game, leaves, and lands back at a working chat prompt.

function makeNode(nick: string): ChatNode {
  const dir = join(tmpdir(), `lcng-e2e-${nick}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const ui = new Tui(node, { quiet: true, notifyBody: false, color: true }, new History(null), join(tmpdir(), 'unused-history'), {
    input: tty.input,
    output: tty.output,
  });
  ui.banner(node.fingerprint, node.boundPort, { discovery: false, history: false });
  return ui;
}

test('host a game from chat, invite arrives, join, play, chat in-game, leave back to chat', async () => {
  const alice = makeNode('alice');
  const bob = makeNode('bob');
  await alice.start();
  await bob.start();
  const ta = fakeTty(120, 36);
  const tb = fakeTty(120, 36);
  const ua = makeUi(alice, ta);
  const ub = makeUi(bob, tb);
  screens.length = 0;
  screens.push(['alice', ta], ['bob', tb]);
  try {
    const met = once(alice, 'peer-connect');
    await bob.connect('127.0.0.1', alice.boundPort);
    await met;
    await until(() => bob.listPeers()[0]?.nick === 'alice', 4000, 'hello exchange');

    // Alice hosts straight from the chat prompt.
    ta.type('/play snake\r');
    await until(() => ta.vt.altActive && ta.vt.text().includes('SNAKE ARENA'), 4000, 'alice in her lobby');

    // Bob is still chatting; the invite shows up in his chat scrollback.
    await until(() => tb.vt.text().includes('opened a Snake Arena table'), 4000, 'invite in bob chat');
    assert.equal(tb.vt.altActive, false);
    tb.type('/play\r');
    await until(() => tb.vt.altActive && tb.vt.text().includes('PLAYERS 2/8'), 4000, 'bob seated');
    await until(() => ta.vt.text().includes('PLAYERS 2/8'), 4000, 'alice sees bob');

    // Host adds a bot and starts the match.
    ta.type('b');
    await until(() => ta.vt.text().includes('PLAYERS 3/8'), 4000, 'bot added');
    ta.type(KEY.enter);
    await until(() => tb.vt.text().includes('SCORES') && tb.vt.text().includes('round 1/3'), 4000, 'match on bob screen');
    await until(() => ta.vt.text().includes('SCORES'), 4000, 'match on alice screen');

    // Steering is accepted (no crash), and chat works from inside the game.
    tb.type(KEY.up);
    tb.type(KEY.left);
    tb.type('t');
    await until(() => tb.vt.text().includes('say ›'), 2000, 'chat line opens');
    tb.type('gg ez\r');
    await until(() => ta.vt.text().includes('gg ez'), 4000, 'in-game chat reaches alice');

    // The match keeps ticking: frames change over time on bob's screen
    // (the countdown alone changes digit every second).
    const before = tb.vt.text();
    await wait(1200);
    assert.notEqual(tb.vt.text(), before, 'board should animate');

    // Bob leaves the table (Esc, confirm) and then the arcade (Esc).
    tb.type(KEY.esc);
    await until(() => tb.vt.text().includes('Leave this table?'), 2000, 'leave dialog');
    tb.type('y');
    await until(() => tb.vt.text().includes('START A NEW GAME'), 2000, 'bob back in arcade');
    await until(() => ta.vt.text().includes('bob left'), 4000, 'alice notified');
    tb.type(KEY.esc);
    await until(() => !tb.vt.altActive, 2000, 'bob back to chat');
    await until(() => tb.vt.text().includes('back to chat'), 2000, 'chat restored');

    // The chat prompt works again after the game.
    tb.type('still here\r');
    await until(() => ta.vt.text().includes('still here') || ua.games.client !== null, 4000, 'chat after game');

    // Alice closes her table; she is back in the arcade, the ad disappears for bob.
    ta.type(KEY.esc);
    await until(() => ta.vt.text().includes('End the match?'), 2000, 'host dialog');
    ta.type('y');
    await until(() => ta.vt.text().includes('START A NEW GAME'), 2000, 'alice in arcade');
    await until(() => ub.games.tables().length === 0, 4000, 'ad withdrawn');
  } finally {
    ua.close();
    ub.close();
    alice.stop();
    bob.stop();
  }
});

test('panic key blanks the game, resize redraws, a vanished host is reported', async () => {
  const alice = makeNode('alice');
  const bob = makeNode('bob');
  await alice.start();
  await bob.start();
  const ta = fakeTty(120, 36);
  const tb = fakeTty(120, 36);
  const ua = makeUi(alice, ta);
  const ub = makeUi(bob, tb);
  screens.length = 0;
  screens.push(['alice', ta], ['bob', tb]);
  try {
    await bob.connect('127.0.0.1', alice.boundPort);
    await until(() => bob.listPeers()[0]?.nick === 'alice' && alice.listPeers()[0]?.nick === 'bob', 4000, 'hello exchange');
    ta.type('/play eights\r');
    await until(() => tb.vt.text().includes('opened a Crazy Eights table'), 4000, 'invite');
    tb.type('/play\r');
    await until(() => ta.vt.text().includes('PLAYERS 2/6'), 4000, 'seated');
    ta.type(KEY.enter);
    await until(() => tb.vt.text().includes('CRAZY EIGHTS') && /card/.test(tb.vt.text()), 4000, 'dealt');

    // Ctrl+X blanks the screen at once; nothing is drawn while hidden; again restores.
    tb.type('\x18');
    await wait(100);
    assert.equal(tb.vt.text().trim(), '', 'screen is blank');
    tb.type(KEY.right);
    await wait(300);
    assert.equal(tb.vt.text().trim(), '', 'still blank, keys ignored');
    tb.type('\x18');
    await until(() => tb.vt.text().includes('CRAZY EIGHTS'), 2000, 'restored');

    // A smaller terminal: the screen redraws to fit without losing the game.
    tb.resize(90, 28);
    await until(() => tb.vt.lines().length <= 28 && tb.vt.text().includes('CRAZY EIGHTS'), 2000, 'redrawn at 90x28');

    // The host's machine vanishes without a goodbye: only the connection drops
    // (closing alice's app first would send "the host closed the table" instead,
    // and which notice wins would then depend on the OS). Bob is told the host
    // disconnected, and gets back to the arcade.
    alice.stop();
    await until(() => tb.vt.text().includes('TABLE CLOSED') && tb.vt.text().includes('disconnected'), 6000, 'host gone notice');
    tb.type('x');
    await until(() => tb.vt.text().includes('START A NEW GAME'), 2000, 'back to arcade');
  } finally {
    ua.close();
    ub.close();
    alice.stop();
    bob.stop();
  }
});
