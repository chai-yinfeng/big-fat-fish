import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createContentOperator } from './operator.js';
import { createContentServer } from './server.mjs';
import { REFERENCE_TEXT, trustedReference } from '../speech/config.js';

function wave(seconds = 3, channels = 1) {
  const size = 16000 * 2 * seconds * channels, b = Buffer.alloc(44 + size);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40); return b;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-content-operator-'))), workRoot = path.join(root, 'work');
  fs.mkdirSync(path.join(workRoot, 'reference'), { recursive: true });
  const reference = path.join(workRoot, 'reference/default.wav'), data = wave(); fs.writeFileSync(reference, data);
  fs.writeFileSync(reference + '.json', JSON.stringify({ schemaVersion: 1, origin: 'kokoro-local', model: 'tts-light', text: REFERENCE_TEXT, speakerId: 0, sha256: createHash('sha256').update(data).digest('hex') }));
  const models = Object.fromEntries(['asr', 'tts'].map(kind => [kind, Object.fromEntries(['light', 'heavy'].map(quality => [quality, { id: kind + '-' + quality, engine: 'fake-only', files: {} }]))]));
  const configFile = path.join(root, 'speech.json'), config = { schemaVersion: 1, nodeExecutable: process.execPath, sherpaModule: path.join(root, 'fake-sherpa.js'), workRoot, inputRoots: [root], numThreads: 2, timeoutMs: 180000, maxTextChars: 120, maxAudioSeconds: 120, maxHeavyAudioSeconds: 30, models, voiceProfiles: { default: { referencePath: reference, referenceOrigin: 'kokoro-local', speakerId: 0, language: 'zh' } } };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  let world = { paused: true, revision: 3 }, synth, calls = 0, removeFile = file => fs.unlinkSync(file);
  const runner = { status: () => ({ models: Object.fromEntries(['asr:light', 'asr:heavy', 'tts:light', 'tts:heavy'].map(key => [key, { model: key.replace(':', '-'), componentsPresent: true, enabled: true, verified: true, secretPath: '/must-not-leak', apiKey: 'must-not-leak' }])) }), synthesize: async args => { calls++; if (synth) return synth(args); fs.writeFileSync(args.outputFile, wave()); return { model: 'tts-heavy' }; } };
  const worldStatus = async () => world;
  const operator = createContentOperator({ speechConfigFile: configFile, worldStatus, speechFactory: () => runner, unlinkReference: file => removeFile(file) });
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^fish-content-operator-/); fs.rmSync(root, { recursive: true }); });
  return { root, workRoot, configFile, reference, operator, worldStatus, setWorld: value => { world = value; }, setSynth: value => { synth = value; }, setUnlink: value => { removeFile = value; }, calls: () => calls };
}
const request = (socketPath, token, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body)), req = http.request({ socketPath, path: '/operator', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': data.length } }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(raw) })); }); req.on('error', reject); req.end(data);
});

test('private operator status is safe and read-only; settings need pause, known fields and configuration CAS', async t => {
  const f = fixture(t), before = fs.readFileSync(f.configFile), token = 'synthetic-content-control-token-not-real', tokenFile = path.join(f.root, 'control.token'), socketPath = path.join(f.root, 'operator.sock'); fs.writeFileSync(tokenFile, token);
  const app = createContentServer({ socketPath, tokenFile, worldStatus: f.worldStatus, service: { call: () => { throw Error('model route not used'); } }, operatorCall: f.operator.call });
  await app.start(); t.after(() => app.close());
  f.setWorld({ paused: false, revision: 3 });
  const response = await request(socketPath, token, { action: 'status' }); assert.equal(response.status, 200);
  const status = response.value.value; assert.equal(status.speech.defaultTtsQuality, 'heavy'); assert.equal(status.voice.hasReference, true); assert.equal(status.voice.transcriptUsedForSynthesis, false); assert.equal(JSON.stringify(status).includes('must-not-leak'), false); assert.deepEqual(fs.readFileSync(f.configFile), before);
  const configure = { action: 'configure', expectedRevision: status.speech.configurationRevision, worldRevision: 3, defaultTtsQuality: 'heavy', numThreads: 1, maxTextChars: 64 };
  const { worldRevision: _pinned, ...unpinned } = configure;
  assert.equal((await request(socketPath, token, configure)).status, 409);
  assert.equal((await request(socketPath, token, unpinned)).status, 409);
  f.setWorld({ paused: true, revision: 3 });
  await assert.rejects(f.operator.call({ ...configure, executable: '/untrusted' }), { statusCode: 400 });
  await assert.rejects(f.operator.call({ ...configure, expectedRevision: 'stale' }), { statusCode: 409 });
  const updated = await f.operator.call(configure); assert.notEqual(updated.speech.configurationRevision, status.speech.configurationRevision); assert.equal(updated.speech.numThreads, 1); assert.equal(updated.speech.maxTextChars, 64);
  // worldRevision is optional; a supplied stale one still conflicts.
  await assert.rejects(f.operator.call({ ...configure, expectedRevision: updated.speech.configurationRevision, worldRevision: 2 }), { code: 'CONTENT_OPERATOR_WORLD_CONFLICT', statusCode: 409 });
  const unpinnedResult = await request(socketPath, token, { ...unpinned, expectedRevision: updated.speech.configurationRevision, maxTextChars: 32 });
  assert.equal(unpinnedResult.status, 200); assert.equal(unpinnedResult.value.value.speech.maxTextChars, 32);
});

test('authorized PCM reference registration and explicit removal preserve the original synthetic voice', async t => {
  const f = fixture(t), status = await f.operator.call({ action: 'status' });
  const upload = { action: 'reference', worldRevision: 3, expectedRevision: status.speech.configurationRevision, authorized: true, transcript: '这是由操作人提供并确认的参考文本。', audioBase64: wave().toString('base64') };
  await assert.rejects(f.operator.call({ ...upload, authorized: false }), { statusCode: 400 });
  await assert.rejects(f.operator.call({ ...upload, audioBase64: wave(3, 2).toString('base64') }), { code: 'CONTENT_OPERATOR_AUDIO_INVALID' });
  assert.deepEqual(fs.readdirSync(path.dirname(f.reference)).sort(), ['default.wav', 'default.wav.json']);
  const registered = await f.operator.call(upload), current = JSON.parse(fs.readFileSync(f.configFile));
  assert.equal(registered.voice.origin, 'operator-authorized'); assert.equal(registered.voice.hasReference, true); assert.equal(JSON.stringify(registered).includes(upload.transcript), false);
  const { file, manifest } = trustedReference(current); assert.equal(manifest.transcript, upload.transcript); assert.equal(current.voiceProfiles.default.syntheticReference.referencePath, f.reference);
  await assert.rejects(f.operator.call({ ...upload, expectedRevision: registered.speech.configurationRevision }), { statusCode: 409 });
  const remove = { action: 'removeReference', expectedRevision: registered.speech.configurationRevision, confirmed: true, worldRevision: 3 };
  await assert.rejects(f.operator.call({ ...remove, confirmed: false }), { statusCode: 400 });
  let deletions = 0;
  f.setUnlink(target => { if (++deletions === 2) throw Error('simulated private unlink failure'); fs.unlinkSync(target); });
  await assert.rejects(f.operator.call(remove), { code: 'CONTENT_OPERATOR_UNAVAILABLE', statusCode: 503 });
  const pending = await f.operator.call({ action: 'status' });
  assert.equal(pending.voice.origin, 'kokoro-local'); assert.equal(pending.voice.hasReference, true); assert.equal(pending.voice.cleanupPending, true); assert.equal(JSON.stringify(pending).includes(file), false);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + '.json'), true);
  await assert.rejects(f.operator.call({ ...upload, expectedRevision: pending.speech.configurationRevision }), { code: 'CONTENT_OPERATOR_REFERENCE_CLEANUP_PENDING', statusCode: 409 });
  f.setUnlink(target => fs.unlinkSync(target));
  const restored = await f.operator.call({ ...remove, expectedRevision: pending.speech.configurationRevision });
  assert.equal(restored.voice.origin, 'kokoro-local'); assert.equal(restored.voice.hasReference, true); assert.equal(restored.voice.cleanupPending, false); assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + '.json'), false); assert.equal(fs.existsSync(f.reference), true);
});

test('public local test has no external action, cleans output and excludes concurrent mutations until cancelled', async t => {
  const f = fixture(t), result = await f.operator.call({ action: 'test', quality: 'heavy', worldRevision: 3 });
  assert.equal(result.mime, 'audio/wav'); assert.equal(result.model, 'tts-heavy'); assert.equal(result.transcriptUsedForSynthesis, false); assert.equal(Buffer.from(result.audioBase64, 'base64').length, wave().length); assert.equal(fs.readdirSync(f.workRoot).some(x => x.startsWith('tts-')), false);
  await assert.rejects(f.operator.call({ action: 'test', quality: 'light', worldRevision: 3 }), { statusCode: 400 });
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.setSynth(async args => { fs.writeFileSync(args.outputFile, wave()); started(); await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(Error('private error never reflected'), { code: 'SPEECH_CANCELLED' }); });
  const controller = new AbortController(), pending = f.operator.call({ action: 'test', quality: 'heavy', worldRevision: 3 }, { signal: controller.signal });
  await ready;
  await assert.rejects(f.operator.call({ action: 'removeReference', expectedRevision: 'unused', confirmed: true, worldRevision: 3 }), { code: 'CONTENT_OPERATOR_BUSY', statusCode: 409 });
  controller.abort(); await assert.rejects(pending, { code: 'CONTENT_OPERATOR_UNAVAILABLE', statusCode: 503 }); assert.equal(fs.readdirSync(f.workRoot).some(x => x.startsWith('tts-')), false); assert.equal(f.calls(), 2);
});
