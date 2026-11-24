// Her intents ("打算"): a short to-do she leaves herself about one person, optionally with a Beijing date
// ("明天问问面试怎么样"). Stored like any reviewed memory (no schema change): a memory_items row, collection 'notes',
// kind 'intent', owned by that person and private. The body carries `dueDate` (Beijing YYYY-MM-DD or null),
// `state` ('open' | 'done' | 'expired') and `expiresAt` (ms), fixed when it is written. Nothing here sends a message.

const DAY = 86400000, BEIJING = 8 * 3600000;
export const INTENT = Object.freeze({
  /** Unsettled intents one person may have at a time; a proposal over it is refused (`intent_limit_reached`). */
  openPerPerson: 5,
  /** An intent with a date lapses this many days after that day; one without a date this many days after it was written. */
  graceDays: 3, undatedDays: 14,
  /** Its text. */
  chars: 500,
  /** Intents consolidation may propose from one batch. */
  perBatch: 2,
});
export const INTENT_STATES = ['open', 'done', 'expired'];

/** A Beijing calendar date `YYYY-MM-DD` that exists, or false. */
export function validDueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}
/** When an intent written at `at` lapses: the end of its Beijing due day plus the grace days, or `undatedDays` after `at`. */
export function intentExpiresAt(dueDate, at) {
  if (dueDate == null) return at + INTENT.undatedDays * DAY;
  return Date.parse(dueDate + 'T00:00:00Z') - BEIJING + (1 + INTENT.graceDays) * DAY;
}
/** What an intent is at `now`: its stored state, except that an open one past its `expiresAt` has expired. */
export function intentState(entry, now) {
  const state = INTENT_STATES.includes(entry?.state) ? entry.state : 'open';
  return state === 'open' && Number.isFinite(entry?.expiresAt) && now >= entry.expiresAt ? 'expired' : state;
}
/** SQL over memory_items `m`: the row is not an intent, or is one still open at the bound time (one `?` argument: now). */
export const OPEN_INTENT_SQL = "(COALESCE(m.kind,'')<>'intent' OR (json_extract(m.body,'$.state')='open' AND json_extract(m.body,'$.expiresAt')>?))";
