// operator/content.json: the one place its keys and checks live. capabilities/media/main.mjs and the deploy preflight
// both call `load`. Unknown keys: the preflight refuses them (`strict`); at startup they are ignored with one stderr
// line, so a release rolled back to still starts on a file a newer release wrote.
import fs from 'node:fs';
import path from 'node:path';

/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  store: { required: true, range: 'object { root, ttlMs?, maxBytes? } (ArtifactStore options)', since: '0.10.0' },
  workRoot: { required: true, range: 'absolute path', since: '0.10.0' },
  speechConfigFile: { required: true, range: 'absolute path', since: '0.10.0' },
  authority: { required: true, range: 'object (AuthorityClient options)', since: '0.10.0' },
  gateway: { required: true, range: 'object { socketPath, tokenFile } (capability gateway client)', since: '0.10.0' },
  sharpModule: { required: true, range: 'absolute path', since: '0.10.0' },
  control: { required: true, range: 'object (content server options)', since: '0.10.0' },
  allowRawSmallPng: { required: false, range: 'boolean; default false (staging only)', since: '0.10.0' },
});
/** Defaults of the optional keys, and the store limits a new world starts with (ArtifactStore's own defaults). */
export const defaults = Object.freeze({ store: Object.freeze({ ttlMs: 7 * 86400000, maxBytes: 8 * 1024 * 1024 }), allowRawSmallPng: false });

const MAX_BYTES = 16384;
const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

/** -> { config (unknown keys taken out), unknown: [field] }; throws CONFIG_INVALID. */
export function validate(raw) {
  if (!plain(raw)) throw fail('CONFIG_INVALID');
  const unknown = [], config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(KEYS, key)) config[key] = value; else unknown.push(fieldName(key));
  }
  if (typeof config.sharpModule !== 'string' || !path.isAbsolute(config.sharpModule) || config.allowRawSmallPng !== undefined && typeof config.allowRawSmallPng !== 'boolean') throw fail('CONFIG_INVALID');
  return { config, unknown };
}

/** Reads and checks the file (regular, not a link, <= 16 KiB, not readable by others).
 * `strict` (the preflight): an unknown key throws CONFIG_UNKNOWN_KEY with `fields`. Otherwise it is left out and
 * `warn` gets one line naming the keys (never values). */
export function load(file, { strict = false, warn = line => process.stderr.write(line + '\n') } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { throw fail(error.code === 'ENOENT' ? 'MISSING_CONFIG' : 'CONFIG_PERMISSIONS'); }
  if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077)) throw fail('CONFIG_PERMISSIONS');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('CONFIG_UNREADABLE'); }
  const { config, unknown } = validate(raw);
  if (unknown.length && strict) throw fail('CONFIG_UNKNOWN_KEY', unknown);
  if (unknown.length) warn(`content.json: ignoring unknown keys ${unknown.join(', ')}`);
  return config;
}
