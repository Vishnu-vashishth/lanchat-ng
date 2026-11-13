#!/usr/bin/env node
import { parseArgs, paths } from './config.js';
import { loadOrCreateIdentity } from './crypto/identity.js';
import { TrustStore } from './core/trust.js';
import { History } from './core/history.js';
import { ChatNode } from './core/node.js';
import { Tui } from './ui/tui.js';

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const p = paths(opts.dataDir);

  const identity = loadOrCreateIdentity(p.identity);
  const trust = new TrustStore(p.trust);
  const history = new History(opts.history ? p.history : null);

  const node = new ChatNode({
    identity,
    nick: opts.nick,
    port: opts.port,
    trust,
    history,
    discovery: opts.discovery,
    discoveryPort: opts.discoveryPort,
    autoConnect: opts.autoConnect,
  });

  try {
    await node.start();
  } catch (err) {
    process.stderr.write(`failed to start on port ${opts.port}: ${String(err)}\n`);
    process.exit(1);
  }

  const tui = new Tui(node, { quiet: opts.quiet, notifyBody: opts.notifyBody }, history, p.history);
  tui.banner(identity.fingerprint, opts.port, { discovery: opts.discovery, history: opts.history });

  for (const c of opts.connect) void node.connect(c.host, c.port);

  const shutdown = () => {
    tui.close();
    node.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
