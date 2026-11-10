import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Authority } from '../../authority/src/engine.js';
import { drill } from './migration-drill.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));

/** A copy of a paused world with a row or two, as staging hands it to the drill. */
function copy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-drill-')), database = path.join(dir, 'authority.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authority = new Authority({ file: database, initialPaused: true });
  authority.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  authority.close();
  return { dir, database };
}

test('drill with this checkout as both releases: table and column rounds, backups kept, old code writes', async t => {
  const { dir, database } = copy(t);
  const result = await drill({ to: project, from: project, database });
  assert.deepEqual(result.rounds, ['table', 'column']);
  assert.equal(result.backups, 2);
  assert.match(result.line, /staging-drill-table: backup, applied, recorded, idempotent, old release writes; .*staging-drill-column/);
  const db = new DatabaseSync(database, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM observations WHERE capability_id='staging-drill'").get().n, 4);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['authority.sqlite', 'migration-backups']);
  // A copy that was drilled before is refused instead of reporting a stale pass.
  await assert.rejects(drill({ to: project, from: project, database }), /already drilled/);
});

test('CLI prints one DRILL line and fails closed', t => {
  const { database } = copy(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'deploy/staging/migration-drill.mjs'), ...args], { encoding: 'utf8' });
  let out = run('--to', project, '--from', project, '--database', database);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^DRILL \{"registered":\d+,"fromRollbackLevel":1,.*\}\n$/);
  out = run('--to', project, '--from', project, '--database', database);
  assert.deepEqual([out.status, out.stdout], [1, 'DRILL FAILED the copy was already drilled\n']);
  assert.equal(run('--to', project).status, 1);
});
