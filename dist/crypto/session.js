import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { fingerprintOf, verifySig } from './identity.js';
// -----------------------------------------------------------------------------
// Secure session: an authenticated, forward-secret channel over a TCP framer.
//
// Handshake (station-to-station / signed ephemeral DH):
//   M1  I -> R  (plain):  MAGIC | VER | iEphPub(32) | nonceI(16)
//   M2  R -> I  (plain):  rEphPub(32) | nonceR(16)
//     both derive  dh = X25519(eph, eph);  T = SHA256(label | M1 | M2)
//     keys = HKDF(dh, salt=T) -> kI2R | kR2I | saltI2R | saltR2I
//   M3  R -> I  (enc kR2I): rIdPub(32) | sigR(64)     // responder authenticates
//   M4  I -> R  (enc kI2R): iIdPub(32) | sigI(64)     // initiator authenticates
//     sig = Ed25519(SHA256(confirmCtx | T))  bound to both ephemeral keys
//
// Only ephemeral public keys ever appear in cleartext. Long-term identities,
// nicknames, rooms, message bodies — everything else — are encrypted.
// -----------------------------------------------------------------------------
const MAGIC = utf8ToBytes('LCNG');
const VERSION = 1;
const HS_LABEL = utf8ToBytes('lanchat-ng/handshake/v1');
const KDF_INFO = utf8ToBytes('lanchat-ng/keys/v1');
const CONFIRM_CTX = utf8ToBytes('lanchat-ng/confirm/v1');
const M1_LEN = 4 + 1 + 32 + 16;
const M2_LEN = 32 + 16;
export class HandshakeError extends Error {
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a[i] ^ b[i];
    return d === 0;
}
// 24-byte XChaCha nonce = 16-byte per-direction salt | 64-bit big-endian counter.
function makeNonce(salt, counter) {
    const n = new Uint8Array(24);
    n.set(salt, 0);
    new DataView(n.buffer).setBigUint64(16, counter, false);
    return n;
}
export class SecureSession {
    framer;
    sendKey;
    sendSalt;
    recvKey;
    recvSalt;
    sendCtr = 0n;
    recvCtr = 0n;
    peerIdPk = null;
    peerFingerprint = null;
    constructor(framer, sendKey, sendSalt, recvKey, recvSalt) {
        this.framer = framer;
        this.sendKey = sendKey;
        this.sendSalt = sendSalt;
        this.recvKey = recvKey;
        this.recvSalt = recvSalt;
    }
    /** AEAD-seal a plaintext with the next outbound counter. */
    seal(plaintext) {
        const nonce = makeNonce(this.sendSalt, this.sendCtr);
        const ct = xchacha20poly1305(this.sendKey, nonce).encrypt(plaintext);
        this.sendCtr++;
        return ct;
    }
    /** AEAD-open a ciphertext with the next inbound counter. Throws on tamper. */
    open(ciphertext) {
        const nonce = makeNonce(this.recvSalt, this.recvCtr);
        const pt = xchacha20poly1305(this.recvKey, nonce).decrypt(ciphertext);
        this.recvCtr++;
        return pt;
    }
    /** Encrypt and frame a JSON message. */
    send(obj) {
        this.framer.sendFrame(this.seal(utf8ToBytes(JSON.stringify(obj))));
    }
    /** Receive, decrypt and parse the next JSON message (null when closed). */
    async receive() {
        const ct = await this.framer.recvFrame();
        if (ct === null)
            return null;
        const pt = this.open(ct);
        return JSON.parse(Buffer.from(pt).toString('utf8'));
    }
    setPeer(idPk) {
        this.peerIdPk = idPk;
        this.peerFingerprint = fingerprintOf(idPk);
    }
    static deriveKeys(dh, transcript) {
        const km = hkdf(sha256, dh, transcript, KDF_INFO, 96);
        return {
            kI2R: km.subarray(0, 32),
            kR2I: km.subarray(32, 64),
            sI2R: km.subarray(64, 80),
            sR2I: km.subarray(80, 96),
        };
    }
    /** Dialer side of the handshake. */
    static async initiate(framer, id) {
        const eSk = randomBytes(32);
        const ePk = x25519.getPublicKey(eSk);
        const nonceI = randomBytes(16);
        const m1 = concatBytes(MAGIC, Uint8Array.of(VERSION), ePk, nonceI);
        framer.sendFrame(m1);
        const m2 = await framer.recvFrame();
        if (!m2 || m2.length !== M2_LEN)
            throw new HandshakeError('bad M2');
        const rEphPk = m2.subarray(0, 32);
        const dh = x25519.getSharedSecret(eSk, rEphPk);
        const transcript = sha256(concatBytes(HS_LABEL, m1, m2));
        const k = SecureSession.deriveKeys(dh, transcript);
        const sess = new SecureSession(framer, k.kI2R, k.sI2R, k.kR2I, k.sR2I);
        const confirm = sha256(concatBytes(CONFIRM_CTX, transcript));
        // M3: responder authenticates first.
        const m3 = await framer.recvFrame();
        if (!m3)
            throw new HandshakeError('no M3');
        const p3 = sess.open(m3);
        if (p3.length !== 96)
            throw new HandshakeError('bad M3');
        const rIdPk = p3.subarray(0, 32);
        const sigR = p3.subarray(32, 96);
        if (!verifySig(sigR, confirm, rIdPk))
            throw new HandshakeError('responder signature invalid');
        // M4: initiator authenticates.
        framer.sendFrame(sess.seal(concatBytes(id.idPk, id.sign(confirm))));
        sess.setPeer(rIdPk);
        return sess;
    }
    /** Listener side of the handshake. */
    static async respond(framer, id) {
        const m1 = await framer.recvFrame();
        if (!m1 || m1.length !== M1_LEN)
            throw new HandshakeError('bad M1');
        if (!bytesEqual(m1.subarray(0, 4), MAGIC))
            throw new HandshakeError('bad magic');
        if (m1[4] !== VERSION)
            throw new HandshakeError('version mismatch');
        const iEphPk = m1.subarray(5, 37);
        const eSk = randomBytes(32);
        const ePk = x25519.getPublicKey(eSk);
        const nonceR = randomBytes(16);
        const m2 = concatBytes(ePk, nonceR);
        framer.sendFrame(m2);
        const dh = x25519.getSharedSecret(eSk, iEphPk);
        const transcript = sha256(concatBytes(HS_LABEL, m1, m2));
        const k = SecureSession.deriveKeys(dh, transcript);
        const sess = new SecureSession(framer, k.kR2I, k.sR2I, k.kI2R, k.sI2R);
        const confirm = sha256(concatBytes(CONFIRM_CTX, transcript));
        // M3: responder authenticates first.
        framer.sendFrame(sess.seal(concatBytes(id.idPk, id.sign(confirm))));
        // M4: initiator authenticates.
        const m4 = await framer.recvFrame();
        if (!m4)
            throw new HandshakeError('no M4');
        const p4 = sess.open(m4);
        if (p4.length !== 96)
            throw new HandshakeError('bad M4');
        const iIdPk = p4.subarray(0, 32);
        const sigI = p4.subarray(32, 96);
        if (!verifySig(sigI, confirm, iIdPk))
            throw new HandshakeError('initiator signature invalid');
        sess.setPeer(iIdPk);
        return sess;
    }
}
