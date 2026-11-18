#!/usr/bin/env node
// Development preview only: serves this directory on loopback. Not part of any release, unit or deploy step.
//   node room/serve.mjs [port]      (default 4173)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4' };
const port = Number(process.argv[2] ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Usage: node room/serve.mjs [port 1024-65535]'); process.exit(2); }

http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, name), type = TYPES[path.extname(file).toLowerCase()];
    if (req.method !== 'GET' || !type || !file.startsWith(root) || name.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`room preview: http://127.0.0.1:${port}/`));
