import test from 'node:test';
import assert from 'node:assert/strict';
import { cmakeFor, hfUrl, ggufUrl, proxyEnv } from './install-speech.mjs';

test('portable CMake archive and official digest follow the host architecture', () => {
  assert.deepEqual(cmakeFor('arm64'), { version: '4.4.5', directory: 'cmake-4.4.5-linux-aarch64', source: 'https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-linux-aarch64.tar.gz', sha256: '301d5063ab259577c1b57ce5490b1aab9ea5c56dc4c822f73499553dab94925f' });
  assert.deepEqual(cmakeFor('x64'), { version: '4.4.5', directory: 'cmake-4.4.5-linux-x86_64', source: 'https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-linux-x86_64.tar.gz', sha256: 'ed85135c5a5135b45e50423cb406dea04ca3338da0b8ef3c9ede963559680be0' });
  assert.throws(() => cmakeFor('riscv64'), { code: 'SPEECH_INSTALL_PLATFORM' });
});

test('HuggingFace endpoint is optional, allowlisted and keeps the pinned path', () => {
  const pinned = 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/ca27d74bc954b73dadab5b71ca265d87fc861a7c/model.gguf';
  assert.equal(hfUrl(pinned), pinned);
  assert.equal(hfUrl(pinned, 'https://hf-mirror.com'), 'https://hf-mirror.com/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/ca27d74bc954b73dadab5b71ca265d87fc861a7c/model.gguf');
  const github = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/x.tar.bz2';
  assert.equal(hfUrl(github, 'https://hf-mirror.com'), github);
  assert.throws(() => hfUrl(pinned, 'https://example.com'), { code: 'SPEECH_INSTALL_ARGUMENTS' });
});

test('GGUF files can come from ModelScope; the pinned sha256 in the manifest still applies', () => {
  const entry = { id: 'qwen3-tts-1.7b-base-q4-k-m', source: 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', revision: 'ca27d74bc954b73dadab5b71ca265d87fc861a7c', modelscope: 'https://www.modelscope.cn/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', modelscopeRevision: 'master' };
  assert.equal(ggufUrl(entry, 'a.gguf'), 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/ca27d74bc954b73dadab5b71ca265d87fc861a7c/a.gguf');
  assert.equal(ggufUrl(entry, 'a.gguf', { hfEndpoint: 'https://hf-mirror.com' }), 'https://hf-mirror.com/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/ca27d74bc954b73dadab5b71ca265d87fc861a7c/a.gguf');
  assert.equal(ggufUrl(entry, 'a.gguf', { modelSource: 'modelscope' }), 'https://www.modelscope.cn/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/master/a.gguf');
  assert.throws(() => ggufUrl({ ...entry, modelscope: 'https://example.com/x' }, 'a.gguf', { modelSource: 'modelscope' }), { code: 'SPEECH_INSTALL_MANIFEST' });
  assert.throws(() => ggufUrl(entry, 'a.gguf', { modelSource: 'mirror' }), { code: 'SPEECH_INSTALL_ARGUMENTS' });
});

test('--proxy accepts only a bare http(s) origin and bypasses ModelScope/hf-mirror', () => {
  const env = proxyEnv('http://127.0.0.1:7890');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890'); assert.equal(env.https_proxy, 'http://127.0.0.1:7890'); assert.match(env.NO_PROXY, /modelscope\.cn/); assert.match(env.NO_PROXY, /hf-mirror\.com/);
  for (const bad of ['socks5://127.0.0.1:1080', 'http://user:secret@127.0.0.1:7890', 'http://127.0.0.1:7890/path', 'not a url']) assert.throws(() => proxyEnv(bad), { code: 'SPEECH_INSTALL_ARGUMENTS' });
});
