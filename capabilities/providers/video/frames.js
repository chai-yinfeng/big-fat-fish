// Choosing a few stills of a video. Pure work on numbers and bytes, no I/O. The method, simple over clever:
// 1. ffmpeg's scene score marks where the picture changes (sceneArgs in ./source.js), which cuts the video into shots;
// 2. the middle of the longest shots are the candidates, longest first (a long shot is what the video dwells on, and
//    its middle is clear of the cut's blur); a video of one long take gets evenly spaced times as well;
// 3. each candidate still is also taken as 8x8 grey bytes; its average hash (one bit a pixel: brighter than the mean)
//    drops a still that is nearly the same as one already kept (same speaker, same slide after a cutaway).

export const PICK = Object.freeze({
  /** Candidates looked at for every still wanted (each costs one ffmpeg seek, nothing else). */
  candidatesPerStill: 3,
  /** Shots shorter than this are not worth a still; cuts this close to either end are ignored. */
  minShotSeconds: 1, edgeSeconds: 0.5,
  /** Evenly spaced times closer than this to a chosen one are not added. */
  spacingSeconds: 2,
  /** Average hashes this close (bits of 64) are the same picture. */
  nearDuplicate: 6,
  /** At most this many cuts are read (a very busy video). */
  cuts: 2000,
});

/** The times (seconds) ffmpeg's `metadata=print` wrote for the frames where the scene changed. */
export function sceneCuts(text) {
  if (typeof text !== 'string') return [];
  const cuts = [];
  for (const match of text.matchAll(/^frame:\d+\s+pts:-?\d+\s+pts_time:(\d+(?:\.\d+)?)\s*$/gm)) { cuts.push(Number(match[1])); if (cuts.length >= PICK.cuts) break; }
  return cuts.filter(Number.isFinite);
}

/** Candidate times in seconds, best first, at most `wanted * PICK.candidatesPerStill`. */
export function candidateTimes({ cuts = [], durationMs, wanted }) {
  const end = durationMs / 1000;
  if (!(end > 0) || !(wanted > 0)) return [];
  const inside = [...new Set(cuts.filter(time => time > PICK.edgeSeconds && time < end - PICK.edgeSeconds))].sort((a, b) => a - b);
  const edges = [0, ...inside, end];
  const shots = edges.slice(1).map((to, index) => ({ from: edges[index], to })).filter(shot => shot.to - shot.from >= PICK.minShotSeconds)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const limit = wanted * PICK.candidatesPerStill, picks = shots.slice(0, limit).map(shot => (shot.from + shot.to) / 2);
  for (let index = 1; index <= wanted && picks.length < limit; index++) {
    const time = end * index / (wanted + 1);
    if (picks.every(pick => Math.abs(pick - time) >= PICK.spacingSeconds)) picks.push(time);
  }
  return picks.map(time => Math.round(Math.min(Math.max(0, time), Math.max(0, end - 0.1)) * 1000) / 1000);
}

/** Average hash of 64 grey bytes, as 64 booleans; null for anything else. */
export function averageHash(grey) {
  if (!Buffer.isBuffer(grey) || grey.length !== 64) return null;
  const mean = grey.reduce((sum, value) => sum + value, 0) / 64;
  return [...grey].map(value => value > mean);
}
export const hashDistance = (a, b) => a.reduce((sum, bit, index) => sum + (bit !== b[index] ? 1 : 0), 0);
export const nearlySame = (a, b) => hashDistance(a, b) <= PICK.nearDuplicate;
