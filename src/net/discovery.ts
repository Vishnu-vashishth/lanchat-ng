import dgram from 'node:dgram';

// Opt-in LAN peer discovery over UDP broadcast. OFF by default so the app does
// not announce its presence on the network. The datagram carries only a TCP
// port, a short fingerprint prefix and the rooms the node is in — no nickname,
// no identity key. Peers only auto-connect when they share a room.
const DISCO_MAGIC = 'LCNG-DISCO/1';

export type PeerFound = (
  host: string,
  tcpPort: number,
  fpShort: string,
  rooms: string[],
) => void;

export interface DiscoveryOptions {
  port: number;
  tcpPort: number;
  fpShort: string;
  rooms: string[];
  onPeer: PeerFound;
}

export class Discovery {
  private readonly sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  private timer: NodeJS.Timeout | undefined;

  private readonly o: DiscoveryOptions;

  constructor(o: DiscoveryOptions) {
    this.o = o;
  }

  start(): void {
    this.sock.on('message', (msg, rinfo) => {
      try {
        const o = JSON.parse(msg.toString('utf8')) as {
          m?: string;
          tcpPort?: number;
          fp?: string;
          rooms?: unknown;
        };
        if (o.m !== DISCO_MAGIC || typeof o.tcpPort !== 'number' || typeof o.fp !== 'string') return;
        if (o.fp === this.o.fpShort) return; // ignore our own announcements
        const rooms = Array.isArray(o.rooms) ? o.rooms.filter((r) => typeof r === 'string') : [];
        this.o.onPeer(rinfo.address, o.tcpPort, o.fp, rooms);
      } catch {
        /* ignore malformed datagrams */
      }
    });
    this.sock.on('error', () => this.stop());
    this.sock.bind(this.o.port, () => {
      try {
        this.sock.setBroadcast(true);
      } catch {
        /* ignore */
      }
      this.announce();
      this.timer = setInterval(() => this.announce(), 5000);
    });
  }

  private announce(): void {
    const payload = Buffer.from(
      JSON.stringify({ m: DISCO_MAGIC, tcpPort: this.o.tcpPort, fp: this.o.fpShort, rooms: this.o.rooms }),
    );
    this.sock.send(payload, this.o.port, '255.255.255.255', () => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }
}
