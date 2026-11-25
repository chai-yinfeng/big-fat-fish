import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CONTENT_ACTIONS, CONTENT_FIELDS } from '../../capabilities/providers/index.js';

const SCHEMAS = {
  '/v1/observations': ['eventId', 'streamId', 'actorId', 'role', 'text', 'at', 'origin'],
  '/v1/proposals': ['proposalId', 'observationId', 'type', 'payload'],
  '/v1/context': ['streamId', 'query', 'budgetChars', 'exclude', 'profile', 'windowFromAt'],
  '/v1/admin/capabilities': ['id', 'policy'],
  '/v1/admin/actors': ['capabilityId', 'externalActorId', 'personId'],
  '/v1/admin/streams': ['capabilityId', 'streamId', 'personId', 'audience', 'entityId'],
  '/v1/admin/persona': ['entityId', 'expectedRevision', 'patch', 'reason'],
  '/v1/memory/search': ['streamId', 'query', 'limit', 'budgetChars', 'windowFromAt'],
  '/v1/memory/read': ['streamId', 'id', 'windowFromAt'],
  '/v1/memory/recall': ['streamId', 'fromAt', 'toAt', 'limit', 'budgetChars', 'windowFromAt'],
  '/v1/people/admit': ['uid', 'actorId', 'streamId'],
  '/v1/initiations/next': ['busy'],
  '/v1/initiations/ack': ['id', 'outcome'],
  '/v1/initiations/carry': ['streamId'],
  '/v1/self': ['streamId', 'mood', 'note', 'reach'],
  '/v1/maintenance/batch': ['afterRevision', 'limit', 'mode'],
  '/v1/maintenance/diary': ['taskId', 'kind', 'text', 'sourceIds'],
  '/v1/maintenance/consolidation/next': [],
  '/v1/maintenance/consolidation/commit': ['taskId', 'outcome', 'digest', 'facts', 'intents'],
  '/v1/maintenance/diary/next': [],
  '/v1/maintenance/diary/commit': ['taskId', 'outcome', 'private', 'open', 'usedIds'],
  '/v1/diary/code': ['streamId'],
  '/v1/cleanup/next': ['party'],
  '/v1/cleanup/ack': ['id', 'memoryEpoch', 'party', 'report'],
};
/** Passcode attempts on `/v1/room/diary` in any one minute, whoever makes them: a passcode is short, so guessing is
 * held back here as well as in the room page's server. */
export const ROOM_DIARY_PER_MINUTE = 30;
/** How often the content service is asked again to forget its part of a pending cleanup job. */
export const CLEANUP_RETRY_MS = 5000;
const ERRORS = {
  AUTH_REQUIRED: [401, 'A valid capability or operator credential is required'],
  FORBIDDEN: [403, 'This operation is not granted to this principal'],
  INVALID_REQUEST: [400, 'Request does not match the bounded protocol'],
  VALIDATION_ERROR: [400, 'Request does not match the bounded protocol'],
  CONFLICT: [409, 'The existing operation or revision conflicts with this request'],
  WRITER_BUSY: [409, 'Another authority writer is active'],
  SCHEMA_ERROR: [409, 'Authority storage schema is incompatible'],
  CLOSED: [503, 'Authority is not available'],
  NOT_FOUND: [404, 'No matching operation exists for this principal'],
  BODY_TOO_LARGE: [413, 'Request exceeds the protocol body limit'],
  UNAVAILABLE: [503, 'Authority review is unavailable'],
  PEOPLE_LIMIT: [409, 'The admitted people limit is reached'],
  SPEND_RESTRICTED: [429, 'The daily spend cap has stopped this capability'],
  RATE_LIMITED: [429, 'Too many attempts; try again in a minute'],
};
function failure(code) { return Object.assign(new Error(ERRORS[code][1]), { code }); }
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(status >= 400 ? { connection: 'close' } : {}) });
  res.end(JSON.stringify(body));
}
async function bodyOf(req, allowed, maxBytes) {
  if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw failure('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    let length = 0, chunks = [], failed = false;
    req.on('data', chunk => {
      if (failed) return;
      length += chunk.length;
      if (length > maxBytes) { failed = true; chunks = []; reject(failure('BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('error', () => reject(failure('INVALID_REQUEST')));
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('INVALID_REQUEST');
        resolve(value);
      } catch { reject(failure('INVALID_REQUEST')); }
    });
  });
}
async function recoverSocket(socketPath) {
  let initial;
  try { initial = fs.lstatSync(socketPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!initial.isSocket()) throw new Error('Refusing an existing non-socket target');
  await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    connection.once('connect', () => { connection.destroy(); reject(new Error('A live server already owns the socket')); });
    connection.once('error', error => {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') { reject(new Error('Cannot verify stale socket ownership')); return; }
      try {
        const current = fs.lstatSync(socketPath);
        if (!current.isSocket() || current.dev !== initial.dev || current.ino !== initial.ino) throw new Error('Socket path changed during stale recovery');
        // Main opens the exclusive SQLite writer BEFORE this recovery. Only the
        // verified dead socket inode under the configured directory is removed.
        fs.unlinkSync(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') { reject(error); return; } }
      resolve();
    });
  });
}

/** Unix-only transport. The caller supplies the already-exclusive authority. */
export function createAuthorityServer({ authority, socketPath, credentials, contentControl, contentJobs, contentForget, cleanupRetryMs = CLEANUP_RETRY_MS, maxBodyBytes = 32768, socketMode = 0o600, batchSize = 32, onFatal = () => {} }) {
  if (!path.isAbsolute(socketPath) || !Array.isArray(credentials) || credentials.length === 0) throw new Error('Explicit socket and credentials are required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 65536) throw new Error('Invalid protocol body limit');
  if (![0o600, 0o660].includes(socketMode)) throw new Error('Socket mode must be private or explicitly group-scoped');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error('Invalid review batch size');
  const seen = new Set();
  const grants = credentials.map(record => {
    if (!/^[a-f0-9]{64}$/.test(record.hash) || seen.has(record.hash) || !['admin', 'capability', 'maintenance', 'room'].includes(record.role) || (record.role === 'capability' && (typeof record.capabilityId !== 'string' || !record.capabilityId)) || (record.role === 'maintenance' && (typeof record.entityId !== 'string' || !record.entityId))) throw new Error('Invalid authority credential configuration');
    seen.add(record.hash);
    return { ...record, bytes: Buffer.from(record.hash, 'hex') };
  });
  let closed = false, scheduled = false, unhealthy = false;
  const diaryAttempts = [];
  // Finished background jobs nobody was told about, as the content service lists them. Authority asks with its own
  // control credential; the content service never calls here. Unreachable means none this round.
  const untoldJobs = async grant => {
    // Any conversation channel may ask; Authority then hands each only the jobs of its own conversations.
    if (!contentJobs || !authority.conversationChannel(grant.capabilityId)) return [];
    try { const value = await contentJobs({ action: 'pending' }); return Array.isArray(value?.jobs) ? value.jobs : []; } catch { return []; }
  };
  // What Authority decided about those jobs goes back before the caller hears of it. A report that fails is made
  // again when the job is next listed; Authority's own record already forbids a second telling.
  const reportJobs = async () => { for (const notice of authority.drainJobNotices()) { try { await contentJobs?.({ action: 'notice', ...notice }); } catch {} } };
  // Forgetting: the content service's part of each pending cleanup job. Authority hands the job over on its control
  // socket and records the confirmation itself; the content service never calls here. Refused (it is busy, the
  // world is not paused) or unreachable: asked again on the next round. One round at a time.
  let forgetting = false, forgetTimer = null;
  async function forgetContent() {
    if (closed || forgetting || !contentForget) return;
    forgetting = true;
    try {
      for (const job of authority.cleanupForContent()) {
        try { const report = await contentForget(job); if (!closed) authority.cleanupConfirm('content', { id: job.id, memoryEpoch: job.memoryEpoch, report }); } catch {}
      }
    } catch {} finally { forgetting = false; }
  }
  function schedule() {
    if (closed || scheduled || unhealthy) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closed || unhealthy) return;
      try {
        const processed = authority.processPending({ limit: batchSize });
        if (processed.length === batchSize) schedule();
      } catch { unhealthy = true; onFatal(new Error('Authority review transaction failed')); }
    });
  }
  function authenticate(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
    if (!match) throw failure('AUTH_REQUIRED');
    const digest = createHash('sha256').update(match[1]).digest();
    let matched;
    for (const grant of grants) if (timingSafeEqual(digest, grant.bytes)) matched = grant;
    if (!matched) throw failure('AUTH_REQUIRED');
    return matched;
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      const grant = authenticate(req);
      if (unhealthy) throw failure('UNAVAILABLE');
      const url = new URL(req.url, 'http://authority.invalid');
      if (url.search || url.hash) throw failure('INVALID_REQUEST');
      const route = url.pathname;
      if (route.startsWith('/v1/admin/') && grant.role !== 'admin') throw failure('FORBIDDEN');
      let value;
      // The room grant reads the room state and, with a person's passcode, that person's open diaries; nothing else,
      // and nobody else reads either: no write, no admin or capability route, not even health. Running jobs come
      // from the content service; unreachable means none.
      if (grant.role === 'room' || route === '/v1/room' || route === '/v1/room/diary') {
        if (grant.role !== 'room') throw failure('FORBIDDEN');
        if (route === '/v1/room' && req.method === 'GET') {
          let listing = null;
          try { listing = contentJobs ? await contentJobs({ action: 'list' }) : null; } catch {}
          value = authority.roomState(listing);
        } else if (route === '/v1/room/diary' && req.method === 'POST') {
          // Every attempt counts, right or wrong; over the limit nothing is looked up.
          const now = Date.now();
          while (diaryAttempts.length && diaryAttempts[0] <= now - 60000) diaryAttempts.shift();
          if (diaryAttempts.length >= ROOM_DIARY_PER_MINUTE) throw failure('RATE_LIMITED');
          diaryAttempts.push(now);
          value = authority.roomDiary(await bodyOf(req, ['code'], 1024));
        } else throw failure('FORBIDDEN');
      } else if (route === '/v1/content') {
        if (grant.role !== 'capability' || req.method !== 'POST') throw failure('FORBIDDEN');
        if (!contentControl) throw failure('UNAVAILABLE');
        // The actions, their fields and which must carry a source message are the capability declarations'.
        const body = await bodyOf(req, CONTENT_FIELDS, 13 * 1024 * 1024);
        const declared = CONTENT_ACTIONS.find(row => row.action === body.action);
        if (!declared) throw failure('INVALID_REQUEST');
        if (declared.sourceRequired && typeof body.sourceEventId !== 'string') throw failure('INVALID_REQUEST');
        const scopeInput = { streamId: body.streamId, memoryEpoch: body.memoryEpoch, ...(body.sourceEventId === undefined ? {} : { sourceEventId: body.sourceEventId }) };
        let scope;
        try { scope = authority.contentScope(grant.capabilityId, scopeInput); }
        catch (error) {
          // An action whose source is only optional (none of its uses requires one) runs without a source it may not
          // use (forgotten, or not the bound person's own message): nothing is then filed under that message.
          const optional = declared.uses.some(use => use.source === 'optional') && !declared.uses.some(use => use.source === 'required');
          if (!optional || scopeInput.sourceEventId === undefined || error?.code !== 'FORBIDDEN') throw error;
          delete scopeInput.sourceEventId; delete body.sourceEventId;
          scope = authority.contentScope(grant.capabilityId, scopeInput);
        }
        value = await contentControl(scope, body);
        const current = authority.contentScope(grant.capabilityId, scopeInput);
        if (current.worldRevision !== scope.worldRevision || current.entityId !== scope.entityId || current.personId !== scope.personId || current.audience !== scope.audience) throw failure('CONFLICT');
      } else if (route.startsWith('/v1/maintenance/')) {
        if (grant.role !== 'maintenance' || req.method !== 'POST' || !SCHEMAS[route]) throw failure('FORBIDDEN');
        const body = await bodyOf(req, SCHEMAS[route], maxBodyBytes);
        if (route === '/v1/maintenance/consolidation/next') value = authority.consolidationNext(grant.entityId, body);
        // A commit may queue quoted facts: they are reviewed like any other proposal.
        else if (route === '/v1/maintenance/consolidation/commit') { value = authority.consolidationCommit(grant.entityId, body); schedule(); }
        else if (route === '/v1/maintenance/diary/next') value = authority.diaryNext(grant.entityId, body);
        else if (route === '/v1/maintenance/diary/commit') value = authority.diaryCommit(grant.entityId, body);
        else value = route === '/v1/maintenance/batch' ? authority.maintenanceBatch(grant.entityId, body) : authority.maintenanceDiary(grant.entityId, body);
      } else if (grant.role === 'maintenance') throw failure('FORBIDDEN');
      else if (req.method === 'GET' && route === '/v1/health') value = authority.health();
      else if (req.method === 'GET' && route === '/v1/admin/state') value = authority.snapshot();
      else if (grant.role === 'capability' && req.method === 'GET' && route.startsWith('/v1/receipts/')) {
        let id; try { id = decodeURIComponent(route.slice('/v1/receipts/'.length)); } catch { throw failure('INVALID_REQUEST'); }
        value = authority.getReceipt(grant.capabilityId, id);
        if (value === null) throw failure('NOT_FOUND');
      } else if (req.method === 'POST' && SCHEMAS[route]) {
        if (!route.startsWith('/v1/admin/') && grant.role !== 'capability') throw failure('FORBIDDEN');
        const body = await bodyOf(req, SCHEMAS[route], maxBodyBytes);
        if (route === '/v1/observations') value = authority.observe(grant.capabilityId, body);
        else if (route === '/v1/proposals') { value = authority.submit(grant.capabilityId, body); schedule(); }
        else if (route === '/v1/context') value = authority.context(grant.capabilityId, body);
        else if (route === '/v1/memory/search') value = authority.memorySearch(grant.capabilityId, body);
        else if (route === '/v1/memory/read') value = authority.memoryRead(grant.capabilityId, body);
        else if (route === '/v1/memory/recall') value = authority.memoryRecall(grant.capabilityId, body);
        else if (route === '/v1/people/admit') value = authority.admitPerson(grant.capabilityId, body);
        // The person of this conversation asked for their diary passcode: the bridge sends the answer itself.
        else if (route === '/v1/diary/code') value = authority.diaryCode(grant.capabilityId, body);
        // Forgetting: a channel's bridge or executor takes its part of a pending cleanup job and confirms it.
        else if (route === '/v1/cleanup/next') value = authority.cleanupNext(grant.capabilityId, body);
        else if (route === '/v1/cleanup/ack') value = authority.cleanupAck(grant.capabilityId, body);
        else if (route === '/v1/initiations/next') { value = authority.initiationNext(grant.capabilityId, body, await untoldJobs(grant)); await reportJobs(); }
        else if (route === '/v1/initiations/carry') { value = authority.initiationCarry(grant.capabilityId, body, await untoldJobs(grant)); await reportJobs(); }
        else if (route === '/v1/initiations/ack') { value = authority.initiationAck(grant.capabilityId, body); await reportJobs(); }
        // Her private wake-up: what she writes down for herself, from inside the wake-up that is out on this channel.
        else if (route === '/v1/self') value = authority.selfRecord(grant.capabilityId, body);
        else if (route === '/v1/admin/capabilities') value = authority.registerCapability(body);
        else if (route === '/v1/admin/actors') value = authority.bindActor(body);
        else if (route === '/v1/admin/streams') value = authority.bindStream(body);
        else if (route === '/v1/admin/persona') value = authority.revisePersona(body);
      } else throw failure('NOT_FOUND');
      send(res, 200, { ok: true, value });
    } catch (error) {
      const code = ERRORS[error?.code] ? error.code : error instanceof TypeError || error instanceof RangeError ? 'INVALID_REQUEST' : 'UNAVAILABLE';
      const [status, message] = ERRORS[code];
      req.resume();
      if (!res.headersSent) send(res, status, { ok: false, error: { code, message } });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  return {
    server,
    wakeReviewer: schedule,
    /** A cleanup job was just created (or may be waiting): ask the content service now. */
    wakeCleanup: forgetContent,
    async start() {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await recoverSocket(socketPath);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
      fs.chmodSync(socketPath, socketMode);
      schedule();
      if (contentForget) { forgetTimer = setInterval(() => { void forgetContent(); }, cleanupRetryMs); forgetTimer.unref(); void forgetContent(); }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(forgetTimer);
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
