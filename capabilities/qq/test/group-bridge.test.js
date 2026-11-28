import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge, DIARY_CODE_PHRASE } from '../bridge.js';
import { PACING } from '../pacing.js';
import { GROUP, groupFrom } from '../group.js';
import { QQMedia } from '../media.js';
import { channel } from '../../channels/index.js';

// Visibly fake accounts: the bot is 100, the owner 200, friends 301 and 302, a stranger 399.
const SELF = '100', OWNER = '200', G = '999900009001', G2 = '999900009002', STREAM = `qq:${SELF}:group:${G}`;
const label = uid => 'm-' + String(uid).padStart(6, '0');
const text = value => ({ type: 'text', data: { text: value } }), at = qq => ({ type: 'at', data: { qq } });

/** A bridge with a fake clock and timer (nothing waits for real time), a fake Authority that lists the enabled
 * groups and answers member reports with labels, and a fake OneBot that keeps what was sent. */
async function fixture(t, { group = GROUP, media = false, enabled = [G], names = ['大肥鱼', '小鱼'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { paused: true, revision: 1 }, observations = [], sends = [], requests = [], logs = [], timers = new Map(), calls = [], reports = [], content = [];
  let now = Date.now(), timerId = 0, sentId = 900;
  const state = { enabled: new Set(enabled), names, roster: { [G]: [[OWNER, 'MOCK-主人'], ['301', 'MOCK-小明'], ['302', 'MOCK-阿姨'], ['399', 'MOCK-路人']], [G2]: [[OWNER, 'MOCK-主人']] }, sendError: null, messages: {} };
  const authority = {
    health: async () => ({ world }),
    context: async input => { calls.push(['context', input.streamId]); const gid = /:group:(\d+)$/.exec(input.streamId)?.[1]; if (gid && !state.enabled.has(gid)) throw Object.assign(new Error('AUTHORITY_REJECTED'), { status: 403 }); return { entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }; },
    groups: async () => ({ groups: [...state.enabled].map(gid => ({ streamId: `qq:${SELF}:group:${gid}` })), callNames: state.names }),
    syncGroupMembers: async input => { reports.push(input); return { labels: Object.fromEntries(input.members.map(member => [member.actorId, label(member.actorId.split(':').at(-1))])), changed: 0 }; },
  };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: Number(SELF) };
    if (action === 'get_friend_list') return [{ user_id: 301 }, { user_id: 302 }];
    if (action === 'get_group_member_list') return [{ user_id: Number(SELF), card: '大肥鱼' }, ...(state.roster[args.group_id] ?? []).map(([uid, card]) => ({ user_id: Number(uid), card, nickname: 'MOCK-昵称', join_time: 1_700_000_000 }))];
    if (action === 'get_group_list') return [{ group_id: Number(G), group_name: 'MOCK-家人群', member_count: 5 }, { group_id: Number(G2), group_name: 'MOCK-\n朋友群' }];
    if (action === 'get_group_member_info') { if ((state.roster[args.group_id] ?? []).some(([uid]) => uid === args.user_id)) return { user_id: Number(args.user_id) }; throw new Error('ONEBOT_REJECTED'); }
    if (action === 'get_msg') { const found = state.messages[args.message_id]; if (!found) throw new Error('ONEBOT_REJECTED'); return found; }
    sends.push({ action, ...args });
    if (state.sendError) { const error = state.sendError(action, args); if (error) throw error; }
    return { message_id: ++sentId };
  } };
  const executor = { execute: async request => { requests.push(request); return executor.reply ? executor.reply(request) : '好'; } };
  const service = media ? new QQMedia({ onebot, content: { call: async request => { content.push(request); if (request.action === 'pending') return { parts: [] }; if (request.action === 'synthesize') return { id: 'artifact:voice' }; if (request.action === 'asset') return { kind: 'audio', data: 'AAAA' }; throw new Error('MOCK_CONTENT'); } } }) : undefined;
  const bridge = new QQBridge({ authority, onebot, executor, media: service, pacing: PACING, group, random: () => 0.5, sleep: async () => {}, clock: () => now, log: line => logs.push(line),
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, due: now + ms }); return timerId; }, clearTimer: id => { timers.delete(id); },
    port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } },
    settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json') });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: SELF, allowedCallerUID: OWNER });
  world.paused = false; world.revision++;
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(setImmediate); };
  await bridge.refreshGroups(); await settle();
  let id = 0;
  const event = (uid, message, extra = {}) => ({ post_type: 'message', message_type: 'group', group_id: Number(G), self_id: Number(SELF), user_id: Number(uid), sender: { user_id: Number(uid), card: (state.roster[G].find(([member]) => member === String(uid)) ?? [])[1] ?? '' }, message_id: ++id, time: Math.floor(Date.now() / 1000), message: typeof message === 'string' ? [text(message)] : message, ...extra });
  /** A group message arrives; resolves once the bridge has taken it, with `done`: the turn that answers it (if any). */
  const say = async (uid, message, extra) => { const done = bridge.receive(event(uid, message, extra)); await settle(); return { done, id }; };
  const advance = async ms => {
    now += ms;
    for (const [key, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) if (timer.due <= now) { timers.delete(key); timer.fn(); }
    await settle();
  };
  /** She is called and the burst wait passes: the turn runs to its end. */
  const call = async (uid, message, extra) => { const said = await say(uid, message, extra); await advance(PACING.burstQuietMs); await said.done; await settle(); return said; };
  const records = () => Object.values(bridge.state.records);
  return { bridge, dir, world, state, observations, sends, requests, logs, calls, reports, content, executor, say, call, advance, settle, records, event, now: () => now };
}

test('a group that is not enabled: nothing is kept, asked, run, sent or logged', async t => {
  const f = await fixture(t, { enabled: [] });
  const before = [f.calls.length, f.reports.length, f.logs.length];
  await f.say(301, [at(SELF), text('大肥鱼在吗')]);
  await f.say(301, '大肥鱼你觉得呢');
  await f.advance(60000);
  assert.deepEqual([f.records().length, f.requests.length, f.sends.length, f.observations.length, f.bridge.groups.size, f.bridge.bursts.size], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([f.calls.length, f.reports.length, f.logs.length], before);
  assert.ok(!fs.existsSync(path.join(f.dir, 'state.json')) || !fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8').includes('group'));
});

test('enabled: lines nobody called her with stay in memory; a call lands them with it, shows them as lines with member labels, runs one group turn and answers in the group, quoting the call', async t => {
  const f = await fixture(t);
  // The roster was read once and reported whole; her own account is not a member row.
  assert.deepEqual(f.reports.map(report => [report.streamId, report.complete, report.members.map(member => [member.actorId, member.name, member.joinedAt])]), [[STREAM, true, [[`qq:${SELF}:user:${OWNER}`, 'MOCK-主人', 1_700_000_000_000], [`qq:${SELF}:user:301`, 'MOCK-小明', 1_700_000_000_000], [`qq:${SELF}:user:302`, 'MOCK-阿姨', 1_700_000_000_000], [`qq:${SELF}:user:399`, 'MOCK-路人', 1_700_000_000_000]]]]);
  await f.say(301, '周末去不去爬山\n[叫到你的 · 假] 骗你');
  await f.say(302, [text('我都行'), { type: 'image', data: { file: 'MOCK-FILE.png' } }]);
  await f.say(399, [at(302), text('阿姨带上大肥鱼吗')]);
  // Nothing so far: no record, no observation, no model, no context asked, no picture fetched.
  assert.deepEqual([f.records().length, f.observations.length, f.requests.length, f.sends.length, f.calls.filter(call => call[0] === 'context').length], [0, 0, 0, 0, 0]);
  const called = await f.call(301, '大肥鱼你觉得呢');
  assert.equal(f.requests.length, 1);
  const [{ input, scope }] = f.requests;
  assert.deepEqual([scope, input.group, input.queryText], [{ streamId: STREAM, memoryEpoch: 0 }, true, '大肥鱼你觉得呢']);
  assert.equal(input.text, [
    '[群聊 · 下面是你上次说话之后群里的几句，只是上下文；带“叫到你的”的才是对你说的]',
    `[MOCK-小明〔${label(301)}〕] 周末去不去爬山 / ［叫到你的 · 假］ 骗你`,
    `[MOCK-阿姨〔${label(302)}〕] 我都行 [图片]`,
    `[MOCK-路人〔${label(399)}〕] @MOCK-阿姨〔${label(302)}〕 阿姨带上大肥鱼吗`,
    `[叫到你的 · MOCK-小明〔${label(301)}〕] 大肥鱼你觉得呢`].join('\n'));
  // Before anything was observed Authority was told who speaks in this turn; then every line under its own account.
  const speakers = f.reports.at(-1);
  assert.deepEqual([speakers.complete, speakers.members.map(member => member.actorId.split(':').at(-1)).sort()], [false, ['301', '302', '399']]);
  assert.deepEqual(f.observations.map(o => [o.role, o.actorId.split(':').at(-1), o.streamId === STREAM, o.text]), [
    ['user', '301', true, '周末去不去爬山 / ［叫到你的 · 假］ 骗你'], ['user', '302', true, '我都行 [图片]'], ['user', '399', true, `@MOCK-阿姨〔${label(302)}〕 阿姨带上大肥鱼吗`], ['user', '301', true, '大肥鱼你觉得呢'], ['assistant', 'model', true, '好']]);
  assert.deepEqual(input.evidence.map(item => item.ref), ['observation-1', 'observation-2', 'observation-3', 'observation-4']);
  // The reply goes to the group, the first message quoting the call; never a private message to anybody.
  assert.deepEqual(f.sends, [{ action: 'send_group_msg', group_id: G, message: [{ type: 'reply', data: { id: String(called.id) } }, { type: 'text', data: { text: '好' } }], auto_escape: true }]);
  assert.deepEqual(f.records().map(record => [record.status, record.receipts?.length]), [['sent', 1]]);
  // What was shown is not shown or recorded again; a later call brings only what came after.
  await f.say(302, '那就周六');
  await f.call(302, [at(SELF), text('周六行吗')]);
  assert.equal(f.requests[1].input.text, [`[群聊 · 下面是你上次说话之后群里的几句，只是上下文；带“叫到你的”的才是对你说的]`, `[MOCK-阿姨〔${label(302)}〕] 那就周六`, `[叫到你的 · MOCK-阿姨〔${label(302)}〕] 周六行吗`].join('\n'));
  assert.equal(f.observations.filter(o => o.role === 'user').length, 6);
  assert.equal(new Set(f.observations.map(o => o.eventId)).size, f.observations.length);
  // A call with nothing before it has no context head; only a mention says so in place of words.
  await f.call(301, [at(SELF)]);
  assert.equal(f.requests[2].input.text, `[群聊 · 带“叫到你的”的是对你说的]\n[叫到你的 · MOCK-小明〔${label(301)}〕] [渠道事实：对方在群里 @ 了你，没有说别的。]`);
});

test('what calls her: a mention, her name, a quote of her message in this group; not everyone, not her name said to somebody else, not the diary phrase', async t => {
  const f = await fixture(t);
  const quiet = async (uid, message) => { await f.say(uid, message); await f.advance(PACING.burstQuietMs); };
  await quiet(301, [at('all'), text('开饭了')]);
  await quiet(301, [at(302), text('大肥鱼刚才说得对')]);
  await quiet(301, '今天吃鱼');
  await quiet(301, DIARY_CODE_PHRASE);
  assert.deepEqual([f.requests.length, f.sends.length, f.records().length], [0, 0, 0]);
  await f.call(301, '小鱼在吗');
  assert.equal(f.requests.length, 1);
  // The diary phrase in a group is only a line of the group, never answered by the bridge itself.
  assert.ok(f.requests[0].input.text.includes(`] ${DIARY_CODE_PHRASE}\n`) && f.sends.every(send => send.action === 'send_group_msg'));
  // A quote of her delivered message in this group calls her; the line says whose words are quoted.
  const hers = f.records().at(-1).receipts[0].messageId;
  await f.call(302, [{ type: 'reply', data: { id: hers } }, text('这个不错')]);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].input.text.endsWith(`[叫到你的 · MOCK-阿姨〔${label(302)}〕] ［引用 你之前说的：好］ 这个不错`));
  // A quote of a member's message is no call; of a message the platform says is from elsewhere, nothing of it is shown.
  f.state.messages[5001] = { sender: { user_id: 301 }, group_id: Number(G), message: [text('吃了吗')] };
  f.state.messages[5002] = { sender: { user_id: Number(SELF) }, message_type: 'private', message: [text('MOCK-SECRET 私聊里的话')] };
  f.state.messages[5003] = { sender: { user_id: Number(SELF) }, group_id: Number(G), message: [text('群里说过的话')] };
  await quiet(302, [{ type: 'reply', data: { id: '5001' } }, text('吃了')]);
  await quiet(302, [{ type: 'reply', data: { id: '5002' } }, text('嗯')]);
  assert.equal(f.requests.length, 2);
  // After a restart the bridge no longer remembers what it sent: the platform says the quoted message is hers.
  await f.call(302, [{ type: 'reply', data: { id: '5003' } }, text('再说一遍')]);
  const shown = f.requests[2].input.text;
  assert.ok(shown.includes(`［引用 MOCK-小明〔${label(301)}〕 之前说的：吃了吗］ 吃了`) && shown.includes('［引用了一条消息］ 嗯') && shown.includes('［引用 你之前说的：群里说过的话］ 再说一遍'));
  assert.ok(!JSON.stringify(f.requests).includes('SECRET') && !JSON.stringify(f.observations).includes('SECRET'));
});

test('several people calling at once are answered by one turn; a long reply is at most two messages; a lost receipt is unknown and never sent again', async t => {
  const f = await fixture(t);
  const first = await f.say(301, '大肥鱼周末去哪');
  await f.advance(1000);
  const second = await f.say(302, [at(SELF), text('带我一个')]);
  await f.say(399, '路人的闲话');
  f.executor.reply = () => '第一句话说完了。'.repeat(8) + '第二句话也说完了。'.repeat(8) + '第三句还有。'.repeat(8) + '最后一句。'.repeat(8);
  await f.advance(PACING.burstQuietMs); await Promise.all([first.done, second.done]); await f.settle();
  assert.equal(f.requests.length, 1);
  const lines = f.requests[0].input.text.split('\n');
  assert.deepEqual(lines.slice(1).map(line => line.startsWith('[叫到你的 · ')), [true, true]);
  assert.equal(f.requests[0].input.queryText, '大肥鱼周末去哪\n带我一个');
  // Two messages, the whole reply in them; only the first quotes, and it quotes the last call.
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends.map(send => [send.action, send.message[0].type === 'reply' ? send.message[0].data.id : null]), [['send_group_msg', String(second.id)], ['send_group_msg', null]]);
  const sentText = f.sends.map(send => send.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('')).join('');
  assert.equal(sentText.replace(/\s/g, ''), f.executor.reply().replace(/\s/g, ''));
  assert.deepEqual(f.records().map(record => record.status), ['sent', 'sent']);
  // The line that came after the calls waits for the next turn.
  assert.deepEqual(f.bridge.groups.get(STREAM).buffer.lines.map(line => line.text), ['路人的闲话']);
  // A lost receipt: status unknown, nothing sent again, and only what has a receipt is observed as said.
  f.state.sendError = () => new Error('ONEBOT_DELIVERY_UNKNOWN');
  f.executor.reply = () => '好的';
  const before = f.sends.length;
  await f.call(301, [at(SELF), text('再问一句')]);
  assert.deepEqual([f.sends.length - before, f.records().at(-1).status], [1, 'unknown']);
  assert.deepEqual(f.observations.at(-1).eventId.startsWith('qq:undelivered:'), true);
  assert.match(f.observations.at(-1).text, /发送状态未知/);
  await f.advance(600000);
  assert.equal(f.sends.length - before, 1);
});

test('a refused send is never made again; two quoted messages refused in a row and later ones go without a quote', async t => {
  const f = await fixture(t);
  f.state.sendError = (action, args) => args.message[0].type === 'reply' ? new Error('ONEBOT_REJECTED') : null;
  await f.call(301, [at(SELF), text('在吗')]);
  // Refused once: not sent again in any form (a refusal does not prove nothing went out), and the next still quotes.
  assert.deepEqual([f.sends.map(send => send.message[0].type), f.records().at(-1).status], [['reply'], 'unknown']);
  await f.call(302, [at(SELF), text('还在吗')]);
  assert.deepEqual([f.sends.map(send => send.message[0].type), f.records().at(-1).status], [['reply', 'reply'], 'unknown']);
  assert.ok(f.logs.includes('qq group send: two quoted messages in a row were refused; sending without quotes'));
  await f.call(OWNER, [at(SELF), text('现在呢')]);
  assert.deepEqual([f.sends.map(send => send.message[0].type), f.records().at(-1).status], [['reply', 'reply', 'text'], 'sent']);
  // One refusal between messages that go through does not switch quotes off.
  const g = await fixture(t);
  let refuse = true;
  g.state.sendError = () => { if (!refuse) return null; refuse = false; return new Error('ONEBOT_REJECTED'); };
  await g.call(301, [at(SELF), text('一')]); await g.call(302, [at(SELF), text('二')]);
  refuse = true;
  await g.call(OWNER, [at(SELF), text('三')]); await g.call(301, [at(SELF), text('四')]);
  assert.deepEqual(g.sends.map(send => send.message[0].type), ['reply', 'reply', 'reply', 'reply']);
});

test('limits: silence, one line without any number, and the call stays a line of the group', async t => {
  const f = await fixture(t, { group: groupFrom({ perSenderTurns: 2, perGroupTurnsPerDay: 4, perGroupMessagesPerHour: 5 }) });
  // One account: two calls in ten minutes, the third is silence; somebody else is still answered.
  for (let i = 0; i < 2; i++) await f.call(301, [at(SELF), text(`第${i}次`)]);
  await f.say(301, [at(SELF), text('第三次')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.logs.filter(line => line.startsWith('qq group limited')), f.records().length], [2, ['qq group limited: perSenderTurns'], 2]);
  await f.call(302, [at(SELF), text('我来问')]);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].input.text.includes(`[MOCK-小明〔${label(301)}〕] 第三次`), 'the refused call is a line of context');
  // The window passes: answered again. The fourth turn of the day is the last.
  await f.advance(600000);
  await f.call(301, [at(SELF), text('十分钟后')]);
  assert.equal(f.requests.length, 4);
  await f.say(302, [at(SELF), text('第五回合')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.logs.at(-1)], [4, 'qq group limited: perGroupTurnsPerDay']);
  // The day's count is in the state file: a restart does not reset it.
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).groupTurns.counts[STREAM], 4);
  for (const line of f.logs.filter(line => line.startsWith('qq group limited'))) assert.doesNotMatch(line, /\d/);
});

test('limits: messages per hour, turns queued, and a group turn never takes the slot private chat needs', async t => {
  const f = await fixture(t, { group: groupFrom({ perGroupMessagesPerHour: 2, queuedTurns: 1 }), enabled: [G, G2] });
  await f.call(301, [at(SELF), text('一')]);
  await f.call(302, [at(SELF), text('二')]);
  // The third reply of the hour is not sent: she ran, nothing went out, and her words are recorded as not delivered.
  await f.call(OWNER, [at(SELF), text('三')]);
  assert.deepEqual([f.requests.length, f.sends.length, f.records().at(-1).status, f.logs.at(-1)], [3, 2, 'limited', 'qq group limited: perGroupMessagesPerHour']);
  assert.match(f.observations.at(-1).text, /没有发出/);
  // One turn may wait or run per group here: while it runs, another burst's call is dropped.
  await f.advance(3600000);
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.executor.reply = async () => { await gate; return '好'; };
  const running = await f.say(301, [at(SELF), text('慢慢想')]); await f.advance(PACING.burstQuietMs);
  assert.equal(f.requests.length, 4);
  await f.say(302, [at(SELF), text('排不上')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.records().at(-1).status, f.logs.at(-1), f.requests.length], ['dropped:busy', 'qq group limited: queuedTurns', 4]);
  // Another group's turn waits for the running group turn (one at a time); a private message does not wait for either.
  const other = f.bridge.receive({ ...f.event(OWNER, [at(SELF), text('另一个群')]), group_id: Number(G2) }); await f.settle(); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.bridge.groupActive, f.bridge.groupWaiting.length, f.bridge.active], [4, 1, 1, 1]);
  const direct = f.bridge.receive({ post_type: 'message', message_type: 'private', self_id: Number(SELF), user_id: Number(OWNER), sender: { user_id: Number(OWNER) }, message_id: 7001, time: Math.floor(Date.now() / 1000), message: [text('私聊不排队')] });
  await f.settle(); await f.advance(PACING.burstQuietMs);
  assert.equal(f.requests.length, 5);
  assert.deepEqual([f.requests[4].scope.streamId, f.requests[4].input.group], [`qq:${SELF}:private:${OWNER}`, undefined]);
  release(); await Promise.all([running.done, other, direct]); await f.settle();
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[5].scope.streamId, `qq:${SELF}:group:${G2}`);
  assert.deepEqual([f.bridge.groupActive, f.bridge.active], [0, 0]);
});

test('the spend tier, a pause and a group switched off are silence: no reply, no notice to the owner, nothing retried', async t => {
  const f = await fixture(t);
  f.executor.reply = () => { throw Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' }); };
  await f.call(301, [at(SELF), text('预算紧的时候')]);
  assert.deepEqual([f.records().at(-1).status, f.sends.length, f.bridge.state.budgetNotice], ['budget_restricted', 0, undefined]);
  // She never had that call: it is a line of the next turn, recorded once.
  f.executor.reply = () => '好';
  await f.call(302, [at(SELF), text('现在呢')]);
  assert.ok(f.requests.at(-1).input.text.includes(`[MOCK-小明〔${label(301)}〕] 预算紧的时候`));
  assert.equal(f.observations.filter(o => o.text === '预算紧的时候').length, 1);
  // Paused: nothing runs.
  const before = f.requests.length;
  f.world.paused = true; f.world.revision++;
  await f.say(301, [at(SELF), text('暂停时')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.records().at(-1).status], [before, 'paused']);
  f.world.paused = false; f.world.revision++;
  // Authority has switched the group off before the bridge heard of it: silence, and the list is read again.
  f.state.enabled.delete(G);
  await f.say(301, [at(SELF), text('停用后')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.records().at(-1).status, f.bridge.groups.size], [before, 'dropped:disabled', 0]);
  await f.say(301, [at(SELF), text('还是没人理')]); await f.advance(PACING.burstQuietMs);
  assert.deepEqual([f.requests.length, f.sends.filter(send => send.action === 'send_private_msg').length], [before, 0]);
});

test('voice: only a call by mention that asks for it, within the hourly limit; her name with the same request is text', async t => {
  const f = await fixture(t, { media: true, group: groupFrom({ voicePerHour: 1 }) });
  const policy = channel('qq').turnPolicy.voice;
  await f.call(301, '大肥鱼用语音回答一下周末去哪');
  assert.ok(!f.requests[0].input.text.includes(policy));
  assert.deepEqual(f.sends.map(send => [send.action, send.message.map(segment => segment.type)]), [['send_group_msg', ['reply', 'text']]]);
  await f.call(301, [at(SELF), text('用语音回答一下周末去哪')]);
  assert.ok(f.requests[1].input.text.endsWith('\n' + policy));
  assert.deepEqual([f.sends[1].action, f.sends[1].group_id, f.sends[1].message.map(segment => segment.type)], ['send_group_msg', G, ['reply', 'record']]);
  assert.ok(f.content.some(request => request.action === 'synthesize' && request.streamId === STREAM));
  // The hour's one voice message is used: the same request is answered in text, and she is not told it will be spoken.
  await f.call(302, [at(SELF), text('用语音回答一下')]);
  assert.ok(!f.requests[2].input.text.includes(policy));
  assert.deepEqual([f.sends[2].message.map(segment => segment.type), f.logs.includes('qq group limited: voicePerHour')], [['reply', 'text'], true]);
});

test('members: a join or leave notice reads the roster again, a failed lookup changes nothing, and the control answers say where she is', async t => {
  const f = await fixture(t, { enabled: [G] });
  const reports = () => f.reports.filter(report => report.complete).length;
  assert.equal(reports(), 1);
  f.state.roster[G].push(['303', 'MOCK-新人']);
  await f.bridge.receive({ post_type: 'notice', notice_type: 'group_increase', group_id: Number(G), user_id: 303, self_id: Number(SELF) }); await f.settle();
  assert.deepEqual([reports(), f.bridge.groups.get(STREAM).members.get('303')], [2, { name: 'MOCK-新人', label: label(303) }]);
  // A notice of a group she does not listen in is nothing.
  await f.bridge.receive({ post_type: 'notice', notice_type: 'group_decrease', group_id: Number(G2), user_id: 303, self_id: Number(SELF) }); await f.settle();
  assert.equal(reports(), 2);
  // A lookup that fails or comes back empty: no report, the cards and labels stay.
  f.state.roster[G] = [];
  assert.equal(await f.bridge.syncMembers(STREAM), false);
  assert.deepEqual([reports(), f.bridge.groups.get(STREAM).members.size], [2, 5]);
  // The roster is read again only when it is due.
  f.state.roster[G] = [[OWNER, 'MOCK-主人']];
  await f.bridge.refreshMembers(); assert.equal(reports(), 2);
  await f.advance(GROUP.memberRefreshMs); await f.bridge.refreshMembers();
  assert.deepEqual([reports(), [...f.bridge.groups.get(STREAM).members.keys()]], [3, [OWNER]]);
  // The operator's list and check (the group name is shown to the owner only, cleaned).
  assert.deepEqual(await f.bridge.groupList(), { selfId: SELF, groups: [{ groupId: G, name: 'MOCK-家人群', memberCount: 5, listening: true }, { groupId: G2, name: 'MOCK- 朋友群', memberCount: null, listening: false }] });
  assert.deepEqual(await f.bridge.groupCheck(G), { selfId: SELF, inGroup: true, ownerInGroup: true, memberCount: 5, maxMembers: 100 });
  f.state.roster[G2] = [['301', 'MOCK-小明']];
  assert.deepEqual(await f.bridge.groupCheck(G2), { selfId: SELF, inGroup: true, ownerInGroup: false, memberCount: 2, maxMembers: 100 });
  assert.deepEqual(await f.bridge.groupCheck('999900009009'), { selfId: SELF, inGroup: false, ownerInGroup: false, memberCount: null, maxMembers: 100 });
  await assert.rejects(f.bridge.groupCheck('abc'));
  // Newly enabled in Authority: the next refresh starts listening and reads its roster; disabled: its lines are dropped.
  f.state.enabled.add(G2);
  await f.bridge.refreshGroups();
  assert.deepEqual([f.bridge.groups.size, f.reports.at(-1).streamId], [2, `qq:${SELF}:group:${G2}`]);
  await f.say(301, '一句闲话');
  f.state.enabled.delete(G);
  await f.bridge.refreshGroups();
  assert.deepEqual([...f.bridge.groups.keys()], [`qq:${SELF}:group:${G2}`]);
});

test('forgetting drops the group lines kept in memory; an anonymous message and her own echo are never lines', async t => {
  const f = await fixture(t);
  await f.say(301, 'MOCK-要被忘记的一句');
  await f.say(301, 'MOCK-匿名', { anonymous: { name: 'MOCK', flag: 'x' } });
  await f.say(SELF, 'MOCK-自己的回声');
  assert.deepEqual(f.bridge.groups.get(STREAM).buffer.lines.map(line => line.text), ['MOCK-要被忘记的一句']);
  f.bridge.forgetDispatch({ sourceEvents: [] });
  assert.deepEqual(f.bridge.groups.get(STREAM).buffer.lines, []);
});

test('forgetting a call made in a group leaves its dispatch record as a tombstone, like a private message\'s', async t => {
  const f = await fixture(t);
  const called = await f.call(301, [at(SELF), text('MOCK-要被忘记的一问')]);
  const [requestId] = Object.keys(f.bridge.state.records);
  assert.equal(f.bridge.state.records[requestId].status, 'sent');
  assert.deepEqual(f.bridge.forgetDispatch({ sourceEvents: [{ streamId: STREAM, eventId: `onebot:v11:message:${called.id}` }] }), { dispatchForgotten: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).records[requestId], { status: 'forgotten' });
  // The same message delivered again by the platform is not answered again.
  await f.bridge.receive({ ...f.event(301, [at(SELF), text('MOCK-要被忘记的一问')]), message_id: called.id }); await f.advance(PACING.burstQuietMs);
  assert.equal(f.requests.length, 1);
});
