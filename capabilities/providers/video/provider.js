// "Watch" a video somebody shared as a link (run by the content service; declared in ./manifest.js).
// A new video is a background job: metadata -> audio -> 16 kHz pieces -> local speech recognition, piece by piece
// with their offsets -> a summary by the model -> a note. A video already in the cache is answered at once.
// Stills (`frames`, a job of its own; or inside `watch` when the video has no usable voice): the lowest-quality video
// stream -> where the scene changes -> the middles of the longest shots, near-duplicates dropped (./frames.js) -> each
// still described by the vision model (`purpose: 'frame'`) -> added to the cached note.
//
// What is kept:
// - The cache (`cacheRoot`, one JSON per video, seven days): metadata, timed transcript, summary, the note. It is
//   about the video only and never holds who shared it, so one cache serves everybody.
// - A note reference per share, in the media store, bound to the conversation and to the message that shared the
//   link: forgetting that message removes the reference by the store's existing rule; the public cache entry stays.
// - Media files only while they are worked on: each job has one work directory, removed however the job ends, and
//   every leftover one is removed when the service starts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NOTE, TIMED, tooLittleSpeech, sectionsOf, pagesOf, summaryRequests, mergeRequest, parseSummary, renderNote, mergeFrames, framesText, FRAME_QUESTION } from './note.js';
import { fail, LIMITS, loadVideoConfig, matchSite, videoKey, metadataArgs, subtitleArgs, cookieArgs, cookieState, copyCookies, subtitleFile, parseSrt, SUBTITLES, downloadArgs, videoDownloadArgs, convertArgs, sceneArgs, grabArgs, childCommand, runChild, refusalCode, metadataOf, audioFormat, videoFormat } from './source.js';
import { sceneCuts, candidateTimes, averageHash, nearlySame } from './frames.js';

export const VIDEO = Object.freeze({
  /** Stage limits (the waits before a slice do not count; the job's overall deadline does). */
  metadataMs: 60000, subtitlesMs: 60000, downloadMs: 10 * 60000, convertMs: 3 * 60000, summaryMs: 2 * 60000,
  /** Transcription may take this many times the audio's length, plus a fixed allowance for starting the recognizer. */
  transcribeFactor: 1.5, transcribeBaseMs: 2 * 60000,
  deadlineMs: 3 * 3600000,
  cacheTtlMs: 7 * 86400000,
  /** A note made without the recognizer (not installed, or it failed) is kept only this long: the video is listened
   * to on a later share instead of being answered from the cache for a week. */
  unheardTtlMs: 3600000,
  /** Output cap of one summary request. */
  summaryTokens: 900,
  /** Stills: finding the cuts may take this plus this share of the video's length; taking and describing them, these. */
  sceneBaseMs: 2 * 60000, sceneFactor: 0.2, stillsMs: 2 * 60000, lookMs: 4 * 60000,
  /** The largest still sent to the vision model (ffmpeg scales it to 512x512 at most; a JPEG of that is far smaller). */
  stillBytes: 1024 * 1024,
});
const NOTE_MIME = 'application/vnd.companion.video-note+json';
const WORK_PREFIX = 'video-job-';
const derived = value => ({ ...value, derived: true, isNewEvidence: false, isVerbatimUserText: false });
const refused = code => derived({ status: 'failed', code });
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const JPEG = Buffer.from([255, 216, 255]);
/** A regular file in the work directory of at most `max` bytes, or null. */
const small = (file, max) => { try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size <= max ? fs.readFileSync(file) : null; } catch { return null; } };

/**
 * `store`: the media ArtifactStore. `speech`: the local speech runner. `summarize({ messages, maxTokens, signal })`
 * -> `{ content }`: one model completion through the gateway (it throws when the spend tier refuses or the call
 * fails; the note is then filed without a summary). `describeFrame({ imageBase64, mime, question, signal })` ->
 * `{ description }`: one still looked at through the gateway's vision route marked `purpose: 'frame'` (rejects with
 * CONTENT_BUDGET_EXHAUSTED or CONTENT_SPEND_RESTRICTED when the day's stills or the spend tier refuse it; absent: no
 * stills). `jobs()`: the background jobs (resolved late: they are created with this provider's runners). `workRoot`
 * must be inside one of the speech runner's input roots. `cookieFile` (optional): the operator's cookies
 * (operator/secrets/video-cookies.txt); while it is usable each job works with its own copy (./source.js copyCookies).
 */
export function createVideoProvider({ configFile, cookieFile, cacheRoot, workRoot, store, speech, summarize, describeFrame, jobs, spawn, clock = Date.now, log = line => process.stderr.write(line + '\n') }) {
  for (const directory of [cacheRoot, workRoot]) {
    if (!path.isAbsolute(directory)) throw fail('VIDEO_CONFIG');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw fail('VIDEO_CONFIG');
  }
  // An unreadable operator file turns the capability off (and says so once); it never stops the content service.
  // Unknown keys (from a newer release) are left out and named once.
  let complained = false, warned = false;
  const warn = line => { if (!warned) { warned = true; log(line); } };
  const config = () => { try { return loadVideoConfig(configFile, { warn }); } catch { if (!complained) { complained = true; log('VIDEO_CONFIG_INVALID operator/providers/video.json is not usable; watching videos is off.'); } return null; } };
  const cacheFile = key => path.join(cacheRoot, createHash('sha256').update(key).digest('hex') + '.json');
  const blockedFile = site => path.join(cacheRoot, `blocked-${createHash('sha256').update(site).digest('hex').slice(0, 16)}.json`);
  const writeJson = (file, value) => { const temporary = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); };
  // How the cookies last fared (times only, never anything of the cookies): the last subtitle run with them that showed
  // no sign of being signed out, and the last run with them whose output matched the site's `loginRequired`.
  const cookieStateFile = path.join(cacheRoot, 'cookie-state.json');
  const cookieRecord = () => { try { const value = JSON.parse(fs.readFileSync(cookieStateFile, 'utf8')); return { lastSuccessAt: Number.isSafeInteger(value?.lastSuccessAt) ? value.lastSuccessAt : null, suspectedAt: Number.isSafeInteger(value?.suspectedAt) ? value.suspectedAt : null }; } catch { return { lastSuccessAt: null, suspectedAt: null }; } };
  let cookieComplained = false;
  /** This job's copy of the cookies, when the operator's file is usable (said once in the log when it is not). */
  function jobCookies(workDir) {
    if (!cookieFile) return false;
    const state = copyCookies(cookieFile, workDir);
    if ((state === 'unsafe' || state === 'invalid') && !cookieComplained) { cookieComplained = true; log(`VIDEO_COOKIES_${state.toUpperCase()} operator/secrets/video-cookies.txt is not used (it must be a regular file of this service's user, mode 0600).`); }
    return state === 'configured';
  }
  function cached(key) {
    try {
      const entry = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
      return entry?.schema === 1 && entry.key === key && entry.expiresAt > clock() && typeof entry.note === 'string' && Array.isArray(entry.pages) ? entry : null;
    } catch { return null; }
  }
  /** This share's own reference to a cached note, in the conversation and under the message that shared the link. The
   * link itself is kept here (it may carry the sharer's share parameters), never in the public cache: `frames` needs it. */
  const fileNote = (scope, sourceEventId, entry, url) => store.put({ scope, sourceEventId, kind: 'note', mime: NOTE_MIME, data: Buffer.from(JSON.stringify({ key: entry.key, url })) }).id;
  /** This conversation's newest share: its reference, the cached entry it points at and the link, or nulls. */
  function lastShare(scope) {
    const reference = store.latest(scope, 'note');
    if (!reference) return { reference: null, entry: null, url: null };
    try {
      const data = JSON.parse(store.read(reference.id, scope).data.toString('utf8'));
      return { reference, entry: cached(data.key), url: typeof data.url === 'string' ? data.url : null };
    } catch { return { reference, entry: null, url: null }; }
  }

  /** One yt-dlp run, with this job's copy of the cookies when it has one. -> `{ code, stdout, stderr }`. A run with the
   * cookies whose output looks signed out (the site's `loginRequired`) marks them as perhaps expired; a subtitle run
   * with them that does not is their last success. */
  async function ytRun(configNow, site, workDir, args, { signal, stdoutBytes, cookies = false, subtitles = false }) {
    const result = await runChild(childCommand(configNow, { workDir, network: true }, [...configNow.ytdlp, ...cookieArgs(cookies), ...args]), { signal, stdoutBytes, spawn });
    if (cookies) {
      const signedOut = site.loginRequired.some(pattern => pattern.test(result.stderr));
      if (signedOut || subtitles && result.code === 0) writeJson(cookieStateFile, { schema: 1, ...cookieRecord(), ...(signedOut ? { suspectedAt: clock() } : { lastSuccessAt: clock() }) });
    }
    return result;
  }
  /** A site's refusal, as the job's fixed code; "blocked" is remembered first. */
  function siteRefusal(site, stderr) {
    const code = refusalCode(site, stderr);
    // Blocked by the site: remembered, so nothing more is asked of it until the operator has looked (the file is
    // removed by hand; no retry, no change of address or identity). Nothing of yt-dlp's own output is logged.
    if (code === 'blocked') { writeJson(blockedFile(site.id), { schema: 1, site: site.id, at: clock() }); log(`VIDEO_BLOCKED ${site.id}: watching is stopped for this site until the operator clears it.`); }
    return code;
  }
  /** One yt-dlp run that must succeed. `stdoutBytes: 0` for a download: what it prints there is progress, however long that gets. */
  async function yt(configNow, site, workDir, args, options) {
    const result = await ytRun(configNow, site, workDir, args, options);
    if (result.code === 0) return result.stdout;
    throw fail(siteRefusal(site, result.stderr));
  }
  /**
   * The platform's own subtitles (only with the cookies: the site gives them to a signed-in client). -> `{ segments,
   * kind }`, or null when there are none to use: the audio is then listened to as before. Only "blocked" ends the job.
   */
  async function subtitles(configNow, site, workDir, url, stage, outer) {
    let result;
    try { result = await stage('subtitles', VIDEO.subtitlesMs, step => step.slice(inner => ytRun(configNow, site, workDir, subtitleArgs(url), { signal: inner, stdoutBytes: 0, cookies: true, subtitles: true }))); }
    catch (error) { if (outer.aborted || error?.code !== 'timeout') throw error; log('VIDEO_SUBTITLES_SKIPPED timeout'); return null; }
    const names = fs.readdirSync(workDir), chosen = subtitleFile(names);
    try {
      if (result.code !== 0 && siteRefusal(site, result.stderr) === 'blocked') throw fail('blocked');
      if (!chosen) return null;
      const segments = parseSrt(small(path.join(workDir, chosen.name), SUBTITLES.fileBytes)?.toString('utf8') ?? '');
      return segments.length ? { segments, kind: chosen.kind } : null;
    } finally { for (const name of names) if (name.startsWith('subs.')) fs.rmSync(path.join(workDir, name), { force: true }); }
  }

  /** Listens to the downloaded audio: pieces of at most `pieceSeconds`, one recognizer run a piece (a slice each, so a
   * request somebody is waiting for goes first), times shifted by where the piece starts. */
  async function transcribe(configNow, workDir, meta, pieceSeconds, stage) {
    const audio = fs.readdirSync(workDir).find(name => /^audio\.[A-Za-z0-9]{1,8}$/.test(name) && fs.lstatSync(path.join(workDir, name)).isFile());
    // yt-dlp skips a file over --max-filesize without an error.
    if (!audio) throw fail('too_large');
    await stage('convert', VIDEO.convertMs, step => step.slice(async signal => {
      const result = await runChild(childCommand(configNow, { workDir, network: false }, [...configNow.ffmpeg, ...convertArgs({ input: audio, pieceSeconds })]), { signal, spawn });
      if (result.code !== 0) throw fail('failed');
    }));
    fs.rmSync(path.join(workDir, audio));
    const pieces = fs.readdirSync(workDir).filter(name => /^piece-\d{4}\.wav$/.test(name) && fs.lstatSync(path.join(workDir, name)).isFile()).sort();
    if (!pieces.length) throw fail('failed');
    const segments = []; let offset = 0, speechMs = 0, engine = '';
    await stage('transcribe', Math.round(meta.durationMs * VIDEO.transcribeFactor) + VIDEO.transcribeBaseMs, async step => {
      for (const [index, name] of pieces.entries()) {
        const piece = path.join(workDir, name);
        const heard = await step.slice(signal => speech.transcribe({ inputFile: piece, segments: true, signal }));
        // A piece the voice detector found no voice in contributes nothing, whatever the recognizer wrote for it
        // (a short piece is decoded in one pass without the detector, and recognizers caption music).
        if (heard.speechMs > 0) for (const segment of heard.segments) segments.push({ startMs: offset + segment.startMs, endMs: offset + segment.endMs, text: segment.text });
        offset += heard.durationMs; speechMs += heard.speechMs; engine = heard.model;
        fs.rmSync(piece);
        step.progress((index + 1) / pieces.length * 100);
      }
    });
    return { segments, speechMs, engine };
  }

  /** The model's summary of the sections, or null (refused by the spend tier, failed, or not the JSON asked for). */
  async function summarized(meta, sections, stage, outer) {
    const requests = summaryRequests({ meta, sections });
    if (!requests.length) return null;
    try {
      return await stage('summary', VIDEO.summaryMs, async step => {
        const parts = [];
        for (const request of requests) {
          const answer = parseSummary((await step.slice(signal => summarize({ messages: request.messages, maxTokens: VIDEO.summaryTokens, signal }))).content, request.numbers);
          if (!answer) return null;
          parts.push(answer);
        }
        let overall = parts[0].summary;
        if (parts.length > 1) {
          const merged = parseSummary((await step.slice(signal => summarize({ messages: mergeRequest(parts.map(part => part.summary)), maxTokens: 400, signal }))).content);
          if (!merged) return null;
          overall = merged.summary;
        }
        return { overall, sections: parts.flatMap(part => part.sections) };
      });
    } catch (error) {
      // The job being stopped (pause, cancel, deadline, shutdown) is not a summary that failed.
      if (outer.aborted) throw error;
      return null;
    }
  }

  async function watch({ input, signal, stage, scope, source: asked }) {
    const configNow = config(), matched = configNow && matchSite(configNow, input.url);
    if (!matched) throw fail('not_configured');
    const { site } = matched;
    if (!source(asked?.sourceEventId)) throw fail('failed');
    // Somebody else's share of the same video may have finished while this one waited.
    const ready = matched.key && cached(matched.key);
    if (ready) { fileNote(scope, asked.sourceEventId, ready, input.url); return { text: ready.note }; }
    const workDir = fs.mkdtempSync(path.join(workRoot, WORK_PREFIX));
    try {
      const cookies = jobCookies(workDir);
      const raw = await stage('metadata', VIDEO.metadataMs, step => step.slice(inner => yt(configNow, site, workDir, metadataArgs(input.url), { signal: inner, stdoutBytes: LIMITS.jsonBytes, cookies })));
      let info; try { info = JSON.parse(raw); } catch { throw fail('failed'); }
      const meta = metadataOf(info), key = matched.key ?? (meta.id ? videoKey(site.id, meta.id) : null);
      if (!key) throw fail('failed');
      // The link did not carry the video's number: only now is it known whether this video is already in the cache.
      const known = cached(key);
      if (known) { fileNote(scope, asked.sourceEventId, known, input.url); return { text: known.note }; }
      if (meta.durationMs > configNow.limits.maxDurationSeconds * 1000) throw fail('too_long');
      let heard = null, state = 'unavailable';
      // The platform's subtitles first, when there are cookies to ask with; without them (or any) the audio is listened to.
      const written = cookies ? await subtitles(configNow, site, workDir, input.url, stage, signal) : null;
      if (written) { heard = { segments: written.segments }; state = `subtitle_${written.kind}`; }
      // Without a usable recognizer nothing is downloaded: the note then has the title and the description only.
      const status = written ? null : speech.status(), longest = status?.longAudio?.vadPresent === true && status.models?.['asr:default']?.componentsPresent === true && status.models['asr:default'].enabled !== false ? status.longAudio.maxAudioSeconds : 0;
      const format = audioFormat(info, site);
      if (!written && longest >= 10 && format) {
        fs.writeFileSync(path.join(workDir, 'info.json'), raw, { mode: 0o600 });
        await stage('download', VIDEO.downloadMs, step => step.slice(inner => yt(configNow, site, workDir, downloadArgs({ format, maxFilesizeMiB: configNow.limits.maxFilesizeMiB }), { signal: inner, stdoutBytes: 0, cookies })));
        fs.rmSync(path.join(workDir, 'info.json'), { force: true });
        try {
          // Two seconds under the recognizer's own limit: a piece is cut at a packet, not at the exact second.
          heard = await transcribe(configNow, workDir, meta, Math.max(8, Math.min(configNow.limits.pieceSeconds, Math.floor(longest) - 2)), stage);
          state = tooLittleSpeech(heard.speechMs, meta.durationMs) || !heard.segments.length ? 'empty_unconfirmed' : 'asr';
        } catch (error) {
          // The recognizer failing is not the video failing: she still gets the title and the description.
          if (signal.aborted || !String(error?.code).startsWith('SPEECH_')) throw error;
          if (error.code === 'SPEECH_TIMEOUT') throw fail('timeout');
          log(`VIDEO_TRANSCRIBE_FAILED ${error.code}`);
        }
      }
      signal.throwIfAborted();
      // Too little voice: whatever the recognizer wrote is dropped, not kept "just in case".
      const timed = TIMED.includes(state), segments = timed ? heard.segments : [];
      const sections = sectionsOf({ durationMs: meta.durationMs, chapters: meta.chapters, segments }), pages = pagesOf(segments, written ? '平台字幕' : '机器转写');
      const summary = timed ? await summarized(meta, sections, stage, signal) : null;
      const { id: _id, chapters: _chapters, ...described } = meta;
      let note = renderNote({ meta: described, source: state, engine: heard?.engine, sections, summary, pages: pages.length });
      // No usable voice: the picture is all there is to go on, so a few stills are looked at without being asked.
      // Whatever stops them (no video stream, the day's stills used up, the spend tier) leaves the note as it is.
      let frames = null;
      if (state === 'empty_unconfirmed' && describeFrame) {
        try {
          const looked = await stills({ configNow, site, workDir, raw, info, meta, stage, cookies });
          if (looked.frames.length) { frames = looked.frames; note = mergeFrames(note, frames); }
          else log(`VIDEO_FRAMES_SKIPPED ${looked.refusal ?? 'failed'}`);
        } catch (error) {
          if (signal.aborted || error?.code === 'timeout') throw error;
          log(`VIDEO_FRAMES_SKIPPED ${/^[a-z_]{1,32}$/.test(error?.code ?? '') ? error.code : 'failed'}`);
        }
      }
      const now = clock(), entry = { schema: 1, key, site: site.id, fetchedAt: now, expiresAt: now + (state === 'unavailable' ? VIDEO.unheardTtlMs : VIDEO.cacheTtlMs), meta: described, source: state, engine: state === 'asr' ? heard.engine : null, summarized: Boolean(summary), note, pages, ...(frames ? { frames } : {}) };
      writeJson(cacheFile(key), entry);
      fileNote(scope, asked.sourceEventId, entry, input.url);
      return { text: note };
    } finally { removeWork(workDir); }
  }
  /**
   * A few stills of the video, each described by the vision model. -> `{ frames: [{ atMs, text }], refusal }`, frames
   * in time order (empty when none could be looked at; `refusal` then says why: `daily_limit`, `spend_tier`).
   * At most `framesPerVideo` are looked at; they are cached with the video, so that is all one video ever costs.
   */
  async function stills({ configNow, site, workDir, raw, info, meta, stage, cookies = false }) {
    const format = videoFormat(info, site), wanted = configNow.limits.framesPerVideo;
    if (!format) throw fail('unavailable');
    fs.writeFileSync(path.join(workDir, 'info.json'), raw, { mode: 0o600 });
    await stage('video', VIDEO.downloadMs, step => step.slice(inner => yt(configNow, site, workDir, videoDownloadArgs({ format, maxFilesizeMiB: configNow.limits.maxFilesizeMiB }), { signal: inner, stdoutBytes: 0, cookies })));
    fs.rmSync(path.join(workDir, 'info.json'), { force: true });
    const video = fs.readdirSync(workDir).find(name => /^video\.[A-Za-z0-9]{1,8}$/.test(name) && fs.lstatSync(path.join(workDir, name)).isFile());
    if (!video) throw fail('too_large');
    const ffmpeg = (args, signal) => runChild(childCommand(configNow, { workDir, network: false }, [...configNow.ffmpeg, ...args]), { signal, spawn });
    await stage('scenes', VIDEO.sceneBaseMs + Math.round(meta.durationMs * VIDEO.sceneFactor), step => step.slice(async signal => { if ((await ffmpeg(sceneArgs({ input: video }), signal)).code !== 0) throw fail('failed'); }));
    const times = candidateTimes({ cuts: sceneCuts(small(path.join(workDir, 'scenes.txt'), 1024 * 1024)?.toString('utf8') ?? ''), durationMs: meta.durationMs, wanted });
    const kept = [];
    await stage('stills', VIDEO.stillsMs, async step => {
      for (const [index, seconds] of times.entries()) {
        if (kept.length >= wanted) break;
        const name = `frame-${String(index).padStart(2, '0')}`;
        const result = await step.slice(signal => ffmpeg(grabArgs({ input: video, seconds, name }), signal));
        const image = small(path.join(workDir, name + '.jpg'), VIDEO.stillBytes), hash = averageHash(small(path.join(workDir, name + '.gray'), 64));
        for (const suffix of ['.jpg', '.gray']) fs.rmSync(path.join(workDir, name + suffix), { force: true });
        if (result.code !== 0 || !image || !image.subarray(0, 3).equals(JPEG) || !hash || kept.some(still => nearlySame(still.hash, hash))) continue;
        kept.push({ atMs: Math.round(seconds * 1000), hash, image });
        step.progress(kept.length / wanted * 100);
      }
    });
    fs.rmSync(path.join(workDir, video));
    if (!kept.length) throw fail('failed');
    const frames = []; let refusal = null;
    await stage('look', VIDEO.lookMs, async step => {
      for (const still of kept.sort((a, b) => a.atMs - b.atMs)) {
        try {
          const answer = await step.slice(signal => describeFrame({ imageBase64: still.image.toString('base64'), mime: 'image/jpeg', question: FRAME_QUESTION, signal }));
          if (typeof answer?.description === 'string' && answer.description.trim()) frames.push({ atMs: still.atMs, text: answer.description.trim().slice(0, 400) });
        } catch (error) {
          if (error?.code === 'timeout') throw error;
          if (error?.code === 'CONTENT_BUDGET_EXHAUSTED' || error?.code === 'CONTENT_SPEND_RESTRICTED') { refusal = error.code === 'CONTENT_BUDGET_EXHAUSTED' ? 'daily_limit' : 'spend_tier'; break; }
          if (!String(error?.code ?? '').startsWith('CONTENT_')) throw error;
        }
        step.progress(frames.length / kept.length * 100);
      }
    });
    return { frames, refusal };
  }

  /** The `frames` job: stills of a video this conversation watched (its link from this share's own reference). */
  async function frames({ input, signal, stage }) {
    const configNow = config(), matched = configNow && matchSite(configNow, input.url);
    if (!matched) throw fail('not_configured');
    const entry = cached(input.key);
    if (!entry) throw fail('unavailable');
    if (entry.frames) return { text: framesText(entry) };
    if (!describeFrame) throw fail('not_configured');
    if (fs.existsSync(blockedFile(matched.site.id))) throw fail('blocked');
    const workDir = fs.mkdtempSync(path.join(workRoot, WORK_PREFIX));
    try {
      const cookies = jobCookies(workDir);
      const raw = await stage('metadata', VIDEO.metadataMs, step => step.slice(inner => yt(configNow, matched.site, workDir, metadataArgs(input.url), { signal: inner, stdoutBytes: LIMITS.jsonBytes, cookies })));
      let info; try { info = JSON.parse(raw); } catch { throw fail('failed'); }
      const meta = metadataOf(info);
      // The link must still be the same video the note is about.
      if ((matched.key ?? (meta.id ? videoKey(matched.site.id, meta.id) : null)) !== input.key) throw fail('failed');
      const looked = await stills({ configNow, site: matched.site, workDir, raw, info, meta, stage, cookies });
      if (!looked.frames.length) throw fail(looked.refusal ?? 'failed');
      signal.throwIfAborted();
      const current = cached(input.key) ?? entry, next = { ...current, frames: looked.frames, note: mergeFrames(current.note, looked.frames) };
      writeJson(cacheFile(input.key), next);
      return { text: framesText(next) };
    } finally { removeWork(workDir); }
  }
  function removeWork(directory) {
    if (path.dirname(directory) !== workRoot || !path.basename(directory).startsWith(WORK_PREFIX) || !fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return;
    fs.rmSync(directory, { recursive: true, force: true });
  }

  return {
    /** The background job (capabilities/media/jobs.js). */
    runner: {
      title: '看视频', action: 'watch', priority: 'yielding', deadlineMs: VIDEO.deadlineMs,
      input(raw) {
        const configNow = config(), matched = configNow && raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key => key === 'url') ? matchSite(configNow, raw.url) : null;
        if (!matched) throw fail('MEDIA_INPUT_INVALID');
        return { url: raw.url, dedupe: matched.dedupe };
      },
      dedupe: input => input.dedupe,
      run: watch,
    },
    /** The stills job (`frames`). It takes no slot of the day's videos: each still takes one of the `video-frame` row's
     * at the gateway, and the job reports nothing of its own. */
    framesRunner: {
      title: '看视频画面', action: 'frames', priority: 'yielding', deadlineMs: VIDEO.deadlineMs, ledger: false,
      input(raw) {
        const configNow = config(), ok = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).sort().join() === 'key,url' && typeof raw.key === 'string' && raw.key.length <= 256;
        if (!ok || !configNow || !matchSite(configNow, raw.url)) throw fail('MEDIA_INPUT_INVALID');
        return { url: raw.url, key: raw.key };
      },
      dedupe: input => 'frames:' + input.key,
      run: frames,
    },
    /**
     * The model's side (through the content service's `activity` action, inside the scope Authority derived).
     * `watch { url }` -> the note at once when the video is cached, `processing` when a job was queued (or already is
     * for this link), or `failed` with a fixed code. `status` -> how this conversation's newest watch stands.
     * `page { page }` -> one page of the full transcript of the video this conversation watched last.
     * `frames` -> stills of that same video: at once when they were looked at before (by anyone: they are about the
     * video), else `processing` (a job of its own), or `failed` with a fixed code.
     */
    async call(scope, { activity, input = {}, sourceEventId, requestId } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MEDIA_INPUT_INVALID');
      // Anyone Authority admitted may share a video, each in their own private conversation (the scope Authority bound
      // to this request names the person; who that is makes no difference here). Nothing else is a place for it.
      if (typeof scope.personId !== 'string' || !scope.personId || scope.audience !== 'private') return refused('not_allowed');
      if (activity === 'status') {
        if (Object.keys(input).length) throw fail('MEDIA_INPUT_INVALID');
        const job = jobs().recent(scope, 'video');
        return derived(job ? { status: ['queued', 'running'].includes(job.status) ? 'processing' : job.status, stage: job.progress?.stage ?? null, percent: job.progress?.percent ?? null, code: job.failureCode, ahead: job.ahead } : { status: 'none' });
      }
      if (activity === 'page') {
        const page = input.page ?? 1;
        if (Object.keys(input).some(key => key !== 'page') || !Number.isSafeInteger(page) || page < 1 || page > 999) throw fail('MEDIA_INPUT_INVALID');
        const { entry } = lastShare(scope);
        if (!entry) return refused('nothing_watched');
        if (!entry.pages.length) return derived({ status: 'done', page: 0, pages: 0, text: '', note: entry.note });
        if (page > entry.pages.length) return refused('no_such_page');
        return derived({ status: 'done', page, pages: entry.pages.length, text: entry.pages[page - 1] });
      }
      if (activity === 'frames') {
        if (Object.keys(input).length) throw fail('MEDIA_INPUT_INVALID');
        // Only the video this conversation watched last, found through its own reference (as `page`): another
        // conversation's videos, or a video only somebody else shared, cannot be named here.
        const { reference, entry, url } = lastShare(scope);
        if (!entry) return refused('nothing_watched');
        if (entry.frames) return derived({ status: 'done', text: framesText(entry), frames: entry.frames.length, cached: true });
        const configNow = config();
        if (!configNow || !describeFrame) return refused('not_configured');
        const matched = url && matchSite(configNow, url);
        if (!matched) return refused('unavailable');
        if (fs.existsSync(blockedFile(matched.site.id))) return refused('blocked');
        // Filed under the message that shared the link: forgetting it removes this job as it removes the note.
        const job = await jobs().register(scope, { capability: 'video-frames', input: { url, key: entry.key }, source: { sourceEventId: reference.sourceEventId, ...(requestId === undefined ? {} : { requestId }) } });
        if (job.status === 'rejected') return refused(job.failureCode);
        return derived({ status: 'processing', minutes: 3 + 5 * Math.max(0, jobs().waiting - 1), ...(job.duplicate ? { already: true } : {}) });
      }
      if (activity !== 'watch') throw fail('MEDIA_ACTION_DENIED');
      if (Object.keys(input).some(key => key !== 'url') || typeof input.url !== 'string' || !source(sourceEventId)) throw fail('MEDIA_INPUT_INVALID');
      const configNow = config();
      if (!configNow) return refused('not_configured');
      // A link outside the operator's patterns is refused here; nothing is ever fetched for it.
      const matched = matchSite(configNow, input.url);
      if (!matched) return refused('unsupported_link');
      if (fs.existsSync(blockedFile(matched.site.id))) return refused('blocked');
      const known = matched.key && cached(matched.key);
      if (known) { fileNote(scope, sourceEventId, known, input.url); return derived({ status: 'done', note: known.note, pages: known.pages.length, cached: true }); }
      const job = await jobs().register(scope, { capability: 'video', input: { url: input.url }, source: { sourceEventId, ...(requestId === undefined ? {} : { requestId }) } });
      if (job.status === 'rejected') return refused(job.failureCode);
      // A guess: the length is only known once the job has asked. A few minutes for the video, more behind others.
      return derived({ status: 'processing', minutes: 5 + 5 * Math.max(0, jobs().waiting - 1), ...(job.duplicate ? { already: true } : {}) });
    },
    /**
     * For the operator's console: whether the capability is configured, and the cookies' state (never their content):
     * `cookie.state` 'none' | 'configured' | 'unsafe' | 'invalid', `lastSuccessAt` (ms or null) and `suspectedExpired`
     * (the latest sign from a run with them was "signed out").
     */
    status() {
      const { lastSuccessAt, suspectedAt } = cookieRecord();
      return { configured: Boolean(config()), cookie: { state: cookieFile ? cookieState(cookieFile) : 'none', lastSuccessAt, suspectedExpired: suspectedAt !== null && suspectedAt >= (lastSuccessAt ?? 0) } };
    },
    /** Housekeeping: cache entries past their seven days go; with `start`, so does every leftover work directory. */
    sweep({ start = false } = {}) {
      for (const name of fs.readdirSync(cacheRoot)) {
        const target = path.join(cacheRoot, name);
        if (!/^[a-f0-9]{64}\.json$/.test(name) || !fs.lstatSync(target).isFile()) continue;
        let expiresAt = 0; try { expiresAt = JSON.parse(fs.readFileSync(target, 'utf8')).expiresAt; } catch {}
        if (!(expiresAt > clock())) fs.rmSync(target);
      }
      if (start) for (const name of fs.readdirSync(workRoot)) if (name.startsWith(WORK_PREFIX)) removeWork(path.join(workRoot, name));
    },
  };
}
