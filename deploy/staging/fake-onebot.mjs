#!/usr/bin/env node
// Staging-only fake NapCat: a OneBot v11 WebSocket server on 127.0.0.1 plus a private
// Unix control socket for the scenario runner. Never part of a release or a production unit.
//   node fake-onebot.mjs --port 13001 --token-file <file> --control <socket> --self <bot QQ>
// Control (HTTP on the Unix socket):
//   GET  /state                       -> { selfId, clients, friends, sent, lost }  (each sent item: its text segments joined, segment types, face ids)
//   POST /friends { friends: [{ user_id, nickname }] }   (also emits a friend_add notice)
//   POST /message { user_id, nickname, text, sub_type?, faces?, image? } -> { message_id }  (private message event; `faces`: QQ
//                                     face numbers, each a face segment after the text; `image`: { seed, as?: "picture" | "sticker"
//                                     | "mall", name? }, one image segment after those: a tiny PNG made from `seed` (the same seed,
//                                     the same bytes), read back with get_image. "sticker" carries NapCat's `sub_type: 1`, "mall"
//                                     its `emoji_id` fields with `name` as the summary)
//   POST /lose-receipts { count }     -> the next `count` send_private_msg calls get no receipt (recorded in `lost`, never in `sent`)
//   POST /reset                       -> forgets recorded send_private_msg calls and pending lost receipts
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const qq = value => /^[1-9]\d{0,19}$/.test(String(value)) && Number.isSafeInteger(Number(value));

/** A 1x1 PNG made from `seed` (its colour and a text chunk), never a real picture: the same seed gives the same bytes. */
export function mockPicture(seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const digest = createHash('sha256').update(String(seed)).digest();
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('MOCK\0' + String(seed))), chunk('IDAT', deflateSync(Buffer.from([0, digest[0], digest[1], digest[2]]))), chunk('IEND', Buffer.alloc(0))]);
}
/** The image segment for a `/message` image: NapCat's fields for a sticker or a mall sticker (as reported second-hand). */
export function imageSegment({ seed, as = 'picture', name }) {
  const file = 'MOCK-IMG-' + createHash('sha256').update(String(seed)).digest('hex').slice(0, 16) + '.png';
  if (as === 'sticker') return { type: 'image', data: { file, sub_type: 1, summary: '[动画表情]' } };
  if (as === 'mall') return { type: 'image', data: { file, emoji_id: 'mock0', emoji_package_id: 'mock0', key: 'mock0', summary: `[${name}]` } };
  return { type: 'image', data: { file, sub_type: 0 } };
}

/** One unmasked server-to-client frame (RFC 6455 §5.2). */
export function encodeFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
    : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
  return Buffer.concat([head, body]);
}

/** Incremental parser for masked client frames; `push(chunk)` returns complete messages. */
export function createFrameParser(limit = 16 * 1024 * 1024) {
  let buffer = Buffer.alloc(0), fragments = [], fragmentOpcode = 0;
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const messages = [];
      while (buffer.length >= 2) {
        const fin = Boolean(buffer[0] & 0x80), opcode = buffer[0] & 0x0f, masked = Boolean(buffer[1] & 0x80);
        let length = buffer[1] & 0x7f, offset = 2;
        if (buffer[0] & 0x70 || !masked) throw new Error('WS_PROTOCOL');
        if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) break; const big = buffer.readBigUInt64BE(2); if (big > BigInt(limit)) throw new Error('WS_LIMIT'); length = Number(big); offset = 10; }
        if (length > limit) throw new Error('WS_LIMIT');
        if (buffer.length < offset + 4 + length) break;
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode >= 8) { messages.push({ opcode, payload }); continue; }
        if (opcode) { fragments = [payload]; fragmentOpcode = opcode; } else fragments.push(payload);
        if (fin) { messages.push({ opcode: fragmentOpcode, payload: Buffer.concat(fragments) }); fragments = []; }
      }
      return messages;
    },
  };
}

export function createFakeOneBot({ port, token, controlSocket, selfId, nickname = 'MOCK-BOT' }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3001, 3082, 6099].includes(port)) throw new Error('FAKE_ONEBOT_PORT');
  if (typeof token !== 'string' || !token || !qq(selfId) || !path.isAbsolute(controlSocket)) throw new Error('FAKE_ONEBOT_CONFIG');
  const clients = new Set(), sent = [], lost = [], pictures = new Map();
  let losing = 0, friends = [], nextMessageId = Math.floor(Date.now() / 1000) % 1000000 * 1000;
  const broadcast = event => { const frame = encodeFrame(JSON.stringify(event)); for (const socket of clients) socket.write(frame); };
  const envelope = () => ({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId) });

  function action({ action: name, params = {}, echo }) {
    const ok = data => ({ status: 'ok', retcode: 0, data, echo });
    if (name === 'get_login_info') return ok({ user_id: Number(selfId), nickname });
    if (name === 'get_image' && pictures.has(params.file)) return ok({ file: params.file, base64: pictures.get(params.file) });
    if (name === 'get_friend_list') return ok(friends.map(friend => ({ user_id: Number(friend.user_id), nickname: friend.nickname, remark: '' })));
    if (name === 'send_private_msg' && qq(params.user_id) && Array.isArray(params.message)) {
      const text = params.message.filter(segment => segment?.type === 'text').map(segment => String(segment.data?.text ?? '')).join('');
      // The platform's answer is lost: the caller cannot tell whether the message went out.
      if (losing > 0) { losing--; lost.push({ user_id: String(params.user_id), text, at: Date.now() }); return { status: 'failed', retcode: 1200, data: null, echo }; }
      const message_id = ++nextMessageId;
      sent.push({ message_id, user_id: String(params.user_id), text, types: params.message.map(segment => segment?.type), faces: params.message.filter(segment => segment?.type === 'face').map(segment => String(segment.data?.id)), images: params.message.filter(segment => segment?.type === 'image').map(segment => ({ subType: segment.data?.sub_type ?? 0, base64: typeof segment.data?.file === 'string' && segment.data.file.startsWith('base64://') })), at: Date.now() });
      return ok({ message_id });
    }
    return { status: 'failed', retcode: 1404, data: null, echo };
  }

  const ws = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  ws.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://fake-onebot.invalid'), key = req.headers['sec-websocket-key'];
    const presented = url.searchParams.get('access_token') ?? /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (presented !== token || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const parser = createFrameParser();
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      let messages; try { messages = parser.push(chunk); } catch { socket.destroy(); return; }
      for (const { opcode, payload } of messages) {
        if (opcode === 8) { socket.end(encodeFrame(payload.subarray(0, 2), 8)); return; }
        if (opcode === 9) { socket.write(encodeFrame(payload, 10)); continue; }
        if (opcode !== 1) continue;
        let request; try { request = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (request && typeof request.action === 'string') socket.write(encodeFrame(JSON.stringify(action(request))));
      }
    });
    socket.write(encodeFrame(JSON.stringify({ ...envelope(), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' })));
  });

  const control = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && req.url === '/state') { send(200, { ok: true, value: { selfId: String(selfId), clients: clients.size, friends, sent, lost } }); return; }
      if (req.method !== 'POST') { send(404, { ok: false }); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.url === '/reset') { sent.length = 0; lost.length = 0; losing = 0; send(200, { ok: true, value: {} }); return; }
      if (req.url === '/lose-receipts') {
        if (!Number.isInteger(body.count) || body.count < 0 || body.count > 20) throw new Error('LOSE');
        losing = body.count; send(200, { ok: true, value: { losing } }); return;
      }
      if (req.url === '/friends') {
        if (!Array.isArray(body.friends) || body.friends.some(friend => !qq(friend?.user_id) || typeof friend.nickname !== 'string')) throw new Error('FRIENDS');
        friends = body.friends.map(friend => ({ user_id: String(friend.user_id), nickname: friend.nickname }));
        // The bridge drops its cached friend list on this notice and asks again.
        for (const friend of friends.slice(0, 1)) broadcast({ ...envelope(), post_type: 'notice', notice_type: 'friend_add', user_id: Number(friend.user_id) });
        send(200, { ok: true, value: { friends: friends.length } }); return;
      }
      if (req.url === '/message') {
        if (!qq(body.user_id) || typeof body.text !== 'string' || !body.text || typeof body.nickname !== 'string') throw new Error('MESSAGE');
        if (body.faces !== undefined && (!Array.isArray(body.faces) || body.faces.length > 31 || body.faces.some(id => typeof id !== 'string' || !/^\d{1,10}$/.test(id)))) throw new Error('MESSAGE');
        if (body.image !== undefined && (typeof body.image?.seed !== 'string' || !body.image.seed || body.image.seed.length > 80 || !['picture', 'sticker', 'mall', undefined].includes(body.image.as) || (body.image.as === 'mall') !== (typeof body.image.name === 'string' && body.image.name.length > 0 && body.image.name.length <= 12))) throw new Error('MESSAGE');
        if (!clients.size) { send(409, { ok: false, error: 'NO_BRIDGE_CONNECTED' }); return; }
        const message_id = ++nextMessageId, user_id = Number(body.user_id), image = body.image ? imageSegment(body.image) : null;
        if (image) pictures.set(image.data.file, mockPicture(body.image.seed).toString('base64'));
        broadcast({ ...envelope(), post_type: 'message', message_type: 'private', sub_type: body.sub_type ?? 'friend', message_id, user_id, message: [{ type: 'text', data: { text: body.text } }, ...(body.faces ?? []).map(id => ({ type: 'face', data: { id } })), ...(image ? [image] : [])], raw_message: body.text + (body.faces ?? []).map(id => `[CQ:face,id=${id}]`).join('') + (image ? `[CQ:image,file=${image.data.file}]` : ''), font: 14, sender: { user_id, nickname: body.nickname, card: '' }, message_format: 'array' });
        send(200, { ok: true, value: { message_id } }); return;
      }
      send(404, { ok: false });
    } catch { send(400, { ok: false, error: 'INVALID_REQUEST' }); }
  });

  return {
    sent, lost, clients,
    async start() {
      fs.mkdirSync(path.dirname(controlSocket), { recursive: true, mode: 0o700 });
      fs.rmSync(controlSocket, { force: true });
      await new Promise((resolve, reject) => { ws.once('error', reject); ws.listen(port, '127.0.0.1', resolve); });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlSocket, resolve); });
      fs.chmodSync(controlSocket, 0o600);
    },
    async close() {
      for (const socket of clients) socket.destroy();
      for (const server of [ws, control]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      fs.rmSync(controlSocket, { force: true });
    },
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
  process.umask(0o077);
  const fake = createFakeOneBot({ port: Number(args.port), token: fs.readFileSync(args['token-file'], 'utf8').trim(), controlSocket: args.control, selfId: args.self });
  fake.start().then(() => {
    process.stdout.write('fake OneBot ready\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void fake.close().then(() => process.exit(0)); });
  }, error => { process.stderr.write('fake OneBot failed: ' + (error.code || error.message) + '\n'); process.exitCode = 1; });
}
