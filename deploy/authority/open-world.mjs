#!/usr/bin/env node
// Independent operator console. No DSH page, SDK access token or boot payload.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { WORLD, PRODUCTION_HOST, readCompanionFile, errorCode } from './companion-sudo.mjs';
// Production world belongs to the dedicated `companion` user (home 0700); the
// SSH user reads it only through sudo, prompted on this terminal.
const COMPANION_CONSOLE_TOKEN = WORLD + '/operator/console.token';
const openOnly = process.argv.includes('--open-only');
let tunnel, stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; tunnel?.kill('SIGTERM'); process.exitCode = code; }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
const portReady = () => new Promise(resolve => { const socket = net.connect(3082, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
try {
  if (!openOnly) {
    if (await portReady()) throw Error('FORWARD_PORT_OCCUPIED');
    tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N', '-L', '127.0.0.1:3082:127.0.0.1:3082', PRODUCTION_HOST], { stdio: ['ignore', 'ignore', 'pipe'] });
    tunnel.on('error', () => stop(1));
    tunnel.on('exit', code => { if (!stopping) { process.stderr.write('World console SSH forwarding stopped.\n'); stop(code || 1); } });
    tunnel.stderr.resume();
    const deadline = Date.now() + 10000;
    while (!await portReady()) {
      if (stopping || tunnel.exitCode !== null || Date.now() > deadline) throw Error('FORWARD_FAILED');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } else if (!await portReady()) throw Error('FORWARD_NOT_READY');
  const token = await readCompanionFile(COMPANION_CONSOLE_TOKEN);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('ACCESS_INVALID');
  const url = new URL('http://127.0.0.1:3082/'); url.hash = 'companion-operator=' + token;
  try { execFileSync('/usr/bin/open', [url.href], { stdio: 'ignore' }); } catch { throw Error('BROWSER_OPEN_FAILED'); }
  process.stdout.write(JSON.stringify({ opened: true, origin: url.origin, standalone: true, forwarding: !openOnly }) + '\n');
} catch (error) { process.stderr.write(`World console could not open (${errorCode(error)}); check SSH connectivity, sudo and private forwarding. No credential was printed.\n`); stop(1); }
