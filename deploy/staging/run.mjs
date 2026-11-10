#!/usr/bin/env node
// Staging lifecycle on the dev host from the Mac (agent account, never production):
//   node deploy/staging/run.mjs [--reset] [--from <tarball>] [--to <tarball>]
// --from defaults to the release production runs now (its status JSON, tarball from
// .build/releases); --to defaults to .build/releases/<release of HEAD>.tar.gz, built with
// `node deploy/authority/stage-release.mjs --no-upload [--allow-unpublished]`.
// --reset alone only wipes ~/companion-staging and its units on the host.
// --scenarios [--only S1,S3] replays only the scenarios (scenarios.json) against the release
// the last lifecycle left on the host.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_HOST } from '../authority/companion-sudo.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
export const HOST = process.env.COMPANION_STAGING_HOST || 'home-agent-dev';
export const USER = process.env.COMPANION_STAGING_USER || 'agent';
const REMOTE = 'companion-staging';  // relative to the agent's home
const TOOLS = { 'deploy/staging/staging-agent.py': 'staging-agent.py', 'deploy/authority/companion-deploy/companion-deploy': 'companion-deploy', 'deploy/vm/install-runtime.sh': 'install-runtime.sh',
  // Scenario replay (staging only; none of these is part of a release).
  'deploy/staging/fake-onebot.mjs': 'fake-onebot.mjs', 'deploy/staging/fake-model.mjs': 'fake-model.mjs', 'deploy/staging/scenarios.mjs': 'scenarios.mjs', 'deploy/staging/scenarios.json': 'scenarios.json' };

export function parseArgs(argv) {
  const options = { reset: false, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reset') options.reset = true;
    else if (['--from', '--to'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[argv[i].slice(2)] = argv[++i];
    else if (argv[i] === '--scenarios') options.scenarios = true;
    else if (argv[i] === '--only' && /^[A-Z][A-Z0-9-]*(,[A-Z][A-Z0-9-]*)*$/.test(argv[i + 1] ?? '')) options.only = argv[++i];
    else throw new Error('Usage: run.mjs [--reset] [--from <tarball>] [--to <tarball>] | --scenarios [--only <id,...>]');
  }
  if (options.scenarios ? options.reset || options.from || options.to : options.only) throw new Error('Usage: --scenarios [--only <id,...>] runs alone');
  options.lifecycle = !options.scenarios && (!options.reset || Boolean(options.from || options.to));
  for (const key of ['from', 'to']) if (options[key] && !/^authority-[0-9A-Za-z.-]+-[0-9a-f]{12}\.tar\.gz$/.test(path.basename(options[key]))) throw new Error(`--${key} must be a release tarball authority-<version>-<sha12>.tar.gz`);
  return options;
}

export function checkHost(host = HOST) {
  if (!/^[A-Za-z0-9._-]+$/.test(host) || [PRODUCTION_HOST, 'home-agent'].includes(host)) throw new Error(`Refusing staging host ${host}: use the agent account alias (home-agent-dev), never ${PRODUCTION_HOST}`);
  return host;
}

const ssh = (...command) => execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, ...command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function tarball(file) {
  const resolved = path.resolve(file);
  for (const item of [resolved, resolved + '.sha256']) if (!fs.statSync(item, { throwIfNoEntry: false })?.isFile()) throw new Error('Missing ' + path.relative(project, item));
  return resolved;
}

function defaults(options) {
  const releases = path.join(project, '.build/releases');
  if (!options.from) {
    const current = JSON.parse(ssh('cat', '/var/log/companion-deploy.status.json')).current;
    if (!/^authority-[0-9A-Za-z.-]+-[0-9a-f]{12}$/.test(current || '')) throw new Error('Cannot read the production release; pass --from');
    options.from = path.join(releases, current + '.tar.gz');
  }
  if (!options.to) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
    options.to = path.join(releases, `authority-${version}-${head.slice(0, 12)}.tar.gz`);
  }
  options.from = tarball(options.from); options.to = tarball(options.to);
  if (path.basename(options.from) === path.basename(options.to)) throw new Error('--from and --to are the same release');
}

function upload(files, directory) {
  ssh('mkdir', '-p', '-m', '0700', `${REMOTE}/${directory}`);
  execFileSync('scp', ['-q', '-o', 'BatchMode=yes', ...files, `${HOST}:${REMOTE}/${directory}/`], { stdio: 'inherit' });
}

function agent(...args) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', HOST, 'python3', '-I', `${REMOTE}/tools/staging-agent.py`, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

function tools() {
  const staged = fs.mkdtempSync(path.join(project, '.build/staging-tools-'));
  try {
    for (const [source, name] of Object.entries(TOOLS)) fs.copyFileSync(path.join(project, source), path.join(staged, name));
    upload(Object.values(TOOLS).map(name => path.join(staged, name)), 'tools');
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
}

function main(argv) {
  const options = parseArgs(argv);
  checkHost();
  const who = ssh('id', '-un').trim();
  if (who !== USER) throw new Error(`Staging host account is ${who}, expected ${USER}`);
  if (options.scenarios) {
    tools();
    return agent('scenarios', ...(options.only ? ['--only', options.only] : []));
  }
  if (options.lifecycle) defaults(options);
  if (options.reset) {
    tools();
    const code = agent('reset');
    if (code) return code;
  }
  if (!options.lifecycle) return 0;
  tools();
  upload([options.from, options.from + '.sha256', options.to, options.to + '.sha256'], 'inbox');
  console.log(`staging ${path.basename(options.from)} -> ${path.basename(options.to)} on ${HOST}:~/${REMOTE}`);
  return agent('lifecycle', '--from', `${REMOTE}/inbox/${path.basename(options.from)}`, '--to', `${REMOTE}/inbox/${path.basename(options.to)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(project, '.build'), { recursive: true });
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error('staging: ' + error.message); process.exitCode = 1; }
}
