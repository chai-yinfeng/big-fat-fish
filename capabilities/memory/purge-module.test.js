import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { purgeModuleURL } from './purge-module.js';

test('purge-execution resolves inside the running release, so pruning old releases cannot break it', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-purge-module-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const release = name => {
    fs.mkdirSync(path.join(root, name, 'capabilities/memory'), { recursive: true });
    fs.mkdirSync(path.join(root, name, 'ops'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'ops/purge-execution.mjs'), 'export const purgeExecution = () => {};\n');
  };
  release('authority-0.10.0-old'); release('authority-0.10.1-new');
  fs.symlinkSync('authority-0.10.1-new', path.join(root, 'current'));
  // systemd starts current/…/main.mjs; Node realpaths the entry module into the release directory.
  const entry = pathToFileURL(fs.realpathSync(path.join(root, 'current/capabilities/memory')) + '/main.mjs').href;
  fs.rmSync(path.join(root, 'authority-0.10.0-old'), { recursive: true });
  assert.equal(fileURLToPath(purgeModuleURL(entry)), path.join(root, 'authority-0.10.1-new/ops/purge-execution.mjs'));
  // A development checkout keeps the module under deploy/authority/.
  assert.equal(fileURLToPath(purgeModuleURL()), fileURLToPath(new URL('../../deploy/authority/purge-execution.mjs', import.meta.url)));
  fs.rmSync(path.join(root, 'authority-0.10.1-new/ops'), { recursive: true });
  assert.throws(() => purgeModuleURL(entry), { code: 'MEMORY_PURGE_MODULE' });
});

test('a startup failure logs only a stable code, never the config path', () => {
  const secretPath = path.join(os.tmpdir(), 'token-like-secret-path-does-not-exist.json');
  for (const args of [[], ['--config', secretPath]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./main.mjs', import.meta.url)), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Memory maintenance failed \((MEMORY_CONFIG|ENOENT)\); inspect private configuration\.\n$/);
    assert.doesNotMatch(result.stderr, /token-like-secret/);
  }
});
