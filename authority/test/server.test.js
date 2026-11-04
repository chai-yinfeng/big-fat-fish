import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createAuthorityServer } from '../src/server.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-http-'));
  const authority = new Authority({ file: path.join(root, 'state.sqlite') });
  const token = randomBytes(32).toString('hex'), admin = randomBytes(32).toString('hex');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const socketPath = path.join(root, 'api.sock');
  authority.registerCapability({ id: 'native', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'native', externalActorId: 'owner', personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'native', streamId: 'a', personId: 'person:owner', audience: 'private' });
  const app = createAuthorityServer({ authority, socketPath, credentials: [{ hash: hash(token), role: 'capability', capabilityId: 'native' }, { hash: hash(admin), role: 'admin' }] });
  await app.start();
  t.after(async () => { await app.close(); authority.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(method, url, body, credential = token) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: url, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), 'content-type': 'application/json' } }, res => {
        let value = ''; res.on('data', chunk => { value += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(value) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  return { authority, app, request, token, admin, socketPath };
}

test('UDS transport authenticates before exposing state or privileged operations', async t => {
  const { request, admin, app } = await fixture(t);
  assert.equal(typeof app.server.address(), 'string');
  assert.equal((await request('GET', '/v1/health', undefined, '')).status, 401);
  assert.equal((await request('GET', '/v1/admin/state')).status, 403);
  assert.equal((await request('POST', '/v1/admin/actors', { capabilityId: 'native', externalActorId: 'fake', personId: 'person:owner' })).status, 403);
  assert.equal((await request('GET', '/v1/admin/state', undefined, admin)).status, 200);
});

test('proposals are durably queued, serially reviewed and visible only through the capability grant', async t => {
  const { request } = await fixture(t);
  const observation = await request('POST', '/v1/observations', { eventId: 'e1', streamId: 'a', actorId: 'owner', role: 'user', text: '我喜欢咖啡', at: 1000 });
  assert.equal(observation.status, 200);
  const queued = await request('POST', '/v1/proposals', { proposalId: 'p1', observationId: observation.body.value.observationId, type: 'fact.report', payload: { key: '饮料', value: '咖啡', quote: '我喜欢咖啡' } });
  assert.equal(queued.body.value.status, 'pending');
  let receipt;
  for (let attempt = 0; attempt < 30; attempt++) {
    receipt = await request('GET', '/v1/receipts/p1');
    if (receipt.body.value.status !== 'pending') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(receipt.body.value.status, 'accepted');
  const context = await request('POST', '/v1/context', { streamId: 'a', query: '咖啡', budgetChars: 2400 });
  assert.match(context.body.value.text, /咖啡/);
});

test('transport rejects source selectors, malformed JSON and oversized input without echoing credentials', async t => {
  const { request, token } = await fixture(t);
  const overridden = await request('POST', '/v1/observations', { capabilityId: 'other', eventId: 'x' });
  assert.equal(overridden.status, 400);
  assert.equal((await request('POST', '/v1/proposals', '{broken')).status, 400);
  assert.equal((await request('POST', '/v1/proposals', { payload: 'x'.repeat(40000) })).status, 413);
  const denied = await request('GET', '/v1/health', undefined, token + 'wrong');
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes(token), false);
});

test('socket lifecycle never removes an existing unrelated file or a live server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-socket-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'not-a-socket');
  fs.writeFileSync(file, 'keep');
  const credentials = [{ hash: 'a'.repeat(64), role: 'admin' }];
  const authority = { processPending: () => [] };
  await assert.rejects(createAuthorityServer({ authority, socketPath: file, credentials }).start(), /socket|existing/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  const live = http.createServer();
  const socketPath = path.join(root, 'live.sock');
  await new Promise(resolve => live.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => live.close(resolve)));
  await assert.rejects(createAuthorityServer({ authority, socketPath, credentials }).start(), /socket|live|use/i);
  assert.ok(fs.lstatSync(socketPath).isSocket());
});
