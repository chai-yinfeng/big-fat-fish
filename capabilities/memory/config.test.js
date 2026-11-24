import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, validate, KEYS, defaults } from './config.js';
import { operatorURL } from './cleanup.js';
import { MemoryConsolidation } from './consolidation.js';

const GOOD = { authority: { socketPath: '/w/a.sock', tokenFile: '/w/t' }, gateway: { socketPath: '/w/i.sock', tokenFile: '/w/i' }, base: '/w', operatorTokenFile: '/w/console.token' };
function file(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-config-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const target = path.join(root, 'memory-worker.json');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  return target;
}

test('memory-worker.json: unknown keys are ignored at startup with one line, refused when strict; old keys are dropped silently', t => {
  const target = file(t, { ...GOOD, future: 1, entityId: 'entity:x', stateFile: '/w/m.json', maxCallsPerDay: 4, purgeModule: '/w/p.mjs' });
  const lines = [], legacy = [];
  assert.deepEqual(load(target, { warn: line => lines.push(line), legacy: keys => legacy.push(...keys) }), GOOD);
  // Only purgeModule is reported: prepare-memory still writes the others (for releases from before c843d93).
  assert.deepEqual([lines, legacy], [['memory-worker.json: ignoring unknown keys future'], ['purgeModule']]);
  assert.throws(() => load(target, { strict: true }), { code: 'CONFIG_UNKNOWN_KEY', fields: ['future'] });
});

test('memory-worker.json: values the worker refuses and missing required keys are still refused', t => {
  for (const bad of [{ tickMs: 999 }, { tickMs: 600001 }, { consolidationDeferMs: 86400001 }, { operatorPort: 0 }, { operatorPort: '3082' }, { base: 'relative' }, { gateway: null }]) assert.throws(() => validate({ ...GOOD, ...bad }), { code: 'CONFIG_INVALID' }, JSON.stringify(bad));
  for (const key of Object.keys(KEYS).filter(key => KEYS[key].required)) { const c = { ...GOOD }; delete c[key]; assert.throws(() => validate(c), { code: 'CONFIG_INVALID' }, key); }
  const target = file(t, GOOD);
  fs.chmodSync(target, 0o640);
  assert.throws(() => load(target), { code: 'CONFIG_PERMISSIONS' });
  // The defaults are the worker's own.
  assert.equal(operatorURL(), `http://127.0.0.1:${defaults.operatorPort}`);
  assert.equal(new MemoryConsolidation({ authority: {}, complete: async () => {} }).deferMs, defaults.consolidationDeferMs);
  assert.equal(defaults.tickMs, 60000);
});
