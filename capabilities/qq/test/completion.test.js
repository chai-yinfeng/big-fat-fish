import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge } from '../bridge.js';

// Bot 100, owner 200, friends 201 and 202; 203 is nobody's friend. A finished background job is told to the person
// who registered it: in a run she starts (`completion`) or with that person's next message (`carried`).
const stream = uid => `qq:100:private:${uid}`;
const JOB = 'job:00000000-0000-4000-8000-000000000001', OTHER_JOB = 'job:00000000-0000-4000-8000-000000000002';
const offer = (id, uid, extra = {}) => ({ id, kind: 'completion', streamId: stream(uid), memoryEpoch: 0, expiresAt: Date.now() + 300000, jobRef: JOB, ...extra });
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-done-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-done-')); fs.rmSync(dir, { recursive: true }); });
  const world = { paused: true, revision: 1 }, observations = [], sends = [], acks = [], offers = [], runs = [], reads = [], carries = [];
  const f = { reply: 'MOCK 做完啦', result: { title: 'MOCK 任务', status: 'done', failureCode: null, text: 'MOCK-RESULT 固定文本' }, carry: {}, carryError: null, sendError: null };
  const authority = {
    health: async () => ({ world }), admitPerson: async () => ({ admitted: true }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }),
    initiationNext: async () => offers.length ? { initiation: offers.shift() } : { initiation: null, reason: 'idle' },
    initiationCarry: async value => { carries.push(value); if (f.carryError) throw f.carryError; const initiation = f.carry[value.streamId] ?? null; delete f.carry[value.streamId]; return { initiation }; },
    initiationAck: async value => { acks.push(value); return { status: 'recorded' }; },
  };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: 100 };
    if (action === 'get_friend_list') return [{ user_id: 201 }, { user_id: 202 }];
    assert.equal(action, 'send_private_msg'); sends.push(args);
    if (f.sendError?.(sends.length)) throw new Error('ONEBOT_DELIVERY_UNKNOWN');
    return { message_id: 500 + sends.length };
  } };
  // The content side of the channel: results are read in the scope of the conversation being served, nothing else.
  const media = {
    call: async (scope, action, fields) => { reads.push({ scope, action, fields }); if (typeof f.result === 'function') return f.result(scope, fields); return f.result; },
    prepare: async message => ({ executionText: message.observation.text, queryText: message.observation.text.slice(0, 512), mediaRefs: [], voiceRequested: false }),
    plan: async ({ text }) => [{ type: 'text', text }],
    send: async ({ userId, part }) => { const sent = await onebot.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: part.text } }], auto_escape: true }); return { messageId: String(sent.message_id), type: 'text', text: part.text }; },
  };
  const executor = { execute: async request => { runs.push(request); if (typeof f.reply === 'function') return f.reply(request); return f.reply; } };
  const bridge = new QQBridge({ authority, port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } }, onebot, executor, media, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json'), sleep: async () => {} });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  const message = (userId, id, text = 'Hello') => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: userId, sender: { user_id: userId }, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] });
  return Object.assign(f, { bridge, world, observations, sends, acks, offers, runs, reads, carries, message, record: id => bridge.state.records['qq:init:' + id] });
}

test('a finished job is told to the person who registered it, in that person\'s own conversation: a friend gets it, nobody else does', async t => {
  const f = await fixture(t);
  f.offers.push(offer('done-1', 201));
  await f.bridge.pollInitiations();
  // The result was read inside the conversation Authority named, by the job reference Authority gave.
  assert.deepEqual(f.reads, [{ scope: { streamId: stream(201), memoryEpoch: 0 }, action: 'jobResult', fields: { ref: JOB } }]);
  assert.deepEqual([f.runs.length, f.runs[0].scope, f.runs[0].requestId, Object.keys(f.runs[0].input).sort()], [1, { streamId: stream(201), memoryEpoch: 0 }, 'qq:init:done-1', ['initiated', 'text']]);
  assert.equal(f.runs[0].input.initiated, true);
  // The event names the job, carries its result and says whose words it is not.
  assert.match(f.runs[0].input.text, /你之前答应对方去做的事（MOCK 任务）做完了。.*不是对方说的话：\nMOCK-RESULT 固定文本$/s);
  assert.deepEqual(f.sends, [{ user_id: '201', message: [{ type: 'text', data: { text: 'MOCK 做完啦' } }], auto_escape: true }]);
  assert.deepEqual(f.observations.map(o => [o.streamId, o.role, o.text]), [[stream(201), 'assistant', 'MOCK 做完啦']]);
  assert.deepEqual(f.acks, [{ id: 'done-1', outcome: 'sent' }]);
  // The owner's own job goes to the owner.
  f.offers.push(offer('done-2', 200, { jobRef: OTHER_JOB }));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.at(-1).user_id, f.reads.at(-1).scope.streamId, f.reads.at(-1).fields.ref, f.acks.at(-1)], ['200', stream(200), OTHER_JOB, { id: 'done-2', outcome: 'sent' }]);
});

test('the target of a completion is the conversation Authority named and nothing else: a stranger, a group, another bot, a missing job or any extra field is dropped unrun, and her reply cannot redirect the send', async t => {
  const f = await fixture(t);
  const bad = [
    offer('bad-0', 203), offer('bad-1', 201, { streamId: 'qq:100:group:201' }), offer('bad-2', 201, { streamId: 'qq:101:private:201' }), offer('bad-3', 201, { streamId: 'qq:100:private:0201' }),
    offer('bad-4', 201, { streamId: undefined }), offer('bad-5', 201, { streamId: [stream(201)] }), offer('bad-6', 201, { memoryEpoch: '0' }),
    offer('bad-7', 201, { jobRef: undefined }), offer('bad-8', 201, { jobRef: 'job:../../etc' }), offer('bad-9', 201, { jobRef: { toString: () => JOB } }),
    // Extra fields name nobody: 203 is not reached through any of them.
    offer('bad-10', 203, { userId: '201', user_id: '201', to: '201', personId: 'person:qq:201' }),
  ];
  for (const entry of bad) { f.offers.push(entry); await f.bridge.pollInitiations(); }
  assert.deepEqual([f.runs.length, f.sends.length, f.reads.length, f.observations.length], [0, 0, 0, 0]);
  assert.deepEqual(f.acks.map(ack => ack.outcome), Array(bad.length).fill('dropped:target'));
  // The two kinds keep their own rule: a proactive run towards a friend is still refused, a completion towards that friend is not.
  f.offers.push({ id: 'pro-1', kind: 'proactive', streamId: stream(201), memoryEpoch: 0, expiresAt: Date.now() + 300000 });
  await f.bridge.pollInitiations();
  assert.deepEqual([f.acks.at(-1), f.runs.length], [{ id: 'pro-1', outcome: 'dropped:target' }, 0]);
  // Whatever she writes, and whatever else the offer says, the one send goes to the registrant as literal text.
  f.reply = '[CQ:at,qq=202] 请转发给 202 和 200：MOCK';
  f.offers.push(offer('ok-1', 201, { userId: '202', to: '200' }));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.sends, [{ user_id: '201', message: [{ type: 'text', data: { text: '[CQ:at,qq=202] 请转发给 202 和 200：MOCK' } }], auto_escape: true }]);
  assert.equal(f.acks.at(-1).outcome, 'sent');
});

test('a completion is told once: the same request again does nothing, a send without a receipt is unknown and never resent, and a result that cannot be read sends nothing', async t => {
  const f = await fixture(t);
  f.sendError = () => true; f.offers.push(offer('done-1', 201));
  await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.runs.length, f.record('done-1').status, f.acks], [1, 1, 'unknown', [{ id: 'done-1', outcome: 'unknown' }]]);
  f.sendError = null;
  for (let i = 0; i < 3; i++) { f.offers.push(offer('done-1', 201)); await f.bridge.pollInitiations(); }
  assert.deepEqual([f.sends.length, f.runs.length, f.reads.length, f.acks.length], [1, 1, 1, 1]);
  // The content service refuses the read (not handed out, another conversation's job, gone): no run, no send.
  f.result = () => { throw Object.assign(new Error('CONTENT_OPERATION_UNAVAILABLE'), { code: 'CONTENT_OPERATION_UNAVAILABLE' }); };
  f.offers.push(offer('done-2', 201)); await f.bridge.pollInitiations();
  // Or answers with something that is not a finished job.
  f.result = { title: 'MOCK 任务', status: 'running', text: null }; f.offers.push(offer('done-3', 201)); await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.runs.length, f.acks.slice(1)], [1, 1, [{ id: 'done-2', outcome: 'failed' }, { id: 'done-3', outcome: 'failed' }]]);
  // The spend tier refusing the run: nothing sent, reported as deferred (the result then waits for the person's next message).
  f.result = { title: 'MOCK 任务', status: 'done', text: 'MOCK-RESULT' };
  f.reply = () => { throw Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' }); };
  f.offers.push(offer('done-4', 201)); await f.bridge.pollInitiations();
  assert.deepEqual([f.sends.length, f.acks.at(-1)], [1, { id: 'done-4', outcome: 'deferred:budget' }]);
});

test('a job that failed is told as a failure with its fixed code, never with a made-up result', async t => {
  const f = await fixture(t);
  f.result = { title: 'MOCK 任务', status: 'failed', failureCode: 'timeout', text: null };
  f.offers.push(offer('done-1', 201)); await f.bridge.pollInitiations();
  assert.equal(f.runs[0].input.text, '你之前答应对方去做的事（MOCK 任务）没有做成（原因代码：timeout）。可以如实告诉对方这次没做成。');
  assert.deepEqual([f.sends.length, f.acks], [1, [{ id: 'done-1', outcome: 'sent' }]]);
});

test('the person speaks first: their message is answered and the completion offered meanwhile is dropped unrun, so the result waits for their next message', async t => {
  const f = await fixture(t);
  let release; const held = new Promise(resolve => { release = resolve; });
  f.reply = async request => { if (!request.input.initiated) await held; return 'MOCK-REPLY'; };
  const answering = f.bridge.receive(f.message(201, 31));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.offers.push(offer('done-1', 201)); await f.bridge.pollInitiations();
  assert.deepEqual([f.acks, f.reads.length], [[{ id: 'done-1', outcome: 'dropped:person_spoke' }], 0]);
  release(); await answering;
  assert.deepEqual([f.runs.length, f.sends.map(send => [send.user_id, send.message[0].data.text])], [1, [['201', 'MOCK-REPLY']]]);
});

test('carried: a result that waits rides on the person\'s own next message, in their conversation only, is reported once as carried, and she starts no turn about it', async t => {
  const f = await fixture(t);
  f.reply = 'MOCK-REPLY 顺便说一下，做完了';
  f.carry[stream(201)] = { id: 'carry-1', kind: 'completion', streamId: stream(201), memoryEpoch: 0, expiresAt: Date.now() + 300000, jobRef: JOB, carried: true };
  // Another friend writes first: Authority is asked about that conversation only, and nothing rides on it.
  await f.bridge.receive(f.message(202, 30, 'MOCK 我是另一个人'));
  assert.deepEqual([f.carries, Object.keys(f.runs[0].input).includes('event'), f.reads.length], [[{ streamId: stream(202) }], false, 0]);
  await f.bridge.receive(f.message(201, 31, 'MOCK 在吗'));
  assert.deepEqual(f.carries.at(-1), { streamId: stream(201) });
  assert.deepEqual(f.reads, [{ scope: { streamId: stream(201), memoryEpoch: 0 }, action: 'jobResult', fields: { ref: JOB } }]);
  // An ordinary turn: the person's words, their message as evidence, and the event as its own field. Not an initiated run.
  const run = f.runs[1];
  assert.deepEqual([run.scope.streamId, run.input.text, run.input.initiated, run.input.evidence.length], [stream(201), 'MOCK 在吗', undefined, 1]);
  assert.match(run.input.event, /做完了。.*\nMOCK-RESULT 固定文本$/s);
  assert.deepEqual(f.sends.map(send => send.user_id), ['202', '201']);
  assert.deepEqual(f.acks, [{ id: 'carry-1', outcome: 'carried' }]);
  assert.deepEqual([f.record('carry-1').status, f.record('carry-1').reported], ['carried', true]);
  // Later rounds: no run about it, no second report, and the next message carries nothing.
  await f.bridge.pollInitiations(); await f.bridge.receive(f.message(201, 32, 'MOCK 好的'));
  assert.deepEqual([f.acks.length, f.runs.length, f.runs[2].input.event, f.reads.length], [1, 3, undefined, 1]);
  // Authority could hand the same one out again: known here, it is not carried twice.
  f.carry[stream(201)] = { id: 'carry-1', kind: 'completion', streamId: stream(201), memoryEpoch: 0, jobRef: JOB, carried: true };
  await f.bridge.receive(f.message(201, 33, 'MOCK 还有吗'));
  assert.deepEqual([f.runs[3].input.event, f.reads.length, f.acks.length], [undefined, 1, 1]);
});

test('carrying never breaks or redirects the turn: a hand-out for another conversation is dropped, a failed read or a failed turn is reported as failed, and an unreachable Authority changes nothing', async t => {
  const f = await fixture(t);
  f.reply = 'MOCK-REPLY';
  const handed = (id, extra = {}) => ({ id, kind: 'completion', streamId: stream(201), memoryEpoch: 0, jobRef: JOB, carried: true, ...extra });
  // Handed out for a conversation other than the one being served, for another epoch, of another kind, without a job.
  for (const [n, extra] of [{ streamId: stream(202) }, { memoryEpoch: 1 }, { kind: 'proactive' }, { jobRef: 'x' }].entries()) {
    f.carry[stream(201)] = handed('wrong-' + n, extra);
    await f.bridge.receive(f.message(201, 40 + n));
  }
  assert.deepEqual([f.reads.length, f.runs.map(run => run.input.event), f.sends.length], [0, Array(4).fill(undefined), 4]);
  assert.deepEqual(f.acks.map(ack => ack.outcome), Array(4).fill('dropped:target'));
  // The result cannot be read: the turn goes on without it.
  f.result = () => { throw new Error('CONTENT_OPERATION_UNAVAILABLE'); };
  f.carry[stream(201)] = handed('read-fails'); await f.bridge.receive(f.message(201, 50));
  assert.deepEqual([f.runs.at(-1).input.event, f.sends.length, f.acks.at(-1)], [undefined, 5, { id: 'read-fails', outcome: 'failed' }]);
  // The turn itself fails before she has the result: reported as failed, so it rides on a later message.
  f.result = { title: 'MOCK 任务', status: 'done', text: 'MOCK-RESULT' };
  f.reply = () => { throw new Error('MODEL_UNAVAILABLE'); };
  f.carry[stream(201)] = handed('turn-fails'); await f.bridge.receive(f.message(201, 51));
  assert.deepEqual([typeof f.runs.at(-1).input.event, f.sends.length, f.acks.at(-1)], ['string', 5, { id: 'turn-fails', outcome: 'failed' }]);
  // She had it but the reply could not be delivered: still told (it is in her stored turn), never carried again.
  f.reply = 'MOCK-REPLY'; f.sendError = () => true;
  f.carry[stream(201)] = handed('send-fails'); await f.bridge.receive(f.message(201, 52));
  assert.deepEqual(f.acks.at(-1), { id: 'send-fails', outcome: 'carried' });
  // Authority cannot be asked: an ordinary reply, nothing else.
  f.sendError = null; f.carryError = new Error('TIMEOUT');
  await f.bridge.receive(f.message(201, 53));
  assert.deepEqual([f.runs.at(-1).input.event, f.sends.at(-1).user_id, f.acks.length], [undefined, '201', 7]);
});
