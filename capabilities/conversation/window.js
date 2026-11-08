const fail = code => Object.assign(new Error(code), { code });
export const ACTIVE_CONTEXT_CHARS = 32000;
export const WINDOW_MARKER = 'Older completed execution dialogue is outside the active window. No facts are asserted by this maintenance marker. Retrieve authoritative long-term memory with companion_scope search/read when needed.';

/**
 * Bound the replayed history to `limit` serialized characters. Units are whole
 * runs (one user input plus its assistant/tool chain), so tool pairs are never
 * split. The newest two completed runs and the current run are always kept; if
 * they alone do not fit, execution fails instead of slicing them.
 */
export function fitActiveWindow(messages, limit = ACTIVE_CONTEXT_CHARS) {
  let index = 0;
  const lead = [];
  while (index < messages.length && messages[index].role === 'system') lead.push(messages[index++]);
  const runs = [];
  for (; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user' || !runs.length) runs.push([message]);
    else runs.at(-1).push(message);
  }
  const size = run => run.reduce((total, message) => total + JSON.stringify(message).length, 0);
  let total = runs.reduce((sum, run) => sum + size(run), 0);
  if (total <= limit) return messages;
  const protectedFrom = Math.max(0, runs.length - 3);
  let start = 0;
  while (total + WINDOW_MARKER.length > limit && start < protectedFrom) total -= size(runs[start++]);
  if (!start || total + WINDOW_MARKER.length > limit) throw fail('ACTIVE_CONTEXT_LIMIT');
  const [head, ...rest] = lead;
  if (head?.role !== 'system' || typeof head.content !== 'string') throw fail('ACTIVE_CONTEXT_LIMIT');
  return [{ ...head, content: head.content + '\n\n' + WINDOW_MARKER }, ...rest, ...runs.slice(start).flat()];
}
