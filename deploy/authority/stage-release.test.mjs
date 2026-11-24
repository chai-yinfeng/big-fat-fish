import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packTar } from './stage-release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const top = 'authority-0.11.0-0123456789ab';

test('release tarball is deterministic and accepted by companion-deploy safe_extract', t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stage-')));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  const tree = path.join(temp, 'tree'), deep = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/file.js';
  for (const [name, text, mode] of [['package.json', '{}\n', 0o644], ['ops/isolation/launch.py', '#!/usr/bin/python3\n', 0o755], [deep, 'x', 0o600]]) {
    fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
    fs.writeFileSync(path.join(tree, name), text, { mode });
  }
  const first = packTar(tree, top, 1700000000);
  fs.utimesSync(path.join(tree, 'package.json'), new Date(), new Date());
  assert.deepEqual(packTar(tree, top, 1700000000), first);
  const file = path.join(temp, top + '.tar.gz');
  fs.writeFileSync(file, first);
  const listing = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8' });
  assert.match(listing, /-rwxr-xr-x .*ops\/isolation\/launch.py/);
  assert.match(listing, new RegExp('-rw-r--r-- .*' + deep));
  const out = path.join(temp, 'out'); fs.mkdirSync(out);
  const script = `import importlib.machinery as m, importlib.util as u, sys
loader = m.SourceFileLoader('cd', sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader('cd', loader)); loader.exec_module(mod)
print(mod.safe_extract(sys.argv[2], sys.argv[3]))`;
  const extracted = execFileSync('python3', ['-I', '-W', 'ignore', '-c', script, path.join(here, 'companion-deploy/companion-deploy'), file, out], { encoding: 'utf8' }).trim();
  assert.equal(extracted, top);
  assert.equal(fs.readFileSync(path.join(out, top, deep), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(out, top, 'ops/isolation/launch.py'), 'utf8'), '#!/usr/bin/python3\n');
});

test('symlinks are not packed', t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stage-')));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  fs.symlinkSync('/etc/passwd', path.join(temp, 'link'));
  assert.throws(() => packTar(temp, top, 0), /only files and directories/);
});

test('every relative import in a built release resolves inside the release', t => {
  const project = path.resolve(here, '../..');
  const modules = path.join(project, 'capabilities/conversation/node_modules');
  assert.ok(fs.existsSync(modules), 'run npm ci in capabilities/conversation first (the release bundles the executor)');
  // build-release.mjs wants a clean commit: build from a throwaway repo holding this working tree.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-release-')));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  const source = path.join(temp, 'src'), output = path.join(temp, 'release');
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: project, encoding: 'utf8' });
  for (const name of listed.split('\0').filter(Boolean)) {
    const from = path.join(project, name);
    if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.copyFileSync(from, path.join(source, name));
    fs.chmodSync(path.join(source, name), fs.statSync(from).mode & 0o777);
  }
  fs.mkdirSync(path.join(source, 'console/dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'console/dist/index.html'), '<!doctype html>\n');
  fs.symlinkSync(modules, path.join(source, 'capabilities/conversation/node_modules'));
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  fs.appendFileSync(path.join(source, '.git/info/exclude'), '/console/dist/\n/capabilities/conversation/node_modules\n');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'release test');
  execFileSync(process.execPath, [path.join(source, 'deploy/authority/build-release.mjs'), output], { cwd: source, stdio: ['ignore', 'ignore', 'pipe'] });
  // Static import/export ... from, side-effect imports and literal dynamic import().
  const pattern = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1|\bimport\s*(['"])(\.{1,2}\/[^'"]+)\3|\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\5\s*\)/g;
  // Known gaps outside the runtime path: shipped tests reaching repo-only fixtures, and an
  // operator-machine script that is never run from a release. Anything new here fails.
  const knownGaps = new Set([
    'capabilities/media/video.test.js -> ../../deploy/staging/fake-ytdlp.mjs',
    'capabilities/speech/runner.test.js -> ../../deploy/authority/prepare-speech.mjs',
    'capabilities/speech/segments.test.js -> ../../deploy/authority/prepare-speech.mjs',
    'deploy/qq/open-login.mjs -> ../authority/companion-sudo.mjs',
  ]);
  const missing = [];
  let scanned = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.m?js$/.test(entry.name)) continue;
      scanned++;
      for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) {
        const specifier = match[2] || match[4] || match[6];
        const edge = path.relative(output, file) + ' -> ' + specifier;
        if (!fs.existsSync(path.resolve(path.dirname(file), specifier)) && !knownGaps.has(edge)) missing.push(edge);
      }
    }
  })(output);
  assert.ok(scanned > 50, 'release scan found too few modules: ' + scanned);
  assert.deepEqual(missing, []);
});
