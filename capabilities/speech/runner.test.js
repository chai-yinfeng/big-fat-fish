import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalSpeechRunner } from './runner.js';
import { loadSpeechConfig, resolveVoice, trustedReference } from './config.js';
import { prepareSpeech } from '../../deploy/authority/prepare-speech.mjs';

function wave(dataBytes = 640, rate = 16000) {
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  return wav;
}
const voice = (id, usageScope, referencePath = '/unused/' + id + '.wav') => ({ id, label: 'Synthetic ' + id, engine: 'test-only', referencePath, referenceTranscript: 'synthetic transcript', referenceLanguage: 'ja', useReferenceText: false, usageScope });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-speech-'));
  for (const name of ['operator', 'media-data', 'speech-data']) fs.mkdirSync(path.join(root, name));
  const prepared = prepareSpeech(root, path.join(root, 'runtime'));
  assert.equal(prepared.modelsInstalled, false);
  const configFile = path.join(root, 'operator/speech.json'), c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(c.schemaVersion, 2); assert.equal(c.numThreads, 8); assert.equal(c.defaultVoice, null); assert.deepEqual(c.voiceProfiles, {});
  assert.equal(c.models.asr.default.engine, 'sherpa-qwen3-asr'); assert.deepEqual(Object.keys(c.models.asr), ['default']); assert.equal(Object.hasOwn(c, 'maxFastAudioSeconds'), false); assert.deepEqual(Object.keys(c.models.tts), ['llama-tts']);
  assert.equal(Object.hasOwn(c.models.tts, 'light'), false);
  const component = path.join(root, 'synthetic.component'); fs.writeFileSync(component, 'synthetic');
  c.sherpaModule = component;
  c.models.asr.default = { id: 'asr-default', engine: 'test-only', files: { model: component } };
  c.models.tts = { 'test-only': { id: 'tts-test', engine: 'test-only', files: { model: component } } };
  c.voiceProfiles = { actress: voice('actress', 'private'), synthetic: voice('synthetic', 'public') };
  c.defaultVoice = 'actress';
  fs.writeFileSync(configFile, JSON.stringify(c));
  const wav = wave();
  const inputFile = path.join(root, 'media-data/input.wav'); fs.writeFileSync(inputFile, wav);
  const workerFile = path.join(root, 'fake-worker.mjs');
  fs.writeFileSync(workerFile, `import fs from 'node:fs';import path from 'node:path';const c=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));let raw='';for await(const b of process.stdin)raw+=b;const j=JSON.parse(raw);if(j.language==='en'){process.stderr.write('synthetic-secret-and-private-input');process.exit(3);}const trace=path.join(c.workRoot,'trace');fs.appendFileSync(trace,'start '+(j.voiceProfile||j.quality)+'\\n');await new Promise(r=>setTimeout(r,j.text==='cancelled synthetic speech'?1000:15));if(j.kind==='tts')fs.copyFileSync(path.join(c.inputRoots[0],'input.wav'),j.outputFile);fs.appendFileSync(trace,'end\\n');const model=j.kind==='asr'?c.models.asr[j.quality].id:c.models.tts[c.voiceProfiles[j.voiceProfile].engine].id;process.stdout.write(JSON.stringify({ok:true,value:{model,text:'synthetic transcript',durationMs:j.kind==='asr'?Math.round((fs.statSync(j.inputFile).size-44)/fs.readFileSync(j.inputFile).readUInt32LE(28)*1000):20,sampleRate:16000,complete:true}}));`);
  t.after(() => { const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.match(path.basename(real), /^companion-speech-/); fs.rmSync(real, { recursive: true }); });
  return { root, configFile, c, inputFile, wav, runner: createLocalSpeechRunner({ configFile, workerFile }) };
}

test('trusted speech paths stay in input/work roots, including symlink escapes; preparation installs nothing', async t => {
  const { root, inputFile, wav, runner } = fixture(t);
  const outside = path.join(root, 'outside.wav'); fs.writeFileSync(outside, wav);
  const link = path.join(root, 'media-data/link.wav'); fs.symlinkSync(outside, link);
  await assert.rejects(runner.transcribe({ inputFile: outside }), { code: 'SPEECH_PATH' });
  await assert.rejects(runner.transcribe({ inputFile: link }), { code: 'SPEECH_PATH' });
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: path.join(root, 'out.wav') }), { code: 'SPEECH_PATH' });
  assert.equal(fs.existsSync(path.join(root, 'speech-data/trace')), false);
  assert.equal(fs.existsSync(inputFile), true);
});

test('one selected child runs at a time; Qwen3-ASR only, audio over its cap is a clear error with no fallback', async t => {
  const { root, runner, configFile, c, inputFile, wav } = fixture(t);
  const results = await Promise.all([runner.transcribe({ inputFile }), runner.transcribe({ inputFile })]);
  assert.ok(results.every(x => x.derived && x.model === 'asr-default'));
  assert.equal(fs.readFileSync(path.join(root, 'speech-data/trace'), 'utf8'), 'start default\nend\nstart default\nend\n');
  const long = Buffer.alloc(44 + 24000 * 2 * 31); wav.copy(long, 0, 0, 44);
  long.writeUInt32LE(long.length - 8, 4); long.writeUInt32LE(24000, 24); long.writeUInt32LE(48000, 28); long.writeUInt32LE(long.length - 44, 40);
  const at24k = path.join(root, 'media-data/31-seconds-at-24k.wav'); fs.writeFileSync(at24k, long);
  await assert.rejects(runner.transcribe({ inputFile: at24k }), { code: 'SPEECH_AUDIO_LIMIT' });
  await assert.rejects(runner.transcribe({ inputFile: at24k, quality: 'fast' }), { code: 'SPEECH_AUDIO_LIMIT' });
  assert.deepEqual(Object.keys(runner.status().models), ['asr:default', 'tts:test-only']);
  c.models.asr.default.files.model = path.join(root, 'missing-model'); fs.writeFileSync(configFile, JSON.stringify(c));
  await assert.rejects(runner.transcribe({ inputFile }), { code: 'SPEECH_NOT_CONFIGURED' });
  assert.equal(runner.status().models['asr:default'].componentsPresent, false);
  c.models.tts['test-only'].enabled = false; fs.writeFileSync(configFile, JSON.stringify(c));
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: path.join(root, 'speech-data/disabled.wav') }), { code: 'SPEECH_MODEL_DISABLED' });
  assert.equal(runner.status().models['tts:test-only'].enabled, false);
});

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
test('audio over 30 s needs the VAD model; maxAudioSeconds (<=600) caps it, and a pre-VAD config still loads', async t => {
  const { root, runner, configFile, c, wav } = fixture(t);
  const seconds = n => { const b = Buffer.alloc(44 + 16000 * 2 * n); wav.copy(b, 0, 0, 44); b.writeUInt32LE(b.length - 8, 4); b.writeUInt32LE(b.length - 44, 40); const file = path.join(root, `media-data/${n}s.wav`); fs.writeFileSync(file, b); return file; };
  const s61 = seconds(61), s121 = seconds(121);
  assert.equal(c.maxAudioSeconds, 120); assert.equal(c.models.vad.engine, 'sherpa-silero-vad');
  // Prepared config names the VAD, but its file is not installed yet: one pass only, with a hint.
  await assert.rejects(runner.transcribe({ inputFile: s61 }), { code: 'SPEECH_AUDIO_LIMIT' });
  assert.deepEqual({ ...runner.status().longAudio, hint: undefined }, { vadPresent: false, singlePassSeconds: 30, maxAudioSeconds: 30, timeoutMs: 180000, hint: undefined });
  assert.match(runner.status().longAudio.hint, /SPEECH_VAD_NOT_INSTALLED.*--models vad/);
  write(configFile, { ...c, models: { ...c.models, vad: { ...c.models.vad, file: c.sherpaModule } } });
  assert.equal((await runner.transcribe({ inputFile: s61 })).durationMs, 61000);
  assert.deepEqual(runner.status().longAudio, { vadPresent: true, singlePassSeconds: 30, maxAudioSeconds: 120, timeoutMs: 180000 });
  await assert.rejects(runner.transcribe({ inputFile: s121 }), { code: 'SPEECH_AUDIO_LIMIT' });
  write(configFile, { ...c, models: { ...c.models, vad: { ...c.models.vad, file: c.sherpaModule, enabled: false } } });
  await assert.rejects(runner.transcribe({ inputFile: s61 }), { code: 'SPEECH_AUDIO_LIMIT' });
  // A production config prepared before long-audio support: no models.vad, maxAudioSeconds 30.
  const { vad, ...models } = c.models;
  write(configFile, { ...c, models, maxAudioSeconds: 30 }); assert.equal(loadSpeechConfig(configFile).models.vad, undefined);
  for (const bad of [{ ...c, maxAudioSeconds: 601 }, { ...c, models: { ...c.models, vad: { ...vad, engine: 'other' } } }, { ...c, models: { ...c.models, vad: { ...vad, file: 'relative.onnx' } } }]) { write(configFile, bad); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' }); }
  write(configFile, { ...c, maxAudioSeconds: 600 }); assert.equal(loadSpeechConfig(configFile).maxAudioSeconds, 600);
});

test('voice ids resolve only through operator config; usageScope is a label, not an audience gate', async t => {
  const { root, runner, configFile, c } = fixture(t);
  const out = name => path.join(root, 'speech-data', name + '.wav');
  assert.deepEqual(await runner.synthesize({ text: '测试', outputFile: out('default') }), { model: 'tts-test', durationMs: 20, sampleRate: 16000, mime: 'audio/wav' });
  await runner.synthesize({ text: '测试', outputFile: out('public'), voiceProfile: 'synthetic' });
  await runner.synthesize({ text: '测试', outputFile: out('private-named'), voiceProfile: 'actress', audience: 'shared' });
  assert.match(fs.readFileSync(path.join(root, 'speech-data/trace'), 'utf8'), /^start actress\nend\nstart synthetic\nend\nstart actress\nend\n$/);
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: out('unknown'), voiceProfile: 'nobody' }), { code: 'SPEECH_VOICE_UNKNOWN' });
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: out('path'), voiceProfile: '/etc/passwd' }), { code: 'SPEECH_VOICE_UNKNOWN' });
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: out('proto'), voiceProfile: '__proto__' }), { code: 'SPEECH_VOICE_UNKNOWN' });
  for (const name of ['unknown', 'path', 'proto']) assert.equal(fs.existsSync(out(name)), false);
  assert.deepEqual(runner.status().voices.map(v => [v.id, v.usageScope]), [['actress', 'private'], ['synthetic', 'public']]);
  c.defaultVoice = null; fs.writeFileSync(configFile, JSON.stringify(c));
  await assert.rejects(runner.synthesize({ text: '测试', outputFile: out('none') }), { code: 'SPEECH_REFERENCE_REQUIRED' });
});

test('config schema: old schema refused, llama-tts voices cannot claim transcript use, thread cap is 16', t => {
  const { root, configFile, c } = fixture(t);
  const write = value => { fs.writeFileSync(configFile, JSON.stringify(value)); };
  write({ ...c, schemaVersion: 1 }); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG_SCHEMA' });
  assert.throws(() => prepareSpeech(root, path.join(root, 'runtime')), { code: 'SPEECH_CONFIG_SCHEMA' });
  write({ ...c, numThreads: 16 }); assert.equal(loadSpeechConfig(configFile).numThreads, 16);
  write({ ...c, numThreads: 17 }); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' });
  write({ ...c, defaultVoice: 'missing' }); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' });
  write({ ...c, voiceProfiles: { ...c.voiceProfiles, actress: { ...c.voiceProfiles.actress, usageScope: 'everyone' } } }); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' });
  const llama = { ...c, models: { ...c.models, tts: { 'llama-tts': { id: 'qwen3-tts', engine: 'llama-tts' } } }, voiceProfiles: { actress: { ...c.voiceProfiles.actress, engine: 'llama-tts', useReferenceText: true } } };
  write(llama); assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' });
  llama.voiceProfiles.actress.useReferenceText = false; write(llama); assert.equal(resolveVoice(loadSpeechConfig(configFile)).engine, 'llama-tts');
});

test('a reference is trusted only with its matching manifest, voice id and transcript', t => {
  const { c } = fixture(t);
  const directory = path.join(c.workRoot, 'reference'), file = path.join(directory, 'operator-' + randomUUID() + '.wav'), data = wave(16000 * 2 * 3);
  fs.writeFileSync(file, data);
  const manifest = { schemaVersion: 1, origin: 'operator-authorized', voiceId: 'actress', sha256: createHash('sha256').update(data).digest('hex'), transcript: 'synthetic transcript', consentRecordedAt: new Date().toISOString() };
  fs.writeFileSync(file + '.json', JSON.stringify(manifest));
  const profile = { ...c.voiceProfiles.actress, referencePath: file };
  assert.equal(trustedReference(c, profile).file, fs.realpathSync(file));
  assert.throws(() => trustedReference(c, { ...profile, id: 'synthetic' }), { code: 'SPEECH_REFERENCE_REQUIRED' });
  assert.throws(() => trustedReference(c, { ...profile, referenceTranscript: 'other' }), { code: 'SPEECH_REFERENCE_REQUIRED' });
  fs.writeFileSync(file + '.json', JSON.stringify({ ...manifest, origin: 'synthetic-local' }));
  assert.throws(() => trustedReference(c, profile), { code: 'SPEECH_REFERENCE_REQUIRED' });
});

test('child exit failure is sanitized and does not poison the next queued request', async t => {
  const { root, runner, inputFile } = fixture(t);
  await assert.rejects(runner.transcribe({ inputFile, language: 'en' }), error => error.code === 'SPEECH_WORKER_FAILED' && error.message === 'SPEECH_WORKER_FAILED');
  const controller = new AbortController(), outputFile = path.join(root, 'speech-data/cancelled.wav');
  const pending = runner.synthesize({ text: 'cancelled synthetic speech', outputFile, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, { code: 'SPEECH_CANCELLED' }); clearTimeout(timer);
  assert.equal(fs.existsSync(outputFile), false);
  assert.equal((await runner.transcribe({ inputFile })).text, 'synthetic transcript');
});
