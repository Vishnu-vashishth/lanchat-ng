import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { base32 } from '../util/base32.js';
export function fingerprintOf(idPk) {
    // 256-bit digest -> 52 base32 chars. Shown to users to verify first contact.
    return base32(sha256(idPk));
}
export function verifySig(sig, msg, idPk) {
    try {
        return ed25519.verify(sig, msg, idPk);
    }
    catch {
        return false;
    }
}
function fromSeed(idSk) {
    const idPk = ed25519.getPublicKey(idSk);
    return {
        idPk,
        idSk,
        fingerprint: fingerprintOf(idPk),
        sign: (msg) => ed25519.sign(msg, idSk),
    };
}
export function createIdentity() {
    return fromSeed(ed25519.utils.randomSecretKey());
}
// Load the persisted identity seed, or create one and store it with 0600 perms.
export function loadOrCreateIdentity(path) {
    if (existsSync(path)) {
        const seed = hexToBytes(readFileSync(path, 'utf8').trim());
        return fromSeed(seed);
    }
    const id = createIdentity();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytesToHex(id.idSk) + '\n', { mode: 0o600 });
    return id;
}
