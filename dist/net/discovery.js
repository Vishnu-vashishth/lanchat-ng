import dgram from 'node:dgram';
// Opt-in LAN peer discovery over UDP broadcast. OFF by default so the app does
// not announce its presence on the network. The datagram carries only a TCP
// port and a short fingerprint prefix — no nickname, no identity key.
const DISCO_MAGIC = 'LCNG-DISCO/1';
export class Discovery {
    port;
    tcpPort;
    fpShort;
    onPeer;
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    timer;
    constructor(port, tcpPort, fpShort, onPeer) {
        this.port = port;
        this.tcpPort = tcpPort;
        this.fpShort = fpShort;
        this.onPeer = onPeer;
    }
    start() {
        this.sock.on('message', (msg, rinfo) => {
            try {
                const o = JSON.parse(msg.toString('utf8'));
                if (o.m !== DISCO_MAGIC || typeof o.tcpPort !== 'number' || typeof o.fp !== 'string')
                    return;
                if (o.fp === this.fpShort)
                    return; // ignore our own announcements
                this.onPeer(rinfo.address, o.tcpPort, o.fp);
            }
            catch {
                /* ignore malformed datagrams */
            }
        });
        this.sock.on('error', () => this.stop());
        this.sock.bind(this.port, () => {
            try {
                this.sock.setBroadcast(true);
            }
            catch {
                /* ignore */
            }
            this.announce();
            this.timer = setInterval(() => this.announce(), 5000);
        });
    }
    announce() {
        const payload = Buffer.from(JSON.stringify({ m: DISCO_MAGIC, tcpPort: this.tcpPort, fp: this.fpShort }));
        this.sock.send(payload, this.port, '255.255.255.255', () => { });
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        try {
            this.sock.close();
        }
        catch {
            /* already closed */
        }
    }
}
