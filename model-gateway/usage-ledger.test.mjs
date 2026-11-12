import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUsageLedger, DENIAL_REASONS } from './usage-ledger.mjs';
import { createModelGateway } from './server.mjs';
import { CAPABILITIES } from '../capabilities/providers/index.js';
import { capabilityGateway, meteredSpeech } from '../capabilities/media/client.js';

const operator = 'operator-test-token-with-no-real-credential', infer = 'inference-test-token-with-no-real-credential';
const hash = value => createHash('sha256').update(value).digest('hex');
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-ledger-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^fish-ledger-/); await fs.rm(directory, { recursive: true }); });
  return directory;
}
const rowsOf = status => Object.fromEntries(status.rows.map(row => [row.id, row]));
// A capability as a later step would declare it: local, reported by its own process, with a daily limit.
const DEMO = { id: 'demo', title: 'MOCK 演示', meter: { kind: 'local', source: 'reported', unit: 'calls', units: ['videos'], dailyLimit: 2, spendCategory: null, stopTier: null, perPerson: false } };

test('ledger: one row per declared capability; outcomes, denials by reason, units, cost and time add up and survive a restart', async t => {
  const directory = await temporary(t), counters = { vision: 3 };
  const open = async () => { const ledger = createUsageLedger({ directory, capabilities: CAPABILITIES, defaults: { vision: 12, web: 20 }, external: () => counters, clock: () => Date.parse('2026-11-12T04:00:00Z') }); await ledger.start(); return ledger; };
  let ledger = await open();
  let status = await ledger.status();
  assert.deepEqual([status.day, status.timezone, status.rows.map(row => row.id)], ['2026-11-12', 'Asia/Shanghai', ['chat', 'consolidation', 'vision', 'web', 'speech-tts', 'speech-asr']]);
  assert.deepEqual(rowsOf(status).chat, { id: 'chat', title: '聊天', kind: 'paid', unit: 'requests', used: 0, limit: null, calls: 0, ok: 0, failed: 0, denied: {}, units: {}, busyMs: 0, limitDefault: null, costYuan: 0, spendCategory: 'conversation', stopTier: 'exhausted' });
  await ledger.record('chat', { outcome: 'ok', busyMs: 1200, costMicros: 2500 });
  await ledger.record('chat', { outcome: 'failed', busyMs: 300 });
  await ledger.record('chat', { outcome: 'denied', reason: 'spend_tier' });
  await ledger.record('vision', { outcome: 'ok', busyMs: 900, costMicros: 10000 });
  await ledger.record('vision', { outcome: 'denied', reason: 'daily_limit' });
  await ledger.record('vision', { outcome: 'denied', reason: 'daily_limit' });
  await ledger.report({ capability: 'speech-tts', outcome: 'ok', busyMs: 4000, units: { chars: 18, audioSeconds: 3.4 } });
  await ledger.report({ capability: 'speech-tts', outcome: 'ok', busyMs: 2000, units: { chars: 7, audioSeconds: 1.3 } });
  await ledger.report({ capability: 'speech-asr', outcome: 'failed', busyMs: 500 });
  const expected = {
    chat: { used: 2, limit: null, calls: 2, ok: 1, failed: 1, denied: { spend_tier: 1 }, units: {}, costYuan: 0.0025, busyMs: 1500 },
    // `used` is the legacy counter (capability-usage.json), not the ledger's own count.
    vision: { used: 3, limit: 12, calls: 1, ok: 1, failed: 0, denied: { daily_limit: 2 }, units: {}, costYuan: 0.01, busyMs: 900 },
    'speech-tts': { used: 2, limit: null, calls: 2, ok: 2, failed: 0, denied: {}, units: { chars: 25, audioSeconds: 4.7 }, costYuan: 0, busyMs: 6000 },
    'speech-asr': { used: 1, limit: null, calls: 1, ok: 0, failed: 1, denied: {}, units: {}, costYuan: 0, busyMs: 500 },
  };
  const check = async () => { const rows = rowsOf(await ledger.status()); for (const [id, row] of Object.entries(expected)) for (const [key, value] of Object.entries(row)) assert.deepEqual(rows[id][key], value, `${id}.${key}`); };
  await check();
  assert.equal((await fs.stat(path.join(directory, 'usage-ledger.json'))).mode & 0o777, 0o600);
  await ledger.close();
  ledger = await open();
  await check();
  await ledger.close();
});

test('ledger: what may be recorded is closed; a process can only report its own capability and never money', async t => {
  const ledger = createUsageLedger({ directory: await temporary(t), capabilities: CAPABILITIES }); await ledger.start(); t.after(() => ledger.close());
  const refused = promise => assert.rejects(promise, error => error.code === 'INVALID_REQUEST');
  await refused(ledger.record('unknown', { outcome: 'ok' }));
  await refused(ledger.record('chat', { outcome: 'done' }));
  await refused(ledger.record('chat', { outcome: 'denied', reason: 'because' }));
  await refused(ledger.record('chat', { outcome: 'ok', reason: 'paused' }));
  await refused(ledger.record('chat', { outcome: 'ok', busyMs: -1 }));
  await refused(ledger.record('speech-asr', { outcome: 'ok', units: { chars: 3 } }));
  await refused(ledger.record('speech-asr', { outcome: 'ok', units: { audioSeconds: '3' } }));
  // The reporting route: only capabilities whose own process reports them, no cost field, no other keys.
  for (const capability of ['chat', 'consolidation', 'vision', 'web', 'unknown']) await refused(ledger.report({ capability, outcome: 'ok' }));
  await refused(ledger.report({ capability: 'speech-tts', outcome: 'ok', costMicros: 5 }));
  await refused(ledger.report({ capability: 'speech-tts', outcome: 'ok', text: 'MOCK' }));
  await refused(ledger.reserve('vision'));
  for (const reason of DENIAL_REASONS) await ledger.report({ capability: 'speech-tts', outcome: 'denied', reason });
  const row = rowsOf(await ledger.status())['speech-tts'];
  assert.deepEqual([row.calls, Object.keys(row.denied).sort()], [0, [...DENIAL_REASONS].sort()]);
});

test('ledger: reserve takes a daily slot of a limited capability, refuses and counts the denial when none is left; limits can be changed', async t => {
  const directory = await temporary(t);
  const ledger = createUsageLedger({ directory, capabilities: [...CAPABILITIES, DEMO], defaults: { vision: 12, web: 20 } }); await ledger.start(); t.after(() => ledger.close());
  await ledger.reserve('demo'); await ledger.reserve('demo');
  await assert.rejects(ledger.reserve('demo'), error => error.code === 'BUDGET_EXHAUSTED');
  let row = rowsOf(await ledger.status()).demo;
  assert.deepEqual([row.used, row.limit, row.limitDefault, row.denied], [2, 2, 2, { daily_limit: 1 }]);
  await ledger.setLimits({ demo: 3, vision: 5 });
  await ledger.reserve('demo');
  assert.deepEqual([ledger.limit('demo'), ledger.limit('vision'), ledger.limit('web'), ledger.limit('chat'), ledger.limit('speech-tts')], [3, 5, 20, null, null]);
  // A capability without a declared daily limit has none to set; a limit is a whole number of 0–1000.
  for (const bad of [{ chat: 5 }, { 'speech-tts': 5 }, { unknown: 1 }, { vision: -1 }, { vision: 1001 }, { vision: 1.5 }, { vision: '5' }, {}, null, [1]])
    await assert.rejects(ledger.setLimits(bad), error => error.code === 'INVALID_REQUEST', JSON.stringify(bad));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'usage-limits.json'), 'utf8')), { schema: 1, limits: { demo: 3, vision: 5 } });
  const again = createUsageLedger({ directory, capabilities: [...CAPABILITIES, DEMO], defaults: { vision: 12, web: 20 } }); await again.start(); t.after(() => again.close());
  assert.deepEqual([again.limit('demo'), again.limit('vision')], [3, 5]);
  // null returns to the default.
  await again.setLimits({ vision: null });
  row = rowsOf(await again.status()).vision;
  assert.deepEqual([row.limit, row.limitDefault], [12, 12]);
});

test('ledger: a finished Beijing day becomes one history line, the newest 90 are kept, today starts empty', async t => {
  const directory = await temporary(t);
  let now = Date.parse('2026-11-09T15:30:00Z'), counters = { vision: 4 }; // 23:30 on the 9th in Beijing
  const ledger = createUsageLedger({ directory, capabilities: CAPABILITIES, defaults: { vision: 12, web: 20 }, external: () => counters, clock: () => now }); await ledger.start(); t.after(() => ledger.close());
  await ledger.record('chat', { outcome: 'ok', busyMs: 100, costMicros: 1500 });
  await ledger.record('web', { outcome: 'denied', reason: 'spend_tier' });
  assert.deepEqual((await ledger.history(7)).days, []);
  now = Date.parse('2026-11-09T16:00:00Z'); // 00:00 on the 10th in Beijing; UTC is still the 9th
  let status = await ledger.status();
  assert.deepEqual([status.day, rowsOf(status).chat.calls, rowsOf(status).web.denied], ['2026-11-10', 0, {}]);
  let history = await ledger.history(7);
  assert.deepEqual(history.days.map(day => day.day), ['2026-11-09']);
  assert.deepEqual(history.days[0].rows, {
    chat: { used: 1, limit: null, calls: 1, ok: 1, failed: 0, denied: {}, units: {}, busyMs: 100, costYuan: 0.0015 },
    vision: { used: 4, limit: 12, calls: 0, ok: 0, failed: 0, denied: {}, units: {}, busyMs: 0, costYuan: 0 },
    web: { used: 0, limit: 20, calls: 0, ok: 0, failed: 0, denied: { spend_tier: 1 }, units: {}, busyMs: 0, costYuan: 0 },
  });
  // A day on which nothing happened leaves no line.
  counters = {}; now += 3 * 86400000;
  assert.equal((await ledger.status()).day, '2026-11-13');
  assert.equal((await ledger.history(7)).days.length, 1);
  for (let day = 0; day < 95; day++) { await ledger.record('chat', { outcome: 'ok' }); now += 86400000; }
  await ledger.status();
  const lines = (await fs.readFile(path.join(directory, 'usage-history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 90);
  history = await ledger.history(90);
  assert.equal(history.days.length, 90);
  assert.ok(history.days[0].day > history.days[1].day, 'newest first');
  assert.equal((await ledger.history(7)).days.length, 7);
  for (const bad of [0, 91, 1.5, '7']) await assert.rejects(ledger.history(bad), error => error.code === 'INVALID_REQUEST');
});

test('ledger: an unreadable, foreign or future-shaped file never stops it; it starts afresh and keeps what it understands', async t => {
  const directory = await temporary(t), day = '2026-11-12', clock = () => Date.parse('2026-11-12T04:00:00Z');
  const write = (name, text) => fs.writeFile(path.join(directory, name), text, { mode: 0o600 });
  const open = async () => { const ledger = createUsageLedger({ directory, capabilities: CAPABILITIES, clock }); await ledger.start(); t.after(() => ledger.close()); return ledger; };
  await write('usage-ledger.json', '{not json'); await write('usage-limits.json', '[]'); await write('usage-history.jsonl', 'garbage\n{"day":"2026-11-11","rows":{"chat":{"calls":2,"costMicros":3000},"gone":{"calls":1}}}\n');
  let ledger = await open();
  assert.equal(rowsOf(await ledger.status()).chat.calls, 0);
  assert.deepEqual((await ledger.history(7)).days, [{ day: '2026-11-11', rows: { chat: { calls: 2, costYuan: 0.003 } } }]);
  await ledger.record('chat', { outcome: 'ok' });
  // Written by a later release: unknown top-level keys, an unknown capability, an unknown denial reason, an extra row field.
  await write('usage-ledger.json', JSON.stringify({ schema: 1, day, future: true, rows: { chat: { calls: 4, ok: 4, failed: 0, reserved: 0, denied: { paused: 1, novel: 9 }, units: {}, costMicros: 10, busyMs: 5, extra: 1 }, video: { calls: 1 }, web: { calls: 'x' } } }));
  await write('usage-limits.json', JSON.stringify({ schema: 1, limits: { vision: 3, video: 6, web: 5000 } }));
  ledger = await open();
  const rows = rowsOf(await ledger.status());
  assert.deepEqual([rows.chat.calls, rows.chat.denied, rows.web.calls, rows.vision.limit, rows.web.limit], [4, { paused: 1 }, 0, 3, 20]);
  // A file that is not private is not trusted.
  await fs.chmod(path.join(directory, 'usage-ledger.json'), 0o644);
  assert.equal(rowsOf(await (await open()).status()).chat.calls, 0);
});

function request(socketPath, route, body, token, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const sse = 'data: {"choices":[{"delta":{"content":"MOCK"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":1000,"completion_tokens":100}}\n\ndata: [DONE]\n\n';
async function gateway(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-ledger-')), calls = [];
  const state = { paused: false, now: Date.parse('2026-11-14T04:00:00Z') }; // a Saturday: off-peak prices
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ model: 'deepseek-flash', apiKey: 'MOCK-KEY-not-a-real-key' }), { mode: 0o600 });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (state.upstream) return new Response('{}', { status: state.upstream });
    if (url.endsWith('/v1/tools/search')) return new Response(JSON.stringify({ results: [{ title: 'MOCK', url: 'https://example.com/', snippet: 'MOCK' }] }));
    if (body.stream) return new Response(sse);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'MOCK-OK' } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
  };
  const options = { settingsFile: path.join(directory, 'settings.json'), inferenceSocket: path.join(directory, 'infer.sock'), controlSocket: path.join(directory, 'control.sock'), inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), clock: () => state.now, worldStatus: async () => ({ paused: state.paused }), fetchImpl, ...overrides };
  const start = async () => { const instance = createModelGateway(options); await instance.start(); return instance; };
  let instance = await start();
  // The directory goes only after the gateway has closed: a call is written down after its response.
  t.after(async () => { await instance.close(); assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true }); });
  const control = (route, body, method) => request(options.controlSocket, route, body, operator, method ?? (body === undefined ? 'GET' : 'POST'));
  const inference = (route, body, token = infer) => request(options.inferenceSocket, route, body, token);
  // The ledger is written after the response: wait until it shows what the caller expects.
  const usage = async (settled = () => true) => { for (let i = 0; ; i++) { const rows = rowsOf((await control('/usage')).json().value); if (settled(rows) || i > 200) return rows; await new Promise(resolve => setTimeout(resolve, 10)); } };
  return { directory, calls, state, control, inference, usage, restart: async () => { await instance.close(); instance = await start(); },
    chat: () => inference('/v1/chat/completions', { model: 'deepseek', messages: [{ role: 'user', content: 'MOCK synthetic test' }], stream: true }),
    memory: () => inference('/v1/memory/completions', { model: 'deepseek', messages: [{ role: 'user', content: 'MOCK synthetic material' }], stream: false }),
    vision: () => inference('/v1/vision/describe', { imageBase64: PNG, mime: 'image/png' }), search: () => inference('/v1/web/search', { query: 'MOCK' }) };
}

test('gateway: every exit lands in its row, and the rows add up to what the spend meter charged', async t => {
  const f = await gateway(t);
  for (const call of [f.chat, f.chat, f.memory, f.vision, f.search]) assert.equal((await call()).status, 200);
  const rows = await f.usage(seen => seen.web.ok === 1 && seen.chat.ok === 2);
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, [row.used, row.limit, row.calls, row.ok, row.failed, row.denied]])), {
    chat: [2, null, 2, 2, 0, {}], consolidation: [1, null, 1, 1, 0, {}], vision: [1, 12, 1, 1, 0, {}], web: [1, 20, 1, 1, 0, {}], 'speech-tts': [0, null, 0, 0, 0, {}], 'speech-asr': [0, null, 0, 0, 0, {}],
  });
  const spend = (await f.control('/spend')).json().value;
  for (const row of Object.values(rows)) if (row.spendCategory) assert.equal(row.costYuan, spend.byTier[row.spendCategory], row.id);
  assert.ok(rows.chat.costYuan > 0 && rows.consolidation.costYuan > 0);
  // Tokens as the provider reported them, per row; together they are the spend meter's totals.
  assert.deepEqual([rows.chat.units, rows.consolidation.units], [{ inputTokens: 2000, outputTokens: 200 }, { inputTokens: 40, outputTokens: 20 }]);
  assert.deepEqual([spend.tokens.cacheHit + spend.tokens.cacheMiss, spend.tokens.output], [2040, 220]);
  assert.deepEqual([rows.vision.costYuan, rows.web.costYuan], [0.01, 0.005]);
  assert.equal(Math.round(Object.values(rows).reduce((sum, row) => sum + row.costYuan * 1e6, 0)), Math.round(spend.spentYuan * 1e6));
  assert.equal(Object.values(rows).reduce((sum, row) => sum + row.ok + row.failed, 0), spend.calls);
  // The legacy counter file keeps exactly the fields the previous release accepts.
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(f.directory, 'capability-usage.json'), 'utf8'))).sort(), ['day', 'inputTokens', 'outputTokens', 'schema', 'unreportedUsageResponses', 'visionCalls', 'webCalls']);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'spend.json'), 'utf8')).schema, 1);
});

test('gateway: a refusal is counted by its reason and never reaches the provider', async t => {
  const f = await gateway(t, { budgets: { vision: 1, web: 20 } });
  assert.equal((await f.vision()).status, 200);
  let refused = await f.vision();
  assert.deepEqual([refused.status, refused.json().error.code], [429, 'BUDGET_EXHAUSTED']);
  let rows = await f.usage(seen => seen.vision.denied.daily_limit === 1);
  assert.deepEqual([rows.vision.used, rows.vision.limit, rows.vision.calls, rows.vision.denied, f.calls.length], [1, 1, 1, { daily_limit: 1 }, 1]);
  // Paused: chat, maintenance, vision and web are each refused before anything is sent.
  f.state.paused = true;
  for (const call of [f.chat, f.memory, f.vision, f.search]) assert.equal((await call()).status, 409);
  rows = await f.usage(seen => seen.web.denied.paused === 1 && seen.chat.denied.paused === 1);
  assert.deepEqual([rows.chat.denied, rows.consolidation.denied, rows.vision.denied, rows.web.denied], [{ paused: 1 }, { paused: 1 }, { daily_limit: 1, paused: 1 }, { paused: 1 }]);
  f.state.paused = false;
  // Spend tiers: maintenance, vision and web stop at "restricted", chat only at 100%.
  assert.equal((await f.control('/spend/settings', { dailyCapYuan: 0.01, reducedPercent: 1, restrictedPercent: 2 })).status, 200);
  assert.equal((await f.search()).status, 429); assert.equal((await f.memory()).status, 429); assert.equal((await f.chat()).status, 429);
  rows = await f.usage(seen => seen.chat.denied.spend_tier === 1 && seen.web.denied.spend_tier === 1);
  assert.deepEqual([rows.chat.denied.spend_tier, rows.consolidation.denied.spend_tier, rows.web.denied.spend_tier, rows.web.calls, rows.chat.calls], [1, 1, 1, 0, 0]);
  assert.equal(f.calls.length, 1, 'only the first vision call was sent');
  // A provider error is a failed call, not a refusal; a malformed request is neither.
  await f.control('/spend/settings', { dailyCapYuan: 5, reducedPercent: 60, restrictedPercent: 80 });
  f.state.upstream = 500;
  assert.equal((await f.search()).status, 502);
  assert.equal((await f.inference('/v1/web/search', { query: '' })).status, 400);
  rows = await f.usage(seen => seen.web.failed === 1);
  assert.deepEqual([rows.web.calls, rows.web.ok, rows.web.failed, rows.web.costYuan, rows.web.used], [1, 0, 1, 0, 1]);
});

test('gateway: operator reads /usage and history and changes a daily limit; the limit applies to the next call', async t => {
  const f = await gateway(t);
  assert.equal((await request(path.join(f.directory, 'control.sock'), '/usage', undefined, infer, 'GET')).status, 401, 'the inference token cannot read the control socket');
  assert.equal((await f.inference('/usage', {})).status, 404, 'usage is not readable on the inference socket');
  assert.equal((await f.vision()).status, 200);
  let changed = await f.control('/usage/limits', { limits: { vision: 1 } });
  assert.equal(changed.status, 200);
  assert.deepEqual((({ limit, limitDefault }) => [limit, limitDefault])(rowsOf(changed.json().value).vision), [1, 12]);
  assert.equal((await f.vision()).status, 429);
  assert.equal((await f.control('/usage/limits', { limits: { vision: null } })).status, 200);
  assert.equal((await f.vision()).status, 200);
  for (const bad of [{ limits: { chat: 3 } }, { limits: { vision: -1 } }, { limits: {} }, { vision: 3 }, {}]) assert.equal((await f.control('/usage/limits', bad)).status, 400, JSON.stringify(bad));
  // The limit file survives a restart; so do today's rows.
  await f.control('/usage/limits', { limits: { web: 7 } });
  const before = await f.usage(seen => seen.vision.ok === 2);
  await f.restart();
  const after = await f.usage();
  assert.deepEqual(after, before);
  assert.equal(after.web.limit, 7);
  // History: nothing yet today; after midnight the finished day is one line.
  assert.deepEqual((await f.control('/usage/history')).json().value.days, []);
  f.state.now += 86400000;
  const history = (await f.control('/usage/history?days=7')).json().value;
  assert.deepEqual(history.days.map(day => [day.day, day.rows.vision.used, day.rows.vision.ok, day.rows.vision.denied]), [['2026-11-14', 2, 2, { daily_limit: 1 }]]);
  assert.equal((await f.usage()).vision.used, 0);
  for (const route of ['/usage/history?days=0', '/usage/history?days=100', '/usage/history?days=x', '/usage/history?other=1', '/usage?x=1']) assert.equal((await f.control(route)).status, 404, route);
  assert.equal((await f.control('/usage/history?days=91')).status, 400);
});

test('gateway: a local capability reports through the inference socket; only its own rows, never money', async t => {
  const f = await gateway(t);
  assert.equal((await f.inference('/v1/usage/record', { capability: 'speech-tts', outcome: 'ok', busyMs: 5200, units: { chars: 21, audioSeconds: 4.2 } })).status, 200);
  assert.equal((await f.inference('/v1/usage/record', { capability: 'speech-asr', outcome: 'ok', busyMs: 900, units: { audioSeconds: 6.5 } })).status, 200);
  assert.equal((await f.inference('/v1/usage/record', { capability: 'speech-asr', outcome: 'failed', busyMs: 100 })).status, 200);
  for (const bad of [{ capability: 'chat', outcome: 'ok' }, { capability: 'vision', outcome: 'ok' }, { capability: 'speech-tts', outcome: 'ok', costMicros: 1 }, { capability: 'speech-tts', outcome: 'ok', units: { videos: 1 } }, { capability: 'speech-tts' }, {}])
    assert.equal((await f.inference('/v1/usage/record', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await f.inference('/v1/usage/record', { capability: 'speech-tts', outcome: 'ok' }, operator)).status, 401);
  // Recording is not gated by pause: what already ran is still counted.
  f.state.paused = true;
  assert.equal((await f.inference('/v1/usage/record', { capability: 'speech-tts', outcome: 'ok', busyMs: 800, units: { chars: 4, audioSeconds: 0.8 } })).status, 200);
  // Reserving a slot is refused while paused, and counted as such.
  const paused = await f.inference('/v1/usage/reserve', { capability: 'speech-tts' });
  assert.deepEqual([paused.status, paused.json().error.code], [409, 'WORLD_PAUSED']);
  f.state.paused = false;
  assert.equal((await f.inference('/v1/usage/reserve', { capability: 'speech-tts' })).status, 200, 'no daily limit declared: a slot is always granted');
  for (const bad of [{ capability: 'vision' }, { capability: 'chat' }, { capability: 'speech-tts', extra: 1 }, {}]) assert.equal((await f.inference('/v1/usage/reserve', bad)).status, 400, JSON.stringify(bad));
  const rows = await f.usage();
  assert.deepEqual([rows['speech-tts'].calls, rows['speech-tts'].ok, rows['speech-tts'].units, rows['speech-tts'].busyMs, rows['speech-tts'].denied, rows['speech-tts'].costYuan], [2, 2, { chars: 25, audioSeconds: 5 }, 6000, { paused: 1 }, 0]);
  assert.deepEqual([rows['speech-asr'].calls, rows['speech-asr'].ok, rows['speech-asr'].failed, rows['speech-asr'].units, rows['speech-asr'].busyMs], [2, 1, 1, { audioSeconds: 6.5 }, 1000]);
  assert.equal(f.calls.length, 0);
  // The content service's own client and wrapper, against this gateway: a synthesis shows up in the row.
  await fs.writeFile(path.join(f.directory, 'inference.token'), infer + '\n', { mode: 0o600 });
  const { recordUsage } = capabilityGateway({ socketPath: path.join(f.directory, 'infer.sock'), tokenFile: path.join(f.directory, 'inference.token') });
  const speech = meteredSpeech({ synthesize: async () => ({ durationMs: 2000 }), transcribe: async () => ({ durationMs: 1000 }) }, recordUsage);
  await speech.synthesize({ text: 'MOCK 五个字' });
  const counted = await f.usage(seen => seen['speech-tts'].ok === 3);
  assert.deepEqual([counted['speech-tts'].ok, counted['speech-tts'].units], [3, { chars: 33, audioSeconds: 7 }]);
});

test('gateway: a ledger that cannot be written never fails or delays a model call', async t => {
  const f = await gateway(t);
  // The ledger's files are replaced by directories: every write and read of them fails from now on.
  for (const name of ['usage-ledger.json', 'usage-history.jsonl', 'usage-limits.json']) { await fs.rm(path.join(f.directory, name), { force: true }); await fs.mkdir(path.join(f.directory, name)); }
  for (const call of [f.chat, f.memory, f.vision, f.search]) assert.equal((await call()).status, 200);
  assert.equal((await f.control('/spend')).json().value.calls, 4);
  assert.equal((await f.control('/usage')).status, 200);
  // The gateway also starts on such a directory, and on a data root the previous release wrote (no ledger files at all).
  await f.restart();
  assert.equal((await f.chat()).status, 200);
});
