import * as ROT from 'rot-js';

// Seeded randomness for a match, backed by rot.js's RNG (an Alea generator),
// so a table can be replayed from its seed and tests are deterministic.

type RotRng = ReturnType<typeof ROT.RNG.clone>;

export interface Rng {
  readonly seed: number;
  next(): number; // [0, 1)
  int(n: number): number; // [0, n)
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
  /** Run rot.js map generators (which use rot's global RNG) under this seed. */
  withRot<T>(fn: () => T): T;
}

export function makeRng(seed: number = Math.floor(Math.random() * 0x7fffffff)): Rng {
  const r: RotRng = ROT.RNG.clone();
  r.setSeed(seed);
  return {
    seed,
    next: () => r.getUniform(),
    int: (n) => Math.floor(r.getUniform() * n),
    chance: (p) => r.getUniform() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(r.getUniform() * items.length)]!,
    shuffle: <T>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(r.getUniform() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
    withRot: <T>(fn: () => T): T => {
      const saved = ROT.RNG.getState();
      ROT.RNG.setSeed(Math.floor(r.getUniform() * 0x7fffffff));
      try {
        return fn();
      } finally {
        ROT.RNG.setState(saved);
      }
    },
  };
}
