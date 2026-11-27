import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validGroups, callNamesPayload } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
// Visibly fake group numbers.
const G1 = '999900009001', G2 = '999900009002', G3 = '999900009003';
const row = (groupId, state, extra = {}) => ({ capabilityId: 'qq', groupId, name: 'MOCK-群' + groupId.slice(-1), memberCount: 5, present: true, state, members: state === 'none' ? 0 : 3, messages: state === 'none' ? 0 : 12, lastReplyAt: state === 'none' ? null : 1794000000000, digests: state === 'none' ? 0 : 2, ...extra });
const listing = (groups, extra = {}) => ({ available: true, settings: { callNames: ['小鱼'] }, groups, ...extra });
// Hook position in view.js: the group states follow the card import awaiting confirmation (52).
const GROUPS = 53, CONFIRM = 54, NAMES = 55;

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, btoa, URLSearchParams,
    fetch: async (url, options) => { const path = url.slice(url.indexOf('3082') + 4); calls.push({ url: path, method: options.method, body: options.body }); const answer = responses(path, options); return answer?.refuse ? { ok: false, status: answer.status, json: async () => ({ ok: false, error: answer.refuse }) } : { ok: true, status: 200, json: async () => ({ ok: true, value: answer }) }; } })
    .then(loaded => {
      const { WorldConsole: component } = loaded.factory(() => React);
      const render = (t = key => key) => { cursor = 0; refCursor = 0; return component({ t }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      return { render, nodes, calls, textOf };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 10));
const card = (h, tree) => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes('groups.title'));
const plain = value => JSON.parse(JSON.stringify(value));
const page = list => { const states = ['operator-test', '', world, {}, 'channels']; states[GROUPS] = list; return states; };
const buttons = (h, part) => h.nodes(part).filter(node => node.type === 'button');

test('group paths: the list is a GET, every change a POST; the answers and the names are checked before use', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  const ask = (path, payload) => operatorRequest({ location, token: 'operator-test', path, payload, fetchImpl });
  await ask('/groups'); await ask('/groups/enable', { capabilityId: 'qq', groupId: G1 }); await ask('/groups/disable', { capabilityId: 'qq', groupId: G1 }); await ask('/groups/settings', { callNames: [] });
  assert.deepEqual(seen, ['GET /groups', `POST /groups/enable {"capabilityId":"qq","groupId":"${G1}"}`, `POST /groups/disable {"capabilityId":"qq","groupId":"${G1}"}`, 'POST /groups/settings {"callNames":[]}']);
  await assert.rejects(ask('/groups', {}), /operator_get_required/);
  for (const path of ['/groups/enable', '/groups/disable', '/groups/settings']) await assert.rejects(ask(path), /operator_post_required/);
  await assert.rejects(ask('/groups/leave', {}), /unsupported_operator_path/);
  // A refusal carries which condition failed, as a fixed word only.
  const refusing = reason => operatorRequest({ location, token: 'operator-test', path: '/groups/enable', payload: {}, fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'CONFLICT', reason } }) }) });
  await assert.rejects(refusing('owner_absent'), error => error.code === 'revision_conflict' && error.reason === 'owner_absent');
  await assert.rejects(refusing('<b>群号 999900009001</b>'), error => error.code === 'revision_conflict' && error.reason === undefined);
  assert.equal(validGroups(listing([row(G1, 'enabled'), row(G2, 'none', { memberCount: null }), row(G3, 'disabled', { present: false, name: '' })])), true);
  for (const bad of [null, {}, listing([{ ...row(G1, 'enabled'), state: 'on' }]), listing([{ ...row(G1, 'enabled'), groupId: 'x' }]), listing([row(G1, 'none')], { settings: { callNames: 'x' } }), listing([row(G1, 'none')], { available: 'yes' })]) assert.equal(validGroups(bad), false);
  assert.deepEqual(callNamesPayload(' 小鱼，肥鱼, 小鱼、Ｆｉｓｈ酱\n'), { callNames: ['小鱼', '肥鱼', 'Fish酱'] });
  assert.deepEqual(callNamesPayload(''), { callNames: [] });
  for (const bad of ['鱼', '小鱼,鱼', '一二三四五六七八九十十一十二十三', Array.from({ length: 9 }, (_, i) => 'MOCK名' + i).join(',')]) assert.throws(() => callNamesPayload(bad), { code: 'invalid_call_names' }, bad);
});

test('the card: one row a group with its state and what is recorded; enable asks first, disable does not; a group she left has no button', async () => {
  const h = await harness(page(listing([row(G1, 'enabled'), row(G2, 'none'), row(G3, 'disabled'), row('999900009004', 'disabled', { present: false, name: '' })])), () => null);
  const tree = h.render(), section = card(h, tree);
  const titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  // Below the QQ settings and above the sticker library.
  assert.ok(titles.indexOf('groups.title') > titles.indexOf('qqTitle') && titles.indexOf('groups.title') < titles.indexOf('stickers.title'));
  const rows = h.nodes(section).filter(node => node.type === 'tr').slice(1).map(tr => tr.children.map(cell => h.textOf(cell).replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rows.map(cells => [cells[0], cells[1], cells[2], cells[4]]), [
    [`MOCK-群1 ${G1}`, '5', 'groups.states.enabled', 'groups.disable'], [`MOCK-群2 ${G2}`, '5', 'groups.states.none', 'groups.enable'],
    [`MOCK-群3 ${G3}`, '5', 'groups.states.disabled', 'groups.enable'], ['groups.left 999900009004', '5', 'groups.states.disabled', '']]);
  assert.match(rows[0][3], /^groups\.members 3 · groups\.digests 2 · groups\.lastReply /);
  assert.equal(rows[1][3], '—');
  // There is no way to leave a group here, and no confirmation box until a group is picked.
  assert.deepEqual(buttons(h, section).map(node => h.textOf(node).trim()), ['refresh', 'groups.disable', 'groups.enable', 'groups.enable', 'groups.saveNames']);
  assert.equal(h.nodes(section).filter(node => node.props.role === 'alertdialog').length, 0);
});

test('enabling: the confirmation says the three things it means, and only its button posts; a refusal says which condition failed', async () => {
  const states = page(listing([row(G2, 'none')]));
  let answer = listing([row(G2, 'enabled')]);
  const h = await harness(states, path => path === '/groups/enable' ? answer : null);
  buttons(h, card(h, h.render())).find(node => h.textOf(node).trim() === 'groups.enable').props.onClick();
  assert.deepEqual([states[CONFIRM], h.calls.length], [G2, 0], 'asking first sends nothing');
  const dialog = h.nodes(card(h, h.render())).find(node => node.props.role === 'alertdialog');
  assert.deepEqual(h.nodes(dialog).filter(node => node.type === 'li').map(node => h.textOf(node)), ['groups.confirm1', 'groups.confirm2', 'groups.confirm3']);
  assert.ok(h.textOf(dialog).includes('MOCK-群2') && h.textOf(dialog).includes('groups.confirmNote'));
  // Cancel closes it without a request.
  buttons(h, dialog).find(node => h.textOf(node).trim() === 'groups.cancel').props.onClick();
  assert.deepEqual([states[CONFIRM], h.calls.length], [null, 0]);
  states[CONFIRM] = G2;
  buttons(h, h.nodes(card(h, h.render())).find(node => node.props.role === 'alertdialog')).find(node => h.textOf(node).trim() === 'groups.confirmEnable').props.onClick();
  await settled();
  assert.deepEqual(h.calls.map(call => [call.url, call.method, call.body]), [['/groups/enable', 'POST', JSON.stringify({ capabilityId: 'qq', groupId: G2 })]]);
  assert.deepEqual([plain(states[GROUPS]).groups[0].state, states[CONFIRM]], ['enabled', null]);
  // Refused: the list stays as it was and the page says why.
  states[GROUPS] = listing([row(G3, 'none')]); states[CONFIRM] = G3;
  answer = { status: 409, refuse: { code: 'CONFLICT', reason: 'owner_absent' } };
  buttons(h, h.nodes(card(h, h.render())).find(node => node.props.role === 'alertdialog')).find(node => h.textOf(node).trim() === 'groups.confirmEnable').props.onClick();
  await settled();
  assert.equal(plain(states[GROUPS]).groups[0].state, 'none');
  assert.ok(h.nodes(h.render()).some(node => h.textOf(node).includes('groups.refused.owner_absent')));
});

test('disabling posts at once; her other names are checked here before they are sent; without an answer the card says so', async () => {
  const states = page(listing([row(G1, 'enabled')]));
  const h = await harness(states, (path, options) => path === '/groups/disable' ? listing([row(G1, 'disabled')]) : path === '/groups/settings' ? listing([row(G1, 'disabled')], { settings: JSON.parse(options.body) }) : null);
  buttons(h, card(h, h.render())).find(node => h.textOf(node).trim() === 'groups.disable').props.onClick();
  await settled();
  assert.deepEqual([h.calls.map(call => call.url), plain(states[GROUPS]).groups[0].state], [['/groups/disable'], 'disabled']);
  // The names: shown as saved, the save button only once they were changed.
  let section = card(h, h.render());
  const field = () => h.nodes(card(h, h.render())).find(node => node.type === 'input');
  assert.deepEqual([field().props.value, buttons(h, section).at(-1).props.disabled], ['小鱼', true]);
  field().props.onChange({ target: { value: '小鱼，鱼' } });
  h.nodes(card(h, h.render())).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await settled();
  assert.equal(h.calls.length, 1, 'a one-character name is not sent');
  assert.ok(h.nodes(h.render()).some(node => h.textOf(node).includes('errors.invalid_call_names')));
  field().props.onChange({ target: { value: '小鱼，肥鱼' } });
  h.nodes(card(h, h.render())).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await settled();
  assert.deepEqual([h.calls.at(-1).url, h.calls.at(-1).body, plain(states[GROUPS]).settings, states[NAMES]], ['/groups/settings', '{"callNames":["小鱼","肥鱼"]}', { callNames: ['小鱼', '肥鱼'] }, null]);
  // Nothing read (an older Authority): the card says so and offers nothing. The bridge unreachable: no enabling.
  states[GROUPS] = null;
  section = card(h, h.render());
  assert.ok(h.textOf(section).includes('groups.unavailable'));
  assert.deepEqual(buttons(h, section).map(node => h.textOf(node).trim()), ['refresh']);
  states[GROUPS] = listing([row(G1, 'enabled', { present: false }), row(G2, 'none')], { available: false });
  section = card(h, h.render());
  assert.ok(h.textOf(section).includes('groups.bridgeDown'));
  assert.deepEqual(buttons(h, section).map(node => h.textOf(node).trim()), ['refresh', 'groups.disable', 'groups.saveNames']);
});

test('group strings exist in both locales, for every state and every reason a group can be refused for', async () => {
  for (const name of ['zh', 'en']) {
    const locale = JSON.parse(await readFile(new URL(`locale/${name}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(locale.groups.states).sort(), ['disabled', 'enabled', 'none']);
    assert.deepEqual(Object.keys(locale.groups.refused).sort(), ['not_in_group', 'not_logged_in', 'owner_absent', 'too_large']);
    for (const key of ['title', 'hint', 'confirm1', 'confirm2', 'confirm3', 'confirmNote', 'callNamesHint']) assert.ok(locale.groups[key].length > 0, key);
    assert.ok(locale.errors.invalid_call_names);
    assert.doesNotMatch(locale.qqPrivateHint, /不开放群|Groups are not enabled/);
  }
});
