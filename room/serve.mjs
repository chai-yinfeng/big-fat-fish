#!/usr/bin/env node
// The room page's server: this directory on loopback. Local preview, and in a release the companion-room unit
// (real mode on 127.0.0.1:4173; who may reach it from outside the host is the owner's `tailscale serve`, not this file).
//   node room/serve.mjs [port]      (default 4173; fake data)
//   node room/serve.mjs [port] --authority-socket /abs/api.sock --credential-file /abs/room.token
//     real mode: `GET /state` answers with the room state read from Authority's `GET /v1/room`. The two paths may
//     also come from ROOM_AUTHORITY_SOCKET and ROOM_CREDENTIAL_FILE. The credential stays in this process: it is
//     sent to the Unix socket only, and nothing this server answers contains it. A missing credential file is not
//     fatal: `/state` answers 503 until ops/prepare-room.mjs has run and Authority has been restarted.
//     Real mode also answers `POST /diary {code}`: the notebook. The passcode is handed to Authority's
//     `POST /v1/room/diary` with the same room credential, and what comes back is that one person's open diaries
//     (day and text) or one and the same 404 for every wrong passcode. Attempts are limited per client and overall.
import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateRoomState } from './state.js';

const root = fileURLToPath(new URL('./', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4' };

/** Passcode attempts on `POST /diary` in any one minute: from one client, and from everyone together (kept under
 * Authority's own limit, so this server answers 429 first). */
export const DIARY_LIMITS = Object.freeze({ perClient: 6, overall: 24, windowMs: 60000 });
/** The room credential: a private file holding the token, read on each call so a rotated one is picked up. Throws when unusable. */
function roomToken(credentialFile) {
  const stat = fs.statSync(credentialFile);
  if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0) throw new Error('Room credential unavailable');
  const token = fs.readFileSync(credentialFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Room credential unavailable');
  return token;
}
/** Reads one person's open diaries from Authority: `POST /v1/room/diary {code}` on its Unix socket with the room
 * credential. Resolves with `[{ day, text }]` (nothing else is passed on); rejects with an Error whose `status` is
 * 404 (not a passcode of anyone, whatever was wrong with it), 429 (Authority's limit) or 503 (unavailable). */
export function authorityDiaryReader({ socketPath, credentialFile, timeoutMs = 5000 }) {
  if (typeof socketPath !== 'string' || typeof credentialFile !== 'string' || !path.isAbsolute(socketPath) || !path.isAbsolute(credentialFile)) throw new Error('The Authority socket and the credential file are absolute paths');
  const failed = status => Object.assign(new Error('Diary unavailable'), { status });
  return code => new Promise((resolve, reject) => {
    let token;
    try { token = roomToken(credentialFile); } catch { reject(failed(503)); return; }
    const body = Buffer.from(JSON.stringify({ code: String(code) }));
    const req = http.request({ socketPath, path: '/v1/room/diary', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': body.length } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 131072) { res.destroy(); reject(failed(503)); } else chunks.push(chunk); });
      res.on('error', () => reject(failed(503)));
      res.on('end', () => {
        if (res.statusCode === 404 || res.statusCode === 429) { reject(failed(res.statusCode)); return; }
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || envelope.ok !== true || !Array.isArray(envelope.value?.diaries) || envelope.value.diaries.length > 40) throw failed(503);
          resolve(envelope.value.diaries.map(entry => {
            if (typeof entry?.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) || typeof entry.text !== 'string' || !entry.text || entry.text.length > 600) throw failed(503);
            return { day: entry.day, text: entry.text };
          }));
        } catch { reject(failed(503)); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(failed(503)); }, timeoutMs);
    req.on('close', () => clearTimeout(timer)); req.on('error', () => reject(failed(503)));
    req.end(body);
  });
}

/** Reads the room state from Authority: `GET /v1/room` on its Unix socket with the room credential (a private file
 * holding the token, read on each call so a rotated one is picked up). The answer is held to the contract and kept
 * for `cacheMs`, so the number of viewers does not multiply the reads. Rejects with no detail when unavailable. */
export function authorityReader({ socketPath, credentialFile, cacheMs = 5000, timeoutMs = 5000 }) {
  if (typeof socketPath !== 'string' || typeof credentialFile !== 'string' || !path.isAbsolute(socketPath) || !path.isAbsolute(credentialFile)) throw new Error('The Authority socket and the credential file are absolute paths');
  const unavailable = () => new Error('Room state unavailable');
  let cached = null, cachedAt = 0, pending = null;
  const read = () => new Promise((resolve, reject) => {
    let token;
    try { token = roomToken(credentialFile); } catch { reject(unavailable()); return; }
    const req = http.request({ socketPath, path: '/v1/room', method: 'GET', agent: false, headers: { authorization: 'Bearer ' + token } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) { res.destroy(); reject(unavailable()); } else chunks.push(chunk); });
      res.on('error', () => reject(unavailable()));
      res.on('end', () => {
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || envelope.ok !== true || envelope.value?.source !== 'authority') throw unavailable();
          resolve(validateRoomState(envelope.value));
        } catch { reject(unavailable()); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(unavailable()); }, timeoutMs);
    req.on('close', () => clearTimeout(timer)); req.on('error', () => reject(unavailable()));
    req.end();
  });
  return () => {
    if (cached && Date.now() - cachedAt < cacheMs) return Promise.resolve(cached);
    pending ??= read().then(state => { cached = state; cachedAt = Date.now(); return state; }).finally(() => { pending = null; });
    return pending;
  };
}

/** The preview server. `live` (optional) is an async function returning a room state: with it `GET /state` exists.
 * `diary` (optional) is an async function from a passcode to that person's open diaries (authorityDiaryReader):
 * with it `POST /diary` exists. `clock` is for tests of the attempt limit. */
export function createRoomServer({ live, diary, clock = Date.now } = {}) {
  const json = { 'content-type': TYPES['.json'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  const attempts = [];
  /** Who is asking, for the per-client limit: behind the owner's `tailscale serve` (a loopback connection) the
   * address it reports, otherwise the connection's own. A made-up header only moves a caller between per-client
   * buckets; the overall limit counts everyone. */
  const client = req => {
    const remote = req.socket.remoteAddress ?? '', forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
    return (/^(127\.|::1$|::ffff:127\.)/.test(remote) && forwarded ? forwarded : remote).slice(0, 64);
  };
  return http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
      if (diary && req.method === 'POST' && name === 'diary') {
        const now = clock(), who = client(req);
        while (attempts.length && attempts[0].at <= now - DIARY_LIMITS.windowMs) attempts.shift();
        // Every attempt counts, right or wrong; over a limit nothing is read and Authority is not asked.
        if (attempts.length >= DIARY_LIMITS.overall || attempts.filter(item => item.who === who).length >= DIARY_LIMITS.perClient) { res.writeHead(429, json).end('{}'); return; }
        attempts.push({ at: now, who });
        let status = 404, diaries = null;
        try {
          if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw Object.assign(new Error('Not JSON'), { status: 404 });
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) throw Object.assign(new Error('Too large'), { status: 404 }); chunks.push(chunk); }
          let code; try { code = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.code; } catch {}
          if (typeof code !== 'string' || code.length > 64) throw Object.assign(new Error('No passcode'), { status: 404 });
          diaries = await diary(code); status = 200;
        } catch (error) { status = [404, 429].includes(error?.status) ? error.status : 503; }
        // A wrong passcode, a malformed request and a passcode of nobody are the same empty 404.
        res.writeHead(status, json).end(JSON.stringify(status === 200 ? { diaries } : {}));
        return;
      }
      if (live && req.method === 'GET' && name === 'state') {
        let state = null;
        try { state = validateRoomState(await live()); } catch {}
        res.writeHead(state ? 200 : 503, { 'content-type': TYPES['.json'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(state ?? {}));
        return;
      }
      const file = path.join(root, name), type = TYPES[path.extname(file).toLowerCase()];
      if (req.method !== 'GET' || !type || !file.startsWith(root) || name.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = () => { console.error('Usage: node room/serve.mjs [port 1024-65535] [--authority-socket /abs/path --credential-file /abs/path]'); process.exit(2); };
  let parsed;
  try { parsed = parseArgs({ allowPositionals: true, options: { 'authority-socket': { type: 'string' }, 'credential-file': { type: 'string' } } }); } catch { usage(); }
  const port = Number(parsed.positionals[0] ?? 4173);
  const socketPath = parsed.values['authority-socket'] ?? process.env.ROOM_AUTHORITY_SOCKET, credentialFile = parsed.values['credential-file'] ?? process.env.ROOM_CREDENTIAL_FILE;
  if (parsed.positionals.length > 1 || !Number.isInteger(port) || port < 1024 || port > 65535 || Boolean(socketPath) !== Boolean(credentialFile)) usage();
  let live, diary;
  try { live = socketPath ? authorityReader({ socketPath, credentialFile }) : undefined; diary = socketPath ? authorityDiaryReader({ socketPath, credentialFile }) : undefined; } catch { usage(); }
  // Loopback only, in both modes: who else may see the room is decided outside (tailscale serve), never here.
  createRoomServer({ live, diary }).listen(port, '127.0.0.1', () => console.log(`room page (${live ? 'real data from Authority' : 'fake data'}): http://127.0.0.1:${port}/`));
}
