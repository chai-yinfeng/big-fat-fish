import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthorityClient } from '../../authority/src/client.js';
import { ConversationPort } from '../conversation/index.js';
import { createConversationClient } from '../conversation/client.js';
import { QQBridge } from './bridge.js';
import { OneBotClient } from './onebot-client.js';
import { ContentClient } from '../media/client.js';
import { QQMedia } from './media.js';

process.umask(0o077);
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('QQ_CONFIG');
  const file = path.resolve(process.argv[3]), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('QQ_CONFIG');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const authority = new AuthorityClient(cfg.authority), port = new ConversationPort(authority);
  let bridge;
  const onebot = new OneBotClient({ url: 'ws://127.0.0.1:3001', token: fs.readFileSync(cfg.onebotTokenFile, 'utf8').trim(), onEvent: event => bridge.receive(event), onStatus: connected => { void bridge.connection(connected); } });
  const executor = createConversationClient(cfg.conversation);
  const media = cfg.contentEnabled ? new QQMedia({ content: new ContentClient(cfg.authority), onebot }) : undefined;
  bridge = new QQBridge({ ...cfg, authority, port, onebot, executor, media });
  const expected = Buffer.from(cfg.operatorTokenHash, 'hex');
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
      if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), expected)) { send(401, { ok: false }); return; }
      if (req.method === 'GET' && req.url === '/qq') { send(200, { ok: true, value: await bridge.status() }); return; }
      if (req.method === 'GET' && req.url === '/qq/identity') { send(200, { ok: true, value: { expectedSelfId: bridge.loginIdentity() } }); return; }
      if (req.method !== 'POST' || req.url !== '/qq') { send(404, { ok: false }); return; }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw new Error('QQ_BODY'); }
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expectedSelfId', 'allowedCallerUID'].includes(k))) throw new Error('QQ_BODY');
      const value = await bridge.configure(body); send(200, { ok: true, value });
    } catch { send(409, { ok: false, error: { code: 'CONFLICT', message: 'Pause the world and complete QQ login before configuring the private caller' } }); }
  });
  server.requestTimeout = 10000;
  fs.mkdirSync(path.dirname(cfg.controlSocket), { recursive: true, mode: 0o700 });
  if (fs.existsSync(cfg.controlSocket)) {
    if (!fs.lstatSync(cfg.controlSocket).isSocket() || fs.realpathSync(cfg.controlSocket) !== cfg.controlSocket) throw new Error('QQ_SOCKET');
    await new Promise((resolve, reject) => { const socket = net.connect(cfg.controlSocket); socket.once('connect', () => { socket.destroy(); reject(new Error('QQ_ALREADY_RUNNING')); }); socket.once('error', error => { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) { reject(error); return; } fs.unlinkSync(cfg.controlSocket); resolve(); }); });
  }
  await new Promise(resolve => server.listen(cfg.controlSocket, resolve)); fs.chmodSync(cfg.controlSocket, 0o600);
  onebot.start();
  // NapCat may accept WebSocket connections before QQ has finished restoring login.
  const identityTimer = setInterval(() => { if (bridge.connected && !bridge.selfId) void bridge.refreshIdentity(); }, 5000);
  identityTimer.unref();
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; clearInterval(identityTimer); onebot.stop(); server.closeIdleConnections(); server.close(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  process.stdout.write('QQ private transport ready; waiting for authenticated runtime and caller configuration.\n');
}
main().catch(() => { process.stderr.write('QQ transport failed; inspect private configuration.\n'); process.exitCode = 1; });
