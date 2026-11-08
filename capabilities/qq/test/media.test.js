import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../media/artifacts.js';
import { MediaService } from '../../media/service.js';
import { QQMedia, explicitSpeechRequested } from '../media.js';
import { QQBridge } from '../bridge.js';

function wav() {
  const b = Buffer.alloc(44 + 3200); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
function fixture(t) {
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
  const bridge = new QQBridge({ authority: { health: async () => ({ world: { paused: false, revision: 1 } }), context: async () => ({ entityId: scope.entityId, memoryEpoch: 0 }) }, port: { observe: async value => { observed.push(value); return { observationId: 'synthetic-observation' }; } }, onebot, executor, media: new QQMedia({ content, onebot }), settingsFile, stateFile: path.join(root, 'dispatch.json') });
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
