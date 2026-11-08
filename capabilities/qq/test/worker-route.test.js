import test from 'node:test';
import assert from 'node:assert/strict';
import { qqRequestId } from '../worker-route.js';
import { observationFromOneBot } from '../source.js';

test('request IDs bind one platform event to its stream and refuse untrusted input', () => {
  const observation = observationFromOneBot({ post_type: 'message', self_id: '100', user_id: '200', message_id: '31', message_type: 'private', time: 9, message: 'I prefer tea' }, { expectedSelfId: '100' });
  const id = qqRequestId(observation);
  assert.match(id, /^qq-message-[a-f0-9]{64}$/);
  assert.equal(qqRequestId({ ...observation }), id);
  assert.notEqual(qqRequestId({ ...observation, streamId: 'qq:100:private:201' }), id);
  assert.throws(() => qqRequestId({ text: 'no event' }), /QQ_INPUT_UNTRUSTED/);
});
