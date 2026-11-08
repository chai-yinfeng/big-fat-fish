import fs from 'node:fs';
import path from 'node:path';
import { messageFromOneBot } from './source.js';
import { qqRequestId } from './worker-route.js';
import { executeConversation } from '../conversation/executor.js';

const identifier = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export class QQBridge {
  constructor({ authority, port, onebot, executor, media, settingsFile, stateFile }) {
    Object.assign(this, { authority, port, onebot, executor, media, settingsFile, stateFile });
    this.settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {} };
    for (const item of Object.values(this.state.records)) { if (['queued', 'processing'].includes(item.status)) item.status = 'interrupted'; else if (item.status === 'sending') item.status = 'unknown'; }
    this.connected = false; this.selfId = null; this.connectedAt = 0; this.connectionEpoch = 0; this.identityProbe = null;
    this.queue = Promise.resolve(); this.queued = 0;
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
    this.connectedAt = Date.now(); await this.refreshIdentity();
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
    if (!cfg || !this.connected || this.selfId !== cfg.expectedSelfId || event?.post_type !== 'message' || event.message_type !== 'private' || event.anonymous || String(event.user_id) !== cfg.allowedCallerUID) return;
    let message; try { message = messageFromOneBot(event, cfg); } catch { return; }
    if (!message || message.observation.at < this.connectedAt - 1000) return;
    const observation = message.observation, requestId = qqRequestId(observation);
    if (this.state.records[requestId]) return;
    const item = this.state.records[requestId] = { status: 'queued' }; this.save();
    const world = (await this.authority.health()).world; item.worldRevision = world.revision;
    if (world.paused || this.queued >= 10) { item.status = 'paused'; this.save(); return; }
    const scope = await this.authority.context({ streamId: observation.streamId, query: observation.text.slice(0, 512), budgetChars: 1 });
    if (!Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof scope.entityId !== 'string') { item.status = 'failed'; this.save(); return; }
    item.memoryEpoch = scope.memoryEpoch; item.entityId = scope.entityId;
    this.queued++;
    const task = this.queue.then(() => this.process({ cfg, message, requestId, item }));
    this.queue = task.catch(() => {}).finally(() => { this.queued--; }); return task;
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
  async process({ cfg, message, requestId, item }) {
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
      const parts = this.media ? await this.media.plan({ scope, requestId, sourceEventId: observation.eventId, text, voiceRequested: prepared.voiceRequested, voiceQuality: prepared.voiceQuality }) : [{ type: 'text', text }];
      for (const part of parts) {
        if (!await this.current(cfg, observation, item)) { item.status = item.receipts?.length ? 'partial' : 'paused'; this.save(); return; }
        sending = true; item.status = 'sending'; this.save();
        let receipt;
        if (this.media) receipt = await this.media.send({ scope, userId: cfg.allowedCallerUID, part });
        else {
          const sent = await this.onebot.call('send_private_msg', { user_id: cfg.allowedCallerUID, message: [{ type: 'text', data: { text: part.text } }], auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error('INVALID_SEND_RECEIPT');
          receipt = { messageId, type: 'text', text: part.text };
        }
        await this.delivered(observation, item, receipt); sending = false;
      }
      item.status = item.unobserved ? 'sent_unobserved' : 'sent'; this.save();
    } catch {
      item.status = sending ? item.receipts?.length ? 'partial_unknown' : 'unknown' : item.receipts?.length ? 'partial' : 'failed'; this.save();
      // A failed perception must not be replaced by a hallucinated description.
      if (!sending && !prepared && message.media.length && await this.current(cfg, observation, item).catch(() => false)) {
        const text = '这条附件暂时没有处理完成，我没有识别其内容。可以重试或改用文字。';
        try {
          const sent = await this.onebot.call('send_private_msg', { user_id: cfg.allowedCallerUID, message: [{ type: 'text', data: { text } }], auto_escape: true });
          const messageId = String(sent.message_id); if (!/^-?\d{1,20}$/.test(messageId)) throw new Error();
          await this.delivered(observation, item, { messageId, type: 'text', text }); item.status = 'failed_notified'; this.save();
        } catch { item.status = 'unknown'; this.save(); }
      }
    }
  }
}
