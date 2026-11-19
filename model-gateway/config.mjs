// operator/model-gateway.json: the one place its keys and checks live. model-gateway/main.mjs and the deploy
// preflight both call `load`. Unknown keys: the preflight refuses them (`strict`); at startup they are ignored with one
// stderr line, so a release rolled back to still starts on a file a newer release wrote.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  settingsFile: { required: true, range: 'absolute path', since: '0.10.0' },
  inferenceSocket: { required: true, range: 'absolute path', since: '0.10.0' },
  controlSocket: { required: true, range: 'absolute path', since: '0.10.0' },
  inferenceTokenHash: { required: true, range: '64 hex sha256, unlike operatorTokenHash', since: '0.10.0' },
  operatorTokenHash: { required: true, range: '64 hex sha256', since: '0.10.0' },
  authority: { required: true, range: 'object { socketPath, tokenFile }', since: '0.10.0', keys: ['socketPath', 'tokenFile'] },
  usageFile: { required: false, range: 'absolute path; default <settingsFile dir>/capability-usage.json', since: '0.10.0' },
  budgets: { required: false, range: 'object { web?, vision? }, integers 0..1000', since: '0.10.0', keys: ['web', 'vision'] },
});
/** Defaults of the optional keys (usageFile's default depends on settingsFile, see KEYS). */
export const defaults = Object.freeze({ budgets: Object.freeze({ web: 20, vision: 12 }) });

const MAX_BYTES = 32768;
const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

/** -> { config (unknown keys taken out), unknown: [field] }; throws CONFIG_INVALID on a value the gateway refuses. */
export function validate(raw) {
  if (!plain(raw)) throw fail('CONFIG_INVALID');
  const unknown = [], config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(KEYS, key)) { unknown.push(fieldName(key)); continue; }
    if (!KEYS[key].keys) { config[key] = value; continue; }
    if (!plain(value)) throw fail('CONFIG_INVALID');
    config[key] = {};
    for (const [inner, item] of Object.entries(value)) {
      if (KEYS[key].keys.includes(inner)) config[key][inner] = item; else unknown.push(`${key}.${fieldName(inner)}`);
    }
  }
  // The same shape model-gateway/server.mjs createModelGateway requires.
  const paths = ['settingsFile', 'inferenceSocket', 'controlSocket', 'usageFile'].filter(key => key !== 'usageFile' || config.usageFile !== undefined).map(key => config[key]);
  if (!paths.every(absolute) || new Set(paths).size !== paths.length || !config.authority) throw fail('CONFIG_INVALID');
  if (![config.inferenceTokenHash, config.operatorTokenHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) || config.inferenceTokenHash === config.operatorTokenHash) throw fail('CONFIG_INVALID');
  if (config.budgets && Object.values(config.budgets).some(value => !Number.isSafeInteger(value) || value < 0 || value > 1000)) throw fail('CONFIG_INVALID');
  return { config, unknown };
}

/** Reads and checks the file (regular, not a link, owned by this user, 0600-like, <= 32 KiB).
 * `strict` (the preflight): an unknown key throws CONFIG_UNKNOWN_KEY with `fields`. Otherwise it is left out and
 * `warn` gets one line naming the keys (never values). */
export async function load(file, { strict = false, warn = line => process.stderr.write(line + '\n') } = {}) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw fail(error.code === 'ENOENT' ? 'MISSING_CONFIG' : 'CONFIG_PERMISSIONS'); }
  let raw;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw fail('CONFIG_PERMISSIONS');
    try { raw = JSON.parse(await handle.readFile('utf8')); } catch { throw fail('CONFIG_UNREADABLE'); }
  } finally { await handle.close(); }
  const { config, unknown } = validate(raw);
  if (unknown.length && strict) throw fail('CONFIG_UNKNOWN_KEY', unknown);
  if (unknown.length) warn(`model-gateway.json: ignoring unknown keys ${unknown.join(', ')}`);
  return config;
}
