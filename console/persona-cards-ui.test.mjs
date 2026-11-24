import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, personaDraft, validCards, cardTags } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const persona = name => ({ name, userCallName: '你', identity: 'MOCK-身份', traits: [], boundaries: [], speechStyle: 's', relationshipStage: 'new', principles: [], examples: [] });
const worldOf = (name, revision) => ({ world: { paused: false, revision: 1 }, persona: { revision, value: persona(name), default: persona('Default') }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null });
const library = (currentId, revision = 3) => ({ entityId: 'entity:big-fat-fish', personaRevision: revision, currentId, limit: 24, cards: [
  { id: 'card:default', title: 'MOCK-默认卡', tags: [], summary: '', current: currentId === 'card:default', persona: persona('MOCK-甲'), createdAt: null, updatedAt: null },
  { id: 'card:b', title: 'MOCK-乙卡', tags: ['MOCK-外冷内热', 'MOCK-嘴直'], summary: 'MOCK-乙卡的一句话简介', current: currentId === 'card:b', persona: persona('MOCK-乙'), createdAt: 1, updatedAt: 2 }] });
// Hook positions in view.js: the editor draft is state 3; the card states are 35-39.
const DRAFT = 3, CARDS = 35, EDIT = 36, META = 37, NEW = 38, CONFIRM = 39;

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    // A response `{ refused: error }` answers 400 with that operator error.
    fetch: async (url, options) => { const call = { url: url.slice(url.indexOf('3082') + 4), method: options.method, payload: options.body && JSON.parse(options.body) }; calls.push(call); const value = responses(call); return value?.refused ? { ok: false, status: 400, json: async () => ({ ok: false, error: value.refused }) } : { ok: true, status: 200, json: async () => ({ ok: true, value }) }; } })
    .then(loaded => {
      const { WorldConsole: component, flattenDictionary } = loaded.factory(() => React);
      const render = (t = key => key) => { cursor = 0; refCursor = 0; return component({ t }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      const rows = () => Object.fromEntries(nodes(render()).filter(node => node.props.className === 'bff-list-row').map(node => [textOf(nodes(node).find(item => item.type === 'strong')), node]));
      const press = (scope, key) => nodes(scope).find(node => node.type === 'button' && node.children.includes(key)).props.onClick();
      return { render, nodes, calls, textOf, rows, press, flattenDictionary };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 5));
// State objects are made inside the harness's vm context: compare them by value.
const plain = value => JSON.parse(JSON.stringify(value));
function page(currentId = 'card:default') {
  const states = ['operator-test', '', worldOf('MOCK-甲', 3), personaDraft(persona('MOCK-甲')), 'persona'];
  states[CARDS] = library(currentId);
  return states;
}

test('card paths: the list is a GET, creating posts to the same path, and edit/activate/delete must POST', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/persona/cards', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/persona/cards', payload: { title: 'MOCK' }, fetchImpl });
  for (const path of ['/persona/cards/update', '/persona/cards/activate', '/persona/cards/delete']) {
    await operatorRequest({ location, token: 'operator-test', path, payload: { id: 'card:b' }, fetchImpl });
    await assert.rejects(operatorRequest({ location, token: 'operator-test', path, fetchImpl }), /operator_post_required/);
  }
  assert.deepEqual(seen, ['GET /persona/cards', 'POST /persona/cards', 'POST /persona/cards/update', 'POST /persona/cards/activate', 'POST /persona/cards/delete']);
  assert.equal(validCards(library('card:default')), true);
  for (const bad of [null, {}, { ...library('card:default'), cards: [] }, library('card:none'), { ...library('card:b'), cards: [{ id: 'card:b', title: 'x', current: true }] }, { ...library('card:b'), cards: library('card:b').cards.map(({ tags, ...card }) => card) }]) assert.equal(validCards(bad), false);
  // Tags are typed on one line.
  assert.deepEqual([cardTags(' MOCK-外冷内热、MOCK-嘴直，MOCK-嘴直 , a;b  c '), cardTags(''), cardTags(undefined)], [['MOCK-外冷内热', 'MOCK-嘴直', 'a', 'b', 'c'], [], []]);
});

test('card library: the current card is marked and cannot be deleted or made current; another card is edited without touching the persona in force', async () => {
  const states = page();
  const h = await harness(states, call => call.url === '/persona/cards' ? { ...library('card:default'), cards: library('card:default').cards.map(card => card.id === 'card:b' ? { ...card, title: 'MOCK-乙卡改', tags: ['MOCK-天然呆'], summary: '', persona: persona('MOCK-乙改') } : card) } : {});
  let rows = h.rows();
  assert.deepEqual(Object.keys(rows), ['MOCK-默认卡', 'MOCK-乙卡']);
  const labels = row => h.nodes(row).filter(node => node.type === 'button').map(node => h.textOf(node).trim());
  assert.deepEqual([labels(rows['MOCK-默认卡']), labels(rows['MOCK-乙卡'])], [['cardsPanel.edit'], ['cardsPanel.edit', 'cardsPanel.activate', 'cardsPanel.delete']]);
  assert.ok(h.textOf(rows['MOCK-默认卡']).includes('cardsPanel.current') && h.textOf(rows['MOCK-默认卡']).includes('cardsPanel.editing') && !h.textOf(rows['MOCK-乙卡']).includes('cardsPanel.current'));
  assert.ok(JSON.stringify(h.render()).includes('cardsPanel.editingCurrent'));
  // A row shows what helps picking a card: its tags and its one-line summary.
  for (const shown of ['MOCK-外冷内热', 'MOCK-嘴直', 'MOCK-乙卡的一句话简介']) assert.ok(h.textOf(rows['MOCK-乙卡']).includes(shown) && !h.textOf(rows['MOCK-默认卡']).includes(shown), shown);
  // Pick the other card: the editor holds its persona and says saving does not affect conversations.
  h.press(rows['MOCK-乙卡'], 'cardsPanel.edit');
  assert.deepEqual([states[EDIT], states[DRAFT].name], ['card:b', 'MOCK-乙']);
  assert.ok(JSON.stringify(h.render()).includes('cardsPanel.editingOther'));
  // An unsaved edit holds the library still: no switching, creating, deleting or making current underneath it.
  const inputs = () => Object.fromEntries(h.nodes(h.render()).filter(node => node.type === 'input' && String(node.props.name).startsWith('card')).map(node => [node.props.name, node]));
  assert.deepEqual(Object.fromEntries(Object.entries(inputs()).map(([name, node]) => [name, node.props.value])), { cardTitle: 'MOCK-乙卡', cardTags: 'MOCK-外冷内热、MOCK-嘴直', cardSummary: 'MOCK-乙卡的一句话简介' });
  states[DRAFT] = { ...states[DRAFT], name: 'MOCK-乙改' };
  inputs().cardTitle.props.onChange({ target: { value: 'MOCK-乙卡改' } }); inputs().cardTags.props.onChange({ target: { value: 'MOCK-天然呆' } }); inputs().cardSummary.props.onChange({ target: { value: '' } });
  assert.ok(JSON.stringify(h.render()).includes('cardsPanel.dirtyHint'));
  assert.ok(h.nodes(h.render()).filter(node => node.type === 'button' && ['cardsPanel.edit', 'cardsPanel.activate', 'cardsPanel.delete', 'cardsPanel.create'].some(key => node.children.includes(key))).every(node => node.props.disabled));
  // Saving posts the card (no expectedRevision: it is not the persona in force) and never the persona route or /world.
  h.nodes(h.render()).find(node => node.type === 'form' && node.props.className === 'bff-stack').props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url}`), ['POST /persona/cards/update', 'GET /persona/cards']);
  assert.deepEqual([h.calls[0].payload.id, h.calls[0].payload.title, h.calls[0].payload.tags, h.calls[0].payload.summary, h.calls[0].payload.patch.name, 'expectedRevision' in h.calls[0].payload], ['card:b', 'MOCK-乙卡改', ['MOCK-天然呆'], '', 'MOCK-乙改', false]);
  assert.deepEqual([states[EDIT], states[META], states[DRAFT].name, states[2].persona.value.name], ['card:b', null, 'MOCK-乙改', 'MOCK-甲']);
  rows = h.rows();
  assert.ok(rows['MOCK-乙卡改'] && !JSON.stringify(h.render()).includes('cardsPanel.dirtyHint'));
});

test('card library: saving the current card sends the persona revision; a new card is a copy or the default persona and lands in the editor', async () => {
  const states = page();
  const made = { ...library('card:default'), id: 'card:c', cards: [...library('card:default').cards, { id: 'card:c', title: 'MOCK-丙卡', tags: ['MOCK-毒舌'], summary: 'MOCK-丙卡简介', current: false, persona: persona('MOCK-乙'), createdAt: 5, updatedAt: 5 }] };
  const h = await harness(states, call => call.url === '/world' ? worldOf('MOCK-甲改', 4) : call.method === 'POST' && call.url === '/persona/cards' ? made : call.url === '/persona/cards' ? library('card:default', 4) : {});
  states[DRAFT] = { ...states[DRAFT], name: 'MOCK-甲改' };
  h.nodes(h.render()).find(node => node.type === 'form' && node.props.className === 'bff-stack').props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url}`), ['POST /persona/cards/update', 'GET /world', 'GET /persona/cards']);
  assert.deepEqual([h.calls[0].payload.id, h.calls[0].payload.expectedRevision, h.calls[0].payload.patch.name, ['title', 'tags', 'summary'].some(key => key in h.calls[0].payload)], ['card:default', 3, 'MOCK-甲改', false]);
  assert.deepEqual([states[EDIT], states[DRAFT].name], [null, 'MOCK-甲改']);
  // New card: a name and a source; the page names no persona content itself.
  h.calls.length = 0;
  const form = () => h.nodes(h.render()).find(node => node.type === 'form' && h.textOf(node).includes('cardsPanel.create'));
  assert.equal(h.nodes(form()).find(node => node.type === 'button').props.disabled, true, 'a card needs a name');
  for (const [name, value] of [['newCardTitle', 'MOCK-丙卡'], ['newCardTags', 'MOCK-毒舌，MOCK-毒舌'], ['newCardSummary', 'MOCK-丙卡简介']]) h.nodes(form()).find(node => node.type === 'input' && node.props.name === name).props.onChange({ target: { value } });
  const select = h.nodes(form()).find(node => node.type === 'select');
  assert.deepEqual(h.nodes(select).filter(node => node.type === 'option').map(node => node.props.value), ['', 'card:default', 'card:b']);
  select.props.onChange({ target: { value: 'card:b' } });
  form().props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls, [{ url: '/persona/cards', method: 'POST', payload: { title: 'MOCK-丙卡', tags: ['MOCK-毒舌'], summary: 'MOCK-丙卡简介', copyFrom: 'card:b' } }]);
  assert.deepEqual([states[EDIT], states[DRAFT].name, plain(states[NEW]), Object.keys(h.rows())], ['card:c', 'MOCK-乙', { title: '', tags: '', summary: '', copyFrom: '' }, ['MOCK-默认卡', 'MOCK-乙卡', 'MOCK-丙卡']]);
});

test('card library: making a card current and deleting one each take a confirmation that says what it costs', async () => {
  const states = page();
  let current = 'card:default';
  const h = await harness(states, call => {
    if (call.url === '/persona/cards/activate') { current = call.payload.id; return { changed: true, ...library(current, 4) }; }
    if (call.url === '/world') return worldOf(current === 'card:b' ? 'MOCK-乙' : 'MOCK-甲', 4);
    if (call.url === '/persona/cards/delete') return { ...library('card:b', 4), cards: library('card:b', 4).cards.filter(card => card.id !== call.payload.id) };
    return library(current, 4);
  });
  const dialog = () => h.nodes(h.render()).find(node => node.props.role === 'alertdialog');
  assert.equal(dialog(), undefined);
  h.press(h.rows()['MOCK-乙卡'], 'cardsPanel.activate');
  assert.deepEqual([plain(states[CONFIRM]), h.calls.length], [{ kind: 'activate', id: 'card:b' }, 0], 'nothing is sent before the confirmation');
  for (const shown of ['cardsPanel.activateTitle', 'MOCK-乙卡', 'cardsPanel.activateWarning']) assert.ok(h.textOf(dialog()).includes(shown), shown);
  h.press(dialog(), 'cardsPanel.cancel');
  assert.deepEqual([states[CONFIRM], h.calls.length], [null, 0]);
  h.press(h.rows()['MOCK-乙卡'], 'cardsPanel.activate'); h.press(dialog(), 'cardsPanel.activateConfirm'); await settled();
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url}`), ['POST /persona/cards/activate', 'GET /world', 'GET /persona/cards']);
  assert.deepEqual(h.calls[0].payload, { id: 'card:b', expectedRevision: 3 });
  // The editor follows the persona now in force; the card that was current can now be deleted, after a confirmation.
  assert.deepEqual([states[CONFIRM], states[EDIT], states[DRAFT].name], [null, null, 'MOCK-乙']);
  assert.ok(h.textOf(h.rows()['MOCK-乙卡']).includes('cardsPanel.current'));
  h.calls.length = 0;
  h.press(h.rows()['MOCK-默认卡'], 'cardsPanel.delete');
  for (const shown of ['cardsPanel.deleteTitle', 'MOCK-默认卡', 'cardsPanel.deleteWarning']) assert.ok(h.textOf(dialog()).includes(shown), shown);
  assert.equal(h.calls.length, 0);
  h.press(dialog(), 'cardsPanel.deleteConfirm'); await settled();
  assert.deepEqual(h.calls, [{ url: '/persona/cards/delete', method: 'POST', payload: { id: 'card:default' } }]);
  assert.deepEqual([Object.keys(h.rows()), states[CONFIRM]], [['MOCK-乙卡'], null]);
});

test('card library: without the library the page still edits the persona in force; every card label exists in both dictionaries', async () => {
  const states = page(); states[CARDS] = null;
  const h = await harness(states, call => call.url === '/world' ? worldOf('MOCK-甲', 4) : {});
  assert.ok(!JSON.stringify(h.render()).includes('cardsPanel.'));
  h.nodes(h.render()).find(node => node.type === 'form' && node.props.className === 'bff-stack').props.onSubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(h.calls.map(call => `${call.method} ${call.url}`), ['POST /persona', 'GET /world']);
  const [zh, en] = await Promise.all(['zh', 'en'].map(async name => h.flattenDictionary(JSON.parse(await readFile(new URL(`./locale/${name}.json`, import.meta.url), 'utf8')))));
  const used = [...(await readFile(new URL('./view.js', import.meta.url), 'utf8')).matchAll(/'(cardsPanel\.[A-Za-z]+)'/g)].map(match => match[1]);
  assert.ok(used.length > 20);
  for (const key of used) assert.ok(zh[key] && en[key], key);
  assert.deepEqual(Object.keys(zh).filter(key => key.startsWith('cardsPanel.')).sort(), Object.keys(en).filter(key => key.startsWith('cardsPanel.')).sort());
});

test('card library: a refused save names the field and the rule it broke, in both languages, and never echoes the content', async () => {
  const [zh, en] = await Promise.all(['zh', 'en'].map(async name => JSON.parse(await readFile(new URL(`./locale/${name}.json`, import.meta.url), 'utf8'))));
  let refused = { code: 'VALIDATION_ERROR', message: 'The operation does not match the field requirements', field: 'tags', rule: 'maxItems', limit: 6 };
  const states = page();
  const h = await harness(states, call => call.url === '/persona/cards/update' ? { refused } : {});
  const flat = h.flattenDictionary(zh), t = key => flat[key] ?? key;
  const save = async () => { h.nodes(h.render(t)).find(node => node.type === 'form' && node.props.className === 'bff-stack').props.onSubmit({ preventDefault() {} }); await settled(); };
  const shown = () => h.nodes(h.render(t)).filter(node => node.props.role === 'alert').map(node => h.textOf(node).replace(/\s+/g, ' ').trim()).join(' | ');
  states[DRAFT] = { ...states[DRAFT], name: 'MOCK-甲改' };
  await save();
  assert.ok(shown().includes('标签最多 6 个'), shown());
  assert.ok(!shown().includes(zh.errors.validation_error));
  refused = { ...refused, field: 'summary', rule: 'maxChars', limit: 60 };
  await save();
  assert.ok(shown().includes('简介最多 60 字'), shown());
  refused = { ...refused, field: 'name', rule: 'required', limit: undefined };
  await save();
  assert.ok(shown().includes('名字不能为空'), shown());
  // Without a field (or with one the page does not trust) it is the general message as before.
  for (const bare of [{ code: 'VALIDATION_ERROR' }, { code: 'VALIDATION_ERROR', field: '<b>x</b>', rule: 'maxChars', limit: 6 }, { code: 'VALIDATION_ERROR', field: 'tags', rule: 'whatever' }, { code: 'VALIDATION_ERROR', field: 'tags', rule: 'maxItems' }]) {
    refused = bare;
    await save();
    assert.ok(shown().includes(zh.errors.validation_error), JSON.stringify(bare));
  }
  // Every field and rule Authority can name has its words in both languages.
  for (const locale of [zh, en]) {
    assert.ok(locale.errors.fieldRule.includes('{field}') && locale.errors.fieldRule.includes('{rule}'));
    assert.deepEqual(Object.keys(locale.errors.rules).sort(), ['invalid', 'maxChars', 'maxItems', 'required']);
    assert.deepEqual(Object.keys(locale.errors.fields).sort(), ['boundaries', 'examples', 'identity', 'name', 'persona', 'principles', 'relationshipStage', 'speechStyle', 'summary', 'tag', 'tags', 'title', 'traits', 'userCallName']);
  }
});
