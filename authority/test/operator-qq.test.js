import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';

test('human QQ configuration binds authenticated bot and approved private caller to the same owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-qq-')), token = 'operator'.repeat(6);
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), initialPaused: true });
  authority.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  const state = { loggedIn: true, connected: true, configured: false, callerConfigured: false, paused: true };
  const server = createOperatorServer({ authority, socketPath: path.join(dir, 'op.sock'), tokenHash: createHash('sha256').update(token).digest('hex'), origins: [], qqControl: async (route, body) => {
    if (route === '/qq/identity') return { expectedSelfId: '100' };
    if (body) { assert.deepEqual(body, { expectedSelfId: '100', allowedCallerUID: '200' }); state.configured = state.callerConfigured = true; }
    return state;
  } });
  await server.start();
  t.after(async () => { await server.close(); authority.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'operator-qq-')); fs.rmSync(dir, { recursive: true }); });
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, 'op.sock'), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call('/qq', { allowedCallerUID: '200' })).status, 200);
  const snapshot = authority.snapshot();
  assert.equal(snapshot.streams.find(s => s.capabilityId === 'qq').personId, 'person:owner');
  assert.equal((await call('/world')).value.channels.find(c => c.id === 'qq').status, 'ready');
  authority.setWorldPaused({ paused: false, expectedRevision: 1 });
  assert.equal((await call('/qq', { allowedCallerUID: '200' })).status, 409);
});
