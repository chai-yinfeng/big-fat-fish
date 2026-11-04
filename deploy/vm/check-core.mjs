#!/usr/bin/env node
/** Authenticated, no-model checks for the isolated VM validation deployment. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const home = path.resolve(process.env.DSH_HOME || path.join(process.env.HOME, '.local/share/dsh-companion-base'));
const directory = path.join(home, 'run');
const accessFile = path.join(directory, 'local-access.json');
const mode = process.argv[2] || 'status';
const previousRun = mode === 'after-restart' ? JSON.parse(fs.readFileSync(path.join(directory, 'core-validation.json'), 'utf8')).runId : undefined;
function readPrivateAccess() {
  try { return JSON.parse(fs.readFileSync(accessFile, 'utf8')); }
  catch { throw new Error('Private DSH access record is invalid'); }
}
await new Promise((resolve, reject) => {
  const watcher = fs.watch(directory, check);
  const timeout = setTimeout(() => { watcher.close(); reject(new Error('Timed out waiting for a new private DSH access record')); }, 30_000);
  function check() {
    if (!fs.existsSync(accessFile)) return;
    let record;
    try { record = readPrivateAccess(); }
    catch (error) { watcher.close(); clearTimeout(timeout); reject(error); return; }
    if (record.runId === previousRun) return;
    watcher.close(); clearTimeout(timeout); resolve();
  }
  check();
});
assert.equal(fs.statSync(accessFile).mode & 0o077, 0, 'access record permissions must be private');
const access = readPrivateAccess();
assert.equal(access.purpose, 'companion-local-access');
process.on('uncaughtException', (error) => {
  const message = String(error.message || error).replaceAll(access.token, '[redacted]').replace(/([?&]token=)[^\s&"']+/g, '$1[redacted]');
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
assert.match(access.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const url = new URL('/', access.origin);
url.searchParams.set('token', access.token);
const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
assert.equal(auth.status, 303, 'browser process-token exchange must use the clean-root redirect');
assert.equal(auth.headers.get('location'), './');
const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
assert.ok(cookie, 'authenticated cookie was not issued');
const headers = { 'content-type': 'application/json', cookie, origin: access.origin };
async function rpc(method, args = {}) {
  const response = await fetch(access.origin + '/api/' + method, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, `HTTP failure for ${method}`);
  const envelope = await response.json();
  if (!envelope.result?.ok) throw new Error(`RPC ${method} rejected (${envelope.result?.error?.code || 'unknown'})`);
  return envelope.result.value;
}
async function coreState() {
  const response = await fetch(access.origin + '/companion-core/state', { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return response.json();
}
function safeState(state) {
  return { ready: state.ready, boundCount: state.boundSessions?.length, counts: state.counts, persona: state.persona && { name: state.persona.name, revision: state.persona.revision, hash: state.persona.hash, source: state.persona.source, sourceError: state.persona.sourceError }, settings: state.settings, ttsEnabled: state.tts?.enabled, extractorEnabled: state.extractor?.enabled };
}
if (mode === 'status') {
  console.log(JSON.stringify(safeState(await coreState())));
} else if (mode === 'verify' || mode === 'after-restart') {
  const presets = await rpc('agentPresets/list');
  const presetList = presets.presets;
  assert.ok(presetList?.some((preset) => preset.id === 'companion'), 'companion preset is absent');
  const inventory = await rpc('pluginInventory/list');
  const coreEntry = inventory.entries.find((entry) => entry.moduleName === '@local/companion');
  assert.equal(coreEntry?.enabled, true, 'core entry is not enabled');
  assert.equal(coreEntry.fiberPhase, 'active', 'core entry is not active');
  assert.equal(coreEntry.meta?.error, undefined, 'display metadata has a diagnostic');
  assert.ok(coreEntry.meta?.title && coreEntry.meta?.icon, 'bundle display resources were not resolved');
  const composition = inventory.agentPresets?.find((preset) => preset.id === 'companion');
  assert.ok(composition && !composition.broken, 'companion composition is broken');
  assert.equal(composition.rows.some((row) => row.moduleName === '@deepseek-ai/dsh-persona'), false, 'duplicate preset persona remains');
  assert.ok(composition.rows.filter((row) => row.enabled === true).every((row) => row.fiberPhase === 'active'), 'preset rows are not active');
  fs.writeFileSync(path.join(directory, 'inventory-inspection.json'), JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600 });
  const sessionId = 'companion-core-validation';
  const workspace = process.env.COMPANION_WORKSPACE || path.join(process.env.HOME, 'src/dsh-companion/core-0.3.0');
  const created = await rpc('session/create', { request: { cwd: workspace, sessionId, agentPreset: 'companion' } });
  assert.equal(created.sessionId, sessionId, 'blank validation session was not preserved');
  const commands = await rpc('commands/list', { agentId: sessionId });
  const commandList = commands;
  assert.ok(commandList?.some((command) => command.name === 'companion'), 'companion command is absent');
  const execute = async () => {
    const response = await rpc('commands/execute', { agentId: sessionId, line: '/companion persona reload', submittedAttachments: [] });
    return response?.result;
  };
  const before = await coreState();
  assert.equal(before.ready, true);
  assert.equal(before.settings.proactiveEnabled, false);
  assert.equal(before.tts.enabled, false);
  assert.equal(before.extractor.enabled, false);
  assert.deepEqual(before.counts, { facts: 0, factsTotal: 0, diary: 0, episodes: 0 });
  const reportFile = path.join(directory, 'core-validation.json');
  if (mode === 'verify') {
    const file = path.join(home, 'companion/persona.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = { ...original, revision: original.revision + 1, persona: { ...original.persona, name: 'VM companion（修订验证）' } };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    assert.equal((await execute())?.kind, 'success');
    assert.equal((await coreState()).persona.revision, next.revision);
    try {
      fs.writeFileSync(file, JSON.stringify({ ...next, persona: { ...next.persona, name: 'same-version drift must fail' } }) + '\n');
      assert.equal((await execute())?.kind, 'error');
      assert.equal((await coreState()).persona.name, next.persona.name);
    } finally {
      fs.writeFileSync(file, JSON.stringify({ ...original, revision: next.revision + 1 }, null, 2) + '\n', { mode: 0o600 });
      assert.equal((await execute())?.kind, 'success');
    }
    const state = safeState(await coreState());
    fs.writeFileSync(reportFile, JSON.stringify({ sessionId, runId: access.runId, beforeRevision: before.persona.revision, afterRevision: state.persona.revision, hash: state.persona.hash, noModelPromptSent: true, state }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ checks: ['preset listed', 'blank agent mounted', 'companion command registered', 'revision reload', 'same-version drift rejected', 'prior content restored as a new revision', 'external capabilities disabled'], state }));
  } else {
    const previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const state = safeState(await coreState());
    assert.equal(state.persona.revision, previous.afterRevision);
    assert.equal(state.persona.hash, previous.hash);
    assert.equal((await execute())?.kind, 'success');
    fs.writeFileSync(reportFile, JSON.stringify({ ...previous, runId: access.runId, lastRestartVerifiedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ checks: ['authenticated after restart', 'same blank session restored', 'persona revision and hash preserved', 'reload remains idempotent'], state }));
  }
} else throw new Error('Unknown verification mode');
