import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createStickers, splitTags, DESCRIPTION_TTL_MS, STICKER_QUESTION } from './stickers.js';

/** A tiny PNG made here (never a real sticker): one pixel whose colour and text chunk come from `seed`. */
function png(seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const colour = Buffer.from([0, ...Buffer.from(seed).subarray(0, 3), 0, 0, 0].slice(0, 4));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('MOCK\0' + seed)), chunk('IDAT', deflateSync(colour)), chunk('IEND', Buffer.alloc(0))]);
}
const scopeOf = (person, stream) => ({ entityId: 'entity:test', streamId: stream, personId: person, audience: 'private', memoryEpoch: 0 });
const OWNER = scopeOf('person:owner', 'qq:1:private:2'), OTHER = scopeOf('person:qq:3', 'qq:1:private:3');

function fixture(t, { answer = 'MOCK 一只猫在笑\n标签：开心、哈哈、得意' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stickers-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^fish-stickers-/); fs.rmSync(root, { recursive: true }); });
  const state = { now: Date.parse('2026-11-14T04:00:00Z'), asked: [], refuse: null, logs: [] };
  const clock = () => state.now, store = new ArtifactStore({ root: path.join(root, 'media'), clock });
  const stickers = createStickers({ root: store.root, clock, log: line => state.logs.push(line) });
  const vision = async body => { state.asked.push(body); if (state.refuse) throw Object.assign(new Error(state.refuse), { code: state.refuse }); return { description: answer, model: 'synthetic-vision' }; };
  const service = new MediaService({ store, stickers, workRoot: path.join(root, 'work'), speech: {}, normalizeImage: async data => ({ data, mime: 'image/png' }), vision });
  const ingest = (scope, data, event = 'event:' + Math.random()) => service.call(scope, { action: 'ingest', kind: 'image', sourceEventId: event, data: data.toString('base64') });
  return { root, store, stickers, service, state, ingest };
}

test('a picture is looked at once, by the hash of its bytes, whoever sends it; the cache knows only what it is', async t => {
  const f = fixture(t), picture = png('MOCK-A');
  const first = await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, picture)).id, sticker: true });
  const second = await f.service.call(OTHER, { action: 'describe', ref: (await f.ingest(OTHER, picture)).id, sticker: true });
  assert.equal(f.state.asked.length, 1, 'one look for two senders');
  assert.deepEqual([f.state.asked[0].purpose, f.state.asked[0].question], ['sticker', STICKER_QUESTION]);
  // The tag line is taken out of what she reads; both get the same description, each in their own scope.
  assert.deepEqual([first.description, first.kind, first.cached, second.description, second.cached], ['MOCK 一只猫在笑', 'sticker', false, 'MOCK 一只猫在笑', true]);
  assert.notEqual(first.ref, second.ref);
  await assert.rejects(f.service.call(OTHER, { action: 'describe', ref: first.ref }), { code: 'MEDIA_FORBIDDEN' });
  const cache = fs.readFileSync(path.join(f.store.root, 'describe-cache.json'), 'utf8');
  assert.deepEqual(JSON.parse(cache).entries[f.store.metadata(first.sourceRef).sha256].tags, ['开心', '哈哈', '得意']);
  for (const who of ['qq:1:private:2', 'qq:1:private:3', 'person:', 'entity:', 'event:']) assert.ok(!cache.includes(who), 'the cache holds no sender: ' + who);
  // An ordinary picture: vision's own count (no purpose), the default question, no tags; also looked at once.
  const photo = png('MOCK-B');
  await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, photo)).id });
  await f.service.call(OTHER, { action: 'describe', ref: (await f.ingest(OTHER, photo)).id });
  assert.equal(f.state.asked.length, 2); assert.equal(f.state.asked[1].purpose, undefined);
  // A question of her own is asked every time and never cached.
  const ref = (await f.ingest(OWNER, photo)).id;
  await f.service.call(OWNER, { action: 'describe', ref, question: '图里几只猫？' });
  await f.service.call(OWNER, { action: 'describe', ref, question: '图里几只猫？' });
  assert.equal(f.state.asked.length, 4);
});

test('a mall sticker is known by its platform name and never looked at; a sticker the day has no looks left for is not made up', async t => {
  const f = fixture(t);
  const mall = await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, png('MOCK-M'))).id, sticker: true, name: '狗头' });
  assert.deepEqual([mall.kind, mall.description, f.state.asked.length], ['mall', '商城表情「狗头」', 0]);
  for (const bad of [{ name: '' }, { name: '[狗头]' }, { name: '长'.repeat(13) }, { sticker: false }]) await assert.rejects(f.service.call(OWNER, { action: 'describe', ref: mall.sourceRef, ...bad }), { code: 'MEDIA_INPUT_INVALID' }, JSON.stringify(bad));
  // The sticker row is used up: not looked at, said so, nothing cached, no description stored.
  f.state.refuse = 'CONTENT_BUDGET_EXHAUSTED';
  const ref = (await f.ingest(OWNER, png('MOCK-N'))).id, records = f.store.records().length;
  const result = await f.service.call(OWNER, { action: 'describe', ref, sticker: true });
  assert.deepEqual([result.unrecognized, result.kind, result.description, result.ref, f.store.records().length], [true, 'sticker', undefined, undefined, records]);
  // The next day it is looked at as usual. An ordinary picture over vision's count still fails as before.
  f.state.refuse = null;
  assert.equal((await f.service.call(OWNER, { action: 'describe', ref, sticker: true })).cached, false);
  f.state.refuse = 'CONTENT_BUDGET_EXHAUSTED';
  await assert.rejects(f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, png('MOCK-O'))).id }), { code: 'CONTENT_BUDGET_EXHAUSTED' });
  f.state.refuse = 'CONTENT_SPEND_RESTRICTED';
  await assert.rejects(f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, png('MOCK-P'))).id, sticker: true }), { code: 'CONTENT_SPEND_RESTRICTED' });
});

test('the description of an ordinary picture is kept 30 days; an unreadable cache starts afresh', async t => {
  const f = fixture(t), picture = png('MOCK-T');
  await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, picture)).id });
  f.state.now += DESCRIPTION_TTL_MS - 1000;
  await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, picture)).id });
  assert.equal(f.state.asked.length, 1);
  f.state.now += 2000;
  await f.service.call(OWNER, { action: 'describe', ref: (await f.ingest(OWNER, picture)).id });
  assert.equal(f.state.asked.length, 2);
  fs.writeFileSync(path.join(f.store.root, 'describe-cache.json'), '{not json');
  const fresh = createStickers({ root: f.store.root, clock: () => f.state.now });
  assert.equal(fresh.described(f.store.records().find(r => r.kind === 'image').sha256), null);
  // The artifact store does not take the new files for artifacts.
  assert.ok(f.store.records().every(r => /^media:/.test(r.id)));
});

test('tags come from the same answer', () => {
  assert.deepEqual(splitTags('一只猫\n标签：开心、 哈哈，#得意 / 摸鱼;无语、开心'), { description: '一只猫', tags: ['开心', '哈哈', '得意', '摸鱼', '无语'] });
  assert.deepEqual(splitTags('没有标签的回答'), { description: '没有标签的回答', tags: [] });
  assert.deepEqual(splitTags('标签:好'), { description: '标签:好', tags: ['好'] });
});
