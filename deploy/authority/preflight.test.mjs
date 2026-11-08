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
