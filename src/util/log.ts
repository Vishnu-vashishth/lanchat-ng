// Minimal debug logger. Writes to stderr only when LCNG_DEBUG=1 so it never
// clutters the chat UI (which lives on stdout).
const enabled = process.env.LCNG_DEBUG === '1';

export function debug(...parts: unknown[]): void {
  if (!enabled) return;
  process.stderr.write('[debug] ' + parts.map((p) => String(p)).join(' ') + '\n');
}
