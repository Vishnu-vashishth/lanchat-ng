import type { SecureSession } from '../crypto/session.js';
import { isMessage, type Message } from '../protocol/messages.js';

// A connected remote node: its secure session plus the mutable state we learn
// about it (nickname, which rooms it has joined, its advertised endpoint).
export class Peer {
  nick = '(unknown)';
  rooms = new Set<string>();
  endpoint: { host: string; port: number } | undefined;
  firstSeen = false;

  constructor(public readonly session: SecureSession) {}

  get fp(): string {
    return this.session.peerFingerprint!;
  }

  send(msg: Message): void {
    try {
      this.session.send(msg);
    } catch {
      /* socket gone; the receive loop will clean up */
    }
  }

  async *messages(): AsyncGenerator<Message> {
    for (;;) {
      const m = await this.session.receive();
      if (m === null) return;
      if (isMessage(m)) yield m;
    }
  }

  close(): void {
    this.session.framer.close();
  }
}
