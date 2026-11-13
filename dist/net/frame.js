// Length-prefixed message framing over a TCP socket:
//   [uint32 big-endian length][payload]
// recvFrame() resolves the next whole frame, or null once the socket closes.
export class Framer {
    sock;
    maxLen;
    buffer = Buffer.alloc(0);
    queue = [];
    waiters = [];
    closed = false;
    constructor(sock, maxLen = 8 * 1024 * 1024) {
        this.sock = sock;
        this.maxLen = maxLen;
        sock.on('data', (d) => this.onData(typeof d === 'string' ? Buffer.from(d) : d));
        sock.on('close', () => this.onClose());
        sock.on('error', () => this.onClose());
    }
    get socket() {
        return this.sock;
    }
    onData(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length >= 4) {
            const len = this.buffer.readUInt32BE(0);
            if (len > this.maxLen) {
                this.sock.destroy();
                this.onClose();
                return;
            }
            if (this.buffer.length < 4 + len)
                break;
            const frame = Buffer.from(this.buffer.subarray(4, 4 + len));
            this.buffer = Buffer.from(this.buffer.subarray(4 + len));
            this.deliver(frame);
        }
    }
    deliver(frame) {
        const waiter = this.waiters.shift();
        if (waiter)
            waiter(frame);
        else
            this.queue.push(frame);
    }
    onClose() {
        if (this.closed)
            return;
        this.closed = true;
        for (const w of this.waiters.splice(0))
            w(null);
    }
    recvFrame() {
        const queued = this.queue.shift();
        if (queued)
            return Promise.resolve(queued);
        if (this.closed)
            return Promise.resolve(null);
        return new Promise((resolve) => this.waiters.push(resolve));
    }
    sendFrame(data) {
        if (this.closed)
            return;
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(data.length, 0);
        this.sock.write(Buffer.concat([header, Buffer.from(data)]));
    }
    close() {
        this.sock.destroy();
        this.onClose();
    }
}
