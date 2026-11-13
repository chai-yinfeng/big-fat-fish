import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, providerKeyPayload, validProviders } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const KEY = 'MOCK-PROVIDER-KEY-not-a-real-key';
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
const deepseek = { id: 'deepseek', title: 'DeepSeek', configured: true, operations: [], managed: 'model' };
const mock = configured => ({ id: 'mock', title: 'MOCK provider', configured, operations: [{ name: 'mock.generate', mode: 'async' }], managed: 'providers' });
// Hook positions in view.js: the provider list and the row awaiting a confirmed clear are states 30 and 31.
const PROVIDERS = 30, CLEAR = 31;

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
/** The provider card of a rendered runtime page, and its rows by provider title. */
function card(h, tree) {
  const section = h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes('providerKeys.title'));
  const rows = Object.fromEntries(h.nodes(section).filter(node => String(node.props.className).includes('bff-list-row')).map(node => [h.textOf(node.children[0]), node]));
  return { section, rows };
}

test('provider key paths: the list is a GET, a key or a clear must POST, and a key is sent as typed without spaces', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/providers', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/providers/key', payload: providerKeyPayload('mock', KEY), fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/providers/clear', payload: { provider: 'mock' }, fetchImpl });
  assert.deepEqual(seen, ['GET /providers', 'POST /providers/key', 'POST /providers/clear']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/providers', payload: {}, fetchImpl }), /operator_get_required/);
  for (const path of ['/providers/key', '/providers/clear']) await assert.rejects(operatorRequest({ location, token: 'operator-test', path, fetchImpl }), /operator_post_required/);
  assert.deepEqual(providerKeyPayload('mock', `  ${KEY}\n`), { provider: 'mock', apiKey: KEY });
  for (const bad of ['', '   ', 'has space', undefined, null, '密钥']) assert.throws(() => providerKeyPayload('mock', bad), error => error.code === 'invalid_provider_key', String(bad));
  assert.throws(() => providerKeyPayload('', KEY), error => error.code === 'invalid_provider_key');
  assert.equal(validProviders({ providers: [deepseek, mock(false)] }), true);
  for (const bad of [null, {}, { providers: [{ ...deepseek, configured: 'yes' }] }, { providers: [{ ...deepseek, managed: 'x' }] }]) assert.equal(validProviders(bad), false);
});

test('provider keys card: only the providers the gateway lists, DeepSeek pointing at the model form, no placeholder rows', async () => {
  const states = ['operator-test', '', world, {}, 'runtime'];
  states[PROVIDERS] = [deepseek];
  const h = await harness(states, () => null);
  let { section, rows } = card(h, h.render());
  // A release: DeepSeek alone, shown as configured, with no input and no button of its own.
  assert.deepEqual(Object.keys(rows), ['DeepSeek']);
  assert.ok(h.textOf(rows.DeepSeek).includes('providerKeys.configured') && h.textOf(rows.DeepSeek).includes('providerKeys.modelManaged'));
  assert.deepEqual(h.nodes(section).filter(node => ['input', 'button', 'form'].includes(node.type)), []);
  for (const absent of ['OpenAI', 'MiniMax', 'Replicate', 'Seedream', 'Seedance', '火山']) assert.ok(!JSON.stringify(section).includes(absent), `no placeholder row for ${absent}`);
  // The card follows the model card on the settings page.
  const titles = h.nodes(h.render()).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.equal(titles.indexOf('providerKeys.title'), titles.indexOf('model') + 1);
  // The gateway could not be asked: the card says so and the page still shows.
  states[PROVIDERS] = null;
  ({ section } = card(h, h.render()));
  assert.ok(h.textOf(section).includes('providerKeys.unavailable') && JSON.stringify(h.render()).includes('modelSave'));
});

test('provider keys card: a key is typed into a password field that is emptied on sending, and clearing takes two clicks', async () => {
  const states = ['operator-test', '', world, {}, 'runtime'];
  states[PROVIDERS] = [deepseek, mock(false)];
  let stored = false;
  const h = await harness(states, (url, options) => {
    if (url.endsWith('/providers/key')) { stored = true; return { provider: 'mock', configured: true }; }
    if (url.endsWith('/providers/clear')) { stored = false; return { provider: 'mock', configured: false }; }
    return { providers: [deepseek, mock(stored)] };
  });
  let { rows } = card(h, h.render());
  assert.deepEqual(Object.keys(rows), ['DeepSeek', 'MOCK provider']);
  const row = rows['MOCK provider'], input = h.nodes(row).find(node => node.type === 'input'), form = () => h.nodes(card(h, h.render()).rows['MOCK provider']).find(node => node.type === 'form');
  assert.ok(h.textOf(row).includes('providerKeys.missing') && h.textOf(row).includes('providerKeys.save') && !h.textOf(row).includes('providerKeys.clear'));
  // Not echoed: a password field with no value bound to state.
  assert.deepEqual([input.props.type, input.props.autoComplete, 'value' in input.props, 'defaultValue' in input.props], ['password', 'off', false, false]);
  const field = { value: `${KEY} ` };
  input.props.ref(field);
  form().props.onSubmit({ preventDefault() {} });
  await settled();
  assert.deepEqual(h.calls.map(call => [call.method, call.url, call.payload]), [['POST', '/providers/key', { provider: 'mock', apiKey: KEY }], ['GET', '/providers', undefined]]);
  assert.equal(field.value, '');
  // Nothing the page keeps or draws afterwards contains the key.
  assert.ok(!JSON.stringify(states).includes('MOCK-PROVIDER-KEY') && !JSON.stringify(h.render()).includes('MOCK-PROVIDER-KEY'));
  ({ rows } = card(h, h.render()));
  assert.ok(h.textOf(rows['MOCK provider']).includes('providerKeys.configured') && h.textOf(rows['MOCK provider']).includes('providerKeys.replace'));
  // Clear: the first click only asks; the second sends.
  const buttons = () => h.nodes(card(h, h.render()).rows['MOCK provider']).filter(node => node.type === 'button' && node.props.type === 'button');
  assert.deepEqual(buttons().map(node => h.textOf(node).trim()), ['providerKeys.clear']);
  buttons()[0].props.onClick();
  assert.deepEqual([states[CLEAR], h.calls.length, buttons().map(node => h.textOf(node).trim())], ['mock', 2, ['providerKeys.clearConfirm']]);
  buttons()[0].props.onClick();
  await settled();
  assert.deepEqual(h.calls.slice(2).map(call => [call.method, call.url, call.payload]), [['POST', '/providers/clear', { provider: 'mock' }], ['GET', '/providers', undefined]]);
  assert.deepEqual([states[CLEAR], h.textOf(card(h, h.render()).rows['MOCK provider']).includes('providerKeys.missing')], [null, true]);
  // An empty field is refused in the browser; nothing is sent.
  const empty = { value: '   ' };
  h.nodes(card(h, h.render()).rows['MOCK provider']).find(node => node.type === 'input').props.ref(empty);
  form().props.onSubmit({ preventDefault() {} });
  await settled();
  assert.equal(h.calls.length, 4);
});
