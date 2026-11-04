import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalSpeechRunner } from './runner.js';
import { prepareSpeech } from '../../deploy/authority/prepare-speech.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-speech-'));
  for (const name of ['operator', 'media-data', 'speech-data']) fs.mkdirSync(path.join(root, name));
  const prepared = prepareSpeech(root, path.join(root, 'runtime'));
  assert.equal(prepared.modelsInstalled, false);
  const configFile = path.join(root, 'operator/speech.json'), c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const component = path.join(root, 'synthetic.component'); fs.writeFileSync(component, 'synthetic');
  c.sherpaModule = component;
  for (const kind of ['asr', 'tts']) for (const quality of ['light', 'heavy']) c.models[kind][quality] = { id: `${kind}-${quality}`, engine: 'test-only', files: { model: component } };
  fs.writeFileSync(configFile, JSON.stringify(c));
  const wav = Buffer.alloc(44 + 640);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(640, 40);
  const inputFile = path.join(root, 'media-data/input.wav'); fs.writeFileSync(inputFile, wav);
  const workerFile = path.join(root, 'fake-worker.mjs');
  fs.writeFileSync(workerFile, `import fs from 'node:fs';import path from 'node:path';const c=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));let raw='';for await(const b of process.stdin)raw+=b;const j=JSON.parse(raw);if(j.language==='en'){process.stderr.write('synthetic-secret-and-private-input');process.exit(3);}const trace=path.join(c.workRoot,'trace');fs.appendFileSync(trace,'start\\n');await new Promise(r=>setTimeout(r,j.text==='cancelled synthetic speech'?1000:15));if(j.kind==='tts')fs.copyFileSync(path.join(c.inputRoots[0],'input.wav'),j.outputFile);fs.appendFileSync(trace,'end\\n');process.stdout.write(JSON.stringify({ok:true,value:{model:c.models[j.kind][j.quality].id,text:'synthetic transcript',durationMs:j.kind==='asr'?Math.round((fs.statSync(j.inputFile).size-44)/fs.readFileSync(j.inputFile).readUInt32LE(28)*1000):20,sampleRate:16000,complete:true}}));`);
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

test('one selected child runs at a time and successful output is bounded WAV metadata, not an engine fallback', async t => {
  const { root, runner, configFile, c, inputFile, wav } = fixture(t);
  const results = await Promise.all([runner.transcribe({ inputFile }), runner.transcribe({ inputFile })]);
  assert.ok(results.every(x => x.derived && x.model === 'asr-light'));
  assert.equal(fs.readFileSync(path.join(root, 'speech-data/trace'), 'utf8'), 'start\nend\nstart\nend\n');
  const voice = await runner.synthesize({ text: '测试', outputFile: path.join(root, 'speech-data/out.wav') });
  assert.deepEqual(voice, { model: 'tts-light', durationMs: 20, sampleRate: 16000, mime: 'audio/wav' });
  const long = Buffer.alloc(44 + 24000 * 2 * 31); wav.copy(long, 0, 0, 44);
  long.writeUInt32LE(long.length - 8, 4); long.writeUInt32LE(24000, 24); long.writeUInt32LE(48000, 28); long.writeUInt32LE(long.length - 44, 40);
  const at24k = path.join(root, 'media-data/31-seconds-at-24k.wav'); fs.writeFileSync(at24k, long);
  assert.equal((await runner.transcribe({ inputFile: at24k })).durationMs, 31000);
  await assert.rejects(runner.transcribe({ inputFile: at24k, quality: 'heavy' }), { code: 'SPEECH_AUDIO_LIMIT' });
  c.models.asr.heavy.files.model = path.join(root, 'missing-heavy-model'); fs.writeFileSync(configFile, JSON.stringify(c));
  await assert.rejects(runner.transcribe({ inputFile, quality: 'heavy' }), { code: 'SPEECH_NOT_CONFIGURED' });
  assert.equal(runner.status().models['asr:heavy'].componentsPresent, false);
  c.models.tts.heavy.enabled = false; fs.writeFileSync(configFile, JSON.stringify(c));
  await assert.rejects(runner.synthesize({ text: '测试', quality: 'heavy', outputFile: path.join(root, 'speech-data/disabled.wav') }), { code: 'SPEECH_MODEL_DISABLED' });
  assert.equal(runner.status().models['tts:heavy'].enabled, false);
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
