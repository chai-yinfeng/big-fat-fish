import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authority } from '../src/engine.js';

function fixture(t, initialPaused = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-world-'));
  const file = join(dir, 'authority.sqlite');
  let now = 1000;
  let a = new Authority({ file, clock: () => now, initialPaused });
  t.after(() => { a.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get a() { return a; }, time(value) { now = value; }, reopen() { a.close(); a = new Authority({ file, clock: () => now }); } };
}

test('world freezes durably, resumes without catch-up and raw reads never advance anchors', t => {
  const f = fixture(t);
  assert.deepEqual(f.a.worldStatus(), { paused: false, revision: 1, worldNow: 1000, realNow: 1000 });
  f.time(1200);
  const before = f.a.health().revision;
  assert.deepEqual(f.a.setWorldPaused({ paused: true, expectedRevision: 1 }), { paused: true, revision: 2, worldNow: 1200, realNow: 1200 });
  assert.equal(f.a.health().revision, before + 1);
  const raw = f.a.snapshot();
  f.time(5000);
  assert.deepEqual(f.a.snapshot(), raw);
  assert.equal(f.a.health().world.worldNow, 1200);
  assert.equal(f.a.setWorldPaused({ paused: true, expectedRevision: 2 }).revision, 2);
  assert.deepEqual(f.a.snapshot(), raw);
  assert.throws(() => f.a.setWorldPaused({ paused: false, expectedRevision: 1 }), error => error.code === 'CONFLICT');
  f.reopen();
  assert.equal(f.a.worldStatus().worldNow, 1200);
  f.a.setWorldPaused({ paused: false, expectedRevision: 2 });
  f.time(5100);
  assert.equal(f.a.worldStatus().worldNow, 1300);
  f.reopen();
  assert.deepEqual(f.a.worldStatus(), { paused: false, revision: 3, worldNow: 1300, realNow: 5100 });
  assert.equal(f.a.snapshot().audit.filter(entry => entry.type === 'world.pause').length, 2);
});

test('paused proposals reject durably without effects; pre-pause pending waits for resume', t => {
  const f = fixture(t, true);
  const a = f.a;
  a.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'chat', externalActorId: 'alice', personId: 'p1' });
  a.bindStream({ capabilityId: 'chat', streamId: 'one', personId: 'p1', audience: 'private' });
  const { observationId } = a.observe('chat', { eventId: 'e', streamId: 'one', actorId: 'alice', role: 'user', text: 'I like tea. Thank you.', at: 900 });
  const proposal = { proposalId: 'paused', observationId, type: 'appraisal.record', payload: { kind: 'gratitude', quote: 'Thank you.' } };
  const rejected = a.submit('chat', proposal);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'world_paused');
  assert.deepEqual(a.submit('chat', proposal), rejected);
  assert.deepEqual(a.processPending(), []);
  assert.deepEqual(a.snapshot().relationships, {});
  assert.equal(a.snapshot().appraisals.length, 0);
  assert.equal(a.context('chat', { streamId: 'one' }).world.paused, true);
  a.revisePersona({ expectedRevision: 1, patch: { name: 'Operator edit' }, reason: 'operator' });
  assert.equal(a.snapshot().persona.name, 'Operator edit');
  a.setWorldPaused({ paused: false, expectedRevision: 1 });
  a.submit('chat', { ...proposal, proposalId: 'before-pause' });
  a.setWorldPaused({ paused: true, expectedRevision: 2 });
  const paused = a.snapshot();
  f.time(9000);
  assert.deepEqual(a.processPending(), []);
  assert.deepEqual(a.snapshot(), paused);
  f.reopen();
  assert.deepEqual(f.a.getReceipt('chat', 'paused'), rejected);
  assert.equal(f.a.getReceipt('chat', 'before-pause').status, 'pending');
  assert.deepEqual(f.a.processPending(), []);
  f.a.setWorldPaused({ paused: false, expectedRevision: 3 });
  assert.equal(f.a.processPending()[0].status, 'accepted');
  assert.equal(f.a.snapshot().relationships.p1.score, 1);
  assert.equal(f.a.snapshot().observations[0].at, 900);
  assert.equal(f.a.snapshot().audit.filter(entry => entry.proposalId === 'paused').length, 1);
});
