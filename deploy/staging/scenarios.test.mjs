import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareModel } from '../authority/prepare-model.mjs';
import { prepareQQ } from '../authority/prepare-qq.mjs';
import { prepareConversation } from '../authority/prepare-conversation.mjs';
import { createFakeOneBot } from './fake-onebot.mjs';
import { Runner, STEPS, validateScenarios, summaryLine } from './scenarios.mjs';
import { planReply } from './fake-model.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const shipped = () => JSON.parse(fs.readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

test('the shipped scenarios are valid and every simulated person is visibly fake', () => {
  const data = validateScenarios(shipped());
  assert.deepEqual(data.scenarios.map(scenario => scenario.id), ['S1', 'S2', 'S3']);
  for (const change of [
    d => { d.people['Alice'] = { qq: '999900000050', friend: true }; },
    d => { d.people['MOCK-A'].qq = '10001'; },
    d => { d.people['MOCK-B'].qq = d.people['MOCK-A'].qq; },
    d => { d.bot.qq = '123456789'; },
    d => { d.people['MOCK-A'].owner = true; },
    d => { d.scenarios[0].steps.push({ shout: {} }); },
    d => { d.scenarios[0].steps.push({ say: { from: 'MOCK-NOBODY', text: 'x' } }); },
    d => { d.scenarios[1].id = 'S1'; },
  ]) { const data = shipped(); change(data); assert.throws(() => validateScenarios(data)); }
});

test('expectPrompt reads the whole request, so a leak outside the system prompt fails the isolation check', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/fscn-log-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'requests.jsonl'), run = new Runner({ data: shipped(), modelLog: log });
  const system = 'MOCK system prompt', hub = text => `<<<记忆中枢附注开始>>>\n${text}\n<<<记忆中枢附注结束>>>\n`;
  const user = (text, memory = '"无关记忆"') => ({ role: 'user', content: [{ type: 'text', text: hub(memory) }, { type: 'text', text }] });
  const entry = messages => { const plan = planReply({ stream: true, messages }); return { stream: plan.stream, userText: plan.userText, system: plan.system, context: plan.context, rest: plan.rest }; };
  const check = async (messages, args) => { fs.writeFileSync(log, JSON.stringify(entry(messages)) + '\n'); return STEPS.expectPrompt(run, { logOffset: 0 }, { userText: '（MOCK-B 问）', ...args }); };
  const clean = [{ role: 'system', content: system }, user('蓝鲸 队长 是谁（MOCK-B 问）')];
  await check(clean, { absent: '蓝鲸队长' });
  // The same check fails wherever the other person's memory shows up: memory-hub note, earlier dialogue, tool result, system prompt.
  const leaks = {
    note: [{ role: 'system', content: system }, user('蓝鲸 队长 是谁（MOCK-B 问）', '"Reported by p-aaaaaa (unverified): 代号: 蓝鲸队长"')],
    history: [{ role: 'system', content: system }, { role: 'user', content: '我的代号是蓝鲸队长' }, { role: 'assistant', content: 'ok' }, user('蓝鲸 队长 是谁（MOCK-B 问）')],
    tool: [...clean, { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', content: '{"items":[{"excerpt":"代号 蓝鲸队长"}]}' }],
    system: [{ role: 'system', content: system + ' 蓝鲸队长' }, user('蓝鲸 队长 是谁（MOCK-B 问）')],
  };
  for (const [where, messages] of Object.entries(leaks)) await assert.rejects(check(messages, { absent: '蓝鲸队长' }), /the model request for "（MOCK-B 问）" contains "蓝鲸队长"/, where);
  // `in: "context"` is only the note: earlier dialogue does not satisfy a retrieval check.
  await assert.rejects(check(leaks.history, { contains: '蓝鲸队长', in: 'context' }), /the model context .* lacks/);
  await check(leaks.note, { contains: '蓝鲸队长', in: 'context' });
  // A log written without the new fields (an older fake model) is refused instead of passing vacuously.
  fs.writeFileSync(log, JSON.stringify({ stream: true, userText: '（MOCK-B 问）', system }) + '\n');
  await assert.rejects(STEPS.expectPrompt(run, { logOffset: 0 }, { userText: '（MOCK-B 问）', absent: '蓝鲸队长' }), /lacks system\/context\/rest/);
});

// The real services of this checkout, as processes, on a throwaway data root: Authority, the model
// gateway behind fake-model.mjs, the conversation executor and the QQ bridge against the fake OneBot.
async function stack(t) {
  const root = path.join(fs.realpathSync(fs.mkdtempSync('/tmp/fscn-')), 'companion-staging'), base = path.join(root, 'companion-world-v1');
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => child.once('exit', resolve))));
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });
  for (const dir of ['operator', 'authority-data', 'ipc/authority', 'ipc/operator', 'service-config', 'qq-runtime/private', 'scenario']) fs.mkdirSync(path.join(base, dir), { recursive: true, mode: 0o700 });
  const token = () => randomBytes(32).toString('base64url'), operatorToken = token(), healthToken = token(), onebotToken = randomBytes(32).toString('hex');
  const write = (relative, value) => fs.writeFileSync(path.join(base, relative), typeof value === 'string' ? value + '\n' : JSON.stringify(value), { mode: 0o600 });
  write('operator/console.token', operatorToken); write('service-config/health.token', healthToken); write('qq-runtime/private/onebot.token', onebotToken);
  write('operator/authority.json', {
    schemaVersion: 1, initialPaused: true, databasePath: path.join(base, 'authority-data/authority.sqlite'), socketPath: path.join(base, 'ipc/authority/authority.sock'),
    operator: { socketPath: path.join(base, 'ipc/operator/operator.sock'), tokenHash: hash(operatorToken), origins: [] },
    credentials: [{ hash: hash(healthToken), role: 'capability', capabilityId: 'health' }], capabilities: [{ id: 'health', policy: 'learning.v1' }], actors: [], streams: [], persona: { name: '大肥鱼' },
  });
  prepareModel(base); prepareQQ(base); prepareConversation(base);
  const edit = (label, change) => { const file = path.join(base, 'operator', label), value = JSON.parse(fs.readFileSync(file, 'utf8')); change(value); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return value; };
  // The prepare scripts write the paths Authority sees inside its production sandbox.
  edit('authority.json', c => Object.assign(c.operator, { modelSocketPath: path.join(base, 'ipc/model-control/control.sock'), qqSocketPath: path.join(base, 'ipc/qq-control/control.sock') }));
  const onebotPort = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  edit('qq-bridge.json', c => { c.onebotPort = onebotPort; });
  const data = shipped(), files = { control: path.join(base, 'scenario/onebot.sock'), script: path.join(base, 'scenario/script.json'), log: path.join(base, 'scenario/requests.jsonl') };
  fs.writeFileSync(files.script, '[]');
  const fake = createFakeOneBot({ port: onebotPort, token: onebotToken, controlSocket: files.control, selfId: data.bot.qq });
  await fake.start(); t.after(() => fake.close());
  const output = [];
  const start = (...args) => { const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output.push(String(chunk))); children.push(child); };
  const ready = async file => { for (let i = 0; !fs.existsSync(file); i++) { if (i > 200) throw new Error('service did not start: ' + path.basename(file) + '\n' + output.join('')); await new Promise(resolve => setTimeout(resolve, 50)); } };
  start(path.join(project, 'authority/src/main.js'), '--config', path.join(base, 'operator/authority.json'));
  await ready(path.join(base, 'ipc/operator/operator.sock'));
  start(path.join(project, 'deploy/staging/fake-model.mjs'), '--release', project, '--config', path.join(base, 'operator/model-gateway.json'), '--script', files.script, '--log', files.log);
  await ready(path.join(base, 'ipc/model/inference.sock'));
  start(path.join(project, 'capabilities/conversation/main.mjs'), '--config', path.join(base, 'operator/conversation.json'));
  await ready(path.join(base, 'ipc/conversation/execute.sock'));
  start(path.join(project, 'capabilities/qq/main.mjs'), '--config', path.join(base, 'operator/qq-bridge.json'));
  await ready(path.join(base, 'ipc/qq-control/control.sock'));
  const call = (socketPath, headers) => (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route, agent: false, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { let envelope = null; try { envelope = JSON.parse(raw); } catch {} if (res.statusCode === 200 && envelope?.ok) resolve(envelope.value); else reject(new Error(`${method} ${route} -> ${res.statusCode}`)); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Silence windows are shortened here; staging waits the full time.
  const runner = input => new Runner({ data: input, modelScript: files.script, modelLog: files.log, operator: call(path.join(base, 'ipc/operator/operator.sock'), { authorization: 'Bearer ' + operatorToken }), onebot: call(files.control, {}), sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1500))) });
  return { runner, data, files, fake, base };
}

test('scenario replay against the real Authority, gateway (scripted upstream), executor and QQ bridge', { timeout: 180000 }, async t => {
  const { runner, data, files, fake, base } = await stack(t);
  const summary = await runner(data).run();
  assert.deepEqual(summary.results.map(result => [result.id, result.ok, result.error]), [['S1', true, undefined], ['S2', true, undefined], ['S3', true, undefined]]);
  assert.equal(summaryLine(summary), '3/3 passed: S1 PASS, S2 PASS, S3 PASS');
  // Nothing was ever delivered to a QQ number outside the scenario file.
  const numbers = new Set(Object.values(data.people).map(person => person.qq));
  assert.ok(fake.sent.every(message => numbers.has(message.user_id)));
  // The gateway process really metered the scripted usage and kept the mock key out of the request log.
  assert.ok(!fs.readFileSync(files.log, 'utf8').includes('MOCK-KEY'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'model-data/spend-settings.json'), 'utf8')).dailyCapYuan, 5);

  await t.test('a broken expectation fails the scenario and names the step', async () => {
    const broken = shipped();
    broken.scenarios = [{ id: 'X1', title: 'isolation must hold', model: [], steps: [
      { say: { from: 'MOCK-B', text: 'MOCK-X1 蓝鲸队长 是谁（MOCK-B 再问）' } },
      { expectReply: { to: 'MOCK-B', contains: 'MOCK-REPLY' } },
      { expectPrompt: { userText: '（MOCK-B 再问）', contains: '蓝鲸队长', in: 'context' } },
    ] }];
    const result = await runner(broken).run();
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /^step 3 .*the model context .* lacks "蓝鲸队长"/);
    // Counter-example for the isolation check: the text reaches the model outside the system prompt
    // (here: typed by MOCK-B, then replayed as earlier dialogue), and `absent` must catch it both times.
    const leaked = shipped();
    leaked.scenarios = [{ id: 'X3', title: 'absent covers the whole request', model: [], steps: [
      { say: { from: 'MOCK-B', text: 'MOCK-X3 泄漏词甲' } },
      { expectReply: { to: 'MOCK-B', contains: 'MOCK-REPLY' } },
      { expectPrompt: { userText: 'MOCK-X3', absent: '泄漏词乙' } },
      { say: { from: 'MOCK-B', text: 'MOCK-X3-NEXT 之后的一句' } },
      { expectReply: { to: 'MOCK-B', contains: 'MOCK-REPLY' } },
      { expectPrompt: { userText: 'MOCK-X3-NEXT', absent: '泄漏词甲' } },
    ] }];
    assert.match((await runner(leaked).run()).results[0].error, /^step 6 .*the model request for "MOCK-X3-NEXT" contains "泄漏词甲"/);
    leaked.scenarios[0].steps[2] = { expectPrompt: { userText: 'MOCK-X3', absent: '泄漏词甲' } };
    assert.match((await runner(leaked).run()).results[0].error, /^step 3 .*the model request for "MOCK-X3" contains "泄漏词甲"/);
    const silent = shipped();
    silent.scenarios = [{ id: 'X2', title: 'a reply is not silence', model: [], steps: [{ say: { from: 'MOCK-A', text: 'MOCK-X2 在吗' } }, { expectSilence: { to: '*', observedFrom: ['MOCK-A'], afterMs: 1500 } }] }];
    assert.match((await runner(silent).run()).results[0].error, /expected silence, but MOCK-A received "MOCK-REPLY"/);
  });
});
