import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConversation, DEFAULT_EXECUTION_TIMEOUT_MS } from './executor.js';

test('text execution depends only on a duck-typed backend and preserves its execution envelope', async () => {
  const calls = [];
  const executor = { execute: async request => { calls.push(request); return 'backend reply'; } };
  const request = { sessionId: 'conversation-test', requestId: 'request-test', text: 'literal input' };
  assert.equal(await executeConversation(executor, request), 'backend reply');
  assert.deepEqual(calls, [{ ...request, timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS }]);
  assert.equal(Object.hasOwn(calls[0], 'rpc'), false);
});
