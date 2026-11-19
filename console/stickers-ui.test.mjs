import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validStickers, stickerDataUrl, stickerWords, readStickerFile } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
const hash = n => String(n).repeat(64);
const sticker = (n, level, extra = {}) => ({ hash: hash(n), name: 'MOCK' + n, tags: ['开心'], kind: 'sticker', mime: 'image/png', status: 'active', level, senders: level === 'owner' ? 0 : 1, uses: 0, lastUsedAt: null, addedAt: 1794000000000, description: 'MOCK 描述' + n, machine: true, ...extra });
const listing = (...stickers) => ({ publicThreshold: 3, limits: { library: 500, pending: 300 }, rejected: 0, stickers });
// A one-pixel PNG made here (never a real sticker) and the file object a file input would hand over.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const fileOf = bytes => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
// Hook position in view.js: the sticker states follow the persona cards' (35–39).
const STICKERS = 40, IMAGES = 41, EDIT = 42, NEW = 43, THRESHOLD = 44, SHOWN = 45;

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, btoa, URLSearchParams,
    fetch: async (url, options) => { calls.push({ url: url.slice(url.indexOf('3082') + 4), method: options.method, body: options.body }); return { ok: true, status: 200, json: async () => ({ ok: true, value: responses(url, options) }) }; } })
    .then(loaded => {
      const { WorldConsole: component, flattenDictionary } = loaded.factory(() => React);
      const render = (t = key => key) => { cursor = 0; refCursor = 0; return component({ t }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      return { render, nodes, calls, textOf, flattenDictionary, refs };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 10));
const card = (h, tree, title = 'stickers.title') => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes(title));
// State set by the page comes from the test loader's own context: compared by value.
const plain = value => JSON.parse(JSON.stringify(value));
const page = list => { const states = ['operator-test', '', world, {}, 'channels']; states[STICKERS] = list; return states; };

test('sticker paths: the list and one picture are GETs (the picture by its hash only); every change is a POST', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  const ask = (path, payload, query) => operatorRequest({ location, token: 'operator-test', path, payload, query, fetchImpl });
  await ask('/stickers'); await ask('/stickers/image', undefined, { hash: hash(1) });
  for (const path of ['/stickers/update', '/stickers/upload', '/stickers/describe', '/stickers/approve', '/stickers/reject', '/stickers/settings']) await ask(path, { hash: hash(1) });
  assert.deepEqual(seen.slice(0, 3), ['GET /stickers', 'GET /stickers/image?hash=' + hash(1), `POST /stickers/update {"hash":"${hash(1)}"}`]);
  assert.equal(seen.length, 8);
  await assert.rejects(ask('/stickers', {}), /operator_get_required/);
  await assert.rejects(ask('/stickers/approve'), /operator_post_required/);
  await assert.rejects(ask('/stickers/image'), /operator_query_unsupported/);
  for (const bad of [{ hash: 'abc' }, { hash: '../x' }, {}]) await assert.rejects(ask('/stickers/image', undefined, bad), /invalid_sticker_query/);
  await assert.rejects(ask('/stickers', undefined, { hash: hash(1) }), /operator_query_unsupported/);
  assert.equal(validStickers(listing(sticker(1, 'pending'), sticker(2, 'owner', { description: undefined }))), true);
  for (const bad of [null, {}, listing({ ...sticker(1, 'owner'), level: 'mine' }), listing({ ...sticker(1, 'owner'), hash: 'x' }), listing({ ...sticker(1, 'owner'), senders: ['p'] }), { ...listing(), publicThreshold: '3' }]) assert.equal(validStickers(bad), false);
});

test('what the page checks before sending: a name and tags as typed, a picture by its first bytes and size, a picture answer before it becomes an <img> source', async () => {
  assert.deepEqual(stickerWords(' 摸鱼 ', '摸鱼、 偷懒,摸鱼'), { name: '摸鱼', tags: ['摸鱼', '偷懒'] });
  assert.deepEqual(stickerWords('ok', ''), { name: 'ok', tags: [] });
  for (const [name, tags] of [['', ''], ['长'.repeat(13), ''], ['好', 'a、b、c、d、e、f、g'], ['好', '长'.repeat(13)]]) assert.throws(() => stickerWords(name, tags), { code: 'invalid_sticker' });
  assert.equal(await readStickerFile(fileOf(PNG)), PNG.toString('base64'));
  for (const bad of [undefined, fileOf(Buffer.from('not a picture at all')), fileOf(Buffer.alloc(0)), { size: 3 * 1024 * 1024, arrayBuffer: async () => { throw new Error('must not be read'); } }]) await assert.rejects(readStickerFile(bad), { code: 'invalid_sticker_image' });
  assert.equal(stickerDataUrl({ mime: 'image/png', data: PNG.toString('base64') }), 'data:image/png;base64,' + PNG.toString('base64'));
  for (const bad of [null, { mime: 'text/html', data: 'AAAA' }, { mime: 'image/svg+xml', data: 'AAAA' }, { mime: 'image/png', data: '"><script>' }, { mime: 'image/png' }]) assert.throws(() => stickerDataUrl(bad), { code: 'invalid_response' });
});

test('the card is on the channels page: the pending queue with a number of senders and two decisions, the library with level and state, the upload form; nobody is named', async () => {
  const states = page(listing(sticker(1, 'pending', { senders: 2 }), sticker(2, 'pending', { description: undefined }), sticker(3, 'owner'), sticker(4, 'public', { senders: 3, status: 'disabled', machine: false })));
  states[IMAGES] = { [hash(1)]: 'data:image/png;base64,AAAA' };
  const h = await harness(states, () => null);
  const tree = h.render(), section = card(h, tree);
  const titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.ok(titles.indexOf('stickers.title') > titles.indexOf('qqTitle'), 'below the QQ settings');
  assert.deepEqual(h.nodes(section).filter(node => node.type === 'h3').map(node => h.textOf(node)), ['stickers.pendingTitle', 'stickers.libraryTitle', 'stickers.uploadTitle']);
  // A picture that was read is an <img> with a data URL; one not read yet is an empty box.
  assert.deepEqual(h.nodes(section).filter(node => node.type === 'img').map(node => [node.props.src, node.props.alt]), [['data:image/png;base64,AAAA', 'MOCK1']]);
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8')));
  const shown = card(h, h.render(key => zh[key] || key), zh['stickers.title']), squeeze = value => value.replace(/\s+/g, ' ').trim();
  const queue = h.nodes(shown).filter(node => node.props.className === 'bff-list-row').map(row => squeeze(h.textOf(row)));
  assert.deepEqual(queue, ['MOCK 描述1（机器描述） 发过的人数: 2 · 名字: MOCK1 给所有人用 不要', '还没有描述 发过的人数: 1 · 名字: MOCK2 给所有人用 不要']);
  const rows = h.nodes(shown).filter(node => node.type === 'tr').slice(1).map(row => row.children.slice(1).map(cell => squeeze(h.textOf(cell))));
  assert.deepEqual(rows, [['MOCK3 开心 MOCK 描述3（机器描述）', '主人', '0', '0', '改名字和标签 停用'], ['MOCK4 开心 MOCK 描述4', '公共 已停用', '3', '0', '改名字和标签 启用 不要']]);
  assert.match(squeeze(h.textOf(shown)), /库里 2 · 待审 2 · 已拒绝 0/);
  assert.match(squeeze(h.textOf(shown)), /现在是 3）/);
  // The upload form: a file, a name, tags, a machine description on request.
  const inputs = h.nodes(section).filter(node => node.type === 'input').map(node => node.props.type);
  assert.deepEqual(inputs, ['number', 'file', 'text', 'text']);
  assert.equal(h.nodes(section).find(node => node.type === 'input' && node.props.type === 'file').props.accept, 'image/png,image/jpeg,image/gif,image/webp');
  // Nothing loaded: the card says so. Nothing in the library or the queue: both say so, the upload form stays.
  states[STICKERS] = null;
  assert.ok(h.textOf(card(h, h.render())).includes('stickers.unavailable'));
  states[STICKERS] = listing();
  const empty = h.textOf(card(h, h.render()));
  assert.ok(empty.includes('stickers.pendingEmpty') && empty.includes('stickers.libraryEmpty') && empty.includes('stickers.upload'));
});

test('decisions and edits post the hash and nothing about a person, then read the list and the pictures on screen again', async () => {
  let list = listing(sticker(1, 'pending'), sticker(3, 'owner'));
  const states = page(list);
  const h = await harness(states, (url, options) => options.method === 'POST' ? { hash: hash(1) } : url.includes('/stickers/image') ? { mime: 'image/png', data: PNG.toString('base64') } : list);
  const press = async (label, nth = 0) => { h.nodes(card(h, h.render())).filter(node => node.type === 'button' && h.textOf(node).trim() === label)[nth].props.onClick(); await settled(); };
  await press('stickers.approve');
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url} ${call.body ?? ''}`.trim()), [`POST /stickers/approve {"hash":"${hash(1)}"}`, 'GET /stickers', 'GET /stickers/image?hash=' + hash(1), 'GET /stickers/image?hash=' + hash(3)]);
  assert.deepEqual(Object.keys(states[IMAGES]).sort(), [hash(1), hash(3)]);
  assert.ok(states.includes('stickers.approved'));
  h.calls.length = 0; await press('stickers.reject');
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url} ${call.body ?? ''}`.trim()), [`POST /stickers/reject {"hash":"${hash(1)}"}`, 'GET /stickers'], 'pictures already read are not read again');
  h.calls.length = 0; await press('stickers.disable');
  assert.equal(h.calls[0].body, JSON.stringify({ hash: hash(3), status: 'disabled' }));
  // Rename and retag: the row turns into two fields; saving sends the words as typed, cancelling sends nothing.
  h.calls.length = 0; await press('stickers.edit');
  assert.deepEqual(plain(states[EDIT]), { hash: hash(3), name: 'MOCK3', tags: '开心' });
  const fields = () => h.nodes(card(h, h.render())).filter(node => node.type === 'input' && node.props.type === 'text');
  fields()[0].props.onChange({ target: { value: '摸鱼' } }); fields()[1].props.onChange({ target: { value: '摸鱼，偷懒' } });
  await press('stickers.save');
  assert.deepEqual(h.calls.slice(0, 2).map(call => [call.url, call.body]), [['/stickers/update', JSON.stringify({ hash: hash(3), name: '摸鱼', tags: ['摸鱼', '偷懒'] })], ['/stickers', undefined]]);
  assert.equal(states[EDIT], null);
  h.calls.length = 0; await press('stickers.edit'); fields()[0].props.onChange({ target: { value: '' } }); await press('stickers.save');
  assert.deepEqual(h.calls, [], 'an empty name is not sent');
  await press('stickers.cancel'); assert.equal(states[EDIT], null);
  // The threshold: a whole number of 2–20 or nothing is sent.
  const form = () => h.nodes(card(h, h.render())).filter(node => node.type === 'form')[0];
  const submit = async node => { node.props.onSubmit({ preventDefault() {} }); await settled(); };
  states[THRESHOLD] = '1'; await submit(form()); assert.deepEqual(h.calls, []);
  states[THRESHOLD] = '4'; await submit(form());
  assert.deepEqual([h.calls[0].url, h.calls[0].body, states[THRESHOLD]], ['/stickers/settings', '{"publicThreshold":4}', '']);
});

test('upload: a machine description on request fills the empty fields; the picture goes as bytes with the owner\'s words; a day without looks says so and sends nothing more', async () => {
  const states = page(listing());
  let described = { recognized: true, cached: false, name: '开心', description: 'MOCK 一只猫在笑', tags: ['开心', '哈哈'] };
  const h = await harness(states, (url, options) => url.endsWith('/stickers/describe') ? described : options.method === 'POST' ? { hash: hash(5), already: false } : listing());
  h.render();
  const input = { files: [fileOf(PNG)], value: 'C:\\fakepath\\MOCK.png' };
  h.refs.at(-2).current = input;
  const press = async label => { h.nodes(card(h, h.render())).find(node => node.type === 'button' && h.textOf(node).trim() === label).props.onClick(); await settled(); };
  const form = () => h.nodes(card(h, h.render())).filter(node => node.type === 'form')[1];
  await press('stickers.describe');
  assert.deepEqual(h.calls.map(call => [call.url, call.body]), [['/stickers/describe', JSON.stringify({ imageBase64: PNG.toString('base64') })]]);
  assert.deepEqual(plain(states[NEW]), { name: '开心', tags: '开心、哈哈', description: 'MOCK 一只猫在笑' });
  assert.ok(h.textOf(card(h, h.render())).includes('MOCK 一只猫在笑'));
  // What the owner typed is kept over the machine's words.
  states[NEW] = { name: '摸鱼', tags: '', description: '' }; await press('stickers.describe');
  assert.deepEqual(plain(states[NEW]), { name: '摸鱼', tags: '开心、哈哈', description: 'MOCK 一只猫在笑' });
  h.calls.length = 0; form().props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls.map(call => [call.url, call.body]), [['/stickers/upload', JSON.stringify({ imageBase64: PNG.toString('base64'), name: '摸鱼', tags: ['开心', '哈哈'] })], ['/stickers', undefined]]);
  assert.deepEqual([plain(states[NEW]), input.value], [{ name: '', tags: '', description: '' }, ''], 'the form is emptied after the upload');
  assert.ok(states.includes('stickers.uploaded'));
  assert.ok(!JSON.stringify(h.calls).includes('fakepath'), 'no file name or path is sent');
  // No looks left today: said, nothing filled in. No file chosen, or no name: nothing is sent.
  input.files = [fileOf(PNG)]; described = { recognized: false, reason: 'budget' }; h.calls.length = 0;
  await press('stickers.describe');
  assert.ok(states.includes('stickers.describeBudget')); assert.deepEqual(plain(states[NEW]), { name: '', tags: '', description: '' });
  h.calls.length = 0; form().props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls, [], 'a picture without a name is not uploaded');
  input.files = []; states[NEW] = { name: '摸鱼', tags: '', description: '' }; form().props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls, []);
});

test('a long library shows twenty rows and reads their pictures only; "show more" adds twenty', async () => {
  const many = listing(...Array.from({ length: 45 }, (_, index) => ({ ...sticker(1, 'owner'), hash: index.toString(16).padStart(64, '0'), name: 'MOCK' + index })));
  const states = page(many);
  const h = await harness(states, url => url.includes('/stickers/image') ? { mime: 'image/png', data: PNG.toString('base64') } : many);
  const rows = () => h.nodes(card(h, h.render())).filter(node => node.type === 'tr').length - 1;
  assert.equal(rows(), 20);
  h.nodes(card(h, h.render())).find(node => node.type === 'button' && h.textOf(node).trim() === 'stickers.more').props.onClick(); await settled(); await settled();
  assert.deepEqual([rows(), states[SHOWN], h.calls.filter(call => call.url.startsWith('/stickers/image')).length], [40, 40, 40]);
});

test('sticker strings exist in both locales', async () => {
  for (const locale of ['zh', 'en']) {
    const { stickers, errors } = JSON.parse(await readFile(new URL(`./locale/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['title', 'hint', 'unavailable', 'machine', 'undescribed', 'pendingTitle', 'pendingHint', 'pendingEmpty', 'pendingMore', 'senders', 'approve', 'reject', 'approved', 'rejected', 'threshold', 'thresholdNow', 'thresholdSave', 'libraryTitle', 'libraryEmpty', 'disabled', 'edit', 'save', 'cancel', 'disable', 'enable', 'more', 'name', 'tags', 'tagsHint', 'uploadTitle', 'uploadHint', 'file', 'describe', 'upload', 'uploaded', 'uploadedAlready', 'describeBudget', 'describeSpend']) assert.equal(typeof stickers[key], 'string', `${locale} ${key}`);
    assert.deepEqual(Object.keys(stickers.columns), ['picture', 'name', 'level', 'senders', 'uses', 'action'], locale);
    assert.deepEqual(Object.keys(stickers.level), ['owner', 'public', 'pending'], locale);
    assert.deepEqual(Object.keys(stickers.count), ['library', 'pending', 'rejected'], locale);
    for (const key of ['invalid_sticker', 'invalid_sticker_image']) assert.equal(typeof errors[key], 'string', `${locale} ${key}`);
  }
});
