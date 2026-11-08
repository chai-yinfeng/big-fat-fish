#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Adds provider infrastructure to an existing world; never resets identity or memory.
export function prepareModel(base = path.join(os.homedir(), '.local/share/companion-world-v1')) {
  const authorityPath = path.join(base, 'operator/authority.json');
  const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  const operatorToken = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
  for (const dir of ['model-data', 'ipc/model', 'ipc/model-control']) fs.mkdirSync(path.join(base, dir), { recursive: true, mode: 0o700 });
  const tokenFile = path.join(base, 'service-config/inference.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  const inferenceToken = fs.readFileSync(tokenFile, 'utf8').trim();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const config = {
    settingsFile: path.join(base, 'model-data/settings.json'),
    inferenceSocket: path.join(base, 'ipc/model/inference.sock'),
    controlSocket: path.join(base, 'ipc/model-control/control.sock'),
    inferenceTokenHash: hash(inferenceToken), operatorTokenHash: hash(operatorToken),
    authority: { socketPath: path.join(base, 'ipc/authority/authority.sock'), tokenFile: path.join(base, 'service-config/health.token') },
  };
  fs.writeFileSync(path.join(base, 'operator/model-gateway.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  authority.operator.modelSocketPath = '/authority/model-control/control.sock';
  fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2) + '\n', { mode: 0o600 });
  return { prepared: true, credentialsConfigured: fs.existsSync(config.settingsFile) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(prepareModel()) + '\n'); }
  catch { process.stderr.write('Model preparation failed; existing world was not reset.\n'); process.exitCode = 1; }
}
