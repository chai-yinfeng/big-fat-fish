import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { INITIATION, quietHours } from '../src/initiations.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
const MINUTE = 60000, HOUR = 60 * MINUTE;
const stream = uid => `qq:${SELF}:private:${uid}`;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-init-'));
  // 2027-01-15 16:00 in Beijing: outside the quiet hours.
  const clock = { now: 1_800_000_000_000 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now, ...options });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  a.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  a.admitPerson('qq', { uid: A }); a.admitPerson('qq', { uid: B });
  let seq = 0;
  const say = (uid, text, { she = false } = {}) => a.observe('qq', { eventId: `e-${++seq}`, streamId: stream(uid), actorId: she ? 'qq:model' : `qq:${SELF}:user:${uid}`, role: she ? 'assistant' : 'user', text, at: clock.now }).observationId;
  const stored = () => JSON.parse(a.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get().value);
  const tamper = change => { const state = stored(); change(state); a.store.db.prepare("UPDATE metadata SET value=? WHERE key='initiations'").run(JSON.stringify(state)); };
  const next = () => a.initiationNext('qq'), outcomes = () => a.initiationLog().items.map(item => item.outcome ?? item.status);
  return { a, clock, root, say, stored, tamper, next, outcomes };
}

test('a poke can only ever be about the owner: it takes no argument, and the request handed out names the owner\'s own private conversation', t => {
  const { a, next, tamper, outcomes } = fixture(t);
  for (const body of [{ streamId: stream(A) }, { personId: `person:qq:${A}` }, { uid: A }, { to: A }]) assert.throws(() => a.initiationPoke(body), { code: 'VALIDATION_ERROR' });
  for (const body of [{ streamId: stream(A) }, { id: 'x' }]) assert.throws(() => a.initiationNext('qq', body), { code: 'VALIDATION_ERROR' });
  const poked = a.initiationPoke();
  assert.deepEqual([poked.kind, poked.source, poked.owner, poked.status, poked.outcome], ['proactive', 'poke', true, 'waiting', null]);
  const { initiation } = next();
  assert.deepEqual(Object.keys(initiation).sort(), ['expiresAt', 'id', 'kind', 'memoryEpoch', 'streamId']);
  assert.deepEqual([initiation.id, initiation.kind, initiation.streamId, initiation.memoryEpoch], [poked.id, 'proactive', stream(OWNER), 0]);
  a.initiationAck('qq', { id: initiation.id, outcome: 'sent' });
  // A stored request that names anyone else is never handed out, whoever wrote it there.
  for (const change of [item => { item.streamId = stream(A); }, item => { item.streamId = stream(A); item.personId = `person:qq:${A}`; }, item => { item.streamId = `qq:${SELF}:group:${A}`; }, item => { item.capabilityId = 'native'; }, item => { item.entityId = 'entity:other'; }]) {
    a.initiationPoke(); tamper(state => change(state.items.at(-1)));
    assert.deepEqual(next(), { initiation: null, reason: 'idle' });
    assert.equal(outcomes()[0], 'dropped:target');
  }
});

test('without a bound owner there is nothing to poke; only the QQ conversation capability may fetch or report', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-init-'));
  const a = new Authority({ file: path.join(root, 'world.sqlite') });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.registerCapability({ id: 'qq', policy: 'conversation.v1' }); a.registerCapability({ id: 'native', policy: 'conversation.v1' });
  assert.throws(() => a.initiationPoke(), { code: 'CONFLICT' });
  assert.throws(() => a.initiationNext('native'), { code: 'FORBIDDEN' });
  assert.throws(() => a.initiationNext('nobody'), { code: 'FORBIDDEN' });
  assert.throws(() => a.initiationAck('native', { id: 'x', outcome: 'sent' }), { code: 'FORBIDDEN' });
  assert.deepEqual(a.initiationNext('qq'), { initiation: null, reason: 'idle' });
});

test('a request is handed out once: one is open at a time, a fetched one is never fetched again, and one without a report ends as unknown', t => {
  const { a, clock, next, outcomes } = fixture(t);
  const first = a.initiationPoke();
  assert.deepEqual([a.initiationPoke().id, a.initiationPoke().already], [first.id, true]);
  assert.equal(next().initiation.id, first.id);
  // Out and not reported: nothing else goes out, the same one does not come back, another poke changes nothing.
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  assert.deepEqual([a.initiationPoke().id, a.initiationPoke().status], [first.id, 'issued']);
  clock.now += INITIATION.reportMs - 1;
  assert.deepEqual(next(), { initiation: null, reason: 'busy' });
  clock.now += 1;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual(outcomes(), ['unknown']);
  // The bridge's own report, when it does come, replaces the guess; after that the record is settled.
  assert.deepEqual(a.initiationAck('qq', { id: first.id, outcome: 'sent' }), { status: 'recorded' });
  assert.deepEqual(a.initiationAck('qq', { id: first.id, outcome: 'sent' }), { status: 'recorded', replayed: true });
  assert.throws(() => a.initiationAck('qq', { id: first.id, outcome: 'unknown' }), { code: 'CONFLICT' });
  const second = a.initiationPoke();
  assert.notEqual(second.id, first.id);
  assert.equal(next().initiation.id, second.id);
  assert.deepEqual(outcomes(), ['issued', 'sent']);
});

test('reports: a fixed set of outcomes, only for a request that is out', t => {
  const { a, next, outcomes, stored } = fixture(t);
  const { id } = a.initiationPoke();
  assert.throws(() => a.initiationAck('qq', { id, outcome: 'sent' }), { code: 'CONFLICT' });
  next();
  for (const outcome of ['ok', 'resend', 'dropped:', 'dropped:Bad Reason', 'deferred:other', '', 7]) assert.throws(() => a.initiationAck('qq', { id, outcome }), { code: 'VALIDATION_ERROR' }, String(outcome));
  assert.throws(() => a.initiationAck('qq', { id, outcome: 'sent', streamId: stream(A) }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.initiationAck('qq', { id: 'unknown-id', outcome: 'sent' }), { code: 'CONFLICT' });
  a.initiationAck('qq', { id, outcome: 'deferred:budget' });
  assert.equal(stored().deferredAt, a.now());
  for (const outcome of ['partial', 'unknown', 'failed', 'declined', 'dropped:stale']) { const poked = a.initiationPoke(); next(); a.initiationAck('qq', { id: poked.id, outcome }); }
  assert.deepEqual(outcomes(), ['dropped:stale', 'declined', 'failed', 'unknown', 'partial', 'deferred:budget']);
});

test('paused: a poke is closed at once, a waiting one is dropped by a pause, and nothing goes out after the world resumes', t => {
  const { a, next, outcomes } = fixture(t);
  const waiting = a.initiationPoke();
  a.setWorldPaused({ paused: true });
  assert.deepEqual(next(), { initiation: null, reason: 'paused' });
  assert.deepEqual([a.initiationPoke().outcome, a.initiationPoke().already], ['dropped:paused', undefined]);
  a.setWorldPaused({ paused: false });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.deepEqual(outcomes(), ['dropped:paused', 'dropped:paused', 'dropped:paused']);
  assert.equal(a.initiationLog().items.at(-1).id, waiting.id);
  // Registered before a pause that has already ended when the bridge next asks: still dropped.
  a.initiationPoke(); a.setWorldPaused({ paused: true }); a.setWorldPaused({ paused: false });
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(outcomes()[0], 'dropped:paused');
});

test('quiet hours (23:30 to 08:00 Beijing), expiry and the person speaking first each close a request with the reason', t => {
  const { a, clock, say, next, outcomes } = fixture(t);
  const beijing = (hour, minute) => Date.UTC(2027, 0, 15, hour - 8, minute);
  assert.deepEqual([[23, 29], [23, 30], [0, 0], [7, 59], [8, 0], [16, 0]].map(([hour, minute]) => quietHours(beijing(hour, minute))), [false, true, true, true, false, false]);
  clock.now = beijing(23, 40);
  assert.equal(a.initiationPoke().outcome, 'dropped:quiet_hours');
  assert.equal(a.initiationLog().quietHours.now, true);
  // Registered at 23:27, fetched at 23:31: the quiet hours win.
  clock.now = beijing(23, 27); a.initiationPoke(); clock.now = beijing(23, 31);
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(outcomes()[0], 'dropped:quiet_hours');
  clock.now = beijing(16, 0) + 24 * HOUR;
  a.initiationPoke(); clock.now += INITIATION.ttlMs;
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(outcomes()[0], 'dropped:expired');
  // Her own line and another person's message change nothing; a message of the owner does.
  a.initiationPoke(); say(OWNER, 'MOCK 她自己刚说的话', { she: true }); say(A, 'MOCK 别人的消息');
  const fetched = next().initiation;
  assert.equal(fetched.streamId, stream(OWNER));
  a.initiationAck('qq', { id: fetched.id, outcome: 'sent' });
  a.initiationPoke(); say(OWNER, 'MOCK 主人先开口了');
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(outcomes()[0], 'dropped:person_spoke');
  // A conversation whose epoch moved (something was forgotten) is not initiated into.
  a.initiationPoke();
  a.store.db.prepare("INSERT INTO metadata(key,value) VALUES('streamEpochs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ [DEFAULT_ENTITY_ID]: { [`qq\u0000${stream(OWNER)}`]: 1 } }));
  assert.equal(a.streamEpoch(a.entity(DEFAULT_ENTITY_ID), 'qq', stream(OWNER)), 1);
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(outcomes()[0], 'dropped:epoch');
});

test('the operator list holds labels and times only, is bounded, and an idle poll writes nothing', t => {
  const { a, next, stored } = fixture(t);
  assert.deepEqual(next(), { initiation: null, reason: 'idle' });
  assert.equal(a.store.db.prepare("SELECT 1 FROM metadata WHERE key='initiations'").get(), undefined);
  for (let i = 0; i < INITIATION.kept + 5; i++) { const { id } = a.initiationPoke(); next(); a.initiationAck('qq', { id, outcome: 'declined' }); }
  const open = a.initiationPoke(), log = a.initiationLog();
  assert.equal(stored().items.length, INITIATION.kept + 1);
  assert.deepEqual([log.items.length, log.items[0].id, log.items[0].status], [INITIATION.kept + 1, open.id, 'waiting']);
  assert.deepEqual(Object.keys(log.items[0]).sort(), ['createdAt', 'endedAt', 'id', 'issuedAt', 'kind', 'outcome', 'owner', 'person', 'source', 'status']);
  for (const account of [SELF, OWNER, A, B]) assert.ok(!JSON.stringify(log).includes(account));
  assert.match(log.items[0].person, /^p-[0-9a-f]{6}$/);
  const before = JSON.stringify(stored());
  a.initiationLog();
  assert.equal(JSON.stringify(stored()), before);
});

test('consolidation is not stuck by a run she started: her lines with no message before them join the next batch or move the cursor', t => {
  const { a, clock, say } = fixture(t);
  const rollOut = () => { clock.now += 1000; a.context('qq', { streamId: stream(A), query: 'MOCK', windowFromAt: clock.now }); };
  const cursor = () => a.consolidationState()[DEFAULT_ENTITY_ID]?.streams[`qq\u0000${stream(A)}`]?.lastObservationId ?? null;
  // Only her own lines have left the window: no model call, and the cursor passes them.
  say(A, 'MOCK-INIT 她先开口说的一句', { she: true }); const second = say(A, 'MOCK-INIT 她接着说的第二句', { she: true });
  rollOut();
  assert.equal(a.consolidationNext(DEFAULT_ENTITY_ID).task, null);
  assert.equal(cursor(), second);
  // An ordinary run, a run she started, another ordinary run: one batch, in order, committed to its end.
  say(A, 'MOCK 我周末去了海边'); say(A, 'MOCK-REPLY 嗯', { she: true });
  say(A, 'MOCK-INIT 她隔天先开口', { she: true });
  say(A, 'MOCK 刚看到，在忙'); const last = say(A, 'MOCK-REPLY 好', { she: true });
  rollOut();
  const { task } = a.consolidationNext(DEFAULT_ENTITY_ID);
  assert.deepEqual(task.observations.map(row => row.role), ['user', 'assistant', 'assistant', 'user', 'assistant']);
  assert.equal(a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', digest: { summary: 'MOCK-摘要：对方说周末去了海边。' }, facts: [] }).status, 'committed');
  assert.equal(cursor(), last);
  assert.equal(a.consolidationNext(DEFAULT_ENTITY_ID).task, null);
});

test('transport: the QQ capability fetches and reports with an empty or fixed body; other roles are refused; the operator pokes with an empty body', async t => {
  const { a, root } = fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const tokens = { qq: 'q'.repeat(40), maintenance: 'm'.repeat(40), admin: 'a'.repeat(40), operator: 'o'.repeat(40) };
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials: [{ hash: hash(tokens.qq), role: 'capability', capabilityId: 'qq' }, { hash: hash(tokens.maintenance), role: 'maintenance', entityId: DEFAULT_ENTITY_ID }, { hash: hash(tokens.admin), role: 'admin' }] });
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'op.sock'), tokenHash: hash(tokens.operator), origins: [] });
  await app.start(); await operator.start();
  t.after(async () => { await operator.close(); await app.close(); });
  const call = (socket, token, method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, socket), path: route, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/initiative/poke', { streamId: stream(A) })).status, 400);
  assert.equal((await call('op.sock', tokens.operator, 'POST', '/initiative/poke', { uid: A })).status, 400);
  assert.equal((await call('op.sock', 'x'.repeat(40), 'POST', '/initiative/poke', {})).status, 401);
  const poked = await call('op.sock', tokens.operator, 'POST', '/initiative/poke', {});
  assert.deepEqual([poked.status, poked.value.status, poked.value.owner], [200, 'waiting', true]);
  for (const token of [tokens.maintenance, tokens.admin]) assert.equal((await call('api.sock', token, 'POST', '/v1/initiations/next', {})).status, 403);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', { streamId: stream(A) })).status, 400);
  const fetched = await call('api.sock', tokens.qq, 'POST', '/v1/initiations/next', {});
  assert.deepEqual([fetched.status, fetched.value.initiation.id, fetched.value.initiation.streamId], [200, poked.value.id, stream(OWNER)]);
  assert.equal((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: poked.value.id, outcome: 'sent', streamId: stream(A) })).status, 400);
  assert.equal((await call('api.sock', tokens.maintenance, 'POST', '/v1/initiations/ack', { id: poked.value.id, outcome: 'sent' })).status, 403);
  assert.deepEqual((await call('api.sock', tokens.qq, 'POST', '/v1/initiations/ack', { id: poked.value.id, outcome: 'sent' })).value, { status: 'recorded' });
  const log = await call('op.sock', tokens.operator, 'GET', '/initiative/log');
  assert.deepEqual([log.status, log.value.items.length, log.value.items[0].outcome], [200, 1, 'sent']);
  for (const account of [SELF, OWNER]) assert.ok(!JSON.stringify(log.value).includes(account));
});
