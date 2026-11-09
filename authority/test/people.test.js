import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Authority, MAX_ADMITTED_PEOPLE } from '../src/engine.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';
import { AuthorityClient } from '../src/client.js';

const SELF = '100', OWNER = '200', A = '300', B = '400';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-people-'));
  let now = 1_800_000_000_000;
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: `qq:${SELF}:private:${OWNER}`, personId: 'person:owner', audience: 'private' });
  let seq = 0;
  // A private message from `uid` that the reviewer accepts as a reported fact.
  function tell(uid, key, value) {
    const eventId = `e-${++seq}`;
    const { observationId } = a.observe('qq', { eventId, streamId: `qq:${SELF}:private:${uid}`, actorId: `qq:${SELF}:user:${uid}`, role: 'user', text: value, at: now });
    a.submit('qq', { proposalId: `p-${seq}`, observationId, type: 'fact.report', payload: { key, value, quote: value } });
    assert.equal(a.processPending()[0].status, 'accepted');
    return a.store.db.prepare("SELECT id FROM memory_items WHERE json_extract(body,'$.proposalId')=?").get(`p-${seq}`).id;
  }
  const stream = uid => `qq:${SELF}:private:${uid}`;
  return { a, root, tell, stream };
}

test('admission is deterministic, idempotent, audited, owner-anchored and QQ-only', t => {
  const { a, stream } = fixture(t);
  const first = a.admitPerson('qq', { uid: A });
  assert.deepEqual(first, { personId: `person:qq:${A}`, streamId: stream(A), admitted: true });
  assert.deepEqual(a.admitPerson('qq', { uid: A }), { ...first, admitted: false });
  const snapshot = a.snapshot();
  assert.equal(snapshot.actors.filter(row => row.personId === `person:qq:${A}`).length, 1);
  assert.deepEqual({ ...snapshot.streams.find(row => row.streamId === stream(A)) }, { capabilityId: 'qq', streamId: stream(A), personId: `person:qq:${A}`, audience: 'private', entityId: 'entity:big-fat-fish' });
  assert.equal(snapshot.audit.filter(entry => entry.type === 'person.admit').length, 1);
  // The owner's own number keeps its owner binding.
  assert.equal(a.admitPerson('qq', { uid: OWNER }).personId, 'person:owner');
  assert.throws(() => a.admitPerson('qq', { uid: '0123' }), { code: 'VALIDATION_ERROR' });
  a.registerCapability({ id: 'other', policy: 'conversation.v1' });
  assert.throws(() => a.admitPerson('other', { uid: B }), { code: 'FORBIDDEN' });
  const people = a.listPeople();
  assert.equal(people.admitted, 1);
  assert.ok(people.people.some(p => p.owner && p.personId === 'person:owner'));
  assert.match(people.people.find(p => !p.owner).label, /^p-[0-9a-f]{6}$/);
  assert.deepEqual(a.listConversations().map(c => c.streamId).sort(), [stream(OWNER), stream(A)].sort());
});

test('admission requires the owner binding and stops at the people cap', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-people-'));
  const bare = new Authority({ file: path.join(root, 'w.sqlite') });
  t.after(() => { bare.close(); fs.rmSync(root, { recursive: true, force: true }); });
  bare.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  assert.throws(() => bare.admitPerson('qq', { uid: A }), { code: 'CONFLICT' });
  const { a } = fixture(t);
  for (let i = 0; i < MAX_ADMITTED_PEOPLE; i++) a.admitPerson('qq', { uid: String(1000 + i) });
  assert.equal(MAX_ADMITTED_PEOPLE, 40);
  assert.throws(() => a.admitPerson('qq', { uid: '9999' }), { code: 'PEOPLE_LIMIT' });
  // Already admitted people stay idempotent at the cap.
  assert.equal(a.admitPerson('qq', { uid: '1000' }).admitted, false);
});

test('two private people never see each other’s memory, and the model never sees raw person IDs', t => {
  const { a, tell, stream } = fixture(t);
  a.admitPerson('qq', { uid: A }); a.admitPerson('qq', { uid: B });
  const id = tell(A, '称呼', '叫我阿星');
  tell(OWNER, '饮料', '我喜欢红茶');
  const contextA = a.context('qq', { streamId: stream(A), query: '称呼 阿星' });
  const contextB = a.context('qq', { streamId: stream(B), query: '称呼 阿星' });
  assert.match(contextA.text, /阿星/);
  assert.doesNotMatch(contextB.text, /阿星/);
  assert.equal(a.memorySearch('qq', { streamId: stream(B), query: '阿星' }).items.length, 0);
  assert.equal(a.memoryRead('qq', { streamId: stream(B), id }).item, null);
  // Model-facing text and tool results: opaque labels only.
  const owner = a.context('qq', { streamId: stream(OWNER), query: '红茶 饮料' });
  const read = a.memoryRead('qq', { streamId: stream(A), id });
  const recall = a.memoryRecall('qq', { streamId: stream(OWNER), fromAt: 0, toAt: 2_000_000_000_000 });
  const search = a.memorySearch('qq', { streamId: stream(OWNER), query: '红茶' });
  assert.match(owner.text, /Reported by p-[0-9a-f]{6} /);
  for (const value of [owner.text, contextA.text, JSON.stringify(read), JSON.stringify(recall), JSON.stringify(search)]) {
    assert.doesNotMatch(value, /owner|person:/i);
  }
});

test('forgetting in one private chat retires only that conversation’s sessions', t => {
  const { a, tell, stream } = fixture(t);
  a.admitPerson('qq', { uid: A }); a.admitPerson('qq', { uid: B });
  const id = tell(A, '称呼', '叫我阿星');
  const before = { a: a.context('qq', { streamId: stream(A) }).memoryEpoch, b: a.context('qq', { streamId: stream(B) }).memoryEpoch, entity: a.health().memoryEpoch };
  a.setWorldPaused({ paused: true });
  const preview = a.forgetPreview({ entityId: 'entity:big-fat-fish', ids: [id] });
  assert.equal(preview.epochScope, 'streams');
  assert.deepEqual(preview.affectedStreams, [{ capabilityId: 'qq', streamId: stream(A) }]);
  const job = a.forgetApply({ entityId: 'entity:big-fat-fish', ids: [id], expectedMemoryEpoch: preview.memoryEpoch });
  assert.deepEqual(job.affectedStreams, [{ capabilityId: 'qq', streamId: stream(A), memoryEpoch: before.a + 1 }]);
  assert.equal(job.memoryEpoch, before.a + 1);
  assert.equal(a.health().memoryEpoch, before.entity, 'entity epoch is unchanged');
  assert.equal(a.context('qq', { streamId: stream(A) }).memoryEpoch, before.a + 1);
  assert.equal(a.context('qq', { streamId: stream(B) }).memoryEpoch, before.b, 'B keeps its session');
  assert.equal(a.listConversations().find(c => c.streamId === stream(A)).memoryEpoch, before.a + 1);
  a.cleanupComplete({ id: job.id, memoryEpoch: job.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
  // Content scope follows the stream epoch.
  a.setWorldPaused({ paused: false });
  assert.throws(() => a.contentScope('qq', { streamId: stream(A), memoryEpoch: before.a }), { code: 'CONFLICT' });
  assert.equal(a.contentScope('qq', { streamId: stream(B), memoryEpoch: before.b }).memoryEpoch, before.b);
});

test('forgetting public material still retires every conversation', t => {
  const { a, tell, stream } = fixture(t);
  a.admitPerson('qq', { uid: A });
  const id = tell(A, '爱好', '我喜欢下棋');
  a.markMemoryPublic({ entityId: 'entity:big-fat-fish', id });
  a.setWorldPaused({ paused: true });
  const preview = a.forgetPreview({ entityId: 'entity:big-fat-fish', ids: [id] });
  assert.equal(preview.epochScope, 'entity');
  const job = a.forgetApply({ entityId: 'entity:big-fat-fish', ids: [id], expectedMemoryEpoch: preview.memoryEpoch });
  assert.equal(a.health().memoryEpoch, 1);
  assert.equal(job.affectedStreams.length, 2);
  assert.equal(a.context('qq', { streamId: stream(OWNER) }).memoryEpoch, 1);
});

test('QQ capability admits through the UDS route; operator lists people, conversations and spend', async t => {
  const { a, root } = fixture(t);
  const token = randomBytes(32).toString('hex'), operatorToken = 'operator'.repeat(6);
  const hash = value => createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(root, 'qq.token'), token);
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials: [{ hash: hash(token), role: 'capability', capabilityId: 'qq' }] });
  await app.start(); t.after(() => app.close());
  const client = new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile: path.join(root, 'qq.token') });
  assert.equal((await client.admitPerson({ uid: A })).personId, `person:qq:${A}`);
  await assert.rejects(client.admitPerson({ uid: 'x' }), { code: 'INVALID_REQUEST' });
  const spend = { day: '2026-11-08', spentYuan: 1.2, reservedYuan: 0, capYuan: 5, tier: 'normal' }, posted = [];
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'op.sock'), tokenHash: hash(operatorToken), origins: [],
    modelControl: async (route, body) => {
      if (route === '/model') return { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' };
      if (route === '/spend') return spend;
      if (route === '/spend/settings') { posted.push(body); return { ...spend, capYuan: body.dailyCapYuan }; }
      throw new Error('unexpected');
    },
    qqControl: async route => { assert.equal(route, '/qq/people'); return { friends: 3, admitted: 1 }; } });
  await operator.start(); t.after(() => operator.close());
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, 'op.sock'), path: route, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const people = await call('/people');
  assert.equal(people.status, 200); assert.equal(people.value.admitted, 1); assert.deepEqual(people.value.qq, { friends: 3, admitted: 1 });
  assert.equal((await call('/conversations')).value.length, 2);
  assert.deepEqual((await call('/spend')).value, spend);
  assert.deepEqual((await call('/world')).value.spend, spend);
  assert.equal((await call('/spend/settings', { dailyCapYuan: 2, reducedPercent: 50, restrictedPercent: 70 })).value.capYuan, 2);
  assert.deepEqual(posted, [{ dailyCapYuan: 2, reducedPercent: 50, restrictedPercent: 70 }]);
  assert.equal((await call('/spend/settings', { dailyCapYuan: 2, extra: 1 })).status, 400);
});
