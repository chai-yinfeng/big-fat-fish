import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest } from './operator-client.js';
import DICTIONARIES from './dictionaries.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = conversation => ({ world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null, ...(conversation === undefined ? {} : { conversation }) });

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url: url.slice(url.indexOf('3082') + 4), method: options.method, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: responses(url, options) }) }; } })
    .then(loaded => {
      const component = loaded.factory(() => React).WorldConsole;
      const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      return { render, nodes, calls, textOf };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 5));
const card = (h, tree) => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes('thinking.title'));

test('everyday-chat thinking: off by default, one checkbox on the settings page sends the switch, and the page follows Authority', async () => {
  let current = { chatThinking: false };
  const states = ['operator-test', '', world(current), {}, 'runtime'];
  const h = await harness(states, url => {
    if (url.endsWith('/conversation/settings')) return current;
    return world(current);
  });
  let section = card(h, h.render());
  assert.ok(h.textOf(section).includes('thinking.off') && h.textOf(section).includes('thinking.hint'));
  const box = () => h.nodes(card(h, h.render())).find(node => node.type === 'input');
  assert.deepEqual([box().props.type, box().props.checked], ['checkbox', false]);
  current = { chatThinking: true };
  box().props.onChange({ target: { checked: true } });
  await settled();
  assert.deepEqual(h.calls.map(call => [call.method, call.url, call.payload]), [['POST', '/conversation/settings', { chatThinking: true }], ['GET', '/world', undefined]]);
  section = card(h, h.render());
  assert.ok(h.textOf(section).includes('thinking.on'));
  assert.equal(box().props.checked, true);
  // An older Authority sends no setting: the card says so and offers nothing to click.
  states[2] = world(undefined);
  section = card(h, h.render());
  assert.ok(h.textOf(section).includes('thinking.unavailable'));
  assert.equal(h.nodes(section).find(node => node.type === 'input'), undefined);
});

test('the switch path must POST, and its words say why it is off (Chinese and English)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) });
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/conversation/settings', fetchImpl }), /operator_post_required/);
  await operatorRequest({ location, token: 'operator-test', path: '/conversation/settings', payload: { chatThinking: false }, fetchImpl });
  assert.match(DICTIONARIES.zh.thinking.hint, /关掉省钱，日常聊天通常不需要/);
  assert.deepEqual(Object.keys(DICTIONARIES.en.thinking).sort(), Object.keys(DICTIONARIES.zh.thinking).sort());
});
