import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModelGateway } from './server.mjs';

const operator = 'operator-test-token-with-no-real-credential', infer = 'inference-test-token-with-no-real-credential';
const hash = value => createHash('sha256').update(value).digest('hex');
function request(socketPath, route, body, token = operator, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, json: () => JSON.parse(text), headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, fetchImpl, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-model-'));
  const options = { settingsFile: path.join(directory, 'settings.json'), usageFile: path.join(directory, 'capability-usage.json'), inferenceSocket: path.join(directory, 'infer.sock'), controlSocket: path.join(directory, 'control.sock'), inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), ...overrides };
  let paused = true;
  const gateway = createModelGateway({ ...options, fetchImpl, worldStatus: async () => ({ paused }) });
  await gateway.start();
  t.after(async () => {
    await gateway.close();
    // mkdtemp returned this absolute, dedicated test-owned directory.
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^fish-model-/);
    await fs.rm(directory, { recursive: true });
  });
  return { ...options, gateway, pause: value => { paused = value; }, control: (route, body, token, method) => request(options.controlSocket, route, body, token, method), inference: (body, token = infer) => request(options.inferenceSocket, '/v1/chat/completions', body, token), memory: body => request(options.inferenceSocket, '/v1/memory/completions', body, infer), capability: (route, body, token = infer) => request(options.inferenceSocket, route, body, token) };
}
const prompt = { model: 'deepseek', messages: [{ role: 'user', content: 'synthetic test' }], stream: true };

test('private settings, paused-only edits, model alias and lossless SSE/tool reasoning pass-through', async t => {
  const calls = [];
  const sse = 'data: {"choices":[{"delta":{"reasoning_content":"reason","tool_calls":[{"id":"call-1","function":{"name":"test","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return new Response(sse, { headers: { 'x-private-upstream': 'do-not-forward' } }); });
  let result = await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key-not-a-real-secret' });
  assert.equal(result.status, 200);
  assert.equal(result.json().value.status, 'configured');
  assert.equal(result.text.includes('synthetic-key'), false);
  assert.equal((await fs.stat(f.settingsFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.controlSocket)).mode & 0o777, 0o600);
  assert.equal((await f.inference(prompt)).status, 409);
  assert.equal(calls.length, 0);
  f.pause(false);
  result = await f.inference({ ...prompt, max_tokens: 20000 });
  assert.equal(result.status, 200);
  assert.equal(result.text, sse);
  assert.equal(result.headers['x-private-upstream'], undefined);
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].headers.authorization, 'Bearer synthetic-key-not-a-real-secret');
  assert.equal((await f.control('/model', { model: 'deepseek-v4-pro', apiKey: '' })).status, 409);
  f.pause(true);
  assert.equal((await f.control('/model', { model: 'deepseek-v4-pro', apiKey: '' })).status, 200);
  assert.equal(JSON.parse(await fs.readFile(f.settingsFile, 'utf8')).apiKey, 'synthetic-key-not-a-real-secret');
  const second = createModelGateway({ settingsFile: f.settingsFile, inferenceSocket: f.inferenceSocket, controlSocket: f.controlSocket, inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), worldStatus: async () => ({ paused: true }) });
  await assert.rejects(second.start(), /already active/);
});

test('role isolation, unconfigured gate and sanitized upstream failures including explicit test', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response('SECRET-UPSTREAM-KEY-OR-ERROR', { status: 401, headers: { 'x-secret': 'sensitive' } }); });
  assert.equal((await f.control('/model', undefined, infer, 'GET')).status, 401);
  assert.equal((await f.inference(prompt, operator)).status, 401);
  f.pause(false);
  assert.equal((await f.inference(prompt)).status, 503);
  assert.equal(calls, 0);
  f.pause(true);
  assert.equal((await f.control('/model', { model: 'deepseek-chat', apiKey: 'fake' })).status, 400);
  assert.equal((await f.control('/model', { model: 'deepseek-flash', apiKey: '' })).status, 400);
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' });
  const probe = await f.control('/model/test', {});
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.json().value, { ok: false, code: 'UPSTREAM_AUTH', model: 'deepseek-flash' });
  assert.equal(calls, 1); // Explicit operator test is allowed while paused.
  const state = (await f.control('/model', undefined, operator, 'GET')).json().value;
  assert.equal(state.status, 'error');
  assert.equal(state.lastTest.ok, false);
  f.pause(false);
  const rejected = await f.inference(prompt);
  assert.equal(rejected.status, 502);
  assert.equal(rejected.text.includes('SECRET'), false);
  assert.equal(rejected.headers['x-secret'], undefined);
});

test('operator cancellation aborts active inference and a successful explicit probe marks verified', async t => {
  let abortSeen = false, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async (_url, options) => {
    if (JSON.parse(options.body).stream === false) return new Response('{"choices":[{"message":{"content":"OK"}}]}');
    entered();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { abortSeen = true; reject(new Error('private error')); }, { once: true }));
  });
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' });
  const probe = await f.control('/model/test', {});
  assert.equal(probe.json().value.ok, true);
  assert.equal((await f.control('/model', undefined, operator, 'GET')).json().value.status, 'verified');
  f.pause(false);
  const pending = f.inference(prompt);
  await started;
  f.pause(true);
  assert.equal((await f.control('/model', { model: 'deepseek-v4-pro' })).status, 409);
  assert.equal((await f.control('/cancel', {})).status, 200);
  assert.equal((await pending).status, 503);
  assert.equal(abortSeen, true);
});

test('memory completion is bounded and toolless, disables reasoning, and still respects pause', async t => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response('{"choices":[{"message":{"content":"{\\"text\\":\\"reflection\\",\\"sourceIds\\":[\\"m1\\"]}"}}],"usage":{"prompt_tokens":40,"completion_tokens":20}}'); });
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' });
  const request = { model: 'deepseek', messages: [{ role: 'user', content: 'synthetic authorized material' }], max_tokens: 2000, stream: false };
  assert.equal((await f.memory(request)).status, 409);
  assert.equal(calls.length, 0);
  f.pause(false);
  assert.equal((await f.memory(request)).status, 200);
  assert.equal(calls[0].max_tokens, 1536);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[0].reasoning_effort, undefined);
  assert.equal((await f.memory({ ...request, tools: [] })).status, 400);
  assert.equal((await f.memory({ ...request, messages: [{ role: 'user', content: 'x'.repeat(8001) }] })).status, 400);
  assert.equal(calls.length, 1);
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a7cAAAAASUVORK5CYII=';
test('vision and read-only web capabilities use fixed provider schemas, bounded derived outputs and pause gates', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, headers: options.headers });
    if (url.endsWith('/tools/search')) {
      assert.deepEqual(body, { query: 'synthetic query', count: 5, need_content: false });
      return new Response(JSON.stringify({ results: Array.from({ length: 6 }, (_, i) => ({ title: 'result-' + i, url: 'https://example.com/' + i, snippet: 'short', summary: 'e'.repeat(900) })) }));
    }
    if (url.endsWith('/tools/fetch')) return new Response(JSON.stringify({ title: 'page', content: 'c'.repeat(8100) }));
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 512); assert.equal(body.tools, undefined);
    assert.deepEqual(body.messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png, detail: 'low' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'v'.repeat(2500) } }], usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } }));
  });
  await f.control('/model', { model: 'deepseek-v4-pro', apiKey: 'synthetic-key' });
  const image = { imageBase64: png, mime: 'image/png' };
  assert.equal((await f.capability('/v1/vision/describe', image)).status, 409);
  assert.equal((await f.capability('/v1/web/search', { query: 'synthetic query' })).status, 409);
  assert.equal((await f.capability('/v1/web/fetch', { url: 'https://example.com' })).status, 409);
  assert.equal(calls.length, 0); await assert.rejects(fs.access(f.usageFile), { code: 'ENOENT' });
  f.pause(false);
  const vision = (await f.capability('/v1/vision/describe', image)).json().value;
  assert.equal(vision.description.length, 2400); assert.equal(vision.truncated, true); assert.equal(vision.isNewEvidence, false); assert.deepEqual(vision.usage, { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 });
  const search = (await f.capability('/v1/web/search', { query: 'synthetic query', count: 5 })).json().value;
  assert.equal(search.results.length, 5); assert.equal(search.results[0].excerpt.length, 800); assert.equal(search.truncated, true); assert.equal(search.external, true); assert.equal(search.usage, null);
  const page = (await f.capability('/v1/web/fetch', { url: 'https://example.com/page' })).json().value;
  assert.equal(page.content.length, 8000); assert.equal(page.truncated, true); assert.equal(page.derived, true);
  assert.equal(calls[2].url, 'https://api.deepseek.com/v1/tools/fetch'); assert.equal(calls[2].headers.cookie, undefined);
  const saved = JSON.parse(await fs.readFile(f.usageFile, 'utf8'));
  assert.equal(saved.webCalls, 2); assert.equal(saved.visionCalls, 1); assert.equal(saved.inputTokens, 23); assert.equal(saved.outputTokens, 11);
  const raw = await fs.readFile(f.usageFile, 'utf8'); assert.equal(raw.includes('synthetic query'), false); assert.equal(raw.includes('example.com'), false); assert.equal(raw.includes(png), false);
  assert.equal(JSON.parse(await fs.readFile(f.settingsFile, 'utf8')).model, 'deepseek-v4-pro');
});

test('failed capability attempts retain their daily reservations across gateway restart without reflecting provider errors', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response('PRIVATE_PROVIDER_RESPONSE', { status: 401 }); }, { budgets: { web: 1, vision: 1 } });
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' }); f.pause(false);
  const bad = await f.capability('/v1/web/search', { query: 'private synthetic input' });
  assert.equal(bad.status, 502); assert.equal(bad.text.includes('PRIVATE_PROVIDER'), false); assert.equal(bad.text.includes('private synthetic input'), false);
  assert.equal((await f.capability('/v1/web/fetch', { url: 'https://example.com' })).status, 429);
  assert.equal((await f.capability('/v1/vision/describe', { imageBase64: png, mime: 'image/png' })).status, 502);
  assert.equal(calls, 2);
  await f.gateway.close();
  const reopened = createModelGateway({ settingsFile: f.settingsFile, usageFile: f.usageFile, inferenceSocket: f.inferenceSocket, controlSocket: f.controlSocket, inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), budgets: { web: 1, vision: 1 }, worldStatus: async () => ({ paused: false }), fetchImpl: async () => { calls++; throw Error('must not call'); } });
  await reopened.start();
  try {
    assert.equal((await request(f.inferenceSocket, '/v1/web/search', { query: 'retry' }, infer)).status, 429);
    assert.equal((await request(f.inferenceSocket, '/v1/vision/describe', { imageBase64: png, mime: 'image/png' }, infer)).status, 429);
    assert.equal(calls, 2);
  } finally { await reopened.close(); }
  const saved = JSON.parse(await fs.readFile(f.usageFile, 'utf8')); assert.equal(saved.webCalls, 1); assert.equal(saved.visionCalls, 1);
});

test('capability credentials and public-only inputs are checked before budget reservation or provider traffic', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw Error('must not call'); });
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' }); f.pause(false);
  assert.equal((await f.capability('/v1/web/search', { query: 'query' }, operator)).status, 401);
  assert.equal((await f.capability('/v1/web/fetch', { url: 'http://127.0.0.1/private' })).status, 400);
  assert.equal((await f.capability('/v1/web/fetch', { url: 'https://user:password@example.com/' })).status, 400);
  assert.equal((await f.capability('/v1/vision/describe', { imageBase64: png, mime: 'image/jpeg' })).status, 400);
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1); tooLarge[0] = 255; tooLarge[1] = 216; tooLarge[2] = 255;
  assert.equal((await f.capability('/v1/vision/describe', { imageBase64: tooLarge.toString('base64'), mime: 'image/jpeg' })).status, 400);
  assert.equal(calls, 0); await assert.rejects(fs.access(f.usageFile), { code: 'ENOENT' });
});

test('a spend-tier refusal of vision/web is SPEND_RESTRICTED; the daily call count stays BUDGET_EXHAUSTED', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response(JSON.stringify({ results: [] })); }, { budgets: { web: 1, vision: 1 }, clock: () => Date.parse('2026-11-09T02:00:00Z') });
  await f.control('/model', { model: 'deepseek-flash', apiKey: 'synthetic-key' }); f.pause(false);
  assert.equal((await f.capability('/v1/web/search', { query: 'x' })).status, 200);
  const counted = await f.capability('/v1/web/search', { query: 'x' });
  assert.deepEqual([counted.status, counted.json().error.code], [429, 'BUDGET_EXHAUSTED']);
  // One web call cost 0.005 of a 0.01 cap: 50%, restricted once that tier starts at 40%.
  assert.equal((await f.control('/spend/settings', { dailyCapYuan: 0.01, reducedPercent: 30, restrictedPercent: 40 })).json().value.tier, 'restricted');
  for (const [route, body] of [['/v1/vision/describe', { imageBase64: png, mime: 'image/png' }], ['/v1/web/search', { query: 'x' }], ['/v1/web/fetch', { url: 'https://example.com' }]]) {
    const refused = await f.capability(route, body);
    assert.deepEqual([refused.status, refused.json().error.code], [429, 'SPEND_RESTRICTED'], route);
  }
  assert.equal(calls, 1);
  const saved = JSON.parse(await fs.readFile(f.usageFile, 'utf8')); assert.equal(saved.visionCalls, 0, 'a spend refusal does not consume the daily count');
});

test('daily vision/web counts roll over at Beijing midnight; a usage file with a UTC day from an older release still loads', async t => {
  let now = Date.parse('2026-11-09T15:30:00Z'), calls = 0; // 23:30 Monday in Beijing, still the 9th in UTC too
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-model-')), usageFile = path.join(directory, 'capability-usage.json');
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true }); });
  // Written by the previous release at 23:30 Beijing time: day is the UTC date, both counters at their limit.
  await fs.writeFile(usageFile, JSON.stringify({ schema: 1, day: '2026-11-09', webCalls: 1, visionCalls: 1, inputTokens: 5, outputTokens: 7, unreportedUsageResponses: 0 }), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-key' }), { mode: 0o600 });
  const gateway = createModelGateway({ settingsFile: path.join(directory, 'settings.json'), usageFile, inferenceSocket: path.join(directory, 'infer.sock'), controlSocket: path.join(directory, 'control.sock'), inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), budgets: { web: 1, vision: 1 }, clock: () => now, worldStatus: async () => ({ paused: false }), fetchImpl: async () => { calls++; return new Response(JSON.stringify({ results: [] })); } });
  await gateway.start(); t.after(() => gateway.close());
  const search = () => request(path.join(directory, 'infer.sock'), '/v1/web/search', { query: 'x' }, infer);
  assert.equal((await search()).status, 429, 'same day in both calendars: the stored count still applies');
  now = Date.parse('2026-11-09T16:00:00Z'); // 00:00 Tuesday in Beijing, 16:00 Monday UTC
  assert.equal((await search()).status, 200, 'the Beijing day changed');
  assert.equal((await search()).status, 429);
  let saved = JSON.parse(await fs.readFile(usageFile, 'utf8'));
  assert.deepEqual([saved.day, saved.webCalls, saved.visionCalls, saved.inputTokens], ['2026-11-10', 1, 0, 0]);
  now = Date.parse('2026-11-10T00:30:00Z'); // UTC midnight passed: still Tuesday in Beijing, no reset
  assert.equal((await search()).status, 429);
  assert.equal(calls, 1);
});
