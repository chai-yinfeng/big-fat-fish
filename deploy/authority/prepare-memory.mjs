#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function prepareMemory(base = path.join(os.homedir(), '.local/share/companion-world-v1'), entityId = 'entity:big-fat-fish') {
  const authorityFile = path.join(base, 'operator/authority.json');
  const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
  for (const name of ['memory-config', 'memory-data']) fs.mkdirSync(path.join(base, name), { recursive: true, mode: 0o700 });
  const label = createHash('sha256').update(entityId).digest('hex').slice(0, 16);
  const tokenFile = path.join(base, 'memory-config', label + '.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  const hash = createHash('sha256').update(fs.readFileSync(tokenFile, 'utf8').trim()).digest('hex');
  const previous = authority.credentials.find(row => row.role === 'maintenance' && row.entityId === entityId);
  if (previous && previous.hash !== hash) throw new Error('MEMORY_CREDENTIAL_CONFLICT');
  if (!previous) authority.credentials.push({ hash, role: 'maintenance', entityId });
  const config = {
    entityId,
    authority: { socketPath: path.join(base, 'ipc/authority/authority.sock'), tokenFile },
    gateway: { socketPath: path.join(base, 'ipc/model/inference.sock'), tokenFile: path.join(base, 'dsh-config/model-gateway.token') },
    stateFile: path.join(base, 'memory-data', label + '.json'),
    maxCallsPerDay: 4,
    base,
    operatorTokenFile: path.join(base, 'operator/console.token'),
    purgeModule: fileURLToPath(new URL('./purge-execution.mjs', import.meta.url)),
  };
  // Confirmed for the pinned SDK rc.3 shipped defaults: file sessions and
  // in-memory session-query index. Never include workspace.json as derived data.
  const layoutFile = path.join(base, 'operator/execution-storage.json');
  const layout = { version: 1, sessionsRoot: 'dsh-home/sessions', derivedPaths: [{ kind: 'projection-cache-domain', path: 'dsh-home/storages/session_projcache' }] };
  if (fs.existsSync(layoutFile)) {
    const existing = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    if (JSON.stringify({ version: existing.version, sessionsRoot: existing.sessionsRoot, derivedPaths: existing.derivedPaths }) !== JSON.stringify(layout)) throw new Error('EXECUTION_LAYOUT_CONFLICT');
  } else fs.writeFileSync(layoutFile, JSON.stringify(layout) + '\n', { flag: 'wx', mode: 0o600 });
  const configFile = path.join(base, 'operator/memory-worker.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(authorityFile, JSON.stringify(authority, null, 2) + '\n', { mode: 0o600 });
  return { prepared: true, entityConfigured: true, credentialsPreserved: Boolean(previous), worldNotReset: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(prepareMemory()) + '\n'); }
  catch { process.stderr.write('Memory preparation failed; existing world was not reset.\n'); process.exitCode = 1; }
}
