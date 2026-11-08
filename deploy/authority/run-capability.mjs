#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { connectWeb } from './web-rpc.mjs';

process.umask(0o077);
const NODE = `/opt/companion/runtime/node-v24.22.2-linux-${process.arch}/bin/node`;
const DSH = '/opt/companion/runtime/dsh-0.2.1-rc.3/node_modules/@deepseek-ai/dsh/lib/bin.js';
const ORIGIN = 'http://127.0.0.1:3081';
const ACCESS = '/home/companion/dsh/run/local-access.json';
const runId = randomUUID();
const children = new Set();
let stopping = false, token, modelRelay;
const modelConnections = new Set();
function redact(value) {
  const clean = String(value).replace(/\x1b\[[0-9;]*m/g, '');
  return (token ? clean.replaceAll(token, '[redacted]') : clean).replace(/([?&](?:token|secret|credential)=)[^\s&"']+/gi, '$1[redacted]');
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  modelRelay?.close();
  for (const socket of modelConnections) socket.destroy();
  try { fs.closeSync(3); } catch {}
  try { if (fs.existsSync(ACCESS) && JSON.parse(fs.readFileSync(ACCESS, 'utf8')).runId === runId) fs.unlinkSync(ACCESS); } catch {}
  const deadline = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 8000);
  deadline.unref();
  process.exitCode = code;
}
function own(child, label, consume) {
  children.add(child);
  child.once('error', () => { process.stderr.write(label + ' failed to start.\n'); stop(1); });
  child.once('exit', () => { children.delete(child); if (!stopping) { process.stderr.write(label + ' stopped; capability is not ready.\n'); stop(1); } });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', line => {
      try { if (!consume?.(line)) destination.write(redact(line) + '\n'); }
      catch { process.stderr.write('Private Web handoff failed.\n'); stop(1); }
    });
  }
  return child;
}
async function authorityReady() {
  const until = Date.now() + 30000;
  while (!stopping) {
    const connected = await new Promise(resolve => {
      const socket = net.createConnection('/run/companion/authority.sock');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    if (Date.now() >= until) throw new Error('AUTHORITY_NOT_READY');
    // Bounded startup retry inside the supervisor, not model polling or a memory scheduler.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('STOPPING');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));
try {
  if (!fs.fstatSync(3).isSocket()) throw new Error('ACTIVATION_REQUIRED');
  await authorityReady();
  // Only this fixed inference socket is reachable from the worker's private network.
  modelRelay = net.createServer(client => {
    const peer = net.createConnection('/run/companion-model/inference.sock');
    for (const socket of [client, peer]) {
      modelConnections.add(socket);
      socket.once('close', () => modelConnections.delete(socket));
      socket.once('error', () => { client.destroy(); peer.destroy(); });
    }
    client.once('close', () => peer.destroy());
    client.pipe(peer).pipe(client);
  });
  await new Promise((resolve, reject) => { modelRelay.once('error', reject); modelRelay.listen(3090, '127.0.0.1', resolve); });
  modelRelay.on('error', () => stop(1));
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => rejectReady(new Error('DSH_STARTUP_TIMEOUT')), 45000);
  const child = own(spawn(NODE, [DSH, '--profile', 'companion', '--host', '127.0.0.1', '--port', '3080', '--public-url', ORIGIN, '--trusted-host', '127.0.0.1:3081', '--no-open'], { cwd: '/home/companion/dsh', env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }), 'DSH', line => {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (!clean.startsWith('dsh web:')) return false;
    const match = clean.match(/https?:\/\/\S+/);
    if (!match) return false;
    const url = new URL(match[0]);
    if (!url.searchParams.has('token')) return false;
    if (url.origin !== ORIGIN || !url.searchParams.get('token')) throw new Error('INVALID_ADVERTISED_ORIGIN');
    token = url.searchParams.get('token'); resolveReady(); return true;
  });
  child.once('exit', () => rejectReady(new Error('DSH_STARTUP_FAILED')));
  child.once('error', () => rejectReady(new Error('DSH_STARTUP_FAILED')));
  await ready.finally(() => clearTimeout(timeout));
  if (stopping) throw new Error('STOPPING');
  // No public forwarding until required capability and only the approved roster
  // are active. A missing marker also makes DSH's required Web runtime fail boot.
  const rpc = await connectWeb({ origin: ORIGIN, token, connectPort: 3080 });
  const roster = await rpc('agentPresets/list');
  if (roster.presets.length !== 1 || roster.presets[0].id !== 'companion' || roster.presets[0].broken || !roster.presets[0].isDefault) throw new Error('UNAPPROVED_PRESET_ROSTER');
  const inventory = await rpc('pluginInventory/list');
  const entry = inventory.entries.find(value => value.moduleName === '@local/companion');
  if (!entry?.enabled || entry.fiberPhase !== 'active' || entry.meta?.error) throw new Error('CAPABILITY_INACTIVE');
  const composition = inventory.agentPresets?.find(value => value.id === 'companion');
  if (!composition || composition.broken || composition.rows.some(value => value.moduleName !== '@deepseek-ai/dsh-time-context')) throw new Error('UNAPPROVED_PRESET_TOOLS');
  fs.mkdirSync(path.dirname(ACCESS), { recursive: true, mode: 0o700 });
  if (fs.existsSync(ACCESS) && JSON.parse(fs.readFileSync(ACCESS, 'utf8')).purpose !== 'companion-local-access') throw new Error('UNRELATED_ACCESS_FILE');
  const temporary = path.join(path.dirname(ACCESS), `access-${runId}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, purpose: 'companion-local-access', runId, origin: ORIGIN, token }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, ACCESS);
  // Only this child receives activation fd3; DSH above has exactly 0/1/2.
  const env = { ...process.env, LISTEN_FDS: '1' }; delete env.LISTEN_PIDFDID;
  own(spawn('/bin/sh', ['-c', 'LISTEN_PID=$$; export LISTEN_PID; exec /usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:3080'], { env, stdio: ['ignore', 'pipe', 'pipe', 3] }), 'Inner Web proxy');
  fs.closeSync(3);
  process.stdout.write('Restricted DSH capability ready; private Web access record updated.\n');
} catch {
  process.stderr.write('Restricted capability startup failed closed; no generic assistant fallback.\n');
  stop(1);
}
