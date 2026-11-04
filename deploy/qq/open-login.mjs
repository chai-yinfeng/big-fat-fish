#!/usr/bin/env node
// Operator machine only. Keep this process alive while scanning in the OS browser.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const host = process.argv[2] || 'myvm';
const openOnly = process.argv[3] === '--open-only';
let tunnel;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel?.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
const occupied = () => new Promise(resolve => {
  const socket = net.connect(6099, '127.0.0.1');
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});

try {
  if (process.argv.length > (openOnly ? 4 : 3) || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host)) throw new Error('INVALID_SSH_HOST');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('UNSUPPORTED_OPERATOR_OS');
  if (!openOnly) {
  if (await occupied()) throw new Error('PORT_6099_OCCUPIED');
  tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N', '-L', '127.0.0.1:6099:127.0.0.1:6099', host], { stdio: ['ignore', 'ignore', 'pipe'] });
  tunnel.stderr.resume();
  tunnel.on('error', () => stop(1));
  tunnel.on('exit', code => {
    if (!stopping) { process.stderr.write('QQ SSH tunnel closed.\n'); stop(code || 1); }
  });
  const deadline = Date.now() + 10000;
  while (!(await occupied())) {
    if (stopping || tunnel.exitCode !== null || Date.now() > deadline) throw new Error('TUNNEL_UNAVAILABLE');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  }
  if (stopping) throw new Error('TUNNEL_CLOSED');
  const response = await fetch('http://127.0.0.1:6099/webui/', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('WEBUI_UNAVAILABLE');
  await response.body?.cancel();
  // Read the actual WebUI config (not an env token that may have been changed in WebUI).
  // The credential crosses SSH stdout into memory only; neither command nor logs contain it.
  const remote = `const fs=require('fs'),os=require('os'),p=os.homedir()+'/.local/share/companion-world-v1/qq-runtime/data/config/webui.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.port!==6099||(c.prefix&&c.prefix!=='/')||!/^([a-f0-9]{64})$/.test(c.token))process.exit(1);process.stdout.write(c.token);`;
  const token = execFileSync('ssh', ['-o', 'BatchMode=yes', host, '"$HOME/.local/opt/companion/bin/node" -'], { input: remote, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('INVALID_WEBUI_TOKEN');
  const url = new URL('http://127.0.0.1:6099/webui/');
  url.searchParams.set('token', token);
  // Native browser handoff; URL intentionally never printed or passed to sidebar tools.
  execFileSync(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url.href], { stdio: 'ignore', timeout: 10000 });
  process.stdout.write('QQ login opened in your browser. Scan manually; keep this terminal running. Ctrl-C closes only this 6099 SSH tunnel.\n');
} catch {
  process.stderr.write('QQ login could not open. Check SSH, private WebUI config, running NapCat, and whether local 6099 is free. Credentials were not printed.\n');
  stop(1);
}
