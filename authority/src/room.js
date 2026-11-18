// The room's projection: what a page that several people may look at is allowed to know about her. A category of
// activity, when it began, the Beijing clock and fixed defaults; no person, conversation, text, title or id. Pure
// and dependency-free. The shape is the room state contract v1 (room/state.js, which is not part of a release;
// room/room.test.mjs holds the two together).
const DAY = 86400000, BEIJING = 8 * 3600000;
/** A conversation that moved within this time shows her with her phone. Only the time of the newest message in
 * either direction is known, so this says nothing about who wrote or whether she is answering. */
export const PHONE_MS = 90000;
const POSE = { idle: 'sitting', replying: 'phone', working: 'laptop', sleeping: 'bed' };
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const minuteOf = at => Math.floor((at + BEIJING) % DAY / 60000);

function state(now, activity, since) {
  const minute = minuteOf(now), phase = minute < 300 ? 'night' : minute < 450 ? 'dawn' : minute < 1050 ? 'day' : minute < 1170 ? 'dusk' : 'night';
  // Weather has no source yet: always the neutral default. Mood has none either and is left out.
  return { version: 1, source: 'authority', at: now, since, clock: { timezone: 'Asia/Shanghai', minute, phase }, weather: 'clear',
    lamp: activity !== 'sleeping' && (phase === 'dusk' || phase === 'night') ? 'on' : 'off', activity, pose: POSE[activity] };
}
/** `now` in milliseconds; `paused` the world; `quiet` `{ now, fromMinute }` (inside the quiet hours, and the minute of
 * the Beijing day they begin); `jobs` the content service's job rows (only `status` and `startedAt` are read);
 * `lastAts` times of recent messages. A missing or malformed input is ignored. In order: a conversation moved just
 * now -> phone (also at night); quiet hours -> asleep; a job is running -> working; otherwise idle. */
export function roomProjection({ now, paused, quiet, jobs, lastAts } = {}) {
  if (time(now) === null) throw new Error('Invalid now');
  const lastAt = Math.max(-1, ...(Array.isArray(lastAts) ? lastAts : []).map(time).filter(at => at !== null && at <= now));
  if (paused !== true && lastAt >= 0 && now - lastAt <= PHONE_MS) return state(now, 'replying', lastAt);
  if (quiet?.now === true) {
    const from = Number.isInteger(quiet.fromMinute) && quiet.fromMinute >= 0 && quiet.fromMinute < 1440 ? quiet.fromMinute : null;
    return state(now, 'sleeping', from === null ? now : Math.max(0, Math.floor(now / 60000) * 60000 - (minuteOf(now) - from + 1440) % 1440 * 60000));
  }
  const running = paused === true ? [] : (Array.isArray(jobs) ? jobs : []).filter(job => job?.status === 'running').map(job => time(job.startedAt) ?? now).filter(at => at <= now);
  if (running.length) return state(now, 'working', Math.min(...running));
  return state(now, 'idle', lastAt >= 0 ? lastAt : now);
}
