import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { AuthorityClient } from '../src/client.js';
import { createAuthorityServer, ROOM_DIARY_PER_MINUTE } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';
import { CONSOLIDATION } from '../src/consolidation.js';
import { DIARY } from '../src/diary.js';
import { OPEN_DIARY } from '../src/open-diary.js';
import { DEFAULT_CARD_ID } from '../src/cards.js';
import { opaquePerson } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const HOUR = 3600000, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => uid === OWNER ? 'person:owner' : `person:qq:${uid}`;
// Beijing days: day 0 is 2027-01-15; `at(day, hour)` is that hour of that Beijing day.
const DAY0 = 1_800_000_000_000 - 16 * HOUR, at = (day, hour = 12) => DAY0 + day * DAY + hour * HOUR;
const dayName = day => new Date(at(day, 12) + 8 * HOUR).toISOString().slice(0, 10);
const REASON = 'MOCK-原因';
const CODE = new RegExp(`^[${OPEN_DIARY.alphabet}]{${OPEN_DIARY.codeChars}}$`);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-open-diary-')), file = path.join(root, 'world.sqlite');
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
  const chat = (uid, text, summary, { feeling = '' } = {}) => {
    const line = say(uid, text); say(uid, 'MOCK-REPLY 嗯', { she: true }); clock.now += 1000;
    a.context('qq', { streamId: stream(uid), query: 'MOCK', windowFromAt: clock.now });
    const { task } = a.consolidationNext(DEFAULT_ENTITY_ID);
    assert.equal(a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', digest: { summary, feeling }, facts: [] }).status, 'committed');
    a.processPending();
    return line;
  };
  const next = () => a.diaryNext(DEFAULT_ENTITY_ID);
  const commit = input => a.diaryCommit(DEFAULT_ENTITY_ID, input);
  /** The private diary now due, written from everything given. */
  const writePrivate = (text = 'MOCK-私密日记') => {
    const { task } = next();
    assert.ok(task && task.kind === undefined, 'a private diary is due');
    return { task, result: commit({ taskId: task.taskId, outcome: 'ok', private: { text }, usedIds: [...task.digests, ...task.notes].map(row => row.ref) }) };
  };
  /** The open diary now due, written from every digest given. */
  const writeOpen = text => {
    const { task } = next();
    assert.equal(task?.kind, 'open', 'an open diary is due');
    return { task, result: commit({ taskId: task.taskId, outcome: 'ok', open: { text }, usedIds: task.digests.map(row => row.ref) }) };
  };
  const list = uids => { for (const uid of uids) a.setOpenDiaryListed({ personId: person(uid), listed: true }); };
  const diaries = kind => a.listMemory({ limit: 100 }).diaries.filter(diary => diary.v === 2 && (!kind || diary.kind === kind));
  const body = id => JSON.parse(a.store.db.prepare('SELECT body FROM diaries WHERE id=?').get(id).body);
  const state = () => a.consolidationState()[DEFAULT_ENTITY_ID];
  const read = code => a.roomDiary({ code }).diaries;
  return { a, root, clock, say, chat, next, commit, writePrivate, writeOpen, list, diaries, body, state, read };
}

test('the list holds the owner alone by default: someone off it gets no open diary, the owner gets one after the private diary, and only with material', t => {
  const { a, clock, chat, next, writePrivate, writeOpen, diaries, body } = fixture(t);
  assert.deepEqual(a.openDiaryRoster(DEFAULT_ENTITY_ID), ['person:owner']);
  // Day 0: only A (not on the list) talks. The private diary is written; no open diary is asked for.
  chat(A, '我家的猫叫MOCK-煤球', 'MOCK-摘要甲：对方的猫叫煤球。');
  clock.now = at(1, 5);
  writePrivate();
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  assert.deepEqual(diaries('open'), []);
  // Day 1: the owner and A talk. Private first, then exactly one open diary, the owner's.
  clock.now = at(1, 12); chat(OWNER, '我今天去MOCK-钓鱼了', 'MOCK-摘要主人：对方去钓鱼。', { feeling: 'MOCK-感受主人' });
  clock.now = at(1, 13); chat(A, 'MOCK-甲第1天', 'MOCK-摘要甲第1天：煤球生病了。');
  clock.now = at(2, 5);
  assert.equal(next().task.kind, undefined, 'the private diary comes first');
  writePrivate('MOCK-私密第1天：主人去钓鱼，甲的猫病了。');
  const { task, result } = writeOpen('MOCK-明面：写给主人的一天。');
  // The request holds the owner's own digest and nothing else: no label, no note, no earlier diary, nothing of A.
  assert.deepEqual(Object.keys(task).sort(), ['day', 'digests', 'kind', 'personaText', 'taskId']);
  assert.deepEqual(task.digests, [{ ref: 'd1', time: '12:00', summary: 'MOCK-摘要主人：对方去钓鱼。', feeling: 'MOCK-感受主人' }]);
  for (const foreign of ['煤球', 'MOCK-摘要甲', 'MOCK-私密', 'person:', OWNER, A, opaquePerson('person:owner')]) assert.ok(!JSON.stringify(task).includes(foreign), foreign);
  assert.deepEqual(result, { status: 'committed', day: dayName(1), kind: 'open', openId: result.openId });
  assert.deepEqual(body(result.openId), { v: 2, day: dayName(1), text: 'MOCK-明面：写给主人的一天。', cardId: DEFAULT_CARD_ID, personId: 'person:owner', taskId: task.taskId, at: clock.now });
  assert.deepEqual({ ...a.store.db.prepare('SELECT kind,status FROM diaries WHERE id=?').get(result.openId) }, { kind: 'open', status: 'open' });
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM diary_sources WHERE diary_id=?').get(result.openId).n, 1);
  // Nothing more that day: A is not on the list, and the owner's is written once.
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  assert.deepEqual(diaries('open').map(diary => [diary.day, diary.personLabel, diary.personIsOwner, diary.personId]), [[dayName(1), opaquePerson('person:owner'), true, undefined]]);
  // The operator listing never carries a person ID (it may hold an account number).
  assert.ok(!JSON.stringify(a.listMemory({ limit: 100 }).diaries).includes('person:'));
});

test('each listed person gets a diary from their own digests only: a word of B is never in A\'s request, and the other way round', t => {
  const { a, clock, chat, next, commit, writePrivate, writeOpen, list, diaries, state } = fixture(t);
  list([A, B]);
  assert.deepEqual(a.openDiaryRoster(DEFAULT_ENTITY_ID), ['person:owner', person(A), person(B)]);
  chat(A, '我周末去了MOCK-海边潜水', 'MOCK-摘要甲：对方说周末去MOCK-海边潜水。', { feeling: 'MOCK-感受甲' });
  chat(B, '我在学MOCK-大提琴', 'MOCK-摘要乙：对方说在学MOCK-大提琴。', { feeling: 'MOCK-感受乙' });
  clock.now = at(1, 5);
  const first = next().task;
  // The private diary mixes everyone; it is the only request that does.
  assert.ok(JSON.stringify(first).includes('MOCK-海边潜水') && JSON.stringify(first).includes('MOCK-大提琴'));
  commit({ taskId: first.taskId, outcome: 'ok', private: { text: 'MOCK-私密：潜水和大提琴。' }, usedIds: ['d1', 'd2'] });
  const forA = writeOpen('MOCK-明面给甲');
  assert.ok(JSON.stringify(forA.task).includes('MOCK-海边潜水') && JSON.stringify(forA.task).includes('MOCK-感受甲'));
  for (const foreign of ['大提琴', 'MOCK-摘要乙', 'MOCK-感受乙', 'MOCK-私密']) assert.ok(!JSON.stringify(forA.task).includes(foreign), foreign);
  const forB = writeOpen('MOCK-明面给乙');
  assert.ok(JSON.stringify(forB.task).includes('MOCK-大提琴'));
  for (const foreign of ['潜水', 'MOCK-摘要甲', 'MOCK-感受甲', 'MOCK-私密', 'MOCK-明面给甲']) assert.ok(!JSON.stringify(forB.task).includes(foreign), foreign);
  // The owner is on the list but said nothing that day: no request, no diary.
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'idle' });
  assert.deepEqual(diaries('open').map(diary => [diary.personLabel, diary.text]).sort(), [[opaquePerson(person(A)), 'MOCK-明面给甲'], [opaquePerson(person(B)), 'MOCK-明面给乙']].sort());
  // One call each, counted with the day's consolidation batches (a new Beijing day began at zero).
  assert.equal(state().calls, 3);
  assert.deepEqual([state().openDiary.people[person(A)].lastDay, state().openDiary.people[person(B)].lastDay, state().openDiary.people['person:owner']], [dayName(0), dayName(0), undefined]);
  // Taken off the list: no more diaries for B; A still gets one.
  a.setOpenDiaryListed({ personId: person(B), listed: false });
  clock.now = at(1, 12); chat(A, 'MOCK-甲第1天', 'MOCK-摘要甲第1天'); chat(B, 'MOCK-乙第1天', 'MOCK-摘要乙第1天');
  clock.now = at(2, 5); writePrivate(); writeOpen('MOCK-明面给甲第1天');
  assert.equal(next().task, null);
  assert.equal(diaries('open').filter(diary => diary.personLabel === opaquePerson(person(B))).length, 1);
});

test('an open diary is held to the private diary\'s checks: shape, 500 characters, usedIds of the request, the sensitive lexicon; three unusable answers give that person\'s day up', t => {
  const { a, clock, chat, next, commit, writePrivate, list, diaries, state } = fixture(t);
  list([A]);
  chat(A, 'MOCK-第0天', 'MOCK-摘要甲第0天'); chat(OWNER, 'MOCK-主人第0天', 'MOCK-摘要主人第0天');
  clock.now = at(1, 5); writePrivate();
  // The owner's comes first. The private field does not count for an open request; nor do a long text or a foreign ref.
  const owner = next().task;
  assert.equal(owner.kind, 'open');
  for (const answer of [{ private: { text: 'MOCK-写错了栏' } }, { open: { text: '字'.repeat(DIARY.textChars + 1) } }, { open: { text: 'MOCK-明面', extra: 1 } }]) {
    assert.deepEqual(commit({ taskId: next().task.taskId, outcome: 'ok', ...answer, usedIds: ['d1'] }), { status: answer.open?.extra ? 'skipped' : 'invalid' });
  }
  // Three unusable answers: the owner's day is given up (audit without text); A's diary of the same day is still written.
  assert.deepEqual([state().openDiary.people['person:owner'].lastDay, state().openDiary.skipped], [dayName(0), 1]);
  const forA = next().task;
  assert.ok(JSON.stringify(forA).includes('MOCK-摘要甲第0天') && !JSON.stringify(forA).includes('主人'));
  assert.deepEqual(commit({ taskId: forA.taskId, outcome: 'ok', open: { text: 'MOCK-明面' }, usedIds: ['d2'] }), { status: 'invalid' });
  assert.equal(next().task.taskId, forA.taskId);
  // The spend tier refused the call: uncounted, still due.
  const counted = state().calls;
  assert.deepEqual(commit({ taskId: forA.taskId, outcome: 'deferred' }), { status: 'deferred' });
  assert.equal(state().calls, counted - 1);
  // A text matching the sensitive lexicon is not stored; the day is done all the same.
  const again = next().task;
  const refused = commit({ taskId: again.taskId, outcome: 'ok', open: { text: 'MOCK-明面：密码是 hunter2。' }, usedIds: ['d1'] });
  assert.deepEqual(refused, { status: 'committed', day: dayName(0), kind: 'open', openId: null, rejected: 'sensitive' });
  assert.deepEqual(commit({ taskId: again.taskId, outcome: 'ok', open: { text: 'MOCK-明面：密码是 hunter2。' }, usedIds: ['d1'] }), { status: 'committed', replayed: true });
  assert.deepEqual(diaries('open'), []);
  assert.equal(next().task, null);
  const audit = a.store.db.prepare("SELECT body FROM audit WHERE json_extract(body,'$.type') LIKE 'diary.%'").all().map(row => row.body).join('\n');
  assert.ok(audit.includes('"kind":"open"') && !audit.includes('MOCK-明面') && !audit.includes(A) && !audit.includes('hunter2'));
  // Every batch of the day used: an open diary waits like anything else.
  clock.now = at(1, 12); chat(A, 'MOCK-第1天', 'MOCK-摘要甲第1天'); clock.now = at(2, 5); writePrivate();
  const all = a.consolidationState(); all[DEFAULT_ENTITY_ID].calls = CONSOLIDATION.perDay; a.saveConsolidationState(all);
  assert.deepEqual(next(), { entityId: DEFAULT_ENTITY_ID, task: null, reason: 'budget' });
});

test('forgetting a line of A removes A\'s digest and the open diary written from it; B\'s open diary stays', t => {
  const { a, clock, chat, writePrivate, writeOpen, list, diaries } = fixture(t);
  list([A, B]);
  const line = chat(A, '我周末去了MOCK-海边潜水', 'MOCK-摘要甲：对方说周末去潜水。');
  chat(B, '我在学MOCK-大提琴', 'MOCK-摘要乙：对方说在学大提琴。');
  clock.now = at(1, 5);
  const secret = writePrivate().result, forA = writeOpen('MOCK-明面给甲：潜水真好。').result, forB = writeOpen('MOCK-明面给乙：大提琴真好。').result;
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [line] });
  assert.deepEqual([...preview.diaryIds].sort(), [secret.privateId, forA.openId].sort());
  // A's open diary holds nothing but A's: only the private diary is "mixed".
  assert.deepEqual(preview.mixedDiaryIds, [secret.privateId]);
  a.setWorldPaused({ paused: true });
  a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [line], expectedMemoryEpoch: preview.memoryEpoch });
  assert.deepEqual(diaries().map(diary => diary.id), [forB.openId]);
  assert.ok(!JSON.stringify(a.store.db.prepare('SELECT body FROM diaries').all()).includes('潜水'));
});

test('passcode: only for someone on the list, in their own private conversation; asking again replaces it; it reads that person\'s diaries whatever card is current', t => {
  const { a, clock, chat, writePrivate, writeOpen, list, read, body } = fixture(t);
  list([A]);
  // B is not on the list; a conversation that is not bound at all is refused.
  assert.deepEqual(a.diaryCode('qq', { streamId: stream(B) }), { listed: false });
  assert.throws(() => a.diaryCode('qq', { streamId: stream('999900000099') }), { code: 'FORBIDDEN' });
  assert.throws(() => a.diaryCode('qq', { streamId: stream(A), personId: person(B) }), { code: 'VALIDATION_ERROR' });
  const issued = a.diaryCode('qq', { streamId: stream(A) });
  assert.deepEqual(Object.keys(issued), ['listed', 'code']);
  assert.ok(issued.listed && CODE.test(issued.code));
  // Only a hash is kept, and nothing is observed or audited with the passcode in it.
  const everything = JSON.stringify(a.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => a.store.db.prepare(`SELECT * FROM "${name}"`).all()));
  assert.ok(!everything.includes(issued.code));
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE json_extract(body,'$.text') LIKE '%口令%'").get().n, 0);
  // Days 0 and 1 for A and the owner, day 1 under another persona card.
  chat(A, 'MOCK-甲第0天', 'MOCK-摘要甲第0天'); chat(OWNER, 'MOCK-主人第0天', 'MOCK-摘要主人第0天');
  clock.now = at(1, 5); writePrivate(); writeOpen('MOCK-明面给主人第0天'); writeOpen('MOCK-明面给甲第0天');
  const { id: other } = a.createPersonaCard({ title: 'MOCK-乙卡' });
  a.activatePersonaCard({ id: other, reason: REASON });
  clock.now = at(1, 12); chat(A, 'MOCK-甲第1天', 'MOCK-摘要甲第1天');
  clock.now = at(2, 5); writePrivate();
  const second = writeOpen('MOCK-明面给甲第1天').result;
  assert.equal(body(second.openId).cardId, other);
  // A reads both days, newest first, although another card is current now; nothing of the owner's, no id, no card.
  assert.deepEqual(read(issued.code), [{ day: dayName(1), text: 'MOCK-明面给甲第1天' }, { day: dayName(0), text: 'MOCK-明面给甲第0天' }]);
  assert.deepEqual(read(`  ${issued.code.toUpperCase()} `), read(issued.code));
  a.activatePersonaCard({ id: DEFAULT_CARD_ID, reason: REASON });
  assert.equal(read(issued.code).length, 2);
  // Every wrong passcode fails the same way, whatever is wrong with it.
  const failure = value => { try { a.roomDiary(value); } catch (error) { return [error.code, error.statusCode, error.message]; } return null; };
  const expected = ['NOT_FOUND', 404, 'No diary for this passcode'];
  const wrong = issued.code.slice(0, -1) + (issued.code.endsWith('a') ? 'b' : 'a');
  for (const value of [{ code: wrong }, { code: '' }, { code: 'x' }, { code: 'x'.repeat(500) }, { code: 12345678 }, { code: null }, {}, null, { code: opaquePerson(person(A)) }, { code: person(A) }]) assert.deepEqual(failure(value), expected);
  // Asking again makes a new one; the old one is like any wrong one. The owner's reset does the same and is shown once.
  const renewed = a.diaryCode('qq', { streamId: stream(A) }).code;
  assert.notEqual(renewed, issued.code);
  assert.deepEqual([failure({ code: issued.code }), read(renewed).length], [expected, 2]);
  const reset = a.resetOpenDiaryCode({ personId: person(A) });
  assert.deepEqual([Object.keys(reset), CODE.test(reset.code), reset.label], [['entityId', 'personId', 'label', 'code', 'codeAt'], true, opaquePerson(person(A))]);
  assert.deepEqual([failure({ code: renewed }), read(reset.code).length], [expected, 2]);
  assert.throws(() => a.resetOpenDiaryCode({ personId: person(B) }), { code: 'CONFLICT' });
  // The owner has a passcode of their own and reads only their own diary.
  const owner = a.diaryCode('qq', { streamId: stream(OWNER) }).code;
  assert.deepEqual(read(owner), [{ day: dayName(0), text: 'MOCK-明面给主人第0天' }]);
  // Only the last 30 days are shown.
  clock.now = at(1 + OPEN_DIARY.readDays, 12);
  assert.deepEqual(read(reset.code).map(diary => diary.day), [dayName(1)]);
  // Off the list: the passcode is gone, the diaries stay; back on it, a new passcode reads them again.
  a.setOpenDiaryListed({ personId: person(A), listed: false });
  assert.deepEqual(failure({ code: reset.code }), expected);
  assert.deepEqual(a.diaryCode('qq', { streamId: stream(A) }), { listed: false });
  a.setOpenDiaryListed({ personId: person(A), listed: true });
  assert.deepEqual(failure({ code: reset.code }), expected);
  assert.equal(read(a.diaryCode('qq', { streamId: stream(A) }).code).length, 1);
  // The list as the console sees it: no passcode, no hash.
  const listing = a.openDiaryList();
  assert.deepEqual(listing.people.map(row => [row.personId, row.owner, row.listed, row.hasCode, row.diaries, row.lastDay]),
    [['person:owner', true, true, true, 1, dayName(0)], [person(A), false, true, true, 2, dayName(1)], [person(B), false, false, false, 0, null]]);
  assert.ok(!/codeHash|[a-f0-9]{64}/.test(JSON.stringify(listing)));
  assert.throws(() => a.setOpenDiaryListed({ personId: 'person:qq:999900000077', listed: true }), { code: 'VALIDATION_ERROR' });
});

test('no schema change: the list and the passcodes are one metadata key; a database without it has the owner alone on the list', t => {
  const { a, clock, chat, writePrivate, writeOpen, list } = fixture(t);
  const shape = () => JSON.stringify([a.store.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(), a.store.db.prepare('PRAGMA user_version').get()]);
  const before = shape(), keys = () => a.store.db.prepare('SELECT key FROM metadata ORDER BY key').all().map(row => row.key);
  assert.ok(!keys().includes('openDiary'));
  chat(OWNER, 'MOCK-主人第0天', 'MOCK-摘要主人第0天'); clock.now = at(1, 5); writePrivate(); writeOpen('MOCK-明面');
  // Writing the default list's diary stores no list.
  assert.ok(!keys().includes('openDiary'));
  list([A]); a.diaryCode('qq', { streamId: stream(A) });
  assert.ok(keys().includes('openDiary'));
  assert.equal(shape(), before);
  const stored = JSON.parse(a.store.db.prepare("SELECT value FROM metadata WHERE key='openDiary'").get().value);
  assert.deepEqual(Object.keys(stored[DEFAULT_ENTITY_ID].people), ['person:owner', person(A)]);
  assert.deepEqual(Object.keys(stored[DEFAULT_ENTITY_ID].people[person(A)]), ['codeHash', 'codeAt']);
  // The owner may leave the list too: then nobody gets one.
  a.setOpenDiaryListed({ personId: 'person:owner', listed: false }); a.setOpenDiaryListed({ personId: person(A), listed: false });
  assert.deepEqual(a.openDiaryRoster(DEFAULT_ENTITY_ID), []);
  clock.now = at(1, 12); chat(OWNER, 'MOCK-主人第1天', 'MOCK-摘要主人第1天'); clock.now = at(2, 5); writePrivate();
  assert.equal(a.diaryNext(DEFAULT_ENTITY_ID).task, null);
});

test('routes: the room grant gains POST /v1/room/diary and nothing else; a channel asks for a passcode for its own conversation; attempts are limited per minute', async t => {
  const { a, root, clock, chat, writePrivate, writeOpen } = fixture(t);
  const socketPath = path.join(root, 'api.sock'), tokens = {}, credentials = [];
  for (const [name, extra] of [['room', {}], ['capability', { capabilityId: 'qq' }], ['maintenance', { entityId: DEFAULT_ENTITY_ID }], ['admin', {}]]) {
    tokens[name] = randomBytes(32).toString('hex');
    credentials.push({ hash: createHash('sha256').update(tokens[name]).digest('hex'), role: name, ...extra });
  }
  const app = createAuthorityServer({ authority: a, socketPath, credentials });
  await app.start(); t.after(() => app.close());
  const call = (target, token) => (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: target, path: route, method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8'), body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const as = Object.fromEntries(Object.entries(tokens).map(([name, token]) => [name, call(socketPath, token)]));
  chat(OWNER, '我今天去MOCK-钓鱼了', 'MOCK-摘要主人：对方去钓鱼。');
  clock.now = at(1, 5); writePrivate('MOCK-私密：不给任何人看。'); writeOpen('MOCK-明面：写给主人的一天。');
  // A channel asks for the passcode of one of its own conversations; nobody else may.
  const tokenFile = path.join(root, 'capability.token'); fs.writeFileSync(tokenFile, tokens.capability, { mode: 0o600 });
  const { code } = await new AuthorityClient({ socketPath, tokenFile }).diaryCode({ streamId: stream(OWNER) });
  assert.match(code, CODE);
  for (const name of ['room', 'maintenance', 'admin']) assert.equal((await as[name]('POST', '/v1/diary/code', { streamId: stream(OWNER) })).status, 403, name);
  assert.equal((await as.capability('POST', '/v1/diary/code', { streamId: stream(OWNER), personId: 'person:owner' })).status, 400);
  // The room grant: the passcode reads that person's open diaries, in a closed shape.
  const ok = await as.room('POST', '/v1/room/diary', { code });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, value: { diaries: [{ day: dayName(0), text: 'MOCK-明面：写给主人的一天。' }] } }]);
  assert.ok(!ok.raw.includes('MOCK-私密') && !ok.raw.includes('person'));
  // Wrong passcodes: one answer, byte for byte.
  const wrong = await as.room('POST', '/v1/room/diary', { code: 'aaaaaaaa' });
  assert.equal(wrong.status, 404);
  for (const value of ['', 'zz', code + 'a', 'p-000000']) assert.equal((await as.room('POST', '/v1/room/diary', { code: value })).raw, wrong.raw);
  // Nobody else reads it, and the room grant still reads nothing else.
  for (const name of ['capability', 'maintenance', 'admin']) assert.equal((await as[name]('POST', '/v1/room/diary', { code })).status, 403, name);
  assert.equal((await as.room('GET', '/v1/room/diary')).status, 403);
  for (const route of ['/v1/diary/code', '/v1/context', '/v1/memory/search', '/v1/maintenance/diary/next', '/v1/admin/persona', '/v1/room', '/v1/room/diary/x']) assert.equal((await as.room('POST', route, {})).status, 403, route);
  // The room's public state is what it was: a closed set of categories, nothing of any diary or passcode.
  const state = await as.room('GET', '/v1/room');
  assert.deepEqual(Object.keys(state.body.value), ['version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose']);
  assert.ok(!state.raw.includes('MOCK') && !state.raw.includes(code) && !/diar/i.test(state.raw));
  // The limit: every attempt of the minute counts, right or wrong; over it even the right passcode is refused.
  for (let made = 6; made < ROOM_DIARY_PER_MINUTE; made++) assert.equal((await as.room('POST', '/v1/room/diary', { code })).status, 200, 'attempt ' + (made + 1));
  for (const value of [code, 'aaaaaaaa']) { const over = await as.room('POST', '/v1/room/diary', { code: value }); assert.deepEqual([over.status, over.body.error.code], [429, 'RATE_LIMITED']); }
  assert.equal((await as.room('GET', '/v1/room')).status, 200);
  // The operator: the list, a change to it, a reset (the passcode is returned once).
  const token = randomBytes(32).toString('base64url');
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'operator.sock'), tokenHash: createHash('sha256').update(token).digest('hex'), origins: [] });
  await operator.start(); t.after(() => operator.close());
  const owner = call(path.join(root, 'operator.sock'), token);
  const listed = await owner('GET', '/diary/open');
  assert.deepEqual(listed.body.value.people.map(row => [row.owner, row.listed, row.hasCode, row.diaries]), [[true, true, true, 1], [false, false, false, 0], [false, false, false, 0]]);
  const changed = await owner('POST', '/diary/open/listed', { personId: person(A), listed: true });
  assert.deepEqual(changed.body.value.people.map(row => row.listed), [true, true, false]);
  assert.equal((await owner('POST', '/diary/open/listed', { personId: person(A), listed: 'yes' })).status, 400);
  const reset = await owner('POST', '/diary/open/code', { personId: person(A) });
  assert.match(reset.body.value.code, CODE);
  assert.equal((await owner('POST', '/diary/open/code', { personId: person(B) })).status, 409);
  assert.deepEqual((await owner('GET', '/memory')).body.value.diaries.map(diary => [diary.kind, diary.personIsOwner]), [['open', true], ['private', undefined]]);
});

test('the staging trigger is used up once the running day has nothing left to hand out: a digest that arrives later the same day waits', t => {
  const { a, clock, chat, next, writePrivate, writeOpen, diaries, state } = fixture(t);
  chat(OWNER, 'MOCK-主人上午', 'MOCK-摘要主人上午');
  a.diaryTrigger({});
  writePrivate(); writeOpen('MOCK-明面上午');
  assert.equal(state().diary.liveDay, dayName(0));
  assert.equal(a.consolidationStatus().diary.liveDay, dayName(0));
  // Nothing is left for the running day: this idle answer ends the trigger.
  assert.equal(next().task, null);
  assert.equal(state().diary.liveDay, undefined);
  assert.equal(a.consolidationStatus().diary.liveDay, null);
  a.setOpenDiaryListed({ personId: person(A), listed: true });
  clock.now += HOUR; chat(A, 'MOCK-甲下午', 'MOCK-摘要甲下午');
  assert.equal(next().task, null);
  // Another trigger writes A's; the owner's and the private diary of the day are written already.
  a.diaryTrigger({});
  assert.deepEqual(writeOpen('MOCK-明面甲').task.digests.map(row => row.summary), ['MOCK-摘要甲下午']);
  assert.equal(next().task, null);
  assert.deepEqual(diaries().map(diary => diary.kind).sort(), ['open', 'open', 'private']);
});
