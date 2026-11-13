import test from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, joinTranscripts, speechMs, transcriptSegments, CHUNK_SECONDS } from './chunks.js';

const rate = 100, sec = n => n * rate;

test('VAD regions are grouped in order into chunks of at most 25 s, keeping the pauses between them', () => {
  // Shaped like the 69 s benchmark clip: ten sentences of 2-15 s separated by short pauses.
  const regions = [[0.4, 3.4], [4.1, 6.0], [6.5, 12.6], [13.0, 19.2], [19.6, 34.6], [35.0, 38.1], [38.7, 40.7], [41.2, 47.3], [47.6, 53.8], [54.2, 69.2]].map(([a, b]) => [sec(a), sec(b)]);
  const chunks = planChunks(regions, sec(69.3), rate);
  assert.ok(chunks.every(c => c.end - c.start <= sec(CHUNK_SECONDS) && !c.overlapsPrevious));
  assert.ok(chunks.every((c, i) => i === 0 || c.start >= chunks[i - 1].end));
  assert.equal(chunks[0].start, sec(0.2)); assert.equal(chunks.at(-1).end, sec(69.3));
  // Every voiced sample is covered by exactly one chunk.
  for (const [a, b] of regions) assert.equal(chunks.filter(c => c.start <= a && b <= c.end).length, 1);
  assert.deepEqual(planChunks([], sec(40), rate), []);
});

test('a voiced region longer than 25 s is hard-split into windows with a 1 s overlap', () => {
  const chunks = planChunks([[0, sec(60)]], sec(60), rate);
  assert.deepEqual(chunks.map(c => [c.start / rate, c.end / rate, c.overlapsPrevious]), [[0, 25, false], [24, 49, true], [48, 60, true]]);
});

test('transcripts join in order; text repeated across a hard-split overlap is dropped once', () => {
  assert.equal(joinTranscripts([{ text: '今天好累啊。', overlapsPrevious: false }, { text: ' 哈哈，你也太可爱了吧！', overlapsPrevious: false }]), '今天好累啊。哈哈，你也太可爱了吧！');
  assert.equal(joinTranscripts([{ text: '回家路上还下雨了', overlapsPrevious: false }, { text: '下雨了，特别冷。', overlapsPrevious: true }]), '回家路上还下雨了，特别冷。');
  assert.equal(joinTranscripts([{ text: 'hello there', overlapsPrevious: false }, { text: '', overlapsPrevious: false }, { text: 'general kenobi', overlapsPrevious: false }]), 'hello there general kenobi');
  // Without an overlap the same words are genuine repetition and stay.
  assert.equal(joinTranscripts([{ text: '好的好的', overlapsPrevious: false }, { text: '好的', overlapsPrevious: false }]), '好的好的好的');
});

test('timed segments: one per chunk that added text, in ms, and together they are the joined transcript', () => {
  const parts = [
    { start: sec(0.2), end: sec(20.4), text: ' 回家路上还下雨了 ', overlapsPrevious: false },
    { start: sec(19.4), end: sec(44.4), text: '下雨了，特别冷。', overlapsPrevious: true },
    { start: sec(50), end: sec(52), text: '  ', overlapsPrevious: false },
    { start: sec(60), end: sec(61.5), text: 'hello', overlapsPrevious: false },
    { start: sec(70), end: sec(71), text: 'there', overlapsPrevious: false },
  ];
  const segments = transcriptSegments(parts, rate);
  assert.deepEqual(segments, [
    { startMs: 200, endMs: 20400, text: '回家路上还下雨了' },
    { startMs: 19400, endMs: 44400, text: '，特别冷。' },
    { startMs: 60000, endMs: 61500, text: 'hello' },
    { startMs: 70000, endMs: 71000, text: 'there' },
  ]);
  assert.equal(joinTranscripts(parts), '回家路上还下雨了，特别冷。hello there');
  assert.equal(joinTranscripts(segments.map(s => ({ text: s.text, overlapsPrevious: false }))), joinTranscripts(parts));
  assert.deepEqual(transcriptSegments([], rate), []);
  assert.equal(speechMs([[sec(0.4), sec(3.4)], [sec(4.1), sec(6)]], rate), 4900);
  assert.equal(speechMs([], rate), 0);
});
