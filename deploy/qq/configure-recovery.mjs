#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function withQuickLoginAccount(environment, account) {
  if (typeof environment !== 'string' || typeof account !== 'string' || !/^[1-9]\d{0,19}$/.test(account)) throw new Error('INVALID_QUICK_LOGIN_ACCOUNT');
  return environment.split('\n').filter(line => line && !line.startsWith('ACCOUNT=')).join('\n') + '\nACCOUNT=' + account + '\n';
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('RECOVERY_COMMAND_FAILED');
}
export async function configureRecovery() {
  if (process.platform !== 'linux' || !process.getuid()) throw new Error('VM_USER_REQUIRED');
  const base = path.join(os.homedir(), '.local/share/companion-world-v1');
  const token = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
  const headers = { authorization: 'Bearer ' + token };
  const response = await fetch('http://127.0.0.1:3082/world', { headers });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok || !envelope.value.world.paused) throw new Error('PAUSE_BEFORE_RECOVERY');
  const world = envelope.value;
  const settings = JSON.parse(fs.readFileSync(path.join(base, 'qq-data/settings.json'), 'utf8'));
  const file = path.join(base, 'qq-runtime/private/napcat.env');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('PRIVATE_ENV_REQUIRED');
  const current = fs.readFileSync(file, 'utf8'), next = withQuickLoginAccount(current, settings.expectedSelfId);
  fs.writeFileSync(path.join(base, 'operator/recovery-before.json'), JSON.stringify({
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    world: world.world, personaRevision: world.persona.revision, counts: world.counts,
    bindings: world.bindings.map(row => ({ sourceId: row.sourceId, personId: row.personId, audience: row.audience })),
    dispatchKeys: fs.existsSync(path.join(base, 'qq-data/dispatch.json')) ? Object.keys(JSON.parse(fs.readFileSync(path.join(base, 'qq-data/dispatch.json'), 'utf8')).records) : [],
  }) + '\n', { mode: 0o600 });
  // Official WebUI setting also covers NapCat's internal worker restarts, which
  // deliberately do not pass the Docker ACCOUNT/-q argument on every restart.
  const webui = JSON.parse(fs.readFileSync(path.join(base, 'qq-runtime/data/config/webui.json'), 'utf8'));
  const post = async (route, body, credential) => {
    const r = await fetch('http://127.0.0.1:6099/api' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await r.json(); if (!r.ok || result.code !== 0) throw new Error('NAPCAT_RECOVERY_CONFIGURATION_FAILED'); return result.data;
  };
  const auth = await post('/auth/login', { hash: createHash('sha256').update(webui.token + '.napcat').digest('hex') });
  if (!auth?.Credential) throw new Error('NAPCAT_MANUAL_AUTH_REQUIRED');
  await post('/QQLogin/SetQuickLoginQQ', { uin: settings.expectedSelfId }, auth.Credential);
  run('loginctl', ['enable-linger', '--no-ask-password', os.userInfo().username]);
  run('systemctl', ['--user', 'enable', 'companion-authority.service', 'companion-model.service', 'companion-conversation.service', 'companion-world-public.socket', 'companion-qq.service']);
  if (next !== current) {
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, next, { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  // Existing private tokens and login volumes are preserved. The image entrypoint
  // uses ACCOUNT only to select its cached login; no password or QR is synthesized.
  run('docker', ['compose', '-f', path.join(base, 'qq-runtime/compose.yaml'), 'up', '-d', '--no-build']);
  return { quickLoginConfigured: true, environmentUpdated: next !== current, userServicesEnabled: true, lingerRequested: true, worldStillPaused: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await configureRecovery()) + '\n'); }
  catch { process.stderr.write('Recovery setup failed; check maintenance pause, user service permissions and Docker. Credentials were not printed.\n'); process.exitCode = 1; }
}
