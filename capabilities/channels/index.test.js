import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHANNELS, CHANNEL_PROMPT_CHARS, channel, channelPrompt } from './index.js';

test('the registry lists every declared channel once, as frozen dependency-free data of one closed shape', () => {
  assert.deepEqual(CHANNELS.map(item => item.id), ['qq', 'mock']);
  const directories = fs.readdirSync(fileURLToPath(new URL('./', import.meta.url)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(directories, CHANNELS.map(item => item.id).sort());
  for (const id of directories) assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL(`./${id}/manifest.js`, import.meta.url)), 'utf8'), /^\s*import\s|require\(/m, `${id}: a declaration imports nothing`);
  assert.ok(Object.isFrozen(CHANNELS) && CHANNELS.every(item => Object.isFrozen(item) && Object.isFrozen(item.expression) && Object.isFrozen(item.turnPolicy) && Object.isFrozen(item.faceNames)));
  for (const item of CHANNELS) {
    assert.deepEqual(Object.keys(item).sort(), ['account', 'expression', 'faceNames', 'friends', 'id', 'prompt', 'receipts', 'testOnly', 'title', 'turnPolicy'], item.id);
    assert.match(item.id, /^[a-z][a-z0-9-]{1,31}$/); assert.ok(item.title.length > 0 && item.title.length <= 12);
    assert.deepEqual(Object.keys(item.expression).sort(), ['faces', 'images', 'split', 'voice']);
    assert.ok(Object.values(item.expression).every(value => typeof value === 'boolean') && typeof item.friends === 'boolean' && typeof item.testOnly === 'boolean', item.id);
    assert.ok(['reliable', 'unreliable'].includes(item.receipts), item.id);
    // A channel with friends says what an account name looks like there; one without names none.
    if (item.friends) assert.doesNotThrow(() => new RegExp(item.account, 'u'), item.id); else assert.equal(item.account, null, item.id);
    // The channel's part of the system message: fixed, bounded, one paragraph, and never a memory-hub delimiter.
    assert.ok(typeof item.prompt === 'string' && item.prompt.length <= CHANNEL_PROMPT_CHARS && !/\n|<<<|>>>|记忆中枢/.test(item.prompt), item.id);
    assert.ok(Object.values(item.turnPolicy).every(line => typeof line === 'string' && line.length <= 300 && !line.includes('\n')), item.id);
    // What a channel cannot express, its prompt does not offer.
    if (!item.expression.faces) assert.deepEqual([item.faceNames.length, /\[微笑\]/.test(item.prompt)], [0, false], item.id);
    if (!item.expression.voice) assert.equal(item.turnPolicy.voice, undefined, item.id);
  }
});

test('lookups: a declared channel by id, null and an empty prompt for anything else; only the mock channel is test-only', () => {
  assert.equal(channel('qq').title, 'QQ');
  assert.deepEqual([channel('wechat'), channel(undefined), channelPrompt('wechat'), channelPrompt(undefined), channelPrompt(null)], [null, null, '', '', '']);
  assert.equal(channelPrompt('qq'), channel('qq').prompt);
  assert.deepEqual(CHANNELS.filter(item => item.testOnly).map(item => item.id), ['mock']);
  assert.deepEqual([channel('qq').receipts, channel('mock').receipts], ['reliable', 'unreliable']);
  assert.ok(new RegExp(channel('qq').account, 'u').test('999900000011') && !new RegExp(channel('qq').account, 'u').test('0123'));
});
