import { readFeed, readTable, str } from './proto.js';
// The player side of a table: the latest roster/phase from the host, the
// latest frame for our seat, and the way back to the host for our inputs.
export class TableClient {
    gid;
    room;
    hostId;
    def;
    hosting;
    out;
    onFeed;
    table = null;
    frame = null;
    frameAt = 0;
    /** Set once the table is gone for us (closed, denied, host vanished). */
    closed = null;
    game;
    openedAt = Date.now();
    constructor(gid, room, hostId, def, hosting, out, onFeed) {
        this.gid = gid;
        this.room = room;
        this.hostId = hostId;
        this.def = def;
        this.hosting = hosting;
        this.out = out;
        this.onFeed = onFeed;
        this.game = def.client();
    }
    /** Apply a message from the host. */
    receive(msg) {
        switch (msg.op) {
            case 'table': {
                const t = readTable(msg.d);
                if (!t || t.kind !== this.def.id)
                    return;
                if (t.phase !== 'playing')
                    this.frame = null;
                this.table = t;
                break;
            }
            case 'frame':
                if (this.table?.phase !== 'playing')
                    return;
                this.frame = msg.d ?? null;
                this.frameAt = Date.now();
                break;
            case 'feed': {
                const f = readFeed(msg.d);
                if (f)
                    this.onFeed(f);
                break;
            }
            case 'deny':
            case 'close': {
                const d = msg.d && typeof msg.d === 'object' ? msg.d : {};
                this.closed = str(d.reason, 80) || (msg.op === 'deny' ? 'could not join' : 'the table was closed');
                break;
            }
            default:
                break;
        }
    }
    input(d) {
        if (d !== undefined && !this.closed)
            this.out('input', d);
    }
    resize(size) {
        if (!this.closed)
            this.out('size', size);
    }
    leave() {
        if (!this.closed)
            this.out('leave');
        this.closed = this.closed ?? 'left';
    }
}
