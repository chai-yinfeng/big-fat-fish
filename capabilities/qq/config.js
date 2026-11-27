// operator/qq-bridge.json: the one place its keys and checks live. capabilities/qq/main.mjs and the deploy preflight
// both call `load`. Unknown keys: the preflight refuses them (`strict`); at startup they are ignored with one stderr
// line, so a release rolled back to still starts on a file a newer release wrote. Keys earlier releases wrote and no
// release reads any more (LEGACY) are left out silently; the preflight lists them as warnings.
import fs from 'node:fs';
import path from 'node:path';
import { INITIATION_POLL_MS } from './bridge.js';
import { PACING, pacingFrom } from './pacing.js';
import { GROUP, groupFrom } from './group.js';

/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  authority: { required: true, range: 'object (AuthorityClient options)', since: '0.10.0' },
  conversation: { required: true, range: 'object (conversation executor client options)', since: '0.10.0' },
  controlSocket: { required: true, range: 'absolute path', since: '0.10.0' },
  onebotTokenFile: { required: true, range: 'absolute path', since: '0.10.0' },
  operatorTokenHash: { required: true, range: '64 hex sha256', since: '0.10.0' },
  settingsFile: { required: true, range: 'absolute path', since: '0.10.0' },
  stateFile: { required: true, range: 'absolute path', since: '0.10.0' },
  onebotPort: { required: false, range: 'integer 1..65535; default 3001', since: '0.10.0' },
  contentEnabled: { required: false, range: 'truthy turns QQ media on; default off', since: '0.10.0' },
  initiationPollMs: { required: false, range: 'integer 1000..600000', since: '0.10.0' },
  stickerSubType: { required: false, range: 'boolean', since: '0.10.0' },
  pacing: { required: false, range: 'object, keys and ranges of capabilities/qq/pacing.js', since: '0.10.0', keys: Object.keys(PACING) },
  // Group chat's numbers. No release writes this key (production runs on the defaults); staging does.
  group: { required: false, range: 'object, keys and ranges of capabilities/qq/group.js', since: '0.10.0', keys: Object.keys(GROUP) },
});
/** Written by the DSH-era prepare-qq; read by no release since. */
export const LEGACY = Object.freeze(['accessFile', 'inboxFile', 'workerConfigFile', 'workerAuthoritySocket', 'workerTokenFile', 'workerInboxFile']);
/** Defaults of the optional keys. */
export const defaults = Object.freeze({ onebotPort: 3001, contentEnabled: false, initiationPollMs: INITIATION_POLL_MS, stickerSubType: true, pacing: PACING, group: GROUP });

const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const port = value => value === undefined || (Number.isInteger(value) && value > 0 && value < 65536);
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

/** -> { config (unknown and legacy keys taken out), unknown: [field], legacy: [field] }; throws CONFIG_INVALID. */
export function validate(raw) {
  if (!plain(raw)) throw fail('CONFIG_INVALID');
  const unknown = [], legacy = [], config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LEGACY.includes(key)) legacy.push(key);
    else if (!Object.hasOwn(KEYS, key)) unknown.push(fieldName(key));
    else config[key] = value;
  }
  // pacing: only its unknown keys are left out; pacingFrom checks the rest.
  if (plain(config.pacing)) {
    const pacing = {};
    for (const [key, value] of Object.entries(config.pacing)) if (KEYS.pacing.keys.includes(key)) pacing[key] = value; else unknown.push(`pacing.${fieldName(key)}`);
    config.pacing = pacing;
  }
  // group: the same.
  if (plain(config.group)) {
    const group = {};
    for (const [key, value] of Object.entries(config.group)) if (KEYS.group.keys.includes(key)) group[key] = value; else unknown.push(`group.${fieldName(key)}`);
    config.group = group;
  }
  if (!plain(config.authority) || !plain(config.conversation) || !absolute(config.controlSocket) || !absolute(config.onebotTokenFile) || !absolute(config.settingsFile) || !absolute(config.stateFile)
    || typeof config.operatorTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(config.operatorTokenHash) || !port(config.onebotPort)) throw fail('CONFIG_INVALID');
  if (config.initiationPollMs !== undefined && !(Number.isInteger(config.initiationPollMs) && config.initiationPollMs >= 1000 && config.initiationPollMs <= 600000)) throw fail('CONFIG_INVALID');
  if (config.stickerSubType !== undefined && typeof config.stickerSubType !== 'boolean') throw fail('CONFIG_INVALID');
  try { pacingFrom(config.pacing); groupFrom(config.group); } catch { throw fail('CONFIG_INVALID'); }
  return { config, unknown, legacy };
}

/** Reads and checks the file (regular, not a link, owned by this user, 0600-like).
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
  if (unknown.length) warn(`qq-bridge.json: ignoring unknown keys ${unknown.join(', ')}`);
  if (legacy.length) onLegacy(legacy);
  return config;
}
