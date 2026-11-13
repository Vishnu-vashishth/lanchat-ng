import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { base32 } from '../util/base32.js';

// A node's long-term identity is an Ed25519 keypair. Trust is pinned to the
// fingerprint (a hash of the public key), never to an IP address — this is the
// core fix over the original Lanchat, which keyed trust to IPs.
export interface Identity {
  readonly idPk: Uint8Array; // 32-byte Ed25519 public key
  readonly idSk: Uint8Array; // 32-byte Ed25519 secret seed
  readonly fingerprint: string;
  sign(msg: Uint8Array): Uint8Array;
}

export function fingerprintOf(idPk: Uint8Array): string {
  // 256-bit digest -> 52 base32 chars. Shown to users to verify first contact.
  return base32(sha256(idPk));
}

export function verifySig(sig: Uint8Array, msg: Uint8Array, idPk: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, idPk);
  } catch {
    return false;
  }
}

function fromSeed(idSk: Uint8Array): Identity {
  const idPk = ed25519.getPublicKey(idSk);
  return {
    idPk,
    idSk,
    fingerprint: fingerprintOf(idPk),
    sign: (msg) => ed25519.sign(msg, idSk),
  };
}

export function createIdentity(): Identity {
  return fromSeed(ed25519.utils.randomSecretKey());
}

// Load the persisted identity seed, or create one and store it with 0600 perms.
export function loadOrCreateIdentity(path: string): Identity {
  if (existsSync(path)) {
    const seed = hexToBytes(readFileSync(path, 'utf8').trim());
    return fromSeed(seed);
  }
  const id = createIdentity();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytesToHex(id.idSk) + '\n', { mode: 0o600 });
  return id;
}
