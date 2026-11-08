import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cmakeFor, hfUrl, ggufUrl, proxyEnv, localArchive, speechInstallPlan } from './install-speech.mjs';
import { prepareSpeech } from './prepare-speech.mjs';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speech-install-test-')));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^speech-install-test-/); fs.rmSync(root, { recursive: true }); });
  return root;
}

test('--archive-dir copies are used only when size and pinned sha256 match', async t => {
  const dir = tempRoot(t), data = Buffer.from('synthetic archive bytes'), expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  fs.writeFileSync(path.join(dir, 'good.tar.bz2'), data);
  fs.writeFileSync(path.join(dir, 'tampered.tar.bz2'), Buffer.from('synthetic archive bytez'));
  fs.symlinkSync(path.join(dir, 'good.tar.bz2'), path.join(dir, 'link.tar.bz2'));
  assert.equal(await localArchive(dir, 'good.tar.bz2', expected), path.join(dir, 'good.tar.bz2'));
  assert.equal(await localArchive(dir, 'absent.tar.bz2', expected), null);
  assert.equal(await localArchive(undefined, 'good.tar.bz2', expected), null);
  assert.equal(await localArchive(dir, 'good.tar.bz2', { bytes: data.length }), null);
  await assert.rejects(localArchive(dir, 'tampered.tar.bz2', expected), { code: 'SPEECH_DOWNLOAD_DIGEST' });
  await assert.rejects(localArchive(dir, 'good.tar.bz2', { ...expected, bytes: data.length + 1 }), { code: 'SPEECH_DOWNLOAD_DIGEST' });
  await assert.rejects(localArchive(dir, 'link.tar.bz2', expected), { code: 'SPEECH_INSTALL_TARGET' });
});

test('prepared manifest pins the Qwen3-ASR archive digest (no SenseVoice) and the plan rejects a changed pin', async t => {
  const root = tempRoot(t), base = path.join(root, 'companion-world-v1');
  fs.mkdirSync(path.join(base, 'operator'), { recursive: true }); fs.writeFileSync(path.join(base, 'operator/authority.json'), '{}');
  prepareSpeech(base, path.join(root, 'runtime'));
  const manifestFile = path.join(base, 'operator/speech-models.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const entry of manifest.models.filter(m => !m.files)) { assert.match(entry.sha256, /^[a-f0-9]{64}$/); assert.ok(entry.bytes > 0); assert.equal(entry.digestPendingDownload, undefined); }
  const plan = speechInstallPlan({ base, models: 'asr', archiveDir: root });
  assert.equal(plan.archiveDir, root); assert.equal(plan.writesPerformed, false);
  assert.deepEqual(plan.selected, ['qwen3-asr-0.6b-int8-2026-03-25']); assert.equal(manifest.models.some(m => /sensevoice/.test(m.id)), false);
  assert.deepEqual(speechInstallPlan({ base }).selected, ['qwen3-asr-0.6b-int8-2026-03-25', 'qwen3-tts-1.7b-base-q4-k-m']);
  assert.throws(() => speechInstallPlan({ base, archiveDir: 'relative/dir' }), { code: 'SPEECH_INSTALL_ARGUMENTS' });
  assert.throws(() => speechInstallPlan({ base, archiveDir: path.join(root, 'missing') }), { code: 'SPEECH_INSTALL_ARGUMENTS' });
  manifest.models[0].sha256 = '0'.repeat(64); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => speechInstallPlan({ base, models: 'asr' }), { code: 'SPEECH_INSTALL_MANIFEST' });
});

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
