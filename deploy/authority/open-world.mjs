#!/usr/bin/env node
// Independent operator console. No DSH page, SDK access token or boot payload.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
// Production world belongs to the dedicated `companion` user (home 0700); the
// SSH user reads it only through sudo, prompted on this terminal.
const COMPANION_CONSOLE_TOKEN = '/home/companion/.local/share/companion-world-v1/operator/console.token';
const SUDO_PROMPT = '[sudo] myvm password for your SSH user (input hidden): ';
const openOnly = process.argv.includes('--open-only');
let tunnel, stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; tunnel?.kill('SIGTERM'); process.exitCode = code; }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
// `ssh -t` gives sudo a remote TTY whose output (prompt included) arrives on our
// piped stdout; show only the prompt on stderr and keep the token in memory.
function readConsoleToken() {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-t', 'myvm', `sudo -p '${SUDO_PROMPT}' -u companion cat ${COMPANION_CONSOLE_TOKEN}`], { stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; while (output.includes(SUDO_PROMPT)) { output = output.replace(SUDO_PROMPT, ''); process.stderr.write(SUDO_PROMPT); } });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).pop() || '') : reject(Error('TOKEN_READ_FAILED')));
  });
}
const portReady = () => new Promise(resolve => { const socket = net.connect(3082, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
try {
  if (!openOnly) {
    if (await portReady()) throw Error('FORWARD_PORT_OCCUPIED');
    tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N', '-L', '127.0.0.1:3082:127.0.0.1:3082', 'myvm'], { stdio: ['ignore', 'ignore', 'pipe'] });
    tunnel.on('error', () => stop(1));
    tunnel.on('exit', code => { if (!stopping) { process.stderr.write('World console SSH forwarding stopped.\n'); stop(code || 1); } });
    tunnel.stderr.resume();
    const deadline = Date.now() + 10000;
    while (!await portReady()) {
      if (stopping || tunnel.exitCode !== null || Date.now() > deadline) throw Error('FORWARD_FAILED');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } else if (!await portReady()) throw Error('FORWARD_NOT_READY');
  const token = await readConsoleToken();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('ACCESS_INVALID');
  const url = new URL('http://127.0.0.1:3082/'); url.hash = 'companion-operator=' + token;
  execFileSync('/usr/bin/open', [url.href], { stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ opened: true, origin: url.origin, standalone: true, forwarding: !openOnly }) + '\n');
} catch { process.stderr.write('World console could not open; check SSH connectivity and private forwarding.\n'); stop(1); }
