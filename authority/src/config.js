// operator/authority.json: the one place its keys and checks live. authority/src/main.js and the deploy preflight both
// call `load`. Unknown top-level keys: the preflight refuses them (`strict`); at startup they are ignored with one
// stderr line, so a release rolled back to still starts on a file a newer release wrote. The room credential is not
// here: main.js reads it from its own file beside this one (room-credential.json).
import fs from 'node:fs';
import path from 'node:path';
import { channel } from '../../capabilities/channels/index.js';

export const SCHEMA_VERSION = 1;
/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  schemaVersion: { required: true, range: `${SCHEMA_VERSION}`, since: '0.10.0' },
  databasePath: { required: true, range: 'absolute path (sandbox)', since: '0.10.0' },
  socketPath: { required: true, range: 'absolute path (sandbox)', since: '0.10.0' },
  credentials: { required: true, range: 'array of { hash, role, ... }; a test-only channel only with operator.allowTestChannels', since: '0.10.0' },
  capabilities: { required: true, range: 'array of { id, policy }', since: '0.10.0' },
  actors: { required: true, range: 'array', since: '0.10.0' },
  streams: { required: true, range: 'array', since: '0.10.0' },
  operator: { required: true, range: 'object { socketPath, tokenHash (64 hex), origins: [], ... } (createOperatorServer options)', since: '0.10.0' },
  persona: { required: false, range: 'object (Authority persona)', since: '0.10.0' },
  initialPaused: { required: false, range: 'boolean; default false', since: '0.10.0' },
  content: { required: false, range: 'object { socketPath, tokenFile } (content service client)', since: '0.10.0' },
});
/** Defaults of the optional keys, and what a new world starts with (bootstrap writes initialPaused: true). */
export const defaults = Object.freeze({ initialPaused: false });

const MAX_BYTES = 65536;
const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

/** -> { config (unknown keys taken out), unknown: [field] }; throws CONFIG_INVALID or TEST_CHANNEL_CONFIGURED. */
export function validate(raw) {
  if (!plain(raw)) throw fail('CONFIG_INVALID');
  const unknown = [], config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(KEYS, key)) config[key] = value; else unknown.push(fieldName(key));
  }
  if (config.schemaVersion !== SCHEMA_VERSION || !absolute(config.databasePath) || !absolute(config.socketPath) || !['credentials', 'capabilities', 'actors', 'streams'].every(key => Array.isArray(config[key]))) throw fail('CONFIG_INVALID');
  // The same operator shape authority/src/operator.js createOperatorServer requires.
  if (!plain(config.operator) || !absolute(config.operator.socketPath) || !/^[a-f0-9]{64}$/.test(config.operator.tokenHash) || !Array.isArray(config.operator.origins)) throw fail('CONFIG_INVALID');
  // A test-only channel (capabilities/channels) is never served by accident: its capability or credential is
  // refused unless the private configuration also says `operator.allowTestChannels: true`. No prepare script of a
  // release writes that; the staging tools and the tests do. (An older release ignores the field.)
  if (config.operator.allowTestChannels !== true && [...config.capabilities, ...config.credentials].some(row => channel(row?.id ?? row?.capabilityId)?.testOnly)) throw fail('TEST_CHANNEL_CONFIGURED');
  return { config, unknown };
}

/** Reads and checks the file (regular, not a link, <= 64 KiB, not readable by others).
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
  if (unknown.length) warn(`authority.json: ignoring unknown keys ${unknown.join(', ')}`);
  return config;
}
