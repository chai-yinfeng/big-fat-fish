import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { CONSOLIDATION } from '../src/consolidation.js';
import { opaquePerson } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
// What the QQ bridge sends to admit a friend: the account and, in QQ's own terms, its actor and conversation.
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const HOUR = 3600000, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => `person:qq:${uid}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cons-'));
  // 2027-01-15 16:00 in Beijing: outside the nightly hours.
  const clock = { now: 1_800_000_000_000 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  let seq = 0;
  /** One line of a private chat; `she: true` is her delivered reply. Returns the observation ID. */
  const say = (uid, text, { she = false, at = clock.now } = {}) => a.observe('qq', { eventId: `e-${++seq}`, streamId: stream(uid), actorId: she ? 'qq:model' : `qq:${SELF}:user:${uid}`, role: she ? 'assistant' : 'user', text, at }).observationId;
  /** She answers `uid` (which completes the run), then the executor reports that every run so far has left
   * its replay window. Returns the ID of her reply. */
  const rollOut = uid => { const reply = say(uid, 'MOCK-REPLY 嗯', { she: true }); clock.now += 1000; a.context('qq', { streamId: stream(uid), query: 'MOCK', windowFromAt: clock.now }); return reply; };
  const next = () => a.consolidationNext(DEFAULT_ENTITY_ID);
  const commit = input => a.consolidationCommit(DEFAULT_ENTITY_ID, input);
  const digests = uid => a.listMemory({ limit: 100 }).items.filter(item => item.kind === 'digest' && item.personId === (uid === OWNER ? 'person:owner' : person(uid)));
  const cursor = uid => a.consolidationState()[DEFAULT_ENTITY_ID]?.streams[`qq\u0000${stream(uid)}`]?.lastObservationId ?? null;
  return { a, clock, say, rollOut, next, commit, digests, cursor };
}
const answer = (taskId, extra = {}) => ({ taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：对方说起周末去了海边。', feeling: 'MOCK-感受：听着很开心。' }, facts: [], ...extra });

test('dialogue that left the window becomes a digest and a quoted fact of that person only; neither digest reaches any conversation', t => {
  const { a, say, rollOut, next, commit, digests } = fixture(t);
  const first = say(A, '我周末去了MOCK-海边，我家的猫叫MOCK-煤球');
  say(B, 'MOCK-B 的私事：我在学MOCK-大提琴');
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' }, 'nothing has left any window yet');
  const reply = rollOut(A);
  // A line of the run the executor still replays is not part of what left the window.
  const replayed = say(A, 'MOCK-还在窗口里的一句');
  const { task } = next();
  // The batch is one conversation: A's completed run, by short refs. Nothing of B, no raw ID or account number.
  assert.deepEqual(task.observations.map(row => [row.ref, row.role, row.text]), [['o1', 'user', '我周末去了MOCK-海边，我家的猫叫MOCK-煤球'], ['o2', 'assistant', 'MOCK-REPLY 嗯']]);
  assert.ok(!JSON.stringify(task).includes('还在窗口里') && replayed);
  assert.equal(task.trigger, 'rollout');
  const sent = JSON.stringify(task);
  for (const hidden of ['大提琴', '99990000', first, reply, 'person:', 'owner']) assert.ok(!sent.includes(hidden), hidden);
  const result = commit(answer(task.taskId, { facts: [{ key: '猫的名字', value: 'MOCK-煤球', quote: '我家的猫叫MOCK-煤球', ref: 'o1' }] }));
  assert.equal(result.status, 'committed');
  assert.deepEqual(a.processPending().map(receipt => [receipt.proposalId.startsWith('cons:'), receipt.status]), [[true, 'accepted']]);
  const [digest] = digests(A);
  assert.deepEqual([digest.type, digest.kind, digest.visibility, digest.importance, digest.summary, digest.feeling, digest.derivedFrom, digest.source.machine, digest.personLabel],
    ['experiences', 'digest', 'private', 0.65, 'MOCK-摘要：对方说起周末去了海边。', 'MOCK-感受：听着很开心。', [first, reply], 'digest', opaquePerson(person(A))]);
  assert.equal(digest.evidence, undefined, 'a digest carries no evidence');
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE memory_id=?').get(digest.id).n, 0);
  assert.deepEqual(digests(B), []);
  const fact = a.listMemory({ limit: 100 }).items.find(item => item.type === 'facts');
  assert.deepEqual([fact.personId, fact.key, fact.value, fact.importance, fact.source.machine, fact.evidence.observationId, fact.evidence.quote], [person(A), '猫的名字', 'MOCK-煤球', 0.7, 'extracted', first, '我家的猫叫MOCK-煤球']);
  // Written, not read back: no retrieval, search, read, recall or profile of anyone returns the digest.
  for (const uid of [A, B, OWNER]) {
    const context = a.context('qq', { streamId: stream(uid), query: 'MOCK-摘要 周末 海边', profile: true });
    assert.ok(![context.text, context.memoryText, context.profileText].join('\n').includes('MOCK-摘要'), `context of ${uid}`);
    assert.ok(!context.memoryIds.includes(digest.id));
    assert.deepEqual(a.memorySearch('qq', { streamId: stream(uid), query: 'MOCK-摘要 周末 海边' }).items.filter(item => item.id === digest.id), []);
    assert.equal(a.memoryRead('qq', { streamId: stream(uid), id: digest.id }).item, null);
    assert.deepEqual(a.memoryRecall('qq', { streamId: stream(uid), fromAt: 0, toAt: 2_000_000_000_000 }).items.filter(item => item.id === digest.id), []);
  }
  // The extracted fact is an ordinary fact of A: in A's profile, in nobody else's.
  assert.ok(a.context('qq', { streamId: stream(A), query: 'MOCK', profile: true }).profileText.includes('MOCK-煤球'));
  assert.ok(!JSON.stringify(a.context('qq', { streamId: stream(B), query: 'MOCK-煤球 猫', profile: true })).includes('MOCK-煤球'));
  assert.throws(() => a.markMemoryPublic({ entityId: DEFAULT_ENTITY_ID, id: digest.id }), { code: 'FORBIDDEN' });
  // The audit trail of the commit has labels and counts, no text.
  const audit = a.snapshot().audit.find(entry => entry.type === 'consolidation.committed');
  assert.deepEqual([audit.person, audit.observations, audit.digestId, audit.proposals.length], [opaquePerson(person(A)), 2, digest.id, 1]);
  assert.ok(!/MOCK|99990000/.test(JSON.stringify(audit)));
  assert.throws(() => a.submit('qq', { proposalId: 'cons:forged', observationId: first, type: 'fact.report', payload: { key: 'k', value: '我', quote: '我' } }), { code: 'VALIDATION_ERROR' });
});

test('a fact needs an observation of the person in this batch; a loose quote or value is stored and marked, and the digest is still written', t => {
  const { a, say, rollOut, next, commit, digests } = fixture(t);
  const first = say(A, '我的生日是MOCK-三月十二'); say(A, 'MOCK-REPLY 我的生日是MOCK-腊月初八', { she: true }); say(B, '我的生日是MOCK-七月初七');
  const third = say(A, 'MOCK-我下个月 5 号搬家'); rollOut(A);
  const { task } = next();
  const result = commit(answer(task.taskId, { facts: [
    { key: '生日', value: 'MOCK-三月十二', quote: '我生日是MOCK-三月十二', ref: 'o1' },   // not verbatim
    { key: '搬家', value: 'MOCK-2026-12-05', quote: 'MOCK-我下个月 5 号搬家', ref: 'o3' }, // value not in the quote
    { key: '生日', value: 'MOCK-腊月初八', quote: '我的生日是MOCK-腊月初八', ref: 'o2' }, // her own words
    { key: '生日', value: 'MOCK-七月初七', quote: '我的生日是MOCK-七月初七', ref: 'o9' }, // not in this batch (B said it)
  ] }));
  assert.deepEqual(result.dropped, [{ index: 3, reason: 'ref_unavailable' }]);
  assert.deepEqual(a.processPending().map(receipt => [receipt.status, receipt.reason]), [['accepted', undefined], ['accepted', undefined], ['rejected', 'unconfirmed_identity']]);
  assert.deepEqual(a.consolidationStatus().extracted, { accepted: 2, pending: 0, rejected: { unconfirmed_identity: 1 } });
  const facts = Object.fromEntries(a.listMemory({ limit: 100 }).items.filter(item => item.type === 'facts').map(item => [item.key, item]));
  assert.deepEqual(Object.keys(facts).sort(), ['搬家', '生日']);
  assert.deepEqual([facts.生日.value, facts.生日.personId, facts.生日.importance, facts.生日.source.machine, facts.生日.evidence.observationId, facts.生日.evidence.quoteVerbatim], ['MOCK-三月十二', person(A), 0.7, 'extracted', first, false]);
  assert.deepEqual([facts.搬家.value, facts.搬家.personId, facts.搬家.evidence.observationId, facts.搬家.evidence.quoteVerbatim], ['MOCK-2026-12-05', person(A), third, undefined]);
  assert.deepEqual(a.memorySources({ id: facts.生日.id }).sources.map(source => [source.id, source.text]), [[first, '我的生日是MOCK-三月十二']]);
  // Marked or not, the fact is that person's alone.
  assert.ok(a.context('qq', { streamId: stream(A), query: 'MOCK', profile: true }).profileText.includes('MOCK-三月十二'));
  assert.ok(!/MOCK-三月十二|MOCK-2026-12-05/.test(JSON.stringify(a.context('qq', { streamId: stream(B), query: 'MOCK-三月十二 生日 搬家', profile: true }))));
  assert.equal(digests(A).length, 1);
});

test('an extracted fact never replaces a pinned fact or one recorded from words at least as recent', t => {
  const { a, clock, say, rollOut, next, commit } = fixture(t);
  const facts = () => Object.fromEntries(a.listMemory({ limit: 100 }).items.filter(item => item.type === 'facts' && item.status === 'active').map(item => [item.key, item.value]));
  const live = (key, value, text) => { const observationId = say(A, text); a.submit('qq', { proposalId: `live-${key}`, observationId, type: 'fact.report', payload: { key, value, quote: text } }); a.processPending(); };
  say(A, '我住在MOCK-旧城'); say(A, '我养MOCK-金鱼'); say(A, '我爱喝MOCK-红茶');
  clock.now += HOUR;
  live('住处', 'MOCK-新城', '我搬到MOCK-新城了');
  rollOut(A);
  let { task } = next();
  assert.deepEqual(task.knownKeys, ['住处'], 'known keys are offered for reuse');
  commit(answer(task.taskId, { facts: [{ key: '住处', value: 'MOCK-旧城', quote: '我住在MOCK-旧城', ref: 'o1' }, { key: '宠物', value: 'MOCK-金鱼', quote: '我养MOCK-金鱼', ref: 'o2' }, { key: '茶', value: 'MOCK-红茶', quote: '我爱喝MOCK-红茶', ref: 'o3' }] }));
  assert.deepEqual(a.processPending().map(receipt => receipt.reason ?? receipt.status), ['newer_fact_kept', 'accepted', 'accepted']);
  assert.deepEqual(facts(), { 住处: 'MOCK-新城', 宠物: 'MOCK-金鱼', 茶: 'MOCK-红茶' });
  // Later words replace an extracted fact; a pinned one stays whatever comes.
  const pet = a.listMemory({ limit: 100 }).items.find(item => item.key === '宠物');
  a.setMemoryRetention({ entityId: DEFAULT_ENTITY_ID, id: pet.id, pinned: true });
  clock.now += HOUR; say(A, '我现在养MOCK-乌龟'); say(A, '我改喝MOCK-绿茶了');
  rollOut(A);
  ({ task } = next());
  const refs = Object.fromEntries(task.observations.map(row => [row.text, row.ref]));
  commit(answer(task.taskId, { facts: [{ key: '宠物', value: 'MOCK-乌龟', quote: '我现在养MOCK-乌龟', ref: refs['我现在养MOCK-乌龟'] }, { key: '茶', value: 'MOCK-绿茶', quote: '我改喝MOCK-绿茶了', ref: refs['我改喝MOCK-绿茶了'] }] }));
  assert.deepEqual(a.processPending().map(receipt => receipt.reason ?? receipt.status), ['newer_fact_kept', 'accepted']);
  assert.deepEqual(facts(), { 住处: 'MOCK-新城', 宠物: 'MOCK-金鱼', 茶: 'MOCK-绿茶' });
});

test('the cursor moves with the digest: a batch handed out twice is committed once, with no gap and no repeat', t => {
  const { a, clock, say, rollOut, next, commit, digests, cursor } = fixture(t);
  const ids = [say(A, 'MOCK-第一句')];
  ids.push(rollOut(A));
  const once = next().task, again = next().task;
  assert.equal(again.taskId, once.taskId, 'a worker that died after taking the batch gets the same one');
  assert.equal(cursor(A), null);
  const input = answer(once.taskId);
  const first = commit(input);
  assert.equal(cursor(A), ids[1]);
  // The response was lost: the same commit again changes nothing; a different answer for it is refused.
  assert.deepEqual(commit(input), { status: 'committed', digestId: first.digestId, replayed: true });
  assert.throws(() => commit(answer(once.taskId, { digest: { summary: 'MOCK-另一个摘要' } })), { code: 'CONFLICT' });
  assert.equal(digests(A).length, 1);
  assert.equal(next().task, null, 'nothing new has left the window');
  ids.push(say(A, 'MOCK-第二句'));
  clock.now += DAY; // handing the first batch out twice used this conversation's two of the day
  ids.push(rollOut(A));
  const later = next().task;
  assert.deepEqual(later.observations.map(row => row.text), ['MOCK-第二句', 'MOCK-REPLY 嗯']);
  assert.equal(later.lastDigest, 'MOCK-摘要：对方说起周末去了海边。', 'the previous digest of this conversation is offered for continuity');
  // A failed commit leaves digest and cursor as they were.
  assert.throws(() => commit({ taskId: 'x'.repeat(64), outcome: 'ok', digest: { summary: 'MOCK' } }), { code: 'CONFLICT' });
  assert.equal(cursor(A), ids[1]);
  commit(answer(later.taskId));
  assert.deepEqual(digests(A).flatMap(digest => digest.derivedFrom).sort(), [...ids].sort(), 'every line is covered by exactly one digest');
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM maintenance_tasks WHERE mode='consolidation'").get().n, 0);
  // The receipt holds a hash, not the digest.
  assert.ok(a.store.db.prepare("SELECT canonical FROM diary_receipts WHERE kind='consolidation'").all().every(row => /^[0-9a-f]{64}$/.test(row.canonical)));
});

test('budget: two batches per conversation and 24 for everyone per Beijing day; a call the spend tier refused is handed back', t => {
  const { a, clock, say, rollOut, next, commit, cursor } = fixture(t);
  const round = uid => { say(uid, `MOCK-${uid}-${clock.now}`); rollOut(uid); };
  const status = () => a.consolidationStatus();
  round(A);
  // Spend tier at 80% or above: the worker reports `deferred`; nothing is counted and the cursor stays.
  let { task } = next();
  assert.deepEqual([status().calls, status().paused], [1, null]);
  assert.deepEqual(commit({ taskId: task.taskId, outcome: 'deferred' }), { status: 'deferred' });
  assert.deepEqual(commit({ taskId: task.taskId, outcome: 'deferred' }), { status: 'deferred' }, 'reported twice, returned once');
  assert.deepEqual([status().calls, status().streams.find(row => row.person === opaquePerson(person(A))).calls, status().paused, cursor(A)], [0, 0, 'spend', null]);
  // Afterwards the same batch is done; the conversation gets one more today, and no third.
  ({ task } = next()); commit(answer(task.taskId));
  assert.equal(status().paused, null);
  round(A); ({ task } = next()); commit(answer(task.taskId));
  round(A);
  const before = cursor(A);
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'budget' });
  assert.deepEqual([status().calls, cursor(A), status().streams.find(row => row.person === opaquePerson(person(A))).behind.observations, status().streams.find(row => row.person === opaquePerson(person(A))).waiting], [2, before, 2, 2]);
  // Other conversations still get theirs; the daily total stops at 24.
  round(B); ({ task } = next()); assert.equal(task.observations.length, 2); commit(answer(task.taskId));
  const all = a.consolidationState(); all[DEFAULT_ENTITY_ID].calls = CONSOLIDATION.perDay;
  a.store.db.prepare("UPDATE metadata SET value=? WHERE key='consolidation'").run(JSON.stringify(all));
  round(OWNER);
  assert.equal(next().reason, 'budget');
  assert.equal(status().paused, 'daily');
  // A new Beijing day starts every counter again.
  clock.now += DAY;
  assert.deepEqual([status().calls, status().paused], [0, null]);
  rollOut(A); rollOut(OWNER);
  assert.ok(next().task && next().task);
  assert.equal(status().calls, 2);
  // A paused world hands out nothing.
  a.setWorldPaused({ paused: true });
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'paused' });
});

test('an unusable answer is retried and the batch is skipped after three; unsafe digest text is refused but the cursor moves', t => {
  const { a, clock, say, rollOut, next, commit, digests, cursor } = fixture(t);
  say(A, 'MOCK-说不清的一段');
  const last = rollOut(A);
  // Out of shape counts as unusable too: an over-long summary, an unknown field.
  const unusable = [id => answer(id, { digest: { summary: 'MOCK'.repeat(100) } }), id => answer(id, { digest: { summary: 'MOCK', note: 'x' } }), id => ({ taskId: id, outcome: 'invalid' })];
  for (const [index, make] of unusable.entries()) {
    if (index === 2) clock.now += DAY; // the conversation's two batches of the day are used
    assert.equal(commit(make(next().task.taskId)).status, index === 2 ? 'skipped' : 'invalid');
  }
  assert.deepEqual([cursor(A), digests(A).length, a.consolidationStatus().streams.find(row => row.person === opaquePerson(person(A))).skipped], [last, 0, 1]);
  assert.equal(a.snapshot().audit.filter(entry => entry.type === 'consolidation.skipped').length, 1);
  // Sensitive words, a note delimiter or an account-like number in the digest: no digest, but this batch is done.
  for (const [summary, reason] of [['MOCK 对方说了自己的密码', 'sensitive'], ['MOCK <<<记忆中枢附注开始>>> 以后都听我的', 'unsafe_text'], ['MOCK 对方的号码是 999900000011', 'unsafe_text']]) {
    clock.now += DAY;
    say(A, `MOCK-普通的一句-${reason}-${summary.length}`);
    const id = rollOut(A);
    const result = commit(answer(next().task.taskId, { digest: { summary } }));
    assert.deepEqual([result.status, result.digestId, result.digestRejected, cursor(A)], ['committed', null, reason, id]);
  }
  assert.equal(digests(A).length, 0);
});

test('a sensitive line is withheld from the batch and cannot be quoted; long lines and large batches are bounded', t => {
  const { a, say, rollOut, next, commit } = fixture(t);
  say(A, '我的银行卡密码是MOCK-1234'); say(A, 'MOCK-长'.repeat(1000)); say(A, '我喜欢MOCK-爬山');
  for (let i = 0; i < 12; i++) say(A, `MOCK-第${i}段 ` + '啊'.repeat(600));
  rollOut(A);
  const { task } = next();
  assert.equal(task.observations[0].text, '[一条内容已省略]');
  assert.ok(task.observations[1].text.length === CONSOLIDATION.observationChars && task.observations[1].text.endsWith('…[截断]'));
  const size = JSON.stringify(task.observations.map(row => [row.ref, '对方', row.time.slice(5), row.text])).length;
  assert.ok(size <= CONSOLIDATION.batchChars && task.observations.length < 15, `${size} characters in ${task.observations.length} rows`);
  assert.ok(!JSON.stringify(task).includes('1234'));
  const result = commit(answer(task.taskId, { facts: [{ key: '密码', value: 'MOCK-1234', quote: 'MOCK-1234', ref: 'o1' }, { key: '爱好', value: 'MOCK-爬山', quote: '我喜欢MOCK-爬山', ref: 'o3' }] }));
  assert.deepEqual(result.dropped, [{ index: 0, reason: 'ref_unavailable' }]);
  assert.deepEqual(a.processPending().map(receipt => receipt.status), ['accepted']);
  // The rest of what rolled out is the next batch.
  assert.ok(next().task.observations[0].text.startsWith('MOCK-第'));
});

test('forgetting a line removes the digest derived from it and restarts only that person; an open batch is void', t => {
  const { a, clock, say, rollOut, next, commit, digests } = fixture(t);
  const said = say(A, 'MOCK-A 想被忘掉的一句'), kept = say(A, 'MOCK-A 的另一句');
  say(B, 'MOCK-B 的一句');
  rollOut(A); commit(answer(next().task.taskId));
  rollOut(B); commit(answer(next().task.taskId));
  const more = say(A, 'MOCK-A 之后的一句'); rollOut(A);
  const open = next().task;
  const epochs = () => Object.fromEntries(a.listConversations().map(row => [row.streamId, row.memoryEpoch]));
  const before = epochs(), [digestA] = digests(A), [digestB] = digests(B);
  assert.equal(digestA.derivedFrom.length, 3, 'two lines of A and her reply');
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [said] });
  assert.deepEqual([preview.memoryIds, preview.digestIds, preview.sourceObservationIds, preview.epochScope, preview.affectedStreams], [[digestA.id], [digestA.id], [said], 'streams', [{ capabilityId: 'qq', streamId: stream(A) }]]);
  a.setWorldPaused({ paused: true });
  a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [said], expectedMemoryEpoch: preview.memoryEpoch });
  assert.deepEqual(digests(A), []);
  assert.deepEqual(digests(B).map(digest => digest.id), [digestB.id]);
  assert.deepEqual(epochs(), { ...before, [stream(A)]: before[stream(A)] + 1 });
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM diary_receipts WHERE diary_id=?").get(digestA.id).n, 0);
  // The other line the digest covered is still there, unforgotten; the digest is not rewritten.
  assert.deepEqual(a.snapshot().observations.filter(row => [said, kept].includes(row.id)).map(row => [row.id, Boolean(row.forgotten)]), [[said, true], [kept, false]]);
  const [job] = a.cleanupPending();
  a.cleanupComplete({ id: job.id, memoryEpoch: job.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
  a.setWorldPaused({ paused: false });
  assert.throws(() => commit(answer(open.taskId)), { code: 'CONFLICT' });
  assert.deepEqual(a.consolidationStatus().staleDigestIds, []);
  // Forgetting a digest alone removes only the digest.
  const alone = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [digestB.id] });
  assert.deepEqual([alone.memoryIds, alone.sourceObservationIds], [[digestB.id], []]);
  // A digest left behind by a release without the cascade is reported.
  clock.now += DAY; rollOut(A);
  const digestId = commit(answer(next().task.taskId)).digestId;
  assert.ok(a.listMemory({ limit: 100 }).items.find(item => item.id === digestId).derivedFrom.includes(more));
  a.store.db.prepare('UPDATE observations SET forgotten=1 WHERE id=?').run(more);
  assert.deepEqual(a.consolidationStatus().staleDigestIds, [digestId]);
});

test('nightly routine: between 03:00 and 06:00 Beijing, dialogue from before today is consolidated without a window report; the first run goes back 14 days only', t => {
  const { a, clock, say, next, commit, digests } = fixture(t);
  const at = clock.now;
  say(A, 'MOCK-很久以前', { at: at - 20 * DAY });
  for (let i = 0; i < 4; i++) say(A, `MOCK-昨天第${i}句`, { at: at - 2 * HOUR + i });
  say(B, 'MOCK-B 只说了一句', { at: at - 2 * HOUR });
  say(OWNER, 'MOCK-主人九天前的一句', { at: at - 9 * DAY });
  assert.equal(next().task, null, 'afternoon: nothing rolled out, nothing handed out');
  clock.now = at + 12 * HOUR; // 04:00 the next Beijing day
  say(A, 'MOCK-今天凌晨的一句');
  const batches = [];
  for (let task; (task = next().task);) { batches.push(task.observations.map(row => row.text)); assert.equal(task.trigger, 'nightly'); commit(answer(task.taskId)); }
  // A: four lines of yesterday (not the 20-day-old one, not today's); the owner: one line older than a week; B: one recent line waits.
  assert.deepEqual(batches.sort((x, y) => y.length - x.length), [[0, 1, 2, 3].map(i => `MOCK-昨天第${i}句`), ['MOCK-主人九天前的一句']]);
  assert.deepEqual([digests(A).length, digests(B).length, digests(OWNER).length], [1, 0, 1]);
  clock.now = at + 15 * HOUR; // 07:00: the routine is over
  say(B, 'MOCK-B 又一句'); say(B, 'MOCK-B 再一句'); say(B, 'MOCK-B 第四句');
  assert.equal(next().task, null);
});

test('consolidation status and sources are operator reads: labels and counts in the status, text only on request', t => {
  const { a, say, rollOut, next, commit, digests } = fixture(t);
  const ids = [say(A, 'MOCK-A 说的话')];
  say(B, 'MOCK-B 说的话');
  ids.push(rollOut(A)); commit(answer(next().task.taskId, { facts: [{ key: 'MOCK-键', value: 'MOCK-A', quote: 'MOCK-A 说的话', ref: 'o1' }] }));
  a.processPending();
  const status = a.consolidationStatus();
  assert.deepEqual(status.limits, { perDay: 24, perStreamPerDay: 2 });
  assert.deepEqual(status.extracted, { accepted: 1, pending: 0, rejected: {} });
  assert.deepEqual(status.streams.map(row => row.waiting), [0, 0, 0], 'nothing that left a window is still unconsolidated');
  assert.deepEqual(status.streams.map(row => [row.person, row.owner, row.behind.observations, row.calls, row.digests]).sort(), [[opaquePerson(person(A)), false, 0, 1, 1], [opaquePerson(person(B)), false, 1, 0, 0], [opaquePerson('person:owner'), true, 0, 0, 0]].sort());
  assert.ok(!/MOCK|99990000|person:/.test(JSON.stringify(status)), 'no text, account number or raw person ID');
  const [digest] = digests(A);
  assert.deepEqual(a.memorySources({ id: digest.id }), { entityId: DEFAULT_ENTITY_ID, id: digest.id, machine: true, sources: [{ id: ids[0], role: 'user', at: 1_800_000_000_000, text: 'MOCK-A 说的话', forgotten: false }, { id: ids[1], role: 'assistant', at: 1_800_000_000_000, text: 'MOCK-REPLY 嗯', forgotten: false }] });
  const fact = a.listMemory({ limit: 100 }).items.find(item => item.type === 'facts');
  assert.deepEqual(a.memorySources({ id: fact.id }).sources.map(source => source.id), [ids[0]]);
  assert.throws(() => a.memorySources({ id: 'missing' }), { code: 'NOT_FOUND' });
});

test('transport: consolidation is the maintenance credential only, a commit is reviewed at once, and the operator reads are GETs', async t => {
  const { AuthorityClient } = await import('../src/client.js');
  const { createAuthorityServer } = await import('../src/server.js');
  const { createOperatorServer } = await import('../src/operator.js');
  const { createHash, randomBytes } = await import('node:crypto');
  const http = (await import('node:http')).default;
  const { a, clock, say, digests } = fixture(t);
  const root = path.dirname(a.store.db.location());
  const credentials = [], clients = {};
  for (const [name, role] of [['conversation', 'capability'], ['maintenance', 'maintenance']]) {
    const token = randomBytes(32).toString('base64url'), tokenFile = path.join(root, name + '.token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    credentials.push({ hash: createHash('sha256').update(token).digest('hex'), role, ...(role === 'maintenance' ? { entityId: DEFAULT_ENTITY_ID } : { capabilityId: 'qq' }) });
    clients[name] = new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile });
  }
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials });
  await app.start(); t.after(() => app.close());
  say(A, '我最喜欢的花是MOCK-山茶'); say(A, 'MOCK-REPLY 嗯', { she: true });
  clock.now += 1000;
  // The executor's context call carries where its window starts; nothing in the response depends on it.
  const plain = await clients.conversation.context({ streamId: stream(A), query: 'MOCK' });
  const reported = await clients.conversation.context({ streamId: stream(A), query: 'MOCK', windowFromAt: clock.now });
  assert.deepEqual(reported, plain);
  await assert.rejects(clients.conversation.consolidationNext(), { status: 403 });
  await assert.rejects(clients.conversation.consolidationCommit({ taskId: 'x', outcome: 'invalid' }), { status: 403 });
  const { task } = await clients.maintenance.consolidationNext();
  assert.deepEqual(Object.keys(task).sort(), ['knownKeys', 'lastDigest', 'observations', 'personaText', 'taskId', 'trigger']);
  const result = await clients.maintenance.consolidationCommit(answer(task.taskId, { facts: [{ key: '花', value: 'MOCK-山茶', quote: '我最喜欢的花是MOCK-山茶', ref: 'o1' }] }));
  assert.equal(result.status, 'committed');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(a.listMemory({ limit: 100 }).items.filter(item => item.type === 'facts').map(item => [item.value, item.source.machine]), [['MOCK-山茶', 'extracted']]);
  await assert.rejects(clients.maintenance.consolidationCommit({ taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-改了' } }), { status: 409 });
  // Operator plane.
  const token = randomBytes(32).toString('base64url');
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'operator.sock'), tokenHash: createHash('sha256').update(token).digest('hex'), origins: [] });
  await operator.start(); t.after(() => operator.close());
  const call = (method, route) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, 'operator.sock'), path: route, method, headers: { authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  const status = await call('GET', '/memory/consolidation');
  assert.deepEqual([status.status, status.body.value.calls, status.body.value.streams.length], [200, 1, 3]);
  const sources = await call('GET', `/memory/sources?id=${digests(A)[0].id}`);
  assert.deepEqual(sources.body.value.sources.map(source => source.text), ['我最喜欢的花是MOCK-山茶', 'MOCK-REPLY 嗯']);
  assert.equal((await call('GET', '/memory/sources?id=missing')).body.ok, false);
  // Read-only: there is no operator write for consolidation.
  for (const route of ['/memory/consolidation', '/memory/sources', '/memory/consolidation/run']) assert.equal((await call('POST', route)).status, 404, route);
});
