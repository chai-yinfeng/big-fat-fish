#!/usr/bin/env node
// Development preview only: serves this directory on loopback. Not part of any release, unit or deploy step.
//   node room/serve.mjs [port]      (default 4173; fake data)
//   node room/serve.mjs [port] --authority-socket /abs/api.sock --credential-file /abs/room.token
//     real mode: `GET /state` answers with the room state read from Authority's `GET /v1/room`. The two paths may
//     also come from ROOM_AUTHORITY_SOCKET and ROOM_CREDENTIAL_FILE. The credential stays in this process: it is
//     sent to the Unix socket only, and nothing this server answers contains it.
import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateRoomState } from './state.js';

const root = fileURLToPath(new URL('./', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4' };

/** Reads the room state from Authority: `GET /v1/room` on its Unix socket with the room credential (a private file
 * holding the token, read on each call so a rotated one is picked up). The answer is held to the contract and kept
 * for `cacheMs`, so the number of viewers does not multiply the reads. Rejects with no detail when unavailable. */
export function authorityReader({ socketPath, credentialFile, cacheMs = 5000, timeoutMs = 5000 }) {
  if (typeof socketPath !== 'string' || typeof credentialFile !== 'string' || !path.isAbsolute(socketPath) || !path.isAbsolute(credentialFile)) throw new Error('The Authority socket and the credential file are absolute paths');
  const unavailable = () => new Error('Room state unavailable');
  let cached = null, cachedAt = 0, pending = null;
  const read = () => new Promise((resolve, reject) => {
    let token;
    try {
      const stat = fs.statSync(credentialFile);
      if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0) throw unavailable();
      token = fs.readFileSync(credentialFile, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw unavailable();
    } catch { reject(unavailable()); return; }
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

/** The preview server. `live` (optional) is an async function returning a room state: with it `GET /state` exists. */
export function createRoomServer({ live } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
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
  let live;
  try { live = socketPath ? authorityReader({ socketPath, credentialFile }) : undefined; } catch { usage(); }
  // Loopback only, in both modes: who else may see the room, and through what, is not decided here.
  createRoomServer({ live }).listen(port, '127.0.0.1', () => console.log(`room preview (${live ? 'real data from Authority' : 'fake data'}): http://127.0.0.1:${port}/`));
}
