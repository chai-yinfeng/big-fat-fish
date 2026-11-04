#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Infrastructure only: no runtime installation, model download, network or inference. */
export function prepareSpeech(base = path.join(os.homedir(), '.local/share/companion-world-v1'), runtime = path.join(os.homedir(), '.local/opt/companion/speech-node')) {
  if (!path.isAbsolute(base) || !path.isAbsolute(runtime) || !fs.statSync(path.join(base, 'operator')).isDirectory()) throw new Error('SPEECH_CONFIG');
  for (const name of ['speech-models', 'speech-data', 'media-data']) fs.mkdirSync(path.join(base, name), { recursive: true, mode: 0o700 });
  const workRoot = path.join(base, 'speech-data');
  fs.mkdirSync(path.join(workRoot, 'reference'), { recursive: true, mode: 0o700 });
  const modelRoot = path.join(base, 'speech-models');
  const model = name => path.join(modelRoot, name);
  const sense = model('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  const qwen = model('sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25');
  const kokoro = model('kokoro-int8-multi-lang-v1_1');
  const heavy = model('qwen3-tts-1.7b-base-gguf');
  const config = {
    schemaVersion: 1,
    nodeExecutable: process.execPath,
    sherpaModule: path.join(runtime, 'node_modules/sherpa-onnx-node/sherpa-onnx.js'),
    workRoot,
    inputRoots: [path.join(base, 'media-data')],
    numThreads: 2,
    timeoutMs: 180000,
    maxTextChars: 120,
    maxAudioSeconds: 120,
    maxHeavyAudioSeconds: 30,
    voiceProfiles: { default: { speakerId: 0, language: 'zh', auditioned: false, referenceOrigin: 'kokoro-local', referencePath: path.join(workRoot, 'reference/default.wav') } },
    models: {
      asr: {
        light: { id: 'sensevoice-small-int8-2024-07-17', engine: 'sherpa-sensevoice', files: { model: path.join(sense, 'model.int8.onnx'), tokens: path.join(sense, 'tokens.txt') } },
        heavy: { id: 'qwen3-asr-0.6b-int8-2026-03-25', enabled: false, engine: 'sherpa-qwen3-asr', files: { convFrontend: path.join(qwen, 'conv_frontend.onnx'), encoder: path.join(qwen, 'encoder.int8.onnx'), decoder: path.join(qwen, 'decoder.int8.onnx'), tokenizer: path.join(qwen, 'tokenizer') } },
      },
      tts: {
        light: { id: 'kokoro-v1.1-zh-int8', engine: 'sherpa-kokoro', files: { model: path.join(kokoro, 'model.int8.onnx'), voices: path.join(kokoro, 'voices.bin'), tokens: path.join(kokoro, 'tokens.txt'), lexiconEn: path.join(kokoro, 'lexicon-us-en.txt'), lexiconZh: path.join(kokoro, 'lexicon-zh.txt'), dict: path.join(kokoro, 'dict'), espeakData: path.join(kokoro, 'espeak-ng-data'), numberFst: path.join(kokoro, 'number-zh.fst'), dateFst: path.join(kokoro, 'date-zh.fst') } },
        heavy: { id: 'qwen3-tts-1.7b-base-q4-k-m', enabled: false, engine: 'llama-tts', executable: path.join(runtime, 'llama.cpp/build/bin/llama-tts'), model: path.join(heavy, 'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf'), mmproj: path.join(heavy, 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf'), maxFrames: 1024 },
      },
    },
  };
  const manifest = {
    schemaVersion: 1,
    runtime: { node: '24.x (private Companion runtime)', sherpa: { package: 'sherpa-onnx-node', version: '2.0.1', source: 'https://registry.npmjs.org/sherpa-onnx-node/2.0.1', integrity: 'sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==' }, llamaCpp: { version: 'v0.8.0', commit: '8642541b255bfb5dc39cd351a178be09013a55d6', source: 'https://github.com/ggml-org/llama.cpp', cpuOnly: true } },
    models: [
      { id: config.models.asr.light.id, source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', license: 'Verify the selected artifact LICENSE; current upstream SenseVoice card points to FunASR MODEL_LICENSE, not the sherpa runtime Apache license.', digestPendingDownload: true },
      { id: config.models.asr.heavy.id, source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2', upstream: 'Qwen/Qwen3-ASR-0.6B', upstreamRevision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0', license: 'Apache-2.0 upstream; retain export provenance', digestPendingDownload: true },
      { id: config.models.tts.light.id, source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2', upstream: 'hexgrad/Kokoro-82M-v1.1-zh', license: 'Apache-2.0 model; bundled phonemization/data dependencies retain their own licenses', digestPendingDownload: true },
      { id: config.models.tts.heavy.id, source: 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', revision: 'ca27d74bc954b73dadab5b71ca265d87fc861a7c', upstream: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', upstreamRevision: 'fd4b254389122332181a7c3db7f27e918eec64e3', license: 'Apache-2.0 upstream', files: [
        { name: path.basename(config.models.tts.heavy.model), bytes: 1035965280, sha256: '8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129' },
        { name: path.basename(config.models.tts.heavy.mmproj), bytes: 446422912, sha256: '6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2' },
      ] },
    ],
    verification: 'not installed or benchmarked; model file bytes are not runtime RSS',
  };
  const configFile = path.join(base, 'operator/speech.json'), manifestFile = path.join(base, 'operator/speech-models.json');
  let configPreserved = false;
  if (fs.existsSync(configFile)) { JSON.parse(fs.readFileSync(configFile, 'utf8')); configPreserved = true; }
  else fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { prepared: true, configPreserved, modelsInstalled: false, cpuBenchmarked: false, voiceAuditioned: false, cloudEnabled: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(prepareSpeech()) + '\n'); }
  catch { process.stderr.write('Speech preparation failed; no engine was installed or invoked.\n'); process.exitCode = 1; }
}
