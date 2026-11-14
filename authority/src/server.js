import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

const SCHEMAS = {
  '/v1/observations': ['eventId', 'streamId', 'actorId', 'role', 'text', 'at', 'origin'],
  '/v1/proposals': ['proposalId', 'observationId', 'type', 'payload'],
  '/v1/context': ['streamId', 'query', 'budgetChars', 'exclude', 'profile', 'windowFromAt'],
  '/v1/admin/capabilities': ['id', 'policy'],
  '/v1/admin/actors': ['capabilityId', 'externalActorId', 'personId'],
  '/v1/admin/streams': ['capabilityId', 'streamId', 'personId', 'audience', 'entityId'],
  '/v1/admin/persona': ['entityId', 'expectedRevision', 'patch', 'reason'],
  '/v1/memory/search': ['streamId', 'query', 'limit', 'budgetChars'],
  '/v1/memory/read': ['streamId', 'id'],
  '/v1/memory/recall': ['streamId', 'fromAt', 'toAt', 'limit', 'budgetChars'],
  '/v1/people/admit': ['uid'],
  '/v1/initiations/next': [],
  '/v1/initiations/ack': ['id', 'outcome'],
  '/v1/initiations/carry': ['streamId'],
  '/v1/maintenance/batch': ['afterRevision', 'limit', 'mode'],
  '/v1/maintenance/diary': ['taskId', 'kind', 'text', 'sourceIds'],
  '/v1/maintenance/consolidation/next': [],
  '/v1/maintenance/consolidation/commit': ['taskId', 'outcome', 'digest', 'facts'],
};
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
export function createAuthorityServer({ authority, socketPath, credentials, contentControl, contentJobs, maxBodyBytes = 32768, socketMode = 0o600, batchSize = 32, onFatal = () => {} }) {
  if (!path.isAbsolute(socketPath) || !Array.isArray(credentials) || credentials.length === 0) throw new Error('Explicit socket and credentials are required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 65536) throw new Error('Invalid protocol body limit');
  if (![0o600, 0o660].includes(socketMode)) throw new Error('Socket mode must be private or explicitly group-scoped');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error('Invalid review batch size');
  const seen = new Set();
  const grants = credentials.map(record => {
    if (!/^[a-f0-9]{64}$/.test(record.hash) || seen.has(record.hash) || !['admin', 'capability', 'maintenance'].includes(record.role) || (record.role === 'capability' && (typeof record.capabilityId !== 'string' || !record.capabilityId)) || (record.role === 'maintenance' && (typeof record.entityId !== 'string' || !record.entityId))) throw new Error('Invalid authority credential configuration');
    seen.add(record.hash);
    return { ...record, bytes: Buffer.from(record.hash, 'hex') };
  });
  let closed = false, scheduled = false, unhealthy = false;
  // Finished background jobs nobody was told about, as the content service lists them. Authority asks with its own
  // control credential; the content service never calls here. Unreachable means none this round.
  const untoldJobs = async grant => {
    if (!contentJobs || grant.capabilityId !== 'qq') return [];
    try { const value = await contentJobs({ action: 'pending' }); return Array.isArray(value?.jobs) ? value.jobs : []; } catch { return []; }
  };
  // What Authority decided about those jobs goes back before the caller hears of it. A report that fails is made
  // again when the job is next listed; Authority's own record already forbids a second telling.
  const reportJobs = async () => { for (const notice of authority.drainJobNotices()) { try { await contentJobs?.({ action: 'notice', ...notice }); } catch {} } };
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
      if (route === '/v1/content') {
        if (grant.role !== 'capability' || req.method !== 'POST') throw failure('FORBIDDEN');
        if (!contentControl) throw failure('UNAVAILABLE');
        const body = await bodyOf(req, ['action', 'streamId', 'memoryEpoch', 'sourceEventId', 'requestId', 'kind', 'data', 'ref', 'quality', 'voiceProfile', 'question', 'text', 'query', 'url', 'sticker', 'name'], 13 * 1024 * 1024);
        if (!['ingest', 'transcribe', 'describe', 'synthesize', 'asset', 'attach', 'pending', 'search', 'fetch', 'jobResult'].includes(body.action)) throw failure('INVALID_REQUEST');
        if (['ingest', 'synthesize'].includes(body.action) && typeof body.sourceEventId !== 'string') throw failure('INVALID_REQUEST');
        const scopeInput = { streamId: body.streamId, memoryEpoch: body.memoryEpoch, ...(body.sourceEventId === undefined ? {} : { sourceEventId: body.sourceEventId }) };
        const scope = authority.contentScope(grant.capabilityId, scopeInput);
        value = await contentControl(scope, body);
        const current = authority.contentScope(grant.capabilityId, scopeInput);
        if (current.worldRevision !== scope.worldRevision || current.entityId !== scope.entityId || current.personId !== scope.personId || current.audience !== scope.audience) throw failure('CONFLICT');
      } else if (route.startsWith('/v1/maintenance/')) {
        if (grant.role !== 'maintenance' || req.method !== 'POST' || !SCHEMAS[route]) throw failure('FORBIDDEN');
        const body = await bodyOf(req, SCHEMAS[route], maxBodyBytes);
        if (route === '/v1/maintenance/consolidation/next') value = authority.consolidationNext(grant.entityId, body);
        // A commit may queue quoted facts: they are reviewed like any other proposal.
        else if (route === '/v1/maintenance/consolidation/commit') { value = authority.consolidationCommit(grant.entityId, body); schedule(); }
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
        else if (route === '/v1/initiations/next') { value = authority.initiationNext(grant.capabilityId, body, await untoldJobs(grant)); await reportJobs(); }
        else if (route === '/v1/initiations/carry') { value = authority.initiationCarry(grant.capabilityId, body, await untoldJobs(grant)); await reportJobs(); }
        else if (route === '/v1/initiations/ack') { value = authority.initiationAck(grant.capabilityId, body); await reportJobs(); }
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
    async start() {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await recoverSocket(socketPath);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
      fs.chmodSync(socketPath, socketMode);
      schedule();
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
