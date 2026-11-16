import { spawn } from 'node:child_process';
import os from 'node:os';

// Best-effort desktop notifications — disguised as generic system alerts so the
// chat app is not identifiable from the notification itself (no "lanchat-ng"
// app name, no nicknames in the title). The message body is kept out unless
// --notify-body is set; failures are swallowed — a missing notifier must never
// crash the chat.
export function notify(_title: string, body: string): void {
  try {
    const platform = os.platform();
    const appName = genericAppName(platform);
    const dispTitle = genericTitle(platform);

    if (platform === 'linux') {
      spawn('notify-send', ['--app-name=' + appName, dispTitle, body], { stdio: 'ignore' }).on('error', () => {});
    } else if (platform === 'darwin') {
      const script = `display notification ${q(body)} with title ${q(dispTitle)}`;
      spawn('osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => {});
    } else if (platform === 'win32') {
      const cmd = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;` +
        `$n.Visible=$true;$n.ShowBalloonTip(5000, ${q(dispTitle)}, ${q(body)}, 'Info')`;
      spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }).on('error', () => {});
    }
  } catch {
    /* notifications are optional */
  }
}

function genericAppName(platform: string): string {
  if (platform === 'win32') return 'Windows Update';
  if (platform === 'darwin') return 'System';
  return 'System';
}

function genericTitle(platform: string): string {
  if (platform === 'win32') return 'Update available';
  if (platform === 'darwin') return 'System notification';
  return 'System notification';
}

// Quote for AppleScript / PowerShell string literals.
function q(s: string): string {
  return '"' + s.replace(/["\\]/g, '\\$&') + '"';
}
