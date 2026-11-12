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
import { MemoryConsolidation } from './consolidation.js';

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

test('rolled-out dialogue crosses real UDS/gateway into a digest and a quoted fact; a call the spend tier refuses costs nothing and moves nothing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-flow-'));
  const authority = new Authority({ file: path.join(dir, 'core.sqlite'), clock: () => 100000 });
  authority.registerCapability({ id: 'source', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'source', externalActorId: 'owner', personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'source', streamId: 'private', personId: 'person:owner', audience: 'private' });
  const say = (eventId, text, at, she = false) => authority.observe('source', { eventId, streamId: 'private', actorId: she ? 'model' : 'owner', role: she ? 'assistant' : 'user', text, at }).observationId;
  const first = say('event-1', '我养了一只叫MOCK-年糕的仓鼠', 1000), reply = say('reply-1', 'MOCK-REPLY 好可爱', 2000, true);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const coreSocket = path.join(dir, 'core.sock'), inferenceSocket = path.join(dir, 'infer.sock'), tokenFile = path.join(dir, 'maintenance.token'), inferenceTokenFile = path.join(dir, 'inference.token');
  fs.writeFileSync(tokenFile, 'synthetic-maintenance-token-not-a-real-credential', { mode: 0o600 }); fs.writeFileSync(inferenceTokenFile, 'synthetic-inference-token', { mode: 0o600 });
  const server = createAuthorityServer({ authority, socketPath: coreSocket, credentials: [{ hash: hash('synthetic-maintenance-token-not-a-real-credential'), role: 'maintenance', entityId: DEFAULT_ENTITY_ID }] });
  const settingsFile = path.join(dir, 'model.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-provider-key', status: 'configured' }), { mode: 0o600 });
  // Any spend at all reaches the "restricted" tier: the first call is the only one the gateway lets through.
  fs.writeFileSync(path.join(dir, 'spend-settings.json'), JSON.stringify({ dailyCapYuan: 0.01, reducedPercent: 0.001, restrictedPercent: 0.002 }), { mode: 0o600 });
  const requests = [];
  const gateway = createModelGateway({ settingsFile, inferenceSocket, controlSocket: path.join(dir, 'control.sock'), inferenceTokenHash: hash('synthetic-inference-token'), operatorTokenHash: hash('synthetic-operator'), worldStatus: async () => authority.worldStatus(), fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const [ref, , , text] = JSON.parse(request.messages[1].content).messages[0];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'MOCK-摘要：对方说起自己养的仓鼠。', feeling: 'MOCK-感受', facts: [{ key: '宠物', value: 'MOCK-年糕', quote: text, ref }] }) } }], usage: { prompt_tokens: 900, completion_tokens: 200 } }));
  } });
  t.after(async () => { await gateway.close(); await server.close(); authority.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^fish-memory-flow-/); fs.rmSync(dir, { recursive: true }); });
  await server.start(); await gateway.start();
  const worker = new MemoryConsolidation({ authority: new AuthorityClient({ socketPath: coreSocket, tokenFile }), complete: completeDiary({ socketPath: inferenceSocket, tokenFile: inferenceTokenFile }) });
  assert.equal(await worker.runOnce(), 'idle');
  authority.context('source', { streamId: 'private', query: 'MOCK', windowFromAt: 5000 });
  assert.equal(await worker.runOnce(), 'committed');
  assert.deepEqual([requests.length, requests[0].max_tokens, requests[0].thinking, requests[0].tools, requests[0].messages.length], [1, 1536, { type: 'disabled' }, undefined, 2]);
  await new Promise(resolve => setTimeout(resolve, 50));
  const items = authority.listMemory({}).items;
  assert.deepEqual(items.map(item => [item.type, item.kind ?? null, item.source.machine, item.summary ?? item.value]).sort(), [['experiences', 'digest', 'digest', 'MOCK-摘要：对方说起自己养的仓鼠。'], ['facts', null, 'extracted', 'MOCK-年糕']]);
  assert.deepEqual(items.find(item => item.kind === 'digest').derivedFrom, [first, reply]);
  assert.ok(!authority.context('source', { streamId: 'private', query: 'MOCK-摘要 仓鼠' }).text.includes('MOCK-摘要'));
  // More dialogue leaves the window, but today's spend is past the tier that stops maintenance.
  say('event-2', '它最爱吃MOCK-瓜子', 6000); say('reply-2', 'MOCK-REPLY 记住了', 7000, true);
  authority.context('source', { streamId: 'private', query: 'MOCK', windowFromAt: 9000 });
  const before = authority.consolidationState();
  assert.equal(await worker.runOnce(), 'budget_deferred');
  assert.equal(requests.length, 1, 'no provider call');
  const status = authority.consolidationStatus();
  assert.deepEqual([status.calls, status.paused, status.streams[0].behind.observations, status.streams[0].waiting, status.streams[0].digests], [1, 'spend', 2, 2, 1]);
  assert.equal(authority.consolidationState()[DEFAULT_ENTITY_ID].streams['source\u0000private'].lastObservationId, before[DEFAULT_ENTITY_ID].streams['source\u0000private'].lastObservationId);
  assert.equal(await worker.runOnce(), 'budget_deferred');
  assert.equal(authority.consolidationStatus().calls, 1, 'while waiting it does not even take a batch');
});
