import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { APPLICATION_ID } from '../src/store.js';
import { createAuthorityServer } from '../src/server.js';
import { createOperatorServer } from '../src/operator.js';
import http from 'node:http';
import { AuthorityClient } from '../src/client.js';
import { normalizePersona } from '../../core/src/persona.js';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-'));
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep + 'fish-memory-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}
function fixture(t) {
  const root = directory(t);
  let now = 1000000000;
  const a = new Authority({ file: path.join(root, 'a.sqlite'), clock: () => now });
  t.after(() => a.close());
  a.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'chat', externalActorId: 'alice', personId: 'person:alice' });
  a.bindStream({ capabilityId: 'chat', streamId: 'one', personId: 'person:alice', audience: 'private' });
  a.bindStream({ capabilityId: 'chat', streamId: 'two', personId: 'person:alice', audience: 'private' });
  a.bindStream({ capabilityId: 'chat', streamId: 'group', personId: 'person:alice', audience: 'shared' });
  let seq = 0;
  function remember(value, { streamId = 'one', key = 'drink', type = 'fact.report' } = {}) {
    const eventId = `event-${++seq}`, proposalId = `proposal-${seq}`;
    const input = { eventId, streamId, actorId: 'alice', role: 'user', text: value, at: now };
    const observationId = a.observe('chat', input).observationId;
    const payload = type === 'fact.report' ? { key, value, quote: value } : type === 'experience.remember' ? { summary: value, quote: value } : { text: value, quote: value, kind: 'outer' };
    a.submit('chat', { proposalId, observationId, type, payload });
    assert.equal(a.processPending()[0].status, 'accepted');
    const item = a.store.db.prepare('SELECT id FROM memory_items WHERE json_extract(body,\'$.proposalId\')=?').get(proposalId);
    return { id: item.id, observationId, input, proposalId };
  }
  return { a, root, remember, advance(ms) { now += ms; } };
}

function legacyFile(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE capabilities(id TEXT PRIMARY KEY,policy TEXT NOT NULL);
    CREATE TABLE actors(capability_id TEXT NOT NULL,actor_id TEXT NOT NULL,person_id TEXT NOT NULL,PRIMARY KEY(capability_id,actor_id));
    CREATE TABLE streams(capability_id TEXT NOT NULL,stream_id TEXT NOT NULL,person_id TEXT NOT NULL,audience TEXT NOT NULL,PRIMARY KEY(capability_id,stream_id));
    CREATE TABLE observations(id TEXT PRIMARY KEY,capability_id TEXT NOT NULL,stream_id TEXT NOT NULL,event_id TEXT NOT NULL,canonical TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(capability_id,stream_id,event_id));
    CREATE TABLE inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,capability_id TEXT NOT NULL,proposal_id TEXT NOT NULL,observation_id TEXT NOT NULL,canonical TEXT NOT NULL,body TEXT NOT NULL,policy TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(capability_id,proposal_id));
    CREATE INDEX inbox_pending ON inbox(status,seq); CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);`);
  const observation = { eventId: 'legacy-event', streamId: 'one', actorId: 'alice', role: 'user', text: '红茶', at: 1000 };
  const entry = { id: 'legacy-memory', key: 'drink', value: '红茶', personId: 'person:alice', visibility: 'private', policy: 'conversation.v1', attribution: 'reported', revision: 8, at: 1000, evidence: { observationId: 'legacy-source', quote: '红茶', at: 1000 } };
  const world = { paused: true, revision: 19, anchorWorldAt: 5000, anchorRealAt: 6000 };
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('state', JSON.stringify({ world, persona: normalizePersona({ name: '迁移鱼' }), personaRevision: 2, facts: [entry], experiences: [], notes: [], appraisals: [], relationships: {} }));
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('revision', '8');
  db.exec("INSERT INTO capabilities VALUES('chat','conversation.v1'); INSERT INTO actors VALUES('chat','alice','person:alice'); INSERT INTO streams VALUES('chat','one','person:alice','private')");
  db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?)').run('legacy-source', 'chat', 'one', 'legacy-event', JSON.stringify(observation), JSON.stringify(observation));
  db.close();
}

test('v1 -> v2 migration preserves world/persona/evidence and moves only memory corpus into item tables', t => {
  const root = directory(t), file = path.join(root, 'legacy.sqlite');
  legacyFile(file);
  const a = new Authority({ file, clock: () => 999999, persona: { name: 'must-not-replace' }, initialPaused: false });
  t.after(() => a.close());
  assert.equal(a.store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(a.worldStatus(), { paused: true, revision: 19, worldNow: 5000, realNow: 999999 });
  assert.equal(a.getEntity().personaRevision, 2);
  assert.equal(a.getEntity().persona.name, '迁移鱼');
  assert.deepEqual(Object.keys(a.store.get('state')), ['world']);
  assert.match(a.context('chat', { streamId: 'one', query: '红茶' }).text, /红茶/);
  assert.equal(a.snapshot().facts[0].evidence.observationId, 'legacy-source');
  assert.throws(() => new Authority({ file }), { code: 'WRITER_BUSY' });
});

test('failed v1 migration rolls back its DDL, rows and version together', t => {
  const root = directory(t), file = path.join(root, 'rollback.sqlite');
  legacyFile(file);
  let db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_migration BEFORE UPDATE ON metadata WHEN NEW.key='state' BEGIN SELECT RAISE(ABORT,'migration fixture failure'); END");
  db.close();
  assert.throws(() => new Authority({ file }), /migration fixture failure/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='memory_items'").get().n, 0);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='state'").get().value).facts[0].value, '红茶');
  db.close();
});

test('entity-bound sessions share only their own indexed memory; fact corrections supersede the selected person/key', t => {
  const { a, remember } = fixture(t);
  const first = remember('红茶');
  a.createEntity({ id: 'entity:other', persona: { name: '另一鱼' } });
  a.bindStream({ capabilityId: 'chat', streamId: 'other', entityId: 'entity:other', personId: 'person:alice', audience: 'private' });
  const other = remember('蓝色咖啡', { streamId: 'other' });
  assert.match(a.context('chat', { streamId: 'two', query: '红茶' }).text, /红茶/);
  assert.equal(a.memoryRead('chat', { streamId: 'one', id: other.id }).item, null);
  assert.equal(a.memoryRead('chat', { streamId: 'other', id: first.id }).item, null);
  assert.throws(() => a.memorySearch('chat', { streamId: 'one', query: '', entityId: 'entity:other' }), { code: 'VALIDATION_ERROR' });
  const revised = remember('绿茶');
  assert.equal(a.memoryRead('chat', { streamId: 'one', id: first.id }).item, null);
  assert.equal(a.store.db.prepare('SELECT superseded_by FROM memory_items WHERE id=?').get(first.id).superseded_by, revised.id);
  assert.equal(a.memoryRead('chat', { streamId: 'other', id: other.id }).item.value, '蓝色咖啡');
  const result = a.memorySearch('chat', { streamId: 'two', query: '绿茶', budgetChars: 20, limit: 1 });
  assert.equal(result.items[0].id, revised.id);
  assert.ok(result.text.length <= 20);
  assert.equal(a.memorySearch('chat', { streamId: 'group', query: '绿茶' }).items.length, 0);
  assert.equal(a.snapshot().facts.some(row => row.entityId === 'entity:other'), false);
});

test('forget erases source copies and descendants without spreading through an unrelated diary source; replay stays tombstoned', t => {
  const { a, root, remember } = fixture(t);
  const forgotten = remember('星海约定情境', { key: 'one' });
  const retained = remember('松林独立情境', { key: 'two' });
  a.submit('chat', { proposalId: 'same-source-note', observationId: forgotten.observationId, type: 'self.note', payload: { kind: 'outer', text: '星海约定情境', quote: '星海约定情境' } });
  a.processPending();
  const diary = a.writePrivateDiary({ entityId: DEFAULT_ENTITY_ID, text: '星海约定情境和松林独立情境的共同日记', sourceIds: [forgotten.id, retained.id] });
  assert.throws(() => a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [forgotten.id], expectedMemoryEpoch: 0 }), { code: 'CONFLICT' });
  a.setWorldPaused({ paused: true, expectedRevision: 1 });
  const preview = a.forgetPreview({ entityId: DEFAULT_ENTITY_ID, ids: [forgotten.id] });
  assert.ok(preview.diaryIds.includes(diary.id));
  assert.equal(preview.memoryIds.includes(retained.id), false);
  const result = a.forgetApply({ entityId: DEFAULT_ENTITY_ID, ids: [forgotten.id], expectedMemoryEpoch: preview.memoryEpoch, expectedRevision: preview.revision });
  assert.equal(result.complete, false);
  assert.equal(result.externalCleanup.status, 'pending');
  assert.equal(a.memoryRead('chat', { streamId: 'one', id: retained.id }).item.value, '松林独立情境');
  assert.equal(a.memoryRead('chat', { streamId: 'one', id: forgotten.id }).item, null);
  const raw = a.store.db.prepare('SELECT body,canonical FROM observations WHERE id=?').get(forgotten.observationId);
  assert.doesNotMatch(JSON.stringify(raw), /星海约定情境/);
  for (const row of a.store.db.prepare('SELECT body,canonical FROM inbox WHERE observation_id=?').all(forgotten.observationId)) assert.doesNotMatch(JSON.stringify(row), /星海约定情境/);
  assert.doesNotMatch(JSON.stringify(a.snapshot().audit), /星海约定情境/);
  assert.equal(fs.readFileSync(path.join(root, 'a.sqlite')).includes(Buffer.from('星海约定情境')), false);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) AS n FROM memory_tokens WHERE memory_id=?').get(forgotten.id).n, 0);
  assert.equal(a.observe('chat', forgotten.input).forgotten, true);
  assert.throws(() => a.submit('chat', { proposalId: 'resurrect', observationId: forgotten.observationId, type: 'fact.report', payload: { key: 'one', value: '星海约定情境', quote: '星海约定情境' } }), { code: 'FORBIDDEN' });
  assert.throws(() => a.setWorldPaused({ paused: false, expectedRevision: 2 }), { code: 'CONFLICT' });
  assert.throws(() => a.cleanupComplete({ id: result.id, memoryEpoch: 1, report: { sdkPurged: false, localSourcesPurged: true, platform: 'outside-control' } }), { code: 'CONFLICT' });
  a.cleanupComplete({ id: result.id, memoryEpoch: 1, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
  a.setWorldPaused({ paused: false, expectedRevision: 2 });
});

test('natural aging follows frozen world time; pinning and bounded date recall retain important authorized events', t => {
  const { a, remember, advance } = fixture(t);
  const item = remember('星空下的散步', { type: 'experience.remember' });
  const sourceAt = a.memoryRead('chat', { streamId: 'one', id: item.id }).item.evidence.at;
  a.setWorldPaused({ paused: true, expectedRevision: 1 });
  advance(500 * 86400000);
  assert.equal(a.memorySearch('chat', { streamId: 'one', query: '星空' }).items.length, 1);
  a.setWorldPaused({ paused: false, expectedRevision: 2 });
  advance(400 * 86400000);
  assert.doesNotMatch(a.context('chat', { streamId: 'one', query: '星空' }).text, /星空下的散步/);
  assert.equal(a.memoryRead('chat', { streamId: 'one', id: item.id }).item.archived, true);
  const cold = a.memorySearch('chat', { streamId: 'one', query: '星空' }).items;
  assert.equal(cold[0].id, item.id);
  assert.equal(cold[0].archived, true);
  a.setMemoryRetention({ entityId: DEFAULT_ENTITY_ID, id: item.id, pinned: true, importance: 0.9 });
  assert.match(a.context('chat', { streamId: 'one', query: '星空' }).text, /星空下的散步/);
  assert.equal(a.memorySearch('chat', { streamId: 'one', query: '星空' }).items.length, 1);
  const recall = a.memoryRecall('chat', { streamId: 'one', fromAt: sourceAt, toAt: sourceAt, limit: 1, budgetChars: 40 });
  assert.equal(recall.items[0].id, item.id);
  assert.equal(recall.isNewEvidence, false);
  assert.equal(recall.items[0].dateBasis, 'recordedAt');
  assert.equal(recall.items[0].eventAt, null);
  assert.equal(a.memoryRecall('chat', { streamId: 'group', fromAt: sourceAt, toAt: sourceAt }).items.length, 0);
  a.setMemoryRetention({ entityId: DEFAULT_ENTITY_ID, id: item.id, eventAt: sourceAt - 100 });
  assert.equal(a.memoryRecall('chat', { streamId: 'one', fromAt: sourceAt, toAt: sourceAt }).items.length, 0);
  const dated = a.memoryRecall('chat', { streamId: 'one', fromAt: sourceAt - 100, toAt: sourceAt - 100 }).items[0];
  assert.equal(dated.dateBasis, 'eventAt');
  assert.equal(dated.recordedAt, sourceAt);
});

test('operator reads private diaries only explicitly and keeps forget pending until controlled cleanup acknowledgement', async t => {
  const { a, root, remember } = fixture(t), source = remember('清晨的湖面', { type: 'experience.remember' });
  a.writePrivateDiary({ entityId: DEFAULT_ENTITY_ID, text: '仅管理者可读的静夜日记', sourceIds: [source.id] });
  const token = randomBytes(32).toString('base64url'), socketPath = path.join(root, 'operator.sock');
  const operator = createOperatorServer({ authority: a, socketPath, tokenHash: createHash('sha256').update(token).digest('hex'), origins: [] });
  await operator.start(); t.after(() => operator.close());
  const call = (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route, agent: false, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.doesNotMatch(JSON.stringify(await call('GET', '/world')), /仅管理者可读的静夜日记/);
  assert.match(JSON.stringify(await call('GET', '/memory')), /仅管理者可读的静夜日记/);
  await call('POST', '/world/pause', { paused: true, expectedRevision: 1 });
  const preview = (await call('POST', '/memory/forget-preview', { entityId: DEFAULT_ENTITY_ID, ids: [source.id] })).value;
  const removed = (await call('POST', '/memory/forget', { entityId: DEFAULT_ENTITY_ID, ids: [source.id], expectedMemoryEpoch: preview.memoryEpoch, expectedRevision: preview.revision })).value;
  assert.equal(removed.complete, false);
  assert.equal((await call('GET', '/memory/cleanup/pending')).value[0].id, removed.id);
  assert.equal((await call('POST', '/world/pause', { paused: false, expectedRevision: 2 })).status, 409);
  assert.equal((await call('POST', '/memory/cleanup/complete', { id: removed.id, memoryEpoch: removed.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } })).value.status, 'complete');
  assert.equal(a.worldStatus().paused, true);
});

test('maintenance credential sees bounded accepted items only; private diaries stay private and public drafts require explicit material authorization', async t => {
  const { a, root, remember } = fixture(t);
  const source = remember('日落下的公园散步', { type: 'experience.remember' });
  const credentials = [], clients = {};
  for (const [name, role] of [['conversation', 'capability'], ['maintenance', 'maintenance']]) {
    const token = randomBytes(32).toString('base64url'), tokenFile = path.join(root, name + '.token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    credentials.push({ hash: createHash('sha256').update(token).digest('hex'), role, ...(role === 'maintenance' ? { entityId: DEFAULT_ENTITY_ID } : { capabilityId: 'chat' }) });
    clients[name] = new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile });
  }
  const app = createAuthorityServer({ authority: a, socketPath: path.join(root, 'api.sock'), credentials });
  await app.start(); t.after(() => app.close());
  const batch = await clients.maintenance.maintenanceBatch({ afterRevision: 0, mode: 'private' });
  assert.equal(batch.items[0].id, source.id);
  assert.equal(typeof batch.items[0].importance, 'number');
  assert.equal(typeof batch.items[0].pinned, 'boolean');
  assert.ok(batch.personaText.length <= 1000);
  assert.ok(batch.items.reduce((n, row) => n + row.text.length, 0) <= 6000);
  const saved = await clients.maintenance.writeDiary({ kind: 'private', text: '今天的安静私密日记', sourceIds: [source.id] });
  assert.equal(saved.receipt.status, 'private');
  assert.equal((await clients.maintenance.writeDiary({ kind: 'private', text: '今天的安静私密日记', sourceIds: [source.id] })).receipt.id, saved.receipt.id);
  assert.equal((await clients.conversation.memoryRead({ streamId: 'one', id: saved.receipt.id })).item, null);
  assert.doesNotMatch(a.context('chat', { streamId: 'one' }).text, /今天的安静私密日记/);
  await assert.rejects(clients.conversation.maintenanceBatch({ mode: 'private' }), { status: 403 });
  await assert.rejects(clients.maintenance.context({ streamId: 'one' }), { status: 403 });
  // Simulate a Host crash after Core committed but before its local cursor save.
  const replay = await clients.maintenance.maintenanceBatch({ afterRevision: 0, mode: 'private' });
  assert.deepEqual(replay.items, []);
  assert.equal(replay.cursor, batch.cursor);
  assert.equal(replay.committedReceipt.id, saved.receipt.id);
  await assert.rejects(clients.maintenance.writeDiary({ kind: 'private', text: '重生成的不同文本仍应冲突', sourceIds: [source.id] }), { status: 409 });
  const noLoop = await clients.maintenance.maintenanceBatch({ afterRevision: batch.cursor, mode: 'private' });
  assert.deepEqual(noLoop.items, []);
  assert.ok(noLoop.cursor >= saved.receipt.revision);
  assert.deepEqual((await clients.maintenance.maintenanceBatch({ afterRevision: 0, mode: 'public' })).items, []);
  assert.throws(() => a.savePublicDiaryDraft({ entityId: DEFAULT_ENTITY_ID, text: '公开草稿', sourceIds: [source.id] }), { code: 'FORBIDDEN' });
  a.markMemoryPublic({ entityId: DEFAULT_ENTITY_ID, id: source.id });
  const pub = await clients.maintenance.maintenanceBatch({ afterRevision: 0, mode: 'public' });
  assert.equal(pub.items[0].id, source.id);
  assert.equal(pub.items[0].evidence, undefined);
  const draft = await clients.maintenance.writeDiary({ kind: 'public', text: '公园日落的公开草稿', sourceIds: [source.id] });
  assert.equal(draft.receipt.status, 'draft');
  assert.equal(a.publishDiary({ entityId: DEFAULT_ENTITY_ID, id: draft.receipt.id }).status, 'published');
  assert.equal(a.listMemory().diaries.length, 2);
});
