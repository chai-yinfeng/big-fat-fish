import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createContentServer } from './server.mjs';
import { createContentStickersClient } from '../../authority/src/content-control.js';
import { createOperatorServer } from '../../authority/src/operator.js';
import { createStickers, splitTags, overlap, DESCRIPTION_TTL_MS, STICKER_QUESTION, STICKERS_PER_DAY, MAX_PENDING } from './stickers.js';

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
  const stickers = createStickers({ root: store.root, clock, random: () => state.random ?? 0, log: line => state.logs.push(line) });
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

test('tags come from the same answer; words match by the characters they share', () => {
  assert.deepEqual(splitTags('一只猫\n标签：开心、 哈哈，#得意 / 摸鱼;无语、开心'), { description: '一只猫', tags: ['开心', '哈哈', '得意', '摸鱼', '无语'] });
  assert.deepEqual(splitTags('没有标签的回答'), { description: '没有标签的回答', tags: [] });
  assert.deepEqual(splitTags('标签:好'), { description: '标签:好', tags: ['好'] });
  assert.equal(overlap('开心', '开心'), 1); assert.equal(overlap('开心', '好开心'), 2 / 3); assert.equal(overlap('开心', '伤心'), 1 / 3);
  assert.equal(overlap('犀牛潜水艇', '开心'), 0); assert.equal(overlap('OK!', 'ok'), 1); assert.equal(overlap('', '开心'), 0);
});

test('her library: only the owner, in the owner\'s own conversation, adds to it; tags come from the first look', async t => {
  const f = fixture(t), picture = png('MOCK-K');
  const ref = (await f.ingest(OWNER, picture, 'event:keep')).id;
  await f.service.call(OWNER, { action: 'describe', ref, sticker: true });
  // Someone else (and the owner in anything but a private conversation) cannot add to it, not even the same picture.
  const theirs = (await f.ingest(OTHER, picture)).id;
  await assert.rejects(f.service.call(OTHER, { action: 'stickerKeep', ref: theirs }), { code: 'MEDIA_FORBIDDEN' });
  await assert.rejects(f.service.call({ ...OWNER, audience: 'shared' }, { action: 'stickerKeep', ref }), { code: 'MEDIA_FORBIDDEN' });
  await assert.rejects(f.service.call(OWNER, { action: 'stickerKeep', ref: theirs }), { code: 'MEDIA_FORBIDDEN' });
  // So far it is only a sticker the owner sent (collected, waiting): nothing above made it the owner's.
  const index = () => JSON.parse(fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8'));
  assert.deepEqual(index().entries.map(item => [item.source, 'origin' in item]), [['collected', false]]);
  assert.deepEqual(await f.service.call(OWNER, { action: 'stickerKeep', ref }), { kept: true, already: false, name: '开心' });
  assert.deepEqual(await f.service.call(OWNER, { action: 'stickerKeep', ref: (await f.ingest(OWNER, picture)).id }), { kept: true, already: true, name: '开心' });
  const [{ senders, seenAt, ...entry }] = index().entries;
  assert.equal(Object.keys(senders).length, 1, 'the owner is counted as one sender, by an opaque value');
  assert.deepEqual({ ...entry, addedAt: 0 }, { hash: f.store.metadata(ref).sha256, file: f.store.metadata(ref).sha256 + '.png', mime: 'image/png', name: '开心', tags: ['开心', '哈哈', '得意'], kind: 'sticker', source: 'owner', status: 'active', uses: 0, lastUsedAt: null, addedAt: 0, origin: { entityId: 'entity:test', streamId: OWNER.streamId, eventId: 'event:keep' } });
  assert.ok(fs.readFileSync(path.join(f.store.root, 'stickers', entry.file)).equals(picture));
  // A mall sticker is kept under its name; a picture never looked at under a plain name.
  const mall = (await f.ingest(OWNER, png('MOCK-L'))).id;
  await f.service.call(OWNER, { action: 'describe', ref: mall, sticker: true, name: '狗头' });
  assert.equal((await f.service.call(OWNER, { action: 'stickerKeep', ref: mall })).name, '狗头');
  assert.equal((await f.service.call(OWNER, { action: 'stickerKeep', ref: (await f.ingest(OWNER, png('MOCK-U'))).id })).name, '表情包');
  // A library picture's description outlives the 30 days of an ordinary one.
  f.state.now += DESCRIPTION_TTL_MS * 2;
  assert.equal(f.stickers.described(entry.hash).description, 'MOCK 一只猫在笑');
});

test('picking: the closest library stickers to her word, at random among the best few; nothing when none is close enough', async t => {
  const f = fixture(t), event = 'event:reply';
  for (const [seed, name] of [['MOCK-1', '开心'], ['MOCK-2', '好开心'], ['MOCK-3', '伤心'], ['MOCK-4', '晚安']]) {
    const ref = (await f.ingest(OWNER, png(seed))).id;
    await f.service.call(OWNER, { action: 'describe', ref, sticker: true, name });
    await f.service.call(OWNER, { action: 'stickerKeep', ref });
  }
  const pick = (query, scope = OTHER) => f.service.call(scope, { action: 'stickerPick', query, sourceEventId: event });
  // Library stickers go to anyone: the copy is a short-lived picture of that person's own conversation.
  const picked = await pick('开心');
  assert.deepEqual([picked.found, picked.name], [true, '开心']);
  assert.equal(f.store.read(picked.ref, OTHER).meta.sourceEventId, event);
  await assert.rejects(f.service.call(OWNER, { action: 'asset', ref: picked.ref }), { code: 'MEDIA_FORBIDDEN' });
  assert.ok(f.store.read(picked.ref, OTHER).meta.expiresAt <= f.state.now + 3600000);
  f.state.random = 0.99;
  assert.equal((await pick('开心')).name, '好开心', 'the second closest is in the pool; 伤心 (1/3) is not');
  assert.deepEqual(await pick('犀牛潜水艇'), { found: false });
  assert.equal((await pick('伤')).name, '伤心', 'half the characters is just close enough');
  for (const query of ['', ' ', '长'.repeat(13), 3]) await assert.rejects(f.service.call(OTHER, { action: 'stickerPick', query, sourceEventId: event }), { code: 'MEDIA_INPUT_INVALID' });
  await assert.rejects(f.service.call(OTHER, { action: 'stickerPick', query: '开心' }), { code: 'MEDIA_INPUT_INVALID' });
  // Each sticker sent is counted; the day's safety value stops picking (logged) until the next Beijing day.
  const index = () => JSON.parse(fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8'));
  assert.deepEqual([index().sent, index().entries.find(entry => entry.name === '开心').uses], [3, 1]);
  const full = index(); full.sent = STICKERS_PER_DAY; fs.writeFileSync(path.join(f.store.root, 'stickers/index.json'), JSON.stringify(full));
  const fresh = new MediaService({ store: f.store, stickers: createStickers({ root: f.store.root, clock: () => f.state.now, log: line => f.state.logs.push(line) }), workRoot: path.join(f.root, 'work'), speech: {} });
  assert.deepEqual(await fresh.call(OTHER, { action: 'stickerPick', query: '晚安', sourceEventId: event }), { found: false });
  assert.match(f.state.logs.at(-1), /daily safety cap/);
  f.state.now += 86400000;
  assert.equal((await fresh.call(OTHER, { action: 'stickerPick', query: '晚安', sourceEventId: event })).found, true);
});

test('a picked sticker carries what the description cache already says it is, and whether a model wrote that; never looked at again for it', async t => {
  const f = fixture(t), seen = (await f.ingest(OWNER, png('MOCK-D'))).id, unseen = (await f.ingest(OWNER, png('MOCK-N'))).id, mall = (await f.ingest(OWNER, png('MOCK-L'))).id;
  await f.service.call(OWNER, { action: 'describe', ref: seen, sticker: true });
  await f.service.call(OWNER, { action: 'describe', ref: mall, sticker: true, name: '狗头' });
  for (const ref of [seen, unseen, mall]) await f.service.call(OWNER, { action: 'stickerKeep', ref });
  const asked = f.state.asked.length, pick = query => f.service.call(OTHER, { action: 'stickerPick', query, sourceEventId: 'event:reply' });
  const described = await pick('哈哈');
  assert.deepEqual([described.found, described.name, described.description, described.machine], [true, '开心', 'MOCK 一只猫在笑', true]);
  // A mall sticker's description is the platform's name for it, not a model's words.
  const named = await pick('狗头');
  assert.deepEqual([named.found, named.name, named.description, named.machine], [true, '狗头', '商城表情「狗头」', false]);
  // Kept without a first look: found, with no description.
  const plain = await pick('表情包');
  assert.deepEqual([plain.found, plain.name, 'description' in plain, 'machine' in plain], [true, '表情包', false, false]);
  assert.equal(f.state.asked.length, asked, 'picking asks the vision model nothing');
});

test('forgetting the owner\'s message removes the sticker kept from it; an unreadable index is never overwritten', async t => {
  const f = fixture(t), ref = (await f.ingest(OWNER, png('MOCK-F'), 'event:forget')).id;
  await f.service.call(OWNER, { action: 'describe', ref, sticker: true });
  await f.service.call(OWNER, { action: 'stickerKeep', ref });
  const plan = { entityId: 'entity:test', sourceEvents: [{ streamId: OWNER.streamId, eventId: 'event:forget' }] };
  assert.deepEqual(f.stickers.forget({ entityId: 'entity:other', sourceEvents: plan.sourceEvents }), { removed: 0 });
  assert.deepEqual(f.stickers.forget({ ...plan, dryRun: true }), { verified: true, selected: 1 });
  assert.deepEqual(f.stickers.forget(plan), { removed: 1 });
  assert.deepEqual(fs.readdirSync(path.join(f.store.root, 'stickers')), ['index.json']);
  assert.deepEqual(await f.service.call(OTHER, { action: 'stickerPick', query: '开心', sourceEventId: 'event:x' }), { found: false });
  // Nobody is left who sent it: what the description cache said of the picture is gone with it.
  assert.equal(f.stickers.described(f.store.metadata(ref).sha256), null);
  fs.writeFileSync(path.join(f.store.root, 'stickers/index.json'), '{broken');
  const reopened = createStickers({ root: f.store.root });
  assert.throws(() => reopened.pick('开心')); assert.throws(() => reopened.forget(plan));
  assert.equal(fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8'), '{broken');
});

// Collecting from others (design §1.1). 甲, 乙, 丙: three people, each in their own private conversation.
const JIA = scopeOf('person:qq:9999001', 'qq:1:private:9999001'), YI = scopeOf('person:qq:9999002', 'qq:1:private:9999002'), BING = scopeOf('person:qq:9999003', 'qq:1:private:9999003');
const libraryOf = f => JSON.parse(fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8'));
/** `scope`'s person sends `picture` as a sticker in the message `event`; the picture's hash. */
async function sends(f, scope, picture, event) {
  const ref = (await f.ingest(scope, picture, event)).id;
  await f.service.call(scope, { action: 'describe', ref, sticker: true });
  return f.store.metadata(ref).sha256;
}
const picks = (f, scope, query = '开心') => f.service.call(scope, { action: 'stickerPick', query, sourceEventId: 'event:reply' });
const planOf = (scope, ...events) => ({ entityId: scope.entityId, sourceEvents: events.map(eventId => ({ streamId: scope.streamId, eventId })) });

test('collecting: a sticker only 甲 sent never goes to 乙 and may go back to 甲; who sent it is stored as opaque values only', async t => {
  const f = fixture(t), picture = png('MOCK-C1');
  const hash = await sends(f, JIA, picture, 'event:jia-1');
  assert.deepEqual(await picks(f, YI), { found: false });
  assert.deepEqual(await picks(f, OWNER), { found: false }, 'not even to the owner before the owner says so');
  for (let round = 0; round < 5; round++) assert.deepEqual(await picks(f, YI), { found: false });
  const back = await picks(f, JIA);
  assert.deepEqual([back.found, back.name, back.description], [true, '开心', 'MOCK 一只猫在笑']);
  assert.ok(f.store.read(back.ref, JIA).data.equals(picture));
  await assert.rejects(f.service.call(YI, { action: 'asset', ref: back.ref }), { code: 'MEDIA_FORBIDDEN' });
  // An ordinary picture is never collected.
  const photo = (await f.ingest(JIA, png('MOCK-C2'))).id;
  await f.service.call(JIA, { action: 'describe', ref: photo });
  assert.deepEqual(libraryOf(f).entries.map(entry => entry.hash), [hash]);
  // What is written: no person, account, conversation or message id; the console's list gives a number.
  const written = fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8'), [entry] = libraryOf(f).entries;
  for (const who of ['9999001', 'person:', 'qq:1', 'event:jia', 'entity:test']) assert.ok(!written.includes(who), 'the index names nobody: ' + who);
  assert.deepEqual([entry.source, Object.keys(entry.senders).length, Object.keys(entry.senders).every(who => /^[a-f0-9]{32}$/.test(who))], ['collected', 1, true]);
  const [listed] = f.stickers.list().stickers;
  assert.deepEqual([listed.level, listed.senders, listed.description, 'origin' in listed, JSON.stringify(listed).includes(Object.keys(entry.senders)[0])], ['pending', 1, 'MOCK 一只猫在笑', false, false]);
  // The same person sending it again, in another message, is still one person.
  await sends(f, JIA, picture, 'event:jia-2');
  assert.equal(f.stickers.list().stickers[0].senders, 1);
  assert.equal(f.state.asked.filter(body => body.purpose === 'sticker').length, 1, 'the picture was looked at once');
});

test('collecting: the third different person makes it public; the owner counts as a person; the count is the owner\'s to set', async t => {
  const f = fixture(t), picture = png('MOCK-P1');
  await sends(f, JIA, picture, 'event:jia'); await sends(f, YI, picture, 'event:yi');
  assert.equal(f.stickers.list().stickers[0].level, 'pending');
  assert.equal((await picks(f, YI)).found, true); assert.deepEqual(await picks(f, BING), { found: false });
  await sends(f, BING, picture, 'event:bing');
  assert.deepEqual([f.stickers.list().stickers[0].level, f.stickers.list().stickers[0].senders], ['public', 3]);
  assert.equal((await picks(f, OWNER)).found, true, 'a public sticker goes to someone who never sent it');
  // A release before collecting sends only `source: owner`: a public sticker is simply not sent there.
  assert.equal(libraryOf(f).entries[0].source, 'collected');
  // Two people and the owner are three people too.
  const other = png('MOCK-P2');
  await sends(f, JIA, other, 'event:jia-b'); await sends(f, OWNER, other, 'event:owner-b');
  assert.equal(f.stickers.list().stickers[1].level, 'pending');
  await sends(f, YI, other, 'event:yi-b');
  assert.equal(f.stickers.list().stickers[1].level, 'public');
  // The count follows the setting at once, both ways.
  assert.deepEqual(f.stickers.setThreshold(4), { publicThreshold: 4 });
  assert.deepEqual(f.stickers.list().stickers.map(item => item.level), ['pending', 'pending']);
  assert.deepEqual(await picks(f, scopeOf('person:qq:9999004', 'qq:1:private:9999004')), { found: false });
  f.stickers.setThreshold(2);
  assert.deepEqual(f.stickers.list().stickers.map(item => item.level), ['public', 'public']);
  for (const bad of [1, 21, 2.5, '3']) assert.throws(() => f.stickers.setThreshold(bad), { code: 'MEDIA_INPUT_INVALID' });
});

test('collecting: the owner lets a waiting sticker go to everyone, or refuses it for good; saying 收下这个 makes one the owner\'s', async t => {
  const f = fixture(t), wanted = png('MOCK-A1'), unwanted = png('MOCK-A2');
  const hash = await sends(f, JIA, wanted, 'event:jia-a'), refused = await sends(f, JIA, unwanted, 'event:jia-b');
  assert.deepEqual(await picks(f, YI), { found: false });
  assert.deepEqual(f.stickers.approve(hash), { hash });
  assert.deepEqual([f.stickers.list().stickers[0].level, libraryOf(f).entries[0].source], ['owner', 'owner']);
  f.state.random = 0;
  assert.equal((await picks(f, YI)).found, true);
  // Refused: entry and file go, the hash is remembered, and it is not collected again whoever sends it.
  assert.deepEqual(f.stickers.reject(refused), { hash: refused });
  assert.deepEqual([f.stickers.list().stickers.length, f.stickers.list().rejected, fs.existsSync(path.join(f.store.root, 'stickers', refused + '.png'))], [1, 1, false]);
  for (const scope of [JIA, YI, BING, OWNER]) await sends(f, scope, unwanted, 'event:again-' + scope.personId);
  assert.deepEqual(libraryOf(f).entries.map(entry => entry.hash), [hash]);
  assert.equal(f.state.asked.length, 2, 'a refused picture is still known: it is not looked at again');
  assert.throws(() => f.stickers.reject(hash), { code: 'MEDIA_INPUT_INVALID' }, 'a sticker of the owner\'s level is turned off, not refused');
  assert.throws(() => f.stickers.approve('0'.repeat(64)), { code: 'MEDIA_STICKER_UNKNOWN' });
  // The owner asking for a refused picture in the owner's own conversation takes it after all.
  const ref = (await f.ingest(OWNER, unwanted, 'event:owner-keep')).id;
  assert.deepEqual(await f.service.call(OWNER, { action: 'stickerKeep', ref }), { kept: true, already: false, name: '开心' });
  assert.deepEqual([f.stickers.list().rejected, f.stickers.list().stickers.map(item => item.level)], [0, ['owner', 'owner']]);
  // A waiting sticker the owner sends and then keeps becomes the owner's, with its senders still counted.
  const third = png('MOCK-A3'); await sends(f, JIA, third, 'event:jia-c');
  const mine = (await f.ingest(OWNER, third, 'event:owner-c')).id;
  await f.service.call(OWNER, { action: 'describe', ref: mine, sticker: true });
  assert.deepEqual(await f.service.call(OWNER, { action: 'stickerKeep', ref: mine }), { kept: true, already: false, name: '开心' });
  assert.deepEqual([f.stickers.list().stickers[2].level, f.stickers.list().stickers[2].senders], ['owner', 2]);
});

test('collecting: 甲 forgets the message: a sticker only 甲 sent is gone from the library and the cache; one others also sent only loses 甲', async t => {
  const f = fixture(t), own = png('MOCK-F1'), shared = png('MOCK-F2');
  const hash = await sends(f, JIA, own, 'event:jia-own');
  const common = await sends(f, JIA, shared, 'event:jia-shared'); await sends(f, YI, shared, 'event:yi-shared'); await sends(f, BING, shared, 'event:bing-shared');
  assert.deepEqual(f.stickers.list().stickers.map(item => [item.level, item.senders]), [['pending', 1], ['public', 3]]);
  // Another conversation's message of the same id, or another entity, is not 甲's message.
  assert.deepEqual(f.stickers.forget(planOf(YI, 'event:jia-own')), { removed: 0 });
  assert.deepEqual(f.stickers.forget({ ...planOf(JIA, 'event:jia-own'), entityId: 'entity:other' }), { removed: 0 });
  assert.deepEqual(f.stickers.forget({ ...planOf(JIA, 'event:jia-own', 'event:jia-shared'), dryRun: true }), { verified: true, selected: 2 });
  assert.equal(f.stickers.list().stickers.length, 2, 'a dry run changes nothing');
  assert.deepEqual(f.stickers.forget(planOf(JIA, 'event:jia-own', 'event:jia-shared')), { removed: 1, detached: 1 });
  // Only 甲 had sent it: no entry, no file, no description.
  assert.deepEqual(fs.readdirSync(path.join(f.store.root, 'stickers')).sort(), [common + '.png', 'index.json'].sort());
  assert.equal(f.stickers.described(hash), null);
  assert.ok(!fs.readFileSync(path.join(f.store.root, 'describe-cache.json'), 'utf8').includes(hash));
  assert.ok(!fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8').includes(hash));
  // 乙 and 丙 also sent the other: it stays, 甲 is no longer counted, and with two people it waits again.
  assert.deepEqual(f.stickers.list().stickers.map(item => [item.hash, item.level, item.senders]), [[common, 'pending', 2]]);
  assert.equal(f.stickers.described(common).description, 'MOCK 一只猫在笑');
  assert.deepEqual(await picks(f, JIA), { found: false }, '甲 is not one of its senders any more');
  assert.equal((await picks(f, YI)).found, true);
  // A person who sent it in two messages stays a sender until both are forgotten.
  await sends(f, YI, shared, 'event:yi-again');
  assert.deepEqual(f.stickers.forget(planOf(YI, 'event:yi-shared')), { removed: 0, detached: 1 });
  assert.equal(f.stickers.list().stickers[0].senders, 2);
  assert.deepEqual(f.stickers.forget(planOf(YI, 'event:yi-again')), { removed: 0, detached: 1 });
  assert.equal(f.stickers.list().stickers[0].senders, 1);
  // The owner let it go to everyone, but the bytes came only from 丙's message: forgetting that message removes it.
  f.stickers.approve(common);
  assert.equal((await picks(f, JIA)).found, true);
  assert.deepEqual(f.stickers.forget(planOf(BING, 'event:bing-shared')), { removed: 1 });
  assert.deepEqual([f.stickers.list().stickers, f.stickers.described(common)], [[], null]);
  // A picture the owner uploaded, or kept from a message of the owner's own, does not go with someone else's message.
  const kept = png('MOCK-F3'), ref = (await f.ingest(OWNER, kept, 'event:owner-keep')).id;
  await f.service.call(OWNER, { action: 'stickerKeep', ref });
  const keptHash = await sends(f, JIA, kept, 'event:jia-kept');
  const { hash: uploaded } = f.stickers.upload({ data: own, mime: 'image/png', name: '开心', tags: [] });
  await sends(f, JIA, own, 'event:jia-own-2');
  assert.deepEqual(f.stickers.forget(planOf(JIA, 'event:jia-kept', 'event:jia-own-2')), { removed: 0, detached: 2 });
  assert.deepEqual(f.stickers.list().stickers.map(item => [item.hash, item.level, item.senders]), [[keptHash, 'owner', 0], [uploaded, 'owner', 0]]);
  // Forgetting the owner's own message undoes the keeping; nobody else is left, so it goes.
  assert.deepEqual(f.stickers.forget(planOf(OWNER, 'event:owner-keep')), { removed: 1 });
  assert.deepEqual(f.stickers.list().stickers.map(item => item.hash), [uploaded]);
});

test('the console\'s operations: list, picture bytes, rename and tags, off and on, upload; a library written before collecting reads as the owner\'s', async t => {
  const f = fixture(t), picture = png('MOCK-O1');
  const { hash, already } = f.stickers.upload({ data: picture, mime: 'image/png', name: '摸鱼', tags: ['摸鱼', '偷懒', '摸鱼'] });
  assert.equal(already, false);
  const [row] = f.stickers.list().stickers;
  assert.deepEqual({ ...row, addedAt: 0 }, { hash, name: '摸鱼', tags: ['摸鱼', '偷懒'], kind: 'sticker', mime: 'image/png', status: 'active', level: 'owner', senders: 0, uses: 0, lastUsedAt: null, addedAt: 0 });
  assert.deepEqual(f.stickers.list().limits, { library: 500, pending: 300 });
  assert.ok(f.stickers.image(hash).data.equals(picture));
  assert.equal((await picks(f, YI, '偷懒')).found, true);
  f.stickers.update({ hash, name: '划水', tags: ['划水'] });
  assert.deepEqual(await picks(f, YI, '偷懒'), { found: false });
  assert.equal((await picks(f, YI, '划水')).name, '划水');
  f.stickers.update({ hash, status: 'disabled' });
  assert.deepEqual([await picks(f, YI, '划水'), f.stickers.list().stickers[0].status], [{ found: false }, 'disabled']);
  f.stickers.update({ hash, status: 'active' });
  assert.equal((await picks(f, YI, '划水')).found, true);
  for (const bad of [{ hash, name: '' }, { hash, tags: ['a'.repeat(13)] }, { hash, tags: Array(7).fill('x') }, { hash, status: 'gone' }]) assert.throws(() => f.stickers.update(bad), { code: 'MEDIA_INPUT_INVALID' }, JSON.stringify(bad));
  assert.throws(() => f.stickers.update({ hash: '1'.repeat(64), name: 'x' }), { code: 'MEDIA_STICKER_UNKNOWN' });
  assert.throws(() => f.stickers.image('../index.json'), { code: 'MEDIA_STICKER_UNKNOWN' });
  for (const bad of [{ data: Buffer.alloc(0), mime: 'image/png', name: 'x', tags: [] }, { data: picture, mime: 'text/plain', name: 'x', tags: [] }, { data: picture, mime: 'image/png', name: '', tags: [] }]) assert.throws(() => f.stickers.upload(bad), { code: 'MEDIA_INPUT_INVALID' });
  // Uploading a picture that waits makes it the owner's, under the name given.
  const waiting = png('MOCK-O2'); await sends(f, JIA, waiting, 'event:jia');
  assert.deepEqual(f.stickers.upload({ data: waiting, mime: 'image/png', name: '晚安', tags: ['晚安'] }), { hash: f.stickers.list().stickers[1].hash, already: true });
  assert.deepEqual([f.stickers.list().stickers[1].level, f.stickers.list().stickers[1].name], ['owner', '晚安']);
  // An index as the release before collecting wrote it: owner entries with an origin, nothing else. Read as it is.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stickers-'));
  t.after(() => { assert.equal(path.dirname(old), os.tmpdir()); assert.match(path.basename(old), /^fish-stickers-/); fs.rmSync(old, { recursive: true }); });
  fs.mkdirSync(path.join(old, 'stickers'));
  const legacy = { hash: 'a'.repeat(64), file: 'a'.repeat(64) + '.png', mime: 'image/png', name: '开心', tags: ['开心'], kind: 'sticker', source: 'owner', status: 'active', uses: 2, lastUsedAt: 1, addedAt: 1, origin: { entityId: 'entity:test', streamId: OWNER.streamId, eventId: 'event:old' } };
  fs.writeFileSync(path.join(old, 'stickers/index.json'), JSON.stringify({ schema: 1, entries: [legacy], day: null, sent: 0 }));
  fs.writeFileSync(path.join(old, 'stickers', legacy.file), picture);
  const reopened = createStickers({ root: old, clock: () => f.state.now, random: () => 0 });
  assert.deepEqual([reopened.list().stickers[0].level, reopened.list().stickers[0].senders, reopened.pick('开心', { personId: 'person:qq:9999002' }).name], ['owner', 0, '开心']);
  assert.deepEqual(reopened.forget({ entityId: 'entity:test', sourceEvents: [{ streamId: OWNER.streamId, eventId: 'event:old' }] }), { removed: 1 });
});

test('safety values: the pictures waiting for the owner are capped, the least sent one makes room', async t => {
  const f = fixture(t), origin = n => ({ entityId: 'entity:test', streamId: JIA.streamId, eventId: 'event:' + n });
  const hashOf = seed => createHash('sha256').update('MOCK ' + seed).digest('hex');
  const item = n => ({ hash: hashOf(n), data: Buffer.from('MOCK ' + n), mime: 'image/png', kind: 'sticker', name: 'MOCK' + n, tags: [] });
  for (let n = 0; n < MAX_PENDING; n++) { f.state.now += 1000; f.stickers.collect({ ...item(n), personId: JIA.personId, origin: origin(n) }); }
  f.stickers.collect({ ...item(0), personId: YI.personId, origin: { ...origin('yi'), streamId: YI.streamId } });
  f.state.now += 1000; f.stickers.collect({ ...item('new'), personId: JIA.personId, origin: origin('new') });
  const hashes = f.stickers.list().stickers.map(entry => entry.hash);
  assert.deepEqual([hashes.length, hashes.includes(hashOf(0)), hashes.includes(hashOf(1)), hashes.includes(hashOf('new'))], [MAX_PENDING, true, false, true], 'the oldest one only one person sent went');
  assert.equal(fs.existsSync(path.join(f.store.root, 'stickers', hashOf(1) + '.png')), false);
  assert.match(f.state.logs.at(-1), /made room/);
});

test('the console reaches the library through Authority\'s operator port: list, picture, upload with a machine description, decide, settings; nothing says who sent a picture', async t => {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stickers-'));
  const tokenFile = path.join(dir, 'control.token'), socketPath = path.join(dir, 'content.sock'), operatorSocket = path.join(dir, 'op.sock'), operatorToken = 'synthetic-operator-credential-MOCK-0123456789';
  fs.writeFileSync(tokenFile, 'synthetic-content-control-credential-MOCK', { mode: 0o600 });
  // A running world: managing the library needs no pause.
  const server = createContentServer({ socketPath, tokenFile, service: f.service, worldStatus: async () => ({ paused: false, revision: 1 }), stickersCall: input => f.service.stickersCall(input) });
  const operator = createOperatorServer({ authority: {}, socketPath: operatorSocket, tokenHash: createHash('sha256').update(operatorToken).digest('hex'), origins: [], contentStickers: createContentStickersClient({ socketPath, tokenFile }) });
  await server.start(); await operator.start();
  t.after(async () => { await operator.close(); await server.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^fish-stickers-/); fs.rmSync(dir, { recursive: true }); });
  const call = (method, route, body, { socket = operatorSocket, bearer = operatorToken } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method, agent: false, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.deepEqual((await call('GET', '/stickers')).value, { publicThreshold: 3, limits: { library: 500, pending: 300 }, rejected: 0, stickers: [] });
  assert.equal((await call('GET', '/stickers', undefined, { bearer: 'another-synthetic-credential-of-enough-length' })).status, 401);
  assert.equal((await call('POST', '/stickers', { action: 'list' }, { socket: socketPath, bearer: 'another-synthetic-credential-of-enough-length' })).status, 401);
  // 甲 and 乙 send stickers; the owner sees them waiting, with a number of senders.
  const waiting = png('MOCK-W1'), other = png('MOCK-W2');
  const hash = await sends(f, JIA, waiting, 'event:jia-w'); await sends(f, YI, waiting, 'event:yi-w');
  const refused = await sends(f, JIA, other, 'event:jia-x');
  const listed = (await call('GET', '/stickers')).value;
  assert.deepEqual(listed.stickers.map(item => [item.hash, item.level, item.senders, item.description, item.machine]), [[hash, 'pending', 2, 'MOCK 一只猫在笑', true], [refused, 'pending', 1, 'MOCK 一只猫在笑', true]]);
  for (const who of ['9999001', '9999002', 'person:', 'event:', 'qq:1', 'senders":{']) assert.ok(!JSON.stringify(listed).includes(who), 'the list names nobody: ' + who);
  const image = (await call('GET', '/stickers/image?hash=' + hash)).value;
  assert.deepEqual([image.mime, Buffer.from(image.data, 'base64').equals(waiting)], ['image/png', true]);
  for (const route of ['/stickers/image', '/stickers/image?hash=abc', `/stickers/image?hash=${hash}&person=x`, '/stickers/image?hash=' + '0'.repeat(64)]) assert.equal((await call('GET', route)).status, 400, route);
  // Decide: one to everyone, one refused. Rename, retag, off.
  assert.equal((await call('POST', '/stickers/approve', { hash })).status, 200);
  assert.equal((await call('POST', '/stickers/reject', { hash: refused })).status, 200);
  assert.equal((await call('POST', '/stickers/update', { hash, name: '得意', tags: ['得意', '嘿嘿'], status: 'disabled' })).status, 200);
  assert.deepEqual((await call('GET', '/stickers')).value.stickers.map(item => [item.name, item.tags, item.status, item.level]), [['得意', ['得意', '嘿嘿'], 'disabled', 'owner']]);
  assert.equal((await call('GET', '/stickers')).value.rejected, 1);
  for (const [route, body] of [['/stickers/approve', {}], ['/stickers/approve', { hash, person: 'x' }], ['/stickers/reject', { hash }], ['/stickers/update', { hash: 'x', name: 'y' }], ['/stickers/update', { hash, status: 'gone' }], ['/stickers/settings', { publicThreshold: 1 }], ['/stickers/upload', { imageBase64: 'AAAA', name: 'x', tags: [] }], ['/stickers/upload', { imageBase64: waiting.toString('base64') }]]) assert.equal((await call('POST', route, body)).status, 400, route + JSON.stringify(body).slice(0, 60));
  // Upload: a machine description on request (one look in the sticker row), then the picture under the owner's words.
  const mine = png('MOCK-W3'), asked = f.state.asked.length;
  const described = (await call('POST', '/stickers/describe', { imageBase64: mine.toString('base64') })).value;
  assert.deepEqual([described, f.state.asked.length - asked, f.state.asked.at(-1).purpose], [{ recognized: true, cached: false, name: '开心', description: 'MOCK 一只猫在笑', tags: ['开心', '哈哈', '得意'] }, 1, 'sticker']);
  assert.equal((await call('POST', '/stickers/describe', { imageBase64: mine.toString('base64') })).value.cached, true);
  assert.equal(f.state.asked.length - asked, 1, 'the same picture is not looked at twice');
  f.state.refuse = 'CONTENT_BUDGET_EXHAUSTED';
  assert.deepEqual((await call('POST', '/stickers/describe', { imageBase64: png('MOCK-W4').toString('base64') })).value, { recognized: false, reason: 'budget' });
  f.state.refuse = null;
  const uploaded = (await call('POST', '/stickers/upload', { imageBase64: mine.toString('base64'), name: '摸鱼', tags: ['摸鱼'] })).value;
  assert.equal(uploaded.already, false);
  assert.equal((await picks(f, BING, '摸鱼')).found, true, 'an uploaded sticker goes to anybody');
  assert.deepEqual((await call('POST', '/stickers/settings', { publicThreshold: 2 })).value, { publicThreshold: 2 });
  assert.equal((await call('GET', '/stickers')).value.publicThreshold, 2);
  // Without a content service the page has nothing to show.
  const bare = createOperatorServer({ authority: {}, socketPath: path.join(dir, 'bare.sock'), tokenHash: createHash('sha256').update(operatorToken).digest('hex'), origins: [] });
  await bare.start(); t.after(() => bare.close());
  assert.deepEqual([(await call('GET', '/stickers', undefined, { socket: path.join(dir, 'bare.sock') })).status, (await call('POST', '/stickers/approve', { hash }, { socket: path.join(dir, 'bare.sock') })).status], [503, 503]);
});
