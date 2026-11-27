import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';
import { groupKey } from '../src/identity.js';

// Visibly fake accounts.
const SELF = '999900000001', OWNER = '999900000002', G1 = '999900009001', G2 = '999900009002', G3 = '999900009003';
const stream = gid => `qq:${SELF}:group:${gid}`;

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-groups-')), token = 'operator'.repeat(6);
  const authority = new Authority({ file: path.join(dir, 'world.sqlite') });
  authority.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'qq', streamId: `qq:${SELF}:private:${OWNER}`, personId: 'person:owner', audience: 'private' });
  // The bridge's control socket: where she is, who else is there, and how often it was told to read its list again.
  const bridge = { selfId: SELF, down: false, refreshed: 0, asked: [], groups: { [G1]: { name: 'MOCK-家人群', memberCount: 5, owner: true }, [G2]: { name: 'MOCK-大群', memberCount: 320, owner: true }, [G3]: { name: 'MOCK-没有主人的群', memberCount: 8, owner: false } } };
  const qqControl = async (route, body) => {
    bridge.asked.push(route);
    if (bridge.down) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
    if (route === '/qq/identity') return { expectedSelfId: bridge.selfId };
    if (route === '/qq/groups') return { selfId: bridge.selfId, groups: Object.entries(bridge.groups).map(([groupId, row]) => ({ groupId, name: row.name, memberCount: row.memberCount, listening: false })) };
    if (route === '/qq/groups/check') { const row = bridge.groups[body.groupId]; return { selfId: bridge.selfId, inGroup: Boolean(row), ownerInGroup: Boolean(row?.owner), memberCount: row?.memberCount ?? null, maxMembers: 100 }; }
    if (route === '/qq/groups/refresh') { bridge.refreshed++; return { listening: 0 }; }
    throw new Error('unexpected route ' + route);
  };
  const server = createOperatorServer({ authority, socketPath: path.join(dir, 'op.sock'), tokenHash: createHash('sha256').update(token).digest('hex'), origins: [], qqControl });
  await server.start();
  t.after(async () => { await server.close(); authority.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, 'op.sock'), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { authority, bridge, call };
}

test('the operator\'s group list: every group her account is in, with Authority\'s switch and counts; enabling binds the group and tells the bridge; disabling keeps everything', async t => {
  const { authority, bridge, call } = await fixture(t);
  const first = await call('/groups');
  assert.deepEqual([first.status, first.value.available, first.value.settings], [200, true, { callNames: [] }]);
  assert.deepEqual(first.value.groups.map(row => [row.groupId, row.name, row.memberCount, row.present, row.state, row.members, row.digests]), [[G1, 'MOCK-家人群', 5, true, 'none', 0, 0], [G2, 'MOCK-大群', 320, true, 'none', 0, 0], [G3, 'MOCK-没有主人的群', 8, true, 'none', 0, 0]]);
  // Enabling needs no pause (the world is running here), binds the conversation to its own scope key and tells the bridge.
  const enabled = await call('/groups/enable', { capabilityId: 'qq', groupId: G1 });
  assert.deepEqual([enabled.status, enabled.value.groups.find(row => row.groupId === G1).state, bridge.refreshed], [200, 'enabled', 1]);
  assert.deepEqual({ ...authority.snapshot().streams.find(row => row.streamId === stream(G1)) }, { capabilityId: 'qq', streamId: stream(G1), personId: groupKey(stream(G1)), audience: 'shared', entityId: 'entity:big-fat-fish' });
  assert.equal((await call('/groups/enable', { capabilityId: 'qq', groupId: G1 })).status, 200, 'again changes nothing');
  assert.equal(authority.snapshot().audit.filter(entry => entry.type === 'group.enable').length, 1);
  // The conversation list marks it as a group; it is nobody's.
  const listed = (await call('/conversations')).value.find(row => row.streamId === stream(G1));
  assert.deepEqual([listed.group, listed.enabled, listed.owner], [true, true, false]);
  // Counts come from Authority once there is something.
  authority.syncGroupMembers('qq', { streamId: stream(G1), complete: true, members: [{ actorId: `qq:${SELF}:user:${OWNER}`, name: 'MOCK-主人' }] });
  authority.observe('qq', { eventId: 'e-1', streamId: stream(G1), actorId: `qq:${SELF}:user:${OWNER}`, role: 'user', text: 'MOCK-群里一句', at: 5 });
  authority.observe('qq', { eventId: 'e-2', streamId: stream(G1), actorId: 'qq:model', role: 'assistant', text: 'MOCK-回复', at: 7 });
  assert.deepEqual((await call('/groups')).value.groups.filter(row => row.groupId === G1).map(row => [row.members, row.messages, row.lastReplyAt]), [[1, 2, 7]]);
  const disabled = await call('/groups/disable', { capabilityId: 'qq', groupId: G1 });
  assert.deepEqual([disabled.status, disabled.value.groups.find(row => row.groupId === G1).state, disabled.value.groups.find(row => row.groupId === G1).messages, bridge.refreshed], [200, 'disabled', 2, 3]);
  // A group that was never enabled cannot be disabled: the page is out of date.
  assert.deepEqual([(await call('/groups/disable', { capabilityId: 'qq', groupId: G3 })).status], [409]);
  // She left a group Authority still holds: listed without a name, as not present.
  await call('/groups/enable', { capabilityId: 'qq', groupId: G1 });
  delete bridge.groups[G1];
  assert.deepEqual((await call('/groups')).value.groups.filter(row => row.groupId === G1).map(row => [row.name, row.present, row.current, row.state]), [['', false, true, 'enabled']]);
  // The bridge cannot be asked: Authority's own rows still show, and nothing can be enabled.
  bridge.down = true;
  const offline = await call('/groups');
  assert.deepEqual([offline.status, offline.value.available, offline.value.groups.map(row => [row.groupId, row.present, row.state])], [200, false, [[G1, false, 'enabled']]]);
  assert.equal((await call('/groups/enable', { capabilityId: 'qq', groupId: G3 })).status, 503);
});

test('enabling a group is refused, with the condition that failed, unless she is in it, the owner is in it and it is small enough', async t => {
  const { authority, bridge, call } = await fixture(t);
  const refused = async (groupId, reason) => { const answer = await call('/groups/enable', { capabilityId: 'qq', groupId }); assert.deepEqual([answer.status, answer.error.code, answer.error.reason], [409, 'CONFLICT', reason], reason); };
  await refused('999900009099', 'not_in_group');
  await refused(G3, 'owner_absent');
  await refused(G2, 'too_large');
  bridge.groups[G3] = { name: 'MOCK', memberCount: null, owner: true };
  await refused(G3, 'too_large');
  bridge.selfId = null;
  await refused(G1, 'not_logged_in');
  assert.deepEqual([authority.listGroups(), authority.snapshot().streams.filter(row => row.audience === 'shared'), bridge.refreshed], [[], [], 0]);
  for (const body of [{ capabilityId: 'mock', groupId: G1 }, { capabilityId: 'qq', groupId: '0123' }, { capabilityId: 'qq', groupId: Number(G1) }, { capabilityId: 'qq' }, { capabilityId: 'qq', groupId: G1, streamId: 'qq:1:private:2' }]) assert.equal((await call('/groups/enable', body)).status, 400, JSON.stringify(body));
});

test('the other names she answers to in a group: saved, told to the bridge, and refused with the rule that was broken', async t => {
  const { authority, bridge, call } = await fixture(t);
  const saved = await call('/groups/settings', { callNames: ['小鱼', ' 肥鱼 '] });
  assert.deepEqual([saved.status, saved.value.settings, bridge.refreshed], [200, { callNames: ['小鱼', '肥鱼'] }, 1]);
  for (const [callNames, rule] of [[['鱼'], 'minChars'], [['一二三四五六七八九十十一十二'], 'maxChars'], [Array.from({ length: 9 }, (_, i) => `MOCK名${i}`), 'maxItems'], ['小鱼', 'invalid']]) {
    const answer = await call('/groups/settings', { callNames });
    assert.deepEqual([answer.status, answer.error.code, answer.error.field, answer.error.rule], [400, 'VALIDATION_ERROR', 'callNames', rule]);
  }
  assert.equal((await call('/groups/settings', { callNames: ['小鱼'], perGroupTurnsPerDay: 5 })).status, 400);
  assert.deepEqual(authority.groupSettings(), { callNames: ['小鱼', '肥鱼'] });
});
