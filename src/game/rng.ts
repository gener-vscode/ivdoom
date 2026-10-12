/**
 * mulberry32 - tiny deterministic PRNG.
 * The state is stored inside the game state so a demo run can be replayed
 * exactly from its seed (useful for debugging physics/AI behaviour).
 */

type RngHost = { rngState: number };

export const random = (state: RngHost): number => {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const range = (state: RngHost, min: number, max: number): number => min + random(state) * (max - min);

export const intRange = (state: RngHost, min: number, max: number): number => Math.floor(range(state, min, max + 1));
