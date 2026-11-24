import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, validate, KEYS, SCHEMA_VERSION, defaults } from '../src/config.js';

const GOOD = { schemaVersion: 1, databasePath: '/authority/state/a.sqlite', socketPath: '/authority/ipc/a.sock', credentials: [], capabilities: [], actors: [], streams: [], operator: { socketPath: '/authority/operator/o.sock', tokenHash: 'b'.repeat(64), origins: [] } };
function file(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-authority-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'authority.json');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  return target;
}

test('authority.json: unknown top-level keys are ignored at startup with one line, refused when strict', t => {
  const target = file(t, { ...GOOD, future: 1, persona: { name: 'x' } });
  const lines = [];
  assert.deepEqual(load(target, { warn: line => lines.push(line) }), { ...GOOD, persona: { name: 'x' } });
  assert.deepEqual(lines, ['authority.json: ignoring unknown keys future']);
  assert.throws(() => load(target, { strict: true }), { code: 'CONFIG_UNKNOWN_KEY', fields: ['future'] });
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(defaults, { initialPaused: false });
});

test('authority.json: values Authority refuses and missing required keys are still refused', t => {
  for (const bad of [{ schemaVersion: 2 }, { databasePath: 'relative' }, { credentials: {} }, { operator: { ...GOOD.operator, tokenHash: 'x' } }, { operator: { ...GOOD.operator, origins: 'x' } }]) assert.throws(() => validate({ ...GOOD, ...bad }), { code: 'CONFIG_INVALID' }, JSON.stringify(bad));
  for (const key of Object.keys(KEYS).filter(key => KEYS[key].required)) { const c = { ...GOOD }; delete c[key]; assert.throws(() => validate(c), { code: 'CONFIG_INVALID' }, key); }
  assert.throws(() => validate({ ...GOOD, capabilities: [{ id: 'mock', policy: 'conversation.v1' }] }), { code: 'TEST_CHANNEL_CONFIGURED' });
  validate({ ...GOOD, capabilities: [{ id: 'mock', policy: 'conversation.v1' }], operator: { ...GOOD.operator, allowTestChannels: true } });
  const target = file(t, GOOD);
  fs.chmodSync(target, 0o640);
  assert.throws(() => load(target), { code: 'CONFIG_PERMISSIONS' });
});

test('the production entry point starts on a configuration with a key it does not know, and says so on stderr', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-authority-start-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'authority.json');
  fs.writeFileSync(target, JSON.stringify({ ...GOOD, credentials: [{ hash: 'a'.repeat(64), role: 'capability', capabilityId: 'qq' }], capabilities: [{ id: 'qq', policy: 'conversation.v1' }], databasePath: path.join(root, 'w.sqlite'), socketPath: path.join(root, 'a.sock'), operator: { ...GOOD.operator, socketPath: path.join(root, 'o.sock') }, future: 1 }), { mode: 0o600 });
  const started = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--config', target], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 2000, killSignal: 'SIGTERM' });
  assert.match(started.stdout, /Companion authority ready/);
  assert.equal(started.stderr, 'authority.json: ignoring unknown keys future\n');
});
