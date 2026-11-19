import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge, DIARY_CODE_PHRASE, DIARY_CODE_NONE, DIARY_CODE_QUOTED, diaryCodeReply, isDiaryCodeReply } from '../bridge.js';
import { PACING } from '../pacing.js';

const QUICK = { pacing: { ...PACING, burstQuietMs: 0, burstMaxWaitMs: 0 }, random: () => 0.5 };
// Visibly fake: the bot is 100, the owner 200, a friend 301 (on the list) and another 302 (not on it).
const CODES = { 'qq:100:private:200': 'mockcd22', 'qq:100:private:301': 'mockcd33' };

async function fixture(t, { sendError = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diary-code-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { paused: true, revision: 1 }, observations = [], sends = [], asked = [], executed = [], admitted = [], lookups = [], stored = new Map();
  const authority = { health: async () => ({ world }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }),
    admitPerson: async input => { admitted.push(input.uid); return { admitted: true }; },
    diaryCode: async input => { asked.push(input); return CODES[input.streamId] ? { listed: true, code: CODES[input.streamId] } : { listed: false }; } };
  const onebot = { call: async (action, args) => { if (action === 'get_login_info') return { user_id: 100 }; if (action === 'get_friend_list') return [{ user_id: 301 }, { user_id: 302 }]; if (action === 'get_msg') { lookups.push(args.message_id); if (!stored.has(args.message_id)) throw new Error('ONEBOT_ACTION_FAILED'); return stored.get(args.message_id); } sends.push(args); if (sendError) throw new Error('NO_RECEIPT'); return { message_id: 900 + sends.length }; } };
  const bridge = new QQBridge({ ...QUICK, sleep: async () => {}, log: () => {}, authority, port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } }, onebot,
    settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json'), executor: { execute: async request => { executed.push(request); return 'MOCK-REPLY 好的'; } } });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  let id = 0;
  const message = (uid, text, extra = {}) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: uid, sender: { user_id: uid }, message_id: ++id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...extra });
  return { bridge, dir, world, observations, sends, asked, executed, message, lookups, stored };
}
const texts = sends => sends.map(send => [send.user_id, send.message.map(part => part.data.text).join('')]);

test('"日记口令" in a private chat is answered by the bridge itself: the passcode goes to that person only, no model runs, nothing is observed or kept', async t => {
  const f = await fixture(t);
  await f.bridge.receive(f.message(301, DIARY_CODE_PHRASE));
  assert.deepEqual(f.asked, [{ streamId: 'qq:100:private:301' }]);
  assert.deepEqual(texts(f.sends), [['301', diaryCodeReply('mockcd33')]]);
  assert.equal(f.sends[0].auto_escape, true);
  // The owner asks: their own passcode, to themselves.
  await f.bridge.receive(f.message(200, ` ${DIARY_CODE_PHRASE}\n`));
  assert.deepEqual(texts(f.sends).at(-1), ['200', diaryCodeReply('mockcd22')]);
  // Someone not on the list is told so; no passcode of anyone is in that answer.
  await f.bridge.receive(f.message(302, DIARY_CODE_PHRASE));
  assert.deepEqual(texts(f.sends).at(-1), ['302', DIARY_CODE_NONE]);
  assert.ok(!DIARY_CODE_NONE.includes('mockcd'));
  // No model run, no observation (so no context, no consolidation, no memory), and the passcode is not in the bridge's state.
  assert.deepEqual([f.executed.length, f.observations.length], [0, 0]);
  const state = fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8');
  assert.ok(!state.includes('mockcd') && !state.includes(DIARY_CODE_PHRASE));
  assert.deepEqual(Object.values(JSON.parse(state).records).map(item => item.status), ['sent', 'sent', 'sent']);
  // The same platform message again does nothing.
  const again = f.message(301, DIARY_CODE_PHRASE);
  await f.bridge.receive(again); await f.bridge.receive(again);
  assert.equal(f.sends.length, 4);
  // A later quote of the passcode message is not read back from the bridge's memory of what it sent.
  assert.ok(![...f.bridge.sentTexts.values()].some(text => text.includes('mockcd')));
});

test('only the exact phrase: anything more is an ordinary message for her; a paused world answers nothing', async t => {
  const f = await fixture(t);
  for (const text of ['我的日记口令是什么', '日记口令？', '日记 口令', '口令']) await f.bridge.receive(f.message(301, text));
  assert.deepEqual([f.asked.length, f.executed.length], [0, 4]);
  assert.ok(texts(f.sends).every(([, text]) => !text.includes('mockcd')));
  // With a picture or as a reply to another message it is an ordinary message too.
  await f.bridge.receive(f.message(301, DIARY_CODE_PHRASE, { message: [{ type: 'reply', data: { id: '5' } }, { type: 'text', data: { text: DIARY_CODE_PHRASE } }] }));
  assert.equal(f.asked.length, 0);
  // Group messages never reach it.
  await f.bridge.receive(f.message(301, DIARY_CODE_PHRASE, { message_type: 'group', group_id: 400, sub_type: 'normal' }));
  f.world.paused = true; f.world.revision++;
  const sent = f.sends.length;
  await f.bridge.receive(f.message(301, DIARY_CODE_PHRASE));
  assert.deepEqual([f.asked.length, f.sends.length], [0, sent]);
});

test('a passcode message without a platform receipt stays unknown and is not sent again', async t => {
  const f = await fixture(t, { sendError: true });
  const event = f.message(301, DIARY_CODE_PHRASE);
  await f.bridge.receive(event); await f.bridge.receive(event);
  assert.deepEqual([f.asked.length, f.sends.length, Object.values(f.bridge.state.records).map(item => item.status)], [1, 1, ['unknown']]);
  assert.deepEqual([f.executed.length, f.observations.length], [0, 0]);
});

test('quoting her passcode message never shows the passcode to the model: a placeholder from the bridge\'s memory, and after a restart from get_msg too', async t => {
  const quoting = (f, id, text) => f.message(301, text, { message: [{ type: 'reply', data: { id: String(id) } }, { type: 'text', data: { text } }] });
  const seen = f => JSON.stringify(f.executed);
  // The same process: the bridge remembers it sent a passcode there and asks the platform nothing.
  const f = await fixture(t);
  await f.bridge.receive(f.message(301, DIARY_CODE_PHRASE));
  assert.equal(f.sends.length, 1);
  await f.bridge.receive(quoting(f, 901, 'MOCK 这条是什么意思'));
  assert.deepEqual([f.executed.length, f.lookups.length], [1, 0]);
  assert.ok(seen(f).includes(`[引用 你之前说的：${DIARY_CODE_QUOTED}]`) && seen(f).includes('MOCK 这条是什么意思') && !seen(f).includes('mockcd'));
  assert.ok(!JSON.stringify(f.observations).includes('mockcd'));
  // After a restart nothing is remembered: the platform returns her message with the passcode in it, as segments or as a string.
  for (const stored of [[{ type: 'text', data: { text: diaryCodeReply('mockcd33') } }], [{ type: 'text', data: { text: '你的日记口令是：' } }, { type: 'text', data: { text: 'mockcd33\n在房间页面里……' } }], diaryCodeReply('mockcd33'), '\n ' + diaryCodeReply('mockcd33')]) {
    const again = await fixture(t);
    again.stored.set(555, { sender: { user_id: 100 }, message: stored });
    await again.bridge.receive(quoting(again, 555, 'MOCK 重启后再引用'));
    assert.deepEqual([again.executed.length, again.lookups], [1, [555]]);
    assert.ok(seen(again).includes(`[引用 你之前说的：${DIARY_CODE_QUOTED}]`) && !seen(again).includes('mockcd') && !seen(again).includes('房间页面'), JSON.stringify(stored).slice(0, 40));
    assert.ok(!JSON.stringify(again.observations).includes('mockcd'));
  }
  // Recognized on her own messages only, by the fixed opening: anything else of hers is quoted as it is, and the
  // person's own "日记口令" message holds no passcode.
  assert.deepEqual([isDiaryCodeReply('我的日记口令是：x'), isDiaryCodeReply([{ type: 'image', data: {} }]), isDiaryCodeReply(null), isDiaryCodeReply(DIARY_CODE_NONE)], [false, false, false, false]);
  const other = await fixture(t);
  other.stored.set(7, { sender: { user_id: 100 }, message: [{ type: 'text', data: { text: 'MOCK 她说过的别的话' } }] });
  other.stored.set(8, { sender: { user_id: 301 }, message: [{ type: 'text', data: { text: DIARY_CODE_PHRASE } }] });
  await other.bridge.receive(quoting(other, 7, 'MOCK 引用别的'));
  await other.bridge.receive(quoting(other, 8, 'MOCK 引用自己那句'));
  assert.ok(seen(other).includes('[引用 你之前说的：MOCK 她说过的别的话]') && seen(other).includes(`[引用 对方之前说的：${DIARY_CODE_PHRASE}]`));
});
