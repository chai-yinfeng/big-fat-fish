import test from 'node:test';
import assert from 'node:assert/strict';
import { speechText } from './text.js';

test('speech text: plain sentences are handed to synthesis unchanged', () => {
  for (const text of ['我在。', '你好，这是一次本地语音试听。今天也辛苦了，我们慢慢聊吧。', '今天25℃，3 + 4 = 7，对吧？', '嗯……好！！真的吗？！', 'OK, see you at 11:20. Bye!', '第一行\n第二行']) assert.equal(speechText(text), text);
});

test('speech text: paired round brackets go with their content, Chinese or English, nested or mixed', () => {
  assert.equal(speechText('（轻轻笑）你回来啦。'), '你回来啦。');
  assert.equal(speechText('你回来啦（歪头）今天累不累？'), '你回来啦今天累不累？');
  assert.equal(speechText('好呀 (sighs softly) 那就明天见'), '好呀 那就明天见');
  assert.equal(speechText('嗯（停顿（很久））我想想（小声)。'), '嗯我想想。');
  assert.equal(speechText('晚安。（挥手）'), '晚安。');
  // Other brackets and an unpaired round one are spoken text and stay.
  assert.equal(speechText('《小王子》里说【重要】的东西“看不见”。'), '《小王子》里说【重要】的东西“看不见”。');
  assert.equal(speechText('第一点）先吃饭，（然后呢'), '第一点）先吃饭，（然后呢');
});

test('speech text: emoji and common emoticons are dropped', () => {
  assert.equal(speechText('好的😊明天见👋🏻'), '好的明天见');
  assert.equal(speechText('收到 ❤️ 爱你 👨‍👩‍👧 🇨🇳'), '收到 爱你');
  assert.equal(speechText('太好了 (≧▽≦) 我们走吧 ╮(╯▽╰)╭'), '太好了 我们走吧');
  assert.equal(speechText('呜呜 QAQ 不要走 T_T'), '呜呜 不要走');
  assert.equal(speechText('嘿嘿^_^ 好困-_-|| 哼>_<'), '嘿嘿 好困 哼');
  assert.equal(speechText('晚安☆～做个好梦♪'), '晚安～做个好梦');
  assert.equal(speechText('ok :) see you ;-)'), 'ok see you');
  // Letters that only look like one inside a word are kept.
  assert.equal(speechText('QAQ3 和 TATA 是型号'), 'QAQ3 和 TATA 是型号');
});

test('speech text: the white space and doubled punctuation a removal leaves are tidied, nothing else', () => {
  assert.equal(speechText('好的，（笑）。明天见'), '好的。明天见');
  assert.equal(speechText('好的，（笑），明天见'), '好的，明天见');
  assert.equal(speechText('好的。（笑），明天见'), '好的。明天见');
  assert.equal(speechText('好的。（笑）。明天见'), '好的。明天见');
  assert.equal(speechText('（笑），明天见'), '明天见');
  assert.equal(speechText('  你好 （挥手） ！ 😊 '), '你好！');
  assert.equal(speechText('走吧 😊 （笑） 😊 出发'), '走吧 出发');
  // Punctuation the reply already doubled away from a removal is the speaker's own.
  assert.equal(speechText('好，，走。。（笑）'), '好，，走。。');
});

test('speech text: nothing left to say gives an empty string', () => {
  for (const text of ['（点头）', '(≧▽≦)', '😊😊', ' （笑） ^_^ ', '（笑）。', '']) assert.equal(speechText(text), '', JSON.stringify(text));
});
