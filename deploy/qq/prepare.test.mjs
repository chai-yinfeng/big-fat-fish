import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE, PLATFORMS, renderFiles } from './prepare.mjs';

const options = () => ({ webuiToken: 'a'.repeat(64), onebotToken: 'b'.repeat(64), uid: 1000, gid: 1000, arch: 'arm64' });

test('prepare content pins the release, loopback ports, and exactly three dedicated mounts', () => {
  const files = renderFiles(options());
  const compose = files['compose.yaml'];
  assert.ok(IMAGE.startsWith('mlikiowa/napcat-docker:v4.18.42@sha256:'));
  assert.ok(compose.includes('platform: linux/arm64'));
  assert.deepEqual(compose.match(/127\.0\.0\.1:\d+:\d+/g), ['127.0.0.1:6099:6099', '127.0.0.1:3001:3001']);
  assert.equal((compose.match(/:\/app\//g) || []).length, 3);
  assert.ok(compose.includes('./private/napcat.env'));
  assert.ok(compose.includes('driver: "none"'));
  assert.ok(!/privileged|docker\.sock|network_mode|modelKey|dsh-home|authority/.test(compose));
  assert.ok(!compose.includes(options().webuiToken));
  assert.ok(!compose.includes(options().onebotToken));
});

test('compose platform follows the host architecture with the same multi-arch digest', () => {
  for (const [arch, platform] of [['arm64', 'linux/arm64'], ['x64', 'linux/amd64']]) {
    const files = renderFiles({ ...options(), arch });
    assert.ok(files['compose.yaml'].includes(`image: ${IMAGE}\n    platform: ${platform}\n`));
    assert.equal((files['compose.yaml'].match(/platform:/g) || []).length, 1);
    assert.deepEqual(JSON.parse(files['prepared.json']), { schema: 1, image: IMAGE, platform });
  }
  assert.equal(renderFiles({ ...options(), arch: undefined })['compose.yaml'].includes(`platform: ${PLATFORMS[process.arch]}`), Boolean(PLATFORMS[process.arch]));
  assert.throws(() => renderFiles({ ...options(), arch: 'ia32' }), /UNSUPPORTED_ARCH/);
});

test('official ws template is authenticated before first login without an invented env', () => {
  const files = renderFiles(options());
  const config = JSON.parse(files['data/config/onebot11.json']);
  const server = config.network.websocketServers[0];
  assert.equal(server.token, options().onebotToken);
  assert.equal(server.enable, true);
  assert.equal(server.port, 3001);
  assert.equal(server.messagePostFormat, 'array');
  assert.equal(config.network.websocketClients.length, 0);
  assert.ok(files['private/napcat.env'].includes('WEBUI_TOKEN='));
  assert.ok(!files['private/napcat.env'].includes('ONEBOT_TOKEN='));
  assert.equal(files['private/onebot.token'].trim(), options().onebotToken);
  assert.equal(Object.keys(files).at(-1), 'prepared.json');
});

test('reject empty, reused, injected tokens and root UID', () => {
  for (const patch of [{ webuiToken: '' }, { onebotToken: options().webuiToken }, { webuiToken: 'x\nMODE=unsafe' }, { uid: 0 }, { gid: -1 }]) {
    assert.throws(() => renderFiles({ ...options(), ...patch }));
  }
});
