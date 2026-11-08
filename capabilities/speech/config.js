import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;
export const ASR_TIERS = ['default', 'fast'];
export const VOICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const USAGE_SCOPES = ['private', 'public'];
export const failure = code => Object.assign(new Error(code), { code });
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, max) => typeof value === 'string' && value.trim() !== '' && [...value].length <= max && !value.includes('\0');

// A voice names a registered TTS engine entry (models.tts[engine]). Only the
// llama-tts adapter exists now; another engine needs its own worker adapter.
function validVoice(c, id, p) {
  return VOICE_ID.test(id) && plain(p) && p.id === id && boundedText(p.label, 64) && Object.hasOwn(c.models.tts, p.engine)
    && absolute(p.referencePath) && boundedText(p.referenceTranscript, 1000) && /^[a-z]{2,3}$/.test(p.referenceLanguage)
    // llama-tts conditions on speaker audio only; claiming transcript use would be false.
    && typeof p.useReferenceText === 'boolean' && !(p.engine === 'llama-tts' && p.useReferenceText)
    && USAGE_SCOPES.includes(p.usageScope) && (p.auditioned === undefined || typeof p.auditioned === 'boolean');
}
export function loadSpeechConfig(file) {
  if (!absolute(file)) throw failure('SPEECH_CONFIG');
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw failure('SPEECH_NOT_CONFIGURED'); }
  // Schema 1 (light/heavy tiers + one default profile) is not migrated: move the
  // old operator/speech.json aside and re-run deploy/authority/prepare-speech.mjs.
  if (c?.schemaVersion !== SCHEMA_VERSION) throw failure('SPEECH_CONFIG_SCHEMA');
  if (!absolute(c.workRoot) || !Array.isArray(c.inputRoots) || !c.inputRoots.length || !c.inputRoots.every(absolute) || !absolute(c.nodeExecutable) || !absolute(c.sherpaModule) || !plain(c.models) || !plain(c.models.asr) || !plain(c.models.tts) || !Number.isInteger(c.numThreads) || c.numThreads < 1 || c.numThreads > 16) throw failure('SPEECH_CONFIG');
  if (!Number.isInteger(c.maxTextChars) || c.maxTextChars < 1 || c.maxTextChars > 120 || !Number.isInteger(c.maxAudioSeconds) || c.maxAudioSeconds < 1 || c.maxAudioSeconds > 30 || !Number.isInteger(c.maxFastAudioSeconds) || c.maxFastAudioSeconds < 1 || c.maxFastAudioSeconds > 120 || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 300000) throw failure('SPEECH_CONFIG');
  if (Object.entries(c.models.tts).some(([key, e]) => !plain(e) || e.engine !== key || typeof e.id !== 'string')) throw failure('SPEECH_CONFIG');
  if (!plain(c.voiceProfiles) || Object.entries(c.voiceProfiles).some(([id, p]) => !validVoice(c, id, p))) throw failure('SPEECH_CONFIG');
  if (c.defaultVoice !== null && !Object.hasOwn(c.voiceProfiles, c.defaultVoice)) throw failure('SPEECH_CONFIG');
  if (c.pendingReferenceCleanup !== undefined && (!plain(c.pendingReferenceCleanup) || Object.keys(c.pendingReferenceCleanup).join() !== 'uploadId' || !/^[a-f0-9-]{36}$/.test(c.pendingReferenceCleanup.uploadId))) throw failure('SPEECH_CONFIG');
  return c;
}
export function inputPath(c, file) {
  if (!absolute(file)) throw failure('SPEECH_PATH');
  let real;
  try { if (!fs.lstatSync(file).isFile()) throw 0; real = fs.realpathSync(file); } catch { throw failure('SPEECH_PATH'); }
  const allowed = c.inputRoots.some(root => { try { return inside(fs.realpathSync(root), real); } catch { return false; } });
  if (!allowed) throw failure('SPEECH_PATH');
  return real;
}
export function outputPath(c, file) {
  if (!absolute(file)) throw failure('SPEECH_PATH');
  let root, parent;
  try { root = fs.realpathSync(c.workRoot); parent = fs.realpathSync(path.dirname(file)); } catch { throw failure('SPEECH_PATH'); }
  if (!inside(root, parent) || fs.existsSync(file)) throw failure('SPEECH_PATH');
  return path.join(parent, path.basename(file));
}
/** ASR tiers are 'default' (Qwen3-ASR) and 'fast' (SenseVoice); TTS entries are keyed by engine. */
export function engineFor(c, kind, key) {
  if (kind === 'asr' ? !ASR_TIERS.includes(key) : kind !== 'tts' || typeof key !== 'string') throw failure('SPEECH_REQUEST');
  const engine = Object.hasOwn(c.models[kind], key) ? c.models[kind][key] : undefined;
  if (!engine || typeof engine.id !== 'string') throw failure('SPEECH_NOT_CONFIGURED');
  return engine;
}
export function componentsPresent(c, kind, key) {
  const e = engineFor(c, kind, key);
  const paths = e.engine === 'llama-tts' ? [c.nodeExecutable, e.executable, e.model, e.mmproj] : [c.nodeExecutable, c.sherpaModule, ...Object.values(e.files || {})];
  return paths.length > 2 && paths.every(file => {
    if (!absolute(file)) return false;
    try { const stat = fs.statSync(file); return stat.isDirectory() || stat.isFile() && stat.size > 0; } catch { return false; }
  });
}
/** Resolves a voice id only through operator config; never a caller path. A
 * private-scope voice (e.g. a real person's recording) is only for private audiences. */
export function resolveVoice(c, voiceId, audience) {
  const id = voiceId === undefined || voiceId === null ? c.defaultVoice : voiceId;
  if (id === null) throw failure('SPEECH_REFERENCE_REQUIRED');
  if (typeof id !== 'string' || !VOICE_ID.test(id) || !Object.hasOwn(c.voiceProfiles, id)) throw failure('SPEECH_VOICE_UNKNOWN');
  const profile = c.voiceProfiles[id];
  if (profile.usageScope === 'private' && audience !== 'private') throw failure('SPEECH_VOICE_SCOPE');
  return profile;
}
// Registered operator audio is private data, never a model-selected path. The
// pinned native CLI consumes only speaker audio; the transcript is provenance,
// not an ICL input or a flag the CLI does not implement.
export function trustedReference(c, profile) {
  try {
    const root = fs.realpathSync(c.workRoot), p = profile;
    if (!path.isAbsolute(p.referencePath) || fs.lstatSync(p.referencePath).isSymbolicLink() || !fs.lstatSync(p.referencePath).isFile() || fs.lstatSync(p.referencePath + '.json').isSymbolicLink()) throw 0;
    const file = fs.realpathSync(p.referencePath), manifest = JSON.parse(fs.readFileSync(p.referencePath + '.json', 'utf8'));
    const referenceRoot = fs.realpathSync(path.join(root, 'reference'));
    if (!inside(root, file) || path.dirname(file) !== referenceRoot || !/^operator-[a-f0-9-]{36}\.wav$/.test(path.basename(file))) throw 0;
    if (manifest.schemaVersion !== 1 || manifest.origin !== 'operator-authorized' || manifest.voiceId !== p.id || manifest.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw 0;
    if (manifest.transcript !== p.referenceTranscript || !Number.isFinite(Date.parse(manifest.consentRecordedAt))) throw 0;
    const info = wavInfo(file, 2 * 1024 * 1024);
    if (info.format !== 1 || info.bits !== 16 || info.durationMs < 3000 || info.durationMs > 20000) throw 0;
    return { file, manifest };
  } catch { throw failure('SPEECH_REFERENCE_REQUIRED'); }
}

export function wavInfo(file, maxBytes = 16 * 1024 * 1024) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 44 || stat.size > maxBytes) throw failure('SPEECH_AUDIO_FORMAT');
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw failure('SPEECH_AUDIO_FORMAT');
  let format, channels, sampleRate, byteRate, bits, dataBytes;
  for (let p = 12; p + 8 <= b.length;) {
    const n = b.readUInt32LE(p + 4), start = p + 8;
    if (start + n > b.length) throw failure('SPEECH_AUDIO_FORMAT');
    const id = b.toString('ascii', p, p + 4);
    if (id === 'fmt ' && n >= 16) { format = b.readUInt16LE(start); channels = b.readUInt16LE(start + 2); sampleRate = b.readUInt32LE(start + 4); byteRate = b.readUInt32LE(start + 8); bits = b.readUInt16LE(start + 14); }
    if (id === 'data') dataBytes = n;
    p = start + n + (n % 2);
  }
  if (![1, 3].includes(format) || channels !== 1 || (sampleRate < 8000 || sampleRate > 48000) || ![16, 32].includes(bits) || byteRate !== sampleRate * channels * bits / 8 || !dataBytes) throw failure('SPEECH_AUDIO_FORMAT');
  return { sampleRate, channels, bits, format, durationMs: Math.round(dataBytes / byteRate * 1000) };
}
