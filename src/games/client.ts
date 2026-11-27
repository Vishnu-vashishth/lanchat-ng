import type { GameClient, GameDef } from './types.js';
import { readFeed, readTable, str, type FeedData, type GameMsg, type GameOp, type SizeData, type TableData } from './proto.js';

// The player side of a table: the latest roster/phase from the host, the
// latest frame for our seat, and the way back to the host for our inputs.

export class TableClient {
  table: TableData | null = null;
  frame: unknown = null;
  frameAt = 0;
  /** Set once the table is gone for us (closed, denied, host vanished). */
  closed: string | null = null;
  readonly game: GameClient;
  readonly openedAt = Date.now();

  constructor(
    readonly gid: string,
    readonly room: string,
    readonly hostId: string,
    readonly def: GameDef,
    readonly hosting: boolean,
    private readonly out: (op: GameOp, d?: unknown) => void,
    private readonly onFeed: (f: FeedData) => void,
  ) {
    this.game = def.client();
  }

  /** Apply a message from the host. */
  receive(msg: GameMsg): void {
    switch (msg.op) {
      case 'table': {
        const t = readTable(msg.d);
        if (!t || t.kind !== this.def.id) return;
        if (t.phase !== 'playing') this.frame = null;
        this.table = t;
        break;
      }
      case 'frame':
        if (this.table?.phase !== 'playing') return;
        this.frame = msg.d ?? null;
        this.frameAt = Date.now();
        break;
      case 'feed': {
        const f = readFeed(msg.d);
        if (f) this.onFeed(f);
        break;
      }
      case 'deny':
      case 'close': {
        const d = msg.d && typeof msg.d === 'object' ? (msg.d as Record<string, unknown>) : {};
        this.closed = str(d.reason, 80) || (msg.op === 'deny' ? 'could not join' : 'the table was closed');
        break;
      }
      default:
        break;
    }
  }

  input(d: unknown): void {
    if (d !== undefined && !this.closed) this.out('input', d);
  }

  resize(size: SizeData): void {
    if (!this.closed) this.out('size', size);
  }

  leave(): void {
    if (!this.closed) this.out('leave');
    this.closed = this.closed ?? 'left';
  }
}
