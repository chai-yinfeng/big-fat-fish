import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { opaquePerson } from '../src/context.js';
import { SELF_PERSON, WAKE, REACH, REASON_CATEGORIES, nextWake, refusedReason, refusedText, repeatsWords, withoutLabels, renderBriefing, renderCard, renderReachEvent } from '../src/wake.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012', C = '999900000013';
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => `person:qq:${uid}`, label = uid => opaquePerson(uid === OWNER ? 'person:owner' : person(uid));
const OWN = 'qq:self';
// Nothing that identifies a person outside Authority: no account number, person ID or channel conversation ID.
const IDENTIFYING = /9999\d{8}|person:|private:/;
// 2027-01-15 16:00 in Beijing.
const START = 1_800_000_000_000, MIDNIGHT = START - 16 * HOUR;
function fixture(t, { quiet = 'none' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-wake-'));
  // `random.value` 0.5 makes every schedule shift zero.
  const clock = { now: START }, random = { value: 0.5 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now, random: () => random.value });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  if (quiet === 'none') a.initiationSettings({ quietHours: { from: '00:00', to: '00:00' } });
  let seq = 0;
  const say = (uid, text, { she = false } = {}) => a.observe('qq', { eventId: `e-${++seq}`, streamId: stream(uid), actorId: she ? 'qq:model' : `qq:${SELF}:user:${uid}`, role: she ? 'assistant' : 'user', text, at: clock.now }).observationId;
  const propose = (observationId, type, payload) => { const proposalId = `p-${++seq}`; a.submit('qq', { proposalId, observationId, type, payload }); a.processPending(); return a.getReceipt('qq', proposalId); };
  /** One exchange with `uid` now, rolled out of the window and consolidated into a machine digest. */
  const chat = (uid, text, summary) => {
    say(uid, text); say(uid, 'MOCK-REPLY 嗯', { she: true }); clock.now += 1000;
    a.context('qq', { streamId: stream(uid), query: 'MOCK', windowFromAt: clock.now });
    const { task } = a.consolidationNext(DEFAULT_ENTITY_ID);
    assert.equal(a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', digest: { summary }, facts: [] }).status, 'committed');
    a.processPending();
  };
  const next = (input = {}) => a.initiationNext('qq', input);
  const view = () => a.initiativeView();
  const settings = input => a.initiationSettings(input);
  /** Both switches on, and the people named (besides the owner, whose switch is on to begin with). */
  const enable = (...uids) => settings({ wake: { enabled: true }, reach: { enabled: true, ...(uids.length ? { people: Object.fromEntries(uids.map(uid => [label(uid), true])) } : {}) } });
  const wakeNow = () => { a.initiativeWake(); return next().initiation; };
  const done = id => a.initiationAck('qq', { id, outcome: 'done' });
  const reach = (...items) => a.selfRecord('qq', { streamId: OWN, reach: items.map(([uid, reason]) => ({ label: typeof uid === 'string' && uid.startsWith('p-') ? uid : label(uid), reason })) }).reach;
  return { a, clock, random, say, propose, chat, next, view, settings, enable, wakeNow, done, reach };
}

test('off until the operator turns it on: nothing is scheduled or handed out, a wake-up asked for meanwhile is only counted, and every person switch but the owner\'s starts off', t => {
  const { a, next, view, clock, settings } = fixture(t);
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  const shown = view();
  assert.deepEqual([shown.wake, shown.reach.enabled, shown.reach.recentMinutes, shown.reach.fuses, shown.fuse, shown.nextAt, shown.log, shown.moods, shown.notes],
    [{ enabled: false, times: ['10:00', '19:00'], maxTimes: 2, jitterMinutes: 30 }, false, 30, { per_day: 20, per_person_day: 4, per_person_week: 12, per_hour: 3 }, null, null, [], [], []]);
  assert.deepEqual(shown.reach.people.map(item => [item.person, item.owner, item.enabled]), [[label(OWNER), true, true], ...[A, B].map(uid => [label(uid), false, false]).sort((x, y) => x[0] < y[0] ? -1 : 1)]);
  assert.doesNotMatch(JSON.stringify(shown), IDENTIFYING);
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now, blocked: 'off' });
  clock.now += 4 * HOUR;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual(view().log.map(entry => [entry.type, entry.counts]), [['skip', { off: 1 }]]);
  // Not counted again on later polls, and her own conversation was never bound.
  next(); next();
  assert.deepEqual(view().log[0].counts, { off: 1 });
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM streams WHERE stream_id=?').get(OWN).n, 0);
  const invalid = [{}, { wake: {}, extra: 1 }, { wake: { enabled: 'yes' } }, { wake: { perDay: 8 } }, { wake: { times: [] } }, { wake: { times: ['10:00', '12:00', '19:00'] } }, { wake: { times: ['25:00'] } }, { wake: { times: ['10:00', '10:00'] } },
    { reach: { enabled: 1 } }, { reach: { people: { [label(C)]: true } } }, { reach: { people: { [person(A)]: true } } }, { reach: { people: { [label(A)]: 'on' } } }, { reach: { recentMinutes: -1 } }, { reach: { fuses: { per_day: 0 } } }, { reach: { fuses: { messages: 2 } } }];
  for (const body of invalid) assert.throws(() => settings(body), { code: 'VALIDATION_ERROR' }, JSON.stringify(body));
  for (const body of [{ person: A }, { streamId: stream(A) }]) assert.throws(() => a.initiativeWake(body), { code: 'VALIDATION_ERROR' });
});

test('once or twice a day: she wakes at the set times, each shifted by up to half an hour; a time that was missed is not made up for', t => {
  const { a, next, view, clock, random, settings, done } = fixture(t);
  assert.deepEqual(settings({ wake: { enabled: true } }).wake, { enabled: true, times: ['10:00', '19:00'] });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(view().nextAt, MIDNIGHT + 19 * HOUR);
  clock.now = MIDNIGHT + 19 * HOUR - 1;
  assert.equal(next().initiation, null);
  clock.now += 1;
  const { initiation } = next();
  assert.deepEqual(Object.keys(initiation).sort(), ['briefing', 'expiresAt', 'id', 'kind', 'memoryEpoch', 'streamId']);
  assert.deepEqual([initiation.kind, initiation.streamId, initiation.memoryEpoch, initiation.expiresAt], ['wake', OWN, 0, clock.now + 5 * MINUTE]);
  // Her own conversation is an ordinary private binding to the reserved person, made by Authority itself.
  assert.deepEqual({ ...a.store.db.prepare('SELECT person_id,audience,entity_id FROM streams WHERE capability_id=? AND stream_id=?').get('qq', OWN) }, { person_id: SELF_PERSON, audience: 'private', entity_id: DEFAULT_ENTITY_ID });
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  // She did nothing: reported once as done.
  assert.deepEqual(done(initiation.id), { status: 'recorded' });
  assert.deepEqual(done(initiation.id), { status: 'recorded', replayed: true });
  assert.throws(() => a.initiationAck('qq', { id: initiation.id, outcome: 'failed' }), { code: 'CONFLICT' });
  const [entry] = view().log;
  assert.deepEqual([entry.type, entry.reason, entry.outcome, entry.did, entry.reach, entry.fuses, entry.counts], ['wake', 'schedule', 'done', { rested: true }, [], [], { cards: 0, excluded: { reach_off: 3 }, diary: false, mood: false }]);
  // The next one is tomorrow's first time, shifted by the jitter: here the earliest and (almost) the latest.
  random.value = 0; next();
  assert.equal(view().nextAt, MIDNIGHT + DAY + 10 * HOUR - 30 * MINUTE);
  // The whole window passed (the bridge was down): nothing is made up for, the day's second time is next.
  clock.now = MIDNIGHT + DAY + 12 * HOUR; random.value = 0.5;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual([view().nextAt, view().log.map(item => item.counts)], [MIDNIGHT + DAY + 19 * HOUR, [{ missed: 1 }, entry.counts]]);
  // One time a day, set by the operator: scheduled afresh.
  assert.deepEqual(settings({ wake: { times: ['21:30'] } }).wake, { enabled: true, times: ['21:30'] });
  next();
  assert.equal(view().nextAt, MIDNIGHT + DAY + 21 * HOUR + 30 * MINUTE);
  // A request to a person always goes before her own wake-up.
  clock.now = view().nextAt;
  a.observe('qq', { eventId: 'e-owner', streamId: stream(OWNER), actorId: `qq:${SELF}:user:${OWNER}`, role: 'user', text: 'MOCK-OWNER 在', at: clock.now - HOUR });
  const poke = a.initiationPoke();
  assert.equal(next().initiation.id, poke.id);
  a.initiationAck('qq', { id: poke.id, outcome: 'declined' });
  assert.equal(next().initiation.kind, 'wake');
});

test('schedule arithmetic: the first time not used yet whose window is not over', () => {
  const none = () => 0.5, at = (day, hour) => MIDNIGHT + day * DAY + hour * HOUR;
  assert.deepEqual(nextWake(at(0, 9), [600, 1140], undefined, none), { slot: at(0, 10), at: at(0, 10) });
  // Inside the window of 10:00 it is still that one; once used (`after`), the next.
  assert.equal(nextWake(at(0, 10) + 20 * MINUTE, [1140, 600], undefined, none).slot, at(0, 10));
  assert.equal(nextWake(at(0, 10) + 20 * MINUTE, [600, 1140], at(0, 10), none).slot, at(0, 19));
  assert.equal(nextWake(at(0, 10) + 31 * MINUTE, [600, 1140], undefined, none).slot, at(0, 19));
  assert.equal(nextWake(at(0, 20), [600, 1140], undefined, none).slot, at(1, 10));
  assert.deepEqual([0, 1].map(value => nextWake(at(0, 9), [600], undefined, () => value).at - at(0, 10)), [-30 * MINUTE, 30 * MINUTE]);
});

test('she does not wake in the quiet hours, while the world is paused, once the spend tier refused or with turns queued; each is counted with its reason', t => {
  const { a, next, view, clock, settings, wakeNow, done } = fixture(t, { quiet: 'default' });
  settings({ wake: { enabled: true } });
  const counts = () => view().log.find(entry => entry.type === 'skip' && entry.day === new Date(clock.now + 8 * HOUR).toISOString().slice(0, 10))?.counts ?? {};
  // Busy: put off by five minutes, what was asked for is kept.
  a.initiativeWake();
  assert.deepEqual(next({ busy: true }), { initiation: null, reason: 'idle' });
  assert.deepEqual(next({ busy: true }), { initiation: null, reason: 'idle' });
  assert.deepEqual(counts(), { busy: 1 });
  clock.now += WAKE.busyRetryMs;
  const first = next().initiation;
  assert.equal(first.kind, 'wake'); done(first.id);
  // Quiet hours (23:30 to 08:00 by default): not handed out and not made up for afterwards.
  clock.now = MIDNIGHT + 23 * HOUR + 45 * MINUTE;
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now, blocked: 'quiet_hours' });
  assert.equal(next().initiation, null);
  clock.now = MIDNIGHT + DAY + 8 * HOUR + MINUTE;
  assert.equal(next().initiation, null);
  // Paused: the same.
  a.setWorldPaused({ paused: true });
  assert.equal(a.initiativeWake().blocked, 'paused');
  assert.deepEqual(next(), { initiation: null, reason: 'paused' });
  a.setWorldPaused({ paused: false });
  assert.equal(next().initiation, null);
  assert.deepEqual(counts(), { paused: 1 });
  // The gateway's spend tier refused a wake-up: nothing more that Beijing day.
  const refused = wakeNow();
  assert.deepEqual(a.initiationAck('qq', { id: refused.id, outcome: 'deferred:budget' }), { status: 'recorded' });
  assert.equal(a.initiativeWake().blocked, 'budget');
  assert.equal(next().initiation, null);
  assert.deepEqual(counts(), { paused: 1, budget: 1 });
  clock.now += DAY;
  assert.equal(wakeNow().kind, 'wake');
});

test('the briefing: her diary and mood, and one card for each person she may reach out to; whoever she may not reach out to gets none', t => {
  const { a, clock, say, propose, chat, view, settings, enable, wakeNow, done } = fixture(t);
  a.admitPerson('qq', admit(C));
  chat(A, 'MOCK-A-原话 我下周要去面试一家新公司', 'MOCK-摘要甲：对方说下周有个面试，有点紧张。');
  assert.equal(propose(say(A, 'MOCK-A-原话 周三面试'), 'intent.note', { text: 'MOCK-打算甲 问问面试怎么样', quote: '周三面试', due: '2027-01-20' }).status, 'accepted');
  chat(B, 'MOCK-B-原话 我在学大提琴', 'MOCK-摘要乙：对方说在学大提琴。');
  assert.equal(propose(say(B, 'MOCK-B-原话 周末演出'), 'intent.note', { text: 'MOCK-打算乙 问问演出', quote: '周末演出' }).status, 'accepted');
  assert.equal(propose(say(C, 'MOCK-C-原话 最近别找我'), 'appraisal.record', { kind: 'boundary', quote: '最近别找我' }).status, 'accepted');
  say(OWNER, 'MOCK-OWNER-原话 今天好累');
  // Her private diary of that day, written the next morning.
  clock.now = MIDNIGHT + DAY + 4 * HOUR;
  const { task } = a.diaryNext(DEFAULT_ENTITY_ID);
  a.diaryCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', private: { text: 'MOCK-日记：今天和两个人聊了。' }, usedIds: task.digests.map(row => row.ref) });
  clock.now = MIDNIGHT + DAY + 11 * HOUR;

  // Reaching out is off: she wakes with her diary and no card at all.
  settings({ wake: { enabled: true } });
  const alone = wakeNow();
  assert.match(alone.briefing, /你最近一篇日记（2027-01-15）："MOCK-日记：今天和两个人聊了。"/);
  assert.match(alone.briefing, /你还没有写过心情。\n今天你已经主动找过 0 个人。\n现在没有可以去找的人。$/);
  assert.doesNotMatch(alone.briefing, /p-[0-9a-f]{6}|MOCK-摘要|MOCK-打算|原话/);
  a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 心情一' }); done(alone.id);
  assert.deepEqual(view().log[0].counts, { cards: 0, excluded: { reach_off: 4 }, diary: true, mood: false });

  // On, with A's switch on and C's too: the owner and A get a card; B's switch is off, C set a boundary.
  clock.now += MINUTE; enable(A, C);
  const wake = wakeNow(), text = wake.briefing;
  assert.match(text, /^现在是 2027年1月16日 周六 11:01（北京时间）。这次醒来是因为：主人让你现在醒一次。\n/);
  assert.match(text, /你上次写下的心情（1 分钟前）："MOCK 心情一"/);
  assert.match(text, /现在可以去找的人有 2 个/);
  const card = uid => text.split('\n[').find(part => part.startsWith(label(uid) + ']'));
  assert.match(card(A), /上次聊天是 19 小时前；最近 14 天对方说了 2 句；你还没有主动找过对方；最近 7 天你主动找过对方 0 次；认识 19 小时了。/);
  assert.match(card(A), /你留给这个人的打算：\n  - （到 2027-01-20）"MOCK-打算甲 问问面试怎么样"/);
  assert.match(card(A), /最近的经历摘要（机器整理，不是原话）：\n  - （2027-01-15）"MOCK-摘要甲：对方说下周有个面试，有点紧张。"/);
  assert.match(card(OWNER), /你没有给这个人留下打算。/);
  // Nothing of B or C in any form, no line anybody wrote, and nothing that identifies a person outside Authority.
  for (const absent of [label(B), label(C), 'MOCK-摘要乙', 'MOCK-打算乙', 'MOCK-A-原话', 'MOCK-OWNER-原话', '大提琴', '别找我']) assert.ok(!text.includes(absent), absent);
  assert.doesNotMatch(text, IDENTIFYING);
  assert.ok(text.length <= 20000);
  done(wake.id);
  assert.deepEqual(view().log[0].counts, { cards: 2, excluded: { switch: 1, boundary: 1 }, diary: true, mood: true });
  // The log and the page hold the labels only, and none of the cards' text.
  assert.doesNotMatch(JSON.stringify(view()), /MOCK-摘要|MOCK-打算|原话|9999\d{8}|person:/);

  // Somebody either side wrote to within the last half hour gets no card either (the operator may change the span).
  clock.now += HOUR; say(A, 'MOCK-A-原话 在吗'); clock.now += 10 * MINUTE;
  const later = wakeNow();
  assert.ok(!later.briefing.includes(label(A)));
  done(later.id);
  assert.deepEqual(view().log[0].counts.excluded, { recent: 1, switch: 1, boundary: 1 });
  settings({ reach: { recentMinutes: 0 } });
  const again = wakeNow();
  assert.ok(again.briefing.includes(`[${label(A)}]`));
  done(again.id);
});

test('a card is bounded: an intent is cut to 120 characters, the digests to 200 between them, a sensitive digest is left out', t => {
  const { a, clock, say, propose, chat, enable, wakeNow } = fixture(t);
  chat(A, 'MOCK-A 第一段', 'MOCK-摘要一' + '很'.repeat(150));
  clock.now += HOUR; chat(A, 'MOCK-A 第二段', 'MOCK-摘要二' + '长'.repeat(150));
  clock.now += HOUR; chat(B, 'MOCK-B 说了件事', 'MOCK-摘要乙：对方说了密码的事。');
  assert.equal(propose(say(A, 'MOCK-A 帮我记着'), 'intent.note', { text: 'MOCK-长打算' + '啊'.repeat(300), quote: '帮我记着' }).status, 'accepted');
  clock.now += 2 * HOUR; enable(A, B);
  const text = wakeNow().briefing, summaries = [...text.matchAll(/）"(MOCK-摘要[^"]*)"/g)].map(match => match[1]);
  // Newest first; together 200 characters.
  assert.deepEqual(summaries.map(summary => summary.slice(0, 8)), ['MOCK-摘要二', 'MOCK-摘要一'].map(head => head.slice(0, 8)));
  assert.equal(summaries.reduce((sum, summary) => sum + [...summary].length, 0), REACH.digestChars);
  assert.equal([.../"(MOCK-长打算[^"]*)"/.exec(text)[1]].length, REACH.intentChars);
  assert.ok(text.includes(`[${label(B)}]`) && !text.includes('MOCK-摘要乙'));
});

test('briefing and event text: plain functions of what they are given', () => {
  const now = START, stats = { lastAt: now - 3 * DAY, lines14: 12, firstAt: now - 40 * DAY, reachedAt: now - 5 * DAY, unanswered: 2, reached7: 1 };
  const card = renderCard({ label: 'p-0a1b2c', stats, intents: [{ text: 'MOCK 问问', dueDate: null }], digests: [] }, now);
  assert.equal(card, '[p-0a1b2c] 上次聊天是 3 天前；最近 14 天对方说了 12 句；你上次主动找对方是 5 天前，对方还没回（连续 2 次没回）；最近 7 天你主动找过对方 1 次；认识 40 天了。\n  你留给这个人的打算：\n  - （没定日子）"MOCK 问问"');
  const briefing = renderBriefing({ now, reason: 'schedule', diary: null, mood: null, cards: [card], reachedToday: 1 });
  assert.match(briefing, /这次醒来是因为：到点了。\n你还没有写过日记。\n你还没有写过心情。\n今天你已经主动找过 1 个人。\n现在可以去找的人有 1 个/);
  const event = renderReachEvent({ reason: 'MOCK 想问问近况', intents: [], stats: { ...stats, unanswered: 0 }, now });
  assert.match(event, /^你想找他，因为：MOCK 想问问近况\n你没有给对方留下具体的事。\n关于对方的几件事实（只是事实，不是要求）：.*对方回了；/);
});

test('what she writes down: only inside the wake-up that is out, checked like a machine digest, kept with the wake-up and the persona card, the newest 30', t => {
  const { a, clock, view, settings, wakeNow, done } = fixture(t);
  settings({ wake: { enabled: true } });
  assert.throws(() => a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 太早' }), { code: 'CONFLICT' });
  const wake = wakeNow();
  assert.throws(() => a.selfRecord('qq', { streamId: stream(A), mood: 'MOCK 别处' }), { code: 'CONFLICT' });
  for (const body of [{ streamId: OWN, mood: 1 }, { streamId: OWN, outreach: 'yes' }, { streamId: OWN, person: A }, { mood: 'MOCK' }, { streamId: OWN, reach: 'p-000000' }, { streamId: OWN, reach: [{ label: 'p-000000' }] }, { streamId: OWN, reach: [1, 2, 3].map(() => ({ label: 'p-000000', reason: 'MOCK' })) }])
    assert.throws(() => a.selfRecord('qq', body), { code: 'VALIDATION_ERROR' }, JSON.stringify(body));
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 有点想找人说话', note: 'MOCK 随笔：今天的云很低。' }), { mood: 'accepted', note: 'accepted' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: 'x'.repeat(WAKE.moodChars + 1) }), { mood: 'rejected:too_long' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: '   ' }), { mood: 'rejected:empty' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, note: 'MOCK 密码是 hunter2' }), { note: 'rejected:sensitive' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, note: 'MOCK 号码 99990000' }), { note: 'rejected:unsafe_text' });
  a.setWorldPaused({ paused: true });
  assert.throws(() => a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 暂停中' }), { code: 'CONFLICT' });
  a.setWorldPaused({ paused: false });
  done(wake.id);
  assert.throws(() => a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 太晚' }), { code: 'CONFLICT' });
  const shown = view();
  assert.deepEqual(shown.moods.map(mood => [mood.text, mood.wakeId, mood.cardId]), [['MOCK 有点想找人说话', wake.id, 'card:default']]);
  assert.deepEqual(shown.notes.map(note => note.text), ['MOCK 随笔：今天的云很低。']);
  assert.deepEqual(shown.log[0].did, { mood: 'rejected:empty', note: 'rejected:unsafe_text', rested: false });
  // Read nowhere else: no context of anyone, no memory listing.
  assert.doesNotMatch(JSON.stringify([a.context('qq', { streamId: stream(A), query: '想找人说话 云很低' }), a.context('qq', { streamId: stream(OWNER), query: '想找人说话 云很低' }), a.listMemory({ limit: 100 })]), /想找人说话|云很低/);
  // A mood of another persona card is not read back.
  const card = a.createPersonaCard({ title: 'MOCK 另一张' });
  a.activatePersonaCard({ id: card.id, reason: 'MOCK' });
  clock.now += HOUR;
  assert.match(wakeNow().briefing, /你还没有写过心情。/);
  // The newest 30 are kept.
  for (let index = 0; index < WAKE.moods + 5; index++) a.selfRecord('qq', { streamId: OWN, mood: `MOCK 心情 ${index}` });
  assert.equal(view().moods.length, WAKE.moods);
});

test('reach: a label must be one of this wake-up\'s cards, a sensitive reason drops the whole entry, and another person\'s label in a reason becomes "另一个人"', t => {
  const { a, clock, say, view, enable, wakeNow, done, reach, next } = fixture(t);
  a.admitPerson('qq', admit(C));
  say(A, 'MOCK-A 我最近在准备马拉松比赛训练计划'); say(B, 'MOCK-B 随便聊聊'); say(C, 'MOCK-C 嗯');
  clock.now += HOUR; enable(A, B);
  const wake = wakeNow();
  // C has no card (the switch is off); a label of nobody; twice the same person.
  assert.deepEqual(reach([C, 'MOCK 想聊聊']), ['rejected:not_candidate']);
  assert.deepEqual(reach(['p-ffffff', 'MOCK 想聊聊'], [A, 'MOCK 想聊聊']), ['rejected:not_candidate', 'accepted']);
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, reach: [{ label: person(A), reason: 'MOCK' }, { label: label(A), reason: 'MOCK 一' }] }).reach, ['rejected:not_candidate', 'accepted']);
  assert.deepEqual(reach([A, 'MOCK 一'], [A, 'MOCK 二']), ['accepted', 'rejected:duplicate']);
  // Every category refuses; so does the old lexicon, a long number, an empty or an over-long reason.
  const refused = {
    'sensitive:health': 'MOCK 另一个人说他住院了，想问问', 'sensitive:finance': 'MOCK 听说工资的事', 'sensitive:romance': 'MOCK 另一个人分手了', 'sensitive:account': 'MOCK 想要个手机号',
    'sensitive:quote': 'MOCK 另一个人说：“我好累”', sensitive: 'MOCK 那个诊断的事', unsafe_text: 'MOCK 9999000', empty: '  ', too_long: 'MOCK' + '长'.repeat(REACH.reasonChars),
  };
  for (const [why, reason] of Object.entries(refused)) assert.deepEqual(reach([B, reason]), [`rejected:${why}`], reason);
  // Repeating a run of what somebody wrote is a quotation, whatever marks it carries.
  assert.deepEqual(reach([B, 'MOCK 有人最近在准备马拉松比赛训练']), ['rejected:sensitive:quote']);
  // The latest `reach` of a wake-up is the one that counts. B's reason names A by label: it is kept without the label.
  assert.deepEqual(reach([B, `MOCK ${label(A)} 提到在练跑步，想问问 ${label(B)} 要不要一起`], [OWNER, 'MOCK 那件事 @不该有']), ['accepted', 'rejected:sensitive:account']);
  done(wake.id);
  const [entry] = view().log;
  assert.deepEqual(entry.reach.map(item => [item.person, item.owner, item.check, item.reason]), [[label(B), undefined, 'accepted', 'MOCK 另一个人 提到在练跑步，想问问 对方 要不要一起'], [label(OWNER), true, 'rejected:sensitive:account', undefined]]);
  assert.equal(entry.did.reach, 2);
  // A refused reason is kept nowhere.
  assert.doesNotMatch(JSON.stringify([view(), a.store.db.prepare("SELECT value FROM metadata WHERE key IN ('initiative','initiative.log','initiations')").all()]), /不该有|住院|分手/);
  // What reaches B's conversation holds neither label.
  const { initiation } = next();
  assert.equal(initiation.streamId, stream(B));
  assert.doesNotMatch(initiation.event, /p-[0-9a-f]{6}/);
  assert.match(initiation.event, /^你想找他，因为：MOCK 另一个人 提到在练跑步，想问问 对方 要不要一起\n/);
});

test('reason filter: categories, quotation and labels as plain functions', () => {
  assert.deepEqual(REASON_CATEGORIES.map(([name]) => name), ['health', 'finance', 'romance', 'account', 'quote']);
  for (const fine of ['想问问最近过得怎么样', '另一个人提到他最近不开心，想问问对方知不知道', '好久没聊了', '答应过要问问面试结果']) assert.equal(refusedReason(fine), null, fine);
  const hits = { health: ['去医院复查', '感冒发烧症状', 'her surgery'], finance: ['借了他三千块', '欠钱', '3 万'], romance: ['和女朋友吵架', '离婚', 'his crush'], account: ['QQ号', '12345', 'a@b', 'https://x'], quote: ['他说：好', '「好」', '原话是这样'] };
  for (const [category, reasons] of Object.entries(hits)) for (const reason of reasons) assert.equal(refusedReason(reason), `sensitive:${category}`, reason);
  assert.equal(refusedReason('x'.repeat(REACH.reasonChars + 1)), 'too_long');
  assert.equal(refusedText('', 10), 'empty');
  assert.equal(repeatsWords('想问问，周末去了海边玩得怎么样', ['我 周末去了海边玩得很开心！']), true);
  assert.equal(repeatsWords('想问问周末过得怎么样', ['我周末去了海边玩得很开心']), false);
  assert.equal(repeatsWords('短', ['短']), false);
  assert.equal(withoutLabels('p-aaaaaa 和 p-bbbbbb 还有 p-cccccc', 'p-bbbbbb'), '另一个人 和 对方 还有 另一个人');
});

test('6c: an accepted person gets a turn she starts in their own conversation, with her reason, their intents and facts about them only; delivery settles the due intents and is counted for good', t => {
  const { a, clock, say, propose, view, enable, wakeNow, done, reach, next } = fixture(t);
  assert.equal(propose(say(A, 'MOCK-A 周三面试'), 'intent.note', { text: 'MOCK-打算甲 问问面试', quote: '周三面试', due: '2027-01-15' }).status, 'accepted');
  assert.equal(propose(say(A, 'MOCK-A 下个月搬家'), 'intent.note', { text: 'MOCK-打算甲 问问搬家', quote: '下个月搬家', due: '2027-02-10' }).status, 'accepted');
  assert.equal(propose(say(B, 'MOCK-B 周末演出'), 'intent.note', { text: 'MOCK-打算乙 问问演出', quote: '周末演出' }).status, 'accepted');
  say(OWNER, 'MOCK-OWNER 在');
  clock.now += HOUR; enable(A, B);
  const wake = wakeNow();
  assert.deepEqual(reach([A, 'MOCK 想问问面试的事'], [B, 'MOCK 另一个人也有演出，想聊聊']), ['accepted', 'accepted']);
  // Nothing is registered while the wake-up is still out.
  assert.equal(a.initiationLog().items.length, 0);
  done(wake.id);
  assert.deepEqual(a.initiationLog().items.map(item => [item.kind, item.source, item.person, item.status]).reverse(), [['proactive', 'reach', label(A), 'waiting'], ['proactive', 'reach', label(B), 'waiting']]);
  // One at a time, each in that person's own conversation.
  const first = next().initiation;
  assert.deepEqual(Object.keys(first).sort(), ['event', 'expiresAt', 'id', 'kind', 'light', 'memoryEpoch', 'streamId']);
  assert.deepEqual([first.kind, first.streamId, first.light, first.expiresAt], ['proactive', stream(A), true, clock.now + REACH.ttlMs]);
  assert.match(first.event, /^你想找他，因为：MOCK 想问问面试的事\n你留给对方的打算：\n- （到 2027-01-15）"MOCK-打算甲 问问面试"\n- （到 2027-02-10）"MOCK-打算甲 问问搬家"\n关于对方的几件事实（只是事实，不是要求）：上次聊天是 1 小时前；最近 14 天对方说了 2 句；你还没有主动找过对方；/);
  assert.doesNotMatch(first.event, /打算乙|演出|p-[0-9a-f]{6}|9999\d{8}|person:/);
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  assert.deepEqual(a.initiationAck('qq', { id: first.id, outcome: 'sent' }), { status: 'recorded' });
  // Delivered: the intent whose day had come is settled, the one for next month stays.
  const intents = () => Object.fromEntries(a.listMemory({ limit: 100 }).items.filter(item => item.kind === 'intent').map(item => [item.text, item.state]));
  assert.deepEqual(intents(), { 'MOCK-打算甲 问问面试': 'done', 'MOCK-打算甲 问问搬家': 'open', 'MOCK-打算乙 问问演出': 'open' });
  // B declines: nothing went out, nothing is settled or counted.
  const second = next().initiation;
  assert.equal(second.streamId, stream(B));
  assert.doesNotMatch(second.event, /打算甲|面试|搬家/);
  a.initiationAck('qq', { id: second.id, outcome: 'declined' });
  assert.equal(intents()['MOCK-打算乙 问问演出'], 'open');
  const people = () => Object.fromEntries(view().reach.people.map(item => [item.person, [item.reachedAt, item.unanswered, item.reached7]]));
  assert.deepEqual(people(), { [label(OWNER)]: [null, 0, 0], [label(A)]: [clock.now, 1, 1], [label(B)]: [null, 0, 0] });
  assert.deepEqual(view().log[0].reach.map(item => [item.person, item.check, item.outcome]), [[label(A), 'accepted', 'sent'], [label(B), 'accepted', 'declined']]);

  // The record does not depend on the kept requests: with all of them gone it still stands, and her next card says so.
  a.store.db.prepare("DELETE FROM metadata WHERE key='initiations'").run();
  a.initiationSettings({ quietHours: { from: '00:00', to: '00:00' } });
  clock.now += 2 * HOUR;
  const later = wakeNow();
  assert.match(later.briefing, new RegExp(`\\[${label(A)}\\] 上次聊天是 3 小时前；最近 14 天对方说了 2 句；你上次主动找对方是 2 小时前，对方还没回（连续 1 次没回）；最近 7 天你主动找过对方 1 次`));
  assert.match(later.briefing, /今天你已经主动找过 1 个人。/);
  reach([A, 'MOCK 再问一次']); done(later.id);
  const again = next().initiation;
  a.initiationAck('qq', { id: again.id, outcome: 'unknown' });
  // Unknown counts as a reach-out (it may have arrived) and settles nothing.
  assert.deepEqual(people()[label(A)], [clock.now, 2, 2]);
  // Once A writes, "unanswered" is over.
  clock.now += MINUTE; say(A, 'MOCK-A 来了');
  assert.deepEqual(people()[label(A)].slice(1), [0, 2]);
  // Eight days on, the week's count is empty again.
  clock.now += 8 * DAY;
  assert.deepEqual(people()[label(A)].slice(1), [0, 0]);
});

test('forced rules still hold when the request is fetched: a switch turned off meanwhile, a pause, the person having spoken, the quiet hours', t => {
  const { a, clock, say, view, settings, enable, wakeNow, done, reach, next } = fixture(t);
  say(A, 'MOCK-A 嗯'); say(OWNER, 'MOCK-OWNER 在'); clock.now += HOUR; enable(A);
  const go = () => { clock.now += MINUTE; const wake = wakeNow(); assert.deepEqual(reach([A, 'MOCK 想聊聊']), ['accepted']); done(wake.id); };
  const last = () => view().log[0].reach[0];
  go(); settings({ reach: { people: { [label(A)]: false } } });
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:switch']);
  settings({ reach: { people: { [label(A)]: true } } });
  go(); settings({ reach: { enabled: false } });
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:reach_off']);
  settings({ reach: { enabled: true } });
  go(); say(A, 'MOCK-A 我先说了');
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:person_spoke']);
  clock.now += HOUR;
  go(); a.setWorldPaused({ paused: true }); a.setWorldPaused({ paused: false });
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:paused']);
  go(); settings({ quietHours: { from: '00:00', to: '23:59' } });
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:quiet_hours']);
  settings({ quietHours: { from: '00:00', to: '00:00' } });
  go(); clock.now += REACH.ttlMs;
  assert.deepEqual([next().initiation, last().outcome], [null, 'dropped:expired']);
  // None of these went out: nothing was counted.
  assert.deepEqual(view().reach.people.find(item => item.person === label(A)).reached7, 0);
  // A switch turned off before the wake-up ends refuses at once, without a request.
  clock.now += MINUTE; const wake = wakeNow(); reach([A, 'MOCK 想聊聊']); settings({ reach: { people: { [label(A)]: false } } }); done(wake.id);
  assert.deepEqual([last().check, last().initiationId, a.initiationLog().items.filter(item => item.status !== 'closed').length], ['rejected:switch', undefined, 0]);
  // The operator's poke is still for the owner alone, and is not held up by a waiting reach-out to somebody else.
  assert.equal(a.initiationPoke().owner, true);
});

test('a high fuse is a fault: the reach-out is refused, the owner is told once with a fixed notice, and nothing more is started that day', t => {
  const { a, clock, say, view, settings, enable, wakeNow, done, reach, next } = fixture(t);
  say(A, 'MOCK-A 嗯'); say(B, 'MOCK-B 嗯'); say(OWNER, 'MOCK-OWNER 在'); clock.now += HOUR; enable(A, B);
  assert.deepEqual(settings({ reach: { fuses: { per_hour: 1 } } }).reach.fuses, { per_day: 20, per_person_day: 4, per_person_week: 12, per_hour: 1 });
  const wake = wakeNow();
  reach([A, 'MOCK 想聊聊'], [B, 'MOCK 也想聊聊']); done(wake.id);
  const [entry] = view().log.filter(item => item.type === 'wake');
  assert.deepEqual([entry.reach.map(item => item.check), entry.fuses], [['accepted', 'rejected:fuse:per_hour'], ['fuse:per_hour']]);
  assert.deepEqual([view().fuse, view().log.find(item => item.type === 'skip').counts], [{ name: 'per_hour', at: clock.now }, { 'fuse:per_hour': 1 }]);
  // The request to A that had passed is stopped as well; the only thing handed out is the notice, to the owner.
  const { initiation } = next();
  assert.deepEqual(initiation, { id: initiation.id, kind: 'notice', streamId: stream(OWNER), memoryEpoch: 0, expiresAt: clock.now + REACH.ttlMs, notice: 'fuse' });
  assert.equal(view().log.find(item => item.type === 'wake').reach[0].outcome, 'dropped:fuse');
  assert.deepEqual(a.initiationAck('qq', { id: initiation.id, outcome: 'sent' }), { status: 'recorded' });
  assert.deepEqual(a.initiationLog().items.map(item => [item.kind, item.owner, item.outcome]), [['notice', true, 'sent'], ['proactive', false, 'dropped:fuse']]);
  // No wake-up and no second notice for the rest of the Beijing day.
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now, blocked: 'fuse' });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(a.initiationLog().items.length, 2);
  // The next day she wakes again.
  clock.now += DAY;
  assert.equal(view().fuse, null);
  const tomorrow = wakeNow();
  assert.equal(tomorrow.kind, 'wake');
  // The fuses count what went out from the lasting record: three to A today trips "per person a day" at the fourth... here set to 1.
  settings({ reach: { fuses: { per_hour: 100, per_person_day: 1 } } });
  reach([A, 'MOCK 想聊聊']); done(tomorrow.id);
  a.initiationAck('qq', { id: next().initiation.id, outcome: 'partial' });
  clock.now += HOUR;
  const more = wakeNow(); reach([A, 'MOCK 再聊聊']); done(more.id);
  assert.deepEqual(view().log.find(item => item.type === 'wake').reach.map(item => item.check), ['rejected:fuse:per_person_day']);
  assert.equal(next().initiation.kind, 'notice');
});

test('the other fuses: too many messages in one turn (the bridge refuses and reports it) and too many wake-ups in a day', t => {
  const { a, clock, say, view, enable, wakeNow, done, reach, next } = fixture(t);
  say(A, 'MOCK-A 嗯'); say(OWNER, 'MOCK-OWNER 在'); clock.now += HOUR; enable(A);
  const wake = wakeNow(); reach([A, 'MOCK 想聊聊']); done(wake.id);
  const { initiation } = next();
  a.initiationAck('qq', { id: initiation.id, outcome: 'dropped:fuse_messages' });
  assert.deepEqual([view().fuse?.name, view().reach.people.find(item => item.person === label(A)).reached7, next().initiation.kind], ['messages_per_turn', 0, 'notice']);
  // 48 wake-ups in a Beijing day, however they came about.
  clock.now += DAY;
  const log = Array.from({ length: WAKE.fuseWakesPerDay }, (_, index) => ({ id: `w-${index}`, type: 'wake', at: clock.now - index, endedAt: clock.now, reason: 'manual', outcome: 'done', counts: {}, did: { rested: true }, reach: [], fuses: [] }));
  a.store.db.prepare("UPDATE metadata SET value=? WHERE key='initiative.log'").run(JSON.stringify(log));
  a.initiativeWake(); next();
  assert.equal(next().initiation.kind, 'notice');
  assert.deepEqual([view().fuse.name, view().log.find(item => item.type === 'skip').counts], ['wakes_per_day', { missed: 1, 'fuse:wakes_per_day': 1 }]);
});

test('the reserved person is nobody: no account or conversation can be bound to it, nothing is observed in her conversation, and it is not listed as anyone\'s', t => {
  const { a, settings, wakeNow, done, clock, view } = fixture(t);
  assert.throws(() => a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${C}`, personId: SELF_PERSON }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.bindStream({ capabilityId: 'qq', streamId: stream(C), personId: SELF_PERSON, audience: 'private' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.attachAccount({ capabilityId: 'qq', actorId: `qq:${SELF}:user:${A}`, streamId: stream(A), personId: SELF_PERSON, move: true }), { code: 'VALIDATION_ERROR' });
  settings({ wake: { enabled: true }, reach: { enabled: true } }); done(wakeNow().id);
  assert.throws(() => a.observe('qq', { eventId: 'e-own', streamId: OWN, actorId: `qq:${SELF}:user:${A}`, role: 'user', text: 'MOCK 混进来的话', at: clock.now }), { code: 'FORBIDDEN' });
  // A bridge cannot admit an account into her conversation either: the binding is taken.
  assert.throws(() => a.admitPerson('qq', { uid: C, actorId: `qq:${SELF}:user:${C}`, streamId: OWN }), { code: 'CONFLICT' });
  assert.ok(!a.listConversations().some(row => row.streamId === OWN));
  assert.ok(!a.listPeople().people.some(row => row.personId === SELF_PERSON));
  // She is no candidate of her own, and has no switch.
  assert.ok(!view().reach.people.some(item => item.person === opaquePerson(SELF_PERSON)));
  assert.throws(() => settings({ reach: { people: { [opaquePerson(SELF_PERSON)]: true } } }), { code: 'VALIDATION_ERROR' });
  // Only the channel the owner last spoke on carries wake-ups.
  a.registerCapability({ id: 'native', policy: 'conversation.v1' });
  a.initiativeWake();
  assert.deepEqual(a.initiationNext('native'), { initiation: null, reason: 'idle' });
  assert.equal(a.initiationNext('qq').initiation.kind, 'wake');
});

test('her own conversation still sees no person\'s memory, and forgetting anything retires it: the cards it read go with its session', t => {
  const { a, clock, say, propose, enable, wakeNow, done } = fixture(t);
  const line = say(A, 'MOCK-A 周三面试');
  assert.equal(propose(line, 'intent.note', { text: 'MOCK-打算甲 问问面试', quote: '周三面试' }).status, 'accepted');
  assert.equal(propose(line, 'fact.report', { key: 'MOCK 面试', value: 'MOCK 周三', quote: '周三面试' }).status, 'accepted');
  clock.now += HOUR; enable(A);
  const wake = wakeNow();
  assert.ok(wake.briefing.includes('MOCK-打算甲 问问面试'));
  // The cards are the only way anything of a person reaches her there: context and the memory tools give none.
  const own = a.context('qq', { streamId: OWN, query: 'MOCK 面试 打算 周三', budgetChars: 16000 });
  assert.equal(own.own, true);
  assert.doesNotMatch(JSON.stringify([own, a.memorySearch('qq', { streamId: OWN, query: 'MOCK 面试 周三' })]), /MOCK-打算甲|MOCK 周三|p-[0-9a-f]{6}/);
  done(wake.id);
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [line] });
  assert.deepEqual(preview.affectedStreams.map(item => item.streamId).sort(), [OWN, stream(A)].sort());
  assert.equal(preview.epochScope, 'streams');
  a.setWorldPaused({ paused: true });
  const applied = a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [line], expectedMemoryEpoch: preview.memoryEpoch });
  assert.ok(JSON.stringify(applied).includes(OWN));
  // Her conversation is under a new epoch (the executor drops the session of the old one), and both the bridge's
  // and the executor's part of the cleanup name it.
  assert.ok(a.context('qq', { streamId: OWN, query: 'MOCK' }).memoryEpoch > wake.memoryEpoch);
  assert.ok(a.cleanupNext('qq', { party: 'executor' }).job.affectedStreams.some(item => item.streamId === OWN));
});

test('a wake-up nobody reported is closed as unknown after 20 minutes and reaches out to nobody; the late report may still replace the outcome', t => {
  const { a, next, view, clock, say, enable, wakeNow, reach } = fixture(t);
  say(A, 'MOCK-A 嗯'); clock.now += HOUR; enable(A);
  const wake = wakeNow();
  a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 写到一半' }); reach([A, 'MOCK 想聊聊']);
  clock.now += 19 * MINUTE;
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  clock.now += MINUTE;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  const [entry] = view().log;
  assert.deepEqual([entry.outcome, entry.unreported, entry.did, entry.reach.map(item => [item.check, item.initiationId]), view().out], ['unknown', true, { mood: 'accepted', reach: 1, rested: false }, [['rejected:wake_not_done', undefined]], null]);
  assert.equal(a.initiationLog().items.length, 0);
  assert.throws(() => a.initiationAck('qq', { id: wake.id, outcome: 'sent' }), { code: 'CONFLICT' });
  assert.deepEqual(a.initiationAck('qq', { id: wake.id, outcome: 'failed' }), { status: 'recorded' });
  assert.deepEqual([view().log[0].outcome, view().log[0].unreported], ['failed', undefined]);
  assert.deepEqual(a.initiationAck('qq', { id: wake.id, outcome: 'failed' }), { status: 'recorded', replayed: true });
  assert.throws(() => a.initiationAck('qq', { id: wake.id, outcome: 'done' }), { code: 'CONFLICT' });
  // The log keeps the newest 300 entries.
  const log = Array.from({ length: 320 }, (_, index) => ({ id: `w-${index}`, type: 'wake', at: index, endedAt: index, reason: 'schedule', outcome: 'done', counts: {}, did: { rested: true }, reach: [], fuses: [] }));
  a.store.db.prepare("UPDATE metadata SET value=? WHERE key='initiative.log'").run(JSON.stringify(log));
  clock.now += 2 * HOUR; a.initiationAck('qq', { id: wakeNow().id, outcome: 'done' });
  assert.equal(view().log.length, WAKE.log);
});

test('what the release before this stored is read or ignored: its tier, its day count, its schedule and its log entries', t => {
  const { a, next, view, clock, wakeNow, done } = fixture(t);
  const old = { wake: { enabled: true, perDay: 8 }, outreach: { tier: 'yes', cardId: 'card:default', at: clock.now - HOUR }, nextAt: clock.now + 10 * MINUTE, lastWakeAt: clock.now - HOUR, due: { day: '2027-01-15', people: 1 },
    moods: [{ text: 'MOCK 旧心情', at: clock.now - HOUR, wakeId: 'w-old' }], notes: [] };
  const entry = { id: 'w-old', type: 'wake', at: clock.now - HOUR, endedAt: clock.now - HOUR, reason: 'intent_due', outcome: 'done', counts: { wokeToday: 0, sinceLastMs: null, reachedToday: 0, intentPeople: 1, chattedPeople: 2 }, did: { outreach: 'yes', rested: false }, tier: 'yes',
    selection: { tier: 'yes', dryRun: true, candidates: [], excluded: [], noneWeight: 1, total: 1, chance: null, random: 0.5, result: 'none' }, second: null, fuses: [] };
  const put = (key, value) => a.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  put('initiative', old); put('initiative.log', [entry]);
  // The switch stays as it was; the times are the default; the old three-hourly schedule is replaced; reaching out is off.
  assert.deepEqual([view().wake, view().reach.enabled, view().nextAt, view().wokeToday, view().moods[0].text, view().log[0].id], [{ enabled: true, times: ['10:00', '19:00'], maxTimes: 2, jitterMinutes: 30 }, false, null, 1, 'MOCK 旧心情', 'w-old']);
  clock.now += 15 * MINUTE;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(view().nextAt, MIDNIGHT + 19 * HOUR);
  const wake = wakeNow();
  assert.match(wake.briefing, /"MOCK 旧心情"/);
  done(wake.id);
  assert.deepEqual(view().log.map(item => item.id), [wake.id, 'w-old']);
});

test('routes: the executor writes through /v1/self with its channel credential and nothing else may; the operator reads /initiative, sets the switches and asks for a wake-up with an empty body', async t => {
  const { a, clock } = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-wake-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokens = { qq: 'q'.repeat(40), maintenance: 'm'.repeat(40), admin: 'a'.repeat(40), operator: 'o'.repeat(40) }, hash = token => createHash('sha256').update(token).digest('hex');
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials: [{ hash: hash(tokens.qq), role: 'capability', capabilityId: 'qq' }, { hash: hash(tokens.maintenance), role: 'maintenance', entityId: DEFAULT_ENTITY_ID }, { hash: hash(tokens.admin), role: 'admin' }] });
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'op.sock'), tokenHash: hash(tokens.operator), origins: [] });
  await app.start(); await operator.start();
  t.after(async () => { await operator.close(); await app.close(); });
  const call = (socket, token, method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, socket), path: route, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const set = (await call('op.sock', tokens.operator, 'POST', '/initiative/settings', { wake: { enabled: true, times: ['09:30'] }, reach: { enabled: true, people: { [label(A)]: true } } })).value;
  assert.deepEqual([set.wake, set.reach.enabled, set.reach.people.filter(item => item.enabled).map(item => item.person).sort()], [{ enabled: true, times: ['09:30'] }, true, [label(OWNER), label(A)].sort()]);
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/initiative/settings', { wake: { perDay: 6 } })).status, 400);
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/initiative/wake', { person: A })).status, 400);
  assert.equal((await call('op.sock', 'x'.repeat(40), 'POST', '/initiative/wake', {})).status, 401);
  assert.deepEqual((await call('op.sock', tokens.operator, 'POST', '/initiative/wake', {})).value, { scheduledAt: clock.now, blocked: null });
  for (const token of [tokens.maintenance, tokens.admin]) assert.equal((await call('api.sock', token, 'POST', '/v1/self', { streamId: OWN, mood: 'MOCK' })).status, 403);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/self', { streamId: OWN, mood: 'MOCK 太早' })).status, 409);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', { busy: true })).value.initiation, null);
  clock.now += WAKE.busyRetryMs;
  const { initiation } = (await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', { busy: false })).value;
  assert.equal(initiation.kind, 'wake');
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/self', { streamId: OWN, mood: 'MOCK 还行', person: A })).status, 400);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/self', { streamId: OWN, outreach: 'yes' })).status, 400);
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/self', { streamId: OWN, mood: 'MOCK 还行', reach: [{ label: label(A), reason: 'MOCK 想聊聊' }] })).value, { mood: 'accepted', reach: ['accepted'] });
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: initiation.id, outcome: 'done' })).value, { status: 'recorded' });
  const out = (await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', {})).value.initiation;
  assert.deepEqual([out.kind, out.streamId, out.light, typeof out.event], ['proactive', stream(A), true, 'string']);
  const shown = (await call('op.sock', tokens.operator, 'GET', '/initiative')).value;
  assert.deepEqual([shown.wake, shown.moods.map(mood => mood.text), shown.log.map(entry => [entry.type, entry.outcome ?? entry.counts])], [{ enabled: true, times: ['09:30'], maxTimes: 2, jitterMinutes: 30 }, ['MOCK 还行'], [['wake', 'done'], ['skip', { busy: 1 }]]]);
  // The mood is on no other operator listing and in no capability answer.
  assert.doesNotMatch(JSON.stringify([(await call('op.sock', tokens.operator, 'GET', '/initiative/log')).value, (await call('op.sock', tokens.operator, 'GET', '/world')).value, (await call('api.sock', tokens.qq, 'POST', '/v1/context', { streamId: stream(OWNER), query: '还行' })).value]), /MOCK 还行/);
});
