import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { llamaTtsArgs, vulkanProbe, synthesizeOnDevice, BACKEND_FAILED, VULKAN_FAILED, VULKAN_NO_DEVICE, VULKAN_UNSUPPORTED } from './llama-tts.js';
import { loadSpeechConfig, ttsDevice, failure } from './config.js';
import { createLocalSpeechRunner } from './runner.js';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tts-backend-')));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^companion-tts-backend-/); fs.rmSync(root, { recursive: true }); });
  return root;
}
function wave(seconds = 3.5, rate = 16000) {
  const b = Buffer.alloc(44 + rate * 2 * seconds);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const e = { model: '/m/model.gguf', mmproj: '/m/mmproj.gguf', maxFrames: 1024, language: 'zh' };
const io = { e, numThreads: 8, reference: '/w/reference/r.wav', prompt: '/w/job/prompt.txt', outputFile: '/w/out.wav' };

test('llama-tts args: Vulkan offloads everything incl. the mmproj; CPU keeps the previous flags', () => {
  const tail = ['-t', '8', '-c', '2048', '-n', '1024', '--tts-lang', 'zh', '--tts-speaker-file', '/w/reference/r.wav', '-f', '/w/job/prompt.txt', '--output', '/w/out.wav'];
  assert.deepEqual(llamaTtsArgs({ ...io, backend: 'vulkan' }), ['-m', '/m/model.gguf', '-mm', '/m/mmproj.gguf', '--device', 'Vulkan0', '-ngl', '99', ...tail]);
  assert.deepEqual(llamaTtsArgs({ ...io, backend: 'cpu' }), ['-m', '/m/model.gguf', '-mm', '/m/mmproj.gguf', '--device', 'none', '-ngl', '0', '--no-mmproj-offload', ...tail]);
  assert.equal(llamaTtsArgs({ ...io, backend: 'vulkan' }).includes('--no-mmproj-offload'), false);
  assert.throws(() => llamaTtsArgs({ ...io, backend: 'cuda' }), { code: 'SPEECH_REQUEST' });
});

test('auto: a failed Vulkan run is retried on CPU, and the remembered reason sends the next request straight to CPU', async () => {
  const spawned = [];
  // Fake spawn: the Vulkan process exits non-zero, the CPU process succeeds.
  const run = async (backend, timeoutMs) => { spawned.push([backend, timeoutMs]); if (backend === 'vulkan') throw failure(BACKEND_FAILED); };
  let memo; // what the runner keeps between worker processes
  const first = await synthesizeOnDevice({ device: 'auto', known: memo, probe: () => null, run, timeoutMs: 180000 });
  assert.deepEqual(first, { backend: 'cpu', fallback: VULKAN_FAILED });
  assert.deepEqual(spawned, [['vulkan', 90000], ['cpu', undefined]]);
  memo = first.fallback; spawned.length = 0;
  const second = await synthesizeOnDevice({ device: 'auto', known: memo, probe: () => assert.fail('probe skipped once Vulkan is known unavailable'), run, timeoutMs: 180000 });
  assert.deepEqual(second, { backend: 'cpu', fallback: VULKAN_FAILED });
  assert.deepEqual(spawned, [['cpu', undefined]]);
});

test('auto uses Vulkan when it works; probe failures go to CPU without spawning Vulkan; explicit devices never fall back', async () => {
  const spawned = [], ok = async backend => { spawned.push(backend); };
  assert.deepEqual(await synthesizeOnDevice({ device: 'auto', probe: () => null, run: ok, timeoutMs: 1000 }), { backend: 'vulkan', fallback: null });
  for (const code of [VULKAN_UNSUPPORTED, VULKAN_NO_DEVICE]) assert.deepEqual(await synthesizeOnDevice({ device: 'auto', probe: () => code, run: ok, timeoutMs: 1000 }), { backend: 'cpu', fallback: code });
  assert.deepEqual(await synthesizeOnDevice({ device: 'cpu', known: VULKAN_FAILED, probe: () => assert.fail('cpu does not probe'), run: ok, timeoutMs: 1000 }), { backend: 'cpu', fallback: null });
  assert.deepEqual(spawned, ['vulkan', 'cpu', 'cpu', 'cpu']);
  const failing = async () => { throw failure(BACKEND_FAILED); };
  await assert.rejects(synthesizeOnDevice({ device: 'vulkan', probe: () => null, run: failing, timeoutMs: 1000 }), { code: BACKEND_FAILED });
  await assert.rejects(synthesizeOnDevice({ device: 'vulkan', probe: () => VULKAN_NO_DEVICE, run: ok, timeoutMs: 1000 }), { code: 'SPEECH_NOT_CONFIGURED' });
  // An incomplete synthesis is a model result, not a backend failure: no CPU retry.
  spawned.length = 0;
  await assert.rejects(synthesizeOnDevice({ device: 'auto', probe: () => null, run: async backend => { spawned.push(backend); throw failure('SPEECH_INCOMPLETE'); }, timeoutMs: 1000 }), { code: 'SPEECH_INCOMPLETE' });
  assert.deepEqual(spawned, ['vulkan']);
});

test('Vulkan probe: a CPU-only build or no accessible render node means CPU', t => {
  const root = tempRoot(t), bin = path.join(root, 'bin'), dri = path.join(root, 'dri');
  fs.mkdirSync(bin); fs.mkdirSync(dri);
  const exe = path.join(bin, 'llama-tts'); fs.writeFileSync(exe, 'x');
  assert.equal(vulkanProbe(exe, { dri }), VULKAN_UNSUPPORTED);
  fs.writeFileSync(path.join(bin, 'libggml-vulkan.so'), 'x');
  assert.equal(vulkanProbe(exe, { dri }), VULKAN_NO_DEVICE);
  assert.equal(vulkanProbe(exe, { dri: path.join(root, 'missing') }), VULKAN_NO_DEVICE);
  fs.writeFileSync(path.join(dri, 'renderD128'), '');
  assert.equal(vulkanProbe(exe, { dri }), null);
});

function fixture(t, device) {
  const root = tempRoot(t), work = path.join(root, 'speech-data'), reference = path.join(work, 'reference');
  fs.mkdirSync(reference, { recursive: true }); fs.mkdirSync(path.join(root, 'media-data'));
  const id = 'actress', transcript = '合成参考文本', file = path.join(reference, `operator-${randomUUID()}.wav`), audio = wave();
  fs.writeFileSync(file, audio);
  fs.writeFileSync(file + '.json', JSON.stringify({ schemaVersion: 1, origin: 'operator-authorized', voiceId: id, sha256: createHash('sha256').update(audio).digest('hex'), transcript, consentRecordedAt: '2026-11-08T00:00:00Z' }));
  // Fake llama-tts: records its backend flags, refuses Vulkan, writes a WAV for CPU.
  const bin = path.join(root, 'bin'), exe = path.join(bin, 'llama-tts'), trace = path.join(root, 'native-trace');
  fs.mkdirSync(bin);
  fs.writeFileSync(exe, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const d=a[a.indexOf('--device')+1];fs.appendFileSync(${JSON.stringify(trace)},d+'\\n');if(d!=='none')process.exit(1);fs.copyFileSync(${JSON.stringify(file)},a[a.indexOf('--output')+1]);process.stderr.write('generated 12 frames, 112044 bytes of WAV audio (16000 Hz)\\n');\n`, { mode: 0o700 });
  const model = path.join(root, 'model.gguf'), mmproj = path.join(root, 'mmproj.gguf');
  fs.writeFileSync(model, 'synthetic'); fs.writeFileSync(mmproj, 'synthetic');
  const tts = { id: 'qwen3-tts-test', engine: 'llama-tts', executable: exe, model, mmproj, maxFrames: 1024, language: 'zh', ...(device ? { device } : {}) };
  const config = { schemaVersion: 2, nodeExecutable: process.execPath, sherpaModule: path.join(root, 'sherpa/sherpa-onnx.js'), workRoot: work, inputRoots: [path.join(root, 'media-data')], numThreads: 2, timeoutMs: 20000, maxTextChars: 120, maxAudioSeconds: 30, defaultVoice: id,
    voiceProfiles: { [id]: { id, label: 'Actress', engine: 'llama-tts', referencePath: file, referenceTranscript: transcript, referenceLanguage: 'zh', useReferenceText: false, usageScope: 'private' } },
    models: { asr: {}, tts: { 'llama-tts': tts } } };
  const configFile = path.join(root, 'speech.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const logs = [];
  return { root, work, trace, configFile, logs, runner: createLocalSpeechRunner({ configFile, log: line => logs.push(line) }) };
}

test('a schema-2 config without the device field means auto; an unknown device is refused', t => {
  const { configFile } = fixture(t);
  const c = loadSpeechConfig(configFile);
  assert.equal(Object.hasOwn(c.models.tts['llama-tts'], 'device'), false);
  assert.equal(ttsDevice(c.models.tts['llama-tts']), 'auto');
  for (const device of ['auto', 'vulkan', 'cpu']) { c.models.tts['llama-tts'].device = device; fs.writeFileSync(configFile, JSON.stringify(c)); assert.equal(ttsDevice(loadSpeechConfig(configFile).models.tts['llama-tts']), device); }
  c.models.tts['llama-tts'].device = 'cuda'; fs.writeFileSync(configFile, JSON.stringify(c));
  assert.throws(() => loadSpeechConfig(configFile), { code: 'SPEECH_CONFIG' });
});

test('real worker with an existing CPU-only llama-tts: auto runs on CPU, logs one stable code and reports the backend', async t => {
  const { work, trace, logs, runner } = fixture(t);
  assert.deepEqual(runner.status().tts, { device: 'auto', backend: 'cpu', fallback: VULKAN_UNSUPPORTED, observed: false });
  assert.equal(runner.status().cpuOnly, true);
  for (const n of [1, 2]) {
    const result = await runner.synthesize({ text: '你好。', outputFile: path.join(work, `out-${n}.wav`) });
    assert.equal(result.mime, 'audio/wav'); assert.equal(result.durationMs, 3500);
  }
  // No libggml-vulkan.so next to the binary: Vulkan is never spawned.
  assert.equal(fs.readFileSync(trace, 'utf8'), 'none\nnone\n');
  assert.deepEqual(logs, ['SPEECH_TTS_FALLBACK_CPU ' + VULKAN_UNSUPPORTED]);
  assert.deepEqual(runner.status().tts, { device: 'auto', backend: 'cpu', fallback: VULKAN_UNSUPPORTED, observed: true });
  assert.equal(fs.readdirSync(work).some(name => name.startsWith('speech-job-')), false);
});

test('real worker: device vulkan never falls back; a failed native run is a sanitized worker failure', async t => {
  const { root, work, trace, logs, runner } = fixture(t, 'vulkan');
  fs.writeFileSync(path.join(root, 'bin/libggml-vulkan.so'), 'x');
  const usable = vulkanProbe(path.join(root, 'bin/llama-tts')) === null;
  await assert.rejects(runner.synthesize({ text: '你好。', outputFile: path.join(work, 'out.wav') }), { code: usable ? 'SPEECH_WORKER_FAILED' : 'SPEECH_NOT_CONFIGURED' });
  assert.equal(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '', usable ? 'Vulkan0\n' : '');
  assert.deepEqual(logs, []);
  assert.equal(fs.existsSync(path.join(work, 'out.wav')), false);
});
