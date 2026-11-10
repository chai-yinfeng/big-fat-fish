#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Authority } from './engine.js';
import { createAuthorityServer } from './server.js';
import { createOperatorServer } from './operator.js';
import { createModelControlClient } from './model-control.js';
import { createContentControlClient, createContentOperatorClient } from './content-control.js';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
let authority, app, operator, closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  try { await operator?.close(); await app?.close(); authority?.close(); }
  catch { code = 1; }
  process.exitCode = code;
}
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !path.isAbsolute(process.argv[3])) throw new Error('CONFIG');
  const file = process.argv[3];
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 65536 || (fs.statSync(file).mode & 0o077) !== 0) throw new Error('CONFIG');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fields = ['schemaVersion', 'databasePath', 'socketPath', 'credentials', 'capabilities', 'actors', 'streams', 'persona', 'initialPaused', 'operator', 'content'];
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => !fields.includes(key)) || !path.isAbsolute(config.databasePath) || !path.isAbsolute(config.socketPath) || !['credentials', 'capabilities', 'actors', 'streams'].every(key => Array.isArray(config[key]))) throw new Error('CONFIG');
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
  authority = new Authority({ file: config.databasePath, initialPaused: config.initialPaused, ...(config.persona ? { persona: config.persona } : {}) });
  if (authority.store.migrated.applied.length) process.stdout.write(`Authority schema migrated: ${authority.store.migrated.applied.map(m => `${m.id}-${m.name}`).join(', ')}; backup ${authority.store.migrated.backup ? path.basename(authority.store.migrated.backup) : 'none (new database)'}.\n`);
  for (const capability of config.capabilities) authority.registerCapability(capability);
  for (const actor of config.actors) authority.bindActor(actor);
  for (const stream of config.streams) authority.bindStream(stream);
  app = createAuthorityServer({ authority, socketPath: config.socketPath, credentials: config.credentials, ...(config.content ? { contentControl: createContentControlClient(config.content) } : {}), onFatal: () => { process.stderr.write('Authority reviewer failed; pending work remains durable.\n'); void stop(1); } });
  operator = createOperatorServer({ authority, ...config.operator, assetsDir: fileURLToPath(new URL('../../console-web/', import.meta.url)), ...(config.content ? { contentOperator: createContentOperatorClient(config.content) } : {}), modelControl: config.operator.modelSocketPath ? createModelControlClient(config.operator.modelSocketPath) : undefined, qqControl: config.operator.qqSocketPath ? createModelControlClient(config.operator.qqSocketPath, ['/qq', '/qq/identity', '/qq/people']) : undefined, onResume: () => app.wakeReviewer() });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop(0); });
  await app.start();
  await operator.start();
  process.stdout.write('Companion authority ready; Unix transport only.\n');
} catch (error) {
  process.stderr.write(`Companion authority could not start; inspect private configuration, schema and writer ownership.${/^MIGRATION_[A-Z_]+$/.test(error?.code ?? '') ? ` (${error.code})` : ''}\n`);
  await stop(1);
}
