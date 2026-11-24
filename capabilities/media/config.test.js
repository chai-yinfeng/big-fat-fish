import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, validate, KEYS, defaults } from './config.js';
import { ArtifactStore } from './artifacts.js';

const GOOD = { store: { root: '/w/media-data' }, workRoot: '/w/speech-data', speechConfigFile: '/w/speech.json', authority: { socketPath: '/w/a.sock', tokenFile: '/w/t' }, gateway: { socketPath: '/w/i.sock', tokenFile: '/w/i' }, sharpModule: '/w/sharp', control: { socketPath: '/w/c.sock', tokenFile: '/w/c' } };
function file(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-content-config-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const target = path.join(root, 'content.json');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  return { root, target };
}

test('content.json: unknown keys are ignored at startup with one line, refused when strict', t => {
  const { target } = file(t, { ...GOOD, future: 1, allowRawSmallPng: true });
  const lines = [];
  assert.deepEqual(load(target, { warn: line => lines.push(line) }), { ...GOOD, allowRawSmallPng: true });
  assert.deepEqual(lines, ['content.json: ignoring unknown keys future']);
  assert.throws(() => load(target, { strict: true }), { code: 'CONFIG_UNKNOWN_KEY', fields: ['future'] });
});

test('content.json: values the service refuses and missing required keys are still refused', t => {
  for (const bad of [{ allowRawSmallPng: 'yes' }, { sharpModule: 'relative' }, { sharpModule: 1 }]) assert.throws(() => validate({ ...GOOD, ...bad }), { code: 'CONFIG_INVALID' }, JSON.stringify(bad));
  assert.throws(() => validate([]), { code: 'CONFIG_INVALID' });
  const { sharpModule, ...missing } = GOOD;
  assert.throws(() => validate(missing), { code: 'CONFIG_INVALID' });
  assert.deepEqual(Object.keys(KEYS).filter(key => !KEYS[key].required), ['allowRawSmallPng']);
  const { root, target } = file(t, GOOD);
  fs.chmodSync(target, 0o640);
  assert.throws(() => load(target), { code: 'CONFIG_PERMISSIONS' });
  // The store defaults are ArtifactStore's own.
  const store = new ArtifactStore({ root: path.join(root, 'store') });
  assert.deepEqual([store.ttlMs, store.maxBytes], [defaults.store.ttlMs, defaults.store.maxBytes]);
});
