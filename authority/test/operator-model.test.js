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

test('operator proxies the gateway usage ledger: today, history and daily limits, like /spend', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-'));
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), initialPaused: true });
  const token = 'operator'.repeat(6), inferenceToken = 'inference'.repeat(6);
  const hash = value => createHash('sha256').update(value).digest('hex');
  let now = Date.parse('2026-11-12T04:00:00Z');
  const gateway = createModelGateway({ settingsFile: path.join(dir, 'model.json'), inferenceSocket: path.join(dir, 'infer.sock'), controlSocket: path.join(dir, 'control.sock'), inferenceTokenHash: hash(inferenceToken), operatorTokenHash: hash(token), clock: () => now, worldStatus: () => authority.worldStatus(), fetchImpl: async () => { throw new Error('no provider call expected'); } });
  await gateway.start();
  const operator = createOperatorServer({ authority, socketPath: path.join(dir, 'op.sock'), tokenHash: hash(token), origins: [], modelControl: createModelControlClient(path.join(dir, 'control.sock')) });
  await operator.start();
  t.after(async () => { await operator.close(); await gateway.close(); authority.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'world-model-')); fs.rmSync(dir, { recursive: true }); });
  const send = (socket, route, body, bearer) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, socket), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const call = (route, body, bearer = token) => send('op.sock', route, body, bearer);
  const usage = await call('/usage');
  assert.equal(usage.status, 200);
  assert.deepEqual([usage.value.day, usage.value.rows.map(row => row.id)], ['2026-11-12', ['chat', 'consolidation', 'vision', 'web', 'speech-tts', 'speech-asr', 'proactive']]);
  assert.equal((await call('/usage', undefined, 'x'.repeat(48))).status, 401);
  // A daily limit is changed through the operator route; unknown fields never reach the gateway.
  const changed = await call('/usage/limits', { limits: { vision: 3 } });
  assert.deepEqual([changed.status, changed.value.rows.find(row => row.id === 'vision').limit], [200, 3]);
  assert.equal((await call('/usage/limits', { limits: { vision: 3 }, extra: 1 })).status, 400);
  assert.equal((await call('/usage/limits', { limits: { chat: 3 } })).status, 400);
  // The content process reports a local run; the next Beijing day it is a history line the operator can read.
  assert.equal((await send('infer.sock', '/v1/usage/record', { capability: 'speech-tts', outcome: 'ok', busyMs: 3000, units: { chars: 12, audioSeconds: 2.5 } }, inferenceToken)).status, 200);
  assert.deepEqual((await call('/usage/history')).value.days, []);
  now += 86400000;
  for (const route of ['/usage/history', '/usage/history?days=7', '/usage/history?days=90']) {
    const history = await call(route);
    assert.deepEqual([history.status, history.value.days.map(day => day.day), history.value.days[0].rows['speech-tts'].units], [200, ['2026-11-12'], { chars: 12, audioSeconds: 2.5 }], route);
  }
  for (const route of ['/usage/history?days=0', '/usage/history?days=91', '/usage/history?days=x', '/usage/history?days=7&x=1']) assert.equal((await call(route)).status, 400, route);
  // Without a gateway the routes answer 503 instead of failing the console.
  const alone = createOperatorServer({ authority, socketPath: path.join(dir, 'op2.sock'), tokenHash: hash(token), origins: [] });
  await alone.start(); t.after(() => alone.close());
  for (const [route, body] of [['/usage'], ['/usage/history'], ['/usage/limits', { limits: { vision: 3 } }]]) assert.equal((await send('op2.sock', route, body, token)).status, 503, route);
});

test('operator proxies the provider key routes: listed, set and cleared without the key ever coming back', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-'));
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), initialPaused: true });
  const token = 'operator'.repeat(6), key = 'MOCK-PROVIDER-KEY-not-a-real-key';
  const hash = value => createHash('sha256').update(value).digest('hex');
  // A stand-in adapter and the capability its operation is counted under (a release has none).
  const { CAPABILITIES } = await import('../../capabilities/providers/index.js');
  const capability = { id: 'mock', title: 'MOCK', meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 3, spendCategory: 'generation', stopTier: 'restricted', perPerson: false } };
  const adapter = { id: 'mock', title: 'MOCK provider', hosts: ['provider.mock.invalid'], proxy: false, operations: { 'mock.sketch': { mode: 'sync', estimate: () => 0, submit: () => ({}), submitted: () => ({}) } } };
  const gateway = createModelGateway({ settingsFile: path.join(dir, 'model.json'), inferenceSocket: path.join(dir, 'infer.sock'), controlSocket: path.join(dir, 'control.sock'), inferenceTokenHash: hash('inference'.repeat(6)), operatorTokenHash: hash(token), worldStatus: () => authority.worldStatus(), fetchImpl: async () => { throw new Error('no provider in this test'); }, providers: [adapter], capabilities: [...CAPABILITIES, capability] });
  await gateway.start();
  const operator = createOperatorServer({ authority, socketPath: path.join(dir, 'op.sock'), tokenHash: hash(token), origins: [], modelControl: createModelControlClient(path.join(dir, 'control.sock')) });
  await operator.start();
  t.after(async () => { await operator.close(); await gateway.close(); authority.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'world-model-')); fs.rmSync(dir, { recursive: true }); });
  const send = (socket, route, body, bearer = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, socket), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, raw, ...JSON.parse(raw) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const configured = async () => Object.fromEntries((await send('op.sock', '/providers')).value.providers.map(item => [item.id, item.configured]));
  assert.deepEqual(await configured(), { deepseek: false, mock: false });
  assert.equal((await send('op.sock', '/providers', undefined, 'x'.repeat(48))).status, 401);
  // The answer carries no key, and neither does the listing or the world state.
  const stored = await send('op.sock', '/providers/key', { provider: 'mock', apiKey: key });
  assert.deepEqual([stored.status, stored.value, stored.raw.includes('MOCK-PROVIDER')], [200, { provider: 'mock', configured: true }, false]);
  const listed = await send('op.sock', '/providers');
  assert.deepEqual([await configured(), listed.raw.includes('MOCK-PROVIDER')], [{ deepseek: false, mock: true }, false]);
  assert.equal(JSON.stringify(authority.snapshot()).includes('MOCK-PROVIDER'), false);
  // Unknown fields and providers never store anything; DeepSeek keeps its own route.
  for (const body of [{ provider: 'mock', apiKey: key, extra: 1 }, { provider: 'other', apiKey: key }, { provider: 'deepseek', apiKey: key }, { provider: 'mock' }]) assert.equal((await send('op.sock', '/providers/key', body)).status, 400, JSON.stringify(Object.keys(body)));
  assert.equal((await send('op.sock', '/providers/clear', { provider: 'mock', apiKey: key })).status, 400);
  assert.deepEqual((await send('op.sock', '/providers/clear', { provider: 'mock' })).value, { provider: 'mock', configured: false });
  assert.deepEqual(await configured(), { deepseek: false, mock: false });
  // It needs no pause: the same while the world runs.
  authority.setWorldPaused({ paused: false, expectedRevision: 1 });
  assert.equal((await send('op.sock', '/providers/key', { provider: 'mock', apiKey: key })).status, 200);
  const alone = createOperatorServer({ authority, socketPath: path.join(dir, 'op2.sock'), tokenHash: hash(token), origins: [] });
  await alone.start(); t.after(() => alone.close());
  for (const [route, body] of [['/providers'], ['/providers/key', { provider: 'mock', apiKey: key }], ['/providers/clear', { provider: 'mock' }]]) assert.equal((await send('op2.sock', route, body)).status, 503, route);
});
