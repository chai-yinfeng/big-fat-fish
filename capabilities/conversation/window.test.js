import test from 'node:test';
import assert from 'node:assert/strict';
import { fitActiveWindow, activeDialogue, ACTIVE_CONTEXT_CHARS, ACTIVE_CONTEXT_LOW_CHARS, WINDOW_MARKER } from './window.js';

const system = { role: 'system', content: 'prompt', timestamp: 0 };
const run = (n, size = 400) => [
  { role: 'user', content: [{ type: 'text', text: 'u' + n + 'x'.repeat(size) }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'c' + n, name: 'companion_scope', arguments: {} }], stopReason: 'toolUse' },
  { role: 'toolResult', toolCallId: 'c' + n, toolName: 'companion_scope', content: [{ type: 'text', text: 'r' + n }] },
  { role: 'assistant', content: [{ type: 'text', text: 'a' + n }], stopReason: 'stop' },
];

test('within budget the transcript is untouched', () => {
  const messages = [system, ...run(1), ...run(2)];
  assert.equal(fitActiveWindow(messages, 32000), messages);
});

test('old runs are dropped whole, so no tool call loses its result', () => {
  const messages = [system, ...run(1), ...run(2), ...run(3), ...run(4)];
  const fitted = fitActiveWindow(messages, 2700);
  assert.equal(fitted[0].content, 'prompt\n\n' + WINDOW_MARKER);
  assert.deepEqual(fitted.slice(1).filter(m => m.role === 'user').map(m => m.content[0].text.slice(0, 2)), ['u2', 'u3', 'u4']);
  const calls = fitted.flatMap(m => m.role === 'assistant' ? m.content.filter(b => b.type === 'toolCall').map(b => b.id) : []);
  const results = fitted.filter(m => m.role === 'toolResult').map(m => m.toolCallId);
  assert.deepEqual(calls, results);
});

test('the newest two completed runs and the current run are never sliced', () => {
  assert.throws(() => fitActiveWindow([system, ...run(1, 2000), ...run(2, 2000), ...run(3, 2000)], 4000), { code: 'ACTIVE_CONTEXT_LIMIT' });
});

test('trimming is batched: one cut down to the low-water mark, then the cut stays until the window overflows again', () => {
  const limit = 6000, low = 3000, transcript = [system], requests = [];
  const size = messages => messages.filter(m => m.role !== 'system').reduce((total, m) => total + JSON.stringify(m).length, 0);
  const firstKept = fitted => Number(fitted.find(m => m.role === 'user').content[0].text.match(/^u(\d+)/)[1]);
  const from = (messages, n) => messages.slice(messages.findIndex(m => m.role === 'user' && m.content[0].text.startsWith('u' + n + 'x')));
  for (let n = 1; n <= 40; n++) {
    const [user, ...answer] = run(n, 300 + (n * 37) % 200);
    // The request for run n is sent with only its user message; the stored transcript then gains the answer.
    transcript.push(user);
    const fitted = fitActiveWindow(transcript, limit, low);
    assert.ok(size(fitted) + (fitted === transcript ? 0 : WINDOW_MARKER.length) <= limit);
    assert.deepEqual(fitActiveWindow([...transcript], limit, low), fitted, 'the same transcript always gives the same cut');
    requests.push({ n, cut: firstKept(fitted), sent: [...transcript], kept: size(fitted) - JSON.stringify(user).length });
    transcript.push(...answer);
  }
  const moves = requests.filter((request, i) => i > 0 && request.cut !== requests[i - 1].cut);
  // Consecutive requests share their cut; it moved a handful of times in 40 runs (one run at a time would move it on every run).
  assert.ok(moves.length >= 3 && moves.length <= 13, `moved ${moves.length} times`);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].n - moves[i - 1].n >= 3, `cuts at runs ${moves[i - 1].n} and ${moves[i].n}`);
  for (const move of moves) {
    const previous = requests[move.n - 2];
    // It moved only because keeping the previous cut would have overflowed, by several runs, down to the low-water mark.
    assert.ok(size(from(move.sent, previous.cut)) + (previous.cut > 1 ? WINDOW_MARKER.length : 0) > limit, `run ${move.n}`);
    assert.ok(move.cut - previous.cut >= 2);
    // (The mark is measured without the run that was newest when the cut was made: this one or the one before.)
    assert.ok(move.kept - size(from(move.sent, move.n - 1).slice(0, -1)) + WINDOW_MARKER.length <= low);
  }
});

test('a batch cut never reaches into the newest two completed runs', () => {
  // Three large runs: getting under the low-water mark would need to drop protected runs, so only the oldest goes.
  const fitted = fitActiveWindow([system, ...run(1, 900), ...run(2, 900), ...run(3, 900), ...run(4, 900)], 4500, 1000);
  assert.deepEqual(fitted.filter(m => m.role === 'user').map(m => m.content[0].text.slice(0, 2)), ['u2', 'u3', 'u4']);
});

test('default marks: above 16000 characters one cut brings the earlier runs down to 8000', () => {
  assert.deepEqual([ACTIVE_CONTEXT_CHARS, ACTIVE_CONTEXT_LOW_CHARS], [16000, 8000]);
  const size = messages => messages.filter(m => m.role !== 'system').reduce((total, m) => total + JSON.stringify(m).length, 0);
  const transcript = [system];
  let n = 0;
  while (size(transcript) <= ACTIVE_CONTEXT_CHARS) {
    assert.equal(fitActiveWindow(transcript), transcript, 'nothing is cut up to the high-water mark');
    transcript.push(...run(++n, 700));
  }
  const fitted = fitActiveWindow(transcript), kept = fitted.slice(1), newest = run(n, 700);
  assert.ok(fitted[0].content.endsWith(WINDOW_MARKER));
  assert.ok(size(kept) - size(newest) + WINDOW_MARKER.length <= ACTIVE_CONTEXT_LOW_CHARS);
  // Not more than needed: one more run would have been above the low-water mark.
  assert.ok(size(kept) - size(newest) + size(run(1, 700)) + WINDOW_MARKER.length > ACTIVE_CONTEXT_LOW_CHARS);
  assert.deepEqual(activeDialogue(transcript), kept);
  // A custom limit keeps the same proportion.
  assert.deepEqual(fitActiveWindow(transcript, 6000), fitActiveWindow(transcript, 6000, 3000));
});

test('persona change: the first run under a new revision keeps two earlier runs; runs without a record never cut', () => {
  const at = (n, personaRevision) => { const [user, ...rest] = run(n, 100); return [{ ...user, ...(personaRevision === undefined ? {} : { hub: { personaRevision, memoryIds: [] } }) }, ...rest]; };
  const first = messages => messages.find(m => m.role === 'user').content[0].text.slice(0, 2);
  const old = [system, ...at(1, 7), ...at(2, 7), ...at(3, 7), ...at(4, 7)];
  assert.equal(fitActiveWindow(old, 32000), old);
  // Request time (only the user message of the new run) and after it was stored: the same cut.
  const [user5, ...answer5] = at(5, 8);
  for (const messages of [[...old, user5], [...old, user5, ...answer5], [...old, user5, ...answer5, ...at(6, 8), ...at(7, 8)]]) {
    const fitted = fitActiveWindow(messages, 32000);
    assert.equal(first(fitted), 'u3');
    assert.ok(fitted[0].content.endsWith(WINDOW_MARKER));
  }
  // A second change cuts again, relative to the run that saw it.
  assert.equal(first(fitActiveWindow([...old, ...at(5, 8), ...at(6, 8), ...at(7, 8), ...at(8, 9)], 32000)), 'u6');
  // Lines of the previous release carry no revision: they neither cut nor hide a later change.
  const legacy = [system, ...at(1), ...at(2), ...at(3), ...at(4, 7), ...at(5)];
  assert.equal(fitActiveWindow(legacy, 32000), legacy);
  assert.equal(first(fitActiveWindow([...legacy, ...at(6, 8)], 32000)), 'u4');
  // With one or two earlier runs there is nothing to cut.
  const short = [system, ...at(1, 7), ...at(2, 7), ...at(3, 8)];
  assert.equal(fitActiveWindow(short, 32000), short);
});
