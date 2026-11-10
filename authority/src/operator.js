import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_PERSONA } from '../../core/src/persona.js';

function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Object.assign(new Error('Invalid operation'), { statusCode: 400, code: 'INVALID_REQUEST' });
  return value;
}
async function json(req, limit = 98304) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw Object.assign(new Error('Request too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400, code: 'INVALID_REQUEST' }); }
}

/** Human control plane. Its socket/token are never mounted to the model worker. */
export function createOperatorServer({ authority, socketPath, tokenHash, origins, modelControl, qqControl, contentOperator, assetsDir, onResume = () => {} }) {
  if (!path.isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(tokenHash) || !Array.isArray(origins)) throw new Error('Invalid operator configuration');
  const expected = Buffer.from(tokenHash, 'hex');
  async function overview(authorization) {
    const state = authority.snapshot();
    const bindings = state.streams.map(row => ({ sourceId: row.capabilityId, conversationId: row.streamId, entityId: row.entityId, personId: row.personId, audience: row.audience }));
    const qq = qqControl ? await qqControl('/qq', undefined, authorization).catch(() => null) : undefined;
    return {
      world: authority.worldStatus(), persona: { revision: state.personaRevision, value: state.persona, default: DEFAULT_PERSONA },
      counts: { facts: state.facts.length, notes: state.notes.length, experiences: state.experiences.length, pending: authority.health().pending },
      channels: [
        { id: 'qq', name: 'QQ', status: qq === null ? 'error' : !qq ? 'not_configured' : !qq.loggedIn ? 'waiting_login' : !qq.configured ? 'not_configured' : qq.connected ? 'ready' : 'disconnected', enabled: Boolean(qq?.configured && qq.loggedIn && qq.connected), boundStreams: bindings.filter(row => row.sourceId === 'qq').length },
      ], bindings, model: modelControl ? await modelControl('/model', undefined, authorization) : { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' },
      // Today's spend (Beijing day) from the model gateway; null when unavailable.
      spend: modelControl ? await modelControl('/spend', undefined, authorization).catch(() => null) : null,
    };
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const contentAbort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) contentAbort.abort(); });
    const origin = req.headers.origin;
    const allowedOrigin = !origin || origins.includes(origin);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(origin && allowedOrigin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) };
    const respond = (status, value) => { res.writeHead(status, headers); res.end(JSON.stringify(value)); };
    try {
      if (!allowedOrigin) { respond(403, { ok: false, error: { code: 'ORIGIN_DENIED', message: 'This console origin is not allowed' } }); return; }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' }); res.end(); return;
      }
      const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      if (assetsDir && ['GET', 'HEAD'].includes(req.method) && Object.hasOwn(staticFiles, req.url)) {
        const [name, mime] = staticFiles[req.url], root = fs.realpathSync(assetsDir), file = path.join(root, name);
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) { respond(404, { ok: false }); return; }
        const bytes = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
      if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), expected)) { respond(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Operator access is required' } }); return; }
      const url = new URL(req.url, 'http://operator.invalid');
      if (req.method === 'GET' && url.pathname === '/memory/status') { respond(200, { ok: true, value: authority.memoryStatus() }); return; }
      if (req.method === 'GET' && url.pathname === '/entities') { respond(200, { ok: true, value: authority.listEntities() }); return; }
      if (req.method === 'GET' && url.pathname === '/memory') {
        const input = {};
        if (url.searchParams.has('entityId')) input.entityId = url.searchParams.get('entityId');
        if (url.searchParams.has('limit')) input.limit = Number(url.searchParams.get('limit'));
        if (url.searchParams.has('beforeRevision')) input.beforeRevision = Number(url.searchParams.get('beforeRevision'));
        respond(200, { ok: true, value: authority.listMemory(input) }); return;
      }
      // Read-only: what context() injected lately (IDs and sizes; kept in memory, cleared by a restart).
      if (req.method === 'GET' && url.pathname === '/memory/trace') {
        const input = {};
        if (url.searchParams.has('person')) input.person = url.searchParams.get('person');
        if (url.searchParams.has('limit')) input.limit = Number(url.searchParams.get('limit'));
        respond(200, { ok: true, value: authority.contextTrace(input) }); return;
      }
      if (req.method === 'GET' && req.url === '/memory/cleanup/pending') { respond(200, { ok: true, value: authority.cleanupPending() }); return; }
      if (req.method === 'GET' && req.url === '/world') { respond(200, { ok: true, value: await overview(req.headers.authorization) }); return; }
      if (req.method === 'GET' && req.url === '/people') {
        const qq = qqControl ? await qqControl('/qq/people', undefined, req.headers.authorization).catch(() => null) : null;
        respond(200, { ok: true, value: { ...authority.listPeople(), qq } }); return;
      }
      if (req.method === 'GET' && req.url === '/conversations') { respond(200, { ok: true, value: authority.listConversations() }); return; }
      if (req.method === 'GET' && req.url === '/spend') {
        if (!modelControl) throw Object.assign(new Error('Model unavailable'), { statusCode: 503 });
        respond(200, { ok: true, value: await modelControl('/spend', undefined, req.headers.authorization) }); return;
      }
      if (req.method === 'GET' && req.url === '/qq' && qqControl) { respond(200, { ok: true, value: await qqControl('/qq', undefined, req.headers.authorization) }); return; }
      if (req.method === 'GET' && req.url === '/runtime') {
        if (!contentOperator) throw Object.assign(new Error('Content runtime unavailable'), { statusCode: 503 });
        respond(200, { ok: true, value: await contentOperator('status', {}, { signal: contentAbort.signal }) }); return;
      }
      if (req.method !== 'POST') { respond(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown console operation' } }); return; }
      const body = await json(req, req.url === '/voice/reference' ? 3 * 1024 * 1024 : 98304);
      let value;
      const contentActions = {
        '/speech': ['configure', ['expectedRevision', 'numThreads', 'maxTextChars']],
        '/voice/reference': ['reference', ['expectedRevision', 'voiceId', 'label', 'language', 'usageScope', 'audioBase64', 'transcript', 'authorized']],
        '/voice/reference/remove': ['removeReference', ['expectedRevision', 'voiceId', 'confirmed']],
        '/voice/default': ['setDefaultVoice', ['expectedRevision', 'voiceId']],
        '/voice/test': ['test', ['voiceId']],
      };
      if (Object.hasOwn(contentActions, req.url)) {
        if (!contentOperator) throw Object.assign(new Error('Content runtime unavailable'), { statusCode: 503 });
        const world = authority.worldStatus();
        if (!world.paused) throw Object.assign(new Error('Pause before changing voice runtime'), { statusCode: 409, code: 'CONFLICT' });
        const [action, fields] = contentActions[req.url]; object(body, fields);
        value = await contentOperator(action, { ...body, worldRevision: world.revision }, { signal: contentAbort.signal });
        const current = authority.worldStatus();
        if (!current.paused || current.revision !== world.revision) throw Object.assign(new Error('World changed during operation'), { statusCode: 409, code: 'CONFLICT' });
        respond(200, { ok: true, value }); return;
      }
      const memoryActions = {
        '/entities': 'createEntity', '/memory/forget-preview': 'forgetPreview', '/memory/forget': 'forgetApply',
        '/memory/cleanup/complete': 'cleanupComplete', '/memory/retention': 'setMemoryRetention',
        '/memory/public': 'markMemoryPublic', '/diary/private': 'writePrivateDiary',
        '/diary/draft': 'savePublicDiaryDraft', '/diary/publish': 'publishDiary',
      };
      if (Object.hasOwn(memoryActions, req.url)) value = authority[memoryActions[req.url]](body);
      else if (req.url === '/world/pause') {
        object(body, ['paused', 'expectedRevision']);
        if (body.paused === false && authority.cleanupPending().length) throw Object.assign(new Error('Complete controlled cleanup before resuming'), { statusCode: 409, code: 'CONFLICT' });
        value = authority.setWorldPaused(body);
        if (!value.paused) onResume();
        else if (modelControl) await modelControl('/cancel', {}, req.headers.authorization);
      } else if (req.url === '/spend/settings') {
        object(body, ['dailyCapYuan', 'reducedPercent', 'restrictedPercent']);
        if (!modelControl) throw Object.assign(new Error('Model unavailable'), { statusCode: 503 });
        value = await modelControl('/spend/settings', body, req.headers.authorization);
      } else if (req.url === '/model' || req.url === '/model/test') {
        object(body, req.url === '/model' ? ['model', 'apiKey'] : []);
        if (!modelControl) throw Object.assign(new Error('Model unavailable'), { statusCode: 503 });
        value = await modelControl(req.url, body, req.headers.authorization);
      } else if (req.url === '/qq') {
        object(body, ['allowedCallerUID']);
        if (!qqControl) throw Object.assign(new Error('QQ unavailable'), { statusCode: 503 });
        if (!authority.worldStatus().paused || typeof body.allowedCallerUID !== 'string' || !/^[1-9]\d{0,19}$/.test(body.allowedCallerUID)) throw Object.assign(new Error('QQ configuration requires pause'), { statusCode: 409 });
        const { expectedSelfId } = await qqControl('/qq/identity', undefined, req.headers.authorization);
        if (!/^[1-9]\d{0,19}$/.test(expectedSelfId || '') || expectedSelfId === body.allowedCallerUID) throw Object.assign(new Error('Complete bot login and use a different caller'), { statusCode: 409 });
        authority.bindActor({ capabilityId: 'qq', externalActorId: `qq:${expectedSelfId}:user:${body.allowedCallerUID}`, personId: 'person:owner' });
        authority.bindStream({ capabilityId: 'qq', streamId: `qq:${expectedSelfId}:private:${body.allowedCallerUID}`, personId: 'person:owner', audience: 'private' });
        value = await qqControl('/qq', { expectedSelfId, allowedCallerUID: body.allowedCallerUID }, req.headers.authorization);
      } else if (req.url === '/persona' || req.url === '/persona/preview') {
        object(body, req.url === '/persona' ? ['entityId', 'expectedRevision', 'patch'] : ['entityId', 'patch']);
        object(body.patch, Object.keys(DEFAULT_PERSONA));
        value = req.url === '/persona' ? authority.revisePersona({ ...body, reason: 'Explicit world console edit' }) : authority.previewPersona(body);
      } else { respond(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown console operation' } }); return; }
      respond(200, { ok: true, value });
    } catch (error) {
      const status = [400, 403, 409, 413, 503].includes(error.statusCode) ? error.statusCode : 500;
      respond(status, { ok: false, error: { code: ['VALIDATION_ERROR', 'CONFLICT', 'INVALID_REQUEST', 'BODY_TOO_LARGE'].includes(error.code) ? error.code : 'OPERATION_FAILED', message: status === 409 ? 'State changed; refresh before saving' : status === 400 ? 'The operation does not match the field requirements' : 'The operator operation failed' } });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  return {
    server,
    async start() {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(socketPath)) {
        if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Refusing non-socket operator target');
        // Authority's exclusive DB lease has already ruled out another writer.
        fs.unlinkSync(socketPath);
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
      fs.chmodSync(socketPath, 0o600);
    },
    async close() { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
