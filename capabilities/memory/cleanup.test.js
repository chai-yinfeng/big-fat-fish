import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCleanup } from './cleanup.js';

test('explicit pending cleanup stops writers, purges, acknowledges and restarts; failure stays pending', async () => {
  const actions = [], job = { id: 'job', memoryEpoch: 1 };
  let fail = false;
  const worker = new MemoryCleanup({
    operator: async (route, body) => {
      if (route === '/memory/cleanup/pending') return [job];
      if (route === '/world') return { world: { paused: true } };
      actions.push('ack'); assert.deepEqual(body.report, { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' });
    },
    stopExecution: async () => actions.push('stop'), startExecution: async () => actions.push('start'),
    purge: async () => { actions.push('purge'); if (fail) throw Error('synthetic private failure'); return { sdkPurged: true, localSourcesPurged: true }; },
  });
  assert.equal((await worker.runOnce()).completed, 1);
  assert.deepEqual(actions, ['stop', 'purge', 'ack', 'start']);
  actions.length = 0; fail = true;
  assert.equal((await worker.runOnce()).status, 'pending');
  assert.deepEqual(actions, ['stop', 'purge', 'start']);
});
