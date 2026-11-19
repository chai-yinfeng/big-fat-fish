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

/** Offline forgetting (deploy/authority/purge-execution.mjs, with this service stopped and the world paused): the
 * content service's own files. `storage` is the deployment's operator/execution-storage.json (its `media` part names
 * this service's roots), `inside(root, file)` the caller's guard (absolute, under root, no symlink). `dryRun` only
 * validates and counts; what is already gone is not counted, so the same plan again is harmless.
 * -> { artifactsRemoved, stickersRemoved, stickersDetached, jobRecordsRemoved, speechScratchRemoved } */
export function forget(plan, { base, storage, inside, dryRun = false }) {
  const result = { artifactsRemoved: 0, stickersRemoved: 0, stickersDetached: 0, jobRecordsRemoved: 0, speechScratchRemoved: 0 };
  if (!storage?.media) {
    if (fs.existsSync(path.join(base, 'media-data')) && fs.readdirSync(path.join(base, 'media-data')).length) throw fail('EXECUTION_STORAGE_UNVERIFIED');
    return result;
  }
  if (storage.media.root !== 'media-data' || storage.media.workRoot !== 'speech-data' || typeof plan.entityId !== 'string' || !Array.isArray(plan.sourceEvents)) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const mediaRoot = inside(base, path.join(base, storage.media.root)), workRoot = inside(base, path.join(base, storage.media.workRoot));
  const { entityId, sourceEvents } = plan;
  if (fs.existsSync(mediaRoot)) {
    const store = new ArtifactStore({ root: mediaRoot });
    const artifacts = store.forget({ entityId, sourceEvents, dryRun });
    // Her sticker library: a picture the owner had her keep goes when the message it came from is forgotten. One
    // collected from the forgotten message goes too (with what the description cache says of it) when nobody else
    // sent it; when others did, only this sender is taken off it (`stickersDetached`).
    const stickers = createStickers({ root: store.root }).forget({ entityId, sourceEvents, dryRun });
    // Background jobs (jobs.js): the records of jobs a forgotten message asked for, and of jobs registered in a
    // retired epoch of an affected conversation, go with their results; a waiting one never starts.
    const jobs = forgetJobs({ file: inside(base, path.join(mediaRoot, 'jobs.json')), entityId, sourceEvents, affectedStreams: plan.affectedStreams.map(entry => ({ streamId: entry.streamId, memoryEpoch: entry.memoryEpoch ?? plan.memoryEpoch })), dryRun });
    if (!dryRun) Object.assign(result, { artifactsRemoved: artifacts.removed, stickersRemoved: stickers.removed, stickersDetached: stickers.detached ?? 0, jobRecordsRemoved: jobs.removed });
  }
  // Unfinished speech work (synthesized audio, recognition jobs) may hold the forgotten words; the reference voice stays.
  const scratch = [];
  if (fs.existsSync(workRoot)) for (const name of fs.readdirSync(workRoot)) if (/^tts-[a-f0-9-]{36}\.wav$|^speech-job-[A-Za-z0-9]+$/.test(name)) {
    const target = inside(base, path.join(workRoot, name)); if (fs.statSync(target).isDirectory()) noLinks(target); scratch.push(target);
  }
  if (!dryRun) for (const target of scratch) { inside(base, target); if (fs.statSync(target).isDirectory()) { noLinks(target); fs.rmSync(target, { recursive: true }); } else fs.unlinkSync(target); }
  result.speechScratchRemoved = scratch.length;
  return result;
}
