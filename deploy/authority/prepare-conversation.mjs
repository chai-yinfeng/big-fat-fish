#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Adds the conversation executor's private configuration to an existing world.
// It reuses the QQ capability credential (the executor acts for that channel)
// and the gateway inference token; only the caller token is new. Never resets
// identity, memory or sessions.
export function prepareConversation(base = path.join(os.homedir(), '.local/share/companion-world-v1')) {
  if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') throw Error('CONVERSATION_BASE');
  const capabilityToken = path.join(base, 'qq-worker/capability.token'), gatewayToken = path.join(base, 'dsh-config/model-gateway.token');
  if (!fs.existsSync(capabilityToken) || !fs.existsSync(gatewayToken)) throw Error('CONVERSATION_PREREQUISITES');
  for (const dir of ['conversation-config', 'conversation-data/sessions', 'ipc/conversation']) fs.mkdirSync(path.join(base, dir), { recursive: true, mode: 0o700 });
  const callerToken = path.join(base, 'conversation-config/caller.token');
  if (!fs.existsSync(callerToken)) fs.writeFileSync(callerToken, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  const hash = createHash('sha256').update(fs.readFileSync(callerToken, 'utf8').trim()).digest('hex');
  const config = {
    socketPath: path.join(base, 'ipc/conversation/execute.sock'),
    callerTokenHash: hash,
    sessionsDir: path.join(base, 'conversation-data/sessions'),
    authority: { socketPath: path.join(base, 'ipc/authority/authority.sock'), tokenFile: capabilityToken },
    gateway: { socketPath: path.join(base, 'ipc/model/inference.sock'), tokenFile: gatewayToken },
  };
  fs.writeFileSync(path.join(base, 'operator/conversation.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { prepared: true, sessionsPreserved: true, worldNotReset: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareConversation())); } catch { console.error('Conversation preparation failed; no world reset.'); process.exitCode = 1; }
}
