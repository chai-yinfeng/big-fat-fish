import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../media/artifacts.js';
import { MediaService } from '../../media/service.js';
import { QQMedia, explicitSpeechRequested } from '../media.js';
import { QQBridge } from '../bridge.js';
import { PACING } from '../pacing.js';

// No burst wait (each message is its own turn unless they arrive together) and a fixed random source.
const QUICK = { pacing: { ...PACING, burstQuietMs: 0, burstMaxWaitMs: 0 }, random: () => 0.5 };

function wav() {
  const b = Buffer.alloc(44 + 3200); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
function fixture(t, { faces } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-qq-media-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^fish-qq-media-/); fs.rmSync(root, { recursive: true }); });
  const store = new ArtifactStore({ root: path.join(root, 'artifacts') }), observed = [], sent = [], executions = [];
  let tts = 0, nextId = 500;
  const qualities = [];
  const service = new MediaService({ store, workRoot: path.join(root, 'work'), speech: { transcribe: async () => ({ text: '你好，我回来了', model: 'synthetic-asr' }), synthesize: async ({ outputFile, voiceProfile }) => { qualities.push(voiceProfile); tts++; fs.writeFileSync(outputFile, wav()); return { model: 'synthetic-tts' }; } }, normalizeImage: async data => ({ data, mime: 'image/gif' }), vision: async () => ({ description: '一张合成测试表情图', model: 'synthetic-vision', derived: true }), search: async () => ({}), fetchPage: async () => ({}) });
  const scope = { entityId: 'entity:test', streamId: 'qq:100:private:200', personId: 'person:owner', audience: 'private', memoryEpoch: 0 };
  const content = { call: input => service.call({ ...scope, streamId: input.streamId, memoryEpoch: input.memoryEpoch }, input) };
  const onebot = { call: async (action, params) => { if (action === 'get_login_info') return { user_id: '100' }; if (action === 'get_record') return { base64: wav().toString('base64') }; if (action === 'get_image') return { base64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }; if (action === 'send_private_msg') { sent.push(params); return { message_id: nextId++ }; } throw Error('unexpected action'); } };
  const settingsFile = path.join(root, 'settings.json'); fs.writeFileSync(settingsFile, JSON.stringify({ expectedSelfId: '100', allowedCallerUID: '200' }));
  const executor = { execute: async request => { executions.push(request); return '我在。'; } };
  const bridge = new QQBridge({ ...QUICK, sleep: async () => {}, authority: { health: async () => ({ world: { paused: false, revision: 1 } }), context: async () => ({ entityId: scope.entityId, memoryEpoch: 0 }) }, port: { observe: async value => { observed.push(value); return { observationId: 'synthetic-observation' }; } }, onebot, executor, media: new QQMedia({ content, onebot, ...(faces === undefined ? {} : { faces }) }), settingsFile, stateFile: path.join(root, 'dispatch.json') });
  const event = (id, message) => ({ post_type: 'message', self_id: 100, user_id: 200, message_id: id, message_type: 'private', sender: { user_id: 200 }, time: Math.floor(Date.now() / 1000), message });
  return { bridge, event, observed, sent, executions, executor, content, store, service, qualities, tts: () => tts };
}

test('QQ voice becomes derived input, never a fabricated verbatim observation; default reply remains text', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  await f.bridge.receive(f.event(1, [{ type: 'record', data: { file: 'trusted-onebot-file-reference' } }]));
  assert.equal(f.observed[0].text, '[QQ语音消息]'); assert.equal(f.observed[0].role, 'user');
  const { input } = f.executions[0];
  assert.match(input.text, /机器转写/); assert.match(input.text, /你好，我回来了/);
  assert.equal(input.queryText, '你好，我回来了');
  assert.deepEqual(input.evidence, [{ ref: 'synthetic-observation', eventId: f.observed[0].eventId, role: 'user' }]);
  assert.doesNotMatch(input.text, /渠道表达策略/);
  assert.equal(f.sent[0].message[0].type, 'text'); assert.equal(f.tts(), 0);
});

test('explicit speech creates a record only after synthesis; authorized image attachment gets its own receipt', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  await f.bridge.receive(f.event(2, [{ type: 'text', data: { text: '请用语音告诉我，你在吗' } }]));
  // The model is told the reply is spoken in its own voice, so it does not claim it can only type.
  assert.match(f.executions[0].input.text, /用你自己的声音合成为语音消息发出，你能发语音/); assert.match(f.executions[0].input.text, /不超过100字，不用Markdown、链接、表情符号/);
  assert.equal(f.tts(), 1); assert.deepEqual(f.qualities, [undefined]); assert.equal(f.sent[0].message[0].type, 'record'); assert.match(f.sent[0].message[0].data.file, /^base64:\/\//);
  assert.match(f.observed.at(-1).text, /已发送语音/);
  f.executor.execute = async request => { const image = f.store.records().find(r => r.kind === 'image'); await f.content.call({ action: 'attach', streamId: 'qq:100:private:200', memoryEpoch: 0, requestId: request.requestId, ref: image.id }); return '给你这张图。'; };
  await f.bridge.receive(f.event(3, [{ type: 'text', data: { text: '把这张表情包发回来' } }, { type: 'image', data: { file: 'trusted-image-reference', emoji_id: 'fixture' } }]));
  assert.deepEqual(f.sent.slice(1).map(p => p.message[0].type), ['text', 'image']);
  assert.equal(Object.values(f.bridge.state.records).at(-1).receipts.length, 2);
  assert.equal(explicitSpeechRequested('不要语音，请用文字回答'), false);
  assert.equal(explicitSpeechRequested('Qwen3-TTS是什么？'), false);
  const image = f.store.records().find(r => r.kind === 'image');
  await f.content.call({ action: 'attach', streamId: 'qq:100:private:200', memoryEpoch: 0, requestId: 'expired-reply', ref: image.id });
  for (const row of f.service.replies.values()) row.expiresAt = Date.now() - 1;
  assert.deepEqual(await f.content.call({ action: 'pending', streamId: 'qq:100:private:200', memoryEpoch: 0, requestId: 'expired-reply' }), { parts: [] });
});

test('an image refused by the spend tier gets silence; any other attachment failure still gets the notice', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  const image = [{ type: 'image', data: { file: 'trusted-onebot-image-reference' } }], call = f.service.vision;
  f.service.vision = async () => { throw Object.assign(new Error('CONTENT_SPEND_RESTRICTED'), { code: 'CONTENT_SPEND_RESTRICTED' }); };
  await f.bridge.receive(f.event(11, image));
  await f.bridge.receive(f.event(12, [{ type: 'text', data: { text: '看看这张' } }, ...image]));
  assert.equal(f.sent.length, 0); assert.equal(f.executions.length, 0);
  assert.deepEqual(Object.values(f.bridge.state.records).map(item => item.status), ['budget_restricted', 'budget_restricted']);
  for (const code of ['CONTENT_BUDGET_EXHAUSTED', 'CONTENT_OPERATION_UNAVAILABLE']) {
    f.service.vision = async () => { throw Object.assign(new Error(code), { code }); };
    await f.bridge.receive(f.event(code.length, image));
  }
  assert.deepEqual(f.sent.map(item => item.message[0].data.text), Array(2).fill('这条附件暂时没有处理完成，我没有识别其内容。可以重试或改用文字。'));
  f.service.vision = call;
  await f.bridge.receive(f.event(15, image));
  assert.equal(f.sent.at(-1).message[0].data.text, '我在。'); assert.equal(f.executions.length, 1);
});

test('with media: only the text of a reply is split; a voice reply and an attachment stay one message each', async t => {
  const f = fixture(t), gaps = []; await f.bridge.connection(true); f.bridge.sleep = async ms => { gaps.push(ms); };
  const sentence = n => `这是第${n}句话，它的长度刚好让两句放不进同一条消息里面去，所以一句一条。`, long = sentence(1) + sentence(2);
  f.executor.execute = async () => long;
  await f.bridge.receive(f.event(21, [{ type: 'text', data: { text: '请用语音告诉我' } }]));
  assert.deepEqual(f.sent.map(p => p.message[0].type), ['record']); assert.equal(f.tts(), 1); assert.deepEqual(gaps, []);
  assert.ok(f.observed.at(-1).text.endsWith(long));
  // Failed synthesis falls back to one text message, as before.
  f.service.speech.synthesize = async () => { throw new Error('TTS_UNAVAILABLE'); };
  await f.bridge.receive(f.event(22, [{ type: 'text', data: { text: '请用语音再说一遍' } }]));
  assert.deepEqual(f.sent.slice(1).map(p => p.message[0].data.text), [long + '\n（本次语音合成未完成，已改用文字；没有发送残缺语音。）']); assert.deepEqual(gaps, []);
  f.executor.execute = async request => { const image = f.store.records().find(r => r.kind === 'image'); await f.content.call({ action: 'attach', streamId: 'qq:100:private:200', memoryEpoch: 0, requestId: request.requestId, ref: image.id }); return long; };
  await f.bridge.receive(f.event(23, [{ type: 'text', data: { text: '把这张图发回来' } }, { type: 'image', data: { file: 'trusted-image-reference' } }]));
  assert.deepEqual(f.sent.slice(2).map(p => p.message[0].type === 'text' ? p.message[0].data.text : p.message[0].type), [sentence(1), sentence(2), 'image']);
  assert.deepEqual(gaps, [950, 2363]);
  assert.equal(Object.values(f.bridge.state.records).at(-1).receipts.length, 3);
  assert.deepEqual(f.observed.slice(-3, -1).map(o => o.text), [sentence(1), sentence(2)]);
});

test('a voice reply is synthesized without bracketed asides and emoticons; the recorded reply keeps them', async t => {
  const f = fixture(t), spoken = []; await f.bridge.connection(true);
  f.service.speech.synthesize = async ({ text, outputFile }) => { spoken.push(text); fs.writeFileSync(outputFile, wav()); return { model: 'synthetic-tts' }; };
  f.executor.execute = async () => '（轻轻笑）我在呢😊，别担心。(拍拍你)';
  await f.bridge.receive(f.event(31, [{ type: 'text', data: { text: '请用语音告诉我，你在吗' } }]));
  assert.deepEqual(spoken, ['我在呢，别担心。']);
  assert.equal(f.sent[0].message[0].type, 'record');
  assert.equal(f.observed.at(-1).text, '[已发送语音；以下为合成文本而非逐字收听验证]\n（轻轻笑）我在呢😊，别担心。(拍拍你)');
  // Nothing left to say: no synthesis, and the existing text fallback carries the reply as written.
  f.executor.execute = async () => '（点头）';
  await f.bridge.receive(f.event(32, [{ type: 'text', data: { text: '请用语音回答我' } }]));
  assert.equal(spoken.length, 1);
  assert.deepEqual(f.sent.slice(1).map(p => p.message[0].data.text), ['（点头）\n（本次语音合成未完成，已改用文字；没有发送残缺语音。）']);
  // The limit of 120 characters applies to what is synthesized.
  await assert.rejects(f.content.call({ action: 'synthesize', streamId: 'qq:100:private:200', memoryEpoch: 0, sourceEventId: f.observed[0].eventId, text: '好'.repeat(121) }), { code: 'MEDIA_SPEECH_INPUT' });
  await f.content.call({ action: 'synthesize', streamId: 'qq:100:private:200', memoryEpoch: 0, sourceEventId: f.observed[0].eventId, text: '好'.repeat(120) + '（笑）' });
  assert.equal(spoken.at(-1), '好'.repeat(120));
});

test('small faces: six in one message are answered, read by name and stored as nothing; with faces on her [微笑] goes out as a face in the same message', async t => {
  const f = fixture(t, { faces: true }); await f.bridge.connection(true);
  f.executor.execute = async request => { f.executions.push(request); return '收到[微笑]，这个[不存在]不是表情'; };
  await f.bridge.receive(f.event(10, [{ type: 'text', data: { text: '哈哈' } }, ...['14', '14', '179', '264', '277', '9999'].map(id => ({ type: 'face', data: { id } }))]));
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].input.text, '哈哈[微笑][微笑][doge][捂脸][汪汪][表情]');
  assert.doesNotMatch(f.executions[0].input.text, /QQ编号/);
  assert.equal(f.store.records().length, 0);
  assert.deepEqual(f.sent.map(p => p.message), [[{ type: 'text', data: { text: '收到' } }, { type: 'face', data: { id: '14' } }, { type: 'text', data: { text: '，这个[不存在]不是表情' } }]]);
  // What she said is recorded as she wrote it, under the one receipt.
  assert.equal(f.observed.at(-1).text, '收到[微笑]，这个[不存在]不是表情');
  assert.equal(Object.values(f.bridge.state.records).at(-1).receipts.length, 1);
});

test('more than four pictures: the first four are looked at, the model is told how many were not, and she still answers', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  await f.bridge.receive(f.event(11, [{ type: 'text', data: { text: '看看这些' } }, ...[1, 2, 3, 4, 5, 6].map(n => ({ type: 'image', data: { file: 'trusted-image-' + n } }))]));
  assert.equal(f.executions.length, 1);
  assert.equal(f.store.records().filter(r => r.kind === 'image').length, 4);
  assert.match(f.executions[0].input.text, /还有 2 个附件没有处理/);
  assert.equal(f.sent.length, 1);
});

test('a voice reply is synthesized without face markers; the recorded reply keeps them', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  const spoken = [], synthesize = f.service.speech.synthesize;
  f.service.speech.synthesize = input => { spoken.push(input.text); return synthesize(input); };
  f.executor.execute = async () => '在呢[微笑]，[不存在]也念';
  await f.bridge.receive(f.event(12, [{ type: 'text', data: { text: '请用语音告诉我，你在吗' } }]));
  assert.deepEqual(spoken, ['在呢，[不存在]也念']);
  assert.equal(f.sent[0].message[0].type, 'record');
  assert.match(f.observed.at(-1).text, /在呢\[微笑\]，\[不存在\]也念/);
});

test('stickers: read as a sticker, described once by picture, a mall sticker by its name, an unrecognized one said so', async t => {
  const f = fixture(t), looks = [], vision = f.service.vision; await f.bridge.connection(true);
  f.service.vision = async body => { looks.push(body.purpose); return vision(body); };
  const custom = { type: 'image', data: { file: 'trusted-sticker', sub_type: 1, summary: '[动画表情]' } };
  await f.bridge.receive(f.event(41, [{ type: 'text', data: { text: '哈' } }, custom]));
  await f.bridge.receive(f.event(42, [{ type: 'text', data: { text: '再来' } }, custom]));
  assert.deepEqual(looks, ['sticker'], 'the same picture is looked at once, in the sticker row');
  for (const execution of f.executions) assert.match(execution.input.text, /表情包 media:[a-f0-9-]{36}：一张合成测试表情图（机器描述，仅首帧，不代表完整动画）/);
  // Another picture (other bytes) for the mall sticker.
  const onebotCall = f.bridge.onebot.call;
  f.bridge.onebot.call = async (action, params) => action === 'get_image' && params.file === 'trusted-mall' ? { base64: 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7' } : onebotCall(action, params);
  await f.bridge.receive(f.event(43, [{ type: 'text', data: { text: '狗头' } }, { type: 'image', data: { file: 'trusted-mall', emoji_id: 'MOCK-E', emoji_package_id: 'MOCK-P', summary: '[狗头]' } }]));
  assert.match(f.executions.at(-1).input.text, /表情包 media:[a-f0-9-]{36}：商城表情「狗头」（名字来自平台，不是看图识别）/);
  assert.deepEqual(looks, ['sticker']);
  // The day's sticker looks are used up and the picture is not known.
  f.service.vision = async () => { throw Object.assign(new Error('CONTENT_BUDGET_EXHAUSTED'), { code: 'CONTENT_BUDGET_EXHAUSTED' }); };
  f.service.stickers.described = () => null;
  await f.bridge.receive(f.event(44, [{ type: 'text', data: { text: '这个呢' } }, custom]));
  assert.match(f.executions.at(-1).input.text, /表情包 media:[a-f0-9-]{36}：收到一张没见过的表情包，今天没有识别。不要编造它的内容。/);
  assert.equal(f.sent.length, 4, 'every message was answered');
});

test('her library: the owner says 收下这个 after a picture; her [表情:词] then goes out last, as a message of its own', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  const replies = ['好可爱', '收到', '好呀[表情:合成测试表情] 嘿', '在呢[表情:犀牛潜水艇]'];
  f.executor.execute = async request => { f.executions.push(request); return replies.shift(); };
  await f.bridge.receive(f.event(51, [{ type: 'image', data: { file: 'trusted-sticker', sub_type: 1 } }]));
  await f.bridge.receive(f.event(52, [{ type: 'text', data: { text: '收下这个' } }]));
  assert.match(f.executions[1].input.text, /\[渠道事实：已把主人发的那张图收进你的表情库（名字：一张合成测试表情图）。\]/);
  await f.bridge.receive(f.event(53, [{ type: 'text', data: { text: '考过了！' } }]));
  // The marker never reaches the chat; the sticker is the last message, an image marked as a sticker, with its own receipt.
  assert.deepEqual(f.sent.slice(2).map(p => p.message.map(segment => segment.type === 'text' ? segment.data.text : [segment.type, segment.data.sub_type, segment.data.summary, segment.data.file.startsWith('base64://')])), [['好呀 嘿'], [['image', 1, '[动画表情]', true]]]);
  assert.deepEqual(f.observed.slice(-2).map(o => o.text), ['好呀 嘿', '[已发送表情包：一张合成测试表情图]']);
  assert.equal(Object.values(f.bridge.state.records).at(-1).receipts.length, 2);
  // How often she sent one lately is told as a fact; no close sticker: nothing is sent but her words.
  await f.bridge.receive(f.event(54, [{ type: 'text', data: { text: '还在吗' } }]));
  assert.match(f.executions[3].input.text, /\[渠道事实：你最近 3 条回复里发过 1 次表情包。\]$/);
  assert.deepEqual(f.sent.slice(4).map(p => p.message), [[{ type: 'text', data: { text: '在呢' } }]]);
  // A voice reply sends no sticker and speaks no marker; the voice turn gets no frequency line.
  const spoken = [], synthesize = f.service.speech.synthesize;
  f.service.speech.synthesize = input => { spoken.push(input.text); return synthesize(input); };
  f.executor.execute = async request => { f.executions.push(request); return '晚安[表情:合成测试表情]'; };
  await f.bridge.receive(f.event(55, [{ type: 'text', data: { text: '请用语音说晚安' } }]));
  assert.deepEqual([spoken, f.sent.slice(5).map(p => p.message[0].type)], [['晚安'], ['record']]);
  assert.doesNotMatch(f.executions[4].input.text, /渠道事实/);
});

/** Distinct one-pixel GIFs by file name (`pic-<n>`), so each picture is its own hash; keepSticker calls are recorded. */
function pictures(f) {
  const call = f.bridge.onebot.call, kept = [];
  f.bridge.onebot.call = async (action, params) => {
    const n = /^pic-(\d+)$/.exec(params?.file ?? '')?.[1];
    if (action !== 'get_image' || n === undefined) return call(action, params);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); gif[13] = Number(n); return { base64: gif.toString('base64') };
  };
  const keep = f.bridge.media.keepSticker.bind(f.bridge.media);
  f.bridge.media.keepSticker = (scope, ref) => { kept.push(ref); return keep(scope, ref); };
  const picture = (id, n) => f.event(id, [{ type: 'image', data: { file: `pic-${n}`, sub_type: 1 } }]);
  return { kept, picture };
}

test('收下这些: the owner keeps every picture of the last 10 minutes, oldest first, each like one; already kept ones are counted, not added', async t => {
  const f = fixture(t), { kept, picture } = pictures(f); await f.bridge.connection(true);
  let now = Date.parse('2026-11-19T04:00:00Z'); f.bridge.clock = () => now;
  await f.bridge.receive(picture(101, 1));
  await f.bridge.receive(f.event(102, [{ type: 'text', data: { text: '收下这张' } }]));
  assert.equal(kept.length, 1, 'the one picture, as before');
  now += 60000; await f.bridge.receive(picture(103, 2));
  now += 60000; await f.bridge.receive(picture(104, 3));
  const before = kept.length;
  await f.bridge.receive(f.event(105, [{ type: 'text', data: { text: '这些都收下' } }]));
  const refs = kept.slice(before);
  assert.equal(refs.length, 3);
  assert.deepEqual(refs.map(ref => f.store.metadata(ref).sourceEventId.match(/\d+$/)[0]), ['101', '103', '104'], 'oldest first');
  assert.match(f.executions.at(-1).input.text, /\[渠道事实：主人让你收下最近的 3 张图：收进表情库 2 张（名字：[^）]+、[^）]+），本来就在库里 1 张，没能收进 0 张。\]/);
  // A picture failing to go in is counted as failed; the others still go in.
  now += 60000; await f.bridge.receive(picture(106, 4));
  const keep = f.bridge.media.keepSticker; let calls = 0;
  f.bridge.media.keepSticker = (scope, ref) => ++calls === 4 ? Promise.reject(new Error('content down')) : keep(scope, ref);
  await f.bridge.receive(f.event(107, [{ type: 'text', data: { text: '把刚才的都收了' } }]));
  assert.match(f.executions.at(-1).input.text, /收下最近的 4 张图：收进表情库 0 张，本来就在库里 3 张，没能收进 1 张。\]/);
  // Ten minutes after the last picture, nothing is left to keep.
  now += 10 * 60000 + 1;
  await f.bridge.receive(f.event(108, [{ type: 'text', data: { text: '收下这几张' } }]));
  assert.match(f.executions.at(-1).input.text, /\[渠道事实：主人让你收下最近的几张图，但最近没有收到图，表情库没有变化。\]/);
});

test('收下这些 keeps at most the latest 10 and says so; the singular still keeps only the last picture', async t => {
  const f = fixture(t), { kept, picture } = pictures(f); await f.bridge.connection(true);
  for (let n = 1; n <= 12; n++) await f.bridge.receive(picture(110 + n, n));
  await f.bridge.receive(f.event(130, [{ type: 'text', data: { text: '收下它' } }]));
  assert.equal(kept.length, 1);
  const last = kept[0];
  await f.bridge.receive(f.event(131, [{ type: 'text', data: { text: '收下它们' } }]));
  assert.equal(kept.length, 11);
  assert.equal(kept.at(-1), last, 'the latest ten end with the last picture');
  assert.match(f.executions.at(-1).input.text, /收下最近的 10 张图：收进表情库 9 张（名字：[^）]+），本来就在库里 1 张，没能收进 0 张；一次最多收 10 张，更早的 2 张没有收。\]/);
});

test('收下这些 from anyone but the owner, in their own conversation, changes nothing', async t => {
  const f = fixture(t), { kept } = pictures(f);
  const call = f.bridge.onebot.call;
  f.bridge.onebot.call = async (action, params) => action === 'get_friend_list' ? [{ user_id: 300 }] : call(action, params);
  await f.bridge.connection(true);
  f.bridge.authority.admitPerson = async () => ({});
  const friend = (id, message) => ({ ...f.event(id, message), user_id: 300, sender: { user_id: 300 }, sub_type: 'friend' });
  await f.bridge.receive(friend(141, [{ type: 'image', data: { file: 'pic-1', sub_type: 1 } }]));
  await f.bridge.receive(friend(142, [{ type: 'image', data: { file: 'pic-2', sub_type: 1 } }]));
  await f.bridge.receive(friend(143, [{ type: 'text', data: { text: '这些都收下' } }]));
  assert.deepEqual(kept, []);
  for (const execution of f.executions) assert.doesNotMatch(execution.input.text, /表情库/);
});

test('收下这个 from anyone but the owner changes nothing; without the sticker switch the picture goes as an ordinary image', async t => {
  const f = fixture(t), kept = [];
  const call = f.bridge.onebot.call;
  f.bridge.onebot.call = async (action, params) => action === 'get_friend_list' ? [{ user_id: 300 }] : call(action, params);
  await f.bridge.connection(true);
  f.bridge.authority.admitPerson = async () => ({});
  const keep = f.bridge.media.keepSticker.bind(f.bridge.media);
  f.bridge.media.keepSticker = (scope, ref) => { kept.push(ref); return keep(scope, ref); };
  const friend = (id, message) => ({ ...f.event(id, message), user_id: 300, sender: { user_id: 300 }, sub_type: 'friend' });
  await f.bridge.receive(friend(61, [{ type: 'text', data: { text: '收下这个' } }, { type: 'image', data: { file: 'trusted-sticker', sub_type: 1 } }]));
  await f.bridge.receive(friend(62, [{ type: 'text', data: { text: '收下这个' } }]));
  assert.equal(f.executions.length, 2); assert.deepEqual(kept, []);
  for (const execution of f.executions) assert.doesNotMatch(execution.input.text, /表情库/);
  // The owner: with no picture lately she is told nothing changed.
  await f.bridge.receive(f.event(63, [{ type: 'text', data: { text: '收下这个' } }]));
  assert.match(f.executions.at(-1).input.text, /最近没有收到图，表情库没有变化/);
  await f.bridge.receive(f.event(64, [{ type: 'text', data: { text: '收下这张' } }, { type: 'image', data: { file: 'trusted-sticker', sub_type: 1 } }]));
  assert.equal(kept.length, 1);
  f.bridge.media.stickerSubType = false;
  f.executor.execute = async () => '给你[表情:合成测试表情]';
  await f.bridge.receive(f.event(65, [{ type: 'text', data: { text: '来一张' } }]));
  assert.deepEqual(f.sent.at(-1).message.map(segment => Object.keys(segment.data).sort()), [['file']]);
});

test('delivery report: after a turn the executor is told what really went out, part by part, sent only with a receipt', async t => {
  const f = fixture(t), reports = [], logs = []; await f.bridge.connection(true); f.bridge.log = line => logs.push(line);
  const replies = [];
  f.executor.execute = async request => { f.executions.push(request); return replies.shift(); };
  f.executor.delivered = async report => { reports.push(report); };
  const say = async (id, text, ...reply) => { replies.push(...reply); await f.bridge.receive(f.event(id, [{ type: 'text', data: { text } }])); return reports.at(-1).delivery.parts; };
  // Plain text, sent whole: one report for the run the executor stored, in this conversation's scope.
  assert.deepEqual(await say(81, '在吗', '在呢'), [{ kind: 'text', status: 'sent', chars: 2 }]);
  assert.deepEqual(reports, [{ scope: { streamId: 'qq:100:private:200', memoryEpoch: 0 }, requestId: f.executions[0].requestId, delivery: { parts: [{ kind: 'text', status: 'sent', chars: 2 }] } }]);
  // A library sticker: which picture, in the words the content service already had (a model's, so marked), under the
  // exact marker she wrote; a second marker is dropped and reported as not sent.
  replies.push('好可爱');
  await f.bridge.receive(f.event(82, [{ type: 'image', data: { file: 'trusted-sticker', sub_type: 1 } }]));
  await say(83, '收下这个', '收到');
  const looked = f.store.records().filter(r => r.kind === 'description').length;
  assert.deepEqual(await say(84, '考过了！', '好呀[表情: 合成测试表情 ] 嘿[表情:晚安]'), [{ kind: 'text', status: 'sent', chars: 4 }, { kind: 'sticker', status: 'sent', marker: '[表情: 合成测试表情 ]', description: '一张合成测试表情图', machine: true }, { kind: 'sticker', status: 'unsent', marker: '[表情:晚安]' }]);
  assert.equal(f.store.records().filter(r => r.kind === 'description').length, looked, 'nothing is looked at for the report');
  // Nothing in the library close to her word.
  assert.deepEqual(await say(85, '还在吗', '在呢[表情:犀牛潜水艇]'), [{ kind: 'text', status: 'sent', chars: 2 }, { kind: 'sticker', status: 'unsent', marker: '[表情:犀牛潜水艇]', reason: 'none' }]);
  // The content service failing to pick one: not sent, and not said to be missing.
  const pick = f.bridge.media.pickSticker; f.bridge.media.pickSticker = async () => { throw new Error('CONTENT_UNAVAILABLE'); };
  assert.deepEqual(await say(86, '嗯', '嗯嗯[表情:合成测试表情]'), [{ kind: 'text', status: 'sent', chars: 2 }, { kind: 'sticker', status: 'unsent', marker: '[表情:合成测试表情]' }]);
  f.bridge.media.pickSticker = pick;
  // A voice reply: voice, and its sticker is not sent. A failed synthesis: text in place of voice.
  assert.deepEqual(await say(87, '请用语音说晚安', '晚安[表情:合成测试表情]'), [{ kind: 'voice', status: 'sent' }, { kind: 'sticker', status: 'unsent', marker: '[表情:合成测试表情]' }]);
  const synthesize = f.service.speech.synthesize; f.service.speech.synthesize = async () => { throw new Error('TTS_UNAVAILABLE'); };
  const fallback = await say(88, '请用语音再说一遍', '晚安');
  assert.deepEqual(fallback, [{ kind: 'text', status: 'sent', chars: f.sent.at(-1).message[0].data.text.length, fallback: 'voice' }]);
  f.service.speech.synthesize = synthesize;
  // A split reply whose second message gets no receipt: delivered, unknown, never tried. The sticker after them too.
  const sentence = n => `这是第${n}句话，它的长度刚好让两句放不进同一条消息里面去，所以一句一条。`, call = f.bridge.onebot.call;
  let sends = 0;
  f.bridge.onebot.call = async (action, params) => { if (action === 'send_private_msg' && ++sends === 2) throw new Error('ONEBOT_DELIVERY_UNKNOWN'); return call(action, params); };
  assert.deepEqual(await say(89, '说长一点', sentence(1) + sentence(2) + sentence(3) + '[表情:合成测试表情]'), [{ kind: 'text', status: 'sent', chars: sentence(1).length }, { kind: 'text', status: 'unknown', chars: sentence(2).length }, { kind: 'text', status: 'unsent', chars: sentence(3).length }, { kind: 'sticker', status: 'unsent', marker: '[表情:合成测试表情]', description: '一张合成测试表情图', machine: true }]);
  assert.equal(Object.values(f.bridge.state.records).at(-1).status, 'partial_unknown');
  f.bridge.onebot.call = call;
  // The reply was made but the conversation moved on before anything was sent (a new memory epoch): nothing went out.
  const context = f.bridge.authority.context;
  f.executor.execute = async request => { f.executions.push(request); f.bridge.authority.context = async () => ({ entityId: 'entity:test', memoryEpoch: 4 }); return '过期的回复[表情:合成测试表情]'; };
  await f.bridge.receive(f.event(90, [{ type: 'text', data: { text: '在吗' } }]));
  assert.deepEqual(reports.at(-1).delivery.parts, [{ kind: 'text', status: 'unsent' }, { kind: 'sticker', status: 'unsent', marker: '[表情:合成测试表情]' }]);
  assert.equal(reports.at(-1).scope.memoryEpoch, 0);
  f.bridge.authority.context = context; f.executor.execute = async request => { f.executions.push(request); return replies.shift(); };
  // One report per run, each for the run just executed.
  assert.deepEqual(reports.map(report => report.requestId), f.executions.map(execution => execution.requestId));
  // A report the executor refuses or cannot take changes nothing about the turn: one log line without content.
  f.executor.delivered = async () => { throw Object.assign(new Error('DELIVERY_NOT_CURRENT'), { code: 'DELIVERY_NOT_CURRENT' }); };
  const before = f.sent.length; logs.length = 0;
  replies.push('还在'); await f.bridge.receive(f.event(91, [{ type: 'text', data: { text: '还在吗' } }]));
  assert.deepEqual([f.sent.length - before, Object.values(f.bridge.state.records).at(-1).status, logs], [1, 'sent', ['qq delivery report: DELIVERY_NOT_CURRENT']]);
  // A backend that keeps no such record is told nothing.
  delete f.executor.delivered; logs.length = 0;
  replies.push('嗯'); await f.bridge.receive(f.event(92, [{ type: 'text', data: { text: '好' } }]));
  assert.deepEqual([Object.values(f.bridge.state.records).at(-1).status, logs], ['sent', []]);
});

test('delivery echo: what she writes in imitation of her replayed delivery lines never reaches the chat; a message left empty is not sent', async t => {
  const f = fixture(t), reports = [], logs = [], replies = []; await f.bridge.connection(true); f.bridge.log = line => logs.push(line);
  f.executor.execute = async request => { f.executions.push(request); return replies.shift(); };
  f.executor.delivered = async report => { reports.push(report); };
  const say = async (id, reply) => { const before = f.sent.length; logs.length = 0; replies.push(reply); await f.bridge.receive(f.event(id, [{ type: 'text', data: { text: '在吗' } }])); return f.sent.slice(before).map(p => p.message[0].data.text); };
  assert.deepEqual(await say(101, '好呀[表情包：一只打哈欠的猫（机器描述）] 嘿\n[送达情况：这条是用语音发出的]'), ['好呀 嘿']);
  assert.deepEqual(logs, ['qq delivery echo stripped']);
  assert.deepEqual(f.observed.at(-1).text, '好呀 嘿');
  assert.deepEqual(reports.at(-1).delivery.parts, [{ kind: 'text', status: 'sent', chars: 4 }]);
  // Full-width brackets and the other colon; a description is never read as a sticker word.
  assert.deepEqual(await say(102, '在呢［表情包:开心］[表情包 : 没发出]［送达情况:拆成 2 条发］'), ['在呢']);
  assert.equal(f.sent.at(-1).message.length, 1);
  // A paragraph that was only such a piece is not sent as an empty message.
  assert.deepEqual(await say(103, '第一段。\n\n[送达情况：这条回复没有发出]\n\n第二段。'), ['第一段。', '第二段。']);
  // Nothing else in the reply: nothing is sent, and the report says so.
  assert.deepEqual(await say(104, '[表情包：已发出，没有描述]'), []);
  assert.deepEqual(logs, ['qq delivery echo stripped']);
  assert.deepEqual(reports.at(-1).delivery.parts, [{ kind: 'text', status: 'unsent' }]);
  // Ordinary brackets, small faces and her real marker are untouched; no log line.
  assert.deepEqual(await say(105, '[微笑]表情包：这个词不在括号里（歪头）[表情:犀牛潜水艇]'), ['[微笑]表情包：这个词不在括号里（歪头）']);
  assert.deepEqual(logs, []);
});

test('small faces off (QQ\'s declaration by default): her [微笑] goes out as plain text in her message, no face segment', async t => {
  const f = fixture(t); await f.bridge.connection(true);
  assert.equal(f.bridge.media.faces, false);
  f.executor.execute = async () => '收到[微笑]';
  await f.bridge.receive(f.event(70, [{ type: 'text', data: { text: '哈哈' } }, { type: 'face', data: { id: '14' } }]));
  assert.deepEqual(f.sent.map(p => p.message), [[{ type: 'text', data: { text: '收到[微笑]' } }]]);
  assert.equal(f.observed.at(-1).text, '收到[微笑]');
});
