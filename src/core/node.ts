import { EventEmitter } from 'node:events';
import type { Server, Socket } from 'node:net';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { createServer, dial } from '../net/transport.js';
import { Framer } from '../net/frame.js';
import { Discovery } from '../net/discovery.js';
import { SecureSession } from '../crypto/session.js';
import type { Identity } from '../crypto/identity.js';
import { Peer } from './peer.js';
import type { TrustStore } from './trust.js';
import type { History } from './history.js';
import { DEFAULT_ROOM, PROTOCOL_VERSION, type ChatMsg, type Message } from '../protocol/messages.js';
import { debug } from '../util/log.js';

export interface NodeOptions {
  identity: Identity;
  nick: string;
  port: number;
  trust: TrustStore;
  history: History;
  discovery: boolean;
  discoveryPort: number;
  autoConnect: boolean;
}

// The node: owns the TCP server, the set of peers, discovery and gossip, and
// routes application messages. Emits events the UI subscribes to.
export class ChatNode extends EventEmitter {
  private server: Server | undefined;
  private disco: Discovery | undefined;
  private readonly peers = new Map<string, Peer>(); // fp -> peer
  private readonly dialing = new Set<string>(); // "host:port" currently dialing
  readonly rooms = new Set<string>([DEFAULT_ROOM]);
  nick: string;

  constructor(private readonly o: NodeOptions) {
    super();
    this.nick = o.nick;
  }

  get identity(): Identity {
    return this.o.identity;
  }
  get fingerprint(): string {
    return this.o.identity.fingerprint;
  }
  get historyStore(): History {
    return this.o.history;
  }
  listPeers(): Peer[] {
    return [...this.peers.values()];
  }
  get boundPort(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.o.port;
  }

  async start(): Promise<void> {
    this.server = createServer((sock) => this.onInbound(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port, () => resolve());
    });
    if (this.o.discovery) {
      this.disco = new Discovery(
        this.o.discoveryPort,
        this.o.port,
        this.fingerprint.slice(0, 12),
        (host, port) => {
          if (this.o.autoConnect) void this.connect(host, port);
        },
      );
      this.disco.start();
    }
  }

  private async onInbound(sock: Socket): Promise<void> {
    const framer = new Framer(sock);
    try {
      const session = await SecureSession.respond(framer, this.o.identity);
      const host = (sock.remoteAddress ?? '?').replace(/^::ffff:/, '');
      this.addPeer(new Peer(session), host, undefined);
    } catch (err) {
      debug('inbound handshake failed:', String(err));
      framer.close();
    }
  }

  async connect(host: string, port: number): Promise<void> {
    const key = `${host}:${port}`;
    if (this.dialing.has(key)) return;
    this.dialing.add(key);
    try {
      const sock = await dial(host, port);
      const framer = new Framer(sock);
      const session = await SecureSession.initiate(framer, this.o.identity);
      this.addPeer(new Peer(session), host, port);
    } catch (err) {
      debug('connect failed', key, String(err));
    } finally {
      this.dialing.delete(key);
    }
  }

  private addPeer(peer: Peer, host: string, port: number | undefined): void {
    const fp = peer.fp;
    if (fp === this.fingerprint) {
      peer.close(); // connected to ourselves
      return;
    }
    if (this.peers.has(fp)) {
      peer.close(); // already connected (dedupe double-dial)
      return;
    }
    peer.endpoint = { host, port: port ?? 0 };
    const { isNew } = this.o.trust.record(fp);
    peer.firstSeen = isNew;
    this.peers.set(fp, peer);

    peer.send({ t: 'hello', nick: this.nick, rooms: [...this.rooms], port: this.o.port, ver: PROTOCOL_VERSION });
    peer.send({ t: 'peers', peers: this.gossipList(fp) });
    void this.pump(peer);
  }

  private gossipList(exceptFp: string): { host: string; port: number; fp: string }[] {
    const out: { host: string; port: number; fp: string }[] = [];
    for (const [fp, p] of this.peers) {
      if (fp === exceptFp || !p.endpoint || !p.endpoint.port) continue;
      out.push({ host: p.endpoint.host, port: p.endpoint.port, fp });
    }
    return out;
  }

  private async pump(peer: Peer): Promise<void> {
    try {
      for await (const msg of peer.messages()) this.handle(peer, msg);
    } catch (err) {
      debug('peer loop ended', String(err));
    }
    this.peers.delete(peer.fp);
    peer.close();
    this.emit('peer-disconnect', peer);
  }

  private handle(peer: Peer, msg: Message): void {
    switch (msg.t) {
      case 'hello':
        peer.nick = String(msg.nick).slice(0, 32);
        peer.rooms = new Set(Array.isArray(msg.rooms) ? msg.rooms : []);
        if (peer.endpoint && msg.port) peer.endpoint.port = msg.port;
        this.o.trust.record(peer.fp, peer.nick);
        this.emit('peer-connect', peer);
        break;
      case 'peers':
        if (this.o.autoConnect && Array.isArray(msg.peers)) {
          for (const p of msg.peers) {
            if (!p || p.fp === this.fingerprint || this.peers.has(p.fp)) continue;
            void this.connect(p.host, p.port);
          }
        }
        break;
      case 'chat': {
        if (!this.rooms.has(msg.room)) break;
        this.o.history.append({
          id: msg.id,
          room: msg.room,
          from: peer.nick,
          fp: peer.fp,
          body: msg.body,
          ts: msg.ts,
        });
        this.emit('chat', peer, msg);
        peer.send({ t: 'receipt', room: msg.room, ids: [msg.id], kind: 'delivered' });
        break;
      }
      case 'typing':
        this.emit('typing', peer, msg.room, !!msg.on);
        break;
      case 'receipt':
        this.emit('receipt', peer, msg);
        break;
      case 'join':
        peer.rooms.add(msg.room);
        this.emit('peer-room', peer, msg.room, true);
        break;
      case 'leave':
        peer.rooms.delete(msg.room);
        this.emit('peer-room', peer, msg.room, false);
        break;
      case 'ping':
        peer.send({ t: 'pong' });
        break;
      default:
        break;
    }
  }

  // ---- actions driven by the UI ----

  sendChat(room: string, body: string): ChatMsg {
    const msg: ChatMsg = { t: 'chat', id: bytesToHex(randomBytes(8)), room, body, ts: Date.now() };
    this.o.history.append({ id: msg.id, room, from: this.nick, fp: this.fingerprint, body, ts: msg.ts, self: true });
    for (const p of this.peers.values()) if (p.rooms.has(room)) p.send(msg);
    return msg;
  }

  setTyping(room: string, on: boolean): void {
    for (const p of this.peers.values()) if (p.rooms.has(room)) p.send({ t: 'typing', room, on });
  }

  sendRead(room: string, ids: string[]): void {
    if (!ids.length) return;
    for (const p of this.peers.values()) if (p.rooms.has(room)) p.send({ t: 'receipt', room, ids, kind: 'read' });
  }

  join(room: string): void {
    this.rooms.add(room);
    for (const p of this.peers.values()) p.send({ t: 'join', room });
  }

  leave(room: string): void {
    this.rooms.delete(room);
    for (const p of this.peers.values()) p.send({ t: 'leave', room });
  }

  setNick(nick: string): void {
    this.nick = nick;
    for (const p of this.peers.values())
      p.send({ t: 'hello', nick, rooms: [...this.rooms], port: this.o.port, ver: PROTOCOL_VERSION });
  }

  stop(): void {
    this.disco?.stop();
    for (const p of this.peers.values()) p.close();
    this.server?.close();
  }
}
