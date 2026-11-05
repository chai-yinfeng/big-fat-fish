#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSpeech } from './prepare-speech.mjs';

const CMAKE = { version: '4.4.5', directory: 'cmake-4.4.5-linux-aarch64', source: 'https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-linux-aarch64.tar.gz', sha256: '301d5063ab259577c1b57ce5490b1aab9ea5c56dc4c822f73499553dab94925f' };
const LLAMA_COMMIT = '8642541b255bfb5dc39cd351a178be09013a55d6';
const SOURCES = {
  'sensevoice-small-int8-2024-07-17': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  'qwen3-asr-0.6b-int8-2026-03-25': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
  'kokoro-v1.1-zh-int8': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
  'qwen3-tts-1.7b-base-q4-k-m': 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF',
};
const GGUF_FILES = [
  { name: 'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf', bytes: 1035965280, sha256: '8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129' },
  { name: 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf', bytes: 446422912, sha256: '6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2' },
];
const GGUF_REVISION = 'ca27d74bc954b73dadab5b71ca265d87fc861a7c';
const fail = code => Object.assign(new Error(code), { code });
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const defaultBase = () => path.join(os.homedir(), '.local/share/companion-world-v1');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function basePath(value) {
  let base;
  try { base = fs.realpathSync(value); } catch { throw fail('SPEECH_INSTALL_TARGET'); }
  const authority = path.join(base, 'operator/authority.json');
  if (path.basename(base) !== 'companion-world-v1' || !fs.statSync(base).isDirectory() || !fs.statSync(authority).isFile() || !inside(base, fs.realpathSync(authority))) throw fail('SPEECH_INSTALL_TARGET');
  return base;
}
function target(root, relative) {
  const file = path.resolve(root, relative);
  if (!inside(root, file) || file === root) throw fail('SPEECH_INSTALL_TARGET');
  let existing = file;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!inside(root, fs.realpathSync(existing))) throw fail('SPEECH_INSTALL_TARGET');
  return file;
}
function directory(root, relative) {
  const file = target(root, relative);
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  if (!fs.statSync(file).isDirectory() || fs.realpathSync(file) !== file) throw fail('SPEECH_INSTALL_TARGET');
  return file;
}
function modelSelections(config, manifest, models) {
  const selections = [['asr', 'light'], ['tts', 'light'], ...(models === 'all' ? [['asr', 'heavy'], ['tts', 'heavy']] : [])];
  return selections.map(([kind, quality]) => {
    const engine = config.models[kind][quality], entry = manifest.models.find(m => m.id === engine.id);
    if (!entry || entry.source !== SOURCES[entry.id]) throw fail('SPEECH_INSTALL_MANIFEST');
    if (entry.files && (entry.revision !== GGUF_REVISION || JSON.stringify(entry.files) !== JSON.stringify(GGUF_FILES))) throw fail('SPEECH_INSTALL_MANIFEST');
    return { kind, quality, engine, entry };
  });
}
export function speechInstallPlan({ base = defaultBase(), models = 'all' } = {}) {
  if (!['light', 'all'].includes(models)) throw fail('SPEECH_INSTALL_ARGUMENTS');
  base = basePath(base);
  const prepared = fs.existsSync(path.join(base, 'operator/speech.json')) && fs.existsSync(path.join(base, 'operator/speech-models.json'));
  const selected = prepared ? modelSelections(readJson(path.join(base, 'operator/speech.json')), readJson(path.join(base, 'operator/speech-models.json')), models).map(x => x.entry.id) : Object.keys(SOURCES).filter(id => models === 'all' || id.startsWith('sensevoice') || id.startsWith('kokoro'));
  return { mode: 'plan', models, prepared, targetValidated: true, runtime: 'private speech-node prefix', dependencies: { 'sherpa-onnx-node': '2.0.1', sharp: '0.35.5' }, selected, nativeTts: models === 'all' ? { llamaCpp: 'v0.8.0', commit: LLAMA_COMMIT, portableCmake: CMAKE.version, cpuOnly: true, jobs: 2 } : null, estimatedDiskGiB: models === 'all' ? '8-12 including cache/source/build; estimate, not measured' : '2-3 including cache/runtime; estimate, not measured', actionsRequireApply: ['private npm install with scripts disabled', 'public pinned model downloads and safe extraction', ...(models === 'all' ? ['private portable CMake download', 'pinned llama.cpp clone and CPU-only build'] : [])], inferencePerformed: false, referenceGenerated: false, servicesChanged: false, writesPerformed: false, networkRequestsPerformed: false };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function saveJson(file, value, root) {
  if (target(root, path.relative(root, file)) !== file) throw fail('SPEECH_INSTALL_TARGET');
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw fail('SPEECH_INSTALL_TARGET');
  const temporary = target(root, path.relative(root, file) + '.next-' + randomUUID());
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  // Both absolute paths were validated in the same owned root above.
  fs.renameSync(temporary, file);
}
async function publicResponse(url) {
  let current = new URL(url);
  for (let n = 0; n < 8; n++) {
    if (current.protocol !== 'https:' || current.username || current.password || !['github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'huggingface.co'].includes(current.hostname) && !current.hostname.endsWith('.huggingface.co') && !current.hostname.endsWith('.hf.co')) throw fail('SPEECH_DOWNLOAD_SOURCE');
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(300000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); current = new URL(location, current); continue; }
    if (!response.ok || !response.body) throw fail('SPEECH_DOWNLOAD_FAILED');
    return response;
  }
  throw fail('SPEECH_DOWNLOAD_SOURCE');
}
async function command(executable, args, env, code, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-32768); });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096); });
    child.on('error', () => reject(fail(code)));
    child.on('close', status => {
      if (status === 0) { resolve(output.trim()); return; }
      // Installation uses a clean environment and public dependencies only.
      // Keep a bounded private diagnostic, never reflect it into model errors.
      if (env.SPEECH_INSTALL_LOG) fs.appendFileSync(env.SPEECH_INSTALL_LOG, code + '\n' + diagnostic + '\n' + output + '\n', { mode: 0o600 });
      reject(fail(code));
    });
  });
}
const EXTRACT_PYTHON = `import pathlib,sys,tarfile
archive,stage,top=sys.argv[1:]
root=pathlib.Path(stage).resolve()
with tarfile.open(archive,'r:*') as tar:
 members=tar.getmembers()
 if sum(m.size for m in members)>8*1024**3: raise ValueError('ARCHIVE_SIZE')
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  if p.is_absolute() or not p.parts or p.parts[0]!=top or '..' in p.parts or '\\\\' in m.name: raise ValueError('ARCHIVE_PATH')
  if not (m.isfile() or m.isdir() or m.issym() or m.islnk()): raise ValueError('ARCHIVE_TYPE')
  if m.issym() or m.islnk():
   link=(root/m.name).parent/m.linkname if m.issym() else root/m.linkname
   if not link.resolve().is_relative_to(root/top): raise ValueError('ARCHIVE_LINK')
 tar.extractall(root,filter='data')
`;

export async function installSpeech({ base = defaultBase(), models = 'all', apply = false } = {}) {
  const plan = speechInstallPlan({ base, models });
  if (!apply) return plan;
  if (process.platform !== 'linux' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) !== 24) throw fail('SPEECH_INSTALL_PLATFORM');
  base = basePath(base);
  const privateRoot = fs.realpathSync(path.join(os.homedir(), '.local/opt/companion'));
  if (!inside(privateRoot, fs.realpathSync(process.execPath))) throw fail('SPEECH_PRIVATE_NODE_REQUIRED');
  const stats = fs.statfsSync(base), minFree = (models === 'all' ? 12 : 3) * 1024 ** 3;
  if (stats.bavail * stats.bsize < minFree) throw fail('SPEECH_INSTALL_DISK');
  const runtime = directory(privateRoot, 'speech-node');
  prepareSpeech(base, runtime);
  const config = readJson(path.join(base, 'operator/speech.json')), manifest = readJson(path.join(base, 'operator/speech-models.json'));
  const selected = modelSelections(config, manifest, models), modelRoot = directory(base, 'speech-models');
  const cache = directory(runtime, 'downloads'), metadataFile = path.join(base, 'operator/speech-install.json');
  const metadata = fs.existsSync(metadataFile) ? readJson(metadataFile) : { schemaVersion: 1, downloads: {}, components: {} };
  const persist = () => saveJson(metadataFile, metadata, base);
  const emptyGlobal = target(runtime, 'npm-empty-global.npmrc');
  if (!fs.existsSync(emptyGlobal)) fs.writeFileSync(emptyGlobal, '', { flag: 'wx', mode: 0o600 });
  if (!fs.lstatSync(emptyGlobal).isFile() || fs.statSync(emptyGlobal).size !== 0) throw fail('SPEECH_RUNTIME_CONFLICT');
  const env = { SPEECH_INSTALL_LOG: path.join(runtime, 'install-diagnostics.log'), PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: runtime, TMPDIR: runtime, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', npm_config_userconfig: '/dev/null', npm_config_globalconfig: emptyGlobal };
  async function download(url, name, expected = {}) {
    const file = target(cache, name);
    if (!fs.existsSync(file)) {
      const part = target(cache, name + '.part-' + randomUUID()), response = await publicResponse(url);
      let bytes = 0;
      const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > 3 * 1024 ** 3 ? fail('SPEECH_DOWNLOAD_SIZE') : null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      if (expected.bytes != null && bytes !== expected.bytes || expected.sha256 && await sha256(part) !== expected.sha256) throw fail('SPEECH_DOWNLOAD_DIGEST');
      if (target(cache, name) !== file || fs.existsSync(file)) throw fail('SPEECH_INSTALL_TARGET');
      fs.renameSync(part, file);
    }
    if (!fs.lstatSync(file).isFile()) throw fail('SPEECH_INSTALL_TARGET');
    const digest = await sha256(file), bytes = fs.statSync(file).size;
    if (expected.sha256 && digest !== expected.sha256 || expected.bytes != null && bytes !== expected.bytes) throw fail('SPEECH_DOWNLOAD_DIGEST');
    if (metadata.downloads[name] && (metadata.downloads[name].source !== url || metadata.downloads[name].sha256 !== digest)) throw fail('SPEECH_DOWNLOAD_DIGEST');
    metadata.downloads[name] = { source: url, sha256: digest, bytes, verifiedAgainstPublishedDigest: Boolean(expected.sha256) }; persist();
    return { file, sha256: digest, bytes };
  }
  async function extract(archive, parent, top, finalName, marker) {
    const destination = target(parent, finalName);
    if (fs.existsSync(destination)) {
      const receipt = path.join(destination, '.companion-speech-install.json');
      if (!fs.lstatSync(destination).isDirectory() || !fs.existsSync(receipt) || JSON.stringify(readJson(receipt)) !== JSON.stringify(marker)) throw fail('SPEECH_EXISTING_DIRECTORY_UNMANAGED');
      return destination;
    }
    const staging = fs.mkdtempSync(target(parent, '.speech-extract-'));
    await command('/usr/bin/python3', ['-c', EXTRACT_PYTHON, archive, staging, top], env, 'SPEECH_ARCHIVE_REJECTED');
    const source = path.join(staging, top);
    if (!inside(parent, path.resolve(source)) || fs.realpathSync(source) !== source || !fs.lstatSync(source).isDirectory() || target(parent, finalName) !== destination) throw fail('SPEECH_INSTALL_TARGET');
    fs.writeFileSync(path.join(source, '.companion-speech-install.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    // Validated staged directory -> absent validated destination, with no overwrite or deletion.
    fs.renameSync(source, destination);
    return destination;
  }
  const packageSource = readJson(fileURLToPath(new URL('./media-runtime.package.json', import.meta.url)));
  if (JSON.stringify(packageSource.dependencies) !== JSON.stringify({ 'sherpa-onnx-node': '2.0.1', sharp: '0.35.5' })) throw fail('SPEECH_INSTALL_MANIFEST');
  const packageFile = path.join(runtime, 'package.json');
  if (fs.existsSync(packageFile)) { if (!fs.lstatSync(packageFile).isFile() || JSON.stringify(readJson(packageFile).dependencies) !== JSON.stringify(packageSource.dependencies)) throw fail('SPEECH_RUNTIME_CONFLICT'); }
  else fs.writeFileSync(packageFile, JSON.stringify(packageSource, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const npm = path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../lib/node_modules/npm/bin/npm-cli.js');
  if (!fs.statSync(npm).isFile() || !inside(privateRoot, fs.realpathSync(npm))) throw fail('SPEECH_PRIVATE_NPM_REQUIRED');
  directory(runtime, 'node_modules');
  const lockFile = path.join(runtime, 'package-lock.json');
  if (fs.existsSync(lockFile) && !fs.lstatSync(lockFile).isFile()) throw fail('SPEECH_INSTALL_TARGET');
  await command(process.execPath, [npm, 'install', '--prefix', runtime, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', directory(runtime, 'npm-cache'), '--userconfig=/dev/null', '--globalconfig=' + emptyGlobal], env, 'SPEECH_NPM_FAILED', runtime);
  for (const [name, version] of Object.entries(packageSource.dependencies)) if (readJson(path.join(runtime, 'node_modules', name, 'package.json')).version !== version) throw fail('SPEECH_NPM_VERSION');
  metadata.components.npm = { dependencies: packageSource.dependencies, scriptsExecuted: false, lockSha256: await sha256(lockFile) }; persist();
  for (const { engine, entry } of selected) {
    if (!entry.files) {
      const archive = await download(entry.source, path.basename(new URL(entry.source).pathname));
      const top = path.basename(new URL(entry.source).pathname).replace(/\.tar\.bz2$/, '');
      const expected = path.dirname(engine.files.model || engine.files.encoder);
      if (expected !== target(modelRoot, top)) throw fail('SPEECH_INSTALL_MANIFEST');
      await extract(archive.file, modelRoot, top, top, { id: entry.id, source: entry.source, sha256: archive.sha256 });
    } else {
      const destination = target(modelRoot, 'qwen3-tts-1.7b-base-gguf');
      if (path.dirname(engine.model) !== destination || path.dirname(engine.mmproj) !== destination) throw fail('SPEECH_INSTALL_MANIFEST');
      const files = [];
      for (const f of entry.files) files.push({ ...f, cached: await download(`${entry.source}/resolve/${entry.revision}/${f.name}`, f.name, f) });
      if (fs.existsSync(destination)) {
        if (!fs.lstatSync(destination).isDirectory()) throw fail('SPEECH_INSTALL_TARGET');
        for (const f of files) { const file = target(destination, f.name); if (!fs.lstatSync(file).isFile() || await sha256(file) !== f.sha256) throw fail('SPEECH_EXISTING_DIRECTORY_UNMANAGED'); }
      } else {
        const staging = fs.mkdtempSync(target(modelRoot, '.speech-gguf-'));
        for (const f of files) fs.copyFileSync(f.cached.file, target(staging, f.name), fs.constants.COPYFILE_EXCL);
        const card = await download(`https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/raw/${entry.upstreamRevision}/README.md`, 'qwen3-tts-upstream-model-card.md');
        const license = await download('https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/022e286b98fbec7e1e916cb940cdf532cd9f488e/LICENSE', 'qwen3-tts-Apache-LICENSE.txt');
        fs.copyFileSync(card.file, target(staging, 'UPSTREAM_MODEL_CARD.md'), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(license.file, target(staging, 'LICENSE'), fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(target(staging, 'SOURCE.json'), JSON.stringify({ source: entry.source, revision: entry.revision, files: entry.files, upstream: entry.upstream, upstreamRevision: entry.upstreamRevision }), { mode: 0o600, flag: 'wx' });
        if (target(modelRoot, path.basename(destination)) !== destination || fs.existsSync(destination)) throw fail('SPEECH_INSTALL_TARGET');
        fs.renameSync(staging, destination);
      }
    }
    metadata.components[entry.id] = { installed: true, inferenceVerified: false }; persist();
  }
  if (models === 'all') {
    if (manifest.runtime.llamaCpp.commit !== LLAMA_COMMIT || manifest.runtime.llamaCpp.version !== 'v0.8.0' || manifest.runtime.llamaCpp.source !== 'https://github.com/ggml-org/llama.cpp') throw fail('SPEECH_INSTALL_MANIFEST');
    const cmakeArchive = await download(CMAKE.source, CMAKE.directory + '.tar.gz', { sha256: CMAKE.sha256 });
    const tools = directory(runtime, 'tools');
    const cmakeRoot = await extract(cmakeArchive.file, tools, CMAKE.directory, CMAKE.directory, { version: CMAKE.version, source: CMAKE.source, sha256: CMAKE.sha256 });
    const source = target(runtime, 'llama.cpp');
    if (!fs.existsSync(source)) await command('/usr/bin/git', ['clone', '--no-checkout', '--depth', '1', '--branch', 'v0.8.0', 'https://github.com/ggml-org/llama.cpp', source], env, 'SPEECH_GIT_FAILED', runtime);
    if (fs.realpathSync(source) !== source || !fs.lstatSync(path.join(source, '.git')).isDirectory() || fs.realpathSync(path.join(source, '.git')) !== path.join(source, '.git') || await command('/usr/bin/git', ['-C', source, 'rev-parse', 'HEAD'], env, 'SPEECH_GIT_FAILED') !== LLAMA_COMMIT || await command('/usr/bin/git', ['-C', source, 'remote', 'get-url', 'origin'], env, 'SPEECH_GIT_FAILED') !== 'https://github.com/ggml-org/llama.cpp') throw fail('SPEECH_GIT_REVISION');
    if (!fs.existsSync(path.join(source, 'CMakeLists.txt'))) await command('/usr/bin/git', ['-C', source, 'checkout', '--detach', LLAMA_COMMIT], env, 'SPEECH_GIT_FAILED');
    await command('/usr/bin/git', ['-C', source, 'diff', '--quiet'], env, 'SPEECH_GIT_MODIFIED');
    await command('/usr/bin/git', ['-C', source, 'diff', '--cached', '--quiet'], env, 'SPEECH_GIT_MODIFIED');
    const cmake = path.join(cmakeRoot, 'bin/cmake'), build = target(source, 'build');
    await command(cmake, ['-S', source, '-B', build, '-G', 'Unix Makefiles', '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF', '-DGGML_METAL=OFF', '-DGGML_CPU_KLEIDIAI=OFF', '-DGGML_BLAS=OFF', '-DLLAMA_OPENSSL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=OFF', '-DLLAMA_BUILD_APP=OFF', '-DLLAMA_CONNECT=OFF'], env, 'SPEECH_CMAKE_FAILED');
    await command(cmake, ['--build', build, '--target', 'llama-tts', '-j2'], env, 'SPEECH_BUILD_FAILED');
    if (config.models.tts.heavy.executable !== path.join(build, 'bin/llama-tts') || !fs.statSync(config.models.tts.heavy.executable).isFile()) throw fail('SPEECH_INSTALL_MANIFEST');
    metadata.components.llamaCpp = { version: 'v0.8.0', commit: LLAMA_COMMIT, cpuOnly: true, cmake: CMAKE.version, inferenceVerified: false }; persist();
  }
  return { mode: 'apply', models, installed: selected.map(x => x.entry.id), npm: metadata.components.npm.dependencies, nativeTtsBuilt: models === 'all', inferencePerformed: false, referenceGenerated: false, servicesChanged: false, worldReset: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const options = { apply: false, models: 'all' };
    let explicitMode;
    for (let i = 2; i < process.argv.length; i++) {
      const value = process.argv[i];
      if (value === '--plan' || value === '--apply') { if (explicitMode) throw fail('SPEECH_INSTALL_ARGUMENTS'); explicitMode = value; options.apply = value === '--apply'; }
      else if (value === '--base' || value === '--models') { const next = process.argv[++i]; if (!next || next.startsWith('--')) throw fail('SPEECH_INSTALL_ARGUMENTS'); options[value.slice(2)] = next; }
      else throw fail('SPEECH_INSTALL_ARGUMENTS');
    }
    process.stdout.write(JSON.stringify(await installSpeech(options)) + '\n');
  } catch (e) { process.stderr.write(/^SPEECH_[A-Z_]+$/.test(e.code || '') ? e.code + '\n' : 'SPEECH_INSTALL_FAILED\n'); process.exitCode = 1; }
}
