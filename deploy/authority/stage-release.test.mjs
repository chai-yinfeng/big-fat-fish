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
  for (const [name, text, mode] of [['package.json', '{}\n', 0o644], ['ops/isolation/bin/dsh', '#!/bin/sh\n', 0o755], [deep, 'x', 0o600]]) {
    fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
    fs.writeFileSync(path.join(tree, name), text, { mode });
  }
  const first = packTar(tree, top, 1700000000);
  fs.utimesSync(path.join(tree, 'package.json'), new Date(), new Date());
  assert.deepEqual(packTar(tree, top, 1700000000), first);
  const file = path.join(temp, top + '.tar.gz');
  fs.writeFileSync(file, first);
  const listing = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8' });
  assert.match(listing, /-rwxr-xr-x .*ops\/isolation\/bin\/dsh/);
  assert.match(listing, new RegExp('-rw-r--r-- .*' + deep));
  const out = path.join(temp, 'out'); fs.mkdirSync(out);
  const script = `import importlib.machinery as m, importlib.util as u, sys
loader = m.SourceFileLoader('cd', sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader('cd', loader)); loader.exec_module(mod)
print(mod.safe_extract(sys.argv[2], sys.argv[3]))`;
  const extracted = execFileSync('python3', ['-I', '-W', 'ignore', '-c', script, path.join(here, 'companion-deploy/companion-deploy'), file, out], { encoding: 'utf8' }).trim();
  assert.equal(extracted, top);
  assert.equal(fs.readFileSync(path.join(out, top, deep), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(out, top, 'ops/isolation/bin/dsh'), 'utf8'), '#!/bin/sh\n');
});

test('symlinks are not packed', t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stage-')));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  fs.symlinkSync('/etc/passwd', path.join(temp, 'link'));
  assert.throws(() => packTar(temp, top, 0), /only files and directories/);
});
