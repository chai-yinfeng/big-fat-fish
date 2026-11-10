const fail = code => Object.assign(new Error(code), { code });
const VOICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const validProfile = p => VOICE_ID.test(p?.id) && typeof p.label === 'string' && typeof p.engine === 'string' && typeof p.referenceLanguage === 'string'
  && ['private', 'public'].includes(p.usageScope) && ['useReferenceText', 'auditioned', 'hasReference'].every(k => typeof p[k] === 'boolean');
export const SPEECH_UNAVAILABLE = ['not_configured', 'config_schema_outdated', 'config_invalid'];
export function validRuntime(value) {
  const s = value?.speech, v = value?.voices;
  // A degraded status carries only its reason; the rest of the runtime view still renders.
  if (SPEECH_UNAVAILABLE.includes(s?.status)) return Object.keys(s).length === 1 && v === null
    && value.imageGeneration?.configured === false && value.imageGeneration.status === 'not_configured';
  return s?.status === 'ready' && typeof s.configurationRevision === 'string' && Number.isInteger(s.numThreads) && Number.isInteger(s.maxTextChars)
    && s.models && typeof s.models === 'object' && Object.values(s.models).every(m => typeof m?.model === 'string'
      && ['componentsPresent', 'enabled', 'verified'].every(k => typeof m[k] === 'boolean'))
    && Array.isArray(v?.profiles) && v.profiles.every(validProfile) && (v.defaultVoice === null || v.profiles.some(p => p.id === v.defaultVoice))
    && typeof v.cleanupPending === 'boolean'
    && value.imageGeneration?.configured === false && value.imageGeneration.status === 'not_configured';
}
/** TTS backend as the server reports it: configured device, the backend of the last synthesis in this
 * service process (observed) or the one a probe expects (not observed), and why auto fell back to CPU. */
export function ttsBackend(speech) {
  const t = speech?.tts;
  if (!t || !['auto', 'vulkan', 'cpu'].includes(t.device) || !['vulkan', 'cpu'].includes(t.backend)) return null;
  return { device: t.device, backend: t.backend, observed: t.observed === true, fallback: ['SPEECH_VULKAN_UNSUPPORTED', 'SPEECH_VULKAN_NO_DEVICE', 'SPEECH_VULKAN_FAILED'].includes(t.fallback) ? t.fallback : null };
}
export function speechPayload(revision, draft) {
  const numThreads = Number(draft.numThreads), maxTextChars = Number(draft.maxTextChars);
  if (typeof revision !== 'string' || !revision
    || !Number.isInteger(numThreads) || numThreads < 1 || numThreads > 16 || !Number.isInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 120) throw fail('invalid_speech_parameters');
  return { expectedRevision: revision, numThreads, maxTextChars };
}
export function referencePayload(revision, audioBase64, transcript, authorized, voice) {
  if (!authorized) throw fail('reference_authorization_required');
  if (typeof transcript !== 'string' || !transcript.trim() || [...transcript.trim()].length > 1000) throw fail('reference_transcript_required');
  const label = typeof voice?.label === 'string' ? voice.label.trim() : '';
  if (!VOICE_ID.test(voice?.voiceId || '') || !label || [...label].length > 64 || !/^[a-z]{2,3}$/.test(voice.language || '') || !['private', 'public'].includes(voice.usageScope)) throw fail('invalid_voice_fields');
  if (typeof revision !== 'string' || !revision || typeof audioBase64 !== 'string' || !audioBase64) throw fail('invalid_reference_audio');
  return { expectedRevision: revision, voiceId: voice.voiceId, label, language: voice.language, usageScope: voice.usageScope, audioBase64, transcript: transcript.trim(), authorized: true };
}
export function inspectReferenceWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44 || bytes.byteLength > 2 * 1024 * 1024) throw fail('invalid_reference_audio');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw fail('invalid_reference_audio');
  let format, channels, sampleRate, byteRate, bits, dataBytes;
  for (let p = 12; p + 8 <= bytes.length;) {
    const count = view.getUint32(p + 4, true), start = p + 8;
    if (start + count > bytes.length) throw fail('invalid_reference_audio');
    if (text(p, 4) === 'fmt ' && count >= 16) { format = view.getUint16(start, true); channels = view.getUint16(start + 2, true); sampleRate = view.getUint32(start + 4, true); byteRate = view.getUint32(start + 8, true); bits = view.getUint16(start + 14, true); }
    if (text(p, 4) === 'data') dataBytes = count;
    p = start + count + (count % 2);
  }
  const durationMs = dataBytes / byteRate * 1000;
  if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate < 8000 || sampleRate > 48000 || byteRate !== sampleRate * 2 || !Number.isFinite(durationMs) || durationMs < 3000 || durationMs > 20000) throw fail('invalid_reference_audio');
  return { durationMs, sampleRate };
}
export async function readReferenceFile(file) {
  if (!file || file.size > 2 * 1024 * 1024) throw fail('invalid_reference_audio');
  const bytes = new Uint8Array(await file.arrayBuffer()); inspectReferenceWav(bytes);
  let binary = ''; for (let p = 0; p < bytes.length; p += 8192) binary += String.fromCharCode(...bytes.subarray(p, p + 8192));
  return btoa(binary);
}
export function voiceTestBlob(value) {
  if (value?.mime !== 'audio/wav' || typeof value.audioBase64 !== 'string' || value.audioBase64.length > 6 * 1024 * 1024
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.audioBase64)
    || typeof value.model !== 'string' || !Number.isFinite(value.durationMs) || value.durationMs <= 0) throw fail('invalid_response');
  const bytes = Uint8Array.from(atob(value.audioBase64), c => c.charCodeAt(0));
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') throw fail('invalid_response');
  return new Blob([bytes], { type: 'audio/wav' });
}
