// operator/memory-worker.json: the one place its keys and checks live. capabilities/memory/main.mjs and the deploy
// preflight both call `load`. Unknown keys: the preflight refuses them (`strict`); at startup they are ignored with one
// stderr line, so a release rolled back to still starts on a file a newer release wrote. Keys this worker no longer
// reads (LEGACY, ROLLBACK) are left out silently; the preflight lists the LEGACY ones as warnings.
// The worker holds two credentials, both named here: Authority's maintenance grant and the gateway's inference
// token. It reads no operator token, dials no TCP port and controls no service.
import fs from 'node:fs';

/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  authority: { required: true, range: 'object (AuthorityClient options)', since: '0.10.0' },
  gateway: { required: true, range: 'object { socketPath, tokenFile } (inference client)', since: '0.10.0' },
  tickMs: { required: false, range: 'integer 1000..600000; default 60000', since: '0.10.0' },
  consolidationDeferMs: { required: false, range: 'integer 1000..86400000; default 1800000', since: '0.10.0' },
});
/** Read by no release since 945e4dc (a pinned purge path); the preflight warns. */
export const LEGACY = Object.freeze(['purgeModule']);
/** Not read by this worker, but still written by prepare-memory and to be left in the file, because a release rolled
 * back to reads them: releases from before c843d93 read stateFile and maxCallsPerDay (entityId was never read);
 * releases from before the worker gave up the cleanup after a forget (driver step 7c) refuse to start without `base`
 * and `operatorTokenFile` and dial `operatorPort` (staging writes it, which keeps such a worker off the production
 * port). Left out silently, and no preflight warning: every world has them. */
export const ROLLBACK = Object.freeze(['entityId', 'stateFile', 'maxCallsPerDay', 'base', 'operatorTokenFile', 'operatorPort']);
/** Defaults of the optional keys. */
export const defaults = Object.freeze({ tickMs: 60000, consolidationDeferMs: 1800000 });

const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const within = (value, min, max) => value === undefined || (Number.isInteger(value) && value >= min && value <= max);
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

/** -> { config (unknown, legacy and rollback keys taken out), unknown: [field], legacy: [field] }; throws CONFIG_INVALID. */
export function validate(raw) {
  if (!plain(raw)) throw fail('CONFIG_INVALID');
  const unknown = [], legacy = [], config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LEGACY.includes(key)) legacy.push(key);
    else if (ROLLBACK.includes(key)) continue;
    else if (!Object.hasOwn(KEYS, key)) unknown.push(fieldName(key));
    else config[key] = value;
  }
  if (!plain(config.authority) || !plain(config.gateway)) throw fail('CONFIG_INVALID');
  // Optional timings (staging shortens them).
  if (!within(config.tickMs, 1000, 600000) || !within(config.consolidationDeferMs, 1000, 86400000)) throw fail('CONFIG_INVALID');
  return { config, unknown, legacy };
}

/** Reads and checks the file (regular, not a link, owned by this user, not readable by others).
 * `strict` (the preflight): an unknown key throws CONFIG_UNKNOWN_KEY with `fields`. Otherwise it is left out and
 * `warn` gets one line naming the keys (never values). `legacy` receives the legacy keys found. */
export function load(file, { strict = false, warn = line => process.stderr.write(line + '\n'), legacy: onLegacy = () => {} } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { throw fail(error.code === 'ENOENT' ? 'MISSING_CONFIG' : 'CONFIG_PERMISSIONS'); }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('CONFIG_PERMISSIONS');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('CONFIG_UNREADABLE'); }
  const { config, unknown, legacy } = validate(raw);
  if (unknown.length && strict) throw fail('CONFIG_UNKNOWN_KEY', unknown);
  if (unknown.length) warn(`memory-worker.json: ignoring unknown keys ${unknown.join(', ')}`);
  if (legacy.length) onLegacy(legacy);
  return config;
}
