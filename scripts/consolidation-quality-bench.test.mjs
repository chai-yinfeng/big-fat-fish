import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runQuality, formatResult, CASES, DAILY_CAP_YUAN } from './consolidation-quality-bench.mjs';

const MOCK_KEY = 'MOCK-KEY-bench-not-a-real-key';
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cons-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'deepseek.key');
  fs.writeFileSync(keyFile, MOCK_KEY + '\n', { mode: 0o600 });
  return { dir, keyFile, stateDir: path.join(dir, 'state') };
}

test('the invented chats are visibly fake and each fits one batch', () => {
  assert.deepEqual(CASES.map(item => item.id), ['daily', 'continued', 'venting', 'injection', 'dense', 'long']);
  for (const item of CASES) {
    assert.match(item.uid, /^9999\d{8}$/);
    assert.equal(item.lines.at(-1)[0], 'a', item.id + ' ends with her reply, so the whole chat has left the window');
    assert.ok(item.lines.reduce((sum, line) => sum + JSON.stringify(line[1]).length + 34, 0) <= 4800, item.id);
  }
});

test('one consolidation call per case through the real gateway and Authority; the result holds the raw answer and no key', async t => {
  const f = fixture(t), bodies = [];
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer ' + MOCK_KEY);
    const body = JSON.parse(options.body); bodies.push(body);
    const rows = JSON.parse(body.messages[1].content).messages, said = rows.find(row => row[1] === '对方' && row[3].includes('MOCK-煤球'));
    const answer = bodies.length === 1
      ? { summary: 'MOCK-摘要：对方下班后聊了开会和猫。', feeling: 'MOCK-感受', facts: [{ key: '猫', value: 'MOCK-煤球', quote: '我家猫叫MOCK-煤球', ref: said[0] }, { key: '猫', value: 'MOCK-煤球', quote: '我的猫叫MOCK-煤球', ref: said[0] }] }
      : 'not json';
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3000, completion_tokens: 200, total_tokens: 3200 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await runQuality({ ...f, label: 'test', only: ['daily', 'venting'], fetchImpl });
  assert.deepEqual(bodies.map(body => [body.max_tokens, body.thinking, body.stream, body.messages.length]), [[1536, { type: 'disabled' }, false, 2], [1536, { type: 'disabled' }, false, 2]]);
  const [daily, venting] = result.cases;
  assert.deepEqual([daily.workerStatus, daily.digest.summary, daily.digest.covers, daily.facts, daily.refused], ['committed', 'MOCK-摘要：对方下班后聊了开会和猫。', 20, [{ key: '猫', value: 'MOCK-煤球', quote: '我家猫叫MOCK-煤球', verbatim: true }], ['quote_not_in_observation']]);
  assert.deepEqual([daily.upstream.output.includes('MOCK-摘要'), daily.upstream.finishReason, daily.upstream.promptTokens, daily.upstream.completionTokens], [true, 'stop', 3000, 200]);
  assert.deepEqual([venting.workerStatus, venting.digest, venting.upstream.output], ['invalid_output', null, 'not json']);
  assert.ok(result.total.calls === 2 && result.total.spendYuan > 0 && result.dailyCapYuan === DAILY_CAP_YUAN);
  // One conversation per request: the second request carries nothing of the first person's chat.
  assert.ok(bodies[0].messages[1].content.includes('MOCK-煤球') && !bodies[1].messages[1].content.includes('MOCK-煤球') && !bodies[1].messages[1].content.includes('MOCK-摘要'));
  const text = JSON.stringify(result) + formatResult(result);
  assert.ok(!text.includes(MOCK_KEY));
  assert.match(formatResult(result), /== daily \(MOCK-A; 20 lines/);
  // The settings file that held the key is gone; the cap is the bench's own.
  assert.deepEqual(fs.readdirSync(f.stateDir).sort(), ['capability-usage.json', 'model-pricing.json', 'spend-settings.json', 'spend.json'].filter(name => fs.existsSync(path.join(f.stateDir, name))));
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'model-settings.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'spend-settings.json'), 'utf8')).dailyCapYuan, 1);
  await assert.rejects(runQuality({ ...f, only: ['nope'], fetchImpl }), /Invalid bench options/);
});
