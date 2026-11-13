import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32, group } from '../src/util/base32.js';
import { isMessage } from '../src/protocol/messages.js';

test('base32 is deterministic and stays within the alphabet', () => {
  const b = new Uint8Array([0, 1, 2, 3, 4, 250, 255]);
  assert.equal(base32(b), base32(b));
  assert.match(base32(b), /^[0-9a-hjkmnp-tv-z]+$/);
});

test('group splits into space-separated blocks', () => {
  assert.equal(group('abcdefgh', 4), 'abcd efgh');
  assert.equal(group('abc', 4), 'abc');
});

test('isMessage guards on the discriminant', () => {
  assert.equal(isMessage({ t: 'chat' }), true);
  assert.equal(isMessage({}), false);
  assert.equal(isMessage(null), false);
  assert.equal(isMessage('chat'), false);
});
