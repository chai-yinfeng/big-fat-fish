import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { INITIATION } from '../src/initiations.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';

// Visibly fake accounts: 12 digits starting with 9999. A and B are admitted friends, C is nobody.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012', C = '999900000013';
// What the QQ bridge sends to admit a friend: the account and, in QQ's own terms, its actor and conversation.
const admit = uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` });
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const stream = uid => `qq:${SELF}:private:${uid}`, person = uid => uid === OWNER ? 'person:owner' : `person:qq:${uid}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-done-'));
  // 2027-01-15 16:00 in Beijing: outside the quiet hours.
  const clock = { now: 1_800_000_000_000 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', admit(A)); a.admitPerson('qq', admit(B));
  let seq = 0;
  const say = (uid, text, at = clock.now) => { const eventId = `e-${++seq}`; a.observe('qq', { eventId, streamId: stream(uid), actorId: `qq:${SELF}:user:${uid}`, role: 'user', text, at }); return eventId; };
  // A finished job as the content service lists it: who registered it and where, never the result.
  const job = (uid, change = () => {}) => {
    const value = { id: 'job:' + randomUUID(), capability: 'demo', status: 'done', failureCode: null, scope: { entityId: DEFAULT_ENTITY_ID, streamId: stream(uid), personId: person(uid), audience: 'private', memoryEpoch: 0 }, source: { requestId: 'MOCK-request', sourceEventId: null }, endedAt: clock.now, worldRevision: a.worldStatus().revision, expiresAt: clock.now + 7 * DAY, notice: 'pending' };
    change(value); return value;
  };
  const notices = () => a.drainJobNotices(), outcomes = () => a.initiationLog().items.map(item => item.outcome ?? item.status);
  return { a, clock, root, say, job, notices, outcomes, next: (jobs = []) => a.initiationNext('qq', {}, jobs), carry: (uid, jobs = []) => a.initiationCarry('qq', { streamId: stream(uid) }, jobs) };
}

test('a finished job is handed out for the conversation it was registered in, whoever registered it: a friend\'s goes to that friend, and the caller can name nothing', t => {
  const { a, job, next, notices } = fixture(t);
  const done = job(A);
  for (const body of [{ streamId: stream(B) }, { jobRef: done.id }, { personId: person(B) }, { jobs: [job(B)] }]) assert.throws(() => a.initiationNext('qq', body, [done]), { code: 'VALIDATION_ERROR' });
  notices();
  const { initiation } = next([done]);
  assert.deepEqual(Object.keys(initiation).sort(), ['expiresAt', 'id', 'jobRef', 'kind', 'memoryEpoch', 'streamId']);
  assert.deepEqual([initiation.kind, initiation.streamId, initiation.memoryEpoch, initiation.jobRef], ['completion', stream(A), 0, done.id]);
  // The content service is told it is out, before the bridge can ask for the result.
  assert.deepEqual(notices(), [{ id: done.id, state: 'issued' }]);
  // On the operator's list it is a completion towards A's label; no account, no stream, no job text.
  const [shown] = a.initiationLog().items;
  assert.deepEqual([shown.kind, shown.source, shown.owner, shown.status], ['completion', 'job', false, 'issued']);
  assert.deepEqual(Object.keys(shown).sort(), ['createdAt', 'endedAt', 'id', 'issuedAt', 'kind', 'outcome', 'owner', 'person', 'source', 'status']);
  for (const account of [SELF, A]) assert.ok(!JSON.stringify(a.initiationLog()).includes(account));
  a.initiationAck('qq', { id: initiation.id, outcome: 'sent' });
  assert.deepEqual(notices(), [{ id: done.id, state: 'closed', outcome: 'sent' }]);
  // The owner's own job goes to the owner. Another conversation channel may ask, and is handed nothing of a QQ
  // conversation (nor told anything about its jobs); a capability that is no conversation channel may not ask.
  const own = job(OWNER);
  a.registerCapability({ id: 'native', policy: 'conversation.v1' }); a.registerCapability({ id: 'reader', policy: 'learning.v1' });
  assert.deepEqual(a.initiationNext('native', {}, [own, job(A)]), { initiation: null, reason: 'idle' });
  assert.deepEqual(a.initiationCarry('native', { streamId: stream(A) }, [own, job(A)]), { initiation: null });
  assert.deepEqual(notices(), []);
  assert.equal(next([own]).initiation.streamId, stream(OWNER));
  assert.throws(() => a.initiationNext('reader', {}, [job(A)]), { code: 'FORBIDDEN' });
  assert.throws(() => a.initiationCarry('reader', { streamId: stream(A) }, [job(A)]), { code: 'FORBIDDEN' });
});

test('the target comes only from the job record and must still be what Authority itself has bound: anything else is closed as dropped and never handed out', t => {
  const { a, job, next, notices, say } = fixture(t);
  const asked = say(A, 'MOCK 帮我做一下'), forgotten = say(A, 'MOCK 这句会被忘记');
  a.store.db.prepare("UPDATE observations SET forgotten=1 WHERE capability_id='qq' AND event_id=?").run(forgotten);
  const cases = [
    ['dropped:target', job(C)],                                                               // never admitted: no such conversation
    ['dropped:target', job(A, j => { j.scope.streamId = `qq:${SELF}:group:${A}`; })],          // not a private conversation
    ['dropped:target', job(A, j => { j.scope.streamId = `qq:999900000099:private:${A}`; })],   // another bot's conversation
    ['dropped:target', job(A, j => { j.scope.streamId = stream(B); })],                        // A's job pointed at B's conversation
    ['dropped:target', job(A, j => { j.scope.personId = person(B); })],                        // A's conversation claimed for B
    ['dropped:target', job(A, j => { j.scope.personId = 'person:owner'; })],
    ['dropped:target', job(A, j => { j.scope.entityId = 'entity:other'; })],
    ['dropped:target', job(A, j => { j.scope.audience = 'shared'; })],
    ['dropped:target', job(A, j => { j.scope.streamId = undefined; })],
    ['dropped:epoch', job(A, j => { j.scope.memoryEpoch = 1; })],                             // something was forgotten since
    ['dropped:forgotten', job(A, j => { j.source.sourceEventId = forgotten; })],              // the message that asked for it is gone
    ['dropped:forgotten', job(A, j => { j.source.sourceEventId = 'e-never-observed'; })],
    ['dropped:forgotten', job(A, j => { j.source.sourceEventId = 7; })],
  ];
  for (const [reason, bad] of cases) {
    assert.deepEqual(next([bad]), { initiation: null, reason: 'idle' }, reason);
    assert.deepEqual(notices(), [{ id: bad.id, state: 'closed', outcome: reason }]);
    assert.deepEqual(a.initiationCarry('qq', { streamId: stream(A) }, [bad]), { initiation: null });
    assert.deepEqual(a.initiationCarry('qq', { streamId: stream(B) }, [bad]), { initiation: null });
    notices();
  }
  // Nothing was written for any of them, and malformed entries are ignored outright.
  assert.equal(a.initiationLog().items.length, 0);
  assert.deepEqual(next([null, 'job', { id: 'job:x' }, { ...job(A), id: 'not-a-job' }, { ...job(A), scope: null }]), { initiation: null, reason: 'idle' });
  assert.deepEqual(notices(), []);
  // A person who is no longer admitted is not reached, though the old conversation row is still there.
  const late = job(B);
  a.store.db.prepare("DELETE FROM actors WHERE capability_id='qq' AND actor_id=?").run(`qq:${SELF}:user:${B}`);
  assert.deepEqual([next([late]), notices()], [{ initiation: null, reason: 'idle' }, [{ id: late.id, state: 'closed', outcome: 'dropped:target' }]]);
  // The same job with the message that asked for it intact goes out.
  assert.equal(next([job(A, j => { j.source.sourceEventId = asked; })]).initiation.streamId, stream(A));
});

test('a finished job is told once: handed out, it is never offered again whatever the content service lists, however it ended and however long ago', t => {
  const { a, clock, job, next, carry, notices, outcomes } = fixture(t);
  const done = job(A), { initiation } = next([done]); notices();
  // Still out (the content service missed that): not handed out again, by either road; it is told again that it is out.
  assert.deepEqual([next([done]), carry(A, [done])], [{ initiation: null, reason: 'busy' }, { initiation: null }]);
  assert.deepEqual(notices(), [{ id: done.id, state: 'issued' }, { id: done.id, state: 'issued' }]);
  a.initiationAck('qq', { id: initiation.id, outcome: 'sent' }); notices();
  assert.deepEqual([next([done]), carry(A, [done]), notices()], [{ initiation: null, reason: 'idle' }, { initiation: null }, [{ id: done.id, state: 'closed', outcome: 'sent' }, { id: done.id, state: 'closed', outcome: 'sent' }]]);
  // Every settled ending holds: told, partly told, perhaps told, declined.
  for (const outcome of ['partial', 'unknown', 'declined']) {
    const other = job(A), handed = next([other]).initiation;
    a.initiationAck('qq', { id: handed.id, outcome }); notices();
    assert.deepEqual([next([other]), carry(A, [other])], [{ initiation: null, reason: 'idle' }, { initiation: null }], outcome);
    assert.deepEqual(notices().map(notice => notice.outcome), [outcome, outcome]);
  }
  // Never reported at all: closed as unknown after 20 minutes, and that too is final.
  const silent = job(A); next([silent]); notices();
  clock.now += INITIATION.reportMs;
  assert.deepEqual([next([silent]), notices()], [{ initiation: null, reason: 'idle' }, [{ id: silent.id, state: 'closed', outcome: 'unknown' }, { id: silent.id, state: 'closed', outcome: 'unknown' }]]);
  // More closed requests than the list keeps: the record of a job that may still be listed is not dropped with them.
  for (let n = 0; n < INITIATION.kept + 10; n++) { const { id } = a.initiationPoke(); next(); a.initiationAck('qq', { id, outcome: 'declined' }); }
  assert.deepEqual([next([done]), carry(A, [done])], [{ initiation: null, reason: 'idle' }, { initiation: null }]);
  assert.deepEqual(notices().map(notice => notice.outcome), ['sent', 'sent']);
  assert.equal(outcomes().filter(outcome => outcome === 'sent').length, 1);
  // Once the job itself has expired at the content service, its record goes with the rest.
  clock.now += 8 * DAY; a.initiationPoke();
  assert.ok(!a.initiationLog().items.some(item => item.kind === 'completion'));
});

test('carried: a result she could not start a turn about rides on the registrant\'s next message, never on anyone else\'s, and then never again', t => {
  const { a, job, next, carry, notices, outcomes } = fixture(t);
  // Nothing reached her or the person (the spend tier refused the run, the person spoke first, the run failed): carry-only.
  for (const outcome of ['deferred:budget', 'dropped:person_spoke', 'dropped:stale', 'failed']) {
    const held = job(A), { initiation } = next([held]); notices();
    a.initiationAck('qq', { id: initiation.id, outcome });
    assert.deepEqual(notices(), [{ id: held.id, state: 'carry', outcome }]);
    held.notice = 'carry';
    // She does not start a turn about it again...
    assert.deepEqual([next([held]), notices()], [{ initiation: null, reason: 'idle' }, []]);
    // ...another person's message does not carry it...
    assert.deepEqual([carry(B, [held]), carry(OWNER, [held]), notices()], [{ initiation: null }, { initiation: null }, []]);
    // ...the registrant's own next message does.
    const handed = carry(A, [held]).initiation;
    assert.deepEqual(Object.keys(handed).sort(), ['carried', 'expiresAt', 'id', 'jobRef', 'kind', 'memoryEpoch', 'streamId']);
    assert.deepEqual([handed.kind, handed.streamId, handed.jobRef, handed.carried, notices()], ['completion', stream(A), held.id, true, [{ id: held.id, state: 'issued' }]]);
    assert.deepEqual(carry(A, [held]), { initiation: null }); notices();
    a.initiationAck('qq', { id: handed.id, outcome: 'carried' });
    assert.deepEqual(notices(), [{ id: held.id, state: 'closed', outcome: 'carried' }]);
    assert.deepEqual([carry(A, [held]), next([held])], [{ initiation: null }, { initiation: null, reason: 'idle' }]); notices();
  }
  assert.deepEqual(outcomes().slice(0, 2), ['carried', 'failed']);
  // A result still waiting for her own turn is carried too when the person writes first, and she then starts no turn.
  const fresh = job(B), handed = carry(B, [fresh]).initiation;
  assert.deepEqual([next([fresh]), handed.streamId], [{ initiation: null, reason: 'busy' }, stream(B)]);
  // A carried turn that failed before she had it: reported failed, carried again with the next message.
  a.initiationAck('qq', { id: handed.id, outcome: 'failed' }); notices();
  const again = carry(B, [{ ...fresh, notice: 'carry' }]).initiation;
  assert.equal(again.jobRef, fresh.id);
  // `carried` ends only what was handed out to be carried.
  const own = job(OWNER), started = next([own]).initiation;
  assert.equal(started, null, 'one request is out at a time');
  a.initiationAck('qq', { id: again.id, outcome: 'carried' });
  const turn = next([own]).initiation;
  assert.throws(() => a.initiationAck('qq', { id: turn.id, outcome: 'carried' }), { code: 'CONFLICT' });
  const poke = a.initiationPoke(); a.initiationAck('qq', { id: turn.id, outcome: 'sent' }); next();
  assert.throws(() => a.initiationAck('qq', { id: poke.id, outcome: 'carried' }), { code: 'CONFLICT' });
  for (const body of [{}, { streamId: 7 }, { streamId: stream(A), jobRef: own.id }]) assert.throws(() => a.initiationCarry('qq', body, [own]), { code: 'VALIDATION_ERROR' });
});

test('when she may not start a turn about a finished job it becomes carry-only: a pause, two hours, the quiet hours without a recent message', t => {
  const { a, clock, job, next, carry, notices, say } = fixture(t);
  // Paused: nothing is handed out by either road, and nothing is made up for after the world resumes.
  const paused = job(A);
  a.setWorldPaused({ paused: true });
  assert.deepEqual([next([paused]), carry(A, [paused])], [{ initiation: null, reason: 'paused' }, { initiation: null }]);
  assert.deepEqual(notices(), [{ id: paused.id, state: 'carry', outcome: 'dropped:paused' }]);
  a.setWorldPaused({ paused: false });
  // Finished before a pause the poll never saw: the world revision it finished in is not the current one.
  const before = job(A, j => { j.worldRevision -= 2; }), unknown = job(A, j => { j.worldRevision = null; });
  assert.deepEqual([next([before, unknown]), notices().map(notice => [notice.state, notice.outcome])], [{ initiation: null, reason: 'idle' }, [['carry', 'dropped:paused'], ['carry', 'dropped:paused']]]);
  // It still rides on that person's next message.
  assert.equal(carry(A, [{ ...paused, notice: 'carry' }]).initiation.jobRef, paused.id); notices();
  // Finished two hours ago: carry-only. A minute less: she may still start.
  const old = job(B, j => { j.endedAt = clock.now - INITIATION.completionMs; });
  assert.deepEqual([next([old]), notices()], [{ initiation: null, reason: 'busy' }, [{ id: old.id, state: 'carry', outcome: 'dropped:expired' }]]);
  const recent = job(B, j => { j.endedAt = clock.now - INITIATION.completionMs + MINUTE; });
  next([recent]); assert.deepEqual(notices(), []);
  // Quiet hours (02:00 Beijing): held unless that person wrote in the last ten minutes; someone else's message does not count.
  clock.now += 10 * HOUR;
  // (What was handed out above and never reported has meanwhile ended as unknown.)
  a.initiationLog(); notices();
  const night = job(OWNER);
  say(A, 'MOCK 夜里的话'); say(OWNER, 'MOCK 十一分钟前', clock.now - 11 * MINUTE);
  assert.deepEqual([next([night]).initiation, notices()], [null, [{ id: night.id, state: 'carry', outcome: 'dropped:quiet_hours' }]]);
  const chatting = job(OWNER);
  say(OWNER, 'MOCK 还在聊', clock.now - 9 * MINUTE);
  // (The request to A handed out above is still out: close it first.)
  for (const item of a.initiationLog().items.filter(item => item.status === 'issued')) a.initiationAck('qq', { id: item.id, outcome: 'failed' });
  notices();
  assert.deepEqual([next([chatting]).initiation.streamId, notices()], [stream(OWNER), [{ id: chatting.id, state: 'issued' }]]);
});

test('the two kinds keep their own rule: a poke still reaches only the owner, goes first, and a completion never widens it', t => {
  const { a, job, next, notices } = fixture(t);
  const done = job(A), poked = a.initiationPoke();
  const first = next([done]).initiation;
  assert.deepEqual([first.id, first.kind, first.streamId, Object.keys(first).sort()], [poked.id, 'proactive', stream(OWNER), ['expiresAt', 'id', 'kind', 'memoryEpoch', 'streamId']]);
  assert.deepEqual([next([done]), notices()], [{ initiation: null, reason: 'busy' }, []]);
  a.initiationAck('qq', { id: first.id, outcome: 'sent' });
  assert.equal(next([done]).initiation.streamId, stream(A));
  // A stored waiting request cannot be turned into a completion towards someone: it is dropped.
  const stored = () => JSON.parse(a.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get().value);
  for (const item of a.initiationLog().items.filter(item => item.status === 'issued')) a.initiationAck('qq', { id: item.id, outcome: 'sent' });
  a.initiationPoke();
  const state = stored(); Object.assign(state.items.at(-1), { kind: 'completion', streamId: stream(B), personId: person(B), jobRef: job(B).id });
  a.store.db.prepare("UPDATE metadata SET value=? WHERE key='initiations'").run(JSON.stringify(state));
  assert.deepEqual([next(), a.initiationLog().items[0].outcome], [{ initiation: null, reason: 'idle' }, 'dropped:target']);
});

test('transport: Authority asks the content service with its own control credential and reports back before answering; the channel can read a result but cannot register a job; the operator registers the demo job for the owner only', async t => {
  const { a, root, job } = fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const tokens = { qq: 'q'.repeat(40), maintenance: 'm'.repeat(40), operator: 'o'.repeat(40) };
  const content = { pending: [], calls: [], scoped: [], down: false, list: { limits: { queued: 8, perPerson: 2 }, jobs: [] } };
  const contentJobs = async input => { content.calls.push(input); if (content.down) throw new Error('UNAVAILABLE'); return input.action === 'pending' ? { jobs: content.pending } : input.action === 'list' ? content.list : { id: input.id, status: 'cancelled' }; };
  const contentControl = async (scope, input) => { content.scoped.push({ scope, input }); return input.action === 'jobStart' ? { id: 'job:' + randomUUID(), capability: input.capability, status: 'queued', failureCode: null } : { text: 'MOCK-RESULT' }; };
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials: [{ hash: hash(tokens.qq), role: 'capability', capabilityId: 'qq' }, { hash: hash(tokens.maintenance), role: 'maintenance', entityId: DEFAULT_ENTITY_ID }], contentControl, contentJobs });
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'op.sock'), tokenHash: hash(tokens.operator), origins: [], contentControl, contentJobs });
  await app.start(); await operator.start();
  t.after(async () => { await operator.close(); await app.close(); });
  const call = (socket, token, method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, socket), path: route, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Poll: the content service is asked what is untold, and told what was handed out, before the bridge hears of it.
  const done = job(A); content.pending = [done];
  const fetched = await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', {});
  assert.deepEqual([fetched.status, fetched.value.initiation.kind, fetched.value.initiation.streamId, fetched.value.initiation.jobRef], [200, 'completion', stream(A), done.id]);
  assert.deepEqual(content.calls, [{ action: 'pending' }, { action: 'notice', id: done.id, state: 'issued' }]);
  // The caller supplies no job, no conversation; other principals are refused and the content service is not asked for them.
  content.calls = [];
  for (const body of [{ jobs: [job(B)] }, { jobRef: done.id }, { streamId: stream(B) }]) assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', body)).status, 400);
  assert.equal((await call('api.sock', tokens.maintenance, 'POST', '/v1/initiations/next', {})).status, 403);
  assert.equal((await call('api.sock', tokens.maintenance, 'POST', '/v1/initiations/carry', { streamId: stream(A) })).status, 403);
  assert.deepEqual(content.calls, []);
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: fetched.value.initiation.id, outcome: 'deferred:budget' })).value, { status: 'recorded' });
  assert.deepEqual(content.calls, [{ action: 'notice', id: done.id, state: 'carry', outcome: 'deferred:budget' }]);
  // Carry: asked as B's turn begins, nothing of A's; as A's turn begins, A's result.
  content.calls = []; content.pending = [{ ...done, notice: 'carry' }];
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/carry', { streamId: stream(B) })).value, { initiation: null });
  const carried = await call('api.sock', tokens.qq, 'POST', '/v1/initiations/carry', { streamId: stream(A) });
  assert.deepEqual([carried.value.initiation.jobRef, carried.value.initiation.carried, content.calls.at(-1)], [done.id, true, { action: 'notice', id: done.id, state: 'issued' }]);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/carry', { streamId: stream(A), jobRef: done.id })).status, 400);
  // The content service cannot be reached: an ordinary idle answer, nothing handed out, nothing lost.
  await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: carried.value.initiation.id, outcome: 'carried' });
  content.down = true; content.pending = [job(B)];
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', {})).value, { initiation: null, reason: 'idle' });
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/carry', { streamId: stream(B) })).value, { initiation: null });
  content.down = false;
  // The scoped content route: the channel may read a result in a conversation it serves; it cannot register a job.
  const read = await call('api.sock', tokens.qq, 'POST', '/v1/content', { action: 'jobResult', streamId: stream(A), memoryEpoch: 0, ref: done.id });
  assert.deepEqual([read.status, content.scoped.at(-1).scope.streamId, content.scoped.at(-1).scope.personId, content.scoped.at(-1).input.ref], [200, stream(A), person(A), done.id]);
  const before = content.scoped.length;
  for (const action of ['jobStart', 'job', 'jobs', 'jobCancel']) assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/content', { action, streamId: stream(A), memoryEpoch: 0, capability: 'demo' })).status, 400, action);
  assert.equal(content.scoped.length, before);
  // Operator: the demo job is registered in the owner's own conversation; the body can name nobody.
  for (const body of [{ streamId: stream(A) }, { personId: person(A) }, { uid: A }, { seconds: 0 }, { seconds: 121 }, { seconds: '5' }]) assert.equal((await call('op.sock', tokens.operator, 'POST', '/jobs/demo', body)).status, 400);
  assert.equal(content.scoped.length, before);
  assert.equal((await call('op.sock', 'x'.repeat(40), 'POST', '/jobs/demo', {})).status, 401);
  const started = await call('op.sock', tokens.operator, 'POST', '/jobs/demo', { seconds: 3 });
  const sent = content.scoped.at(-1);
  assert.deepEqual([started.status, started.value.status, sent.scope.streamId, sent.scope.personId, sent.scope.audience, sent.scope.memoryEpoch], [200, 'queued', stream(OWNER), 'person:owner', 'private', 0]);
  assert.deepEqual([sent.input.action, sent.input.capability, sent.input.input, /^operator:[a-f0-9-]{36}$/.test(sent.input.requestId)], ['jobStart', 'demo', { seconds: 3 }, true]);
  await call('op.sock', tokens.operator, 'POST', '/jobs/demo', {});
  assert.deepEqual(content.scoped.at(-1).input.input, {});
  // Paused: nothing is registered.
  a.setWorldPaused({ paused: true });
  assert.deepEqual([(await call('op.sock', tokens.operator, 'POST', '/jobs/demo', {})).status, content.scoped.length], [409, before + 2]);
  a.setWorldPaused({ paused: false });
  // The list: people as opaque labels, no conversation and no account; cancelling names a job and nothing else.
  content.list = { limits: { queued: 8, perPerson: 2 }, jobs: [{ id: done.id, capability: 'demo', title: '演示任务', status: 'done', failureCode: null, scope: done.scope, notice: { state: 'closed', outcome: 'carried', at: 1 }, result: 'MOCK-RESULT' }, { id: 'job:' + randomUUID(), capability: 'demo', status: 'rejected', failureCode: 'daily_limit', scope: job(OWNER).scope, notice: { state: 'none', outcome: null, at: 2 }, result: null }] };
  const listed = await call('op.sock', tokens.operator, 'GET', '/jobs');
  assert.deepEqual([listed.status, listed.value.limits, listed.value.jobs.map(entry => [entry.owner, /^p-[0-9a-f]{6}$/.test(entry.person), entry.status, entry.failureCode, entry.result, 'scope' in entry])], [200, { queued: 8, perPerson: 2 }, [[false, true, 'done', null, 'MOCK-RESULT', false], [true, true, 'rejected', 'daily_limit', null, false]]]);
  for (const account of [SELF, OWNER, A]) assert.ok(!JSON.stringify(listed.value).includes(account));
  for (const body of [{ id: 'x' }, { id: done.id, streamId: stream(A) }, {}]) assert.equal((await call('op.sock', tokens.operator, 'POST', '/jobs/cancel', body)).status, 400);
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/jobs/cancel', { id: done.id })).status, 200);
  assert.deepEqual(content.calls.at(-1), { action: 'cancel', id: done.id });
  assert.equal((await call('api.sock', tokens.qq, 'GET', '/jobs')).status, 404);
  // Without a content service there is nothing to list or register, and polling is as before.
  const bare = createOperatorServer({ authority: a, socketPath: path.join(root, 'bare.sock'), tokenHash: hash(tokens.operator), origins: [] });
  await bare.start(); t.after(() => bare.close());
  assert.deepEqual([(await call('bare.sock', tokens.operator, 'GET', '/jobs')).status, (await call('bare.sock', tokens.operator, 'POST', '/jobs/demo', {})).status], [503, 503]);
});
