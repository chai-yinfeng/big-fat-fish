import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge } from '../bridge.js';
import { qqRequestId } from '../worker-route.js';
import { observationFromOneBot } from '../source.js';

async function fixture(t, sendError = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-bridge-')); fs.rmSync(dir, { recursive: true }); });
  const world = { paused: true, revision: 1 }, observations = [], sends = []; let executions = 0;
  const authority = { health: async () => ({ world }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }) };
  const onebot = { call: async (action, args) => { if (action === 'get_login_info') return { user_id: 100 }; sends.push(args); if (sendError) throw new Error('NO_RECEIPT'); return { message_id: 99 }; } };
  const bridge = new QQBridge({ authority, port: { observe: async value => observations.push(value) }, onebot, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json'), inboxFile: path.join(dir, 'inbox.ndjson'), workerConfigFile: path.join(dir, 'worker.json'), workerAuthoritySocket: '/private/authority.sock', workerTokenFile: '/private/token', workerInboxFile: '/private/inbox', executor: { execute: async () => { executions++; return '[CQ:file,file=/secret] just text'; } } });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  const event = { post_type: 'message', message_type: 'private', self_id: 100, user_id: 200, sender: { user_id: 200 }, message_id: 7, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'Hello' } }] };
  return { bridge, world, event, observations, sends, executions: () => executions };
}
test('one private input generates once and only literal final text becomes confirmed QQ output', async t => {
  const f = await fixture(t); await f.bridge.receive(f.event); await f.bridge.receive(f.event);
  assert.equal(f.executions(), 1); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].user_id, '200'); assert.equal(f.sends[0].auto_escape, true); assert.equal(f.sends[0].message[0].type, 'text');
  assert.deepEqual(f.observations.map(o => o.role), ['user', 'assistant']); assert.equal(f.observations[1].eventId, 'qq:sent:99');
});
test('group, other caller, self echoes and paused input do not invoke model or send; resume has no replay', async t => {
  const f = await fixture(t);
  await f.bridge.receive({ ...f.event, message_type: 'group', group_id: 300 });
  await f.bridge.receive({ ...f.event, user_id: 201 });
  await f.bridge.receive({ ...f.event, user_id: 100 });
  f.world.paused = true; f.world.revision++; await f.bridge.receive(f.event);
  f.world.paused = false; f.world.revision++; await f.bridge.receive(f.event);
  assert.equal(f.executions(), 0); assert.equal(f.sends.length, 0); assert.equal(f.observations.length, 0);
});
test('lost send receipt remains unknown, never blindly resends or records a sent experience', async t => {
  const f = await fixture(t, true); await f.bridge.receive(f.event); await f.bridge.receive(f.event);
  const requestId = qqRequestId(observationFromOneBot(f.event, { expectedSelfId: '100' }));
  assert.equal(f.bridge.state.records[requestId].status, 'unknown'); assert.equal(f.sends.length, 1); assert.equal(f.observations.length, 1);
});

test('slow QQ login retries on the same socket once at a time and ignores disconnected probe results', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-identity-')); fs.rmSync(dir, { recursive: true }); });
  let calls = 0, complete;
  const onebot = { call: action => {
    assert.equal(action, 'get_login_info'); calls++;
    if (calls === 1) return Promise.reject(new Error('QQ_STARTING'));
    return new Promise(resolve => { complete = resolve; });
  } };
  const bridge = new QQBridge({ onebot, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json') });
  await bridge.connection(true);
  assert.equal(bridge.connected, true); assert.equal(bridge.selfId, null);
  const connectedAt = bridge.connectedAt;
  const first = bridge.refreshIdentity(), duplicate = bridge.refreshIdentity();
  await Promise.resolve(); assert.equal(calls, 2);
  complete({ user_id: 100 }); await Promise.all([first, duplicate]);
  assert.equal(bridge.selfId, '100'); assert.equal(bridge.connectedAt, connectedAt);
  await bridge.refreshIdentity(); assert.equal(calls, 2);
  await bridge.connection(false);
  const opening = bridge.connection(true);
  await Promise.resolve(); assert.equal(calls, 3);
  await bridge.connection(false);
  complete({ user_id: 100 }); await opening;
  assert.equal(bridge.connected, false); assert.equal(bridge.selfId, null);
});


test('Core forgotten platform input becomes a dedupe tombstone without any SDK or send action', async t => {
  const f = await fixture(t);
  f.bridge.port.observe = async () => ({ forgotten: true });
  await f.bridge.receive(f.event); await f.bridge.receive(f.event);
  assert.equal(f.executions(), 0); assert.equal(f.sends.length, 0);
  assert.equal(Object.values(f.bridge.state.records)[0].status, 'forgotten');
});


test('QQ selects only the Core epoch SID and discards an in-flight reply after forget', async t => {
  const f = await fixture(t); let epoch = 3, executed;
  f.bridge.authority.context = async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: epoch, world: f.world });
  assert.match((await f.bridge.status()).sessionId, /-e3$/);
  f.bridge.executor.execute = async input => { executed = input.sessionId; epoch = 4; return 'stale reply'; };
  await f.bridge.receive(f.event);
  assert.match(executed, /-e3$/);
  assert.equal(f.sends.length, 0);
  assert.equal(Object.values(f.bridge.state.records)[0].status, 'paused');
});
