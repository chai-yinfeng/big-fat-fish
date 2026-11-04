import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnQuery, createEpochStore, boundActiveSurface } from '../lib/execution-context.js';
import { createAdapter, observationFromEvent } from '../lib/adapter.js';
import { qqSessionId, qqSessionEpoch } from '../../qq/worker-route.js';
const input = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] });

test('queries use this turn real input only; empty tool steps reuse it, not earlier turns or plugin text', () => {
  const query = createTurnQuery();
  assert.equal(query({ turn: 1, messages: [input('hidden plugin text', 'plugin'), input('tea')] }), 'tea');
  assert.equal(query({ turn: 1, messages: [] }), 'tea');
  assert.throws(() => query({ turn: 2, messages: [] }), /REAL_USER_INPUT_REQUIRED/);
  assert.equal(query({ turn: 2, messages: [input('forged SDK label')] }, 'trusted QQ observation'), 'trusted QQ observation');
  assert.equal(qqSessionEpoch(qqSessionId('100', '200', 4), '100', '200'), 4);
  assert.equal(qqSessionEpoch(qqSessionId('100', '200') + '-e04', '100', '200'), null);
});

test('execution stamps survive restart and cannot adopt a forgotten Native history into a new epoch', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-epoch-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-epoch-')); fs.rmSync(dir, { recursive: true }); });
  const file = path.join(dir, 'epochs.json'), session = { id: 'native', firstLifecycleSeq: 0 }, context = { entityId: 'entity:big-fat-fish', memoryEpoch: 0 };
  createEpochStore(file).assert(session, context);
  assert.throws(() => createEpochStore(file).assert({ ...session, firstLifecycleSeq: 10 }, { ...context, memoryEpoch: 1 }), /EPOCH_RETIRED/);
  assert.throws(() => createEpochStore().assert({ ...session, firstLifecycleSeq: 10 }, { ...context, memoryEpoch: 1 }), /EPOCH_RETIRED/);
  createEpochStore(file).assert({ id: 'fresh', firstLifecycleSeq: 0 }, { ...context, memoryEpoch: 1 });
});

test('official surface replacement retires completed old turns, never the active tool turn or raw log', async () => {
  const raw = [], surface = [], appended = [];
  for (let turn = 1; turn <= 4; turn++) {
    raw.push({ seq: raw.length, type: 'turn/start', data: { turn } });
    const event = { seq: raw.length, type: 'user/message', data: input('x'.repeat(300)) };
    raw.push(event); surface.push(event);
    if (turn < 4) raw.push({ seq: raw.length, type: 'turn/end', data: { turn } });
  }
  const count = raw.length, agent = { id: 'native', ctx: { sessionQuery: { readSurface: async () => ({ events: surface, capturedThroughSeq: count - 1 }), observeSession: async () => ({ events: raw, [Symbol.dispose]() {} }) } }, session: { seq: count, append: (...args) => appended.push(args) } };
  await boundActiveSurface(agent, { turn: 4, signal: new AbortController().signal }, 1500);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0][2].sourceEventSeqs, [surface[0].seq]);
  assert.equal(appended[0][1].source.kind, 'plugin');
  assert.equal(observationFromEvent({}, 'native', { type: 'user/message', seq: 100, time: 1, data: appended[0][1] }), null);
  assert.equal(raw.length, count);
  await assert.rejects(boundActiveSurface(agent, { turn: 4, signal: new AbortController().signal }, 100), /ACTIVE_CONTEXT_LIMIT/);
});

test('memory discovery stays stream scoped and bounded, and old epoch blocks later tools', async () => {
  let epoch = 0; const calls = [];
  const client = { context: async args => { calls.push(args); return { revision: 1, personaRevision: 1, entityId: 'entity:big-fat-fish', memoryEpoch: epoch, text: 'context' }; }, memorySearch: async args => ({ ids: [args.streamId], query: args.query }), memoryRead: async () => ({ text: 'x'.repeat(10000) }) };
  const a = createAdapter({}, client);
  await a.refresh('native', { query: 'tea', turn: 1 });
  assert.equal(calls[0].query, 'tea');
  assert.deepEqual(await a.act('native', { action: 'search', query: 'tea' }), { ids: ['native'], query: 'tea' });
  assert.equal((await a.act('native', { action: 'read', id: 'm1' })).truncated, true);
  await assert.rejects(a.act('native', { action: 'search', query: '' }), /INVALID_REQUEST/);
  epoch++;
  await assert.rejects(a.act('native', { action: 'search', query: 'tea' }), /EPOCH_RETIRED/);
});


test('Core forgotten observations never become evidence or quotations', async () => {
  const a = createAdapter({ actorId: 'owner' }, { observe: async () => ({ forgotten: true }), context: async () => ({ text: '', revision: 1, personaRevision: 1, entityId: 'e', memoryEpoch: 1 }) });
  a.ingest('native', { type: 'user/message', seq: 0, time: 1, data: input('forgotten fixture text') });
  await a.refresh('native', { query: 'new user topic', turn: 1 });
  assert.deepEqual(a.references('native'), []);
  assert.equal(a.evidence('native').unavailable[0].reason, 'FORGOTTEN');
  assert.doesNotMatch(a.text('native'), /forgotten fixture text/);
});


test('date recall accepts explicit offset ISO only, stays bounded and renders Authority world time', async () => {
  let request;
  const worldNow = Date.parse('2026-11-01T12:00:00-05:00');
  const a = createAdapter({}, { context: async () => ({ revision: 1, personaRevision: 1, entityId: 'e', memoryEpoch: 0, text: '', world: { worldNow } }), memoryRecall: async input => { request = input; return { items: [{ id: 'm', isNewEvidence: false, eventAt: null, recordedAt: worldNow, dateBasis: 'recordedAt' }] }; } });
  await a.refresh('native', { query: 'anniversary', turn: 1 });
  assert.match(a.text('native'), /Authority world time: 2026-11-01T17:00:00.000Z/);
  const value = await a.act('native', { action: 'recall', from: '2026-11-01T00:00:00-05:00', to: '2026-11-01T23:59:59-05:00' });
  assert.equal(request.fromAt, Date.parse('2026-11-01T00:00:00-05:00')); assert.equal(request.streamId, 'native'); assert.equal(request.limit, 4); assert.equal(request.budgetChars, 1600);
  assert.equal(value.items[0].isNewEvidence, false); assert.deepEqual(a.references('native'), []);
  await assert.rejects(a.act('native', { action: 'recall', from: '2026-11-01T00:00:00', to: 'tomorrow' }), /INVALID_REQUEST/);
  await assert.rejects(a.act('native', { action: 'recall', from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }), /INVALID_REQUEST/);
});
