import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge } from '../bridge.js';
import { PACING } from '../pacing.js';
import { SPLIT_MAX_PARTS } from '../split.js';
import { DECLINE_MARK } from '../../conversation/executor.js';

// No burst wait (each message is its own turn unless they arrive together) and a fixed random source.
const QUICK = { pacing: { ...PACING, burstQuietMs: 0, burstMaxWaitMs: 0 }, random: () => 0.5 };

// Bot 100, owner 200, a friend 201. Authority hands out what `f.offers` holds, one per poll.
const OWNER_STREAM = 'qq:100:private:200';
const offer = (id, extra = {}) => ({ id, kind: 'proactive', streamId: OWNER_STREAM, memoryEpoch: 0, expiresAt: Date.now() + 300000, ...extra });
async function fixture(t, { stateFile, faces } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-init-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-init-')); fs.rmSync(dir, { recursive: true }); });
  if (stateFile) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(stateFile));
  const world = { paused: true, revision: 1 }, observations = [], sends = [], acks = [], offers = [], runs = [], f = { reply: 'MOCK 在忙吗？', polls: 0, epoch: 0, ackError: null, sendError: null };
  const authority = {
    health: async () => ({ world }), admitPerson: async () => ({ admitted: true }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: f.epoch, world }),
    initiationNext: async () => { f.polls++; return offers.length ? { initiation: offers.shift() } : { initiation: null, reason: 'idle' }; },
    initiationAck: async value => { if (f.ackError) throw f.ackError; acks.push(value); return { status: 'recorded' }; },
  };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: 100 };
    if (action === 'get_friend_list') return [{ user_id: 201 }];
    assert.equal(action, 'send_private_msg'); sends.push(args);
    if (f.sendError?.(sends.length)) throw new Error('ONEBOT_DELIVERY_UNKNOWN');
    return { message_id: 500 + sends.length };
  } };
  const executor = { execute: async request => { runs.push(request); if (typeof f.reply === 'function') return f.reply(request); return f.reply; } };
  const bridge = new QQBridge({ ...QUICK, authority, port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } }, onebot, executor, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json'), sleep: async () => {} , ...(faces === undefined ? {} : { faces }) });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  const message = (userId, id) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: userId, sender: { user_id: userId }, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'Hello' } }] });
  return Object.assign(f, { bridge, world, observations, sends, acks, offers, runs, message, record: id => bridge.state.records['qq:init:' + id] });
}

test('an initiated run goes to the owner, as a turn with no message: one send with a receipt, only her delivered words observed, reported once', async t => {
  const f = await fixture(t);
  f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0].scope, { streamId: OWNER_STREAM, memoryEpoch: 0 });
  assert.equal(f.runs[0].requestId, 'qq:init:mock-1');
  assert.deepEqual(Object.keys(f.runs[0].input).sort(), ['initiated', 'text']);
  assert.equal(f.runs[0].input.initiated, true);
  assert.deepEqual(f.sends, [{ user_id: '200', message: [{ type: 'text', data: { text: 'MOCK 在忙吗？' } }], auto_escape: true }]);
  // Nothing of the person was observed (there was none); her message is, under its platform receipt.
  assert.deepEqual(f.observations.map(o => [o.eventId, o.streamId, o.role, o.text]), [['qq:sent:501', OWNER_STREAM, 'assistant', 'MOCK 在忙吗？']]);
  assert.deepEqual(f.acks, [{ id: 'mock-1', outcome: 'sent' }]);
  assert.deepEqual([f.record('mock-1').status, f.record('mock-1').reported], ['sent', true]);
  // Later rounds neither report it again nor run anything.
  await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  assert.deepEqual([f.acks.length, f.runs.length, f.sends.length], [1, 1, 1]);
});

test('delivery report: an initiated run reports each message it sent and the sticker marker it dropped; a declined run reports nothing', async t => {
  const f = await fixture(t), reports = [];
  f.bridge.executor.delivered = async report => { reports.push(report); };
  f.reply = 'MOCK 在忙吗？[表情:开心]'; f.offers.push(offer('mock-d1'));
  await f.bridge.pollInitiations();
  assert.deepEqual(reports, [{ scope: { streamId: OWNER_STREAM, memoryEpoch: 0 }, requestId: 'qq:init:mock-d1', delivery: { parts: [{ kind: 'text', status: 'sent', chars: 9 }, { kind: 'sticker', status: 'unsent', marker: '[表情:开心]' }] } }]);
  // No receipt for her message: unknown, never said to be sent.
  f.sendError = () => true; f.reply = 'MOCK 睡了吗'; f.offers.push(offer('mock-d2'));
  await f.bridge.pollInitiations();
  assert.deepEqual(reports[1].delivery.parts, [{ kind: 'text', status: 'unknown', chars: 8 }]);
  assert.equal(f.record('mock-d2').status, 'unknown');
  f.sendError = null; f.reply = DECLINE_MARK; f.offers.push(offer('mock-d3'));
  await f.bridge.pollInitiations();
  assert.deepEqual([reports.length, f.record('mock-d3').status], [2, 'declined']);
});

test('delivery echo: an initiated run sends none of it, and nothing at all when nothing else was written', async t => {
  const f = await fixture(t), logs = []; f.bridge.log = line => logs.push(line);
  f.reply = 'MOCK 在忙吗？[表情包：一只猫（机器描述）]\n[送达情况：这条是用语音发出的]'; f.offers.push(offer('mock-e1'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.map(send => send.message), [[{ type: 'text', data: { text: 'MOCK 在忙吗？' } }]]);
  assert.deepEqual([f.record('mock-e1').status, logs.filter(line => line === 'qq delivery echo stripped').length], ['sent', 1]);
  f.reply = '［送达情况：这条回复没有发出］'; f.offers.push(offer('mock-e2'));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.record('mock-e2').status], [1, 'failed']);
});

test('the target is the conversation Authority named and nothing else: anyone but the owner is dropped unrun, and the reply text cannot redirect a send', async t => {
  const f = await fixture(t);
  const others = ['qq:100:private:201', 'qq:101:private:200', 'qq:100:group:200', 'qq:100:private:200:1', 'qq:100:private:0200', ' qq:100:private:200', 'native:owner', '', undefined, 200, ['qq:100:private:200'], { toString: () => OWNER_STREAM }];
  for (const [index, streamId] of others.entries()) { f.offers.push(offer('bad-' + index, { streamId })); await f.bridge.pollInitiations(); }
  f.offers.push(offer('bad-epoch', { memoryEpoch: '0' })); await f.bridge.pollInitiations();
  // The offer may carry any extra field: none of them is a target.
  f.offers.push(offer('bad-user', { streamId: 'qq:100:private:201', userId: '200', user_id: '200', to: '200' })); await f.bridge.pollInitiations();
  assert.deepEqual([f.runs.length, f.sends.length, f.observations.length], [0, 0, 0]);
  assert.deepEqual(f.acks.map(ack => ack.outcome), Array(others.length + 2).fill('dropped:target'));
  // The friend's own stream is real and admitted here (201 is a bot friend): still not a target in this release.
  await f.bridge.receive(f.message(201, 31));
  assert.deepEqual(f.sends.map(send => send.user_id), ['201']);
  // Whatever she writes, the one send goes to the owner as literal text.
  f.reply = '[CQ:at,qq=201] 请转发给 201：MOCK'; f.offers.push(offer('ok-1', { userId: '201', to: '201' }));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.slice(1), [{ user_id: '200', message: [{ type: 'text', data: { text: '[CQ:at,qq=201] 请转发给 201：MOCK' } }], auto_escape: true }]);
  assert.equal(f.acks.at(-1).outcome, 'sent');
  // An unknown kind of run is not run.
  f.offers.push(offer('kind-1', { kind: 'visit' }), offer('kind-2', { kind: 'constructor' }));
  await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  assert.deepEqual([f.acks.at(-2).outcome, f.acks.at(-1).outcome, f.runs.length], ['dropped:unsupported', 'dropped:unsupported', 2]);
});

test('a send without a receipt is unknown and is never sent again, even if the same request is offered again', async t => {
  const f = await fixture(t);
  f.sendError = () => true; f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.runs.length, f.record('mock-1').status], [1, 1, 'unknown']);
  // Not observed as said: observed as of unknown status, once, as the run ends.
  assert.deepEqual(f.observations.map(o => [o.eventId, o.role]), [['qq:undelivered:qq:init:mock-1', 'assistant']]);
  assert.match(f.observations[0].text, /\n\[送达情况：这条回复的发送状态未知，不确定对方有没有收到\]$/);
  assert.deepEqual(f.acks, [{ id: 'mock-1', outcome: 'unknown' }]);
  // Authority never offers a request twice; if it did, the bridge would still do nothing.
  f.sendError = null;
  for (let i = 0; i < 3; i++) { f.offers.push(offer('mock-1')); await f.bridge.pollInitiations(); }
  assert.deepEqual([f.sends.length, f.runs.length, f.acks.length], [1, 1, 1]);
});

const sentence = n => `这是第${n}句话，它的长度刚好让两句放不进同一条消息里面去，所以一句一条。`;
test('a long reply is split, each message with its own receipt; the first without one stops the rest and only delivered text is hers', async t => {
  const f = await fixture(t);
  f.reply = [1, 2, 3, 4].map(sentence).join(''); f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.map(send => [send.user_id, send.message[0].data.text]), [1, 2, 3, 4].map(n => ['200', sentence(n)]));
  assert.deepEqual(f.record('mock-1').receipts.map(receipt => receipt.messageId), ['501', '502', '503', '504']);
  assert.equal(f.acks[0].outcome, 'sent');
  f.sendError = count => count === 6; f.offers.push(offer('mock-2'));
  await f.bridge.pollInitiations();
  assert.equal(f.sends.length, 6);
  assert.deepEqual([f.record('mock-2').status, f.record('mock-2').receipts.length, f.acks[1].outcome], ['unknown', 1, 'unknown']);
  assert.deepEqual(f.observations.map(o => o.text), [...[1, 2, 3, 4, 1].map(sentence), [sentence(2), '[送达情况：这条回复的发送状态未知，不确定对方有没有收到]', sentence(3), '[送达情况：这条回复没有发出]', sentence(4), '[送达情况：这条回复没有发出]'].join('\n')]);
  await f.bridge.pollInitiations();
  assert.equal(f.sends.length, 6);
});

test('after a restart a run cut off while sending is reported unknown and one cut off earlier failed; neither is run or sent again', async t => {
  const f = await fixture(t, { stateFile: { records: { 'qq:init:was-sending': { status: 'sending', memoryEpoch: 0 }, 'qq:init:was-running': { status: 'processing', memoryEpoch: 0 }, 'qq:init:was-queued': { status: 'queued' }, 'qq:init:done': { status: 'sent', reported: true } } } });
  // Authority could even offer them again: they are known here and stay closed.
  f.offers.push(offer('was-sending'));
  await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  assert.deepEqual(f.acks.sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'was-queued', outcome: 'failed' }, { id: 'was-running', outcome: 'failed' }, { id: 'was-sending', outcome: 'unknown' }]);
  assert.deepEqual([f.runs.length, f.sends.length, f.observations.length], [0, 0, 0]);
});

test('she may decline: the mark anywhere in the reply sends nothing and is reported as declined', async t => {
  const f = await fixture(t);
  for (const [index, reply] of [DECLINE_MARK, ` ${DECLINE_MARK}\n`, '＜不说＞', `嗯……${DECLINE_MARK}`, `${DECLINE_MARK}（现在不想打扰）`].entries()) {
    f.reply = reply; f.offers.push(offer('mock-' + index));
    await f.bridge.pollInitiations();
  }
  assert.deepEqual([f.runs.length, f.sends.length, f.observations.length], [5, 0, 0]);
  assert.deepEqual(f.acks.map(ack => ack.outcome), Array(5).fill('declined'));
});

test('the spend tier refusing the run sends nothing, not even the owner notice, and is reported as deferred', async t => {
  const f = await fixture(t);
  f.reply = () => { throw Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' }); };
  f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.bridge.state.budgetNotice, f.acks], [0, undefined, [{ id: 'mock-1', outcome: 'deferred:budget' }]]);
  // An ordinary message is still answered.
  f.reply = 'MOCK-REPLY';
  await f.bridge.receive(f.message(200, 41));
  assert.deepEqual(f.sends.map(send => send.message[0].data.text), ['MOCK-REPLY']);
});

test('nothing is fetched unless QQ is connected, logged in as the configured bot and idle; paused, stale or expired requests are dropped unrun', async t => {
  const f = await fixture(t);
  f.offers.push(offer('mock-1'));
  await f.bridge.connection(false); await f.bridge.pollInitiations();
  f.bridge.connected = true; f.bridge.selfId = null; await f.bridge.pollInitiations();
  f.bridge.selfId = '101'; await f.bridge.pollInitiations();
  const settings = f.bridge.settings; f.bridge.settings = null; f.bridge.selfId = '100'; await f.bridge.pollInitiations();
  assert.deepEqual([f.polls, f.offers.length], [0, 1]);
  f.bridge.settings = settings;
  f.world.paused = true; f.world.revision++;
  await f.bridge.pollInitiations();
  f.world.paused = false; f.world.revision++;
  f.epoch = 1; f.offers.push(offer('mock-2')); await f.bridge.pollInitiations(); f.epoch = 0;
  f.offers.push(offer('mock-3', { expiresAt: Date.now() - 1 }), offer('mock-4', { expiresAt: undefined }));
  await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  // The world pauses between the offer and the model call, then during the reply.
  f.reply = () => { f.world.paused = true; f.world.revision++; return 'MOCK'; }; f.offers.push(offer('mock-5'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.acks.map(ack => ack.outcome), ['dropped:paused', 'dropped:epoch', 'dropped:expired', 'dropped:expired', 'dropped:stale']);
  assert.deepEqual([f.runs.length, f.sends.length], [1, 0]);
});

test('the person speaking first wins: with their message ahead in the queue the initiated run is dropped; arriving later, it waits behind', async t => {
  const f = await fixture(t);
  let release; const order = [];
  f.reply = request => { order.push(request.requestId.startsWith('qq:init:') ? 'initiated' : 'message'); return order.length === 1 ? new Promise(resolve => { release = () => resolve('MOCK-REPLY'); }) : 'MOCK-REPLY'; };
  const answering = f.bridge.receive(f.message(200, 51));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.acks, order], [[{ id: 'mock-1', outcome: 'dropped:person_spoke' }], ['message']]);
  release(); await answering;
  // The other way round: the initiated run is in progress when the owner writes.
  order.length = 0; f.offers.push(offer('mock-2'));
  const initiating = f.bridge.pollInitiations();
  await new Promise(resolve => setTimeout(resolve, 20));
  const later = f.bridge.receive(f.message(200, 52));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(order, ['initiated']);
  release(); await Promise.all([initiating, later]);
  assert.deepEqual(order, ['initiated', 'message']);
  assert.deepEqual(f.sends.map(send => send.user_id), ['200', '200', '200']);
  assert.equal(f.acks.at(-1).outcome, 'sent');
});

test('a report Authority could not take is made again on a later round, without running or sending anything again', async t => {
  const f = await fixture(t);
  f.ackError = Object.assign(new Error('TRANSPORT_ERROR'), { code: 'TRANSPORT_ERROR' }); f.offers.push(offer('mock-1'));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.acks.length, f.record('mock-1').reported], [1, 0, undefined]);
  f.ackError = null;
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.runs.length, f.acks], [1, 1, [{ id: 'mock-1', outcome: 'sent' }]]);
  // A report Authority refuses for good (already settled there) is not repeated either.
  f.ackError = Object.assign(new Error('rejected'), { status: 409 }); f.offers.push(offer('mock-2'));
  await f.bridge.pollInitiations();
  f.ackError = null;
  await f.bridge.pollInitiations();
  assert.deepEqual([f.acks.length, f.record('mock-2').reported], [1, true]);
});

test('faces on: an initiated run sends her [微笑] as a face in the same message, like any reply; the record keeps what she wrote', async t => {
  const f = await fixture(t, { faces: true });
  f.reply = 'MOCK 在忙吗[微笑][不存在]';
  f.offers.push(offer('mock-face'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.map(s => s.message), [[{ type: 'text', data: { text: 'MOCK 在忙吗' } }, { type: 'face', data: { id: '14' } }, { type: 'text', data: { text: '[不存在]' } }]]);
  assert.deepEqual(f.observations.map(o => o.text), ['MOCK 在忙吗[微笑][不存在]']);
  assert.equal(f.record('mock-face').status, 'sent');
});

test('an initiated run sends no sticker yet: her [表情:词] is taken out and dropped', async t => {
  const f = await fixture(t);
  f.reply = 'MOCK 早呀[表情:开心]';
  f.offers.push(offer('mock-sticker'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.map(s => s.message), [[{ type: 'text', data: { text: 'MOCK 早呀' } }]]);
  // The dropped marker is observed as not sent, worded as her replayed history words it.
  assert.deepEqual(f.observations.map(o => [o.eventId, o.text]), [['qq:sent:501', 'MOCK 早呀'], ['qq:undelivered:qq:init:mock-sticker', '[表情包：没发出]']]);
  assert.equal(f.record('mock-sticker').status, 'sent');
});

test('faces off (QQ\'s declaration by default): an initiated run sends her [微笑] as plain text, no face segment', async t => {
  const f = await fixture(t);
  f.reply = 'MOCK 在忙吗[微笑]';
  f.offers.push(offer('mock-face-off'));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends.map(s => s.message), [[{ type: 'text', data: { text: 'MOCK 在忙吗[微笑]' } }]]);
  assert.equal(f.record('mock-face-off').status, 'sent');
});

// Reaching out from her wake-up (Authority's event block comes with the request) and the fixed notice to the owner.
const FRIEND_STREAM = 'qq:100:private:201', EVENT = '你想找他，因为：MOCK 想问问近况\n你没有给对方留下具体的事。';

test('a request from her wake-up goes to the owner or a friend with Authority\'s event block as its text, without thinking of its own; never to a stranger or a group', async t => {
  const f = await fixture(t);
  f.offers.push(offer('reach-1', { streamId: FRIEND_STREAM, event: EVENT, light: true }));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.runs.map(run => [run.scope, run.input]), [[{ streamId: FRIEND_STREAM, memoryEpoch: 0 }, { text: EVENT, initiated: true, light: true }]]);
  assert.deepEqual(f.sends, [{ user_id: '201', message: [{ type: 'text', data: { text: 'MOCK 在忙吗？' } }], auto_escape: true }]);
  assert.deepEqual(f.observations.map(o => [o.streamId, o.role, o.text]), [[FRIEND_STREAM, 'assistant', 'MOCK 在忙吗？']]);
  assert.deepEqual(f.acks, [{ id: 'reach-1', outcome: 'sent' }]);
  // She may still say nothing.
  f.reply = DECLINE_MARK; f.offers.push(offer('reach-2', { event: EVENT, light: true }));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.acks.at(-1), f.sends.length, f.runs[1].scope.streamId], [{ id: 'reach-2', outcome: 'declined' }, 1, OWNER_STREAM]);
  // Not a friend, a group, another bot, an event that is no text: never run. Without an event block a friend is still refused.
  const bad = [{ streamId: 'qq:100:private:202', event: EVENT }, { streamId: 'qq:100:group:300', event: EVENT }, { streamId: 'qq:101:private:201', event: EVENT }, { streamId: FRIEND_STREAM, event: '' }, { streamId: FRIEND_STREAM, event: 3 }, { streamId: FRIEND_STREAM, event: 'x'.repeat(4001) }, { streamId: FRIEND_STREAM }];
  for (const [index, extra] of bad.entries()) { f.offers.push(offer('bad-' + index, extra)); await f.bridge.pollInitiations(); }
  assert.deepEqual([f.runs.length, f.sends.length, f.acks.slice(2).map(ack => ack.outcome)], [2, 1, bad.map(() => 'dropped:target')]);
});

test('a fuse notice is a fixed line to the owner: no model, not observed as her words, sent once; anybody else or an unknown notice is refused', async t => {
  const f = await fixture(t);
  f.offers.push({ id: 'notice-1', kind: 'notice', streamId: OWNER_STREAM, memoryEpoch: 0, expiresAt: Date.now() + 300000, notice: 'fuse', text: 'MOCK 不该被发出去的字' });
  await f.bridge.pollInitiations();
  assert.equal(f.sends.length, 1);
  assert.deepEqual([f.sends[0].user_id, f.sends[0].auto_escape], ['200', true]);
  assert.match(f.sends[0].message[0].data.text, /^\[系统提醒\] 主动找人的保险触发了/);
  assert.deepEqual([f.runs.length, f.observations.length, f.acks], [0, 0, [{ id: 'notice-1', outcome: 'sent' }]]);
  f.offers.push({ id: 'notice-1', kind: 'notice', streamId: OWNER_STREAM, memoryEpoch: 0, expiresAt: Date.now() + 300000, notice: 'fuse' });
  await f.bridge.pollInitiations();
  assert.equal(f.sends.length, 1);
  for (const [id, extra] of Object.entries({ 'notice-2': { streamId: FRIEND_STREAM }, 'notice-3': { notice: 'other' }, 'notice-4': { notice: undefined } })) {
    f.offers.push({ id, kind: 'notice', streamId: OWNER_STREAM, memoryEpoch: 0, expiresAt: Date.now() + 300000, notice: 'fuse', ...extra });
    await f.bridge.pollInitiations();
  }
  assert.deepEqual([f.sends.length, f.acks.slice(1).map(ack => ack.outcome)], [1, ['dropped:target', 'dropped:unsupported', 'dropped:unsupported']]);
  // A send without a receipt is unknown and is not tried again.
  f.sendError = () => true;
  f.offers.push({ id: 'notice-5', kind: 'notice', streamId: OWNER_STREAM, memoryEpoch: 0, expiresAt: Date.now() + 300000, notice: 'fuse' });
  await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.acks.at(-1)], [2, { id: 'notice-5', outcome: 'unknown' }]);
});

test('a turn she starts never sends more than four messages: the split stops there, and the fuse behind it stands at the same number', async t => {
  const f = await fixture(t);
  assert.ok(SPLIT_MAX_PARTS <= 4);
  f.reply = Array.from({ length: 9 }, (_, index) => `MOCK 第 ${index + 1} 句话写得稍微长一点好让它单独成为一条消息。`).join('\n');
  f.offers.push(offer('reach-long', { streamId: FRIEND_STREAM, event: EVENT, light: true }));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length <= 4, f.acks.at(-1).outcome], [true, 'sent']);
});
