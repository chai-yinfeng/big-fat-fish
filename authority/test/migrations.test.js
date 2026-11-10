import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Authority } from '../src/engine.js';
import { Store } from '../src/store.js';
import { MIGRATIONS, LEDGER, BACKUP_DIR, KEEP_BACKUPS, checkList, listBackups, plan } from '../src/migrations.js';

const table = (id, name = `drill-${id}`) => ({ id, name, up: db => db.exec(`CREATE TABLE drill_${id}(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX drill_${id}_body ON drill_${id}(body)`) });
const tables = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name); } finally { db.close(); } };
const rejection = (fn, code) => assert.throws(fn, error => error.code === code);

/** A database as the current release leaves it, with some rows in the tables every turn writes. */
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-migrations-')), file = path.join(dir, 'authority.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new Authority({ file, clock: () => 1000 });
  a.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  a.bindActor({ capabilityId: 'chat', externalActorId: 'alice', personId: 'p1' });
  a.bindStream({ capabilityId: 'chat', streamId: 'one', personId: 'p1', audience: 'private' });
  write(a, 'first');
  a.close();
  return { dir, file, backups: path.join(dir, BACKUP_DIR) };
}
function write(a, id) {
  const observationId = a.observe('chat', { eventId: id, streamId: 'one', actorId: 'alice', role: 'user', text: `I like ${id}.`, at: 900 }).observationId;
  a.submit('chat', { proposalId: id, observationId, type: 'fact.report', payload: { key: id, value: id, quote: `I like ${id}.` } });
  a.processPending();
  return a.snapshot().facts.length;
}
function dump(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
    const rows = Object.fromEntries(schema.filter(o => o.type === 'table').map(o => [o.name, db.prepare(`SELECT * FROM "${o.name}"`).all()]));
    return JSON.stringify({ schema, rows, version: db.prepare('PRAGMA user_version').get(), application: db.prepare('PRAGMA application_id').get() });
  } finally { db.close(); }
}
/** File bytes without the two header counters SQLite bumps on any committed write (the open itself re-sets user_version). */
function bytes(file) {
  const buffer = fs.readFileSync(file);
  buffer.fill(0, 24, 28); buffer.fill(0, 92, 96);
  return buffer.toString('hex');
}

test('this release registers a valid migration list', () => {
  assert.doesNotThrow(() => checkList(MIGRATIONS));
  assert.ok(Object.isFrozen(MIGRATIONS));
});

test('nothing registered: an existing database is left exactly as it was (no ledger, no backup)', t => {
  const w = world(t), before = { dump: dump(w.file), bytes: bytes(w.file), files: fs.readdirSync(w.dir) };
  for (const options of [undefined, { migrations: [] }]) {
    const a = new Authority({ file: w.file, ...options });
    assert.deepEqual(a.store.migrated, { applied: [], backup: null });
    a.close();
    assert.equal(dump(w.file), before.dump);
    assert.equal(bytes(w.file), before.bytes);
    assert.deepEqual(fs.readdirSync(w.dir), before.files);
  }
  assert.ok(!tables(w.file).includes(LEDGER));
});

test('pending migrations: backup first, then apply and record; reopening applies nothing again', t => {
  const w = world(t), before = dump(w.file);
  let a = new Authority({ file: w.file, migrations: [table(1), table(2)] });
  const { applied, backup } = a.store.migrated;
  assert.deepEqual(applied, [{ id: 1, name: 'drill-1' }, { id: 2, name: 'drill-2' }]);
  assert.match(path.basename(backup), /^authority-m0-m2-\d{8}T\d{9}Z\.sqlite$/);
  assert.equal(path.dirname(backup), w.backups);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(w.backups).mode & 0o777, 0o700);
  // The backup is the database as it was: same schema, rows, user_version and application_id, no ledger.
  assert.equal(dump(backup), before);
  assert.deepEqual(a.store.db.prepare(`SELECT id,name FROM ${LEDGER} ORDER BY id`).all().map(row => ({ ...row })), [{ id: 1, name: 'drill-1' }, { id: 2, name: 'drill-2' }]);
  assert.match(a.store.db.prepare(`SELECT applied_at FROM ${LEDGER} WHERE id=1`).get().applied_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(a.store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(write(a, 'second'), 2);
  a.close();
  assert.deepEqual(tables(w.file).filter(name => name.startsWith('drill_')), ['drill_1', 'drill_2']);

  a = new Authority({ file: w.file, migrations: [table(1), table(2)] });
  assert.deepEqual(a.store.migrated, { applied: [], backup: null });
  assert.equal(a.store.db.prepare(`SELECT count(*) AS n FROM ${LEDGER}`).get().n, 2);
  a.close();
  assert.deepEqual(listBackups(w.backups), [path.basename(backup)]);

  // The next release adds one: only that one runs, behind its own backup.
  a = new Authority({ file: w.file, migrations: [table(1), table(2), table(3)] });
  assert.deepEqual(a.store.migrated.applied, [{ id: 3, name: 'drill-3' }]);
  assert.match(path.basename(a.store.migrated.backup), /^authority-m2-m3-/);
  assert.ok(tables(a.store.migrated.backup).includes('drill_2') && !tables(a.store.migrated.backup).includes('drill_3'));
  a.close();
});

test('a release that knows fewer migrations (rollback) opens and writes the migrated database', t => {
  const w = world(t);
  new Authority({ file: w.file, migrations: [table(1), table(2)] }).close();
  const after = tables(w.file);
  for (const migrations of [[], [table(1)]]) {
    const a = new Authority({ file: w.file, migrations });
    assert.deepEqual(a.store.migrated, { applied: [], backup: null });
    assert.deepEqual(plan(a.store.db, migrations).unknown.map(row => row.id), migrations.length ? [2] : [1, 2]);
    write(a, `rolled-back-${migrations.length}`);
    a.close();
  }
  assert.deepEqual(tables(w.file), after);
  assert.equal(listBackups(w.backups).length, 1);
});

test('only the newest backups are kept', t => {
  const w = world(t), list = [];
  let stamp = Date.UTC(2026, 10, 10);
  for (let id = 1; id <= KEEP_BACKUPS + 2; id++) {
    list.push(table(id));
    new Store(w.file, undefined, { migrations: [...list], now: () => (stamp += 1000) }).close();
  }
  fs.writeFileSync(path.join(w.backups, 'notes.txt'), 'not a backup');
  const kept = listBackups(w.backups);
  assert.deepEqual(kept.map(name => name.slice(0, name.lastIndexOf('-'))), ['authority-m2-m3', 'authority-m3-m4', 'authority-m4-m5']);
  assert.deepEqual(fs.readdirSync(w.backups).sort(), [...kept, 'notes.txt'].sort());
});

test('a failed backup refuses to migrate and to start; the database is unchanged and still opens', t => {
  const w = world(t), before = dump(w.file);
  fs.writeFileSync(w.backups, 'in the way');  // the backup directory cannot be created
  rejection(() => new Authority({ file: w.file, migrations: [table(1)] }), 'MIGRATION_BACKUP_FAILED');
  assert.equal(dump(w.file), before);
  fs.rmSync(w.backups);
  // The output file already exists: VACUUM INTO refuses, and the stale file is not mistaken for a backup of this run.
  fs.mkdirSync(w.backups);
  fs.writeFileSync(path.join(w.backups, 'authority-m0-m1-20261110T000000000Z.sqlite'), 'stale');
  rejection(() => new Store(w.file, undefined, { migrations: [table(1)], now: () => Date.UTC(2026, 10, 10) }), 'MIGRATION_BACKUP_FAILED');
  assert.equal(dump(w.file), before);
  const a = new Authority({ file: w.file });
  assert.equal(write(a, 'second'), 2);
  a.close();
});

test('a migration that fails part-way rolls the whole batch back; the database stays usable', t => {
  const w = world(t), before = dump(w.file);
  const broken = { id: 2, name: 'broken', up: db => { db.exec('CREATE TABLE drill_half(id TEXT)'); db.exec('INSERT INTO no_such_table(id) VALUES(1)'); } };
  rejection(() => new Authority({ file: w.file, migrations: [table(1), broken] }), 'MIGRATION_FAILED');
  assert.equal(dump(w.file), before);
  const [backup] = listBackups(w.backups);
  assert.equal(dump(path.join(w.backups, backup)), before);
  const a = new Authority({ file: w.file });
  assert.equal(write(a, 'second'), 2);
  a.close();
  // Fixed in the next build: both apply.
  const fixed = new Authority({ file: w.file, migrations: [table(1), table(2)] });
  assert.equal(fixed.store.migrated.applied.length, 2);
  fixed.close();
});

test('only additive migrations are accepted', t => {
  const w = world(t), before = dump(w.file);
  const refused = [
    db => db.exec('DROP TABLE diary_receipts'),
    db => db.exec('DROP INDEX inbox_pending'),
    db => db.exec('ALTER TABLE streams RENAME COLUMN audience TO scope'),
    db => db.exec('ALTER TABLE cleanup_jobs DROP COLUMN body'),
    db => db.exec('PRAGMA user_version=3'),
    db => db.exec('ALTER TABLE streams ADD COLUMN note TEXT'),  // additive, but rollbackLevel 1 is not declared
  ];
  for (const up of refused) {
    rejection(() => new Authority({ file: w.file, migrations: [{ id: 1, name: 'not-additive', up }] }), 'MIGRATION_INVALID');
    assert.equal(dump(w.file), before);
  }
  for (const list of [{}, [table(2)], [{ ...table(1), name: 'Bad Name' }], [{ id: 1, name: 'no-up' }], [{ ...table(1), rollbackLevel: 2 }], [table(1), table(1)]]) {
    rejection(() => new Authority({ file: w.file, migrations: list }), 'MIGRATION_INVALID');
  }
  assert.equal(dump(w.file), before);
});

test('named inserts keep every write path working after columns are added to existing tables', t => {
  const w = world(t);
  const names = tables(w.file).filter(name => name !== 'sqlite_sequence');
  const widen = { id: 1, name: 'widen-all', rollbackLevel: 1, up: db => { for (const name of names) db.exec(`ALTER TABLE ${name} ADD COLUMN drill_extra TEXT; ALTER TABLE ${name} ADD COLUMN drill_count INTEGER NOT NULL DEFAULT 7`); } };
  let a = new Authority({ file: w.file, migrations: [widen] });
  assert.equal(a.store.migrated.applied.length, 1);
  a.registerCapability({ id: 'read', policy: 'learning.v1' });
  a.bindActor({ capabilityId: 'chat', externalActorId: 'bob', personId: 'p2' });
  a.bindStream({ capabilityId: 'chat', streamId: 'two', personId: 'p2', audience: 'private' });
  assert.equal(write(a, 'second'), 2);
  assert.match(a.context('chat', { streamId: 'one', query: 'second' }).text, /second/);
  a.close();
  // The release being replaced (no migration registered) writes the widened tables too.
  a = new Authority({ file: w.file });
  assert.equal(write(a, 'third'), 3);
  assert.equal(a.store.db.prepare('SELECT drill_count FROM observations ORDER BY rowid DESC LIMIT 1').get().drill_count, 7);
  a.close();
});

test('a ledger that disagrees with this release refuses to open', t => {
  const w = world(t);
  new Authority({ file: w.file, migrations: [table(1), table(2)] }).close();
  rejection(() => new Authority({ file: w.file, migrations: [table(1, 'renamed'), table(2)] }), 'SCHEMA_ERROR');
  const db = new DatabaseSync(w.file);
  db.exec(`DELETE FROM ${LEDGER} WHERE id=1`); db.close();
  rejection(() => new Authority({ file: w.file, migrations: [table(1), table(2)] }), 'SCHEMA_ERROR');
});

test('a new database gets the migrations without a backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-migrations-new-')), file = path.join(dir, 'authority.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const target of [file, ':memory:']) {
    const a = new Authority({ file: target, migrations: [table(1)] });
    assert.deepEqual(a.store.migrated, { applied: [{ id: 1, name: 'drill-1' }], backup: null });
    assert.equal(a.store.db.prepare(`SELECT count(*) AS n FROM ${LEDGER}`).get().n, 1);
    a.close();
  }
  assert.deepEqual(fs.readdirSync(dir), ['authority.sqlite']);
});
