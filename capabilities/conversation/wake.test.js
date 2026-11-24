// Her private wake-up (`input.wake`): a run in her own conversation, which is nobody's. Its request carries the
// briefing the channel handed over and nothing of any person; its one tool is companion_self.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuthorityClient } from '../../authority/src/client.js';
import { ContentClient } from '../media/client.js';
import { SessionStore, conversationSessionId } from './sessions.js';
import { createGatewayStream } from './model.js';
import { createConversationExecutor, thinkingFor, NOTE_OPEN, NOTE_CLOSE, EVENT_OPEN, WAKE_OPEN } from './agent.js';
import { REST_MARK } from './executor.js';
import { SELF_TOOL_SCHEMA, SCOPE_TOOL_SCHEMA, CONTENT_TOOL_SCHEMA, ACTIVITY_TOOL_SCHEMA, createCompanionTools, createSelfTools } from './tools.js';
import { tempRoot, fakeAuthority, fakeGateway, reply, toolCall } from './fixtures.js';

const OWN = { streamId: 'qq:self', memoryEpoch: 0 }, PERSON = { streamId: 'qq:100:private:200', memoryEpoch: 0 };
const BRIEFING = '现在是 2027年1月15日 周五 16:00（北京时间）。这次醒来是因为：到点了。\n你还没有写过心情。\n你现在的档位：不想主动找人（none）。\n关于你自己的几个数：今天这是第 1 次醒来；之前还没有醒过；今天你主动找过 0 个人；有 1 个人身上有你留的、到今天该办的打算；今天有 2 个人和你聊过。';
const wakeRequest = (id = 'qq:init:wake-1', text = BRIEFING) => ({ scope: OWN, requestId: id, input: { text, wake: true }, timeoutMs: 10000 });
async function setup(t) {
  const root = tempRoot(t), authority = await fakeAuthority(t, root), gateway = await fakeGateway(t, root), sessionsDir = path.join(root, 'sessions');
  const { model, streamFn } = createGatewayStream(gateway.config);
  const executor = createConversationExecutor({ authority: new AuthorityClient(authority.config), content: new ContentClient(authority.config), store: new SessionStore(sessionsDir), model, streamFn, clock: () => Date.parse('2027-01-15T08:00:30Z'), log: () => {} });
  return { authority, gateway, sessionsDir, executor };
}
const lastUser = body => body.messages.findLast(m => m.role === 'user');
const blocks = message => message.content.map(part => part.text);

test('wake-up: her own system text and session, the briefing where a message would be, companion_self as the only tool, thinking on, counted as proactive work', async t => {
  const f = await setup(t);
  f.authority.state.text = '[人格]\n大肥鱼，说话简短';
  f.gateway.state.script.push(toolCall(SELF_TOOL_SCHEMA.name, { mood: 'MOCK 有点想出去走走', outreach: 'maybe' }, 'MOCK thinking'), reply('记好了，再眯一会儿。'));
  assert.equal(await f.executor.execute(wakeRequest()), '记好了，再眯一会儿。');
  const [body, second] = f.gateway.state.bodies;
  // The one tool, with nothing in it that could name anyone.
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['companion_self']);
  assert.deepEqual(Object.keys(body.tools[0].function.parameters.properties), ['mood', 'note', 'outreach']);
  assert.equal(JSON.stringify(body.tools).match(/streamId|memoryEpoch|entityId|personId|requestId|person|account|target|to"/), null);
  // Her own stable system text: the persona, no channel part, no sentence about the people she chats with.
  const system = body.messages[0].content;
  assert.match(system, /这里是你自己的时间/); assert.match(system, /大肥鱼，说话简短/); assert.match(system, /只回复 <休息>/);
  assert.doesNotMatch(system, /每段私聊都是独立的|语音|QQ|常驻档案|对方/);
  // The note says nobody wrote; there is no evidence line; then the briefing, marked.
  const [note, typed] = blocks(lastUser(body));
  assert.ok(note.startsWith(NOTE_OPEN) && note.endsWith(NOTE_CLOSE + '\n'));
  assert.match(note, /这一条不是任何人发来的消息/); assert.match(note, /^现在是 2027年1月15日 周五 16:00（北京时间）$/m);
  assert.doesNotMatch(note, /本轮可引用的聊天证据|对方/);
  assert.equal(typed, WAKE_OPEN + BRIEFING);
  assert.ok(!typed.startsWith(EVENT_OPEN));
  // Nothing of any person anywhere in the request.
  assert.doesNotMatch(JSON.stringify(body), /owner|person:|private:|p-[0-9a-f]{6}|9999\d{8}/i);
  // Thinking on; every provider request of the run carries the gateway's mark for proactive work.
  assert.deepEqual([body.thinking, body.reasoning_effort], [{ type: 'enabled' }, 'high']);
  assert.deepEqual(f.gateway.state.marks, ['initiated', 'initiated']);
  // Authority was asked for her own conversation's context, without a query and without a profile.
  const [{ windowFromAt, ...asked }] = f.authority.state.requests.filter(r => r.route === '/v1/context').map(r => r.body);
  assert.deepEqual(asked, { streamId: OWN.streamId, query: '', budgetChars: 4000, exclude: [], profile: false });
  assert.ok(Number.isSafeInteger(windowFromAt));
  // What she wrote down went to Authority under the bound conversation, and she was told how it went.
  assert.deepEqual(f.authority.state.requests.filter(r => r.route === '/v1/self').map(r => r.body), [{ streamId: OWN.streamId, mood: 'MOCK 有点想出去走走', outreach: 'maybe' }]);
  assert.deepEqual(JSON.parse(second.messages.findLast(m => m.role === 'tool').content), { mood: '记下了。', outreach: '档位现在是 maybe。' });
  // Its own session file; no other conversation's file exists or is touched.
  assert.deepEqual(fs.readdirSync(f.sessionsDir), [conversationSessionId(OWN.streamId, 0) + '.jsonl']);
  const run = JSON.parse(fs.readFileSync(path.join(f.sessionsDir, conversationSessionId(OWN.streamId, 0) + '.jsonl'), 'utf8'));
  assert.deepEqual(run.messages.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
  assert.doesNotMatch(JSON.stringify(run), /MOCK thinking/);
});

test('wake-up: she may do nothing (<休息>), or write something down and say no more; the next wake-up extends the same conversation', async t => {
  const f = await setup(t);
  f.gateway.state.script.push(reply(REST_MARK), toolCall(SELF_TOOL_SCHEMA.name, { note: 'MOCK 随笔' }), reply(''), reply(REST_MARK));
  assert.equal(await f.executor.execute(wakeRequest('qq:init:wake-1')), REST_MARK);
  assert.equal(f.authority.state.requests.filter(r => r.route === '/v1/self').length, 0);
  // No words after the tool: a rest, not a failure.
  assert.equal(await f.executor.execute(wakeRequest('qq:init:wake-2')), REST_MARK);
  assert.equal(await f.executor.execute(wakeRequest('qq:init:wake-3')), REST_MARK);
  const bodies = f.gateway.state.bodies;
  assert.equal(bodies.length, 4);
  // Same system text and tool on every wake-up, and each request is the one before it plus new messages.
  for (const body of bodies) assert.deepEqual([body.messages[0].content, JSON.stringify(body.tools)], [bodies[0].messages[0].content, JSON.stringify(bodies[0].tools)]);
  const flat = messages => JSON.stringify(messages.map(m => m.role === 'assistant' ? { ...m, reasoning_content: '' } : m));
  for (let n = 1; n < bodies.length; n++) assert.equal(flat(bodies[n].messages.slice(0, bodies[n - 1].messages.length)), flat(bodies[n - 1].messages), `request ${n + 1} extends request ${n}`);
  // What is replayed for the wordless run is the rest mark.
  assert.equal(bodies[3].messages.filter(m => m.role === 'assistant').at(-1).content, REST_MARK);
});

test('wake-up and a conversation with a person never share a tool, a system text or a session', async t => {
  const f = await setup(t);
  f.gateway.state.script.push(reply('你好呀'), reply(REST_MARK), reply('在呢'));
  const ordinary = text => ({ scope: PERSON, requestId: 'qq-message-' + text.length, input: { text, evidence: [{ ref: 'obs-1', eventId: 'onebot:v11:message:7', role: 'user' }] }, timeoutMs: 10000 });
  await f.executor.execute(ordinary('MOCK-PERSON 你好'));
  await f.executor.execute(wakeRequest());
  await f.executor.execute(ordinary('MOCK-PERSON 还在吗'));
  const [first, wake, later] = f.gateway.state.bodies;
  for (const body of [first, later]) {
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['companion_scope', 'companion_content', 'companion_activity']);
    assert.doesNotMatch(JSON.stringify(body), /companion_self|私下时间|这里是你自己的时间|今天这是第 1 次醒来/);
  }
  assert.deepEqual(wake.tools.map(tool => tool.function.name), ['companion_self']);
  // The person's words are in their own conversation only; the wake-up request has none of them.
  assert.doesNotMatch(JSON.stringify(wake), /MOCK-PERSON|你好呀|companion_scope|companion_content|companion_activity/);
  assert.equal(later.messages.length, first.messages.length + 2);
  assert.deepEqual(fs.readdirSync(f.sessionsDir).sort(), [conversationSessionId(OWN.streamId, 0), conversationSessionId(PERSON.streamId, 0)].map(id => id + '.jsonl').sort());
  // The tool is not one of the three, and the three are not offered beside it.
  assert.ok(![SCOPE_TOOL_SCHEMA.name, CONTENT_TOOL_SCHEMA.name, ACTIVITY_TOOL_SCHEMA.name].includes(SELF_TOOL_SCHEMA.name));
  assert.ok(!createCompanionTools({ authority: {}, scope: PERSON, requestId: 'r', evidence: [], guard: async () => {} }).some(tool => tool.name === SELF_TOOL_SCHEMA.name));
});

test('wake-up: only the channel can mark one, and with nothing but the briefing text', async t => {
  const f = await setup(t);
  for (const input of [{ text: 'x', wake: false }, { text: 'x', wake: 'true' }, { text: '', wake: true }, { text: 'x', wake: true, initiated: true }, { text: 'x', wake: true, light: true }, { text: 'x', wake: true, event: 'y' },
    { text: 'x', wake: true, queryText: 'MOCK' }, { text: 'x', wake: true, evidence: [] }, { text: 'x', wake: true, mediaRefs: [] }, { text: 'x', wake: true, streamId: PERSON.streamId }]) {
    await assert.rejects(f.executor.execute({ scope: OWN, requestId: 'r-bad', input, timeoutMs: 10000 }), { code: 'INVALID_EXECUTION_REQUEST' });
  }
  // Where it may run is Authority's word, not the channel's: a wake-up aimed at a person's conversation is refused
  // before anything is stored or sent to the model, and so is any other kind of run aimed at her own conversation.
  await assert.rejects(f.executor.execute({ ...wakeRequest(), scope: PERSON }), { code: 'AUTHORITY_BINDING_REQUIRED' });
  for (const input of [{ text: 'MOCK 你好', evidence: [{ ref: 'obs-1', eventId: 'e-1', role: 'user' }] }, { text: 'MOCK-EVENT', initiated: true }, { text: 'MOCK 你好', event: 'MOCK-EVENT' }])
    await assert.rejects(f.executor.execute({ scope: OWN, requestId: 'r-own', input, timeoutMs: 10000 }), { code: 'AUTHORITY_BINDING_REQUIRED' });
  assert.equal(f.gateway.state.bodies.length, 0);
  assert.deepEqual(fs.readdirSync(f.sessionsDir), []);
  assert.deepEqual([thinkingFor({ wake: true }), thinkingFor({ wake: true, chatThinking: false })], ['high', 'high']);
  // A paused world or a retired epoch stops it like any run.
  f.authority.state.paused = true;
  await assert.rejects(f.executor.execute(wakeRequest()), { code: 'WORLD_PAUSED' });
  f.authority.state.paused = false; f.authority.state.epoch = 1;
  await assert.rejects(f.executor.execute(wakeRequest()), { code: 'EXECUTION_EPOCH_RETIRED' });
});

test('companion_self: a call must carry something within its bounds; a refusal comes back with what to do about it; the world is re-checked first', async () => {
  const sent = [], lines = [];
  let guarded = 0, answer = body => ({ ...(body.mood === undefined ? {} : { mood: 'accepted' }), ...(body.note === undefined ? {} : { note: 'rejected:sensitive' }), ...(body.outreach === undefined ? {} : { outreach: body.outreach }) });
  const [tool] = createSelfTools({ authority: { selfRecord: async body => { sent.push(body); return answer(body); } }, scope: OWN, guard: async () => { guarded++; }, log: line => lines.push(line) });
  const call = async args => JSON.parse((await tool.execute('call', args)).content[0].text);
  for (const args of [{}, { mood: '' }, { mood: '   ' }, { mood: '长'.repeat(121) }, { note: '长'.repeat(401) }, { outreach: 'now' }, { mood: 'x', person: 'p-0a1b2c' }, { mood: 'x', streamId: PERSON.streamId }, null, 'x'])
    await assert.rejects(tool.execute('call', args), { code: 'INVALID_REQUEST' });
  assert.deepEqual([sent.length, guarded], [0, 0]);
  assert.deepEqual(await call({ mood: '长'.repeat(120), note: 'MOCK 随笔', outreach: 'yes' }), { mood: '记下了。', note: '没有记下：涉及密码、证件、健康等敏感信息，按规定不保存。不要换说法重试。', outreach: '档位现在是 yes。' });
  assert.deepEqual(sent, [{ streamId: OWN.streamId, mood: '长'.repeat(120), note: 'MOCK 随笔', outreach: 'yes' }]);
  assert.equal(guarded, 1);
  answer = () => ({ mood: 'rejected:unsafe_text' });
  assert.match((await call({ mood: 'MOCK 1234567' })).mood, /^没有记下：里面有一长串数字/);
  // One stderr line per failed call: the tool and the code, never what she wrote.
  assert.ok(lines.length === 10 && lines.every(line => line === 'conversation tool failed: companion_self - INVALID_REQUEST'));
});
