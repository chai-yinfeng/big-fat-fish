import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validInitiations, initiationResult } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
const item = (id, status, outcome = null, extra = {}) => ({ id, kind: 'proactive', source: 'poke', person: 'p-0a1b2c', owner: true, status, outcome, createdAt: 1794000000000, issuedAt: null, endedAt: null, ...extra });
// Hook position in view.js: the initiation list is state 32 (after the provider states 30 and 31).
const INITIATIONS = 32;

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url: url.slice(url.indexOf('3082') + 4), method: options.method, body: options.body }); return { ok: true, status: 200, json: async () => ({ ok: true, value: responses(url, options) }) }; } })
    .then(loaded => {
      const { WorldConsole: component, flattenDictionary } = loaded.factory(() => React);
      const render = (t = key => key) => { cursor = 0; refCursor = 0; return component({ t }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      return { render, nodes, calls, textOf, flattenDictionary };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 5));
const card = (h, tree, title = 'initiative.title') => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes(title));

test('initiative paths: the list is a GET, a poke is a POST whose body is empty', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/log', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/poke', payload: {}, fetchImpl });
  assert.deepEqual(seen, ['GET /initiative/log', 'POST /initiative/poke {}']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/initiative/log', payload: {}, fetchImpl }), /operator_get_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/initiative/poke', fetchImpl }), /operator_post_required/);
  assert.equal(validInitiations({ items: [item('a', 'waiting'), item('b', 'closed', 'sent')] }), true);
  for (const bad of [null, {}, { items: [item('a', 'open')] }, { items: [{ ...item('a', 'closed'), outcome: 3 }] }, { items: [{ ...item('a', 'waiting'), createdAt: 'now' }] }]) assert.equal(validInitiations(bad), false);
});

test('how a request stands: a result, and for a void or deferred one the reason it was not sent', () => {
  const shown = (status, outcome) => initiationResult(item('x', status, outcome));
  assert.deepEqual([shown('waiting'), shown('issued')], [{ result: 'waiting', reason: null }, { result: 'issued', reason: null }]);
  assert.deepEqual(['sent', 'partial', 'unknown', 'failed', 'declined'].map(outcome => shown('closed', outcome)), ['sent', 'partial', 'unknown', 'failed', 'declined'].map(result => ({ result, reason: null })));
  assert.deepEqual(shown('closed', 'dropped:quiet_hours'), { result: 'dropped', reason: 'quiet_hours' });
  assert.deepEqual(shown('closed', 'deferred:budget'), { result: 'deferred', reason: 'budget' });
  // A reason is a plain code or it is not shown at all.
  assert.deepEqual(shown('closed', 'dropped:<b>x</b>'), { result: 'dropped', reason: null });
});

test('the card sits on the channels page after the QQ settings: one button, the newest ten requests with result and reason, no account', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[INITIATIONS] = { items: [item('a', 'waiting'), item('b', 'closed', 'sent'), item('c', 'closed', 'dropped:quiet_hours'), item('d', 'closed', 'deferred:budget'), item('e', 'closed', 'unknown'), item('f', 'closed', 'declined'), item('g', 'closed', 'dropped:newer_reason'),
    ...Array.from({ length: 6 }, (_, index) => item('old-' + index, 'closed', 'sent'))] };
  const h = await harness(states, () => null);
  const tree = h.render(), section = card(h, tree);
  const titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.ok(titles.includes('qqTitle'));
  assert.equal(titles.indexOf('initiative.title'), titles.indexOf('qqTitle') + 1);
  const buttons = h.nodes(section).filter(node => node.type === 'button').map(node => h.textOf(node).trim());
  assert.deepEqual(buttons, ['refresh', 'initiative.poke']);
  assert.deepEqual(h.nodes(section).filter(node => ['input', 'select', 'textarea', 'form'].includes(node.type)), []);
  const rowsOf = part => h.nodes(part).filter(node => node.type === 'tr').slice(1).map(row => row.children.slice(1).map(cell => h.textOf(cell).trim()));
  assert.equal(rowsOf(section).length, 10);
  // As the owner reads it (zh): a result, and a reason or a short note; a reason this page has no words for shows as its code.
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8')));
  assert.deepEqual(rowsOf(card(h, h.render(key => zh[key] || key), zh['initiative.title'])).slice(0, 8), [
    ['等待 QQ 桥来取', '最多约一分钟'], ['已送达', '—'], ['作废', '安静时段（23:30–08:00）'], ['推迟', '预算到了降级档'],
    ['状态不明', '平台没有给回执，不会重发'], ['她选择不说', '没有发出任何消息'], ['作废', 'newer_reason'], ['已送达', '—'],
  ]);
  assert.ok(!JSON.stringify(section).includes('p-0a1b2c'));
  // Nothing loaded (an Authority that could not answer) or nothing yet: the card says so, the button stays.
  states[INITIATIONS] = null;
  assert.ok(h.textOf(card(h, h.render())).includes('initiative.unavailable'));
  states[INITIATIONS] = { items: [] };
  assert.ok(h.textOf(card(h, h.render())).includes('initiative.empty') && h.textOf(card(h, h.render())).includes('initiative.poke'));
});

test('the button posts an empty body and reads the list again; the notice tells queued, already open and refused apart', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[INITIATIONS] = { items: [] };
  let answer = item('a', 'waiting');
  const h = await harness(states, (url, options) => options.method === 'POST' ? answer : { items: [answer] });
  const press = async () => { h.nodes(card(h, h.render())).find(node => node.type === 'button' && h.textOf(node).includes('initiative.poke')).props.onClick(); await settled(); };
  await press();
  assert.deepEqual(h.calls, [{ url: '/initiative/poke', method: 'POST', body: '{}' }, { url: '/initiative/log', method: 'GET', body: undefined }]);
  assert.deepEqual(states[INITIATIONS].items.map(entry => entry.id), ['a']);
  assert.ok(states.includes('initiative.queued'));
  answer = { ...item('a', 'issued'), already: true }; await press();
  assert.ok(states.includes('initiative.already'));
  answer = item('b', 'closed', 'dropped:paused'); await press();
  assert.ok(states.includes('initiative.refused'));
});

test('initiative strings exist in both locales for every result and reason Authority and the bridge can produce', async () => {
  for (const locale of ['zh', 'en']) {
    const { initiative, quotaPanel } = JSON.parse(await readFile(new URL(`./locale/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['title', 'hint', 'poke', 'queued', 'already', 'refused', 'unavailable', 'empty']) assert.equal(typeof initiative[key], 'string', `${locale} ${key}`);
    assert.deepEqual(Object.keys(initiative.columns), ['time', 'result', 'reason'], locale);
    assert.deepEqual(Object.keys(initiative.result), ['waiting', 'issued', 'sent', 'partial', 'unknown', 'failed', 'declined', 'dropped', 'deferred'], locale);
    assert.deepEqual(Object.keys(initiative.reason), ['paused', 'expired', 'target', 'epoch', 'quiet_hours', 'person_spoke', 'stale', 'unsupported', 'budget'], locale);
    assert.equal(typeof quotaPanel.rows.proactive, 'string');
  }
});
