import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConversation, DEFAULT_EXECUTION_TIMEOUT_MS } from './executor.js';

test('text execution depends only on a duck-typed backend and passes scope, never a session ID', async () => {
  const calls = [];
  const executor = { execute: async request => { calls.push(request); return 'backend reply'; } };
  const request = { scope: { streamId: 'qq:1:private:2', memoryEpoch: 0 }, requestId: 'request-test', input: { text: 'literal input' } };
  assert.equal(await executeConversation(executor, request), 'backend reply');
  assert.deepEqual(calls, [{ ...request, timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS }]);
  assert.equal(Object.hasOwn(calls[0], 'sessionId'), false);
  await assert.rejects(executeConversation(executor, { ...request, scope: { streamId: 'qq:1:private:2' } }), /INVALID_EXECUTION_REQUEST/);
});
