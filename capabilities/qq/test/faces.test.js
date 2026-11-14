import test from 'node:test';
import assert from 'node:assert/strict';
import { QQ_FACES, MAX_FACES_PER_MESSAGE, faceText, replySegments, withoutFaceMarkers } from '../faces.js';
import { splitReply } from '../split.js';
import { channel } from '../../channels/index.js';
import { FACE_NAMES } from '../../channels/qq/manifest.js';

// The names QQ's declaration would offer her when faces are on (they are off for now: faceNames is then empty).
const PROMPT_FACE_NAMES = FACE_NAMES;

const text = value => ({ type: 'text', data: { text: value } }), face = id => ({ type: 'face', data: { id } });

test('the table: 116 numbered faces with distinct names; a number not in it is a plain [表情]', () => {
  assert.equal(Object.keys(QQ_FACES).length, 116);
  assert.equal(new Set(Object.values(QQ_FACES)).size, 116);
  assert.deepEqual([faceText('14'), faceText('179'), faceText('277'), faceText('9999')], ['[微笑]', '[doge]', '[汪汪]', '[表情]']);
});

test('every face name the base prompt offers her is in the table', () => {
  assert.ok(PROMPT_FACE_NAMES.length >= 30 && PROMPT_FACE_NAMES.length <= 50);
  for (const name of PROMPT_FACE_NAMES) assert.ok(Object.values(QQ_FACES).includes(name), name);
});

test('[名字] of the table becomes a face segment where it stands, in the same message; anything else stays text', () => {
  assert.deepEqual(replySegments('好呀[微笑]明天见'), [text('好呀'), face('14'), text('明天见')]);
  assert.deepEqual(replySegments('[doge]'), [face('179')]);
  assert.deepEqual(replySegments('哈哈[笑哭][捂脸]'), [text('哈哈'), face('182'), face('264')]);
  // Not in the table, not exact, or not a marker at all: text as written.
  for (const value of ['这个[不存在]的', '[ 微笑]', '[微笑 ]', '[微 笑]', '【微笑】', '微笑', '[]', '']) assert.deepEqual(replySegments(value), [text(value)]);
  assert.deepEqual(replySegments('[不存在][微笑]'), [text('[不存在]'), face('14')]);
  assert.deepEqual(replySegments('[[微笑]]'), [text('['), face('14'), text(']')]);
});

test(`at most ${MAX_FACES_PER_MESSAGE} faces a message; later markers stay text`, () => {
  assert.equal(MAX_FACES_PER_MESSAGE, 3);
  assert.deepEqual(replySegments('[微笑]一[赞]二[OK]三[doge]四[微笑]'), [face('14'), text('一'), face('76'), text('二'), face('124'), text('三[doge]四[微笑]')]);
});

test('a long reply is split first, then each message gets its faces; a marker is never cut in two', () => {
  const reply = '今天下班路上看到一只橘猫趴在便利店门口晒太阳，圆滚滚的特别像你上次发给我的那张照[微笑]片。我蹲下来看了它好一会儿[doge]，它居然一点都不怕人，还伸了个懒腰！后来店员出来说它叫大橘[捂脸]。';
  const pieces = splitReply(reply);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces.join(''), reply);
  for (const piece of pieces) assert.doesNotMatch(piece, /\[[^\]]*$|^[^[]*\]/, piece);
  // Every marker sits wholly inside one message, at the limit too.
  for (let at = 50; at <= 60; at++) {
    const crafted = '一'.repeat(at) + '[微笑]' + '二'.repeat(30);
    for (const piece of splitReply(crafted)) assert.doesNotMatch(piece, /\[[^\]]*$|^[^[]*\]/, `${at}: ${piece}`);
  }
  const faces = pieces.flatMap(piece => replySegments(piece)).filter(segment => segment.type === 'face').map(segment => segment.data.id);
  assert.deepEqual(faces, ['14', '179', '264']);
});

test('faces off (the default of QQ\'s declaration): every marker stays text, the message is one text segment', () => {
  assert.equal(channel('qq').expression.faces, false);
  assert.deepEqual(channel('qq').faceNames, []);
  assert.doesNotMatch(channel('qq').prompt, /\[微笑\]|小表情/);
  for (const value of ['好呀[微笑]明天见', '[doge]', '']) assert.deepEqual(replySegments(value, false), [text(value)]);
});

test('a reply spoken aloud loses the markers of the table and keeps every other bracket', () => {
  assert.equal(withoutFaceMarkers('好呀[微笑]，明天见[doge]'), '好呀，明天见');
  assert.equal(withoutFaceMarkers('[不存在]和[1]、[微 笑]、（笑）都留着'), '[不存在]和[1]、[微 笑]、（笑）都留着');
});
