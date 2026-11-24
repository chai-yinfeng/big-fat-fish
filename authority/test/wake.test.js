import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { opaquePerson } from '../src/context.js';
import { SELF_PERSON, WAKE, SELECTION, candidateWeights, pick, refusedText, renderBriefing } from '../src/wake.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012', C = '999900000013';
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => `person:qq:${uid}`;
const OWN = 'qq:self';
// Nothing of any person: no test marker, account number, opaque label, person ID or channel conversation ID.
const OF_A_PERSON = /MOCK|9999\d{8}|p-[0-9a-f]{6}|person:|owner|private:/i;
function fixture(t, { quiet = 'none' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-wake-'));
  // 2027-01-15 16:00 in Beijing. `random.value` 0.5 makes every schedule shift zero.
  const clock = { now: 1_800_000_000_000 }, random = { value: 0.5 };
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
  const next = (input = {}) => a.initiationNext('qq', input);
  const view = () => a.initiativeView();
  /** Turns the switch on and has the operator ask for a wake-up now: the next poll hands one out when nothing forbids it. */
  const enable = (wake = {}) => a.initiationSettings({ wake: { enabled: true, ...wake } });
  const wakeNow = () => { a.initiativeWake(); return next().initiation; };
  const done = id => a.initiationAck('qq', { id, outcome: 'done' });
  return { a, clock, random, say, propose, next, view, enable, wakeNow, done };
}

test('off until the operator turns it on: nothing is scheduled or handed out, and a wake-up asked for meanwhile is only counted', t => {
  const { a, next, view, clock } = fixture(t);
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual([view().wake.enabled, view().wake.perDay, view().nextAt, view().log, view().moods, view().notes, view().outreach], [false, 8, null, [], [], [], 'none']);
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now, blocked: 'off' });
  clock.now += 4 * HOUR;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual(view().log.map(entry => [entry.type, entry.counts]), [['skip', { off: 1 }]]);
  // Not counted again on later polls, and her own conversation was never bound.
  next(); next();
  assert.deepEqual(view().log[0].counts, { off: 1 });
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM streams WHERE stream_id=?').get(OWN).n, 0);
  for (const body of [{}, { wake: {} , extra: 1 }, { wake: { enabled: 'yes' } }, { wake: { perDay: 0 } }, { wake: { perDay: WAKE.perDayMax + 1 } }, { wake: { perDay: 2.5 } }, { wake: { person: A } }]) assert.throws(() => a.initiationSettings(body), { code: 'VALIDATION_ERROR' });
  for (const body of [{ person: A }, { streamId: stream(A) }]) assert.throws(() => a.initiativeWake(body), { code: 'VALIDATION_ERROR' });
});

test('about every 3 hours: the first wake-up comes one interval after the switch, runs in her own conversation, and may do nothing at all', t => {
  const { a, next, view, clock, enable, done } = fixture(t);
  assert.deepEqual(enable().wake, { enabled: true, perDay: 8 });
  const from = clock.now;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(view().nextAt, from + 3 * HOUR);
  clock.now = from + 3 * HOUR - 1;
  assert.equal(next().initiation, null);
  clock.now += 1;
  const { initiation } = next();
  assert.deepEqual(Object.keys(initiation).sort(), ['briefing', 'expiresAt', 'id', 'kind', 'memoryEpoch', 'streamId']);
  assert.deepEqual([initiation.kind, initiation.streamId, initiation.memoryEpoch, initiation.expiresAt], ['wake', OWN, 0, clock.now + 5 * MINUTE]);
  // Her own conversation is an ordinary private binding to the reserved person, made by Authority itself.
  assert.deepEqual({ ...a.store.db.prepare('SELECT person_id,audience,entity_id FROM streams WHERE capability_id=? AND stream_id=?').get('qq', OWN) }, { person_id: SELF_PERSON, audience: 'private', entity_id: DEFAULT_ENTITY_ID });
  // While it is out nothing else of hers is handed out.
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  // She did nothing: reported once as done.
  assert.deepEqual(done(initiation.id), { status: 'recorded' });
  assert.deepEqual(done(initiation.id), { status: 'recorded', replayed: true });
  assert.throws(() => a.initiationAck('qq', { id: initiation.id, outcome: 'failed' }), { code: 'CONFLICT' });
  const [entry] = view().log;
  assert.deepEqual([entry.type, entry.id, entry.reason, entry.outcome, entry.did, entry.tier, entry.selection, entry.second, entry.fuses], ['wake', initiation.id, 'schedule', 'done', { rested: true }, 'none', null, null, []]);
  assert.deepEqual(entry.counts, { wokeToday: 0, sinceLastMs: null, reachedToday: 0, intentPeople: 0, chattedPeople: 0 });
  // The next one is another interval away; `random` moves it by up to half an hour either way.
  assert.deepEqual([view().wokeToday, view().nextAt, view().lastWakeAt], [1, clock.now + 3 * HOUR, clock.now]);
  // No request to anybody came of it.
  assert.deepEqual(a.initiationLog().items, []);
  // `done` ends a wake-up and nothing else.
  const poked = a.initiationPoke(); next();
  assert.throws(() => a.initiationAck('qq', { id: poked.id, outcome: 'done' }), { code: 'CONFLICT' });
});

test('the schedule shifts at random within half an hour, and a request to a person always goes before her own wake-up', t => {
  const { a, next, view, clock, random, enable, done } = fixture(t);
  random.value = 0; enable(); next();
  assert.equal(view().nextAt, clock.now + 3 * HOUR - 30 * MINUTE);
  clock.now += 3 * HOUR;
  const poked = a.initiationPoke();
  assert.equal(next().initiation.id, poked.id);
  // The poke is out: nothing else. Once it is reported the wake-up, still due, is handed out.
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  a.initiationAck('qq', { id: poked.id, outcome: 'declined' });
  random.value = 0.999;
  const { initiation } = next();
  assert.equal(initiation.kind, 'wake'); done(initiation.id);
  assert.ok(view().nextAt > clock.now + 3 * HOUR + 29 * MINUTE && view().nextAt <= clock.now + 3 * HOUR + 30 * MINUTE);
});

test('she does not wake in the quiet hours, while the world is paused, once the spend tier refused, with turns queued, or past the day\'s count; each is counted with its reason', t => {
  const { a, next, view, clock, enable, wakeNow, done } = fixture(t, { quiet: 'default' });
  const skips = () => view().log.find(entry => entry.type === 'skip' && entry.day === new Date(clock.now + 8 * HOUR).toISOString().slice(0, 10))?.counts ?? {};
  enable({ perDay: 3 });
  // Quiet hours (16:00 Beijing now): moved to their end, and the reason it was due is kept.
  a.initiationSettings({ quietHours: { from: '15:00', to: '17:00' } });
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now, blocked: 'quiet_hours' });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual(skips(), { quiet_hours: 1 });
  assert.equal(view().nextAt, clock.now + HOUR + 15 * MINUTE);
  clock.now += HOUR + 15 * MINUTE;
  const first = next().initiation;
  assert.match(first.briefing, /这次醒来是因为：主人让你现在醒一次/);
  done(first.id);
  // 45 minutes at least between two, whoever asks.
  assert.deepEqual(a.initiativeWake(), { scheduledAt: clock.now + 45 * MINUTE, blocked: null });
  assert.equal(next().initiation, null);
  clock.now += 45 * MINUTE;
  // Paused: not handed out, and nothing is made up for after the resume.
  a.setWorldPaused({ paused: true });
  assert.deepEqual(next(), { initiation: null, reason: 'paused' });
  assert.deepEqual(skips(), { quiet_hours: 1, paused: 1 });
  a.setWorldPaused({ paused: false });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(view().nextAt, clock.now + 3 * HOUR);
  // The bridge has turns queued: held back and tried again a little later.
  a.initiativeWake();
  assert.deepEqual(a.initiationNext('qq', { busy: true }), { initiation: null, reason: 'idle' });
  assert.deepEqual(skips(), { quiet_hours: 1, paused: 1, busy: 1 });
  assert.equal(view().nextAt, clock.now + WAKE.busyRetryMs);
  clock.now += WAKE.busyRetryMs;
  const second = a.initiationNext('qq', { busy: false }).initiation;
  assert.equal(second.kind, 'wake');
  // The gateway's spend tier (60%) refused the run: no wake-up for the rest of that Beijing day.
  assert.deepEqual(a.initiationAck('qq', { id: second.id, outcome: 'deferred:budget' }), { status: 'recorded' });
  assert.equal(view().wokeToday, 1);
  clock.now += 45 * MINUTE;
  assert.equal(a.initiativeWake().blocked, 'budget');
  assert.equal(next().initiation, null);
  assert.deepEqual(skips(), { quiet_hours: 1, paused: 1, busy: 1, budget: 1 });
  // The next day it wakes again (the quiet hours first move it to their end).
  a.initiationSettings({ quietHours: { from: '00:00', to: '00:00' } });
  clock.now = view().nextAt;
  assert.equal(new Date(clock.now + 8 * HOUR).toISOString().slice(0, 16), '2027-01-16T00:15');
  const third = next().initiation; done(third.id);
  // The day's count (3 here): the fourth is not handed out, and the next is the day after.
  for (let i = 0; i < 2; i++) { clock.now += HOUR; done(wakeNow().id); }
  clock.now += HOUR;
  assert.equal(a.initiativeWake().blocked, 'daily_limit');
  assert.equal(next().initiation, null);
  assert.deepEqual(skips(), { daily_limit: 1 });
  assert.equal(new Date(view().nextAt + 8 * HOUR).toISOString().slice(0, 16), '2027-01-17T00:15');
  assert.throws(() => a.initiationNext('qq', { busy: 'yes' }), { code: 'VALIDATION_ERROR' });
});

test('the briefing holds the time and counts about herself, and nothing of any person: no words, intent, fact, name, label or account', t => {
  const { a, say, propose, clock, enable, wakeNow, done, view } = fixture(t);
  // B spoke yesterday; the owner and A today. A has an intent due today, a fact, and a fact the operator made public.
  clock.now -= DAY; say(B, 'MOCK-B 昨天说的话'); clock.now += DAY;
  say(OWNER, 'MOCK-OWNER 今天说的话');
  const line = say(A, 'MOCK-A 明天面试，我住在 MOCK-CITY');
  assert.equal(propose(line, 'intent.note', { text: 'MOCK-INTENT 问问面试', quote: '明天面试', due: '2027-01-15' }).status, 'accepted');
  assert.equal(propose(line, 'fact.report', { key: 'MOCK-KEY 住处', value: 'MOCK-CITY', quote: '我住在 MOCK-CITY' }).status, 'accepted');
  const fact = a.listMemory({ limit: 50 }).items.find(item => item.type === 'facts');
  a.markMemoryPublic({ entityId: DEFAULT_ENTITY_ID, id: fact.id });
  // The owner's own chat does read A's public fact; her wake-up reads nobody's.
  assert.match(a.context('qq', { streamId: stream(OWNER), query: 'MOCK-CITY' }).text, /MOCK-CITY/);
  assert.equal(Object.hasOwn(a.context('qq', { streamId: stream(OWNER) }), 'own'), false);
  clock.now += HOUR; enable();
  // An intent that is due brings the first wake-up forward to the very next poll.
  const wake = a.initiationNext('qq').initiation;
  assert.equal(wake.kind, 'wake');
  assert.doesNotMatch(JSON.stringify(wake), OF_A_PERSON);
  assert.equal(wake.briefing, [
    '现在是 2027年1月15日 周五 17:00（北京时间）。这次醒来是因为：有打算到了该办的日子。',
    '你还没有写过心情。',
    '你现在的档位：不想主动找人（none）。',
    '关于你自己的几个数：今天这是第 1 次醒来；之前还没有醒过；今天你主动找过 0 个人；有 1 个人身上有你留的、到今天该办的打算；今天有 2 个人和你聊过。',
  ].join('\n'));
  // What her own conversation can read through the ordinary context: the persona, and nothing of anyone.
  for (const query of ['', 'MOCK-CITY 面试', 'MOCK-INTENT']) {
    const context = a.context('qq', { streamId: OWN, query, profile: true, windowFromAt: clock.now });
    assert.doesNotMatch(JSON.stringify({ ...context, scope: null }), OF_A_PERSON);
    assert.deepEqual([context.memoryText, context.profileText, context.continuationText, context.memoryIds, context.own], ['', '', '', [], true]);
    assert.deepEqual(a.memorySearch('qq', { streamId: OWN, query: query || 'MOCK', windowFromAt: clock.now }).items, []);
  }
  assert.equal(a.memoryRead('qq', { streamId: OWN, id: fact.id }).item, null);
  done(wake.id);
  // The log entry: counts and no person.
  assert.doesNotMatch(JSON.stringify(view().log), OF_A_PERSON);
  assert.deepEqual(view().log[0].counts, { wokeToday: 0, sinceLastMs: null, reachedToday: 0, intentPeople: 1, chattedPeople: 2 });
  assert.equal(view().log[0].reason, 'intent_due');
  // The same due intent does not bring another one forward; one more person with a due intent does, 45 minutes on at the earliest.
  assert.equal(a.initiationNext('qq').initiation, null);
  assert.equal(view().nextAt, clock.now + 3 * HOUR);
  const other = say(B, 'MOCK-B 今天要交报告');
  propose(other, 'intent.note', { text: 'MOCK-INTENT-B 问问报告', quote: '今天要交报告', due: '2027-01-15' });
  assert.equal(a.initiationNext('qq').initiation, null);
  assert.equal(view().nextAt, clock.now + 45 * MINUTE);
  clock.now += 45 * MINUTE;
  const again = a.initiationNext('qq').initiation;
  assert.match(again.briefing, /今天这是第 2 次醒来；上次醒来是 45 分钟前；今天你主动找过 0 个人；有 2 个人身上有你留的、到今天该办的打算；今天有 3 个人和你聊过/);
  assert.doesNotMatch(JSON.stringify(again), OF_A_PERSON);
});

test('briefing text: her last mood and tier are her own words and choice; a count of people she reached is a number', () => {
  const now = Date.parse('2027-01-15T08:00:00Z');
  const text = renderBriefing({ now, reason: 'schedule', counts: { wokeToday: 2, sinceLastMs: 3 * HOUR, reachedToday: 1, intentPeople: 0, chattedPeople: 4 }, mood: { text: 'MOCK 有点困', at: now - 26 * HOUR }, tier: 'maybe' });
  assert.equal(text, '现在是 2027年1月15日 周五 16:00（北京时间）。这次醒来是因为：到点了。\n你上次写下的心情（26 小时前）："MOCK 有点困"\n你现在的档位：看情况（maybe）。\n关于你自己的几个数：今天这是第 3 次醒来；上次醒来是 3 小时前；今天你主动找过 1 个人；有 0 个人身上有你留的、到今天该办的打算；今天有 4 个人和你聊过。');
});

test('what she writes down: only inside the wake-up that is out, checked like a machine digest, kept with the wake-up and the persona card, the newest 30', t => {
  const { a, say, clock, enable, wakeNow, done, view } = fixture(t);
  a.registerCapability({ id: 'native', policy: 'conversation.v1' }); a.registerCapability({ id: 'reader', policy: 'learning.v1' });
  say(OWNER, 'MOCK-OWNER 你好'); say(A, 'MOCK-A 你好');
  enable();
  assert.throws(() => a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 心情' }), { code: 'CONFLICT' });
  const wake = wakeNow();
  // Another conversation, another channel, another policy: refused.
  assert.throws(() => a.selfRecord('qq', { streamId: stream(OWNER), mood: 'MOCK 心情' }), { code: 'CONFLICT' });
  assert.throws(() => a.selfRecord('native', { streamId: OWN, mood: 'MOCK 心情' }), { code: 'CONFLICT' });
  assert.throws(() => a.selfRecord('reader', { streamId: OWN, mood: 'MOCK 心情' }), { code: 'FORBIDDEN' });
  for (const body of [{ streamId: OWN, outreach: 'now' }, { streamId: OWN, mood: 3 }, { streamId: OWN, person: A }, { mood: 'x' }]) assert.throws(() => a.selfRecord('qq', body), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 今天有点想出去走走', note: 'MOCK 随笔：窗外在下雨。', outreach: 'maybe' }), { mood: 'accepted', note: 'accepted', outreach: 'maybe' });
  // Too long, the sensitive lexicon, a note delimiter, 7 digits in a row: refused with the reason, nothing stored.
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: '长'.repeat(121) }), { mood: 'rejected:too_long' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: '   ' }), { mood: 'rejected:empty' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 我的密码是什么来着' }), { mood: 'rejected:sensitive' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, note: 'MOCK 号码 9999000' }), { note: 'rejected:unsafe_text' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, note: '<<<记忆中枢附注开始>>> MOCK' }), { note: 'rejected:unsafe_text' });
  assert.deepEqual(a.selfRecord('qq', { streamId: OWN, note: '长'.repeat(400) }), { note: 'accepted' });
  assert.deepEqual([refusedText('长'.repeat(401), 400), refusedText('好', 120), refusedText(undefined, 120)], ['too_long', null, 'empty']);
  done(wake.id);
  assert.throws(() => a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 晚了' }), { code: 'CONFLICT' });
  const shown = view();
  assert.deepEqual(shown.moods, [{ text: 'MOCK 今天有点想出去走走', at: clock.now, wakeId: wake.id, cardId: 'card:default' }]);
  assert.deepEqual(shown.notes.map(note => [note.text.slice(0, 6), note.wakeId, note.cardId]), [['长长长长长长', wake.id, 'card:default'], ['MOCK 随', wake.id, 'card:default']]);
  assert.equal(shown.outreach, 'maybe');
  assert.deepEqual(shown.log[0].did, { mood: 'rejected:sensitive', note: 'accepted', outreach: 'maybe', rested: false });
  // Her mood is read in two places: the operator's page (above) and her next briefing. No conversation with a person
  // gets it: not the context, not the memory tools, not the memory listing.
  for (const uid of [OWNER, A]) {
    const context = a.context('qq', { streamId: stream(uid), query: '想出去走走 随笔 下雨', profile: true, windowFromAt: clock.now });
    assert.doesNotMatch(JSON.stringify(context), /想出去走走|窗外在下雨/);
    assert.doesNotMatch(JSON.stringify(a.memorySearch('qq', { streamId: stream(uid), query: '想出去走走 随笔 下雨' })), /想出去走走|窗外在下雨/);
  }
  assert.doesNotMatch(JSON.stringify(a.listMemory({ limit: 100 })), /想出去走走|窗外在下雨/);
  clock.now += HOUR;
  const second = wakeNow();
  assert.match(second.briefing, /你上次写下的心情（1 小时前）："MOCK 今天有点想出去走走"\n你现在的档位：看情况（maybe）。/);
  // The newest 30 moods are kept.
  for (let i = 0; i < 31; i++) a.selfRecord('qq', { streamId: OWN, mood: `MOCK 心情 ${i}` });
  done(second.id);
  assert.deepEqual([view().moods.length, view().moods[0].text, view().moods.at(-1).text], [30, 'MOCK 心情 30', 'MOCK 心情 1']);
  // Subjective memory belongs to a persona card: under another card neither the mood nor the tier is read back.
  a.setWorldPaused({ paused: true });
  const card = a.createPersonaCard({ title: 'MOCK 另一张卡' });
  a.activatePersonaCard({ id: card.id, reason: 'MOCK 换卡' });
  a.setWorldPaused({ paused: false });
  clock.now += HOUR;
  const third = wakeNow();
  assert.match(third.briefing, /你还没有写过心情。\n你现在的档位：不想主动找人（none）。/);
  assert.equal(view().outreach, 'none');
});

test('the pick of a person is only worked through: forced rules keep people out, the weights multiply, the draw is logged under opaque labels, and no request is made', t => {
  const { a, say, propose, clock, random, enable, wakeNow, done, view } = fixture(t);
  a.admitPerson('qq', admit(C));
  // A group conversation of A, and a stranger who was never admitted: never candidates.
  a.bindStream({ capabilityId: 'qq', streamId: `qq:${SELF}:group:999900000099`, personId: person(A), audience: 'shared' });
  const T = clock.now;
  // The owner: known for 20 days, 25 lines then and one two days ago.
  clock.now = T - 20 * DAY; for (let i = 0; i < 25; i++) say(OWNER, `MOCK-OWNER 旧话 ${i}`);
  clock.now = T - 2 * DAY; say(OWNER, 'MOCK-OWNER 前天');
  // A: one line five days ago, and an intent due today.
  clock.now = T - 5 * DAY;
  propose(say(A, 'MOCK-A 15 号面试'), 'intent.note', { text: 'MOCK-INTENT 问问面试', quote: '15 号面试', due: '2027-01-15' });
  // C asked for distance three days ago (an accepted boundary appraisal); B wrote ten minutes ago.
  clock.now = T - 3 * DAY;
  assert.equal(propose(say(C, 'MOCK-C 最近别找我'), 'appraisal.record', { kind: 'boundary', quote: '最近别找我' }).status, 'accepted');
  clock.now = T - 10 * MINUTE; say(B, 'MOCK-B 刚说的');
  clock.now = T; enable();
  const label = uid => opaquePerson(uid === OWNER ? 'person:owner' : person(uid));
  // Tier `yes`: one draw over the owner, A and "nobody this time".
  let wake = wakeNow();
  a.selfRecord('qq', { streamId: OWN, outreach: 'yes' });
  random.value = 0.5; done(wake.id);
  let entry = view().log[0];
  assert.deepEqual([entry.tier, entry.did, entry.second, entry.fuses], ['yes', { outreach: 'yes', rested: false }, null, []]);
  assert.deepEqual(entry.selection.candidates.map(item => [item.person, item.owner === true, item.weights, item.weight]), [
    [label(OWNER), true, { intent: 1, chatter: 1.02, gap: 1, reached: 1, unanswered: 1, newcomer: 1 }, 1.02],
    [label(A), false, { intent: 4, chatter: 1.02, gap: 1.5, reached: 1, unanswered: 1, newcomer: 0.3 }, 1.836],
  ]);
  assert.deepEqual(entry.selection.excluded, [{ person: label(B), reason: 'recent' }, { person: label(C), reason: 'boundary' }]);
  assert.deepEqual([entry.selection.dryRun, entry.selection.noneWeight, entry.selection.total, entry.selection.chance, entry.selection.random, entry.selection.result], [true, 1, 3.856, null, 0.5, label(A)]);
  // Labels and numbers only.
  assert.doesNotMatch(JSON.stringify(view().log), /MOCK|9999\d{8}|person:|private:/);
  // Tier `maybe`: a 30% chance first. Not taken: nobody. Taken: the draw.
  clock.now += HOUR; wake = wakeNow(); a.selfRecord('qq', { streamId: OWN, outreach: 'maybe' });
  random.value = 0.3; done(wake.id); entry = view().log[0];
  assert.deepEqual([entry.selection.chance, entry.selection.total, entry.selection.random, entry.selection.result], [{ needed: 0.3, roll: 0.3, passed: false }, null, null, 'none']);
  clock.now += HOUR; wake = wakeNow();
  random.value = 0.1; done(wake.id); entry = view().log[0];
  assert.deepEqual([entry.tier, entry.did, entry.selection.chance.passed, entry.selection.random, entry.selection.result], ['maybe', { rested: true }, true, 0.1, label(OWNER)]);
  // The last slice of the draw is "nobody this time".
  clock.now += HOUR; wake = wakeNow(); a.selfRecord('qq', { streamId: OWN, outreach: 'yes' });
  random.value = 0.99; done(wake.id);
  assert.equal(view().log[0].selection.result, 'none');
  // Tier `none`: no pick at all.
  clock.now += HOUR; wake = wakeNow(); a.selfRecord('qq', { streamId: OWN, outreach: 'none' }); done(wake.id);
  assert.deepEqual([view().log[0].tier, view().log[0].selection], ['none', null]);
  // Step 6b acts on none of it: no request to anybody was ever registered.
  assert.deepEqual(a.initiationLog().items, []);
  assert.deepEqual(JSON.parse(a.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get().value).items, []);
});

test('weights (design 3.4): each factor on its own, and a draw over nothing but "nobody" picks nobody', () => {
  const now = 100 * DAY, base = { intent: 'none', lines14: 0, lastAt: now - 2 * DAY, reached7: 0, unanswered: 0, firstAt: now - 30 * DAY, lines: 50 };
  const of = change => candidateWeights({ ...base, ...change }, now).weights;
  assert.deepEqual(of({}), { intent: 1, chatter: 1, gap: 1, reached: 1, unanswered: 1, newcomer: 1 });
  assert.deepEqual([of({ intent: 'due' }).intent, of({ intent: 'open' }).intent], [4, 2]);
  assert.deepEqual([of({ lines14: 50 }).chatter, of({ lines14: 500 }).chatter], [2, 3]);
  assert.deepEqual([now - HOUR, now - 2 * DAY, now - 5 * DAY, now - 20 * DAY, null].map(lastAt => of({ lastAt }).gap), [0.5, 1, 1.5, 1, 1]);
  assert.deepEqual([of({ reached7: 1 }).reached, of({ reached7: 3 }).reached], [0.5, 0.25]);
  assert.deepEqual([1, 2, 3].map(unanswered => of({ unanswered }).unanswered), [0.25, 0.0625, 0.05]);
  assert.deepEqual([of({ firstAt: now - DAY }).newcomer, of({ lines: 19 }).newcomer, of({ firstAt: null }).newcomer], [0.3, 0.3, 0.3]);
  assert.equal(candidateWeights({ ...base, intent: 'due', unanswered: 1 }, now).weight, 1);
  const alone = pick({ tier: 'yes', candidates: [], excluded: [], random: () => 0 });
  assert.deepEqual([alone.total, alone.result], [SELECTION.noneWeight, 'none']);
  // One low-weight candidate: most draws pick nobody.
  const low = [{ person: 'p-000000', weight: 0.05 }];
  assert.deepEqual([0.04, 0.05, 0.9].map(roll => pick({ tier: 'yes', candidates: low, excluded: [], random: () => roll }).result), ['p-000000', 'none', 'none']);
});

test('the reserved person is nobody: no account or conversation can be bound to it, nothing is observed in her conversation, and it is not listed as anyone\'s', t => {
  const { a, enable, wakeNow, done, clock } = fixture(t);
  assert.throws(() => a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${C}`, personId: SELF_PERSON }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.bindStream({ capabilityId: 'qq', streamId: stream(C), personId: SELF_PERSON, audience: 'private' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.attachAccount({ capabilityId: 'qq', actorId: `qq:${SELF}:user:${A}`, streamId: stream(A), personId: SELF_PERSON, move: true }), { code: 'VALIDATION_ERROR' });
  enable(); done(wakeNow().id);
  assert.throws(() => a.observe('qq', { eventId: 'e-own', streamId: OWN, actorId: `qq:${SELF}:user:${A}`, role: 'user', text: 'MOCK 混进来的话', at: clock.now }), { code: 'FORBIDDEN' });
  // A bridge cannot admit an account into her conversation either: the binding is taken.
  assert.throws(() => a.admitPerson('qq', { uid: C, actorId: `qq:${SELF}:user:${C}`, streamId: OWN }), { code: 'CONFLICT' });
  assert.ok(!a.listConversations().some(row => row.streamId === OWN));
  assert.ok(!a.listPeople().people.some(row => row.personId === SELF_PERSON));
  // Only the channel the owner last spoke on carries wake-ups.
  a.registerCapability({ id: 'native', policy: 'conversation.v1' });
  a.initiativeWake(); clock.now += HOUR;
  assert.deepEqual(a.initiationNext('native'), { initiation: null, reason: 'idle' });
  assert.equal(a.initiationNext('qq').initiation.kind, 'wake');
});

test('a wake-up nobody reported is closed as unknown after 20 minutes; the late report may still replace that', t => {
  const { a, next, view, clock, enable, wakeNow } = fixture(t);
  enable();
  const wake = wakeNow();
  a.selfRecord('qq', { streamId: OWN, mood: 'MOCK 写到一半' });
  clock.now += 19 * MINUTE;
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  clock.now += MINUTE;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual([view().log[0].outcome, view().log[0].unreported, view().log[0].did, view().out], ['unknown', true, { mood: 'accepted', rested: false }, null]);
  assert.throws(() => a.initiationAck('qq', { id: wake.id, outcome: 'sent' }), { code: 'CONFLICT' });
  assert.deepEqual(a.initiationAck('qq', { id: wake.id, outcome: 'failed' }), { status: 'recorded' });
  assert.deepEqual([view().log[0].outcome, view().log[0].unreported], ['failed', undefined]);
  assert.deepEqual(a.initiationAck('qq', { id: wake.id, outcome: 'failed' }), { status: 'recorded', replayed: true });
  assert.throws(() => a.initiationAck('qq', { id: wake.id, outcome: 'done' }), { code: 'CONFLICT' });
  // The log keeps the newest 300 entries.
  const log = Array.from({ length: 320 }, (_, index) => ({ id: `w-${index}`, type: 'wake', at: index, endedAt: index, reason: 'schedule', outcome: 'done', counts: {}, did: { rested: true }, tier: 'none', selection: null, second: null, fuses: [] }));
  a.store.db.prepare("UPDATE metadata SET value=? WHERE key='initiative.log'").run(JSON.stringify(log));
  clock.now += 2 * HOUR; a.initiationAck('qq', { id: wakeNow().id, outcome: 'done' });
  assert.equal(view().log.length, WAKE.log);
});

test('routes: the executor writes through /v1/self with its channel credential and nothing else may; the operator reads /initiative and asks for a wake-up with an empty body', async t => {
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
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/initiative/settings', { wake: { enabled: true, perDay: 6 } })).value.wake.perDay, 6);
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
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/self', { streamId: OWN, mood: 'MOCK 还行', outreach: 'none' })).value, { mood: 'accepted', outreach: 'none' });
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: initiation.id, outcome: 'done' })).value, { status: 'recorded' });
  const shown = (await call('op.sock', tokens.operator, 'GET', '/initiative')).value;
  assert.deepEqual([shown.wake, shown.moods.map(mood => mood.text), shown.log.map(entry => [entry.type, entry.outcome ?? entry.counts])], [{ enabled: true, perDay: 6, perDayMax: 24, intervalMinutes: 180, minGapMinutes: 45 }, ['MOCK 还行'], [['wake', 'done'], ['skip', { busy: 1 }]]]);
  // The mood is on no other operator listing and in no capability answer.
  assert.doesNotMatch(JSON.stringify([(await call('op.sock', tokens.operator, 'GET', '/initiative/log')).value, (await call('op.sock', tokens.operator, 'GET', '/world')).value, (await call('api.sock', tokens.qq, 'POST', '/v1/context', { streamId: stream(OWNER), query: '还行' })).value]), /MOCK 还行/);
});
