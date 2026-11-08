import test from 'node:test';
import assert from 'node:assert/strict';
import { fitActiveWindow, WINDOW_MARKER } from './window.js';

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
