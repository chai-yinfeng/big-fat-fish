#!/usr/bin/env node
// Builds a release from a clean, published commit, packs a deterministic tarball
// and uploads it to the production host's agent inbox (COMPANION_HOST, default
// home-agent). It never deploys: the human runs companion-deploy as root there. Usage:
//   node deploy/authority/stage-release.mjs [--no-upload [--allow-unpublished]]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_HOST as HOST } from './companion-sudo.mjs';

const INBOX = 'releases';
const project = fileURLToPath(new URL('../../', import.meta.url));

/** Deterministic ustar archive of regular files and their parent directories. */
export function packTar(root, top, mtime) {
  const files = [];
  (function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? relative + '/' + name : name, stat = fs.lstatSync(path.join(root, child));
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.push({ name: child, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
      else throw new Error('Release may contain only files and directories: ' + child);
    }
  })('');
  const dirs = new Set([top]);
  for (const { name } of files) for (let at = name.indexOf('/'); at > 0; at = name.indexOf('/', at + 1)) dirs.add(top + '/' + name.slice(0, at));
  const entries = [...[...dirs].map(name => ({ name: name + '/', mode: 0o755, dir: true })),
    ...files.map(file => ({ name: top + '/' + file.name, mode: file.mode, source: path.join(root, file.name) }))]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const blocks = [];
  for (const entry of entries) {
    const data = entry.dir ? Buffer.alloc(0) : fs.readFileSync(entry.source);
    blocks.push(header(entry.name, entry.mode, data.length, mtime, entry.dir ? '5' : '0'), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
  gz[9] = 0xff; // gzip OS byte: "unknown", so the archive does not depend on the build platform
  return gz;
}

function header(name, mode, size, mtime, type) {
  const block = Buffer.alloc(512), bytes = Buffer.from(name);
  let prefix = '', base = name;
  if (bytes.length > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error('Path too long for ustar: ' + name);
  }
  const put = (text, at, length) => block.write(text, at, length, 'utf8');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(base, 0, 100); put(octal(mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12); put(octal(mtime, 12), 136, 12); put('        ', 148, 8); put(type, 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2); put(prefix, 345, 155);
  let sum = 0; for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

function main(argv) {
  const noUpload = argv.includes('--no-upload'), allowUnpublished = argv.includes('--allow-unpublished');
  if (argv.some(arg => !['--no-upload', '--allow-unpublished'].includes(arg))) throw new Error('Usage: stage-release.mjs [--no-upload [--allow-unpublished]]');
  if (allowUnpublished && !noUpload) throw new Error('--allow-unpublished is only for local --no-upload builds');
  const clean = () => { if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Staging requires a clean working tree'); };
  clean();
  const head = git('rev-parse', '--verify', 'HEAD');
  git('fetch', '--quiet', 'origin', 'main');
  let published = true;
  try { execFileSync('git', ['merge-base', '--is-ancestor', head, 'origin/main'], { cwd: project, stdio: 'ignore' }); } catch { published = false; }
  if (!published && !allowUnpublished) throw new Error(`HEAD ${head} is not contained in origin/main; merge and push it first`);
  if (!published) console.error('WARNING: HEAD is not on origin/main; companion-deploy will refuse this tarball.');
  execFileSync(process.execPath, [path.join(project, 'console/build.mjs'), '--standalone'], { cwd: project, stdio: ['ignore', 'ignore', 'inherit'] });
  clean();
  // A fresh checkout has no .build yet.
  fs.mkdirSync(path.join(project, '.build'), { recursive: true });
  const work = fs.mkdtempSync(path.join(project, '.build/stage-'));
  try {
    const built = JSON.parse(execFileSync(process.execPath, [path.join(project, 'deploy/authority/build-release.mjs'), path.join(work, 'release')], { cwd: project, encoding: 'utf8' }).trim().split('\n').pop());
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'release/source-manifest.json'), 'utf8'));
    if (manifest.sourceRevision !== head || built.releaseName !== manifest.releaseName) throw new Error('Built manifest does not match HEAD');
    const mtime = Number(git('log', '-1', '--format=%ct', head));
    const tarball = packTar(path.join(work, 'release'), manifest.releaseName, mtime);
    const outDir = path.join(project, '.build/releases'); fs.mkdirSync(outDir, { recursive: true });
    const file = manifest.releaseName + '.tar.gz', target = path.join(outDir, file);
    fs.writeFileSync(target, tarball);
    const digest = createHash('sha256').update(tarball).digest('hex');
    fs.writeFileSync(target + '.sha256', `${digest}  ${file}\n`);
    console.log(JSON.stringify({ release: manifest.releaseName, sourceRevision: head, files: Object.keys(manifest.files).length, tarball: target, sha256: digest, bytes: tarball.length }));
    if (!noUpload) {
      execFileSync('ssh', [HOST, `mkdir -p -m 0700 ${INBOX}`], { stdio: 'inherit' });
      execFileSync('scp', ['-q', target, target + '.sha256', `${HOST}:${INBOX}/`], { stdio: 'inherit' });
      console.log('Uploaded. Deploy (human, on a TTY):');
    } else console.log('Not uploaded. After upload, deploy (human, on a TTY) with:');
    console.log(`  ssh -t ${HOST} 'sudo companion-deploy deploy ~blackmagic/${INBOX}/${file}'`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error('stage-release: ' + error.message); process.exitCode = 1; }
}
