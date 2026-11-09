import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cmakeFor, hfUrl, ggufUrl, proxyEnv, localArchive, speechInstallPlan, installSpeech, vulkanBuildMissing, VAD, vadUrl, registerVad } from './install-speech.mjs';
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
  assert.deepEqual(plan.selected, ['qwen3-asr-0.6b-int8-2026-03-25', 'silero-vad-v5.1.2']); assert.equal(manifest.models.some(m => /sensevoice/.test(m.id)), false);
  assert.deepEqual(speechInstallPlan({ base }).selected, ['qwen3-asr-0.6b-int8-2026-03-25', 'qwen3-tts-1.7b-base-q4-k-m', 'silero-vad-v5.1.2']);
  const vadPlan = speechInstallPlan({ base, models: 'vad', modelSource: 'modelscope' });
  assert.deepEqual(vadPlan.selected, ['silero-vad-v5.1.2']); assert.equal(vadPlan.writesPerformed, false); assert.equal(vadPlan.vadSource, vadUrl('modelscope'));
  const vadEntry = manifest.models.find(m => m.id === VAD.id);
  assert.deepEqual([vadEntry.source, vadEntry.bytes, vadEntry.sha256], [VAD.source, VAD.bytes, VAD.sha256]);
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

test('the VAD is one sha256-pinned file from GitHub or the identical ModelScope copy', () => {
  assert.equal(VAD.sha256, '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f'); assert.equal(VAD.bytes, 2327524);
  assert.equal(vadUrl(), 'https://raw.githubusercontent.com/snakers4/silero-vad/6478567951ae5c9979ad7b234185b5515f4be7a1/src/silero_vad/data/silero_vad.onnx');
  assert.equal(vadUrl('modelscope'), 'https://www.modelscope.cn/models/pengzhendong/silero-vad/resolve/370539c71ec0ac703627938064cf31c1852186d7/v5/silero_vad.onnx');
  assert.throws(() => vadUrl('mirror'), { code: 'SPEECH_INSTALL_ARGUMENTS' });
});

test('installing the VAD registers it in a pre-VAD config and manifest without a schema change', t => {
  const root = tempRoot(t), base = path.join(root, 'companion-world-v1');
  fs.mkdirSync(path.join(base, 'operator'), { recursive: true });
  prepareSpeech(base, path.join(root, 'runtime'));
  const config = JSON.parse(fs.readFileSync(path.join(base, 'operator/speech.json'), 'utf8')), manifest = JSON.parse(fs.readFileSync(path.join(base, 'operator/speech-models.json'), 'utf8'));
  const file = config.models.vad.file;
  // The shape production has today: no models.vad, maxAudioSeconds 30, no manifest entry.
  delete config.models.vad; config.maxAudioSeconds = 30; manifest.models = manifest.models.filter(m => m.id !== VAD.id);
  const registered = registerVad(config, manifest, file);
  assert.equal(registered.changed, true); assert.equal(config.models.vad, undefined);
  assert.deepEqual(registered.config.models.vad, { id: VAD.id, engine: 'sherpa-silero-vad', file }); assert.equal(registered.config.maxAudioSeconds, 120); assert.equal(registered.config.schemaVersion, 2);
  assert.equal(registered.manifest.models.filter(m => m.id === VAD.id).length, 1);
  assert.equal(registerVad(registered.config, registered.manifest, file).changed, false);
  assert.equal(registerVad({ ...config, maxAudioSeconds: 20 }, manifest, file).config.maxAudioSeconds, 20);
  assert.throws(() => registerVad(registered.config, registered.manifest, path.join(root, 'other.onnx')), { code: 'SPEECH_INSTALL_MANIFEST' });
  assert.throws(() => registerVad(config, { ...manifest, models: [...manifest.models, { id: VAD.id, source: VAD.source, bytes: VAD.bytes, sha256: '0'.repeat(64) }] }, file), { code: 'SPEECH_INSTALL_MANIFEST' });
});

test('llama-tts builds with Vulkan by default; missing build packages are named, --cpu-only opts out', async t => {
  const all = new Set(['/usr/bin/glslc', '/usr/include/vulkan/vulkan.h', '/usr/lib/x86_64-linux-gnu/libvulkan.so', '/usr/include/spirv/unified1/spirv.hpp', '/usr/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake']);
  assert.deepEqual(vulkanBuildMissing({ exists: f => all.has(f), arch: 'x64' }), []);
  assert.deepEqual(vulkanBuildMissing({ exists: f => all.has(f) && !f.includes('SPIRV-Headers'), arch: 'x64' }), ['spirv-headers']);
  assert.deepEqual(vulkanBuildMissing({ exists: () => false, arch: 'arm64' }), ['glslc', 'libvulkan-dev', 'spirv-headers']);
  const root = tempRoot(t), base = path.join(root, 'companion-world-v1');
  fs.mkdirSync(path.join(base, 'operator'), { recursive: true }); fs.writeFileSync(path.join(base, 'operator/authority.json'), '{}');
  const vulkan = speechInstallPlan({ base }), cpu = speechInstallPlan({ base, cpuOnly: true });
  assert.deepEqual([vulkan.nativeTts.vulkan, vulkan.nativeTts.cpuOnly, vulkan.nativeTts.vulkanBuildMissing], [true, false, vulkanBuildMissing()]);
  assert.match(vulkan.actionsRequireApply.at(-1), /Vulkan build/);
  assert.deepEqual([cpu.nativeTts.vulkan, cpu.nativeTts.cpuOnly, cpu.nativeTts.vulkanBuildMissing], [false, true, []]);
  assert.throws(() => speechInstallPlan({ base, models: 'vad', cpuOnly: true }), { code: 'SPEECH_INSTALL_ARGUMENTS' });
  if (vulkanBuildMissing().length) {
    await assert.rejects(installSpeech({ base, apply: true }), error => error.code === 'SPEECH_VULKAN_BUILD_DEPS' && error.missing.length > 0);
    assert.deepEqual(fs.readdirSync(path.join(base, 'operator')), ['authority.json']);
  }
});
