import { isMessage } from '../protocol/messages.js';
// A connected remote node: its secure session plus the mutable state we learn
// about it (nickname, which rooms it has joined, its advertised endpoint).
export class Peer {
    session;
    nick = '(unknown)';
    rooms = new Set();
    endpoint;
    firstSeen = false;
    constructor(session) {
        this.session = session;
    }
    get fp() {
        return this.session.peerFingerprint;
    }
    send(msg) {
        try {
            this.session.send(msg);
        }
        catch {
            /* socket gone; the receive loop will clean up */
        }
    }
    async *messages() {
        for (;;) {
            const m = await this.session.receive();
            if (m === null)
                return;
            if (isMessage(m))
                yield m;
        }
    }
    close() {
        this.session.framer.close();
    }
}
