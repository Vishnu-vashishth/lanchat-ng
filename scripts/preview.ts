// Dev helper: render game frames to plain text (or HTML with colors) without
// a terminal. Usage: npx tsx scripts/preview.ts <game> [ticks] [cols] [rows] [--html out.html]
import { writeFileSync } from 'node:fs';
import { Canvas } from '../src/games/term/canvas.js';
import { gameById } from '../src/games/registry.js';
import { makeRng } from '../src/games/rng.js';
import type { Player, Settings } from '../src/games/types.js';

const [kind = 'snake', ticksArg = '60', colsArg = '120', rowsArg = '34'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const htmlIdx = process.argv.indexOf('--html');
const def = gameById(kind);
if (!def) throw new Error(`no game ${kind}`);
const settings: Settings = {};
for (const s of def.settings) settings[s.key] = s.choices[s.def ?? 0]!.v;
for (const a of process.argv) { const m = /^--set=(\w+):(.+)$/.exec(a); if (m) settings[m[1]!] = isNaN(Number(m[2])) ? m[2]! : Number(m[2]); }
const n = Number(process.env.PLAYERS ?? 4);
const players: Player[] = Array.from({ length: n }, (_, i) => ({ slot: i, nick: ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hal'][i]!, bot: i > 0 }));
const cols = Number(colsArg), rows = Number(rowsArg);
const feed: string[] = [];
const logic = def.create({ players, settings, arena: { cols, rows }, rng: makeRng(Number(process.env.SEED ?? 7)), feed: (t) => feed.push(t) });
for (let i = 0; i < Number(ticksArg) && !logic.done; i++) logic.tick();
const frame = JSON.parse(JSON.stringify(logic.view(0)));
const client = def.client();
const ctx = { me: 0, players, nick: (s: number) => players.find((p) => p.slot === s)?.nick ?? '?', color: true, now: Date.now() };
const m = client.measure(frame, cols, rows - 2);
console.log('measure', m, 'status:', client.status?.(frame, ctx), '| done', logic.done);
if (!m) process.exit(0);
const c = new Canvas(m.w, m.h);
client.draw(c, frame, ctx);
console.log(c.lines().join('\n'));
console.log('scoreboard:', (client.scoreboard?.(frame, ctx) ?? []).map((l) => l.text).join(' | '));
console.log('feed:', feed.slice(-6).join(' | '));
if (htmlIdx > 0) {
  const PAL = ['#000','#c00','#0a0','#c80','#00c','#c0c','#0aa','#ccc','#666','#f44','#4f4','#ff4','#66f','#f4f','#4ff','#fff'];
  let html = '<pre style="background:#111;color:#ccc;font:14px/1.15 Consolas,monospace;padding:8px">';
  for (let y = 0; y < c.h; y++) { for (let x = 0; x < c.w; x++) { const i = y * c.w + x; const fg = c.fg[i]!, bg = c.bg[i]!; const ch = c.ch[i]!.replace('&','&amp;').replace('<','&lt;'); html += `<span style="color:${fg >= 0 ? PAL[fg] : '#ccc'};${bg >= 0 ? 'background:' + PAL[bg] : ''}">${ch}</span>`; } html += '\n'; }
  writeFileSync(process.argv[htmlIdx + 1]!, html + '</pre>');
}
