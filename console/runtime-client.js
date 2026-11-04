const fail = code => Object.assign(new Error(code), { code });
export function validRuntime(value) {
  const s = value?.speech;
  return typeof s?.configurationRevision === 'string' && ['light', 'heavy'].includes(s.defaultTtsQuality)
    && Number.isInteger(s.numThreads) && Number.isInteger(s.maxTextChars)
    && ['asr:light', 'asr:heavy', 'tts:light', 'tts:heavy'].every(key => typeof s.models?.[key]?.model === 'string'
      && ['componentsPresent', 'enabled', 'verified'].every(k => typeof s.models[key][k] === 'boolean'))
    && value.voice?.profileId === 'default' && ['kokoro-local', 'operator-authorized'].includes(value.voice.origin)
    && typeof value.voice.hasReference === 'boolean' && (value.voice.cleanupPending === undefined || typeof value.voice.cleanupPending === 'boolean')
    && value.imageGeneration?.configured === false && value.imageGeneration.status === 'not_configured';
}
export function speechPayload(revision, draft) {
  const numThreads = Number(draft.numThreads), maxTextChars = Number(draft.maxTextChars);
  if (typeof revision !== 'string' || !revision || !['light', 'heavy'].includes(draft.defaultTtsQuality)
    || !Number.isInteger(numThreads) || numThreads < 1 || numThreads > 2 || !Number.isInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 120) throw fail('invalid_speech_parameters');
  return { expectedRevision: revision, defaultTtsQuality: draft.defaultTtsQuality, numThreads, maxTextChars };
}
export function referencePayload(revision, audioBase64, transcript, authorized) {
  if (!authorized) throw fail('reference_authorization_required');
  if (typeof transcript !== 'string' || !transcript.trim() || [...transcript.trim()].length > 1000) throw fail('reference_transcript_required');
  if (typeof revision !== 'string' || !revision || typeof audioBase64 !== 'string' || !audioBase64) throw fail('invalid_reference_audio');
  return { expectedRevision: revision, audioBase64, transcript: transcript.trim(), authorized: true };
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
