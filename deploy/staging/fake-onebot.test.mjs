import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OneBotClient, onebotURL } from '../../capabilities/qq/onebot-client.js';
import { messageFromOneBot } from '../../capabilities/qq/source.js';
import { createFakeOneBot, createFrameParser, encodeFrame } from './fake-onebot.mjs';

const freePort = () => new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const until = async probe => { for (let i = 0; i < 200; i++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timeout'); };
function clientFrame(text, opcode = 1, fin = true) {
  const body = Buffer.from(text), mask = randomBytes(4), length = body.length < 126 ? Buffer.from([0x80 | body.length]) : Buffer.from([0x80 | 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), length, mask, Buffer.from(body.map((byte, i) => byte ^ mask[i & 3]))]);
}

test('frame codec: masked client frames in pieces, fragments, and all three server length encodings', () => {
  const parser = createFrameParser(), bytes = Buffer.concat([clientFrame('{"a":1}'), clientFrame('x'.repeat(300)), clientFrame('he', 1, false), clientFrame('llo', 0), clientFrame('', 9)]);
  const messages = [];
  for (let i = 0; i < bytes.length; i += 7) messages.push(...parser.push(bytes.subarray(i, i + 7)));
  assert.deepEqual(messages.map(message => [message.opcode, message.payload.toString()]), [[1, '{"a":1}'], [1, 'x'.repeat(300)], [1, 'hello'], [9, '']]);
  assert.throws(() => createFrameParser().push(Buffer.from([0x81, 0x01, 0x41])), /WS_PROTOCOL/); // unmasked client frame
  assert.deepEqual([encodeFrame('a'.repeat(125))[1], encodeFrame('a'.repeat(126))[1], encodeFrame('a'.repeat(70000))[1]], [125, 126, 127]);
  assert.equal(encodeFrame('a'.repeat(70000)).length, 70010);
});

test('fake NapCat serves the real OneBotClient: token, login, friends, recorded sends, injected messages', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/fob-')), controlSocket = path.join(dir, 'control.sock'), port = await freePort(), token = 'a'.repeat(64);
  const fake = createFakeOneBot({ port, token, controlSocket, selfId: '999900000001' });
  await fake.start();
  t.after(async () => { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(fs.statSync(controlSocket).mode & 0o777, 0o600);
  const control = (method, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: controlSocket, method, path: route, agent: false }, res => { let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: 'nobody listens' })).status, 409);

  let wrongStatus = null;
  const wrong = new OneBotClient({ url: onebotURL(port), token: 'b'.repeat(64), onEvent: () => {}, onStatus: connected => { wrongStatus ??= connected; } });
  wrong.start(); await until(() => wrongStatus !== null); wrong.stop();
  assert.equal(wrongStatus, false);
  assert.equal(fake.clients.size, 0);

  const events = []; let connected = false;
  const client = new OneBotClient({ url: onebotURL(port), token, onEvent: event => { events.push(event); }, onStatus: value => { connected = value; } });
  client.start(); t.after(() => client.stop());
  await until(() => connected);
  assert.deepEqual(await client.call('get_login_info'), { user_id: 999900000001, nickname: 'MOCK-BOT' });
  assert.deepEqual(await client.call('get_friend_list'), []);
  assert.equal((await control('POST', '/friends', { friends: [{ user_id: '999900000011', nickname: 'MOCK-A' }] })).status, 200);
  await until(() => events.some(event => event.notice_type === 'friend_add'));
  assert.deepEqual((await client.call('get_friend_list')).map(friend => [friend.user_id, friend.nickname]), [[999900000011, 'MOCK-A']]);

  const long = '长'.repeat(30000); // > 65535 bytes: 64-bit length both ways
  const first = await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: 'MOCK-REPLY' } }], auto_escape: true });
  const second = await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: long } }] });
  assert.ok(Number.isSafeInteger(first.message_id) && second.message_id > first.message_id);
  await assert.rejects(client.call('get_msg', { message_id: 1 }), /ONEBOT_REJECTED/);
  const state = (await control('GET', '/state')).value;
  assert.deepEqual([state.selfId, state.clients, state.sent.length], ['999900000001', 1, 2]);
  assert.deepEqual([state.sent[0].user_id, state.sent[0].text, state.sent[0].message_id, state.sent[1].text.length], ['999900000011', 'MOCK-REPLY', first.message_id, 30000]);

  const incoming = long.slice(0, 15000); // the bridge accepts at most 16000 characters
  const injected = await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: incoming });
  await until(() => events.some(event => event.post_type === 'message'));
  const event = events.find(item => item.post_type === 'message');
  assert.equal(event.message_id, injected.value.message_id);
  // The bridge's own normalization accepts the event as a private message from that sender.
  const message = messageFromOneBot(event, { expectedSelfId: '999900000001' });
  assert.deepEqual([message.observation.streamId, message.observation.actorId, message.observation.role, message.authoredText === incoming], ['qq:999900000001:private:999900000011', 'qq:999900000001:user:999900000011', 'user', true]);
  assert.equal((await control('POST', '/message', { user_id: 'abc', nickname: 'x', text: 'y' })).status, 400);
  assert.equal((await control('POST', '/reset', {})).status, 200);
  assert.equal((await control('GET', '/state')).value.sent.length, 0);
});

test('the fake refuses production ports', () => {
  for (const port of [3001, 3082, 6099, 80]) assert.throws(() => createFakeOneBot({ port, token: 't', controlSocket: '/tmp/x.sock', selfId: '999900000001' }), /FAKE_ONEBOT_PORT/);
});
