#!/usr/bin/env node
/** Build one relocatable core product from an explicit source-only allowlist. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(project, '.build/companion-core-0.3.0'));
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite an existing bundle: ${output}`);
fs.mkdirSync(output, { recursive: true });
const hashes = {};
function copy(relative, destination = relative) {
  const source = path.join(project, relative);
  const target = path.join(output, destination);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink is not admitted: ${relative}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) copy(path.join(relative, name), path.join(destination, name));
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    hashes[destination] = createHash('sha256').update(bytes).digest('hex');
  } else throw new Error(`Unsupported source entry: ${relative}`);
}
for (const entry of ['core/src', 'core/test', 'plugin/lib', 'plugin/test']) copy(entry);
copy('plugin/icon.svg', 'icon.svg');
const preset = fs.readFileSync(path.join(project, 'preset/cordis.patch.yml'), 'utf8');
const patch = "- insert:\n    - id: companion-core\n      name: '@local/companion'\n" + preset;
fs.writeFileSync(path.join(output, 'cordis.patch.yml'), patch, { flag: 'wx' });
fs.writeFileSync(path.join(output, 'index.js'), 'export { apply, inject, name } from "./plugin/lib/index.js";\n', { flag: 'wx' });
const manifest = {
  name: '@local/companion', version: '0.3.0', private: true, type: 'module',
  description: 'Companion core: versioned identity, durable memory and an optional capability preset.',
  main: './index.js',
  exports: { '.': './index.js', './cordis.patch.yml': './cordis.patch.yml', './locale/*.json': './locale/*.json', './icon': './icon.svg', './package.json': './package.json' },
  files: ['index.js', 'core/src', 'plugin/lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'build-manifest.json'],
  scripts: { test: 'node --test core/test/*.test.js plugin/test/*.test.js' },
  engines: { node: '>=24', dsh: '>=0.2.1-rc.3 <0.3.0' },
  dependencies: { '@deepseek-ai/node-addon-system': '0.1.2' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
};
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
fs.mkdirSync(path.join(output, 'locale'));
for (const [language, title, description] of [
  ['en', 'Companion — Core', 'Versioned identity and durable memory. This base deployment does not enable QQ, voice, browsing or proactive messages.'],
  ['zh', 'Companion · 基础内核', '版本化人格与持久记忆；本阶段不启用 QQ、语音、浏览或主动发送。'],
]) fs.writeFileSync(path.join(output, 'locale', language + '.json'), JSON.stringify({ meta: { title, description } }, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(output, 'build-manifest.json'), JSON.stringify({ version: 1, sourceFiles: hashes }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sourceFiles: Object.keys(hashes).length, secretsOrRuntimeDataIncluded: false }));
