import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { WORLD, PRODUCTION_HOST, SUDO_PROMPT, sudoReadCommand, parseSudoRead, failureCode, errorCode, readCompanionFiles, readCompanionFile, webuiToken } from './companion-sudo.mjs';

const token = 'T'.repeat(43);
const B = '@@companion-file@@', E = '@@companion-end@@';

test('remote command reads only fixed companion paths through sudo -u companion', () => {
  const command = sudoReadCommand([WORLD + '/operator/console.token']);
  assert.match(command, /^sudo -p '\[sudo\] production host password[^']*' -u companion sh -c '/);
  assert.ok(command.includes('cat /home/companion/.local/share/companion-world-v1/operator/console.token'));
  for (const bad of ['/etc/shadow', '/home/companion/../root/x', "/home/companion/a'b", '/home/companion/a b', '/home/companion/$(id)'])
    assert.throws(() => sudoReadCommand([bad]), /INVALID_COMPANION_PATH/);
  assert.throws(() => sudoReadCommand([]), /INVALID_COMPANION_PATH/);
});

test('ssh -t output is parsed past prompts, retries and CRLF', () => {
  const noisy = `${SUDO_PROMPT}\r\nSorry, try again.\r\n${SUDO_PROMPT}\r\n${B}\r\n{"origin":"http://127.0.0.1:3081/"}\r\n\r\n${B}\r\n${token}\r\n\r\n${E}\r\n`;
  assert.deepEqual(parseSudoRead(noisy, 2), ['{"origin":"http://127.0.0.1:3081/"}\n', token + '\n']);
  assert.deepEqual(parseSudoRead(`${B}\n${token}\n${E}\n`, 1), [token]);
  assert.throws(() => parseSudoRead('sudo: 3 incorrect password attempts\r\n', 1), /SUDO_FAILED/);
  assert.throws(() => parseSudoRead(`${B}\ncat: x: No such file\n`, 1), /TOKEN_READ_FAILED/);
  assert.throws(() => parseSudoRead(`${B}\na\n${E}\n`, 2), /TOKEN_READ_FAILED/);
});

test('exit status and errors map to printable codes only', () => {
  assert.equal(failureCode(255, ''), 'SSH_FAILED');
  assert.equal(failureCode(1, 'Sorry, try again.\r\n'), 'SUDO_FAILED');
  assert.equal(failureCode(3, `${B}\r\ncat: missing\r\n`), 'TOKEN_READ_FAILED');
  assert.equal(errorCode(Error('FORWARD_PORT_OCCUPIED')), 'FORWARD_PORT_OCCUPIED');
  assert.equal(errorCode(Error('connect ECONNREFUSED ' + token)), 'UNEXPECTED_ERROR');
  assert.equal(errorCode(undefined), 'UNEXPECTED_ERROR');
});

test('NapCat WebUI token is accepted only for the fixed local config', () => {
  const hex = 'a'.repeat(64);
  assert.equal(webuiToken(JSON.stringify({ port: 6099, prefix: '/', token: hex })), hex);
  for (const config of [{ port: 6100, token: hex }, { port: 6099, prefix: '/x', token: hex }, { port: 6099, token: 'short' }])
    assert.throws(() => webuiToken(JSON.stringify(config)), /INVALID_WEBUI_CONFIG/);
  assert.throws(() => webuiToken('not json'), /INVALID_WEBUI_CONFIG/);
});

function fakeSsh(chunks, status) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough();
    setImmediate(() => { for (const chunk of chunks) child.stdout.write(chunk); child.stdout.end(); child.stdout.once('end', () => child.emit('close', status)); child.stdout.resume(); });
    return child;
  };
  return { spawnImpl, calls };
}

async function capturedStderr(run) {
  const original = process.stderr.write, written = [];
  process.stderr.write = text => { written.push(String(text)); return true; };
  try { return { result: await run().catch(error => error), stderr: written.join('') }; }
  finally { process.stderr.write = original; }
}

test('reader shows each sudo prompt once and never echoes the secret', async () => {
  const half = SUDO_PROMPT.length >> 1;
  const { spawnImpl, calls } = fakeSsh([SUDO_PROMPT.slice(0, half), SUDO_PROMPT.slice(half) + '\r\n', `${B}\r\n${token}\r\n`, `\r\n${E}\r\n`], 0);
  const { result, stderr } = await capturedStderr(() => readCompanionFile(WORLD + '/operator/console.token', { host: 'other-host', spawnImpl }));
  assert.equal(result, token);
  assert.equal(stderr, SUDO_PROMPT);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-t', 'other-host']);
  assert.deepEqual(calls[0].options.stdio, ['inherit', 'pipe', 'inherit']);
});

test('reader rejects with a code and keeps output private on failure', async () => {
  const { spawnImpl, calls } = fakeSsh([SUDO_PROMPT, '\r\nSorry, try again.\r\n'], 1);
  const { result, stderr } = await capturedStderr(() => readCompanionFiles([WORLD + '/operator/console.token'], { spawnImpl }));
  assert.equal(calls[0].args[1], PRODUCTION_HOST);
  assert.equal(result.message, 'SUDO_FAILED');
  assert.equal(stderr, SUDO_PROMPT);
});

test('production host defaults to home-agent, follows COMPANION_HOST and rejects option-like values', () => {
  const module = new URL('./companion-sudo.mjs', import.meta.url).href;
  const host = env => spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(module)}).then(m => process.stdout.write(m.PRODUCTION_HOST))`], { env, encoding: 'utf8' });
  const { COMPANION_HOST, ...base } = process.env;
  assert.equal(host(base).stdout, 'home-agent');
  assert.equal(host({ ...base, COMPANION_HOST: 'myvm' }).stdout, 'myvm');
  const bad = host({ ...base, COMPANION_HOST: '-oProxyCommand=x' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /INVALID_SSH_HOST/);
});
