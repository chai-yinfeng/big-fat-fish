#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const { qqSessionId } = await import(path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'ops' ? '../capabilities/qq/worker-route.js' : '../../capabilities/qq/worker-route.js');

const fail = code => Object.assign(new Error(code), { code });
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('EXECUTION_LOCAL_FORMAT_INVALID'); } };
const units = ['companion-content.service', 'companion-qq.service', 'companion-dsh-internal.service', 'companion-dsh-internal.socket', 'companion-dsh-public.service', 'companion-dsh-public.socket'];
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
function header(file) {
  let bytes = fs.readFileSync(file);
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw fail('EXECUTION_CODEC_UNAVAILABLE');
    bytes = zlib.zstdDecompressSync(bytes);
  }
  let value;
  try { value = JSON.parse(bytes.subarray(0, bytes.indexOf(10) < 0 ? bytes.length : bytes.indexOf(10)).toString('utf8')); } catch { throw fail('EXECUTION_UNKNOWN_FORMAT'); }
  const version = file.match(/session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/)?.[1] || '0';
  if (!Number.isSafeInteger(value.version) || value.version !== Number(version) || value.version > 4 || typeof value.id !== 'string') throw fail('EXECUTION_UNKNOWN_FORMAT');
  return value;
}
function rewrite(file, value) {
  fs.writeFileSync(file + '.purge-tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.purge-tmp', file);
}

/** Trusted operator-only maintenance. Caller must hold world pause through completion.
 * A deployment descriptor is mandatory: no guessed SDK storage roots or live unlink.
 * checkStopped is a test seam; CLI and production callers use the systemd check.
 */
export async function purgeExecution({ base, plan, checkStopped = stopped }) {
  if (!path.isAbsolute(base) || fs.realpathSync(base) !== path.resolve(base) || path.basename(base) !== 'companion-world-v1') throw fail('EXECUTION_ROOT_REFUSED');
  const sdk = inside(base, path.join(base, 'dsh-home'));
  if (!plan || typeof plan.id !== 'string' || !Number.isSafeInteger(plan.memoryEpoch) || plan.memoryEpoch < 1 || !Array.isArray(plan.affectedStreams)) throw fail('EXECUTION_PLAN_INVALID');
  if (!fs.existsSync(inside(base, path.join(base, 'operator/authority.json')))) throw fail('EXECUTION_ROOT_REFUSED');
  const descriptorFile = inside(base, path.join(base, 'operator/execution-storage.json'));
  if (!fs.existsSync(descriptorFile)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const layout = read(descriptorFile);
  if (layout.version !== 1 || typeof layout.sessionsRoot !== 'string' || !Array.isArray(layout.derivedPaths)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const resolve = value => inside(sdk, path.isAbsolute(value) ? value : path.join(base, value));
  const sessionsRoot = resolve(layout.sessionsRoot);
  if (!fs.statSync(sessionsRoot).isDirectory()) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  await checkStopped();
  const qqStreams = new Set(), nativeIds = new Set(), qqBases = new Set();
  for (const entry of plan.affectedStreams) {
    if (typeof entry?.capabilityId !== 'string' || typeof entry.streamId !== 'string') throw fail('EXECUTION_PLAN_INVALID');
    if (entry.capabilityId === 'qq') {
      const match = entry.streamId.match(/^qq:(\d{1,20}):private:(\d{1,20})$/);
      if (!match) throw fail('EXECUTION_UNKNOWN_STREAM');
      qqStreams.add(entry.streamId); qqBases.add(qqSessionId(match[1], match[2]));
    } else nativeIds.add(entry.streamId);
  }
  const selectedId = id => nativeIds.has(id) || [...qqBases].some(prefix => id === prefix || id.startsWith(prefix + '-e') && /^[1-9]\d*$/.test(id.slice(prefix.length + 2)) && Number(id.slice(prefix.length + 2)) < plan.memoryEpoch);
  const directories = [], artifacts = [];
  for (const project of fs.readdirSync(sessionsRoot)) {
    const projectPath = inside(sdk, path.join(sessionsRoot, project));
    if (!fs.statSync(projectPath).isDirectory()) throw fail('EXECUTION_UNKNOWN_LAYOUT');
    for (const name of fs.readdirSync(projectPath)) {
      const directory = inside(sdk, path.join(projectPath, name));
      if (!fs.statSync(directory).isDirectory()) throw fail('EXECUTION_UNKNOWN_LAYOUT');
      const names = fs.readdirSync(directory).filter(n => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(n));
      if (!names.length) throw fail('EXECUTION_UNKNOWN_FORMAT');
      const heads = names.map(n => header(inside(sdk, path.join(directory, n))));
      const last = heads.toSorted((a, b) => b.version - a.version)[0];
      artifacts.push({ directory, last, heads });
    }
  }
  const selected = new Set(artifacts.filter(a => selectedId(a.last.id)).map(a => a.last.id));
  let changed;
  do { changed = false; for (const a of artifacts) if (selected.has(a.last.parentSession) && !selected.has(a.last.id)) { selected.add(a.last.id); changed = true; } } while (changed);
  for (const { directory, last, heads } of artifacts) if (selected.has(last.id)) {
    if (last.agentPreset !== 'companion' || last.cwd !== '/home/companion/dsh' || heads.some(h => h.id !== last.id)) throw fail('EXECUTION_SESSION_OWNERSHIP_REFUSED');
    noLinks(directory); directories.push(directory);
  }
  const matchesExecution = id => selectedId(id) || selected.has(id);
  const derived = [], derivedDirectories = [];
  for (const entry of layout.derivedPaths) {
    if (!['sqlite', 'projection-json', 'projection-cache-domain'].includes(entry?.kind) || typeof entry.path !== 'string') throw fail('EXECUTION_STORAGE_UNVERIFIED');
    const file = resolve(entry.path);
    if (![path.join(sdk, 'cache') + path.sep, path.join(sdk, 'storages') + path.sep].some(p => file.startsWith(p))) throw fail('EXECUTION_DERIVED_OWNERSHIP_REFUSED');
    if (!fs.existsSync(file)) continue;
    if (entry.kind === 'projection-cache-domain') {
      if (file !== path.join(sdk, 'storages/session_projcache') || !fs.statSync(file).isDirectory()) throw fail('EXECUTION_DERIVED_OWNERSHIP_REFUSED');
      noLinks(file); derivedDirectories.push(file); continue;
    }
    if (!fs.statSync(file).isFile()) throw fail('EXECUTION_STORAGE_UNVERIFIED');
    if (entry.kind === 'sqlite') {
      if (fs.readFileSync(file).subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw fail('EXECUTION_UNKNOWN_INDEX');
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) derived.push(inside(sdk, file + suffix));
    } else { read(file); derived.push(file); }
  }
  const deliveryFile = inside(base, path.join(sdk, 'conversation-delivery.json'));
  const epochFile = inside(base, deliveryFile + '.epochs.json');
  const inboxFile = inside(base, path.join(base, 'qq-inbox/inbox.jsonl'));
  const dispatchFile = inside(base, path.join(base, 'qq-data/dispatch.json'));
  const writes = [];
  for (const file of [deliveryFile, epochFile]) if (fs.existsSync(file)) {
    const document = read(file), table = file === deliveryFile ? document.streams : document;
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw fail('EXECUTION_UNKNOWN_ACK_FORMAT');
    for (const id of Object.keys(table)) if (matchesExecution(id)) {
      if (file === epochFile) table[id] = { entityId: table[id].entityId, memoryEpoch: table[id].memoryEpoch, retired: true };
      else delete table[id];
    }
    writes.push([file, document]);
  }
  let inbox, removedRequests = new Set();
  if (fs.existsSync(inboxFile)) {
    const text = fs.readFileSync(inboxFile, 'utf8');
    if (text && !text.endsWith('\n')) throw fail('EXECUTION_INBOX_PARTIAL');
    inbox = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { throw fail('EXECUTION_UNKNOWN_INBOX_FORMAT'); } }).filter(row => {
      if (!row.observation || typeof row.observation.streamId !== 'string') throw fail('EXECUTION_UNKNOWN_INBOX_FORMAT');
      if (!qqStreams.has(row.observation.streamId)) return true;
      removedRequests.add(row.requestId); return false;
    }).map(row => JSON.stringify(row)).join('\n');
    if (inbox) inbox += '\n';
  }
  if (fs.existsSync(dispatchFile) && removedRequests.size) {
    const state = read(dispatchFile);
    if (!state.records || typeof state.records !== 'object') throw fail('EXECUTION_UNKNOWN_DISPATCH_FORMAT');
    for (const id of removedRequests) state.records[id] = { status: 'forgotten' };
    writes.push([dispatchFile, state]);
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
  for (const directory of directories) { inside(sdk, directory); noLinks(directory); fs.rmSync(directory, { recursive: true }); }
  for (const file of derived) { inside(sdk, file); fs.unlinkSync(file); }
  for (const directory of derivedDirectories) { inside(sdk, directory); noLinks(directory); fs.rmSync(directory, { recursive: true }); }
  for (const [file, value] of writes) { inside(base, file); rewrite(file, value); }
  if (inbox !== undefined) { inside(base, inboxFile); fs.writeFileSync(inboxFile + '.purge-tmp', inbox, { mode: 0o600 }); fs.renameSync(inboxFile + '.purge-tmp', inboxFile); }
  if (mediaStore) mediaRemoved = mediaStore.forget({ entityId: plan.entityId, sourceEvents: plan.sourceEvents }).removed;
  for (const target of speechScratch) { inside(base, target); if (fs.statSync(target).isDirectory()) { noLinks(target); fs.rmSync(target, { recursive: true }); } else fs.unlinkSync(target); }
  return { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control', executionSessionsRemoved: directories.length, derivedFilesRemoved: derived.length, derivedDomainsRemoved: derivedDirectories.length, mediaArtifactsRemoved: mediaRemoved, speechScratchRemoved: speechScratch.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const base = process.argv[process.argv.indexOf('--base') + 1], file = process.argv[process.argv.indexOf('--plan') + 1];
    if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') throw fail('EXECUTION_ROOT_REFUSED');
    if (!process.argv.includes('--base') || !process.argv.includes('--plan') || !path.isAbsolute(file)) throw fail('PURGE_ARGUMENTS_REQUIRED');
    // CLI deliberately does not guess pause state or manufacture an acknowledgement.
    const token = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
    const r = await fetch('http://127.0.0.1:3082/world', { headers: { authorization: 'Bearer ' + token } });
    const status = await r.json();
    if (!r.ok || !status.ok || !status.value?.world?.paused) throw fail('WORLD_MUST_BE_PAUSED');
    console.log(JSON.stringify(await purgeExecution({ base, plan: read(file) })));
  } catch (error) { console.error(error.code || 'EXECUTION_PURGE_FAILED'); process.exitCode = 1; }
}
