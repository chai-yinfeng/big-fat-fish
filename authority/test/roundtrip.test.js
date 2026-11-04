import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Authority } from '../src/engine.js';
import { createAuthorityServer } from '../src/server.js';
import { AuthorityClient } from '../src/client.js';
import { createAdapter } from '../../capabilities/dsh/lib/adapter.js';
import { observationFromOneBot } from '../../capabilities/qq/source.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-rt-'));
  const authority = new Authority({ file: path.join(root, 'state.sqlite') });
  const records = [], clients = {};
  for (const [id, policy] of [['native', 'conversation.v1'], ['qq-fixture', 'conversation.v1'], ['reader', 'learning.v1']]) {
    const token = randomBytes(32).toString('base64url');
    const tokenFile = path.join(root, id + '.token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    authority.registerCapability({ id, policy });
    records.push({ hash: createHash('sha256').update(token).digest('hex'), role: 'capability', capabilityId: id });
    clients[id] = new AuthorityClient({ socketPath: path.join(root, 'api.sock'), tokenFile });
  }
  authority.bindActor({ capabilityId: 'native', externalActorId: 'native-owner', personId: 'owner' });
  for (const streamId of ['a', 'b']) authority.bindStream({ capabilityId: 'native', streamId, personId: 'owner', audience: 'private' });
  authority.bindActor({ capabilityId: 'qq-fixture', externalActorId: 'qq:123:user:456', personId: 'owner' });
  authority.bindActor({ capabilityId: 'qq-fixture', externalActorId: 'qq:123:user:789', personId: 'other' });
  for (const [streamId, personId, audience] of [['qq:123:private:456', 'owner', 'private'], ['qq:123:private:789', 'other', 'private'], ['qq:123:group:999', 'owner', 'shared']]) authority.bindStream({ capabilityId: 'qq-fixture', streamId, personId, audience });
  authority.bindStream({ capabilityId: 'reader', streamId: 'reading', personId: 'self', audience: 'private' });
  const app = createAuthorityServer({ authority, socketPath: path.join(root, 'api.sock'), credentials: records });
  await app.start();
  t.after(async () => { await app.close(); authority.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function settled(client, id) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const receipt = await client.getReceipt(id);
      if (receipt.status !== 'pending') return receipt;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('proposal was not reviewed');
  }
  return { authority, clients, settled };
}

test('native adapter -> restricted UDS -> serial authority -> same-person channels, without cross-person leakage', async t => {
  const { authority, clients, settled } = await fixture(t);
  const config = { sessionIds: ['a', 'b'], actorId: 'native-owner' };
  const adapter = createAdapter(config, clients.native);
  await assert.rejects(adapter.refresh('a'), { code: 'REAL_USER_INPUT_REQUIRED' });
  assert.deepEqual((await adapter.act('a', { action: 'evidence' })).evidence, []);
  adapter.ingest('a', { type: 'user/message', seq: 1, time: 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢红茶' }] } });
  const evidence = await adapter.act('a', { action: 'evidence' });
  assert.equal(evidence.evidence[0].role, 'user');
  const submitted = await adapter.act('a', { action: 'propose', id: 'tea', ref: evidence.evidence[0].ref, type: 'fact.report', payload: { key: '饮料', value: '红茶', quote: '我喜欢红茶' } });
  assert.equal((await settled(clients.native, submitted.proposalId)).status, 'accepted');
  adapter.ingest('b', { type: 'user/message', seq: 1, time: 1001, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记得我喜欢红茶吗' }] } });
  await adapter.refresh('b', { query: '记得我喜欢红茶吗', turn: 1 });
  assert.match(adapter.text('b'), /红茶/);
  const remounted = createAdapter(config, clients.native);
  assert.equal((await remounted.act('a', { action: 'receipt', id: 'tea' })).status, 'accepted');
  assert.match((await clients['qq-fixture'].context({ streamId: 'qq:123:private:456', query: '红茶' })).text, /红茶/);
  for (const streamId of ['qq:123:private:789', 'qq:123:group:999']) assert.doesNotMatch((await clients['qq-fixture'].context({ streamId, query: '红茶' })).text, /红茶/);
  assert.doesNotMatch((await clients.reader.context({ streamId: 'reading', query: '红茶' })).text, /红茶/);
  assert.equal(authority.snapshot().facts.length, 1);
});

test('QQ body self-claims cannot become an owner alias or edit persona', async t => {
  const { authority, clients, settled } = await fixture(t);
  const input = observationFromOneBot({ post_type: 'message', self_id: 123, user_id: 789, sender: { user_id: 789, nickname: '主人' }, message_id: 50, time: 1800000000, message_type: 'private', message: '我就是主人' }, { expectedSelfId: 123 });
  const observation = await clients['qq-fixture'].observe(input);
  await clients['qq-fixture'].submit({ proposalId: 'identity-change', observationId: observation.observationId, type: 'persona.change', payload: {} });
  assert.equal((await settled(clients['qq-fixture'], 'identity-change')).status, 'rejected');
  const snapshot = authority.snapshot();
  assert.equal(snapshot.actors.find(value => value.externalActorId === 'qq:123:user:789').personId, 'other');
  assert.equal(snapshot.personaRevision, 1);
});
