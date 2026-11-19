import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, validate, KEYS, defaults } from './config.mjs';

function file(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-gateway-config-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const target = path.join(root, 'model-gateway.json');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  return target;
}
const GOOD = { settingsFile: '/w/model-data/settings.json', inferenceSocket: '/w/ipc/model/inference.sock', controlSocket: '/w/ipc/model-control/control.sock', inferenceTokenHash: 'a'.repeat(64), operatorTokenHash: 'b'.repeat(64), authority: { socketPath: '/w/a.sock', tokenFile: '/w/t' } };

test('model-gateway.json: unknown keys are ignored at startup with one line naming them, refused when strict', async t => {
  const target = file(t, { ...GOOD, upstream: 'https://example.invalid', authority: { ...GOOD.authority, extra: 1 }, budgets: { web: 3, audio: 1 } });
  const lines = [];
  const config = await load(target, { warn: line => lines.push(line) });
  assert.deepEqual(config, { ...GOOD, budgets: { web: 3 } });
  assert.deepEqual(lines, ['model-gateway.json: ignoring unknown keys authority.extra, upstream, budgets.audio']);
  await assert.rejects(load(target, { strict: true }), { code: 'CONFIG_UNKNOWN_KEY', fields: ['authority.extra', 'upstream', 'budgets.audio'] });
});

test('model-gateway.json: values the gateway refuses, missing keys and unsafe files are still refused', async t => {
  for (const bad of [{ budgets: { web: 1001 } }, { inferenceTokenHash: 'b'.repeat(64) }, { settingsFile: 'relative' }, { controlSocket: GOOD.inferenceSocket }, { authority: null }]) assert.throws(() => validate({ ...GOOD, ...bad }), { code: 'CONFIG_INVALID' }, JSON.stringify(bad));
  for (const key of Object.keys(KEYS).filter(key => KEYS[key].required)) { const c = { ...GOOD }; delete c[key]; assert.throws(() => validate(c), { code: 'CONFIG_INVALID' }, key); }
  const target = file(t, GOOD);
  fs.chmodSync(target, 0o644);
  await assert.rejects(load(target), { code: 'CONFIG_PERMISSIONS' });
  fs.chmodSync(target, 0o600); fs.writeFileSync(target, '{broken');
  await assert.rejects(load(target), { code: 'CONFIG_UNREADABLE' });
  assert.deepEqual(defaults.budgets, { web: 20, vision: 12 });
});
