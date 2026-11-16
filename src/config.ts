import os from 'node:os';
import { join } from 'node:path';
import { isWindows, windowsDataDir } from './util/platform.js';

export interface Options {
  nick: string;
  port: number;
  discovery: boolean;
  discoveryPort: number;
  autoConnect: boolean;
  history: boolean;
  quiet: boolean;
  notifyBody: boolean;
  color: boolean;
  connect: { host: string; port: number }[];
  dataDir: string;
  room?: string;
  pass?: string;
}

export function defaultDataDir(): string {
  if (process.env.LCNG_DATA_DIR) return process.env.LCNG_DATA_DIR;
  if (isWindows()) {
    const appdata = windowsDataDir() ?? join(os.homedir(), 'AppData', 'Roaming');
    return join(appdata, 'lanchat-ng');
  }
  const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
  return join(base, 'lanchat-ng');
}

export function paths(dir: string): { identity: string; trust: string; history: string } {
  return {
    identity: join(dir, 'identity'),
    trust: join(dir, 'trust.json'),
    history: join(dir, 'history.jsonl'),
  };
}

function parseEndpoint(value: string, defaultPort: number): { host: string; port: number } {
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { host: value, port: defaultPort };
  const host = value.slice(0, idx);
  const port = Number(value.slice(idx + 1)) || defaultPort;
  return { host, port };
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    nick: os.userInfo().username || 'anon',
    port: 4040,
    discovery: false,
    discoveryPort: 4041,
    autoConnect: true,
    history: false,
    quiet: false,
    notifyBody: false,
    color: true,
    connect: [],
    dataDir: defaultDataDir(),
    room: undefined,
    pass: undefined,
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
        if (v) o.connect.push(parseEndpoint(v, o.port));
        break;
      }
      case '--room':
        o.room = next() ?? o.room;
        break;
      case '--pass':
      case '--password':
        o.pass = next() ?? o.pass;
        break;
      case '--color':
        o.color = true;
        break;
      case '--no-color':
        o.color = false;
        break;
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

export function printHelp(): void {
  process.stdout.write(
    `lanchat-ng — encrypted peer-to-peer LAN chat

usage: lchat [options]

  -n, --nick <name>        nickname (default: your username)
  -p, --port <port>        TCP listen port (default: 4040)
      -c, --connect <host[:port]>  connect to a peer at startup (repeatable)
      --room <name>                room to auto-join after connecting
      --pass <pass>                password for the auto-join room
      --discovery                  enable UDP LAN auto-discovery (default: off)
      --discovery-port <p> discovery UDP port (default: 4041)
      --no-autoconnect     do not auto-dial peers learned via gossip/discovery
      --history            persist message history to disk (default: memory only)
  -q, --quiet              disable desktop notifications
      --notify-body        include message text in notifications (default: hidden)
      --data-dir <path>    config/identity directory (default: ~/.config/lanchat-ng)
      --color              use ANSI colors (default: on)
      --no-color           disable ANSI colors
  -h, --help               show this help
`,
  );
}
