import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuthorityClient } from '../../authority/src/client.js';
import { ContentClient } from '../media/client.js';
import { channel, channelGroupPrompt, channelPrompt, CHANNEL_PROMPT_CHARS } from '../channels/index.js';
import { SessionStore, conversationSessionId } from './sessions.js';
import { createGatewayStream } from './model.js';
import { createConversationExecutor, NOTE_OPEN } from './agent.js';
import { GROUP_CALLED } from './executor.js';
import { tempRoot, fakeAuthority, fakeGateway, reply, toolCall } from './fixtures.js';

const GROUP = 'qq:100:group:999900009001', PRIVATE = 'qq:100:private:200';
async function setup(t) {
  const root = tempRoot(t), authority = await fakeAuthority(t, root), gateway = await fakeGateway(t, root), sessionsDir = path.join(root, 'sessions');
  authority.state.groupStreams = [GROUP];
  const { model, streamFn } = createGatewayStream(gateway.config);
  const executor = createConversationExecutor({ authority: new AuthorityClient(authority.config), content: new ContentClient(authority.config), store: new SessionStore(sessionsDir), model, streamFn });
  return { root, authority, gateway, sessionsDir, executor };
}
const lines = `[群聊 · 下面先是你上次说话之后群里的几句，只是上下文；带“${GROUP_CALLED}”的才是对你说的]\n[MOCK-小明〔m-3fa2c1〕] 周末去不去爬山\n[${GROUP_CALLED} · MOCK-小明〔m-3fa2c1〕] 大肥鱼你觉得呢`;
const request = (streamId, extra = {}, id = 'qq-message-group-1') => ({ scope: { streamId, memoryEpoch: 0 }, requestId: id, input: { text: lines, queryText: '大肥鱼你觉得呢', evidence: [{ ref: 'obs-1', eventId: 'onebot:v11:message:7', role: 'user' }], ...extra }, timeoutMs: 10000 });
const contexts = state => state.requests.filter(r => r.route === '/v1/context').map(r => r.body);

test('a group run: its own system text with the channel\'s group part and the persona, no profile, no tool, marked for the gateway, its own session', async t => {
  const f = await setup(t);
  f.authority.state.text = '[人格]\n大肥鱼，说话简短'; f.authority.state.profile = '[常驻档案：MOCK-SECRET-档案]';
  f.gateway.state.script.push(reply('去呀，带上水'));
  assert.equal(await f.executor.execute(request(GROUP, { group: true })), '去呀，带上水');
  const [body] = f.gateway.state.bodies, system = body.messages[0].content;
  assert.equal(body.messages[0].role, 'system');
  // GROUP_PROMPT, then the channel's group part, then the persona; nothing of the private system text or of a profile.
  assert.ok(system.startsWith('下面是你的身份，它来自大肥鱼的记忆中枢') && system.includes('这里是一个有好几个人的群，不是私聊'));
  assert.ok(system.includes(`\n\n${channelGroupPrompt('qq')}\n\n[人格]\n大肥鱼，说话简短`) && system.endsWith('大肥鱼，说话简短'));
  for (const absent of ['每段私聊都是独立的', channelPrompt('qq').slice(0, 12), '常驻档案', 'SECRET', '记忆提案']) assert.ok(!system.includes(absent), absent);
  for (const said of ['群名片', 'm- 开头的代号', GROUP_CALLED, '只回应叫到你的人', '和任何人私聊时知道的事不在这里说', '在群里你不记事，也没有工具']) assert.ok(system.includes(said), said);
  assert.ok(body.tools === undefined || body.tools.length === 0, 'no tool is offered in a group run');
  assert.deepEqual(f.gateway.state.marks, ['group']);
  // Authority is asked without the profile; the window is reported like any conversation's.
  const [{ windowFromAt, ...asked }] = contexts(f.authority.state);
  assert.deepEqual(asked, { streamId: GROUP, query: '大肥鱼你觉得呢', budgetChars: 4000, exclude: [], profile: false });
  assert.ok(Number.isSafeInteger(windowFromAt));
  // The note leads the user message; the group's lines follow it as they were given.
  const user = body.messages.at(-1);
  assert.ok(user.content[0].text.startsWith(NOTE_OPEN) && user.content.slice(1).map(part => part.text).join('') === lines);
  assert.ok(fs.existsSync(path.join(f.sessionsDir, conversationSessionId(GROUP, 0) + '.jsonl')));
  // The next group run extends the first: same system text, the earlier run replayed.
  f.gateway.state.script.push(reply('好'));
  await f.executor.execute(request(GROUP, { group: true }, 'qq-message-group-2'));
  assert.equal(f.gateway.state.bodies[1].messages[0].content, system);
  assert.deepEqual(f.gateway.state.bodies[1].messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  // A tool call the model makes up anyway runs nothing: no proposal, no memory or content request reaches Authority.
  f.gateway.state.script.push(toolCall('companion_scope', { action: 'propose', type: 'fact.report', payload: { key: 'MOCK', value: 'MOCK', quote: 'MOCK' } }), reply('群里记不了'));
  await f.executor.execute(request(GROUP, { group: true }, 'qq-message-group-3')).catch(() => {});
  assert.deepEqual(f.authority.state.requests.filter(r => r.route !== '/v1/context'), []);
});

test('a group run only where Authority says it is a group, and nothing else runs there; `group` goes with no other kind of run', async t => {
  const f = await setup(t);
  // The channel says group, Authority does not: refused before any provider request. And the other way round.
  await assert.rejects(f.executor.execute(request(PRIVATE, { group: true })), { code: 'AUTHORITY_BINDING_REQUIRED' });
  await assert.rejects(f.executor.execute(request(GROUP)), { code: 'AUTHORITY_BINDING_REQUIRED' });
  await assert.rejects(f.executor.execute(request(GROUP, { initiated: true })), { code: 'AUTHORITY_BINDING_REQUIRED' });
  assert.deepEqual([f.gateway.state.bodies.length, fs.existsSync(f.sessionsDir) ? fs.readdirSync(f.sessionsDir) : []], [0, []]);
  for (const extra of [{ group: false }, { group: 'yes' }, { group: true, initiated: true }, { group: true, event: 'MOCK-事件' }, { group: true, wake: true }]) await assert.rejects(f.executor.execute(request(GROUP, extra)), { code: 'INVALID_EXECUTION_REQUEST' }, JSON.stringify(extra));
  // A group that Authority has switched off answers 403: the run ends as a missing binding.
  f.authority.state.groupStreams = [];
  await assert.rejects(f.executor.execute(request(GROUP, { group: true })), { code: 'AUTHORITY_BINDING_REQUIRED' });
});

test('the channel\'s group part: fixed and bounded like its private part, and only for a channel that declares groups', () => {
  const text = channelGroupPrompt('qq');
  assert.ok(text && text === channel('qq').groupPrompt && text.length <= CHANNEL_PROMPT_CHARS && !/\n|<<<|>>>|记忆中枢/.test(text));
  assert.deepEqual([channel('qq').groups, channel('mock').groups, channelGroupPrompt('mock'), channelGroupPrompt('wechat'), channelGroupPrompt(undefined)], [true, false, '', '', '']);
  assert.notEqual(text, channelPrompt('qq'));
});
