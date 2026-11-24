import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validWake } from './operator-client.js';
import DICTIONARIES from './dictionaries.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
// Hook positions in view.js: the wake-up states are the last three (appended after the memory page's type filter).
const WAKE = 49, DRAFT = 50, OPEN = 51;
const AT = 1794000000000;
const selection = { tier: 'yes', dryRun: true, candidates: [{ person: 'p-0a1b2c', owner: true, weights: { intent: 1, chatter: 1.02, gap: 1, reached: 1, unanswered: 1, newcomer: 1 }, weight: 1.02 }, { person: 'p-3d4e5f', weights: { intent: 4, chatter: 1.02, gap: 1.5, reached: 1, unanswered: 1, newcomer: 0.3 }, weight: 1.836 }],
  excluded: [{ person: 'p-6a7b8c', reason: 'recent' }, { person: 'p-9d0e1f', reason: 'boundary' }], noneWeight: 1, total: 3.856, chance: null, random: 0.5, result: 'p-3d4e5f' };
const entry = (id, extra = {}) => ({ id, type: 'wake', at: AT, endedAt: AT + 4000, reason: 'schedule', outcome: 'done', counts: { wokeToday: 1, sinceLastMs: 10800000, reachedToday: 0, intentPeople: 1, chattedPeople: 2 }, did: { rested: true }, tier: 'none', selection: null, second: null, fuses: [], ...extra });
const view = (extra = {}) => ({ wake: { enabled: true, perDay: 8, perDayMax: 24, intervalMinutes: 180, minGapMinutes: 45 }, nextAt: AT + 10800000, lastWakeAt: AT, out: null, wokeToday: 2, outreach: 'maybe',
  moods: [{ text: 'MOCK 有点想出去走走', at: AT, wakeId: 'w-2', cardId: 'card:default' }], notes: [{ text: 'MOCK 随笔：窗外在下雨', at: AT, wakeId: 'w-2', cardId: 'card:default' }],
  log: [entry('w-3', { did: { outreach: 'yes', rested: false }, tier: 'yes', selection }), entry('w-2', { reason: 'manual', did: { mood: 'accepted', note: 'rejected:sensitive', outreach: 'maybe', rested: false }, tier: 'maybe', selection: { ...selection, tier: 'maybe', chance: { needed: 0.3, roll: 0.7, passed: false }, total: null, random: null, result: 'none' } }),
    entry('w-1'), entry('w-0', { outcome: 'deferred:budget', did: { rested: false }, tier: null }), { type: 'skip', day: '2026-11-07', at: AT - 1, counts: { quiet_hours: 2, busy: 1 } }], ...extra });

function harness(states, responses) {
  const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  return loadConsole({ window: { location, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url: url.slice(url.indexOf('3082') + 4), method: options.method, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: responses(url, options) }) }; } })
    .then(loaded => {
      const { WorldConsole: component, flattenDictionary } = loaded.factory(() => React);
      const render = (t = key => key) => { cursor = 0; refCursor = 0; return component({ t }); };
      const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
      const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
      return { render, nodes, calls, textOf, flattenDictionary };
    });
}
const settled = () => new Promise(resolve => setTimeout(resolve, 5));
const card = (h, tree, title = 'wake.title') => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.nodes(node).some(part => part.type === 'h2' && h.textOf(part).includes(title)));

test('wake paths: the page is a GET, the switch and "wake now" are POSTs; the listing is checked before it is shown', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/initiative', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/wake', payload: {}, fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/settings', payload: { wake: { enabled: true } }, fetchImpl });
  assert.deepEqual(seen, ['GET /initiative', 'POST /initiative/wake {}', 'POST /initiative/settings {"wake":{"enabled":true}}']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/initiative', payload: {}, fetchImpl }), /operator_get_required/);
  for (const path of ['/initiative/wake', '/initiative/settings']) await assert.rejects(operatorRequest({ location, token: 'operator-test', path, fetchImpl }), /operator_post_required/);
  assert.equal(validWake(view()), true);
  for (const bad of [null, {}, { ...view(), wake: { enabled: 'yes', perDay: 8 } }, { ...view(), moods: [{ text: 3, at: AT }] }, { ...view(), notes: null }, { ...view(), log: [{ type: 'other', at: AT }] }, { ...view(), log: [{ type: 'wake' }] }]) assert.equal(validWake(bad), false);
});

test('the card sits on the channels page after the jobs: the switch, the day\'s count, her moods and notes, and the log with what she did', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[WAKE] = view();
  const h = await harness(states, () => null);
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8')));
  const tree = h.render(), titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.equal(titles.indexOf('wake.title'), titles.indexOf('jobs.title') + 1);
  const section = card(h, h.render(key => zh[key] || key), zh['wake.title']), shown = h.textOf(section);
  for (const part of ['已开启', '今天已醒 2 / 8', '她现在的档位 看情况', 'MOCK 有点想出去走走', 'MOCK 随笔：窗外在下雨', '到点但没醒: 安静时段 ×2、QQ 桥上有回合在排队 ×1']) assert.ok(shown.includes(part), part);
  const rows = h.nodes(section).filter(node => node.type === 'table').at(-1).children[1].children.map(row => row.children.slice(1, 4).map(cell => h.textOf(cell).trim()));
  assert.deepEqual(rows, [
    ['到点', '档位改为 想', '想 → p-3d4e5f'],
    ['主人点了“现在醒一次”', '写了心情、写了随笔（被拒收）、档位改为 看情况', '看情况 → 这次不找（没过“看情况”的机会）'],
    ['到点', '休息', '不想 → —'],
    ['到点', '推迟（预算到了降级档（当天不再醒））', '—'],
    ['到点但没醒: 安静时段 ×2、QQ 桥上有回合在排队 ×1'],
  ]);
  // Nothing of a person beyond opaque labels: no account-like number, no conversation ID.
  assert.doesNotMatch(shown, /\d{7,}|private:|person:/);
  // Off, unavailable and empty.
  states[WAKE] = view({ wake: { enabled: false, perDay: 8 }, nextAt: null, moods: [], notes: [], log: [] });
  const off = h.textOf(card(h, h.render()));
  for (const key of ['wake.off', 'wake.noMoods', 'wake.noNotes', 'wake.noLog', 'wake.next —']) assert.ok(off.includes(key), key);
  states[WAKE] = null;
  assert.ok(h.textOf(card(h, h.render())).includes('wake.unavailable'));
  assert.equal(h.nodes(card(h, h.render())).find(node => node.type === 'input'), undefined);
});

test('unfolding a log entry shows the pick worked through: every candidate\'s weights, who was kept out and why, the total, the roll and the result', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[WAKE] = view();
  const h = await harness(states, () => null);
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8'))), t = key => zh[key] || key;
  const unfold = h.nodes(card(h, h.render(t), zh['wake.title'])).filter(node => node.type === 'button' && h.textOf(node).trim() === '展开');
  assert.equal(unfold.length, 4);
  unfold[0].props.onClick();
  assert.equal(states[OPEN], 'w-3');
  const section = card(h, h.render(t), zh['wake.title']), detail = h.nodes(section).filter(node => node.type === 'table').at(-1);
  assert.deepEqual(detail.children[1].children.map(row => row.children.map(cell => h.textOf(cell).trim().replace(/\s+/g, ' '))), [
    ['p-0a1b2c （主人）', '×1', '×1.02', '×1', '×1', '×1', '×1', '1.02'],
    ['p-3d4e5f', '×4', '×1.02', '×1.5', '×1', '×1', '×0.3', '1.836'],
    ['p-6a7b8c', '被排除: 30 分钟内刚聊过'],
    ['p-9d0e1f', '被排除: 对方表达过边界（14 天）'],
    ['这次不找', '', '1'],
  ]);
  const shown = h.textOf(section);
  for (const part of ['只演算，不执行', '总权重 3.856 · 随机数 0.5 · 结果 p-3d4e5f', '她被告知的数: 今天已醒 1 · 今天主动找过的人数 0 · 有到期打算的人数 1 · 今天聊过的人数 2']) assert.ok(shown.includes(part), part);
  // Folding it again; an entry without a pick says so.
  h.nodes(section).find(node => node.type === 'button' && h.textOf(node).trim() === '收起').props.onClick();
  assert.equal(states[OPEN], null);
  states[OPEN] = 'w-1';
  assert.ok(h.textOf(card(h, h.render(t), zh['wake.title'])).includes('档位是“不想”，没有选人。'));
});

test('the switch, the count and "wake now" send what they say and read the page again; a blocked wake-up says why', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[WAKE] = view({ wake: { enabled: false, perDay: 8, perDayMax: 24 } });
  let answer = { scheduledAt: AT, blocked: null };
  const h = await harness(states, (url, options) => options.method === 'POST' ? answer : view());
  const section = () => card(h, h.render());
  h.nodes(section()).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  await settled();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { wake: { enabled: true } } }, { url: '/initiative', method: 'GET', payload: undefined }]);
  assert.equal(states[WAKE].wake.enabled, true);
  // The count: 1..24, sent as a number.
  states[DRAFT] = '6';
  h.nodes(section()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await settled();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { wake: { perDay: 6 } } }, { url: '/initiative', method: 'GET', payload: undefined }]);
  assert.equal(states[DRAFT], '');
  for (const bad of ['0', '25', '2.5', 'x']) { states[DRAFT] = bad; h.nodes(section()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settled(); }
  assert.deepEqual(h.calls.splice(0), []);
  // "Wake now": an empty body, then the page again.
  const press = async () => { h.nodes(section()).find(node => node.type === 'button' && h.textOf(node).includes('wake.now')).props.onClick(); await settled(); };
  await press();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/wake', method: 'POST', payload: {} }, { url: '/initiative', method: 'GET', payload: undefined }]);
  assert.ok(states.includes('wake.asked'));
  answer = { scheduledAt: AT, blocked: 'quiet_hours' }; await press();
  // (This harness has no dictionary: a reason without words shows as its code.)
  assert.ok(states.includes('wake.blockedquiet_hours'));
});

test('wake strings exist in both locales for every reason, outcome, tier and factor Authority can produce', () => {
  assert.deepEqual(Object.keys(DICTIONARIES.en.wake).sort(), Object.keys(DICTIONARIES.zh.wake).sort());
  for (const locale of ['zh', 'en']) {
    const { wake } = DICTIONARIES[locale];
    for (const [group, keys] of Object.entries({ reason: ['schedule', 'intent_due', 'manual'], outcome: ['failed', 'unknown', 'deferred', 'dropped'], tier: ['none', 'maybe', 'yes'], factor: ['intent', 'chatter', 'gap', 'reached', 'unanswered', 'newcomer'], excluded: ['recent', 'boundary'],
      skip: ['off', 'paused', 'quiet_hours', 'budget', 'busy', 'daily_limit', 'fuse:wakes_per_day', 'target', 'expired', 'epoch', 'unsupported'], count: ['wokeToday', 'reachedToday', 'intentPeople', 'chattedPeople'] }))
      for (const key of keys) assert.equal(typeof wake[group][key], 'string', `${locale} ${group}.${key}`);
  }
  assert.match(DICTIONARIES.zh.wake.hint, /不会给任何人发消息/);
});
