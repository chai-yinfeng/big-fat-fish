/** When the bridge answers and how it spaces the messages of a reply. Every number here is a default; qq-bridge.json
 * may override any of them under an optional `pacing` object (checked by `pacingFrom`, the bridge refuses to start on a
 * bad value).
 * - burst*: messages of one person sent in quick succession are answered once. The bridge waits until the person has
 *   been quiet for `burstQuietMs` after their latest message, but no longer than `burstMaxWaitMs` after the first one of
 *   the burst; one reply covers at most `burstMaxMessages` messages.
 * - Her typing: a message of n characters takes `typePerCharMs` × n plus a random jitter in [0, gapJitterMs) to type
 *   (people type Chinese on a phone at about 1–2 characters a second).
 * - gap*: the pause before each message of a split reply after the first is the typing time of that message, plus
 *   `gapBaseMs` and `gapPerLogMs` × log(1 + n) (both 0 by default, kept so an older file stays valid), within
 *   [gapMinMs, gapMaxMs].
 * - read* / first*: the first message of a text reply to the person goes out once she could have read the person's
 *   messages (`readPerCharMs` × their characters, within [readMinMs, readMaxMs]) and typed it, within
 *   [firstMinMs, firstMaxMs], counted from the person's last message: the time the model took is not waited again.
 * - pokeCooldownMs: a poke (QQ 戳一戳) at her in one private conversation is taken at most once in this long; later
 *   ones are ignored. */
export const PACING = Object.freeze({
  burstQuietMs: 2500, burstMaxWaitMs: 8000, burstMaxMessages: 8,
  typePerCharMs: 250, gapBaseMs: 0, gapPerLogMs: 0, gapJitterMs: 1000, gapMinMs: 1500, gapMaxMs: 8000,
  readPerCharMs: 50, readMinMs: 1000, readMaxMs: 4000, firstMinMs: 0, firstMaxMs: 12000,
  pokeCooldownMs: 600000,
});
/** Allowed range of each setting (inclusive). */
const RANGES = {
  burstQuietMs: [0, 10000], burstMaxWaitMs: [0, 30000], burstMaxMessages: [1, 12],
  typePerCharMs: [0, 2000], gapBaseMs: [0, 10000], gapPerLogMs: [0, 5000], gapJitterMs: [0, 5000], gapMinMs: [0, 30000], gapMaxMs: [0, 30000],
  readPerCharMs: [0, 1000], readMinMs: [0, 10000], readMaxMs: [0, 10000], firstMinMs: [0, 30000], firstMaxMs: [0, 30000],
  pokeCooldownMs: [0, 86400000],
};
/** Fixed limits of one merged reply, from what the conversation executor accepts in one turn (12 media refs, each
 * picture or voice clip giving up to 2) and to keep its text well under the executor's limit. A single message beyond
 * them is still answered on its own. */
export const BURST_MAX_MEDIA = 6, BURST_MAX_CHARS = 4000;

/** The settings with qq-bridge.json's optional `pacing` overrides; throws on an unknown key or a value out of range. */
export function pacingFrom(overrides) {
  if (overrides === undefined) return PACING;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('QQ_CONFIG');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(RANGES, key) || !Number.isInteger(value) || value < RANGES[key][0] || value > RANGES[key][1]) throw new Error('QQ_CONFIG');
  }
  const pacing = { ...PACING, ...overrides };
  if (pacing.burstMaxWaitMs < pacing.burstQuietMs || pacing.gapMaxMs < pacing.gapMinMs || pacing.firstMaxMs < pacing.firstMinMs || pacing.readMaxMs < pacing.readMinMs) throw new Error('QQ_CONFIG');
  return Object.freeze(pacing);
}
const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
/** How long typing `text` takes her. `random` returns [0, 1). */
function typing(text, pacing, random) {
  return pacing.typePerCharMs * [...text].length + pacing.gapJitterMs * random();
}
/** Pause before a message of `text` that follows another message of the same reply. */
export function segmentGap(text, pacing = PACING, random = Math.random) {
  const raw = pacing.gapBaseMs + pacing.gapPerLogMs * Math.log1p([...text].length) + typing(text, pacing, random);
  return clamp(raw, pacing.gapMinMs, pacing.gapMaxMs);
}
/** Pause before the first message `text` of a text reply to messages of `readChars` characters in all, `elapsedMs`
 * after the last of them arrived: what is left of reading them and typing it; 0 when that time has passed. */
export function firstDelay(text, readChars, elapsedMs, pacing = PACING, random = Math.random) {
  const read = clamp(pacing.readPerCharMs * readChars, pacing.readMinMs, pacing.readMaxMs);
  const target = clamp(read + typing(text, pacing, random), pacing.firstMinMs, pacing.firstMaxMs);
  return Math.max(0, Math.round(target - Math.max(0, elapsedMs)));
}
