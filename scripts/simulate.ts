// Dev helper: play a whole match with bots only and print how it went.
// Usage: npx tsx scripts/simulate.ts <game> [players] [seed] [--set=key:value]
import { gameById } from '../src/games/registry.js';
import { makeRng } from '../src/games/rng.js';
import type { Player, Settings } from '../src/games/types.js';

const [kind = 'snake', nArg = '4', seedArg = '1'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const def = gameById(kind);
if (!def) throw new Error(`no game ${kind}`);
const settings: Settings = {};
for (const s of def.settings) settings[s.key] = s.choices[s.def ?? 0]!.v;
for (const a of process.argv) { const m = /^--set=(\w+):(.+)$/.exec(a); if (m) settings[m[1]!] = isNaN(Number(m[2])) ? m[2]! : Number(m[2]); }
const players: Player[] = Array.from({ length: Number(nArg) }, (_, i) => ({ slot: i, nick: `bot${i}`, bot: true }));
const feed: string[] = [];
const t0 = performance.now();
const logic = def.create({ players, settings, arena: { cols: 140, rows: 40 }, rng: makeRng(Number(seedArg)), feed: (t) => feed.push(t) });
let ticks = 0;
const maxTicks = (20 * 60 * 1000) / logic.tickMs; // 20 simulated minutes
while (!logic.done && ticks < maxTicks) { logic.tick(); ticks++; if (ticks % 7 === 0) JSON.stringify(logic.view(0)); }
const ms = performance.now() - t0;
console.log(`${kind}: done=${logic.done} after ${ticks} ticks = ${(ticks * logic.tickMs / 1000).toFixed(0)}s simulated in ${ms.toFixed(0)}ms`);
console.log('standings:', logic.standings().map((s) => `${s.nick}:${s.score} (${s.detail})`).join(' | '));
console.log('summary:', (logic.summary?.() ?? []).join(' | '));
console.log('feed (last 8):', feed.slice(-8).join(' | '));
console.log('view bytes:', JSON.stringify(logic.view(0)).length);
