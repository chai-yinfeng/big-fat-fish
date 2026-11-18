// Pure mapping from what Authority can already read out to a room state. Nothing here calls Authority: the
// caller hands in the values of existing read-only operator routes, and the room state that comes back carries
// none of their people, labels, ids, titles or results. Not wired to anything yet (see README.md, "真实数据").
//
//   world          GET /world (.world)   authority.worldStatus()        { paused, ... }
//   initiative     GET /initiative/log   authority.initiationLog()      { quietHours: { from, to, now }, ... }
//   jobs           GET /jobs             authority.jobList()            { jobs: [{ status, startedAt, ... }] }
//   conversations  GET /conversations    authority.listConversations()  [{ lastAt, ... }]
import { roomState, beijingMinute } from '../state.js';

/** A conversation that moved within this time counts as "she is replying". The listing only has the time of the
 * newest message in either direction, so this is an approximation, not a typing indicator. */
export const REPLYING_MS = 90000;
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** `now` is the instant in milliseconds. Every other input is optional: a missing or malformed one is ignored. */
export function fromAuthority({ now, world, initiative, jobs, conversations } = {}) {
  if (time(now) === null) throw new Error('Invalid now');
  const base = { source: 'authority', at: now };
  const lastAt = Math.max(-1, ...(Array.isArray(conversations) ? conversations : []).map(row => time(row?.lastAt)).filter(at => at !== null && at <= now));
  const paused = world?.paused === true;
  // 1. A conversation moved just now (also at night: a message wakes her).
  if (!paused && lastAt >= 0 && now - lastAt <= REPLYING_MS) return roomState({ ...base, activity: 'replying', since: lastAt });
  // 2. Quiet hours: asleep since they began.
  if (initiative?.quietHours?.now === true) return roomState({ ...base, activity: 'sleeping', since: quietSince(now, initiative.quietHours.from) });
  // 3. A background job is running.
  const running = paused ? [] : (Array.isArray(jobs?.jobs) ? jobs.jobs : []).filter(job => job?.status === 'running').map(job => time(job.startedAt) ?? now).filter(at => at <= now);
  if (running.length) return roomState({ ...base, activity: 'working', since: Math.min(...running) });
  // 4. Nothing known: idle since the last conversation moved.
  return roomState({ ...base, activity: 'idle', since: lastAt >= 0 ? lastAt : now });
}
/** The latest instant at or before `now` at which the Beijing clock read `from` ('HH:MM'); `now` when unknown. */
function quietSince(now, from) {
  const match = typeof from === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(from) : null;
  if (!match) return now;
  const ago = (beijingMinute(now) - (Number(match[1]) * 60 + Number(match[2])) + 1440) % 1440;
  return Math.max(0, Math.floor(now / 60000) * 60000 - ago * 60000);
}
