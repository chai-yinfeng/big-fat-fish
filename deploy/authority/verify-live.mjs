#!/usr/bin/env node
// Mutating checks are for a fresh synthetic deployment, not real memories.
// Runs on the VM as companion (authority socket, /proc, systemctl --user). Against the
// production world only the read-only `status` mode is allowed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connectWeb } from './web-rpc.mjs';

const base = '/home/companion/.local/share/companion-world-v1';
const reportFile = path.join(base, 'operator/live-verification.json');
const mode = process.argv[2] || 'status';
if (mode !== 'status') { process.stderr.write('Live acceptance refused: PRODUCTION_WORLD_STATUS_ONLY\n'); process.exit(2); }
const prefix = 'validation:authority-v1:';
const fixedAt = Date.parse('2026-10-30T04:00:00Z');
const socketPath = path.join(base, 'ipc/authority/authority.sock');
const files = { admin: 'operator/admin.token', native: 'dsh-config/capability.token', reading: 'operator/reading.token', other: 'operator/source-check.token' };
async function call(who, method, route, body) {
  const token = fs.readFileSync(path.join(base, files[who]), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, method, path: route, agent: false, headers: { authorization: `Bearer ${token}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { reject(new Error('VERIFY_OUTPUT_LIMIT')); res.destroy(); return; } chunks.push(chunk); });
      res.on('error', () => reject(new Error('VERIFY_TRANSPORT')));
      res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(new Error('VERIFY_RESPONSE')); } });
    });
    req.setTimeout(10000, () => req.destroy()); req.on('error', () => reject(new Error('VERIFY_TRANSPORT'))); req.end(bytes);
  });
}
async function ok(who, method, route, body) {
  const result = await call(who, method, route, body);
  assert.equal(result.status, 200, `Unexpected protocol status on ${route}`); assert.equal(result.ok, true); return result.value;
}
async function receipt(who, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await ok(who, 'GET', '/v1/receipts/' + encodeURIComponent(id));
    if (result.status !== 'pending') return result;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('REVIEW_TIMEOUT');
}
async function readAccess(previousRun) {
  const file = path.join(base, 'dsh-home/run/local-access.json');
  return new Promise((resolve, reject) => {
    const directory = path.dirname(file);
    const watcher = fs.watch(directory, check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error('WEB_ACCESS_NOT_READY')); }, 60000);
    function check() {
      try {
        if (!fs.existsSync(file)) return;
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (previousRun && previousRun === record.runId) return;
        assert.equal(record.purpose, 'companion-local-access');
        assert.equal(fs.statSync(file).mode & 0o077, 0);
        clearTimeout(timer); watcher.close(); resolve(record);
      } catch { clearTimeout(timer); watcher.close(); reject(new Error('PRIVATE_ACCESS_INVALID')); }
    }
    check();
  });
}
async function runtime(access, create = false) {
  const rpc = await connectWeb(access);
  const roster = await rpc('agentPresets/list');
  assert.deepEqual(roster.presets.map(row => [row.id, row.isDefault, !!row.broken]), [['companion', true, false]]);
  const inventory = await rpc('pluginInventory/list');
  const entry = inventory.entries.find(row => row.moduleName === '@local/companion');
  assert.equal(entry.fiberPhase, 'active'); assert.ok(entry.meta.title && entry.meta.icon); assert.equal(entry.meta.error, undefined);
  assert.equal(inventory.entries.filter(row => row.enabled && row.fiberPhase === 'failed').length, 0);
  const results = [];
  for (const id of ['authority-native-a', 'authority-native-b', 'authority-shared']) {
    if (create) assert.equal((await rpc('session/create', { request: { cwd: '/home/companion/dsh', sessionId: id, agentPreset: 'companion' } })).sessionId, id);
    const executed = await rpc('commands/execute', { agentId: id, line: '/companion status', submittedAttachments: [] });
    assert.equal(executed.result.kind, 'success');
    const status = JSON.parse(executed.result.text);
    assert.deepEqual(status.tools, ['companion_scope']); assert.equal(status.directSystemAccess, false);
    results.push({ id, ...status });
  }
  return results;
}
function physical() {
  const hostNet = fs.readlinkSync('/proc/self/ns/net');
  const results = [];
  for (const unit of ['companion-authority.service', 'companion-dsh-internal.service']) {
    const group = execFileSync('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' }).trim();
    assert.match(group, /^\/user.slice\//);
    const pids = fs.readFileSync('/sys/fs/cgroup' + group + '/cgroup.procs', 'utf8').trim().split(/\s+/).filter(Boolean);
    // Node 24 reports comm=MainThread on this kernel; verify the pinned executable instead.
    const nodes = pids.filter(pid => { try { return fs.readlinkSync(`/proc/${pid}/exe`) === '/opt/companion/runtime/node-v24.22.2-linux-arm64/bin/node'; } catch { return false; } });
    assert.ok(nodes.length > 0);
    for (const pid of nodes) {
      const root = `/proc/${pid}/root`;
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapEff:\s+0+$/m);
      assert.notEqual(fs.readlinkSync(`/proc/${pid}/ns/net`), hostNet);
      assert.equal(fs.existsSync(root + base + '/operator/admin.token'), false);
      assert.equal(fs.existsSync(root + `/proc/${process.pid}/root`), false);
      assert.equal(fs.existsSync(root + '/run/dbus/system_bus_socket'), false);
      const authorityRole = unit === 'companion-authority.service';
      if (authorityRole) assert.ok(fs.existsSync(root + '/authority/state/authority.sqlite'));
      else {
        assert.equal(fs.existsSync(root + '/authority/state/authority.sqlite'), false);
        assert.ok(fs.lstatSync(root + '/run/companion/authority.sock').isSocket());
        assert.throws(() => fs.writeFileSync(root + '/home/companion/config/forbidden-write', 'not allowed'), error => error.code === 'EROFS');
      }
      results.push({ unit, privateNetwork: true, noNewPrivileges: true, effectiveCapabilities: 0, hostPidAndAdminAbsent: true, authorityDataVisible: authorityRole });
    }
  }
  return results;
}
try {
  if (mode === 'status') { console.log(JSON.stringify(await ok('admin', 'GET', '/v1/health'))); }
  else if (mode === 'verify') {
    if (fs.existsSync(reportFile)) throw new Error('USE_AFTER_RESTART');
    const before = await ok('admin', 'GET', '/v1/admin/state');
    assert.ok(before.observations.every(row => row.eventId.startsWith(prefix)), 'Live check requires synthetic-only state');
    assert.equal((await call('native', 'GET', '/v1/admin/state')).status, 403);
    assert.equal((await call('native', 'POST', '/v1/admin/actors', {})).status, 403);
    assert.equal((await call('native', 'POST', '/v1/context', { streamId: 'not-bound' })).status, 403);
    assert.equal((await call('native', 'POST', '/v1/observations', { capabilityId: 'source-check' })).status, 400);
    const observation = await ok('native', 'POST', '/v1/observations', { eventId: prefix + 'human', streamId: 'authority-native-a', actorId: 'native-owner', role: 'user', text: '这是集成验收样本，不是我的真实偏好：验证代号 bluewhale。', at: fixedAt });
    const proposal = { proposalId: prefix + 'reported-fact', observationId: observation.observationId, type: 'fact.report', payload: { key: '测试样本代号', value: 'bluewhale', quote: '验证代号 bluewhale' } };
    const duplicates = await Promise.all(Array.from({ length: 16 }, () => ok('native', 'POST', '/v1/proposals', proposal)));
    assert.equal(new Set(duplicates.map(row => row.proposalId)).size, 1);
    assert.equal((await receipt('native', proposal.proposalId)).status, 'accepted');
    assert.equal((await call('native', 'POST', '/v1/proposals', { ...proposal, payload: { ...proposal.payload, value: 'different' } })).status, 409);
    const rejectedIds = Array.from({ length: 32 }, (_, i) => prefix + 'forbidden-persona-' + i);
    await Promise.all(rejectedIds.map(proposalId => ok('native', 'POST', '/v1/proposals', { proposalId, observationId: observation.observationId, type: 'persona.change', payload: {} })));
    for (const id of rejectedIds) assert.equal((await receipt('native', id)).status, 'rejected');
    await ok('admin', 'POST', '/v1/admin/actors', { capabilityId: 'source-check', externalActorId: 'qq:123:user:456', personId: 'person:owner' });
    await ok('admin', 'POST', '/v1/admin/streams', { capabilityId: 'source-check', streamId: 'qq:123:private:456', personId: 'person:owner', audience: 'private' });
    for (const [who, streamId] of [['native', 'authority-native-b'], ['other', 'qq:123:private:456']]) assert.match((await ok(who, 'POST', '/v1/context', { streamId, query: 'bluewhale' })).text, /bluewhale/);
    for (const [who, streamId] of [['native', 'authority-shared'], ['other', 'other-private'], ['reading', 'reading-private']]) assert.doesNotMatch((await ok(who, 'POST', '/v1/context', { streamId, query: 'bluewhale' })).text, /bluewhale/);
    assert.equal((await call('other', 'GET', '/v1/receipts/' + encodeURIComponent(proposal.proposalId))).status, 404);
    const source = await ok('reading', 'POST', '/v1/observations', { eventId: prefix + 'reading', streamId: 'reading-private', actorId: 'synthetic-uploader', role: 'external', text: '这是一条本地合成验收素材：史料需要保留来源。', at: fixedAt });
    await ok('reading', 'POST', '/v1/proposals', { proposalId: prefix + 'learning', observationId: source.observationId, type: 'learning.note', payload: { text: '验收样本：史料应保留来源与不确定性。', quote: '史料需要保留来源' } });
    assert.equal((await receipt('reading', prefix + 'learning')).status, 'accepted');
    await ok('reading', 'POST', '/v1/proposals', { proposalId: prefix + 'learning-appraisal', observationId: source.observationId, type: 'appraisal.record', payload: { kind: 'support', quote: '史料需要保留来源' } });
    assert.equal((await receipt('reading', prefix + 'learning-appraisal')).status, 'rejected');
    const renamed = await ok('admin', 'POST', '/v1/admin/persona', { expectedRevision: before.personaRevision, patch: { name: before.persona.name + ' · 修订验收' }, reason: 'Synthetic authority revision acceptance' });
    assert.equal((await call('admin', 'POST', '/v1/admin/persona', { expectedRevision: before.personaRevision, patch: { name: 'stale revision' }, reason: 'Must conflict' })).status, 409);
    await ok('admin', 'POST', '/v1/admin/persona', { expectedRevision: renamed.personaRevision, patch: { name: before.persona.name }, reason: 'Restore prior content as a new revision' });
    const state = await ok('admin', 'GET', '/v1/admin/state');
    assert.deepEqual(state.persona, before.persona); assert.equal(state.personaRevision, before.personaRevision + 2);
    assert.equal(state.facts.length, 1); assert.equal(state.notes.length, 1); assert.deepEqual(state.relationships, {});
    const access = await readAccess();
    const sessions = await runtime(access, true);
    const confinement = physical();
    const report = { schemaVersion: 1, verifiedAt: new Date().toISOString(), runId: access.runId, personaRevision: state.personaRevision, revision: state.revision, counts: { facts: state.facts.length, notes: state.notes.length, relationships: Object.keys(state.relationships).length }, concurrency: { duplicateDeliveries: 16, distinctForbiddenProposals: 32 }, sessions, confinement, realAccountsConfigured: false, realMemoryMigrated: false, lingerChanged: false };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(report));
  } else if (mode === 'after-restart') {
    const previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const access = await readAccess(previous.runId);
    const state = await ok('admin', 'GET', '/v1/admin/state');
    assert.equal(state.personaRevision, previous.personaRevision); assert.equal(state.revision, previous.revision);
    assert.equal(state.facts.length, previous.counts.facts); assert.equal(state.notes.length, previous.counts.notes);
    assert.equal((await ok('admin', 'GET', '/v1/health')).pending, 0);
    const sessions = await runtime(access);
    const confinement = physical();
    fs.writeFileSync(reportFile, JSON.stringify({ ...previous, runId: access.runId, sessions, confinement, lastRestartVerifiedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ restartVerified: true, personaRevision: state.personaRevision, revision: state.revision, counts: previous.counts, confinement }));
  } else throw new Error('UNKNOWN_VERIFY_MODE');
} catch (error) {
  const location = String(error.stack || '').match(/verify-live\.mjs:\d+:\d+/)?.[0] || 'unknown-check';
  process.stderr.write('Live acceptance failed: ' + (error.code || 'CHECK_FAILED') + ' at ' + location + '\n');
  process.exitCode = 1;
}
