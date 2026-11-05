#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const built = path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'ops';
const { createLocalSpeechRunner } = await import(built ? '../capabilities/speech/runner.js' : '../../capabilities/speech/runner.js');
const { ArtifactStore } = await import(built ? '../capabilities/media/artifacts.js' : '../../capabilities/media/artifacts.js');
const { wavInfo, REFERENCE_TEXT } = await import(built ? '../capabilities/speech/config.js' : '../../capabilities/speech/config.js');

const TEST_TEXT = '你好，这是一次本地语音能力测试。';
const normalized = s => [...s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];
function characterErrorRate(expected, actual) {
  const a = normalized(expected), b = normalized(actual); let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length] / Math.max(1, a.length);
}

/** Explicit operator-only synthetic benchmark. It never opens a conversation,
 * changes the world, sends QQ media, reads a human recording or calls a provider. */
export async function benchmarkSpeech({ base = path.join(os.homedir(), '.local/share/companion-world-v1'), kind, quality, enableOnSuccess = false }) {
  if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1' || !['asr', 'tts'].includes(kind) || !['light', 'heavy'].includes(quality)) throw Error('SPEECH_BENCH_ARGUMENTS');
  base = fs.realpathSync(base);
  const configFile = path.join(base, 'operator/speech.json'), c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const selected = c.models[kind][quality], local = structuredClone(c);
  // The benchmark can test a disabled heavy backend without changing the live
  // setting first. Only an explicit successful admission can enable that backend.
  local.models[kind][quality].enabled = true;
  const runId = randomUUID(), temporaryConfig = path.join(base, 'operator', 'speech-benchmark-' + runId + '.json');
  fs.writeFileSync(temporaryConfig, JSON.stringify(local) + '\n', { flag: 'wx', mode: 0o600 });
  const runner = createLocalSpeechRunner({ configFile: temporaryConfig });
  const store = new ArtifactStore({ root: c.inputRoots[0] });
  const scope = { entityId: 'operator:benchmark', streamId: 'operator:benchmark', personId: 'operator:benchmark', audience: 'private' };
  const sourceEventId = 'operator:benchmark:' + runId;
  const outputFile = path.join(fs.realpathSync(c.workRoot), 'tts-' + runId + '.wav');
  const started = performance.now(); let result;
  try {
    if (kind === 'asr') {
      const reference = c.voiceProfiles.default.referencePath;
      const info = wavInfo(reference);
      const artifact = store.put({ scope, sourceEventId, kind: 'audio', mime: 'audio/wav', data: fs.readFileSync(reference), durationMs: info.durationMs });
      const value = await runner.transcribe({ inputFile: store.read(artifact.id, scope).file, quality });
      const elapsedMs = Math.round(performance.now() - started), cer = characterErrorRate(REFERENCE_TEXT, value.text);
      result = { kind, quality, model: value.model, passed: cer <= 0.3, elapsedMs, audioDurationMs: value.durationMs, rtf: elapsedMs / value.durationMs, characterErrorRate: cer, inputArtifact: artifact.id, input: 'fixed-kokoro-synthetic-reference', coldProcess: true };
    } else {
      const value = await runner.synthesize({ text: TEST_TEXT, outputFile, quality, voiceProfile: 'default' });
      const elapsedMs = Math.round(performance.now() - started), data = fs.readFileSync(outputFile);
      const artifact = store.put({ scope, sourceEventId, kind: 'audio', mime: 'audio/wav', data, durationMs: value.durationMs });
      const checkStarted = performance.now();
      const check = await runner.transcribe({ inputFile: store.read(artifact.id, scope).file, quality: 'light' });
      const cer = characterErrorRate(TEST_TEXT, check.text);
      result = { kind, quality, model: value.model, passed: cer <= 0.3, elapsedMs, audioDurationMs: value.durationMs, rtf: elapsedMs / value.durationMs, sampleRate: value.sampleRate, artifact: artifact.id, characterErrorRate: cer, roundTripAsrElapsedMs: Math.round(performance.now() - checkStarted), input: 'fixed-public-synthetic-text', coldProcess: true, humanAuditioned: false };
    }
  } catch (error) {
    result = { kind, quality, model: selected.id, passed: false, elapsedMs: Math.round(performance.now() - started), code: /^SPEECH_[A-Z_]+$/.test(error.code || '') ? error.code : 'SPEECH_BENCH_FAILED', coldProcess: true };
  } finally {
    if (path.dirname(temporaryConfig) !== path.join(base, 'operator')) throw Error('SPEECH_BENCH_PATH');
    fs.unlinkSync(temporaryConfig);
    if (fs.existsSync(outputFile)) { if (path.dirname(outputFile) !== fs.realpathSync(c.workRoot) || fs.lstatSync(outputFile).isSymbolicLink()) throw Error('SPEECH_BENCH_PATH'); fs.unlinkSync(outputFile); }
  }
  result.measuredAt = new Date().toISOString(); result.memoryMeasurement = 'not measured by this helper; use external process/cgroup metrics';
  const reportFile = path.join(base, 'operator/speech-benchmarks.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { schemaVersion: 1, results: {} };
  report.results[kind + ':' + quality] = result;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (enableOnSuccess) {
    c.models[kind][quality].enabled = result.passed;
    c.models[kind][quality].cpuBenchmark = { model: result.model, passed: result.passed, measuredAt: result.measuredAt };
    fs.writeFileSync(configFile, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (!args.includes('--run')) throw Error('SPEECH_BENCH_EXPLICIT_RUN_REQUIRED');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') continue;
      if (args[i] === '--enable-on-success') options.enableOnSuccess = true;
      else if (['--base', '--kind', '--quality'].includes(args[i]) && args[i + 1]) { const key = args[i].slice(2); options[key] = args[++i]; }
      else throw Error('SPEECH_BENCH_ARGUMENTS');
    }
    const value = await benchmarkSpeech(options); console.log(JSON.stringify(value)); if (!value.passed) process.exitCode = 1;
  } catch { console.error('SPEECH_BENCH_FAILED'); process.exitCode = 1; }
}
