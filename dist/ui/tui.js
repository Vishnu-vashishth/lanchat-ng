import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { notify } from './notify.js';
import { group } from '../util/base32.js';
import { asciiEmoji, COMBOS } from '../util/emoji.js';
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
    typingSent = false;
    lastNotify = 0;
    NOTIFY_THROTTLE_MS = 5000;
    statusShown = false;
    typers = new Map();
    TYPING_TTL_MS = 4000;
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
        this.rl = readline.createInterface({
            input,
            output,
            prompt: this.prompt(),
            completer: (line) => this.complete(line),
        });
        // Prepend so this runs before readline's own keypress handler: the status
        // line must be retracted before readline commits Enter and scrolls past it.
        if (input.isTTY) {
            input.prependListener('keypress', (_s, key) => {
                if (key && (key.name === 'return' || key.name === 'enter'))
                    this.removeHint();
            });
        }
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
        this.removeHint();
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
        output.write(line + '\n');
        this.rl.prompt(true);
        this.renderHint();
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
            this.dropTyper(peer.fp);
            this.sys(`${peer.nick} disconnected`);
        });
        this.node.on('chat', (peer, msg) => {
            this.print(this.chatLine(msg.room, peer.nick, msg.body, msg.ts, false));
            const focused = msg.room === this.room && !this.hidden;
            // Don't notify for the room the user is already looking at.
            if (!focused && !this.opts.quiet && !this.hidden) {
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
            if (room !== this.room)
                return;
            if (on) {
                const existing = this.typers.get(peer.fp);
                if (existing)
                    clearTimeout(existing.timer);
                const timer = setTimeout(() => this.dropTyper(peer.fp), this.TYPING_TTL_MS);
                this.typers.set(peer.fp, { nick: peer.nick, timer });
            }
            else {
                this.dropTyper(peer.fp);
                return;
            }
            this.renderHint();
        });
        this.node.on('mention', (peer, from, body, room) => {
            const short = body.length > 40 ? body.slice(0, 40) + '…' : body;
            this.sys(`${this.YELLOW}@mention${this.RESET} from ${peer.nick}: ${short}`);
            const focused = room === this.room && !this.hidden;
            if (!focused && !this.opts.quiet && !this.hidden) {
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
            this.stopTyping();
            this.rl.prompt();
            this.renderHint();
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
        this.renderHint();
    }
    startTyping() {
        // Only announce the idle → typing transition; re-sending "on" for every
        // keystroke is what used to flood the other side's chat with lines.
        if (!this.typingSent) {
            this.node.setTyping(this.room, true);
            this.typingSent = true;
        }
        if (this.typingTimer)
            clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => this.stopTyping(), 1500);
    }
    stopTyping() {
        if (this.typingTimer) {
            clearTimeout(this.typingTimer);
            this.typingTimer = undefined;
        }
        if (this.typingSent) {
            this.typingSent = false;
            this.node.setTyping(this.room, false);
        }
    }
    // ---- transient hint/status line (typing + suggestions) ----
    // Rendered on the single line directly above the prompt and retracted
    // instead of appended, so it never fills up the scrollback.
    dropTyper(fp) {
        const existing = this.typers.get(fp);
        if (!existing)
            return;
        clearTimeout(existing.timer);
        this.typers.delete(fp);
        this.renderHint();
    }
    clearTypers() {
        for (const t of this.typers.values())
            clearTimeout(t.timer);
        this.typers.clear();
    }
    fit(text) {
        const cols = output.columns || 80;
        const max = Math.max(10, cols - 2);
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }
    hintText() {
        const line = this.rl.line ?? '';
        const cmd = /^\/([a-z]*)$/.exec(line);
        if (cmd) {
            const prefix = cmd[1] ?? '';
            const hits = this.commands.filter((c) => c.startsWith(prefix));
            return hits.length ? hits.map((c) => `/${c}`).join('  ') : '';
        }
        const mention = /(?:^|\s)@([A-Za-z0-9_-]*)$/.exec(line);
        if (mention) {
            const prefix = (mention[1] ?? '').toLowerCase();
            const nicks = [...new Set(this.node.listPeers()
                    .filter((p) => p.rooms.has(this.room))
                    .map((p) => p.nick))].filter((n) => n.toLowerCase().startsWith(prefix));
            return nicks.length ? nicks.map((n) => `@${n}`).join('  ') : '';
        }
        const names = [...this.typers.values()].map((t) => t.nick);
        if (names.length === 1)
            return `${names[0]} is typing…`;
        if (names.length > 1)
            return `${names.length} people are typing…`;
        return '';
    }
    renderHint() {
        if (this.hidden || !ANS)
            return;
        const text = this.hintText();
        if (!text) {
            this.removeHint();
            return;
        }
        const line = `${this.DIM}${this.fit(text)}${this.RESET}`;
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
        if (this.statusShown) {
            readline.moveCursor(output, 0, -1);
            readline.clearLine(output, 0);
            readline.cursorTo(output, 0);
        }
        output.write(line + '\n');
        this.statusShown = true;
        this.rl.prompt(true);
    }
    removeHint() {
        if (!this.statusShown)
            return;
        this.statusShown = false;
        if (!ANS)
            return;
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
        readline.moveCursor(output, 0, -1);
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
        output.write('\x1b[M'); // delete the retracted line so no blank row is left
        this.rl.prompt(true);
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
                    this.clearTypers();
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
                    this.clearTypers();
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
            '/combo <name>            send a kaomoji combo — /combos to list',
            '/combos                  list all combo names',
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
        'combo',
        'combos',
        'quit',
        'exit',
    ];
    // readline calls this on Tab. It must be supplied as the `completer` option to
    // createInterface — node's Interface has no setCompleter method.
    complete(line) {
        if (line.startsWith('/')) {
            const token = line.slice(1);
            if (/\s/.test(token))
                return [[], line];
            const hits = this.commands.filter((c) => c.startsWith(token));
            return [hits.map((c) => `/${c}`), `/${token}`];
        }
        const mention = /(?:^|\s)@([A-Za-z0-9_-]*)$/.exec(line);
        if (mention) {
            const prefix = (mention[1] ?? '').toLowerCase();
            const nicks = [...new Set(this.node.listPeers().map((p) => p.nick))]
                .filter((n) => n.toLowerCase().startsWith(prefix));
            return [nicks.map((n) => `@${n}`), `@${mention[1] ?? ''}`];
        }
        return [[], line];
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
            if (!key.ctrl &&
                key.name &&
                key.name.length === 1 &&
                key.name !== 'tab' &&
                !this.rl.line.startsWith('/')) {
                this.startTyping();
            }
            // Refresh the command/mention suggestions after readline has updated
            // its internal line buffer for this keystroke.
            if (!key.ctrl)
                setImmediate(() => this.renderHint());
        });
    }
    toggleHidden() {
        this.hidden = !this.hidden;
        if (this.hidden) {
            this.statusShown = false;
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
            this.renderHint();
        }
    }
    close() {
        this.stopTyping();
        this.clearTypers();
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
    // Always the newest release: GitHub redirects /releases/latest/download/<asset>
    // to the current release's asset, so this never goes stale between versions.
    const url = 'https://github.com/Vishnu-vashishth/lanchat-ng/releases/latest/download/lanchat-ng.tgz';
    const child = spawn('npm', ['install', '-g', url], { stdio: 'inherit' });
    child.on('error', (err) => {
        output.write(`self-update failed: ${err.message}\n`);
    });
    child.on('close', (code) => {
        output.write(`self-update ${code === 0 ? 'complete — restart lchat' : 'failed (exit ' + code + ')'}\n`);
    });
}
