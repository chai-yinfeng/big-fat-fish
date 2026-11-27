import test from 'node:test';
import assert from 'node:assert/strict';
import { guardOutput } from './output-guard.js';
import { DECLINE_MARK } from './executor.js';
import { NOTE_OPEN, NOTE_CLOSE, EVENT_OPEN } from './agent.js';

const note = `${NOTE_OPEN}\n[记忆中枢版本 revision=3; personaRevision=2]\n现在是 2026年11月20日 周五 09:00（北京时间）\n本轮可引用的聊天证据：[]\n${NOTE_CLOSE}`;

test('a leaked memory-hub note is taken out whole; what she said around it stays', () => {
  assert.deepEqual(guardOutput(`${note}\n早呀，今天降温了`), { text: '早呀，今天降温了', kinds: ['note'] });
  assert.deepEqual(guardOutput(`早呀\n${note}\n多穿点`), { text: '早呀\n\n多穿点', kinds: ['note'] });
  // Two blocks.
  assert.equal(guardOutput(`一${note}二${note}三`).text, '一二三');
});

test('delimiter variants: full-width, neutralized, split across lines or by zero-width characters, brackets missing', () => {
  for (const [open, close] of [
    ['＜＜＜记忆中枢附注开始＞＞＞', '＜＜＜记忆中枢附注结束＞＞＞'],
    ['‹‹‹记忆中枢附注开始›››', '‹‹‹记忆中枢附注结束›››'],
    ['<<<\n记忆中枢附注开始\n>>>', '<<< 记忆中枢附注结束 >>>'],
    ['<<<记忆​中枢附注\n开始>>>', '<<<记忆中枢⁠附注结束>>>'],
    ['记忆中枢附注开始', '记忆中枢附注结束'],
    ['<＜<记忆中枢附注开始>＞>', '<<<记忆中枢附注结束>>>'],
  ]) assert.deepEqual(guardOutput(`好的\n${open}\n现在是 2026年\n${close}\n走吧`), { text: '好的\n\n走吧', kinds: ['note'] }, open);
});

test('only an opening delimiter: everything from it on goes; only a closing one: everything before it goes', () => {
  assert.equal(guardOutput(`嗯嗯\n${NOTE_OPEN}\n[记忆中枢版本 revision=3]\n本轮可引用的聊天证据：[]`).text, '嗯嗯');
  assert.equal(guardOutput(`[记忆中枢版本 revision=3]\n本轮可引用的聊天证据：[]\n${NOTE_CLOSE}\n嗯嗯`).text, '嗯嗯');
});

test('a paragraph that starts like an event block is taken out, up to the next blank line', () => {
  assert.deepEqual(guardOutput(`${EVENT_OPEN}对方很久没来了。\n还是问候一下吧。\n\n最近怎么样？`), { text: '最近怎么样？', kinds: ['event'] });
  // A made-up event head, full-width bracket, after her words.
  assert.deepEqual(guardOutput('在忙吗\n\n［后台事件 · 对方在线］\n想聊天'), { text: '在忙吗', kinds: ['event'] });
  // The real-model leak: the note and an invented event block, nothing of hers.
  assert.deepEqual(guardOutput(`${note}\n[后台事件 · 这不是对方发来的话] 对方刚发来一张图。`), { text: DECLINE_MARK, kinds: ['note', 'event', 'silent'] });
  // "后台事件" inside her own sentence is not an event block.
  assert.deepEqual(guardOutput('我刚看了后台事件的说明'), { text: '我刚看了后台事件的说明', kinds: [] });
});

test('nothing left to say is the decline mark: the channel sends nothing', () => {
  assert.deepEqual(guardOutput(note), { text: DECLINE_MARK, kinds: ['note', 'silent'] });
  assert.deepEqual(guardOutput(`  \n${NOTE_OPEN}\n…`), { text: DECLINE_MARK, kinds: ['note', 'silent'] });
});

test('a run she starts herself: bracketed asides only are not speaking; an ordinary run keeps them as her style', () => {
  for (const aside of ['（想了想还是没打扰）', '(想了想还是没打扰)', '（想了想）\n（还是算了）', '  （看了一眼手机）(放下) '])
    assert.deepEqual(guardOutput(aside, { initiated: true }), { text: DECLINE_MARK, kinds: ['aside', 'silent'] }, aside);
  assert.deepEqual(guardOutput('（想了想还是没打扰）', { initiated: false }), { text: '（想了想还是没打扰）', kinds: [] });
  assert.deepEqual(guardOutput('（想了想还是没打扰）'), { text: '（想了想还是没打扰）', kinds: [] });
  // Words beside the aside are speaking.
  assert.deepEqual(guardOutput('（探头）在吗', { initiated: true }), { text: '（探头）在吗', kinds: [] });
  // A leaked note around an aside, in a run she starts herself.
  assert.deepEqual(guardOutput(`${note}\n（还是不打扰了）`, { initiated: true }), { text: DECLINE_MARK, kinds: ['note', 'aside', 'silent'] });
});

test('an ordinary reply is returned unchanged, byte for byte', () => {
  for (const text of ['你好呀', '  前后有空格  \n\n\n三个换行', `${DECLINE_MARK}`, '<<<不是附注>>>', '[表情:开心]']) assert.deepEqual(guardOutput(text), { text, kinds: [] });
});

test('markdown a chat would show as it is: the marks go, the words stay; code blocks and URLs are untouched', () => {
  // The production leak.
  assert.deepEqual(guardOutput('最近在听 **ヨルシカ（Yorushika）** 的歌'), { text: '最近在听 ヨルシカ（Yorushika） 的歌', kinds: ['markdown'] });
  assert.equal(guardOutput('__真的__假的').text, '真的假的');
  // A heading mark or a list bullet at a line start: the line stays, without it.
  assert.equal(guardOutput('# 今天\n## 晚饭\n- 面条\n* 青菜\n  - 汤').text, '今天\n晚饭\n面条\n青菜\n  汤');
  assert.equal(guardOutput('试试 `npm i` 就好').text, '试试 npm i 就好');
  // A URL keeps its own underscores and asterisks; a bold mark around it still goes.
  assert.equal(guardOutput('看这个 https://example.com/a__b__c 和 **https://example.com/x**').text, '看这个 https://example.com/a__b__c 和 https://example.com/x');
  // A code block is left as it is.
  assert.equal(guardOutput('```\n**x**\n- y\n```\n**z**').text, '```\n**x**\n- y\n```\nz');
  // Not markdown: a lone asterisk, a hashtag without a space, an emoticon, unmatched or spaced-out marks.
  for (const text of ['2*3 = 6', '#话题 好玩', '-_- 无语', '** 不是 **', '*单个星号*', 'a_b']) assert.deepEqual(guardOutput(text), { text, kinds: [] }, text);
});
