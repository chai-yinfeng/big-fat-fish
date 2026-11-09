import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModelGateway } from '../../model-gateway/server.mjs';
import { AuthorityClient } from '../../authority/src/client.js';
import { SessionStore } from './sessions.js';
import { createGatewayStream } from './model.js';
import { createConversationExecutor } from './agent.js';
import { tempRoot, tokenFile, fakeAuthority, reply, toolCall } from './fixtures.js';

const sha = value => createHash('sha256').update(value).digest('hex');

// The real gateway (fake upstream fetch, no provider): pi-ai's request must pass
// the gateway's validation, and reasoning_content must survive the round trip.
test('through the real model gateway: thinking is forced and reasoning_content is replayed upstream', async t => {
  const root = tempRoot(t);
  const authority = await fakeAuthority(t, root);
  const inference = tokenFile(root, 'inference.token'), operator = 'operator-token-for-test-only-0000000000';
  const upstream = [], script = [toolCall('companion_scope', { action: 'evidence' }, 'R1-upstream'), reply('好的', 'R2')];
  const gateway = createModelGateway({
    settingsFile: path.join(root, 'model/settings.json'), usageFile: path.join(root, 'model/usage.json'),
    inferenceSocket: path.join(root, 'model/infer.sock'), controlSocket: path.join(root, 'model/control.sock'),
    inferenceTokenHash: sha(inference.token), operatorTokenHash: sha(operator), worldStatus: async () => ({ paused: authority.state.paused }),
    fetchImpl: async (url, options) => { upstream.push(JSON.parse(options.body)); return new Response(script.shift().map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'); },
  });
  fs.mkdirSync(path.join(root, 'model'), { mode: 0o700 });
  await gateway.start(); t.after(() => gateway.close());
  authority.state.paused = true;
  const configured = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-key-not-a-real-secret' });
    const req = http.request({ socketPath: path.join(root, 'model/control.sock'), path: '/model', method: 'POST', headers: { authorization: 'Bearer ' + operator, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(configured, 200);
  authority.state.paused = false;
  const { model, streamFn } = createGatewayStream({ socketPath: path.join(root, 'model/infer.sock'), tokenFile: inference.file });
  const executor = createConversationExecutor({ authority: new AuthorityClient(authority.config), store: new SessionStore(path.join(root, 'sessions')), model, streamFn });
  const text = await executor.execute({ scope: { streamId: 'qq:1:private:2', memoryEpoch: 0 }, requestId: 'r-1', input: { text: '你好', evidence: [{ ref: 'obs', eventId: 'e', role: 'user' }] }, timeoutMs: 10000 });
  assert.equal(text, '好的');
  assert.equal(upstream.length, 2);
  for (const body of upstream) {
    assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high');
    assert.ok(body.max_tokens <= 4096);
  }
  const assistant = upstream[1].messages.find(message => message.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'R1-upstream');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(upstream[1].messages.find(message => message.role === 'tool').tool_call_id, 'call_1');
  // A paused world fails at the Authority context step; nothing reaches the provider.
  authority.state.paused = true;
  await assert.rejects(executor.execute({ scope: { streamId: 'qq:1:private:2', memoryEpoch: 0 }, requestId: 'r-2', input: { text: '在吗' }, timeoutMs: 10000 }), { code: 'WORLD_PAUSED' });
  assert.equal(upstream.length, 2);
});

test('service entrypoint runs main() through a symlinked release directory', t => {
  const root = tempRoot(t);
  const project = fileURLToPath(new URL('../../', import.meta.url));
  fs.symlinkSync(project, path.join(root, 'current'));
  const result = spawnSync(process.execPath, [path.join(root, 'current/capabilities/conversation/main.mjs'), '--config', path.join(root, 'missing.json')], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Conversation executor could not start/);
});

test('a gateway refusal at the daily cap surfaces as BUDGET_EXHAUSTED without any provider call', async t => {
  const root = tempRoot(t);
  const authority = await fakeAuthority(t, root);
  const inference = tokenFile(root, 'inference.token'), operator = 'operator-token-for-test-only-0000000000';
  let upstream = 0;
  const now = Date.parse('2026-11-09T02:00:00Z');
  fs.mkdirSync(path.join(root, 'model'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'model/settings.json'), JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-key-not-a-real-secret' }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'model/spend.json'), JSON.stringify({ schema: 1, day: '2026-11-09', spentMicros: 5000000, reservedMicros: 0, byTier: {}, calls: 1, unreported: 0 }), { mode: 0o600 });
  const gateway = createModelGateway({
    settingsFile: path.join(root, 'model/settings.json'), inferenceSocket: path.join(root, 'model/infer.sock'), controlSocket: path.join(root, 'model/control.sock'),
    inferenceTokenHash: sha(inference.token), operatorTokenHash: sha(operator), worldStatus: async () => ({ paused: false }), clock: () => now,
    fetchImpl: async () => { upstream++; return new Response('data: [DONE]\n\n'); },
  });
  await gateway.start(); t.after(() => gateway.close());
  const { model, streamFn } = createGatewayStream({ socketPath: path.join(root, 'model/infer.sock'), tokenFile: inference.file });
  const executor = createConversationExecutor({ authority: new AuthorityClient(authority.config), store: new SessionStore(path.join(root, 'sessions')), model, streamFn });
  await assert.rejects(executor.execute({ scope: { streamId: 'qq:1:private:2', memoryEpoch: 0 }, requestId: 'r-1', input: { text: '你好' }, timeoutMs: 10000 }), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(upstream, 0);
});
