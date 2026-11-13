import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { notify } from './notify.js';
import { group } from '../util/base32.js';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
export class Tui {
    node;
    opts;
    history;
    historyPath;
    rl;
    room = 'lobby';
    hidden = false;
    buffered = [];
    constructor(node, opts, history, historyPath) {
        this.node = node;
        this.opts = opts;
        this.history = history;
        this.historyPath = historyPath;
        this.rl = readline.createInterface({ input, output, prompt: this.prompt() });
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
        return `${CYAN}#${this.room}${RESET}> `;
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
        this.print(`${DIM}* ${text}${RESET}`);
    }
    static time(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    chatLine(room, nick, body, ts, self) {
        const who = self ? `${GREEN}${nick}${RESET}` : `${YELLOW}${nick}${RESET}`;
        const where = room === this.room ? '' : `${DIM}#${room}${RESET} `;
        return `${DIM}[${Tui.time(ts)}]${RESET} ${where}<${who}> ${body}`;
    }
    banner(fingerprint, port, opts) {
        output.write(`${CYAN}lanchat-ng${RESET} — encrypted LAN chat\n`);
        output.write(`${DIM}listening on tcp/${port}  ·  discovery ${opts.discovery ? 'ON' : 'off'}  ·  history ${opts.history ? 'ON (disk)' : 'off (memory only)'}${RESET}\n`);
        output.write(`${DIM}your nick:${RESET} ${this.node.nick}\n`);
        output.write(`${DIM}your fingerprint (share to verify first contact):${RESET}\n  ${GREEN}${group(fingerprint)}${RESET}\n`);
        output.write(`${DIM}type /help for commands. Ctrl+X (or F2) hides the screen.${RESET}\n\n`);
        this.rl.setPrompt(this.prompt());
        this.rl.prompt();
    }
    // ---- node events ----
    wire() {
        this.node.on('peer-connect', (peer) => {
            this.sys(`${peer.nick} connected ${DIM}(${peer.fp.slice(0, 12)}…)${RESET}`);
            if (peer.firstSeen) {
                this.sys(`${YELLOW}first contact${RESET} with ${peer.nick} — verify fingerprint:`);
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
                const title = focused ? peer.nick : `${peer.nick} in #${msg.room}`;
                notify(title, this.opts.notifyBody ? msg.body : 'New message');
            }
            if (focused)
                this.node.sendRead(msg.room, [msg.id]); // we're looking at it
        });
        this.node.on('typing', (peer, room, on) => {
            if (on && room === this.room)
                this.sys(`${peer.nick} is typing…`);
        });
        this.node.on('receipt', (peer, msg) => {
            if (msg.kind === 'read')
                this.sys(`${DIM}${peer.nick} read #${msg.room}${RESET}`);
        });
    }
    // ---- input ----
    onLine(raw) {
        const line = raw.replace(/\s+$/, '');
        if (!line) {
            this.rl.prompt();
            return;
        }
        if (line.startsWith('/'))
            this.command(line);
        else {
            const msg = this.node.sendChat(this.room, line);
            this.print(this.chatLine(this.room, this.node.nick, msg.body, msg.ts, true));
        }
        this.rl.prompt();
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
                    this.node.join(arg);
                    this.room = arg;
                    this.rl.setPrompt(this.prompt());
                    this.sys(`joined #${arg}`);
                }
                else
                    this.sys('usage: /join <room>');
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
                        this.sys(`${p.nick} ${DIM}${p.fp.slice(0, 12)}… rooms:${[...p.rooms].join(',') || '-'}${RESET}`);
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
            case 'burn':
                this.history.burn();
                output.write(CLEAR_SCREEN);
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
            default:
                this.sys(`unknown command: /${cmd} (try /help)`);
        }
    }
    printHelp() {
        const lines = [
            '/help                 show this help',
            '/nick <name>          change your nickname',
            '/join <room>          join (and switch to) a room',
            '/room <room>          alias for /join',
            '/leave <room>         leave a room',
            '/rooms                list rooms you are in',
            '/peers  /names        list connected peers',
            '/connect <host[:port]> connect to a peer directly',
            '/fp  /me              show your fingerprint',
            '/history on|off       toggle on-disk history (default off)',
            '/burn                 wipe history (memory + disk) and clear screen',
            '/hide  /panic         hide the screen — Ctrl+X, F2 or Ctrl+O (again to resume)',
            '/quit                 exit',
        ];
        for (const l of lines)
            this.print(`${DIM}${l}${RESET}`);
    }
    // ---- panic / hide-view (screen privacy only) ----
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
            }
        });
    }
    toggleHidden() {
        this.hidden = !this.hidden;
        if (this.hidden) {
            output.write(CLEAR_SCREEN);
            this.rl.setPrompt('');
            this.rl.prompt();
        }
        else {
            output.write(CLEAR_SCREEN);
            output.write(`${DIM}— resumed —${RESET}\n`);
            for (const l of this.buffered)
                output.write(l + '\n');
            this.buffered.length = 0;
            this.rl.setPrompt(this.prompt());
            this.rl.prompt();
        }
    }
    close() {
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
