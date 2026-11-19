import test from 'node:test';
import assert from 'node:assert/strict';
import { takeStickerMarker, asksToKeep, asksToKeepMany, frequencyLine, MAX_KEEP_PER_REQUEST } from '../stickers.js';
import { channel } from '../../channels/index.js';

test('[表情:词] is taken out of her reply; only the first word counts, more are dropped and logged', () => {
  const logs = [], take = text => takeStickerMarker(text, line => logs.push(line));
  assert.deepEqual(take('好呀[表情:开心]'), { text: '好呀', word: '开心' });
  assert.deepEqual(take('好呀 [表情： 摸鱼 ] 去吧'), { text: '好呀 去吧', word: '摸鱼' });
  assert.deepEqual(take('[表情:开心]'), { text: '', word: '开心' });
  assert.deepEqual(logs, []);
  assert.deepEqual(take('一[表情:开心]二[表情:晚安]'), { text: '一二', word: '开心' });
  assert.equal(logs.length, 1);
  // Not a sticker marker: a small face, an empty word, a word too long, brackets of another kind.
  assert.deepEqual(take('  原样  保留\n'), { text: '  原样  保留\n', word: null }, 'a reply without a marker is untouched');
  for (const text of ['好[微笑]', '[表情:]', '[表情:' + '长'.repeat(13) + ']', '【表情:开心】', '[表情]']) assert.deepEqual(take(text), { text, word: null });
});

test('收下这个 is a short request; the frequency line counts her latest replies; the marker QQ\'s prompt teaches is the one taken out', () => {
  for (const text of ['收下这个', '收下这张！', 'MOCK-K10-R1ABC 收下它']) assert.equal(asksToKeep(text), true, text);
  for (const text of ['收下', '我收下了', '他说要收下这个礼物，然后' + '很'.repeat(40), undefined]) assert.equal(asksToKeep(text), false, String(text));
  assert.equal(frequencyLine([]), ''); assert.equal(frequencyLine(undefined), '');
  assert.equal(frequencyLine([true, false, true]), '\n[渠道事实：你最近 3 条回复里发过 2 次表情包。]');
  const example = /\[表情:[^\]]+\]/.exec(channel('qq').prompt)[0];
  assert.deepEqual(takeStickerMarker('好' + example), { text: '好', word: example.slice(4, -1) });
  assert.ok(channel('qq').expression.stickers);
});

test('收下这些 names several pictures: a short message; the singular and other words stay what they were', () => {
  for (const text of ['这些都收下', '把刚才的都收了', '收下这几张', '收下它们', '这几张图都收下吧', '全部收下', '都收下', 'MOCK-K11-R1ABC 刚刚的全收了']) assert.equal(asksToKeepMany(text), true, text);
  for (const text of ['收下这个', '收下这张', '收下它', '我都收了', '我收下了', '收下', '这些都很好看', '他说这些都收下了，然后' + '很'.repeat(40), undefined]) assert.equal(asksToKeepMany(text), false, String(text));
  for (const text of ['收下这个', '收下这张', '收下它']) assert.equal(asksToKeep(text), true, text);
  assert.equal(MAX_KEEP_PER_REQUEST, 10);
});
