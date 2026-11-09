import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const STATUS = { BUDGET_EXHAUSTED: 429, INVALID_EXECUTION_REQUEST: 400, WORLD_PAUSED: 409, EXECUTION_EPOCH_RETIRED: 409, AUTHORITY_BINDING_REQUIRED: 403, EXECUTION_TIMEOUT: 504 };
const CODES = new Set(['INVALID_EXECUTION_REQUEST', 'WORLD_PAUSED', 'EXECUTION_EPOCH_RETIRED', 'AUTHORITY_BINDING_REQUIRED', 'CONTEXT_UNAVAILABLE', 'ACTIVE_CONTEXT_LIMIT', 'TOOL_LOOP_LIMIT', 'REAL_USER_INPUT_REQUIRED', 'EXECUTION_TIMEOUT', 'EXECUTION_CANCELLED', 'MODEL_UNAVAILABLE', 'EMPTY_REPLY', 'SESSION_CORRUPT', 'SESSION_UNAVAILABLE', 'BUDGET_EXHAUSTED']);
const MAX_BODY_BYTES = 256 * 1024;

async function recoverSocket(socketPath) {
  let stat;
  try { stat = fs.lstatSync(socketPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSocket()) throw fail('CONVERSATION_SOCKET');
  await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); reject(fail('CONVERSATION_ALREADY_RUNNING')); });
    socket.once('error', error => {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) { reject(error); return; }
      try { const current = fs.lstatSync(socketPath); if (current.isSocket() && current.ino === stat.ino) fs.unlinkSync(socketPath); } catch (cause) { if (cause.code !== 'ENOENT') { reject(cause); return; } }
      resolve();
    });
  });
}

/** Private UDS face: only POST /execute from a caller holding the configured bearer. */
export function createConversationServer({ socketPath, callerTokenHash, executor }) {
  if (!path.isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(callerTokenHash)) throw fail('CONVERSATION_CONFIG');
  const expected = Buffer.from(callerTokenHash, 'hex');
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status, value) => { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const controller = new AbortController();
    // Caller disconnect cancels the run (the request has been read by then).
    res.on('close', () => { if (!res.writableEnded) controller.abort(fail('EXECUTION_CANCELLED')); });
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
      if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), expected)) { req.resume(); send(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }); return; }
      if (req.method !== 'POST' || req.url !== '/execute') { req.resume(); send(404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }
      if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw fail('INVALID_EXECUTION_REQUEST');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw fail('INVALID_EXECUTION_REQUEST'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_EXECUTION_REQUEST'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['scope', 'requestId', 'input', 'timeoutMs'].includes(key))) throw fail('INVALID_EXECUTION_REQUEST');
      const text = await executor.execute(body, { signal: controller.signal });
      send(200, { ok: true, value: { text } });
    } catch (error) {
      const code = CODES.has(error?.code) ? error.code : 'EXECUTION_FAILED';
      send(STATUS[code] || 502, { ok: false, error: { code } });
    }
  });
  server.headersTimeout = 5000; server.requestTimeout = 0; server.keepAliveTimeout = 1000; server.maxConnections = 32;
  return {
    server,
    async start() {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await recoverSocket(socketPath);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
      fs.chmodSync(socketPath, 0o600);
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
