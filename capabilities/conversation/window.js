const fail = code => Object.assign(new Error(code), { code });
/** High-water mark of the replayed history, in serialized characters: above it the window is cut. */
export const ACTIVE_CONTEXT_CHARS = 16000;
/** Low-water mark: one cut brings the runs before the newest one down to this. */
export const ACTIVE_CONTEXT_LOW_CHARS = 8000;
const lowFor = limit => Math.floor(limit * ACTIVE_CONTEXT_LOW_CHARS / ACTIVE_CONTEXT_CHARS);
export const WINDOW_MARKER = 'Older completed execution dialogue is outside the active window. No facts are asserted by this maintenance marker. Retrieve authoritative long-term memory with companion_scope search/read when needed.';

/** Where the window starts: the leading system messages, the runs, and the index of the first kept run. */
function cut(messages, limit, low) {
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
  let start = 0, total = 0, persona;
  for (let last = 0; last < runs.length; last++) {
    total += sizes[last];
    // A run made under another persona revision than the last one known: only the two runs before it stay.
    const revision = runs[last][0].hub?.personaRevision;
    if (Number.isSafeInteger(revision)) {
      if (persona !== undefined && revision !== persona) while (start < last - 2) total -= sizes[start++];
      persona = revision;
    }
    if (total + (start ? WINDOW_MARKER.length : 0) <= limit) continue;
    const protectedFrom = Math.max(0, last - 2);
    // The low-water mark is measured without the newest run, so the cut is the same whether that run
    // is still only its user message (request time) or complete (stored); then make that run fit.
    while (total - sizes[last] + WINDOW_MARKER.length > low && start < protectedFrom) total -= sizes[start++];
    while (total + WINDOW_MARKER.length > limit && start < protectedFrom) total -= sizes[start++];
  }
  if (total + (start ? WINDOW_MARKER.length : 0) > limit) throw fail('ACTIVE_CONTEXT_LIMIT');
  return { lead, runs, start };
}

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
 * A persona change also cuts: the first run made under a new persona revision
 * (`hub.personaRevision` on its user message) keeps only the two runs before it,
 * so the old tone is not replayed. Runs without that record never cut.
 * The cut is not stored: it is replayed from the whole transcript, run by run,
 * so the same transcript always yields the same cut.
 */
export function fitActiveWindow(messages, limit = ACTIVE_CONTEXT_CHARS, low = lowFor(limit)) {
  const { lead, runs, start } = cut(messages, limit, low);
  if (!start) return messages;
  const [head, ...rest] = lead;
  if (head?.role !== 'system' || typeof head.content !== 'string') throw fail('ACTIVE_CONTEXT_LIMIT');
  return [{ ...head, content: head.content + '\n\n' + WINDOW_MARKER }, ...rest, ...runs.slice(start).flat()];
}

/** The dialogue messages `fitActiveWindow` keeps for this transcript (no system message needed). */
export function activeDialogue(messages, limit = ACTIVE_CONTEXT_CHARS, low = lowFor(limit)) {
  const { runs, start } = cut(messages, limit, low);
  return runs.slice(start).flat();
}
