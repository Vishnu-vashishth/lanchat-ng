import * as ROT from 'rot-js';
export function makeRng(seed = Math.floor(Math.random() * 0x7fffffff)) {
    const r = ROT.RNG.clone();
    r.setSeed(seed);
    return {
        seed,
        next: () => r.getUniform(),
        int: (n) => Math.floor(r.getUniform() * n),
        chance: (p) => r.getUniform() < p,
        pick: (items) => items[Math.floor(r.getUniform() * items.length)],
        shuffle: (items) => {
            for (let i = items.length - 1; i > 0; i--) {
                const j = Math.floor(r.getUniform() * (i + 1));
                [items[i], items[j]] = [items[j], items[i]];
            }
            return items;
        },
        withRot: (fn) => {
            const saved = ROT.RNG.getState();
            ROT.RNG.setSeed(Math.floor(r.getUniform() * 0x7fffffff));
            try {
                return fn();
            }
            finally {
                ROT.RNG.setState(saved);
            }
        },
    };
}
