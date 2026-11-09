// The host timezone must not matter: run everything from a non-Beijing zone.
process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModelGateway } from './server.mjs';
import { DEFAULT_PRICING, beijingDay, createSpendMeter, isPeak, parseUsage, usageCost, validSpendSettings, validPricing } from './spend.mjs';

const operator = 'operator-test-token-with-no-real-credential', infer = 'inference-test-token-with-no-real-credential';
const hash = value => createHash('sha256').update(value).digest('hex');
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-spend-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
// Monday 2026-11-09 in Beijing.
const BJ = (hhmm, day = '2026-11-09') => Date.parse(`${day}T${hhmm}:00+08:00`);

test('peak/off-peak windows and the day boundary follow Beijing time, not the host zone', () => {
  assert.equal(new Date(0).getTimezoneOffset() !== -480, true, 'host zone is not Beijing');
  assert.equal(isPeak(DEFAULT_PRICING, BJ('09:00')), true);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('11:59')), true);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('12:00')), false);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('14:30')), true);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('18:00')), false);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('08:59')), false);
  assert.equal(isPeak(DEFAULT_PRICING, BJ('10:00', '2026-11-08')), false, 'Sunday is off-peak');
  assert.equal(isPeak({ ...DEFAULT_PRICING, peak: { ...DEFAULT_PRICING.peak, offPeakDates: ['2026-11-09'] } }, BJ('10:00')), false, 'listed holiday');
  assert.equal(beijingDay(Date.parse('2026-11-08T15:59:59Z')), '2026-11-08');
  assert.equal(beijingDay(Date.parse('2026-11-08T16:00:00Z')), '2026-11-09');
});

test('usage parsing counts cache hits, misses and reasoning output at the window price', () => {
  const usage = parseUsage({ prompt_tokens: 3000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 2000, completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 2500 } });
  assert.deepEqual(usage, { cacheHit: 1000, cacheMiss: 2000, output: 3000, reasoning: 2500 });
  // flash peak: 1000×0.04 + 2000×2 + 3000×8 = 28040 micro-yuan; off-peak is half.
  assert.equal(usageCost(DEFAULT_PRICING, 'deepseek-flash', usage, BJ('10:00')), 28040);
  assert.equal(usageCost(DEFAULT_PRICING, 'deepseek-flash', usage, BJ('20:00')), 14020);
  assert.equal(usageCost(DEFAULT_PRICING, 'deepseek-v4-pro', usage, BJ('10:00')), 1000 * 0.3 + 2000 * 9 + 3000 * 27);
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 5 }), { cacheHit: 0, cacheMiss: 10, output: 5, reasoning: 0 });
  assert.equal(parseUsage({}), null);
  assert.equal(validPricing(DEFAULT_PRICING), true);
  assert.equal(validPricing({ ...DEFAULT_PRICING, peak: { ...DEFAULT_PRICING.peak, windows: [['12:00', '09:00']] } }), false);
});

test('meter rolls over at Beijing midnight and charges reservations that never report usage', async t => {
  const dir = await directory(t);
  let now = Date.parse('2026-11-08T15:50:00Z'); // 23:50 Sunday in Beijing (off-peak)
  const files = { stateFile: path.join(dir, 'spend.json'), settingsFile: path.join(dir, 'spend-settings.json'), pricingFile: path.join(dir, 'model-pricing.json') };
  const meter = createSpendMeter({ ...files, clock: () => now });
  await meter.start();
  assert.deepEqual(JSON.parse(await fs.readFile(files.pricingFile, 'utf8')), DEFAULT_PRICING, 'missing price table is written with verified defaults');
  assert.equal((await fs.stat(files.pricingFile)).mode & 0o777, 0o600);
  const usage = { cacheHit: 0, cacheMiss: 100000, output: 0 };
  let handle = await meter.reserve('conversation', () => 50000);
  assert.equal(meter.status().reservedYuan, 0.05);
  await meter.settle(handle, usageCost(handle.pricing, 'deepseek-flash', usage, handle.at));
  assert.deepEqual([meter.status().day, meter.status().spentYuan, meter.status().reservedYuan, meter.status().window], ['2026-11-08', 0.1, 0, 'offPeak']);
  handle = await meter.reserve('maintenance', () => 30000);
  await meter.settle(handle, null); // no usage reported: the reservation is charged
  assert.equal(meter.status().spentYuan, 0.13); assert.equal(meter.status().unreportedUsage, 1);
  assert.deepEqual(meter.status().byTier, { conversation: 0.1, maintenance: 0.03, vision: 0, web: 0 });
  // A reservation still in flight at midnight is carried into the new day.
  handle = await meter.reserve('conversation', () => 20000);
  now = Date.parse('2026-11-09T02:00:00Z'); // Monday 10:00 in Beijing: new day, peak
  assert.deepEqual([meter.status().day, meter.status().spentYuan, meter.status().reservedYuan, meter.status().window], ['2026-11-09', 0, 0.02, 'peak']);
  await meter.settle(handle, 10000);
  assert.deepEqual([meter.status().spentYuan, meter.status().reservedYuan], [0.01, 0]);
  // A provider error releases the reservation without charge.
  handle = await meter.reserve('web', () => 5000); await meter.settle(handle, 5000, { charge: false });
  assert.equal(meter.status().spentYuan, 0.01);
  // A reservation held across a restart is charged on the next start.
  await meter.reserve('conversation', () => 40000);
  const restarted = createSpendMeter({ ...files, clock: () => now });
  await restarted.start();
  assert.deepEqual([restarted.status().spentYuan, restarted.status().reservedYuan], [0.05, 0]);
});

test('tiers: reduced stops proactive, restricted stops maintenance/vision/web, exhausted stops everything', async t => {
  const dir = await directory(t);
  const meter = createSpendMeter({ stateFile: path.join(dir, 's.json'), settingsFile: path.join(dir, 'ss.json'), pricingFile: path.join(dir, 'p.json'), clock: () => BJ('20:00') });
  await meter.start();
  await meter.updateSettings({ dailyCapYuan: 1 });
  const spendTo = async yuan => { const h = await meter.reserve('conversation', () => 0); await meter.settle(h, yuan * 1e6 - meter.status().spentYuan * 1e6); };
  const allowed = async category => { try { await meter.settle(await meter.reserve(category, () => 0), 0, { charge: false }); return true; } catch (error) { assert.equal(error.code, 'BUDGET_EXHAUSTED'); return false; } };
  const matrix = async () => Object.fromEntries(await Promise.all(['proactive', 'maintenance', 'vision', 'web', 'conversation'].map(async c => [c, await allowed(c)])));
  assert.deepEqual(await matrix(), { proactive: true, maintenance: true, vision: true, web: true, conversation: true });
  await spendTo(0.6); assert.equal(meter.status().tier, 'reduced');
  assert.deepEqual(await matrix(), { proactive: false, maintenance: true, vision: true, web: true, conversation: true });
  await spendTo(0.8); assert.equal(meter.status().tier, 'restricted');
  assert.deepEqual(await matrix(), { proactive: false, maintenance: false, vision: false, web: false, conversation: true });
  await spendTo(1); assert.equal(meter.status().tier, 'exhausted');
  assert.deepEqual(await matrix(), { proactive: false, maintenance: false, vision: false, web: false, conversation: false });
  // Raising the cap takes effect immediately.
  await meter.updateSettings({ dailyCapYuan: 10 });
  assert.equal(meter.status().tier, 'normal'); assert.equal(await allowed('maintenance'), true);
});

test('spend settings are validated and persisted', async t => {
  const dir = await directory(t);
  const files = { stateFile: path.join(dir, 's.json'), settingsFile: path.join(dir, 'ss.json'), pricingFile: path.join(dir, 'p.json') };
  const meter = createSpendMeter(files); await meter.start();
  assert.deepEqual(meter.settings(), { dailyCapYuan: 5, reducedPercent: 60, restrictedPercent: 80 });
  for (const bad of [{ dailyCapYuan: 0 }, { dailyCapYuan: -1 }, { dailyCapYuan: '5' }, { reducedPercent: 0 }, { reducedPercent: 80 }, { restrictedPercent: 100 }, { reducedPercent: 90, restrictedPercent: 85 }, { other: 1 }])
    await assert.rejects(meter.updateSettings(bad), { code: 'INVALID_REQUEST' }, JSON.stringify(bad));
  assert.equal(validSpendSettings({ dailyCapYuan: 0.01, reducedPercent: 1, restrictedPercent: 99 }), true);
  await meter.updateSettings({ dailyCapYuan: 2.5, reducedPercent: 50, restrictedPercent: 70 });
  const again = createSpendMeter(files); await again.start();
  assert.deepEqual(again.settings(), { dailyCapYuan: 2.5, reducedPercent: 50, restrictedPercent: 70 });
  assert.equal((await fs.stat(files.settingsFile)).mode & 0o777, 0o600);
  // An unreadable price table falls back to peak prices at every hour.
  await fs.writeFile(files.pricingFile, '{"schema":1}', { mode: 0o600 });
  await again.settle(await again.reserve('conversation', () => 0), 0, { charge: false });
  assert.equal(again.status().pricing, 'fallback');
});

function request(socketPath, route, body, token, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('gateway forces include_usage, meters chat by reported usage, exposes /spend and honors a new cap at once', async t => {
  const dir = await directory(t), calls = [];
  const usage = { prompt_tokens: 1200, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 400 } };
  const sse = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":${JSON.stringify(usage)}}\n\ndata: [DONE]\n\n`;
  let mode = 'ok';
  const gateway = createModelGateway({ settingsFile: path.join(dir, 'settings.json'), inferenceSocket: path.join(dir, 'infer.sock'), controlSocket: path.join(dir, 'control.sock'),
    inferenceTokenHash: hash(infer), operatorTokenHash: hash(operator), worldStatus: async () => ({ paused: false }), clock: () => BJ('10:00'),
    fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return mode === 'error' ? new Response('no', { status: 500 }) : new Response(mode === 'nousage' ? 'data: [DONE]\n\n' : sse); } });
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ model: 'deepseek-flash', apiKey: 'synthetic-key-not-a-real-secret' }), { mode: 0o600 });
  await gateway.start(); t.after(() => gateway.close());
  const control = (route, body, method) => request(path.join(dir, 'control.sock'), route, body, operator, method);
  const chat = body => request(path.join(dir, 'infer.sock'), '/v1/chat/completions', body, infer);
  const settled = async expected => { for (let i = 0; i < 50 && (await control('/spend', undefined, 'GET')).json().value.calls !== expected; i++) await new Promise(r => setTimeout(r, 10)); return (await control('/spend', undefined, 'GET')).json().value; };
  const prompt = { model: 'deepseek', messages: [{ role: 'user', content: 'synthetic' }], stream: true };
  const result = await chat(prompt);
  assert.equal(result.status, 200); assert.equal(result.text, sse, 'bytes pass through unchanged');
  assert.deepEqual(calls[0].stream_options, { include_usage: true });
  let spend = await settled(1);
  // Peak flash: 1000×0.04 + 200×2 + 500×8 = 4440 micro-yuan.
  assert.deepEqual([spend.spentYuan, spend.reservedYuan, spend.byTier.conversation, spend.window, spend.tier, spend.capYuan, spend.day, spend.pricing], [0.00444, 0, 0.00444, 'peak', 'normal', 5, '2026-11-09', 'file']);
  mode = 'nousage';
  await chat(prompt);
  spend = await settled(2);
  assert.ok(spend.spentYuan > 0.00444 && spend.unreportedUsage === 1, 'unreported usage charges the reservation');
  mode = 'error';
  assert.equal((await chat(prompt)).status, 502);
  assert.equal((await settled(2)).calls, 2, 'provider errors are released');
  // Settings: validated, then applied to the next call without a restart.
  assert.equal((await control('/spend/settings', { dailyCapYuan: 0 })).status, 400);
  assert.equal((await control('/spend/settings', { reducedPercent: 90, restrictedPercent: 80 })).status, 400);
  assert.equal((await control('/spend/settings', { dailyCapYuan: 0.01 })).json().value.tier, 'exhausted');
  mode = 'ok';
  const before = calls.length, refused = await chat(prompt);
  assert.equal(refused.status, 429); assert.equal(refused.json().error.code, 'BUDGET_EXHAUSTED');
  assert.equal((await request(path.join(dir, 'infer.sock'), '/v1/memory/completions', { model: 'deepseek', messages: [{ role: 'user', content: 'x' }], stream: false }, infer)).status, 429);
  assert.equal((await request(path.join(dir, 'infer.sock'), '/v1/web/search', { query: 'x' }, infer)).status, 429);
  assert.equal(calls.length, before, 'no provider call once the cap is reached');
  assert.equal((await control('/spend/settings', { dailyCapYuan: 5, reducedPercent: 60, restrictedPercent: 80 })).json().value.tier, 'normal');
  assert.equal((await chat(prompt)).status, 200);
});
