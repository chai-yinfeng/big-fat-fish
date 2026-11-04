#!/usr/bin/env node
// Preparation only: no Docker, SSH, service changes, image pulls, or account discovery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const IMAGE = 'mlikiowa/napcat-docker:v4.18.42@sha256:696e9574a0f6fb2f86cbecba8a32048f2a5823117dc9b13c6c02637ad890fa8b';
export const defaultRuntime = () => path.join(os.homedir(), '.local/share/companion-world-v1/qq-runtime');
const tokenValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function renderFiles({ webuiToken, onebotToken, uid, gid }) {
  if (!tokenValid(webuiToken) || !tokenValid(onebotToken) || webuiToken === onebotToken) throw new Error('INVALID_TOKENS');
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('NON_ROOT_OPERATOR_REQUIRED');
  // Official NapCat-Docker templates/templates/ws.json, with only token changed.
  const onebot = {
    network: {
      httpServers: [], httpSseServers: [], httpClients: [],
      websocketServers: [{ enable: true, name: 'ws', host: '0.0.0.0', port: 3001,
        reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: 'array',
        token: onebotToken, debug: false, heartInterval: 30000 }],
      websocketClients: [], plugins: [],
    },
    musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
  };
  return {
    'private/napcat.env': `MODE=ws\nWEBUI_TOKEN=${webuiToken}\nNAPCAT_UID=${uid}\nNAPCAT_GID=${gid}\n`,
    'private/onebot.token': onebotToken + '\n',
    'data/config/onebot11.json': JSON.stringify(onebot, null, 2) + '\n',
    'compose.yaml': `name: companion-world-qq
services:
  napcat:
    image: ${IMAGE}
    platform: linux/arm64
    restart: unless-stopped
    env_file:
      - ./private/napcat.env
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
    ulimits:
      core: 0
    logging:
      driver: "none"
`,
    'prepared.json': JSON.stringify({ schema: 1, image: IMAGE, platform: 'linux/arm64' }, null, 2) + '\n',
  };
}

// Reject existing symlink components rather than following a private path elsewhere.
function ensureDirectory(directory, privateMode = false) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_DIRECTORY');
  }
  if (privateMode) {
    if (fs.statSync(absolute).uid !== process.getuid()) throw new Error('DIRECTORY_OWNER_MISMATCH');
    fs.chmodSync(absolute, 0o700);
  }
}

function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('UNSAFE_PRIVATE_FILE');
}

export function prepare(runtime = defaultRuntime()) {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || !process.getuid?.()) throw new Error('RUN_AS_NON_ROOT_ON_ARM64_LINUX_VM');
  runtime = path.resolve(runtime);
  ensureDirectory(runtime, true);
  const existing = fs.readdirSync(runtime);
  if (existing.length) {
    // Never rotate tokens or overwrite a running/account-specific configuration.
    for (const name of ['prepared.json', 'private/napcat.env', 'private/onebot.token', 'data/config/onebot11.json', 'compose.yaml']) {
      ensureDirectory(path.dirname(path.join(runtime, name)), true);
      privateFile(path.join(runtime, name));
    }
    const marker = JSON.parse(fs.readFileSync(path.join(runtime, 'prepared.json'), 'utf8'));
    if (marker.schema !== 1 || marker.image !== IMAGE) throw new Error('EXISTING_RUNTIME_VERSION_MISMATCH');
    return { prepared: false, runtime, image: IMAGE, started: false };
  }
  for (const directory of ['private', 'data', 'data/qq', 'data/config', 'data/plugins']) ensureDirectory(path.join(runtime, directory), true);
  const files = renderFiles({ webuiToken: randomBytes(32).toString('hex'), onebotToken: randomBytes(32).toString('hex'), uid: process.getuid(), gid: process.getgid() });
  // Marker is last: interruption leaves an incomplete directory which reruns refuse.
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(runtime, name), contents, { flag: 'wx', mode: 0o600 });
  return { prepared: true, runtime, image: IMAGE, started: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('USAGE_NODE_PREPARE_MJS');
    process.stdout.write(JSON.stringify(prepare()) + '\n');
  } catch { process.stderr.write('QQ preparation refused; check VM architecture, non-root ownership, and whether qq-runtime is incomplete or already configured. No service was started.\n'); process.exitCode = 1; }
}
