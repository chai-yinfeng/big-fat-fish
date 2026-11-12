import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Authority } from '../src/engine.js';
import { DEFAULT_PERSONA, renderPersona } from '../../core/src/persona.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-authority-'));
  const file = join(dir, 'authority.sqlite');
  let a = new Authority({ file, clock: () => 1000 });
  t.after(() => { a.close(); rmSync(dir, { recursive: true, force: true }); });
  a.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  a.registerCapability({ id: 'read', policy: 'learning.v1' });
  for (const capabilityId of ['chat', 'read']) {
    a.bindActor({ capabilityId, externalActorId: 'alice', personId: 'p1' });
    a.bindActor({ capabilityId, externalActorId: 'bob', personId: 'p2' });
    for (const [streamId, personId, audience] of [['one','p1','private'], ['two','p1','private'], ['bob','p2','private'], ['group','p1','shared']]) a.bindStream({ capabilityId, streamId, personId, audience });
  }
  return { get a() { return a; }, file, reopen() { a.close(); a = new Authority({ file }); return a; } };
}
function observe(a, overrides = {}, cap = 'chat') {
  return a.observe(cap, { eventId: 'event', streamId: 'one', actorId: 'alice', role: 'user', text: 'I like tea. Thank you. private secret', at: 900, ...overrides }).observationId;
}
function submit(a, observationId, overrides = {}, cap = 'chat') {
  return a.submit(cap, { proposalId: 'proposal', observationId, type: 'fact.report', payload: { key: 'drink', value: 'tea', quote: 'I like tea.' }, ...overrides });
}
function rejection(fn, code = 'VALIDATION_ERROR') { assert.throws(fn, error => error.code === code); }

test('durable pending, canonical idempotency and variant conflicts across reopen', t => {
  const f = fixture(t); const id = observe(f.a);
  assert.equal(f.a.observe('chat', { at: 900, text: 'I like tea. Thank you. private secret', role: 'user', actorId: 'alice', streamId: 'one', eventId: 'event' }).duplicate, true);
  rejection(() => observe(f.a, { text: 'changed' }), 'CONFLICT');
  assert.equal(submit(f.a, id).status, 'pending');
  rejection(() => submit(f.a, id, { payload: { key: 'drink', value: 'coffee', quote: 'coffee' } }), 'CONFLICT');
  f.reopen(); assert.equal(f.a.getReceipt('chat', 'proposal').status, 'pending');
  assert.equal(f.a.processPending({ limit: 1 })[0].status, 'accepted');
  assert.equal(submit(f.a, id).status, 'accepted');
  assert.equal(f.a.getReceipt('read', 'proposal'), null);
  const state = f.a.snapshot();
  assert.equal(state.facts.length, 1); assert.equal(state.facts[0].attribution, 'reported');
  assert.equal(state.facts[0].personId, 'p1'); assert.equal(state.facts[0].evidence.observationId, id);
  assert.equal(state.facts[0].policy, 'conversation.v1');
  assert.equal(state.audit.filter(e => e.proposalId === 'proposal').length, 1);
  f.reopen(); assert.deepEqual(f.a.processPending(), []); assert.equal(f.a.snapshot().facts.length, 1);
});

test('legacy global call name and relationship stage never project onto any person or shared view', t => {
  const { a } = fixture(t);
  a.revisePersona({ expectedRevision: 1, patch: { userCallName: 'OWNER_PRIVATE_NICKNAME', relationshipStage: 'OWNER_INTIMATE_STAGE' }, reason: 'legacy DTO projection test' });
  for (const capabilityId of ['chat', 'read']) {
    for (const streamId of ['one', 'two', 'bob', 'group']) {
      const result = a.context(capabilityId, { streamId, budgetChars: 16000 });
      assert.doesNotMatch(result.text, /OWNER_PRIVATE_NICKNAME|OWNER_INTIMATE_STAGE/);
      assert.match(result.text, /用户称呼：你/);
    }
  }
  // Admin compatibility is retained; these fields are not per-person settings.
  assert.equal(a.snapshot().persona.userCallName, 'OWNER_PRIVATE_NICKNAME');
  assert.equal(a.snapshot().persona.relationshipStage, 'OWNER_INTIMATE_STAGE');
});

test('closed bounded schemas reject forged authority, invalid types and wrong capability', t => {
  const { a } = fixture(t); const id = observe(a);
  for (const extra of ['subject', 'policy', 'deltas', 'capabilityId']) rejection(() => submit(a, id, { [extra]: 'x' }));
  rejection(() => submit(a, id, { payload: { key: 'x', value: 'tea', quote: 'tea', subject: 'p2' } }));
  for (const role of ['system', 'tool', 1]) rejection(() => observe(a, { eventId: String(role), role }));
  for (const at of [-1, NaN, Infinity, 'now']) rejection(() => observe(a, { at }));
  rejection(() => observe(a, { text: 'x'.repeat(32001) }));
  rejection(() => observe(a, { actorId: null }));
  rejection(() => a.context('chat', { streamId: 'one', personId: 'p2' }));
  rejection(() => a.context('chat', { streamId: 'one', budgetChars: -1 }));
  rejection(() => submit(a, id, {}, 'read'), 'FORBIDDEN');
  rejection(() => observe(a, {}, 'unknown'), 'FORBIDDEN');
});

test('private scope filters before retrieval, inner is never returned, group cannot leak', t => {
  const { a } = fixture(t); const id = observe(a);
  submit(a, id);
  submit(a, id, { proposalId: 'inner', type: 'self.note', payload: { text: 'INNER_MARKER', quote: 'private secret', kind: 'inner' } });
  submit(a, id, { proposalId: 'outer', type: 'self.note', payload: { text: 'OUTER_MARKER', quote: 'private secret', kind: 'outer' } });
  a.processPending();
  assert.match(a.context('chat', { streamId: 'two' }).text, /tea/);
  assert.match(a.context('chat', { streamId: 'two' }).text, /OUTER_MARKER/);
  for (const streamId of ['one','two','bob','group']) assert.doesNotMatch(a.context('chat', { streamId }).text, /INNER_MARKER/);
  for (const streamId of ['bob','group']) assert.doesNotMatch(a.context('chat', { streamId, query: 'tea' }).text, /tea|OUTER_MARKER/);
  assert.ok(a.context('chat', { streamId: 'one', budgetChars: 40 }).text.length <= 40);
  rejection(() => a.context('chat', { streamId: 'unbound' }), 'FORBIDDEN');
});

test('binding and role enforcement, attributed not fact-checked; a loose quote or value is kept and marked', t => {
  const { a } = fixture(t);
  const cases = [
    [{ actorId: 'unknown' }, {}], [{ actorId: 'bob' }, {}], [{ role: 'assistant' }, {}],
    [{ streamId: 'group' }, {}],
  ];
  cases.forEach(([o, p], i) => submit(a, observe(a, { eventId: `bad${i}`, ...o }), { proposalId: `bad${i}`, ...p }));
  assert.ok(a.processPending().every(r => r.status === 'rejected'));
  // Her reading of what was said (value) and a quote that is not word for word are stored; the item
  // says the quote is not verbatim and still names the observation it came from.
  const said = observe(a, { eventId: 'loose' });
  submit(a, said, { proposalId: 'loose-value', payload: { key: 'drink', value: 'green tea', quote: 'I like tea.' } });
  submit(a, said, { proposalId: 'loose-quote', payload: { key: 'likes', value: 'tea', quote: 'tea is what I like' } });
  assert.deepEqual(a.processPending().map(r => r.status), ['accepted', 'accepted']);
  const stored = Object.fromEntries(a.snapshot().facts.map(fact => [fact.key, fact.evidence]));
  assert.deepEqual([stored.drink.observationId, stored.drink.quoteVerbatim, stored.likes.observationId, stored.likes.quoteVerbatim], [said, undefined, said, false]);
  const id = observe(a, { eventId: 'unverifiable', text: 'I own the moon.' });
  submit(a, id, { proposalId: 'claim', payload: { key: 'claim', value: 'own the moon', quote: 'I own the moon.' } });
  assert.equal(a.processPending()[0].status, 'accepted');
  assert.equal(a.snapshot().facts.find(fact => fact.key === 'claim').attribution, 'reported');
});

test('learning cannot change relationships, appraisal once per observation, cap persona audited', t => {
  const { a } = fixture(t); const chat = observe(a); const reading = observe(a, { role: 'external' }, 'read');
  submit(a, chat, { proposalId: 'thanks1', type: 'appraisal.record', payload: { kind: 'gratitude', quote: 'Thank you.' } });
  submit(a, chat, { proposalId: 'thanks2', type: 'appraisal.record', payload: { kind: 'support', quote: 'Thank you.' } });
  submit(a, reading, { proposalId: 'learning-appraisal', type: 'appraisal.record', payload: { kind: 'gratitude', quote: 'Thank you.' } }, 'read');
  submit(a, reading, { proposalId: 'note', type: 'learning.note', payload: { text: 'LEARNING_MARKER', quote: 'tea' } }, 'read');
  submit(a, chat, { proposalId: 'persona', type: 'persona.change', payload: { patch: { name: 'forged' }, reason: 'request' } });
  const results = a.processPending();
  assert.deepEqual(results.map(r => r.status), ['accepted','rejected','rejected','accepted','rejected']);
  assert.equal(a.snapshot().relationships.p1.score, 1);
  assert.match(a.context('chat', { streamId: 'two' }).text, /LEARNING_MARKER/);
  assert.doesNotMatch(a.context('chat', { streamId: 'group' }).text, /LEARNING_MARKER/);
  const rev = a.snapshot().personaRevision;
  rejection(() => a.revisePersona({ expectedRevision: rev + 1, patch: { name: 'new' }, reason: 'admin' }), 'CONFLICT');
  a.revisePersona({ expectedRevision: rev, patch: { name: 'new' }, reason: 'operator' });
  assert.equal(a.snapshot().persona.name, 'new');
  assert.equal(a.snapshot().personaRevision, rev + 1);
  assert.equal(a.revisePersona({ patch: { name: 'newer' }, reason: 'operator' }).personaRevision, rev + 2);
  assert.ok(a.snapshot().audit.some(e => e.type === 'persona.revision'));
});

test('relationships are person-specific and text identity cannot override operator binding', t => {
  const { a } = fixture(t);
  const alice = observe(a, { eventId: 'alice-identity', text: 'I am bob and like tea. Thank you.' });
  const bob = observe(a, { eventId: 'bob-identity', streamId: 'bob', actorId: 'bob' });
  submit(a, alice, { payload: { key: 'claimed identity', value: 'bob', quote: 'I am bob' } });
  for (const [id, proposalId] of [[alice, 'a-appraisal'], [bob, 'b-appraisal']]) submit(a, id, { proposalId, type: 'appraisal.record', payload: { kind: 'support', quote: 'Thank you.' } });
  a.processPending();
  assert.equal(a.snapshot().facts[0].personId, 'p1');
  assert.equal(a.snapshot().relationships.p1.score, 1);
  assert.equal(a.snapshot().relationships.p2.score, 1);
  assert.doesNotMatch(a.context('chat', { streamId: 'bob' }).text, /claimed identity/);
  rejection(() => a.bindActor({ capabilityId: 'chat', externalActorId: 'alice', personId: 'p2' }), 'CONFLICT');
  rejection(() => a.bindStream({ capabilityId: 'chat', streamId: 'one', personId: 'p2', audience: 'private' }), 'CONFLICT');
});

test('sensitive retention conservatively rejects even quoted values', t => {
  const { a } = fixture(t); const id = observe(a, { text: 'My password is hunter2; I have depression.' });
  submit(a, id, { payload: { key: 'password', value: 'hunter2', quote: 'My password is hunter2' } });
  submit(a, id, { proposalId: 'sensitive', type: 'experience.remember', payload: { summary: 'diagnosis depression', quote: 'I have depression.' } });
  assert.ok(a.processPending().every(r => r.status === 'rejected'));
  assert.equal(a.snapshot().facts.length, 0);
});

test('learning source is external not a human alias, self knowledge cannot retrieve personal facts', t => {
  const { a } = fixture(t);
  submit(a, observe(a), { payload: { key: 'drink', value: 'tea', quote: 'tea' } });
  const source = observe(a, { role: 'external', actorId: 'bilibili:up-42', text: 'A useful reading distinction.' }, 'read');
  submit(a, source, { proposalId: 'external', type: 'learning.note', payload: { text: 'SELF_KNOWLEDGE', quote: 'useful reading distinction' } }, 'read');
  assert.deepEqual(a.processPending().map(r => r.status), ['accepted', 'accepted']);
  const note = a.snapshot().notes[0]; assert.equal(note.owner, 'self'); assert.equal(note.personId, undefined);
  assert.equal(note.evidence.actorId, 'bilibili:up-42');
  assert.match(a.context('read', { streamId: 'one' }).text, /SELF_KNOWLEDGE/);
  assert.doesNotMatch(a.context('read', { streamId: 'one' }).text, /drink|Reported by/);
  for (const streamId of ['one', 'bob']) assert.match(a.context('chat', { streamId }).text, /SELF_KNOWLEDGE/);
  assert.doesNotMatch(a.context('chat', { streamId: 'group' }).text, /SELF_KNOWLEDGE/);
  const bad = observe(a, { role: 'user', eventId: 'false-human', text: 'reading' }, 'read');
  submit(a, bad, { proposalId: 'false-human', type: 'learning.note', payload: { text: 'not external', quote: 'reading' } }, 'read');
  assert.equal(a.processPending()[0].status, 'rejected');
  for (const streamId of ['unbound', 'group']) {
    const denied = observe(a, { role: 'external', actorId: 'up', streamId, eventId: streamId, text: 'reading' }, 'read');
    submit(a, denied, { proposalId: streamId, type: 'learning.note', payload: { text: 'denied learning', quote: 'reading' } }, 'read');
  }
  assert.ok(a.processPending().every(receipt => receipt.status === 'rejected'));
});

test('assistant self notes do not require a fake human alias', t => {
  const { a } = fixture(t);
  const assistant = observe(a, { actorId: 'conversation:model', role: 'assistant' });
  submit(a, assistant, { type: 'self.note', payload: { text: 'MODEL_SELF_NOTE', kind: 'outer', quote: 'tea' } });
  submit(a, assistant, { proposalId: 'assistant-fact' });
  assert.deepEqual(a.processPending().map(r => r.status), ['accepted', 'rejected']);
  assert.match(a.context('chat', { streamId: 'two' }).text, /MODEL_SELF_NOTE/);
  assert.doesNotMatch(a.context('chat', { streamId: 'bob' }).text, /MODEL_SELF_NOTE/);
  assert.ok(!a.snapshot().actors.some(alias => alias.externalActorId === 'conversation:model'));
  for (const streamId of ['unbound', 'group']) {
    const denied = observe(a, { role: 'assistant', actorId: 'conversation:model', streamId, eventId: streamId });
    submit(a, denied, { proposalId: streamId, type: 'self.note', payload: { text: 'denied note', kind: 'outer', quote: 'tea' } });
  }
  assert.ok(a.processPending().every(receipt => receipt.status === 'rejected'));
});

test('context budgets persona fairly, preserves whole claims, and ranks content not metadata', t => {
  const { a } = fixture(t); const id = observe(a, { text: 'short tea claim. ' + 'L'.repeat(900) });
  a.revisePersona({ expectedRevision: 1, patch: { identity: 'PERSONA '.repeat(500) }, reason: 'budget test' });
  submit(a, id, { payload: { key: 'short', value: 'tea', quote: 'short tea claim.' } });
  submit(a, id, { proposalId: 'long', payload: { key: 'long', value: 'L'.repeat(900), quote: 'L'.repeat(900) } });
  a.processPending();
  const context = a.context('chat', { streamId: 'one', budgetChars: 800 }).text;
  assert.ok(context.length <= 800); assert.match(context, /\[截断\]/); assert.match(context, /\[人格\]/); assert.match(context, /\[记忆数据/);
  assert.match(context, /short.*tea/); assert.doesNotMatch(context, /LLLL/); assert.match(context, /已省略/);
  for (const query of ['conversation.v1', id, 'p1', 'private']) assert.doesNotMatch(a.context('chat', { streamId: 'one', query, budgetChars: 800 }).text, /Reported by/);
  for (const budgetChars of [0, 1, 5, 20, 100, 800, 16000, ...Array.from({ length: 120 }, (_, i) => i * 7)]) {
    const { text, personaText, memoryText } = a.context('chat', { streamId: 'one', budgetChars });
    assert.ok(text.length <= budgetChars);
    // The split fields are the same content apart; the total budget still covers both.
    assert.equal(text, personaText + (memoryText && '\n\n' + memoryText));
    assert.ok(!personaText.includes('[记忆数据') && !memoryText.includes('[人格]'));
    for (const line of text.split('\n').filter(line => line.startsWith('{'))) {
      // A memory line is the attributed content and its day; quote, IDs, role and policy stay out of the prompt.
      const row = JSON.parse(line); assert.deepEqual(Object.keys(row), ['content', 'date']);
      assert.equal(row.date, '1970-01-01');
      assert.match(row.content, /^Reported by p-[0-9a-f]{6} \(unverified\): /);
      assert.ok(row.content.includes('tea') || row.content.includes('L'.repeat(900)));
    }
    assert.ok(!text.includes(id)); assert.doesNotMatch(text, /observationId|actorId|streamId|alice|conversation\.v1|"quote"|"role"/);
  }
});

test('default persona renders untruncated next to memories at the default budget', t => {
  const { a } = fixture(t); const id = observe(a);
  submit(a, id); a.processPending();
  const context = a.context('chat', { streamId: 'one' }).text;
  assert.ok(context.length <= 4000); assert.match(context, /\[记忆数据/); assert.doesNotMatch(context, /\[截断\]/);
  assert.ok(context.startsWith(`[人格]\n${renderPersona(DEFAULT_PERSONA)}`));
  // The persona part does not depend on the query or on a later memory write: executors keep it in a stable system prompt.
  const before = a.context('chat', { streamId: 'one', query: 'tea' });
  submit(a, observe(a, { text: 'I also like coffee', eventId: 'coffee' }), { proposalId: 'coffee', payload: { key: 'drink', value: 'coffee', quote: 'I also like coffee' } }); a.processPending();
  const after = a.context('chat', { streamId: 'one', query: 'coffee' });
  assert.equal(before.personaText, `[人格]\n${renderPersona(DEFAULT_PERSONA)}`);
  assert.equal(after.personaText, before.personaText); assert.notEqual(after.memoryText, before.memoryText); assert.ok(after.revision > before.revision);
});

test('foreign SQLite remains untouched and unsupported authority schema is refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-foreign-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const foreign = join(dir, 'foreign.sqlite'); let db = new DatabaseSync(foreign);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'untouched\')'); db.close();
  rejection(() => new Authority({ file: foreign }), 'SCHEMA_ERROR');
  db = new DatabaseSync(foreign); assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['unrelated']);
  assert.equal(db.prepare('SELECT value FROM unrelated').get().value, 'untouched'); db.close();
  const own = join(dir, 'own.sqlite'); const a = new Authority({ file: own }); a.close();
  db = new DatabaseSync(own); assert.notEqual(db.prepare('PRAGMA application_id').get().application_id, 0); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.exec('PRAGMA user_version=99'); db.close();
  rejection(() => new Authority({ file: own }), 'SCHEMA_ERROR');
  db = new DatabaseSync(own); db.exec('PRAGMA user_version=1; DROP TABLE actors'); db.close();
  rejection(() => new Authority({ file: own }), 'SCHEMA_ERROR');
  db = new DatabaseSync(own); assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='actors'").get().count, 0); db.close();
  const marked = join(dir, 'marked.sqlite'); db = new DatabaseSync(marked); db.exec('PRAGMA application_id=123'); db.close();
  rejection(() => new Authority({ file: marked }), 'SCHEMA_ERROR');
  db = new DatabaseSync(marked); assert.equal(db.prepare('PRAGMA application_id').get().application_id, 123); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get().count, 0); db.close();
});

test('rejected sensitive proposals still have private durable admin evidence, not capability context', t => {
  const f = fixture(t); const id = observe(f.a, { text: 'My password is test-only-password.' });
  submit(f.a, id, { payload: { key: 'password', value: 'test-only-password', quote: 'My password is test-only-password.' } });
  assert.equal(f.a.processPending()[0].status, 'rejected'); f.reopen();
  assert.match(f.a.snapshot().observations.find(o => o.id === id).text, /test-only-password/);
  assert.doesNotMatch(f.a.context('chat', { streamId: 'one' }).text, /test-only-password/);
});

test('explicit null does not bypass strict optional field types', t => {
  const { a } = fixture(t);
  rejection(() => a.context('chat', { streamId: 'one', query: null }));
  rejection(() => a.context('chat', { streamId: 'one', budgetChars: null }));
  rejection(() => a.processPending({ limit: null }));
});

test('audit write failure rolls back state, relationship, receipt and revision together', t => {
  const f = fixture(t); const id = observe(f.a);
  submit(f.a, id, { type: 'appraisal.record', payload: { kind: 'gratitude', quote: 'Thank you.' } });
  const before = f.a.snapshot();
  f.a.store.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
  assert.throws(() => f.a.processPending(), /test audit failure/);
  assert.equal(f.a.getReceipt('chat', 'proposal').status, 'pending');
  assert.deepEqual(f.a.snapshot(), before);
  f.reopen(); assert.deepEqual(f.a.snapshot(), before);
  f.a.store.db.exec('DROP TRIGGER fail_audit');
  assert.equal(f.a.processPending()[0].status, 'accepted');
  assert.equal(f.a.snapshot().relationships.p1.score, 1);
});

test('bounded drain is FIFO and reentrant reviewer is refused', t => {
  const { a } = fixture(t); const id = observe(a);
  for (let i = 0; i < 5; i++) submit(a, id, { proposalId: `p${i}` });
  assert.deepEqual(a.processPending({ limit: 2 }).map(r => r.proposalId), ['p0','p1']);
  assert.equal(a.health().pending, 3);
  const clock = a.clock;
  a.clock = () => { rejection(() => a.processPending(), 'CONFLICT'); return clock(); };
  assert.equal(a.processPending({ limit: 2 }).length, 2);
  a.clock = clock;
  assert.equal(a.health().pending, 1);
  assert.equal(a.processPending()[0].proposalId, 'p4');
});

test('second live writer rejected by SQLite itself and close permits reopen', t => {
  const f = fixture(t);
  rejection(() => new Authority({ file: f.file }), 'WRITER_BUSY');
  f.reopen(); assert.equal(f.a.health().pending, 0);
});

test('process death releases writer lock and recovers durable pending without partial state', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-crash-')); const file = join(dir, 'a.sqlite');
  let recovered;
  t.after(() => { recovered?.close(); rmSync(dir, { recursive: true, force: true }); });
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const script = `import {Authority} from ${JSON.stringify(engineUrl)};
    const a = new Authority({file:process.argv[1]});
    a.registerCapability({id:'chat',policy:'conversation.v1'});
    a.bindActor({capabilityId:'chat',externalActorId:'alice',personId:'p1'});
    a.bindStream({capabilityId:'chat',streamId:'one',personId:'p1',audience:'private'});
    const {observationId} = a.observe('chat',{eventId:'e',streamId:'one',actorId:'alice',role:'user',text:'tea',at:1});
    a.submit('chat',{proposalId:'p',observationId,type:'fact.report',payload:{key:'drink',value:'tea',quote:'tea'}});
    a.store.db.exec('BEGIN IMMEDIATE');
    a.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(999),'revision');
    a.store.insertMemory('entity:big-fat-fish','facts',{id:'uncommitted',value:'uncommitted ghost',revision:999},1);
    a.store.db.prepare('UPDATE inbox SET status=?,receipt=?').run('accepted',JSON.stringify({proposalId:'p',status:'accepted',revision:999}));
    a.store.audit({type:'proposal.resolved',proposalId:'p',revision:999});
    process.send('ready'); setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore','pipe','pipe','ipc'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const contender = spawn(process.execPath, ['--input-type=module', '-e', `import {Authority} from ${JSON.stringify(engineUrl)};try{new Authority({file:process.argv[1]});process.exit(2)}catch(e){process.exit(e.code==='WRITER_BUSY'?0:3)}`, file]);
  assert.equal((await once(contender, 'exit'))[0], 0);
  const rawWriter = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);try{db.exec("INSERT INTO metadata VALUES('intruder','true')");process.exit(2)}catch(e){process.exit(e.errcode===5?0:3)}`, file]);
  assert.equal((await once(rawWriter, 'exit'))[0], 0);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const a = recovered = new Authority({ file });
  assert.notEqual(a.health().revision, 999); assert.equal(a.getReceipt('chat','p').status, 'pending');
  assert.equal(a.snapshot().facts.length, 0);
  assert.equal(a.processPending()[0].status, 'accepted');
  assert.equal(a.snapshot().facts.length, 1);
  assert.equal(a.snapshot().audit.filter(x => x.proposalId === 'p').length, 1);
});
