import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Framer } from '../src/net/frame.js';
import { SecureSession } from '../src/crypto/session.js';
import { createIdentity } from '../src/crypto/identity.js';
import { socketPair } from './helpers.js';

test('handshake authenticates both identities and opens a 2-way channel', async () => {
  const [c, s] = await socketPair();
  const idI = createIdentity();
  const idR = createIdentity();
  const fc = new Framer(c);
  const fs = new Framer(s);

  const [sessI, sessR] = await Promise.all([
    SecureSession.initiate(fc, idI),
    SecureSession.respond(fs, idR),
  ]);

  // Each side learned the other's real fingerprint via signed handshake.
  assert.equal(sessI.peerFingerprint, idR.fingerprint);
  assert.equal(sessR.peerFingerprint, idI.fingerprint);

  // Encrypted messages flow in both directions.
  sessI.send({ t: 'chat', body: 'from initiator' });
  assert.deepEqual(await sessR.receive(), { t: 'chat', body: 'from initiator' });
  sessR.send({ t: 'chat', body: 'from responder' });
  assert.deepEqual(await sessI.receive(), { t: 'chat', body: 'from responder' });

  fc.close();
  fs.close();
});

test('tampered ciphertext is rejected', async () => {
  const [c, s] = await socketPair();
  const fc = new Framer(c);
  const fs = new Framer(s);
  const [sessI, sessR] = await Promise.all([
    SecureSession.initiate(fc, createIdentity()),
    SecureSession.respond(fs, createIdentity()),
  ]);

  const ct = sessI.seal(new TextEncoder().encode('top secret'));
  const tampered = Uint8Array.from(ct);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => sessR.open(tampered));

  // The untampered ciphertext still opens correctly at the same counter.
  assert.equal(new TextDecoder().decode(sessR.open(ct)), 'top secret');

  fc.close();
  fs.close();
});
