const fail = code => Object.assign(new Error(code), { code });
export const ACTIVE_CONTEXT_CHARS = 32000;
export const WINDOW_MARKER = 'Older completed execution dialogue is outside the active window. No facts are asserted by this maintenance marker. Retrieve authoritative long-term memory with companion_scope search/read when needed.';

/**
 * Bound the replayed history to `limit` serialized characters. Units are whole
 * runs (one user input plus its assistant/tool chain), so tool pairs are never
 * split. The newest two completed runs and the current run are always kept; if
 * they alone do not fit, execution fails instead of slicing them.
 *
 * Trimming is batched for the provider's prefix cache: when the window exceeds
 * `limit`, old runs are dropped in one cut until the runs before the newest one
 * are down to `low`, and that cut stays where it is on the following runs until
 * the window exceeds `limit` again.
 * The cut is not stored: it is replayed from the whole transcript, run by run,
 * so the same transcript always yields the same cut.
 */
export function fitActiveWindow(messages, limit = ACTIVE_CONTEXT_CHARS, low = Math.floor(limit / 2)) {
  let index = 0;
  const lead = [];
  while (index < messages.length && messages[index].role === 'system') lead.push(messages[index++]);
  const runs = [];
  for (; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user' || !runs.length) runs.push([message]);
    else runs.at(-1).push(message);
  }
  const sizes = runs.map(run => run.reduce((total, message) => total + JSON.stringify(message).length, 0));
  // Replay: `start` is the first kept run after each run was added; `total` is the size of the kept runs.
  let start = 0, total = 0;
  for (let last = 0; last < runs.length; last++) {
    total += sizes[last];
    if (total + (start ? WINDOW_MARKER.length : 0) <= limit) continue;
    const protectedFrom = Math.max(0, last - 2);
    // The low-water mark is measured without the newest run, so the cut is the same whether that run
    // is still only its user message (request time) or complete (stored); then make that run fit.
    while (total - sizes[last] + WINDOW_MARKER.length > low && start < protectedFrom) total -= sizes[start++];
    while (total + WINDOW_MARKER.length > limit && start < protectedFrom) total -= sizes[start++];
  }
  if (!start) { if (total > limit) throw fail('ACTIVE_CONTEXT_LIMIT'); return messages; }
  if (total + WINDOW_MARKER.length > limit) throw fail('ACTIVE_CONTEXT_LIMIT');
  const [head, ...rest] = lead;
  if (head?.role !== 'system' || typeof head.content !== 'string') throw fail('ACTIVE_CONTEXT_LIMIT');
  return [{ ...head, content: head.content + '\n\n' + WINDOW_MARKER }, ...rest, ...runs.slice(start).flat()];
}
