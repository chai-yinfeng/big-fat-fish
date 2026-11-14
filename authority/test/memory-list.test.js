import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';
import { opaquePerson } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
// What the QQ bridge sends to admit a friend: the account and, in QQ's own terms, its actor and conversation.
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-list-'));
  const now = 1_800_000_000_000;
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.registerCapability({ id: 'reader', policy: 'learning.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: `qq:${SELF}:private:${OWNER}`, personId: 'person:owner', audience: 'private' });
  a.bindStream({ capabilityId: 'reader', streamId: 'reader:mock', personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  let seq = 0;
  function propose(capabilityId, observation, type, payload) {
    const { observationId } = a.observe(capabilityId, { eventId: `e-${++seq}`, at: now, ...observation });
    a.submit(capabilityId, { proposalId: `p-${seq}`, observationId, type, payload: { ...payload, quote: observation.text } });
    assert.equal(a.processPending()[0].status, 'accepted');
    return a.store.db.prepare("SELECT id FROM memory_items WHERE json_extract(body,'$.proposalId')=?").get(`p-${seq}`).id;
  }
  // A private message from `uid` that the reviewer accepts as a memory item; returns the item ID.
  const tell = (uid, type, payload, text) => propose('qq', { streamId: `qq:${SELF}:private:${uid}`, actorId: `qq:${SELF}:user:${uid}`, role: 'user', text }, type, payload);
  return { a, root, tell, propose };
}
const label = uid => opaquePerson(`person:qq:${uid}`);

test('listMemory filters by opaque person label and pages past the first 50 without gaps or repeats', t => {
  const { a, tell } = fixture(t);
  const mine = Array.from({ length: 53 }, (_, i) => tell(A, 'fact.report', { key: `MOCK-键${i}`, value: `MOCK-值${i}` }, `MOCK-值${i}`));
  const theirs = [tell(B, 'fact.report', { key: 'MOCK-键', value: 'MOCK-B的值' }, 'MOCK-B的值'), tell(OWNER, 'experience.remember', { summary: 'MOCK-主人的经历' }, 'MOCK-主人的经历')];
  const first = a.listMemory({ person: label(A) });
  assert.deepEqual([first.items.length, first.more], [50, true]);
  const second = a.listMemory({ person: label(A), beforeRevision: first.items.at(-1).revision });
  assert.deepEqual([second.items.length, second.more], [3, false]);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), [...mine].reverse(), 'newest first, every item exactly once');
  assert.ok([...first.items, ...second.items].every(item => item.personLabel === label(A) && item.personIsOwner === false));
  assert.deepEqual(a.listMemory({ person: label(B) }).items.map(item => item.id), [theirs[0]]);
  assert.deepEqual(a.listMemory({ person: opaquePerson('person:owner') }).items.map(item => [item.id, item.personIsOwner]), [[theirs[1], true]]);
  assert.deepEqual([a.listMemory({ person: 'p-000000' }).items, a.listMemory({ person: 'p-000000' }).more], [[], false], 'an unknown label matches nothing');
  // Unfiltered: everything, 50 a page, with the owners available as a filter (labels and counts only).
  const all = a.listMemory();
  assert.deepEqual([all.items.length, all.more, all.unowned], [50, true, 0]);
  assert.deepEqual(all.people, [{ label: opaquePerson('person:owner'), owner: true, items: 1 }, ...[{ label: label(A), owner: false, items: 53 }, { label: label(B), owner: false, items: 1 }].sort((x, y) => x.label < y.label ? -1 : 1)]);
  assert.deepEqual([a.listMemory({ limit: 100 }).items.length, a.listMemory({ limit: 100 }).more], [55, false]);
  for (const bad of [`person:qq:${A}`, A, 'owner', '', 'P-ABCDEF']) assert.throws(() => a.listMemory({ person: bad }), { code: 'VALIDATION_ERROR' }, bad);
  assert.ok(!JSON.stringify(all.people).includes('9999'), 'the filter list carries no account number');
});

test('listMemory marks where each item came from; unowned items and diaries are told apart', t => {
  const { a, tell, propose } = fixture(t);
  const fact = tell(A, 'fact.report', { key: 'MOCK-键', value: 'MOCK-值' }, 'MOCK-值');
  const experience = tell(A, 'experience.remember', { summary: 'MOCK-经历' }, 'MOCK-经历原话');
  const appraisal = tell(A, 'appraisal.record', { kind: 'gratitude' }, 'MOCK-谢谢');
  const note = propose('qq', { streamId: `qq:${SELF}:private:${A}`, actorId: `qq:${SELF}:self`, role: 'assistant', text: 'MOCK-助手说的话' }, 'self.note', { text: 'MOCK-自述', kind: 'outer' });
  const learning = propose('reader', { streamId: 'reader:mock', actorId: 'reader:author', role: 'external', text: 'MOCK-外部资料原文' }, 'learning.note', { text: 'MOCK-学习笔记' });
  a.writePrivateDiary({ entityId: 'entity:big-fat-fish', text: 'MOCK-私密日记' });
  const all = a.listMemory(), byId = Object.fromEntries(all.items.map(item => [item.id, item]));
  assert.deepEqual(byId[fact].source, { channel: 'qq', role: 'user', proposal: 'fact.report' });
  assert.deepEqual(byId[experience].source, { channel: 'qq', role: 'user', proposal: 'experience.remember' });
  assert.deepEqual(byId[appraisal].source, { channel: 'qq', role: 'user', proposal: 'appraisal.record' });
  assert.deepEqual(byId[note].source, { channel: 'qq', role: 'assistant', proposal: 'self.note' });
  assert.deepEqual(byId[learning].source, { channel: 'reader', role: 'external', proposal: 'learning.note' });
  assert.deepEqual([byId[learning].personLabel, byId[learning].personIsOwner, byId[fact].personLabel], [null, false, label(A)]);
  assert.deepEqual([all.unowned, all.diaries.length], [1, 1]);
  const unowned = a.listMemory({ person: 'none' });
  assert.deepEqual([unowned.items.map(item => item.id), unowned.diaries], [[learning], []], 'diaries are listed only without a person filter');
  assert.deepEqual(a.listMemory({ person: label(A) }).diaries, []);
});

test('operator GET /memory passes the person filter and the page cursor through', async t => {
  const { a, root, tell } = fixture(t);
  for (let i = 0; i < 52; i++) tell(A, 'fact.report', { key: `MOCK-键${i}`, value: `MOCK-值${i}` }, `MOCK-值${i}`);
  tell(B, 'fact.report', { key: 'MOCK-键', value: 'MOCK-B的值' }, 'MOCK-B的值');
  const token = 'operator'.repeat(6), socketPath = path.join(root, 'op.sock');
  const operator = createOperatorServer({ authority: a, socketPath, tokenHash: createHash('sha256').update(token).digest('hex'), origins: [] });
  await operator.start(); t.after(() => operator.close());
  const call = route => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'GET', headers: { authorization: `Bearer ${token}` } }, res => { let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end();
  });
  const first = (await call(`/memory?person=${label(A)}&limit=50`)).value;
  assert.deepEqual([first.items.length, first.more, first.items.every(item => item.personLabel === label(A))], [50, true, true]);
  const second = (await call(`/memory?person=${label(A)}&limit=50&beforeRevision=${first.items.at(-1).revision}`)).value;
  assert.deepEqual([second.items.length, second.more], [2, false]);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 52);
  assert.deepEqual((await call(`/memory?person=${label(B)}`)).value.items.map(item => item.value), ['MOCK-B的值']);
  assert.equal((await call('/memory?person=' + encodeURIComponent(`person:qq:${A}`))).status, 400);
});
