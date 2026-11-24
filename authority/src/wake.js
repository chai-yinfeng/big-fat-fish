// Her private wake-up (design §3.3, step 6b): a turn of her own, in a conversation that is nobody's. A scheduler here
// decides when (no model is asked); the bridge of the channel the owner last spoke on fetches it with its other
// initiated runs (`kind: 'wake'`), runs it and sends nothing. In it she may rest, write down a mood or a note, and
// say whether she feels like reaching out. In this step that last choice is only worked through (who would have been
// picked, with which weights) and logged: no request to anybody is ever made from it.
// What she is told (the briefing) is the time and counts about herself. No name, label, account, word, fact, digest
// or intent of any person is in it; the run's conversation is bound to the reserved person `person:self`, who is
// nobody, so the ordinary visibility rule gives it no person's memory either.
// Storage (no schema change): the metadata keys 'initiative' (settings, schedule, moods, notes, the wake that is out)
// and 'initiative.log' (the newest wake-ups and, merged per Beijing day, why one that was due did not happen). The
// reserved conversation is an ordinary `streams` row. A release from before this ignores both keys and never fetches
// a wake.
import { SENSITIVE } from './policies.js';
import { SELF_PERSON } from './identity.js';
import { UNSAFE_DIGEST } from './consolidation.js';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, BEIJING = 8 * HOUR;
export { SELF_PERSON };
/** Her own conversation on a channel (inside the channel's namespace, like every conversation ID). */
export const selfStream = capabilityId => `${capabilityId}:self`;
export const WAKE = Object.freeze({
  /** About every 3 hours, shifted at random by up to half an hour either way. */
  intervalMs: 3 * HOUR, jitterMs: 30 * MINUTE,
  /** Something that brings the next wake-up forward (an intent that came due, the operator) still leaves this long between two. */
  minGapMs: 45 * MINUTE,
  /** Wake-ups a Beijing day: the default, and the most the operator may set. */
  perDay: 8, perDayMax: 24,
  /** High fuse (design §3.4): more wake-ups than this in a day is a fault, whatever the setting says. */
  fuseWakesPerDay: 48,
  /** A wake-up held back because the bridge had turns queued is tried again this much later. */
  busyRetryMs: 5 * MINUTE,
  moodChars: 120, noteChars: 400, moods: 30, notes: 30, log: 300,
});
export const OUTREACH_TIERS = Object.freeze(['none', 'maybe', 'yes']);
/** How a fetched wake may end, as the bridge reports it; besides these, `dropped:<reason>`. */
export const WAKE_OUTCOMES = Object.freeze(['done', 'failed', 'unknown', 'deferred:budget']);
/** Picking a person (design §3.4): the defaults of every weight, and the high fuses. In this step they are only worked through. */
export const SELECTION = Object.freeze({
  maybeChance: 0.3, noneWeight: 1,
  /** Forced rules: nobody both sides wrote to within this time, nobody with an accepted boundary appraisal this recent. */
  recentMs: 30 * MINUTE, boundaryMs: 14 * DAY,
  intentDue: 4, intentOpen: 2,
  chatterMs: 14 * DAY, chatterCap: 100, chatterPer: 50,
  gap: Object.freeze({ underDay: 0.5, underThreeDays: 1, underTwoWeeks: 1.5, longer: 1 }),
  reachedMs: 7 * DAY,
  unanswered: 0.25, unansweredFloor: 0.05,
  newcomerMs: 3 * DAY, newcomerLines: 20, newcomer: 0.3,
  fuses: Object.freeze({ per_day: 20, per_person_day: 4, per_person_week: 12, per_hour: 3 }),
});

export const beijingDay = at => new Date(at + BEIJING).toISOString().slice(0, 10);
export const beijingMidnight = at => Math.floor((at + BEIJING) / DAY) * DAY - BEIJING;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const beijingClock = at => { const d = new Date(at + BEIJING), two = value => String(value).padStart(2, '0'); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEKDAYS[d.getUTCDay()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
/** A span of time in her words. */
export function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  return minutes < 1 ? '不到 1 分钟' : minutes < 60 ? `${minutes} 分钟` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
}

/** The next regular wake-up after `now`: the interval, shifted by up to the jitter either way (`random` in [0,1)). */
export const regularNext = (now, random) => now + WAKE.intervalMs + Math.round((2 * random() - 1) * WAKE.jitterMs);
/** The first wake-up after the quiet hours `now` is in: when they end, plus up to the jitter. */
export function afterQuiet(now, quiet, random) {
  const minute = Math.floor((now + BEIJING) / MINUTE) % 1440, wait = ((quiet.toMinute - minute + 1440) % 1440) || 1440;
  return Math.floor(now / MINUTE) * MINUTE + wait * MINUTE + Math.round(random() * WAKE.jitterMs);
}
/** The first wake-up of the next Beijing day. */
export const nextDay = (now, random) => beijingMidnight(now) + DAY + Math.round(random() * WAKE.jitterMs);

/** Why a mood or a note is not kept (the checks of a machine digest: the sensitive lexicon, a note delimiter, 7 or
 * more consecutive digits), or null. */
export function refusedText(value, max) {
  if (typeof value !== 'string' || !value.trim()) return 'empty';
  if ([...value].length > max) return 'too_long';
  if (SENSITIVE.test(value)) return 'sensitive';
  if (UNSAFE_DIGEST.test(value)) return 'unsafe_text';
  return null;
}

const TIER_WORDS = { none: '不想主动找人', maybe: '看情况', yes: '想找人聊聊' };
const REASON_WORDS = { schedule: '到点了', intent_due: '有打算到了该办的日子', manual: '主人让你现在醒一次' };
/** What she is told when she wakes. Everything in it is about herself: the time, her last mood and tier, and counts.
 * `counts`: { wokeToday, sinceLastMs|null, reachedToday, intentPeople, chattedPeople }. `mood`: { text, at } or null
 * (her own earlier words, checked when they were stored). No person appears in any form. */
export function renderBriefing({ now, reason, counts, mood, tier }) {
  return [
    `现在是 ${beijingClock(now)}（北京时间）。这次醒来是因为：${REASON_WORDS[reason] ?? REASON_WORDS.schedule}。`,
    mood ? `你上次写下的心情（${ago(now - mood.at)}前）：${JSON.stringify(mood.text)}` : '你还没有写过心情。',
    `你现在的档位：${TIER_WORDS[tier]}（${tier}）。`,
    `关于你自己的几个数：今天这是第 ${counts.wokeToday + 1} 次醒来；${counts.sinceLastMs === null ? '之前还没有醒过' : `上次醒来是 ${ago(counts.sinceLastMs)}前`}；今天你主动找过 ${counts.reachedToday} 个人；有 ${counts.intentPeople} 个人身上有你留的、到今天该办的打算；今天有 ${counts.chattedPeople} 个人和你聊过。`,
  ].join('\n');
}

// Weights are kept to six decimals: what is logged is what was drawn over.
const rounded = value => Math.round(value * 1e6) / 1e6;
/** One candidate's weight (design §3.4, the product of the factors). `stats`: { intent: 'due'|'open'|'none',
 * lines14, lastAt|null, reached7, unanswered, firstAt|null, lines }. */
export function candidateWeights(stats, now, rules = SELECTION) {
  const since = stats.lastAt === null ? Infinity : now - stats.lastAt;
  const weights = {
    intent: stats.intent === 'due' ? rules.intentDue : stats.intent === 'open' ? rules.intentOpen : 1,
    chatter: 1 + Math.min(stats.lines14, rules.chatterCap) / rules.chatterPer,
    gap: since < DAY ? rules.gap.underDay : since < 3 * DAY ? rules.gap.underThreeDays : since < 14 * DAY ? rules.gap.underTwoWeeks : rules.gap.longer,
    reached: 1 / (1 + stats.reached7),
    unanswered: stats.unanswered ? Math.max(rules.unansweredFloor, rules.unanswered ** stats.unanswered) : 1,
    newcomer: stats.firstAt === null || now - stats.firstAt < rules.newcomerMs || stats.lines < rules.newcomerLines ? rules.newcomer : 1,
  };
  return { weights, weight: rounded(Object.values(weights).reduce((product, value) => product * value, 1)) };
}

/** The pick itself, worked through and not acted on: `tier` 'maybe' first takes its chance; then one draw over the
 * candidates and "nobody this time". `candidates`: [{ person (opaque label), weights, weight }] in a fixed order.
 * `random` is drawn once for the chance (maybe only) and once for the pick. */
export function pick({ tier, candidates, excluded, random, rules = SELECTION }) {
  const selection = { tier, dryRun: true, candidates, excluded, noneWeight: rules.noneWeight, total: null, chance: null, random: null, result: 'none' };
  if (tier === 'maybe') {
    const roll = random();
    selection.chance = { needed: rules.maybeChance, roll, passed: roll < rules.maybeChance };
    if (!selection.chance.passed) return selection;
  }
  const total = rounded(candidates.reduce((sum, candidate) => sum + candidate.weight, rules.noneWeight)), roll = random();
  selection.total = total; selection.random = roll;
  let cursor = roll * total;
  for (const candidate of candidates) { cursor -= candidate.weight; if (cursor < 0) { selection.result = candidate.person; break; } }
  return selection;
}
