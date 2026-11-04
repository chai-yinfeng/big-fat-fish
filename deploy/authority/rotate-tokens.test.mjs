import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rotateTokens } from './rotate-tokens.mjs';
import { prepareMemory } from './prepare-memory.mjs';
import { prepareContent } from './prepare-content.mjs';
import { prepareConsole } from './prepare-console.mjs';
import { renderFiles } from '../qq/prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const idle = async () => [];

// Synthetic world built by the real bootstrap/prepare code plus NapCat/DSH fixtures.
function world(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-rotate-')));
  t.after(() => { assert.ok(temp.startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-rotate-')); fs.rmSync(temp, { recursive: true }); });
  execFileSync(process.execPath, [path.join(here, 'bootstrap.mjs')], { env: { ...process.env, HOME: temp }, stdio: 'ignore' });
  const base = path.join(temp, '.local/share/companion-world-v1');
  prepareMemory(base);
  prepareContent(base, path.join(temp, 'speech-node'));
  prepareConsole(base);
  const runtime = path.join(base, 'qq-runtime');
  for (const dir of ['private', 'data/qq', 'data/config', 'data/plugins']) fs.mkdirSync(path.join(runtime, dir), { recursive: true, mode: 0o700 });
  const files = renderFiles({ webuiToken: randomBytes(32).toString('hex'), onebotToken: randomBytes(32).toString('hex'), uid: 1001, gid: 1001 });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(runtime, name), contents, { mode: 0o600 });
  fs.copyFileSync(path.join(runtime, 'data/config/onebot11.json'), path.join(runtime, 'data/config/onebot11_10001.json'));
  // WebUI token changed in the WebUI after first start: differs from the env value.
  fs.writeFileSync(path.join(runtime, 'data/config/webui.json'), JSON.stringify({ host: '0.0.0.0', port: 6099, prefix: '', token: randomBytes(32).toString('hex'), loginRate: 10 }, null, 4), { mode: 0o600 });
  fs.writeFileSync(path.join(runtime, 'data/qq/login.db'), 'QQ LOGIN FIXTURE', { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'dsh-home/.credentials.yaml'), `version: 1\n\nrefs:\n  UNRELATED_KEY: keep-this-value\n\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: A${randomBytes(32).toString('base64url').slice(1)}\n  other-owner/grant:\n    kind: grant\n    payload:\n      access: unrelated-grant\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'authority-data/authority.sqlite'), 'SQLite format 3\0persona and memory fixture', { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'model-data/settings.json'), '{"provider":"deepseek","apiKey":"user-entered"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'qq-worker/capability.token.note'), 'not a token', { mode: 0o600 });
  return base;
}

function walk(root, skip = () => false) {
  const out = new Map();
  (function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (skip(relative)) continue;
      if (entry.isDirectory()) visit(full);
      else out.set(relative, { content: fs.readFileSync(full, 'utf8'), mode: fs.statSync(full).mode & 0o777 });
    }
  })(root);
  return out;
}

const TOKENS = ['operator/admin.token', 'operator/console.token', 'dsh-config/capability.token', 'dsh-config/model-gateway.token', 'qq-worker/capability.token', 'authority-content/control.token', 'qq-runtime/private/onebot.token'];
function secrets(base) {
  const read = relative => fs.readFileSync(path.join(base, relative), 'utf8');
  const memory = fs.readdirSync(path.join(base, 'memory-config')).filter(name => name.endsWith('.token')).map(name => 'memory-config/' + name);
  const tokens = Object.fromEntries([...TOKENS, ...memory].map(relative => [relative, read(relative).trim()]));
  const webuiEnv = /^WEBUI_TOKEN=(.*)$/m.exec(read('qq-runtime/private/napcat.env'))[1];
  const webui = JSON.parse(read('qq-runtime/data/config/webui.json')).token;
  const browser = /secret: (\S+)/.exec(read('dsh-home/.credentials.yaml'))[1];
  return { tokens, memory, webuiEnv, webui, browser };
}

test('dry-run lists every planned change and writes nothing', async t => {
  const base = world(t), before = walk(base);
  const result = await rotateTokens({ base, dryRun: true, probe: idle });
  assert.equal(result.dryRun, true); assert.equal(result.backup, null);
  for (const relative of ['operator/authority.json', 'operator/model-gateway.json', 'operator/qq-bridge.json', 'qq-runtime/private/napcat.env', 'qq-runtime/data/config/webui.json', 'qq-runtime/data/config/onebot11.json', 'qq-runtime/data/config/onebot11_10001.json', 'dsh-home/.credentials.yaml', ...TOKENS]) assert.ok(result.changedFiles.includes(relative), relative);
  assert.ok(!result.changedFiles.includes('model-data/settings.json'));
  assert.deepEqual(walk(base), before);
  assert.ok(!fs.readdirSync(base).some(name => name.startsWith('rotation-backup-')));
});

test('rotation replaces every token and hash, preserves unrelated data, keeps a backup', async t => {
  const base = world(t), old = secrets(base), before = walk(base);
  const oldAuthority = JSON.parse(before.get('operator/authority.json').content);
  const result = await rotateTokens({ base, now: new Date('2026-11-04T01:02:03.004Z'), probe: idle });
  const out = JSON.stringify(result);
  const oldStrings = [...Object.values(old.tokens), ...Object.values(old.tokens).map(sha), old.webuiEnv, old.webui, old.browser];
  for (const value of oldStrings) assert.ok(!out.includes(value), 'summary must not contain secrets');
  const now = secrets(base);
  for (const [relative, value] of Object.entries(now.tokens)) {
    assert.notEqual(value, old.tokens[relative], relative);
    assert.match(value, relative.endsWith('onebot.token') ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(path.join(base, relative), 'utf8'), value + '\n');
  }
  // Hash consumers match the new tokens.
  const read = relative => JSON.parse(fs.readFileSync(path.join(base, relative), 'utf8'));
  const authority = read('operator/authority.json'), gateway = read('operator/model-gateway.json'), qq = read('operator/qq-bridge.json');
  const console_ = sha(now.tokens['operator/console.token']);
  assert.equal(authority.operator.tokenHash, console_); assert.equal(gateway.operatorTokenHash, console_); assert.equal(qq.operatorTokenHash, console_);
  assert.equal(gateway.inferenceTokenHash, sha(now.tokens['dsh-config/model-gateway.token']));
  const credential = predicate => authority.credentials.find(predicate).hash;
  assert.equal(credential(row => row.role === 'admin'), sha(now.tokens['operator/admin.token']));
  assert.equal(credential(row => row.capabilityId === 'dsh-test'), sha(now.tokens['dsh-config/capability.token']));
  assert.equal(credential(row => row.capabilityId === 'qq'), sha(now.tokens['qq-worker/capability.token']));
  assert.equal(credential(row => row.role === 'maintenance'), sha(now.tokens[now.memory[0]]));
  // Plain-value consumers.
  for (const name of ['onebot11.json', 'onebot11_10001.json']) assert.equal(read('qq-runtime/data/config/' + name).network.websocketServers[0].token, now.tokens['qq-runtime/private/onebot.token']);
  assert.match(now.webuiEnv, /^[a-f0-9]{64}$/); assert.equal(now.webui, now.webuiEnv);
  assert.notEqual(now.browser, old.browser); assert.match(now.browser, /^[A-Za-z0-9_-]{43}$/);
  // No old value remains anywhere outside the backup.
  const after = walk(base, relative => relative.startsWith('rotation-backup-'));
  for (const [relative, { content }] of after) for (const value of oldStrings) assert.ok(!content.includes(value), 'old value remains in ' + relative);
  // Only planned files changed; formatting and other fields preserved.
  for (const [relative, entry] of before) {
    if (!result.changedFiles.includes(relative)) assert.deepEqual(after.get(relative), entry, relative);
    else assert.equal(after.get(relative).mode, 0o600, relative);
  }
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.equal(after.get('operator/authority.json').content, JSON.stringify(authority, null, 2) + '\n');
  assert.equal(after.get('qq-runtime/data/config/webui.json').content, JSON.stringify(read('qq-runtime/data/config/webui.json'), null, 4));
  const strip = value => ({ ...value, operator: { ...value.operator, tokenHash: null }, credentials: value.credentials.map(row => ({ ...row, hash: null })) });
  assert.deepEqual(strip(authority), strip(oldAuthority));
  const yaml = after.get('dsh-home/.credentials.yaml').content;
  assert.equal(yaml, before.get('dsh-home/.credentials.yaml').content.replace(old.browser, now.browser));
  assert.equal(after.get('qq-runtime/private/napcat.env').content, before.get('qq-runtime/private/napcat.env').content.replace(old.webuiEnv, now.webuiEnv));
  // Backup mirrors the replaced files with their old contents.
  assert.equal(result.backup, path.join(base, 'rotation-backup-2026-11-04T01-02-03-004Z'));
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o700);
  const backup = walk(result.backup);
  assert.deepEqual([...backup.keys()].sort(), [...result.changedFiles].sort());
  for (const [relative, entry] of backup) { assert.equal(entry.content, before.get(relative).content); assert.equal(entry.mode, 0o600); }
});

test('refuses missing base, active services and unmanaged credentials without writing', async t => {
  await assert.rejects(rotateTokens({ base: path.join(os.tmpdir(), 'absent-' + process.pid, 'companion-world-v1'), probe: idle }), /BASE_MISSING/);
  await assert.rejects(rotateTokens({ base: '/tmp/not-a-world', probe: idle }), /BASE_INVALID/);
  const base = world(t);
  const before = walk(base);
  await assert.rejects(rotateTokens({ base, probe: async () => ['ipc/authority/authority.sock'] }), /SERVICES_ACTIVE/);
  const file = path.join(base, 'operator/authority.json'), authority = JSON.parse(fs.readFileSync(file, 'utf8'));
  authority.credentials.push({ hash: sha('leaked-extra'), role: 'capability', capabilityId: 'legacy' });
  fs.writeFileSync(file, JSON.stringify(authority, null, 2) + '\n', { mode: 0o600 });
  before.set('operator/authority.json', { content: fs.readFileSync(file, 'utf8'), mode: 0o600 });
  await assert.rejects(rotateTokens({ base, probe: idle }), /UNMANAGED_CREDENTIAL role=capability capabilityId=legacy/);
  assert.deepEqual(walk(base), before);
});

test('CLI dry-run prints only a JSON summary', t => {
  const base = world(t), old = secrets(base);
  // Exercise the real CLI argument path; sockets/ports are probed but none belong to this temp world.
  let stdout;
  try { stdout = execFileSync(process.execPath, [path.join(here, 'rotate-tokens.mjs'), '--base', base, '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (/SERVICES_ACTIVE 127\.0\.0\.1/.test(error.stderr)) { t.skip('a local loopback port is in use on this machine'); return; } throw error; }
  const summary = JSON.parse(stdout);
  assert.equal(summary.dryRun, true);
  for (const value of [...Object.values(old.tokens), ...Object.values(old.tokens).map(sha), old.webuiEnv, old.webui, old.browser]) assert.ok(!stdout.includes(value));
});
