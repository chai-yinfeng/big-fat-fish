import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, validate, KEYS, defaults } from '../config.js';
import { PACING } from '../pacing.js';

const GOOD = { authority: { socketPath: '/w/a.sock', tokenFile: '/w/t' }, conversation: { socketPath: '/w/c.sock', tokenFile: '/w/c' }, controlSocket: '/w/q.sock', operatorTokenHash: 'a'.repeat(64), onebotTokenFile: '/w/onebot.token', settingsFile: '/w/settings.json', stateFile: '/w/dispatch.json' };
function file(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-qq-config-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const target = path.join(root, 'qq-bridge.json');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  return target;
}

test('qq-bridge.json: unknown keys (also in pacing) are ignored at startup with one line, refused when strict; DSH-era keys are dropped silently', t => {
  const target = file(t, { ...GOOD, future: 1, pacing: { burstQuietMs: 100, later: 2 }, inboxFile: '/w/inbox.jsonl' });
  const lines = [], legacy = [];
  assert.deepEqual(load(target, { warn: line => lines.push(line), legacy: keys => legacy.push(...keys) }), { ...GOOD, pacing: { burstQuietMs: 100 } });
  assert.deepEqual([lines, legacy], [['qq-bridge.json: ignoring unknown keys future, pacing.later'], ['inboxFile']]);
  assert.throws(() => load(target, { strict: true }), { code: 'CONFIG_UNKNOWN_KEY', fields: ['future', 'pacing.later'] });
});

test('qq-bridge.json: values the bridge refuses and missing required keys are still refused', t => {
  for (const bad of [{ initiationPollMs: 999 }, { initiationPollMs: 600001 }, { stickerSubType: 'yes' }, { onebotPort: 0 }, { pacing: { burstQuietMs: -1 } }, { pacing: null }, { operatorTokenHash: 'x' }]) assert.throws(() => validate({ ...GOOD, ...bad }), { code: 'CONFIG_INVALID' }, JSON.stringify(bad));
  for (const key of Object.keys(KEYS).filter(key => KEYS[key].required)) { const c = { ...GOOD }; delete c[key]; assert.throws(() => validate(c), { code: 'CONFIG_INVALID' }, key); }
  const target = file(t, GOOD);
  fs.chmodSync(target, 0o640);
  assert.throws(() => load(target), { code: 'CONFIG_PERMISSIONS' });
  assert.deepEqual([defaults.initiationPollMs, defaults.stickerSubType, defaults.pacing], [60000, true, PACING]);
});
