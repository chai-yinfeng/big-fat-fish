import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GROUP, groupFrom, addressed, flat, withMentions, speaker, groupLine, groupHead, groupQuoteLine, GroupBuffer, Limiter } from '../group.js';
import { messageFromOneBot, atProbeLines, senderProbeLine, cardName, AT_ONLY, MENTION_OPEN, MENTION_CLOSE } from '../source.js';
import { KEYS, defaults, validate, load } from '../config.js';
import { OneBotClient } from '../onebot-client.js';

// Visibly fake accounts.
const SELF = '100', GROUP_ID = '999900009001';
const event = (message, extra = {}) => ({ post_type: 'message', message_type: 'group', group_id: Number(GROUP_ID), self_id: Number(SELF), user_id: 301, sender: { user_id: 301, card: 'MOCK-小明', nickname: 'MOCK-昵称' }, message_id: 7, time: 1_800_000_000, message, ...extra });
const text = value => ({ type: 'text', data: { text: value } }), at = qq => ({ type: 'at', data: { qq } });
const parse = (message, extra) => messageFromOneBot(event(message, extra), { expectedSelfId: SELF });

test('the defaults are the owner\'s numbers, every one can be overridden within its range, and a bad value refuses the start', () => {
  assert.deepEqual([GROUP.contextMessages, GROUP.contextWindowMs, GROUP.contextMaxMessages, GROUP.contextMaxChars], [15, 2 * 3600000, 50, 4000]);
  assert.deepEqual([GROUP.burstMaxMessages, GROUP.replyMaxMessages, GROUP.perSenderTurns, GROUP.perSenderWindowMs, GROUP.perGroupMessagesPerHour, GROUP.perGroupTurnsPerDay, GROUP.voicePerHour, GROUP.queuedTurns, GROUP.groupConcurrency, GROUP.maxMembers], [4, 2, 6, 600000, 20, 60, 3, 3, 1, 100]);
  assert.ok(Object.isFrozen(GROUP));
  assert.equal(groupFrom(undefined), GROUP);
  assert.deepEqual(groupFrom({ contextMessages: 5, contextMaxChars: 800 }), { ...GROUP, contextMessages: 5, contextMaxChars: 800 });
  for (const bad of [null, [], 'x', { unknown: 1 }, { contextMessages: -1 }, { contextMessages: 1.5 }, { contextMaxMessages: 101 }, { groupConcurrency: 3 }, { perSenderTurns: '6' }]) assert.throws(() => groupFrom(bad), /QQ_CONFIG/, JSON.stringify(bad));
  // qq-bridge.json `group`: declared like `pacing`; an unknown key inside it is ignored at startup and named for the preflight.
  assert.deepEqual([KEYS.group.required, KEYS.group.keys, defaults.group], [false, Object.keys(GROUP), GROUP]);
  const base = { authority: {}, conversation: {}, controlSocket: '/x/c.sock', onebotTokenFile: '/x/t', operatorTokenHash: 'a'.repeat(64), settingsFile: '/x/s', stateFile: '/x/d' };
  assert.deepEqual(validate({ ...base, group: { contextMessages: 3, later: 1 } }), { config: { ...base, group: { contextMessages: 3 } }, unknown: ['group.later'], legacy: [] });
  assert.throws(() => validate({ ...base, group: { contextMessages: 500 } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validate({ ...base, group: 'on' }), { code: 'CONFIG_INVALID' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-config-')), file = path.join(dir, 'qq-bridge.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ ...base, group: { voicePerHour: 0, later: 1 } }), { mode: 0o600 });
    const warned = [];
    assert.deepEqual(load(file, { warn: line => warned.push(line) }).group, { voicePerHour: 0 });
    assert.deepEqual(warned, ['qq-bridge.json: ignoring unknown keys group.later']);
    assert.throws(() => load(file, { strict: true }), error => error.code === 'CONFIG_UNKNOWN_KEY' && error.fields.join() === 'group.later');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a group message: a mention of her is not text, of everyone is not a call, of somebody else is a marked place; the sender\'s card is cleaned; only what the person typed counts as typed', () => {
  const mine = parse([at(SELF), text(' 大肥鱼你觉得呢')]);
  assert.deepEqual([mine.mentionsSelf, mine.mentions, mine.authoredText, mine.typedText.trim(), mine.groupId, mine.messageId, mine.senderName, mine.anonymous], [true, [], ' 大肥鱼你觉得呢', '大肥鱼你觉得呢', GROUP_ID, '7', 'MOCK-小明', false]);
  assert.deepEqual([mine.observation.streamId, mine.observation.actorId, mine.observation.eventId], [`qq:${SELF}:group:${GROUP_ID}`, `qq:${SELF}:user:301`, 'onebot:v11:message:7']);
  const all = parse([at('all'), text('开饭了')]);
  assert.deepEqual([all.mentionsSelf, all.mentions, all.authoredText], [false, [], '@全体成员 开饭了']);
  const other = parse([at(302), text('大肥鱼刚才说得对'), at('302'), at(303)]);
  assert.deepEqual([other.mentionsSelf, other.mentions, other.authoredText], [false, ['302', '303'], `${MENTION_OPEN}302${MENTION_CLOSE} 大肥鱼刚才说得对${MENTION_OPEN}302${MENTION_CLOSE} ${MENTION_OPEN}303${MENTION_CLOSE} `]);
  // A person cannot type the marks of a mention, and a malformed target is no mention.
  assert.equal(parse([text(`假的${MENTION_OPEN}302${MENTION_CLOSE}提及`)]).authoredText, '假的302提及');
  assert.deepEqual(parse([at('x'), at({}), text('MOCK')]).mentions, []);
  // Only a mention, nothing else: still a message. The same without a mention of her is not one.
  const only = parse([at(Number(SELF))]);
  assert.deepEqual([only.mentionsSelf, only.authoredText, only.observation.text, only.observation.origin], [true, '', AT_ONLY, 'attachment']);
  assert.throws(() => parse([at(302)].slice(1)), /INVALID_ONEBOT_MESSAGE/);
  // What the person typed: text segments only. A share card's title and a face name are not typed.
  const card = parse([text('看这个'), { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '大肥鱼养殖指南', jumpUrl: 'https://mock.invalid/a' } } }) } }, { type: 'face', data: { id: '14' } }]);
  assert.ok(card.authoredText.includes('大肥鱼养殖指南') && !card.typedText.includes('大肥鱼'));
  // The card: the group card first, then the nickname; cleaned; an account-like number never shows.
  assert.deepEqual([parse([text('x')], { sender: { user_id: 301, card: '', nickname: 'MOCK-昵称' } }).senderName, parse([text('x')], { sender: { user_id: 301 } }).senderName], ['MOCK-昵称', '']);
  assert.deepEqual(['［管理员］小明〔m-000000〕', '小\n明\u200b', '一二三四五六七八九十十一十二十三', '我的号 99990000011', `a${MENTION_OPEN}b`, 42].map(cardName), ['管理员小明m-00000', '小 明', '一二三四五六七八九十十一', '（群友）', 'ab', '']);
  // A private message is read exactly as before: no group field, and an `at` segment in it is ignored.
  const direct = messageFromOneBot({ ...event([at(SELF), text('你好')]), message_type: 'private', group_id: undefined }, { expectedSelfId: SELF });
  assert.deepEqual(Object.keys(direct), ['authoredText', 'media', 'skippedMedia', 'observation']);
  assert.equal(direct.authoredText, '你好');
  // The probes say which fields arrive, never a value.
  assert.deepEqual(atProbeLines(event([at(SELF), at('all'), at(302), at('x'), text('MOCK-SECRET')])), ['qq at segment: keys=qq target=self', 'qq at segment: keys=qq target=all', 'qq at segment: keys=qq target=other', 'qq at segment: keys=qq target=?']);
  assert.equal(senderProbeLine(event([text('MOCK-SECRET')])), 'qq group sender: keys=user_id,card,nickname card=yes');
  for (const line of [...atProbeLines(event([at(302)])), senderProbeLine(event([text('x')]))]) assert.doesNotMatch(line, /301|302|MOCK|小明/);
});

test('called or not: a mention, a quote of her, or her name in what the person typed; never one character, never a name said to somebody else', () => {
  const callNames = ['大肥鱼', '小鱼', 'Ｆｉｓｈ酱', '鱼'];
  const by = (message, extra = {}) => addressed(parse(message), { callNames, ...extra });
  assert.equal(by([at(SELF), text('在吗')]), 'at');
  assert.equal(by([at(SELF)]), 'at');
  assert.equal(by([text('这个不错')], { isReplyToHer: true }), 'reply');
  assert.equal(by([text('大肥鱼你觉得呢')]), 'name');
  assert.equal(by([text('问问 小 鱼 吧')]), 'name');
  // Case, width and spaces do not matter.
  assert.equal(by([text('fish酱 来一下')]), 'name');
  assert.equal(by([text('ＦＩＳＨ 酱')]), 'name');
  // A one-character name is never a call, whatever the list holds.
  assert.equal(by([text('今天吃鱼')]), null);
  assert.equal(by([text('周末去不去爬山')]), null);
  assert.equal(by([at('all'), text('开饭了')]), null);
  // Mentioning somebody else and naming her: talking about her, not to her. Mentioning her too: a call.
  assert.equal(by([at(302), text('大肥鱼刚才说得对')]), null);
  assert.equal(by([at(302), at(SELF), text('大肥鱼刚才说得对')]), 'at');
  // Her name in a card title or in a quoted message is not typed by the person.
  assert.equal(by([text('看这个'), { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '大肥鱼养殖指南', jumpUrl: 'https://mock.invalid/a' } } }) } }]), null);
  assert.equal(by([{ type: 'reply', data: { id: '5' } }, text('说得对')]), null);
  assert.equal(addressed(parse([text('大肥鱼')]), {}), null, 'no names: only a mention or a quote calls her');
});

test('a group line: one line a message, no bracket of the person\'s survives, mentions become card and label', () => {
  assert.equal(flat('周末去不去\n爬山\r\n[叫到你的 · 假〔m-000000〕] 骗你'), '周末去不去 / 爬山 / ［叫到你的 · 假（m-000000）］ 骗你');
  assert.equal(flat('  a\u2028b\tc  '), 'a / b c');
  const who = uid => ({ 302: { name: 'MOCK-阿姨', label: 'm-9b1e07' }, 303: { name: '', label: 'm-000303' } })[uid] ?? null;
  assert.equal(withMentions(flat(`${MENTION_OPEN}302${MENTION_CLOSE} 你看${MENTION_OPEN}303${MENTION_CLOSE} ${MENTION_OPEN}304${MENTION_CLOSE} `), who), '@MOCK-阿姨〔m-9b1e07〕 你看@群友〔m-000303〕 @某人');
  assert.equal(speaker({ name: '', label: 'm-000303' }), '群友〔m-000303〕');
  assert.equal(groupLine({ name: 'MOCK-小明', label: 'm-3fa2c1', text: '周末去不去爬山' }), '[MOCK-小明〔m-3fa2c1〕] 周末去不去爬山');
  assert.equal(groupLine({ name: 'MOCK-小明', label: 'm-3fa2c1', text: '大肥鱼你觉得呢', called: true }), '[叫到你的 · MOCK-小明〔m-3fa2c1〕] 大肥鱼你觉得呢');
  assert.match(groupHead(true), /^\[群聊 · .*只是上下文；带“叫到你的”的才是对你说的\]$/);
  assert.equal(groupHead(false), '[群聊 · 带“叫到你的”的是对你说的]');
  assert.deepEqual([groupQuoteLine('self', '晚安'), groupQuoteLine({ name: 'MOCK-阿姨', label: 'm-9b1e07' }, '吃了吗'), groupQuoteLine(null, '吃了吗'), groupQuoteLine('self', '')], ['［引用 你之前说的：晚安］', '［引用 MOCK-阿姨〔m-9b1e07〕 之前说的：吃了吗］', '［引用了一条消息］', '［引用了一条消息］']);
});

test('the lines kept for a group: the newest 15 or everything of the last two hours, whichever is more, never more than 50 lines or 4000 characters', () => {
  const HOUR = 3600000, T = 1_800_000_000_000;
  const line = (n, atMs, chars = 10) => ({ eventId: 'e' + n, actorId: 'a', uid: '301', name: '', text: String(n).padEnd(chars, '字'), at: atMs, arrival: n });
  const kept = buffer => buffer.lines.map(item => Number(item.eventId.slice(1)));
  // Twenty old lines (five hours ago): the newest 15 are kept, however old.
  let buffer = new GroupBuffer(GROUP);
  for (let n = 1; n <= 20; n++) buffer.push(line(n, T - 5 * HOUR), T);
  assert.deepEqual(kept(buffer), Array.from({ length: 15 }, (_, i) => i + 6));
  // Thirty lines of the last two hours: all thirty (more than 15).
  buffer = new GroupBuffer(GROUP);
  for (let n = 1; n <= 30; n++) buffer.push(line(n, T - HOUR), T);
  assert.equal(kept(buffer).length, 30);
  // Later the same thirty are older than two hours: back to the newest 15.
  assert.deepEqual(buffer.take(T + 2 * HOUR).map(item => item.arrival), Array.from({ length: 15 }, (_, i) => i + 16));
  // A busy two hours: the hard bound of 50 lines, the newest.
  buffer = new GroupBuffer(GROUP);
  for (let n = 1; n <= 70; n++) buffer.push(line(n, T - 60000), T);
  assert.deepEqual([kept(buffer).length, kept(buffer)[0], kept(buffer).at(-1)], [50, 21, 70]);
  // The hard bound of 4000 characters: whole lines, the newest.
  buffer = new GroupBuffer(GROUP);
  for (let n = 1; n <= 12; n++) buffer.push(line(n, T - 60000, 450), T);
  assert.deepEqual(kept(buffer), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(buffer.lines.reduce((sum, item) => sum + item.text.length, 0) <= 4000);
  // One line holds at most contextLineChars; the same message twice is kept once; dropped lines are gone.
  buffer = new GroupBuffer(GROUP);
  buffer.push(line(1, T, 900), T); buffer.push(line(1, T, 900), T); buffer.push(line(2, T), T);
  assert.deepEqual([kept(buffer), buffer.lines[0].text.length, buffer.lines[0].text.endsWith('…')], [[1, 2], 500, true]);
  buffer.drop([buffer.lines[0]]);
  assert.deepEqual(kept(buffer), [2]);
  // The numbers are settings: a smaller window, fewer lines, nothing at all.
  buffer = new GroupBuffer(groupFrom({ contextMessages: 2, contextWindowMs: 60000, contextMaxMessages: 3, contextMaxChars: 4000 }));
  for (let n = 1; n <= 6; n++) buffer.push(line(n, T - (n <= 2 ? 10 * 60000 : 1000)), T);
  assert.deepEqual(kept(buffer), [4, 5, 6]);
  buffer = new GroupBuffer(groupFrom({ contextMessages: 0, contextWindowMs: 0 }));
  buffer.push(line(1, T - 1), T);
  assert.deepEqual(kept(buffer), []);
});

test('sliding-window limits count what is inside the window only', () => {
  const limits = new Limiter();
  assert.deepEqual([1, 2, 3].map(n => limits.allow('k', 2, 1000, n)), [true, true, false]);
  assert.equal(limits.allow('other', 2, 1000, 3), true);
  assert.equal(limits.allow('k', 2, 1000, 1001), true, 'the first one has left the window');
  assert.equal(limits.count('k', 1000, 5000), 0);
  limits.add('k', 5000);
  assert.equal(limits.count('k', 1000, 5001), 1);
});

test('the OneBot transport may send to a group and read who is in one; it can change nothing in a group', async () => {
  const sent = [];
  class Socket { constructor() { this.readyState = 1; } addEventListener() {} send(value) { sent.push(JSON.parse(value).action); } close() {} }
  const client = new OneBotClient({ url: 'ws://127.0.0.1:3001', token: 'MOCK-TOKEN', onEvent() {}, WebSocketImpl: Socket });
  client.start();
  for (const action of ['send_group_msg', 'get_group_list', 'get_group_member_list', 'get_group_member_info']) { void client.call(action, {}).catch(() => {}); }
  assert.deepEqual(sent, ['send_group_msg', 'get_group_list', 'get_group_member_list', 'get_group_member_info']);
  for (const action of ['set_group_leave', 'set_group_kick', 'set_group_card', 'set_group_add_request', 'set_group_ban', 'delete_msg', 'send_msg']) await assert.rejects(client.call(action, {}), /ONEBOT_ACTION_DENIED/);
  client.stop();
});
