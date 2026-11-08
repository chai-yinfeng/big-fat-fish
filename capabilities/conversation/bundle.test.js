import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createConversationClient } from './client.js';
import { tempRoot, tokenFile, fakeAuthority, fakeGateway, reply, toolCall } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The release ships only the esbuild bundle, so exercise that exact artifact.
test('the released single-file bundle starts and completes a tool round with reasoning replay', { timeout: 60000 }, async t => {
  const root = tempRoot(t);
  const bundle = path.join(root, 'conversation.mjs');
  execFileSync(process.execPath, [path.join(here, 'build.mjs'), bundle], { stdio: 'ignore' });
  const authority = await fakeAuthority(t, root), gateway = await fakeGateway(t, root), caller = tokenFile(root, 'caller.token');
  const config = path.join(root, 'conversation.json'), socketPath = path.join(root, 'execute.sock');
  fs.writeFileSync(config, JSON.stringify({ socketPath, callerTokenHash: createHash('sha256').update(caller.token).digest('hex'), sessionsDir: path.join(root, 'sessions'), authority: authority.config, gateway: gateway.config }), { mode: 0o600 });
  const child = spawn(process.execPath, [bundle, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  for (let i = 0; i < 200 && !/ready|could not start/.test(output); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(output, /executor ready/);
  gateway.state.script.push(toolCall('companion_scope', { action: 'evidence' }, 'R-bundle'), reply('打包可用'));
  const text = await createConversationClient({ socketPath, tokenFile: caller.file }).execute({ scope: { streamId: 'qq:1:private:2', memoryEpoch: 0 }, requestId: 'bundle-1', input: { text: '你好', evidence: [{ ref: 'obs', eventId: 'e', role: 'user' }] }, timeoutMs: 10000 });
  assert.equal(text, '打包可用');
  assert.equal(gateway.state.bodies[1].messages.find(message => message.role === 'assistant').reasoning_content, 'R-bundle');
  assert.equal(fs.readdirSync(path.join(root, 'sessions')).length, 1);
});
