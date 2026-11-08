import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

// Production units run entrypoints through ~/src/companion/current (a symlink).
test('model gateway runs main() when started through a symlinked release directory', t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-entry-')));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  fs.symlinkSync(project, path.join(temp, 'current'));
  const result = spawnSync(process.execPath, [path.join(temp, 'current/model-gateway/main.mjs'), '--config', path.join(temp, 'missing.json')], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model gateway failed/);
});

test('no entrypoint guard compares import.meta.url with an unresolved argv[1]', () => {
  const grep = spawnSync('git', ['grep', '-n', '-E', String.raw`pathToFileURL\((path\.resolve\()?process\.argv\[1\]\)`, '--', '*.mjs', '*.js'], { cwd: project, encoding: 'utf8' });
  assert.equal(grep.status, 1, 'use pathToFileURL(fs.realpathSync(process.argv[1])) instead:\n' + grep.stdout + grep.stderr);
});
