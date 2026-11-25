import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Authority } from '../../authority/src/engine.js';
import { createAuthorityServer } from '../../authority/src/server.js';
import { createContentControlClient } from '../../authority/src/content-control.js';
import { ArtifactStore } from './artifacts.js';
import { MediaService, WEB_PAGE, webPages } from './service.js';
import { createContentServer } from './server.mjs';
import { ContentClient } from './client.js';

const URL_ = 'https://example.com/MOCK-long';
// What the gateway answers: the whole text, one fetch. 12000 characters in lines: three pages.
const LONG = Array.from({ length: 200 }, (_, n) => `MOCK-LINE-${String(n).padStart(3, '0')} ` + 'x'.repeat(44)).join('\n');
const scopeOf = (streamId = 'private', personId = 'person:owner') => ({ entityId: 'entity:mock', streamId, personId, audience: 'private', memoryEpoch: 1 });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-web-pages-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const f = { now: 1_000_000, fetches: [] };
  f.store = new ArtifactStore({ root: path.join(root, 'media'), clock: () => f.now });
  f.service = new MediaService({ store: f.store, workRoot: path.join(root, 'work'), speech: {},
    fetchPage: async ({ url }) => { f.fetches.push(url); return { url, title: 'MOCK 长文', content: LONG, truncated: false, usage: null, external: true, derived: true, isNewEvidence: false }; } });
  f.read = (input, scope = scopeOf()) => f.service.call(scope, { action: 'fetch', url: URL_, ...input });
  return f;
}

test('webPages: every page fits the tool output once JSON-escaped, breaks at a line end, and nothing is lost', () => {
  const pages = webPages(LONG);
  assert.equal(pages.length, 3);
  assert.equal(pages.join(''), LONG);
  for (const page of pages) assert.ok(JSON.stringify(page).length - 2 <= WEB_PAGE.chars);
  for (const page of pages.slice(0, -1)) assert.ok(page.endsWith('\n'));
  // Text that grows when escaped (quotes, control characters) gives smaller pages, never larger ones.
  const escaped = webPages('"\t'.repeat(6000));
  assert.ok(escaped.length >= 3 && escaped.every(page => JSON.stringify(page).length - 2 <= WEB_PAGE.chars) && escaped.join('') === '"\t'.repeat(6000));
  // A surrogate pair is never split; an empty page is one empty page.
  const emoji = webPages('😀'.repeat(4000));
  assert.ok(emoji.every(page => !/[\ud800-\udbff]$/.test(page)) && emoji.join('') === '😀'.repeat(4000));
  assert.deepEqual(webPages(''), ['']);
});

test('read: page 1 and the number of pages, then any page from this conversation\'s kept text without another fetch', async t => {
  const f = fixture(t), pages = webPages(LONG);
  const first = await f.read({ sourceEventId: 'MOCK-asked' });
  assert.deepEqual([first.page, first.pages, first.content, first.title, first.url, first.truncated], [1, 3, pages[0], 'MOCK 长文', URL_, false]);
  assert.deepEqual([first.external, first.derived, first.isNewEvidence], [true, true, false]);
  assert.equal(f.fetches.length, 1);
  // Kept for this conversation only, a few hours, under the message that asked.
  const [kept] = f.store.list(scopeOf(), 'web');
  assert.deepEqual([kept.sourceEventId, kept.expiresAt - f.now], ['MOCK-asked', WEB_PAGE.ttlMs]);
  const second = await f.read({ page: 2 }), third = await f.read({ page: 3 });
  assert.deepEqual([second.page, second.pages, second.content, second.cached, second.usage], [2, 3, pages[1], true, null]);
  assert.equal(third.content, pages[2]);
  assert.equal(f.fetches.length, 1, 'a kept page is not fetched again (and not counted)');
  // Past the end: an empty answer that says so, still without a fetch.
  const beyond = await f.read({ page: 4 });
  assert.deepEqual([beyond.page, beyond.pages, beyond.content, beyond.noSuchPage, beyond.isNewEvidence], [4, 3, '', true, false]);
  assert.equal(f.fetches.length, 1);
  for (const page of [0, -1, 1.5, 1000, '2']) await assert.rejects(f.read({ page }), { code: 'MEDIA_INPUT_INVALID' });
  // Read again without a page: a fresh fetch (the page may have changed).
  await f.read({ sourceEventId: 'MOCK-asked-again' });
  assert.equal(f.fetches.length, 2);
});

test('read: another conversation cannot read the kept text; without a source nothing is kept; expired text is fetched again; forgetting the message removes it', async t => {
  const f = fixture(t);
  await f.read({ sourceEventId: 'MOCK-asked' });
  // Another conversation (another stream, another person) asking for page 2 of the same link fetches it itself.
  const other = await f.read({ page: 2 }, scopeOf('other', 'person:other'));
  assert.deepEqual([other.page, other.cached], [2, undefined]);
  assert.equal(f.fetches.length, 2);
  assert.deepEqual(f.store.list(scopeOf('other', 'person:other'), 'web'), [], 'no source: nothing kept');
  // Expired: fetched again.
  f.now += WEB_PAGE.ttlMs;
  const later = await f.read({ page: 2 });
  assert.deepEqual([later.page, later.cached], [2, undefined]);
  assert.equal(f.fetches.length, 3);
  assert.deepEqual(f.store.expire(), { removed: 1 });
  // Forgetting the message it was read for removes the kept text: the next page is fetched again.
  await f.read({ sourceEventId: 'MOCK-forgotten' });
  assert.equal((await f.read({ page: 2 })).cached, true);
  assert.equal(f.fetches.length, 4);
  assert.deepEqual(f.store.forget({ entityId: 'entity:mock', sourceEvents: [{ streamId: 'private', eventId: 'MOCK-forgotten' }] }), { mediaPurged: true, removed: 1 });
  assert.deepEqual(f.store.list(scopeOf(), 'web'), []);
  assert.equal((await f.read({ page: 2 })).cached, undefined);
  assert.equal(f.fetches.length, 5);
});

test('through Authority: a source the conversation may use files the text under it; one it may not use is left out and the page still read', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-web-flow-'));
  const core = new Authority({ file: path.join(root, 'core.sqlite') });
  const capabilityToken = 'synthetic-capability-credential-for-web', controlToken = 'synthetic-content-control-credential';
  const tokenFile = path.join(root, 'cap.token'), controlFile = path.join(root, 'control.token');
  fs.writeFileSync(tokenFile, capabilityToken, { mode: 0o600 }); fs.writeFileSync(controlFile, controlToken, { mode: 0o600 });
  core.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  core.bindActor({ capabilityId: 'qq', externalActorId: 'owner', personId: 'person:owner' });
  core.bindStream({ capabilityId: 'qq', streamId: 'private', personId: 'person:owner', audience: 'private' });
  core.observe('qq', { streamId: 'private', eventId: 'asked', actorId: 'owner', role: 'user', text: '读一下 ' + URL_, at: 1 });
  // A message of somebody who is not the person this conversation is bound to.
  core.observe('qq', { streamId: 'private', eventId: 'stranger', actorId: 'stranger', role: 'user', text: '读一下 ' + URL_, at: 2 });
  const store = new ArtifactStore({ root: path.join(root, 'media') }), fetches = [];
  const service = new MediaService({ store, workRoot: path.join(root, 'work'), speech: {}, fetchPage: async ({ url }) => { fetches.push(url); return { url, title: 'MOCK', content: LONG, truncated: false, usage: null, external: true, derived: true, isNewEvidence: false }; } });
  const controlSocket = path.join(root, 'content.sock'), socketPath = path.join(root, 'core.sock');
  const content = createContentServer({ socketPath: controlSocket, tokenFile: controlFile, service, worldStatus: async () => core.worldStatus() });
  const authority = createAuthorityServer({ authority: core, socketPath, credentials: [{ role: 'capability', capabilityId: 'qq', hash: createHash('sha256').update(capabilityToken).digest('hex') }], contentControl: createContentControlClient({ socketPath: controlSocket, tokenFile: controlFile }) });
  t.after(async () => { await content.close(); await authority.close(); core.close(); fs.rmSync(root, { recursive: true }); });
  await content.start(); await authority.start();
  const client = new ContentClient({ socketPath, tokenFile }), scope = { streamId: 'private', memoryEpoch: 0 };
  const stranger = await client.call({ ...scope, action: 'fetch', url: URL_, sourceEventId: 'stranger' });
  assert.deepEqual([stranger.page, stranger.pages], [1, 3]);
  assert.equal(store.records().length, 0, 'nothing filed under a message the conversation may not use');
  const first = await client.call({ ...scope, action: 'fetch', url: URL_, sourceEventId: 'asked' });
  assert.deepEqual([first.page, first.pages], [1, 3]);
  assert.deepEqual(store.records().map(meta => [meta.kind, meta.sourceEventId]), [['web', 'asked']]);
  const second = await client.call({ ...scope, action: 'fetch', url: URL_, page: 2 });
  assert.deepEqual([second.page, second.cached, fetches.length], [2, true, 2]);
  // A page answer stays within what the content client takes.
  assert.ok(JSON.stringify(second).length < 65536);
});
