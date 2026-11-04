import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from '../lib/adapter.js';
import { createDeliveryStore, createSessionDelivery } from '../lib/delivery.js';
const config = { sessionIds: ['a', 'b'], actorId: 'owner' };
const event = seq => ({ type: 'user/message', seq, time: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'tea' }] } });
const context = async () => ({ text: '', revision: 1, personaRevision: 1 });

test('temporary observe failure keeps unacked event and retries stable ID on next boundary', async () => {
  const calls = []; let fail = true;
  const a = createAdapter(config, { context, observe: async v => { calls.push(v.eventId); if (fail) throw new Error('TIMEOUT'); return { observationId: 'o1' }; } });
  a.ingest('a', event(0));
  await assert.rejects(a.refresh('a', { query: 'tea', turn: 1 }), /OBSERVATION_UNAVAILABLE/);
  assert.equal(a.text('a'), '');
  fail = false;
  await a.refresh('a', { query: 'tea', turn: 1 });
  assert.deepEqual(calls, ['native:0', 'native:0']);
  assert.deepEqual(a.references('a'), ['o1']);
});

test('receipt survives remount and >128 attempts, and stream hash prevents cross-stream lookup', async () => {
  const receipts = new Map();
  const client = { context, observe: async () => ({ observationId: 'o1' }), submit: async v => { const r = { proposalId: v.proposalId, status: 'accepted' }; receipts.set(v.proposalId, r); return { ...r, status: 'pending' }; }, getReceipt: async id => receipts.get(id) || null };
  const a = createAdapter(config, client);
  a.ingest('a', event(0)); await a.refresh('a', { query: 'tea', turn: 1 });
  for (let n = 0; n < 160; n++) await a.act('a', { action: 'propose', id: `p${n}`, ref: 'o1', type: 'fact.report', payload: { key: 'drink', value: 'tea', quote: 'tea' } });
  const resumed = createAdapter(config, client);
  assert.equal((await resumed.act('a', { action: 'receipt', id: 'p0' })).status, 'accepted');
  assert.equal(await resumed.act('b', { action: 'receipt', id: 'p0' }), null);
});

test('durable ack cursor replays >128 offline events in batches and restores recent refs from source log', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'delivery.json');
  const events = Array.from({ length: 270 }, (_, i) => event(i));
  let ownReads = 0; const calls = []; let failAt = 139;
  const session = { id: 'a', get seq() { return events.length; }, ownEvents: () => { ownReads++; return events; }, eventAt: seq => events[seq], isOwnSeq: seq => seq >= 0 };
  const client = { context, observe: async v => { calls.push(v.eventId); if (v.eventId === `native:${failAt}`) throw new Error('disconnect'); return { observationId: `o-${v.eventId}` }; } };
  const adapter = createAdapter(config, client);
  const driver = await createSessionDelivery({ adapter, session, store: createDeliveryStore(file) });
  await assert.rejects(driver.sync(), /OBSERVATION_UNAVAILABLE/);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.streams.a.cursor, 138);
  assert.equal(saved.streams.a.recent.length, 16);
  assert.equal(adapter.text('a'), '');
  failAt = -1;
  const resumedAdapter = createAdapter(config, client);
  const resumed = await createSessionDelivery({ adapter: resumedAdapter, session, store: createDeliveryStore(file) });
  await resumed.sync();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).streams.a.cursor, 269);
  assert.equal(resumedAdapter.references('a').length, 16);
  const before = calls.length;
  events.push(event(270));
  await resumed.sync();
  assert.equal(calls.length, before + 1);
  assert.equal(ownReads, 2); // once per mount, never per turn
  assert.equal(calls.filter(v => v === 'native:139').length, 2);
});

test('temporary context failure restores recent acknowledged refs without a history rescan', async () => {
  const events = [event(0)]; let failed = false; let ownReads = 0; let observes = 0;
  const adapter = createAdapter(config, { context: async () => { if (failed) throw new Error('down'); return context(); }, observe: async () => { observes++; return { observationId: 'o1' }; } });
  const session = { id: 'a', seq: 1, ownEvents: () => { ownReads++; return events; }, eventAt: seq => events[seq], isOwnSeq: () => true };
  const driver = await createSessionDelivery({ adapter, session, store: createDeliveryStore() });
  await driver.sync(); await adapter.refresh('a', { query: 'tea', turn: 1 });
  failed = true; await assert.rejects(adapter.refresh('a', { query: 'tea', turn: 1 }), /CONTEXT_UNAVAILABLE/);
  assert.deepEqual(adapter.references('a'), []);
  failed = false; await driver.sync(); await adapter.refresh('a', { query: 'tea', turn: 1 });
  assert.deepEqual(adapter.references('a'), ['o1']);
  assert.equal(ownReads, 1); assert.equal(observes, 2);
});

test('oversized wire event is explicitly excluded, persisted and does not poison later evidence', async () => {
  const events = [event(0), event(1)]; events[0].data.content[0].text = '鱼'.repeat(12000);
  const observed = [];
  const adapter = createAdapter(config, { context, observe: async value => { observed.push(value.eventId); return { observationId: 'small' }; } });
  const session = { id: 'a', seq: 2, ownEvents: () => events, eventAt: seq => events[seq], isOwnSeq: () => true };
  const driver = await createSessionDelivery({ adapter, session, store: createDeliveryStore() });
  await driver.sync(); await adapter.refresh('a', { query: 'tea', turn: 1 });
  assert.deepEqual(observed, ['native:1']);
  const discovered = await adapter.act('a', { action: 'evidence' });
  assert.deepEqual(discovered.evidence, [{ ref: 'small', eventId: 'native:1', role: 'user' }]);
  assert.deepEqual(discovered.unavailable, [{ eventId: 'native:0', reason: 'WIRE_LIMIT', enteredEvidence: false }]);
  assert.match(adapter.text('a'), /Not entered into memory evidence/);
});

test('oversized source evidence explicitly fails instead of being silently dropped', async () => {
  const a = createAdapter(config, { context });
  const tooLarge = event(0); tooLarge.data.content[0].text = 'x'.repeat(16001);
  assert.throws(() => a.ingest('a', tooLarge), /EVIDENCE_LIMIT/);
});
