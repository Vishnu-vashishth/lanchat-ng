import os from 'node:os';

export function isWindows(): boolean {
  return os.platform() === 'win32';
}

// Honor the standard NO_COLOR env var; on Windows assume legacy cmd.exe lacks
// ANSI/VT support unless a modern terminal (Windows Terminal, ConEmu, ...) is
// detected via its environment marker.
export function ansiSupported(): boolean {
  if (process.env.NO_COLOR) return false;
  if (isWindows()) {
    return !!(
      process.env.WT_SESSION ||   // Windows Terminal
      process.env.ConEmuANSI ||   // ConEmu
      process.env.TERM ||         // MSYS / Git Bash / WSL-ish
      process.env.ANSI_CONSOLE
    );
  }
  return true;
}

export function windowsDataDir(): string | undefined {
  if (!isWindows()) return undefined;
  return process.env.APPDATA || undefined;
}
