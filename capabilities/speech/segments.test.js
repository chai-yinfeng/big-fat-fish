import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalSpeechRunner } from './runner.js';
import { prepareSpeech } from '../../deploy/authority/prepare-speech.mjs';

const realWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
// A stand-in for sherpa-onnx-node: "speech" is any 512-sample window with a non-zero
// sample, and a decode answers with the number of samples it was given.
const fakeSherpa = `const fs = require('node:fs');
exports.readWave = file => { const b = fs.readFileSync(file), samples = new Float32Array((b.length - 44) / 2); for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(44 + 2 * i) / 32768; return { sampleRate: b.readUInt32LE(24), samples }; };
exports.OfflineRecognizer = class { createStream() { return { acceptWaveform(w) { this.w = w; } }; } decode() {} getResult(s) { return { text: ' 第' + s.w.samples.length + '@' + s.w.sampleRate + '段。 ' }; } };
exports.LinearResampler = class { constructor(from, to) { this.ratio = to / from; } flush(s) { const out = new Float32Array(Math.round(s.length * this.ratio)); for (let i = 0; i < out.length; i++) out[i] = s[Math.floor(i / this.ratio)]; return out; } };
exports.Vad = class { constructor() { this.at = 0; this.open = -1; this.queue = []; }
  acceptWaveform(s) { const voiced = s.some(x => x !== 0); if (voiced && this.open < 0) this.open = this.at; if (!voiced && this.open >= 0) this.close(); this.at += s.length; }
  close() { this.queue.push({ start: this.open, samples: { length: this.at - this.open } }); this.open = -1; }
  flush() { if (this.open >= 0) this.close(); } isEmpty() { return !this.queue.length; } front() { return this.queue[0]; } pop() { this.queue.shift(); } };
`;

/** Mono PCM16 WAV; voiced: [[fromWindow, toWindow]] in 512-sample windows at 16 kHz. */
function wave(seconds, voiced, rate = 16000) {
  const wav = Buffer.alloc(44 + rate * 2 * seconds), step = 512 * rate / 16000;
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (const [a, b] of voiced) for (let i = a * step; i < b * step; i++) wav.writeInt16LE(1000, 44 + 2 * i);
  return wav;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-speech-'));
  for (const name of ['operator', 'media-data', 'speech-data']) fs.mkdirSync(path.join(root, name));
  prepareSpeech(root, path.join(root, 'runtime'));
  const configFile = path.join(root, 'operator/speech.json'), c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const component = path.join(root, 'synthetic.component'); fs.writeFileSync(component, 'synthetic');
  c.nodeExecutable = process.execPath;
  c.sherpaModule = path.join(root, 'fake-sherpa.cjs'); fs.writeFileSync(c.sherpaModule, fakeSherpa);
  c.models.asr.default = { id: 'qwen3-asr-test', engine: 'sherpa-qwen3-asr', files: { convFrontend: component, encoder: component, decoder: component, tokenizer: component } };
  const save = vad => fs.writeFileSync(configFile, JSON.stringify({ ...c, models: { ...c.models, vad } }));
  save({ ...c.models.vad, file: component });
  const input = (name, wav) => { const file = path.join(root, 'media-data', name); fs.writeFileSync(file, wav); return fs.realpathSync(file); };
  // 40 s: speech at 1.024-9.216 s, 12.288-20.48 s and 22.528-38.912 s.
  const long = input('long.wav', wave(40, [[32, 288], [384, 640], [704, 1216]]));
  const short = input('short.wav', wave(4, [[32, 96]]));
  const short8k = input('short-8k.wav', wave(4, [[32, 96]], 8000));
  /** The real worker's exact stdout for one job. */
  const worker = job => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [realWorker, '--config', configFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject); child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(job));
  });
  t.after(() => { const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.match(path.basename(real), /^companion-speech-/); fs.rmSync(real, { recursive: true }); });
  return { root, configFile, c, save, component, long, short, short8k, worker, runner: createLocalSpeechRunner({ configFile }) };
}

test('without segments the worker output and the runner result are byte-for-byte the pre-segments ones', async t => {
  const { long, short, worker, runner } = fixture(t);
  const job = inputFile => ({ kind: 'asr', inputFile, quality: 'default', language: 'auto' });
  // Literals recorded from the worker at 668fbf5 (before `segments` existed) with this same fake sherpa.
  assert.equal(await worker(job(short)), '{"ok":true,"value":{"text":"第64000@16000段。","model":"qwen3-asr-test","durationMs":4000,"complete":true,"derived":true}}\n');
  assert.equal(await worker(job(long)), '{"ok":true,"value":{"text":"第317696@16000段。第268544@16000段。","model":"qwen3-asr-test","durationMs":40000,"complete":true,"derived":true}}\n');
  assert.equal(await worker({ ...job(long), segments: false }), await worker(job(long)));
  for (const input of [{ inputFile: long }, { inputFile: long, segments: false }, { inputFile: long, segments: undefined }]) {
    assert.equal(JSON.stringify(await runner.transcribe(input)), '{"text":"第317696@16000段。第268544@16000段。","model":"qwen3-asr-test","durationMs":40000,"derived":true}');
  }
  assert.equal(JSON.stringify(await runner.transcribe({ inputFile: short })), '{"text":"第64000@16000段。","model":"qwen3-asr-test","durationMs":4000,"derived":true}');
});

test('segments:true adds per-chunk segments and the voiced time; the text stays the same', async t => {
  const { long, short, short8k, runner } = fixture(t);
  const plain = await runner.transcribe({ inputFile: long });
  assert.deepEqual(await runner.transcribe({ inputFile: long, segments: true }), {
    ...plain,
    // Chunk bounds are the VAD regions padded by 0.2 s; the pause before the third region starts a new chunk.
    segments: [{ startMs: 824, endMs: 20680, text: '第317696@16000段。' }, { startMs: 22328, endMs: 39112, text: '第268544@16000段。' }],
    speechMs: 32768,
  });
  // <=30 s is still one pass (same text); the VAD runs only for speechMs.
  assert.deepEqual(await runner.transcribe({ inputFile: short, segments: true }), { ...await runner.transcribe({ inputFile: short }), segments: [{ startMs: 0, endMs: 4000, text: '第64000@16000段。' }], speechMs: 2048 });
  assert.deepEqual(await runner.transcribe({ inputFile: short8k, segments: true }), { text: '第32000@8000段。', model: 'qwen3-asr-test', durationMs: 4000, derived: true, segments: [{ startMs: 0, endMs: 4000, text: '第32000@8000段。' }], speechMs: 2048 });
});

test('segments needs the VAD at any length and a boolean flag; a malformed worker answer is refused', async t => {
  const { root, configFile, c, save, component, short, worker, runner } = fixture(t);
  await assert.rejects(runner.transcribe({ inputFile: short, segments: 'yes' }), { code: 'SPEECH_REQUEST' });
  save({ ...c.models.vad, file: component, enabled: false });
  await assert.rejects(runner.transcribe({ inputFile: short, segments: true }), { code: 'SPEECH_NOT_CONFIGURED' });
  assert.equal(await worker({ kind: 'asr', inputFile: short, quality: 'default', language: 'auto', segments: true }), '{"ok":false,"error":{"code":"SPEECH_NOT_CONFIGURED"}}\n');
  assert.equal((await runner.transcribe({ inputFile: short })).text, '第64000@16000段。');
  save({ ...c.models.vad, file: component });
  // A fake child echoing the job: the flag reaches it only when asked for, and extra fields never leak back.
  const workerFile = path.join(root, 'fake-worker.mjs'), seen = path.join(root, 'speech-data/job.json');
  fs.writeFileSync(workerFile, `import fs from 'node:fs';let raw='';for await(const b of process.stdin)raw+=b;fs.writeFileSync(${JSON.stringify(seen)},raw);const j=JSON.parse(raw);process.stdout.write(JSON.stringify({ok:true,value:{model:'qwen3-asr-test',text:'t',durationMs:4000,complete:true,derived:true,segments:j.language==='ja'?[{startMs:5,endMs:1,text:'t'}]:[{startMs:0,endMs:4000,text:'t',extra:1}],speechMs:j.language==='ko'?-1:7}}));`);
  const fake = createLocalSpeechRunner({ configFile, workerFile });
  assert.deepEqual(await fake.transcribe({ inputFile: short }), { text: 't', model: 'qwen3-asr-test', durationMs: 4000, derived: true });
  assert.equal(fs.readFileSync(seen, 'utf8'), JSON.stringify({ kind: 'asr', inputFile: short, quality: 'default', language: 'auto' }));
  assert.deepEqual(await fake.transcribe({ inputFile: short, segments: true }), { text: 't', model: 'qwen3-asr-test', durationMs: 4000, derived: true, segments: [{ startMs: 0, endMs: 4000, text: 't' }], speechMs: 7 });
  assert.equal(JSON.parse(fs.readFileSync(seen, 'utf8')).segments, true);
  for (const language of ['ja', 'ko']) await assert.rejects(fake.transcribe({ inputFile: short, language, segments: true }), { code: 'SPEECH_WORKER_FAILED' });
});
