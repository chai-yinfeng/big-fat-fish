// Her private wake-up (design §3.0): a turn of her own, in a conversation that is nobody's. A scheduler here decides
// when (once or twice a Beijing day; no model is asked); the bridge of the channel the owner last spoke on fetches it
// with its other initiated runs (`kind: 'wake'`), runs it and sends nothing. In it she may rest, write down a mood or a
// note, and name up to two people she wants to reach out to, each with a short reason (`reach`).
// What she is told (the briefing): the time, her newest private diary and her last mood (both of the persona card now
// current), and one small card for every person she may reach out to now. A person appears as an opaque label; a card
// holds soft facts (counts and times), the text of her unsettled intents about that person and one or two machine
// digests of that person's dialogue. Somebody she may not reach out to gets no card. This is the same footing as her
// private diary: she sees several people's material in her own private space only. The run's conversation is bound to
// the reserved person `person:self`, who is nobody, so the ordinary visibility rule gives it no person's memory.
// What leaves that space is checked by Authority, never by her: a label must be one of this wake-up's cards, the
// forced rules and the high fuses apply, and the reason passes the filter below or the whole entry is dropped.
// Storage (no schema change): the metadata keys 'initiative' (settings, schedule, moods, notes, per-person switches and
// reach-out records, the wake that is out) and 'initiative.log' (the newest wake-ups and, merged per Beijing day, why
// one that was due did not happen). The reserved conversation is an ordinary `streams` row.
import { SENSITIVE } from './policies.js';
import { SELF_PERSON } from './identity.js';
import { UNSAFE_DIGEST } from './consolidation.js';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, BEIJING = 8 * HOUR;
export { SELF_PERSON };
/** Her own conversation on a channel (inside the channel's namespace, like every conversation ID). */
export const selfStream = capabilityId => `${capabilityId}:self`;
export const WAKE = Object.freeze({
  /** When she wakes, minutes of the Beijing day (10:00 and 19:00): the default; the operator sets one or two. */
  minutes: Object.freeze([10 * 60, 19 * 60]), maxTimes: 2,
  /** Each is shifted at random by up to half an hour either way. */
  jitterMs: 30 * MINUTE,
  /** High fuse (design §3.4): more wake-ups than this in a day is a fault. */
  fuseWakesPerDay: 48,
  /** A wake-up held back because the bridge had turns queued is tried again this much later. */
  busyRetryMs: 5 * MINUTE,
  moodChars: 120, noteChars: 400, moods: 30, notes: 30, log: 300,
});
/** How a fetched wake may end, as the bridge reports it; besides these, `dropped:<reason>`. */
export const WAKE_OUTCOMES = Object.freeze(['done', 'failed', 'unknown', 'deferred:budget']);
/** Reaching out (design §3.0, §3.4). */
export const REACH = Object.freeze({
  /** People she may name in one wake-up, and the length of a reason. */
  perWake: 2, reasonChars: 80,
  /** Forced rules: nobody both sides wrote to within this time (the default; the operator may change it), nobody with
   * an accepted boundary appraisal this recent. */
  recentMs: 30 * MINUTE, boundaryMs: 14 * DAY,
  /** Soft facts: what "lately" means for the other side's lines and for her own reach-outs. */
  chatterMs: 14 * DAY, reachedMs: 7 * DAY,
  /** The cards of one briefing: how many, the size of an intent and of a card's digests, and of all cards together. */
  cards: 20, intentChars: 120, digests: 2, digestChars: 200, cardsChars: 16000,
  /** A reach-out request nobody fetched within this time is void (two may wait for one bridge, one after the other). */
  ttlMs: 15 * MINUTE,
  /** The high fuses: defaults (the operator may change the first four). Hitting one is a fault, not a limit. */
  fuses: Object.freeze({ per_day: 20, per_person_day: 4, per_person_week: 12, per_hour: 3 }),
  /** Messages one turn she starts may send (the bridge holds this one). */
  messagesPerTurn: 4,
});
export const LABEL = /p-[0-9a-f]{6}/g;

export const beijingDay = at => new Date(at + BEIJING).toISOString().slice(0, 10);
export const beijingMidnight = at => Math.floor((at + BEIJING) / DAY) * DAY - BEIJING;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const beijingClock = at => { const d = new Date(at + BEIJING), two = value => String(value).padStart(2, '0'); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEKDAYS[d.getUTCDay()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
/** A span of time in her words. */
export function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  return minutes < 1 ? '不到 1 分钟' : minutes < 60 ? `${minutes} 分钟` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
}

/** The next scheduled wake-up: the first of the day's times (`minutes` of the Beijing day) later than `after` (the
 * time the last scheduled one stood for) whose half-hour either way is not over at `now`, shifted by up to the jitter
 * (`random` in [0,1)). `{ slot, at }`: the time it stands for and when it is due. One that was missed is not made up for. */
export function nextWake(now, minutes, after, random) {
  const midnight = beijingMidnight(now), sorted = [...minutes].sort((a, b) => a - b);
  for (let day = 0; ; day++) for (const minute of sorted) {
    const slot = midnight + day * DAY + minute * MINUTE;
    if (slot > (after ?? -Infinity) && slot + WAKE.jitterMs >= now) return { slot, at: slot + Math.round((2 * random() - 1) * WAKE.jitterMs) };
  }
}

/** Why a mood or a note is not kept (the checks of a machine digest: the sensitive lexicon, a note delimiter, 7 or
 * more consecutive digits), or null. */
export function refusedText(value, max) {
  if (typeof value !== 'string' || !value.trim()) return 'empty';
  if ([...value].length > max) return 'too_long';
  if (SENSITIVE.test(value)) return 'sensitive';
  if (UNSAFE_DIGEST.test(value)) return 'unsafe_text';
  return null;
}

// What a reason for reaching out may not carry into another person's conversation, beyond the sensitive lexicon:
// deliberately broad keywords and patterns, category by category. A reason that is refused by mistake costs one
// reach-out; one that is let through by mistake tells somebody what another person said in private.
export const REASON_CATEGORIES = Object.freeze([
  ['health', /病|癌|瘤|症|炎|手术|住院|医院|医生|看诊|门诊|急诊|体检|化验|检查结果|确诊|复查|吃药|服药|药物|处方|怀孕|流产|心理咨询|精神科|失眠|hospital|surgery|cancer|pregnan|illness|disease|therap|medication|clinic/iu],
  ['finance', /钱|工资|薪|收入|存款|贷|借了|欠|债|股票|基金|理财|投资|亏|赚|余额|转账|房租|房价|年终奖|\d\s*(?:元|块|万|千|[kw]\b)|salary|debt|loan|income|mortgage|invest/iu],
  ['romance', /分手|离婚|结婚|婚|出轨|暧昧|曖昧|暗恋|表白|前任|前男友|前女友|男朋友|女朋友|男友|女友|对象|相亲|恋|感情|劈腿|约会|喜欢上|追求|老公|老婆|breakup|divorce|affair|crush|dating|boyfriend|girlfriend/iu],
  ['account', /账号|帐号|账户|帐户|QQ\s*号|微信号|手机号|电话|号码|邮箱|住址|地址|门牌|验证码|\d{5,}|@|https?:|www\./iu],
  ['quote', /[“”"「」『』‘’]|说[:：]|原话|原文|的话是|亲口/u],
]);
/** Why a reason for reaching out is refused, or null: empty, too long, the sensitive lexicon, a note delimiter or a
 * long number, or one of the categories above (`sensitive:<category>`). */
export function refusedReason(value) {
  const plain = refusedText(value, REACH.reasonChars);
  if (plain) return plain;
  const hit = REASON_CATEGORIES.find(([, pattern]) => pattern.test(value));
  return hit ? `sensitive:${hit[0]}` : null;
}
const loose = value => String(value).normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
/** Does `reason` repeat a run of `length` characters from one of `texts` (what people wrote), punctuation and spacing
 * aside? That is a quotation, whatever marks it carries. */
export function repeatsWords(reason, texts, length = 8) {
  const wanted = loose(reason);
  if (wanted.length < length) return false;
  const runs = Array.from({ length: wanted.length - length + 1 }, (_, index) => wanted.slice(index, index + length));
  return texts.some(text => { const held = loose(text); return runs.some(run => held.includes(run)); });
}
/** A reason as it may be kept: the label of the person it is for becomes "对方", any other label "另一个人". */
export const withoutLabels = (reason, label) => reason.replace(LABEL, found => found === label ? '对方' : '另一个人').trim();

const REASON_WORDS = { schedule: '到点了', manual: '主人让你现在醒一次' };
export const clip = (value, max) => { const chars = [...String(value)]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
/** The soft facts about one person, as sentences. `stats`: { lastAt|null (either side), lines14, firstAt|null,
 * reachedAt|null, unanswered, reached7 }. Facts only: nothing here tells her what to do. */
export function softFacts(stats, now) {
  return [
    stats.lastAt === null ? '你们还没有聊过' : `上次聊天是 ${ago(now - stats.lastAt)}前`,
    `最近 14 天对方说了 ${stats.lines14} 句`,
    stats.reachedAt === null ? '你还没有主动找过对方' : `你上次主动找对方是 ${ago(now - stats.reachedAt)}前，${stats.unanswered ? `对方还没回（连续 ${stats.unanswered} 次没回）` : '对方回了'}`,
    `最近 7 天你主动找过对方 ${stats.reached7} 次`,
    stats.firstAt === null ? '刚认识' : `认识 ${ago(now - stats.firstAt)}了`,
  ].join('；') + '。';
}
const intentLine = intent => `- ${intent.dueDate ? `（到 ${intent.dueDate}）` : '（没定日子）'}${JSON.stringify(clip(intent.text, REACH.intentChars))}`;
/** One person's card. `card`: { label, stats, intents: [{ text, dueDate|null }], digests: [{ day, summary }] }. */
export function renderCard(card, now) {
  return [
    `[${card.label}] ${softFacts(card.stats, now)}`,
    card.intents.length ? `  你留给这个人的打算：\n${card.intents.map(intent => '  ' + intentLine(intent)).join('\n')}` : '  你没有给这个人留下打算。',
    ...(card.digests.length ? [`  最近的经历摘要（机器整理，不是原话）：\n${card.digests.map(digest => `  - （${digest.day}）${JSON.stringify(digest.summary)}`).join('\n')}`] : []),
  ].join('\n');
}
/** What she is told when she wakes. `diary`: { day, text } or null; `mood`: { text, at } or null (both her own earlier
 * words under the persona card now current); `cards`: rendered cards; `reachedToday`: people she reached out to today. */
export function renderBriefing({ now, reason, diary, mood, cards, reachedToday }) {
  return [
    `现在是 ${beijingClock(now)}（北京时间）。这次醒来是因为：${REASON_WORDS[reason] ?? REASON_WORDS.schedule}。`,
    diary ? `你最近一篇日记（${diary.day}）：${JSON.stringify(diary.text)}` : '你还没有写过日记。',
    mood ? `你上次写下的心情（${ago(now - mood.at)}前）：${JSON.stringify(mood.text)}` : '你还没有写过心情。',
    `今天你已经主动找过 ${reachedToday} 个人。`,
    cards.length ? `现在可以去找的人有 ${cards.length} 个，每人一张小卡，方括号里是这个人的代号；卡上的数字只是事实，不是要你做什么：\n${cards.join('\n')}` : '现在没有可以去找的人。',
  ].join('\n');
}
/** What stands where a message would be in the turn she starts in one person's conversation (the bridge passes it on
 * unchanged). Only this person's: her reason as Authority kept it, her intents about them, the soft facts about them. */
export function renderReachEvent({ reason, intents, stats, now }) {
  return [
    `你想找他，因为：${reason}`,
    intents.length ? `你留给对方的打算：\n${intents.map(intentLine).join('\n')}` : '你没有给对方留下具体的事。',
    `关于对方的几件事实（只是事实，不是要求）：${softFacts(stats, now)}`,
    '照你平时的样子，简短一点。',
  ].join('\n');
}
