/** Adapter contracts and zero-dependency defaults. */

import { systemLocalParts } from "./util.js";

export const SystemClock = {
  now: () => Date.now(),
  localParts: (now) => systemLocalParts(now),
};

export const MathRng = {
  next: () => Math.random(),
};

/** Default extractor: remembers only what was explicitly written. */
export const NullExtractor = {
  async extract() {
    return {};
  },
};

/**
 * @typedef {object} CompanionAdapters
 * @property {{ now: () => number, localParts: (now: number) => object }} clock
 * @property {{ next: () => number }} rng
 * @property {{ extract: (input: object) => Promise<object>|object }} [extractor]
 * @property {{ synthesize: (input: object) => Promise<object>|object }} [tts]
 * @property {{ transcribe: (input: object) => Promise<object>|object }} [asr]
 * @property {{ send: (input: object) => Promise<object>|object, presence?: () => string }} [transport]
 * @property {{ notify: (event: object) => void }} [ui]
 */

export function resolveClock(clock = SystemClock) {
  return {
    now: typeof clock.now === "function" ? clock.now : SystemClock.now,
    localParts: typeof clock.localParts === "function" ? clock.localParts : SystemClock.localParts,
  };
}

export function resolveRng(rng = MathRng) {
  if (typeof rng.next !== "function") throw new Error("rng.next() is required");
  return rng;
}
