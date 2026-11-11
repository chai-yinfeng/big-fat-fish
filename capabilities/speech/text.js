/** Traditional -> Simplified Chinese hook for Qwen3-ASR output (safety net).
 * Stock Qwen3-ASR normally answers Mandarin in Simplified; one benchmark clip
 * came back Traditional with Chinese numerals. Identity until a conversion
 * (dependency or table) is approved. Pure and synchronous: it runs inside the
 * speech worker before the transcript leaves the child process. */
export function toSimplifiedChinese(text) {
  return text;
}

// Stands where something unspoken was removed, so only the punctuation next to a removal is tidied.
const GONE = '';
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1f3fb}-\u{1f3ff}️‍⃣]+/gu;
// Bare emoticons that are not inside brackets, and the decorative symbols left around one (╮ ╭ ▽ ♪ ☆ ﹏:
// box drawing, shapes, miscellaneous symbols, dingbats). Units such as ℃ and ° are kept.
const KAOMOJI = /(?<![A-Za-z0-9])(?:\^_*\^|[>＞][_﹏.][<＜]|[TQ][_^A][TQ]|[QqOoUu][wW][QqOoUu]|-_-+\|*|=[_.]=|\._\.|[:;]-?[)(])(?![A-Za-z0-9])|[─-➿﹏]+/gu;

/** The text handed to speech synthesis for a reply: what is said aloud, without what is only written.
 * Removes paired round brackets with their content (（笑）, (sighs), bracketed emoticons), emoji and
 * common emoticons, then the white space and doubled punctuation a removal leaves behind. Pure; the
 * result may be empty. The reply that is sent and recorded as text is not changed by this. */
export function speechText(text) {
  let spoken = text.replaceAll(GONE, '');
  for (let previous; previous !== spoken;) { previous = spoken; spoken = spoken.replace(/[（(][^（()）]*[）)]/g, GONE); }
  return spoken.replace(EMOJI, GONE).replace(KAOMOJI, GONE)
    .replace(/(?:\s*)+/g, GONE)
    // "好，（笑）。" -> "好。"; "好。（笑），走" -> "好。走"; "（笑），走" -> "走".
    .replace(/[，、；：,;]\s*\s*(?=[，。！？、；：,;.!?…])/g, '')
    .replace(/(?<=[。！？!?…])\s*\s*[，、；：,;。]+/g, '')
    .replace(/^\s*\s*[，、；：,;。]+/, '')
    .replace(/\s*\s*/g, gap => /\s/.test(gap) ? ' ' : '')
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+(?=[，。！？、；：…～])/g, '').trim();
}
