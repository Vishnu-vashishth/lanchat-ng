// Dev helper: drive the real chat UI on fake terminals and save HTML
// screenshots of the arcade, a lobby and every game mid-match.
// Usage: npx tsx scripts/screens.ts <outDir> [cols] [rows]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatNode } from '../src/core/node.js';
import { createIdentity } from '../src/crypto/identity.js';
import { TrustStore } from '../src/core/trust.js';
import { History } from '../src/core/history.js';
import { Tui } from '../src/ui/tui.js';
import { GAMES } from '../src/games/registry.js';
import { fakeTty, KEY, until, wait } from '../test/vt.js';

const out = process.argv[2] ?? '.';
const cols = Number(process.argv[3] ?? 120);
const rows = Number(process.argv[4] ?? 36);
const mk = (nick: string) => new ChatNode({ identity: createIdentity(), nick, port: 0, trust: new TrustStore(join(tmpdir(), `scr-${nick}-${Date.now()}.json`)), history: new History(null), discovery: false, discoveryPort: 0, autoConnect: true });
const alice = mk('alice'); const bob = mk('bob');
await alice.start(); await bob.start();
const ta = fakeTty(cols, rows), tb = fakeTty(cols, rows);
const ua = new Tui(alice, { quiet: true, notifyBody: false, color: true }, new History(null), 'x', { input: ta.input, output: ta.output });
const ub = new Tui(bob, { quiet: true, notifyBody: false, color: true }, new History(null), 'x', { input: tb.input, output: tb.output });
ua.banner(alice.fingerprint, alice.boundPort, { discovery: false, history: false });
ub.banner(bob.fingerprint, bob.boundPort, { discovery: false, history: false });
await bob.connect('127.0.0.1', alice.boundPort);
await until(() => bob.listPeers()[0]?.nick === 'alice');
const shot = (name: string, t = ta) => { writeFileSync(join(out, `${name}.html`), t.vt.html()); console.log('saved', name); };
tb.type('hey, anyone up for a game?\r');
await wait(150);
ta.type('/games\r');
await until(() => ta.vt.text().includes('START A NEW GAME'));
ta.type(KEY.down); await wait(60);
shot('arcade');
const ticks: Record<string, number> = { snake: 5200, blast: 6000, paddle: 5000, doodle: 1500, eights: 1500 };
for (const g of GAMES) {
  // host from the arcade: Esc to chat, then /play <id>
  ta.type(KEY.esc); await wait(650);
  ta.type(`/play ${g.id}\r`);
  await until(() => ta.vt.text().includes(g.title.toUpperCase()));
  await until(() => tb.vt.text().includes(`opened a ${g.title} table`));
  if (g.id === 'snake') shot('chat-invite', tb);
  tb.type('/play\r');
  await until(() => ta.vt.text().includes('PLAYERS 2/'));
  if (g.bots) { ta.type('b'); await wait(80); }
  if (g.id === 'snake') { await wait(100); shot('lobby'); }
  ta.type(KEY.enter);
  await wait(ticks[g.id]!);
  if (g.id === 'doodle') { tb.type('sun\r'); ta.type(KEY.enter); await wait(300); ta.type(' '); for (let i = 0; i < 12; i++) ta.type(KEY.right); for (let i = 0; i < 6; i++) ta.type(KEY.down); await wait(300); tb.type('pizza\r'); await wait(200); }
  if (g.id === 'eights') { ta.type(KEY.right); tb.type(KEY.right); await wait(200); }
  shot(`${g.id}-alice`); shot(`${g.id}-bob`, tb);
  // bob leaves, alice closes
  tb.type(KEY.esc); await wait(650); tb.type('y'); await wait(100); tb.type(KEY.esc); await wait(650);
  ta.type(KEY.esc); await wait(650); ta.type('y'); await wait(100);
  if (!ta.vt.text().includes('START A NEW GAME')) { console.log('alice not in arcade after', g.id); console.log(ta.vt.text()); }
}
ua.close(); ub.close(); alice.stop(); bob.stop();
process.exit(0);
