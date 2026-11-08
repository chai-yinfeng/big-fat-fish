import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AuthorityClient } from '../../authority/src/client.js';
import { ContentClient } from '../media/client.js';
import { SessionStore, conversationSessionId } from './sessions.js';
import { createGatewayStream } from './model.js';
import { createConversationExecutor } from './agent.js';
import { createConversationServer } from './server.js';
import { createConversationClient } from './client.js';
import { WINDOW_MARKER } from './window.js';
import { tempRoot, tokenFile, fakeAuthority, fakeGateway, reply, toolCall } from './fixtures.js';

const scope = { streamId: 'qq:100:private:200', memoryEpoch: 0 };
const evidence = [{ ref: 'obs-1', eventId: 'onebot:v11:message:7', role: 'user' }];
async function setup(t, options = {}) {
  const root = tempRoot(t);
  const authority = await fakeAuthority(t, root), gateway = await fakeGateway(t, root);
  const sessionsDir = path.join(root, 'sessions');
  const make = () => {
    const { model, streamFn } = createGatewayStream(gateway.config);
    return createConversationExecutor({ authority: new AuthorityClient(authority.config), content: new ContentClient(authority.config), store: new SessionStore(sessionsDir), model, streamFn, ...options });
  };
  return { root, authority, gateway, sessionsDir, executor: make(), restart: make };
}
const request = (text, extra = {}) => ({ scope, requestId: 'qq-message-' + createHash('sha256').update(text).digest('hex').slice(0, 16), input: { text, evidence, ...extra }, timeoutMs: 10000 });
const text = m => typeof m.content === 'string' ? m.content : m.content.map(part => part.text).join('');
const toolMessages = body => body.messages.filter(m => m.role === 'tool');
const contexts = state => state.requests.filter(r => r.route === '/v1/context');

test('plain reply: Authority context in the system prompt, real-input query, private persisted run', async t => {
  const f = await setup(t);
  f.authority.state.text = '[人格]\n大肥鱼，说话简短';
  f.gateway.state.script.push(reply('你好呀', 'thinking'));
  assert.equal(await f.executor.execute(request('你好'.repeat(400), { queryText: '你好' })), '你好呀');
  const [body] = f.gateway.state.bodies;
  assert.equal(body.model, 'deepseek'); assert.equal(body.stream, true); assert.equal(body.max_tokens > 0, true);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['companion_content', 'companion_scope']);
  for (const tool of body.tools) assert.equal(JSON.stringify(tool.function.parameters).match(/streamId|memoryEpoch|entityId|personId|requestId|path/), null);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /大肥鱼，说话简短/); assert.match(body.messages[0].content, /revision=3; personaRevision=2/);
  assert.match(body.messages[0].content, /2026-11-01T00:00:00.000Z/); assert.match(body.messages[0].content, /obs-1/);
  assert.deepEqual(contexts(f.authority.state).map(r => r.body), [{ streamId: scope.streamId, query: '你好', budgetChars: 2400 }]);
  const file = path.join(f.sessionsDir, conversationSessionId(scope.streamId, 0) + '.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(f.sessionsDir).mode & 0o777, 0o700);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(run.messages.map(m => m.role), ['user', 'assistant']);
  // Without queryText, retrieval uses this input truncated to 512 characters.
  f.gateway.state.script.push(reply('再见'));
  await f.executor.execute(request('长'.repeat(600)));
  assert.equal(contexts(f.authority.state).at(-1).body.query, '长'.repeat(512));
});

test('tool loop replays reasoning_content and reuses the same query for every request', async t => {
  const f = await setup(t);
  f.gateway.state.script.push(toolCall('companion_scope', { action: 'evidence' }, 'R1-need-evidence'), reply('记住啦', 'R2-final'));
  assert.equal(await f.executor.execute(request('我喜欢红茶')), '记住啦');
  const second = f.gateway.state.bodies[1];
  const assistant = second.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'R1-need-evidence');
  assert.equal(assistant.tool_calls[0].function.name, 'companion_scope');
  assert.deepEqual(JSON.parse(toolMessages(second)[0].content), { evidence, unavailable: [] });
  assert.deepEqual(contexts(f.authority.state).filter(r => r.body.budgetChars === 2400).map(r => r.body.query), ['我喜欢红茶', '我喜欢红茶']);
  // A later run (also after a restart) replays every earlier assistant with its reasoning_content.
  f.gateway.state.script.push(reply('还记得', 'R3'));
  await f.restart().execute(request('还记得吗'));
  const replayed = f.gateway.state.bodies[2].messages.filter(m => m.role === 'assistant');
  assert.deepEqual(replayed.map(m => m.reasoning_content), ['R1-need-evidence', 'R2-final']);
  assert.deepEqual(f.gateway.state.bodies[2].messages.filter(m => m.role === 'user').map(text), ['我喜欢红茶', '还记得吗']);
});

test('the model cannot widen scope: extra selectors and unobserved refs are refused, calls stay bound', async t => {
  const f = await setup(t);
  f.gateway.state.script.push(
    toolCall('companion_scope', { action: 'search', query: '红茶', streamId: 'qq:100:private:999' }, 'r', 'call_a'),
    toolCall('companion_scope', { action: 'propose', id: 'tea', ref: 'obs-from-elsewhere', type: 'fact.report', payload: { key: '饮料', value: '红茶', quote: '我喜欢红茶' } }, 'r', 'call_b'),
    toolCall('companion_content', { action: 'attach', ref: 'image-1', requestId: 'other-request' }, 'r', 'call_c'),
    toolCall('companion_scope', { action: 'search', query: '红茶' }, 'r', 'call_d'),
    toolCall('companion_content', { action: 'attach', ref: 'image-1' }, 'r', 'call_e'),
    toolCall('companion_scope', { action: 'propose', id: 'tea', ref: 'obs-1', type: 'fact.report', payload: { key: '饮料', value: '红茶', quote: '我喜欢红茶' } }, 'r', 'call_f'),
    reply('好'));
  await f.executor.execute(request('我喜欢红茶'));
  const results = f.gateway.state.bodies.slice(1).map(body => toolMessages(body).at(-1).content);
  assert.match(results[0], /streamId: unknown field/);
  assert.match(results[1], /UNOBSERVED_EVIDENCE/);
  assert.match(results[2], /requestId: unknown field/);
  const routed = f.authority.state.requests.filter(r => r.route !== '/v1/context');
  assert.deepEqual(routed.map(r => r.route), ['/v1/memory/search', '/v1/content', '/v1/proposals']);
  assert.equal(routed[0].body.streamId, scope.streamId);
  assert.deepEqual(routed[1].body, { action: 'attach', ref: 'image-1', streamId: scope.streamId, memoryEpoch: 0, requestId: request('我喜欢红茶').requestId });
  assert.equal(routed[2].body.observationId, 'obs-1');
  assert.match(routed[2].body.proposalId, /^conv:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(results[4]).delivered, false);
});

test('tool outputs stay within 6000 characters and derived content is labelled', async t => {
  const f = await setup(t);
  f.authority.state.search = () => ({ items: [{ id: 'm1', excerpt: '茶'.repeat(9000) }], text: '' });
  f.authority.state.content = () => ({ ref: 'desc-1', description: '图'.repeat(20000) });
  f.gateway.state.script.push(toolCall('companion_scope', { action: 'search', query: '茶' }, 'r', 'a'), toolCall('companion_content', { action: 'describe', ref: 'image-1' }, 'r', 'b'), reply('好'));
  await f.executor.execute(request('看图'));
  const [search, described] = f.gateway.state.bodies.slice(1).map(body => toolMessages(body).at(-1).content);
  assert.ok(search.length <= 6000 && JSON.parse(search).truncated);
  const content = JSON.parse(described);
  assert.ok(described.length <= 6000); assert.equal(content.isNewEvidence, false); assert.equal(content.isVerbatimUserText, false); assert.equal(content.truncated, true);
});

test('pause or a retired epoch fails before any provider request', async t => {
  const f = await setup(t);
  f.authority.state.paused = true;
  await assert.rejects(f.executor.execute(request('你好')), { code: 'WORLD_PAUSED' });
  f.authority.state.paused = false; f.authority.state.epoch = 1;
  await assert.rejects(f.executor.execute(request('你好')), { code: 'EXECUTION_EPOCH_RETIRED' });
  assert.equal(f.gateway.state.bodies.length, 0);
  // An epoch change during a tool continuation retires the run too.
  f.authority.state.epoch = 0;
  f.gateway.state.script.push(toolCall('companion_scope', { action: 'evidence' }), reply('stale'));
  f.authority.state.search = () => { throw new Error('unused'); };
  const original = f.authority.state.requests.push.bind(f.authority.state.requests);
  f.authority.state.requests.push = entry => { const n = original(entry); if (entry.route === '/v1/context' && entry.body.budgetChars === 1) f.authority.state.epoch = 2; return n; };
  await assert.rejects(f.executor.execute(request('你好')), { code: 'EXECUTION_EPOCH_RETIRED' });
  assert.equal(fs.existsSync(path.join(f.sessionsDir, conversationSessionId(scope.streamId, 0) + '.jsonl')), false);
});

test('timeout aborts the in-flight provider request and persists nothing; sessions run serially', async t => {
  const f = await setup(t);
  f.gateway.state.script.push('hang', reply('second'));
  const first = f.executor.execute({ ...request('一'), timeoutMs: 300 });
  const second = f.executor.execute(request('二'));
  await assert.rejects(first, { code: 'EXECUTION_TIMEOUT' });
  assert.equal(await second, 'second');
  for (let i = 0; i < 50 && !f.gateway.state.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.gateway.state.aborted, 1);
  const lines = fs.readFileSync(path.join(f.sessionsDir, conversationSessionId(scope.streamId, 0) + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['二']);
  // The second request only started after the first finished.
  assert.equal(f.gateway.state.bodies[1].messages.filter(m => m.role === 'user').length, 1);
});

test('restart restores history; a torn trailing line is ignored and repaired', async t => {
  const f = await setup(t);
  f.gateway.state.script.push(reply('一号'), reply('二号'));
  await f.executor.execute(request('第一句'));
  const file = path.join(f.sessionsDir, conversationSessionId(scope.streamId, 0) + '.jsonl');
  fs.appendFileSync(file, '{"v":1,"messages":[{"role":"user"');
  await f.restart().execute(request('第二句'));
  assert.deepEqual(f.gateway.state.bodies[1].messages.filter(m => m.role !== 'system').map(text), ['第一句', '一号', '第二句']);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).messages.length), [2, 2]);
  // A new memory epoch is a different session: no old history is replayed.
  f.authority.state.epoch = 1; f.gateway.state.script.push(reply('新'));
  await f.executor.execute({ ...request('第三句'), scope: { ...scope, memoryEpoch: 1 } });
  assert.deepEqual(f.gateway.state.bodies[2].messages.filter(m => m.role !== 'system').map(text), ['第三句']);
});

test('active window drops whole old runs, keeps the newest two and marks the cut', async t => {
  const f = await setup(t, { limit: 2600 });
  for (let i = 0; i < 4; i++) f.gateway.state.script.push(reply('答' + i + '。'.repeat(150)));
  for (let i = 0; i < 4; i++) await f.executor.execute(request('问' + i + '。'.repeat(150)));
  const last = f.gateway.state.bodies[3].messages;
  assert.deepEqual(last.filter(m => m.role === 'user').map(m => text(m).slice(0, 2)), ['问1', '问2', '问3']);
  assert.ok(last[0].content.endsWith(WINDOW_MARKER));
  // When the protected runs alone exceed the budget, execution fails explicitly.
  f.gateway.state.script.push(reply('x'));
  await assert.rejects(f.executor.execute(request('长'.repeat(3000))), { code: 'ACTIVE_CONTEXT_LIMIT' });
});

test('UDS service authenticates callers, derives the session and cancels on disconnect', async t => {
  const f = await setup(t);
  const caller = tokenFile(f.root, 'caller.token'), socketPath = path.join(f.root, 'execute.sock');
  const service = createConversationServer({ socketPath, callerTokenHash: createHash('sha256').update(caller.token).digest('hex'), executor: f.executor });
  await service.start(); t.after(() => service.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const client = createConversationClient({ socketPath, tokenFile: caller.file });
  f.gateway.state.script.push(reply('服务端回复'));
  assert.equal(await client.execute(request('你好')), '服务端回复');
  const wrong = tokenFile(f.root, 'wrong.token');
  await assert.rejects(createConversationClient({ socketPath, tokenFile: wrong.file }).execute(request('你好')), { code: 'AUTH_REQUIRED' });
  await assert.rejects(client.execute({ ...request('你好'), sessionId: 'chosen-by-caller' }), { code: 'INVALID_EXECUTION_REQUEST' });
  await assert.rejects(client.execute({ ...request('你好'), scope: { ...scope, entityId: 'entity:other' } }), { code: 'INVALID_EXECUTION_REQUEST' });
  // Disconnecting the caller aborts the provider request.
  f.gateway.state.script.push('hang');
  const http = await import('node:http');
  const body = JSON.stringify(request('断开'));
  await new Promise(resolve => {
    const req = http.request({ socketPath, path: '/execute', method: 'POST', headers: { authorization: 'Bearer ' + caller.token, 'content-type': 'application/json' } });
    req.on('error', () => resolve()); req.end(body);
    const timer = setInterval(() => { if (f.gateway.state.bodies.length === 2) { clearInterval(timer); req.destroy(); resolve(); } }, 10);
  });
  for (let i = 0; i < 100 && !f.gateway.state.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.gateway.state.aborted, 1);
});
