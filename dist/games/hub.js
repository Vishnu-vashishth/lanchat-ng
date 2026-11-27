import { EventEmitter } from 'node:events';
import { TableHost } from './host.js';
import { TableClient } from './client.js';
import { isGameMsg, readAd } from './proto.js';
import { gameById } from './registry.js';
export class GameHub extends EventEmitter {
    node;
    ads = new Map();
    hosted = null;
    client = null;
    constructor(node) {
        super();
        this.node = node;
        node.on('game', (peer, msg) => this.onMessage(peer, msg));
        node.on('peer-disconnect', (peer) => this.onGone(peer));
        node.on('peer-connect', (peer) => {
            if (!this.hosted)
                return;
            this.hosted.rename(peer.fp, peer.nick);
            if (peer.rooms.has(this.hosted.room))
                this.hosted.advertise(peer.fp);
        });
        node.on('peer-room', (peer, room, joined) => {
            if (joined) {
                if (this.hosted?.room === room)
                    this.hosted.advertise(peer.fp);
                return;
            }
            if (this.hosted?.room === room)
                this.hosted.leave(peer.fp);
            for (const [gid, ad] of this.ads)
                if (ad.hostId === peer.fp && ad.room === room)
                    this.ads.delete(gid);
            this.emit('change');
        });
    }
    /** Open tables in rooms we are in, newest first. */
    tables() {
        return [...this.ads.values()].filter((a) => this.node.rooms.has(a.room)).sort((a, b) => b.seen - a.seen);
    }
    onMessage(peer, raw) {
        if (!isGameMsg(raw))
            return;
        const msg = raw;
        switch (msg.op) {
            case 'ad': {
                if (!this.node.rooms.has(msg.room) || !peer.rooms.has(msg.room))
                    return;
                const ad = readAd(msg.d);
                if (!ad)
                    return;
                const prev = this.ads.get(msg.gid);
                if (prev && prev.hostId !== peer.fp)
                    return; // someone else's table id
                const next = { ...ad, gid: msg.gid, room: msg.room, hostId: peer.fp, seen: prev?.seen ?? Date.now() };
                if (!prev) {
                    // A peer hosts at most a few tables; cap what any one of them can make us remember.
                    const theirs = [...this.ads.values()].filter((a) => a.hostId === peer.fp).sort((a, b) => a.seen - b.seen);
                    if (theirs.length >= 3)
                        this.ads.delete(theirs[0].gid);
                }
                this.ads.set(msg.gid, next);
                if (!prev)
                    this.emit('ad', next);
                this.emit('change');
                return;
            }
            case 'close': {
                const ad = this.ads.get(msg.gid);
                if (ad && ad.hostId === peer.fp)
                    this.ads.delete(msg.gid);
                if (this.client && this.client.gid === msg.gid && this.client.hostId === peer.fp)
                    this.client.receive(msg);
                this.emit('change');
                return;
            }
            case 'join':
            case 'leave':
            case 'input':
            case 'size': {
                const h = this.hosted;
                if (!h || h.gid !== msg.gid || h.room !== msg.room)
                    return;
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
                if (!c || c.gid !== msg.gid || c.hostId !== peer.fp)
                    return;
                c.receive(msg);
                this.emit('change');
                return;
            }
            default:
                return;
        }
    }
    onGone(peer) {
        for (const [gid, ad] of this.ads)
            if (ad.hostId === peer.fp)
                this.ads.delete(gid);
        if (this.client && !this.client.hosting && this.client.hostId === peer.fp && !this.client.closed) {
            this.client.closed = `${peer.nick} (the host) disconnected`;
        }
        this.hosted?.leave(peer.fp);
        this.emit('change');
    }
    feed = (f) => {
        this.emit('feed', f);
    };
    /** Open a new table in `room` and sit at it as host. */
    host(kind, room, size) {
        const def = gameById(kind);
        if (!def)
            return null;
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
            if (op === 'input')
                host.input(selfId, d);
            else if (op === 'size')
                host.resize(selfId, d);
            else if (op === 'leave')
                host.close('the host closed the table');
        }, this.feed);
        host.announce();
        return this.client;
    }
    /** Ask to sit at an advertised table. */
    join(gid, size) {
        const ad = this.ads.get(gid);
        if (!ad)
            return null;
        const def = gameById(ad.kind);
        if (!def)
            return null;
        this.leave();
        const { room, hostId } = ad;
        this.client = new TableClient(gid, room, hostId, def, false, (op, d) => {
            this.node.sendGame(hostId, { t: 'game', room, gid, op, d });
        }, this.feed);
        this.node.sendGame(hostId, { t: 'game', room, gid, op: 'join', d: size });
        return this.client;
    }
    /** Leave (or, as host, close) whatever table we are at. */
    leave() {
        const c = this.client;
        this.client = null;
        if (c && !c.closed)
            c.leave();
        if (this.hosted) {
            this.hosted.close('the host closed the table');
            this.hosted = null;
        }
        this.emit('change');
    }
    stop() {
        this.leave();
    }
}
