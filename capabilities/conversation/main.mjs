#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AuthorityClient } from '../../authority/src/client.js';
import { ContentClient } from '../media/client.js';
import { SessionStore } from './sessions.js';
import { createGatewayStream } from './model.js';
import { createConversationExecutor } from './agent.js';
import { createConversationServer } from './server.js';

const fail = code => Object.assign(new Error(code), { code });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const pair = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && absolute(value.socketPath) && absolute(value.tokenFile);

export function loadConfig(file) {
  if (!absolute(file)) throw fail('CONVERSATION_CONFIG');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let config;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077 || stat.uid !== process.getuid()) throw fail('CONVERSATION_CONFIG');
    config = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const keys = ['socketPath', 'callerTokenHash', 'sessionsDir', 'authority', 'gateway'];
  if (!config || typeof config !== 'object' || Object.keys(config).length !== keys.length || !keys.every(key => Object.hasOwn(config, key)) || !absolute(config.socketPath) || !absolute(config.sessionsDir) || !/^[a-f0-9]{64}$/.test(config.callerTokenHash) || !pair(config.authority) || !pair(config.gateway)) throw fail('CONVERSATION_CONFIG');
  return config;
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  if (args.length !== 2 || args[0] !== '--config') throw fail('CONVERSATION_CONFIG');
  const config = loadConfig(args[1]);
  const authority = new AuthorityClient(config.authority);
  const { model, streamFn } = createGatewayStream(config.gateway);
  const executor = createConversationExecutor({ authority, content: new ContentClient(config.authority), store: new SessionStore(config.sessionsDir), model, streamFn });
  const server = createConversationServer({ socketPath: config.socketPath, callerTokenHash: config.callerTokenHash, executor });
  await server.start();
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void server.close(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  process.stdout.write('Companion conversation executor ready; private Unix transport only.\n');
  return server;
}

// The release runs through the `current` symlink: compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Conversation executor could not start; inspect private configuration.\n'); process.exitCode = 1; });
}
