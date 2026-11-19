import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Authority, DEFAULT_ENTITY_ID } from '../src/engine.js';
import { createOperatorServer } from '../src/operator.js';
import { DEFAULT_CARD_ID, DEFAULT_CARD_TITLE, MAX_PERSONA_CARDS, feelingFor } from '../src/cards.js';
import { renderContinuation } from '../src/context.js';

// Visibly fake accounts: 12 digits starting with 9999.
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011';
const STREAM = `qq:${SELF}:private:${A}`;
const REASON = 'MOCK test edit';
const MOCK_PERSONA = { name: 'MOCK-甲', identity: 'MOCK-身份甲', traits: ['MOCK-特质'], examples: [{ user: 'MOCK-问', assistant: 'MOCK-答' }] };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cards-'));
  const clock = { now: 1_800_000_000_000 }, file = path.join(root, 'world.sqlite');
  const open = () => new Authority({ file, clock: () => clock.now, ...options });
  const f = { a: open(), clock, file, root };
  f.reopen = () => { f.a.close(); f.a = open(); return f.a; };
  t.after(() => { f.a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f.a.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  f.a.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  f.a.bindStream({ capabilityId: 'qq', streamId: `qq:${SELF}:private:${OWNER}`, personId: 'person:owner', audience: 'private' });
  f.a.admitPerson('qq', { uid: A, actorId: `qq:${SELF}:user:${A}`, streamId: STREAM });
  return f;
}
const raw = a => ({ ...a.store.db.prepare('SELECT persona,persona_revision FROM entities WHERE id=?').get(DEFAULT_ENTITY_ID) });
const stored = a => a.store.db.prepare("SELECT value FROM metadata WHERE key='personaCards'").get();
const context = (a, extra = {}) => a.context('qq', { streamId: STREAM, query: 'MOCK', profile: true, ...extra });
const refused = (fn, code, status) => assert.throws(fn, error => error.code === code && error.statusCode === status);

test('the persona that existed becomes the default card, current, without one byte of it changing', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  f.a.revisePersona({ patch: { speechStyle: 'MOCK-风格' }, reason: REASON });
  const before = raw(f.a), text = context(f.a).personaText, revision = f.a.health().revision;
  // Reading the library writes nothing: no metadata row, no audit entry, no revision.
  const audit = f.a.snapshot().audit.length;
  const listed = f.a.listPersonaCards();
  assert.deepEqual(listed, { entityId: DEFAULT_ENTITY_ID, personaRevision: 2, currentId: DEFAULT_CARD_ID, limit: MAX_PERSONA_CARDS,
    cards: [{ id: DEFAULT_CARD_ID, title: DEFAULT_CARD_TITLE, tags: [], summary: '', current: true, persona: JSON.parse(before.persona), createdAt: null, updatedAt: null }] });
  assert.equal(f.a.currentCardId(), DEFAULT_CARD_ID);
  assert.equal(stored(f.a), undefined);
  assert.equal(f.a.snapshot().audit.length, audit);
  // A restart of this release leaves the persona row and its rendering as they were.
  f.reopen();
  assert.deepEqual([raw(f.a), context(f.a).personaText, f.a.health().revision, stored(f.a)], [before, text, revision, undefined]);
  // The first write of the library (another card) does not touch the persona in force either.
  const made = f.a.createPersonaCard({ title: ' MOCK-乙卡 ' });
  assert.deepEqual([raw(f.a), context(f.a).personaText, f.a.health().revision], [before, text, revision]);
  assert.deepEqual(made.cards.map(card => [card.title, card.current]), [[DEFAULT_CARD_TITLE, true], ['MOCK-乙卡', false]]);
  assert.deepEqual(made.cards[0].persona, JSON.parse(before.persona));
  f.reopen();
  assert.deepEqual(f.a.listPersonaCards().cards.map(card => card.id), [DEFAULT_CARD_ID, made.id]);
});

test('making a card current is a persona revision; the card left behind keeps its persona and comes back the same bytes', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  const before = raw(f.a), text = context(f.a).personaText;
  const { id } = f.a.createPersonaCard({ title: 'MOCK-乙卡', copyFrom: DEFAULT_CARD_ID });
  f.a.updatePersonaCard({ id, patch: { name: 'MOCK-乙', identity: 'MOCK-身份乙' }, reason: REASON });
  refused(() => f.a.activatePersonaCard({ id, expectedRevision: 7, reason: REASON }), 'CONFLICT', 409);
  refused(() => f.a.activatePersonaCard({ id: 'card:none', reason: REASON }), 'NOT_FOUND', 404);
  const world = f.a.health().revision;
  const switched = f.a.activatePersonaCard({ id, expectedRevision: 1, reason: REASON });
  assert.deepEqual([switched.changed, switched.personaRevision, switched.currentId, f.a.currentCardId()], [true, 2, id, id]);
  const now = context(f.a);
  assert.equal(now.personaRevision, 2);
  assert.ok(now.personaText.includes('你是MOCK-乙。') && now.personaText.includes('MOCK-身份乙') && !now.personaText.includes('MOCK-身份甲'));
  assert.equal(f.a.health().revision, world + 1);
  // The audit shows the switch (which card to which) as a persona revision.
  assert.deepEqual(f.a.snapshot().audit.filter(entry => entry.type === 'persona.revision').map(entry => [entry.personaRevision, entry.card, entry.reason]), [[2, { from: DEFAULT_CARD_ID, to: id }, REASON]]);
  assert.deepEqual(switched.cards.find(card => card.id === DEFAULT_CARD_ID).persona, JSON.parse(before.persona));
  // Activating the card that is already current changes nothing.
  assert.deepEqual([f.a.activatePersonaCard({ id, reason: REASON }).changed, raw(f.a).persona_revision], [false, 2]);
  // Back to the default card: the next revision, and the same persona bytes as before the first switch.
  assert.equal(f.a.activatePersonaCard({ id: DEFAULT_CARD_ID, reason: REASON }).personaRevision, 3);
  assert.deepEqual([raw(f.a).persona, context(f.a).personaText], [before.persona, text]);
  assert.equal(f.a.listPersonaCards().cards.find(card => card.id === id).persona.name, 'MOCK-乙');
});

test('editing a card that is not current changes nothing a conversation reads; editing the current card is a persona revision', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  const { id } = f.a.createPersonaCard({ title: 'MOCK-乙卡' });
  const before = context(f.a), row = raw(f.a), health = f.a.health();
  const edited = f.a.updatePersonaCard({ id, title: 'MOCK-乙卡改', patch: { name: 'MOCK-乙', examples: [] }, reason: REASON });
  assert.deepEqual(edited.cards.find(card => card.id === id), { id, title: 'MOCK-乙卡改', tags: [], summary: '', current: false, persona: { ...edited.cards.find(card => card.id === id).persona, name: 'MOCK-乙', examples: [] }, createdAt: f.clock.now, updatedAt: f.clock.now });
  assert.deepEqual([context(f.a), raw(f.a), f.a.health()], [before, row, health]);
  assert.deepEqual(f.a.snapshot().audit.filter(entry => entry.type.startsWith('persona.card.')).map(entry => [entry.type, entry.cardId, entry.fields]), [['persona.card.created', id, undefined], ['persona.card.updated', id, ['name', 'examples']]]);
  // Renaming the current card is not a persona change.
  f.a.updatePersonaCard({ id: DEFAULT_CARD_ID, title: 'MOCK-默认改名', reason: REASON });
  assert.deepEqual([context(f.a), raw(f.a)], [before, row]);
  // Editing the current card's persona is: by the card route or by the old persona route, the same row.
  refused(() => f.a.updatePersonaCard({ id: DEFAULT_CARD_ID, patch: { name: 'MOCK-丙' }, expectedRevision: 5, reason: REASON }), 'CONFLICT', 409);
  assert.equal(f.a.updatePersonaCard({ id: DEFAULT_CARD_ID, patch: { name: 'MOCK-丙' }, expectedRevision: 1, reason: REASON }).personaRevision, 2);
  assert.ok(context(f.a).personaText.includes('你是MOCK-丙。'));
  assert.equal(f.a.revisePersona({ patch: { name: 'MOCK-丁' }, reason: REASON }).personaRevision, 3);
  const current = f.a.listPersonaCards().cards.find(card => card.current);
  assert.deepEqual([current.id, current.title, current.persona.name], [DEFAULT_CARD_ID, 'MOCK-默认改名', 'MOCK-丁']);
  refused(() => f.a.updatePersonaCard({ id, reason: REASON }), 'VALIDATION_ERROR', 400);
  refused(() => f.a.updatePersonaCard({ id, patch: { mood: 'x' }, reason: REASON }), 'VALIDATION_ERROR', 400);
  refused(() => f.a.updatePersonaCard({ id, title: ' ', reason: REASON }), 'VALIDATION_ERROR', 400);
});

test('tags and a one-line summary describe a card for the operator only: bounded, optional, never in a context; traits may be empty', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  const before = context(f.a), row = raw(f.a), health = f.a.health();
  const { id } = f.a.createPersonaCard({ title: 'MOCK-乙卡', tags: [' MOCK-外冷内热 ', 'MOCK-嘴直'], summary: ' MOCK-简介：一句话。 ' });
  const card = () => f.a.listPersonaCards().cards.find(item => item.id === id);
  assert.deepEqual([card().tags, card().summary], [['MOCK-外冷内热', 'MOCK-嘴直'], 'MOCK-简介：一句话。']);
  f.a.updatePersonaCard({ id, tags: ['MOCK-天然呆'], reason: REASON });
  assert.deepEqual([card().tags, card().summary, card().title], [['MOCK-天然呆'], 'MOCK-简介：一句话。', 'MOCK-乙卡']);
  f.a.updatePersonaCard({ id, tags: [], summary: '', reason: REASON });
  assert.deepEqual([card().tags, card().summary], [[], '']);
  // On the current card too they are not a persona change: same row, same context, same revisions.
  f.a.updatePersonaCard({ id: DEFAULT_CARD_ID, tags: ['MOCK-标签'], summary: 'MOCK-默认卡的简介', reason: REASON });
  assert.deepEqual([context(f.a), raw(f.a), f.a.health()], [before, row, health]);
  // They go with the card through a switch and never reach the rendered persona.
  f.a.updatePersonaCard({ id, tags: ['MOCK-不进上下文'], summary: 'MOCK-也不进上下文', patch: { traits: [] }, reason: REASON });
  assert.deepEqual(card().persona.traits, [], 'traits may be empty');
  f.a.activatePersonaCard({ id, reason: REASON });
  const now = context(f.a);
  assert.ok(!JSON.stringify(now).includes('不进上下文') && !now.personaText.includes('性格：'));
  assert.deepEqual(f.a.listPersonaCards().cards.map(item => [item.title, item.tags, item.summary, item.current]), [[DEFAULT_CARD_TITLE, ['MOCK-标签'], 'MOCK-默认卡的简介', false], ['MOCK-乙卡', ['MOCK-不进上下文'], 'MOCK-也不进上下文', true]]);
  for (const bad of [{ tags: Array(7).fill('x') }, { tags: ['x'.repeat(13)] }, { tags: [''] }, { tags: 'x' }, { tags: [1] }, { summary: 'x'.repeat(61) }, { summary: 1 }]) {
    refused(() => f.a.updatePersonaCard({ id, ...bad, reason: REASON }), 'VALIDATION_ERROR', 400);
    refused(() => f.a.createPersonaCard({ title: 'MOCK', ...bad }), 'VALIDATION_ERROR', 400);
  }
});

test('the current card cannot be deleted; another one can; the library is bounded', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  const { id } = f.a.createPersonaCard({ title: 'MOCK-乙卡', copyFrom: DEFAULT_CARD_ID });
  assert.equal(f.a.listPersonaCards().cards.find(card => card.id === id).persona.name, 'MOCK-甲', 'a copy starts with the source card\'s persona');
  refused(() => f.a.deletePersonaCard({ id: DEFAULT_CARD_ID }), 'CONFLICT', 409);
  refused(() => f.a.deletePersonaCard({ id: 'card:none' }), 'NOT_FOUND', 404);
  refused(() => f.a.createPersonaCard({ title: 'MOCK', copyFrom: 'card:none' }), 'NOT_FOUND', 404);
  f.a.activatePersonaCard({ id, reason: REASON });
  refused(() => f.a.deletePersonaCard({ id }), 'CONFLICT', 409);
  // The default card is a card like any other once it is not current.
  assert.deepEqual(f.a.deletePersonaCard({ id: DEFAULT_CARD_ID }).cards.map(card => card.id), [id]);
  assert.equal(raw(f.a).persona_revision, 2, 'deleting is not a persona revision');
  for (let n = 1; n < MAX_PERSONA_CARDS; n++) f.a.createPersonaCard({ title: `MOCK-${n}` });
  refused(() => f.a.createPersonaCard({ title: 'MOCK-多一张' }), 'CONFLICT', 409);
  refused(() => f.a.createPersonaCard({ title: 'x'.repeat(41) }), 'VALIDATION_ERROR', 400);
});

test('her feeling in a digest is read back to the card it was written under only; a digest without a card belongs to the default card', t => {
  const f = fixture(t), { a, clock } = f;
  let seq = 0;
  const say = (text, she = false) => a.observe('qq', { eventId: `e-${++seq}`, streamId: STREAM, actorId: she ? 'qq:model' : `qq:${SELF}:user:${A}`, role: she ? 'assistant' : 'user', text, at: clock.now });
  const rollOut = text => { say(text); say('MOCK-REPLY 嗯', true); clock.now += 1000; a.context('qq', { streamId: STREAM, query: 'MOCK', windowFromAt: clock.now }); return a.consolidationNext(DEFAULT_ENTITY_ID).task; };
  const commit = (task, n) => a.consolidationCommit(DEFAULT_ENTITY_ID, { taskId: task.taskId, outcome: 'ok', digest: { summary: `MOCK-摘要${n}`, feeling: `MOCK-感受${n}` }, facts: [] }).digestId;
  const body = id => JSON.parse(a.store.db.prepare('SELECT body FROM memory_items WHERE id=?').get(id).body);
  const lines = () => context(a, { windowFromAt: clock.now }).continuationText.split('\n').slice(1).map(line => { const { summary, feeling } = JSON.parse(line); return [summary, feeling]; });
  // Written before cards existed: no card id in the body.
  const old = commit(rollOut('我周末去了MOCK-海边'), 1);
  assert.equal(body(old).cardId, DEFAULT_CARD_ID);
  a.store.db.prepare("UPDATE memory_items SET body=json_remove(body,'$.cardId') WHERE id=?").run(old);
  assert.equal(body(old).cardId, undefined);
  assert.deepEqual(lines(), [['MOCK-摘要1', 'MOCK-感受1']]);
  // Another card comes into force: the summary stays (objective), the feeling of the default card does not show.
  const { id } = a.createPersonaCard({ title: 'MOCK-乙卡' });
  // A batch handed out under the default card and answered after the switch is still the default card's.
  const pending = rollOut('我今天吃了MOCK-火锅');
  a.activatePersonaCard({ id, reason: REASON });
  const late = commit(pending, 2);
  assert.equal(body(late).cardId, DEFAULT_CARD_ID);
  assert.deepEqual(lines(), [['MOCK-摘要1', undefined], ['MOCK-摘要2', undefined]]);
  // What is written under the new card carries it and is shown to it.
  clock.now += 24 * 3600000;   // two batches a conversation a day
  const own = commit(rollOut('我明天要去MOCK-爬山'), 3);
  assert.equal(body(own).cardId, id);
  assert.deepEqual(lines(), [['MOCK-摘要2', undefined], ['MOCK-摘要3', 'MOCK-感受3']]);
  // Back on the default card: its feelings (the untagged old one included) return, the other card's does not.
  a.activatePersonaCard({ id: DEFAULT_CARD_ID, reason: REASON });
  assert.deepEqual(lines(), [['MOCK-摘要2', 'MOCK-感受2'], ['MOCK-摘要3', undefined]]);
  assert.deepEqual([feelingFor(body(old), DEFAULT_CARD_ID), feelingFor(body(old), id), feelingFor(body(own), id), feelingFor(body(own), DEFAULT_CARD_ID), feelingFor({}, id)], ['MOCK-感受1', '', 'MOCK-感受3', '', '']);
  // Without a card named, the block is rendered for the default card (what callers before cards got).
  assert.ok(renderContinuation([{ id: 'x', summary: 'MOCK-s', feeling: 'MOCK-f', toAt: 0 }]).text.includes('MOCK-f'));
  // Retrieval shows a digest's summary only, whatever the card.
  assert.ok(!context(a, { query: 'MOCK-摘要1 MOCK-摘要2 MOCK-摘要3', windowFromAt: clock.now, exclude: [old, late, own] }).text.includes('MOCK-感受'));
});

test('a database written by this release still opens for a reader that knows no cards: one extra metadata row, no schema change', t => {
  const f = fixture(t, { persona: MOCK_PERSONA });
  const shape = () => { const db = new DatabaseSync(f.file, { readOnly: true }); try { return JSON.stringify([db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(), db.prepare('PRAGMA user_version').get()]); } finally { db.close(); } };
  f.a.close(); const before = shape(); f.reopen();
  const { id } = f.a.createPersonaCard({ title: 'MOCK-乙卡' });
  f.a.updatePersonaCard({ id, patch: { name: 'MOCK-乙' }, reason: REASON });
  f.a.activatePersonaCard({ id, reason: REASON });
  f.a.close();
  assert.equal(shape(), before);
  const db = new DatabaseSync(f.file, { readOnly: true });
  try {
    // What a release without cards reads is the persona in force, which is the current card's.
    assert.equal(JSON.parse(db.prepare('SELECT persona FROM entities WHERE id=?').get(DEFAULT_ENTITY_ID).persona).name, 'MOCK-乙');
    assert.deepEqual(db.prepare('SELECT key FROM metadata ORDER BY key').all().map(row => row.key).filter(key => key === 'personaCards'), ['personaCards']);
  } finally { db.close(); }
  f.reopen();
});

test('operator routes: list, create, edit, make current and delete cards', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-cards-'));
  const authority = new Authority({ file: path.join(dir, 'world.sqlite'), persona: MOCK_PERSONA });
  const token = 'o'.repeat(43), socketPath = path.join(dir, 'operator.sock');
  const app = createOperatorServer({ authority, socketPath, tokenHash: createHash('sha256').update(token).digest('hex'), origins: [] });
  await app.start();
  t.after(async () => { await app.close(); authority.close(); fs.rmSync(dir, { recursive: true }); });
  const call = (method, target, data, key = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: target, method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  assert.equal((await call('GET', '/persona/cards', undefined, 'x'.repeat(43))).status, 401);
  const first = (await call('GET', '/persona/cards')).body.value;
  assert.deepEqual([first.currentId, first.cards.length, first.cards[0].persona.name], [DEFAULT_CARD_ID, 1, 'MOCK-甲']);
  const made = await call('POST', '/persona/cards', { title: 'MOCK-乙卡', tags: ['MOCK-嘴直'], summary: 'MOCK-简介', copyFrom: DEFAULT_CARD_ID });
  assert.equal(made.status, 200);
  const id = made.body.value.id;
  assert.equal((await call('POST', '/persona/cards', { title: 'MOCK', persona: {} })).status, 400);
  assert.equal((await call('POST', '/persona/cards/update', { id, patch: { mood: 'x' } })).status, 400);
  const edited = await call('POST', '/persona/cards/update', { id, title: 'MOCK-乙卡改', tags: ['MOCK-嘴直', 'MOCK-外冷内热'], patch: { name: 'MOCK-乙' } });
  assert.deepEqual([edited.status, edited.body.value.personaRevision], [200, 1]);
  assert.deepEqual(edited.body.value.cards.filter(card => card.id === id).map(card => [card.tags, card.summary]), [[['MOCK-嘴直', 'MOCK-外冷内热'], 'MOCK-简介']]);
  assert.equal((await call('POST', '/persona/cards/update', { id, tags: ['x'.repeat(13)] })).status, 400);
  assert.equal((await call('GET', '/world')).body.value.persona.value.name, 'MOCK-甲');
  assert.equal((await call('POST', '/persona/cards/delete', { id: DEFAULT_CARD_ID })).status, 409);
  assert.equal((await call('POST', '/persona/cards/activate', { id, expectedRevision: 9 })).status, 409);
  const switched = await call('POST', '/persona/cards/activate', { id, expectedRevision: 1 });
  assert.deepEqual([switched.status, switched.body.value.personaRevision, switched.body.value.currentId], [200, 2, id]);
  const world = (await call('GET', '/world')).body.value.persona;
  assert.deepEqual([world.revision, world.value.name], [2, 'MOCK-乙']);
  assert.equal((await call('POST', '/persona/cards/delete', { id })).status, 409);
  const removed = await call('POST', '/persona/cards/delete', { id: DEFAULT_CARD_ID });
  assert.deepEqual([removed.status, removed.body.value.cards.map(card => card.title)], [200, ['MOCK-乙卡改']]);
});
