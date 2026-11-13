import http from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
function closed(value, allowed, required) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail('INVALID_REQUEST');
}

/** Capability-only HTTP/UDS face. No arbitrary route, admin, engine or DB access. */
export class AuthorityClient {
  #socketPath; #tokenFile; #timeoutMs; #maxResponseBytes;
  constructor({ socketPath, tokenFile, timeoutMs = 2000, maxResponseBytes = 32768 }) {
    if (!text(socketPath, 4096) || !isAbsolute(socketPath) || !text(tokenFile, 4096) || !isAbsolute(tokenFile) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 65536) throw fail('INVALID_CONFIG');
    this.#socketPath = socketPath;
    this.#tokenFile = tokenFile;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }
  health() { return this.#request('GET', '/v1/health'); }
  async observe(value) {
    closed(value, ['eventId', 'streamId', 'actorId', 'role', 'text', 'at', 'origin'], ['eventId', 'streamId', 'actorId', 'role', 'text', 'at']);
    if (value.origin !== undefined && value.origin !== 'attachment') throw fail('INVALID_REQUEST');
    if (![value.eventId, value.streamId, value.actorId].every(v => text(v)) || !['user', 'assistant', 'external'].includes(value.role) || !text(value.text, 16000) || !Number.isSafeInteger(value.at) || value.at < 0) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/observations', value);
  }
  async submit(value) {
    closed(value, ['proposalId', 'observationId', 'type', 'payload'], ['proposalId', 'observationId', 'type', 'payload']);
    if (![value.proposalId, value.observationId, value.type].every(v => text(v)) || !object(value.payload)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/proposals', value);
  }
  async getReceipt(id) {
    if (!text(id)) throw fail('INVALID_REQUEST');
    return this.#request('GET', `/v1/receipts/${encodeURIComponent(id)}`);
  }
  async context(value) {
    closed(value, ['streamId', 'query', 'budgetChars', 'exclude', 'profile', 'windowFromAt'], ['streamId']);
    if (value.windowFromAt !== undefined && (!Number.isSafeInteger(value.windowFromAt) || value.windowFromAt < 0)) throw fail('INVALID_REQUEST');
    if (!text(value.streamId) || (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 512)) || (value.budgetChars !== undefined && (!Number.isInteger(value.budgetChars) || value.budgetChars < 1 || value.budgetChars > 4000))) throw fail('INVALID_REQUEST');
    if (value.profile !== undefined && typeof value.profile !== 'boolean') throw fail('INVALID_REQUEST');
    if (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > 256 || !value.exclude.every(id => text(id)))) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/context', value);
  }
  async memorySearch(value) {
    closed(value, ['streamId', 'query', 'limit', 'budgetChars'], ['streamId', 'query']);
    if (!text(value.streamId) || typeof value.query !== 'string' || value.query.length > 2000 || (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 32)) || (value.budgetChars !== undefined && (!Number.isInteger(value.budgetChars) || value.budgetChars < 0 || value.budgetChars > 2400))) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/memory/search', value);
  }
  async memoryRead(value) {
    closed(value, ['streamId', 'id'], ['streamId', 'id']);
    if (!text(value.streamId) || !text(value.id)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/memory/read', value);
  }
  async memoryRecall(value) {
    closed(value, ['streamId', 'fromAt', 'toAt', 'limit', 'budgetChars'], ['streamId', 'fromAt', 'toAt']);
    if (!text(value.streamId) || !Number.isSafeInteger(value.fromAt) || !Number.isSafeInteger(value.toAt) || value.fromAt < 0 || value.toAt < value.fromAt) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/memory/recall', value);
  }
  async admitPerson(value) {
    closed(value, ['uid'], ['uid']);
    if (typeof value.uid !== 'string' || !/^[1-9]\d{0,19}$/.test(value.uid)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/people/admit', value);
  }
  /** QQ capability credential: the next run she starts herself, as Authority chose it, or `initiation: null` with a reason. */
  initiationNext() { return this.#request('POST', '/v1/initiations/next', {}); }
  /** QQ capability credential, as an ordinary turn of this conversation begins: a finished background job of it that
   * the person was not told about yet, handed out to ride on this turn, or `initiation: null`. */
  async initiationCarry(value) {
    closed(value, ['streamId'], ['streamId']);
    if (!text(value.streamId)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/initiations/carry', value);
  }
  async initiationAck(value) {
    closed(value, ['id', 'outcome'], ['id', 'outcome']);
    if (!text(value.id) || !text(value.outcome, 64)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/initiations/ack', value);
  }
  async maintenanceBatch(value = {}) {
    closed(value, ['afterRevision', 'limit', 'mode'], []);
    const batch = await this.#request('POST', '/v1/maintenance/batch', value);
    this.maintenanceTasks ||= {};
    if (batch?.taskId) this.maintenanceTasks[value.mode || 'private'] = batch.taskId;
    return batch;
  }
  async writeDiary(value) {
    closed(value, ['taskId', 'kind', 'text', 'sourceIds'], ['kind', 'text', 'sourceIds']);
    if (!['private', 'public'].includes(value.kind) || !text(value.text, 4000) || !Array.isArray(value.sourceIds) || !value.sourceIds.every(id => text(id))) throw fail('INVALID_REQUEST');
    const taskId = value.taskId || this.maintenanceTasks?.[value.kind];
    if (!text(taskId)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/maintenance/diary', { ...value, taskId });
  }
  /** Maintenance credential: the next consolidation batch Authority chose, or `task: null` with a reason. */
  consolidationNext() { return this.#request('POST', '/v1/maintenance/consolidation/next', {}); }
  async consolidationCommit(value) {
    closed(value, ['taskId', 'outcome', 'digest', 'facts'], ['taskId', 'outcome']);
    if (!text(value.taskId) || !['ok', 'invalid', 'deferred'].includes(value.outcome)) throw fail('INVALID_REQUEST');
    return this.#request('POST', '/v1/maintenance/consolidation/commit', value);
  }
  async #request(method, path, value) {
    let body;
    try { body = value === undefined ? undefined : Buffer.from(JSON.stringify(value)); } catch { throw fail('INVALID_REQUEST'); }
    if (body?.length > 32768) throw fail('REQUEST_LIMIT');
    let token;
    try {
      const handle = await open(this.#tokenFile, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw fail('CREDENTIAL_UNAVAILABLE');
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) throw fail('CREDENTIAL_UNAVAILABLE');
        token = buffer.subarray(0, bytesRead).toString('utf8').trim();
      } finally { await handle.close(); }
      if (!/^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(token)) throw fail('CREDENTIAL_UNAVAILABLE');
    } catch { throw fail('CREDENTIAL_UNAVAILABLE'); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const request = http.request({ socketPath: this.#socketPath, path, method, agent: false, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > this.#maxResponseBytes) { finish(fail('RESPONSE_LIMIT')); response.destroy(); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(fail('TRANSPORT_ERROR')));
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) { finish(Object.assign(new Error(`Authority request failed (${response.statusCode})`), { code: 'AUTHORITY_REJECTED', status: response.statusCode })); return; }
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!object(envelope) || envelope.ok !== true || !Object.hasOwn(envelope, 'value') || Object.keys(envelope).some(key => !['ok', 'value'].includes(key))) throw fail('INVALID_RESPONSE');
            finish(null, envelope.value);
          } catch { finish(fail('INVALID_RESPONSE')); }
        });
      });
      const timer = setTimeout(() => { finish(fail('TIMEOUT')); request.destroy(); }, this.#timeoutMs);
      request.on('error', () => finish(fail('TRANSPORT_ERROR')));
      request.end(body);
    });
  }
}
