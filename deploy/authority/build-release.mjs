#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const project = fileURLToPath(new URL('../../', import.meta.url));
const sourceRevision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: project, encoding: 'utf8' });
if (!/^[a-f0-9]{40,64}$/.test(sourceRevision) || changes.trim()) throw new Error('Release requires a committed, clean source tree');
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('Root package.json needs a plain semantic version');
// Deploy-managed release name: authority-<version>-<first 12 hex of the commit>.
const releaseName = `authority-${version}-${sourceRevision.slice(0, 12)}`;
const output = path.resolve(process.argv[2] || path.join(project, '.build', releaseName));
if (fs.existsSync(output)) throw new Error('Refusing to overwrite a versioned release');
fs.mkdirSync(output, { recursive: true });
const copied = {}, executables = [];
function record(destination, bytes, mode) {
  copied[destination] = createHash('sha256').update(bytes).digest('hex');
  if (mode & 0o111) executables.push(destination);
}
function write(destination, text) {
  const target = path.join(output, destination);
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o644 });
  record(destination, Buffer.from(text), 0o644);
}
function copy(relative, destination = relative) {
  const source = path.join(project, relative), target = path.join(output, destination);
  const stat = fs.lstatSync(source);
  if (path.basename(relative).startsWith('._') || path.basename(relative) === '.DS_Store' || stat.isSymbolicLink()) throw new Error('Unadmitted source artifact');
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) copy(path.join(relative, name), path.join(destination, name));
  } else if (stat.isFile()) {
    const bytes = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
    record(destination, bytes, stat.mode);
  } else throw new Error('Unadmitted source entry');
}
for (const item of ['model-gateway', 'authority/src', 'authority/test', 'authority/package.json', 'authority/PROTOCOL.md', 'capabilities/qq', 'capabilities/memory', 'capabilities/media', 'capabilities/speech', 'capabilities/providers', 'deploy/qq', 'core/src/persona.js', 'core/src/util.js']) copy(item);
// Dependency-free conversation modules used by QQ and the purge; the executor itself is bundled below.
for (const item of ['index.js', 'executor.js', 'client.js', 'sessions.js', 'package.json']) copy('capabilities/conversation/' + item);
for (const item of ['bootstrap.mjs', 'prepare-model.mjs', 'prepare-qq.mjs', 'prepare-conversation.mjs', 'prepare-memory.mjs', 'prepare-speech.mjs', 'prepare-content.mjs', 'prepare-console.mjs', 'install-speech.mjs', 'benchmark-speech.mjs', 'media-runtime.package.json', 'purge-execution.mjs', 'preflight.mjs', 'isolation/launch.py', 'isolation/units']) copy('deploy/authority/' + item, 'ops/' + item);
copy('console/dist', 'console-web');
// One self-contained ESM file (pi-agent-core, pi-ai, openai SDK); no node_modules in a release.
const bundle = 'capabilities/conversation/conversation.mjs';
execFileSync(process.execPath, [path.join(project, 'capabilities/conversation/build.mjs'), path.join(output, bundle)], { cwd: project, stdio: ['ignore', 'ignore', 'inherit'] });
fs.chmodSync(path.join(output, bundle), 0o644);
record(bundle, fs.readFileSync(path.join(output, bundle)), 0o644);
write('package.json', JSON.stringify({ name: '@companion/release', private: true, type: 'module', version, engines: { node: '>=24' } }, null, 2) + '\n');
// schemaVersion 2: `files` lists every release file except this manifest (generated ones included).
const files = Object.fromEntries(Object.entries(copied).sort(([a], [b]) => a < b ? -1 : 1));
fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({ schemaVersion: 2, productVersion: version, releaseName, sourceRevision, files, executables: executables.sort() }, null, 2) + '\n');
console.log(JSON.stringify({ output, releaseName, sourceFiles: Object.keys(copied).length, conversationBundleBytes: fs.statSync(path.join(output, bundle)).size, legacyPluginIncluded: false, privateDataIncluded: false }));
