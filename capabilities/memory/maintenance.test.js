import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryMaintenance } from './maintenance.js';

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^fish-memory-/); fs.rmSync(directory, { recursive: true }); });
  return new MemoryMaintenance({ stateFile: path.join(directory, 'progress.json'), ...options });
}
const batch = (mode, cursor = 3) => ({ entityId: 'entity:test', taskId: 'batch-' + mode + cursor, memoryEpoch: 0, cursor, world: { paused: false, worldNow: 1000 }, personaText: 'synthetic persona', items: [{ id: mode + cursor, text: mode + ' synthetic source', importance: 0.9 }] });

test('paused and empty batches cost no model calls; empty cursors advance', async t => {
  let calls = 0;
  const worker = fixture(t, { authority: { maintenanceBatch: async ({ mode }) => mode === 'private' ? { ...batch(mode), world: { paused: true } } : { ...batch(mode), items: [] } }, complete: async () => { calls++; } });
  await worker.runOnce();
  assert.equal(calls, 0);
  assert.equal(worker.state.cursors.private, 0);
  assert.equal(worker.state.cursors.public, 3);
});
test('private and public inputs stay separate and per-day budget defers without losing cursor', async t => {
  const prompts = [], written = [];
  const authority = { maintenanceBatch: async ({ mode, afterRevision }) => batch(mode, afterRevision + 1), writeDiary: async input => { written.push(input); return { cursor: 1, receipt: { status: input.kind === 'private' ? 'private' : 'draft' } }; } };
  const worker = fixture(t, { authority, maxCallsPerDay: 2, complete: async ({ messages }) => {
    prompts.push(messages); const { sources } = JSON.parse(messages[1].content);
    return { content: JSON.stringify({ text: 'synthetic diary', sourceIds: sources.map(s => s.id) }), usage: { prompt_tokens: 30, completion_tokens: 10 } };
  } });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(prompts.length, 2);
  assert.equal(JSON.stringify(prompts[0]).includes('public synthetic source'), false);
  assert.equal(JSON.stringify(prompts[1]).includes('private synthetic source'), false);
  assert.deepEqual(written.map(v => v.kind), ['private', 'public']);
  assert.equal(worker.state.cursors.private, 1); assert.equal(worker.state.cursors.public, 1);
  assert.equal(worker.status().status, 'budget_deferred');
  assert.equal(worker.status().inputTokens, 60);
  const stored = fs.readFileSync(worker.file, 'utf8');
  assert.equal(stored.includes('synthetic source'), false); assert.equal(stored.includes('synthetic diary'), false);
});
test('a model cannot introduce a source outside its batch and failed output still spends its reserved call', async t => {
  let writes = 0;
  const worker = fixture(t, { authority: { maintenanceBatch: async ({ mode }) => batch(mode), writeDiary: async () => { writes++; } }, complete: async () => ({ content: '{"text":"invented","sourceIds":["another-entity-source"]}' }) });
  await worker.runOnce();
  assert.equal(writes, 0); assert.equal(worker.state.cursors.private, 0);
  assert.equal(worker.status().calls, 1); assert.equal(worker.status().status, 'unavailable');
});
