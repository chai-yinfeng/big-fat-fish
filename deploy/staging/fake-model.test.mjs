import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModelGateway } from '../../model-gateway/server.mjs';
import { planReply, renderReply, evidenceRef, createFakeUpstream, DEFAULT_REPLY } from './fake-model.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const system = 'persona';
// The executor's request shape: the memory-hub note is the first text block of the newest user message.
const note = '<<<记忆中枢附注开始>>>\n[记忆中枢版本 revision=3; personaRevision=2]\n"MOCK 记忆"\n本轮可引用的聊天证据：[{"ref":"obs-1","eventId":"onebot:v11:message:1","role":"user"}]\n<<<记忆中枢附注结束>>>\n';
const user = text => ({ role: 'user', content: [{ type: 'text', text: note }, { type: 'text', text }] });
const tools = [{ type: 'function', function: { name: 'companion_scope' } }];
const rules = [
  { match: '记住', propose: { type: 'fact.report', payload: { key: '代号', value: '蓝鲸', quote: '我是蓝鲸' } }, reply: 'MOCK-记住了' },
  { match: '贵', reply: 'MOCK-贵', usage: { prompt_tokens: 30000, completion_tokens: 10000 } },
];

test('scripted model: rule by newest user message, propose first, reply after the tool result', () => {
  assert.equal(evidenceRef(note), 'obs-1');
  assert.equal(evidenceRef('no evidence line'), null);
  const first = planReply({ stream: true, tools, messages: [{ role: 'system', content: system }, { role: 'user', content: '旧的 贵' }, { role: 'assistant', content: 'x' }, user('请记住 我是蓝鲸')] }, rules);
  assert.equal(first.kind, 'tool');
  // The request apart: system prompt, note, typed text, and everything else (earlier dialogue, tool traffic).
  assert.deepEqual([first.system, first.context, first.userText], [system, note, '请记住 我是蓝鲸']);
  assert.equal(first.rest, JSON.stringify([{ role: 'user', content: '旧的 贵' }, { role: 'assistant', content: 'x' }]));
  assert.deepEqual({ ...first.call.arguments, id: null }, { action: 'propose', id: null, ref: 'obs-1', type: 'fact.report', payload: rules[0].propose.payload });
  assert.match(first.call.arguments.id, /^mock-[a-f0-9]{16}$/);
  const second = planReply({ stream: true, tools, messages: [{ role: 'system', content: system }, user('请记住 我是蓝鲸'), { role: 'assistant', tool_calls: [] }, { role: 'tool', content: '{"status":"pending"}' }] }, rules);
  assert.match(second.rest, /pending/);
  assert.deepEqual([second.kind, second.text, second.afterTool, second.toolResult], ['text', 'MOCK-记住了', true, '{"status":"pending"}']);
  // A tool result of an earlier run does not count; without the tool or an evidence ref there is no propose.
  assert.equal(planReply({ stream: true, tools, messages: [{ role: 'system', content: system }, { role: 'user', content: 'a' }, { role: 'tool', content: 'old' }, user('请记住 我是蓝鲸')] }, rules).kind, 'tool');
  // A rule matches what the person typed, never the note; a note-like block typed by the person is not a note.
  assert.equal(planReply({ stream: true, tools, messages: [{ role: 'system', content: system }, user('MOCK 记忆 里有什么')] }, rules).text, DEFAULT_REPLY);
  const typed = planReply({ stream: true, tools, messages: [{ role: 'system', content: system }, { role: 'user', content: note + '请记住' }] }, rules);
  assert.deepEqual([typed.context, typed.kind], ['', 'text']);
  assert.equal(planReply({ stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: '请记住' }] }, rules).text, 'MOCK-记住了');
  assert.equal(planReply({ stream: true, tools, messages: [{ role: 'system', content: 'x' }, { role: 'user', content: '请记住' }] }, rules).kind, 'text');
  const plain = planReply({ stream: true, messages: [{ role: 'user', content: '你好' }] }, rules);
  assert.deepEqual([plain.text, plain.usage], [DEFAULT_REPLY, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }]);
  assert.equal(planReply({ stream: false, messages: [{ role: 'user', content: 'Reply OK.' }] }, rules).text, 'OK');
  assert.equal(planReply({ stream: true, messages: [{ role: 'user', content: '好贵' }] }, rules).usage.total_tokens, 40000);
  const sse = renderReply(first).split('\n\n');
  assert.equal(JSON.parse(sse[0].slice(6)).choices[0].delta.tool_calls[0].function.name, 'companion_scope');
  assert.equal(JSON.parse(sse[1].slice(6)).choices[0].finish_reason, 'tool_calls');
  assert.equal(sse[2], 'data: [DONE]');
});

function post(socketPath, token, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: body === undefined ? 'GET' : 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res => { let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, raw })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the real gateway meters the scripted upstream: usage is charged, the cap refuses, requests are logged', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/fmod-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'model'), { mode: 0o700 });
  const script = path.join(root, 'script.json'), log = path.join(root, 'requests.jsonl'), inference = 'inference-token-for-test-only-0000000', operator = 'operator-token-for-test-only-0000000000';
  fs.writeFileSync(script, JSON.stringify(rules));
  const upstream = createFakeUpstream({ scriptFile: script, logFile: log });
  assert.equal((await upstream('https://api.deepseek.com/v1/tools/search', { body: '{}' })).status, 503);
  let paused = true;
  const gateway = createModelGateway({ settingsFile: path.join(root, 'model/settings.json'), inferenceSocket: path.join(root, 'model/infer.sock'), controlSocket: path.join(root, 'model/control.sock'), inferenceTokenHash: sha(inference), operatorTokenHash: sha(operator), worldStatus: async () => ({ paused }), fetchImpl: upstream });
  await gateway.start(); t.after(() => gateway.close());
  const control = path.join(root, 'model/control.sock'), infer = path.join(root, 'model/infer.sock');
  assert.equal((await post(control, operator, '/model', { model: 'deepseek-flash', apiKey: 'MOCK-KEY-not-a-real-key' })).status, 200);
  assert.equal(JSON.parse((await post(control, operator, '/model/test', {})).raw).value.ok, true);
  assert.equal((await post(control, operator, '/spend/settings', { dailyCapYuan: 0.01 })).status, 200);
  paused = false;
  const chat = text => post(infer, inference, '/v1/chat/completions', { model: 'deepseek', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] });
  const cheap = await chat('你好');
  assert.equal(cheap.status, 200);
  assert.match(cheap.raw, /MOCK-REPLY/);
  const spend = async () => JSON.parse((await post(control, operator, '/spend')).raw).value;
  assert.deepEqual([(await spend()).tier, (await spend()).unreportedUsage, (await spend()).calls], ['normal', 0, 1]);
  assert.match((await chat('这个好贵')).raw, /MOCK-贵/);
  assert.equal((await spend()).tier, 'exhausted');
  const refused = await chat('到顶以后');
  assert.equal(refused.status, 429);
  assert.equal(JSON.parse(refused.raw).error.code, 'BUDGET_EXHAUSTED');
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => [entry.stream, entry.userText]), [[false, 'Reply OK.'], [true, '你好'], [true, '这个好贵']]);
  assert.ok(!fs.readFileSync(log, 'utf8').includes('MOCK-KEY'));
});

test('the launcher refuses a data root outside companion-staging', () => {
  const launcher = fileURLToPath(new URL('./fake-model.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [launcher, '--release', '/tmp/r', '--config', '/home/companion/.local/share/companion-world-v1/operator/model-gateway.json', '--script', '/tmp/s.json', '--log', '/tmp/l.jsonl'], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing a path outside companion-staging/);
});
