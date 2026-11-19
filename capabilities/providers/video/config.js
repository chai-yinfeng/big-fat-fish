// operator/providers/video.json: the one place its keys and checks live. The video provider (through source.js
// loadVideoConfig) and the deploy preflight both call `load`. Unknown keys: the preflight refuses them (`strict`); at
// run time they are ignored with one warning, so a release rolled back to keeps watching videos on a file a newer
// release wrote. Any other problem: VIDEO_CONFIG (the capability is then off; the preflight refuses the deploy).
import fs from 'node:fs';
import path from 'node:path';

const SITE_KEYS = ['id', 'patterns', 'skipHosts', 'blocked', 'loginRequired', 'unavailable'];
const SANDBOX_KEYS = ['kind', 'bwrap', 'readOnly'];
/** Highest value of each `limits` entry. */
export const CEILINGS = Object.freeze({ maxDurationSeconds: 4 * 3600, maxFilesizeMiB: 2048, pieceSeconds: 500, framesPerVideo: 6 });
/** Defaults of the optional keys: the bounds of one video and the stills of one video the vision model may look at. */
export const defaults = Object.freeze({ limits: Object.freeze({ maxDurationSeconds: 3600, maxFilesizeMiB: 300, pieceSeconds: 120, framesPerVideo: 3 }) });

/** Every key this release reads. `since`: every release so far carries package version 0.10.0. */
export const KEYS = Object.freeze({
  schemaVersion: { required: true, range: '1', since: '0.10.0' },
  ytdlp: { required: true, range: '[absolute executable, ...fixed arguments], at most 8 strings', since: '0.10.0' },
  ffmpeg: { required: true, range: '[absolute executable, ...fixed arguments], at most 8 strings', since: '0.10.0' },
  sandbox: { required: true, range: "{ kind: 'none' } | { kind: 'bwrap', bwrap: absolute, readOnly?: [absolute] }", since: '0.10.0', keys: SANDBOX_KEYS },
  sites: { required: true, range: '1..8 sites { id, patterns: [^https://...], skipHosts?, blocked?, loginRequired?, unavailable? }', since: '0.10.0', keys: SITE_KEYS },
  limits: { required: false, range: Object.entries(CEILINGS).map(([key, max]) => `${key} 1..${max}`).join(', '), since: '0.10.0', keys: Object.keys(CEILINGS) },
});

const fail = (code, fields) => Object.assign(new Error(code), { code, ...(fields ? { fields } : {}) });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const strings = (value, max, each = 256) => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= each);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';
/** The entries of `value` whose key is in `known`; the others are named in `unknown` under `prefix`. */
function known(value, keys, prefix, unknown) {
  const kept = {};
  for (const [key, item] of Object.entries(value)) if (keys.includes(key)) kept[key] = item; else unknown.push(prefix + fieldName(key));
  return kept;
}

/**
 * `{ schemaVersion: 1, ytdlp: [executable, ...fixed arguments], ffmpeg: [executable, ...],
 *    sandbox: { kind: 'bwrap', bwrap, readOnly: [path...] } | { kind: 'none' },
 *    sites: [{ id, patterns: ['^https://…'], skipHosts?, blocked?, loginRequired?, unavailable? }],
 *    limits?: { maxDurationSeconds?, maxFilesizeMiB?, pieceSeconds?, framesPerVideo? } }`
 * A pattern is a regular expression a whole link must match, beginning `^https://`; its named group `id` (and
 * optionally `part`) is the video's own number, when the link carries it. `skipHosts` are media hosts never
 * downloaded from; the three lists of expressions say how that site's refusals look in yt-dlp's error output.
 * -> { config (patterns compiled, limits filled in), unknown: [field] }; throws VIDEO_CONFIG.
 */
export function validate(c) {
  const unknown = [];
  if (!plainObject(c)) throw fail('VIDEO_CONFIG');
  c = known(c, Object.keys(KEYS), '', unknown);
  if (c.schemaVersion !== 1) throw fail('VIDEO_CONFIG');
  for (const key of ['ytdlp', 'ffmpeg']) if (!strings(c[key], 8, 1024) || !c[key].length || !absolute(c[key][0])) throw fail('VIDEO_CONFIG');
  if (!plainObject(c.sandbox)) throw fail('VIDEO_CONFIG');
  const sandbox = known(c.sandbox, SANDBOX_KEYS, 'sandbox.', unknown);
  if (!(sandbox.kind === 'none' && Object.keys(sandbox).length === 1 || sandbox.kind === 'bwrap' && absolute(sandbox.bwrap) && strings(sandbox.readOnly ?? [], 16, 1024) && (sandbox.readOnly ?? []).every(absolute))) throw fail('VIDEO_CONFIG');
  if (!Array.isArray(c.sites) || !c.sites.length || c.sites.length > 8) throw fail('VIDEO_CONFIG');
  const sites = c.sites.map((site, index) => {
    if (!plainObject(site)) throw fail('VIDEO_CONFIG');
    site = known(site, SITE_KEYS, `sites.${index}.`, unknown);
    if (typeof site.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(site.id) || !strings(site.patterns, 8, 512) || !site.patterns.length || site.patterns.some(pattern => !pattern.startsWith('^https://'))) throw fail('VIDEO_CONFIG');
    for (const key of ['skipHosts', 'blocked', 'loginRequired', 'unavailable']) if (site[key] !== undefined && !strings(site[key], 16)) throw fail('VIDEO_CONFIG');
    const compiled = list => (list ?? []).map(pattern => { try { return new RegExp(pattern, 'u'); } catch { throw fail('VIDEO_CONFIG'); } });
    return { id: site.id, patterns: compiled(site.patterns), skipHosts: (site.skipHosts ?? []).map(host => host.toLowerCase()), blocked: compiled(site.blocked), loginRequired: compiled(site.loginRequired), unavailable: compiled(site.unavailable) };
  });
  if (new Set(sites.map(site => site.id)).size !== sites.length) throw fail('VIDEO_CONFIG');
  if (c.limits !== undefined && !plainObject(c.limits)) throw fail('VIDEO_CONFIG');
  const given = c.limits === undefined ? {} : known(c.limits, Object.keys(CEILINGS), 'limits.', unknown), limits = {};
  for (const key of Object.keys(CEILINGS)) {
    const value = given[key] ?? defaults.limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > CEILINGS[key]) throw fail('VIDEO_CONFIG');
    limits[key] = value;
  }
  return { config: { ytdlp: c.ytdlp, ffmpeg: c.ffmpeg, sandbox: sandbox.kind === 'none' ? { kind: 'none' } : { kind: 'bwrap', bwrap: sandbox.bwrap, readOnly: sandbox.readOnly ?? [] }, sites, limits }, unknown };
}

/** The checked config, or null when the operator has not written the file (the capability is then off). The file
 * must be regular, not a link, at most 64 KiB and not readable by others.
 * `strict` (the preflight): an unknown key throws CONFIG_UNKNOWN_KEY with `fields`. Otherwise it is left out and
 * `warn` gets one line naming the keys (never values). */
export function load(file, { strict = false, warn = line => process.stderr.write(line + '\n') } = {}) {
  if (!absolute(file)) throw fail('VIDEO_CONFIG');
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw fail('VIDEO_CONFIG'); }
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0) throw fail('VIDEO_CONFIG');
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('VIDEO_CONFIG'); }
  const { config, unknown } = validate(raw);
  if (unknown.length && strict) throw fail('CONFIG_UNKNOWN_KEY', unknown);
  if (unknown.length) warn(`providers/video.json: ignoring unknown keys ${unknown.join(', ')}`);
  return config;
}
