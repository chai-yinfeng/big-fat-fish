/** A text reply longer than this (UTF-16 units) goes out as several short messages. */
export const SPLIT_MAX_CHARS = 60;
/** Most messages for one reply; what is left over stays in the last one. */
export const SPLIT_MAX_PARTS = 4;
/** Pause before each message after the first. */
export const SPLIT_GAP_MS = 1200;

const SENTENCE = '。！？…～!?~.', CLOSERS = '”’」』）)】》', COMMA = '，、；：,;';
const PAIRS = { '（': '）', '(': ')', '【': '】', '[': ']', '《': '》', '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"' };
const digit = ch => ch >= '0' && ch <= '9', space = ch => ch !== undefined && /\s/.test(ch);

/** Where no cut may fall. `atomic[i]` / `locked[i]`: no cut right after text[i]. Atomic: code and URLs, never cut.
 * Locked: also the inside of matched brackets and quotes no longer than a message; a hard cut may still fall there. */
function protect(text) {
  const atomic = new Array(text.length).fill(false);
  for (const pattern of [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g, /https?:\/\/[^\s　-〿一-鿿＀-￯]+/gi]) {
    for (const match of text.matchAll(pattern)) if (!atomic[match.index]) atomic.fill(true, match.index, match.index + match[0].length - 1);
  }
  const locked = [...atomic], open = [];
  for (let i = 0; i < text.length; i++) {
    if (atomic[i] || atomic[i - 1]) continue;
    const ch = text[i], at = open.findLastIndex(item => PAIRS[item.ch] === ch);
    // A symmetric quote closes the one that is open; otherwise it opens.
    if (at >= 0) { const start = open[at].i; open.length = at; if (i - start < SPLIT_MAX_CHARS) locked.fill(true, start, i); }
    else if (Object.hasOwn(PAIRS, ch)) open.push({ ch, i });
  }
  return { atomic, locked };
}

/** How natural a cut right after text[i] is: 1 line break, 2 sentence end, 3 comma, 4 space; -1 none. */
function pause(text, i) {
  const ch = text[i], next = text[i + 1];
  if (ch === '\n') return 1;
  if (next !== undefined && (SENTENCE.includes(next) || CLOSERS.includes(next) || COMMA.includes(next))) return -1;
  const between = digit(text[i - 1]) && digit(next);
  let j = i; while (j > 0 && CLOSERS.includes(text[j])) j--;
  const end = text[j];
  // An ASCII full stop ends a sentence only before a space or the end, and not after a digit ("3.14", "1. ").
  if (SENTENCE.includes(end) && !(j === i && between) && (end !== '.' || (next === undefined || space(next) || text[j - 1] === '.') && !digit(text[j - 1]))) return 2;
  if (COMMA.includes(ch) && !between) return 3;
  if (space(ch) && !space(next)) return 4;
  return -1;
}

/**
 * One text reply as the messages to send, in order. A reply within SPLIT_MAX_CHARS and without a blank
 * line is returned as it is. Otherwise: one message per paragraph (blank line), and a paragraph that is
 * too long is cut at the last line break that fits, else sentence end, else comma, else space; never
 * inside code or a URL, and not inside brackets or quotes that fit in one message. A stretch with no
 * such place is cut at the limit. Past SPLIT_MAX_PARTS the rest stays in the last message. Only the
 * white space at the cuts is dropped.
 */
export function splitReply(text) {
  if (text.length <= SPLIT_MAX_CHARS && !/\n[ \t\r]*\n/.test(text)) return [text];
  const { atomic, locked } = protect(text), ranges = [];
  const bounds = [...text.matchAll(/\n[ \t\r]*\n/g)].filter(match => !locked[match.index]).map(match => match.index + 1);
  let from = 0;
  for (const to of [...bounds, text.length]) {
    for (let start = from; ;) {
      while (start < to && space(text[start])) start++;
      let stop = to; while (stop > start && space(text[stop - 1])) stop--;
      if (start >= stop) break;
      if (stop - start <= SPLIT_MAX_CHARS) { ranges.push([start, stop]); break; }
      const limit = start + SPLIT_MAX_CHARS;
      let cut = -1, best = 9;
      for (let c = limit; c > start && best > 1; c--) { const kind = locked[c - 1] ? -1 : pause(text, c - 1); if (kind > 0 && kind < best) { cut = c; best = kind; } }
      if (cut < 0) {
        // Nowhere natural: at the limit, but before a protected span rather than through it, and never through code, a URL or a surrogate pair.
        cut = limit; while (cut > start && locked[cut - 1]) cut--;
        if (cut === start) { cut = limit; while (cut < to && atomic[cut - 1]) cut++; }
        const code = text.charCodeAt(cut - 1); if (code >= 0xd800 && code <= 0xdbff && cut - 1 > start) cut--;
      }
      ranges.push([start, cut]); start = cut;
    }
    from = to;
  }
  if (ranges.length > SPLIT_MAX_PARTS) ranges.splice(SPLIT_MAX_PARTS - 1, Infinity, [ranges[SPLIT_MAX_PARTS - 1][0], ranges.at(-1)[1]]);
  return ranges.length > 1 ? ranges.map(([start, stop]) => text.slice(start, stop).trimEnd()) : [text];
}
