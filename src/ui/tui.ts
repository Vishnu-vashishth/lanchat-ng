import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import type { ChatNode } from '../core/node.js';
import type { Peer } from '../core/peer.js';
import type { ChatMsg, ReceiptMsg } from '../protocol/messages.js';
import type { History } from '../core/history.js';
import { notify } from './notify.js';
import { group } from '../util/base32.js';
import { asciiEmoji, COMBOS } from '../util/emoji.js';
import { ansiSupported } from '../util/platform.js';

const ANS = ansiSupported();

export interface UiOptions {
  quiet: boolean;
  notifyBody: boolean;
  color: boolean;
}

export class Tui {
  private readonly rl: readline.Interface;
  private room = 'lobby';
  private hidden = false;
  private readonly buffered: string[] = [];
  private readonly colorEnabled: boolean;
  private readonly DIM: string;
  private readonly CYAN: string;
  private readonly YELLOW: string;
  private readonly GREEN: string;
  private readonly RESET: string;
  private readonly CLEAR_SCREEN: string;
  private typingTimer: NodeJS.Timeout | undefined;
  private lastNotify = 0;
  private readonly NOTIFY_THROTTLE_MS = 5000;

  constructor(
    private readonly node: ChatNode,
    private readonly opts: UiOptions,
    private readonly history: History,
    private readonly historyPath: string,
  ) {
    this.colorEnabled = opts.color && ANS;
    const c = (code: string) => (this.colorEnabled ? code : '');
    this.DIM = c('\x1b[2m');
    this.CYAN = c('\x1b[36m');
    this.YELLOW = c('\x1b[33m');
    this.GREEN = c('\x1b[32m');
    this.RESET = c('\x1b[0m');
    this.CLEAR_SCREEN = this.colorEnabled ? '\x1b[2J\x1b[3J\x1b[H' : '\n'.repeat(40);

    this.rl = readline.createInterface({ input, output, prompt: this.prompt() });
    this.setupCompletion();
    this.setupKeys();
    this.rl.on('line', (raw) => this.onLine(raw));
    this.rl.on('SIGINT', () => {
      this.sys('type /quit to exit');
      this.rl.prompt();
    });
    this.wire();
  }

  // ---- rendering ----

  private prompt(): string {
    return `${this.CYAN}#${this.room}${this.RESET}> `;
  }

  private print(line: string): void {
    if (this.hidden) {
      this.buffered.push(line);
      return;
    }
    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(line + '\n');
    this.rl.prompt(true);
  }

  private sys(text: string): void {
    this.print(`${this.DIM}* ${text}${this.RESET}`);
  }

  private static time(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  private chatLine(room: string, nick: string, body: string, ts: number, self: boolean): string {
    const who = self ? `${this.GREEN}${nick}${this.RESET}` : `${this.YELLOW}${nick}${this.RESET}`;
    const where = room === this.room ? '' : `${this.DIM}#${room}${this.RESET} `;
    return `${this.DIM}[${Tui.time(ts)}]${this.RESET} ${where}<${who}> ${asciiEmoji(body)}`;
  }

  banner(fingerprint: string, port: number, opts: { discovery: boolean; history: boolean }): void {
    output.write(`${this.CYAN}lanchat-ng${this.RESET} — encrypted LAN chat\n`);
    output.write(`${this.DIM}listening on tcp/${port}  ·  discovery ${opts.discovery ? 'ON' : 'off'}  ·  history ${opts.history ? 'ON (disk)' : 'off (memory only)'}${this.RESET}\n`);
    output.write(`${this.DIM}your nick:${this.RESET} ${this.node.nick}\n`);
    output.write(`${this.DIM}your fingerprint (share to verify first contact):${this.RESET}\n  ${this.GREEN}${group(fingerprint)}${this.RESET}\n`);
    output.write(`${this.DIM}type /help for commands. Ctrl+X (or F2) hides the screen.${this.RESET}\n\n`);
    this.rl.setPrompt(this.prompt());
    this.rl.prompt();
  }

  // ---- node events ----

  private wire(): void {
    this.node.on('peer-connect', (peer: Peer) => {
      this.sys(`${peer.nick} connected ${this.DIM}(${peer.fp.slice(0, 12)}…)${this.RESET}`);
      if (peer.firstSeen) {
        this.sys(`${this.YELLOW}first contact${this.RESET} with ${peer.nick} — verify fingerprint:`);
        this.sys(`  ${group(peer.fp)}`);
      }
    });
    this.node.on('peer-disconnect', (peer: Peer) => {
      this.sys(`${peer.nick} disconnected`);
    });
    this.node.on('chat', (peer: Peer, msg: ChatMsg) => {
      this.print(this.chatLine(msg.room, peer.nick, msg.body, msg.ts, false));
      const focused = msg.room === this.room && !this.hidden;
      if (!this.opts.quiet && !this.hidden) {
        const now = Date.now();
        if (now - this.lastNotify > this.NOTIFY_THROTTLE_MS) {
          this.lastNotify = now;
          notify('New message', '', { revealBody: this.opts.notifyBody });
        }
      }
      if (focused) this.node.sendRead(msg.room, [msg.id]); // we're looking at it
    });
    this.node.on('typing', (peer: Peer, room: string, on: boolean) => {
      if (on && room === this.room) this.sys(`${peer.nick} is typing…`);
    });
    this.node.on('mention', (peer: Peer, from: Peer, body: string) => {
      const short = body.length > 40 ? body.slice(0, 40) + '…' : body;
      this.sys(`${this.YELLOW}@mention${this.RESET} from ${peer.nick}: ${short}`);
      if (!this.opts.quiet && !this.hidden) {
        const now = Date.now();
        if (now - this.lastNotify > this.NOTIFY_THROTTLE_MS) {
          this.lastNotify = now;
          notify(`Mention from ${peer.nick}`, short, { revealBody: this.opts.notifyBody });
        }
      }
    });
    this.node.on('receipt', (peer: Peer, msg: ReceiptMsg) => {
      if (msg.kind === 'read') this.sys(`${this.DIM}${peer.nick} read #${msg.room}${this.RESET}`);
    });
  }

  // ---- input ----

  private onLine(raw: string): void {
    const line = raw.replace(/\s+$/, '');
    if (!line) {
      this.rl.prompt();
      return;
    }
    if (line.startsWith('/')) {
      this.stopTyping();
      this.command(line);
    } else {
      const msg = this.node.sendChat(this.room, line);
      this.print(this.chatLine(this.room, this.node.nick, msg.body, msg.ts, true));
      this.stopTyping();
    }
    this.rl.prompt();
  }

  private startTyping(): void {
    this.node.setTyping(this.room, true);
    this.stopTyping();
    this.typingTimer = setTimeout(() => this.node.setTyping(this.room, false), 1500);
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = undefined;
    }
  }

  private command(line: string): void {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help':
        this.printHelp();
        break;
      case 'nick':
        if (arg) {
          this.node.setNick(arg.slice(0, 32));
          this.sys(`nick is now ${this.node.nick}`);
        } else this.sys('usage: /nick <name>');
        break;
      case 'join':
      case 'room':
        if (arg) {
          const parts = arg.split(/\s+/);
          const r = parts[0];
          const pass = parts[1];
          if (!r) break;
          this.node.join(r, pass);
          this.room = r;
          this.rl.setPrompt(this.prompt());
          this.sys(`joined #${r}${pass ? ' (password set)' : ''}`);
        } else this.sys('usage: /join <room> [pass]');
        break;
      case 'leave':
        if (arg) {
          this.node.leave(arg);
          if (this.room === arg) this.room = 'lobby';
          this.rl.setPrompt(this.prompt());
          this.sys(`left #${arg}`);
        } else this.sys('usage: /leave <room>');
        break;
      case 'rooms':
        this.sys(`rooms: ${[...this.node.rooms].map((r) => '#' + r).join(' ') || '(none)'}`);
        break;
      case 'peers':
      case 'names': {
        const peers = this.node.listPeers();
        if (!peers.length) this.sys('no peers connected');
        else for (const p of peers) this.sys(`${p.nick} ${this.DIM}${p.fp.slice(0, 12)}… rooms:${[...p.rooms].join(',') || '-'}${this.RESET}`);
        break;
      }
      case 'connect': {
        const m = /^([^:]+)(?::(\d+))?$/.exec(arg);
        if (!m) {
          this.sys('usage: /connect <host[:port]>');
          break;
        }
        const host = m[1]!;
        const port = m[2] ? Number(m[2]) : 4040;
        this.sys(`connecting to ${host}:${port}…`);
        void this.node.connect(host, port);
        break;
      }
      case 'fp':
      case 'me':
        this.sys(`${this.node.nick} — ${group(this.node.fingerprint)}`);
        break;
      case 'history':
        if (arg === 'on') {
          this.history.enable(this.historyPath);
          this.sys(`history ON → ${this.historyPath}`);
        } else if (arg === 'off') {
          this.history.disable();
          this.sys('history off (memory only; existing file kept — use /burn to wipe)');
        } else this.sys(`history is ${this.history.persistent ? 'ON' : 'off'} — usage: /history on|off`);
        break;
      case 'color':
        if (arg === 'on') {
          this.opts.color = true;
          this.sys('color on');
        } else if (arg === 'off') {
          this.opts.color = false;
          this.sys('color off');
        } else this.sys(`color is ${this.colorEnabled ? 'on' : 'off'} — usage: /color on|off`);
        break;
      case 'update': {
        const parts = arg.split(/\s+/);
        const r = parts[0];
        const pass = parts[1];
        if (!r || !pass) {
          this.sys('usage: /update <room> <newpass>');
        } else {
          this.node.setRoomPassword(r, pass);
          this.sys(`room #${r} password updated`);
        }
        break;
      }
      case 'notify': {
        notify('Test notification', 'lanchat-ng is working', { revealBody: true });
        this.sys('test notification sent');
        break;
      }
      case 'combos': {
        const names = Object.keys(COMBOS).join(', ');
        this.sys(`combos: ${names}`);
        break;
      }
      case 'combo': {
        const name = arg.trim();
        if (!name || !COMBOS[name]) {
          this.sys('usage: /combo <name>  — try /combos to list');
          break;
        }
        this.node.sendChat(this.room, COMBOS[name]);
        this.print(this.chatLine(this.room, this.node.nick, COMBOS[name], Date.now(), true));
        break;
      }
      case 'burn':
        this.history.burn();
        output.write(this.CLEAR_SCREEN);
        this.sys('history burned (memory + disk)');
        this.rl.prompt();
        break;
      case 'hide':
      case 'panic':
        this.toggleHidden();
        break;
      case 'quit':
      case 'exit':
        this.close();
        this.node.stop();
        process.exit(0);
        break;
      case 'selfupdate':
        this.sys('updating lanchat-ng from GitHub release…');
        void selfUpdate();
        break;
      default:
        this.sys(`unknown command: /${cmd} (try /help)`);
    }
  }

  private printHelp(): void {
    const lines = [
      '/help                 show this help',
      '/nick <name>          change your nickname',
      '/join <room> [pass]   join (and switch to) a room, optionally set its password',
      '/room <room>          alias for /join',
      '/leave <room>         leave a room',
      '/rooms                list rooms you are in',
      '/peers  /names        list connected peers',
      '/connect <host[:port]> connect to a peer directly',
      '/fp  /me              show your fingerprint',
      '/history on|off       toggle on-disk history (default off)',
      '/color on|off         toggle ANSI colors',
      '/burn                 wipe history (memory + disk) and clear screen',
      '/hide  /panic         hide the screen — Ctrl+X, F2 or Ctrl+O (again to resume)',
      '/update <room> <newpass> change a room password',
      '/selfupdate            update lanchat-ng from GitHub release',
      '/notify                send a test desktop notification',
      '/combo <name>            send a kaomoji combo — /combos to list',
      '/combos                  list all combo names',
      '/quit                 exit',
    ];
    for (const l of lines) this.print(`${this.DIM}${l}${this.RESET}`);
  }

  // ---- panic / hide-view (screen privacy only) ----

  private readonly commands: string[] = [
    'help',
    'nick',
    'join',
    'room',
    'leave',
    'rooms',
    'peers',
    'names',
    'connect',
    'fp',
    'me',
    'history',
    'color',
    'burn',
    'hide',
    'panic',
    'update',
    'selfupdate',
    'notify',
    'combo',
    'combos',
    'quit',
    'exit',
  ];

  private setupCompletion(): void {
    (this.rl as any).setCompleter((line: string): [string[], string] => {
      if (!line.startsWith('/')) return [[], line];
      const token = line.slice(1);
      const hits = this.commands.filter((c) => c.startsWith(token));
      return [hits.map((c) => `/${c}`), `/${token}`];
    });
  }

  private setupKeys(): void {
    if (!input.isTTY) return;
    readline.emitKeypressEvents(input, this.rl);
    input.on('keypress', (_s, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (!key) return;
      // Quick panic keys — all single, reliable, no readline conflict:
      //   Ctrl+X (primary), F2 (one key), Ctrl+O (legacy). Press again to resume.
      if ((key.ctrl && (key.name === 'x' || key.name === 'o')) || key.name === 'f2') {
        this.toggleHidden();
        return;
      }
      // Live typing indicator while the user types in the chat line.
      if (!key.ctrl && key.name && key.name.length === 1 && key.name !== 'tab') {
        this.startTyping();
      }
    });
  }

  private toggleHidden(): void {
    this.hidden = !this.hidden;
    if (this.hidden) {
      output.write(this.CLEAR_SCREEN);
      this.rl.setPrompt('');
      this.rl.prompt();
    } else {
      output.write(this.CLEAR_SCREEN);
      output.write(`${this.DIM}— resumed —${this.RESET}\n`);
      for (const l of this.buffered) output.write(l + '\n');
      this.buffered.length = 0;
      this.rl.setPrompt(this.prompt());
      this.rl.prompt();
    }
  }

  close(): void {
    this.stopTyping();
    if (input.isTTY) {
      try {
        input.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    this.rl.close();
  }
}

// Self-update: reinstall the global package from the latest GitHub release
// tarball so users never have to run npm by hand.
export function selfUpdate(): void {
  const url =
    'https://github.com/Vishnu-vashishth/lanchat-ng/releases/download/v0.1.0/lanchat-ng-0.1.0.tgz';
  const child = spawn('npm', ['install', '-g', url], { stdio: 'inherit' });
  child.on('error', (err) => {
    output.write(`self-update failed: ${err.message}\n`);
  });
  child.on('close', (code) => {
    output.write(
      `self-update ${code === 0 ? 'complete — restart lchat' : 'failed (exit ' + code + ')'}\n`,
    );
  });
}

