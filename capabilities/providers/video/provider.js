// "Watch" a video somebody shared as a link (run by the content service; declared in ./manifest.js).
// A new video is a background job: metadata -> audio -> 16 kHz pieces -> local speech recognition, piece by piece
// with their offsets -> a summary by the model -> a note. A video already in the cache is answered at once.
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
import { NOTE, tooLittleSpeech, sectionsOf, pagesOf, summaryRequests, mergeRequest, parseSummary, renderNote } from './note.js';
import { fail, LIMITS, loadVideoConfig, matchSite, videoKey, metadataArgs, downloadArgs, convertArgs, childCommand, runChild, refusalCode, metadataOf, audioFormat } from './source.js';

export const VIDEO = Object.freeze({
  /** Stage limits (the waits before a slice do not count; the job's overall deadline does). */
  metadataMs: 60000, downloadMs: 10 * 60000, convertMs: 3 * 60000, summaryMs: 2 * 60000,
  /** Transcription may take this many times the audio's length, plus a fixed allowance for starting the recognizer. */
  transcribeFactor: 1.5, transcribeBaseMs: 2 * 60000,
  deadlineMs: 3 * 3600000,
  cacheTtlMs: 7 * 86400000,
  /** A note made without the recognizer (not installed, or it failed) is kept only this long: the video is listened
   * to on a later share instead of being answered from the cache for a week. */
  unheardTtlMs: 3600000,
  /** Output cap of one summary request. */
  summaryTokens: 900,
});
const NOTE_MIME = 'application/vnd.companion.video-note+json';
const WORK_PREFIX = 'video-job-';
const derived = value => ({ ...value, derived: true, isNewEvidence: false, isVerbatimUserText: false });
const refused = code => derived({ status: 'failed', code });
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/**
 * `store`: the media ArtifactStore. `speech`: the local speech runner. `summarize({ messages, maxTokens, signal })`
 * -> `{ content }`: one model completion through the gateway (it throws when the spend tier refuses or the call
 * fails; the note is then filed without a summary). `jobs()`: the background jobs (resolved late: they are created
 * with this provider's runner). `workRoot` must be inside one of the speech runner's input roots.
 */
export function createVideoProvider({ configFile, cacheRoot, workRoot, store, speech, summarize, jobs, spawn, clock = Date.now, log = line => process.stderr.write(line + '\n') }) {
  for (const directory of [cacheRoot, workRoot]) {
    if (!path.isAbsolute(directory)) throw fail('VIDEO_CONFIG');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw fail('VIDEO_CONFIG');
  }
  // An unreadable operator file turns the capability off (and says so once); it never stops the content service.
  let complained = false;
  const config = () => { try { return loadVideoConfig(configFile); } catch { if (!complained) { complained = true; log('VIDEO_CONFIG_INVALID operator/providers/video.json is not usable; watching videos is off.'); } return null; } };
  const cacheFile = key => path.join(cacheRoot, createHash('sha256').update(key).digest('hex') + '.json');
  const blockedFile = site => path.join(cacheRoot, `blocked-${createHash('sha256').update(site).digest('hex').slice(0, 16)}.json`);
  const writeJson = (file, value) => { const temporary = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); };
  function cached(key) {
    try {
      const entry = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
      return entry?.schema === 1 && entry.key === key && entry.expiresAt > clock() && typeof entry.note === 'string' && Array.isArray(entry.pages) ? entry : null;
    } catch { return null; }
  }
  /** This share's own reference to a cached note, in the conversation and under the message that shared the link. */
  const fileNote = (scope, sourceEventId, entry) => store.put({ scope, sourceEventId, kind: 'note', mime: NOTE_MIME, data: Buffer.from(JSON.stringify({ key: entry.key })) }).id;

  /** One yt-dlp run. `stdoutBytes: 0` for a download: what it prints there is progress, however long that gets. */
  async function yt(configNow, site, workDir, args, { signal, stdoutBytes }) {
    const result = await runChild(childCommand(configNow, { workDir, network: true }, [...configNow.ytdlp, ...args]), { signal, stdoutBytes, spawn });
    if (result.code === 0) return result.stdout;
    const code = refusalCode(site, result.stderr);
    // Blocked by the site: remembered, so nothing more is asked of it until the operator has looked (the file is
    // removed by hand; no retry, no change of address or identity). Nothing of yt-dlp's own output is logged.
    if (code === 'blocked') { writeJson(blockedFile(site.id), { schema: 1, site: site.id, at: clock() }); log(`VIDEO_BLOCKED ${site.id}: watching is stopped for this site until the operator clears it.`); }
    throw fail(code);
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
    if (ready) { fileNote(scope, asked.sourceEventId, ready); return { text: ready.note }; }
    const workDir = fs.mkdtempSync(path.join(workRoot, WORK_PREFIX));
    try {
      const raw = await stage('metadata', VIDEO.metadataMs, step => step.slice(inner => yt(configNow, site, workDir, metadataArgs(input.url), { signal: inner, stdoutBytes: LIMITS.jsonBytes })));
      let info; try { info = JSON.parse(raw); } catch { throw fail('failed'); }
      const meta = metadataOf(info), key = matched.key ?? (meta.id ? videoKey(site.id, meta.id) : null);
      if (!key) throw fail('failed');
      // The link did not carry the video's number: only now is it known whether this video is already in the cache.
      const known = cached(key);
      if (known) { fileNote(scope, asked.sourceEventId, known); return { text: known.note }; }
      if (meta.durationMs > configNow.limits.maxDurationSeconds * 1000) throw fail('too_long');
      let heard = null, state = 'unavailable';
      // Without a usable recognizer nothing is downloaded: the note then has the title and the description only.
      const status = speech.status(), longest = status?.longAudio?.vadPresent === true && status.models?.['asr:default']?.componentsPresent === true && status.models['asr:default'].enabled !== false ? status.longAudio.maxAudioSeconds : 0;
      const format = audioFormat(info, site);
      if (longest >= 10 && format) {
        fs.writeFileSync(path.join(workDir, 'info.json'), raw, { mode: 0o600 });
        await stage('download', VIDEO.downloadMs, step => step.slice(inner => yt(configNow, site, workDir, downloadArgs({ format, maxFilesizeMiB: configNow.limits.maxFilesizeMiB }), { signal: inner, stdoutBytes: 0 })));
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
      const segments = state === 'asr' ? heard.segments : [];
      const sections = sectionsOf({ durationMs: meta.durationMs, chapters: meta.chapters, segments }), pages = pagesOf(segments);
      const summary = state === 'asr' ? await summarized(meta, sections, stage, signal) : null;
      const { id: _id, chapters: _chapters, ...described } = meta;
      const note = renderNote({ meta: described, source: state, engine: heard?.engine, sections, summary, pages: pages.length });
      const now = clock(), entry = { schema: 1, key, site: site.id, fetchedAt: now, expiresAt: now + (state === 'unavailable' ? VIDEO.unheardTtlMs : VIDEO.cacheTtlMs), meta: described, source: state, engine: state === 'asr' ? heard.engine : null, summarized: Boolean(summary), note, pages };
      writeJson(cacheFile(key), entry);
      fileNote(scope, asked.sourceEventId, entry);
      return { text: note };
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
    /**
     * The model's side (through the content service's `activity` action, inside the scope Authority derived).
     * `watch { url }` -> the note at once when the video is cached, `processing` when a job was queued (or already is
     * for this link), or `failed` with a fixed code. `status` -> how this conversation's newest watch stands.
     * `page { page }` -> one page of the full transcript of the video this conversation watched last.
     */
    async call(scope, { activity, input = {}, sourceEventId, requestId } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MEDIA_INPUT_INVALID');
      // Step 4 of the plan: only what the owner shares, in the owner's own private conversation.
      if (scope.personId !== 'person:owner' || scope.audience !== 'private') return refused('not_allowed');
      if (activity === 'status') {
        if (Object.keys(input).length) throw fail('MEDIA_INPUT_INVALID');
        const job = jobs().recent(scope, 'video');
        return derived(job ? { status: ['queued', 'running'].includes(job.status) ? 'processing' : job.status, stage: job.progress?.stage ?? null, percent: job.progress?.percent ?? null, code: job.failureCode, ahead: job.ahead } : { status: 'none' });
      }
      if (activity === 'page') {
        const page = input.page ?? 1;
        if (Object.keys(input).some(key => key !== 'page') || !Number.isSafeInteger(page) || page < 1 || page > 999) throw fail('MEDIA_INPUT_INVALID');
        const reference = store.latest(scope, 'note');
        let entry = null;
        if (reference) { try { entry = cached(JSON.parse(store.read(reference.id, scope).data.toString('utf8')).key); } catch { entry = null; } }
        if (!entry) return refused('nothing_watched');
        if (!entry.pages.length) return derived({ status: 'done', page: 0, pages: 0, text: '', note: entry.note });
        if (page > entry.pages.length) return refused('no_such_page');
        return derived({ status: 'done', page, pages: entry.pages.length, text: entry.pages[page - 1] });
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
      if (known) { fileNote(scope, sourceEventId, known); return derived({ status: 'done', note: known.note, pages: known.pages.length, cached: true }); }
      const job = await jobs().register(scope, { capability: 'video', input: { url: input.url }, source: { sourceEventId, ...(requestId === undefined ? {} : { requestId }) } });
      if (job.status === 'rejected') return refused(job.failureCode);
      // A guess: the length is only known once the job has asked. A few minutes for the video, more behind others.
      return derived({ status: 'processing', minutes: 5 + 5 * Math.max(0, jobs().waiting - 1), ...(job.duplicate ? { already: true } : {}) });
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
