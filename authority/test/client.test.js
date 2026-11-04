import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorityClient } from '../src/client.js';

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-client-'));
  const socketPath = join(dir, 'a.sock');
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'fixture-secret\n');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { client: new AuthorityClient({ socketPath, tokenFile, timeoutMs: 60, maxResponseBytes: 1024 }), dir };
}

test('restricted client sends bearer only in header and encoded receipt id', async t => {
  const seen = [];
  const { client } = await fixture(t, (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.end(JSON.stringify({ ok: true, value: null }));
  });
  await client.getReceipt('a/b');
  assert.deepEqual(seen, [['GET', '/v1/receipts/a%2Fb', 'Bearer fixture-secret']]);
  assert.equal(client.request, undefined);
  assert.equal(client.registerCapability, undefined);
  assert.equal(client.snapshot, undefined);
});

test('rejects unknown request fields before transport', async t => {
  const { client } = await fixture(t, () => assert.fail('must not request'));
  await assert.rejects(client.context({ streamId: 's', personId: 'victim' }), /INVALID_REQUEST/);
  await assert.rejects(client.observe({ eventId: 'e', streamId: 's', actorId: 'a', role: 'user', text: 'x', at: 1, capabilityId: 'admin' }), /INVALID_REQUEST/);
});

test('server errors and malformed envelopes never echo secrets or private input', async t => {
  const { client } = await fixture(t, (_req, res) => { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: { code: 'DENIED', message: 'fixture-secret private diary' } })); });
  await assert.rejects(client.health(), error => error.message === 'Authority request failed (403)' && !JSON.stringify(error).includes('fixture-secret'));
});

test('bounds response and total request time', async t => {
  const { client } = await fixture(t, (req, res) => { if (req.url === '/v1/health') res.end('x'.repeat(2048)); });
  await assert.rejects(client.health(), /RESPONSE_LIMIT/);
  await assert.rejects(client.context({ streamId: 's' }), /TIMEOUT/);
});

test('rejects success envelope with wrong shape', async t => {
  const { client } = await fixture(t, (_req, res) => res.end('{"ok":true}'));
  await assert.rejects(client.health(), /INVALID_RESPONSE/);
});
