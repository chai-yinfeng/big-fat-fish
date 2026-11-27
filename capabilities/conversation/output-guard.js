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

// Markdown a chat shows as it is. Code blocks and URLs are left alone (a URL's own trailing `*` is not part of it).
const FENCE = /```[\s\S]*?(?:```|$)/g, URL = /https?:\/\/[^\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+?(?=\**(?:[\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|$))/giu;
const HOLD = /\ue000(\d+)\ue001/g;
/** Her text without bold markers (**x**, __x__), heading marks and list bullets at a line start, and the backticks of
 * inline code; null when there were none. */
function withoutMarkdown(text) {
  let changed = false;
  const plain = chunk => {
    const held = [];
    const hold = value => `\ue000${held.push(value) - 1}\ue001`;
    let out = chunk.replace(URL, hold).replace(/`([^`\n]+)`/g, (_, code) => { changed = true; return hold(code); });
    const next = out
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '$1').replace(/__(?=\S)([^\n]*?\S)__/g, '$1')
      .replace(/^([ \t]*)#{1,6}[ \t]+/gm, '$1').replace(/^([ \t]*)[-*][ \t]+(?=\S)/gm, '$1');
    if (next !== out) changed = true;
    return next.replace(HOLD, (_, i) => held[Number(i)]);
  };
  let out = '', from = 0;
  for (const match of text.matchAll(FENCE)) { out += plain(text.slice(from, match.index)) + match[0]; from = match.index + match[0].length; }
  out += plain(text.slice(from));
  return changed ? out : null;
}

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
 * - Markdown a chat would show as it is (bold, a heading or list mark at a line start, inline-code backticks): the
 *   marks taken out, the words kept; code blocks and URLs untouched.
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
  const markdown = withoutMarkdown(out);
  if (markdown !== null) { out = markdown; kinds.push('markdown'); }
  if (initiated && ASIDES.test(out)) { out = ''; kinds.push('aside'); }
  if (kinds.length && !out.trim()) { out = DECLINE_MARK; kinds.push('silent'); }
  return { text: kinds.length ? out : text, kinds };
}
