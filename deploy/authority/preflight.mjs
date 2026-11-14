#!/usr/bin/env node
// Read-only deploy preflight. companion-deploy runs it from the NEW release (ops/preflight.mjs),
// as the service user, against the existing data root, before it stops any unit or switches
// `current`. It validates every operator/service config the new release will read and the
// absolute paths they reference, and reads the Authority database's schema state: the migrations
// the new release would apply on its first start, and whether it could back the database up first.
// Output is stable codes, file labels and key names only:
// never values, paths or tokens. Exit 1 refuses the deploy.
//   node ops/preflight.mjs [--base <data root>] [--release <release dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
// Release: ops/ sits next to capabilities/; checkout: deploy/authority/.
const tree = fs.existsSync(path.join(here, '../capabilities')) ? path.resolve(here, '..') : path.resolve(here, '../..');
const RELEASE_NAME = /^authority-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-[0-9a-f]{12}$/;

const fail = code => Object.assign(new Error(code), { code });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const port = value => value === undefined || (Number.isInteger(value) && value > 0 && value < 65536);

function readPrivate(file, { size, owner }) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (size && stat.size > size) || (stat.mode & 0o077) || (owner && stat.uid !== process.getuid())) throw fail('CONFIG_PERMISSIONS');
  return readJson(file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('CONFIG_UNREADABLE'); }
}
async function load(relative) { return import(pathToFileURL(path.join(tree, relative)).href); }

// Each check mirrors what that service does at startup (see the named entry point).
const CHECKS = [
  // authority/src/main.js. Its paths are sandbox paths (/authority/...), not host paths.
  { label: 'authority.json', required: true, hostPaths: false, check: file => {
    const c = readPrivate(file, { size: 65536 });
    const fields = ['schemaVersion', 'databasePath', 'socketPath', 'credentials', 'capabilities', 'actors', 'streams', 'persona', 'initialPaused', 'operator', 'content'];
    if (!plain(c) || c.schemaVersion !== 1 || Object.keys(c).some(key => !fields.includes(key)) || !absolute(c.databasePath) || !absolute(c.socketPath) || !['credentials', 'capabilities', 'actors', 'streams'].every(key => Array.isArray(c[key]))) throw fail('CONFIG_INVALID');
    if (!plain(c.operator) || !absolute(c.operator.socketPath) || !/^[a-f0-9]{64}$/.test(c.operator.tokenHash) || !Array.isArray(c.operator.origins)) throw fail('CONFIG_INVALID');
    return c;
  } },
  // model-gateway/main.mjs
  { label: 'model-gateway.json', required: true, check: file => {
    const c = readPrivate(file, { size: 32768, owner: true });
    const keys = ['settingsFile', 'inferenceSocket', 'controlSocket', 'inferenceTokenHash', 'operatorTokenHash', 'authority', 'usageFile', 'budgets'];
    if (!plain(c) || Object.keys(c).some(key => !keys.includes(key)) || !plain(c.authority) || Object.keys(c.authority).some(key => !['socketPath', 'tokenFile'].includes(key))) throw fail('CONFIG_INVALID');
    return c;
  } },
  // capabilities/conversation/main.mjs loadConfig (bundled into conversation.mjs in a release).
  { label: 'conversation.json', required: true, check: async file => {
    const module = await load(fs.existsSync(path.join(tree, 'capabilities/conversation/conversation.mjs')) ? 'capabilities/conversation/conversation.mjs' : 'capabilities/conversation/main.mjs');
    return module.loadConfig(file);
  } },
  // capabilities/qq/main.mjs
  { label: 'qq-bridge.json', required: true, check: file => {
    const c = readPrivate(file, { owner: true });
    if (!plain(c) || !plain(c.authority) || !plain(c.conversation) || !absolute(c.controlSocket) || !absolute(c.onebotTokenFile) || !/^[a-f0-9]{64}$/.test(c.operatorTokenHash) || !port(c.onebotPort)) throw fail('CONFIG_INVALID');
    // Optional timing (staging shortens it); the bridge refuses to start on a value out of range.
    if (c.initiationPollMs !== undefined && !(Number.isInteger(c.initiationPollMs) && c.initiationPollMs >= 1000 && c.initiationPollMs <= 600000)) throw fail('CONFIG_INVALID');
    return c;
  } },
  // capabilities/memory/main.mjs; a legacy purgeModule is ignored by the worker.
  { label: 'memory-worker.json', required: true, ignored: ['purgeModule'], check: file => {
    const c = readPrivate(file, { owner: true });
    if (!plain(c) || !plain(c.authority) || !plain(c.gateway) || !absolute(c.base) || !absolute(c.operatorTokenFile) || !port(c.operatorPort)) throw fail('CONFIG_INVALID');
    // Optional timings (staging shortens them); the worker refuses to start on a value out of range.
    const within = (value, min, max) => value === undefined || (Number.isInteger(value) && value >= min && value <= max);
    if (!within(c.tickMs, 1000, 600000) || !within(c.consolidationDeferMs, 1000, 86400000)) throw fail('CONFIG_INVALID');
    return c;
  } },
  // capabilities/media/main.mjs
  { label: 'content.json', required: true, check: file => {
    const c = readPrivate(file, { size: 16384 });
    if (!plain(c) || Object.keys(c).some(k => !['store', 'workRoot', 'speechConfigFile', 'authority', 'gateway', 'sharpModule', 'control', 'allowRawSmallPng'].includes(k)) || !absolute(c.sharpModule) || c.allowRawSmallPng !== undefined && typeof c.allowRawSmallPng !== 'boolean') throw fail('CONFIG_INVALID');
    return c;
  } },
  // capabilities/speech/config.js loadSpeechConfig; absent until prepare-speech, which the runtime tolerates.
  { label: 'speech.json', required: false, check: async file => (await load('capabilities/speech/config.js')).loadSpeechConfig(file) },
  { label: 'speech-models.json', required: false, check: async file => {
    const { SCHEMA_VERSION } = await load('capabilities/speech/config.js');
    const c = readJson(file);
    if (c?.schemaVersion !== SCHEMA_VERSION) throw fail('SPEECH_CONFIG_SCHEMA');
    return c;
  } },
  // deploy/authority/purge-execution.mjs and prepare-content expect execution layout v2.
  { label: 'execution-storage.json', required: true, hostPaths: false, check: file => {
    const c = readJson(file);
    if (c?.version !== 2 || c.sessionsRoot !== 'conversation-data/sessions') throw fail('EXECUTION_LAYOUT');
    return c;
  } },
];

const mustExist = key => key === 'nodeExecutable' || /(^t|T)okenFile$/.test(key);

/** Every absolute string in a host config: not pinned to a release directory, and present when required. */
export function checkPaths(label, config, { release, ignored = [] }, report) {
  const releases = release && path.dirname(release), currentPrefix = releases && path.join(releases, 'current') + path.sep;
  let realReleases = null;
  try { realReleases = releases && fs.realpathSync(releases); } catch { /* no releases directory */ }
  const inReleases = (value, root) => Boolean(root && value) && (value === root || value.startsWith(root + path.sep));
  (function walk(value, keys) {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, [...keys, String(index)])); return; }
    if (plain(value)) { for (const [key, item] of Object.entries(value)) walk(item, [...keys, key]); return; }
    if (!absolute(value)) return;
    const field = keys.join('.'), key = keys.filter(k => !/^\d+$/.test(k)).at(-1) || '';
    // Real path of the deepest existing ancestor, so a symlink into a release is seen even when the leaf is gone.
    let real = null, probe = value, rest = '';
    for (;;) {
      try { real = path.join(fs.realpathSync(probe), rest); break; } catch { /* go up */ }
      if (probe === path.dirname(probe)) break;
      rest = path.join(path.basename(probe), rest); probe = path.dirname(probe);
    }
    if (releases && value.startsWith(currentPrefix)) {
      // `current` will name the new release after the switch: the path must exist there.
      if (!fs.existsSync(path.join(release, value.slice(currentPrefix.length)))) report.fail(label, 'RELEASE_PATH_MISSING', field);
      return;
    }
    if (releases && (inReleases(value, releases) || inReleases(real, realReleases))) {
      // A path into one versioned release breaks once retention prunes that release.
      if (keys.length === 1 && ignored.includes(key)) report.warn(label, 'IGNORED_LEGACY_FIELD', field);
      else report.fail(label, 'RELEASE_PINNED_PATH', field);
      return;
    }
    if (mustExist(key) && !fs.existsSync(value)) report.fail(label, 'MISSING_PATH', field);
  })(config, []);
}

// isolation/launch.py binds <base>/authority-data at this sandbox path.
const SANDBOX_STATE = '/authority/state/';
const BACKUP_MARGIN_BYTES = 16 * 1024 * 1024;
const freeBytesOf = directory => { const stat = fs.statfsSync(directory); return stat.bavail * stat.bsize; };

/** ROLLBACK_LEVEL of an installed release, read as text (its code is not run); 0 before migrations.js existed. */
function rollbackLevel(release) {
  let text = '';
  try { text = fs.readFileSync(path.join(release, 'authority/src/migrations.js'), 'utf8'); } catch { return 0; }
  const found = /^export const ROLLBACK_LEVEL = (\d+);$/m.exec(text);
  if (!found) throw fail('MIGRATION_ROLLBACK_UNSAFE');
  return Number(found[1]);
}

/** Read-only: what the new release's Authority would do to the existing database when it opens it. */
async function checkDatabase(base, release, config, { migrations, freeBytes = freeBytesOf }, report) {
  const label = 'authority-db', root = path.join(base, 'authority-data');
  const file = config.databasePath.startsWith(SANDBOX_STATE) ? path.join(root, config.databasePath.slice(SANDBOX_STATE.length)) : null;
  if (!file || path.dirname(file) !== root) { report.warn(label, 'DATABASE_NOT_CHECKED'); return false; }
  if (!fs.existsSync(file)) return false;  // initialized but never started
  const { inspect } = await load('authority/src/store.js'), registry = await load('authority/src/migrations.js');
  // The running Authority keeps the writer lock for as long as it lives; immutable=1 reads the file
  // without taking a lock and cannot write. A read that races a commit is retried.
  const url = pathToFileURL(file); url.searchParams.set('immutable', '1');
  let plan = null, code = 'DATABASE_UNREADABLE';
  for (let attempt = 0; attempt < 3 && !plan; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(url, { readOnly: true });
      if (!inspect(db)) return false;  // empty file: the new release creates the schema
      plan = registry.plan(db, migrations ?? registry.MIGRATIONS);
    } catch (error) {
      if (typeof error?.code === 'string' && /^(SCHEMA_ERROR|MIGRATION_INVALID)$/.test(error.code)) { code = error.code; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally { try { db?.close(); } catch { /* nothing was written */ } }
  }
  if (!plan) { report.fail(label, code); return true; }
  // Migrations this release does not know: the database was migrated by a newer release. `rollback` is the way back to an older one.
  for (const row of plan.unknown.slice(0, 5)) report.fail(label, 'MIGRATION_UNKNOWN', `m${row.id}-${row.name}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64));
  if (!plan.pending.length) return true;
  for (const migration of plan.pending.slice(0, 10)) report.warn(label, 'MIGRATION_PENDING', `m${migration.id}-${migration.name}`);
  const backups = registry.backupDirectory(file), parent = fs.existsSync(backups) ? backups : root;
  try {
    if (!fs.statSync(parent).isDirectory()) throw fail('MIGRATION_BACKUP_UNWRITABLE');
    fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
    // The backup is at most as large as the database, and the migration's rollback journal needs room as well.
    if (freeBytes(parent) < 2 * fs.statSync(file).size + BACKUP_MARGIN_BYTES) report.fail(label, 'MIGRATION_DISK_SPACE');
  } catch { report.fail(label, 'MIGRATION_BACKUP_UNWRITABLE'); }
  // A column added to an existing table is only safe to roll back from when the release now running names its INSERT columns.
  const widening = plan.pending.find(migration => (migration.rollbackLevel ?? 0) > 0);
  if (widening && !release) report.warn(label, 'MIGRATION_ROLLBACK_NOT_CHECKED');
  else if (widening) {
    let level = -1;
    try { level = rollbackLevel(path.join(path.dirname(release), 'current')); } catch { /* unreadable: refuse */ }
    if (plan.pending.some(migration => (migration.rollbackLevel ?? 0) > level)) report.fail(label, 'MIGRATION_ROLLBACK_UNSAFE', `m${widening.id}-${widening.name}`);
  }
  return true;
}

/** `migrations` and `freeBytes` are for tests; the release's own list and statfs are used otherwise. */
export async function preflight({ base = path.join(os.homedir(), '.local/share/companion-world-v1'), release = RELEASE_NAME.test(path.basename(tree)) ? tree : null, migrations, freeBytes } = {}) {
  const result = { failures: [], warnings: [], checked: [] };
  const report = {
    fail: (label, code, field) => result.failures.push({ label, code, ...(field ? { field } : {}) }),
    warn: (label, code, field) => result.warnings.push({ label, code, ...(field ? { field } : {}) }),
  };
  if (!fs.existsSync(base)) { report.warn('world', 'NO_WORLD'); return result; }
  if (release) release = path.resolve(release);
  let authority = null;
  for (const spec of CHECKS) {
    const file = path.join(base, 'operator', spec.label);
    if (!fs.existsSync(file)) { if (spec.required) report.fail(spec.label, 'MISSING_CONFIG'); continue; }
    let config;
    try { config = await spec.check(file); } catch (error) {
      report.fail(spec.label, typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CONFIG_INVALID');
      continue;
    }
    if (spec.hostPaths !== false) checkPaths(spec.label, config, { release, ignored: spec.ignored }, report);
    result.checked.push(spec.label);
    if (spec.label === 'authority.json') authority = config;
  }
  if (authority && await checkDatabase(base, release, authority, { migrations, freeBytes }, report)) result.checked.push('authority-db');
  return result;
}

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  if (!absolute(argv[at + 1])) throw fail('PREFLIGHT_ARGUMENTS');
  return argv[at + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2), base = option(argv, '--base'), release = option(argv, '--release');
    const result = await preflight({ ...(base ? { base } : {}), ...(release ? { release } : {}) });
    const line = (kind, row) => `PREFLIGHT ${kind} ${row.label} ${row.code}${row.field ? ' ' + row.field : ''}`;
    for (const row of result.failures.slice(0, 40)) process.stdout.write(line('FAIL', row) + '\n');
    for (const row of result.warnings.slice(0, 20)) process.stdout.write(line('WARN', row) + '\n');
    process.stdout.write(`PREFLIGHT ${result.failures.length ? 'REFUSED' : 'OK'} checked=${result.checked.length} failures=${result.failures.length} warnings=${result.warnings.length}\n`);
    if (result.failures.length) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`PREFLIGHT ERROR ${error?.code === 'PREFLIGHT_ARGUMENTS' ? 'PREFLIGHT_ARGUMENTS' : 'PREFLIGHT_CRASHED'}\n`);
    process.exitCode = 1;
  }
}
