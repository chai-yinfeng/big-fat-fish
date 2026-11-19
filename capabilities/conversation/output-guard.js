import { DECLINE_MARK } from './executor.js';

/** What may stand between the pieces of a note delimiter (whitespace, a line break, zero-width characters). Shared with
 * agent.js `neutralizeNoteMarkers`, so a delimiter is recognized the same way in what comes in and in what goes out. */
export const GAP = '[\\s\\u200b-\\u200f\\u2060\\ufeff]*';
// A note delimiter in her reply: its angle brackets half- or full-width, or already neutralized (‹ ›, as replayed
// history shows them), or missing; any two of its characters may be split by GAP.
const spread = word => [...word].join(GAP);
const MARKER = new RegExp(`(?:[<＜‹]+${GAP})?${spread('记忆中枢附注')}${GAP}(${spread('开始')}|${spread('结束')})(?:${GAP}[>＞›]+)?`, 'gu');
// A paragraph that starts like an event block ("[后台事件 · …]", either bracket): up to the next blank line or the end.
const EVENT = new RegExp(`(^|\\n)[ \\t\\u3000]*[\\[［]${GAP}后台事件[^]*?(?=\\n[ \\t\\u3000]*\\n|$)`, 'gu');
// Nothing but bracketed asides: （…） or (…), one or more.
const ASIDES = /^(?:\s*[（(][^（）()]*[）)])+\s*$/u;

/** Her text with every note block taken out: from an opening delimiter to the next closing one (or to the end), and,
 * for a closing delimiter with no opening one before it, everything before it. */
function withoutNotes(text) {
  let out = '', from = 0, open = false, found = false;
  for (const match of text.matchAll(MARKER)) {
    found = true;
    if (match[1].startsWith('开')) { if (!open) { out += text.slice(from, match.index); open = true; } }
    else { open = false; from = match.index + match[0].length; }
  }
  if (!found) return null;
  return open ? out : out + text.slice(from);
}

/**
 * Executor exit guard, the same for every channel: what of her reply may go out as her words.
 * - A memory-hub note (or any piece of one) and a paragraph imitating an event block are the executor's own input,
 *   never words for the chat: taken out.
 * - In a run she starts herself (`initiated`), a reply of bracketed asides only (（想了想还是没打扰）) is not speaking.
 * Nothing left to say is DECLINE_MARK: the channel sends nothing. `kinds` names what was done (empty: unchanged).
 */
export function guardOutput(text, { initiated = false } = {}) {
  const kinds = [];
  let out = text;
  const notes = withoutNotes(out);
  if (notes !== null) { out = notes; kinds.push('note'); }
  EVENT.lastIndex = 0;
  if (EVENT.test(out)) { EVENT.lastIndex = 0; out = out.replace(EVENT, '$1'); kinds.push('event'); }
  if (kinds.length) out = out.replace(/\n[ \t　]*(?:\n[ \t　]*)+/g, '\n\n').trim();
  if (initiated && ASIDES.test(out)) { out = ''; kinds.push('aside'); }
  if (kinds.length && !out.trim()) { out = DECLINE_MARK; kinds.push('silent'); }
  return { text: kinds.length ? out : text, kinds };
}
