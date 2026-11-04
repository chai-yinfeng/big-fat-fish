import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';

test('operator UI uses its separate credential and real world/persona operations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-operator-'));
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), initialPaused: true });
  authority.registerCapability({ id: 'dsh-test', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'dsh-test', externalActorId: 'test-owner', personId: 'person:owner' });
  const token = 'o'.repeat(43), socketPath = path.join(dir, 'operator.sock');
  let resumed = 0;
  const app = createOperatorServer({ authority, socketPath, tokenHash: createHash('sha256').update(token).digest('hex'), origins: ['http://127.0.0.1:3081'], onResume: () => { resumed++; } });
  await app.start();
  t.after(async () => { await app.close(); authority.close(); fs.rmSync(dir, { recursive: true }); });
  const call = (method, target, data, key = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: target, method, headers: { origin: 'http://127.0.0.1:3081', authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw), cors: res.headers['access-control-allow-origin'] }));
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  assert.equal((await call('GET', '/world', undefined, 'capability'.repeat(5))).status, 401);
  const first = await call('GET', '/world');
  assert.equal(first.cors, 'http://127.0.0.1:3081');
  assert.equal(first.body.value.world.paused, true);
  assert.equal(first.body.value.channels[1].status, 'not_configured');
  assert.equal((await call('POST', '/world/pause', { paused: false, expectedRevision: 1 })).body.value.paused, false);
  assert.equal(resumed, 1);
  assert.equal((await call('POST', '/world/pause', { paused: true, expectedRevision: 1 })).status, 409);
  assert.equal((await call('POST', '/test-conversations', { conversationId: 'test-first' })).body.value.sourceId, 'dsh-test');
  const edited = await call('POST', '/persona', { expectedRevision: 1, patch: { name: '大肥鱼' } });
  assert.equal(edited.body.value.personaRevision, 2);
  assert.equal((await call('GET', '/world')).body.value.bindings.length, 1);
});
