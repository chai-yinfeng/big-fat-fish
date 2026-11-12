import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReply, SPLIT_MAX_CHARS, SPLIT_MAX_PARTS, SPLIT_GAP_MS } from '../split.js';

const squeezed = text => text.replace(/\s+/g, '');
/** Every split keeps all the text, in order; only white space at the cuts is dropped. */
function split(text) {
  const parts = splitReply(text);
  assert.equal(squeezed(parts.join('')), squeezed(text));
  for (const part of parts) { assert.ok(part.length > 0); if (parts.length > 1) assert.equal(part, part.trim()); }
  return parts;
}

test('the constants: 60 characters a message, at most 4 messages, about 1.2 seconds apart', () => {
  assert.deepEqual([SPLIT_MAX_CHARS, SPLIT_MAX_PARTS, SPLIT_GAP_MS], [60, 4, 1200]);
});

test('a short reply without a blank line is returned as it is, byte for byte', () => {
  for (const text of ['我在。', ' 前后有空白 \n', '第一行\n第二行', '好。'.repeat(30), 'x'.repeat(60), '[CQ:file,file=/secret] just text']) assert.deepEqual(splitReply(text), [text]);
});

test('paragraphs the model wrote (blank lines) become messages, even when the reply is short', () => {
  assert.deepEqual(split('好呀\n\n明天见'), ['好呀', '明天见']);
  assert.deepEqual(split('第一段。\n \n第二段，还有一句。\n\n\n第三段'), ['第一段。', '第二段，还有一句。', '第三段']);
  // A single line break is not a paragraph: short lines stay in one message.
  assert.deepEqual(splitReply('第一行\n第二行\n\n第三行'), ['第一行\n第二行', '第三行']);
});

test('a long paragraph is cut at the last line break that fits, else sentence end, else comma, else space', () => {
  const a = '甲'.repeat(20), b = '乙'.repeat(30), c = '丙'.repeat(25);
  // Line break before sentence end before comma, wherever each one is.
  assert.deepEqual(split(`${a}\n${b}。丙丙，${c}`), [a, `${b}。丙丙，${c}`]);
  assert.deepEqual(split(`${a}。${b}，丙丙丙${c}`), [`${a}。`, `${b}，丙丙丙${c}`]);
  assert.deepEqual(split(`${a}，${b}、丙丙丙${c}`), [`${a}，${b}、`, `丙丙丙${c}`]);
  // The last sentence end that still fits is used, and a run of marks stays together.
  assert.deepEqual(split(`${a}！${a}？！${b}`), [`${a}！${a}？！`, b]);
  assert.deepEqual(split(`${a}……${b}～${c}`), [`${a}……${b}～`, c]);
  // A closing quote stays with the sentence it ends (the quote is too long to be kept whole).
  assert.deepEqual(split(`她说：“${'甲'.repeat(30)}，${'乙'.repeat(40)}。”${b}`), [`她说：“${'甲'.repeat(30)}，`, `${'乙'.repeat(40)}。”`, b]);
  // English: sentence ends and commas, then spaces; never inside a word, and not at a decimal point.
  assert.deepEqual(split('The quick brown fox jumps over the lazy dog and keeps running through the forest. Version 3.14 is out.'), ['The quick brown fox jumps over the lazy dog and keeps', 'running through the forest. Version 3.14 is out.']);
  assert.deepEqual(split(`Hello there, how are you? ${'word '.repeat(13)}end`), ['Hello there, how are you?', 'word '.repeat(12).trim(), 'word end']);
  // Not at a decimal point, the "1." of a list or the colon of a clock time.
  assert.deepEqual(split(`${a}共3.5斤，1. ${a}，11:20${c}${c}`), [`${a}共3.5斤，1. ${a}，`, `11:20${c}${c}`]);
});

test('no cut inside brackets, quotes or book-title marks that fit in a message, a URL or code', () => {
  const tail = '然后外面继续说很多很多的话，直到超过六十个字符为止，这样才会触发拆分。';
  for (const [open, close] of ['（）', '()', '【】', '《》', '「」', '“”', '""']) {
    const inside = `${open}里面有逗号，还有句号。也有问号？对吧${close}`;
    const parts = split(`你看这个${inside}${tail}${tail}`);
    assert.ok(parts.length > 1); assert.ok(parts.some(part => part.includes(inside)), open);
    for (const part of parts) assert.ok(part.length <= 60);
  }
  // A bracket that does not fit before the limit moves whole into the next message.
  assert.deepEqual(split(`${'甲'.repeat(50)}（${'乙'.repeat(20)}）${'丙'.repeat(20)}`), ['甲'.repeat(50), `（${'乙'.repeat(20)}）${'丙'.repeat(20)}`]);
  // An unclosed bracket protects nothing.
  assert.deepEqual(split(`开头（没有关上，${'甲'.repeat(40)}。${'乙'.repeat(40)}`), [`开头（没有关上，${'甲'.repeat(40)}。`, '乙'.repeat(40)]);
  const url = 'https://example.com/a/very/long/path?with=query&and=more,stuff.html#fragment-0123456789-abcdefghij';
  assert.ok(url.length > 60);
  assert.deepEqual(split(`链接在这里 ${url} 你点开看看，里面写得很清楚。`), ['链接在这里', url, '你点开看看，里面写得很清楚。']);
  assert.deepEqual(split(`${'甲'.repeat(40)}看https://example.com/a.b?c=1,2。${'乙'.repeat(30)}`), [`${'甲'.repeat(40)}看`, `https://example.com/a.b?c=1,2。${'乙'.repeat(30)}`]);
  const code = '```js\nconst a = 1;\n\nconst b = [a, 2];\nconsole.log(a, b); // done.\n```';
  assert.ok(code.length > 60);
  assert.deepEqual(split(`代码如下：\n${code}\n就这样。`), ['代码如下：', code, '就这样。']);
  assert.deepEqual(splitReply(code), [code]);
  assert.deepEqual(split(`${'甲'.repeat(45)}用 \`a, b. c\` 就行，${'乙'.repeat(30)}`), [`${'甲'.repeat(45)}用 \`a, b. c\` 就行，`, '乙'.repeat(30)]);
});

test('a stretch with no natural place is cut at the limit, without breaking a surrogate pair', () => {
  assert.deepEqual(split('一二三四五六七八九十'.repeat(13)), ['一二三四五六七八九十'.repeat(6), '一二三四五六七八九十'.repeat(6), '一二三四五六七八九十']);
  assert.deepEqual(split('甲'.repeat(59) + '😀' + '乙'.repeat(30)), ['甲'.repeat(59), '😀' + '乙'.repeat(30)]);
});

test('more than 4 messages: the rest stays in the last one, nothing is lost', () => {
  assert.deepEqual(split('一\n\n二\n\n三\n\n四\n\n五\n\n六'), ['一', '二', '三', '四\n\n五\n\n六']);
  const sentence = n => `这是第${n}句话，它的长度刚好让两句放不进同一条消息里面去，所以一句一条。`;
  assert.deepEqual(split([1, 2, 3, 4, 5, 6].map(sentence).join('')), [sentence(1), sentence(2), sentence(3), sentence(4) + sentence(5) + sentence(6)]);
});

test('a reply of about 150 characters in several sentences becomes 2 to 4 messages of at most 60', () => {
  const text = '今天下班路上看到一只橘猫趴在便利店门口晒太阳，圆滚滚的特别像你上次发给我的那张照片。我蹲下来看了它好一会儿，它居然一点都不怕人，还伸了个懒腰！后来店员出来说它叫大橘，是这条街的常客，每天下午都会准时来报到。你那边今天过得怎么样呀？有没有好好吃饭？';
  const parts = split(text);
  assert.equal(parts.length, 3); assert.equal(parts.join(''), text);
  for (const part of parts) { assert.ok(part.length <= 60); assert.match(part, /[。！？]$/); }
});
