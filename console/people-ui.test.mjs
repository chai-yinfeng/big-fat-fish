import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, spendPayload, maskAccount, validSpend } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const spend = { day: '2026-11-09', timezone: 'Asia/Shanghai', spentYuan: 1.2345, reservedYuan: 0.01, capYuan: 5, percent: 24.9, tier: 'normal', thresholds: { reducedPercent: 60, restrictedPercent: 80, exhaustedPercent: 100 }, byTier: { conversation: 1.2, maintenance: 0.0345, vision: 0, web: 0 }, calls: 3, unreportedUsage: 0, window: 'peak', pricing: 'file' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' }, spend };
const people = { people: [{ personId: 'person:owner', label: 'p-aaaaaa', owner: true, actors: [{ capabilityId: 'qq', externalActorId: 'qq:100:user:123456789' }], conversations: 1 }, { personId: 'person:qq:987654321', label: 'p-bbbbbb', owner: false, actors: [{ capabilityId: 'qq', externalActorId: 'qq:100:user:987654321' }], conversations: 1 }], limit: 40, admitted: 1, qq: { friends: 5 } };
const conversations = [{ capabilityId: 'qq', streamId: 'qq:100:private:987654321', personId: 'person:qq:987654321', audience: 'private', messages: 4, lastAt: 1, memoryEpoch: 2, label: 'p-bbbbbb', owner: false }];

test('people/spend operator paths: GETs stay GET, settings must POST validated numbers', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push([url, options.method]); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  for (const path of ['/people', '/conversations', '/spend']) await operatorRequest({ location, token: 'operator-test', path, fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/spend/settings', payload: spendPayload({ dailyCapYuan: '3', reducedPercent: '50', restrictedPercent: '70' }), fetchImpl });
  assert.deepEqual(seen.map(([url, method]) => `${method} ${url.slice(url.indexOf('3082') + 4)}`), ['GET /people', 'GET /conversations', 'GET /spend', 'POST /spend/settings']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/spend/settings', fetchImpl }), /operator_post_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/people', payload: {}, fetchImpl }), /operator_get_required/);
  assert.deepEqual(spendPayload({ dailyCapYuan: '0.01', reducedPercent: '1', restrictedPercent: '99' }), { dailyCapYuan: 0.01, reducedPercent: 1, restrictedPercent: 99 });
  for (const bad of [{ dailyCapYuan: '0', reducedPercent: '60', restrictedPercent: '80' }, { dailyCapYuan: '5', reducedPercent: '80', restrictedPercent: '80' }, { dailyCapYuan: '5', reducedPercent: '60', restrictedPercent: '100' }, { dailyCapYuan: 'x', reducedPercent: '60', restrictedPercent: '80' }, { dailyCapYuan: '5', reducedPercent: '0', restrictedPercent: '80' }])
    assert.throws(() => spendPayload(bad), error => error.code === 'invalid_spend_settings');
  assert.equal(maskAccount('qq:100:user:987654321'), '98*****21');
  assert.equal(validSpend(spend), true); assert.equal(validSpend({ ...spend, tier: 'x' }), false);
});

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, method: options.method, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: responses(url) }) }; } })
    .then(loaded => {
      const component = loaded.factory(() => React).WorldConsole;
      const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      return { render, nodes, calls };
    });
}

test('overview shows today’s spend and saves validated cap/tier settings', async () => {
  const states = ['operator-test', '', world, {}, 'overview'];
  const { render, nodes, calls } = await harness(states, url => url.endsWith('/world') ? world : spend);
  let tree = render();
  const text = JSON.stringify(tree);
  assert.ok(text.includes('spend.title') && text.includes('¥1.23 / ¥5') && text.includes('spend.tier.normal') && text.includes('spend.window.peak'));
  const inputs = Object.fromEntries(nodes(tree).filter(n => n.type === 'input' && ['dailyCapYuan', 'reducedPercent', 'restrictedPercent'].includes(n.props.name)).map(n => [n.props.name, n]));
  assert.deepEqual(Object.values(inputs).map(n => n.props.value), ['5', '60', '80']);
  inputs.dailyCapYuan.props.onChange({ target: { value: '2.5' } });
  tree = render();
  nodes(tree).find(n => n.type === 'form' && nodes(n).some(c => c.props?.name === 'dailyCapYuan')).props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:3082/spend/settings', method: 'POST', payload: { dailyCapYuan: 2.5, reducedPercent: 60, restrictedPercent: 80 } });
  // Invalid tiers never reach the operator API.
  nodes(render()).find(n => n.type === 'input' && n.props.name === 'reducedPercent').props.onChange({ target: { value: '90' } });
  nodes(render()).find(n => n.type === 'form' && nodes(n).some(c => c.props?.name === 'dailyCapYuan')).props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(calls.filter(c => c.url.endsWith('/spend/settings')).length, 1);
  assert.equal(states[6], 'errors.invalid_spend_settings');
  // Without a gateway the card says so instead of failing the overview.
  states[2] = { ...world, spend: null }; states[22] = null;
  assert.ok(JSON.stringify(render()).includes('spend.unavailable'));
});

test('people page lists admitted people and conversations with opaque labels and masked numbers', async () => {
  const states = ['operator-test', '', world, {}, 'people'];
  states[21] = { ...people, conversations };
  const { render } = await harness(states, () => null);
  const text = JSON.stringify(render());
  assert.ok(text.includes('peoplePanel.owner') && text.includes('p-bbbbbb') && text.includes('98*****21'));
  assert.ok(!text.includes('987654321') && !text.includes('123456789'), 'full QQ numbers are not rendered');
  assert.ok(text.includes('peoplePanel.admitted: 1 / 40') && text.includes('peoplePanel.friends: 5'));
});
