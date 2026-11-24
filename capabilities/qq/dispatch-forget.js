import fs from 'node:fs';
import path from 'node:path';
import { qqRequestId } from './worker-route.js';

const fail = code => Object.assign(new Error(code), { code });

/** Dispatch records keep only opaque request hashes; the record of a forgotten input becomes a tombstone, in
 * `records` itself (a new object: whoever still holds the old one can no longer change what is stored). The same
 * messages again find only tombstones. -> how many records were set. */
export function forgetRecords(records, sourceEvents) {
  let changed = 0;
  for (const source of sourceEvents) {
    if (typeof source?.streamId !== 'string' || typeof source.eventId !== 'string') throw fail('EXECUTION_PLAN_INVALID');
    const id = qqRequestId(source);
    if (Object.hasOwn(records, id)) { records[id] = { status: 'forgotten' }; changed++; }
  }
  return changed;
}

/** Offline forgetting (deploy/authority/purge-execution.mjs, with the bridge stopped and the world paused; the running
 * bridge forgets in its own records, bridge.js `forgetDispatch`). `inside(root, file)`
 * is the caller's guard (absolute, under root, no symlink). `dryRun` only validates and counts; without the file
 * there is nothing to do. -> { dispatchForgotten } */
export function forget(plan, { base, inside, dryRun = false }) {
  const file = inside(base, path.join(base, 'qq-data/dispatch.json'));
  if (!fs.existsSync(file) || !Array.isArray(plan.sourceEvents) || !plan.sourceEvents.length) return { dispatchForgotten: 0 };
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('EXECUTION_LOCAL_FORMAT_INVALID'); }
  if (!state.records || typeof state.records !== 'object') throw fail('EXECUTION_UNKNOWN_DISPATCH_FORMAT');
  const changed = forgetRecords(state.records, plan.sourceEvents);
  if (!dryRun && changed) {
    inside(base, file);
    fs.writeFileSync(file + '.purge-tmp', JSON.stringify(state) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.purge-tmp', file);
  }
  return { dispatchForgotten: changed };
}
