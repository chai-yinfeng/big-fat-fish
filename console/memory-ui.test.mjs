import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('memory and private diaries load only on explicit read; forgetting requires preview and pause', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 1, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const memory = { entityId: 'entity:test', memoryEpoch: 0, items: [{ id: 'm1', type: 'facts', status: 'active', key: 'preference', value: 'synthetic preference' }], diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'synthetic private diary' }] };
  const preview = { entityId: memory.entityId, memoryEpoch: 0, revision: 4, ids: ['m1'], expandedIds: ['m1', 'd1'], sourceObservationIds: ['o1'] };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [], writes = [];
  let cursor = 0, refCursor = 0, component, loaded;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem() {} };
  vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), { window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage, __ModuleLoader__: { load: value => { loaded = value; } } }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: url.endsWith('/forget-preview') ? preview : url.endsWith('/world') ? world : memory }) }; } });
  loaded.factory(() => React).apply({ effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key }, slots: { inject: (_key, fn) => fn(), register: (_options, value) => { component = value; } } });
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
  button('overview').props.onClick(); assert.equal(states[12], null); assert.equal(states[13], null);
});
