// Group chat (phase 2): she answers in an enabled group only when she is called, and what she is shown of the group
// is the few lines before that. Pure functions and default numbers; the bridge (bridge.js) does the rest.
// Every number here is a default; qq-bridge.json may override any of them under an optional `group` object (checked by
// `groupFrom`; the bridge refuses to start on a bad value). No release writes that key: only staging does.
import { GROUP_CALLED } from '../conversation/executor.js';
import { MENTION_OPEN, MENTION_CLOSE } from './source.js';

/** - context*: the lines of a group nobody called her with are kept in memory only (never on disk, never sent to
 *   Authority or a model). When she is called, the lines since she last spoke are recorded with the call and shown to
 *   her: the newest `contextMessages` of them, or every one of the last `contextWindowMs`, whichever is more, but never
 *   more than `contextMaxMessages` lines or `contextMaxChars` characters (the newest are kept). One kept line holds at
 *   most `contextLineChars` characters.
 * - burstMaxMessages: one turn answers at most this many messages that call her (several people at once included).
 * - replyMaxMessages: her reply goes out as at most this many messages (more is joined into the last one).
 * - perSenderTurns / perSenderWindowMs: one account may call her this many times in this long; more is silence.
 * - perGroupMessagesPerHour: messages she sends to one group in an hour.
 * - perGroupTurnsPerDay: turns in one group in a Beijing day (kept in the state file).
 * - voicePerHour: voice messages to one group in an hour; over it the reply is text.
 * - queuedTurns: turns of one group waiting or running; a call beyond that is dropped.
 * - groupConcurrency: group turns running at once, of the bridge's two; the rest stays free for private chat.
 * - memberRefreshMs: how often each enabled group's member list is read again.
 * - maxMembers: a larger group is not enabled (the control socket's check) and its member list is not read. */
export const GROUP = Object.freeze({
  contextMessages: 15, contextWindowMs: 7200000, contextMaxMessages: 50, contextMaxChars: 4000, contextLineChars: 500,
  burstMaxMessages: 4, replyMaxMessages: 2,
  perSenderTurns: 6, perSenderWindowMs: 600000,
  perGroupMessagesPerHour: 20, perGroupTurnsPerDay: 60, voicePerHour: 3,
  queuedTurns: 3, groupConcurrency: 1,
  memberRefreshMs: 600000, maxMembers: 100,
});
/** Allowed range of each setting (inclusive). */
const RANGES = {
  contextMessages: [0, 50], contextWindowMs: [0, 86400000], contextMaxMessages: [0, 100], contextMaxChars: [0, 12000], contextLineChars: [50, 4000],
  burstMaxMessages: [1, 8], replyMaxMessages: [1, 4],
  perSenderTurns: [1, 1000], perSenderWindowMs: [1000, 86400000],
  perGroupMessagesPerHour: [1, 1000], perGroupTurnsPerDay: [1, 10000], voicePerHour: [0, 100],
  queuedTurns: [1, 10], groupConcurrency: [1, 2],
  memberRefreshMs: [10000, 86400000], maxMembers: [2, 200],
};
/** The settings with qq-bridge.json's optional `group` overrides; throws on an unknown key or a value out of range. */
export function groupFrom(overrides) {
  if (overrides === undefined) return GROUP;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('QQ_CONFIG');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(RANGES, key) || !Number.isInteger(value) || value < RANGES[key][0] || value > RANGES[key][1]) throw new Error('QQ_CONFIG');
  }
  return Object.freeze({ ...GROUP, ...overrides });
}

const loose = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
/** Whether a group message calls her, and how: 'at' (it mentions her account), 'reply' (it quotes a message of hers)
 * or 'name' (the person typed her name or one of her other names), otherwise null. Mentioning everyone is not a
 * call. A name counts only in what the person typed themselves (never in a quoted message, a card title, a picture
 * or a transcript), compared without case, width or spaces; a name of one character is never a call; and a message
 * that mentions somebody else and not her speaks about her to them, so its names do not count. */
export function addressed(message, { callNames = [], isReplyToHer = false } = {}) {
  if (message?.mentionsSelf === true) return 'at';
  if (isReplyToHer) return 'reply';
  if (message?.mentions?.length) return null;
  const typed = loose(message?.typedText);
  return typed && callNames.some(name => { const wanted = loose(name); return [...wanted].length >= 2 && typed.includes(wanted); }) ? 'name' : null;
}

/** A person's text as one line of a group turn: line breaks become " / ", square brackets become full-width ones
 * (no line head of somebody else can be made up) and member-label brackets become ordinary ones (no label can). */
export function flat(text) {
  return String(text ?? '').replace(/\r?\n|[\u2028\u2029]/g, ' / ').replace(/[\p{Cc}]/gu, ' ').replaceAll('[', '［').replaceAll(']', '］').replaceAll('〔', '（').replaceAll('〕', '）').replace(/ {2,}/g, ' ').trim();
}
/** `text` with every mention of another member (source.js MENTION_OPEN…MENTION_CLOSE) written as `@card〔label〕`;
 * `who(uid)` gives `{ name, label }` or null for somebody the bridge does not know. Done after `flat`, so the
 * brackets of a label are the bridge's own. */
export function withMentions(text, who) {
  return text.replace(new RegExp(`${MENTION_OPEN}(\\d{1,20})${MENTION_CLOSE}`, 'g'), (_, uid) => { const member = who(uid); return member ? `@${speaker(member)}` : '@某人'; });
}
/** How a member is named wherever she sees one: the card (untrusted, may be empty) and the member label. */
export const speaker = ({ name, label }) => `${name || '群友'}〔${label}〕`;
/** One line of a group turn: who said it, marked when it called her, then what they said (already `flat`). */
export function groupLine({ name, label, text, called = false }) {
  return `[${called ? `${GROUP_CALLED} · ` : ''}${speaker({ name, label })}] ${text}`;
}
/** The head of a group turn's text; `context`: whether lines that did not call her come with it. */
export const groupHead = context => context ? `[群聊 · 下面是你上次说话之后群里的几句，只是上下文；带“${GROUP_CALLED}”的才是对你说的]` : `[群聊 · 带“${GROUP_CALLED}”的是对你说的]`;
/** The line put before a group message that quotes another: whose words (her own, or a member's) and what they say. */
export function groupQuoteLine(who, text) {
  return !text || !who ? '［引用了一条消息］' : `［引用 ${who === 'self' ? '你之前说的' : `${speaker(who)} 之前说的`}：${text}］`;
}

/** The lines of a group kept in memory until she is called. `settings`: GROUP (or its overrides). */
export class GroupBuffer {
  constructor(settings = GROUP) { this.settings = settings; this.lines = []; }
  /** Keeps what a later call may still take: the lines of the window, or the newest few if those are more, within the
   * hard bounds (the newest stay). Lines already recorded (`observationId`) wait for the run that shows them. */
  trim(now) {
    const { contextMessages, contextWindowMs, contextMaxMessages, contextMaxChars } = this.settings;
    const recent = this.lines.filter(line => now - line.at <= contextWindowMs).length;
    const wanted = Math.min(Math.max(recent, Math.min(contextMessages, this.lines.length)), contextMaxMessages), kept = wanted ? this.lines.slice(-wanted) : [];
    let chars = 0, from = kept.length;
    while (from > 0 && chars + kept[from - 1].text.length <= contextMaxChars) chars += kept[--from].text.length;
    this.lines = kept.slice(from);
  }
  /** `line`: { eventId, actorId, uid, name, text (flat, not yet with mentions), at, arrival }. The same message twice is kept once. */
  push(line, now) {
    if (this.lines.some(kept => kept.eventId === line.eventId)) return;
    const chars = [...line.text];
    this.lines.push({ ...line, text: chars.length > this.settings.contextLineChars ? chars.slice(0, this.settings.contextLineChars - 1).join('') + '…' : line.text });
    this.trim(now);
  }
  /** The lines a turn starting now shows, oldest first. They stay here until `drop` (a run that showed them was stored). */
  take(now) { this.trim(now); return [...this.lines]; }
  drop(lines) { const gone = new Set(lines.map(line => line.eventId)); this.lines = this.lines.filter(line => !gone.has(line.eventId)); }
}

/** Sliding-window counters, in memory: `allow(key, limit, windowMs, now)` says whether one more fits (and counts it),
 * `count(key, windowMs, now)` how many are in the window, `add(key, now)` counts one. */
export class Limiter {
  constructor() { this.hits = new Map(); }
  count(key, windowMs, now) {
    const kept = (this.hits.get(key) ?? []).filter(at => now - at < windowMs);
    if (kept.length) this.hits.set(key, kept); else this.hits.delete(key);
    return kept.length;
  }
  add(key, now) { this.hits.set(key, [...(this.hits.get(key) ?? []), now]); }
  allow(key, limit, windowMs, now) {
    if (this.count(key, windowMs, now) >= limit) return false;
    this.add(key, now); return true;
  }
}
