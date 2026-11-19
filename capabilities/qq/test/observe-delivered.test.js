import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Authority, DEFAULT_ENTITY_ID } from '../../../authority/src/engine.js';
import { consolidationMessages } from '../../memory/consolidation.js';
import { QQBridge, observedText } from '../bridge.js';
import { PACING } from '../pacing.js';
import { qqRequestId } from '../worker-route.js';
import { observationFromOneBot } from '../source.js';

const QUICK = { pacing: { ...PACING, burstQuietMs: 0, burstMaxWaitMs: 0 }, random: () => 0.5 };
const UNKNOWN = '[送达情况：这条回复的发送状态未知，不确定对方有没有收到]', UNSENT = '[送达情况：这条回复没有发出]';
const sentence = n => `这是第${n}句话，它的长度刚好让两句放不进同一条消息里面去，所以一句一条。`;

test('an observation of hers says what became of the part, in the words of her replayed history; text that went out whole is unchanged', () => {
  const text = (status, extra = {}) => ({ kind: 'text', status, chars: 4, ...extra });
  assert.equal(observedText('好的呀', text('sent')), '好的呀');
  assert.equal(observedText('好的呀', text('unknown')), '好的呀\n' + UNKNOWN);
  assert.equal(observedText('好的呀', text('unsent')), '好的呀\n' + UNSENT);
  assert.equal(observedText('好的呀', text('sent', { fallback: 'voice' })), '好的呀\n[送达情况：语音没有合成出来，改用文字发出了]');
  assert.equal(observedText('晚安', { kind: 'voice', status: 'sent' }), '晚安\n[送达情况：这条是用语音发出的]');
  assert.equal(observedText('晚安', { kind: 'voice', status: 'unknown' }), '晚安\n[送达情况：这条用语音发，发送状态未知，不确定对方有没有收到]');
  // A sticker takes the place of her marker; a description written by a model is marked as such.
  assert.equal(observedText('', { kind: 'sticker', status: 'sent', marker: '[表情:猫]', description: '一只打哈欠的猫', machine: true }), '[表情包：一只打哈欠的猫（机器描述）]');
  assert.equal(observedText('', { kind: 'sticker', status: 'unsent', marker: '[表情:猫]', reason: 'none' }), '[表情包：没有挑出能发的，没发出]');
  assert.equal(observedText('', { kind: 'sticker', status: 'unknown', marker: '[表情:猫]' }), '[表情包：发送状态未知，不确定对方有没有收到]');
  // No marker to replace (a picture she attached): one delivery line.
  assert.equal(observedText('', { kind: 'image', status: 'sent' }), '[送达情况：图片：已发出，没有描述]');
});

/** The bridge observing into a real Authority; the platform gives no receipt for send number `failAt`. */
async function fixture(t, { failAt = 0, reply = [1, 2, 3].map(sentence).join('') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-observe-delivered-'));
  const core = new Authority({ file: ':memory:', clock: () => Date.now() + 3600000 });
  t.after(() => { core.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'qq-observe-delivered-')); fs.rmSync(dir, { recursive: true }); });
  const streamId = 'qq:100:private:200';
  core.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  core.bindActor({ capabilityId: 'qq', externalActorId: 'qq:100:user:200', personId: 'person:owner' });
  core.bindStream({ capabilityId: 'qq', streamId, personId: 'person:owner', audience: 'private' });
  const world = { paused: true, revision: 1 }, texts = [];
  const authority = { health: async () => ({ world }), context: async () => ({ entityId: DEFAULT_ENTITY_ID, memoryEpoch: 0, world }) };
  const onebot = { call: async (action, args) => {
    if (action === 'get_login_info') return { user_id: 100 }; if (action === 'get_friend_list') return [];
    texts.push(args.message[0].data.text);
    if (texts.length === failAt) throw new Error('ONEBOT_DELIVERY_UNKNOWN');
    return { message_id: 500 + texts.length };
  } };
  const executor = { execute: async () => reply };
  const bridge = new QQBridge({ ...QUICK, sleep: async () => {}, authority, port: { observe: async input => core.observe('qq', input) }, onebot, executor, settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json') });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  const event = { post_type: 'message', message_type: 'private', self_id: 100, user_id: 200, sender: { user_id: 200 }, message_id: 7, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '我下周搬去MOCK-杭州' } }] };
  const hers = () => core.snapshot().observations.filter(row => row.actorId === 'qq:model').map(row => [row.eventId, row.text]);
  return { core, bridge, world, event, texts, streamId, executor, hers };
}

test('the night consolidation reads her reply as it went out: delivered text unchanged, the rest with what became of it', async t => {
  const f = await fixture(t, { failAt: 2 });
  await f.bridge.receive(f.event);
  assert.deepEqual(f.texts, [sentence(1), sentence(2)]);
  const requestId = qqRequestId(observationFromOneBot(f.event, { expectedSelfId: '100' }));
  assert.deepEqual(f.hers().map(([eventId]) => eventId), ['qq:sent:501', 'qq:undelivered:' + requestId]);
  // The dialogue leaves the replay window; the next batch is what the model is asked to read.
  f.core.context('qq', { streamId: f.streamId, query: 'MOCK', windowFromAt: Date.now() + 60000 });
  const { task } = f.core.consolidationNext(DEFAULT_ENTITY_ID);
  assert.deepEqual(task.observations.map(row => [row.role, row.text]), [
    ['user', '我下周搬去MOCK-杭州'],
    ['assistant', sentence(1)],
    ['assistant', [sentence(2), UNKNOWN, sentence(3), UNSENT].join('\n')],
  ]);
  const messages = JSON.parse(consolidationMessages(task)[1].content).messages;
  assert.deepEqual(messages.map(([, speaker, , text]) => [speaker, text]).slice(1), [['我', sentence(1)], ['我', [sentence(2), UNKNOWN, sentence(3), UNSENT].join('\n')]]);
  // Her lines are hers ("我"): a fact must still cite the person's own message (policies.js real_user_required).
  assert.equal(messages[0][1], '对方');
});

test('a reply sent whole is observed exactly as sent, once; a reply cut off by a pause is not written back', async t => {
  const f = await fixture(t, { reply: '好呀，路上小心。' });
  await f.bridge.receive(f.event);
  assert.deepEqual(f.hers(), [['qq:sent:501', '好呀，路上小心。']]);
  // The world is paused after the reply is written and before anything is sent: nothing went out, and nothing of hers
  // is observed (a paused world or a new memory epoch is not written to).
  const g = await fixture(t);
  g.executor.execute = async () => { g.world.paused = true; g.world.revision++; return [1, 2].map(sentence).join(''); };
  await g.bridge.receive(g.event);
  assert.deepEqual(g.texts, []);
  assert.deepEqual(g.hers(), []);
});
