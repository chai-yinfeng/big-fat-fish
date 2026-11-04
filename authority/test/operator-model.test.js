import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';
import { createModelControlClient } from '../src/model-control.js';
import { createModelGateway } from '../../model-gateway/server.mjs';

test('human model configuration crosses the private control socket without entering world state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-'));
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), initialPaused: true });
  const token = 'operator'.repeat(6), inferenceToken = 'inference'.repeat(6), key = 'sk-unit-test-not-real';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const gateway = createModelGateway({ settingsFile: path.join(dir, 'model.json'), inferenceSocket: path.join(dir, 'infer.sock'), controlSocket: path.join(dir, 'control.sock'), inferenceTokenHash: hash(inferenceToken), operatorTokenHash: hash(token), worldStatus: () => authority.worldStatus(), fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })) });
  await gateway.start();
  const operator = createOperatorServer({ authority, socketPath: path.join(dir, 'op.sock'), tokenHash: hash(token), origins: [], modelControl: createModelControlClient(path.join(dir, 'control.sock')) });
  await operator.start();
  t.after(async () => { await operator.close(); await gateway.close(); authority.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'world-model-')); fs.rmSync(dir, { recursive: true }); });
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, 'op.sock'), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, raw, ...JSON.parse(raw) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call('/model', { model: 'deepseek-flash', apiKey: key })).value.configured, true);
  const overview = await call('/world');
  assert.equal(overview.value.model.status, 'configured');
  assert.equal(overview.raw.includes(key), false);
  assert.equal(JSON.stringify(authority.snapshot()).includes(key), false);
  assert.equal((await call('/model/test', {})).value.ok, true);
  authority.setWorldPaused({ paused: false, expectedRevision: 1 });
  assert.equal((await call('/model', { model: 'deepseek-v4-pro' })).status, 409);
  assert.equal((await call('/world/pause', { paused: true, expectedRevision: 2 })).value.paused, true);
});
