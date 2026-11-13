// Crockford base32 (lowercase) — used for human-comparable fingerprints.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Group a string into space-separated blocks for readability (fingerprint display).
export function group(s: string, n = 4): string {
  const re = new RegExp(`.{1,${n}}`, 'g');
  return (s.match(re) ?? [s]).join(' ');
}
