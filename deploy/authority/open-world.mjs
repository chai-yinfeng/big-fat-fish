#!/usr/bin/env node
// Independent operator console. No DSH page, SDK access token or boot payload.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { WORLD, PRODUCTION_HOST, readCompanionFile, errorCode } from './companion-sudo.mjs';
import { tunnelArgs, consoleURL, pickRoomPort } from './console-tunnel.mjs';
// Production world belongs to the dedicated `companion` user (home 0700); the
// SSH user reads it only through sudo, prompted on this terminal.
const COMPANION_CONSOLE_TOKEN = WORLD + '/operator/console.token';
const openOnly = process.argv.includes('--open-only');
let tunnel, stopping = false, roomPort = null;
function stop(code = 0) { if (stopping) return; stopping = true; tunnel?.kill('SIGTERM'); process.exitCode = code; }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
const portReady = () => new Promise(resolve => { const socket = net.connect(3082, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
try {
  if (!openOnly) {
    if (await portReady()) throw Error('FORWARD_PORT_OCCUPIED');
    // The room page (4173 on the host) on the first free local port; when none is free the console opens without it.
    roomPort = await pickRoomPort();
    if (!roomPort) process.stderr.write('No free local port for the room page; the console opens without the room button.\n');
    tunnel = spawn('ssh', tunnelArgs(PRODUCTION_HOST, roomPort), { stdio: ['ignore', 'ignore', 'pipe'] });
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
  // --open-only reuses a tunnel whose room forwarding is unknown, so the console then gets no room port.
  const url = consoleURL(token, roomPort);
  try { execFileSync('/usr/bin/open', [url.href], { stdio: 'ignore' }); } catch { throw Error('BROWSER_OPEN_FAILED'); }
  process.stdout.write(JSON.stringify({ opened: true, origin: url.origin, standalone: true, forwarding: !openOnly, roomPort }) + '\n');
} catch (error) { process.stderr.write(`World console could not open (${errorCode(error)}); check SSH connectivity, sudo and private forwarding. No credential was printed.\n`); stop(1); }
