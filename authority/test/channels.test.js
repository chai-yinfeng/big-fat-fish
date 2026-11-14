import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID, MAX_ADMITTED_PEOPLE } from '../src/engine.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';
import { AuthorityClient } from '../src/client.js';

// Two conversation channels on one Authority: QQ and the test-only MOCK channel (capabilities/channels).
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011', B = '999900000012';
const qq = { actor: uid => `qq:${SELF}:user:${uid}`, stream: uid => `qq:${SELF}:private:${uid}`, admit: uid => ({ uid, actorId: `qq:${SELF}:user:${uid}`, streamId: `qq:${SELF}:private:${uid}` }) };
const mock = { actor: name => `mock:user:${name}`, stream: name => `mock:private:${name}`, admit: name => ({ uid: name, actorId: `mock:user:${name}`, streamId: `mock:private:${name}` }) };
const OWNER_PERSON = 'person:owner', person = uid => `person:qq:${uid}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-channels-'));
  // 2027-01-15 16:00 in Beijing: outside the quiet hours.
  const clock = { now: 1_800_000_000_000 };
  const a = new Authority({ file: path.join(root, 'world.sqlite'), clock: () => clock.now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['qq', 'mock']) a.registerCapability({ id, policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'qq', externalActorId: qq.actor(OWNER), personId: OWNER_PERSON });
  a.bindStream({ capabilityId: 'qq', streamId: qq.stream(OWNER), personId: OWNER_PERSON, audience: 'private' });
  a.admitPerson('qq', qq.admit(A)); a.admitPerson('qq', qq.admit(B));
  let seq = 0;
  /** A line of a person on a channel; with `fact`, also a reported fact the reviewer accepts. */
  const say = (capabilityId, streamId, actorId, text, fact) => {
    const eventId = `e-${++seq}`, { observationId } = a.observe(capabilityId, { eventId, streamId, actorId, role: 'user', text, at: clock.now });
    if (fact) { a.submit(capabilityId, { proposalId: `p-${seq}`, observationId, type: 'fact.report', payload: { key: fact, value: text, quote: text } }); assert.equal(a.processPending()[0].status, 'accepted'); }
    return eventId;
  };
  const job = (streamId, personId) => ({ id: 'job:' + randomUUID(), capability: 'demo', status: 'done', failureCode: null, scope: { entityId: DEFAULT_ENTITY_ID, streamId, personId, audience: 'private', memoryEpoch: 0 }, source: { requestId: 'MOCK-request', sourceEventId: null }, endedAt: clock.now, worldRevision: a.worldStatus().revision, expiresAt: clock.now + 7 * 86400000, notice: 'pending' });
  return { a, clock, root, say, job };
}

test('admission belongs to channels that declare friends: the channel names its own account, actor and conversation, inside its own namespace', t => {
  const { a } = fixture(t);
  const first = a.admitPerson('mock', (a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-OWNER'), streamId: mock.stream('MOCK-OWNER'), personId: OWNER_PERSON }), mock.admit('MOCK-C')));
  assert.deepEqual(first, { personId: 'person:mock:MOCK-C', streamId: mock.stream('MOCK-C'), admitted: true });
  assert.deepEqual(a.admitPerson('mock', mock.admit('MOCK-C')), { ...first, admitted: false });
  // The account has the shape the channel declared; actor and conversation stay in the channel's namespace and are plain and bounded.
  assert.throws(() => a.admitPerson('mock', { ...mock.admit('MOCK-D'), uid: A }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.admitPerson('qq', { ...qq.admit(A), uid: 'MOCK-D' }), { code: 'VALIDATION_ERROR' });
  for (const change of [{ actorId: qq.actor(A) }, { streamId: qq.stream(A) }, { actorId: 'mock:' + 'x'.repeat(130) }, { streamId: 'mock:private:a b' }, { streamId: 'mock' }, { actorId: 7 }]) assert.throws(() => a.admitPerson('mock', { ...mock.admit('MOCK-D'), ...change }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.admitPerson('mock', { uid: 'MOCK-D' }), { code: 'VALIDATION_ERROR' });
  // A conversation someone else already has is never taken over by an admission.
  assert.throws(() => a.admitPerson('mock', { ...mock.admit('MOCK-D'), streamId: mock.stream('MOCK-C') }), { code: 'CONFLICT' });
  // A conversation capability no channel declares, and a declared one without the conversation policy, admit nobody.
  a.registerCapability({ id: 'native', policy: 'conversation.v1' });
  assert.throws(() => a.admitPerson('native', { uid: 'x', actorId: 'native:user:x', streamId: 'native:private:x' }), { code: 'FORBIDDEN' });
  assert.equal(a.snapshot().audit.filter(entry => entry.type === 'person.admit' && entry.capabilityId === 'mock').length, 1);
});

test('the people cap counts people, not accounts or channels, and reads nothing from a person\'s name', t => {
  const { a } = fixture(t);
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-OWNER'), streamId: mock.stream('MOCK-OWNER'), personId: OWNER_PERSON });
  // A second account of a known person adds nobody.
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-A'), streamId: mock.stream('MOCK-A'), personId: person(A) });
  assert.equal(a.listPeople().admitted, 2);
  for (let i = 0; i < MAX_ADMITTED_PEOPLE - 3; i++) a.admitPerson('qq', qq.admit(String(1000 + i)));
  a.admitPerson('mock', mock.admit('MOCK-LAST'));
  assert.equal(a.listPeople().admitted, MAX_ADMITTED_PEOPLE);
  // Full, on either channel; someone already known is still idempotent.
  assert.throws(() => a.admitPerson('mock', mock.admit('MOCK-EXTRA')), { code: 'PEOPLE_LIMIT' });
  assert.throws(() => a.admitPerson('qq', qq.admit('9999')), { code: 'PEOPLE_LIMIT' });
  assert.equal(a.admitPerson('mock', mock.admit('MOCK-LAST')).admitted, false);
  const listed = a.listPeople().people.find(item => item.personId === person(A));
  assert.deepEqual(listed.actors, [{ capabilityId: 'qq', externalActorId: qq.actor(A) }, { capabilityId: 'mock', externalActorId: mock.actor('MOCK-A') }]);
  assert.equal(listed.conversations, 2);
});

test('attaching an account is the operator\'s: only to a person that exists, never to two people, and moving is explicit', t => {
  const { a } = fixture(t);
  const input = { capabilityId: 'mock', actorId: mock.actor('MOCK-A'), streamId: mock.stream('MOCK-A'), personId: person(A) };
  assert.throws(() => a.attachAccount({ ...input, personId: 'person:qq:nobody' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.attachAccount({ ...input, capabilityId: 'reader' }), { code: 'FORBIDDEN' });
  assert.throws(() => a.attachAccount({ ...input, actorId: qq.actor(B) }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.attachAccount({ ...input, move: 'yes' }), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(a.attachAccount(input), { ...input, attached: true, movedFrom: null });
  assert.deepEqual(a.attachAccount(input), { ...input, attached: false, movedFrom: null });
  // The same account for someone else: refused unless the move is explicit; then it is that person's only.
  assert.throws(() => a.attachAccount({ ...input, personId: person(B) }), { code: 'CONFLICT' });
  assert.throws(() => a.attachAccount({ ...input, personId: person(B), move: false }), { code: 'CONFLICT' });
  const moved = a.attachAccount({ ...input, personId: person(B), move: true });
  assert.equal(moved.attached, true); assert.match(moved.movedFrom, /^p-[0-9a-f]{6}$/);
  const snapshot = a.snapshot();
  assert.deepEqual(snapshot.actors.filter(row => row.externalActorId === mock.actor('MOCK-A')).map(row => row.personId), [person(B)]);
  assert.deepEqual(snapshot.streams.filter(row => row.streamId === mock.stream('MOCK-A')).map(row => [row.personId, row.audience, row.entityId]), [[person(B), 'private', DEFAULT_ENTITY_ID]]);
  assert.deepEqual(snapshot.audit.filter(entry => entry.type === 'person.attach').map(entry => [entry.personId, entry.movedFrom]), [[person(A), undefined], [person(B), person(A)]]);
  // An account whose conversation is someone else's cannot be split across two people, and the owner's is never moved.
  a.attachAccount({ ...input, actorId: mock.actor('MOCK-A2'), streamId: mock.stream('MOCK-A2'), personId: person(A) });
  assert.throws(() => a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-A2'), streamId: mock.stream('MOCK-A'), personId: OWNER_PERSON, move: true }), { code: 'CONFLICT' });
  assert.throws(() => a.attachAccount({ capabilityId: 'qq', actorId: qq.actor(OWNER), streamId: qq.stream(OWNER), personId: person(A), move: true }), { code: 'CONFLICT' });
});

test('one person on two channels: one long-term memory, two separate conversations; nobody else sees either', t => {
  const { a, say } = fixture(t);
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-A'), streamId: mock.stream('MOCK-A'), personId: person(A) });
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-B'), streamId: mock.stream('MOCK-B'), personId: person(B) });
  say('qq', qq.stream(A), qq.actor(A), 'MOCK-A 在 QQ 里说：我养了一只叫 MOCK-年糕 的猫', 'MOCK-宠物');
  say('mock', mock.stream('MOCK-A'), mock.actor('MOCK-A'), 'MOCK-A 在第二渠道说：我周末去 MOCK-青岛', 'MOCK-行程');
  const read = (capabilityId, streamId) => { const context = a.context(capabilityId, { streamId, query: 'MOCK-年糕 MOCK-青岛', profile: true }); return context.text + '\n' + context.profileText; };
  // What was said on either channel is that person's memory on both.
  for (const text of [read('qq', qq.stream(A)), read('mock', mock.stream('MOCK-A'))]) { assert.match(text, /MOCK-年糕/); assert.match(text, /MOCK-青岛/); }
  // Another person sees none of it on either channel.
  for (const text of [read('qq', qq.stream(B)), read('mock', mock.stream('MOCK-B')), read('qq', qq.stream(OWNER))]) assert.doesNotMatch(text, /MOCK-年糕|MOCK-青岛/);
  // The context names the caller's own channel, and the two conversations stay two: their own lines, their own epoch.
  assert.deepEqual([a.context('qq', { streamId: qq.stream(A) }).capabilityId, a.context('mock', { streamId: mock.stream('MOCK-A') }).capabilityId], ['qq', 'mock']);
  const conversations = Object.fromEntries(a.listConversations().map(row => [`${row.capabilityId}|${row.streamId}`, row]));
  assert.deepEqual([conversations[`qq|${qq.stream(A)}`].messages, conversations[`mock|${mock.stream('MOCK-A')}`].messages], [1, 1]);
  assert.equal(conversations[`qq|${qq.stream(A)}`].label, conversations[`mock|${mock.stream('MOCK-A')}`].label);
  // A channel's credential reaches no conversation of another channel, whoever it belongs to.
  assert.throws(() => a.context('mock', { streamId: qq.stream(A) }), { code: 'FORBIDDEN' });
  assert.throws(() => a.context('qq', { streamId: mock.stream('MOCK-A') }), { code: 'FORBIDDEN' });
  assert.throws(() => a.contentScope('mock', { streamId: qq.stream(A), memoryEpoch: 0 }), { code: 'FORBIDDEN' });
  // Forgetting a private memory of that person retires both of that person's conversations, and nobody else's.
  const fact = a.listMemory().items.find(item => item.value?.includes('MOCK-年糕'));
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [fact.id] });
  assert.deepEqual(preview.affectedStreams.map(row => row.streamId).sort(), [mock.stream('MOCK-A'), qq.stream(A)].sort());
});

test('she speaks first on the channel the person last spoke on; each bridge is only handed its own channel\'s requests', t => {
  const { a, say } = fixture(t);
  const poke = () => { const item = a.initiationPoke(); assert.equal(item.status, 'waiting'); return item.id; };
  const next = capabilityId => a.initiationNext(capabilityId).initiation;
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-OWNER'), streamId: mock.stream('MOCK-OWNER'), personId: OWNER_PERSON });
  // Never spoke anywhere: the conversation bound last.
  let id = poke();
  assert.equal(next('qq'), null);
  assert.deepEqual([next('mock').id, a.initiationNext('mock').reason], [id, 'busy']);
  // Another channel cannot report on it; its own can, once.
  assert.throws(() => a.initiationAck('qq', { id, outcome: 'sent' }), { code: 'CONFLICT' });
  a.initiationAck('mock', { id, outcome: 'sent' });
  // Spoke on QQ last: QQ. Then on the second channel: there.
  say('qq', qq.stream(OWNER), qq.actor(OWNER), 'MOCK 主人在 QQ 说话');
  id = poke();
  assert.equal(next('mock'), null);
  const onQQ = next('qq');
  assert.deepEqual([onQQ.id, onQQ.streamId], [id, qq.stream(OWNER)]);
  a.initiationAck('qq', { id, outcome: 'unknown' });
  say('mock', mock.stream('MOCK-OWNER'), mock.actor('MOCK-OWNER'), 'MOCK 主人在第二渠道说话');
  id = poke();
  assert.equal(next('qq'), null);
  // The owner moves to the other channel before it is fetched: the request is void, not redirected.
  say('qq', qq.stream(OWNER), qq.actor(OWNER), 'MOCK 主人又回到 QQ');
  assert.equal(next('mock'), null);
  assert.equal(a.initiationLog().items[0].outcome, 'dropped:target');
  // What her friend says somewhere changes nothing about where the owner is.
  say('mock', mock.stream('MOCK-OWNER'), mock.actor('MOCK-OWNER'), 'MOCK 主人回到第二渠道');
  say('qq', qq.stream(A), qq.actor(A), 'MOCK-A 在 QQ 说话');
  id = poke();
  assert.equal(next('mock').streamId, mock.stream('MOCK-OWNER'));
  // The list shows no account of either channel.
  assert.doesNotMatch(JSON.stringify(a.initiationLog()), /MOCK-OWNER|9999/);
});

test('a finished job is told on the channel of the conversation it was registered in, and only its bridge hears of it', t => {
  const { a, job } = fixture(t);
  a.attachAccount({ capabilityId: 'mock', actorId: mock.actor('MOCK-A'), streamId: mock.stream('MOCK-A'), personId: person(A) });
  const there = job(mock.stream('MOCK-A'), person(A)), here = job(qq.stream(B), person(B));
  // The QQ bridge is handed the QQ job, never the other channel's, and is told nothing about it.
  assert.equal(a.initiationNext('qq', {}, [there, here]).initiation.jobRef, here.id);
  assert.deepEqual(a.drainJobNotices(), [{ id: here.id, state: 'issued' }]);
  assert.deepEqual(a.initiationCarry('qq', { streamId: mock.stream('MOCK-A') }, [there]), { initiation: null });
  const told = a.initiationNext('mock', {}, [there, here]).initiation;
  assert.deepEqual([told.kind, told.streamId, told.jobRef], ['completion', mock.stream('MOCK-A'), there.id]);
  a.drainJobNotices();
  // Named for a person it is not registered with, or a conversation bound on no channel: closed, told to nobody.
  const forged = job(mock.stream('MOCK-A'), person(B)), orphan = job('mock:private:MOCK-NOBODY', person(A));
  a.initiationAck('mock', { id: told.id, outcome: 'sent' }); a.drainJobNotices();
  assert.deepEqual(a.initiationNext('mock', {}, [forged, orphan]), { initiation: null, reason: 'idle' });
  assert.deepEqual(a.drainJobNotices(), [{ id: forged.id, state: 'closed', outcome: 'dropped:target' }, { id: orphan.id, state: 'closed', outcome: 'dropped:target' }]);
});

test('over the sockets: a channel credential admits and asks only for itself, the operator attaches accounts and lists every channel', async t => {
  const { a, root } = fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex'), operatorToken = 'operator'.repeat(6);
  const tokens = { qq: randomBytes(32).toString('hex'), mock: randomBytes(32).toString('hex') };
  for (const [id, token] of Object.entries(tokens)) fs.writeFileSync(path.join(root, id + '.token'), token);
  const asked = [];
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials: Object.entries(tokens).map(([capabilityId, token]) => ({ hash: hash(token), role: 'capability', capabilityId })), contentJobs: async request => { asked.push(request.action); return { jobs: [] }; } });
  await app.start(); t.after(() => app.close());
  const client = id => new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile: path.join(root, id + '.token') });
  const operator = createOperatorServer({ authority: a, socketPath: path.join(root, 'op.sock'), tokenHash: hash(operatorToken), origins: [] });
  await operator.start(); t.after(() => operator.close());
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, 'op.sock'), path: route, method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + operatorToken, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  // No bridge can attach an account: the route exists on the operator socket only.
  assert.deepEqual((await call('/people/attach', { capabilityId: 'mock', actorId: mock.actor('MOCK-OWNER'), streamId: mock.stream('MOCK-OWNER'), personId: OWNER_PERSON })).body.value.attached, true);
  assert.equal((await call('/people/attach', { capabilityId: 'mock', actorId: mock.actor('MOCK-OWNER'), streamId: mock.stream('MOCK-OWNER'), personId: person(A) })).status, 409);
  assert.equal((await call('/people/attach', { capabilityId: 'mock', actorId: mock.actor('MOCK-X'), streamId: mock.stream('MOCK-X'), personId: 'person:nobody' })).status, 400);
  assert.equal((await call('/people/attach', { capabilityId: 'mock', actorId: mock.actor('MOCK-X'), streamId: mock.stream('MOCK-X'), personId: person(A), target: 'x' })).status, 400);
  assert.equal((await client('mock').admitPerson(mock.admit('MOCK-C'))).personId, 'person:mock:MOCK-C');
  await assert.rejects(client('mock').admitPerson(qq.admit(A)), { status: 400 });
  await assert.rejects(client('mock').context({ streamId: qq.stream(A) }), { status: 403 });
  // Both bridges may ask for initiated runs (the content service is asked for each), and each gets its own.
  const poked = (await call('/initiative/poke', {})).body.value;
  assert.equal((await client('qq').initiationNext()).initiation, null);
  assert.equal((await client('mock').initiationNext()).initiation.id, poked.id);
  assert.deepEqual(asked, ['pending', 'pending']);
  const world = (await call('/world')).body.value;
  assert.deepEqual(world.channels.map(item => [item.id, item.name, item.status, item.boundStreams, item.receipts, item.friends]), [['qq', 'QQ', 'available', 3, 'reliable', true], ['mock', 'MOCK', 'available', 2, 'unreliable', true]]);
  assert.deepEqual(world.channels[0].expression, { voice: true, images: true, faces: false, stickers: true, split: true });
});

test('the production entry point refuses a configuration that registers a test-only channel', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'authority.json'), main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const write = extra => fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, databasePath: path.join(root, 'w.sqlite'), socketPath: path.join(root, 'a.sock'), credentials: [{ hash: 'a'.repeat(64), role: 'capability', capabilityId: 'qq' }], capabilities: [{ id: 'qq', policy: 'conversation.v1' }], actors: [], streams: [], operator: { socketPath: path.join(root, 'o.sock'), tokenHash: 'b'.repeat(64), origins: [] }, ...extra }), { mode: 0o600 });
  const start = () => spawnSync(process.execPath, [main, '--config', config], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 2000, killSignal: 'SIGTERM' });
  for (const extra of [{ capabilities: [{ id: 'qq', policy: 'conversation.v1' }, { id: 'mock', policy: 'conversation.v1' }] }, { credentials: [{ hash: 'c'.repeat(64), role: 'capability', capabilityId: 'mock' }] }]) {
    write(extra);
    const refused = start();
    assert.equal(refused.status, 1); assert.match(refused.stderr, /could not start/); assert.ok(!fs.existsSync(path.join(root, 'w.sqlite')));
  }
  // With the explicit switch in the private configuration the same registration starts (and is stopped here).
  const operator = { socketPath: path.join(root, 'o.sock'), tokenHash: 'b'.repeat(64), origins: [] };
  for (const value of [false, 'true', 1]) { write({ credentials: [{ hash: 'c'.repeat(64), role: 'capability', capabilityId: 'mock' }], operator: { ...operator, allowTestChannels: value } }); assert.equal(start().status, 1); }
  write({ credentials: [{ hash: 'c'.repeat(64), role: 'capability', capabilityId: 'mock' }], operator: { ...operator, allowTestChannels: true } });
  const allowed = start();
  assert.match(allowed.stdout, /Companion authority ready/);
});
