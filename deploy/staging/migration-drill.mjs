#!/usr/bin/env node
// Staging migration drill (a staging tool, never part of a release or of the production path):
//   node migration-drill.mjs --to <release dir> --from <release dir> --database <COPY of an authority database>
// With the TO release's own Store code it injects a test migration (a new staging_drill_* table)
// into the copy and requires: a backup made first, the migration applied and recorded, nothing
// applied again on reopen. Then the FROM release's code must open the migrated copy and take a
// write (observe -> submit -> review), as it would after `companion-deploy rollback`. When FROM
// names its insert columns (ROLLBACK_LEVEL >= 1) the same is repeated with a column added to
// existing tables; an older FROM (positional inserts) skips that part and says so.
// Prints one line `DRILL {json}`; exits 1 with `DRILL FAILED <reason>` otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const load = (release, relative) => import(pathToFileURL(path.join(release, relative)).href);
const tablesOf = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name); } finally { db.close(); } };

/** One observation reviewed into a fact, through the given release's Authority. Returns the fact count. */
function write(authority, tag) {
  const capabilityId = 'staging-drill', streamId = 'drill-' + tag, personId = 'person:staging-drill';
  authority.registerCapability({ id: capabilityId, policy: 'conversation.v1' });
  authority.bindActor({ capabilityId, externalActorId: 'MOCK-drill', personId });
  authority.bindStream({ capabilityId, streamId, personId, audience: 'private' });
  if (authority.worldStatus().paused) authority.setWorldPaused({ paused: false });  // scenarios leave the world paused; this is a copy
  const { observationId } = authority.observe(capabilityId, { eventId: tag, streamId, actorId: 'MOCK-drill', role: 'user', text: `MOCK drill ${tag}.`, at: Date.now() - 1000 });
  authority.submit(capabilityId, { proposalId: tag, observationId, type: 'fact.report', payload: { key: 'drill-' + tag, value: tag, quote: `MOCK drill ${tag}.` } });
  authority.processPending();
  const facts = authority.snapshot().facts.filter(fact => String(fact.key).startsWith('drill-'));
  assert.ok(facts.some(fact => fact.value === tag), `the ${tag} write was not stored`);
  return facts.length;
}

export async function drill({ to, from, database }) {
  const target = await load(to, 'authority/src/engine.js'), registry = await load(to, 'authority/src/migrations.js');
  const source = await load(from, 'authority/src/engine.js');
  const fromLevel = fs.existsSync(path.join(from, 'authority/src/migrations.js')) ? (await load(from, 'authority/src/migrations.js')).ROLLBACK_LEVEL ?? 0 : 0;
  const backups = path.join(path.dirname(database), registry.BACKUP_DIR), start = registry.MIGRATIONS.length;
  assert.ok(!tablesOf(database).some(name => name.startsWith('staging_drill')), 'the copy was already drilled');
  const table = { id: start + 1, name: 'staging-drill-table', up: db => db.exec('CREATE TABLE staging_drill_marker(id INTEGER PRIMARY KEY,note TEXT NOT NULL); CREATE INDEX staging_drill_note ON staging_drill_marker(note)') };
  const column = { id: start + 2, name: 'staging-drill-column', rollbackLevel: 1, up: db => db.exec('ALTER TABLE streams ADD COLUMN staging_drill_note TEXT; ALTER TABLE observations ADD COLUMN staging_drill_count INTEGER NOT NULL DEFAULT 0') };
  const rounds = [];

  for (const [label, list] of [['table', [...registry.MIGRATIONS, table]], ...(fromLevel >= 1 ? [['column', [...registry.MIGRATIONS, table, column]]] : [])]) {
    const added = list.at(-1), known = registry.listBackups(backups);
    // TO applies it behind a backup, records it, and keeps writing.
    let authority = new target.Authority({ file: database, migrations: list });
    try {
      const { applied, backup } = authority.store.migrated;
      assert.deepEqual(applied, [{ id: added.id, name: added.name }], 'the drill migration was not the one applied');
      assert.ok(backup && path.dirname(backup) === backups && !known.includes(path.basename(backup)), 'no new backup was made');
      assert.equal(fs.statSync(backup).mode & 0o777, 0o600, 'backup is not 0600');
      assert.ok(new RegExp(`^authority-m${added.id - 1}-m${added.id}-`).test(path.basename(backup)), 'backup name lacks the versions');
      const marker = label === 'table' ? () => tablesOf(backup).includes('staging_drill_marker') : () => { const db = new DatabaseSync(backup, { readOnly: true }); try { return db.prepare('PRAGMA table_info(streams)').all().some(c => c.name === 'staging_drill_note'); } finally { db.close(); } };
      assert.ok(!marker(), 'the backup already contains the migration');
      assert.deepEqual(authority.store.db.prepare(`SELECT name FROM ${registry.LEDGER} WHERE id=?`).get(added.id)?.name, added.name, 'the ledger has no row for the drill migration');
      assert.equal(authority.store.db.prepare('PRAGMA user_version').get().user_version, 2);
      write(authority, `to-${label}`);
    } finally { authority.close(); }
    // Reopening applies nothing and makes no backup.
    authority = new target.Authority({ file: database, migrations: list });
    try {
      assert.deepEqual(authority.store.migrated, { applied: [], backup: null }, 'the migration ran twice');
      assert.equal(authority.store.db.prepare(`SELECT count(*) AS n FROM ${registry.LEDGER}`).get().n, added.id);
      assert.equal(registry.listBackups(backups).length, Math.min(known.length + 1, registry.KEEP_BACKUPS));
    } finally { authority.close(); }
    // FROM (the release a rollback returns to) opens the migrated copy and writes.
    authority = new source.Authority({ file: database });
    let facts;
    try { facts = write(authority, `from-${label}`); } finally { authority.close(); }
    const db = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(db.prepare(`SELECT count(*) AS n FROM ${registry.LEDGER}`).get().n, added.id, 'the old release changed the ledger'); assert.ok(tablesOf(database).includes('staging_drill_marker')); } finally { db.close(); }
    rounds.push({ label, migration: `m${added.id}-${added.name}`, facts });
  }
  return { registered: start, fromRollbackLevel: fromLevel, rounds: rounds.map(round => round.label), backups: registry.listBackups(backups).length,
    line: `registered=${start}; ${rounds.map(round => `${round.migration}: backup, applied, recorded, idempotent, old release writes`).join('; ')}${fromLevel >= 1 ? '' : '; column drill skipped (from release inserts by position, rollback level 0)'}` };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), option = name => { const value = argv[argv.indexOf(name) + 1]; return argv.includes(name) && value && path.isAbsolute(value) ? value : null; };
  try {
    const options = { to: option('--to'), from: option('--from'), database: option('--database') };
    if (Object.values(options).some(value => !value)) throw new Error('usage: --to <release dir> --from <release dir> --database <copy>');
    process.stdout.write('DRILL ' + JSON.stringify(await drill(options)) + '\n');
  } catch (error) {
    process.stdout.write('DRILL FAILED ' + String(error?.message ?? error).split('\n')[0].slice(0, 300) + '\n');
    process.exitCode = 1;
  }
}
