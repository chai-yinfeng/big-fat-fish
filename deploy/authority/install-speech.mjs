#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSpeech } from './prepare-speech.mjs';

const fail = code => Object.assign(new Error(code), { code });

// sha256 values from Kitware's official cmake-4.4.5-SHA-256.txt release asset.
const CMAKE_SHA256 = { aarch64: '301d5063ab259577c1b57ce5490b1aab9ea5c56dc4c822f73499553dab94925f', x86_64: 'ed85135c5a5135b45e50423cb406dea04ca3338da0b8ef3c9ede963559680be0' };
const MACHINE = { arm64: 'aarch64', x64: 'x86_64' };
export function cmakeFor(arch = process.arch) {
  const machine = MACHINE[arch];
  if (!machine) throw fail('SPEECH_INSTALL_PLATFORM');
  const directory = `cmake-4.4.5-linux-${machine}`;
  return { version: '4.4.5', directory, source: `https://github.com/Kitware/CMake/releases/download/v4.4.5/${directory}.tar.gz`, sha256: CMAKE_SHA256[machine] };
}
// Optional mirror for huggingface.co; pinned revisions and digests stay unchanged.
const HF_ENDPOINTS = ['https://huggingface.co', 'https://hf-mirror.com'];
export function hfUrl(url, endpoint = HF_ENDPOINTS[0]) {
  if (!HF_ENDPOINTS.includes(endpoint)) throw fail('SPEECH_INSTALL_ARGUMENTS');
  return url.startsWith(HF_ENDPOINTS[0] + '/') ? endpoint + url.slice(HF_ENDPOINTS[0].length) : url;
}
// ModelScope is an alternative source for files with a fixed sha256 (the GGUFs).
// On home-agent it ran ~30 MB/s direct while GitHub assets via proxy returned 504
// and hf-mirror stalled on large files.
export const MODEL_SOURCES = ['huggingface', 'modelscope'];
export function ggufUrl(entry, name, { modelSource = 'huggingface', hfEndpoint = HF_ENDPOINTS[0] } = {}) {
  if (!MODEL_SOURCES.includes(modelSource)) throw fail('SPEECH_INSTALL_ARGUMENTS');
  if (modelSource === 'modelscope') {
    if (entry.modelscope !== MODELSCOPE[entry.id]) throw fail('SPEECH_INSTALL_MANIFEST');
    return `${entry.modelscope}/resolve/${entry.modelscopeRevision}/${name}`;
  }
  return hfUrl(`${entry.source}/resolve/${entry.revision}/${name}`, hfEndpoint);
}
// --proxy is for GitHub/npm/git only; ModelScope and hf-mirror are reached directly.
export function proxyEnv(proxy) {
  let url; try { url = new URL(proxy); } catch { throw fail('SPEECH_INSTALL_ARGUMENTS'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('SPEECH_INSTALL_ARGUMENTS');
  const value = url.origin, noProxy = 'modelscope.cn,.modelscope.cn,hf-mirror.com,localhost,127.0.0.1';
  return { HTTPS_PROXY: value, HTTP_PROXY: value, https_proxy: value, http_proxy: value, NO_PROXY: noProxy, no_proxy: noProxy };
}
const LLAMA_COMMIT = '8642541b255bfb5dc39cd351a178be09013a55d6';
// llama-tts is built with Vulkan (iGPU) unless --cpu-only. These Ubuntu packages are
// build-time only (all files must exist); at runtime it needs libvulkan1 + Mesa.
export function vulkanBuildMissing({ exists = fs.existsSync, arch = process.arch } = {}) {
  const lib = `/usr/lib/${MACHINE[arch] ?? arch}-linux-gnu`;
  const packages = { glslc: ['/usr/bin/glslc'], 'libvulkan-dev': ['/usr/include/vulkan/vulkan.h', `${lib}/libvulkan.so`], 'spirv-headers': ['/usr/include/spirv/unified1/spirv.hpp', '/usr/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake'] };
  return Object.keys(packages).filter(name => !packages[name].every(file => exists(file)));
}
const SOURCES = {
  'qwen3-asr-0.6b-int8-2026-03-25': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
  'qwen3-tts-1.7b-base-q4-k-m': 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF',
};
// sha256 observed on a direct GitHub download (2026-11-08); upstream publishes none.
// Must match the manifest written by prepare-speech.mjs.
const ARCHIVES = {
  'qwen3-asr-0.6b-int8-2026-03-25': { bytes: 878702423, sha256: '393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96' },
};
// Confirmed via the ModelScope file API: same names, sizes and sha256 as GGUF_FILES.
// TODO(speech-install): a ModelScope path for the sherpa Qwen3-ASR archive is not
// confirmed. GitHub release assets fail from home-agent even via the proxy, so fetch
// it elsewhere and pass --archive-dir; the pinned sha256 is still checked.
/** A pre-fetched copy of a sha256-pinned download: the file `<dir>/<name>` if
 * present (regular file, digest and size must match), null if absent. */
export async function localArchive(dir, name, expected) {
  if (dir === undefined || !expected?.sha256) return null;
  const file = path.join(dir, name);
  if (path.basename(file) !== name || path.dirname(file) !== dir) throw fail('SPEECH_INSTALL_TARGET');
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw fail('SPEECH_INSTALL_TARGET'); }
  if (!stat.isFile()) throw fail('SPEECH_INSTALL_TARGET');
  if (expected.bytes != null && stat.size !== expected.bytes || await sha256(file) !== expected.sha256) throw fail('SPEECH_DOWNLOAD_DIGEST');
  return file;
}
function archiveDirectory(value) {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) throw fail('SPEECH_INSTALL_ARGUMENTS');
  let real; try { real = fs.realpathSync(value); } catch { throw fail('SPEECH_INSTALL_ARGUMENTS'); }
  if (!fs.statSync(real).isDirectory()) throw fail('SPEECH_INSTALL_ARGUMENTS');
  return real;
}
// Silero VAD v5.1.2 (MIT) splits audio over one Qwen3-ASR pass (~30 s). A single ONNX
// file: upstream GitHub at a fixed commit, or the byte-identical ModelScope copy
// (sha256 observed on both, 2026-11-08; upstream publishes none).
export const VAD = { id: 'silero-vad-v5.1.2', engine: 'sherpa-silero-vad', name: 'silero_vad.onnx', directory: 'silero-vad-v5.1.2', bytes: 2327524, sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
  source: 'https://raw.githubusercontent.com/snakers4/silero-vad/6478567951ae5c9979ad7b234185b5515f4be7a1/src/silero_vad/data/silero_vad.onnx',
  modelscope: 'https://www.modelscope.cn/models/pengzhendong/silero-vad', modelscopeRevision: '370539c71ec0ac703627938064cf31c1852186d7', modelscopePath: 'v5/silero_vad.onnx', upstream: 'snakers4/silero-vad', upstreamRevision: 'v5.1.2', license: 'MIT' };
export function vadUrl(modelSource = 'huggingface') {
  if (!MODEL_SOURCES.includes(modelSource)) throw fail('SPEECH_INSTALL_ARGUMENTS');
  return modelSource === 'modelscope' ? `${VAD.modelscope}/resolve/${VAD.modelscopeRevision}/${VAD.modelscopePath}` : VAD.source;
}
const OLD_DEFAULT_AUDIO_SECONDS = 30, LONG_AUDIO_SECONDS = 120;
/** Registers the installed VAD in a speech config/manifest that predates it (no schema change).
 * Returns copies plus whether anything changed; a conflicting existing entry is refused. */
export function registerVad(config, manifest, file) {
  config = structuredClone(config); manifest = structuredClone(manifest);
  let changed = false;
  const existing = config.models.vad;
  if (existing !== undefined) { if (existing?.id !== VAD.id || existing.engine !== VAD.engine || existing.file !== file) throw fail('SPEECH_INSTALL_MANIFEST'); }
  else { config.models.vad = { id: VAD.id, engine: VAD.engine, file }; changed = true; }
  // Only the old prepared default is raised; an operator's own value stays.
  if (config.maxAudioSeconds === OLD_DEFAULT_AUDIO_SECONDS) { config.maxAudioSeconds = LONG_AUDIO_SECONDS; changed = true; }
  const entry = manifest.models.find(m => m.id === VAD.id);
  if (entry) { if (entry.source !== VAD.source || entry.sha256 !== VAD.sha256 || entry.bytes !== VAD.bytes) throw fail('SPEECH_INSTALL_MANIFEST'); }
  else { const { id, source, modelscope, modelscopeRevision, modelscopePath, upstream, upstreamRevision, license, bytes, sha256 } = VAD; manifest.models.push({ id, source, modelscope, modelscopeRevision, modelscopePath, upstream, upstreamRevision, license, bytes, sha256 }); changed = true; }
  return { config, manifest, changed };
}
const MODELSCOPE = { 'qwen3-tts-1.7b-base-q4-k-m': 'https://www.modelscope.cn/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF' };
const GGUF_FILES = [
  { name: 'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf', bytes: 1035965280, sha256: '8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129' },
  { name: 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf', bytes: 446422912, sha256: '6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2' },
];
const GGUF_REVISION = 'ca27d74bc954b73dadab5b71ca265d87fc861a7c';
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
  if (config.schemaVersion !== 2 || manifest.schemaVersion !== 2) throw fail('SPEECH_CONFIG_SCHEMA');
  if (models === 'vad') return [];
  const selections = [['asr', 'default'], ...(models === 'all' ? [['tts', 'llama-tts']] : [])];
  return selections.map(([kind, key]) => {
    const engine = config.models[kind][key], entry = manifest.models.find(m => m.id === engine?.id);
    if (!entry || entry.source !== SOURCES[entry.id]) throw fail('SPEECH_INSTALL_MANIFEST');
    if (!entry.files && (entry.sha256 !== ARCHIVES[entry.id]?.sha256 || entry.bytes !== ARCHIVES[entry.id]?.bytes)) throw fail('SPEECH_INSTALL_MANIFEST');
    if (entry.files && (entry.revision !== GGUF_REVISION || JSON.stringify(entry.files) !== JSON.stringify(GGUF_FILES))) throw fail('SPEECH_INSTALL_MANIFEST');
    return { kind, key, engine, entry };
  });
}
export function speechInstallPlan({ base = defaultBase(), models = 'all', hfEndpoint = HF_ENDPOINTS[0], modelSource = 'huggingface', proxy, archiveDir, cpuOnly = false } = {}) {
  if (!['asr', 'all', 'vad'].includes(models) || !HF_ENDPOINTS.includes(hfEndpoint) || !MODEL_SOURCES.includes(modelSource) || typeof cpuOnly !== 'boolean' || cpuOnly && models !== 'all') throw fail('SPEECH_INSTALL_ARGUMENTS');
  if (proxy !== undefined) proxyEnv(proxy);
  archiveDir = archiveDirectory(archiveDir);
  base = basePath(base);
  const prepared = fs.existsSync(path.join(base, 'operator/speech.json')) && fs.existsSync(path.join(base, 'operator/speech-models.json'));
  const selected = prepared ? modelSelections(readJson(path.join(base, 'operator/speech.json')), readJson(path.join(base, 'operator/speech-models.json')), models).map(x => x.entry.id) : Object.keys(SOURCES).filter(id => models === 'all' || models === 'asr' && !id.startsWith('qwen3-tts'));
  selected.push(VAD.id);
  if (models === 'vad') return { mode: 'plan', models, prepared, targetValidated: true, selected, modelSource, vadSource: vadUrl(modelSource), proxy: proxy === undefined ? null : new URL(proxy).origin, archiveDir: archiveDir ?? null, estimatedDiskMiB: 5, actionsRequireApply: ['public pinned VAD model download', 'register models.vad in operator/speech.json (raises maxAudioSeconds 30 -> 120)'], inferencePerformed: false, servicesChanged: false, writesPerformed: false, networkRequestsPerformed: false };
  return { mode: 'plan', models, prepared, targetValidated: true, runtime: 'private speech-node prefix', dependencies: { 'sherpa-onnx-node': '2.0.1', sharp: '0.35.5' }, selected, hfEndpoint, modelSource, proxy: proxy === undefined ? null : new URL(proxy).origin, archiveDir: archiveDir ?? null, nativeTts: models === 'all' ? { llamaCpp: 'v0.8.0', commit: LLAMA_COMMIT, portableCmake: '4.4.5', cpuOnly, vulkan: !cpuOnly, vulkanBuildMissing: cpuOnly ? [] : vulkanBuildMissing(), jobs: 2 } : null, estimatedDiskGiB: models === 'all' ? '8-12 including cache/source/build; estimate, not measured' : '3-4 including cache/runtime; estimate, not measured', actionsRequireApply: ['private npm install with scripts disabled', 'public pinned model downloads and safe extraction', ...(models === 'all' ? ['private portable CMake download', cpuOnly ? 'pinned llama.cpp clone and CPU-only build' : 'pinned llama.cpp clone and Vulkan build'] : [])], inferencePerformed: false, referenceGenerated: false, servicesChanged: false, writesPerformed: false, networkRequestsPerformed: false };
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
    if (current.protocol !== 'https:' || current.username || current.password || !['github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'huggingface.co', 'hf-mirror.com', 'modelscope.cn'].includes(current.hostname) && !current.hostname.endsWith('.huggingface.co') && !current.hostname.endsWith('.hf.co') && !current.hostname.endsWith('.modelscope.cn')) throw fail('SPEECH_DOWNLOAD_SOURCE');
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

export async function installSpeech({ base = defaultBase(), models = 'all', hfEndpoint = HF_ENDPOINTS[0], modelSource = 'huggingface', proxy, archiveDir, cpuOnly = false, apply = false } = {}) {
  const plan = speechInstallPlan({ base, models, hfEndpoint, modelSource, proxy, archiveDir, cpuOnly });
  if (!apply) return plan;
  // Refuse before any download rather than silently building CPU-only.
  if (plan.nativeTts?.vulkanBuildMissing.length) throw Object.assign(fail('SPEECH_VULKAN_BUILD_DEPS'), { missing: plan.nativeTts.vulkanBuildMissing });
  archiveDir = plan.archiveDir ?? undefined;
  // In-process fetch only uses the proxy when Node started with --use-env-proxy (the CLI re-execs).
  if (proxy !== undefined && !process.execArgv.includes('--use-env-proxy')) throw fail('SPEECH_INSTALL_PROXY');
  if (process.platform !== 'linux' || !MACHINE[process.arch] || Number(process.versions.node.split('.')[0]) !== 24) throw fail('SPEECH_INSTALL_PLATFORM');
  const CMAKE = cmakeFor();
  base = basePath(base);
  const privateRoot = fs.realpathSync(path.join(os.homedir(), '.local/opt/companion'));
  if (!inside(privateRoot, fs.realpathSync(process.execPath))) throw fail('SPEECH_PRIVATE_NODE_REQUIRED');
  const stats = fs.statfsSync(base), minFree = (models === 'all' ? 12 : models === 'asr' ? 4 : 0.1) * 1024 ** 3;
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
  const env = { SPEECH_INSTALL_LOG: path.join(runtime, 'install-diagnostics.log'), PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: runtime, TMPDIR: runtime, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', npm_config_userconfig: '/dev/null', npm_config_globalconfig: emptyGlobal, ...(proxy === undefined ? {} : proxyEnv(proxy)) };
  async function download(url, name, expected = {}, fetchUrl = hfUrl(url, hfEndpoint)) {
    const file = target(cache, name);
    if (!fs.existsSync(file)) {
      const part = target(cache, name + '.part-' + randomUUID()), local = await localArchive(archiveDir, name, expected);
      if (local) { fs.copyFileSync(local, part, fs.constants.COPYFILE_EXCL); fetchUrl = 'archive-dir'; }
      else {
        const response = await publicResponse(fetchUrl);
        let bytes = 0;
        const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > 3 * 1024 ** 3 ? fail('SPEECH_DOWNLOAD_SIZE') : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      }
      if (expected.bytes != null && fs.statSync(part).size !== expected.bytes || expected.sha256 && await sha256(part) !== expected.sha256) throw fail('SPEECH_DOWNLOAD_DIGEST');
      if (target(cache, name) !== file || fs.existsSync(file)) throw fail('SPEECH_INSTALL_TARGET');
      fs.renameSync(part, file);
    }
    if (!fs.lstatSync(file).isFile()) throw fail('SPEECH_INSTALL_TARGET');
    const digest = await sha256(file), bytes = fs.statSync(file).size;
    if (expected.sha256 && digest !== expected.sha256 || expected.bytes != null && bytes !== expected.bytes) throw fail('SPEECH_DOWNLOAD_DIGEST');
    if (metadata.downloads[name] && (metadata.downloads[name].source !== url || metadata.downloads[name].sha256 !== digest)) throw fail('SPEECH_DOWNLOAD_DIGEST');
    metadata.downloads[name] = { source: url, ...(fetchUrl === url ? {} : { fetchedFrom: fetchUrl }), sha256: digest, bytes, verifiedAgainstPinnedDigest: Boolean(expected.sha256) }; persist();
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
  if (models !== 'vad') {
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
    // npm selects sherpa-onnx-node's native optional package by os/cpu; require the one for this host.
    if (readJson(path.join(runtime, 'node_modules', `sherpa-onnx-linux-${process.arch}`, 'package.json')).version !== packageSource.dependencies['sherpa-onnx-node']) throw fail('SPEECH_NPM_VERSION');
    metadata.components.npm = { dependencies: packageSource.dependencies, scriptsExecuted: false, lockSha256: await sha256(lockFile) }; persist();
  }
  for (const { engine, entry } of selected) {
    if (!entry.files) {
      const archive = await download(entry.source, path.basename(new URL(entry.source).pathname), { bytes: entry.bytes, sha256: entry.sha256 });
      const top = path.basename(new URL(entry.source).pathname).replace(/\.tar\.bz2$/, '');
      const expected = path.dirname(engine.files.model || engine.files.encoder);
      if (expected !== target(modelRoot, top)) throw fail('SPEECH_INSTALL_MANIFEST');
      await extract(archive.file, modelRoot, top, top, { id: entry.id, source: entry.source, sha256: archive.sha256 });
    } else {
      const destination = target(modelRoot, 'qwen3-tts-1.7b-base-gguf');
      if (path.dirname(engine.model) !== destination || path.dirname(engine.mmproj) !== destination) throw fail('SPEECH_INSTALL_MANIFEST');
      const files = [];
      for (const f of entry.files) files.push({ ...f, cached: await download(`${entry.source}/resolve/${entry.revision}/${f.name}`, f.name, f, ggufUrl(entry, f.name, { modelSource, hfEndpoint })) });
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
        fs.writeFileSync(target(staging, 'SOURCE.json'), JSON.stringify({ source: entry.source, revision: entry.revision, downloadedFrom: modelSource, files: entry.files, upstream: entry.upstream, upstreamRevision: entry.upstreamRevision }), { mode: 0o600, flag: 'wx' });
        if (target(modelRoot, path.basename(destination)) !== destination || fs.existsSync(destination)) throw fail('SPEECH_INSTALL_TARGET');
        fs.renameSync(staging, destination);
      }
    }
    metadata.components[entry.id] = { installed: true, inferenceVerified: false }; persist();
  }
  {
    const destination = target(modelRoot, VAD.directory), file = path.join(destination, VAD.name);
    const cached = await download(VAD.source, VAD.name, VAD, vadUrl(modelSource));
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isDirectory() || !fs.lstatSync(file).isFile() || await sha256(file) !== VAD.sha256) throw fail('SPEECH_EXISTING_DIRECTORY_UNMANAGED');
    } else {
      const staging = fs.mkdtempSync(target(modelRoot, '.speech-vad-'));
      fs.copyFileSync(cached.file, target(staging, VAD.name), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(target(staging, 'SOURCE.json'), JSON.stringify({ source: VAD.source, downloadedFrom: modelSource === 'modelscope' ? vadUrl(modelSource) : VAD.source, upstream: VAD.upstream, upstreamRevision: VAD.upstreamRevision, license: VAD.license, sha256: VAD.sha256 }), { mode: 0o600, flag: 'wx' });
      if (target(modelRoot, VAD.directory) !== destination || fs.existsSync(destination)) throw fail('SPEECH_INSTALL_TARGET');
      fs.renameSync(staging, destination);
    }
    // Configs prepared before long-audio support get models.vad added here (no schema change).
    const registered = registerVad(readJson(path.join(base, 'operator/speech.json')), readJson(path.join(base, 'operator/speech-models.json')), file);
    if (registered.changed) { saveJson(path.join(base, 'operator/speech.json'), registered.config, base); saveJson(path.join(base, 'operator/speech-models.json'), registered.manifest, base); }
    metadata.components[VAD.id] = { installed: true, inferenceVerified: false }; persist();
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
    await command(cmake, ['-S', source, '-B', build, '-G', 'Unix Makefiles', '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=' + (cpuOnly ? 'OFF' : 'ON'), '-DGGML_METAL=OFF', '-DGGML_CPU_KLEIDIAI=OFF', '-DGGML_BLAS=OFF', '-DLLAMA_OPENSSL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=OFF', '-DLLAMA_BUILD_APP=OFF', '-DLLAMA_CONNECT=OFF'], env, 'SPEECH_CMAKE_FAILED');
    await command(cmake, ['--build', build, '--target', 'llama-tts', '-j2'], env, 'SPEECH_BUILD_FAILED');
    if (config.models.tts['llama-tts'].executable !== path.join(build, 'bin/llama-tts') || !fs.statSync(config.models.tts['llama-tts'].executable).isFile()) throw fail('SPEECH_INSTALL_MANIFEST');
    metadata.components.llamaCpp = { version: 'v0.8.0', commit: LLAMA_COMMIT, cpuOnly, vulkan: !cpuOnly, cmake: CMAKE.version, inferenceVerified: false }; persist();
  }
  return { mode: 'apply', models, installed: [...selected.map(x => x.entry.id), VAD.id], npm: metadata.components.npm?.dependencies ?? null, nativeTtsBuilt: models === 'all', inferencePerformed: false, referenceGenerated: false, servicesChanged: false, worldReset: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const options = { apply: false, models: 'all' }, names = { '--hf-endpoint': 'hfEndpoint', '--model-source': 'modelSource', '--archive-dir': 'archiveDir' };
    let explicitMode;
    for (let i = 2; i < process.argv.length; i++) {
      const value = process.argv[i];
      if (value === '--cpu-only') { if (options.cpuOnly) throw fail('SPEECH_INSTALL_ARGUMENTS'); options.cpuOnly = true; }
      else if (value === '--plan' || value === '--apply') { if (explicitMode) throw fail('SPEECH_INSTALL_ARGUMENTS'); explicitMode = value; options.apply = value === '--apply'; }
      else if (['--base', '--models', '--hf-endpoint', '--model-source', '--proxy', '--archive-dir'].includes(value)) { const next = process.argv[++i]; if (!next || next.startsWith('--')) throw fail('SPEECH_INSTALL_ARGUMENTS'); options[names[value] || value.slice(2)] = next; }
      else throw fail('SPEECH_INSTALL_ARGUMENTS');
    }
    if (options.apply && options.proxy !== undefined && !process.execArgv.includes('--use-env-proxy')) {
      // Re-run once with Node's env-proxy support so fetch() honours HTTPS_PROXY/NO_PROXY.
      const child = spawnSync(process.execPath, ['--use-env-proxy', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, ...proxyEnv(options.proxy) } });
      process.exitCode = child.status ?? 1;
    } else process.stdout.write(JSON.stringify(await installSpeech(options)) + '\n');
  } catch (e) {
    if (e.code === 'SPEECH_VULKAN_BUILD_DEPS') process.stderr.write(`SPEECH_VULKAN_BUILD_DEPS: missing ${e.missing.join(', ')}; install them (sudo apt install glslc libvulkan-dev spirv-headers) or re-run with --cpu-only\n`);
    else process.stderr.write(/^SPEECH_[A-Z_]+$/.test(e.code || '') ? e.code + '\n' : 'SPEECH_INSTALL_FAILED\n');
    process.exitCode = 1;
  }
}
