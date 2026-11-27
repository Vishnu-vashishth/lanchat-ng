import { EventEmitter } from 'node:events';
import { TableHost } from './host.js';
import { TableClient } from './client.js';
import { isGameMsg, readAd, type AdData, type FeedData, type GameMsg, type SizeData } from './proto.js';
import { gameById } from './registry.js';

// The bridge between the chat node and the games: tracks tables advertised in
// our rooms, hosts at most one table, sits at most one table, and routes game
// messages between peers and those tables.
//
// Events:
//   'ad'      (ad: Ad)        a new table was opened in one of our rooms
//   'change'  ()              anything the game screen shows changed
//   'feed'    (f: FeedData)   an event line for the table we are at

export interface HubPeer {
  readonly fp: string;
  nick: string;
  rooms: Set<string>;
}

export interface HubNode extends EventEmitter {
  readonly fingerprint: string;
  nick: string;
  readonly rooms: Set<string>;
  sendGame(fp: string, msg: GameMsg): void;
  broadcastGame(room: string, msg: GameMsg): void;
}

export interface Ad extends AdData {
  gid: string;
  room: string;
  hostId: string;
  seen: number;
}

export class GameHub extends EventEmitter {
  readonly ads = new Map<string, Ad>();
  hosted: TableHost | null = null;
  client: TableClient | null = null;

  constructor(private readonly node: HubNode) {
    super();
    node.on('game', (peer: HubPeer, msg: unknown) => this.onMessage(peer, msg));
    node.on('peer-disconnect', (peer: HubPeer) => this.onGone(peer));
    node.on('peer-connect', (peer: HubPeer) => {
      if (!this.hosted) return;
      this.hosted.rename(peer.fp, peer.nick);
      if (peer.rooms.has(this.hosted.room)) this.hosted.advertise(peer.fp);
    });
    node.on('peer-room', (peer: HubPeer, room: string, joined: boolean) => {
      if (joined) {
        if (this.hosted?.room === room) this.hosted.advertise(peer.fp);
        return;
      }
      if (this.hosted?.room === room) this.hosted.leave(peer.fp);
      for (const [gid, ad] of this.ads) if (ad.hostId === peer.fp && ad.room === room) this.ads.delete(gid);
      this.emit('change');
    });
  }

  /** Open tables in rooms we are in, newest first. */
  tables(): Ad[] {
    return [...this.ads.values()].filter((a) => this.node.rooms.has(a.room)).sort((a, b) => b.seen - a.seen);
  }

  private onMessage(peer: HubPeer, raw: unknown): void {
    if (!isGameMsg(raw)) return;
    const msg = raw;
    switch (msg.op) {
      case 'ad': {
        if (!this.node.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        const ad = readAd(msg.d);
        if (!ad) return;
        const prev = this.ads.get(msg.gid);
        if (prev && prev.hostId !== peer.fp) return; // someone else's table id
        const next: Ad = { ...ad, gid: msg.gid, room: msg.room, hostId: peer.fp, seen: prev?.seen ?? Date.now() };
        if (!prev) {
          // A peer hosts at most a few tables; cap what any one of them can make us remember.
          const theirs = [...this.ads.values()].filter((a) => a.hostId === peer.fp).sort((a, b) => a.seen - b.seen);
          if (theirs.length >= 3) this.ads.delete(theirs[0]!.gid);
        }
        this.ads.set(msg.gid, next);
        if (!prev) this.emit('ad', next);
        this.emit('change');
        return;
      }
      case 'close': {
        const ad = this.ads.get(msg.gid);
        if (ad && ad.hostId === peer.fp) this.ads.delete(msg.gid);
        if (this.client && this.client.gid === msg.gid && this.client.hostId === peer.fp) this.client.receive(msg);
        this.emit('change');
        return;
      }
      case 'join':
      case 'leave':
      case 'input':
      case 'size': {
        const h = this.hosted;
        if (!h || h.gid !== msg.gid || h.room !== msg.room) return;
        if (msg.op === 'join' && !peer.rooms.has(h.room)) {
          this.node.sendGame(peer.fp, { t: 'game', room: h.room, gid: h.gid, op: 'deny', d: { reason: `join #${h.room} first` } });
          return;
        }
        h.handle(peer.fp, peer.nick, msg);
        return;
      }
      case 'table':
      case 'frame':
      case 'feed':
      case 'deny': {
        const c = this.client;
        if (!c || c.gid !== msg.gid || c.hostId !== peer.fp) return;
        c.receive(msg);
        this.emit('change');
        return;
      }
      default:
        return;
    }
  }

  private onGone(peer: HubPeer): void {
    for (const [gid, ad] of this.ads) if (ad.hostId === peer.fp) this.ads.delete(gid);
    if (this.client && !this.client.hosting && this.client.hostId === peer.fp && !this.client.closed) {
      this.client.closed = `${peer.nick} (the host) disconnected`;
    }
    this.hosted?.leave(peer.fp);
    this.emit('change');
  }

  private feed = (f: FeedData): void => {
    this.emit('feed', f);
  };

  /** Open a new table in `room` and sit at it as host. */
  host(kind: string, room: string, size: SizeData): TableClient | null {
    const def = gameById(kind);
    if (!def) return null;
    this.leave();
    const selfId = this.node.fingerprint;
    const host = new TableHost(def, room, {
      selfId,
      send: (id, msg) => this.node.sendGame(id, msg),
      local: (msg) => {
        if (this.client && this.client.gid === msg.gid) {
          this.client.receive(msg);
          this.emit('change');
        }
      },
      advertise: (msg, to) => (to ? this.node.sendGame(to, msg) : this.node.broadcastGame(room, msg)),
    }, this.node.nick, size);
    this.hosted = host;
    this.client = new TableClient(host.gid, room, selfId, def, true, (op, d) => {
      if (op === 'input') host.input(selfId, d);
      else if (op === 'size') host.resize(selfId, d as SizeData);
      else if (op === 'leave') host.close('the host closed the table');
    }, this.feed);
    host.announce();
    return this.client;
  }

  /** Ask to sit at an advertised table. */
  join(gid: string, size: SizeData): TableClient | null {
    const ad = this.ads.get(gid);
    if (!ad) return null;
    const def = gameById(ad.kind);
    if (!def) return null;
    this.leave();
    const { room, hostId } = ad;
    this.client = new TableClient(gid, room, hostId, def, false, (op, d) => {
      this.node.sendGame(hostId, { t: 'game', room, gid, op, d });
    }, this.feed);
    this.node.sendGame(hostId, { t: 'game', room, gid, op: 'join', d: size });
    return this.client;
  }

  /** Leave (or, as host, close) whatever table we are at. */
  leave(): void {
    const c = this.client;
    this.client = null;
    if (c && !c.closed) c.leave();
    if (this.hosted) {
      this.hosted.close('the host closed the table');
      this.hosted = null;
    }
    this.emit('change');
  }

  stop(): void {
    this.leave();
  }
}
