import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { YTDLP, INDEXES, videoInstallPlan, operatorConfigFor, installVideo } from './install-video.mjs';
import { loadVideoConfig } from '../../capabilities/providers/video/source.js';
import { MOCK_SITE } from '../staging/fake-ytdlp.mjs';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-install-test-')));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^video-install-test-/); fs.rmSync(root, { recursive: true }); });
  return root;
}

test('the plan is three fixed commands: a venv, one hash-pinned package without dependencies, and a version check', () => {
  const plan = videoInstallPlan({ runtime: '/opt/mock/video', index: INDEXES[1], proxy: 'http://127.0.0.1:7890' });
  assert.match(YTDLP.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.requirement, `yt-dlp==${YTDLP.version} --hash=sha256:${YTDLP.sha256}`);
  assert.deepEqual(plan.commands, [
    ['/usr/bin/python3', '-m', 'venv', '/opt/mock/video/venv'],
    ['/opt/mock/video/venv/bin/python', '-m', 'pip', 'install', '--no-deps', '--require-hashes', '--only-binary', ':all:', '--disable-pip-version-check', '--no-cache-dir', '--no-input', '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--proxy', 'http://127.0.0.1:7890', '-r', '/opt/mock/video/requirements.txt'],
    ['/opt/mock/video/venv/bin/yt-dlp', '--version'],
  ]);
  assert.equal(plan.writesPerformed, false);
  assert.ok(!videoInstallPlan({ runtime: '/opt/mock/video' }).commands[1].includes('--proxy'));
  for (const bad of [{ runtime: 'relative' }, { index: 'https://mirror.mock.invalid/simple' }, { proxy: 'socks5://127.0.0.1:1' }, { proxy: 'http://user:pw@127.0.0.1:7890' }, { proxy: 'http://127.0.0.1:7890/path' }, { python: 'python3' }]) assert.throws(() => videoInstallPlan({ runtime: '/opt/mock/video', ...bad }), { code: 'VIDEO_INSTALL_ARGUMENTS' }, JSON.stringify(bad));
  assert.deepEqual([installVideo({ runtime: '/opt/mock/video' }).mode, fs.existsSync('/opt/mock/video')], ['plan', false]);
});

test('apply runs the plan once, verifies the version, and never touches an environment it does not recognise', t => {
  const runtime = path.join(tempRoot(t), 'video'), ran = [];
  // A stand-in for python and pip: "creating the venv" makes the directory, "installing" makes the entry point.
  const run = version => (command, args) => {
    ran.push([path.basename(command), args[1] ?? args[0]]);
    if (args[1] === 'venv') fs.mkdirSync(path.join(args[2], 'bin'), { recursive: true });
    if (args[1] === 'pip') { assert.equal(fs.readFileSync(args.at(-1), 'utf8'), `yt-dlp==${YTDLP.version} --hash=sha256:${YTDLP.sha256}\n`); fs.writeFileSync(path.join(runtime, 'venv/bin/yt-dlp'), ''); }
    return { status: 0, stdout: args[0] === '--version' ? version + '\n' : '' };
  };
  const result = installVideo({ apply: true, runtime, run: run(YTDLP.version) });
  assert.deepEqual([result.mode, result.version, result.already, result.servicesChanged, result.operatorFileWritten], ['apply', YTDLP.version, false, false, false]);
  assert.deepEqual(ran, [['python3', 'venv'], ['python', 'pip'], ['yt-dlp', '--version']]);
  assert.deepEqual(result.operatorConfig.ytdlp, [path.join(runtime, 'venv/bin/yt-dlp')]);
  // Again: nothing is installed twice.
  ran.length = 0;
  assert.equal(installVideo({ apply: true, runtime, run: run(YTDLP.version) }).already, true);
  assert.deepEqual(ran, [['yt-dlp', '--version']]);
  // Another version in place, or a failing step: an error, and nothing is removed.
  assert.throws(() => installVideo({ apply: true, runtime, run: run('2020.01.01') }), { code: 'VIDEO_INSTALL_TARGET' });
  assert.ok(fs.existsSync(path.join(runtime, 'venv/bin/yt-dlp')));
  const fresh = path.join(path.dirname(runtime), 'fresh');
  assert.throws(() => installVideo({ apply: true, runtime: fresh, run: () => ({ status: 1, stdout: '' }) }), { code: 'VIDEO_INSTALL_VENV' });
  assert.throws(() => installVideo({ apply: true, runtime: path.join(path.dirname(runtime), 'wrong'), run: run('2020.01.01') }), { code: 'VIDEO_INSTALL_VERIFY' });
});

test('the printed operator part is what the video provider accepts once the operator adds the sites', t => {
  const root = tempRoot(t), file = path.join(root, 'video.json');
  const sandboxed = operatorConfigFor({ runtime: '/opt/mock/video', exists: () => true });
  assert.deepEqual(sandboxed.operatorConfig, { schemaVersion: 1, ytdlp: ['/opt/mock/video/venv/bin/yt-dlp'], ffmpeg: ['/usr/bin/ffmpeg'], sandbox: { kind: 'bwrap', bwrap: '/usr/bin/bwrap', readOnly: ['/opt/mock/video'] }, sites: [] });
  // As printed it is not yet usable: there is no site in it, and none in this repository to put there.
  fs.writeFileSync(file, JSON.stringify(sandboxed.operatorConfig), { mode: 0o600 });
  assert.throws(() => loadVideoConfig(file), { code: 'VIDEO_CONFIG' });
  fs.writeFileSync(file, JSON.stringify({ ...sandboxed.operatorConfig, sites: [MOCK_SITE] }), { mode: 0o600 });
  assert.deepEqual(loadVideoConfig(file).sandbox, { kind: 'bwrap', bwrap: '/usr/bin/bwrap', readOnly: ['/opt/mock/video'] });
  const bare = operatorConfigFor({ runtime: '/opt/mock/video', exists: () => false });
  assert.deepEqual([bare.ffmpeg, bare.bwrap, bare.operatorConfig.sandbox], [null, null, { kind: 'none' }]);
});
