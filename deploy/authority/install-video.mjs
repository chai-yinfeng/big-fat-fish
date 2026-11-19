#!/usr/bin/env node
// Installs the pinned yt-dlp for the video capability (capabilities/providers/video) into its own Python virtual
// environment inside the private runtime. An explicit operator step, like install-speech: nothing here runs at
// deploy time, starts or restarts a service, or writes the operator's video.json.
//   node ops/install-video.mjs [--plan | --apply] [--runtime <dir>] [--index <simple index URL>] [--proxy <http proxy>]
// --plan (the default) prints what --apply would run. The wheel is pinned by version and sha256, so a mirror index
// (the tuna one) is as good as PyPI. Only the core package is installed (--no-deps): no optional extras, no JS runtime.
// The result ends with the site-independent part of operator/providers/video.json; the `sites` (link patterns and a
// site's own details) are the operator's to write, in the data root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const fail = code => Object.assign(new Error(code), { code });
// sha256 of the wheel as PyPI lists it (https://pypi.org/pypi/yt-dlp/2026.10.26/json, read 2026-11-19).
export const YTDLP = Object.freeze({ version: '2026.10.26', sha256: 'a05c5b5d8562f7e8a62f5334348b406af4930d56d3a65f8021d14af0e22339ae', python: '>=3.11' });
export const INDEXES = Object.freeze(['https://pypi.org/simple', 'https://pypi.tuna.tsinghua.edu.cn/simple']);
const defaultRuntime = () => path.join(os.homedir(), '.local/opt/companion/video');

/** What an install does, without doing it. */
export function videoInstallPlan({ runtime = defaultRuntime(), index = INDEXES[0], proxy, python = '/usr/bin/python3' } = {}) {
  if (!path.isAbsolute(runtime) || !INDEXES.includes(index) || !path.isAbsolute(python)) throw fail('VIDEO_INSTALL_ARGUMENTS');
  if (proxy !== undefined) { let url; try { url = new URL(proxy); } catch { throw fail('VIDEO_INSTALL_ARGUMENTS'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('VIDEO_INSTALL_ARGUMENTS'); }
  const venv = path.join(runtime, 'venv'), requirements = path.join(runtime, 'requirements.txt');
  return {
    version: YTDLP.version, runtime, venv, requirements, requirement: `yt-dlp==${YTDLP.version} --hash=sha256:${YTDLP.sha256}`,
    commands: [
      [python, '-m', 'venv', venv],
      [path.join(venv, 'bin/python'), '-m', 'pip', 'install', '--no-deps', '--require-hashes', '--only-binary', ':all:', '--disable-pip-version-check', '--no-cache-dir', '--no-input', '--index-url', index, ...(proxy === undefined ? [] : ['--proxy', new URL(proxy).origin]), '-r', requirements],
      [path.join(venv, 'bin/yt-dlp'), '--version'],
    ],
    writesPerformed: false,
  };
}

/** The site-independent part of operator/providers/video.json for this install. */
export function operatorConfigFor({ runtime, exists = fs.existsSync }) {
  const tool = file => exists(file) ? file : null, ffmpeg = tool('/usr/bin/ffmpeg'), bwrap = tool('/usr/bin/bwrap');
  return {
    ffmpeg, bwrap,
    operatorConfig: { schemaVersion: 1, ytdlp: [path.join(runtime, 'venv/bin/yt-dlp')], ffmpeg: [ffmpeg ?? '/usr/bin/ffmpeg'], sandbox: bwrap ? { kind: 'bwrap', bwrap, readOnly: [runtime] } : { kind: 'none' }, sites: [] },
  };
}

export function installVideo({ apply = false, run = (command, args) => spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8' }, timeout: 300000 }), ...options } = {}) {
  const plan = videoInstallPlan(options);
  if (!apply) return { mode: 'plan', ...plan };
  const step = (command, code) => { const result = run(command[0], command.slice(1)); if (result.status !== 0) throw fail(code); return String(result.stdout ?? '').trim(); };
  const [makeVenv, install, version] = plan.commands;
  fs.mkdirSync(plan.runtime, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(plan.runtime).isSymbolicLink()) throw fail('VIDEO_INSTALL_TARGET');
  const installed = () => fs.existsSync(version[0]) && step(version, 'VIDEO_INSTALL_VERIFY') === YTDLP.version;
  let already = false;
  if (fs.existsSync(plan.venv)) {
    // An environment this script did not finish, or one holding another version, is not repaired or replaced here.
    if (!installed()) throw fail('VIDEO_INSTALL_TARGET');
    already = true;
  } else {
    step(makeVenv, 'VIDEO_INSTALL_VENV');
    fs.writeFileSync(plan.requirements, plan.requirement + '\n', { mode: 0o600 });
    step(install, 'VIDEO_INSTALL_PIP');
    if (!installed()) throw fail('VIDEO_INSTALL_VERIFY');
  }
  return { mode: 'apply', version: YTDLP.version, already, ...operatorConfigFor({ runtime: plan.runtime }), servicesChanged: false, operatorFileWritten: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const options = {}; let mode;
    for (let i = 2; i < process.argv.length; i++) {
      const value = process.argv[i];
      if (value === '--plan' || value === '--apply') { if (mode) throw fail('VIDEO_INSTALL_ARGUMENTS'); mode = value; options.apply = value === '--apply'; }
      else if (['--runtime', '--index', '--proxy'].includes(value)) { const next = process.argv[++i]; if (!next || next.startsWith('--')) throw fail('VIDEO_INSTALL_ARGUMENTS'); options[value.slice(2)] = next; }
      else throw fail('VIDEO_INSTALL_ARGUMENTS');
    }
    process.stdout.write(JSON.stringify(installVideo(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(/^VIDEO_[A-Z_]+$/.test(error.code || '') ? error.code + '\n' : 'VIDEO_INSTALL_FAILED\n');
    process.exitCode = 1;
  }
}
