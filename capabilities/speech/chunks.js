// Long-audio planning for Qwen3-ASR (pure helpers; the worker supplies VAD output).
// The sherpa decoder export has max_total_len 512 (prompt + audio, ~13 tokens/s), so
// one pass truncates past ~30 s. VAD speech regions are grouped into chunks of at most
// CHUNK_SECONDS; a region still longer than that is cut into overlapping windows.
export const CHUNK_SECONDS = 25;
const PAD_SECONDS = 0.2, OVERLAP_SECONDS = 1;

/** regions: [[start, end]] sample ranges in order. Returns [{start, end, overlapsPrevious}]. */
export function planChunks(regions, totalSamples, rate, { maxSeconds = CHUNK_SECONDS } = {}) {
  const max = Math.floor(maxSeconds * rate), pad = Math.round(PAD_SECONDS * rate), overlap = Math.round(OVERLAP_SECONDS * rate);
  const grouped = [];
  for (const [a, b] of regions) {
    const start = Math.max(0, a - pad), end = Math.min(totalSamples, b + pad);
    if (end <= start) continue;
    const last = grouped.at(-1);
    // Keep the natural pause between regions inside a chunk; never span more than max.
    if (last && end - last.start <= max) last.end = Math.max(last.end, end);
    else grouped.push({ start: last ? Math.max(start, last.end) : start, end });
  }
  const chunks = [];
  for (const { start, end } of grouped) {
    if (end - start <= max) { chunks.push({ start, end, overlapsPrevious: false }); continue; }
    for (let s = start; ; s += max - overlap) {
      chunks.push({ start: s, end: Math.min(end, s + max), overlapsPrevious: s !== start });
      if (s + max >= end) break;
    }
  }
  return chunks;
}

const wordChar = ch => /[A-Za-z0-9]/.test(ch || '');
/** Joins chunk transcripts in order; across a hard-split overlap the repeated text is dropped once. */
export function joinTranscripts(parts) {
  let text = '';
  for (const { text: raw, overlapsPrevious } of parts) {
    let next = raw.trim();
    if (!next) continue;
    if (overlapsPrevious) {
      for (let k = Math.min(20, text.length, next.length); k >= 2; k--) if (text.endsWith(next.slice(0, k))) { next = next.slice(k); break; }
    }
    text += text && wordChar(text.at(-1)) && wordChar(next[0]) ? ' ' + next : next;
  }
  return text;
}

/** Voiced time in ms: the summed length of the VAD regions [[start, end]] (unpadded). */
export function speechMs(regions, rate) {
  return Math.round(regions.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0) * 1000 / rate);
}

/** parts: [{start, end, text, overlapsPrevious}] in order (start/end are sample indexes).
 * Returns [{startMs, endMs, text}], one per chunk that added text; each text is exactly
 * what that chunk contributed to joinTranscripts(parts), so overlap repeats are dropped. */
export function transcriptSegments(parts, rate) {
  const segments = [];
  let joined = '';
  parts.forEach((part, i) => {
    const next = joinTranscripts(parts.slice(0, i + 1)), text = next.slice(joined.length).trim();
    joined = next;
    if (text) segments.push({ startMs: Math.round(part.start * 1000 / rate), endMs: Math.round(part.end * 1000 / rate), text });
  });
  return segments;
}
