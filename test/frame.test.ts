import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Framer } from '../src/net/frame.js';
import { socketPair } from './helpers.js';

test('framer round-trips multiple frames and signals close with null', async () => {
  const [a, b] = await socketPair();
  const fa = new Framer(a);
  const fb = new Framer(b);

  fa.sendFrame(new Uint8Array([1, 2, 3]));
  fa.sendFrame(new Uint8Array(1000).fill(7));

  const first = await fb.recvFrame();
  assert.deepEqual([...first!], [1, 2, 3]);

  const second = await fb.recvFrame();
  assert.equal(second!.length, 1000);
  assert.equal(second![0], 7);

  fa.close();
  assert.equal(await fb.recvFrame(), null);
  fb.close();
});
