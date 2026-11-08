// Mac-side reads of private files owned by the production `companion` user.
// The SSH user can only reach them through sudo, which prompts on this terminal
// via `ssh -t`. File contents stay in memory and are never printed.
import { spawn } from 'node:child_process';

export const WORLD = '/home/companion/.local/share/companion-world-v1';
/** SSH alias of the production host; override with COMPANION_HOST. */
export const PRODUCTION_HOST = process.env.COMPANION_HOST || 'home-agent';
if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(PRODUCTION_HOST)) throw Error('INVALID_SSH_HOST');
export const SUDO_PROMPT = '[sudo] production host password for your SSH user (input hidden): ';
const BEGIN = '@@companion-file@@', END = '@@companion-end@@';

/** Remote command printing each file between markers, so sudo noise cannot mix in. */
export function sudoReadCommand(files) {
  if (!files.length || files.some(file => !/^\/home\/companion\/[A-Za-z0-9._/-]+$/.test(file) || file.includes('..'))) throw Error('INVALID_COMPANION_PATH');
  const script = files.map(file => `echo ${BEGIN}; cat ${file} || exit 3; echo`).join('; ') + `; echo ${END}`;
  return `sudo -p '${SUDO_PROMPT}' -u companion sh -c '${script}'`;
}

/** Split `ssh -t` output (CRLF, prompts, "Sorry, try again.") into the file contents. */
export function parseSudoRead(output, count) {
  const text = output.replace(/\r/g, '').split(SUDO_PROMPT).join('');
  const start = text.indexOf(BEGIN + '\n');
  if (start < 0) throw Error('SUDO_FAILED');
  const end = text.lastIndexOf('\n' + END);
  if (end < start) throw Error('TOKEN_READ_FAILED');
  const parts = text.slice(start, end + 1).split(BEGIN + '\n').slice(1).map(part => part.replace(/\n$/, ''));
  if (parts.length !== count) throw Error('TOKEN_READ_FAILED');
  return parts;
}

/** Exit status of `ssh -t ... sudo ...` mapped to a stable code (255 = ssh itself). */
export function failureCode(status, output) {
  if (status === 255) return 'SSH_FAILED';
  return output.replace(/\r/g, '').includes(BEGIN + '\n') ? 'TOKEN_READ_FAILED' : 'SUDO_FAILED';
}

/** Upper-case error codes are ours and safe to print; anything else is generic. */
export const errorCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UNEXPECTED_ERROR';

export function readCompanionFiles(files, { host = PRODUCTION_HOST, spawnImpl = spawn } = {}) {
  const command = sudoReadCommand(files);
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', ['-t', host, command], { stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '', shown = 0;
    child.stdout.setEncoding('utf8');
    // Show only the sudo prompt; keep everything else (the secrets) in memory.
    child.stdout.on('data', chunk => { output += chunk; const prompts = output.split(SUDO_PROMPT).length - 1; while (shown < prompts) { shown++; process.stderr.write(SUDO_PROMPT); } });
    child.on('error', () => reject(Error('SSH_FAILED')));
    child.on('close', status => {
      if (status !== 0) return reject(Error(failureCode(status, output)));
      try { resolve(parseSudoRead(output, files.length)); } catch (error) { reject(error); }
    });
  });
}

/** NapCat WebUI token, only if its config still serves the fixed local port and prefix. */
export function webuiToken(text) {
  let config;
  try { config = JSON.parse(text); } catch { throw Error('INVALID_WEBUI_CONFIG'); }
  if (config.port !== 6099 || (config.prefix && config.prefix !== '/') || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('INVALID_WEBUI_CONFIG');
  return config.token;
}

export async function readCompanionFile(file, options) {
  return (await readCompanionFiles([file], options))[0].trim();
}
