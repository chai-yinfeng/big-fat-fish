// Fake provider: fixtures and one scripted day that passes through every activity. Deterministic: the state
// is a function of the instant alone, so tests and the page agree. Nothing here reads Authority.
import { ACTIVITIES, roomState } from '../state.js';

/** One scripted day. `minute` is the Beijing minute shown on the room's clock while the step lasts. */
export const TIMELINE = Object.freeze([
  { minute: 6 * 60 + 40, activity: 'sleeping', weather: 'clear', mood: 'tired' },
  { minute: 8 * 60 + 10, activity: 'idle', weather: 'clear', mood: 'calm' },
  { minute: 9 * 60 + 30, activity: 'replying', weather: 'cloudy', mood: 'cheerful' },
  { minute: 11 * 60, activity: 'working', weather: 'cloudy', mood: 'calm' },
  { minute: 14 * 60, activity: 'watching', weather: 'rain', mood: 'cheerful' },
  { minute: 16 * 60 + 30, activity: 'speaking', weather: 'rain', mood: 'cheerful' },
  { minute: 18 * 60 + 20, activity: 'idle', weather: 'clear', mood: 'calm' },
  { minute: 21 * 60 + 30, activity: 'writing', weather: 'snow', mood: 'calm' },
  { minute: 23 * 60 + 40, activity: 'sleeping', weather: 'snow', mood: 'tired' },
].map(Object.freeze));
export const STEP_MS = 6000;

/** The timeline's state at `at`: each step lasts `stepMs`, then the day starts again. */
export function fakeState(at, { stepMs = STEP_MS } = {}) {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(stepMs) || stepMs < 1) throw new Error('Invalid fake clock');
  const step = Math.floor(at / stepMs);
  return roomState({ source: 'fake', at, since: step * stepMs, ...TIMELINE[step % TIMELINE.length] });
}
/** One fixed state per activity (the dev control and tests). `overrides` may set weather, lamp, minute, mood. */
export function fixture(activity, at = 0, overrides = {}) {
  const step = TIMELINE.find(item => item.activity === activity);
  if (!step) throw new Error('Unknown activity');
  return roomState({ source: 'fake', at, since: at, ...step, ...overrides, activity });
}
export const FIXTURES = Object.freeze(Object.fromEntries(ACTIVITIES.map(activity => [activity, Object.freeze(fixture(activity))])));
