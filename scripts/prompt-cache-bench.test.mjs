import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBench, formatResult, withThinking, readKey, createAuthorityStub, mockPersona, DAILY_CAP_YUAN } from './prompt-cache-bench.mjs';
import { personaContextText } from '../authority/src/context.js';

const MOCK_KEY = 'MOCK-KEY-bench-not-a-real-key';
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-bench-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'deepseek.key');
  fs.writeFileSync(keyFile, MOCK_KEY + '\n', { mode: 0o600 });
  return { dir, keyFile, stateDir: path.join(dir, 'state') };
}
/** Scripted DeepSeek: a streamed reply whose usage reports a cache hit. */
function fakeUpstream(bodies) {
  return async (url, options) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer ' + MOCK_KEY);
    bodies.push(JSON.parse(options.body));
    const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-deepseek', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 50, total_tokens: 1050, completion_tokens_details: { reasoning_tokens: 30 } };
    return new Response(chunk({ role: 'assistant', content: 'MOCK-REPLY' }) + chunk({}, 'stop') + `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-deepseek', choices: [], usage })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

test('replays the script through the real gateway and executor and records cache usage without the key', async t => {
  const f = fixture(t), bodies = [];
  const result = await runBench({ keyFile: f.keyFile, stateDir: f.stateDir, label: 'unit', thinking: 'low', turns: 2, pauseMs: 0, fetchImpl: fakeUpstream(bodies) });
  assert.equal(result.turns.length, 2); assert.equal(result.stopped, null);
  assert.deepEqual(result.turns.map(turn => turn.requests.length), [1, 1]);
  const [row] = result.turns[0].requests;
  assert.deepEqual([row.promptTokens, row.cacheHitTokens, row.cacheMissTokens, row.completionTokens, row.reasoningTokens], [1000, 600, 400, 50, 30]);
  assert.equal(result.total.hitPercent, 60); assert.equal(result.total.reasoningPercentOfOutput, 60);
  // The gateway's spend meter charged the same usage, under the fixed daily cap.
  assert.ok(result.total.spendYuan > 0); assert.equal(result.total.spendYuan, result.total.costYuan);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'spend-settings.json'), 'utf8')).dailyCapYuan, DAILY_CAP_YUAN);
  // Only the thinking parameters are rewritten; the model is the gateway's configured one.
  assert.deepEqual(bodies.map(body => [body.model, body.thinking.type, body.reasoning_effort]), [['deepseek-flash', 'enabled', 'low'], ['deepseek-flash', 'enabled', 'low']]);
  assert.equal(bodies[1].messages.filter(message => message.role === 'user').length, 2);
  assert.ok(result.turns[1].requests[0].sharedPrefixChars > 0);
  // The key is in no output and the settings file that held it is gone.
  assert.equal(fs.existsSync(path.join(f.stateDir, 'model-settings.json')), false);
  const table = formatResult(result);
  for (const text of [JSON.stringify(result), table, ...fs.readdirSync(f.stateDir).map(name => fs.readFileSync(path.join(f.stateDir, name), 'utf8'))]) assert.equal(text.includes(MOCK_KEY), false);
  assert.match(table, /total: 2 requests, prompt 2000 \(hit 1200 = 60%\)/);
});

test('stops before a turn once the day has spent the bench budget', async t => {
  const f = fixture(t), bodies = [];
  const first = await runBench({ keyFile: f.keyFile, stateDir: f.stateDir, turns: 1, pauseMs: 0, fetchImpl: fakeUpstream(bodies) });
  const second = await runBench({ keyFile: f.keyFile, stateDir: f.stateDir, turns: 2, pauseMs: 0, budgetYuan: first.spentTodayYuan, fetchImpl: fakeUpstream(bodies) });
  assert.equal(second.turns.length, 0); assert.match(second.stopped, /bench budget/); assert.equal(bodies.length, 1);
  await assert.rejects(runBench({ keyFile: f.keyFile, stateDir: f.stateDir, budgetYuan: DAILY_CAP_YUAN + 1, fetchImpl: fakeUpstream(bodies) }), /Invalid bench options/);
});

test('thinking levels, key file checks and the stub Authority', async t => {
  assert.deepEqual(withThinking({ a: 1, thinking: { type: 'enabled' }, reasoning_effort: 'high' }, 'disabled'), { a: 1, thinking: { type: 'disabled' } });
  assert.deepEqual(withThinking({ a: 1, thinking: { type: 'enabled' }, reasoning_effort: 'high' }, 'max'), { a: 1, thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  const f = fixture(t);
  fs.chmodSync(f.keyFile, 0o644);
  assert.throws(() => readKey(f.keyFile), /mode 600/);
  const length = personaContextText(mockPersona('0123456789ab')).length;
  assert.ok(length > 1400 && length <= 1600, 'persona length ' + length);
  const authority = createAuthorityStub({ salt: 'x' });
  const cat = await authority.context({ query: '煤球又闯祸了' }), again = await authority.context({ query: '煤球又闯祸了' });
  assert.match(cat.text, /煤球/); assert.ok(again.revision > cat.revision); assert.ok(cat.text.length <= 4000);
  // Without a key file the script exits cleanly and says it skipped.
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./prompt-cache-bench.mjs', import.meta.url)), '--key-file', path.join(f.dir, 'missing.key')], { encoding: 'utf8', env: { ...process.env, BENCH_DEEPSEEK_KEY_FILE: '' } });
  assert.equal(run.status, 0); assert.match(run.stdout, /skipped/);
});
