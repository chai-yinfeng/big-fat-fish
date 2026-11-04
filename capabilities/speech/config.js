import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const REFERENCE_TEXT = '你好，我是你的本地伴侣。这是一段公开的合成语音，用于保持测试音色一致。';
export const failure = code => Object.assign(new Error(code), { code });
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

export function loadSpeechConfig(file) {
  if (!absolute(file)) throw failure('SPEECH_CONFIG');
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw failure('SPEECH_NOT_CONFIGURED'); }
  if (c.schemaVersion !== 1 || !absolute(c.workRoot) || !Array.isArray(c.inputRoots) || !c.inputRoots.length || !c.inputRoots.every(absolute) || !absolute(c.nodeExecutable) || !absolute(c.sherpaModule) || !c.models || !c.voiceProfiles?.default || !Number.isInteger(c.numThreads) || c.numThreads < 1 || c.numThreads > 4) throw failure('SPEECH_CONFIG');
  if (!Number.isInteger(c.maxTextChars) || c.maxTextChars < 1 || c.maxTextChars > 120 || !Number.isInteger(c.maxAudioSeconds) || c.maxAudioSeconds < 1 || c.maxAudioSeconds > 120 || !Number.isInteger(c.maxHeavyAudioSeconds) || c.maxHeavyAudioSeconds < 1 || c.maxHeavyAudioSeconds > 30 || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 300000) throw failure('SPEECH_CONFIG');
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
export function engineFor(c, kind, quality) {
  if (!['light', 'heavy'].includes(quality) || !['asr', 'tts'].includes(kind)) throw failure('SPEECH_REQUEST');
  const engine = c.models[kind]?.[quality];
  if (!engine || typeof engine.id !== 'string') throw failure('SPEECH_NOT_CONFIGURED');
  return engine;
}
export function componentsPresent(c, kind, quality) {
  const e = engineFor(c, kind, quality);
  const paths = e.engine === 'llama-tts' ? [c.nodeExecutable, e.executable, e.model, e.mmproj] : [c.nodeExecutable, c.sherpaModule, ...Object.values(e.files || {})];
  return paths.length > 2 && paths.every(file => {
    if (!absolute(file)) return false;
    try { const stat = fs.statSync(file); return stat.isDirectory() || stat.isFile() && stat.size > 0; } catch { return false; }
  });
}
// Registered operator audio is private data, never a model-selected path. The
// pinned native CLI consumes only speaker audio; its transcript is provenance,
// not an asserted ICL input or a flag the CLI does not implement.
export function trustedReference(c) {
  try {
    const p = c.voiceProfiles.default, root = fs.realpathSync(c.workRoot);
    if (!path.isAbsolute(p.referencePath) || fs.lstatSync(p.referencePath).isSymbolicLink() || !fs.lstatSync(p.referencePath).isFile() || fs.lstatSync(p.referencePath + '.json').isSymbolicLink()) throw 0;
    const file = fs.realpathSync(p.referencePath), manifest = JSON.parse(fs.readFileSync(p.referencePath + '.json', 'utf8'));
    if (!inside(root, file) || manifest.schemaVersion !== 1 || manifest.origin !== p.referenceOrigin || manifest.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw 0;
    if (manifest.origin === 'kokoro-local') {
      if (manifest.text !== REFERENCE_TEXT || manifest.model !== c.models.tts.light.id || manifest.speakerId !== p.speakerId) throw 0;
    } else if (manifest.origin === 'operator-authorized') {
      const referenceRoot = fs.realpathSync(path.join(root, 'reference'));
      if (path.dirname(file) !== referenceRoot || !/^operator-[a-f0-9-]{36}\.wav$/.test(path.basename(file)) || typeof manifest.transcript !== 'string' || !manifest.transcript.trim() || [...manifest.transcript].length > 1000 || !Number.isFinite(Date.parse(manifest.consentRecordedAt))) throw 0;
      const info = wavInfo(file, 2 * 1024 * 1024);
      if (info.format !== 1 || info.bits !== 16 || info.durationMs < 3000 || info.durationMs > 20000) throw 0;
    } else throw 0;
    wavInfo(file);
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
