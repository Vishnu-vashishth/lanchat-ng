import os from 'node:os';
import { join } from 'node:path';
export function defaultDataDir() {
    if (process.env.LCNG_DATA_DIR)
        return process.env.LCNG_DATA_DIR;
    const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
    return join(base, 'lanchat-ng');
}
export function paths(dir) {
    return {
        identity: join(dir, 'identity'),
        trust: join(dir, 'trust.json'),
        history: join(dir, 'history.jsonl'),
    };
}
function parseEndpoint(value, defaultPort) {
    const idx = value.lastIndexOf(':');
    if (idx === -1)
        return { host: value, port: defaultPort };
    const host = value.slice(0, idx);
    const port = Number(value.slice(idx + 1)) || defaultPort;
    return { host, port };
}
export function parseArgs(argv) {
    const o = {
        nick: os.userInfo().username || 'anon',
        port: 4040,
        discovery: false,
        discoveryPort: 4041,
        autoConnect: true,
        history: false,
        quiet: false,
        notifyBody: false,
        connect: [],
        dataDir: defaultDataDir(),
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--nick':
            case '-n':
                o.nick = next() ?? o.nick;
                break;
            case '--port':
            case '-p':
                o.port = Number(next()) || o.port;
                break;
            case '--connect':
            case '-c': {
                const v = next();
                if (v)
                    o.connect.push(parseEndpoint(v, o.port));
                break;
            }
            case '--discovery':
                o.discovery = true;
                break;
            case '--discovery-port':
                o.discoveryPort = Number(next()) || o.discoveryPort;
                break;
            case '--no-autoconnect':
                o.autoConnect = false;
                break;
            case '--history':
                o.history = true;
                break;
            case '--quiet':
            case '-q':
                o.quiet = true;
                break;
            case '--notify-body':
                o.notifyBody = true;
                break;
            case '--data-dir':
                o.dataDir = next() ?? o.dataDir;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                if (a && a.startsWith('-')) {
                    process.stderr.write(`unknown option: ${a}\n`);
                    process.exit(2);
                }
        }
    }
    return o;
}
export function printHelp() {
    process.stdout.write(`lanchat-ng — encrypted peer-to-peer LAN chat

usage: lchat [options]

  -n, --nick <name>        nickname (default: your username)
  -p, --port <port>        TCP listen port (default: 4040)
  -c, --connect <host[:port]>  connect to a peer at startup (repeatable)
      --discovery          enable UDP LAN auto-discovery (default: off)
      --discovery-port <p> discovery UDP port (default: 4041)
      --no-autoconnect     do not auto-dial peers learned via gossip/discovery
      --history            persist message history to disk (default: memory only)
  -q, --quiet              disable desktop notifications
      --notify-body        include message text in notifications (default: hidden)
      --data-dir <path>    config/identity directory (default: ~/.config/lanchat-ng)
  -h, --help               show this help
`);
}
