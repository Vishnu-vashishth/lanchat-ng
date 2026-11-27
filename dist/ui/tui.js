import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { notify } from './notify.js';
import { group } from '../util/base32.js';
import { asciiEmoji, COMBOS } from '../util/emoji.js';
import { ansiSupported } from '../util/platform.js';
import { GameHub } from '../games/hub.js';
import { GameScreen } from '../games/ui.js';
import { GAMES, findGame } from '../games/registry.js';
import { toKey } from '../games/term/keys.js';
const ANS = ansiSupported();
export class Tui {
    node;
    opts;
    history;
    historyPath;
    rl;
    lineHistory = [];
    room = 'lobby';
    hidden = false;
    buffered = [];
    colorEnabled;
    DIM;
    CYAN;
    YELLOW;
    GREEN;
    MAGENTA;
    RESET;
    CLEAR_SCREEN;
    typingTimer;
    typingSent = false;
    lastNotify = 0;
    NOTIFY_THROTTLE_MS = 5000;
    statusShown = false;
    typers = new Map();
    TYPING_TTL_MS = 4000;
    input;
    output;
    // Games: in 'game' mode the arcade owns the screen and the keyboard; the
    // readline prompt is closed and rebuilt (with its history) on the way back.
    mode = 'chat';
    gameHidden = false;
    keysBlocked = false;
    closed = false;
    games;
    screen;
    constructor(node, opts, history, historyPath, io) {
        this.node = node;
        this.opts = opts;
        this.history = history;
        this.historyPath = historyPath;
        this.input = io?.input ?? stdin;
        this.output = io?.output ?? stdout;
        this.colorEnabled = opts.color && ANS;
        const c = (code) => (this.colorEnabled ? code : '');
        this.DIM = c('\x1b[2m');
        this.CYAN = c('\x1b[36m');
        this.YELLOW = c('\x1b[33m');
        this.GREEN = c('\x1b[32m');
        this.MAGENTA = c('\x1b[35m');
        this.RESET = c('\x1b[0m');
        this.CLEAR_SCREEN = this.colorEnabled ? '\x1b[2J\x1b[3J\x1b[H' : '\n'.repeat(40);
        this.games = new GameHub(node);
        this.screen = new GameScreen({
            out: this.output,
            color: this.colorEnabled,
            nick: () => this.node.nick,
            room: () => this.room,
            peopleIn: (room) => this.node.peersIn(room),
            say: (room, text) => {
                const msg = this.node.sendChat(room, text);
                this.print(this.chatLine(room, this.node.nick, msg.body, msg.ts, true));
            },
            recent: (room) => this.node.historyStore.recent(room, 30).map((r) => ({ nick: r.from, text: r.body, self: !!r.self })),
            exit: () => this.exitGame(),
        }, this.games);
        this.games.on('ad', (ad) => {
            this.sys(`${this.MAGENTA}▶ ${ad.host} opened a ${ad.title} table in #${ad.room}${this.RESET} — type /play to join`);
        });
        this.createRl();
        // Prepend so this runs before readline's own keypress handler: the status
        // line must be retracted before readline commits Enter and scrolls past it.
        if (this.input.isTTY) {
            this.input.prependListener('keypress', (_s, key) => {
                if (this.mode === 'chat' && key && (key.name === 'return' || key.name === 'enter'))
                    this.removeHint();
            });
        }
        this.setupKeys();
        this.output.on('resize', () => {
            if (this.mode === 'game')
                this.screen.resized();
        });
        this.wire();
    }
    // The prompt is (re)built here; readline must be closed while a game owns
    // the keyboard, or it would echo keys and turn Enter into chat messages.
    createRl() {
        if (this.input.isTTY)
            this.input.removeListener('keypress', this.onKeypress);
        this.rl = readline.createInterface({
            input: this.input,
            output: this.output,
            prompt: this.prompt(),
            completer: (line) => this.complete(line),
            history: this.lineHistory,
        });
        this.rl.on('history', (h) => {
            this.lineHistory = h;
        });
        this.rl.on('line', (raw) => this.onLine(raw));
        this.rl.on('SIGINT', () => {
            this.sys('type /quit to exit');
            this.rl.prompt();
        });
        // Our key handler runs after readline's, as it always has.
        if (this.input.isTTY)
            this.input.on('keypress', this.onKeypress);
    }
    // ---- rendering ----
    prompt() {
        return `${this.CYAN}#${this.room}${this.RESET}> `;
    }
    print(line) {
        if (this.closed)
            return;
        if (this.hidden || this.mode === 'game') {
            this.buffered.push(line);
            if (this.buffered.length > 1000)
                this.buffered.splice(0, this.buffered.length - 1000);
            return;
        }
        this.removeHint();
        readline.clearLine(this.output, 0);
        readline.cursorTo(this.output, 0);
        this.output.write(line + '\n');
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
        this.output.write(`${this.CYAN}lanchat-ng${this.RESET} — encrypted LAN chat\n`);
        this.output.write(`${this.DIM}listening on tcp/${port}  ·  discovery ${opts.discovery ? 'ON' : 'off'}  ·  history ${opts.history ? 'ON (disk)' : 'off (memory only)'}${this.RESET}\n`);
        this.output.write(`${this.DIM}your nick:${this.RESET} ${this.node.nick}\n`);
        this.output.write(`${this.DIM}your fingerprint (share to verify first contact):${this.RESET}\n  ${this.GREEN}${group(fingerprint)}${this.RESET}\n`);
        this.output.write(`${this.DIM}type /help for commands, /games for the arcade. Ctrl+X (or F2) hides the screen.${this.RESET}\n\n`);
        this.rl.setPrompt(this.prompt());
        this.rl.prompt();
    }
    // ---- node events ----
    /** The room whose messages are on screen right now (chat or game panel). */
    watching() {
        if (this.mode === 'game') {
            const c = this.games.client;
            return c && !c.closed ? c.room : this.room;
        }
        return this.room;
    }
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
            if (this.mode === 'game')
                this.screen.chat(msg.room, peer.nick, msg.body, false);
            const hiddenNow = this.hidden || (this.mode === 'game' && this.gameHidden);
            const focused = msg.room === this.watching() && !hiddenNow;
            // Don't notify for the room the user is already looking at.
            if (!focused && !this.opts.quiet && !hiddenNow) {
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
            if (room !== this.room || this.mode === 'game')
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
            const focused = room === this.watching() && !this.hidden;
            if (!focused && !this.opts.quiet && !this.hidden) {
                const now = Date.now();
                if (now - this.lastNotify > this.NOTIFY_THROTTLE_MS) {
                    this.lastNotify = now;
                    notify(`Mention from ${peer.nick}`, short, { revealBody: this.opts.notifyBody });
                }
            }
        });
        this.node.on('receipt', (peer, msg) => {
            if (msg.kind === 'read' && this.mode === 'chat')
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
        if (this.mode !== 'chat')
            return; // a command switched to the arcade
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
        const cols = this.output.columns || 80;
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
        const play = /^\/play\s+(\S*)$/.exec(line);
        if (play) {
            const prefix = (play[1] ?? '').toLowerCase();
            const hits = GAMES.filter((g) => g.id.startsWith(prefix));
            return hits.length ? hits.map((g) => `${g.id} (${g.title})`).join('  ') : '';
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
        if (this.closed || this.hidden || !ANS || this.mode !== 'chat')
            return;
        const text = this.hintText();
        if (!text) {
            this.removeHint();
            return;
        }
        const line = `${this.DIM}${this.fit(text)}${this.RESET}`;
        readline.clearLine(this.output, 0);
        readline.cursorTo(this.output, 0);
        if (this.statusShown) {
            readline.moveCursor(this.output, 0, -1);
            readline.clearLine(this.output, 0);
            readline.cursorTo(this.output, 0);
        }
        this.output.write(line + '\n');
        this.statusShown = true;
        this.rl.prompt(true);
    }
    removeHint() {
        if (!this.statusShown || this.closed)
            return;
        this.statusShown = false;
        if (!ANS)
            return;
        readline.clearLine(this.output, 0);
        readline.cursorTo(this.output, 0);
        readline.moveCursor(this.output, 0, -1);
        readline.clearLine(this.output, 0);
        readline.cursorTo(this.output, 0);
        this.output.write('\x1b[M'); // delete the retracted line so no blank row is left
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
            case 'games':
            case 'arcade':
                this.enterGame({ kind: 'arcade' });
                break;
            case 'play': {
                if (!arg) {
                    // Join the open table in this room if there is exactly one.
                    const open = this.games.tables().filter((t) => t.room === this.room && t.phase !== 'results');
                    if (open.length === 1)
                        this.enterGame({ kind: 'join', gid: open[0].gid });
                    else
                        this.enterGame({ kind: 'arcade' });
                    break;
                }
                const def = findGame(arg);
                if (!def) {
                    this.sys(`no game called "${arg}" — try ${GAMES.map((g) => g.id).join(', ')}`);
                    break;
                }
                this.enterGame({ kind: 'host', game: def.id });
                break;
            }
            case 'burn':
                this.history.burn();
                this.output.write(this.CLEAR_SCREEN);
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
            '/games                open the arcade: host or join multiplayer games',
            '/play <game>          host a game here (snake, …) — /play alone joins an open table',
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
        'games',
        'arcade',
        'play',
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
        const play = /^\/play\s+(\S*)$/.exec(line);
        if (play) {
            const token = play[1] ?? '';
            const hits = GAMES.map((g) => g.id).filter((id) => id.startsWith(token.toLowerCase()));
            return [hits, token];
        }
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
        if (!this.input.isTTY)
            return;
        readline.emitKeypressEvents(this.input, this.rl);
    }
    onKeypress = (s, key) => {
        if (!key)
            return;
        // Quick panic keys — all single, reliable, no readline conflict:
        //   Ctrl+X (primary), F2 (one key), Ctrl+O (legacy). Press again to resume.
        const panic = (key.ctrl && (key.name === 'x' || key.name === 'o')) || key.name === 'f2';
        if (this.mode === 'game') {
            if (panic) {
                this.gameHidden = !this.gameHidden;
                this.screen.setHidden(this.gameHidden);
                return;
            }
            // The Enter that submitted "/games" is still being dispatched when the
            // arcade opens; it must not also press a button in there.
            if (this.keysBlocked)
                return;
            const k = toKey(s, key);
            if (k)
                this.screen.key(k);
            return;
        }
        if (panic) {
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
    };
    // ---- games ----
    restoreOnExit = () => {
        this.screen.close();
    };
    enterGame(start) {
        if (!this.input.isTTY || !this.output.isTTY) {
            this.sys('games need an interactive terminal');
            return;
        }
        if (this.hidden)
            return;
        if (this.mode === 'game') {
            this.screen.open(start);
            return;
        }
        this.stopTyping();
        this.clearTypers();
        this.removeHint();
        this.mode = 'game';
        this.gameHidden = false;
        // Only the rest of the current keystroke (or pasted chunk) is swallowed.
        this.keysBlocked = true;
        queueMicrotask(() => {
            this.keysBlocked = false;
        });
        this.rl.close(); // hand the keyboard to the arcade; rebuilt in exitGame()
        try {
            this.input.setRawMode(true);
        }
        catch {
            /* not a TTY */
        }
        this.input.resume();
        process.once('exit', this.restoreOnExit);
        this.screen.open(start);
    }
    exitGame() {
        if (this.mode !== 'game')
            return;
        process.removeListener('exit', this.restoreOnExit);
        this.mode = 'chat';
        this.createRl();
        // The chat screen underneath was preserved; add what arrived meanwhile.
        for (const l of this.buffered.splice(0))
            this.output.write(l + '\n');
        this.sys('back to chat — /games opens the arcade again');
        this.rl.setPrompt(this.prompt());
        this.rl.prompt();
    }
    toggleHidden() {
        this.hidden = !this.hidden;
        if (this.hidden) {
            this.statusShown = false;
            this.output.write(this.CLEAR_SCREEN);
            this.rl.setPrompt('');
            this.rl.prompt();
        }
        else {
            this.output.write(this.CLEAR_SCREEN);
            this.output.write(`${this.DIM}— resumed —${this.RESET}\n`);
            for (const l of this.buffered)
                this.output.write(l + '\n');
            this.buffered.length = 0;
            this.rl.setPrompt(this.prompt());
            this.rl.prompt();
            this.renderHint();
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.stopTyping();
        this.clearTypers();
        if (this.mode === 'game') {
            this.screen.close();
            process.removeListener('exit', this.restoreOnExit);
        }
        this.games.stop();
        if (this.input.isTTY) {
            try {
                this.input.setRawMode(false);
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
        stdout.write(`self-update failed: ${err.message}\n`);
    });
    child.on('close', (code) => {
        stdout.write(`self-update ${code === 0 ? 'complete — restart lchat' : 'failed (exit ' + code + ')'}\n`);
    });
}
