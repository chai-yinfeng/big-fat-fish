// A generic video source: yt-dlp and ffmpeg as child processes. Nothing here knows any particular site. Which links
// are accepted, which media hosts to avoid and what a site's "blocked" looks like are the operator's, in the data
// root (operator/providers/video.json); this repository and its tests only ever name the MOCK site.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CEILINGS, defaults } from './config.js';

export const fail = code => Object.assign(new Error(code), { code });
export const LIMITS = Object.freeze({
  /** Default bounds of one video and stills of one video the vision model may look at (cached with the video, so per
   * video); `limits` in the operator file may lower or raise them within these ceilings. Both live in ./config.js. */
  ...defaults.limits,
  ceilings: CEILINGS,
  /** yt-dlp's JSON answer and what is kept of a child's stderr (its end; never written to a log as it is). */
  jsonBytes: 2 * 1024 * 1024, stderrBytes: 65536,
  url: 2048,
});
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** operator/providers/video.json: see ./config.js (its `load`, under the name the provider and tests use). */
export { load as loadVideoConfig } from './config.js';

/**
 * The site a link belongs to, or null: the whole link must match one of that site's patterns. `key` names the video
 * itself (site, number, part) when the link carries its number, so a video already known is found without any
 * request; otherwise null and the number comes from the metadata. `dedupe` always names this link's video.
 */
export function matchSite(config, url) {
  if (typeof url !== 'string' || !url || url.length > LIMITS.url || url.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  for (const site of config.sites) for (const pattern of site.patterns) {
    const match = pattern.exec(url);
    if (!match || match[0] !== url) continue;
    const id = match.groups?.id, part = Number(match.groups?.part ?? 1);
    const key = typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && Number.isSafeInteger(part) && part >= 1 && part <= 9999 ? videoKey(site.id, id, part) : null;
    return { site, key, dedupe: key ?? `${site.id}:link:${createHash('sha256').update(url).digest('hex').slice(0, 32)}` };
  }
  return null;
}
export const videoKey = (siteId, id, part = 1) => `${siteId}:${id}${part > 1 ? `:p${part}` : ''}`;

// Every command line is one of these fixed templates. Only generic options are used; the link goes after `--`
// (and was refused above if it begins with `-`), a format is a name yt-dlp itself listed.
const COMMON = ['--ignore-config', '--no-cache-dir', '--no-playlist', '--socket-timeout', '20'];
export const metadataArgs = url => [...COMMON, '--retries', '1', '-J', '--', url];
export const downloadArgs = ({ format, maxFilesizeMiB }) => [...COMMON, '--retries', '2', '--max-filesize', `${maxFilesizeMiB}M`, '--load-info-json', 'info.json', '-f', format, '-o', 'audio.%(ext)s'];
/** The lowest-quality video stream, for stills only (no sound needed). */
export const videoDownloadArgs = ({ format, maxFilesizeMiB }) => [...COMMON, '--retries', '2', '--max-filesize', `${maxFilesizeMiB}M`, '--load-info-json', 'info.json', '-f', format, '-o', 'video.%(ext)s'];
/** Where the picture changes (ffmpeg's scene score over FRAMES.sceneThreshold): the times go to `scenes.txt`, nothing else is written. */
export const sceneArgs = ({ input }) => ['-nostdin', '-v', 'error', '-i', './' + input, '-an', '-sn', '-dn', '-vf', `select=gt(scene\\,${FRAMES.sceneThreshold}),metadata=print:file=scenes.txt`, '-f', 'null', '-'];
/** One still at `seconds`: a JPEG of at most 512x512 for the vision model, and the same picture as 8x8 grey bytes for its hash. */
export const grabArgs = ({ input, seconds, name }) => ['-nostdin', '-v', 'error', '-ss', seconds.toFixed(3), '-i', './' + input, '-an', '-sn', '-dn',
  '-frames:v', '1', '-vf', 'scale=w=512:h=512:force_original_aspect_ratio=decrease', '-q:v', '5', `${name}.jpg`,
  '-frames:v', '1', '-vf', 'scale=8:8:flags=area,format=gray', '-f', 'rawvideo', `${name}.gray`];
export const FRAMES = Object.freeze({ sceneThreshold: 0.3 });
export const convertArgs = ({ input, pieceSeconds }) => ['-nostdin', '-v', 'error', '-i', './' + input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(pieceSeconds), '-reset_timestamps', '1', 'piece-%04d.wav'];

/**
 * How a child is started. In bubblewrap it sees the system runtime and the operator's listed directories read-only,
 * its own work directory as the only writable place (`/work`, also its HOME) and nothing of the data root; the
 * environment is empty but for HOME, PATH and LANG. `network` false also takes the network away (ffmpeg needs none).
 * Without a sandbox (a development machine, or a host where bubblewrap cannot keep the network) the child is an
 * ordinary process of this service with the same environment: it could read what this service can.
 */
export function childCommand(config, { workDir, network }, argv, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const environment = home => ({ HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  if (config.sandbox.kind === 'none') return { command: argv[0], args: argv.slice(1), cwd: workDir, env: environment(workDir) };
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', ...(network ? [] : ['--unshare-net']), '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run'];
  if (exists('/usr/lib64')) args.push('--symlink', 'usr/lib64', '/lib64');
  // The dynamic linker's cache, and Debian's alternatives (links back into /usr: ffmpeg finds libblas through them).
  for (const file of ['/etc/ld.so.cache', '/etc/alternatives']) if (exists(file)) args.push('--ro-bind', file, file);
  // Name resolution and certificates, nothing else of /etc. resolv.conf is often a link into /run: its target is bound.
  if (network) for (const file of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates']) if (exists(file)) args.push('--ro-bind', realpath(file), file);
  for (const directory of config.sandbox.readOnly) args.push('--ro-bind', directory, directory);
  args.push('--bind', workDir, '/work', '--chdir', '/work');
  for (const [key, value] of Object.entries(environment('/work'))) args.push('--setenv', key, value);
  return { command: config.sandbox.bwrap, args: [...args, '--', ...argv], cwd: workDir, env: {} };
}

/**
 * Runs one child to its end. -> `{ code, stdout, stderr }` (stdout whole, at most `stdoutBytes`, else `too_much_output`;
 * `stdoutBytes: 0` reads and drops it, for a child whose stdout is only progress; stderr only its last LIMITS.stderrBytes). The whole process group is killed when `signal` aborts, and the
 * rejection is then the signal's reason.
 */
export function runChild({ command, args, cwd, env }, { signal, stdoutBytes = 65536, spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch { reject(fail('not_configured')); return; }
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const chunks = []; let size = 0, overflow = false, stderr = Buffer.alloc(0);
    child.stdout.on('data', chunk => { if (!stdoutBytes) return; size += chunk.length; if (size > stdoutBytes) { overflow = true; chunks.length = 0; kill(); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-LIMITS.stderrBytes); });
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => { signal?.removeEventListener('abort', onAbort); reject(fail('not_configured')); });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (overflow) reject(fail('too_much_output'));
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

/** Why yt-dlp failed, as one of the fixed codes, from the operator's descriptions of that site's refusals. */
export function refusalCode(site, stderr) {
  for (const [code, key] of [['blocked', 'blocked'], ['login_required', 'loginRequired'], ['unavailable', 'unavailable']]) if (site[key].some(pattern => pattern.test(stderr))) return code;
  return 'failed';
}

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
/** What is kept of yt-dlp's metadata (all of it external text, bounded here and cleaned where it is rendered). */
export function metadataOf(info) {
  if (!plainObject(info)) throw fail('failed');
  const duration = Number(info.duration);
  // No length (a live stream, a page that is not one video): not something to listen to from start to end.
  if (info.is_live === true || !Number.isFinite(duration) || duration <= 0) throw fail('unavailable');
  const chapters = (Array.isArray(info.chapters) ? info.chapters : []).slice(0, 40).flatMap(chapter => Number.isFinite(chapter?.start_time) && Number.isFinite(chapter?.end_time) ? [{ startMs: Math.round(chapter.start_time * 1000), endMs: Math.round(chapter.end_time * 1000), title: text(chapter.title, 80) }] : []);
  return {
    id: typeof info.id === 'string' && /^[A-Za-z0-9_.-]{1,96}$/.test(info.id) ? info.id : null,
    title: text(info.title, 300), uploader: text(info.uploader, 120) || text(info.channel, 120), durationMs: Math.round(duration * 1000),
    uploadDate: /^\d{8}$/.test(info.upload_date ?? '') ? info.upload_date : '', description: text(info.description, 1200),
    tags: (Array.isArray(info.tags) ? info.tags : []).filter(tag => typeof tag === 'string' && tag).slice(0, 16).map(tag => tag.slice(0, 40)), chapters,
  };
}
/**
 * The format to download for listening: the audio-only one with the lowest bitrate whose media host is not one the
 * operator said to skip; without any audio-only format, the smallest format that has sound. Null when there is none.
 */
export function audioFormat(info, site) {
  const host = format => { try { return new URL(format.url).hostname.toLowerCase(); } catch { return ''; } };
  const usable = (Array.isArray(info?.formats) ? info.formats : []).filter(format => plainObject(format) && typeof format.format_id === 'string' && /^[A-Za-z0-9_.+-]{1,64}$/.test(format.format_id) && !format.format_id.startsWith('-')
    && typeof format.acodec === 'string' && format.acodec !== 'none' && !site.skipHosts.includes(host(format)));
  const rate = format => [format.abr, format.tbr].find(value => Number.isFinite(value) && value > 0) ?? Infinity;
  const audioOnly = usable.filter(format => format.vcodec === 'none').sort((a, b) => rate(a) - rate(b));
  return (audioOnly[0] ?? usable.sort((a, b) => rate(a) - rate(b))[0])?.format_id ?? null;
}
/**
 * The format to download for stills: the video stream with the fewest lines (then the lowest bitrate) whose media host
 * is not one the operator said to skip; sound does not matter. Null when there is none.
 */
export function videoFormat(info, site) {
  const host = format => { try { return new URL(format.url).hostname.toLowerCase(); } catch { return ''; } };
  const usable = (Array.isArray(info?.formats) ? info.formats : []).filter(format => plainObject(format) && typeof format.format_id === 'string' && /^[A-Za-z0-9_.+-]{1,64}$/.test(format.format_id) && !format.format_id.startsWith('-')
    && typeof format.vcodec === 'string' && format.vcodec !== 'none' && format.ext !== 'mhtml' && !site.skipHosts.includes(host(format)));
  const lines = format => Number.isFinite(format.height) && format.height >= 100 ? format.height : Infinity;
  const rate = format => [format.tbr, format.vbr].find(value => Number.isFinite(value) && value > 0) ?? Infinity;
  return usable.sort((a, b) => lines(a) - lines(b) || rate(a) - rate(b))[0]?.format_id ?? null;
}
