#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export function prepareQQ(base = path.join(os.homedir(), '.local/share/companion-world-v1')) {
  const file = path.join(base, 'operator/authority.json');
  const authority = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const dir of ['qq-worker', 'qq-data', 'ipc/qq-control']) fs.mkdirSync(path.join(base, dir), { recursive: true, mode: 0o700 });
  const tokenFile = path.join(base, 'qq-worker/capability.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const tokenHash = hash(fs.readFileSync(tokenFile, 'utf8').trim());
  if (!authority.credentials.some(c => c.capabilityId === 'qq')) authority.credentials.push({ hash: tokenHash, role: 'capability', capabilityId: 'qq' });
  else if (!authority.credentials.some(c => c.capabilityId === 'qq' && c.hash === tokenHash)) throw new Error('QQ_CREDENTIAL_CONFLICT');
  if (!authority.capabilities.some(c => c.id === 'qq')) authority.capabilities.push({ id: 'qq', policy: 'conversation.v1' });
  authority.operator.qqSocketPath = '/authority/qq-control/control.sock';
  const cfg = {
    authority: { socketPath: path.join(base, 'ipc/authority/authority.sock'), tokenFile },
    controlSocket: path.join(base, 'ipc/qq-control/control.sock'),
    operatorTokenHash: hash(fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim()),
    onebotTokenFile: path.join(base, 'qq-runtime/private/onebot.token'),
    conversation: { socketPath: path.join(base, 'ipc/conversation/execute.sock'), tokenFile: path.join(base, 'conversation-config/caller.token') },
    settingsFile: path.join(base, 'qq-data/settings.json'), stateFile: path.join(base, 'qq-data/dispatch.json'),
  };
  fs.writeFileSync(path.join(base, 'operator/qq-bridge.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(file, JSON.stringify(authority, null, 2) + '\n', { mode: 0o600 });
  return { prepared: true, existingWorldPreserved: true, qqConfigured: fs.existsSync(cfg.settingsFile) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareQQ())); } catch { console.error('QQ infrastructure preparation failed; no world reset.'); process.exitCode = 1; }
}
