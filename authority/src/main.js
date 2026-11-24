#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Authority } from './engine.js';
import { createAuthorityServer } from './server.js';
import { createOperatorServer } from './operator.js';
import { createModelControlClient } from './model-control.js';
import { createContentControlClient, createContentOperatorClient, createContentJobsClient, createContentStickersClient, createContentForgetClient } from './content-control.js';
import { fileURLToPath } from 'node:url';
import { load as loadConfig } from './config.js';

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
  // authority/src/config.js: the same checks the deploy preflight runs; an unknown key is ignored here with one line.
  const config = loadConfig(file);
  // The room page's read-only credential lives in its own private file beside this configuration (written by
  // ops/prepare-room.mjs; the launcher mounts it when it exists), never in `credentials`: a release from before the
  // room role refuses a configuration that lists one, and does not read this file, so a rollback needs no edit.
  const roomFile = path.join(path.dirname(file), 'room-credential.json');
  if (fs.existsSync(roomFile)) {
    if (!fs.lstatSync(roomFile).isFile() || fs.statSync(roomFile).size > 4096 || (fs.statSync(roomFile).mode & 0o077) !== 0) throw new Error('CONFIG');
    const room = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
    if (room?.schemaVersion !== 1 || Object.keys(room).some(key => !['schemaVersion', 'hash'].includes(key)) || typeof room.hash !== 'string') throw new Error('CONFIG');
    config.credentials.push({ hash: room.hash, role: 'room' });
  }
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
  authority = new Authority({ file: config.databasePath, initialPaused: config.initialPaused, contentService: Boolean(config.content), ...(config.persona ? { persona: config.persona } : {}) });
  if (authority.store.migrated.applied.length) process.stdout.write(`Authority schema migrated: ${authority.store.migrated.applied.map(m => `${m.id}-${m.name}`).join(', ')}; backup ${authority.store.migrated.backup ? path.basename(authority.store.migrated.backup) : 'none (new database)'}.\n`);
  for (const capability of config.capabilities) authority.registerCapability(capability);
  for (const actor of config.actors) authority.bindActor(actor);
  for (const stream of config.streams) authority.bindStream(stream);
  app = createAuthorityServer({ authority, socketPath: config.socketPath, credentials: config.credentials, ...(config.content ? { contentControl: createContentControlClient(config.content), contentJobs: createContentJobsClient(config.content), contentForget: createContentForgetClient(config.content) } : {}), onFatal: () => { process.stderr.write('Authority reviewer failed; pending work remains durable.\n'); void stop(1); } });
  operator = createOperatorServer({ authority, ...config.operator, assetsDir: fileURLToPath(new URL('../../console-web/', import.meta.url)), ...(config.content ? { contentOperator: createContentOperatorClient(config.content), contentControl: createContentControlClient(config.content), contentJobs: createContentJobsClient(config.content), contentStickers: createContentStickersClient(config.content) } : {}), modelControl: config.operator.modelSocketPath ? createModelControlClient(config.operator.modelSocketPath) : undefined, qqControl: config.operator.qqSocketPath ? createModelControlClient(config.operator.qqSocketPath, ['/qq', '/qq/identity', '/qq/people']) : undefined, onResume: () => app.wakeReviewer(), onForget: () => { void app.wakeCleanup(); } });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop(0); });
  await app.start();
  await operator.start();
  process.stdout.write('Companion authority ready; Unix transport only.\n');
} catch (error) {
  process.stderr.write(`Companion authority could not start; inspect private configuration, schema and writer ownership.${/^MIGRATION_[A-Z_]+$/.test(error?.code ?? '') ? ` (${error.code})` : ''}\n`);
  await stop(1);
}
