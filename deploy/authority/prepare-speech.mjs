#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Must equal SCHEMA_VERSION in capabilities/speech/config.js (this file is copied to ops/ in a release).
const SCHEMA_VERSION = 2;

/** Infrastructure only: no runtime installation, model download, network or inference. */
export function prepareSpeech(base = path.join(os.homedir(), '.local/share/companion-world-v1'), runtime = path.join(os.homedir(), '.local/opt/companion/speech-node')) {
  if (!path.isAbsolute(base) || !path.isAbsolute(runtime) || !fs.statSync(path.join(base, 'operator')).isDirectory()) throw new Error('SPEECH_CONFIG');
  for (const name of ['speech-models', 'speech-data', 'media-data']) fs.mkdirSync(path.join(base, name), { recursive: true, mode: 0o700 });
  const workRoot = path.join(base, 'speech-data');
  fs.mkdirSync(path.join(workRoot, 'reference'), { recursive: true, mode: 0o700 });
  const modelRoot = path.join(base, 'speech-models');
  const model = name => path.join(modelRoot, name);
  const qwen = model('sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25');
  const gguf = model('qwen3-tts-1.7b-base-gguf');
  const vad = model('silero-vad-v5.1.2');
  const config = {
    schemaVersion: SCHEMA_VERSION,
    nodeExecutable: process.execPath,
    sherpaModule: path.join(runtime, 'node_modules/sherpa-onnx-node/sherpa-onnx.js'),
    workRoot,
    inputRoots: [path.join(base, 'media-data')],
    // 8 threads measured fastest on the production Ryzen 8845HS (8C/16T).
    numThreads: 8,
    timeoutMs: 180000,
    maxTextChars: 120,
    // QQ voice is <=60 s; audio over 30 s is split by the VAD (one Qwen3-ASR pass truncates past ~30 s).
    maxAudioSeconds: 120,
    // Voices are registered by the operator (console upload); none exist initially.
    defaultVoice: null,
    voiceProfiles: {},
    models: {
      asr: {
        default: { id: 'qwen3-asr-0.6b-int8-2026-03-25', engine: 'sherpa-qwen3-asr', files: { convFrontend: path.join(qwen, 'conv_frontend.onnx'), encoder: path.join(qwen, 'encoder.int8.onnx'), decoder: path.join(qwen, 'decoder.int8.onnx'), tokenizer: path.join(qwen, 'tokenizer') } },
      },
      // models.vad is optional; without it ASR stays at one pass (<=30 s).
      vad: { id: 'silero-vad-v5.1.2', engine: 'sherpa-silero-vad', file: path.join(vad, 'silero_vad.onnx') },
      tts: {
        'llama-tts': { id: 'qwen3-tts-1.7b-base-q4-k-m', engine: 'llama-tts', executable: path.join(runtime, 'llama.cpp/build/bin/llama-tts'), model: path.join(gguf, 'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf'), mmproj: path.join(gguf, 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf'), maxFrames: 1024, language: 'zh' },
      },
    },
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    runtime: { node: '24.x (private Companion runtime)', sherpa: { package: 'sherpa-onnx-node', version: '2.0.1', source: 'https://registry.npmjs.org/sherpa-onnx-node/2.0.1', integrity: 'sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==' }, llamaCpp: { version: 'v0.8.0', commit: '8642541b255bfb5dc39cd351a178be09013a55d6', source: 'https://github.com/ggml-org/llama.cpp', cpuOnly: true } },
    models: [
      // Archive digests were observed on a direct GitHub download (2026-11-08), not published by upstream.
      { id: config.models.asr.default.id, source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2', modelscope: null, modelscopeTodo: 'ModelScope path for this exact archive not confirmed; GitHub release or a pre-fetched copy via --archive-dir', upstream: 'Qwen/Qwen3-ASR-0.6B', upstreamRevision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0', license: 'Apache-2.0 upstream; retain export provenance', bytes: 878702423, sha256: '393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96' },
      // Upstream Silero VAD v5.1.2 ONNX; ModelScope pengzhendong/silero-vad serves the identical file.
      { id: config.models.vad.id, source: 'https://raw.githubusercontent.com/snakers4/silero-vad/6478567951ae5c9979ad7b234185b5515f4be7a1/src/silero_vad/data/silero_vad.onnx', modelscope: 'https://www.modelscope.cn/models/pengzhendong/silero-vad', modelscopeRevision: '370539c71ec0ac703627938064cf31c1852186d7', modelscopePath: 'v5/silero_vad.onnx', upstream: 'snakers4/silero-vad', upstreamRevision: 'v5.1.2', license: 'MIT', bytes: 2327524, sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f' },
      // ModelScope serves the same GGUF files (sha256 identical to the HF snapshot);
      // its revision is a moving branch, so the fixed sha256 below is what pins it.
      { id: config.models.tts['llama-tts'].id, source: 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', revision: 'ca27d74bc954b73dadab5b71ca265d87fc861a7c', modelscope: 'https://www.modelscope.cn/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', modelscopeRevision: 'master', upstream: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', upstreamRevision: 'fd4b254389122332181a7c3db7f27e918eec64e3', license: 'Apache-2.0 upstream', files: [
        { name: path.basename(config.models.tts['llama-tts'].model), bytes: 1035965280, sha256: '8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129' },
        { name: path.basename(config.models.tts['llama-tts'].mmproj), bytes: 446422912, sha256: '6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2' },
      ] },
    ],
    verification: 'not installed or benchmarked; model file bytes are not runtime RSS',
  };
  const configFile = path.join(base, 'operator/speech.json'), manifestFile = path.join(base, 'operator/speech-models.json');
  let configPreserved = false;
  // Schema 1 (light/heavy tiers) is refused, not migrated: no production speech config exists
  // yet on the current host. Move the old files aside, then re-run this script.
  for (const file of [configFile, manifestFile]) if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion !== SCHEMA_VERSION) throw Object.assign(new Error('SPEECH_CONFIG_SCHEMA'), { code: 'SPEECH_CONFIG_SCHEMA' });
  if (fs.existsSync(configFile)) configPreserved = true;
  else fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { prepared: true, configPreserved, modelsInstalled: false, cpuBenchmarked: false, voiceAuditioned: false, cloudEnabled: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(prepareSpeech()) + '\n'); }
  catch (e) { process.stderr.write(e.code === 'SPEECH_CONFIG_SCHEMA' ? 'SPEECH_CONFIG_SCHEMA: operator/speech.json or speech-models.json uses an old schema; move both aside and re-run.\n' : 'Speech preparation failed; no engine was installed or invoked.\n'); process.exitCode = 1; }
}
