#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const released = path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'ops';
const { conversationSessionId } = await import(released ? '../capabilities/conversation/sessions.js' : '../../capabilities/conversation/sessions.js');
const { qqRequestId } = await import(released ? '../capabilities/qq/worker-route.js' : '../../capabilities/qq/worker-route.js');

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
function noLinks(directory) {
  for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw fail('EXECUTION_SYMLINK_REFUSED');
    if (e.isDirectory()) noLinks(path.join(directory, e.name));
    else if (!e.isFile()) throw fail('EXECUTION_UNKNOWN_ARTIFACT');
  }
}
function rewrite(file, value) {
  fs.writeFileSync(file + '.purge-tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.purge-tmp', file);
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
  if (layout.version !== 2 || layout.sessionsRoot !== 'conversation-data/sessions') throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const sessionsRoot = inside(base, path.join(base, layout.sessionsRoot));
  if (!fs.statSync(sessionsRoot).isDirectory()) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  await checkStopped();
  // Every earlier memory epoch of an affected stream is a retired session.
  const sessions = [];
  for (const entry of plan.affectedStreams) {
    if (typeof entry?.capabilityId !== 'string' || typeof entry.streamId !== 'string') throw fail('EXECUTION_PLAN_INVALID');
    for (let epoch = 0; epoch < plan.memoryEpoch; epoch++) {
      const file = inside(sessionsRoot, path.join(sessionsRoot, conversationSessionId(entry.streamId, epoch) + '.jsonl'));
      if (!fs.existsSync(file)) continue;
      if (!fs.lstatSync(file).isFile()) throw fail('EXECUTION_UNKNOWN_ARTIFACT');
      sessions.push(file);
    }
  }
  // Dispatch records keep only opaque request hashes; forgotten inputs become tombstones.
  const dispatchFile = inside(base, path.join(base, 'qq-data/dispatch.json'));
  const writes = [];
  if (fs.existsSync(dispatchFile) && Array.isArray(plan.sourceEvents) && plan.sourceEvents.length) {
    const state = read(dispatchFile);
    if (!state.records || typeof state.records !== 'object') throw fail('EXECUTION_UNKNOWN_DISPATCH_FORMAT');
    let changed = false;
    for (const source of plan.sourceEvents) {
      if (typeof source?.streamId !== 'string' || typeof source.eventId !== 'string') throw fail('EXECUTION_PLAN_INVALID');
      const id = qqRequestId(source);
      if (Object.hasOwn(state.records, id)) { state.records[id] = { status: 'forgotten' }; changed = true; }
    }
    if (changed) writes.push([dispatchFile, state]);
  }
  let mediaStore, mediaRemoved = 0;
  const speechScratch = [];
  if (layout.media) {
    if (layout.media.root !== 'media-data' || layout.media.workRoot !== 'speech-data' || typeof plan.entityId !== 'string' || !Array.isArray(plan.sourceEvents)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
    const mediaRoot = inside(base, path.join(base, layout.media.root)), workRoot = inside(base, path.join(base, layout.media.workRoot));
    if (fs.existsSync(mediaRoot)) {
      const { ArtifactStore } = await import(path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'ops' ? '../capabilities/media/artifacts.js' : '../../capabilities/media/artifacts.js');
      mediaStore = new ArtifactStore({ root: mediaRoot });
      mediaStore.forget({ entityId: plan.entityId, sourceEvents: plan.sourceEvents, dryRun: true });
    }
    if (fs.existsSync(workRoot)) for (const name of fs.readdirSync(workRoot)) if (/^tts-[a-f0-9-]{36}\.wav$|^speech-job-[A-Za-z0-9]+$/.test(name)) {
      const target = inside(base, path.join(workRoot, name)); if (fs.statSync(target).isDirectory()) noLinks(target); speechScratch.push(target);
    }
  } else if (fs.existsSync(path.join(base, 'media-data')) && fs.readdirSync(path.join(base, 'media-data')).length) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  await checkStopped();
  // Every absolute target was checked above; recheck immediately before mutation.
  for (const file of sessions) { inside(sessionsRoot, file); fs.unlinkSync(file); }
  for (const [file, value] of writes) { inside(base, file); rewrite(file, value); }
  if (mediaStore) mediaRemoved = mediaStore.forget({ entityId: plan.entityId, sourceEvents: plan.sourceEvents }).removed;
  for (const target of speechScratch) { inside(base, target); if (fs.statSync(target).isDirectory()) { noLinks(target); fs.rmSync(target, { recursive: true }); } else fs.unlinkSync(target); }
  return { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control', executionSessionsRemoved: sessions.length, mediaArtifactsRemoved: mediaRemoved, speechScratchRemoved: speechScratch.length };
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
