#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const released = path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'ops';
const from = file => import((released ? '../' : '../../') + file);
// Each service that keeps files forgets its own: forget(plan, { base, storage, inside, dryRun }). This script knows
// none of their layouts; it checks the plan and the root, keeps the writers stopped, and runs them in this order.
const owners = [
  ['companion-conversation', (await from('capabilities/conversation/sessions.js')).forget],
  ['companion-qq', (await from('capabilities/qq/dispatch-forget.js')).forget],
  ['companion-content', (await from('capabilities/media/forget.js')).forget],
];

const fail = code => Object.assign(new Error(code), { code });
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('EXECUTION_LOCAL_FORMAT_INVALID'); } };
const units = ['companion-content.service', 'companion-qq.service', 'companion-conversation.service'];
function stopped() {
  const r = spawnSync('systemctl', ['--user', 'show', ...units, '-p', 'ActiveState', '--value'], { encoding: 'utf8' });
  if (r.status !== 0 || r.stdout.trim().split(/\s+/).length !== units.length || r.stdout.trim().split(/\s+/).some(s => s !== 'inactive')) throw fail('EXECUTION_WRITERS_NOT_STOPPED');
}
function inside(root, candidate) {
  const absolute = path.resolve(candidate);
  if (!path.isAbsolute(candidate) || !absolute.startsWith(root + path.sep)) throw fail('EXECUTION_TARGET_OUTSIDE_ROOT');
  let part = root;
  for (const segment of path.relative(root, absolute).split(path.sep)) {
    part = path.join(part, segment);
    if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) throw fail('EXECUTION_SYMLINK_REFUSED');
  }
  if (fs.existsSync(absolute) && fs.realpathSync(absolute) !== absolute) throw fail('EXECUTION_SYMLINK_REFUSED');
  return absolute;
}

/** Trusted operator-only maintenance. Caller must hold world pause through completion.
 * A deployment descriptor is mandatory: no guessed session roots or live unlink.
 * checkStopped is a test seam; CLI and production callers use the systemd check.
 */
export async function purgeExecution({ base, plan, checkStopped = stopped }) {
  if (!path.isAbsolute(base) || fs.realpathSync(base) !== path.resolve(base) || path.basename(base) !== 'companion-world-v1') throw fail('EXECUTION_ROOT_REFUSED');
  if (!plan || typeof plan.id !== 'string' || !Number.isSafeInteger(plan.memoryEpoch) || plan.memoryEpoch < 1 || !Array.isArray(plan.affectedStreams)) throw fail('EXECUTION_PLAN_INVALID');
  if (!fs.existsSync(inside(base, path.join(base, 'operator/authority.json')))) throw fail('EXECUTION_ROOT_REFUSED');
  const descriptorFile = inside(base, path.join(base, 'operator/execution-storage.json'));
  if (!fs.existsSync(descriptorFile)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const layout = read(descriptorFile);
  if (layout.version !== 2) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  await checkStopped();
  // Every owner validates and counts first; nothing is erased unless all of them can go ahead.
  const context = { base, storage: layout, inside };
  for (const [, forget] of owners) forget(plan, { ...context, dryRun: true });
  await checkStopped();
  const [conversation, qq, content] = owners.map(([, forget]) => forget(plan, context));
  return { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control', executionSessionsRemoved: conversation.sessionsRemoved, mediaArtifactsRemoved: content.artifactsRemoved, stickersRemoved: content.stickersRemoved, stickersDetached: content.stickersDetached, jobRecordsRemoved: content.jobRecordsRemoved, speechScratchRemoved: content.speechScratchRemoved };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const base = process.argv[process.argv.indexOf('--base') + 1], file = process.argv[process.argv.indexOf('--plan') + 1];
    if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') throw fail('EXECUTION_ROOT_REFUSED');
    if (!process.argv.includes('--base') || !process.argv.includes('--plan') || !path.isAbsolute(file)) throw fail('PURGE_ARGUMENTS_REQUIRED');
    // CLI deliberately does not guess pause state or manufacture an acknowledgement.
    // Operator API port: 3082 unless --operator-port (staging uses another loopback port).
    const port = process.argv.includes('--operator-port') ? Number(process.argv[process.argv.indexOf('--operator-port') + 1]) : 3082;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('PURGE_ARGUMENTS_REQUIRED');
    const token = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${port}/world`, { headers: { authorization: 'Bearer ' + token } });
    const status = await r.json();
    if (!r.ok || !status.ok || !status.value?.world?.paused) throw fail('WORLD_MUST_BE_PAUSED');
    console.log(JSON.stringify(await purgeExecution({ base, plan: read(file) })));
  } catch (error) { console.error(error.code || 'EXECUTION_PURGE_FAILED'); process.exitCode = 1; }
}
