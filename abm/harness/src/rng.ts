/**
 * Deterministic seeded RNG — never Math.random() anywhere in this
 * package. Reproducibility (abm_data_generator.md §15) means the same
 * (run_id, agent_id) always produces the same trace; a fresh run_id
 * produces a fresh trace.
 *
 * mulberry32: small, fast, good enough statistical quality for this use
 * case (sampling softmax choices and parameter draws) — not
 * cryptographic, doesn't need to be.
 */

export type Rng = () => number;

function hashStringToSeed(s: string): number {
  // FNV-1a, 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Returns a function producing uniform [0, 1) floats deterministically. */
export function mulberry32(seed: number): Rng {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One seeded RNG per agent, deterministic from (run_id, agent_id). */
export function rngForAgent(runId: string, agentId: string): Rng {
  return mulberry32(hashStringToSeed(`${runId}:${agentId}`));
}

/** Sample a value uniformly in [lo, hi). */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Weighted-random pick from parallel `items`/`weights` arrays (softmax sampling helper). */
export function weightedPick<T>(rng: Rng, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // degenerate case (e.g. all utilities exactly 0) — fall back to uniform
    return items[Math.floor(rng() * items.length)];
  }
  let x = rng() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}
