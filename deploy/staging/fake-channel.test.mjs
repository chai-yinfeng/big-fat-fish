import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createFakeChannel, actorOf, streamOf, executorEntry } from './fake-channel.mjs';
import { executeConversation, DECLINE_MARK } from '../../capabilities/conversation/executor.js';
import { channel } from '../../capabilities/channels/index.js';

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/fchan-')), controlSocket = path.join(root, 'mock.sock');
  const calls = [], executions = [], state = { paused: false, next: null, reply: 'MOCK-REPLY' };
  const authority = {
    health: async () => ({ world: { paused: state.paused } }),
    admitPerson: async value => { calls.push(['admit', value]); return { admitted: true }; },
    context: async value => { calls.push(['context', value.streamId]); return { memoryEpoch: 4, entityId: 'entity:test' }; },
    observe: async value => { calls.push(['observe', value.role, value.streamId, value.actorId, value.text]); return { observationId: 'o-' + calls.length }; },
    initiationNext: async () => { const initiation = state.next; state.next = null; return { initiation }; },
    initiationAck: async value => { calls.push(['ack', value]); return { status: 'recorded' }; },
  };
  const executor = { execute: async request => { executions.push(request); if (state.reply instanceof Error) throw state.reply; return state.reply; } };
  const fake = createFakeChannel({ authority, executor, executeConversation, declineMark: DECLINE_MARK, controlSocket, pollMs: 60000 });
  await fake.start();
  t.after(async () => { await fake.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const control = (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: controlSocket, method, path: route, agent: false }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const settled = async () => { for (let i = 0; i < 200 && fake.turns.some(turn => turn.status === 'queued'); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const say = async (account, text) => { assert.equal((await control('POST', '/message', { account, text })).status, 200); await settled(); };
  return { fake, control, calls, executions, state, say };
}

test('it is the bridge of the declared test-only channel: not QQ, text only, receipts not reliable', () => {
  const declared = channel('mock');
  assert.deepEqual([declared.testOnly, declared.receipts, declared.friends, Object.values(declared.expression).some(Boolean)], [true, 'unreliable', true, false]);
  assert.ok(new RegExp(declared.account, 'u').test('MOCK-A'));
  assert.deepEqual([actorOf('MOCK-A'), streamOf('MOCK-A')], ['mock:user:MOCK-A', 'mock:private:MOCK-A']);
  // A checkout has no bundled executor: its entry point is the source one.
  assert.ok(executorEntry(path.resolve(import.meta.dirname, '../..')).endsWith('capabilities/conversation/main.mjs'));
});

test('a friend is admitted in the channel\'s own terms and answered through the executor; anyone else is ignored without a trace', async t => {
  const f = await fixture(t);
  await f.control('POST', '/friends', { friends: ['MOCK-A'] });
  await f.say('MOCK-STRANGER', 'MOCK 陌生人');
  assert.deepEqual([f.calls, f.executions, f.fake.turns.map(turn => turn.status)], [[], [], ['ignored']]);
  await f.say('MOCK-A', 'MOCK 你好'); await f.say('MOCK-A', 'MOCK 再说一句');
  assert.deepEqual(f.calls.filter(call => call[0] === 'admit'), [['admit', { uid: 'MOCK-A', actorId: 'mock:user:MOCK-A', streamId: 'mock:private:MOCK-A' }]]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'observe').map(call => call.slice(1)), [['user', 'mock:private:MOCK-A', 'mock:user:MOCK-A', 'MOCK 你好'], ['assistant', 'mock:private:MOCK-A', 'mock:model', 'MOCK-REPLY'], ['user', 'mock:private:MOCK-A', 'mock:user:MOCK-A', 'MOCK 再说一句'], ['assistant', 'mock:private:MOCK-A', 'mock:model', 'MOCK-REPLY']]);
  // The same execution contract as the QQ bridge: scope from Authority, the real message, its observation as evidence.
  const [first] = f.executions;
  assert.deepEqual([first.scope, first.input.text, first.input.evidence.map(item => item.role), Object.keys(first.input).sort()], [{ streamId: 'mock:private:MOCK-A', memoryEpoch: 4 }, 'MOCK 你好', ['user'], ['evidence', 'queryText', 'text']]);
  assert.equal(first.input.evidence[0].eventId, first.requestId);
  const state = (await f.control('GET', '/state')).value;
  assert.deepEqual(state.sent.map(item => [item.account, item.text]), [['MOCK-A', 'MOCK-REPLY'], ['MOCK-A', 'MOCK-REPLY']]);
  // Paused: nothing is observed or run. Malformed control requests are refused.
  f.state.paused = true; await f.say('MOCK-A', 'MOCK 暂停时');
  assert.deepEqual([f.executions.length, f.fake.turns.at(-1).status], [2, 'paused']);
  for (const body of [{ account: 'Alice', text: 'x' }, { account: 'MOCK-A', text: '' }, { account: 'MOCK-A' }]) assert.equal((await f.control('POST', '/message', body)).status, 400);
  assert.equal((await f.control('POST', '/friends', { friends: ['999900000011'] })).status, 400);
});

test('a send without a receipt is unknown: not recorded as hers and never sent again; the next message is answered as usual', async t => {
  const f = await fixture(t);
  await f.control('POST', '/friends', { friends: ['MOCK-A'] });
  await f.control('POST', '/lose-receipts', { count: 1 });
  f.state.reply = 'MOCK-REPLY 丢了'; await f.say('MOCK-A', 'MOCK 第一句');
  f.state.reply = 'MOCK-REPLY 第二句'; await f.say('MOCK-A', 'MOCK 第二句');
  assert.deepEqual(f.fake.turns.map(turn => turn.status), ['unknown', 'sent']);
  assert.deepEqual([f.fake.lost.map(item => item.text), f.fake.sent.map(item => item.text)], [['MOCK-REPLY 丢了'], ['MOCK-REPLY 第二句']]);
  assert.equal(f.executions.length, 2, 'the model was asked once per message');
  assert.deepEqual(f.calls.filter(call => call[0] === 'observe' && call[1] === 'assistant').map(call => call[4]), ['MOCK-REPLY 第二句']);
  await f.control('POST', '/reset', {});
  assert.deepEqual([f.fake.sent.length, f.fake.lost.length], [0, 0]);
});

test('a run she starts herself: only what Authority hands this channel, in the conversation it names, reported once', async t => {
  const f = await fixture(t);
  const hand = async initiation => { f.state.next = initiation; await f.fake.poll(); return f.calls.filter(call => call[0] === 'ack').at(-1)?.[1]; };
  assert.equal(await hand(null), undefined);
  assert.deepEqual(await hand({ id: 'i-1', kind: 'proactive', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2, expiresAt: Date.now() + 60000 }), { id: 'i-1', outcome: 'sent' });
  const run = f.executions.at(-1);
  assert.deepEqual([run.scope, run.requestId, run.input.initiated, Object.keys(run.input).sort()], [{ streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2 }, 'mock:init:i-1', true, ['initiated', 'text']]);
  assert.deepEqual(f.fake.sent.map(item => item.account), ['MOCK-OWNER']);
  // The same request again does nothing; a conversation of another channel or another kind of run is not run.
  f.state.next = { id: 'i-1', kind: 'proactive', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2 }; await f.fake.poll();
  assert.equal(f.executions.length, 1);
  assert.deepEqual(await hand({ id: 'i-2', kind: 'proactive', streamId: 'qq:999900000001:private:999900000002', memoryEpoch: 0 }), { id: 'i-2', outcome: 'dropped:target' });
  assert.deepEqual(await hand({ id: 'i-3', kind: 'completion', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2, jobRef: 'job:x' }), { id: 'i-3', outcome: 'dropped:unsupported' });
  assert.equal(f.executions.length, 1);
  // She declines, the receipt is lost, the spend tier refuses: each reported as what it was, nothing repeated.
  f.state.reply = '<不说>';
  assert.deepEqual(await hand({ id: 'i-4', kind: 'proactive', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2 }), { id: 'i-4', outcome: 'declined' });
  f.state.reply = 'MOCK-INIT'; await f.control('POST', '/lose-receipts', { count: 1 });
  assert.deepEqual(await hand({ id: 'i-5', kind: 'proactive', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2 }), { id: 'i-5', outcome: 'unknown' });
  f.state.reply = Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' });
  assert.deepEqual(await hand({ id: 'i-6', kind: 'proactive', streamId: 'mock:private:MOCK-OWNER', memoryEpoch: 2 }), { id: 'i-6', outcome: 'deferred:budget' });
  assert.deepEqual([f.fake.sent.length, f.fake.lost.length], [1, 1]);
});
