import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModelGateway } from './server.mjs';
import { createProviders } from './providers.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { createProxyFetch } from './proxy-fetch.mjs';
import { createUsageLedger } from './usage-ledger.mjs';
import { CAPABILITIES } from '../capabilities/providers/index.js';

// The whole flow (key, submit, poll, fetch, money, ledger) is tested with the staging-only mock adapter in
// deploy/staging/fake-provider.test.mjs; this file covers what holds for the release as it ships.
const operator = 'operator-test-token-with-no-real-credential', inference = 'inference-test-token-with-no-real-credential';
const sha = value => createHash('sha256').update(value).digest('hex');
function call(socketPath, token, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: body === undefined ? 'GET' : 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const json = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve({ status: res.statusCode, value: json.value, code: json.error?.code }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('a release has no provider adapter: DeepSeek is the only key holder listed and nothing can be submitted', async t => {
  assert.deepEqual(PROVIDERS, []);
  assert.ok(Object.isFrozen(PROVIDERS));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-providers-'));
  const files = { settingsFile: path.join(root, 'settings.json'), inferenceSocket: path.join(root, 'infer.sock'), controlSocket: path.join(root, 'control.sock') };
  let fetched = 0;
  const gateway = createModelGateway({ ...files, inferenceTokenHash: sha(inference), operatorTokenHash: sha(operator), worldStatus: async () => ({ paused: true }), fetchImpl: async () => { fetched++; return new Response('{}'); } });
  await gateway.start();
  t.after(async () => { await gateway.close(); fs.rmSync(root, { recursive: true }); });
  assert.deepEqual((await call(files.controlSocket, operator, '/providers')).value, { providers: [{ id: 'deepseek', title: 'DeepSeek', configured: false, operations: [], managed: 'model' }] });
  // The chat key is still set with POST /model only (paused world); the listing follows it.
  assert.equal((await call(files.controlSocket, operator, '/providers/key', { provider: 'deepseek', apiKey: 'MOCK-KEY-not-a-real-key' })).code, 'INVALID_REQUEST');
  assert.equal((await call(files.controlSocket, operator, '/model', { model: 'deepseek-flash', apiKey: 'MOCK-KEY-not-a-real-key' })).status, 200);
  assert.deepEqual((await call(files.controlSocket, operator, '/providers')).value.providers, [{ id: 'deepseek', title: 'DeepSeek', configured: true, operations: [], managed: 'model' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.settingsFile, 'utf8')), { model: 'deepseek-flash', apiKey: 'MOCK-KEY-not-a-real-key', status: 'configured' });
  for (const operation of ['image.generate', 'mock.generate']) assert.equal((await call(files.inferenceSocket, inference, '/v1/provider/submit', { operation, input: { prompt: 'x' } })).code, 'INVALID_REQUEST');
  assert.equal((await call(files.inferenceSocket, inference, '/v1/provider/status', { job: 'x' })).status, 404);
  // The operator token does not open the inference routes, nor the inference token the key routes.
  assert.equal((await call(files.inferenceSocket, operator, '/v1/provider/submit', { operation: 'x.y', input: {} })).status, 401);
  assert.equal((await call(files.controlSocket, inference, '/providers')).status, 401);
  assert.equal(fetched, 0);
  // Neither provider file is written before there is something to store.
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('provider')), []);
});

test('the production entrypoint cannot be handed an adapter, a capability or a fetch', () => {
  const main = fs.readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  assert.ok(main.includes("const keys = ['settingsFile', 'inferenceSocket', 'controlSocket', 'inferenceTokenHash', 'operatorTokenHash', 'authority', 'usageFile', 'budgets'];"));
  assert.doesNotMatch(main, /providers:|capabilities:|fetchImpl/);
  // The staging mock is not among the sources a release is built from, and no gateway module imports it.
  const release = fs.readFileSync(fileURLToPath(new URL('../deploy/authority/build-release.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(release, /deploy\/staging|fake-provider/);
  for (const file of ['server.mjs', 'providers.mjs', 'providers/index.mjs', 'main.mjs', 'proxy-fetch.mjs']) assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL('./' + file, import.meta.url)), 'utf8'), /^import .*(staging|fake)/m, file);
});

test('an adapter that does not have the declared shape stops the gateway from being built', () => {
  const meter = { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 2, spendCategory: 'generation', stopTier: 'restricted', perPerson: false };
  const capabilities = [...CAPABILITIES, { id: 'image', title: 'x', meter }], fn = () => ({});
  const good = { id: 'example', title: 'Example', hosts: ['api.example.com'], proxy: true, operations: { 'image.generate': { mode: 'sync', estimate: fn, submit: fn, submitted: fn } } };
  const build = adapters => createProviders({ directory: '/nonexistent', adapters, capabilities, spend: {}, ledger: {}, world: fn, fetchImpl: fn, track: fn });
  assert.doesNotThrow(() => build([good]));
  const bad = [
    { ...good, id: 'deepseek' }, { ...good, id: 'Bad Id' }, { ...good, hosts: [] }, { ...good, hosts: ['127.0.0.1'] }, { ...good, hosts: ['https://api.example.com'] }, { ...good, proxy: undefined },
    { ...good, operations: { 'image.generate': { mode: 'async', estimate: fn, submit: fn, submitted: fn } } },   // async without poll
    { ...good, operations: { 'image.generate': { mode: 'later', estimate: fn, submit: fn, submitted: fn } } },
    { ...good, operations: { 'video.generate': good.operations['image.generate'] } },                           // no such capability
    { ...good, operations: { 'vision.describe': good.operations['image.generate'] } },                          // counted on the legacy counter
    { ...good, operations: { 'speech-tts.synthesize': good.operations['image.generate'] } },                    // not a gateway exit
    { ...good, operations: { generate: good.operations['image.generate'] } },
  ];
  for (const adapter of bad) assert.throws(() => build([adapter]), /Invalid provider/, JSON.stringify(adapter));
  assert.throws(() => build([good, good]), /Invalid provider adapters/);
});

test('ledger: a gateway exit takes daily slots, and a row this release does not declare is kept for the day', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const now = Date.parse('2026-11-12T04:00:00Z');
  const meter = { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 2, spendCategory: 'generation', stopTier: 'restricted', perPerson: false };
  const newer = createUsageLedger({ directory, capabilities: [...CAPABILITIES, { id: 'image', title: 'x', meter }], clock: () => now });
  await newer.start();
  await newer.take('image'); await newer.take('image');
  await assert.rejects(newer.take('image'), { code: 'BUDGET_EXHAUSTED' });
  // Not for a capability counted elsewhere: vision keeps its legacy counter, speech is reported by its own process.
  for (const id of ['vision', 'speech-tts', 'nothing']) await assert.rejects(newer.take(id), { code: 'INVALID_REQUEST' });
  await newer.close();
  // A release from before the capability existed runs on the same file, counts something, and leaves the row alone.
  const older = createUsageLedger({ directory, capabilities: CAPABILITIES, clock: () => now });
  await older.start();
  await older.record('chat', { outcome: 'ok' });
  assert.deepEqual((await older.status()).rows.map(row => row.id), CAPABILITIES.map(item => item.id));
  await older.close();
  const again = createUsageLedger({ directory, capabilities: [...CAPABILITIES, { id: 'image', title: 'x', meter }], clock: () => now });
  await again.start();
  const row = (await again.status()).rows.find(item => item.id === 'image');
  assert.deepEqual([row.used, row.limit, row.denied], [2, 2, { daily_limit: 1 }]);
  await assert.rejects(again.take('image'), { code: 'BUDGET_EXHAUSTED' });
  await again.close();
});

test('proxy fetch sends the request through the outbound proxy and returns a plain Response', async t => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() }); res.writeHead(req.url.endsWith('/moved') ? 302 : 200, { 'content-type': 'application/json', location: 'http://elsewhere.invalid/' }); res.end('{"via":"proxy"}'); });
  });
  proxy.on('connect', (req, socket) => { seen.push({ method: 'CONNECT', url: req.url }); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const proxied = createProxyFetch(`http://127.0.0.1:${proxy.address().port}`);
  const response = await proxied('http://provider.mock.invalid/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual([response.status, response.ok, await response.json(), response.headers.get('content-type')], [200, true, { via: 'proxy' }, 'application/json']);
  assert.deepEqual(seen[0], { method: 'POST', url: 'http://provider.mock.invalid/v1/tasks', host: 'provider.mock.invalid', body: '{"a":1}' });
  // A redirect is handed back, not followed.
  const moved = await proxied('http://provider.mock.invalid/moved');
  assert.deepEqual([moved.status, moved.ok, seen.length], [302, false, 2]);
  await moved.body.cancel();
  // HTTPS goes out as a CONNECT tunnel to the provider's host (the proxy here refuses it).
  await assert.rejects(proxied('https://provider.mock.invalid/v1/tasks'));
  assert.deepEqual(seen[2], { method: 'CONNECT', url: 'provider.mock.invalid:443' });
  // An aborted request rejects.
  const controller = new AbortController(); controller.abort();
  await assert.rejects(proxied('http://provider.mock.invalid/x', { signal: controller.signal }));
  for (const bad of ['https://127.0.0.1:7890', 'http://user:pass@127.0.0.1:7890', 'socks5://127.0.0.1:7890']) assert.throws(() => createProxyFetch(bad), /Invalid outbound proxy/);
});
