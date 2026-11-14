/** Shared pure helpers. No I/O, no dependencies. */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Half-life decay factor for an elapsed span in milliseconds. */
export function decayFactor(elapsedMs, halfLifeMs) {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isoDate(at) {
  return new Date(at).toISOString().slice(0, 10);
}

const STOPWORDS = new Set([
  "的", "地", "得", "了", "是", "在", "和", "与", "及", "就", "都", "而",
  "着", "吗", "呢", "啊", "吧", "呀", "哦", "嗯", "我", "你", "他", "她",
  "它", "我们", "你们", "他们", "这", "那", "有", "没有", "不", "一个",
  "一下", "什么", "怎么", "为什么", "可以", "还是", "就是",
]);

/**
 * Tokenize Chinese/Latin text for lexical retrieval.
 * - Latin words / numbers are kept.
 * - Each CJK run contributes unigrams (stopword-filtered) and bigrams.
 */
export function tokenize(text) {
  if (text === undefined || text === null) return [];
  const source = String(text).normalize("NFKC").toLowerCase();
  if (source.trim() === "") return [];
  const tokens = [];
  const latin = source.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [];
  for (const word of latin) tokens.push(word);
  const cjk = source.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      if (chars.length === 1) tokens.push(chars[i]);
      if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens.filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

export function uniqueTokens(text) {
  return [...new Set(tokenize(text))];
}

/** Overlap of query tokens against text tokens, in [0, 1]. */
export function overlapScore(queryTokens, textTokens) {
  const query = queryTokens instanceof Set ? queryTokens : new Set(queryTokens);
  if (query.size === 0) return 0;
  const text = textTokens instanceof Set ? textTokens : new Set(textTokens);
  let matched = 0;
  for (const token of query) {
    if (text.has(token)) matched += 1;
  }
  return clamp(matched / query.size, 0, 1);
}

export function systemLocalParts(now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: date.getDay(),
    date: `${year}-${month}-${day}`,
  };
}

/** Quiet hours are [start, end); equal start/end disables them. */
export function inQuietHours(hour, quietHours) {
  if (!quietHours) return false;
  const { start, end } = quietHours;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function isPeak(parts, windows) {
  if (!Array.isArray(windows)) return false;
  return windows.some(
    (window) =>
      Array.isArray(window.days) &&
      window.days.includes(parts.weekday) &&
      parts.hour >= window.start &&
      parts.hour < window.end,
  );
}

export function truncate(text, maxChars) {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function randomId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}
