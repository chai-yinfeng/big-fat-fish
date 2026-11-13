import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModelGateway } from '../../model-gateway/server.mjs';
import { JOB_TTL_MS } from '../../model-gateway/providers.mjs';
import { CAPABILITIES } from '../../capabilities/providers/index.js';
import { FAKE_CAPABILITY, FAKE_HOST, FAKE_PROVIDER, createFakeProviderUpstream } from './fake-provider.mjs';

const operator = 'operator-test-token-with-no-real-credential', inference = 'inference-test-token-with-no-real-credential';
const KEY = 'MOCK-PROVIDER-KEY-not-a-real-key';
const sha = value => createHash('sha256').update(value).digest('hex');
function call(socketPath, token, route, body, method = body === undefined ? 'GET' : 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch {} resolve({ status: res.statusCode, bytes, type: res.headers['content-type'], value: json?.value, code: json?.error?.code }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
/** A gateway with the mock adapter over the mock upstream. `state` survives `restart()`; the upstream's tasks do too. */
async function fixture(t, { upstream = createFakeProviderUpstream(), adapters = [FAKE_PROVIDER] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-provider-')), state = { paused: false, now: Date.parse('2026-11-12T04:00:00Z') }, seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url: String(url), authorization: new Headers(options?.headers).get('authorization') }); return await upstream(url, options) ?? new Response('{}', { status: 503 }); };
  const files = { settingsFile: path.join(root, 'settings.json'), inferenceSocket: path.join(root, 'infer.sock'), controlSocket: path.join(root, 'control.sock') };
  const create = () => createModelGateway({ ...files, inferenceTokenHash: sha(inference), operatorTokenHash: sha(operator), worldStatus: async () => ({ paused: state.paused }), clock: () => state.now, fetchImpl, providers: adapters, capabilities: [...CAPABILITIES, FAKE_CAPABILITY] });
  let gateway = create(); await gateway.start();
  t.after(async () => { await gateway.close(); fs.rmSync(root, { recursive: true }); });
  const control = (route, body) => call(files.controlSocket, operator, route, body), infer = (route, body) => call(files.inferenceSocket, inference, route, body);
  const row = async () => (await control('/usage')).value.rows.find(item => item.id === 'mock'), spend = async () => (await control('/spend')).value;
  /** The ledger is written after the answer: wait until the mock row satisfies `probe`. */
  const settled = async probe => { for (let i = 0; i < 80; i++) { const now = await row(); if (probe(now)) return now; await new Promise(resolve => setTimeout(resolve, 25)); } return row(); };
  return { root, state, seen, control, infer, row, spend, settled, async restart() { await gateway.close(); gateway = create(); await gateway.start(); } };
}
const submit = (f, operation = 'mock.generate', prompt = 'MOCK-PROMPT') => f.infer('/v1/provider/submit', { operation, input: { prompt } });

test('the mock adapter end to end: key, submit, poll, fetch, with the spend meter and the ledger in step', async t => {
  const f = await fixture(t);
  // Listed after DeepSeek, not configured; nothing but the fact of a key is ever shown.
  assert.deepEqual((await f.control('/providers')).value.providers, [
    { id: 'deepseek', title: 'DeepSeek', configured: false, operations: [], managed: 'model' },
    { id: 'mock', title: 'MOCK provider', configured: false, operations: [{ name: 'mock.generate', mode: 'async' }, { name: 'mock.sketch', mode: 'sync' }], managed: 'providers' },
  ]);
  // No key: refused before anything leaves, counted as not_configured.
  const unset = await submit(f);
  assert.deepEqual([unset.status, unset.code, f.seen.length], [503, 'UNCONFIGURED', 0]);
  assert.deepEqual((await f.settled(now => now.denied.not_configured === 1)).denied, { not_configured: 1 });
  const stored = await f.control('/providers/key', { provider: 'mock', apiKey: `  ${KEY}\n` });
  assert.deepEqual([stored.status, stored.value], [200, { provider: 'mock', configured: true }]);
  const keysFile = path.join(f.root, 'providers.json');
  assert.equal(fs.statSync(keysFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(keysFile, 'utf8')), { schema: 1, keys: { mock: KEY } });
  const listed = await f.control('/providers');
  assert.equal(listed.value.providers[1].configured, true);
  assert.ok(!listed.bytes.toString().includes('MOCK-PROVIDER') && !JSON.stringify(listed.value).includes(String(KEY.length)));
  // DeepSeek's own settings file is not created or touched by any of this.
  assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);

  // Async: the submit answers with a job, its estimate (0.02) is reserved and a daily slot is taken.
  const job = await submit(f);
  assert.deepEqual([job.status, job.value.state, job.value.operation, job.value.outputs], [200, 'pending', 'mock.generate', 0]);
  assert.match(job.value.job, /^[0-9a-f-]{36}$/);
  assert.deepEqual([(await f.spend()).reservedYuan, (await f.spend()).spentYuan, (await f.row()).used, (await f.row()).calls], [0.02, 0, 1, 0]);
  f.state.now += 4000;
  assert.equal((await f.infer('/v1/provider/status', { job: job.value.job })).value.state, 'pending');
  const done = await f.infer('/v1/provider/status', { job: job.value.job });
  assert.deepEqual(done.value, { job: job.value.job, operation: 'mock.generate', state: 'done', outputs: 1 });
  // Settled to what the provider reported (0.012), written to the ledger with its unit and elapsed time.
  const row = await f.settled(now => now.ok === 1);
  assert.deepEqual([row.used, row.limit, row.calls, row.ok, row.failed, row.units, row.costYuan, row.busyMs, row.spendCategory], [1, 3, 1, 1, 0, { files: 1 }, 0.012, 4000, 'generation']);
  assert.deepEqual([(await f.spend()).reservedYuan, (await f.spend()).spentYuan, (await f.spend()).byTier.generation], [0, 0.012, 0.012]);
  // Asking again changes nothing and asks the provider nothing.
  const asked = f.seen.length;
  assert.equal((await f.infer('/v1/provider/status', { job: job.value.job })).value.state, 'done');
  assert.equal(f.seen.length, asked);
  // The file comes from the provider's host with the key, as bytes; the key itself goes nowhere else.
  const file = await f.infer('/v1/provider/fetch', { job: job.value.job, output: 0 });
  assert.deepEqual([file.status, file.type, file.bytes.subarray(1, 4).toString()], [200, 'image/png', 'PNG']);
  assert.deepEqual(f.seen.at(-1), { url: `https://files.${FAKE_HOST}/mock.png`, authorization: 'Bearer ' + KEY });
  assert.equal((await f.infer('/v1/provider/fetch', { job: job.value.job, output: 1 })).code, 'INVALID_REQUEST');
  assert.equal((await f.infer('/v1/provider/status', { job: 'no-such-job' })).status, 404);

  // Sync: one call, the result held until it is fetched; no cost reported, so the estimate (0.004) is charged.
  const sketch = await submit(f, 'mock.sketch');
  assert.deepEqual([sketch.status, sketch.value.state, sketch.value.outputs], [200, 'done', 1]);
  const picture = await f.infer('/v1/provider/fetch', { job: sketch.value.job, output: 0 });
  assert.deepEqual([picture.type, picture.bytes.subarray(1, 4).toString()], ['image/png', 'PNG']);
  assert.deepEqual([(await f.settled(now => now.ok === 2)).costYuan, (await f.spend()).spentYuan], [0.016, 0.016]);
  // Nothing on disk or in any answer carries the key except the keys file.
  for (const name of fs.readdirSync(f.root).filter(name => name !== 'providers.json' && !name.endsWith('.sock'))) assert.ok(!fs.readFileSync(path.join(f.root, name), 'utf8').includes('MOCK-PROVIDER'), name);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, 'provider-jobs.json'), 'utf8')).jobs[0]).sort(), ['at', 'id', 'operation', 'provider', 'state', 'task']);

  // Cleared: refused again.
  assert.deepEqual((await f.control('/providers/clear', { provider: 'mock' })).value, { provider: 'mock', configured: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(keysFile, 'utf8')), { schema: 1, keys: {} });
  assert.equal((await submit(f)).code, 'UNCONFIGURED');
});

test('refusals: daily limit, spend tier, pause, a failing task and a provider that says no', async t => {
  const f = await fixture(t);
  await f.control('/providers/key', { provider: 'mock', apiKey: KEY });
  // Malformed requests are not counted.
  for (const body of [{ operation: 'mock.nothing', input: { prompt: 'x' } }, { operation: 'mock.generate', input: { prompt: '' } }, { operation: 'mock.generate', input: { prompt: 'x', extra: 1 } }, { operation: 'mock.generate' }, { operation: 'image.generate', input: {} }]) assert.equal((await f.infer('/v1/provider/submit', body)).code, 'INVALID_REQUEST');
  assert.equal((await f.infer('/v1/provider/submit', { operation: 'mock.generate', input: { prompt: 'x' }, provider: 'mock' })).code, 'INVALID_REQUEST');
  assert.equal(f.seen.length, 0);
  // Paused: nothing is sent, nothing reserved.
  f.state.paused = true;
  assert.deepEqual([(await submit(f)).code, f.seen.length], ['WORLD_PAUSED', 0]);
  f.state.paused = false;
  // The provider refuses (429): released, a failed call, the slot stays taken.
  const refused = await submit(f, 'mock.generate', 'MOCK-REFUSE');
  assert.deepEqual([refused.status, refused.code], [502, 'UPSTREAM_LIMIT']);
  // A task that fails at the provider: released when the poll says so.
  const failing = await submit(f, 'mock.generate', 'MOCK-FAIL');
  await f.infer('/v1/provider/status', { job: failing.value.job });
  // While paused a job cannot be asked about; it is not lost.
  f.state.paused = true;
  assert.equal((await f.infer('/v1/provider/status', { job: failing.value.job })).code, 'WORLD_PAUSED');
  f.state.paused = false;
  assert.equal((await f.infer('/v1/provider/status', { job: failing.value.job })).value.state, 'failed');
  assert.equal((await f.infer('/v1/provider/fetch', { job: failing.value.job, output: 0 })).code, 'INVALID_REQUEST');
  let row = await f.settled(now => now.failed === 2);
  assert.deepEqual([row.used, row.calls, row.ok, row.failed, row.denied, row.costYuan], [2, 2, 0, 2, { paused: 1 }, 0]);
  assert.deepEqual([(await f.spend()).spentYuan, (await f.spend()).reservedYuan], [0, 0]);
  // The third slot of three, then the daily limit: refused before the provider, counted as daily_limit.
  assert.equal((await submit(f, 'mock.sketch')).status, 200);
  const sent = f.seen.length, over = await submit(f, 'mock.sketch');
  assert.deepEqual([over.status, over.code, f.seen.length], [429, 'BUDGET_EXHAUSTED', sent]);
  row = await f.settled(now => now.denied.daily_limit === 1);
  assert.deepEqual([row.used, row.limit, row.denied, (await f.spend()).reservedYuan], [3, 3, { paused: 1, daily_limit: 1 }, 0]);
  // The operator raises the limit on the quota page's route; the restricted spend tier then stops it instead.
  assert.equal((await f.control('/usage/limits', { limits: { mock: 10 } })).status, 200);
  assert.equal((await f.control('/spend/settings', { dailyCapYuan: 0.01, reducedPercent: 20, restrictedPercent: 30 })).status, 200);
  const tier = await submit(f, 'mock.sketch');
  assert.deepEqual([tier.status, tier.code, f.seen.length], [429, 'SPEND_RESTRICTED', sent]);
  assert.equal((await f.settled(now => now.denied.spend_tier === 1)).denied.spend_tier, 1);
});

test('a job outlives a gateway restart; one nobody asks about is dropped and charged', async t => {
  const f = await fixture(t);
  await f.control('/providers/key', { provider: 'mock', apiKey: KEY });
  const job = await submit(f);
  await f.restart();
  // The key and the job are read back. The reservation held across the restart was charged in full by the spend meter.
  assert.equal((await f.control('/providers')).value.providers[1].configured, true);
  assert.deepEqual([(await f.spend()).spentYuan, (await f.spend()).reservedYuan], [0.02, 0]);
  assert.equal((await f.infer('/v1/provider/status', { job: job.value.job })).value.state, 'pending');
  assert.equal((await f.infer('/v1/provider/status', { job: job.value.job })).value.state, 'done');
  const row = await f.settled(now => now.ok === 1);
  assert.deepEqual([row.ok, row.costYuan, (await f.spend()).spentYuan], [1, 0, 0.02]);
  // Finished before another restart: the file list is asked for again when the file is fetched.
  await f.restart();
  const file = await f.infer('/v1/provider/fetch', { job: job.value.job, output: 0 });
  assert.deepEqual([file.status, file.type], [200, 'image/png']);
  assert.equal((await f.row()).ok, 1);
  // A pending job nobody asks about for 72 hours is dropped at the next submit: its estimate is charged, it counts as failed.
  // (Three days on, so a new day's row: the sketch that triggered the sweep and the dropped job.)
  const lost = await submit(f);
  f.state.now += JOB_TTL_MS.async;
  await submit(f, 'mock.sketch');
  assert.equal((await f.infer('/v1/provider/status', { job: lost.value.job })).status, 404);
  assert.equal((await f.infer('/v1/provider/status', { job: job.value.job })).status, 404);
  const after = await f.settled(now => now.failed === 1 && now.ok === 1);
  assert.deepEqual([after.failed, after.ok, after.costYuan, (await f.spend()).byTier.generation], [1, 1, 0.024, 0.024]);
});

test('the gateway only contacts an adapter on its own hosts, and keys of an unknown provider are kept', async t => {
  const stray = { ...FAKE_PROVIDER, operations: { ...FAKE_PROVIDER.operations, 'mock.sketch': { ...FAKE_PROVIDER.operations['mock.sketch'], submit: () => ({ url: 'https://elsewhere.example.com/v1/sketches', method: 'POST', body: '{}' }) } } };
  const f = await fixture(t, { adapters: [stray] });
  await f.control('/providers/key', { provider: 'mock', apiKey: KEY });
  assert.deepEqual([(await submit(f, 'mock.sketch')).code, f.seen.length], ['UPSTREAM_ERROR', 0]);
  assert.deepEqual([(await f.settled(now => now.failed === 1)).failed, (await f.spend()).spentYuan, (await f.spend()).reservedYuan], [1, 0, 0]);
  for (const [route, body] of [['/providers/key', { provider: 'deepseek', apiKey: KEY }], ['/providers/key', { provider: 'other', apiKey: KEY }], ['/providers/key', { provider: 'mock' }], ['/providers/key', { provider: 'mock', apiKey: 'has space' }], ['/providers/clear', { provider: 'deepseek' }], ['/providers/clear', { provider: 'mock', apiKey: '' }]]) assert.equal((await f.control(route, body)).code, 'INVALID_REQUEST', JSON.stringify(Object.keys(body)));
  assert.equal((await f.control('/providers')).value.providers[1].configured, true);
  // A key stored by a release that knew another provider survives this one's writes.
  const keysFile = path.join(f.root, 'providers.json');
  fs.writeFileSync(keysFile, JSON.stringify({ schema: 1, keys: { mock: KEY, later: 'MOCK-LATER-KEY' } }), { mode: 0o600 });
  await f.restart();
  await f.control('/providers/clear', { provider: 'mock' });
  assert.deepEqual(JSON.parse(fs.readFileSync(keysFile, 'utf8')), { schema: 1, keys: { later: 'MOCK-LATER-KEY' } });
  // A keys file this release cannot read stops neither the gateway nor chat, and is never overwritten.
  fs.writeFileSync(keysFile, JSON.stringify({ schema: 2, providers: [] }), { mode: 0o600 });
  await f.restart();
  assert.equal((await f.control('/providers')).value.providers[1].configured, false);
  assert.deepEqual([(await f.control('/providers/key', { provider: 'mock', apiKey: KEY })).status, JSON.parse(fs.readFileSync(keysFile, 'utf8')).schema], [503, 2]);
});
