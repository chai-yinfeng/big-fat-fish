// What the page says in words. Everything is chosen from fixed sentences by the state's categories; nothing
// here can print a name, a message or a title, because the state has none and no text is taken from it.
import { validateRoomState } from './state.js';

export const ACTIVITY_TEXT = Object.freeze({
  idle: ['发呆', '她在发呆，什么也没做。'],
  // The signal is only "a conversation moved just now": she may be answering or just scrolling, so the words say neither.
  replying: ['看手机', '她在看手机。'],
  speaking: ['说话', '她在说话（发语音）。'],
  watching: ['看视频', '她在看视频。'],
  writing: ['写日记', '她在写日记。'],
  working: ['忙自己的事', '她在后台忙一件事。'],
  sleeping: ['睡觉', '她睡了，安静时段不打扰。'],
});
export const WEATHER_TEXT = Object.freeze({ clear: '晴', cloudy: '多云', rain: '下雨', snow: '下雪' });
export const PHASE_TEXT = Object.freeze({ dawn: '清晨', day: '白天', dusk: '傍晚', night: '夜里' });
export const MOOD_TEXT = Object.freeze({ calm: '平静', cheerful: '开心', tired: '困' });
const two = value => String(value).padStart(2, '0');
export function clockText(minute) { return two(Math.floor(minute / 60)) + ':' + two(minute % 60); }
/** How long, coarsely: the room never shows an exact instant of anything. */
export function durationText(ms) {
  const minutes = Math.floor(ms / 60000);
  return minutes < 1 ? '刚刚开始' : minutes < 60 ? `已经 ${minutes} 分钟` : `已经 ${Math.floor(minutes / 60)} 小时多`;
}
/** The one line under the room. */
export function caption(state) {
  validateRoomState(state);
  return `${ACTIVITY_TEXT[state.activity][0]} · ${clockText(state.clock.minute)} ${PHASE_TEXT[state.clock.phase]} · ${WEATHER_TEXT[state.weather]}`;
}
/** The notebook on the desk (hotspot `shows: 'diary'`): fixed words only. What it shows after a passcode is one
 * person's own open diaries, which are not part of the room state and are never drawn anywhere else. */
export const NOTEBOOK_TEXT = Object.freeze({
  title: '笔记本',
  hint: '这是她写给你的日记。在和她的私聊里发“日记口令”，她会告诉你口令。',
  label: '日记口令', open: '翻开', empty: '最近 30 天还没有写给你的日记。',
});
/** A hotspot's drawer: `{ title, lines }` for one of the manifest's `shows` kinds (the notebook is not a drawer). */
export function drawer(shows, state) {
  validateRoomState(state);
  if (shows === 'activity') return { title: ACTIVITY_TEXT[state.activity][0], lines: [ACTIVITY_TEXT[state.activity][1], durationText(state.at - state.since), ...(state.mood ? ['看起来' + MOOD_TEXT[state.mood] + '。'] : [])] };
  if (shows === 'weather') return { title: '窗外', lines: ['窗外' + WEATHER_TEXT[state.weather] + '。'] };
  if (shows === 'clock') return { title: '时间', lines: [`北京时间 ${clockText(state.clock.minute)}，${PHASE_TEXT[state.clock.phase]}。`] };
  if (shows === 'lamp') return { title: '灯', lines: [state.lamp === 'on' ? '灯开着。' : '灯关着。'] };
  throw new Error('Unknown drawer');
}
