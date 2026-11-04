import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function run(t, advertisedPort) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-runner-'));
  const fake = path.join(root, 'fake-dsh');
  const token = 'synthetic-test-access-token';
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log('dsh web: http://127.0.0.1:${advertisedPort}/?token=${token}');console.error('debug token reference ?token=${token}');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./run-dsh.mjs', import.meta.url))], {
    env: { ...process.env, DSH_HOME: root, COMPANION_DSH_BIN: fake, COMPANION_WORKSPACE: root, COMPANION_PORT: '3080' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, child, exited, token, output: () => output };
}

test('runner keeps the access token private and cleans its own record on graceful stop', { timeout: 10000 }, async (t) => {
  const runtime = await run(t, 3080);
  const file = path.join(runtime.root, 'run/local-access.json');
  for (let attempt = 0; !fs.existsSync(file) && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, runtime.token);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  runtime.child.kill('SIGTERM');
  assert.equal((await runtime.exited)[0], 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(runtime.output().includes(runtime.token), false);
});

test('an unexpected access URL fails the service instead of reporting successful startup', { timeout: 10000 }, async (t) => {
  const runtime = await run(t, 3999);
  assert.equal((await runtime.exited)[0], 1);
  assert.equal(runtime.output().includes(runtime.token), false);
});
