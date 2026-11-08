#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoryCleanup } from './cleanup.js';
import { AuthorityClient } from '../../authority/src/client.js';
import { MemoryMaintenance } from './maintenance.js';
import { completeDiary } from './model-client.js';
import { purgeModuleURL } from './purge-module.js';

process.umask(0o077);
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('MEMORY_CONFIG');
  const file = path.resolve(process.argv[3]), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('MEMORY_CONFIG');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const authority = new AuthorityClient(cfg.authority);
  const worker = new MemoryMaintenance({ authority, complete: completeDiary(cfg.gateway), stateFile: cfg.stateFile, maxCallsPerDay: cfg.maxCallsPerDay ?? 4 });
  // A legacy cfg.purgeModule (a pinned release path) is ignored.
  const { purgeExecution } = await import(purgeModuleURL());
  const operator = async (route, payload) => {
    if (!['/world', '/memory/cleanup/pending', '/memory/cleanup/complete'].includes(route)) throw new Error('MEMORY_CONTROL_ROUTE');
    const token = fs.readFileSync(cfg.operatorTokenFile, 'utf8').trim();
    const r = await fetch('http://127.0.0.1:3082' + route, { method: payload === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(10000) });
    const value = await r.json(); if (!r.ok || !value.ok) throw new Error('MEMORY_CONTROL_UNAVAILABLE'); return value.value;
  };
  const service = (action, units) => { const r = spawnSync('systemctl', ['--user', action, ...units], { stdio: ['ignore', 'pipe', 'pipe'] }); if (r.status !== 0) throw new Error('MEMORY_EXECUTION_CONTROL'); };
  const cleanup = new MemoryCleanup({ operator, purge: plan => purgeExecution({ base: cfg.base, plan }),
    stopExecution: () => service('stop', ['companion-qq.service', 'companion-conversation.service', 'companion-content.service']),
    startExecution: () => service('start', ['companion-content.service', 'companion-conversation.service', 'companion-qq.service']),
  });
  let ticking = false;
  const tick = async () => { if (ticking) return; ticking = true; try { await cleanup.runOnce(); await worker.runOnce(); } finally { ticking = false; } };
  await tick();
  const timer = setInterval(() => { void tick(); }, 60000);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (stopping) return; stopping = true; clearInterval(timer); });
  process.stdout.write('Incremental memory maintenance ready; pause and source/budget gates remain active.\n');
}
// Log only a stable code: never the message, a path, a token or a payload.
function failureCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && /^MEMORY_[A-Z_]{1,56}$/.test(error.message)) return error.message;
  return 'UNKNOWN';
}
main().catch(error => { process.stderr.write(`Memory maintenance failed (${failureCode(error)}); inspect private configuration.\n`); process.exitCode = 1; });
