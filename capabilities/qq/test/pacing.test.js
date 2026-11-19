import test from 'node:test';
import assert from 'node:assert/strict';
import { PACING, pacingFrom, segmentGap, firstDelay } from '../pacing.js';

test('the defaults: 2.5 s quiet, 8 s at most, 8 messages a reply; pauses 0.8–3.5 s, first 0.4–1.5 s; one poke in 10 minutes', () => {
  assert.deepEqual(PACING, { burstQuietMs: 2500, burstMaxWaitMs: 8000, burstMaxMessages: 8, gapBaseMs: 500, gapPerLogMs: 450, gapJitterMs: 500, gapMinMs: 800, gapMaxMs: 3500, firstMinMs: 400, firstMaxMs: 1500, pokeCooldownMs: 600000 });
});

test('the pause before a following message grows with the log of its length, with jitter, within the bounds', () => {
  const at = (length, r) => segmentGap('字'.repeat(length), PACING, () => r);
  assert.deepEqual([1, 5, 10, 30, 60].map(length => at(length, 0)), [812, 1306, 1579, 2045, 2350]);
  assert.deepEqual([1, 60].map(length => at(length, 0.999)), [1311, 2849]);
  // Characters, not UTF-16 units; the floor and the ceiling hold.
  assert.equal(segmentGap('😀😀', PACING, () => 0), segmentGap('ab', PACING, () => 0));
  assert.equal(segmentGap('', PACING, () => 0), 800);
  assert.equal(segmentGap('x'.repeat(60), { ...PACING, gapPerLogMs: 5000 }, () => 0.9), 3500);
  for (let i = 0; i < 200; i++) { const gap = segmentGap('x'.repeat(i % 80), PACING); assert.ok(gap >= 800 && gap <= 3500, String(gap)); }
});

test('the pause before the first message is uniform between its bounds', () => {
  assert.deepEqual([0, 0.5, 0.999999].map(r => firstDelay(PACING, () => r)), [400, 950, 1500]);
});

test('qq-bridge.json pacing overrides: known keys, integers in range, consistent bounds; anything else refuses', () => {
  assert.equal(pacingFrom(undefined), PACING);
  assert.deepEqual(pacingFrom({ burstQuietMs: 0, gapMaxMs: 5000 }), { ...PACING, burstQuietMs: 0, gapMaxMs: 5000 });
  assert.deepEqual(pacingFrom({ pokeCooldownMs: 0 }), { ...PACING, pokeCooldownMs: 0 });
  for (const bad of [null, [], 'fast', { unknown: 1 }, { burstQuietMs: -1 }, { burstQuietMs: 1.5 }, { burstQuietMs: '2500' }, { burstMaxMessages: 0 }, { burstMaxMessages: 13 },
    { burstQuietMs: 9000 }, { gapMinMs: 4000 }, { firstMinMs: 2000 }, { pokeCooldownMs: -1 }, { pokeCooldownMs: 86400001 }, { pokeCooldownMs: '600000' }]) assert.throws(() => pacingFrom(bad), /QQ_CONFIG/, JSON.stringify(bad));
});
