import test from 'node:test';
import assert from 'node:assert/strict';
import { Authority } from '../../../authority/src/engine.js';
import { ConversationPort } from '../../conversation/index.js';
import { QQIngress } from '../ingress.js';

test('native and QQ ingress share the conversation port and Authority-owned person state', async t => {
  const authority = new Authority({ file: ':memory:', clock: () => 1000 });
  t.after(() => authority.close());
  const streams = { native: 'test-one', qq: 'qq:123:private:456' };
  const actors = { native: 'test-owner', qq: 'qq:123:user:456' };
  const ports = {};
  for (const capabilityId of ['native', 'qq']) {
    authority.registerCapability({ id: capabilityId, policy: 'conversation.v1' });
    authority.bindActor({ capabilityId, externalActorId: actors[capabilityId], personId: 'person:owner' });
    authority.bindStream({ capabilityId, streamId: streams[capabilityId], personId: 'person:owner', audience: 'private' });
    // The injected face has only the real capability-client operations.
    ports[capabilityId] = new ConversationPort({
      observe: input => authority.observe(capabilityId, input),
      context: input => authority.context(capabilityId, input),
      submit: input => authority.submit(capabilityId, input),
      getReceipt: id => authority.getReceipt(capabilityId, id),
    });
  }
  const qq = new QQIngress({ port: ports.qq, expectedSelfId: '123' });
  const nativeObservation = await ports.native.observe({ eventId: 'native-1', streamId: streams.native, actorId: actors.native, role: 'user', text: 'I like tea.', at: 800 });
  const qqObservation = await qq.observe({ post_type: 'message', self_id: 123, user_id: 456, message_id: 7, time: 2, message_type: 'private', message: 'I like coffee.' });
  for (const [source, observation, value] of [['native', nativeObservation, 'tea'], ['qq', qqObservation, 'coffee']]) {
    const proposal = { proposalId: source, observationId: observation.observationId, type: 'fact.report', payload: { key: source, value, quote: `I like ${value}.` } };
    assert.equal((await ports[source].submit(proposal)).status, 'pending');
  }
  authority.processPending();
  for (const source of ['native', 'qq']) {
    assert.equal((await ports[source].receipt(source)).status, 'accepted');
    const context = await ports[source].context({ streamId: streams[source] });
    assert.match(context.text, /tea/);
    assert.match(context.text, /coffee/);
  }
  assert.equal(await qq.observe({ post_type: 'meta_event' }), null);
  assert.equal(authority.snapshot().observations.length, 2);
  assert.equal(authority.snapshot().observations[1].at, 2000);
});
