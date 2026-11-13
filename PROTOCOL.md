# lanchat-ng protocol

Version 1. Transport is TCP (default port 4040). Optional peer discovery is UDP
broadcast (default 4041).

## Primitives

- **Identity**: Ed25519 keypair. Fingerprint = Crockford-base32(SHA-256(pubkey)).
- **Key agreement**: X25519 (ephemeral, per connection → forward secrecy).
- **AEAD**: XChaCha20-Poly1305, 24-byte nonce = `16-byte per-direction salt || 64-bit big-endian counter`.
- **KDF**: HKDF-SHA-256.

## Framing

Every TCP payload is length-prefixed: `uint32 big-endian length || bytes`
(max 8 MiB). Handshake frames M1/M2 are plaintext; M3/M4 and all later frames
are AEAD ciphertexts.

## Handshake (station-to-station / signed ephemeral DH)

Initiator `I` dials, responder `R` listens.

```
M1  I -> R  (plain):  "LCNG" | ver(1) | I_ephPub(32) | nonceI(16)
M2  R -> I  (plain):  R_ephPub(32) | nonceR(16)

  dh         = X25519(ephSk, peerEphPub)
  transcript = SHA256("lanchat-ng/handshake/v1" | M1 | M2)
  K          = HKDF(ikm=dh, salt=transcript, info="lanchat-ng/keys/v1", len=96)
             = kI2R(32) | kR2I(32) | saltI2R(16) | saltR2I(16)
  confirm    = SHA256("lanchat-ng/confirm/v1" | transcript)

M3  R -> I  (enc kR2I, ctr 0):  R_idPub(32) | Ed25519(R, confirm)(64)
M4  I -> R  (enc kI2R, ctr 0):  I_idPub(32) | Ed25519(I, confirm)(64)
```

Each side verifies the peer's signature over `confirm` with the identity key the
peer just sent. The signature covers the transcript, which commits to **both**
ephemeral public keys — this binds identity to the session and prevents MITM.
The peer's fingerprint is then checked trust-on-first-use.

**Only the ephemeral public keys and nonces are ever in cleartext.** Long-term
identity keys, nicknames, room names, message bodies and all metadata are
encrypted (M3 onward).

After the handshake, each direction continues its AEAD counter from 1.

### Properties
- **Confidentiality + integrity**: XChaCha20-Poly1305 under keys only derivable from the ECDH secret.
- **Forward secrecy**: ephemeral X25519 per connection; secrets vanish on disconnect.
- **Mutual authentication**: Ed25519 signatures over the transcript.
- **Replay/reorder resistance**: strictly increasing per-direction counters; a decrypt failure tears down the session.

## Application messages

After the handshake, each frame's plaintext is a UTF-8 JSON object with a `t` tag:

| `t` | fields | meaning |
|---|---|---|
| `hello` | `nick, rooms[], port, ver` | identity/profile exchange (first message each way) |
| `peers` | `peers[]{host,port,fp}` | gossip: endpoints of the sender's other peers |
| `chat` | `id, room, body, ts` | a chat message |
| `typing` | `room, on` | typing indicator |
| `receipt` | `room, ids[], kind` | `delivered` (auto) or `read` (when focused) |
| `join` / `leave` | `room` | room membership change |
| `ping` / `pong` | — | liveness |

## Mesh

A newly connected peer is sent a `peers` list of the sender's other peers;
with auto-connect on, it dials unknown endpoints, so one introduction joins the
whole mesh. Peers are de-duplicated by fingerprint, and a node ignores its own
fingerprint.

## Discovery (opt-in)

UDP broadcast datagram: `{ "m": "LCNG-DISCO/1", "tcpPort": <n>, "fp": <12-char prefix> }`.
Carries no nickname or identity key. Off unless `--discovery` is passed.
