// Test-only fixtures: real Unix-socket HTTP servers standing in for Authority and
// the model gateway. No network, no provider and no real credentials are used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export function tempRoot(t, prefix = 'fish-conv-') {
  // Short base: Unix socket paths are limited to ~104 bytes on macOS.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
export function tokenFile(root, name) {
  const token = randomBytes(32).toString('base64url'), file = path.join(root, name);
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return { token, file };
}
async function listen(t, socketPath, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}
async function readJson(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** Fake Authority capability API. `state` is mutable by the test. */
export async function fakeAuthority(t, root) {
  const credential = tokenFile(root, 'authority.token'), socketPath = path.join(root, 'authority.sock');
  const state = {
    paused: false, epoch: 0, entityId: 'entity:test', text: '[人格]\n大肥鱼', memory: '', memoryIds: [], profile: '', revision: 3, personaRevision: 2, worldNow: Date.parse('2026-11-01T00:00:00Z'),
    requests: [], search: () => ({ items: [], text: '' }), content: body => ({ ok: true, action: body.action }), receipts: {},
  };
  await listen(t, socketPath, async (req, res) => {
    const body = await readJson(req);
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { ok: true, value } : { ok: false, error: { code: 'X', message: 'x' } })); };
    if (req.headers.authorization !== 'Bearer ' + credential.token) { send(401); return; }
    state.requests.push({ route: req.url, body });
    if (req.url === '/v1/context') send(200, { revision: state.revision, entityId: state.entityId, memoryEpoch: state.epoch, personaRevision: state.personaRevision, text: state.text + (state.memory && '\n\n' + state.memory), personaText: state.text, memoryText: state.memory, memoryIds: state.memoryIds, profileText: state.profile, scope: { audience: 'private' }, world: { paused: state.paused, revision: 1, worldNow: state.worldNow } });
    else if (req.url === '/v1/memory/search') send(200, state.search(body));
    else if (req.url === '/v1/proposals') send(200, { proposalId: body.proposalId, status: 'pending' });
    else if (req.url.startsWith('/v1/receipts/')) { const id = decodeURIComponent(req.url.slice(13)); state.receipts[id] ? send(200, state.receipts[id]) : send(404); }
    else if (req.url === '/v1/content') send(200, state.content(body));
    else send(404);
  });
  return { state, config: { socketPath, tokenFile: credential.file } };
}

export const chunk = (delta, finish = null, extra = {}) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
export const reply = (text, reasoning) => [...(reasoning ? [chunk({ role: 'assistant', reasoning_content: reasoning })] : []), chunk({ content: text }), chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })];
export const toolCall = (name, args, reasoning, id = 'call_1') => [...(reasoning ? [chunk({ role: 'assistant', reasoning_content: reasoning })] : []), chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls')];

/** Fake model gateway on its inference socket. Each request consumes one scripted step:
 * an array of SSE chunks, or 'hang' (never answers until the client disconnects). */
export async function fakeGateway(t, root) {
  const credential = tokenFile(root, 'gateway.token'), socketPath = path.join(root, 'inference.sock');
  const state = { script: [], bodies: [], aborted: 0 };
  await listen(t, socketPath, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + credential.token) { res.writeHead(401); res.end('{}'); return; }
    const body = await readJson(req);
    state.bodies.push(body);
    const step = state.script.shift();
    if (!step) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":{"code":"UNAVAILABLE"}}'); return; }
    if (step === 'hang') { res.on('close', () => { state.aborted++; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(step.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  return { state, config: { socketPath, tokenFile: credential.file } };
}
