import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSdkSession } from '../../../integrations/dsh/executor.js';

test('actual SDK absent projection creates once; an existing conversation is never recreated', async () => {
  let exists = false, creates = 0;
  const rpc = async (method, { request }) => {
    if (method === 'session/projections') return exists ? { kind: 'sequenced', asOfSeq: 0 } : undefined;
    assert.equal(method, 'session/create'); creates++; exists = true;
    return { sessionId: request.sessionId };
  };
  await ensureSdkSession(rpc, 'qq-test'); await ensureSdkSession(rpc, 'qq-test');
  assert.equal(creates, 1);
});
