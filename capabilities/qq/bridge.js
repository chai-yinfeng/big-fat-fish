import fs from 'node:fs';
import path from 'node:path';
import { messageFromOneBot } from './source.js';
import { qqRequestId } from './worker-route.js';
import { executeConversation, DECLINE_MARK } from '../conversation/executor.js';
import { splitReply, SPLIT_GAP_MS } from './split.js';
import { replySegments } from './faces.js';
import { takeStickerMarker, asksToKeep, frequencyLine, RECENT_REPLIES, KEEP_WINDOW_MS } from './stickers.js';

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
/** What she is told when a background job of this conversation ended, from what the content service returned for it
 * (the result is machine-made text, labelled as such). Throws when that is not a finished job. */
function completionEvent(result) {
  const title = typeof result?.title === 'string' && result.title.length <= 40 ? result.title : '后台任务';
  if (result?.status === 'done' && typeof result.text === 'string' && result.text && result.text.length <= 1200) return `你之前答应对方去做的事（${title}）做完了。下面是结果，由后台任务生成，不是对方说的话：\n${result.text}`;
  if (['failed', 'expired'].includes(result?.status) && typeof result.failureCode === 'string' && /^[a-z_]{1,32}$/.test(result.failureCode)) return `你之前答应对方去做的事（${title}）没有做成（原因代码：${result.failureCode}）。可以如实告诉对方这次没做成。`;
  throw new Error('QQ_JOB_RESULT');
}
// She chose to say nothing: the mark anywhere in the reply (full-width brackets too) means nothing is sent.
const DECLINED = new RegExp(`[<＜]\\s*${DECLINE_MARK.slice(1, -1)}\\s*[>＞]`, 'u');
export const OWNER_BUDGET_NOTICE = '提醒：今天的模型开销已经到达每日上限，大肥鱼今天先不再回复任何人，北京时间零点后自动恢复。可以在控制台查看今日开销或调整上限。';
export class QQBridge {
  constructor({ authority, port, onebot, executor, media, settingsFile, stateFile, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { authority, port, onebot, executor, media, settingsFile, stateFile, clock, sleep });
    this.settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {} };
    for (const item of Object.values(this.state.records)) { if (['queued', 'processing'].includes(item.status)) item.status = 'interrupted'; else if (item.status === 'sending') item.status = 'unknown'; }
    this.connected = false; this.selfId = null; this.connectedAt = 0; this.connectionEpoch = 0; this.identityProbe = null;
    // Friends may chat privately; the list is refreshed periodically and on friend_add.
    this.friends = null; this.friendsAt = 0; this.friendProbe = null; this.admitted = new Set();
    // One serial queue per conversation, at most CONCURRENCY conversations at once.
    this.streams = new Map(); this.active = 0; this.waiting = [];
    // Per conversation, in memory only (a restart forgets both): whether each of her latest replies carried a sticker
    // (for the frequency line), and the last picture received (what "收下这个" refers to).
    this.recentStickers = new Map(); this.lastPicture = new Map();
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
    const cfg = this.settings;
    if (event?.post_type === 'notice' && event.notice_type === 'friend_add') { this.friends = null; void this.refreshFriends(); return; }
    if (!cfg || !this.connected || this.selfId !== cfg.expectedSelfId || event?.post_type !== 'message' || event.message_type !== 'private' || event.anonymous) return;
    const uid = String(event.user_id), owner = uid === cfg.allowedCallerUID;
    // Others: bot friends only. Temporary (group) sessions wait for group support.
    if (!owner && (event.sub_type !== undefined && event.sub_type !== 'friend' || !identifier(uid) || !await this.isFriend(uid))) return;
    let message; try { message = messageFromOneBot(event, cfg); } catch { return; }
    if (!message || message.observation.at < this.connectedAt - 1000) return;
    if (!owner && !this.admitted.has(uid)) {
      try { await this.authority.admitPerson({ uid }); this.admitted.add(uid); } catch { return; }
    }
    const observation = message.observation, requestId = qqRequestId(observation);
    if (this.state.records[requestId]) return;
    const item = this.state.records[requestId] = { status: 'queued' }; this.save();
    const world = (await this.authority.health()).world; item.worldRevision = world.revision;
    if (world.paused || (this.streams.get(observation.streamId)?.queued ?? 0) >= STREAM_QUEUE_LIMIT) { item.status = 'paused'; this.save(); return; }
    const scope = await this.authority.context({ streamId: observation.streamId, query: observation.text.slice(0, 512), budgetChars: 1 });
    if (!Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof scope.entityId !== 'string') { item.status = 'failed'; this.save(); return; }
    item.memoryEpoch = scope.memoryEpoch; item.entityId = scope.entityId;
    return this.enqueue(observation.streamId, () => this.process({ cfg, message, requestId, item, userId: uid }));
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
  async delivered(observation, item, receipt) {
    item.receipts ||= []; item.receipts.push({ messageId: receipt.messageId, type: receipt.type }); item.messageId = receipt.messageId; this.save();
    try { await this.port.observe({ eventId: 'qq:sent:' + receipt.messageId, streamId: observation.streamId, actorId: 'qq:model', role: 'assistant', text: receipt.text, at: Date.now() }); }
    catch { item.unobserved = true; this.save(); }
  }
  /** One round of initiated runs: report what earlier ones came to, ask Authority for the next, run it. A timer
   * calls this; nothing happens unless QQ is connected, logged in as the configured bot and idle here. */
  async pollInitiations() {
    const cfg = this.settings;
    if (this.initiating || !cfg || !this.connected || this.selfId !== cfg.expectedSelfId) return;
    this.initiating = true;
    try {
      await this.reportInitiations();
      const { initiation } = await this.authority.initiationNext();
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
      if (this.streams.get(streamId)?.queued) return end('dropped:person_spoke');
      Object.assign(item, { memoryEpoch, entityId: scope.entityId, worldRevision: world.revision }); this.save();
      await this.enqueue(streamId, () => this.initiated({ cfg, kind, requestId, item, streamId, userId: target[2], ...(completion ? { jobRef } : {}) }));
    } catch { if (['queued', 'processing'].includes(item.status)) end('failed'); }
  }
  /** The initiated run itself, in its conversation's queue: a turn with no message of the person. Her reply is split
   * and sent like any reply, each message with its own receipt; the first that fails or is unknown ends it, and
   * nothing is sent twice. Only delivered messages are observed as hers. */
  async initiated({ cfg, kind, requestId, item, streamId, userId, jobRef }) {
    const scope = { streamId, memoryEpoch: item.memoryEpoch }, stream = { streamId, text: '' };
    const end = status => { item.status = status; this.save(); };
    let sending = false;
    try {
      if (!await this.current(cfg, stream, item)) return end('dropped:stale');
      item.status = 'processing'; this.save();
      // A finished job's result is read from the content service inside this conversation's own scope; Authority never
      // carries the text, and a job of another conversation cannot be read here.
      const event = jobRef ? completionEvent(await this.media.call(scope, 'jobResult', { ref: jobRef })) : INITIATION_EVENTS[kind];
      // A sticker marker is taken out and dropped: a run she starts herself sends no sticker yet.
      const text = takeStickerMarker(await executeConversation(this.executor, { scope, requestId, input: { text: event, initiated: true } })).text;
      if (DECLINED.test(text)) return end('declined');
      for (const [index, piece] of splitReply(text).entries()) {
        if (index) await this.sleep(SPLIT_GAP_MS);
        if (!await this.current(cfg, stream, item)) return end(item.receipts?.length ? 'partial' : 'dropped:stale');
        sending = true; item.status = 'sending'; this.save();
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId, part: { type: 'text', text: piece } });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: replySegments(piece), auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
          receipt = { messageId, type: 'text', text: piece };
        }
        await this.delivered(stream, item, receipt); sending = false;
      }
      end('sent');
    } catch (error) {
      // The spend tier stops this kind of work first: recorded, no notice to the owner, nothing retried.
      end(sending ? 'unknown' : item.receipts?.length ? 'partial' : error?.code === 'BUDGET_EXHAUSTED' ? 'deferred:budget' : error?.code === 'WORLD_PAUSED' ? 'dropped:paused' : 'failed');
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
  noteSticker(streamId, sent) {
    const recent = [...(this.recentStickers.get(streamId) ?? []), sent].slice(-RECENT_REPLIES);
    this.recentStickers.delete(streamId); this.recentStickers.set(streamId, recent);
    // Bounded: the conversations heard from longest ago are forgotten first.
    while (this.recentStickers.size > 200) this.recentStickers.delete(this.recentStickers.keys().next().value);
  }
  /** Lines added to what the model reads this turn: how often she sent a sticker lately (not on a voice turn) and, when
   * the owner says 收下这个 in the owner's own conversation, whether the picture went into her library. Anyone else
   * saying it changes nothing. */
  async stickerFacts({ cfg, message, scope, userId, prepared }) {
    const streamId = message.observation.streamId, picture = prepared.mediaRefs.find(ref => ref.kind === 'image');
    let kept = '';
    if (userId === cfg.allowedCallerUID && asksToKeep(message.authoredText)) {
      const last = this.lastPicture.get(streamId), ref = picture?.id ?? (last && this.clock() - last.at <= KEEP_WINDOW_MS ? last.ref : null);
      if (!ref) kept = '\n[渠道事实：主人让你收下一张图，但最近没有收到图，表情库没有变化。]';
      else {
        try { const result = await this.media.keepSticker(scope, ref); kept = `\n[渠道事实：${result.already ? '这张图本来就在你的表情库里' : '已把主人发的那张图收进你的表情库'}（名字：${result.name}）。]`; }
        catch { kept = '\n[渠道事实：这张图没能收进你的表情库。]'; }
      }
    }
    if (picture) { this.lastPicture.delete(streamId); this.lastPicture.set(streamId, { ref: picture.id, at: this.clock() }); while (this.lastPicture.size > 200) this.lastPicture.delete(this.lastPicture.keys().next().value); }
    return kept + (prepared.voiceRequested ? '' : frequencyLine(this.recentStickers.get(streamId)));
  }
  async process({ cfg, message, requestId, item, userId = cfg.allowedCallerUID }) {
    const observation = message.observation, scope = { streamId: observation.streamId, memoryEpoch: item.memoryEpoch };
    let sending = false, prepared, carry = null;
    try {
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      item.status = 'processing'; this.save();
      const observed = await this.port.observe(observation);
      if (observed?.forgotten) { item.status = 'forgotten'; this.save(); return; }
      if (typeof observed?.observationId !== 'string' || !observed.observationId) throw new Error('QQ_OBSERVATION_UNAVAILABLE');
      if (message.media.length && !this.media) throw new Error('QQ_MEDIA_UNAVAILABLE');
      prepared = this.media ? await this.media.prepare(message, scope) : { executionText: observation.text, queryText: observation.text.slice(0, 512), mediaRefs: [], voiceRequested: false };
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      if (this.media) prepared = { ...prepared, executionText: prepared.executionText + await this.stickerFacts({ cfg, message, scope, userId, prepared }) };
      // The executor derives its session from this scope. Only the original
      // observation is memory evidence; ASR/OCR/vision stay execution context.
      carry = await this.carry(scope);
      const input = { text: prepared.executionText, queryText: prepared.queryText, mediaRefs: prepared.mediaRefs, evidence: [{ ref: observed.observationId, eventId: observation.eventId, role: observation.role }], ...(carry ? { event: carry.event } : {}) };
      // `[表情:词]` never reaches the chat: taken out here, its word picks a sticker below.
      const { text, word } = takeStickerMarker(await executeConversation(this.executor, { scope, requestId, input, timeoutMs: this.media && (prepared.mediaRefs.length || /音频|语音|转写|识别|qwen/i.test(prepared.queryText)) ? 420000 : 120000 }));
      // She has the result now, in a stored turn: it counts as told, whatever becomes of sending the reply.
      if (carry) { carry.item.status = 'carried'; this.save(); }
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      const planned = this.media ? await this.media.plan({ scope, requestId, sourceEventId: observation.eventId, text, voiceRequested: prepared.voiceRequested, voiceProfile: prepared.voiceProfile }) : [{ type: 'text', text }];
      // A long text reply goes out as a few short messages. Each is its own send with its own receipt, so the
      // loop below stops at the first one that fails or is unknown, and only delivered ones are observed.
      // A voice reply (and its text fallback) is never split.
      const parts = planned.flatMap(part => part.type === 'text' && !prepared.voiceRequested ? splitReply(part.text).map((piece, index) => ({ type: 'text', text: piece, ...(index ? { follows: true } : {}) })) : [part]).filter(part => part.type !== 'text' || part.text.trim());
      // A library sticker close to her word goes last, as a message of its own with its own receipt. Not with a voice
      // reply. Not found, or the content service failing: no sticker, the text goes as it is.
      const sticker = word && this.media && !prepared.voiceRequested ? await this.media.pickSticker(scope, word, observation.eventId).catch(() => null) : null;
      if (sticker) parts.push(sticker);
      if (this.media && !prepared.voiceRequested) this.noteSticker(observation.streamId, Boolean(sticker));
      for (const part of parts) {
        if (part.follows) await this.sleep(SPLIT_GAP_MS);
        if (!await this.current(cfg, observation, item)) { item.status = item.receipts?.length ? 'partial' : 'paused'; this.save(); return; }
        sending = true; item.status = 'sending'; this.save();
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId, part });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: replySegments(part.text), auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
          receipt = { messageId, type: 'text', text: part.text };
        }
        await this.delivered(observation, item, receipt); sending = false;
      }
      item.status = item.unobserved ? 'sent_unobserved' : 'sent'; this.save();
    } catch (error) {
      if (error?.code === 'BUDGET_EXHAUSTED' && !sending && !item.receipts?.length) { await this.budgetExhausted(cfg, item); return; }
      // The spend tier stopped vision/web (>= restricted): silence, like the daily cap, not an apology per image.
      const restricted = error?.code === 'CONTENT_SPEND_RESTRICTED' && !sending && !item.receipts?.length;
      item.status = restricted ? 'budget_restricted' : sending ? item.receipts?.length ? 'partial_unknown' : 'unknown' : item.receipts?.length ? 'partial' : 'failed'; this.save();
      // A failed perception must not be replaced by a hallucinated description.
      if (!restricted && !sending && !prepared && message.media.length && await this.current(cfg, observation, item).catch(() => false)) {
        const text = '这条附件暂时没有处理完成，我没有识别其内容。可以重试或改用文字。';
        try {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text } }], auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error();
          await this.delivered(observation, item, { messageId, type: 'text', text }); item.status = 'failed_notified'; this.save();
        } catch { item.status = 'unknown'; this.save(); }
      }
    } finally {
      // The turn ended before she had the carried result: reported as failed, so it rides on a later message.
      if (carry?.item.status === 'processing') { carry.item.status = 'failed'; this.save(); }
      // What became of a hand-out for this turn is reported now rather than on the next poll (an open one holds others back).
      if (this.carrying) { this.carrying = false; await this.reportInitiations().catch(() => {}); }
    }
  }
}
