import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createContentOperator } from './operator.js';
import { createContentServer } from './server.mjs';
import { trustedReference } from '../speech/config.js';

function wave(seconds = 3, channels = 1) {
  const size = 16000 * 2 * seconds * channels, b = Buffer.alloc(44 + size);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40); return b;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-content-operator-'))), workRoot = path.join(root, 'work');
  fs.mkdirSync(path.join(workRoot, 'reference'), { recursive: true });
  const models = { asr: { default: { id: 'asr-default', engine: 'fake-only', files: {} }, fast: { id: 'asr-fast', engine: 'fake-only', files: {} } }, tts: { 'llama-tts': { id: 'tts-qwen3', engine: 'llama-tts' } } };
  const configFile = path.join(root, 'speech.json'), config = { schemaVersion: 2, nodeExecutable: process.execPath, sherpaModule: path.join(root, 'fake-sherpa.js'), workRoot, inputRoots: [root], numThreads: 8, timeoutMs: 180000, maxTextChars: 120, maxAudioSeconds: 30, maxFastAudioSeconds: 120, defaultVoice: null, voiceProfiles: {}, models };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  let world = { paused: true, revision: 3 }, synth, calls = 0, removeFile = file => fs.unlinkSync(file);
  const runner = { status: () => ({ models: Object.fromEntries(['asr:default', 'asr:fast', 'tts:llama-tts'].map(key => [key, { model: key.replace(':', '-'), componentsPresent: true, enabled: true, verified: true, secretPath: '/must-not-leak', apiKey: 'must-not-leak' }])) }), synthesize: async args => { calls++; if (synth) return synth(args); fs.writeFileSync(args.outputFile, wave()); return { model: 'tts-qwen3' }; } };
  const worldStatus = async () => world;
  const operator = createContentOperator({ speechConfigFile: configFile, worldStatus, speechFactory: () => runner, unlinkReference: file => removeFile(file) });
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^fish-content-operator-/); fs.rmSync(root, { recursive: true }); });
  return { root, workRoot, configFile, operator, worldStatus, setWorld: value => { world = value; }, setSynth: value => { synth = value; }, setUnlink: value => { removeFile = value; }, calls: () => calls };
}
const upload = (status, voiceId, extra = {}) => ({ action: 'reference', worldRevision: 3, expectedRevision: status.speech.configurationRevision, voiceId, label: '合成测试音色 ' + voiceId, language: 'ja', usageScope: 'private', authorized: true, transcript: '操作人提供并确认的参考文本。' + voiceId, audioBase64: wave().toString('base64'), ...extra });
const request = (socketPath, token, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body)), req = http.request({ socketPath, path: '/operator', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': data.length } }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(raw) })); }); req.on('error', reject); req.end(data);
});

test('private operator status is safe and read-only; settings need pause, known fields and configuration CAS', async t => {
  const f = fixture(t), before = fs.readFileSync(f.configFile), token = 'synthetic-content-control-token-not-real', tokenFile = path.join(f.root, 'control.token'), socketPath = path.join(f.root, 'operator.sock'); fs.writeFileSync(tokenFile, token);
  const app = createContentServer({ socketPath, tokenFile, worldStatus: f.worldStatus, service: { call: () => { throw Error('model route not used'); } }, operatorCall: f.operator.call });
  await app.start(); t.after(() => app.close());
  f.setWorld({ paused: false, revision: 3 });
  const response = await request(socketPath, token, { action: 'status' }); assert.equal(response.status, 200);
  const status = response.value.value; assert.equal(status.voices.defaultVoice, null); assert.deepEqual(status.voices.profiles, []); assert.equal(status.voices.transcriptUsedForSynthesis, false); assert.deepEqual(Object.keys(status.speech.models), ['asr:default', 'asr:fast', 'tts:llama-tts']); assert.equal(JSON.stringify(status).includes('must-not-leak'), false); assert.deepEqual(fs.readFileSync(f.configFile), before);
  const configure = { action: 'configure', expectedRevision: status.speech.configurationRevision, worldRevision: 3, numThreads: 16, maxTextChars: 64 };
  const { worldRevision: _pinned, ...unpinned } = configure;
  assert.equal((await request(socketPath, token, configure)).status, 409);
  assert.equal((await request(socketPath, token, unpinned)).status, 409);
  f.setWorld({ paused: true, revision: 3 });
  await assert.rejects(f.operator.call({ ...configure, executable: '/untrusted' }), { statusCode: 400 });
  await assert.rejects(f.operator.call({ ...configure, numThreads: 17 }), { statusCode: 400 });
  await assert.rejects(f.operator.call({ ...configure, expectedRevision: 'stale' }), { statusCode: 409 });
  const updated = await f.operator.call(configure); assert.notEqual(updated.speech.configurationRevision, status.speech.configurationRevision); assert.equal(updated.speech.numThreads, 16); assert.equal(updated.speech.maxTextChars, 64);
  // worldRevision is optional; a supplied stale one still conflicts.
  await assert.rejects(f.operator.call({ ...configure, expectedRevision: updated.speech.configurationRevision, worldRevision: 2 }), { code: 'CONTENT_OPERATOR_WORLD_CONFLICT', statusCode: 409 });
  const unpinnedResult = await request(socketPath, token, { ...unpinned, expectedRevision: updated.speech.configurationRevision, maxTextChars: 32 });
  assert.equal(unpinnedResult.status, 200); assert.equal(unpinnedResult.value.value.speech.maxTextChars, 32);
});

test('voices are registered, listed, made default and removed with pending cleanup', async t => {
  const f = fixture(t), status = await f.operator.call({ action: 'status' });
  await assert.rejects(f.operator.call({ ...upload(status, 'actress'), authorized: false }), { statusCode: 400 });
  await assert.rejects(f.operator.call({ ...upload(status, 'actress'), audioBase64: wave(3, 2).toString('base64') }), { code: 'CONTENT_OPERATOR_AUDIO_INVALID' });
  await assert.rejects(f.operator.call(upload(status, '../escape')), { code: 'CONTENT_OPERATOR_INPUT' });
  await assert.rejects(f.operator.call(upload(status, 'actress', { usageScope: 'everyone' })), { code: 'CONTENT_OPERATOR_INPUT' });
  await assert.rejects(f.operator.call(upload(status, 'actress', { referencePath: '/untrusted.wav' })), { code: 'CONTENT_OPERATOR_INPUT' });
  assert.deepEqual(fs.readdirSync(path.join(f.workRoot, 'reference')), []);
  const first = await f.operator.call(upload(status, 'actress'));
  assert.equal(first.voices.defaultVoice, 'actress'); assert.equal(JSON.stringify(first).includes('参考文本'), false); assert.equal(JSON.stringify(first).includes(f.workRoot), false);
  assert.deepEqual(first.voices.profiles, [{ id: 'actress', label: '合成测试音色 actress', engine: 'llama-tts', referenceLanguage: 'ja', usageScope: 'private', useReferenceText: false, auditioned: false, hasReference: true }]);
  await assert.rejects(f.operator.call(upload(first, 'actress')), { code: 'CONTENT_OPERATOR_VOICE_EXISTS', statusCode: 409 });
  const second = await f.operator.call(upload(first, 'synthetic', { usageScope: 'public', language: 'zh' }));
  assert.equal(second.voices.defaultVoice, 'actress'); assert.deepEqual(second.voices.profiles.map(p => [p.id, p.usageScope]), [['actress', 'private'], ['synthetic', 'public']]);
  const config = JSON.parse(fs.readFileSync(f.configFile)), { manifest } = trustedReference(config, config.voiceProfiles.synthetic);
  assert.equal(manifest.voiceId, 'synthetic'); assert.equal(config.voiceProfiles.synthetic.referenceTranscript, manifest.transcript);
  await assert.rejects(f.operator.call({ action: 'setDefaultVoice', expectedRevision: second.speech.configurationRevision, voiceId: 'nobody' }), { code: 'CONTENT_OPERATOR_VOICE_MISSING' });
  const switched = await f.operator.call({ action: 'setDefaultVoice', expectedRevision: second.speech.configurationRevision, voiceId: 'synthetic' });
  assert.equal(switched.voices.defaultVoice, 'synthetic');
  const actressFile = config.voiceProfiles.actress.referencePath;
  const remove = { action: 'removeReference', expectedRevision: switched.speech.configurationRevision, voiceId: 'actress', confirmed: true, worldRevision: 3 };
  await assert.rejects(f.operator.call({ ...remove, confirmed: false }), { statusCode: 400 });
  let deletions = 0;
  f.setUnlink(target => { if (++deletions === 2) throw Error('simulated private unlink failure'); fs.unlinkSync(target); });
  await assert.rejects(f.operator.call(remove), { code: 'CONTENT_OPERATOR_UNAVAILABLE', statusCode: 503 });
  const pending = await f.operator.call({ action: 'status' });
  assert.equal(pending.voices.cleanupPending, true); assert.deepEqual(pending.voices.profiles.map(p => p.id), ['synthetic']);
  assert.equal(fs.existsSync(actressFile), false); assert.equal(fs.existsSync(actressFile + '.json'), true);
  await assert.rejects(f.operator.call(upload(pending, 'another')), { code: 'CONTENT_OPERATOR_REFERENCE_CLEANUP_PENDING', statusCode: 409 });
  f.setUnlink(target => fs.unlinkSync(target));
  const cleaned = await f.operator.call({ action: 'removeReference', expectedRevision: pending.speech.configurationRevision, confirmed: true });
  assert.equal(cleaned.voices.cleanupPending, false); assert.equal(fs.existsSync(actressFile + '.json'), false); assert.equal(cleaned.voices.defaultVoice, 'synthetic');
  // Removing the default leaves no default voice until the operator picks one.
  const none = await f.operator.call({ action: 'removeReference', expectedRevision: cleaned.speech.configurationRevision, voiceId: 'synthetic', confirmed: true });
  assert.equal(none.voices.defaultVoice, null); assert.deepEqual(none.voices.profiles, []); assert.deepEqual(fs.readdirSync(path.join(f.workRoot, 'reference')), []);
  await assert.rejects(f.operator.call({ action: 'removeReference', expectedRevision: none.speech.configurationRevision, voiceId: 'synthetic', confirmed: true }), { code: 'CONTENT_OPERATOR_VOICE_MISSING' });
});

test('local audition names a voice, has no external action, cleans output and excludes concurrent mutations until cancelled', async t => {
  const f = fixture(t), registered = await f.operator.call(upload(await f.operator.call({ action: 'status' }), 'actress'));
  let seen; f.setSynth(async args => { seen = args; fs.writeFileSync(args.outputFile, wave()); return { model: 'tts-qwen3' }; });
  const result = await f.operator.call({ action: 'test', voiceId: 'actress', worldRevision: 3 });
  assert.equal(result.mime, 'audio/wav'); assert.equal(result.model, 'tts-qwen3'); assert.equal(result.voiceId, 'actress'); assert.equal(result.transcriptUsedForSynthesis, false); assert.equal(seen.voiceProfile, 'actress'); assert.equal(seen.audience, 'private');
  assert.equal(Buffer.from(result.audioBase64, 'base64').length, wave().length); assert.equal(fs.readdirSync(f.workRoot).some(x => x.startsWith('tts-')), false);
  await assert.rejects(f.operator.call({ action: 'test', voiceId: 'nobody', worldRevision: 3 }), { code: 'CONTENT_OPERATOR_VOICE_MISSING' });
  await assert.rejects(f.operator.call({ action: 'test', quality: 'heavy', worldRevision: 3 }), { statusCode: 400 });
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.setSynth(async args => { fs.writeFileSync(args.outputFile, wave()); started(); await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(Error('private error never reflected'), { code: 'SPEECH_CANCELLED' }); });
  const controller = new AbortController(), pending = f.operator.call({ action: 'test', voiceId: 'actress', worldRevision: 3 }, { signal: controller.signal });
  await ready;
  await assert.rejects(f.operator.call({ action: 'removeReference', expectedRevision: registered.speech.configurationRevision, voiceId: 'actress', confirmed: true, worldRevision: 3 }), { code: 'CONTENT_OPERATOR_BUSY', statusCode: 409 });
  controller.abort(); await assert.rejects(pending, { code: 'CONTENT_OPERATOR_UNAVAILABLE', statusCode: 503 }); assert.equal(fs.readdirSync(f.workRoot).some(x => x.startsWith('tts-')), false); assert.equal(f.calls(), 2);
});
