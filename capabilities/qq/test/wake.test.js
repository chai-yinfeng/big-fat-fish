// Her private wake-up as the QQ bridge runs it: fetched with the other initiated runs, run in her own conversation,
// and only run. Nothing is sent to anyone and nothing is observed, whatever she replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge } from '../bridge.js';
import { PACING } from '../pacing.js';

const QUICK = { pacing: { ...PACING, burstQuietMs: 0, burstMaxWaitMs: 0 }, random: () => 0.5 };
// Bot 100, owner 200, a friend 201.
const OWN = 'qq:self', OWNER_STREAM = 'qq:100:private:200', BRIEFING = '现在是 2027年1月15日 周五 16:00（北京时间）。MOCK-BRIEFING';
const offer = (id, extra = {}) => ({ id, kind: 'wake', streamId: OWN, memoryEpoch: 0, expiresAt: Date.now() + 300000, briefing: BRIEFING, ...extra });
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-wake-')); fs.rmSync(dir, { recursive: true }); });
  const world = { paused: true, revision: 1 }, observations = [], sends = [], acks = [], offers = [], runs = [], polls = [], f = { reply: '<休息>', epoch: 0 };
  const authority = {
    health: async () => ({ world }), admitPerson: async () => ({ admitted: true }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: f.epoch, world }),
    initiationNext: async value => { polls.push(value); return offers.length ? { initiation: offers.shift() } : { initiation: null, reason: 'idle' }; },
    initiationAck: async value => { acks.push(value); return { status: 'recorded' }; },
  };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: 100 };
    if (action === 'get_friend_list') return [{ user_id: 201 }];
    assert.equal(action, 'send_private_msg'); sends.push(args);
    return { message_id: 500 + sends.length };
  } };
  const executor = { execute: async request => { runs.push(request); return typeof f.reply === 'function' ? f.reply(request) : f.reply; }, delivered: async request => { f.delivered = request; } };
  const bridge = new QQBridge({ ...QUICK, authority, port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } }, onebot, executor, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json'), sleep: async () => {} });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  const message = (userId, id) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: userId, sender: { user_id: userId }, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'Hello' } }] });
  return Object.assign(f, { bridge, world, observations, sends, acks, offers, runs, polls, message, record: id => bridge.state.records['qq:init:' + id] });
}

test('a wake-up is only run: her own conversation, the briefing as its text, nothing sent, nothing observed, no delivery report, reported once as done', async t => {
  const f = await fixture(t);
  // Whatever she replies there, nothing leaves: not her words, not a marker, not something that looks like a target.
  for (const [index, reply] of ['<休息>', 'MOCK 想找人聊聊 [CQ:at,qq=201] [表情:开心]', '发给 200：MOCK\n\n第二段'].entries()) {
    f.reply = reply; f.offers.push(offer('wake-' + index));
    await f.bridge.pollInitiations();
  }
  assert.deepEqual(f.runs.map(run => [run.scope, run.requestId, run.input]), [0, 1, 2].map(index => [{ streamId: OWN, memoryEpoch: 0 }, 'qq:init:wake-' + index, { text: BRIEFING, wake: true }]));
  assert.deepEqual([f.sends, f.observations, f.delivered], [[], [], undefined]);
  assert.deepEqual(f.acks, [0, 1, 2].map(index => ({ id: 'wake-' + index, outcome: 'done' })));
  assert.deepEqual([f.record('wake-0').status, f.record('wake-0').reported], ['done', true]);
  // The same request offered again is not run again, and later rounds report nothing more.
  f.offers.push(offer('wake-0')); await f.bridge.pollInitiations(); await f.bridge.pollInitiations();
  assert.deepEqual([f.runs.length, f.acks.length], [3, 3]);
  // No account number or conversation of a person is in what the bridge keeps about it.
  assert.doesNotMatch(JSON.stringify(f.record('wake-1')), /200|201|private/);
});

test('a wake-up names her own conversation and nothing else; one that cannot run is dropped unrun with the reason', async t => {
  const f = await fixture(t);
  const dropped = async (id, extra, before = () => {}) => { before(); f.offers.push(offer(id, extra)); await f.bridge.pollInitiations(); return f.acks.at(-1); };
  // A person's conversation, a missing or oversized briefing, a bad epoch: never run as a wake-up.
  for (const [index, extra] of [{ streamId: OWNER_STREAM }, { streamId: 'qq:100:private:201' }, { streamId: 'qq:self:1' }, { streamId: undefined }, { briefing: undefined }, { briefing: '' }, { briefing: 'x'.repeat(20001) }, { briefing: 3 }, { memoryEpoch: '0' }].entries())
    assert.deepEqual(await dropped('bad-' + index, extra), { id: 'bad-' + index, outcome: 'dropped:target' });
  assert.deepEqual(await dropped('late', { expiresAt: Date.now() - 1 }), { id: 'late', outcome: 'dropped:expired' });
  assert.deepEqual(await dropped('paused', {}, () => { f.world.paused = true; }), { id: 'paused', outcome: 'dropped:paused' });
  f.world.paused = false;
  assert.deepEqual(await dropped('epoch', { memoryEpoch: 3 }), { id: 'epoch', outcome: 'dropped:epoch' });
  assert.deepEqual([f.runs.length, f.sends.length, f.observations.length], [0, 0, 0]);
  // The run itself failing: the spend tier refusing it is deferred (no notice to anyone), anything else failed.
  f.reply = () => { throw Object.assign(new Error('x'), { code: 'BUDGET_EXHAUSTED' }); };
  assert.deepEqual(await dropped('budget'), { id: 'budget', outcome: 'deferred:budget' });
  f.reply = () => { throw Object.assign(new Error('x'), { code: 'WORLD_PAUSED' }); };
  assert.deepEqual(await dropped('paused-late'), { id: 'paused-late', outcome: 'dropped:paused' });
  f.reply = () => { throw new Error('MODEL_UNAVAILABLE'); };
  assert.deepEqual(await dropped('broken'), { id: 'broken', outcome: 'failed' });
  assert.deepEqual([f.runs.length, f.sends.length, f.observations.length], [3, 0, 0]);
});

test('the bridge tells Authority whether it has turns queued or running, so her wake-up waits for people', async t => {
  const f = await fixture(t);
  await f.bridge.pollInitiations();
  assert.deepEqual(f.polls, [{ busy: false }]);
  // A person's turn is running: the poll says so.
  let release;
  f.reply = () => new Promise(resolve => { release = () => resolve('MOCK 在呢'); });
  const turn = f.bridge.receive(f.message(200, 41));
  while (!f.runs.length) await new Promise(resolve => setTimeout(resolve, 1));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.polls.at(-1), { busy: true });
  release(); await turn;
  while (f.bridge.streams.size) await new Promise(resolve => setTimeout(resolve, 1));
  await f.bridge.pollInitiations();
  assert.deepEqual(f.polls.at(-1), { busy: false });
});
