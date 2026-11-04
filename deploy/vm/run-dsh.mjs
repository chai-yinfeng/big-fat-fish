#!/usr/bin/env node
/** Own one DSH child; never send its process-token URL to shared service logs. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

process.umask(0o077);
const home = path.resolve(process.env.DSH_HOME || path.join(process.env.HOME, '.local/share/dsh-companion-base'));
const binary = process.env.COMPANION_DSH_BIN || path.join(process.env.HOME, '.local/opt/companion/bin/dsh');
const port = Number(process.env.COMPANION_PORT || 3080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid companion loopback port');
const origin = `http://127.0.0.1:${port}`;
const directory = path.join(home, 'run');
const accessFile = path.join(directory, 'local-access.json');
const runId = randomUUID();
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
let token;
let accessFailure = false;
function redact(line) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  return (token ? clean.replaceAll(token, '[redacted]') : clean)
    .replace(/([?&](?:token|secret|credential)=)[^\s&"']+/gi, '$1[redacted]');
}
function storeAccess(line) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (!clean.startsWith('dsh web:')) return false;
  const match = clean.match(/https?:\/\/\S+/);
  if (!match) return false;
  const url = new URL(match[0]);
  if (!url.searchParams.has('token')) return false;
  if (url.origin !== origin) throw new Error('Refusing a non-loopback or unexpected DSH access URL');
  token = url.searchParams.get('token');
  if (!token) throw new Error('DSH announced an empty access token');
  if (fs.existsSync(accessFile)) {
    const previous = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
    if (previous.purpose !== 'companion-local-access') throw new Error('Refusing to overwrite an unrelated access file');
  }
  const temporary = path.join(directory, `access-${runId}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, purpose: 'companion-local-access', runId, origin, token }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, accessFile);
  process.stdout.write('Companion DSH ready on loopback; private access record updated.\n');
  return true;
}
const child = spawn(binary, ['--profile', 'companion', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
  cwd: process.env.COMPANION_WORKSPACE || process.cwd(),
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
function consume(stream, destination) {
  createInterface({ input: stream }).on('line', (line) => {
    try { if (!storeAccess(line)) destination.write(redact(line) + '\n'); }
    catch { accessFailure = true; process.stderr.write('Companion access handoff failed; stopping the child.\n'); child.kill('SIGTERM'); }
  });
}
consume(child.stdout, process.stdout);
consume(child.stderr, process.stderr);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { process.stderr.write(`Companion DSH could not start (${error.code || 'spawn-error'}).\n`); process.exitCode = 1; });
child.on('close', (code, signal) => {
  try {
    if (fs.existsSync(accessFile) && JSON.parse(fs.readFileSync(accessFile, 'utf8')).runId === runId) fs.unlinkSync(accessFile);
  } catch { process.stderr.write('Companion private access cleanup requires inspection.\n'); }
  process.exitCode = accessFailure ? 1 : (code !== null && code >= 0 ? code : (signal === 'SIGTERM' ? 0 : 1));
});
