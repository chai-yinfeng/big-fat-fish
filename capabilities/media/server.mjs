import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

const failure = code => Object.assign(new Error(code), { code });
async function recover(socketPath) {
  let previous; try { previous = fs.lstatSync(socketPath); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!previous.isSocket()) throw failure('CONTENT_SOCKET_CONFLICT');
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); reject(failure('CONTENT_WRITER_ACTIVE')); });
    probe.once('error', error => {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') { reject(failure('CONTENT_SOCKET_CONFLICT')); return; }
      if (fs.existsSync(socketPath)) { const current = fs.lstatSync(socketPath); if (!current.isSocket() || current.ino !== previous.ino || !path.isAbsolute(socketPath)) { reject(failure('CONTENT_SOCKET_CONFLICT')); return; } fs.unlinkSync(socketPath); }
      resolve();
    });
  });
}
async function bodyOf(req, limit = 13 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw failure('CONTENT_REQUEST_LIMIT'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('CONTENT_REQUEST_INVALID');
  return value;
}
export function createContentServer({ socketPath, tokenFile, service, worldStatus, operatorCall }) {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenFile)) throw failure('CONTENT_CONFIG');
  const digest = value => createHash('sha256').update(value).digest();
  const credential = digest(fs.readFileSync(tokenFile, 'utf8').trim()), active = new Set();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); } };
    let timer, controller;
    const isOperator = req.url === '/operator';
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
      if (!match || !timingSafeEqual(credential, digest(match[1]))) { send(401, { ok: false, error: { code: 'CONTENT_AUTH_REQUIRED' } }); return; }
      if (req.method !== 'POST' || !['/content', '/operator'].includes(req.url) || req.headers['content-type']?.split(';')[0] !== 'application/json') throw failure('CONTENT_REQUEST_INVALID');
      const body = await bodyOf(req, isOperator ? 3 * 1024 * 1024 : 13 * 1024 * 1024);
      if (isOperator) {
        if (typeof operatorCall !== 'function') throw failure('CONTENT_OPERATOR_UNAVAILABLE');
        if (!['status', 'configure', 'reference', 'test', 'removeReference'].includes(body.action)) throw failure('CONTENT_REQUEST_INVALID');
        if (active.size >= 8) throw failure('CONTENT_BUSY');
        const changing = body.action !== 'status';
        const validWorld = world => world.paused === true && Number.isSafeInteger(body.worldRevision) && world.revision === body.worldRevision;
        if (changing && !validWorld(await worldStatus())) throw Object.assign(failure('CONTENT_OPERATOR_WORLD_CONFLICT'), { statusCode: 409 });
        controller = new AbortController(); active.add(controller);
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        let checking = false;
        if (changing) timer = setInterval(async () => { if (checking) return; checking = true; try { if (!validWorld(await worldStatus())) controller.abort(); } catch { controller.abort(); } finally { checking = false; } }, 1000);
        const result = await operatorCall(body, { signal: controller.signal });
        if (changing && (controller.signal.aborted || !validWorld(await worldStatus()))) throw Object.assign(failure('CONTENT_OPERATOR_WORLD_CONFLICT'), { statusCode: 409 });
        if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw failure('CONTENT_OPERATOR_RESPONSE_LIMIT');
        send(200, { ok: true, value: result }); return;
      }
      const { scope, input } = body;
      if (!scope || !Number.isSafeInteger(scope.memoryEpoch) || !Number.isSafeInteger(scope.worldRevision) || typeof scope.entityId !== 'string' || typeof scope.streamId !== 'string' || !input || Object.keys(body).some(k => !['scope', 'input'].includes(k))) throw failure('CONTENT_REQUEST_INVALID');
      if (active.size >= 8) throw failure('CONTENT_BUSY');
      const current = await worldStatus();
      if (current.paused || current.revision !== scope.worldRevision) throw failure('CONTENT_PAUSED');
      controller = new AbortController(); active.add(controller);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      let checking = false;
      timer = setInterval(async () => { if (checking) return; checking = true; try { const w = await worldStatus(); if (w.paused || w.revision !== scope.worldRevision) controller.abort(); } catch { controller.abort(); } finally { checking = false; } }, 1000);
      const result = await service.call(scope, { ...input, signal: controller.signal });
      const after = await worldStatus();
      if (controller.signal.aborted || after.paused || after.revision !== scope.worldRevision) throw failure('CONTENT_PAUSED');
      send(200, { ok: true, value: result });
    } catch (error) {
      const code = /^(?:MEDIA|SPEECH|CONTENT)_[A-Z_]{1,50}$/.test(error?.code || '') ? error.code : 'CONTENT_UNAVAILABLE';
      const status = isOperator ? (error instanceof SyntaxError || code === 'CONTENT_REQUEST_INVALID' ? 400 : code === 'CONTENT_REQUEST_LIMIT' ? 413 : [400, 409, 413, 503].includes(error.statusCode) ? error.statusCode : 503) : code === 'CONTENT_REQUEST_INVALID' ? 400 : 503;
      send(status, { ok: false, error: { code: isOperator && error instanceof SyntaxError ? 'CONTENT_REQUEST_INVALID' : code } });
    } finally { clearInterval(timer); if (controller) active.delete(controller); req.resume(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 16;
  return {
    async start() { fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }); await recover(socketPath); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); fs.chmodSync(socketPath, 0o600); },
    async close() { for (const c of active) c.abort(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
