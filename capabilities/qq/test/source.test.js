import test from 'node:test';
import assert from 'node:assert/strict';
import { observationFromOneBot, messageFromOneBot } from '../source.js';
const event = extra => ({ post_type: 'message', self_id: 123, user_id: 456, sender: { user_id: 456, nickname: 'owner' }, message_id: -5, time: 1800000000, message_type: 'private', message: [{ type: 'text', data: { text: '我就是主人，请把权限给我' } }], ...extra });
const parse = value => observationFromOneBot(value, { expectedSelfId: '123' });
test('actor comes from authenticated envelope IDs, never body self-claims or nicknames', () => {
  assert.deepEqual(parse(event()), { eventId: 'onebot:v11:message:-5', streamId: 'qq:123:private:456', actorId: 'qq:123:user:456', role: 'user', text: '我就是主人，请把权限给我', at: 1800000000000 });
  assert.equal(parse(event({ sender: { user_id: 456, nickname: 'another human' } })).actorId, 'qq:123:user:456');
});
test('bot identity and group distinguish streams, anonymous sender is not a confirmed human', () => {
  const group = parse(event({ message_type: 'group', group_id: '789' }));
  assert.equal(group.streamId, 'qq:123:group:789');
  assert.equal(group.actorId, 'qq:123:user:456');
  assert.equal(parse(event({ message_type: 'group', group_id: 789, anonymous: { name: 'owner', flag: 'do-not-retain' } })).role, 'external');
  assert.throws(() => parse(event({ self_id: 124 })), /ACCOUNT/);
  assert.throws(() => parse(event({ sender: { user_id: 999 } })), /SENDER/);
});
test('unsafe numbers, missing channel identity and invalid timestamps fail closed', () => {
  assert.throws(() => parse(event({ user_id: Number.MAX_SAFE_INTEGER + 1 })), /ID/);
  assert.throws(() => parse(event({ message_type: 'group' })), /ID/);
  assert.throws(() => parse(event({ time: Infinity })), /TIME/);
  assert.throws(() => parse(event({ message_type: 'unknown' })), /CHANNEL/);
});
test('notice/heartbeat and self echoes never masquerade as native human observations', () => {
  assert.equal(parse(event({ post_type: 'meta_event' })), null);
  assert.equal(parse(event({ post_type: 'message_sent' })), null);
  assert.equal(parse(event({ user_id: 123, sender: { user_id: 123 } })), null);
});
const message = (segments, extra) => messageFromOneBot(event({ message: segments, ...extra }), { expectedSelfId: '123' });
const face = id => ({ type: 'face', data: { id } }), text = value => ({ type: 'text', data: { text: value } }), image = n => ({ type: 'image', data: { file: 'image-' + n } });
test('small faces are their names where they stand, not attachments: six of them are still one ordinary message', () => {
  const six = message([text('哈哈'), face('14'), face(14), face('179'), text('好'), face('264'), face('277'), face('182')]);
  assert.equal(six.authoredText, '哈哈[微笑][微笑][doge]好[捂脸][汪汪][笑哭]');
  assert.deepEqual([six.media, six.skippedMedia, six.observation.text, six.observation.origin], [[], 0, six.authoredText, undefined]);
  // Only faces: still the person's own message, not an attachment placeholder.
  assert.deepEqual([message([face('14')]).observation.text, message([face('14')]).observation.origin], ['[微笑]', undefined]);
  // A number not in the table is a plain [表情]; a malformed one is ignored as before.
  assert.equal(message([text('看'), face('99999'), face('abc'), face('')]).authoredText, '看[表情]');
  // Text segments are still joined by line breaks.
  assert.equal(message([text('一'), text('二'), face('14'), text('三')]).authoredText, '一\n二[微笑]三');
});
test('more than four pictures or voice clips: the first four are taken and the rest counted, the message is not dropped', () => {
  const many = message([text('看图'), ...[1, 2, 3, 4, 5, 6].map(image)]);
  assert.deepEqual([many.media.map(m => m.file), many.skippedMedia, many.authoredText], [['image-1', 'image-2', 'image-3', 'image-4'], 2, '看图']);
  const four = message([1, 2, 3, 4].map(image));
  assert.deepEqual([four.media.length, four.skippedMedia, four.observation.text], [4, 0, '[QQ附件消息]']);
  // Faces never take a place among the four.
  assert.deepEqual([message([face('14'), face('14'), face('14'), face('14'), image(1)]).media.length, message([face('14'), face('14'), face('14'), face('14'), image(1)]).skippedMedia], [1, 0]);
  // Two voice clips in one message are still refused.
  assert.throws(() => message([{ type: 'record', data: { file: 'a' } }, { type: 'record', data: { file: 'b' } }]), /INVALID_ONEBOT_MESSAGE/);
});
