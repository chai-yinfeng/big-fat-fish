import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';

test('memory and private diaries load only on explicit read; forgetting requires preview and pause', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 1, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const memory = { entityId: 'entity:test', memoryEpoch: 0, items: [{ id: 'm1', type: 'facts', status: 'active', key: 'preference', value: 'synthetic preference' }], diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'synthetic private diary' }] };
  const preview = { entityId: memory.entityId, memoryEpoch: 0, revision: 4, ids: ['m1'], expandedIds: ['m1', 'd1'], sourceObservationIds: ['o1'] };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [], writes = [];
  let cursor = 0, refCursor = 0, component, loaded;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem() {} };
  loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: url.endsWith('/forget-preview') ? preview : url.endsWith('/world') ? world : memory }) }; } });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  assert.equal(calls.length, 0); assert.equal(JSON.stringify(render()).includes('synthetic private diary'), false);
  await button('memoryReadExplicitly').props.onClick();
  assert.equal(JSON.stringify(render()).includes('synthetic private diary'), true);
  await button('memoryForgetPreview').props.onClick();
  assert.equal(calls.some(c => c.url.endsWith('/memory/forget')), false);
  states[2] = { ...world, world: { ...world.world, paused: false } };
  assert.equal(button('memoryForgetConfirm').props.disabled, true);
  states[2] = world;
  await button('memoryForgetConfirm').props.onClick();
  assert.deepEqual(calls.find(c => c.url.endsWith('/memory/forget')).payload, { entityId: 'entity:test', ids: ['m1'], expectedMemoryEpoch: 0, expectedRevision: 4 });
  assert.equal(states[7], 'memoryCleanupPending'); assert.equal(writes.length, 0);
  button('overview').props.onClick(); assert.equal(states[10], null); assert.equal(states[11], null);
});

test('memory page is read-only about provenance: owner filter, older pages, opaque owner labels and source marks', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 3, notes: 1, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  // Synthetic data; the raw person ID carries a visibly fake account number that must never be rendered.
  const item = (id, revision, extra) => ({ id, revision, type: 'facts', status: 'active', key: 'MOCK-键', value: `MOCK-值-${id}`, visibility: 'private', personId: 'person:qq:999900000011', personLabel: 'p-aaaaaa', personIsOwner: false, source: { channel: 'qq', role: 'user', proposal: 'fact.report' }, evidence: { actorId: 'qq:999900000001:user:999900000011' }, ...extra });
  const people = [{ label: 'p-0f0f0f', owner: true, items: 1 }, { label: 'p-aaaaaa', owner: false, items: 2 }];
  const pages = {
    '/memory': { entityId: 'entity:test', memoryEpoch: 0, more: true, people, unowned: 1, diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'MOCK-私密日记' }],
      items: [item('m3', 30, { personId: 'person:owner', personLabel: 'p-0f0f0f', personIsOwner: true, visibility: 'public' }), item('m2', 20)] },
    '/memory?beforeRevision=20': { entityId: 'entity:test', memoryEpoch: 0, more: false, people, unowned: 1, diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'MOCK-私密日记' }],
      items: [item('m1', 10), item('m0', 5, { type: 'notes', kind: 'learning', key: undefined, value: undefined, text: 'MOCK-学习笔记', personId: undefined, personLabel: null, source: { channel: 'reader', role: 'external', proposal: 'learning.note' } }), item('old', 1, { personLabel: null, personId: undefined, source: { channel: null, role: null, proposal: null } })] },
    '/memory?person=p-aaaaaa': { entityId: 'entity:test', memoryEpoch: 0, more: false, people, unowned: 1, diaries: [], items: [item('m2', 20), item('m1', 10)] },
  };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    fetch: async (url, options) => { const route = url.slice(url.indexOf('3082') + 4); calls.push(`${options.method} ${route}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: pages[route] }) }; } });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  const cards = () => nodes(render()).filter(n => n.type === 'article').map(n => JSON.stringify(n));
  const settle = () => new Promise(setImmediate);
  assert.equal(nodes(render()).some(n => n.type === 'select'), false, 'no filter before the explicit read');
  await button('memoryReadExplicitly').props.onClick();
  // Ownership (opaque label / owner / public) and source on every item.
  let shown = cards();
  assert.ok(shown[0].includes('peoplePanel.owner') && shown[0].includes('memoryPanel.public') && shown[0].includes('memoryPanel.source: memoryPanel.role.user · memoryPanel.proposal.fact · qq'));
  assert.ok(shown[1].includes('p-aaaaaa') && !shown[1].includes('memoryPanel.public') && !shown[1].includes('peoplePanel.owner'));
  const options = () => nodes(render()).find(n => n.type === 'select').children.filter(Boolean).map(n => [n.props.value, n.children.join('')]);
  assert.deepEqual(options(), [['', 'memoryPanel.all'], ['p-0f0f0f', 'peoplePanel.owner (1)'], ['p-aaaaaa', 'p-aaaaaa (2)'], ['none', 'memoryPanel.unowned (1)']]);
  // Older page: appended after what is shown, cursor = the oldest revision on screen; then nothing more to load.
  await button('memoryPanel.loadMore').props.onClick();
  shown = cards();
  assert.deepEqual(shown.filter(card => card.includes('MOCK-值-')).map(card => /MOCK-值-(\w+)/.exec(card)[1]), ['m3', 'm2', 'm1', 'old']);
  const learning = shown.find(card => card.includes('MOCK-学习笔记')), old = shown.find(card => card.includes('MOCK-值-old'));
  assert.ok(learning.includes('memoryPanel.unowned') && learning.includes('memoryPanel.source: memoryPanel.role.external · memoryPanel.proposal.learning · reader'));
  assert.ok(old.includes('memoryPanel.source: memoryPanel.sourceUnknown'));
  assert.equal(button('memoryPanel.loadMore'), undefined);
  assert.ok(JSON.stringify(render()).includes('memoryPanel.shown: 5'));
  // Filter by owner: one more read with the opaque label; diaries are not part of a filtered view.
  nodes(render()).find(n => n.type === 'select').props.onChange({ target: { value: 'p-aaaaaa' } });
  await settle();
  assert.equal(nodes(render()).find(n => n.type === 'select').props.value, 'p-aaaaaa');
  assert.ok(cards().every(card => card.includes('p-aaaaaa')) && cards().length === 2 && !JSON.stringify(render()).includes('MOCK-私密日记'));
  // Read-only: three GETs, the label and cursor are the only query, and no account number is ever rendered.
  assert.deepEqual(calls, ['GET /memory', 'GET /memory?beforeRevision=20', 'GET /memory?person=p-aaaaaa']);
  assert.ok(!JSON.stringify(render()).includes('9999') && !JSON.stringify(render()).includes('person:'));
  // Leaving the page drops the loaded memory and the filter.
  button('overview').props.onClick(); assert.equal(states[10], null); assert.equal(states[23], '');
});

test('memory queries carry only an opaque owner label and a page cursor', async () => {
  const { operatorRequest, memoryQuery } = await import('./operator-client.js');
  assert.deepEqual([memoryQuery(), memoryQuery({ person: 'none' }), memoryQuery({ person: 'p-0a1b2c', beforeRevision: 7 })], ['', '?person=none', '?person=p-0a1b2c&beforeRevision=7']);
  for (const bad of [{ person: 'person:qq:999900000011' }, { person: '999900000011' }, { beforeRevision: -1 }, { beforeRevision: 1.5 }]) assert.throws(() => memoryQuery(bad), /invalid_memory_query/);
  const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) });
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/memory/forget', payload: {}, query: { person: 'none' }, fetchImpl }), /operator_query_unsupported/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/people', query: {}, fetchImpl }), /operator_query_unsupported/);
});
