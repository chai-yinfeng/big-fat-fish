import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSpeechConfig, inputPath, outputPath, engineFor, componentsPresent, wavInfo, failure, resolveVoice, trustedReference, ASR_TIERS } from './config.js';

const workerDefault = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const publicErrors = new Set(['SPEECH_CANCELLED', 'SPEECH_NOT_CONFIGURED', 'SPEECH_CONFIG_SCHEMA', 'SPEECH_MODEL_DISABLED', 'SPEECH_REQUEST', 'SPEECH_PATH', 'SPEECH_AUDIO_FORMAT', 'SPEECH_AUDIO_LIMIT', 'SPEECH_INCOMPLETE', 'SPEECH_REFERENCE_REQUIRED', 'SPEECH_VOICE_UNKNOWN', 'SPEECH_VOICE_SCOPE', 'SPEECH_TIMEOUT']);

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
    const c = loadSpeechConfig(configFile);
    const profile = job.kind === 'tts' ? resolveVoice(c, job.voiceProfile, job.audience) : undefined;
    const key = job.kind === 'tts' ? profile.engine : job.quality, e = engineFor(c, job.kind, key);
    if (e.enabled === false) throw failure('SPEECH_MODEL_DISABLED');
    if (!componentsPresent(c, job.kind, key)) throw failure('SPEECH_NOT_CONFIGURED');
    let reservedOutput, jobDir;
    if (job.kind === 'asr') {
      job.inputFile = inputPath(c, job.inputFile);
      const info = wavInfo(job.inputFile);
      if (info.format !== 1 || info.bits !== 16) throw failure('SPEECH_AUDIO_FORMAT');
      if (info.durationMs > (job.quality === 'fast' ? c.maxFastAudioSeconds : c.maxAudioSeconds) * 1000) throw failure('SPEECH_AUDIO_LIMIT');
    } else {
      if (typeof job.text !== 'string' || !job.text.trim() || [...job.text].length > c.maxTextChars) throw failure('SPEECH_REQUEST');
      if (e.engine === 'llama-tts') trustedReference(c, profile);
      job.voiceProfile = profile.id;
      job.outputFile = outputPath(c, job.outputFile);
      fs.closeSync(fs.openSync(job.outputFile, 'wx', 0o600));
      reservedOutput = job.outputFile;
      if (e.engine === 'llama-tts') { jobDir = fs.mkdtempSync(path.join(fs.realpathSync(c.workRoot), 'speech-job-')); job.jobDir = jobDir; }
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
    transcribe({ inputFile, quality = 'default', language = 'auto', signal }) {
      if (!['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(language) || !ASR_TIERS.includes(quality)) return Promise.reject(failure('SPEECH_REQUEST'));
      return enqueue({ kind: 'asr', inputFile, quality, language }, signal);
    },
    /** voiceProfile is an operator-registered voice id (omitted -> defaultVoice).
     * audience is the trusted conversation audience; private-scope voices need 'private'. */
    synthesize({ text, outputFile, voiceProfile, audience, signal }) { return enqueue({ kind: 'tts', text, outputFile, voiceProfile, audience }, signal); },
    status() {
      try {
        const c = loadSpeechConfig(configFile);
        const entry = (kind, key) => { const e = engineFor(c, kind, key); return { model: e.id, componentsPresent: componentsPresent(c, kind, key), enabled: e.enabled !== false, verified: e.cpuBenchmark?.passed === true && e.cpuBenchmark?.model === e.id }; };
        const models = Object.fromEntries([...ASR_TIERS.filter(tier => Object.hasOwn(c.models.asr, tier)).map(tier => ['asr:' + tier, entry('asr', tier)]), ...Object.keys(c.models.tts).map(key => ['tts:' + key, entry('tts', key)])]);
        return { configured: true, cpuOnly: true, models, defaultVoice: c.defaultVoice, voices: Object.values(c.voiceProfiles).map(p => ({ id: p.id, engine: p.engine, usageScope: p.usageScope, auditioned: p.auditioned === true })) };
      } catch (error) { return { configured: false, code: error.code === 'SPEECH_CONFIG_SCHEMA' ? error.code : 'SPEECH_NOT_CONFIGURED' }; }
    },
  };
}
