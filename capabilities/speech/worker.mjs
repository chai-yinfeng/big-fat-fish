#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { loadSpeechConfig, inputPath, engineFor, componentsPresent, wavInfo, failure, inside, trustedReference, resolveVoice, asrLimitSeconds, ttsDevice, SINGLE_PASS_SECONDS } from './config.js';
import { llamaTtsArgs, vulkanProbe, synthesizeOnDevice, BACKEND_FAILED } from './llama-tts.js';
import { planChunks, joinTranscripts } from './chunks.js';
import { toSimplifiedChinese } from './text.js';

process.umask(0o077);
const require = createRequire(import.meta.url);
const allowedErrors = new Set(['SPEECH_NOT_CONFIGURED', 'SPEECH_REQUEST', 'SPEECH_AUDIO_FORMAT', 'SPEECH_AUDIO_LIMIT', 'SPEECH_PATH', 'SPEECH_INCOMPLETE', 'SPEECH_REFERENCE_REQUIRED', 'SPEECH_VOICE_UNKNOWN']);

async function nativeTts(c, e, profile, job) {
  const { file: reference } = trustedReference(c, profile);
  // llama-tts v0.8.0 supports speaker-file conditioning, not a reference-text
  // or ICL CLI input. Do not put the registered private transcript in -p/-f.
  // Do not place private reply text in the native process command line.
  const temp = job.jobDir;
  if (typeof temp !== 'string' || path.dirname(fs.realpathSync(temp)) !== fs.realpathSync(c.workRoot) || !path.basename(temp).startsWith('speech-job-')) throw failure('SPEECH_REQUEST');
  try {
    const prompt = path.join(temp, 'prompt.txt');
    fs.writeFileSync(prompt, job.text, { mode: 0o600 });
    // A writable Mesa shader cache under workRoot avoids recompiling shaders (~2 s) per process.
    const shaderCache = path.join(fs.realpathSync(c.workRoot), 'shader-cache');
    const run = async (backend, timeoutMs) => {
      const args = llamaTtsArgs({ e, numThreads: c.numThreads, backend, reference, prompt, outputFile: job.outputFile });
      if (backend === 'vulkan') fs.mkdirSync(shaderCache, { recursive: true, mode: 0o700 });
      const env = backend === 'vulkan' ? { ...process.env, MESA_SHADER_CACHE_DIR: shaderCache } : process.env;
      const log = await new Promise((resolve, reject) => {
        const child = spawn(e.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
        let stderr = '', timedOut = false;
        const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : undefined;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
        child.on('error', () => { clearTimeout(timer); reject(failure('SPEECH_NOT_CONFIGURED')); });
        child.on('close', code => { clearTimeout(timer); code === 0 && !timedOut ? resolve(stderr) : reject(failure(BACKEND_FAILED)); });
      });
      // Pinned llama.cpp v0.8.0 returns exit 0 even at -n; it is not an EOS receipt.
      const match = /generated (\d+) frames, \d+ bytes of WAV audio \(\d+ Hz\)/.exec(log);
      if (!match || Number(match[1]) < 1 || Number(match[1]) >= e.maxFrames) throw failure('SPEECH_INCOMPLETE');
    };
    const known = typeof job.vulkanUnavailable === 'string' ? job.vulkanUnavailable : undefined;
    return await synthesizeOnDevice({ device: ttsDevice(e), known, probe: () => vulkanProbe(e.executable), run, timeoutMs: c.timeoutMs });
  } finally {
    // Only this private, freshly-created job directory is removed, never a caller path.
    const target = path.resolve(temp);
    if (inside(fs.realpathSync(c.workRoot), target) && path.basename(target).startsWith('speech-job-')) fs.rmSync(target, { recursive: true });
  }
}

/** Speech regions [[start, end]] (16 kHz sample indexes) from the pinned Silero VAD. */
function speechRegions(sherpa, c, samples) {
  const windowSize = 512, vad = new sherpa.Vad({ sileroVad: { model: c.models.vad.file, threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, Math.ceil(samples.length / 16000) + 1);
  const regions = [], drain = () => { while (!vad.isEmpty()) { const s = vad.front(false); regions.push([s.start, s.start + s.samples.length]); vad.pop(); } };
  for (let i = 0; i < samples.length; i += windowSize) { vad.acceptWaveform(samples.subarray(i, i + windowSize)); drain(); }
  vad.flush(); drain();
  return regions;
}

async function run(c, job) {
  const profile = job.kind === 'tts' ? resolveVoice(c, job.voiceProfile) : undefined;
  const key = job.kind === 'tts' ? profile.engine : job.quality;
  const e = engineFor(c, job.kind, key);
  if (!componentsPresent(c, job.kind, key)) throw failure('SPEECH_NOT_CONFIGURED');
  if (job.kind === 'asr') {
    job.inputFile = inputPath(c, job.inputFile);
    const info = wavInfo(job.inputFile);
    if (info.durationMs > asrLimitSeconds(c) * 1000) throw failure('SPEECH_AUDIO_LIMIT');
    if (info.format !== 1 || info.bits !== 16) throw failure('SPEECH_AUDIO_FORMAT');
    const sherpa = require(c.sherpaModule), f = e.files;
    const modelConfig = { tokens: f.tokens || '', numThreads: c.numThreads, provider: 'cpu', debug: 0 };
    if (e.engine === 'sherpa-qwen3-asr') modelConfig.qwen3Asr = { convFrontend: f.convFrontend, encoder: f.encoder, decoder: f.decoder, tokenizer: f.tokenizer, hotwords: '', maxNewTokens: 1024 };
    else throw failure('SPEECH_NOT_CONFIGURED');
    const recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig });
    const wave = sherpa.readWave(job.inputFile);
    const decode = (sampleRate, samples) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      if (typeof result.text !== 'string' || result.text.length > 12000) throw failure('SPEECH_WORKER_FAILED');
      return result.text;
    };
    let raw;
    if (info.durationMs <= SINGLE_PASS_SECONDS * 1000) raw = decode(wave.sampleRate, wave.samples);
    else {
      // Silero VAD runs at 16 kHz; Qwen3-ASR resamples to 16 kHz anyway.
      const samples = wave.sampleRate === 16000 ? wave.samples : new sherpa.LinearResampler(wave.sampleRate, 16000).flush(wave.samples);
      const parts = planChunks(speechRegions(sherpa, c, samples), samples.length, 16000).map(chunk => ({ text: decode(16000, samples.subarray(chunk.start, chunk.end)), overlapsPrevious: chunk.overlapsPrevious }));
      raw = joinTranscripts(parts);
      if (raw.length > 12000) throw failure('SPEECH_WORKER_FAILED');
    }
    const text = e.engine === 'sherpa-qwen3-asr' ? toSimplifiedChinese(raw.trim()) : raw.trim();
    return { text, model: e.id, durationMs: info.durationMs, complete: true, derived: true };
  }
  if (job.kind !== 'tts' || typeof job.text !== 'string' || !job.text.trim() || [...job.text].length > c.maxTextChars || !inside(fs.realpathSync(c.workRoot), fs.realpathSync(job.outputFile))) throw failure('SPEECH_REQUEST');
  if (e.engine !== 'llama-tts') throw failure('SPEECH_NOT_CONFIGURED');
  const { backend, fallback } = await nativeTts(c, e, profile, job);
  return { model: e.id, ...wavInfo(job.outputFile), complete: true, mime: 'audio/wav', backend, fallback };
}

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw failure('SPEECH_CONFIG');
  const c = loadSpeechConfig(process.argv[3]);
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) throw failure('SPEECH_REQUEST'); }
  const job = JSON.parse(input);
  const value = await run(c, job);
  process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: allowedErrors.has(error.code) ? error.code : 'SPEECH_WORKER_FAILED' } }) + '\n');
  process.exitCode = 1;
}
