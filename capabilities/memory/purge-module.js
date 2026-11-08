import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * purge-execution ships in the same tree as this worker: `ops/` in a release,
 * `deploy/authority/` in a checkout. Resolve it from this file instead of a path
 * pinned in memory-worker.json: Node realpaths the entry module, so a pinned path
 * names one release directory, which companion-deploy retention later deletes.
 */
export function purgeModuleURL(from = import.meta.url) {
  for (const relative of ['../../ops/purge-execution.mjs', '../../deploy/authority/purge-execution.mjs']) {
    const url = new URL(relative, from);
    if (fs.existsSync(fileURLToPath(url))) return url.href;
  }
  throw Object.assign(new Error('MEMORY_PURGE_MODULE'), { code: 'MEMORY_PURGE_MODULE' });
}
