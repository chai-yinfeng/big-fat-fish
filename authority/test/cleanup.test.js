import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { createAuthorityServer } from '../src/server.js';
import { AuthorityClient } from '../src/client.js';
import { createCleanupParty } from '../src/cleanup-party.js';

// Forgetting while the services stay up: Authority keeps, per cleanup job, who has confirmed that their own files
// are gone. `qq` declares a forget owner for its bridge (capabilities/channels/qq), `mock` does not.
function world(t, { contentService = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cleanup-'));
  let now = 1000;
  const a = new Authority({ file: path.join(root, 'a.sqlite'), clock: () => now++, contentService });
  t.after(() => { a.close(); assert.match(path.basename(root), /^fish-cleanup-/); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['qq', 'mock']) {
    a.registerCapability({ id, policy: 'conversation.v1' });
    a.bindActor({ capabilityId: id, externalActorId: `${id}:alice`, personId: 'person:alice' });
    a.bindStream({ capabilityId: id, streamId: `${id}:private:alice`, personId: 'person:alice', audience: 'private' });
  }
  a.registerCapability({ id: 'health', policy: 'learning.v1' });
  let seq = 0;
  const say = (id, text) => { const eventId = `${id}:event-${++seq}`; return { eventId, id: a.observe(id, { eventId, streamId: `${id}:private:alice`, actorId: `${id}:alice`, role: 'user', text, at: now }).observationId }; };
  /** Pause and forget these observations; returns the cleanup job as the operator sees it. */
  const forget = ids => {
    if (!a.worldStatus().paused) a.setWorldPaused({ paused: true });
    const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids });
    return a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids, expectedMemoryEpoch: preview.memoryEpoch });
  };
  const waiting = id => a.cleanupStatus().jobs.find(job => job.id === id).parties.filter(party => !party.confirmed).map(party => party.party);
  return { a, root, say, forget, waiting };
}

test('a cleanup job lists its parties; each takes only its own part, and the world resumes only after every one confirmed', t => {
  const { a, say, forget, waiting } = world(t);
  const onQQ = say('qq', 'MOCK forgotten on QQ'), onMock = say('mock', 'MOCK forgotten on the second channel'), kept = say('qq', 'MOCK kept');
  const job = forget([onQQ.id, onMock.id]);
  assert.equal(job.externalCleanup.status, 'pending');
  assert.deepEqual(a.cleanupStatus().jobs.map(row => [row.id, row.status, row.completedAt, row.parties.map(party => [party.party, party.confirmed])]),
    [[job.id, 'pending', null, [['content', false], ['executor:mock', false], ['bridge:qq', false], ['executor:qq', false]]]]);
  // Each channel process is handed only its own channel's conversations and messages, with the new epochs.
  const forQQ = a.cleanupNext('qq', { party: 'bridge' }).job;
  assert.deepEqual(forQQ, { id: job.id, memoryEpoch: job.memoryEpoch, affectedStreams: [{ streamId: 'qq:private:alice', memoryEpoch: 1 }], sourceEvents: [{ streamId: 'qq:private:alice', eventId: onQQ.eventId }] });
  assert.deepEqual(a.cleanupNext('qq', { party: 'executor' }).job, forQQ);
  assert.deepEqual(a.cleanupNext('mock', { party: 'executor' }).job.sourceEvents, [{ streamId: 'mock:private:alice', eventId: onMock.eventId }]);
  assert.ok(!JSON.stringify(forQQ).includes(kept.eventId));
  // A bridge that keeps no files is no party; a capability that is no conversation channel may not ask at all.
  assert.deepEqual(a.cleanupNext('mock', { party: 'bridge' }), { job: null });
  assert.throws(() => a.cleanupNext('health', { party: 'executor' }), { code: 'FORBIDDEN' });
  assert.throws(() => a.cleanupNext('qq', { party: 'content' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => a.cleanupAck('mock', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'bridge' }), { code: 'FORBIDDEN' });
  assert.throws(() => a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch + 1, party: 'bridge' }), { code: 'CONFLICT' });
  assert.throws(() => a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'bridge', report: { text: 'words' } }), { code: 'VALIDATION_ERROR' });

  // One confirmation after the other; until the last one the world stays paused.
  assert.deepEqual(a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'bridge', report: { dispatchForgotten: 1 } }), { id: job.id, status: 'pending', waiting: ['content', 'executor:mock', 'executor:qq'] });
  const first = a.cleanupStatus().jobs[0].parties.find(party => party.party === 'bridge:qq');
  assert.deepEqual([first.confirmed, first.report], [true, { dispatchForgotten: 1 }]);
  // Confirming again changes nothing: the first confirmation stands, and the party is not asked again.
  a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'bridge', report: { dispatchForgotten: 0 } });
  assert.deepEqual(a.cleanupStatus().jobs[0].parties.find(party => party.party === 'bridge:qq'), first);
  assert.deepEqual(a.cleanupNext('qq', { party: 'bridge' }), { job: null });
  assert.throws(() => a.setWorldPaused({ paused: false }), { code: 'CONFLICT' });
  a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'executor', report: { sessionsRemoved: 1 } });
  assert.deepEqual(a.cleanupForContent().map(row => row.id), [job.id]);
  a.cleanupConfirm('content', { id: job.id, memoryEpoch: job.memoryEpoch, report: { artifactsRemoved: 2 } });
  assert.deepEqual(a.cleanupForContent(), []);
  // One party is not there (the second channel's executor): the job stays pending and the operator sees who.
  assert.deepEqual(waiting(job.id), ['executor:mock']);
  assert.equal(a.memoryStatus().pendingExternalCleanup, 1);
  assert.throws(() => a.setWorldPaused({ paused: false }), { code: 'CONFLICT' });
  // It comes back and confirms: the job closes, nothing resumes by itself, and the operator may resume.
  assert.deepEqual(a.cleanupAck('mock', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'executor', report: { sessionsRemoved: 0 } }), { id: job.id, status: 'complete', waiting: [] });
  assert.equal(a.worldStatus().paused, true);
  const closed = a.cleanupStatus().jobs[0];
  assert.deepEqual([closed.status, closed.completedBy, closed.parties.every(party => party.confirmed), a.cleanupPending().length], ['complete', 'parties', true, 0]);
  assert.equal(a.setWorldPaused({ paused: false }).paused, false);
  // A late or repeated confirmation of a closed job is answered, not refused.
  assert.deepEqual(a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'executor' }), { id: job.id, status: 'complete', waiting: [] });
  const audit = a.store.db.prepare("SELECT body FROM audit WHERE json_extract(body,'$.type')='memory.external-cleanup'").all().map(row => JSON.parse(row.body));
  assert.equal(audit.length, 1);
  assert.deepEqual(Object.keys(audit[0].parties).sort(), ['bridge:qq', 'content', 'executor:mock', 'executor:qq']);
});

test('the operator\'s own acknowledgement (the offline purge) closes a job whatever was confirmed; without a content service it is no party', t => {
  const { a, say, forget } = world(t, { contentService: false });
  const job = forget([say('qq', 'MOCK forgotten').id]);
  assert.deepEqual(a.cleanupStatus().jobs[0].parties.map(party => party.party), ['bridge:qq', 'executor:qq']);
  assert.deepEqual(a.cleanupForContent(), []);
  a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party: 'bridge' });
  assert.throws(() => a.setWorldPaused({ paused: false }), { code: 'CONFLICT' });
  assert.equal(a.cleanupComplete({ id: job.id, memoryEpoch: job.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } }).status, 'complete');
  const row = a.cleanupStatus().jobs[0];
  assert.deepEqual([row.status, row.completedBy, row.parties.map(party => [party.party, party.confirmed])], ['complete', 'operator', [['bridge:qq', true]]]);
  assert.deepEqual(a.cleanupNext('qq', { party: 'executor' }), { job: null });
  assert.equal(a.setWorldPaused({ paused: false }).paused, false);
});

test('a job an earlier release left pending (no confirmations, streams without their own epoch) is handed out the same way; only the latest closed jobs stay listed', t => {
  const { a, say, forget } = world(t);
  const job = forget([say('qq', 'MOCK forgotten').id]);
  // As an earlier release stored it: no per-stream epoch, no scope, and nothing in the metadata table.
  const body = JSON.parse(a.store.db.prepare('SELECT body FROM cleanup_jobs WHERE id=?').get(job.id).body);
  a.store.db.prepare('UPDATE cleanup_jobs SET body=? WHERE id=?').run(JSON.stringify({ ...body, epochScope: undefined, affectedStreams: body.affectedStreams.map(({ capabilityId, streamId }) => ({ capabilityId, streamId })) }), job.id);
  assert.equal(a.store.db.prepare("SELECT 1 FROM metadata WHERE key='cleanupAcks'").get(), undefined);
  assert.deepEqual(a.cleanupNext('qq', { party: 'executor' }).job.affectedStreams, [{ streamId: 'qq:private:alice', memoryEpoch: job.memoryEpoch }]);
  for (const party of ['bridge', 'executor']) a.cleanupAck('qq', { id: job.id, memoryEpoch: job.memoryEpoch, party });
  assert.equal(a.cleanupConfirm('content', { id: job.id, memoryEpoch: job.memoryEpoch }).status, 'complete');
  // 25 more jobs, each closed: the list keeps the newest 20.
  for (let i = 0; i < 25; i++) {
    const next = forget([say('qq', `MOCK forgotten ${i}`).id]);
    a.cleanupComplete({ id: next.id, memoryEpoch: next.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
  }
  const listed = a.cleanupStatus().jobs;
  assert.equal(listed.length, 20);
  assert.ok(listed.every(row => row.status === 'complete') && !listed.some(row => row.id === job.id));
});

test('over the socket: a channel credential takes and confirms its part, other roles cannot, and Authority asks the content service until it has confirmed', async t => {
  const { a, root, say, forget, waiting } = world(t);
  const token = name => { const value = `synthetic-${name}-credential-not-a-real-secret`, file = path.join(root, name + '.token'); fs.writeFileSync(file, value, { mode: 0o600 }); return { file, hash: createHash('sha256').update(value).digest('hex') }; };
  const qq = token('qq'), maintenance = token('maintenance'), socketPath = path.join(root, 'api.sock');
  // The content service is busy twice (or down), then forgets.
  const asked = [];
  const contentForget = async job => { asked.push(job.id); if (asked.length < 3) throw Object.assign(new Error('busy'), { code: 'UNAVAILABLE' }); return { artifactsRemoved: 2, startedAt: 5 }; };
  const app = createAuthorityServer({ authority: a, socketPath, contentForget, cleanupRetryMs: 3600000,
    credentials: [{ role: 'capability', capabilityId: 'qq', hash: qq.hash }, { role: 'maintenance', entityId: DEFAULT_ENTITY_ID, hash: maintenance.hash }] });
  await app.start(); t.after(() => app.close());
  const client = new AuthorityClient({ socketPath, tokenFile: qq.file });
  assert.deepEqual(await client.cleanupNext({ party: 'executor' }), { job: null });
  const said = say('qq', 'MOCK forgotten over the socket'), job = forget([said.id]);
  await app.wakeCleanup(); await app.wakeCleanup();
  assert.deepEqual([asked.length, waiting(job.id)], [2, ['content', 'bridge:qq', 'executor:qq']]);
  await app.wakeCleanup();
  assert.deepEqual([asked.length, waiting(job.id)], [3, ['bridge:qq', 'executor:qq']]);
  await app.wakeCleanup();
  assert.equal(asked.length, 3);
  // The maintenance credential (the memory worker's) has no part in this.
  await assert.rejects(new AuthorityClient({ socketPath, tokenFile: maintenance.file }).cleanupNext({ party: 'executor' }), { status: 403 });
  // Both processes of the channel run their rounds; a forget that fails leaves the job pending for the next round.
  let fail = true;
  const forgotten = [];
  const executor = createCleanupParty({ authority: client, party: 'executor', forget: async plan => { if (fail) throw Object.assign(new Error('disk'), { code: 'SESSION_UNAVAILABLE' }); forgotten.push(['executor', plan.affectedStreams]); return { sessionsRemoved: 1 }; } });
  const bridge = createCleanupParty({ authority: client, party: 'bridge', forget: async plan => { forgotten.push(['bridge', plan.sourceEvents]); return { dispatchForgotten: 1 }; } });
  assert.deepEqual(await executor.runOnce(), { completed: 0, failed: 'SESSION_UNAVAILABLE' });
  assert.deepEqual(waiting(job.id), ['bridge:qq', 'executor:qq']);
  fail = false;
  // Two callers at once share one round.
  const [one, two] = await Promise.all([executor.runOnce(), executor.runOnce()]);
  assert.deepEqual([one, two], [{ completed: 1 }, { completed: 1 }]);
  assert.deepEqual(await bridge.runOnce(), { completed: 1 });
  assert.deepEqual(forgotten, [['executor', [{ streamId: 'qq:private:alice', memoryEpoch: 1 }]], ['bridge', [{ streamId: 'qq:private:alice', eventId: said.eventId }]]]);
  assert.deepEqual([a.cleanupStatus().jobs[0].status, await bridge.runOnce(), await executor.runOnce()], ['complete', { completed: 0 }, { completed: 0 }]);
  assert.equal(a.setWorldPaused({ paused: false }).paused, false);
});
