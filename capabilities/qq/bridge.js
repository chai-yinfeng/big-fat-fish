import fs from 'node:fs';
import path from 'node:path';
import { messageFromOneBot } from './source.js';
import { qqRequestId } from './worker-route.js';
import { executeConversation } from '../conversation/executor.js';

const identifier = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export const FRIEND_REFRESH_MS = 10 * 60 * 1000;
export const CONCURRENCY = 2;
const STREAM_QUEUE_LIMIT = 10;
// Beijing calendar day (Asia/Shanghai has no DST), independent of the host TZ.
export const beijingDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
export const OWNER_BUDGET_NOTICE = '提醒：今天的模型开销已经到达每日上限，大肥鱼今天先不再回复任何人，北京时间零点后自动恢复。可以在控制台查看今日开销或调整上限。';
export class QQBridge {
  constructor({ authority, port, onebot, executor, media, settingsFile, stateFile, clock = Date.now }) {
    Object.assign(this, { authority, port, onebot, executor, media, settingsFile, stateFile, clock });
    this.settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {} };
    for (const item of Object.values(this.state.records)) { if (['queued', 'processing'].includes(item.status)) item.status = 'interrupted'; else if (item.status === 'sending') item.status = 'unknown'; }
    this.connected = false; this.selfId = null; this.connectedAt = 0; this.connectionEpoch = 0; this.identityProbe = null;
    // Friends may chat privately; the list is refreshed periodically and on friend_add.
    this.friends = null; this.friendsAt = 0; this.friendProbe = null; this.admitted = new Set();
    // One serial queue per conversation, at most CONCURRENCY conversations at once.
    this.streams = new Map(); this.active = 0; this.waiting = [];
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
  async process({ cfg, message, requestId, item, userId = cfg.allowedCallerUID }) {
    const observation = message.observation, scope = { streamId: observation.streamId, memoryEpoch: item.memoryEpoch };
    let sending = false, prepared;
    try {
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      item.status = 'processing'; this.save();
      const observed = await this.port.observe(observation);
      if (observed?.forgotten) { item.status = 'forgotten'; this.save(); return; }
      if (typeof observed?.observationId !== 'string' || !observed.observationId) throw new Error('QQ_OBSERVATION_UNAVAILABLE');
      if (message.media.length && !this.media) throw new Error('QQ_MEDIA_UNAVAILABLE');
      prepared = this.media ? await this.media.prepare(message, scope) : { executionText: observation.text, queryText: observation.text.slice(0, 512), mediaRefs: [], voiceRequested: false };
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      // The executor derives its session from this scope. Only the original
      // observation is memory evidence; ASR/OCR/vision stay execution context.
      const input = { text: prepared.executionText, queryText: prepared.queryText, mediaRefs: prepared.mediaRefs, evidence: [{ ref: observed.observationId, eventId: observation.eventId, role: observation.role }] };
      const text = await executeConversation(this.executor, { scope, requestId, input, timeoutMs: this.media && (prepared.mediaRefs.length || /音频|语音|转写|识别|qwen/i.test(prepared.queryText)) ? 420000 : 120000 });
      if (!await this.current(cfg, observation, item)) { item.status = 'paused'; this.save(); return; }
      const parts = this.media ? await this.media.plan({ scope, requestId, sourceEventId: observation.eventId, text, voiceRequested: prepared.voiceRequested, voiceProfile: prepared.voiceProfile }) : [{ type: 'text', text }];
      for (const part of parts) {
        if (!await this.current(cfg, observation, item)) { item.status = item.receipts?.length ? 'partial' : 'paused'; this.save(); return; }
        sending = true; item.status = 'sending'; this.save();
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId, part });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: part.text } }], auto_escape: true });
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
    }
  }
}
