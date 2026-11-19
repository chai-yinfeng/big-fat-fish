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
/** Safety value: at most this many pictures (the latest of the window) for one "收下这些". */
export const MAX_KEEP_PER_REQUEST = 10;
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
/** Every `[表情:词]` of her reply as she wrote it, in order (`word` null: no word in it). takeStickerMarker takes all
 * of them out and sends at most the first with a word; the delivery report names each by these exact characters. */
export function stickerMarkers(text) {
  return [...text.matchAll(MARKER)].map(match => ({ marker: match[0], word: match[1].trim() ? match[1] : null }));
}
const ECHO = /[\[［]\s*(?:表情包|送达情况)\s*[:：][^\[\]［］\n]*[\]］]/g;
/** Her text without bracketed pieces that imitate what the executor shows her about delivery (`[表情包：…]`,
 * `[送达情况：…]`; full-width brackets and either colon too): those are lines of her replayed history, never words for
 * the chat. Whole pieces only, and the lines they leave empty; `stripped` says whether anything was taken out. A
 * `[表情包：词]` is not read as a sticker request: what follows the colon in her history is a description, not a word. */
export function stripDeliveryEcho(text) {
  if (!ECHO.test(text)) return { text, stripped: false };
  ECHO.lastIndex = 0;
  return { text: text.replace(ECHO, '').split('\n').map(line => line.replace(/[ \t]{2,}/g, ' ').trimEnd()).filter((line, index, lines) => line.trim() || !index || lines[index - 1].trim()).join('\n').trim(), stripped: true };
}
/** The owner asking her to keep a picture: a short message saying 收下这个 / 收下这张 / 收下它. */
export function asksToKeep(text) {
  return typeof text === 'string' && [...text].length <= 40 && /收下(?:这个|这张|它)/.test(text);
}
/** The owner asking her to keep the pictures sent lately: a short message such as 这些都收下 / 把刚才的都收了 /
 * 收下这几张. It names several pictures, so 收下它 stays the one picture of asksToKeep and 我都收了 is nothing. */
export function asksToKeepMany(text) {
  if (typeof text !== 'string' || [...text].length > 40) return false;
  const these = '(?:这些|这几张|这几个|刚才的|刚刚的|刚发的|上面的|它们|全部|所有)';
  return new RegExp(`收下${these}|${these}(?:图|图片|表情|表情包)?(?:都|全|全都|全部)?收(?:下|了|进)|^\\s*(?:都|全|全都|全部)收下`).test(text);
}
/** The fact line about how often she sent a sticker lately (soft: whether to send one is hers to judge). */
export function frequencyLine(recent) {
  if (!recent?.length) return '';
  return `\n[渠道事实：你最近 ${recent.length} 条回复里发过 ${recent.filter(Boolean).length} 次表情包。]`;
}
