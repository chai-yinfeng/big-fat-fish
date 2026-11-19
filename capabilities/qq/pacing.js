/** When the bridge answers and how it spaces the messages of a reply. Every number here is a default; qq-bridge.json
 * may override any of them under an optional `pacing` object (checked by `pacingFrom`, the bridge refuses to start on a
 * bad value).
 * - burst*: messages of one person sent in quick succession are answered once. The bridge waits until the person has
 *   been quiet for `burstQuietMs` after their latest message, but no longer than `burstMaxWaitMs` after the first one of
 *   the burst; one reply covers at most `burstMaxMessages` messages.
 * - gap*: the pause before each message of a split reply after the first grows with the log of that message's length,
 *   plus a random jitter, within [gapMinMs, gapMaxMs].
 * - first*: a random pause in [firstMinMs, firstMaxMs] before the first message of a text reply to the person. */
export const PACING = Object.freeze({
  burstQuietMs: 2500, burstMaxWaitMs: 8000, burstMaxMessages: 8,
  gapBaseMs: 500, gapPerLogMs: 450, gapJitterMs: 500, gapMinMs: 800, gapMaxMs: 3500,
  firstMinMs: 400, firstMaxMs: 1500,
});
/** Allowed range of each setting (inclusive). */
const RANGES = {
  burstQuietMs: [0, 10000], burstMaxWaitMs: [0, 30000], burstMaxMessages: [1, 12],
  gapBaseMs: [0, 10000], gapPerLogMs: [0, 5000], gapJitterMs: [0, 5000], gapMinMs: [0, 10000], gapMaxMs: [0, 10000],
  firstMinMs: [0, 5000], firstMaxMs: [0, 5000],
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
  if (pacing.burstMaxWaitMs < pacing.burstQuietMs || pacing.gapMaxMs < pacing.gapMinMs || pacing.firstMaxMs < pacing.firstMinMs) throw new Error('QQ_CONFIG');
  return Object.freeze(pacing);
}
/** Pause before a message of `text` that follows another message of the same reply. `random` returns [0, 1). */
export function segmentGap(text, pacing = PACING, random = Math.random) {
  const raw = pacing.gapBaseMs + pacing.gapPerLogMs * Math.log1p([...text].length) + pacing.gapJitterMs * random();
  return Math.round(Math.min(pacing.gapMaxMs, Math.max(pacing.gapMinMs, raw)));
}
/** Pause before the first message of a text reply. */
export function firstDelay(pacing = PACING, random = Math.random) {
  return Math.round(pacing.firstMinMs + (pacing.firstMaxMs - pacing.firstMinMs) * random());
}
