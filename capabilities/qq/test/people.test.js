import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge, OWNER_BUDGET_NOTICE, beijingDay } from '../bridge.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, { friends = ['300', '400', '500'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-people-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { paused: true, revision: 1 }, sends = [], admitted = [], admissions = [], executions = [];
  let friendCalls = 0, now = Date.parse('2026-11-08T15:30:00Z'), messageId = 0;
  const authority = { health: async () => ({ world }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }), admitPerson: async request => { admissions.push(request); admitted.push(request.uid); return { personId: `person:qq:${request.uid}`, admitted: true }; } };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: 100 };
    if (action === 'get_friend_list') { friendCalls++; return friends.map(user_id => ({ user_id: Number(user_id), nickname: 'n' })); }
    sends.push({ action, ...args }); return { message_id: ++messageId };
  } };
  const executor = { execute: async request => { executions.push(request.scope.streamId); return (executor.reply ?? (async () => 'hi'))(request); } };
  let observed = 0;
  const bridge = new QQBridge({ authority, port: { observe: async () => ({ observationId: 'o-' + ++observed }) }, onebot, executor, clock: () => now,
    settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json') });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  let id = 0;
  const event = (uid, extra = {}) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: Number(uid), message_id: ++id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'hello ' + id } }], ...extra });
  return { bridge, sends, admitted, admissions, executions, executor, event, friendCalls: () => friendCalls, setNow: value => { now = value; }, friends };
}

test('bot friends are admitted and answered in their own conversation; others are ignored silently', async t => {
  const f = await fixture(t);
  await f.bridge.receive(f.event('300'));
  assert.deepEqual(f.admitted, ['300']);
  assert.deepEqual(f.executions, ['qq:100:private:300']);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].user_id, '300');
  await f.bridge.receive(f.event('300'));
  assert.deepEqual(f.admitted, ['300'], 'admission is cached after the first message');
  // Non-friend, temporary session from a friend, group message: no admission, model call or reply.
  await f.bridge.receive(f.event('999'));
  await f.bridge.receive(f.event('400', { sub_type: 'group' }));
  await f.bridge.receive(f.event('400', { message_type: 'group', group_id: 1 }));
  assert.deepEqual(f.admitted, ['300']); assert.equal(f.executions.length, 2); assert.equal(f.sends.length, 2);
  // The owner keeps working without being a listed friend or admitted.
  await f.bridge.receive(f.event('200', { sub_type: undefined }));
  assert.equal(f.sends.at(-1).user_id, '200'); assert.deepEqual(f.admitted, ['300']);
  assert.deepEqual({ ...f.bridge.peopleStatus(), friendsRefreshedAt: null }, { friends: 3, friendsRefreshedAt: null, admitted: 1, active: 0, waiting: 0, conversationsQueued: 0 });
});

test('a friend_add notice refreshes the friend list', async t => {
  const f = await fixture(t, { friends: ['300'] });
  await f.bridge.receive(f.event('600'));
  assert.equal(f.executions.length, 0);
  const calls = f.friendCalls();
  f.friends.push('600');
  await f.bridge.receive({ post_type: 'notice', notice_type: 'friend_add', self_id: 100, user_id: 600, time: 1 });
  await f.bridge.friendProbe;
  assert.equal(f.friendCalls(), calls + 1);
  await f.bridge.receive(f.event('600'));
  assert.deepEqual(f.executions, ['qq:100:private:600']);
});

test('per-conversation queues: one person’s slow reply never blocks another; global concurrency is 2', async t => {
  const f = await fixture(t);
  const gates = { 'qq:100:private:300': deferred(), 'qq:100:private:400': deferred() };
  f.executor.reply = async request => { const gate = gates[request.scope.streamId]; if (gate) await gate.promise; return 'ok'; };
  const slowA = f.bridge.receive(f.event('300'));
  const secondA = f.bridge.receive(f.event('300'));
  await f.bridge.receive(f.event('500'));
  assert.deepEqual(f.sends.map(s => s.user_id), ['500'], 'B finished while A is still generating');
  assert.equal(f.executions.filter(s => s.endsWith(':300')).length, 1, 'A’s second message waits behind its first');
  // Two slow conversations hold both slots; a third conversation waits for a slot.
  const slowB = f.bridge.receive(f.event('400'));
  await new Promise(setImmediate);
  const waiting = f.bridge.receive(f.event('500'));
  await new Promise(setImmediate);
  assert.equal(f.bridge.active, 2); assert.equal(f.bridge.waiting.length, 1);
  assert.equal(f.executions.filter(s => s.endsWith(':500')).length, 1);
  gates['qq:100:private:400'].resolve();
  await slowB; await waiting;
  assert.equal(f.executions.filter(s => s.endsWith(':500')).length, 2);
  gates['qq:100:private:300'].resolve();
  await slowA; await secondA;
  assert.equal(f.bridge.active, 0);
  assert.equal(f.sends.filter(s => s.user_id === '300').length, 2);
});

test('at the daily cap the sender gets silence and the owner is told once per Beijing day', async t => {
  const f = await fixture(t);
  f.executor.reply = async () => { throw Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' }); };
  // 2026-11-08T15:30Z is 23:30 in Beijing.
  await f.bridge.receive(f.event('300'));
  await f.bridge.receive(f.event('400'));
  await f.bridge.receive(f.event('300'));
  await f.bridge.receive(f.event('200', { sub_type: undefined }));
  assert.deepEqual(f.sends.map(s => [s.user_id, s.message[0].data.text]), [['200', OWNER_BUDGET_NOTICE]]);
  assert.ok(Object.values(f.bridge.state.records).every(r => r.status === 'budget_exhausted'));
  assert.equal(f.bridge.state.budgetNotice.day, '2026-11-08');
  // 16:30Z is already 2026-11-09 in Beijing: one more owner notice, still nothing to others.
  f.setNow(Date.parse('2026-11-08T16:30:00Z'));
  await f.bridge.receive(f.event('300'));
  await f.bridge.receive(f.event('400'));
  assert.deepEqual(f.sends.map(s => s.user_id), ['200', '200']);
  assert.equal(beijingDay(Date.parse('2026-11-08T16:30:00Z')), '2026-11-09');
});

test('an admission names the account and, in QQ\'s own terms, the actor and the conversation the message came in', async t => {
  const f = await fixture(t);
  await f.bridge.receive(f.event('300'));
  assert.deepEqual(f.admissions, [{ uid: '300', actorId: 'qq:100:user:300', streamId: 'qq:100:private:300' }]);
});
