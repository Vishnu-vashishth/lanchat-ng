import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// Boot the real CLI end-to-end (parse args -> start node -> build the TUI) and
// make sure it reaches the banner without throwing. This guards the whole
// startup path, including readline/TUI wiring that unit tests can't reach — e.g.
// a call to a readline method that doesn't exist would crash here, not silently.
test('CLI boots to the banner and quits cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lchat-smoke-'));
  // Random high port so the test never collides with a real instance on 4040.
  const port = 40000 + Math.floor(Math.random() * 20000);

  try {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        ENTRY,
        '--nick',
        'smoke',
        '--room',
        'smoke-room',
        '--pass',
        'secret',
        '--port',
        String(port),
        '--no-discovery',
        '--no-color',
        '--data-dir',
        dataDir,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      // Once the banner prints, we know startup succeeded — ask it to quit.
      if (out.includes('type /help for commands')) child.stdin.write('/quit\n');
    });
    child.stderr.on('data', (d: string) => {
      err += d;
    });

    const exitCode: number | null = await new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('close', (code) => {
        clearTimeout(kill);
        resolve(code);
      });
    });

    const combined = out + err;
    assert.equal(err, '', `CLI wrote to stderr:\n${err}`);
    assert.match(out, /lanchat-ng — encrypted LAN chat/, `missing banner. got:\n${combined}`);
    assert.doesNotMatch(combined, /TypeError|is not a function|setCompleter/, `startup threw:\n${combined}`);
    assert.equal(exitCode, 0, `expected clean exit, got ${exitCode}. output:\n${combined}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
