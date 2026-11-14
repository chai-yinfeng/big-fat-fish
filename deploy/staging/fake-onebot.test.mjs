import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OneBotClient, onebotURL } from '../../capabilities/qq/onebot-client.js';
import { messageFromOneBot } from '../../capabilities/qq/source.js';
import { createFakeOneBot, createFrameParser, encodeFrame, mockPicture } from './fake-onebot.mjs';

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
  // Small faces: one face segment each after the text, read by the bridge as names; bad numbers are refused.
  const withFaces = await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: 'MOCK 看', faces: ['14', '179'] });
  await until(() => events.some(item => item.message_id === withFaces.value.message_id));
  const faced = events.find(item => item.message_id === withFaces.value.message_id);
  assert.deepEqual(faced.message.map(segment => segment.type), ['text', 'face', 'face']);
  assert.equal(messageFromOneBot(faced, { expectedSelfId: '999900000001' }).authoredText, 'MOCK 看[微笑][doge]');
  for (const faces of ['14', [14], ['x'], ['1'.repeat(11)], Array(32).fill('14')]) assert.equal((await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: 'y', faces })).status, 400);
  // A send with faces is recorded with its text segments joined, its segment types and its face numbers.
  await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: 'MOCK 好' } }, { type: 'face', data: { id: '14' } }, { type: 'text', data: { text: '呀' } }] });
  const facedSend = (await control('GET', '/state')).value.sent.at(-1);
  assert.deepEqual([facedSend.text, facedSend.types, facedSend.faces], ['MOCK 好呀', ['text', 'face', 'text'], ['14']]);
  // Pictures: one image segment after the text, with NapCat's sticker fields as asked; get_image gives the made-up bytes
  // back (the same seed, the same bytes), and the bridge reads the segment as a sticker or a mall sticker by name.
  const pictured = {};
  for (const [as, extra] of [['sticker', {}], ['mall', { name: '狗头' }], ['picture', {}]]) {
    const sent = await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: 'MOCK 图', image: { seed: 'MOCK-SEED', as, ...extra } });
    await until(() => events.some(item => item.message_id === sent.value.message_id));
    pictured[as] = events.find(item => item.message_id === sent.value.message_id);
  }
  assert.deepEqual(pictured.sticker.message.map(segment => segment.type), ['text', 'image']);
  assert.deepEqual(Object.values(pictured).map(event => messageFromOneBot(event, { expectedSelfId: '999900000001' }).media.map(({ sticker, stickerName }) => [sticker, stickerName])), [[[true, undefined]], [[true, '狗头']], [[false, undefined]]]);
  const bytes = Buffer.from((await client.call('get_image', { file: pictured.sticker.message[1].data.file })).base64, 'base64');
  assert.deepEqual([bytes.subarray(1, 4).toString('latin1'), bytes.readUInt32BE(16), bytes.equals(mockPicture('MOCK-SEED')), mockPicture('MOCK-SEED').equals(mockPicture('MOCK-OTHER'))], ['PNG', 1, true, false]);
  await assert.rejects(client.call('get_image', { file: 'MOCK-IMG-unknown.png' }), /ONEBOT_REJECTED/);
  for (const image of [{ seed: '' }, { seed: 'x', as: 'gif' }, { seed: 'x', as: 'mall' }, { seed: 'x', name: '狗头' }, { seed: 'x'.repeat(81) }]) assert.equal((await control('POST', '/message', { user_id: '999900000011', nickname: 'MOCK-A', text: 'y', image })).status, 400, JSON.stringify(image));
  // A sent picture is recorded with its sub_type, and whether its bytes were inline.
  await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'image', data: { file: 'base64://' + bytes.toString('base64'), sub_type: 1, summary: '[动画表情]' } }] });
  assert.deepEqual((await control('GET', '/state')).value.sent.at(-1).images, [{ subType: 1, base64: true }]);
  assert.equal((await control('POST', '/reset', {})).status, 200);
  assert.equal((await control('GET', '/state')).value.sent.length, 0);

  // A lost receipt: the send is refused to the caller, recorded as lost and never as sent; then sends work again.
  assert.equal((await control('POST', '/lose-receipts', { count: 1 })).status, 200);
  await assert.rejects(client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: 'MOCK-LOST' } }] }), /ONEBOT_REJECTED/);
  const after = await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: 'MOCK-KEPT' } }] });
  const lossy = (await control('GET', '/state')).value;
  assert.deepEqual([lossy.lost.map(item => [item.user_id, item.text]), lossy.sent.map(item => [item.text, item.message_id])], [[['999900000011', 'MOCK-LOST']], [['MOCK-KEPT', after.message_id]]]);
  for (const count of [-1, 21, '1', 1.5]) assert.equal((await control('POST', '/lose-receipts', { count })).status, 400);
  // A reset also forgets receipts still to be lost.
  await control('POST', '/lose-receipts', { count: 3 }); await control('POST', '/reset', {});
  await client.call('send_private_msg', { user_id: '999900000011', message: [{ type: 'text', data: { text: 'MOCK-AFTER-RESET' } }] });
  const clean = (await control('GET', '/state')).value;
  assert.deepEqual([clean.lost, clean.sent.length], [[], 1]);
});

test('the fake refuses production ports', () => {
  for (const port of [3001, 3082, 6099, 80]) assert.throws(() => createFakeOneBot({ port, token: 't', controlSocket: '/tmp/x.sock', selfId: '999900000001' }), /FAKE_ONEBOT_PORT/);
});
