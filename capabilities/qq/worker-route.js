import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
function uid(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fail('INVALID_QQ_WORKER_CONFIG');
  const text = String(value);
  if (!/^\d{1,20}$/.test(text) || BigInt(text) <= 0n) throw fail('INVALID_QQ_WORKER_CONFIG');
  return BigInt(text).toString();
}
export function qqSessionId(self, caller, epoch = 0) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw fail('INVALID_MEMORY_EPOCH');
  return `qq-private-${digest(`${uid(self)}\0${uid(caller)}`).slice(0, 32)}${epoch ? `-e${epoch}` : ''}`;
}
export function qqSessionEpoch(id, self, caller) {
  const base = qqSessionId(self, caller);
  if (id === base) return 0;
  const tail = id.startsWith(base + '-e') ? id.slice(base.length + 2) : '';
  const epoch = Number(tail);
  return /^[1-9]\d*$/.test(tail) && Number.isSafeInteger(epoch) ? epoch : null;
}
export function qqRequestId(observation) {
  if (typeof observation?.streamId !== 'string' || typeof observation?.eventId !== 'string') throw fail('QQ_INPUT_UNTRUSTED');
  return `qq-message-${digest(`${observation.streamId}\0${observation.eventId}`)}`;
}
export function loadQQWorkerConfig(file = process.env.COMPANION_QQ_WORKER_CONFIG) {
  if (!file) return Object.freeze({ enabled: false });
  try {
    if (!path.isAbsolute(file)) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fields = ['enabled', 'expectedSelfId', 'allowedCallerUID', 'socketPath', 'tokenFile', 'inboxFile'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || typeof value.enabled !== 'boolean') throw new Error();
    if (!value.enabled) return Object.freeze({ enabled: false });
    if (!fields.every(key => Object.hasOwn(value, key)) || !['socketPath', 'tokenFile', 'inboxFile'].every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]))) throw new Error();
    return Object.freeze({ ...value, expectedSelfId: uid(value.expectedSelfId), allowedCallerUID: uid(value.allowedCallerUID) });
  } catch { throw fail('INVALID_QQ_WORKER_CONFIG'); }
}
function messageText(message) {
  if (message?.role !== 'user' || message.source?.kind !== 'user' || !Array.isArray(message.content) || !message.content.length || message.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  return message.content.map(block => block.text).join('\n');
}

/** Trusted runtime correlation, not an identity claim carried in SDK prompt text. */
export function createQQWorkerRoute(config, memoryEpoch = 0) {
  const self = uid(config.expectedSelfId), caller = uid(config.allowedCallerUID);
  const sessionId = qqSessionId(self, caller, memoryEpoch), streamId = `qq:${self}:private:${caller}`, actorId = `qq:${self}:user:${caller}`;
  let cachedStamp, rows = new Map(), authorizedTurn, authorizedQuery, authorizedRequestId;
  function inbox() {
    let stat;
    try { stat = fs.statSync(config.inboxFile); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw fail('QQ_INBOX_UNAVAILABLE'); }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === cachedStamp) return rows;
    const text = fs.readFileSync(config.inboxFile, 'utf8'), next = new Map();
    // A trailing partial append is not committed until its newline appears.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    try {
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.sessionId !== sessionId) continue;
        const observation = row.observation;
        if (!observation || Object.keys(observation).some(key => !['eventId', 'streamId', 'actorId', 'role', 'text', 'at', 'origin'].includes(key)) || observation.streamId !== streamId || observation.actorId !== actorId || observation.role !== 'user' || observation.origin !== undefined && observation.origin !== 'attachment' || !/^onebot:v11:message:-?\d+$/.test(observation.eventId) || typeof observation.text !== 'string' || !observation.text.length || observation.text.length > 16000 || !Number.isSafeInteger(observation.at) || observation.at < 0 || row.requestId !== qqRequestId(observation)) throw new Error();
        if (row.executionText !== undefined && (typeof row.executionText !== 'string' || !row.executionText || row.executionText.length > 24000)) throw new Error();
        if (row.queryText !== undefined && (typeof row.queryText !== 'string' || !row.queryText || row.queryText.length > 512)) throw new Error();
        if (row.mediaRefs !== undefined && (!Array.isArray(row.mediaRefs) || row.mediaRefs.length > 12 || row.mediaRefs.some(ref => !ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 200 || typeof ref.kind !== 'string' || !ref.kind || ref.kind.length > 64))) throw new Error();
        const previous = next.get(row.requestId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error();
        next.set(row.requestId, row);
      }
    } catch { throw fail('QQ_INBOX_INVALID'); }
    rows = next; cachedStamp = stamp;
    return rows;
  }
  function trusted(message) {
    const text = messageText(message), requestId = message?.source?.rpcId;
    if (text === null || typeof requestId !== 'string') return null;
    const row = inbox().get(requestId);
    return row && (row.executionText || row.observation.text) === text ? row : null;
  }
  function normalizeEvent(id, event) {
    if (id !== sessionId || event?.type !== 'user/message' || !Number.isSafeInteger(event.seq) || event.seq < 0) return null;
    const observation = trusted(event.data)?.observation;
    if (observation && Buffer.byteLength(JSON.stringify(observation)) > 32768) throw fail('WIRE_LIMIT');
    return observation ? { ...observation } : null;
  }
  return {
    sessionId, streamId,
    clientConfig: { socketPath: config.socketPath, tokenFile: config.tokenFile },
    normalizeEvent,
    eventIdFor: (id, event) => (id === sessionId && event?.type === 'user/message' ? trusted(event.data)?.observation.eventId : null) || `qq-worker:${id}:${event?.seq}`,
    authorizeStep({ messages, turn }) {
      if (!Array.isArray(messages) || !Number.isSafeInteger(turn)) { authorizedTurn = authorizedRequestId = undefined; throw fail('QQ_INPUT_UNTRUSTED'); }
      if (messages.length) {
        authorizedTurn = authorizedRequestId = undefined;
        const matched = messages.map(trusted);
        if (matched.some(row => !row)) throw fail('QQ_INPUT_UNTRUSTED');
        authorizedTurn = turn;
        authorizedQuery = matched.map(row => row.queryText || row.observation.text).join('\n').slice(0, 512);
        const requests = new Set(matched.map(row => row.requestId));
        authorizedRequestId = requests.size === 1 ? matched[0].requestId : undefined;
      } else if (authorizedTurn !== turn) { authorizedTurn = authorizedRequestId = undefined; throw fail('QQ_INPUT_UNTRUSTED'); }
      return authorizedQuery;
    },
    currentRequestId(turn) { return turn === authorizedTurn ? authorizedRequestId : undefined; },
  };
}
