import fs from 'node:fs';
import path from 'node:path';
import { ArtifactStore } from './artifacts.js';
import { createStickers } from './stickers.js';
import { forgetJobs } from './jobs.js';

const fail = code => Object.assign(new Error(code), { code });
function noLinks(directory) {
  for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw fail('EXECUTION_SYMLINK_REFUSED');
    if (e.isDirectory()) noLinks(path.join(directory, e.name));
    else if (!e.isFile()) throw fail('EXECUTION_UNKNOWN_ARTIFACT');
  }
}

/** What both ways of forgetting do, on the stores they are given. `store` is absent when there is no media root yet;
 * `jobs({ entityId, affectedStreams, sourceEvents, dryRun })` forgets the job records; `guard(target)` returns a
 * checked path of the speech work directory or throws. */
function run(plan, { store, stickers, jobs, workRoot, guard, dryRun }) {
  const result = { artifactsRemoved: 0, stickersRemoved: 0, stickersDetached: 0, jobRecordsRemoved: 0, speechScratchRemoved: 0 };
  const { entityId, sourceEvents } = plan;
  if (store) {
    const artifacts = store.forget({ entityId, sourceEvents, dryRun });
    // Her sticker library: a picture the owner had her keep goes when the message it came from is forgotten. One
    // collected from the forgotten message goes too (with what the description cache says of it) when nobody else
    // sent it; when others did, only this sender is taken off it (`stickersDetached`).
    const library = stickers.forget({ entityId, sourceEvents, dryRun });
    // Background jobs (jobs.js): the records of jobs a forgotten message asked for, and of jobs registered in a
    // retired epoch of an affected conversation, go with their results; a waiting one never starts.
    const records = jobs({ entityId, sourceEvents, affectedStreams: plan.affectedStreams.map(entry => ({ streamId: entry.streamId, memoryEpoch: entry.memoryEpoch ?? plan.memoryEpoch })), dryRun });
    if (!dryRun) Object.assign(result, { artifactsRemoved: artifacts.removed, stickersRemoved: library.removed, stickersDetached: library.detached ?? 0, jobRecordsRemoved: records.removed });
  }
  // Unfinished speech work (synthesized audio, recognition jobs) may hold the forgotten words; the reference voice stays.
  const scratch = [];
  if (fs.existsSync(workRoot)) for (const name of fs.readdirSync(workRoot)) if (/^tts-[a-f0-9-]{36}\.wav$|^speech-job-[A-Za-z0-9]+$/.test(name)) {
    const target = guard(path.join(workRoot, name)); if (fs.statSync(target).isDirectory()) noLinks(target); scratch.push(target);
  }
  if (!dryRun) for (const target of scratch) { guard(target); if (fs.statSync(target).isDirectory()) { noLinks(target); fs.rmSync(target, { recursive: true }); } else fs.unlinkSync(target); }
  result.speechScratchRemoved = scratch.length;
  return result;
}

/** Offline forgetting (deploy/authority/purge-execution.mjs, with this service stopped and the world paused): the
 * content service's own files. `storage` is the deployment's operator/execution-storage.json (its `media` part names
 * this service's roots), `inside(root, file)` the caller's guard (absolute, under root, no symlink). `dryRun` only
 * validates and counts; what is already gone is not counted, so the same plan again is harmless.
 * -> { artifactsRemoved, stickersRemoved, stickersDetached, jobRecordsRemoved, speechScratchRemoved } */
export function forget(plan, { base, storage, inside, dryRun = false }) {
  if (!storage?.media) {
    if (fs.existsSync(path.join(base, 'media-data')) && fs.readdirSync(path.join(base, 'media-data')).length) throw fail('EXECUTION_STORAGE_UNVERIFIED');
    return { artifactsRemoved: 0, stickersRemoved: 0, stickersDetached: 0, jobRecordsRemoved: 0, speechScratchRemoved: 0 };
  }
  if (storage.media.root !== 'media-data' || storage.media.workRoot !== 'speech-data' || typeof plan.entityId !== 'string' || !Array.isArray(plan.sourceEvents)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const mediaRoot = inside(base, path.join(base, storage.media.root)), workRoot = inside(base, path.join(base, storage.media.workRoot));
  const store = fs.existsSync(mediaRoot) ? new ArtifactStore({ root: mediaRoot }) : null;
  return run(plan, { store, stickers: store && createStickers({ root: store.root }), jobs: input => forgetJobs({ file: inside(base, path.join(mediaRoot, 'jobs.json')), ...input }), workRoot, guard: target => inside(base, target), dryRun });
}

/** Forgetting inside the running content service (its `/forget`, asked by Authority while the world is paused): the
 * same files as `forget` above, through the stores this process holds, so nothing it keeps in memory can write a
 * forgotten record back. `store`, `stickers` and `jobs` are the service's own instances, `workRoot` its speech work
 * directory. Synchronous from the first check to the last write: the server calls it only when no other request and
 * no background job is in flight, and nothing of this process can run in between. Everything is validated before
 * anything is erased; what is already gone is not counted, so the same plan again is harmless. -> the same counts. */
export function forgetLive(plan, { store, stickers, jobs, workRoot }) {
  if (!plan || typeof plan.entityId !== 'string' || !Array.isArray(plan.sourceEvents) || !Array.isArray(plan.affectedStreams) || !Number.isSafeInteger(plan.memoryEpoch) || plan.memoryEpoch < 1
    || plan.sourceEvents.some(event => typeof event?.streamId !== 'string' || typeof event.eventId !== 'string') || plan.affectedStreams.some(entry => typeof entry?.streamId !== 'string')) throw fail('MEDIA_FORGET_PLAN');
  if (!path.isAbsolute(workRoot)) throw fail('MEDIA_WORK_ROOT');
  if (jobs.running) throw fail('MEDIA_JOB_RUNNING');
  // A work file sits directly in the work directory and is never a link.
  const guard = target => { if (path.dirname(target) !== workRoot || fs.lstatSync(target).isSymbolicLink()) throw fail('EXECUTION_SYMLINK_REFUSED'); return target; };
  const context = { store, stickers, jobs: input => jobs.forget(input), workRoot, guard };
  run(plan, { ...context, dryRun: true });
  return run(plan, { ...context, dryRun: false });
}
