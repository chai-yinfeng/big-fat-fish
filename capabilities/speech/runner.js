import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSpeechConfig, inputPath, outputPath, engineFor, componentsPresent, wavInfo, failure } from './config.js';

const workerDefault = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const publicErrors = new Set(['SPEECH_CANCELLED', 'SPEECH_NOT_CONFIGURED', 'SPEECH_MODEL_DISABLED', 'SPEECH_REQUEST', 'SPEECH_PATH', 'SPEECH_AUDIO_FORMAT', 'SPEECH_AUDIO_LIMIT', 'SPEECH_INCOMPLETE', 'SPEECH_REFERENCE_REQUIRED', 'SPEECH_TIMEOUT']);

/** Trusted host interface only. The model-facing layer uses artifact IDs, never these paths. */
export function createLocalSpeechRunner({ configFile, workerFile = workerDefault }) {
  if (!path.isAbsolute(configFile) || !path.isAbsolute(workerFile)) throw failure('SPEECH_CONFIG');
  let tail = Promise.resolve();
  const enqueue = (job, signal) => {
    if (signal?.aborted) return Promise.reject(failure('SPEECH_CANCELLED'));
    const pending = tail.then(() => run(job, signal));
    tail = pending.catch(() => {});
    return pending;
  };
  async function run(job, signal) {
    if (signal?.aborted) throw failure('SPEECH_CANCELLED');
    const c = loadSpeechConfig(configFile), e = engineFor(c, job.kind, job.quality);
    if (e.enabled === false) throw failure('SPEECH_MODEL_DISABLED');
    if (!componentsPresent(c, job.kind, job.quality)) throw failure('SPEECH_NOT_CONFIGURED');
    let reservedOutput, jobDir;
    if (job.kind === 'asr') {
      job.inputFile = inputPath(c, job.inputFile);
      const info = wavInfo(job.inputFile);
      if (info.format !== 1 || info.bits !== 16) throw failure('SPEECH_AUDIO_FORMAT');
      if (info.durationMs > (job.quality === 'heavy' ? c.maxHeavyAudioSeconds : c.maxAudioSeconds) * 1000) throw failure('SPEECH_AUDIO_LIMIT');
    } else {
      if (typeof job.text !== 'string' || !job.text.trim() || [...job.text].length > c.maxTextChars || job.voiceProfile !== 'default') throw failure('SPEECH_REQUEST');
      job.outputFile = outputPath(c, job.outputFile);
      fs.closeSync(fs.openSync(job.outputFile, 'wx', 0o600));
      reservedOutput = job.outputFile;
      if (job.quality === 'heavy') { jobDir = fs.mkdtempSync(path.join(fs.realpathSync(c.workRoot), 'speech-job-')); job.jobDir = jobDir; }
    }
    try {
      const result = await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(failure('SPEECH_CANCELLED'));
        const moduleRoot = path.dirname(c.sherpaModule);
        const child = spawn(c.nodeExecutable, [workerFile, '--config', configFile], {
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { PATH: '/usr/bin:/bin', HOME: c.workRoot, TMPDIR: c.workRoot, LD_LIBRARY_PATH: [path.join(moduleRoot, 'lib'), path.join(path.dirname(moduleRoot), `sherpa-onnx-linux-${process.arch}`, 'lib')].join(path.delimiter), OMP_NUM_THREADS: String(c.numThreads), OPENBLAS_NUM_THREADS: String(c.numThreads), HF_HUB_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '', NO_COLOR: '1' },
        });
        let output = '', overflow = false, timedOut = false, cancelled = false;
        const kill = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const onAbort = () => { cancelled = true; kill(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; kill(); }, c.timeoutMs);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 32768) { overflow = true; output = ''; kill(); } });
        child.on('error', () => { cleanup(); reject(failure('SPEECH_WORKER_FAILED')); });
        child.on('close', code => {
          cleanup();
          if (cancelled || signal?.aborted) return reject(failure('SPEECH_CANCELLED'));
          if (timedOut) return reject(failure('SPEECH_TIMEOUT'));
          if (overflow) return reject(failure('SPEECH_WORKER_FAILED'));
          let envelope; try { envelope = JSON.parse(output); } catch { return reject(failure('SPEECH_WORKER_FAILED')); }
          if (code !== 0 || envelope?.ok !== true) return reject(failure(publicErrors.has(envelope?.error?.code) ? envelope.error.code : 'SPEECH_WORKER_FAILED'));
          resolve(envelope.value);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(job));
      });
      if (signal?.aborted) throw failure('SPEECH_CANCELLED');
      if (result?.model !== e.id || result.complete !== true) throw failure('SPEECH_WORKER_FAILED');
      if (job.kind === 'asr') {
        if (typeof result.text !== 'string' || result.text.length > 12000 || !Number.isFinite(result.durationMs)) throw failure('SPEECH_WORKER_FAILED');
        return { text: result.text, model: result.model, durationMs: result.durationMs, derived: true };
      }
      const info = wavInfo(job.outputFile);
      if (info.durationMs !== result.durationMs || info.sampleRate !== result.sampleRate) throw failure('SPEECH_WORKER_FAILED');
      return { model: result.model, durationMs: info.durationMs, sampleRate: info.sampleRate, mime: 'audio/wav' };
    } catch (error) {
      // This exact path was canonicalized inside workRoot and exclusively reserved above.
      if (reservedOutput && path.isAbsolute(reservedOutput) && fs.existsSync(reservedOutput)) fs.unlinkSync(reservedOutput);
      throw failure(publicErrors.has(error.code) ? error.code : 'SPEECH_WORKER_FAILED');
    } finally {
      // Parent owns cleanup even when timeout SIGKILL prevents child finally handlers.
      if (jobDir && path.dirname(jobDir) === fs.realpathSync(c.workRoot) && path.basename(jobDir).startsWith('speech-job-') && fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true });
    }
  }
  return {
    transcribe({ inputFile, quality = 'light', language = 'auto', signal }) {
      if (!['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(language)) return Promise.reject(failure('SPEECH_REQUEST'));
      return enqueue({ kind: 'asr', inputFile, quality, language }, signal);
    },
    synthesize({ text, outputFile, quality = 'light', voiceProfile = 'default', signal }) { return enqueue({ kind: 'tts', text, outputFile, quality, voiceProfile }, signal); },
    status() {
      try {
        const c = loadSpeechConfig(configFile);
        return { configured: true, cpuOnly: true, models: Object.fromEntries(['asr', 'tts'].flatMap(kind => ['light', 'heavy'].map(quality => [`${kind}:${quality}`, { model: engineFor(c, kind, quality).id, componentsPresent: componentsPresent(c, kind, quality), enabled: engineFor(c, kind, quality).enabled !== false, verified: engineFor(c, kind, quality).cpuBenchmark?.passed === true && engineFor(c, kind, quality).cpuBenchmark?.model === engineFor(c, kind, quality).id }]))), voiceProfile: { id: 'default', auditioned: c.voiceProfiles.default.auditioned === true, referenceOrigin: 'kokoro-local' } };
      } catch { return { configured: false, code: 'SPEECH_NOT_CONFIGURED' }; }
    },
  };
}
