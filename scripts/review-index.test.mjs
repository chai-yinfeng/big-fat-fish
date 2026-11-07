import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('index review accepts normal history, rejects synthetic credentials, and never prints the value', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bff-index-check-')));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  const git = (args, input) => { const r = spawnSync('git', args, { cwd: root, env, input, encoding: 'utf8' }); assert.equal(r.status, 0); return r.stdout.trim(); };
  const review = () => spawnSync(process.execPath, ['scripts/review-index.mjs'], { cwd: root, env, encoding: 'utf8' });
  try {
    git(['read-tree', 'HEAD']);
    assert.equal(review().status, 0);
    const synthetic = 'sk-' + 'X'.repeat(24);
    const blob = git(['hash-object', '-w', '--stdin'], 'apiKey = "' + synthetic + '"\n');
    git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',review-fixture.txt']);
    const bad = review();
    assert.equal(bad.status, 1);
    assert.ok(!bad.stdout.includes(synthetic));
    assert.ok(JSON.parse(bad.stdout).findings.some(x => x.file === 'review-fixture.txt' && x.reason === 'credential_prefix'));
  } finally {
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(dir), /^bff-index-check-/);
    fs.rmSync(dir, { recursive: true });
  }
});
