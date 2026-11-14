/** Her own stickers on QQ (K4, K7, K8 of the stickers design): she writes `[表情:词]` in a reply, the bridge takes the
 * marker out of the text and asks the content service for a library sticker close to the word, sent as a message of
 * its own after her last text message. */

// How she is told to use it is part of QQ's channel declaration (capabilities/channels/qq/manifest.js `prompt`).
/** Safety value, not a style rule: at most this many stickers for one reply; later markers are dropped (logged). */
export const MAX_STICKERS_PER_REPLY = 1;
/** How many of her latest replies the frequency line counts. */
export const RECENT_REPLIES = 10;
/** "收下这个" refers to the last picture of the owner's own conversation at most this long ago. */
export const KEEP_WINDOW_MS = 10 * 60000;
const MARKER = /\[表情[:：]\s*([^[\]\n]{1,12}?)\s*\]/g;

/** Her reply without `[表情:词]` markers, and the word of the first (null when there is none). */
export function takeStickerMarker(text, log = message => process.stderr.write(message + '\n')) {
  const words = [...text.matchAll(MARKER)].map(match => match[1]).filter(word => word.trim());
  // A reply without a marker is left exactly as written.
  if (!words.length) return { text, word: null };
  if (words.length > MAX_STICKERS_PER_REPLY) log('Sticker markers beyond the per-reply safety value were dropped.');
  const stripped = text.replace(MARKER, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: stripped, word: words[0] ?? null };
}
/** The owner asking her to keep a picture: a short message saying 收下这个 / 收下这张 / 收下它. */
export function asksToKeep(text) {
  return typeof text === 'string' && [...text].length <= 40 && /收下(?:这个|这张|它)/.test(text);
}
/** The fact line about how often she sent a sticker lately (soft: whether to send one is hers to judge). */
export function frequencyLine(recent) {
  if (!recent?.length) return '';
  return `\n[渠道事实：你最近 ${recent.length} 条回复里发过 ${recent.filter(Boolean).length} 次表情包。]`;
}
