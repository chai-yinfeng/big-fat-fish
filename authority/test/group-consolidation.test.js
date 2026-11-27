import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { CONSOLIDATION } from '../src/consolidation.js';
import { groupKey } from '../src/identity.js';
import { opaqueMember, opaquePerson, GROUP_DIGEST_LABEL } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012', STRANGER = '999900000019';
const G1 = `qq:${SELF}:group:999900009001`;
const stream = uid => `qq:${SELF}:private:${uid}`, actor = uid => `qq:${SELF}:user:${uid}`, person = uid => `person:qq:${uid}`;
const admit = uid => ({ uid, actorId: actor(uid), streamId: stream(uid) });
const HOUR = 3600000, DAY = 24 * HOUR;
const label = uid => opaqueMember('qq', G1, actor(uid));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-group-cons-'));
  // 2027-01-15 16:00 in Beijing: outside the nightly hours.
  const clock = { now: 1_800_000_000_000 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: actor(OWNER), personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  a.enableGroup({ capabilityId: 'qq', streamId: G1 });
  a.syncGroupMembers('qq', { streamId: G1, complete: true, members: [{ actorId: actor(OWNER), name: 'MOCK-主人', joinedAt: 1 }, { actorId: actor(A), name: 'MOCK-小明', joinedAt: 1 }, { actorId: actor(B), name: 'MOCK-阿姨', joinedAt: 1 }] });
  a.syncGroupMembers('qq', { streamId: G1, complete: false, members: [{ actorId: actor(STRANGER), name: '' }] });
  let seq = 0;
  const say = (streamId, uid, text, { she = false, at = clock.now } = {}) => a.observe('qq', { eventId: `e-${++seq}`, streamId, actorId: she ? 'qq:model' : actor(uid), role: she ? 'assistant' : 'user', text, at }).observationId;
  /** She answers in `streamId` (which completes the run), then the executor reports that every run so far has left its window. */
  const rollOut = streamId => { const reply = say(streamId, null, 'MOCK-REPLY 嗯', { she: true }); clock.now += 1000; a.context('qq', { streamId, query: 'MOCK', windowFromAt: clock.now }); return reply; };
  const next = () => a.consolidationNext(DEFAULT_ENTITY_ID);
  const commit = input => a.consolidationCommit(DEFAULT_ENTITY_ID, input);
  const digests = () => a.listMemory({ limit: 100 }).items.filter(item => item.kind === 'digest');
  return { a, clock, say, rollOut, next, commit, digests };
}

test('a group\'s dialogue that left the window becomes a group digest and nothing else: bound to the group, speakers as card and label, no feeling, no fact or intent of anybody', t => {
  const { a, say, rollOut, next, commit, digests, clock } = fixture(t);
  const first = say(G1, A, 'MOCK-周末去不去爬山，我家的猫叫MOCK-煤球'), second = say(G1, STRANGER, 'MOCK-我都行'), third = say(G1, A, 'MOCK-大肥鱼你觉得呢');
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' }, 'nothing has left the window yet');
  const reply = rollOut(G1);
  const { task } = next();
  assert.deepEqual([task.scope, task.personaText, task.knownKeys, task.knownIntents, task.lastDigest, task.trigger], [{ kind: 'group' }, '', [], [], '', 'rollout']);
  // Each person's line names its speaker by kept card and member label; a member without a card is 群友. Hers has none.
  assert.deepEqual(task.observations.map(row => [row.ref, row.role, row.speaker, row.text]), [
    ['o1', 'user', `MOCK-小明〔${label(A)}〕`, 'MOCK-周末去不去爬山，我家的猫叫MOCK-煤球'], ['o2', 'user', `群友〔${label(STRANGER)}〕`, 'MOCK-我都行'],
    ['o3', 'user', `MOCK-小明〔${label(A)}〕`, 'MOCK-大肥鱼你觉得呢'], ['o4', 'assistant', undefined, 'MOCK-REPLY 嗯']]);
  // No account number, no person or stream ID leaves Authority.
  for (const hidden of ['99990000', 'person:', 'group:', 'qq:', 'owner', first]) assert.ok(!JSON.stringify(task).includes(hidden), hidden);
  // The model answers with a feeling, a fact and an intent anyway: only the summary is kept, the rest is dropped and counted.
  const summary = `MOCK-群摘要：MOCK-小明〔${label(A)}〕问周末爬山，群友〔${label(STRANGER)}〕说都行，我说可以去。`;
  const result = commit({ taskId: task.taskId, outcome: 'ok', digest: { summary, feeling: 'MOCK-感受：热闹。' }, facts: [{ key: '猫的名字', value: 'MOCK-煤球', quote: '我家的猫叫MOCK-煤球', ref: 'o1' }], intents: [{ text: 'MOCK-问问爬山', quote: 'MOCK-周末去不去爬山', ref: 'o1' }] });
  assert.deepEqual([result.status, result.proposals, result.dropped], ['committed', [], [{ reason: 'group_scope', facts: 1, intents: 1 }]]);
  assert.deepEqual(a.processPending(), []);
  const [digest] = digests();
  assert.deepEqual([digest.personId, digest.scope, digest.visibility, digest.summary, digest.feeling, digest.cardId, digest.derivedFrom, digest.speakers.sort(), digest.streamId, digest.personLabel],
    [groupKey(G1), { kind: 'group' }, 'private', summary, undefined, undefined, [first, second, third, reply], [label(A), label(STRANGER)].sort(), G1, opaquePerson(groupKey(G1))]);
  const stored = a.listMemory({ limit: 100 }).items;
  assert.deepEqual([stored.filter(item => item.type === 'facts').length, stored.filter(item => item.kind === 'intent').length, stored.length], [0, 0, 1]);
  const audit = a.snapshot().audit.findLast(entry => entry.type === 'consolidation.committed');
  assert.deepEqual([audit.digestId, audit.dropped, audit.person], [digest.id, [{ reason: 'group_scope', facts: 1, intents: 1 }], opaquePerson(groupKey(G1))]);
  // Read back: in the group as its continuation, in a member's private conversation by retrieval with their own
  // label, and by nobody who is not a member.
  clock.now += HOUR;
  const far = clock.now;
  assert.deepEqual(a.context('qq', { streamId: G1, query: 'MOCK', windowFromAt: far }).continuationIds, [digest.id]);
  const mine = a.context('qq', { streamId: stream(A), query: 'MOCK-群摘要 爬山', windowFromAt: far });
  assert.ok(mine.memoryText.includes(GROUP_DIGEST_LABEL) && mine.memoryText.includes(`"you":"${label(A)}"`) && mine.continuationIds.length === 0);
  // The next batch of this group gets this digest as `lastDigest`.
  say(G1, B, 'MOCK-阿姨问晚饭吃什么'); rollOut(G1);
  assert.equal(next().task.lastDigest, summary);
});

test('a group digest must name only member labels of its batch; an account-like number or a sensitive word refuses it; a group switched off is not read', t => {
  const { a, clock, say, rollOut, next, commit, digests } = fixture(t);
  say(G1, A, 'MOCK-第一句'); rollOut(G1);
  let { task } = next();
  // A label that is not in the batch (a made-up one, or B who did not speak): an unusable answer, three times skips the batch.
  for (const summary of [`MOCK-摘要：MOCK-阿姨〔${label(B)}〕说了一句。`, 'MOCK-摘要：某人〔m-000000〕说了一句。']) {
    assert.equal(commit({ taskId: task.taskId, outcome: 'ok', digest: { summary } }).status, 'invalid');
    // (A conversation gets two batches a day: the next day for the third try.)
    if (!next().task) clock.now += DAY;
  }
  ({ task } = next());
  assert.equal(commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：m-ffffff 说了一句。' } }).status, 'skipped');
  assert.deepEqual(digests(), []);
  // A member the bridge named in a line (a mention) may be named in the digest though they did not speak.
  clock.now += DAY;
  say(G1, A, `MOCK-第四句 @MOCK-阿姨〔${label(B)}〕 你来吗`); rollOut(G1);
  ({ task } = next());
  assert.equal(commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: `MOCK-摘要：MOCK-小明〔${label(A)}〕问 MOCK-阿姨〔${label(B)}〕 来不来。` } }).status, 'committed');
  assert.deepEqual(digests().map(item => item.speakers.sort()), [[label(A), label(B)].sort()]);
  // (Taken out again, so the checks below start from no digest.)
  a.store.transaction(() => a.store.db.prepare('DELETE FROM memory_items WHERE id=?').run(digests()[0].id));
  // The ordinary guards hold for a group digest: no account-like number, nothing sensitive.
  say(G1, A, 'MOCK-第二句'); rollOut(G1);
  ({ task } = next());
  assert.equal(commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: `MOCK-摘要：MOCK-小明〔${label(A)}〕的号码是 9999000001。` } }).digestRejected, 'unsafe_text');
  assert.deepEqual(digests(), []);
  // Switched off: not picked, and a batch already out can no longer be committed.
  clock.now += DAY;
  say(G1, A, 'MOCK-第三句'); rollOut(G1);
  ({ task } = next());
  a.disableGroup({ capabilityId: 'qq', streamId: G1 });
  assert.throws(() => commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：有人说了一句。' } }), { code: 'CONFLICT' });
  assert.equal(next().task, null);
  assert.ok(!a.consolidationStatus().streams.some(row => row.group));
  a.enableGroup({ capabilityId: 'qq', streamId: G1 });
  assert.deepEqual(a.consolidationStatus().streams.filter(row => row.group).map(row => [row.owner, row.waiting > 0]), [[false, true]]);
  ({ task } = next());
  assert.equal(commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：有人说了一句。' } }).status, 'committed');
  assert.equal(digests().length, 1);
});

test('private conversations are consolidated before any group, and a group spends the same daily batches', t => {
  const { a, say, rollOut, next, commit } = fixture(t);
  say(G1, A, 'MOCK-群里的一句'); rollOut(G1);
  say(stream(A), A, 'MOCK-私聊的一句'); rollOut(stream(A));
  say(stream(B), B, 'MOCK-另一个私聊'); rollOut(stream(B));
  const order = [];
  for (let i = 0; i < 3; i++) { const { task } = next(); order.push(task.scope?.kind ?? 'person'); commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：有人说了一句。' } }); }
  assert.deepEqual(order, ['person', 'person', 'group']);
  // A private conversation that already used a batch today still goes before a group that used none.
  say(stream(A), A, 'MOCK-私聊又一句'); rollOut(stream(A));
  say(G1, B, 'MOCK-群里又一句'); rollOut(G1);
  assert.equal(next().task.scope, undefined);
  // The per-conversation daily limit applies to the group as to anyone.
  const own = a.consolidationState()[DEFAULT_ENTITY_ID];
  assert.equal(own.streams[`qq\u0000${G1}`].calls, 1);
  assert.equal(CONSOLIDATION.perStreamPerDay, 2);
});

test('her private diary is written without group digests; a person\'s open diary and her wake-up cards never held one', t => {
  const { a, clock, say, rollOut, next, commit } = fixture(t);
  say(G1, A, 'MOCK-GROUPWORD 群里说周末爬山'); rollOut(G1);
  let { task } = next();
  commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: `MOCK-GROUPWORD 群摘要：MOCK-小明〔${label(A)}〕说周末爬山。` } });
  say(stream(A), A, 'MOCK-PRIVATEWORD 私聊说想吃面'); rollOut(stream(A));
  ({ task } = next());
  commit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-PRIVATEWORD 私聊摘要：对方说想吃面。', feeling: '' } });
  // The next Beijing morning, after the nightly hours: the diary of the day that ended.
  clock.now += DAY - 10 * HOUR + 30 * 60000;
  const diary = a.diaryNext(DEFAULT_ENTITY_ID);
  assert.ok(diary.task, diary.reason);
  const material = JSON.stringify(diary.task);
  assert.ok(material.includes('PRIVATEWORD') && !material.includes('GROUPWORD') && !material.includes('m-'));
  assert.ok(!JSON.stringify(a.recentDigests(DEFAULT_ENTITY_ID, person(A), 5)).includes('GROUPWORD'));
});
