import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { notify } from './notify.js';
import { group } from '../util/base32.js';
import { asciiEmoji } from '../util/emoji.js';
import { ansiSupported } from '../util/platform.js';
const ANS = ansiSupported();
export class Tui {
    node;
    opts;
    history;
    historyPath;
    rl;
    room = 'lobby';
    hidden = false;
    buffered = [];
    colorEnabled;
    DIM;
    CYAN;
    YELLOW;
    GREEN;
    RESET;
    CLEAR_SCREEN;
    typingTimer;
    lastNotify = 0;
    NOTIFY_THROTTLE_MS = 5000;
    constructor(node, opts, history, historyPath) {
        this.node = node;
        this.opts = opts;
        this.history = history;
        this.historyPath = historyPath;
        this.colorEnabled = opts.color && ANS;
        const c = (code) => (this.colorEnabled ? code : '');
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
    prompt() {
        return `${this.CYAN}#${this.room}${this.RESET}> `;
    }
    print(line) {
        if (this.hidden) {
            this.buffered.push(line);
            return;
        }
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
        output.write(line + '\n');
        this.rl.prompt(true);
    }
    sys(text) {
        this.print(`${this.DIM}* ${text}${this.RESET}`);
    }
    static time(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    chatLine(room, nick, body, ts, self) {
        const who = self ? `${this.GREEN}${nick}${this.RESET}` : `${this.YELLOW}${nick}${this.RESET}`;
        const where = room === this.room ? '' : `${this.DIM}#${room}${this.RESET} `;
        return `${this.DIM}[${Tui.time(ts)}]${this.RESET} ${where}<${who}> ${asciiEmoji(body)}`;
    }
    banner(fingerprint, port, opts) {
        output.write(`${this.CYAN}lanchat-ng${this.RESET} — encrypted LAN chat\n`);
        output.write(`${this.DIM}listening on tcp/${port}  ·  discovery ${opts.discovery ? 'ON' : 'off'}  ·  history ${opts.history ? 'ON (disk)' : 'off (memory only)'}${this.RESET}\n`);
        output.write(`${this.DIM}your nick:${this.RESET} ${this.node.nick}\n`);
        output.write(`${this.DIM}your fingerprint (share to verify first contact):${this.RESET}\n  ${this.GREEN}${group(fingerprint)}${this.RESET}\n`);
        output.write(`${this.DIM}type /help for commands. Ctrl+X (or F2) hides the screen.${this.RESET}\n\n`);
        this.rl.setPrompt(this.prompt());
        this.rl.prompt();
    }
    // ---- node events ----
    wire() {
        this.node.on('peer-connect', (peer) => {
            this.sys(`${peer.nick} connected ${this.DIM}(${peer.fp.slice(0, 12)}…)${this.RESET}`);
            if (peer.firstSeen) {
                this.sys(`${this.YELLOW}first contact${this.RESET} with ${peer.nick} — verify fingerprint:`);
                this.sys(`  ${group(peer.fp)}`);
            }
        });
        this.node.on('peer-disconnect', (peer) => {
            this.sys(`${peer.nick} disconnected`);
        });
        this.node.on('chat', (peer, msg) => {
            this.print(this.chatLine(msg.room, peer.nick, msg.body, msg.ts, false));
            const focused = msg.room === this.room && !this.hidden;
            if (!this.opts.quiet && !this.hidden) {
                const now = Date.now();
                if (now - this.lastNotify > this.NOTIFY_THROTTLE_MS) {
                    this.lastNotify = now;
                    notify('New message', '', { revealBody: this.opts.notifyBody });
                }
            }
            if (focused)
                this.node.sendRead(msg.room, [msg.id]); // we're looking at it
        });
        this.node.on('typing', (peer, room, on) => {
            if (on && room === this.room)
                this.sys(`${peer.nick} is typing…`);
        });
        this.node.on('mention', (peer, from, body) => {
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
        this.node.on('receipt', (peer, msg) => {
            if (msg.kind === 'read')
                this.sys(`${this.DIM}${peer.nick} read #${msg.room}${this.RESET}`);
        });
    }
    // ---- input ----
    onLine(raw) {
        const line = raw.replace(/\s+$/, '');
        if (!line) {
            this.rl.prompt();
            return;
        }
        if (line.startsWith('/')) {
            this.stopTyping();
            this.command(line);
        }
        else {
            const msg = this.node.sendChat(this.room, line);
            this.print(this.chatLine(this.room, this.node.nick, msg.body, msg.ts, true));
            this.stopTyping();
        }
        this.rl.prompt();
    }
    startTyping() {
        this.node.setTyping(this.room, true);
        this.stopTyping();
        this.typingTimer = setTimeout(() => this.node.setTyping(this.room, false), 1500);
    }
    stopTyping() {
        if (this.typingTimer) {
            clearTimeout(this.typingTimer);
            this.typingTimer = undefined;
        }
    }
    command(line) {
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
                }
                else
                    this.sys('usage: /nick <name>');
                break;
            case 'join':
            case 'room':
                if (arg) {
                    const parts = arg.split(/\s+/);
                    const r = parts[0];
                    const pass = parts[1];
                    if (!r)
                        break;
                    this.node.join(r, pass);
                    this.room = r;
                    this.rl.setPrompt(this.prompt());
                    this.sys(`joined #${r}${pass ? ' (password set)' : ''}`);
                }
                else
                    this.sys('usage: /join <room> [pass]');
                break;
            case 'leave':
                if (arg) {
                    this.node.leave(arg);
                    if (this.room === arg)
                        this.room = 'lobby';
                    this.rl.setPrompt(this.prompt());
                    this.sys(`left #${arg}`);
                }
                else
                    this.sys('usage: /leave <room>');
                break;
            case 'rooms':
                this.sys(`rooms: ${[...this.node.rooms].map((r) => '#' + r).join(' ') || '(none)'}`);
                break;
            case 'peers':
            case 'names': {
                const peers = this.node.listPeers();
                if (!peers.length)
                    this.sys('no peers connected');
                else
                    for (const p of peers)
                        this.sys(`${p.nick} ${this.DIM}${p.fp.slice(0, 12)}… rooms:${[...p.rooms].join(',') || '-'}${this.RESET}`);
                break;
            }
            case 'connect': {
                const m = /^([^:]+)(?::(\d+))?$/.exec(arg);
                if (!m) {
                    this.sys('usage: /connect <host[:port]>');
                    break;
                }
                const host = m[1];
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
                }
                else if (arg === 'off') {
                    this.history.disable();
                    this.sys('history off (memory only; existing file kept — use /burn to wipe)');
                }
                else
                    this.sys(`history is ${this.history.persistent ? 'ON' : 'off'} — usage: /history on|off`);
                break;
            case 'color':
                if (arg === 'on') {
                    this.opts.color = true;
                    this.sys('color on');
                }
                else if (arg === 'off') {
                    this.opts.color = false;
                    this.sys('color off');
                }
                else
                    this.sys(`color is ${this.colorEnabled ? 'on' : 'off'} — usage: /color on|off`);
                break;
            case 'update': {
                const parts = arg.split(/\s+/);
                const r = parts[0];
                const pass = parts[1];
                if (!r || !pass) {
                    this.sys('usage: /update <room> <newpass>');
                }
                else {
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
    printHelp() {
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
            '/quit                 exit',
        ];
        for (const l of lines)
            this.print(`${this.DIM}${l}${this.RESET}`);
    }
    // ---- panic / hide-view (screen privacy only) ----
    commands = [
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
        'quit',
        'exit',
    ];
    setupCompletion() {
        this.rl.setCompleter((line) => {
            if (!line.startsWith('/'))
                return [[], line];
            const token = line.slice(1);
            const hits = this.commands.filter((c) => c.startsWith(token));
            return [hits.map((c) => `/${c}`), `/${token}`];
        });
    }
    setupKeys() {
        if (!input.isTTY)
            return;
        readline.emitKeypressEvents(input, this.rl);
        input.on('keypress', (_s, key) => {
            if (!key)
                return;
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
    toggleHidden() {
        this.hidden = !this.hidden;
        if (this.hidden) {
            output.write(this.CLEAR_SCREEN);
            this.rl.setPrompt('');
            this.rl.prompt();
        }
        else {
            output.write(this.CLEAR_SCREEN);
            output.write(`${this.DIM}— resumed —${this.RESET}\n`);
            for (const l of this.buffered)
                output.write(l + '\n');
            this.buffered.length = 0;
            this.rl.setPrompt(this.prompt());
            this.rl.prompt();
        }
    }
    close() {
        this.stopTyping();
        if (input.isTTY) {
            try {
                input.setRawMode(false);
            }
            catch {
                /* ignore */
            }
        }
        this.rl.close();
    }
}
// Self-update: reinstall the global package from the latest GitHub release
// tarball so users never have to run npm by hand.
export function selfUpdate() {
    const url = 'https://github.com/Vishnu-vashishth/lanchat-ng/releases/download/v0.1.0/lanchat-ng-0.1.0.tgz';
    const child = spawn('npm', ['install', '-g', url], { stdio: 'inherit' });
    child.on('error', (err) => {
        output.write(`self-update failed: ${err.message}\n`);
    });
    child.on('close', (code) => {
        output.write(`self-update ${code === 0 ? 'complete — restart lchat' : 'failed (exit ' + code + ')'}\n`);
    });
}
