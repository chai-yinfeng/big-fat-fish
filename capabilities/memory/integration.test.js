import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../../authority/src/engine.js';
import { AuthorityClient } from '../../authority/src/client.js';
import { createAuthorityServer } from '../../authority/src/server.js';
import { createModelGateway } from '../../model-gateway/server.mjs';
import { MemoryMaintenance } from './maintenance.js';
import { completeDiary } from './model-client.js';

test('accepted incremental memories cross real UDS/gateway into a private diary without reprocessing or public leakage', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-flow-'));
  const authority = new Authority({ file: path.join(dir, 'core.sqlite'), clock: () => 100000 });
  authority.registerCapability({ id: 'source', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'source', externalActorId: 'owner', personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'source', streamId: 'private', personId: 'person:owner', audience: 'private' });
  for (const [index, value] of ['清淡的茶', '傍晚散步'].entries()) {
    const input = { eventId: 'event-' + index, streamId: 'private', actorId: 'owner', role: 'user', text: '我喜欢' + value, at: 1000 + index };
    const observed = authority.observe('source', input);
    authority.submit('source', { proposalId: 'proposal-' + index, observationId: observed.observationId, type: 'fact.report', payload: { key: 'preference-' + index, value, quote: input.text } });
  }
  authority.processPending();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const maintenanceToken = 'synthetic-maintenance-token-not-a-real-credential', inferenceToken = 'synthetic-inference-token';
  const coreSocket = path.join(dir, 'core.sock'), inferenceSocket = path.join(dir, 'infer.sock');
  const tokenFile = path.join(dir, 'maintenance.token'), inferenceTokenFile = path.join(dir, 'inference.token');
  fs.writeFileSync(tokenFile, maintenanceToken, { mode: 0o600 }); fs.writeFileSync(inferenceTokenFile, inferenceToken, { mode: 0o600 });
  const server = createAuthorityServer({ authority, socketPath: coreSocket, credentials: [{ hash: hash(maintenanceToken), role: 'maintenance', entityId: DEFAULT_ENTITY_ID }] });
  const settingsFile = path.join(dir, 'model.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-provider-key', status: 'configured' }), { mode: 0o600 });
  let calls = 0;
  const gateway = createModelGateway({ settingsFile, inferenceSocket, controlSocket: path.join(dir, 'control.sock'), inferenceTokenHash: hash(inferenceToken), operatorTokenHash: hash('synthetic-operator'), worldStatus: async () => authority.worldStatus(), fetchImpl: async (_url, options) => {
    calls++; const request = JSON.parse(options.body), data = JSON.parse(request.messages[1].content);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.equal(request.tools, undefined); assert.equal(request.max_tokens, 600);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '记下这两项偏好，感想：以后可以更贴心。', sourceIds: data.sources.map(s => s.id) }) } }], usage: { prompt_tokens: 90, completion_tokens: 40 } }));
  } });
  t.after(async () => { await gateway.close(); await server.close(); authority.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^fish-memory-flow-/); fs.rmSync(dir, { recursive: true }); });
  await server.start(); await gateway.start();
  const client = new AuthorityClient({ socketPath: coreSocket, tokenFile });
  const admitted = await client.maintenanceBatch({ afterRevision: 0, limit: 16, mode: 'private' });
  assert.equal(admitted.items.length, 2);
  const worker = new MemoryMaintenance({ authority: client, complete: completeDiary({ socketPath: inferenceSocket, tokenFile: inferenceTokenFile }), stateFile: path.join(dir, 'progress.json') });
  await worker.runOnce();
  assert.equal(calls, 1);
  const listed = authority.listMemory({});
  assert.equal(listed.diaries.length, 1); assert.equal(listed.diaries[0].kind, 'private');
  assert.equal(authority.context('source', { streamId: 'private', query: '感想' }).text.includes('以后可以更贴心'), false);
  await worker.runOnce(); assert.equal(calls, 1, 'generated diaries are never re-ingested as new material');
  const before = authority.worldStatus(); authority.setWorldPaused({ paused: true, expectedRevision: before.revision });
  await worker.runOnce(); assert.equal(calls, 1);
});
