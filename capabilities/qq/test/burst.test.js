import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBridge } from '../bridge.js';
import { PACING } from '../pacing.js';
import { imageProbeLines } from '../source.js';

/** A bridge with a fake clock and timer: nothing waits for real time. `advance(ms)` moves the clock and fires the
 * burst timers that are due. */
async function fixture(t, { pacing = PACING, media } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-burst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { paused: true, revision: 1 }, observations = [], sends = [], requests = [], logs = [], timers = new Map();
  let now = Date.parse('2026-11-18T06:00:00Z'), timerId = 0, messageId = 0;
  const authority = { health: async () => ({ world }), context: async () => ({ entityId: 'entity:big-fat-fish', memoryEpoch: 0, world }) };
  const onebot = { call: async (action, args) => { if (action === 'get_login_info') return { user_id: 100 }; if (action === 'get_friend_list') return []; sends.push(args); return { message_id: 900 + ++messageId }; } };
  const executor = { execute: async request => { requests.push(request); return executor.reply ? executor.reply(request) : '好'; } };
  const bridge = new QQBridge({ authority, onebot, executor, media, pacing, random: () => 0.5, sleep: async () => {}, clock: () => now, log: line => logs.push(line),
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, due: now + ms, ms }); return timerId; }, clearTimer: id => { timers.delete(id); },
    port: { observe: async value => { observations.push(value); return { observationId: 'observation-' + observations.length }; } },
    settingsFile: path.join(dir, 'settings.json'), stateFile: path.join(dir, 'state.json') });
  await bridge.connection(true); await bridge.configure({ expectedSelfId: '100', allowedCallerUID: '200' });
  world.paused = false; world.revision++;
  let id = 0;
  const event = message => ({ post_type: 'message', message_type: 'private', self_id: 100, user_id: 200, sender: { user_id: 200 }, message_id: ++id, time: Math.floor(Date.now() / 1000), message: typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
  /** The person sends a message; resolves once the bridge has taken it into a burst, with `done`: the turn that answers it. */
  const say = async message => { const done = bridge.receive(event(message)); await settle(); return { done }; };
  const advance = async ms => {
    now += ms;
    for (const [key, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) if (timer.due <= now) { timers.delete(key); timer.fn(); }
    await settle();
  };
  const records = () => Object.values(bridge.state.records);
  return { bridge, observations, sends, requests, logs, timers, executor, say, advance, settle, records };
}

test('messages sent in quick succession are each observed but answered once, in order, one evidence ref each', async t => {
  const f = await fixture(t);
  const done = [];
  done.push((await f.say('在吗')).done); await f.advance(1000);
  done.push((await f.say('跟你说个事')).done); await f.advance(1000);
  done.push((await f.say('明天几点出发？')).done);
  assert.equal(f.requests.length, 0, 'still waiting for the person to finish');
  await f.advance(2499); assert.equal(f.requests.length, 0);
  await f.advance(1); await Promise.all(done);
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 1);
  const { input, requestId } = f.requests[0];
  assert.equal(input.text, '在吗\n跟你说个事\n明天几点出发？');
  assert.equal(input.queryText, '在吗\n跟你说个事\n明天几点出发？');
  assert.deepEqual(input.evidence.map(item => [item.ref, item.eventId]), [1, 2, 3].map(n => ['observation-' + n, 'onebot:v11:message:' + n]));
  // Every message keeps its own observation and record; the reply hangs on the last one.
  assert.deepEqual(f.observations.map(o => [o.role, o.text]), [['user', '在吗'], ['user', '跟你说个事'], ['user', '明天几点出发？'], ['assistant', '好']]);
  assert.equal(requestId, Object.keys(f.bridge.state.records)[2]);
  assert.deepEqual(f.records().map(r => r.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(f.records().map(r => r.receipts?.length ?? 0), [0, 0, 1]);
});

test('each message restarts the quiet wait, but a long burst is answered at most burstMaxWaitMs after its first message', async t => {
  const f = await fixture(t), done = [];
  for (let i = 0; i < 4; i++) { done.push((await f.say('第' + i + '句')).done); if (i < 3) await f.advance(2000); }
  // The fourth message came 6 s after the first: the wait is cut to the 2 s left of the 8 s.
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [2000]);
  await f.advance(1999); assert.equal(f.requests.length, 0);
  await f.advance(1); await Promise.all(done);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].input.evidence.length, 4);
});

test('a message arriving while a reply is being written is not added to it: it and any later ones get one next reply', async t => {
  const f = await fixture(t);
  let release; f.executor.reply = request => f.requests.length === 1 ? new Promise(resolve => { release = () => resolve('第一次'); }) : '第二次';
  const { done: first } = await f.say('你好'); await f.advance(2500);
  assert.equal(f.requests.length, 1);
  // Two more while the first turn runs; the burst wait still applies to them.
  const { done: second } = await f.say('还有'); await f.advance(1000); const { done: third } = await f.say('再问一句');
  await f.advance(2500);
  assert.equal(f.requests.length, 1, 'queued behind the running turn');
  // One more after their burst was queued but before it started: it joins the queued turn.
  const { done: fourth } = await f.say('最后一句');
  release(); await Promise.all([first, second, third, fourth]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].input.text, '你好');
  assert.equal(f.requests[1].input.text, '还有\n再问一句\n最后一句');
  assert.deepEqual(f.sends.map(send => send.message[0].data.text), ['第一次', '第二次']);
  assert.deepEqual(f.records().map(r => r.status), ['sent', 'sent', 'sent', 'sent']);
});

test('a burst holds at most burstMaxMessages messages; the next message begins a new burst', async t => {
  const f = await fixture(t, { pacing: { ...PACING, burstMaxMessages: 3 } }), done = [];
  for (let i = 1; i <= 4; i++) done.push((await f.say('第' + i + '句')).done);
  await f.advance(2500); await Promise.all(done);
  assert.deepEqual(f.requests.map(request => request.input.evidence.length), [3, 1]);
  assert.deepEqual(f.requests.map(request => request.input.text), ['第1句\n第2句\n第3句', '第4句']);
});

test('a forgotten message leaves the burst; the rest are still answered', async t => {
  const f = await fixture(t), observe = f.bridge.port.observe;
  f.bridge.port.observe = async value => value.text === '忘掉我' ? { forgotten: true } : observe(value);
  const done = [(await f.say('忘掉我')).done, (await f.say('这句要回')).done];
  await f.advance(2500); await Promise.all(done);
  assert.equal(f.requests[0].input.text, '这句要回');
  assert.deepEqual(f.records().map(r => r.status), ['forgotten', 'sent']);
});

test('attachments in a burst keep their order; the sticker frequency line is added once, at the end', async t => {
  const prepared = [];
  const media = {
    prepare: async message => {
      prepared.push(message.observation.eventId);
      const refs = message.media.map((part, index) => ({ id: `media:${message.observation.eventId.split(':').at(-1)}-${index}`, kind: part.kind }));
      return { executionText: message.authoredText || message.observation.text, queryText: (message.authoredText || 'picture').slice(0, 512), mediaRefs: refs, voiceRequested: false };
    },
    plan: async ({ text }) => [{ type: 'text', text }],
    send: async ({ part }) => ({ messageId: '777', type: part.type, text: part.text }),
    pickSticker: async () => null, keepSticker: async () => ({ name: 'x' }),
  };
  const f = await fixture(t, { media });
  const image = file => ({ type: 'image', data: { file } });
  // A first turn of its own, so that the next one has a frequency line.
  const warm = (await f.say('早')).done; await f.advance(2500); await warm;
  const done = [(await f.say([image('a.png')])).done, (await f.say('看这两张')).done, (await f.say([image('b.png'), image('c.png')])).done];
  await f.advance(2500); await Promise.all(done);
  assert.deepEqual(prepared, [1, 2, 3, 4].map(n => 'onebot:v11:message:' + n));
  const { input } = f.requests[1];
  assert.deepEqual(input.mediaRefs.map(ref => ref.id), ['media:2-0', 'media:4-0', 'media:4-1']);
  assert.equal(input.text, '[QQ图片消息]\n看这两张\n[QQ附件消息]\n[渠道事实：你最近 1 条回复里发过 0 次表情包。]');
  // More than BURST_MAX_MEDIA (6) attachments do not share a turn: the executor takes at most 12 refs.
  const g = await fixture(t, { media }), more = [];
  for (let i = 0; i < 2; i++) more.push((await g.say([image('1'), image('2'), image('3'), image('4')])).done);
  await g.advance(2500); await Promise.all(more);
  assert.deepEqual(g.requests.map(request => request.input.mediaRefs.length), [4, 4]);
});

test('one log line per inbound image segment: field names, sub_type, emoji_id present, summary; never a value of another field', async t => {
  const event = { message: [
    { type: 'text', data: { text: '私密文字 12345' } },
    { type: 'image', data: { file: 'secret-file.png', url: 'https://multimedia.nt.qq.com.cn/download?secret', sub_type: 1, summary: '[动画表情]', file_size: '2048' } },
    { type: 'image', data: { file: 'mall.gif', emoji_id: 'abc123', emoji_package_id: 99, summary: '[打call]' } },
    { type: 'image', data: { file: 'plain.jpg' } },
  ] };
  assert.deepEqual(imageProbeLines(event), [
    'qq image segment: keys=file,url,sub_type,summary,file_size sub_type=1 emoji_id=no summary="[动画表情]"',
    'qq image segment: keys=file,emoji_id,emoji_package_id,summary sub_type=- emoji_id=yes summary="[打call]"',
    'qq image segment: keys=file sub_type=- emoji_id=no summary=-',
  ]);
  assert.deepEqual(imageProbeLines({ message: 'text' }), []);
  // The bridge writes them to its output once per accepted message, not for a duplicate.
  const f = await fixture(t);
  f.bridge.media = { prepare: async message => ({ executionText: message.observation.text, queryText: 'x', mediaRefs: [], voiceRequested: false }), plan: async ({ text }) => [{ type: 'text', text }], send: async ({ part }) => ({ messageId: '1', type: 'text', text: part.text }), pickSticker: async () => null };
  const sticker = [{ type: 'image', data: { file: 'secret-file.png', url: 'https://x.qq.com/secret', sub_type: 1, summary: '[动画表情]' } }];
  const { done } = await f.say(sticker); await f.advance(2500); await done;
  assert.deepEqual(f.logs, ['qq image segment: keys=file,url,sub_type,summary sub_type=1 emoji_id=no summary="[动画表情]"']);
  assert.ok(!f.logs.join('').includes('secret'));
});
