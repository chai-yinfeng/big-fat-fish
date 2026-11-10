// Forward-only schema migrations for the Authority database (docs/DEV_WORKFLOW.md "数据库迁移").
//
// Rules, enforced below where they can be:
// - The list is append-only: ids are 1,2,3,... and an applied entry is never edited or removed.
// - Additive only: new tables, new indexes, and nullable/defaulted columns on existing tables.
//   Nothing that exists is dropped, renamed or redefined, and neither PRAGMA user_version nor
//   application_id changes, so the release being replaced still opens the migrated database
//   (its inspect() accepts user_version 2 with unknown tables) and a rollback needs no restore.
// - Adding a column to an EXISTING table is only rollback-safe when the release being replaced
//   names the columns of its INSERTs. Production release 7987e8b and everything before it insert by
//   position (ROLLBACK_LEVEL 0) and would fail every write on a widened table. Such a migration
//   must declare `rollbackLevel: 1`; the deploy preflight refuses it while `current` is below that.
// - Before anything is applied to an existing database it is backed up (VACUUM INTO) next to the
//   database; a failed backup refuses the start. All pending migrations run in one transaction.
// - With nothing registered the database is not read or written by this module at all.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthorityError, fail } from './identity.js';

/** What this release tolerates when it runs on a database migrated by a NEWER release:
 *  0 = unknown tables and indexes only; 1 = also unknown columns on its own tables (named INSERTs). */
export const ROLLBACK_LEVEL = 1;
export const LEDGER = 'schema_migrations';
export const BACKUP_DIR = 'migration-backups';
export const KEEP_BACKUPS = 3;
const BACKUP_NAME = /^authority-m\d+-m\d+-(\d{8}T\d{9}Z)\.sqlite$/;

/** { id, name, rollbackLevel?, up(db) }. Empty: deploying this release migrates nothing. */
export const MIGRATIONS = Object.freeze([]);

export function checkList(migrations) {
  if (!Array.isArray(migrations)) fail('MIGRATION_INVALID', 'Migrations must be a list', 500);
  migrations.forEach((m, index) => {
    const level = m?.rollbackLevel ?? 0;
    if (m?.id !== index + 1 || !/^[a-z][a-z0-9-]{0,47}$/.test(m.name ?? '') || typeof m.up !== 'function' || !Number.isInteger(level) || level < 0 || level > ROLLBACK_LEVEL) fail('MIGRATION_INVALID', 'Migrations need consecutive ids from 1, a name, up(db) and a known rollbackLevel', 500);
  });
  return migrations;
}

/** Applied rows, oldest first; [] when the ledger table does not exist. */
export function ledger(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(LEDGER)) return [];
  return db.prepare(`SELECT id,name,applied_at FROM ${LEDGER} ORDER BY id`).all().map(row => ({ id: row.id, name: row.name, appliedAt: row.applied_at }));
}

/** applied: ledger rows; pending: registered but not applied; unknown: applied by a newer release (tolerated: that is a rollback). */
export function plan(db, migrations) {
  checkList(migrations);
  const applied = ledger(db), known = new Map(migrations.map(m => [m.id, m.name])), done = new Set(applied.map(row => row.id));
  if (applied.some(row => known.has(row.id) && known.get(row.id) !== row.name)) fail('SCHEMA_ERROR', 'Applied migrations differ from this release', 409);
  const pending = migrations.filter(m => !done.has(m.id)), newest = Math.max(0, ...done);
  if (pending.some(m => m.id < newest)) fail('SCHEMA_ERROR', 'Applied migrations are out of order for this release', 409);
  return { applied, pending, unknown: applied.filter(row => !known.has(row.id)) };
}

export function backupDirectory(file) { return path.join(path.dirname(file), BACKUP_DIR); }
export function listBackups(directory) {
  let names = [];
  try { names = fs.readdirSync(directory); } catch { /* no backups yet */ }
  return names.filter(name => BACKUP_NAME.test(name)).sort((a, b) => a.match(BACKUP_NAME)[1].localeCompare(b.match(BACKUP_NAME)[1]));
}

function backUp(db, file, from, to, now) {
  const directory = backupDirectory(file), stamp = new Date(now()).toISOString().replace(/[-:.]/g, '');
  const target = path.join(directory, `authority-m${from}-m${to}-${stamp}.sqlite`);
  let created = false;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(target, 'wx', 0o600)); created = true;  // VACUUM INTO accepts an empty file: never world-readable
    db.prepare('VACUUM INTO ?').run(target);  // consistent copy from this connection, which holds the writer lock
    fs.chmodSync(target, 0o600);
    const fd = fs.openSync(target, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || copy.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n !== db.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n) throw new Error('backup does not verify');
    } finally { copy.close(); }
    // A restart loop on a failing migration makes one backup per attempt, all of the same state: keep the newest few.
    for (const name of listBackups(directory).slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(directory, name), { force: true });
  } catch {
    if (created) try { fs.rmSync(target, { force: true }); } catch { /* reported below */ }
    fail('MIGRATION_BACKUP_FAILED', 'Could not back up the authority database before migrating', 500);
  }
  return target;
}

function shape(db) {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(), columns = new Map();
  for (const object of objects) if (object.type === 'table') columns.set(object.name, db.prepare(`PRAGMA table_info("${object.name.replaceAll('"', '""')}")`).all().map(c => JSON.stringify([c.name, c.type, c.notnull, c.dflt_value, c.pk])));
  return { objects, columns, version: db.prepare('PRAGMA user_version').get().user_version, application: db.prepare('PRAGMA application_id').get().application_id };
}

function additive(migration, before, after) {
  const refuse = () => fail('MIGRATION_INVALID', `Migration ${migration.id} is not additive`, 500);
  if (after.version !== before.version || after.application !== before.application) refuse();
  const now = new Map(after.objects.map(object => [object.type + ' ' + object.name, object]));
  for (const object of before.objects) {
    const kept = now.get(object.type + ' ' + object.name);
    if (!kept) refuse();
    if (object.type !== 'table') { if (kept.sql !== object.sql) refuse(); continue; }
    const old = before.columns.get(object.name), current = after.columns.get(object.name);
    if (old.some((column, index) => current[index] !== column)) refuse();
    if (current.length > old.length && (migration.rollbackLevel ?? 0) < 1) fail('MIGRATION_INVALID', `Migration ${migration.id} adds a column to an existing table: declare rollbackLevel 1`, 500);
  }
}

/** Applies what is pending. `fresh`: the database was created by this open, so there is nothing to back up. */
export function migrate(db, file, migrations, { fresh = false, now = Date.now } = {}) {
  if (!checkList(migrations).length) return { applied: [], backup: null };
  const { applied, pending } = plan(db, migrations);
  if (!pending.length) return { applied: [], backup: null };
  const backup = fresh || file === ':memory:' ? null : backUp(db, file, Math.max(0, ...applied.map(row => row.id)), pending.at(-1).id, now);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER}(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)`);
    for (const migration of pending) {
      const before = shape(db);
      migration.up(db);
      additive(migration, before, shape(db));
      db.prepare(`INSERT INTO ${LEDGER}(id,name,applied_at) VALUES(?,?,?)`).run(migration.id, migration.name, new Date(now()).toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the migration ended the transaction itself */ }
    if (error instanceof AuthorityError) throw error;
    fail('MIGRATION_FAILED', 'Schema migration failed and was rolled back', 500);
  }
  return { applied: pending.map(m => ({ id: m.id, name: m.name })), backup };
}
