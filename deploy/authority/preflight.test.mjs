import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight, checkPaths } from './preflight.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD = 'authority-0.10.0-aaaaaaaaaaaa', NEW = 'authority-0.11.0-bbbbbbbbbbbb';

/** A world initialized by this checkout's own fresh-host steps, with a synthetic NapCat token. */
function world(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-preflight-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  for (const script of ['bootstrap.mjs', 'prepare-memory.mjs', 'prepare-content.mjs']) execFileSync(process.execPath, [path.join(here, script)], { env, stdio: 'ignore' });
  const base = path.join(home, '.local/share/companion-world-v1');
  fs.mkdirSync(path.join(base, 'qq-runtime/private'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(base, 'qq-runtime/private/onebot.token'), 'f'.repeat(64) + '\n', { mode: 0o600 });
  const releases = path.join(home, 'src/companion');
  for (const name of [OLD, NEW]) fs.mkdirSync(path.join(releases, name, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(releases, NEW, 'ops/purge-execution.mjs'), '');
  fs.symlinkSync(OLD, path.join(releases, 'current'));
  const edit = (label, change) => {
    const file = path.join(base, 'operator', label), value = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(value); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  };
  return { home, base, releases, release: path.join(releases, NEW), edit };
}
const codes = rows => rows.map(row => [row.label, row.code, row.field].filter(Boolean).join(' '));

test('a freshly initialized world passes, including speech and memory configs', async t => {
  const w = world(t);
  const result = await preflight({ base: w.base, release: w.release });
  assert.deepEqual(codes(result.failures), []);
  assert.deepEqual(codes(result.warnings), []);
  assert.deepEqual(result.checked.sort(), ['authority.json', 'content.json', 'conversation.json', 'execution-storage.json', 'memory-worker.json', 'model-gateway.json', 'qq-bridge.json', 'speech-models.json', 'speech.json']);
});

test('a speech.json prepared before long-audio support (no models.vad, maxAudioSeconds 30) still passes', async t => {
  const w = world(t);
  w.edit('speech.json', c => { delete c.models.vad; c.maxAudioSeconds = 30; });
  w.edit('speech-models.json', c => { c.models = c.models.filter(m => !m.id.startsWith('silero-vad')); });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), []);
});

test('bug (a): a speech.json left at schema 1 by an older first-time setup refuses the deploy', async t => {
  const w = world(t);
  w.edit('speech.json', c => { c.schemaVersion = 1; });
  w.edit('speech-models.json', c => { c.schemaVersion = 1; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['speech.json SPEECH_CONFIG_SCHEMA', 'speech-models.json SPEECH_CONFIG_SCHEMA']);
});

test('speech is optional until prepare-speech, the other service configs are required', async t => {
  const w = world(t);
  for (const label of ['speech.json', 'speech-models.json', 'content.json']) fs.rmSync(path.join(w.base, 'operator', label));
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['content.json MISSING_CONFIG']);
});

test('bug (b): a config path pinned into a versioned release is refused; current/ must exist in the new release', async t => {
  const w = world(t);
  const pinned = path.join(w.releases, OLD, 'ops/purge-execution.mjs');
  // The purge path prepare-memory used to write (Node realpaths the module).
  w.edit('memory-worker.json', c => { c.purgeModule = pinned; });
  // The current worker ignores purgeModule: a warning only.
  let result = await preflight({ base: w.base, release: w.release });
  assert.deepEqual(codes(result.failures), []);
  assert.deepEqual(codes(result.warnings), ['memory-worker.json IGNORED_LEGACY_FIELD purgeModule']);
  // 9844a5e's worker imported cfg.purgeModule: with that runtime the same config is refused.
  const report = { failures: [], fail: (label, code, field) => report.failures.push({ label, code, field }), warn: () => assert.fail('no warning') };
  checkPaths('memory-worker.json', JSON.parse(fs.readFileSync(path.join(w.base, 'operator/memory-worker.json'), 'utf8')), { release: w.release, ignored: [] }, report);
  assert.deepEqual(codes(report.failures), ['memory-worker.json RELEASE_PINNED_PATH purgeModule']);
  // Any field the runtime reads, also through a symlink, also once the release is gone.
  fs.symlinkSync(path.join(w.releases, OLD), path.join(w.home, 'pin'));
  w.edit('content.json', c => { c.sharpModule = path.join(w.home, 'pin/node_modules/sharp'); });
  w.edit('speech.json', c => { c.sherpaModule = path.join(w.releases, 'authority-0.9.0-cccccccccccc/x.js'); });
  w.edit('qq-bridge.json', c => { c.onebotTokenFile = path.join(w.releases, 'current/ops/onebot.token'); });
  result = await preflight({ base: w.base, release: w.release });
  assert.deepEqual(codes(result.failures), ['qq-bridge.json RELEASE_PATH_MISSING onebotTokenFile', 'content.json RELEASE_PINNED_PATH sharpModule', 'speech.json RELEASE_PINNED_PATH sherpaModule']);
  w.edit('qq-bridge.json', c => { c.onebotTokenFile = path.join(w.releases, 'current/ops/purge-execution.mjs'); });
  assert.ok(!codes((await preflight({ base: w.base, release: w.release })).failures).some(row => row.startsWith('qq-bridge')));
});

test('runtime shape, permissions, token files and staging ports are checked like the services do', async t => {
  const w = world(t);
  w.edit('model-gateway.json', c => { c.upstream = 'https://example.invalid'; });
  w.edit('memory-worker.json', c => { c.operatorPort = 0; });
  w.edit('qq-bridge.json', c => { c.onebotPort = 13001; });
  fs.chmodSync(path.join(w.base, 'operator/content.json'), 0o644);
  fs.rmSync(path.join(w.base, 'qq-runtime/private/onebot.token'));
  w.edit('conversation.json', c => { delete c.callerTokenHash; });
  fs.writeFileSync(path.join(w.base, 'operator/execution-storage.json'), JSON.stringify({ version: 1, sessionsRoot: 'dsh-home/sessions' }), { mode: 0o600 });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), [
    'model-gateway.json CONFIG_INVALID', 'conversation.json CONVERSATION_CONFIG', 'qq-bridge.json MISSING_PATH onebotTokenFile',
    'memory-worker.json CONFIG_INVALID', 'content.json CONFIG_PERMISSIONS', 'execution-storage.json EXECUTION_LAYOUT']);
});

test('no world yet is not a failure (first install before initialization)', async () => {
  const result = await preflight({ base: path.join(os.tmpdir(), 'fish-preflight-absent-' + process.pid, 'companion-world-v1') });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(codes(result.warnings), ['world NO_WORLD']);
});

test('CLI prints only codes, labels and key names, and exits 1 on any failure', t => {
  const w = world(t);
  const run = () => spawnSync(process.execPath, [path.join(here, 'preflight.mjs'), '--base', w.base, '--release', w.release], { encoding: 'utf8' });
  let out = run();
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^PREFLIGHT OK checked=9 failures=0 warnings=0\n$/);
  w.edit('speech.json', c => { c.schemaVersion = 1; });
  w.edit('memory-worker.json', c => { c.purgeModule = path.join(w.releases, OLD, 'ops/purge-execution.mjs'); });
  fs.rmSync(path.join(w.base, 'qq-runtime/private/onebot.token'));
  out = run();
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'PREFLIGHT FAIL qq-bridge.json MISSING_PATH onebotTokenFile\nPREFLIGHT FAIL speech.json SPEECH_CONFIG_SCHEMA\nPREFLIGHT WARN memory-worker.json IGNORED_LEGACY_FIELD purgeModule\nPREFLIGHT REFUSED checked=8 failures=2 warnings=1\n');
  const token = fs.readFileSync(path.join(w.base, 'operator/console.token'), 'utf8').trim();
  assert.ok(!out.stdout.includes(token) && !out.stdout.includes(w.home) && out.stderr === '');
  assert.equal(spawnSync(process.execPath, [path.join(here, 'preflight.mjs'), '--base', 'relative'], { encoding: 'utf8' }).stdout, 'PREFLIGHT ERROR PREFLIGHT_ARGUMENTS\n');
});

// ---- Authority database and schema migrations (authority/src/migrations.js)

const drill = (id, extra = {}) => ({ id, name: `drill-${id}`, up: db => db.exec(`CREATE TABLE drill_${id}(id TEXT PRIMARY KEY)`), ...extra });
/** The world's database as a running Authority leaves it; returns its path. */
async function database(w, migrations) {
  const { Authority } = await import('../../authority/src/engine.js');
  const file = path.join(w.base, 'authority-data/authority.sqlite');
  const authority = new Authority({ file, ...(migrations ? { migrations } : {}) });
  authority.registerCapability({ id: 'chat', policy: 'conversation.v1' });
  return { file, authority };
}

test('the database is read without a lock while the Authority runs; nothing pending is a plain pass', async t => {
  const w = world(t), { file, authority } = await database(w);
  t.after(() => authority.close());
  const before = fs.readFileSync(file), entries = fs.readdirSync(path.dirname(file));
  const result = await preflight({ base: w.base, release: w.release });
  assert.deepEqual([codes(result.failures), codes(result.warnings)], [[], []]);
  assert.ok(result.checked.includes('authority-db'));
  const out = spawnSync(process.execPath, [path.join(here, 'preflight.mjs'), '--base', w.base, '--release', w.release], { encoding: 'utf8' });
  assert.deepEqual([out.status, out.stdout, out.stderr], [0, 'PREFLIGHT OK checked=10 failures=0 warnings=0\n', '']);
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), entries);
  authority.registerCapability({ id: 'read', policy: 'learning.v1' });  // the writer was not disturbed
});

test('pending migrations are reported, and refused when the backup cannot be written or the disk is too full', async t => {
  const w = world(t), { file, authority } = await database(w);
  t.after(() => authority.close());
  const before = fs.readFileSync(file), migrations = [drill(1), drill(2)];
  let result = await preflight({ base: w.base, release: w.release, migrations });
  assert.deepEqual(codes(result.failures), []);
  assert.deepEqual(codes(result.warnings), ['authority-db MIGRATION_PENDING m1-drill-1', 'authority-db MIGRATION_PENDING m2-drill-2']);
  result = await preflight({ base: w.base, release: w.release, migrations, freeBytes: () => 1024 });
  assert.deepEqual(codes(result.failures), ['authority-db MIGRATION_DISK_SPACE']);
  fs.writeFileSync(path.join(path.dirname(file), 'migration-backups'), 'in the way');
  result = await preflight({ base: w.base, release: w.release, migrations });
  assert.deepEqual(codes(result.failures), ['authority-db MIGRATION_BACKUP_UNWRITABLE']);
  // Read-only: no ledger, no backup, not a byte of the database changed.
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'migration-backups'), 'utf8'), 'in the way');
});

test('a database migrated further than the release knows, or differently, refuses the deploy', async t => {
  const w = world(t), { authority } = await database(w, [drill(1), drill(2)]);
  authority.close();
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations: [drill(1), drill(2)] })).failures), []);
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations: [drill(1)] })).failures), ['authority-db MIGRATION_UNKNOWN m2-drill-2']);
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['authority-db MIGRATION_UNKNOWN m1-drill-1', 'authority-db MIGRATION_UNKNOWN m2-drill-2']);
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations: [{ ...drill(1), name: 'renamed' }, drill(2)] })).failures), ['authority-db SCHEMA_ERROR']);
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations: [drill(2)] })).failures), ['authority-db MIGRATION_INVALID']);
});

test('a database this release cannot open refuses the deploy', async t => {
  const w = world(t), { file, authority } = await database(w);
  authority.close();
  const { DatabaseSync } = await import('node:sqlite');
  let db = new DatabaseSync(file); db.exec('PRAGMA user_version=3'); db.close();
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['authority-db SCHEMA_ERROR']);
  fs.writeFileSync(file, 'not a database, but long enough to have a header to misread'.repeat(40));
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['authority-db DATABASE_UNREADABLE']);
  w.edit('authority.json', c => { c.databasePath = '/elsewhere/authority.sqlite'; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).warnings), ['authority-db DATABASE_NOT_CHECKED']);
});

test('a migration that widens an existing table needs a running release that names its insert columns', async t => {
  const w = world(t), { authority } = await database(w);
  authority.close();
  const migrations = [drill(1), { id: 2, name: 'widen-streams', rollbackLevel: 1, up: db => db.exec('ALTER TABLE streams ADD COLUMN note TEXT') }];
  // `current` is OLD, which has no authority/src/migrations.js: rollback level 0, like production release 7987e8b.
  let result = await preflight({ base: w.base, release: w.release, migrations });
  assert.deepEqual(codes(result.failures), ['authority-db MIGRATION_ROLLBACK_UNSAFE m2-widen-streams']);
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations: [drill(1)] })).failures), []);
  fs.mkdirSync(path.join(w.releases, OLD, 'authority/src'), { recursive: true });
  fs.copyFileSync(path.join(here, '../../authority/src/migrations.js'), path.join(w.releases, OLD, 'authority/src/migrations.js'));
  result = await preflight({ base: w.base, release: w.release, migrations });
  assert.deepEqual(codes(result.failures), []);
  assert.equal(result.warnings.length, 2);
  fs.writeFileSync(path.join(w.releases, OLD, 'authority/src/migrations.js'), '// level removed\n');
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release, migrations })).failures), ['authority-db MIGRATION_ROLLBACK_UNSAFE m2-widen-streams']);
});

test('memory worker timings are optional; a value out of range is refused, as the worker would refuse to start', async t => {
  const w = world(t);
  w.edit('memory-worker.json', c => { c.tickMs = 5000; c.consolidationDeferMs = 10000; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), []);
  w.edit('memory-worker.json', c => { c.tickMs = 10; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['memory-worker.json CONFIG_INVALID']);
});

test('the QQ bridge poll interval for initiated runs is optional; a value out of range is refused, as the bridge would refuse to start', async t => {
  const w = world(t);
  w.edit('qq-bridge.json', c => { c.initiationPollMs = 3000; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), []);
  for (const bad of [10, 600001, '3000', 1500.5]) {
    w.edit('qq-bridge.json', c => { c.initiationPollMs = bad; });
    assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['qq-bridge.json CONFIG_INVALID'], String(bad));
  }
});

test('a test-only channel in authority.json refuses the deploy, as Authority would refuse to start, unless the configuration explicitly allows it', async t => {
  const w = world(t);
  w.edit('authority.json', c => { c.capabilities.push({ id: 'mock', policy: 'conversation.v1' }); c.credentials.push({ hash: 'c'.repeat(64), role: 'capability', capabilityId: 'mock' }); });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), ['authority.json TEST_CHANNEL_CONFIGURED']);
  w.edit('authority.json', c => { c.operator.allowTestChannels = true; });
  assert.deepEqual(codes((await preflight({ base: w.base, release: w.release })).failures), []);
});
