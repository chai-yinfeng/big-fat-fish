#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareConsole(base = path.join(os.homedir(), '.local/share/companion-world-v1')) {
  if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') throw Error('CONSOLE_BASE');
  const file = path.join(base, 'operator/authority.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.operator || !Array.isArray(config.operator.origins)) throw Error('CONSOLE_CONFIG');
  config.operator.origins = [...new Set([...config.operator.origins, 'http://127.0.0.1:3082', 'http://localhost:3082'])];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { prepared: true, standaloneOrigin: 'http://127.0.0.1:3082', worldNotReset: true, credentialsPreserved: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareConsole())); }
  catch { console.error('Standalone console preparation failed; existing world was not reset.'); process.exitCode = 1; }
}
