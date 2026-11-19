import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { AuthorityClient } from '../src/client.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';
import { CONSOLIDATION } from '../src/consolidation.js';
import { DIARY } from '../src/diary.js';
import { DEFAULT_CARD_ID } from '../src/cards.js';
import { opaquePerson } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const HOUR = 3600000, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => `person:qq:${uid}`;
// Beijing days: day 0 is 2027-01-15; `at(day, hour)` is that hour of that Beijing day.
const DAY0 = 1_800_000_000_000 - 16 * HOUR, at = (day, hour = 12) => DAY0 + day * DAY + hour * HOUR;
const dayName = day => new Date(at(day, 12) + 8 * HOUR).toISOString().slice(0, 10);
const REASON = 'MOCK-原因';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-diary-')), file = path.join(root, 'world.sqlite');
  const clock = { now: at(0, 16) };
  const a = new Authority({ file, clock: () => clock.now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  let seq = 0;
  const say = (uid, text, { she = false } = {}) => a.observe('qq', { eventId: `e-${++seq}`, streamId: stream(uid), actorId: she ? 'qq:model' : `qq:${SELF}:user:${uid}`, role: she ? 'assistant' : 'user', text, at: clock.now }).observationId;
  /** One exchange with `uid` now, rolled out of the window and consolidated into a digest. Returns the ID of the person's line. */
  const chat = (uid, text, summary, { feeling = '', facts = [] } = {}) => {
    const line = say(uid, text); say(uid, 'MOCK-REPLY 嗯', { she: true }); clock.now += 1000;
    a.context('qq', { streamId: stream(uid), query: 'MOCK', windowFromAt: clock.now });
    const { task } = a.consolidationNext(DEFAULT_ENTITY_ID);
    assert.equal(a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', digest: { summary, feeling }, facts: facts.map(fact => ({ ...fact, ref: 'o1' })) }).status, 'committed');
    a.processPending();
    return line;
  };
  const next = () => a.diaryNext(DEFAULT_ENTITY_ID);
  const commit = input => a.diaryCommit(DEFAULT_ENTITY_ID, input);
  /** The diary of the day now due, written from every source given. Returns the task and the commit's result. */
  const write = privateText => {
    const { task } = next();
    assert.ok(task, 'a diary is due');
    return { task, result: commit({ taskId: task.taskId, outcome: 'ok', private: { text: privateText }, usedIds: [...task.digests, ...task.notes].map(row => row.ref) }) };
  };
  const diaries = () => a.listMemory({ limit: 100 }).diaries.filter(diary => diary.v === 2);
  const digests = uid => a.listMemory({ limit: 100 }).items.filter(item => item.kind === 'digest' && item.personId === person(uid));
  const state = () => a.consolidationState()[DEFAULT_ENTITY_ID];
  return { a, file, clock, say, chat, next, commit, write, diaries, digests, state };
}

test('one private diary for the day that ended (no open one), from opaque labels; asking again makes no second request; the old private task is not involved', t => {
  const { a, clock, chat, next, commit, diaries, state } = fixture(t);
  const lineA = chat(A, '我周末去了MOCK-海边', 'MOCK-摘要甲：对方说周末去了海边。', { feeling: 'MOCK-感受甲' });
  chat(B, '我在学MOCK-大提琴', 'MOCK-摘要乙：对方说在学大提琴。');
  // The day has not ended; and after midnight nothing is written before 03:00.
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  clock.now = at(1, 2.5);
  assert.equal(next().task, null);
  clock.now = at(1, 3.5);
  const { task } = next();
  assert.deepEqual(Object.keys(task).sort(), ['day', 'digests', 'notes', 'own', 'personaText', 'previous', 'taskId']);
  assert.equal(task.day, dayName(0));
  assert.deepEqual(task.digests.map(row => [row.ref, row.person, row.summary, row.feeling]), [['d1', opaquePerson(person(A)), 'MOCK-摘要甲：对方说周末去了海边。', 'MOCK-感受甲'], ['d2', opaquePerson(person(B)), 'MOCK-摘要乙：对方说在学大提琴。', undefined]]);
  assert.deepEqual([task.notes, task.previous, task.own], [[], [], {}]);
  assert.ok(task.personaText.length > 0 && task.personaText.length <= DIARY.personaChars);
  // People are opaque labels: no account number, person or stream ID, memory or observation ID.
  const sent = JSON.stringify(task), listed = a.listMemory({ limit: 100 }).items.map(item => item.id);
  for (const hidden of ['99990000', 'person:', 'qq:', 'owner', lineA, ...listed]) assert.ok(!sent.includes(hidden), hidden);
  assert.match(sent, /p-[0-9a-f]{6}/);
  // The same request again while it is out: the same task (a second batch is counted, as for a consolidation batch).
  assert.equal(next().task.taskId, task.taskId);
  const answer = { taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密：今天和两个人聊了，想明白了一件事。' }, usedIds: ['d1', 'd2'] };
  const result = commit(answer);
  assert.deepEqual(result, { status: 'committed', day: dayName(0), privateId: result.privateId });
  assert.deepEqual(diaries().map(diary => [diary.id, diary.kind, diary.status, diary.day, diary.text, diary.cardId, diary.cardTitle, diary.readDiaryIds, diary.readback]),
    [[result.privateId, 'private', 'private', dayName(0), 'MOCK-私密：今天和两个人聊了，想明白了一件事。', DEFAULT_CARD_ID, '默认卡', [], undefined]]);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM diary_sources WHERE diary_id=?').get(result.privateId).n, 2);
  // The marker moved in the same transaction; nothing more is handed out for that day, now or later.
  assert.equal(state().diary.lastDay, dayName(0));
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  assert.deepEqual(commit(answer), { status: 'committed', replayed: true });
  assert.throws(() => commit({ ...answer, private: { text: 'MOCK-改了' } }), { code: 'CONFLICT' });
  clock.now = at(1, 5.5); assert.equal(next().task, null);
  clock.now = at(2, 5.5); assert.equal(next().task, null, 'a day without material is never handed out');
  assert.equal(diaries().length, 1);
  // The receipt holds a hash only; the audit trail IDs, the day and counts.
  const receipt = a.store.db.prepare("SELECT diary_id,canonical FROM diary_receipts WHERE task_id=? AND kind='diary'").get(task.taskId);
  assert.deepEqual([receipt.diary_id, /^[a-f0-9]{64}$/.test(receipt.canonical)], ['', true]);
  const audit = a.store.db.prepare("SELECT body FROM audit WHERE json_extract(body,'$.type')='diary.committed'").all().map(row => row.body).join('\n');
  assert.ok(audit.includes(result.privateId) && !audit.includes('MOCK-私密'));
  // The old automatic private diary: no task of that kind was admitted, and none of its diaries exists.
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM maintenance_tasks WHERE mode IN ('private','public')").get().n, 0);
  assert.equal(a.listMemory({ limit: 100 }).diaries.filter(diary => diary.v !== 2).length, 0);
});

test('when it is written: after nightly consolidation is done, at 05:00 regardless; a missed night is caught up for the last two days only', t => {
  const { a, clock, say, chat, next, write, diaries, state } = fixture(t);
  chat(A, 'MOCK-第0天的话', 'MOCK-摘要第0天');
  // Four more lines of day 0 that never left the window: nightly consolidation has a batch for them from 03:00 on.
  for (let i = 0; i < 2; i++) { say(B, `MOCK-乙第${i}句`); say(B, 'MOCK-REPLY', { she: true }); }
  clock.now = at(1, 3.5);
  assert.ok(a.consolidationWaiting(DEFAULT_ENTITY_ID));
  assert.equal(next().task, null, 'consolidation first');
  const stored = JSON.stringify(a.consolidationState());
  assert.equal(next().task, null); assert.equal(JSON.stringify(a.consolidationState()), stored, 'asking moved nothing');
  const { task: batch } = a.consolidationNext(DEFAULT_ENTITY_ID);
  assert.equal(batch.trigger, 'nightly');
  a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: batch.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要乙夜间' }, facts: [] });
  assert.ok(!a.consolidationWaiting(DEFAULT_ENTITY_ID));
  assert.deepEqual(next().task.digests.map(row => row.summary), ['MOCK-摘要第0天', 'MOCK-摘要乙夜间']);
  assert.equal(write('MOCK-私密第0天').result.status, 'committed');
  // Day 1: consolidation still has a batch at 05:00 (nobody ran it); the diary is written anyway.
  clock.now = at(1, 12); chat(A, 'MOCK-第1天的话', 'MOCK-摘要第1天');
  for (let i = 0; i < 2; i++) { say(B, `MOCK-乙第1天第${i}句`); say(B, 'MOCK-REPLY', { she: true }); }
  clock.now = at(2, 4.9); assert.equal(next().task, null);
  clock.now = at(2, 5);
  assert.ok(a.consolidationWaiting(DEFAULT_ENTITY_ID));
  assert.deepEqual(write('MOCK-私密第1天').task.digests.map(row => row.summary), ['MOCK-摘要第1天']);
  // The worker did not run for three nights: days 2, 3 and 4 have material; on day 5 only days 3 and 4 are written, oldest first.
  for (const day of [2, 3, 4]) { clock.now = at(day, 13); chat(A, `MOCK-第${day}天的话`, `MOCK-摘要第${day}天`); }
  clock.now = at(5, 10);
  const first = write('MOCK-私密第3天'), second = write('MOCK-私密第4天');
  assert.deepEqual([first.task.day, second.task.day], [dayName(3), dayName(4)]);
  assert.equal(next().task, null);
  assert.deepEqual(diaries().filter(diary => diary.kind === 'private').map(diary => diary.day).sort(), [0, 1, 3, 4].map(dayName));
  assert.equal(state().diary.lastDay, dayName(4));
  // A paused world hands nothing out.
  clock.now = at(5, 13); chat(A, 'MOCK-第5天的话', 'MOCK-摘要第5天'); clock.now = at(6, 5);
  a.setWorldPaused({ paused: true });
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'paused' });
});

test('a word of a diary reaches no conversation: no context, search, read or recall of anyone returns it', t => {
  const { a, clock, chat, write } = fixture(t);
  chat(A, '我周末去了MOCK-海边', 'MOCK-摘要甲');
  clock.now = at(1, 5);
  const { result } = write('MOCK-私密独特词甲 今天想了很多。');
  clock.now += 1000;
  for (const uid of [A, B, OWNER]) {
    const scope = { streamId: stream(uid), windowFromAt: clock.now }, query = 'MOCK-私密独特词甲 独特词 今天';
    const seen = JSON.stringify([a.context('qq', { ...scope, query, profile: true }), a.memorySearch('qq', { ...scope, query }), a.memoryRecall('qq', { ...scope, fromAt: 0, toAt: clock.now + DAY }),
      a.memoryRead('qq', { ...scope, id: result.privateId })]);
    assert.ok(!seen.includes('独特词'), `conversation of ${uid}`);
    assert.equal(a.memoryRead('qq', { ...scope, id: result.privateId }).item, null);
  }
  // A consolidation batch does not carry it either.
  chat(B, 'MOCK-乙的话', 'MOCK-摘要乙');
  assert.ok(!JSON.stringify(a.store.db.prepare('SELECT source_ids FROM maintenance_tasks').all()).includes('独特词'));
});

test('forgetting one line of A removes its digest and the diaries that used it or read such a diary (one hop); B and a later day stay', t => {
  const { a, clock, chat, write, diaries, digests } = fixture(t);
  const line = chat(A, '我周末去了MOCK-海边潜水', 'MOCK-摘要甲：对方说周末去潜水。');
  chat(B, '我在学MOCK-大提琴', 'MOCK-摘要乙：对方说在学大提琴。');
  clock.now = at(1, 5);
  const day0 = write('MOCK-私密第0天：两个人都聊了。').result;
  // Day 1 has only B; its diaries are written after reading day 0's private diary.
  clock.now = at(1, 12); chat(B, 'MOCK-乙第1天', 'MOCK-摘要乙第1天');
  clock.now = at(2, 5);
  const second = write('MOCK-私密第1天：接着昨天想。');
  assert.deepEqual([second.task.previous.map(row => row.text), diaries().find(diary => diary.id === second.result.privateId).readDiaryIds], [['MOCK-私密第0天：两个人都聊了。'], [day0.privateId]]);
  // Day 2 reads day 1 and day 0. Day 3 reads day 2 and day 1 only: it never saw anything of A.
  clock.now = at(2, 12); chat(B, 'MOCK-乙第2天', 'MOCK-摘要乙第2天'); clock.now = at(3, 5);
  const third = write('MOCK-私密第2天').result;
  clock.now = at(3, 12); chat(B, 'MOCK-乙第3天', 'MOCK-摘要乙第3天'); clock.now = at(4, 5);
  const fourth = write('MOCK-私密第3天：周末好像有人去潜水，海边真好。').result;
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [line] });
  const digestA = digests(A)[0].id;
  assert.deepEqual(preview.digestIds, [digestA]);
  // The diary of day 0 (it used A's digest) and those of days 1 and 2 (written after reading day 0's diary): one hop.
  assert.deepEqual([...preview.diaryIds].sort(), [day0.privateId, second.result.privateId, third.privateId].sort());
  // Every one of them also holds other content (B's): the preview says so.
  assert.deepEqual([...preview.mixedDiaryIds].sort(), [...preview.diaryIds].sort());
  // Day 3's private diary stays but speaks of what is being forgotten: listed for the owner to decide.
  assert.deepEqual(preview.mentionDiaryIds, [fourth.privateId]);
  a.setWorldPaused({ paused: true });
  a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [line], expectedMemoryEpoch: preview.memoryEpoch });
  assert.deepEqual(digests(A), []);
  assert.deepEqual(diaries().map(diary => diary.id), [fourth.privateId]);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM diary_sources WHERE diary_id=?').get(day0.privateId).n, 0);
  // B keeps every digest; nothing of the removed days is written again.
  assert.equal(digests(B).length, 4);
  a.cleanupPending().forEach(job => a.cleanupComplete({ id: job.id, memoryEpoch: job.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } }));
  a.setWorldPaused({ paused: false });
  assert.equal(a.diaryNext(DEFAULT_ENTITY_ID).task, null);
  // Selecting only a diary removes it and the diaries that read it, never its sources.
  const only = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [fourth.privateId] });
  assert.deepEqual([only.diaryIds, only.memoryIds], [[fourth.privateId], []]);
});

test('the open diary is not written yet: an `open` in the answer is accepted and ignored, and no open row exists', t => {
  const { a, clock, chat, next, commit, diaries } = fixture(t);
  chat(A, '我家的猫叫MOCK-煤球', 'MOCK-摘要甲');
  clock.now = at(1, 5);
  const { task } = next();
  const result = commit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密：今天听说了一只猫。' }, open: { text: 'MOCK-明面：不会被保存。' }, usedIds: ['d1'] });
  assert.deepEqual(result, { status: 'committed', day: dayName(0), privateId: result.privateId });
  assert.deepEqual(diaries().map(diary => [diary.kind, diary.text]), [['private', 'MOCK-私密：今天听说了一只猫。']]);
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM diaries WHERE kind='open'").get().n, 0);
  assert.ok(!JSON.stringify(a.store.db.prepare('SELECT body FROM diaries').all()).includes('MOCK-明面'));
});

test('a diary matching the sensitive lexicon is refused and the day is done; an answer out of shape is invalid, and three of them give the day up', t => {
  const { a, clock, chat, next, commit, diaries, state } = fixture(t);
  chat(A, 'MOCK-第0天', 'MOCK-摘要第0天');
  clock.now = at(1, 5);
  let { task } = next();
  const result = commit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密：他说了密码。' }, usedIds: ['d1'] });
  assert.deepEqual(result, { status: 'committed', day: dayName(0), privateId: null, rejected: 'sensitive' });
  assert.deepEqual(diaries(), []);
  assert.deepEqual([state().diary.lastDay, next().task], [dayName(0), null]);
  clock.now = at(1, 12); chat(A, 'MOCK-第1天', 'MOCK-摘要第1天'); clock.now = at(2, 5);
  task = next().task;
  assert.equal(commit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密第1天' }, usedIds: ['d1'] }).status, 'committed');
  assert.deepEqual(diaries().map(diary => [diary.kind, diary.day]), [['private', dayName(1)]]);
  // Out of shape: too long, no diary, an extra key, usedIds empty or outside what was given.
  clock.now = at(2, 12); chat(A, 'MOCK-第2天', 'MOCK-摘要第2天'); clock.now = at(3, 5);
  const good = { private: { text: 'MOCK-私密' }, usedIds: ['d1'] };
  const bad = [{ ...good, private: { text: 'x'.repeat(DIARY.textChars + 1) } }, { ...good, private: undefined }, { ...good, private: { text: 'MOCK', title: 'x' } }, { ...good, usedIds: [] }, { ...good, usedIds: ['d9'] }, { ...good, usedIds: ['n1'] }, { ...good, private: { text: '  ' } }];
  for (const [index, answer] of bad.slice(0, 2).entries()) {
    task = next().task;
    assert.deepEqual(commit({ taskId: task.taskId, outcome: 'ok', ...answer }), { status: 'invalid' }, String(index));
    // The same report again counts once.
    assert.deepEqual(commit({ taskId: task.taskId, outcome: 'ok', ...answer }), { status: 'invalid' });
  }
  assert.equal(state().diary.invalid.count, 2);
  task = next().task;
  assert.deepEqual(commit({ taskId: task.taskId, outcome: 'invalid' }), { status: 'skipped' });
  // Each of the three requests was one of the day's batches.
  assert.deepEqual([state().diary.lastDay, state().diary.skipped, state().calls, next().task], [dayName(2), 1, 3, null]);
  assert.equal(diaries().filter(diary => diary.day === dayName(2)).length, 0);
  const audit = a.store.db.prepare("SELECT body FROM audit WHERE json_extract(body,'$.type')='diary.skipped'").all().map(row => JSON.parse(row.body));
  assert.deepEqual(audit.map(entry => [entry.day, entry.reason]), [[dayName(2), 'invalid_output']]);
  // The remaining shapes are refused the same way (a new day each, one strike).
  for (const [index, answer] of bad.slice(2).entries()) {
    clock.now = at(3 + index, 12); chat(A, `MOCK-第${3 + index}天`, `MOCK-摘要第${3 + index}天`); clock.now = at(4 + index, 5);
    task = next().task;
    assert.deepEqual(commit({ taskId: task.taskId, outcome: 'ok', ...answer }), { status: 'invalid' }, JSON.stringify(answer));
    task = next().task;
    assert.equal(commit({ taskId: task.taskId, outcome: 'ok', ...good }).status, 'committed');
  }
});

test('a diary call is one of the day\'s consolidation batches: counted when handed out, returned when the spend tier refuses it, one kept for it at night', t => {
  const { a, clock, say, chat, next, commit, state } = fixture(t);
  chat(A, 'MOCK-第0天', 'MOCK-摘要第0天');
  clock.now = at(1, 5);
  const before = state().calls ?? 0;
  const { task } = next();
  assert.equal(state().calls, 1, 'a new day: the diary took the first batch');
  assert.ok(before >= 1);
  // The gateway's spend tier refused the call: uncounted, the day stays due, the status shows the pause.
  assert.deepEqual(commit({ taskId: task.taskId, outcome: 'deferred' }), { status: 'deferred' });
  assert.deepEqual(commit({ taskId: task.taskId, outcome: 'deferred' }), { status: 'deferred' });
  assert.deepEqual([state().calls, state().diary.lastDay, a.consolidationStatus().paused], [0, undefined, 'spend']);
  assert.equal(next().task.taskId, task.taskId);
  // Every batch of the day is used: the diary waits; a batch is not handed out past the limit.
  const all = a.consolidationState(); all[DEFAULT_ENTITY_ID].calls = CONSOLIDATION.perDay; delete all[DEFAULT_ENTITY_ID].diary.issued;
  a.saveConsolidationState(all);
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'budget' });
  // At night, while yesterday's diary is not written, consolidation stops one batch short of the limit.
  all[DEFAULT_ENTITY_ID].calls = CONSOLIDATION.perDay - 1; a.saveConsolidationState(all);
  say(B, 'MOCK-乙的话'); say(B, 'MOCK-REPLY', { she: true }); clock.now += 1000;
  a.context('qq', { streamId: stream(B), query: 'MOCK', windowFromAt: clock.now });
  assert.deepEqual(a.consolidationNext(DEFAULT_ENTITY_ID), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'budget' });
  const kept = next().task;
  assert.equal(commit({ taskId: kept.taskId, outcome: 'ok', private: { text: 'MOCK-私密' }, usedIds: ['d1'] }).status, 'committed');
  assert.deepEqual([state().calls, a.consolidationStatus().diary.lastDay, a.consolidationStatus().diary.skipped], [CONSOLIDATION.perDay, dayName(0), 0]);
  // By day the last batch is consolidation's again.
  const later = a.consolidationState(); later[DEFAULT_ENTITY_ID].calls = CONSOLIDATION.perDay - 1; a.saveConsolidationState(later);
  assert.ok(a.consolidationNext(DEFAULT_ENTITY_ID).task);
});

test('the input is bounded: over the budget the pinned and the newer digests stay; her own notes of the day are part of it', t => {
  const { a, clock, say, next } = fixture(t);
  // 30 digests of day 0 written straight into the store (the consolidation budget is 2 a conversation a day).
  const long = 'MOCK-摘要' + '很长'.repeat(140);
  for (let i = 0; i < 30; i++) a.store.insertMemory(DEFAULT_ENTITY_ID, 'experiences', { id: `MOCK-digest-${i}`, personId: person(i % 2 ? A : B), visibility: 'private', kind: 'digest', summary: `${i}号 ${long}`, toAt: at(0, 9) + i * 60000, revision: a.store.nextRevision(), at: clock.now }, 0, i === 0 ? { pinned: true } : {});
  // A note about herself, written in a conversation of day 0 (an inner note never reaches a conversation).
  const line = say(A, 'MOCK-你怎么看自己');
  a.submit('qq', { proposalId: 'MOCK-note-1', observationId: line, type: 'self.note', payload: { text: 'MOCK-内心话：我其实有点怕冷场。', quote: 'MOCK-你怎么看自己', kind: 'inner' } });
  a.processPending();
  clock.now = at(1, 5);
  const { task } = next();
  const size = JSON.stringify(task.digests).length;
  assert.ok(size <= DIARY.digestChars + 2 && size > DIARY.digestChars - 400, String(size));
  const kept = task.digests.map(row => Number(row.summary.split('号')[0]));
  // The pinned oldest one and the newest ones, in the order of the day.
  assert.deepEqual(kept, [0, ...Array.from({ length: kept.length - 1 }, (_, index) => 30 - (kept.length - 1) + index)]);
  assert.deepEqual(task.notes, [{ ref: 'n1', kind: 'inner', text: 'MOCK-内心话：我其实有点怕冷场。' }]);
  assert.ok(JSON.stringify(task.notes).length <= DIARY.noteChars);
  // A note used by a diary is one of its sources.
  const result = a.diaryCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密' }, usedIds: ['n1'] });
  const note = a.listMemory({ limit: 100 }).items.find(item => item.type === 'notes');
  assert.deepEqual(a.store.db.prepare('SELECT memory_id FROM diary_sources WHERE diary_id=?').all(result.privateId).map(row => row.memory_id), [note.id]);
});

test('a diary belongs to the persona card it was written under: it carries the card id, and only the same card\'s private diaries and feelings are read while writing', t => {
  const { a, clock, chat, next, commit, write, diaries } = fixture(t);
  const body = id => JSON.parse(a.store.db.prepare('SELECT body FROM diaries WHERE id=?').get(id).body);
  chat(A, 'MOCK-第0天', 'MOCK-摘要第0天', { feeling: 'MOCK-默认卡的感受' });
  clock.now = at(1, 5);
  const first = write('MOCK-默认卡的私密日记第0天').result;
  assert.equal(body(first.privateId).cardId, DEFAULT_CARD_ID);
  // Another card becomes current. Day 1 under it: the default card's private diary and feeling are not in the input.
  const { id: other } = a.createPersonaCard({ title: 'MOCK-乙卡' });
  a.updatePersonaCard({ id: other, patch: { name: 'MOCK-乙' }, reason: REASON });
  clock.now = at(1, 12); chat(A, 'MOCK-第1天', 'MOCK-摘要第1天', { feeling: 'MOCK-默认卡的感受第1天' });
  a.activatePersonaCard({ id: other, reason: REASON });
  clock.now = at(1, 13); chat(B, 'MOCK-乙第1天', 'MOCK-摘要乙第1天', { feeling: 'MOCK-乙卡的感受' });
  clock.now = at(2, 5);
  const second = write('MOCK-乙卡的私密日记第1天');
  assert.deepEqual(second.task.previous, []);
  assert.deepEqual(second.task.digests.map(row => [row.summary, row.feeling]), [['MOCK-摘要第1天', undefined], ['MOCK-摘要乙第1天', 'MOCK-乙卡的感受']]);
  assert.ok(second.task.personaText.includes('MOCK-乙') && !JSON.stringify(second.task).includes('默认卡的'));
  assert.deepEqual([body(second.result.privateId).cardId, body(second.result.privateId).readDiaryIds], [other, []]);
  assert.deepEqual(diaries().filter(diary => diary.day === dayName(1)).map(diary => diary.cardTitle), ['MOCK-乙卡']);
  // Day 2, still the other card: its own diary of day 1 is read, the default card's is not.
  clock.now = at(2, 12); chat(A, 'MOCK-第2天', 'MOCK-摘要第2天'); clock.now = at(3, 5);
  const third = write('MOCK-乙卡的私密日记第2天');
  assert.deepEqual([third.task.previous, body(third.result.privateId).readDiaryIds], [[{ day: dayName(1), text: 'MOCK-乙卡的私密日记第1天' }], [second.result.privateId]]);
  // A request handed out under one card is not written under another.
  clock.now = at(3, 12); chat(A, 'MOCK-第3天', 'MOCK-摘要第3天'); clock.now = at(4, 5);
  const { task } = next();
  a.activatePersonaCard({ id: DEFAULT_CARD_ID, reason: REASON });
  assert.throws(() => commit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密' }, usedIds: ['d1'] }), { code: 'CONFLICT' });
  // Back on the default card: its own diary (and one of this format without a card id, which is the default card's)
  // is read, newest two, oldest first; the other card's are not. A diary of the old format is never read.
  a.store.db.prepare('INSERT INTO diaries(id,entity_id,kind,status,revision,world_at,body) VALUES(?,?,?,?,?,?,?)').run('MOCK-no-card', DEFAULT_ENTITY_ID, 'private', 'private', a.store.nextRevision(), 0, JSON.stringify({ v: 2, day: dayName(2), text: 'MOCK-没有卡号的私密日记', readDiaryIds: [] }));
  a.writePrivateDiary({ entityId: DEFAULT_ENTITY_ID, text: 'MOCK-旧版私密日记' });
  const fourth = write('MOCK-默认卡的私密日记第3天');
  assert.deepEqual(fourth.task.previous.map(row => row.text), ['MOCK-默认卡的私密日记第0天', 'MOCK-没有卡号的私密日记']);
  assert.deepEqual(body(fourth.result.privateId).readDiaryIds, [first.privateId, 'MOCK-no-card']);
  assert.equal(body(fourth.result.privateId).cardId, DEFAULT_CARD_ID);
  // Listed with the card: a title while the card exists, the id alone once it is deleted; the old format has neither.
  a.deletePersonaCard({ id: other });
  const listed = a.listMemory({ limit: 100 }).diaries;
  assert.deepEqual(listed.filter(diary => diary.cardId === other).map(diary => diary.cardTitle), [null, null]);
  assert.deepEqual(listed.filter(diary => diary.text === 'MOCK-旧版私密日记').map(diary => [diary.v, diary.cardId, diary.cardTitle]), [[undefined, undefined, undefined]]);
  assert.deepEqual(listed.filter(diary => diary.id === 'MOCK-no-card').map(diary => [diary.cardId, diary.cardTitle]), [[DEFAULT_CARD_ID, '默认卡']]);
});

test('no schema change: a database with diaries of this release has the shape it had, and the diary marker is one more key of the consolidation state', t => {
  const { a, clock, chat, write } = fixture(t);
  const shape = () => JSON.stringify([a.store.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(), a.store.db.prepare('PRAGMA user_version').get()]);
  const before = shape();
  chat(A, 'MOCK-第0天', 'MOCK-摘要第0天'); clock.now = at(1, 5); write('MOCK-私密');
  assert.equal(shape(), before);
  assert.deepEqual(a.store.db.prepare('SELECT key FROM metadata ORDER BY key').all().map(row => row.key).filter(key => /diar/i.test(key)), []);
  assert.equal(a.consolidationState()[DEFAULT_ENTITY_ID].diary.lastDay, dayName(0));
  // What a release before the two diaries reads: its listing spreads the body, and its batch cursor only takes the newest revision.
  assert.equal(a.maintenanceBatch(DEFAULT_ENTITY_ID, { mode: 'private' }).world.paused, false);
});

test('routes: the diary calls need the maintenance credential; the operator trigger exists only when the private configuration allows it', async t => {
  const { a, clock, chat, diaries } = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-diary-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = [], clients = {};
  for (const [name, role] of [['conversation', 'capability'], ['maintenance', 'maintenance']]) {
    const token = randomBytes(32).toString('base64url'), tokenFile = path.join(root, name + '.token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    credentials.push({ hash: createHash('sha256').update(token).digest('hex'), role, ...(role === 'maintenance' ? { entityId: DEFAULT_ENTITY_ID } : { capabilityId: 'qq' }) });
    clients[name] = new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile });
  }
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials });
  await app.start(); t.after(() => app.close());
  chat(A, 'MOCK-今天的话', 'MOCK-摘要今天');
  await assert.rejects(clients.conversation.diaryNext(), { status: 403 });
  await assert.rejects(clients.conversation.diaryCommit({ taskId: 'x', outcome: 'invalid' }), { status: 403 });
  await assert.rejects(clients.maintenance.diaryCommit({ taskId: 'x', outcome: 'maybe' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await clients.maintenance.diaryNext(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
  const call = socketPath => (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: { authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body ?? {}) : undefined);
  });
  // As in production: no trigger.
  const plain = createOperatorServer({ authority: a, socketPath: path.join(root, 'operator.sock'), tokenHash, origins: [] });
  await plain.start(); t.after(() => plain.close());
  assert.notEqual((await call(path.join(root, 'operator.sock'))('POST', '/memory/diary/trigger')).status, 200);
  assert.equal(a.consolidationState()[DEFAULT_ENTITY_ID].diary?.liveDay, undefined);
  // Staging: the running day is written as if it had ended, once.
  const staging = createOperatorServer({ authority: a, socketPath: path.join(root, 'staging.sock'), tokenHash, origins: [], allowDiaryTrigger: true });
  await staging.start(); t.after(() => staging.close());
  const operator = call(path.join(root, 'staging.sock'));
  assert.equal((await operator('POST', '/memory/diary/trigger', { day: '2027-01-01' })).status, 400);
  const triggered = await operator('POST', '/memory/diary/trigger');
  assert.deepEqual([triggered.status, triggered.body.value.day], [200, dayName(0)]);
  const { task } = await clients.maintenance.diaryNext();
  assert.deepEqual([task.day, task.digests.map(row => row.summary)], [dayName(0), ['MOCK-摘要今天']]);
  const result = await clients.maintenance.diaryCommit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-私密今天' }, usedIds: ['d1'] });
  assert.equal(result.status, 'committed');
  await assert.rejects(clients.maintenance.diaryCommit({ taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-改了' }, usedIds: ['d1'] }), { status: 409 });
  // Triggered again: the day is done, no second request; and the next night does not write it again.
  await operator('POST', '/memory/diary/trigger');
  assert.equal((await clients.maintenance.diaryNext()).task, null);
  clock.now = at(1, 5);
  assert.equal((await clients.maintenance.diaryNext()).task, null);
  assert.equal(diaries().length, 1);
  // The operator listing shows it, and the consolidation status the marker.
  const listed = await operator('GET', '/memory');
  assert.deepEqual(listed.body.value.diaries.map(diary => [diary.kind, diary.day, diary.cardTitle]), [['private', dayName(0), '默认卡']]);
  assert.equal((await operator('GET', '/memory/consolidation')).body.value.diary.lastDay, dayName(0));
});
