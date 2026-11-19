// Room state contract (v1). The room is a window onto Authority's world: it shows the CATEGORY of what she is
// doing and decides nothing. Several people may look at the same room, so a state carries no person, no
// conversation, no text and no id: every key is listed here and every string value comes from a closed list.
// No dependency; the same file is loaded by the browser page and by node tests.
export const VERSION = 1;
export const TIMEZONE = 'Asia/Shanghai';
/** What she is doing, as a category. */
export const ACTIVITIES = Object.freeze(['idle', 'replying', 'speaking', 'watching', 'writing', 'working', 'sleeping']);
/** The poses the art may be asked for, per activity; the first is the default. */
export const POSES = Object.freeze({
  idle: Object.freeze(['sitting']), replying: Object.freeze(['phone']), speaking: Object.freeze(['mic']), watching: Object.freeze(['screen']),
  writing: Object.freeze(['notebook']), working: Object.freeze(['laptop']), sleeping: Object.freeze(['bed']),
});
export const ALL_POSES = Object.freeze(Object.values(POSES).flat());
export const WEATHERS = Object.freeze(['clear', 'cloudy', 'rain', 'snow']);
export const LAMPS = Object.freeze(['on', 'off']);
export const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);
export const MOODS = Object.freeze(['calm', 'cheerful', 'tired']);
export const SOURCES = Object.freeze(['fake', 'authority']);
const KEYS = Object.freeze(['version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose', 'mood']);
const CLOCK_KEYS = Object.freeze(['timezone', 'minute', 'phase']);
const DAY = 86400000, BEIJING = 8 * 3600000;

/** Minute of the Beijing day (0..1439) of a millisecond instant. Beijing has no daylight saving time. */
export function beijingMinute(at) { return Math.floor((((at + BEIJING) % DAY) + DAY) % DAY / 60000); }
/** The lighting phase of a minute of the day: dawn 05:00, day 07:30, dusk 17:30, night 19:30. */
export function phaseOf(minute) { return minute < 300 ? 'night' : minute < 450 ? 'dawn' : minute < 1050 ? 'day' : minute < 1170 ? 'dusk' : 'night'; }
export function clockOf(minute) { return { timezone: TIMEZONE, minute, phase: phaseOf(minute) }; }
/** The lamp when nobody says otherwise: on in the dark while she is up. */
export function defaultLamp(phase, activity) { return activity !== 'sleeping' && (phase === 'dusk' || phase === 'night') ? 'on' : 'off'; }

const fail = message => { throw Object.assign(new Error(message), { code: 'ROOM_STATE_INVALID' }); };
const instant = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Throws ROOM_STATE_INVALID unless `state` is exactly a room state: no unknown key, no free text. Returns it. */
export function validateRoomState(state) {
  if (!plain(state)) fail('Room state is an object');
  for (const key of Object.keys(state)) if (!KEYS.includes(key)) fail('Unknown room state field: ' + key);
  if (state.version !== VERSION) fail('Unsupported room state version');
  if (!SOURCES.includes(state.source)) fail('Unknown source');
  if (!instant(state.at) || !instant(state.since) || state.since > state.at) fail('Invalid at/since');
  if (!plain(state.clock) || Object.keys(state.clock).some(key => !CLOCK_KEYS.includes(key))) fail('Invalid clock');
  const { timezone, minute, phase } = state.clock;
  if (timezone !== TIMEZONE || !Number.isInteger(minute) || minute < 0 || minute > 1439 || phase !== phaseOf(minute)) fail('Invalid clock');
  if (!WEATHERS.includes(state.weather)) fail('Unknown weather');
  if (!LAMPS.includes(state.lamp)) fail('Unknown lamp');
  if (!ACTIVITIES.includes(state.activity)) fail('Unknown activity');
  if (!POSES[state.activity].includes(state.pose)) fail('Pose does not belong to the activity');
  if (state.mood !== undefined && !MOODS.includes(state.mood)) fail('Unknown mood');
  return state;
}
export function isRoomState(state) { try { validateRoomState(state); return true; } catch { return false; } }

/** Build a room state from loose input. Only the contract's own fields are read; anything else on `input` (a
 * person, a message, a title) is dropped, never copied. `minute` overrides the clock (the fake timeline's
 * scripted day); otherwise the clock is the Beijing time of `at`. */
export function roomState(input) {
  if (!plain(input)) fail('Room state input is an object');
  const { source, at, since, minute, weather, lamp, activity, pose, mood } = input;
  if (!ACTIVITIES.includes(activity) || !instant(at)) fail('Room state needs an activity and an instant');
  const clock = clockOf(minute === undefined ? beijingMinute(at) : minute);
  return validateRoomState({
    version: VERSION, source, at, since: since === undefined ? at : since, clock, weather: weather ?? 'clear',
    lamp: lamp ?? defaultLamp(clock.phase, activity), activity, pose: pose ?? POSES[activity][0], ...(mood === undefined ? {} : { mood }),
  });
}
