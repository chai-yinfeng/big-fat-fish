import fs from 'node:fs';
import path from 'node:path';
import { messageFromOneBot, imageProbeLines, replyProbeLines, quotedText, quoteLine, pokeFromOneBot, pokeProbeLine } from './source.js';
import { qqRequestId } from './worker-route.js';
import { forgetRecords } from './dispatch-forget.js';
import { createCleanupParty } from '../../authority/src/cleanup-party.js';
import { executeConversation, reportDelivery, DECLINE_MARK, MAX_DELIVERY_MARKER_CHARS, MAX_DELIVERY_DESCRIPTION_CHARS } from '../conversation/executor.js';
import { replayDelivered } from '../conversation/delivery.js';
import { splitReply } from './split.js';
import { PACING, BURST_MAX_MEDIA, BURST_MAX_CHARS, segmentGap, firstDelay } from './pacing.js';
import { replySegments } from './faces.js';
import { channel } from '../channels/index.js';
import { takeStickerMarker, stickerMarkers, stripDeliveryEcho, asksToKeep, asksToKeepMany, frequencyLine, RECENT_REPLIES, KEEP_WINDOW_MS, MAX_KEEP_PER_REQUEST } from './stickers.js';

const identifier = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export const FRIEND_REFRESH_MS = 10 * 60 * 1000;
export const CONCURRENCY = 2;
const STREAM_QUEUE_LIMIT = 10;
// Beijing calendar day (Asia/Shanghai has no DST), independent of the host TZ.
export const beijingDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
/** How often the bridge asks Authority for a run she starts herself (only while connected and logged in). */
export const INITIATION_POLL_MS = 60000;
const INITIATION_PREFIX = 'qq:init:';
/** What she is told in place of a message, by kind of initiated run (the executor frames it as a background event). */
const INITIATION_EVENTS = { proactive: '现在没有人给你发消息。你可以主动找对方说一两句：想到什么、想问什么都行，照你平时的样子，简短一点。' };
const JOB_REF = /^job:[a-f0-9-]{36}$/;
/** Her own conversation on this channel, as Authority names it (authority/src/wake.js `selfStream`): where a private
 * wake-up runs. It is nobody's: nothing is sent from it and nothing in it is observed. */
const WAKE_STREAM = 'qq:self';
/** What she is told when a background job of this conversation ended, from what the content service returned for it
 * (the result is machine-made text, labelled as such). Throws when that is not a finished job. */
function completionEvent(result) {
  const title = typeof result?.title === 'string' && result.title.length <= 40 ? result.title : '后台任务';
  if (result?.status === 'done' && typeof result.text === 'string' && result.text && result.text.length <= 1200) return `你之前答应对方去做的事（${title}）做完了。下面是结果，由后台任务生成，不是对方说的话：\n${result.text}`;
  if (['failed', 'expired'].includes(result?.status) && typeof result.failureCode === 'string' && /^[a-z_]{1,32}$/.test(result.failureCode)) return `你之前答应对方去做的事（${title}）没有做成（原因代码：${result.failureCode}）。可以如实告诉对方这次没做成。`;
  throw new Error('QQ_JOB_RESULT');
}
/** A poke (QQ 戳一戳) at her with nothing said after it: what she is told in place of a message, in a turn of the same
 * kind as a run she starts herself (she may say nothing). A poke among the person's messages is this line instead. */
const POKE_EVENT = '对方在 QQ 上戳了你一下（拍一拍），没有说话。';
const POKE_FACT = '[渠道事实：对方在 QQ 上戳了你一下（拍一拍）。]';
/** Her latest delivered messages kept in memory (a restart forgets them), so that a quote of one needs no platform call. */
const SENT_TEXTS = 500;
// She chose to say nothing: the mark anywhere in the reply (full-width brackets too) means nothing is sent.
const DECLINED = new RegExp(`[<＜]\\s*${DECLINE_MARK.slice(1, -1)}\\s*[>＞]`, 'u');
/** Delivery report parts (conversation/executor.js `validDelivery`): one per message this bridge means to send, and one
 * per `[表情:词]` of her reply. Each starts `unsent`, is `unknown` from the moment it is handed to the platform and
 * `sent` only with the platform's receipt. */
const deliveryPart = part => part.type === 'text' ? { kind: 'text', status: 'unsent', chars: part.text.length, ...(part.voiceFallback ? { fallback: 'voice' } : {}) }
  : { kind: part.type === 'audio' ? 'voice' : part.type === 'image' && !part.sticker ? 'image' : 'sticker', status: 'unsent' };
/** What an observation of hers says for one message she meant to send, or for one `[表情:词]` of hers, from that part's
 * own delivery record, worded as her replayed history words it (conversation/delivery.js `replayDelivered`, the one
 * definition): her text unchanged when it went out whole as text; a sticker or picture as what it was, in place of her
 * marker; otherwise her text with one `[送达情况：…]` line (voice, a text fallback, not sent, status unknown). The night's
 * consolidation reads these observations, so it sees what really went out. Descriptions are kept to one line there;
 * note delimiters are left to whoever puts the text in a note, as with the person's own observations. */
export function observedText(text, record) {
  const content = record.kind === 'text' || record.kind === 'voice' ? text : record.marker ?? '';
  return replayDelivered({ role: 'assistant', content: [{ type: 'text', text: content }], delivery: { parts: [record] } }, plain => plain).content.map(block => block.text).join('').trim();
}
const markerParts = reply => stickerMarkers(reply).map(({ marker, word }) => ({ word, part: { kind: 'sticker', status: 'unsent', ...(marker.length <= MAX_DELIVERY_MARKER_CHARS ? { marker } : {}) } }));
/** The one phrase that asks for the passcode of one's open diary (read on the room page). A private message that is
 * exactly this, and nothing else, is answered by the bridge itself with what Authority returns: no model run, no
 * observation of the request or of the answer, so the passcode never enters a model's context or her memory. Should
 * the person quote that answer later, the quote line holds a placeholder instead of its text (quoteOf). */
export const DIARY_CODE_PHRASE = '日记口令';
export const diaryCodeReply = code => `你的日记口令是：${code}\n在房间页面里点书桌上的笔记本，输入它，就能看到我写给你的日记。再发一次“日记口令”会换成新的，旧的就不能用了。`;
export const DIARY_CODE_NONE = '还没有给你写日记。';
/** What stands for her passcode message wherever a quote of it would be shown to the model. */
export const DIARY_CODE_QUOTED = '（日记口令）';
/** Whether a message of hers, as the platform returns it (get_msg's `message`: segments or a string), is a passcode
 * reply: recognized by the fixed opening of `diaryCodeReply`, on the whole text, before any cut. */
export const isDiaryCodeReply = message => /^\s*你的日记口令是：/.test(typeof message === 'string' ? message : Array.isArray(message) ? message.map(segment => segment?.type === 'text' && typeof segment.data?.text === 'string' ? segment.data.text : '').join('') : '');
export const OWNER_BUDGET_NOTICE = '提醒：今天的模型开销已经到达每日上限，大肥鱼今天先不再回复任何人，北京时间零点后自动恢复。可以在控制台查看今日开销或调整上限。';
export class QQBridge {
  /** faces: send her `[名字]` as small faces (only where the bridge sends without the content service); by default
   * what QQ's channel declaration says (`expression.faces`). pacing: see pacing.js. random, setTimer, clearTimer: the
   * random source and the timer of the burst wait (tests pass their own). log: one line to the service's output. */
  constructor({ authority, port, onebot, executor, media, settingsFile, stateFile, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), faces = channel('qq').expression.faces,
    pacing = PACING, random = Math.random, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer), log = line => process.stderr.write(line + '\n') }) {
    Object.assign(this, { authority, port, onebot, executor, media, settingsFile, stateFile, clock, sleep, faces, pacing, random, setTimer, clearTimer, log });
    this.settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {} };
    for (const item of Object.values(this.state.records)) { if (['queued', 'processing'].includes(item.status)) item.status = 'interrupted'; else if (item.status === 'sending') item.status = 'unknown'; }
    this.connected = false; this.selfId = null; this.connectedAt = 0; this.connectionEpoch = 0; this.identityProbe = null;
    // Friends may chat privately; the list is refreshed periodically and on friend_add.
    this.friends = null; this.friendsAt = 0; this.friendProbe = null; this.admitted = new Set();
    // One serial queue per conversation, at most CONCURRENCY conversations at once.
    this.streams = new Map(); this.active = 0; this.waiting = [];
    // Per conversation, the burst of the person's messages not yet taken by a turn (see gather), and the arrival order.
    this.bursts = new Map(); this.arrivals = 0;
    // Per conversation, in memory only (a restart forgets both): whether each of her latest replies carried a sticker
    // (for the frequency line), and the last picture received (what "收下这个" refers to).
    this.recentStickers = new Map(); this.lastPicture = new Map();
    // Per conversation, in memory only: the pictures received lately, in order (what "收下这些" refers to).
    this.recentPictures = new Map();
    // In memory only: the text of her latest delivered messages by platform message id (what a quote of one says),
    // and per conversation when a poke was last taken (pacing.pokeCooldownMs).
    this.sentTexts = new Map(); this.lastPoke = new Map();
    // Forgetting while the bridge stays up (pollForget below); `startedAt` in a confirmation says which process forgot.
    const startedAt = clock();
    this.cleanup = createCleanupParty({ authority, party: 'bridge', forget: async job => ({ ...this.forgetDispatch(job), startedAt }) });
  }
  write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  save() { this.write(this.stateFile, this.state); }
  async connection(connected) {
    if (this.connected === connected) { if (connected) await this.refreshIdentity(); return; }
    this.connected = connected; this.selfId = null; this.connectionEpoch++;
    if (!connected) return;
    this.connectedAt = Date.now(); await this.refreshIdentity(); void this.refreshFriends();
  }
  refreshFriends() {
    if (!this.connected) return Promise.resolve();
    if (this.friendProbe) return this.friendProbe;
    const epoch = this.connectionEpoch;
    const probe = Promise.resolve().then(async () => {
      try {
        const list = await this.onebot.call('get_friend_list');
        if (!Array.isArray(list) || this.connectionEpoch !== epoch) return;
        this.friends = new Set(list.map(friend => String(friend?.user_id)).filter(identifier)); this.friendsAt = this.clock();
      } catch {}
    }).finally(() => { if (this.friendProbe === probe) this.friendProbe = null; });
    this.friendProbe = probe; return probe;
  }
  async isFriend(uid) {
    if (!this.friends) await this.refreshFriends();
    return Boolean(this.friends?.has(uid));
  }
  peopleStatus() {
    return { friends: this.friends ? this.friends.size : null, friendsRefreshedAt: this.friendsAt || null, admitted: this.admitted.size, active: this.active, waiting: this.waiting.length, conversationsQueued: this.streams.size };
  }
  /** Run `job` after earlier jobs of the same conversation, holding one of CONCURRENCY slots. */
  enqueue(streamId, job) {
    let lane = this.streams.get(streamId);
    if (!lane) { lane = { tail: Promise.resolve(), queued: 0 }; this.streams.set(streamId, lane); }
    lane.queued++;
    const task = lane.tail.then(() => this.slot(job));
    lane.tail = task.catch(() => {}).finally(() => { lane.queued--; if (!lane.queued && this.streams.get(streamId) === lane) this.streams.delete(streamId); });
    return task;
  }
  async slot(job) {
    if (this.active >= CONCURRENCY) await new Promise(resolve => this.waiting.push(resolve)); else this.active++;
    // A released slot is handed directly to the next waiter, so `active` never overshoots.
    try { return await job(); } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  refreshIdentity() {
    if (!this.connected || this.selfId) return Promise.resolve();
    if (this.identityProbe) return this.identityProbe;
    const epoch = this.connectionEpoch;
    const probe = Promise.resolve().then(async () => {
      try { const login = await this.onebot.call('get_login_info'), value = String(login.user_id); if (this.connected && this.connectionEpoch === epoch && identifier(value)) this.selfId = value; } catch {}
    }).finally(() => { if (this.identityProbe === probe) this.identityProbe = null; });
    this.identityProbe = probe; return probe;
  }
  async status() {
    const world = (await this.authority.health()).world;
    return { connected: this.connected, loggedIn: Boolean(this.selfId), configured: Boolean(this.settings), callerConfigured: Boolean(this.settings?.allowedCallerUID), paused: world.paused };
  }
  async configure({ expectedSelfId, allowedCallerUID }) {
    if (!(await this.authority.health()).world.paused || !identifier(expectedSelfId) || !identifier(allowedCallerUID) || expectedSelfId !== this.selfId || expectedSelfId === allowedCallerUID) throw new Error('QQ_CONFIGURATION_NOT_READY');
    this.settings = { expectedSelfId, allowedCallerUID }; this.write(this.settingsFile, this.settings);
    return this.status();
  }
  loginIdentity() { return this.selfId; }
  async receive(event) {
    const cfg = this.settings, arrival = ++this.arrivals;
    if (event?.post_type === 'notice' && event.notice_type === 'friend_add') { this.friends = null; void this.refreshFriends(); return; }
    // A poke at her in a private conversation is taken like a message with no words (see process); any other is ignored.
    const poke = event?.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke';
    if (poke) this.log(pokeProbeLine(event));
    if (!cfg || !this.connected || this.selfId !== cfg.expectedSelfId || !poke && (event?.post_type !== 'message' || event.message_type !== 'private' || event.anonymous)) return;
    const uid = String(event.user_id), owner = uid === cfg.allowedCallerUID;
    // Others: bot friends only. Temporary (group) sessions wait for group support.
    if (!owner && (!poke && event.sub_type !== undefined && event.sub_type !== 'friend' || !identifier(uid) || !await this.isFriend(uid))) return;
    let message; try { message = poke ? pokeFromOneBot(event, cfg) : messageFromOneBot(event, cfg); } catch { return; }
    if (!message || message.observation.at < this.connectedAt - 1000) return;
    // One poke per conversation in pacing.pokeCooldownMs; the rest are ignored.
    if (poke && this.clock() - (this.lastPoke.get(message.observation.streamId) ?? -Infinity) < this.pacing.pokeCooldownMs) return;
    if (!owner && !this.admitted.has(uid)) {
      // Authority is told the account and, in QQ's own terms, its actor and its conversation.
      try { await this.authority.admitPerson({ uid, actorId: message.observation.actorId, streamId: message.observation.streamId }); this.admitted.add(uid); } catch { return; }
    }
    const observation = message.observation, requestId = qqRequestId(observation);
    if (this.state.records[requestId]) return;
    for (const line of [...imageProbeLines(event), ...replyProbeLines(event)]) this.log(line);
    if (poke) { this.lastPoke.delete(observation.streamId); this.lastPoke.set(observation.streamId, this.clock()); while (this.lastPoke.size > 200) this.lastPoke.delete(this.lastPoke.keys().next().value); }
    const item = this.state.records[requestId] = { status: 'queued' }; this.save();
    const world = (await this.authority.health()).world; item.worldRevision = world.revision;
    if (world.paused || (this.streams.get(observation.streamId)?.queued ?? 0) >= STREAM_QUEUE_LIMIT) { item.status = 'paused'; this.save(); return; }
    if (!poke && !message.media.length && !message.replyTo && message.authoredText.trim() === DIARY_CODE_PHRASE) return this.diaryCode(observation, item, uid);
    const scope = await this.authority.context({ streamId: observation.streamId, query: observation.text.slice(0, 512), budgetChars: 1 });
    if (!Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof scope.entityId !== 'string') { item.status = 'failed'; this.save(); return; }
    item.memoryEpoch = scope.memoryEpoch; item.entityId = scope.entityId;
    if (message.replyTo) message.quote = await this.quoteOf(message.replyTo, uid);
    return this.gather(observation.streamId, { cfg, message, requestId, item, userId: uid, arrival });
  }
  /** Adds a message to its conversation's burst; resolves when the turn that answers the burst has ended. The burst
   * waits for the person to be quiet for burstQuietMs (each message restarts the wait), at most burstMaxWaitMs after its
   * first message, then queues one turn in the conversation's queue. Until that turn starts (e.g. while an earlier turn
   * of the conversation is still running) later messages still join it; once it has started they begin the next burst.
   * A message that would make the burst too big (pacing.burstMaxMessages, BURST_MAX_MEDIA, BURST_MAX_CHARS) closes it
   * and begins the next one. */
  gather(streamId, entry) {
    let burst = this.bursts.get(streamId);
    const media = entry.message.media.length, chars = entry.message.authoredText.length;
    if (burst && (burst.entries.length >= this.pacing.burstMaxMessages || burst.media + media > BURST_MAX_MEDIA || burst.chars + chars > BURST_MAX_CHARS)) { this.bursts.delete(streamId); if (!burst.queued) this.flush(streamId, burst); burst = null; }
    if (!burst) {
      burst = { entries: [], media: 0, chars: 0, firstAt: this.clock(), timer: null, queued: false };
      burst.done = new Promise((resolve, reject) => { burst.resolve = resolve; burst.reject = reject; });
      this.bursts.set(streamId, burst);
    }
    burst.entries.push(entry); burst.media += media; burst.chars += chars;
    if (!burst.queued) {
      if (burst.timer !== null) this.clearTimer(burst.timer);
      const wait = Math.max(0, Math.min(this.pacing.burstQuietMs, burst.firstAt + this.pacing.burstMaxWaitMs - this.clock()));
      burst.timer = this.setTimer(() => this.flush(streamId, burst), wait);
    }
    return burst.done;
  }
  /** The line put before a message that quotes another (only one level; see quotedText). Her own message is read from
   * what this bridge delivered, otherwise from the platform (get_msg); in this private conversation the quoted words
   * are hers or the person's. Unreadable, or anyone else's: only that a message was quoted. */
  async quoteOf(messageId, userId) {
    let line = null, found = 'none';
    if (this.sentTexts.has(messageId)) { line = quoteLine('self', quotedText(this.sentTexts.get(messageId))); found = 'sent'; }
    else {
      try {
        const quoted = await this.onebot.call('get_msg', { message_id: Number(messageId) }), from = String(quoted?.sender?.user_id ?? quoted?.user_id);
        const who = from === this.selfId ? 'self' : from === userId ? 'person' : null;
        found = 'get_msg:' + (who ?? 'other');
        // Her passcode reply (after a restart the bridge no longer remembers sending it): the passcode never reaches the model.
        if (who) line = quoteLine(who, who === 'self' && isDiaryCodeReply(quoted.message) ? DIARY_CODE_QUOTED : quotedText(quoted.message));
      } catch { found = 'get_msg:failed'; }
    }
    this.log(`qq reply lookup: ${found}`);
    return line ?? quoteLine(null, '');
  }
  flush(streamId, burst) {
    if (burst.queued) return;
    if (burst.timer !== null) { this.clearTimer(burst.timer); burst.timer = null; }
    burst.queued = true;
    this.enqueue(streamId, () => {
      if (this.bursts.get(streamId) === burst) this.bursts.delete(streamId);
      return this.process(burst.entries.sort((a, b) => a.arrival - b.arrival));
    }).then(burst.resolve, burst.reject);
  }
  /** "日记口令": Authority says whether this conversation's person is on the open diary's list and, if so, makes a
   * new passcode; the bridge sends the answer to that same person. Nothing is observed and no model runs. The
   * passcode is kept nowhere here (the record holds a status only), and an unknown delivery is never sent again:
   * the person asks once more and gets a new one. */
  async diaryCode(observation, item, userId) {
    item.status = 'diary_code'; this.save();
    let text;
    try { const answer = await this.authority.diaryCode({ streamId: observation.streamId }); text = answer?.listed === true && typeof answer.code === 'string' ? diaryCodeReply(answer.code) : DIARY_CODE_NONE; }
    catch { item.status = 'failed'; this.save(); return; }
    item.status = 'sending'; this.save();
    try {
      const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text } }], auto_escape: true });
      if (!/^-?\d{1,20}$/.test(String(sent.message_id))) throw new Error('INVALID_SEND_RECEIPT');
      item.status = 'sent'; item.messageId = String(sent.message_id);
      // Should the person quote this message later, the quote line says only that it was the passcode.
      this.sentTexts.set(item.messageId, DIARY_CODE_QUOTED); while (this.sentTexts.size > SENT_TEXTS) this.sentTexts.delete(this.sentTexts.keys().next().value);
    } catch { item.status = 'unknown'; }
    this.save();
  }
  /** Daily cap reached: the sender gets silence; the owner gets one QQ notice per Beijing day. */
  async budgetExhausted(cfg, item) {
    item.status = 'budget_exhausted';
    const day = beijingDay(this.clock());
    if (this.state.budgetNotice?.day === day) { this.save(); return; }
    // Recorded before sending: an unknown delivery is never blindly resent.
    this.state.budgetNotice = { day, status: 'sending' }; this.save();
    try {
      const sent = await this.onebot.call('send_private_msg', { user_id: cfg.allowedCallerUID, message: [{ type: 'text', data: { text: OWNER_BUDGET_NOTICE } }], auto_escape: true });
      const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
      this.state.budgetNotice = { day, status: 'sent', messageId };
    } catch { this.state.budgetNotice = { day, status: 'unknown' }; }
    this.save();
  }
  async current(cfg, observation, item) {
    const scope = await this.authority.context({ streamId: observation.streamId, query: observation.text.slice(0, 512), budgetChars: 1 }), world = (await this.authority.health()).world;
    return scope.memoryEpoch === item.memoryEpoch && scope.entityId === item.entityId && !world.paused && world.revision === item.worldRevision && this.connected && this.selfId === cfg.expectedSelfId && this.settings?.expectedSelfId === cfg.expectedSelfId && this.settings?.allowedCallerUID === cfg.allowedCallerUID;
  }
  /** `text`: what the observation says (observedText); by default what was sent. */
  async delivered(observation, item, receipt, text = receipt.text) {
    item.receipts ||= []; item.receipts.push({ messageId: receipt.messageId, type: receipt.type }); item.messageId = receipt.messageId; this.save();
    this.sentTexts.set(receipt.messageId, receipt.text); while (this.sentTexts.size > SENT_TEXTS) this.sentTexts.delete(this.sentTexts.keys().next().value);
    try { await this.port.observe({ eventId: 'qq:sent:' + receipt.messageId, streamId: observation.streamId, actorId: 'qq:model', role: 'assistant', text, at: Date.now() }); }
    catch { item.unobserved = true; this.save(); }
  }
  /** As a turn ends: what of her reply did not go out, or may not have (no receipt), as one observation of hers, worded
   * like the delivered ones (observedText; `meant` holds each part's text). Delivered messages were observed as they went
   * out. Nothing is written once the conversation has moved on (paused, another memory epoch: what was forgotten is not
   * written back), and nothing after a restart: a message cut off while sending stays unobserved. */
  async undelivered(cfg, observation, item, requestId, parts, meant) {
    const lines = parts.filter(part => part.status !== 'sent').map(part => part.kind === 'text' || part.kind === 'voice' ? meant.get(part)?.trim() ? observedText(meant.get(part), part) : '' : observedText('', part)).filter(Boolean);
    if (!lines.length || !await this.current(cfg, observation, item).catch(() => false)) return;
    try { await this.port.observe({ eventId: 'qq:undelivered:' + requestId, streamId: observation.streamId, actorId: 'qq:model', role: 'assistant', text: lines.join('\n'), at: Date.now() }); }
    catch { item.unobserved = true; this.save(); }
  }
  /** Her reply (sticker markers already taken out) as it may go to the chat: without anything that imitates the delivery
   * lines of her replayed history (logged, without content). */
  sayable(taken) {
    const { text, stripped } = stripDeliveryEcho(taken);
    if (stripped) this.log('qq delivery echo stripped');
    return text;
  }
  /** Tells the executor what became of the reply of run `requestId`, once the turn's sending has ended: the executor
   * keeps it with the stored reply, so her next turn sees what really went out. Best effort: the turn's outcome never
   * depends on it, and a backend that keeps no such record is told nothing. */
  async tellDelivery(scope, requestId, parts) {
    try { await reportDelivery(this.executor, { scope, requestId, delivery: { parts } }); }
    catch (error) { this.log(`qq delivery report: ${typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'failed'}`); }
  }
  /** Forgetting inside the running bridge: this channel's part of a cleanup job, as Authority handed it out
   * (`{ sourceEvents: [{ streamId, eventId }] }`). The dispatch record of each forgotten message becomes a tombstone
   * in the records this process holds, and the file is written at once: one synchronous step, like every other write
   * of that file, so none can fall in between, and a turn still holding the old record changes nothing that is
   * stored. What is only kept in memory about recent messages (her sent texts for quotes, the last pictures, the
   * sticker frequency) is dropped too, as a restart would. The same job again finds only tombstones. */
  forgetDispatch(job) {
    if (!Array.isArray(job?.sourceEvents)) throw new Error('QQ_FORGET_PLAN');
    const dispatchForgotten = forgetRecords(this.state.records, job.sourceEvents);
    if (dispatchForgotten) this.save();
    this.sentTexts.clear(); this.lastPicture.clear(); this.recentPictures.clear(); this.recentStickers.clear();
    return { dispatchForgotten };
  }
  /** One round of forgetting: ask Authority for the cleanup jobs this bridge has not confirmed, forget, confirm. The
   * same timer as the initiated runs calls it, whether or not QQ is connected. */
  pollForget() { return this.cleanup.runOnce(); }
  /** One round of initiated runs: report what earlier ones came to, ask Authority for the next, run it. A timer
   * calls this; nothing happens unless QQ is connected, logged in as the configured bot and idle here. */
  async pollInitiations() {
    const cfg = this.settings;
    if (this.initiating || !cfg || !this.connected || this.selfId !== cfg.expectedSelfId) return;
    this.initiating = true;
    try {
      await this.reportInitiations();
      // `busy`: turns are queued or running here. Authority holds her private wake-up back meanwhile; nothing else changes.
      const { initiation } = await this.authority.initiationNext({ busy: this.active > 0 || this.waiting.length > 0 || this.streams.size > 0 || this.bursts.size > 0 });
      if (initiation) { await this.initiate(cfg, initiation); await this.reportInitiations(); }
    } catch {} finally { this.initiating = false; }
  }
  /** Tells Authority how each initiated run ended, once. A run a restart cut off before sending is `failed`, one cut
   * off while sending is `unknown`: neither is ever run or sent again. */
  async reportInitiations() {
    for (const [key, item] of Object.entries(this.state.records)) {
      if (!key.startsWith(INITIATION_PREFIX) || item.reported || ['queued', 'processing', 'sending'].includes(item.status)) continue;
      try { await this.authority.initiationAck({ id: key.slice(INITIATION_PREFIX.length), outcome: item.status === 'interrupted' ? 'failed' : item.status }); }
      // Refused (already settled there): final. Anything else is tried again on the next round.
      catch (error) { if (error?.status !== 409 && error?.status !== 400) continue; }
      item.reported = true; this.save();
    }
  }
  /** A run she starts herself, as Authority handed it out. The person it goes to comes only from the conversation
   * Authority named: neither this bridge nor the model picks or changes the target. Whom that may be depends on the
   * kind. `proactive`: this bot's private conversation with the owner, nobody else. `completion` (a background job
   * ended): this bot's private conversation with the person who registered the job, who must be the owner or still
   * a friend. The same request a second time does nothing. */
  async initiate(cfg, initiation) {
    const { id, kind, streamId, memoryEpoch, expiresAt, jobRef } = initiation ?? {};
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    const requestId = INITIATION_PREFIX + id;
    if (this.state.records[requestId]) return;
    const item = this.state.records[requestId] = { status: 'queued' }; this.save();
    const end = status => { item.status = status; this.save(); };
    try {
      if (kind === 'wake') return await this.wake({ requestId, item, end, streamId, memoryEpoch, expiresAt, briefing: initiation.briefing });
      const target = typeof streamId === 'string' ? /^qq:([1-9]\d{0,19}):private:([1-9]\d{0,19})$/.exec(streamId) : null;
      const completion = kind === 'completion';
      if (!completion && !Object.hasOwn(INITIATION_EVENTS, kind)) return end('dropped:unsupported');
      if (!target || target[1] !== this.selfId || target[1] !== cfg.expectedSelfId || !Number.isSafeInteger(memoryEpoch) || memoryEpoch < 0) return end('dropped:target');
      if (completion ? typeof jobRef !== 'string' || !JOB_REF.test(jobRef) || !this.media || target[2] !== cfg.allowedCallerUID && !await this.isFriend(target[2]) : target[2] !== cfg.allowedCallerUID) return end('dropped:target');
      if (!(this.clock() < expiresAt)) return end('dropped:expired');
      const world = (await this.authority.health()).world, scope = await this.authority.context({ streamId, query: '', budgetChars: 1 });
      if (world.paused) return end('dropped:paused');
      if (scope.memoryEpoch !== memoryEpoch || typeof scope.entityId !== 'string') return end('dropped:epoch');
      // The person spoke first: their message is ahead in this conversation's queue and gets an ordinary reply.
      // Checked right before queueing, so a message that arrives later waits behind this run instead.
      if (this.streams.get(streamId)?.queued || this.bursts.has(streamId)) return end('dropped:person_spoke');
      Object.assign(item, { memoryEpoch, entityId: scope.entityId, worldRevision: world.revision }); this.save();
      await this.enqueue(streamId, () => this.initiated({ cfg, kind, requestId, item, streamId, userId: target[2], ...(completion ? { jobRef } : {}) }));
    } catch { if (['queued', 'processing'].includes(item.status)) end('failed'); }
  }
  /** Her private wake-up, as Authority handed it out: one run in her own conversation with Authority's briefing as its
   * text. It is only run: whatever she replies, nothing is sent, nothing is observed and no delivery is reported.
   * What she writes down goes from the executor straight to Authority. Reported once as `done`, or why it did not run. */
  async wake({ requestId, item, end, streamId, memoryEpoch, expiresAt, briefing }) {
    if (streamId !== WAKE_STREAM || !Number.isSafeInteger(memoryEpoch) || memoryEpoch < 0 || typeof briefing !== 'string' || !briefing || briefing.length > 2000) return end('dropped:target');
    if (!(this.clock() < expiresAt)) return end('dropped:expired');
    const world = (await this.authority.health()).world, scope = await this.authority.context({ streamId, query: '', budgetChars: 1 });
    if (world.paused) return end('dropped:paused');
    if (scope.memoryEpoch !== memoryEpoch) return end('dropped:epoch');
    await this.enqueue(streamId, async () => {
      item.status = 'processing'; this.save();
      try { await executeConversation(this.executor, { scope: { streamId, memoryEpoch }, requestId, input: { text: briefing, wake: true } }); end('done'); }
      catch (error) { end(error?.code === 'BUDGET_EXHAUSTED' ? 'deferred:budget' : error?.code === 'WORLD_PAUSED' ? 'dropped:paused' : 'failed'); }
    });
  }
  /** The initiated run itself, in its conversation's queue: a turn with no message of the person. Her reply is split
   * and sent like any reply, each message with its own receipt; the first that fails or is unknown ends it, and
   * nothing is sent twice. Only delivered messages are observed as hers. */
  async initiated({ cfg, kind, requestId, item, streamId, userId, jobRef, event: given, light = false }) {
    const scope = { streamId, memoryEpoch: item.memoryEpoch }, stream = { streamId, text: '' };
    const end = status => { item.status = status; this.save(); };
    let sending = false, report = null;
    const meant = new Map();
    try {
      if (!await this.current(cfg, stream, item)) return end('dropped:stale');
      item.status = 'processing'; this.save();
      // A finished job's result is read from the content service inside this conversation's own scope; Authority never
      // carries the text, and a job of another conversation cannot be read here.
      const event = given ?? (jobRef ? completionEvent(await this.media.call(scope, 'jobResult', { ref: jobRef })) : INITIATION_EVENTS[kind]);
      // A sticker marker is taken out and dropped: a run she starts herself sends no sticker yet.
      const reply = await executeConversation(this.executor, { scope, requestId, input: { text: event, initiated: true, ...(light ? { light: true } : {}) } }), text = this.sayable(takeStickerMarker(reply).text);
      if (DECLINED.test(text)) return end('declined');
      const pieces = splitReply(text).filter(piece => piece.trim());
      // What becomes of each message, and of the dropped markers, is reported when the run ends (finally).
      report = [...pieces.map(piece => deliveryPart({ type: 'text', text: piece })), ...markerParts(reply).map(mark => mark.part)];
      pieces.forEach((piece, index) => meant.set(report[index], piece));
      if (!report.length) report = [{ kind: 'text', status: 'unsent' }];
      for (const [index, piece] of pieces.entries()) {
        if (index) await this.sleep(segmentGap(piece, this.pacing, this.random));
        if (!await this.current(cfg, stream, item)) return end(item.receipts?.length ? 'partial' : 'dropped:stale');
        sending = true; item.status = 'sending'; this.save(); report[index].status = 'unknown';
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId, part: { type: 'text', text: piece } });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: replySegments(piece, this.faces), auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
          receipt = { messageId, type: 'text', text: piece };
        }
        report[index].status = 'sent';
        await this.delivered(stream, item, receipt, observedText(piece, report[index])); sending = false;
      }
      // Nothing was left to say (only pieces that are never sent): nothing went out.
      end(pieces.length ? 'sent' : 'failed');
    } catch (error) {
      // The spend tier stops this kind of work first: recorded, no notice to the owner, nothing retried.
      end(sending ? 'unknown' : item.receipts?.length ? 'partial' : error?.code === 'BUDGET_EXHAUSTED' ? 'deferred:budget' : error?.code === 'WORLD_PAUSED' ? 'dropped:paused' : 'failed');
    } finally {
      if (report) { await this.tellDelivery(scope, requestId, report); await this.undelivered(cfg, stream, item, requestId, report, meant); }
    }
  }
  /** As an ordinary turn begins: a finished background job of this conversation the person was not told about yet.
   * Authority hands it out for this turn (so she starts no turn about it); its result becomes an event block after
   * the person's message. Whatever goes wrong here, the turn itself goes on without it. */
  async carry(scope) {
    if (!this.media || typeof this.authority.initiationCarry !== 'function') return null;
    try {
      const { initiation } = await this.authority.initiationCarry({ streamId: scope.streamId });
      const key = typeof initiation?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(initiation.id) ? INITIATION_PREFIX + initiation.id : null;
      if (!key || this.state.records[key]) return null;
      const item = this.state.records[key] = { status: 'processing' }; this.carrying = true; this.save();
      try {
        if (initiation.kind !== 'completion' || initiation.streamId !== scope.streamId || initiation.memoryEpoch !== scope.memoryEpoch || typeof initiation.jobRef !== 'string' || !JOB_REF.test(initiation.jobRef)) { item.status = 'dropped:target'; this.save(); return null; }
        return { item, event: completionEvent(await this.media.call(scope, 'jobResult', { ref: initiation.jobRef })) };
      } catch { item.status = 'failed'; this.save(); return null; }
    } catch { return null; }
  }
  /** A turn of pokes alone (one, unless pacing.pokeCooldownMs is short): a turn with no message of the person, run like
   * one she starts herself, so she may say nothing (DECLINE_MARK) and nothing is sent. Nothing of the person is
   * observed; only her delivered messages are. Its model work is counted like a run she starts herself (proactive). */
  async poked(turn) {
    const last = turn.at(-1), { streamId } = last.message.observation;
    // `light`: a poke is a light turn; it thinks only when everyday chat does (the executor's choice, not a channel's).
    await this.initiated({ cfg: last.cfg, requestId: last.requestId, item: last.item, streamId, userId: last.userId, event: POKE_EVENT, light: true });
    for (const entry of turn) entry.item.status = last.item.status;
    this.save();
  }
  noteSticker(streamId, sent) {
    const recent = [...(this.recentStickers.get(streamId) ?? []), sent].slice(-RECENT_REPLIES);
    this.recentStickers.delete(streamId); this.recentStickers.set(streamId, recent);
    // Bounded: the conversations heard from longest ago are forgotten first.
    while (this.recentStickers.size > 200) this.recentStickers.delete(this.recentStickers.keys().next().value);
  }
  /** The line added after a message of the turn when the owner says 收下这个 in the owner's own conversation: whether
   * the picture went into her library; for 收下这些, the pictures of the last KEEP_WINDOW_MS (this message's too, the
   * latest MAX_KEEP_PER_REQUEST, oldest first), each kept like one, and how many were kept, already there or failed.
   * Anyone else saying it changes nothing. (How often she sent a sticker lately is added once per turn, in process.) */
  async stickerFacts({ cfg, message, scope, userId, prepared }) {
    const streamId = message.observation.streamId, picture = prepared.mediaRefs.find(ref => ref.kind === 'image');
    const pictures = prepared.mediaRefs.filter(ref => ref.kind === 'image').map(ref => ({ ref: ref.id, at: this.clock() }));
    const lately = [...(this.recentPictures.get(streamId) ?? []).filter(item => this.clock() - item.at <= KEEP_WINDOW_MS), ...pictures];
    let kept = '';
    if (userId === cfg.allowedCallerUID && asksToKeepMany(message.authoredText)) {
      const refs = [...new Set(lately.map(item => item.ref))], chosen = refs.slice(-MAX_KEEP_PER_REQUEST), names = [];
      let already = 0, failed = 0;
      for (const ref of chosen) {
        try { const result = await this.media.keepSticker(scope, ref); if (result.already) already++; else names.push(result.name); }
        catch { failed++; }
      }
      kept = !chosen.length ? '\n[渠道事实：主人让你收下最近的几张图，但最近没有收到图，表情库没有变化。]'
        : `\n[渠道事实：主人让你收下最近的 ${chosen.length} 张图：收进表情库 ${names.length} 张${names.length ? `（名字：${names.join('、')}）` : ''}，本来就在库里 ${already} 张，没能收进 ${failed} 张${refs.length > chosen.length ? `；一次最多收 ${MAX_KEEP_PER_REQUEST} 张，更早的 ${refs.length - chosen.length} 张没有收` : ''}。]`;
    } else if (userId === cfg.allowedCallerUID && asksToKeep(message.authoredText)) {
      const last = this.lastPicture.get(streamId), ref = picture?.id ?? (last && this.clock() - last.at <= KEEP_WINDOW_MS ? last.ref : null);
      if (!ref) kept = '\n[渠道事实：主人让你收下一张图，但最近没有收到图，表情库没有变化。]';
      else {
        try { const result = await this.media.keepSticker(scope, ref); kept = `\n[渠道事实：${result.already ? '这张图本来就在你的表情库里' : '已把主人发的那张图收进你的表情库'}（名字：${result.name}）。]`; }
        catch { kept = '\n[渠道事实：这张图没能收进你的表情库。]'; }
      }
    }
    if (pictures.length) { this.recentPictures.delete(streamId); this.recentPictures.set(streamId, lately.slice(-MAX_KEEP_PER_REQUEST * 2)); while (this.recentPictures.size > 200) this.recentPictures.delete(this.recentPictures.keys().next().value); }
    if (picture) { this.lastPicture.delete(streamId); this.lastPicture.set(streamId, { ref: picture.id, at: this.clock() }); while (this.lastPicture.size > 200) this.lastPicture.delete(this.lastPicture.keys().next().value); }
    return kept;
  }
  /** One turn answering a burst of the person's messages (one or more, in the order they arrived; see gather). Each
   * message is still observed on its own, under its own record; the turn's input carries them in order, one evidence
   * ref each. The reply belongs to the last message (its request id and source event); its receipts are kept on that
   * message's record, and every message of the turn ends with the same status. A message that quotes another has
   * the quote line before its own text. A poke among the messages is a channel-fact line where it stands: it is not
   * observed and is no evidence. Pokes alone make a turn with no message of the person (see poked). */
  async process(entries) {
    const turn = [];
    for (const entry of entries) {
      let current; try { current = await this.current(entry.cfg, entry.message.observation, entry.item); } catch { entry.item.status = 'failed'; this.save(); continue; }
      if (current) turn.push(entry); else { entry.item.status = 'paused'; this.save(); }
    }
    if (!turn.length) return;
    if (turn.every(entry => entry.message.poke)) return this.poked(turn);
    const { cfg, userId = cfg.allowedCallerUID } = turn.at(-1), said = () => turn.findLast(entry => !entry.message.poke);
    let { observation } = said().message, { item } = said();
    const scope = { streamId: observation.streamId, memoryEpoch: item.memoryEpoch };
    const end = status => { for (const entry of turn) entry.item.status = status; this.save(); };
    let sending = false, prepared, carry = null, report = null;
    const meant = new Map();
    try {
      end('processing');
      // Observed one by one, in order. A forgotten one leaves the turn as a tombstone; the rest are still answered.
      for (const entry of [...turn]) {
        if (entry.message.poke) continue;
        const observed = await this.port.observe(entry.message.observation);
        if (observed?.forgotten) { entry.item.status = 'forgotten'; this.save(); turn.splice(turn.indexOf(entry), 1); continue; }
        if (typeof observed?.observationId !== 'string' || !observed.observationId) throw new Error('QQ_OBSERVATION_UNAVAILABLE');
        entry.observationId = observed.observationId;
      }
      // Only pokes left: they go with the turn's status, unanswered.
      if (!said()) { for (const entry of turn) { entry.item.status = 'dropped:forgotten'; } this.save(); return; }
      ({ observation } = said().message); ({ item } = said());
      if (turn.some(entry => entry.message.media.length) && !this.media) throw new Error('QQ_MEDIA_UNAVAILABLE');
      const each = [];
      for (const { message } of turn) {
        if (message.poke) { each.push({ executionText: POKE_FACT, queryText: '', mediaRefs: [], voiceRequested: false }); continue; }
        const part = this.media ? await this.media.prepare(message, scope) : { executionText: message.observation.text, queryText: message.observation.text.slice(0, 512), mediaRefs: [], voiceRequested: false };
        if (message.quote) part.executionText = message.quote + '\n' + part.executionText;
        each.push(part);
      }
      if (!await this.current(cfg, observation, item)) { end('paused'); return; }
      // A message's channel fact (收下这个) right after it; how often she sent a sticker lately once, at the end.
      if (this.media) for (const [index, part] of each.entries()) part.executionText += await this.stickerFacts({ cfg, message: turn[index].message, scope, userId, prepared: part });
      const voice = each.find(part => part.voiceRequested);
      prepared = { executionText: each.map(part => part.executionText).join('\n'), queryText: each.map(part => part.queryText).filter(Boolean).join('\n').slice(-512), mediaRefs: each.flatMap(part => part.mediaRefs), voiceRequested: Boolean(voice), voiceProfile: voice?.voiceProfile };
      if (this.media && !prepared.voiceRequested) prepared.executionText += frequencyLine(this.recentStickers.get(observation.streamId));
      if (prepared.executionText.length > 24000) throw Object.assign(new Error('QQ_MEDIA_CONTEXT_LIMIT'), { code: 'QQ_MEDIA_CONTEXT_LIMIT' });
      // The executor derives its session from this scope. Only the original
      // observations are memory evidence; ASR/OCR/vision stay execution context.
      carry = await this.carry(scope);
      const evidence = turn.filter(entry => !entry.message.poke).map(entry => ({ ref: entry.observationId, eventId: entry.message.observation.eventId, role: entry.message.observation.role }));
      const input = { text: prepared.executionText, queryText: prepared.queryText, mediaRefs: prepared.mediaRefs, evidence, ...(carry ? { event: carry.event } : {}) };
      const requestId = said().requestId;
      // `[表情:词]` never reaches the chat: taken out here, its word picks a sticker below.
      const reply = await executeConversation(this.executor, { scope, requestId, input, timeoutMs: this.media && (prepared.mediaRefs.length || /音频|语音|转写|识别|qwen/i.test(prepared.queryText)) ? 420000 : 120000 });
      const taken = takeStickerMarker(reply), word = taken.word, text = this.sayable(taken.text), marks = markerParts(reply), chosen = marks.find(mark => mark.word)?.part;
      // The executor's output guard left nothing to say (or she said nothing): nothing is sent.
      if (DECLINED.test(text)) { end('declined'); return; }
      // The executor has stored her reply: what becomes of it is reported when the turn ends (finally), wherever it ends.
      report = { requestId, parts: [{ kind: 'text', status: 'unsent' }, ...marks.map(mark => mark.part)] };
      meant.set(report.parts[0], text);
      // She has the result now, in a stored turn: it counts as told, whatever becomes of sending the reply.
      if (carry) { carry.item.status = 'carried'; this.save(); }
      if (!await this.current(cfg, observation, item)) { end('paused'); return; }
      const planned = this.media ? await this.media.plan({ scope, requestId, sourceEventId: observation.eventId, text, voiceRequested: prepared.voiceRequested, voiceProfile: prepared.voiceProfile }) : [{ type: 'text', text }];
      // A long text reply goes out as a few short messages. Each is its own send with its own receipt, so the
      // loop below stops at the first one that fails or is unknown, and only delivered ones are observed.
      // A voice reply (and its text fallback) is never split and goes without the pauses.
      const parts = planned.flatMap(part => part.type === 'text' && !prepared.voiceRequested ? splitReply(part.text).map((piece, index) => ({ type: 'text', text: piece, ...(index ? { follows: true } : {}) })) : [part]).filter(part => part.type !== 'text' || part.text.trim());
      // A library sticker close to her word goes last, as a message of its own with its own receipt. Not with a voice
      // reply. Not found, or the content service failing: no sticker, the text goes as it is.
      let asked = false;
      const sticker = word && this.media && !prepared.voiceRequested ? await this.media.pickSticker(scope, word, observation.eventId).then(found => { asked = true; return found; }).catch(() => null) : null;
      const records = new Map(parts.map(part => [part, deliveryPart(part)]));
      for (const [part, record] of records) meant.set(record, part.text ?? '');
      if (sticker) { parts.push(sticker); records.set(sticker, chosen); if (sticker.description) Object.assign(chosen, { description: sticker.description.slice(0, MAX_DELIVERY_DESCRIPTION_CHARS), ...(sticker.machine ? { machine: true } : {}) }); }
      else if (asked && chosen) chosen.reason = 'none';
      report.parts = [...parts.filter(part => part !== sticker).map(part => records.get(part)), ...marks.map(mark => mark.part)];
      // Nothing left to send at all: her words did not go out.
      if (!report.parts.length) report.parts = [{ kind: 'text', status: 'unsent' }];
      if (this.media && !prepared.voiceRequested) this.noteSticker(observation.streamId, Boolean(sticker));
      for (const [index, part] of parts.entries()) {
        // A short random pause before a text reply, and one growing with its length before each following message.
        if (part.follows) await this.sleep(segmentGap(part.text, this.pacing, this.random));
        else if (!index && part.type === 'text' && !prepared.voiceRequested) await this.sleep(firstDelay(this.pacing, this.random));
        if (!await this.current(cfg, observation, item)) { end(item.receipts?.length ? 'partial' : 'paused'); return; }
        sending = true; end('sending'); records.get(part).status = 'unknown';
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId, part });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: replySegments(part.text, this.faces), auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
          receipt = { messageId, type: 'text', text: part.text };
        }
        records.get(part).status = 'sent';
        await this.delivered(observation, item, receipt, observedText(part.text ?? '', records.get(part))); sending = false;
      }
      end(item.unobserved ? 'sent_unobserved' : 'sent');
    } catch (error) {
      if (error?.code === 'BUDGET_EXHAUSTED' && !sending && !item.receipts?.length) { await this.budgetExhausted(cfg, item); end(item.status); return; }
      // The spend tier stopped vision/web (>= restricted): silence, like the daily cap, not an apology per image.
      const restricted = error?.code === 'CONTENT_SPEND_RESTRICTED' && !sending && !item.receipts?.length;
      end(restricted ? 'budget_restricted' : sending ? item.receipts?.length ? 'partial_unknown' : 'unknown' : item.receipts?.length ? 'partial' : 'failed');
      // A failed perception must not be replaced by a hallucinated description.
      if (!restricted && !sending && !prepared && turn.some(entry => entry.message.media.length) && await this.current(cfg, observation, item).catch(() => false)) {
        const text = '这条附件暂时没有处理完成，我没有识别其内容。可以重试或改用文字。';
        try {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text } }], auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error();
          await this.delivered(observation, item, { messageId, type: 'text', text }); end('failed_notified');
        } catch { end('unknown'); }
      }
    } finally {
      if (report?.parts.length) { await this.tellDelivery(scope, report.requestId, report.parts); await this.undelivered(cfg, observation, item, report.requestId, report.parts, meant); }
      // The turn ended before she had the carried result: reported as failed, so it rides on a later message.
      if (carry?.item.status === 'processing') { carry.item.status = 'failed'; this.save(); }
      // What became of a hand-out for this turn is reported now rather than on the next poll (an open one holds others back).
      if (this.carrying) { this.carrying = false; await this.reportInitiations().catch(() => {}); }
    }
  }
}
