import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';

test('standalone shell is public-only static; runtime controls require operator, Core pause and sealed world revision', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-console-web-'))), assetsDir = path.join(root, 'web'); fs.mkdirSync(assetsDir);
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>Companion</title><script src="/console.js" defer></script>'); fs.writeFileSync(path.join(assetsDir, 'console.js'), '/* synthetic public app */');
  const authority = new Authority({ file: path.join(root, 'core.sqlite'), initialPaused: true }), token = 'synthetic-console-credential-for-isolated-test';
  let operation; const socketPath = path.join(root, 'operator.sock');
  const app = createOperatorServer({ authority, socketPath, assetsDir, tokenHash: createHash('sha256').update(token).digest('hex'), origins: ['http://127.0.0.1:3082'], contentOperator: async (action, input) => { operation = { action, input }; return { speech: { configurationRevision: 'synthetic' } }; } });
  t.after(async () => { await app.close(); authority.close(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^fish-console-web-/); fs.rmSync(root, { recursive: true }); });
  await app.start();
  const call = (method, target, body, authorized = true) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: target, headers: { origin: 'http://127.0.0.1:3082', ...(authorized ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers })); }); request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const shell = await call('GET', '/', undefined, false); assert.equal(shell.status, 200); assert.match(shell.text, /Companion/); assert.ok(!shell.text.includes(token)); assert.match(shell.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await call('GET', '/world', undefined, false)).status, 401); assert.equal((await call('GET', '/runtime', undefined, false)).status, 401);
  assert.notEqual((await call('GET', '/../operator/console.token', undefined, false)).status, 200);
  assert.equal((await call('GET', '/runtime')).status, 200); assert.equal(operation.action, 'status');
  const settings = { expectedRevision: 'synthetic', defaultTtsQuality: 'heavy', numThreads: 2, maxTextChars: 100 };
  assert.equal((await call('POST', '/speech', { ...settings, worldRevision: 999 })).status, 400);
  assert.equal((await call('POST', '/speech', settings)).status, 200); assert.equal(operation.action, 'configure'); assert.equal(operation.input.worldRevision, authority.worldStatus().revision);
  authority.setWorldPaused({ paused: false, expectedRevision: authority.worldStatus().revision });
  assert.equal((await call('POST', '/voice/test', { quality: 'heavy' })).status, 409);
});
