import test from 'node:test';
import assert from 'node:assert/strict';
import { PACING, pacingFrom, segmentGap, firstDelay } from '../pacing.js';

test('the defaults: 2.5 s quiet, 8 s at most, 8 messages a reply; typing 0.25 s a character, pauses 1.5–8 s; reading 0.05 s a character, 1–4 s, first at most 12 s; one poke in 10 minutes', () => {
  assert.deepEqual(PACING, { burstQuietMs: 2500, burstMaxWaitMs: 8000, burstMaxMessages: 8, typePerCharMs: 250, gapBaseMs: 0, gapPerLogMs: 0, gapJitterMs: 1000, gapMinMs: 1500, gapMaxMs: 8000,
    readPerCharMs: 50, readMinMs: 1000, readMaxMs: 4000, firstMinMs: 0, firstMaxMs: 12000, pokeCooldownMs: 600000 });
});

test('the pause before a following message is the time typing it takes, with jitter, within the bounds', () => {
  const at = (length, r) => segmentGap('字'.repeat(length), PACING, () => r);
  assert.deepEqual([1, 5, 10, 20, 40].map(length => at(length, 0)), [1500, 1500, 2500, 5000, 8000]);
  assert.deepEqual([1, 10, 20].map(length => at(length, 0.5)), [1500, 3000, 5500]);
  // Characters, not UTF-16 units; the floor and the ceiling hold; the older log term still counts when set.
  assert.equal(segmentGap('😀'.repeat(10), PACING, () => 0), segmentGap('ab'.repeat(5), PACING, () => 0));
  assert.equal(segmentGap('', PACING, () => 0), 1500);
  assert.equal(segmentGap('x'.repeat(10), { ...PACING, gapBaseMs: 100, gapPerLogMs: 1000 }, () => 0), Math.round(2500 + 100 + 1000 * Math.log1p(10)));
  for (let i = 0; i < 200; i++) { const gap = segmentGap('x'.repeat(i % 80), PACING); assert.ok(gap >= 1500 && gap <= 8000, String(gap)); }
});

test('the first message waits for reading the messages and typing it, less the time already gone, at most 12 s', () => {
  const first = (text, readChars, elapsed, r = 0) => firstDelay(text, readChars, elapsed, PACING, () => r);
  // Reading: 0.05 s a character within 1–4 s; typing: 0.25 s a character plus jitter.
  assert.deepEqual([0, 20, 40, 100].map(chars => first('字'.repeat(8), chars, 0)), [3000, 3000, 4000, 6000]);
  assert.equal(first('字'.repeat(8), 20, 0, 0.5), 3500);
  // The ceiling holds for the sum.
  assert.equal(first('字'.repeat(60), 200, 0, 0.9), 12000);
  // Time already gone since the person's last message (the model's own time) is not waited again; past the target: at once.
  assert.equal(first('字'.repeat(8), 20, 1200), 1800);
  assert.equal(first('字'.repeat(8), 20, 3000), 0);
  assert.equal(first('字'.repeat(8), 20, 60000), 0);
  // Overridden to nothing: no pause.
  assert.equal(firstDelay('字'.repeat(8), 20, 0, { ...PACING, firstMaxMs: 0 }, () => 0.5), 0);
});

test('qq-bridge.json pacing overrides: known keys, integers in range, consistent bounds; anything else refuses', () => {
  assert.equal(pacingFrom(undefined), PACING);
  assert.deepEqual(pacingFrom({ burstQuietMs: 0, gapMaxMs: 5000 }), { ...PACING, burstQuietMs: 0, gapMaxMs: 5000 });
  assert.deepEqual(pacingFrom({ pokeCooldownMs: 0 }), { ...PACING, pokeCooldownMs: 0 });
  for (const bad of [null, [], 'fast', { unknown: 1 }, { burstQuietMs: -1 }, { burstQuietMs: 1.5 }, { burstQuietMs: '2500' }, { burstMaxMessages: 0 }, { burstMaxMessages: 13 },
    { burstQuietMs: 9000 }, { gapMinMs: 9000 }, { firstMinMs: 13000 }, { readMinMs: 5000 }, { typePerCharMs: 2001 }, { pokeCooldownMs: -1 }, { pokeCooldownMs: 86400001 }, { pokeCooldownMs: '600000' }]) assert.throws(() => pacingFrom(bad), /QQ_CONFIG/, JSON.stringify(bad));
});
