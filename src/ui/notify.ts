import { spawn } from 'node:child_process';
import os from 'node:os';

// Best-effort desktop notifications by shelling out to the platform's native
// tool. No third-party dependency (smaller trust surface for a privacy tool),
// and failures are swallowed — a missing notifier must never crash the chat.
export function notify(title: string, body: string): void {
  try {
    const platform = os.platform();
    if (platform === 'linux') {
      spawn('notify-send', ['--app-name=lanchat-ng', title, body], { stdio: 'ignore' }).on('error', () => {});
    } else if (platform === 'darwin') {
      const script = `display notification ${q(body)} with title ${q(title)}`;
      spawn('osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => {});
    } else if (platform === 'win32') {
      const cmd = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;` +
        `$n.Visible=$true;$n.ShowBalloonTip(5000, ${q(title)}, ${q(body)}, 'Info')`;
      spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }).on('error', () => {});
    }
  } catch {
    /* notifications are optional */
  }
}

// Quote for AppleScript / PowerShell string literals.
function q(s: string): string {
  return '"' + s.replace(/["\\]/g, '\\$&') + '"';
}
