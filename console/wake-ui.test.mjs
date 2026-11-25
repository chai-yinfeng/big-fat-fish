import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validWake } from './operator-client.js';
import DICTIONARIES from './dictionaries.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
// Hook positions in view.js: the wake-up states are the last two (appended after the memory page's type filter).
const WAKE = 49, DRAFT = 50;
const AT = 1794000000000;
const entry = (id, extra = {}) => ({ id, type: 'wake', at: AT, endedAt: AT + 4000, reason: 'schedule', outcome: 'done', counts: { cards: 2, excluded: { switch: 1, recent: 1 }, diary: true, mood: true }, did: { rested: true }, reach: [], fuses: [], ...extra });
// An entry as the release before this one logged it: a tier and a pick worked through, no `reach`.
const older = { id: 'w-old', type: 'wake', at: AT - 5, endedAt: AT, reason: 'intent_due', outcome: 'done', counts: { wokeToday: 1, sinceLastMs: null, reachedToday: 0, intentPeople: 1, chattedPeople: 2 }, did: { outreach: 'yes', rested: false }, tier: 'yes', selection: { tier: 'yes', dryRun: true, candidates: [], excluded: [], noneWeight: 1, total: 1, chance: null, random: 0.5, result: 'none' }, second: null, fuses: [] };
const people = [{ person: 'p-0a1b2c', owner: true, enabled: true, lastAt: AT - 3600000, reachedAt: AT - 7200000, unanswered: 0, reached7: 1, openIntents: 0 }, { person: 'p-3d4e5f', owner: false, enabled: false, lastAt: AT - 86400000, reachedAt: null, unanswered: 0, reached7: 0, openIntents: 2 }];
const view = (extra = {}) => ({ wake: { enabled: true, times: ['10:00', '19:00'], maxTimes: 2, jitterMinutes: 30 }, reach: { enabled: true, recentMinutes: 30, fuses: { per_day: 20, per_person_day: 4, per_person_week: 12, per_hour: 3 }, people }, fuse: null,
  nextAt: AT + 10800000, lastWakeAt: AT, out: null, wokeToday: 2,
  moods: [{ text: 'MOCK 有点想出去走走', at: AT, wakeId: 'w-2', cardId: 'card:default' }], notes: [{ text: 'MOCK 随笔：窗外在下雨', at: AT, wakeId: 'w-2', cardId: 'card:default' }],
  log: [entry('w-3', { did: { mood: 'accepted', reach: 2, rested: false }, reach: [{ person: 'p-0a1b2c', owner: true, check: 'accepted', reason: 'MOCK 想问问近况', initiationId: 'i-1', outcome: 'sent' }, { person: 'p-3d4e5f', check: 'rejected:sensitive:health' }] }),
    entry('w-2', { reason: 'manual', did: { note: 'rejected:sensitive', reach: 2, rested: false }, reach: [{ person: 'p-3d4e5f', check: 'accepted', reason: 'MOCK 另一个人提到的事', initiationId: 'i-2', outcome: null }, { person: null, check: 'rejected:not_candidate' }], fuses: ['fuse:per_hour'] }),
    entry('w-1b', { did: { reach: 1, rested: false }, reach: [{ person: 'p-3d4e5f', check: 'accepted', reason: 'MOCK 想聊聊', initiationId: 'i-3', outcome: 'dropped:person_spoke' }] }),
    entry('w-1'), entry('w-0', { outcome: 'deferred:budget', did: { rested: false } }), older, { type: 'skip', day: '2026-11-07', at: AT - 10, counts: { quiet_hours: 2, 'fuse:per_hour': 1 } }], ...extra });

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
const squeezed = text => text.replace(/\s+/g, ' ').trim();

test('wake paths: the page is a GET, the switches and "wake now" are POSTs; the listing is checked before it is shown', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/initiative', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/wake', payload: {}, fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/initiative/settings', payload: { wake: { enabled: true } }, fetchImpl });
  assert.deepEqual(seen, ['GET /initiative', 'POST /initiative/wake {}', 'POST /initiative/settings {"wake":{"enabled":true}}']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/initiative', payload: {}, fetchImpl }), /operator_get_required/);
  for (const path of ['/initiative/wake', '/initiative/settings']) await assert.rejects(operatorRequest({ location, token: 'operator-test', path, fetchImpl }), /operator_post_required/);
  assert.equal(validWake(view()), true);
  assert.equal(validWake(view({ fuse: { name: 'per_hour', at: AT } })), true);
  const bad = [null, {}, { ...view(), wake: { enabled: 'yes', times: ['10:00'] } }, { ...view(), wake: { enabled: true, perDay: 8 } }, { ...view(), wake: { enabled: true, times: ['10'] } }, { ...view(), reach: undefined }, { ...view(), reach: { enabled: true, people: [{ person: 'person:qq:1', enabled: true }] } },
    { ...view(), reach: { enabled: true, people: [{ person: 'p-0a1b2c' }] } }, { ...view(), fuse: {} }, { ...view(), moods: [{ text: 3, at: AT }] }, { ...view(), notes: null }, { ...view(), log: [{ type: 'other', at: AT }] }, { ...view(), log: [{ type: 'wake' }] }];
  for (const value of bad) assert.equal(validWake(value), false, JSON.stringify(value)?.slice(0, 120));
});

test('the card sits on the channels page after the jobs: both switches, the times, each person\'s switch, her moods and notes, and the log with whom she named and what became of it', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[WAKE] = view();
  const h = await harness(states, () => null);
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8')));
  const tree = h.render(), titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.equal(titles.indexOf('wake.title'), titles.indexOf('jobs.title') + 1);
  const section = card(h, h.render(key => zh[key] || key), zh['wake.title']), shown = squeezed(h.textOf(section));
  for (const part of ['让她自己醒来：已开启 · 允许她主动找人：已开启', '今天已醒 2', '时间点 10:00、19:00（±30 分钟）', 'MOCK 有点想出去走走', 'MOCK 随笔：窗外在下雨']) assert.ok(shown.includes(part), part);
  const tables = h.nodes(section).filter(node => node.type === 'table'), cells = table => table.children[1].children.map(row => row.children.map(cell => squeezed(h.textOf(cell))));
  // Each person: the label, the switch, counts.
  assert.deepEqual(cells(tables[0]).map(row => [row[0], ...row.slice(4)]), [['p-0a1b2c （主人）', '0', '1', '0'], ['p-3d4e5f', '0', '0', '2']]);
  assert.deepEqual(h.nodes(tables[0]).filter(node => node.type === 'input').map(node => node.props.checked), [true, false]);
  // The log: cards given, what she did, and for each person she named the check, her reason and the outcome.
  assert.deepEqual(cells(tables.at(-1)).map(row => row.slice(1)), [
    ['到点', '2（没出卡： 开关关着 ×1、刚聊过 ×1）', '写了心情、点名人数 2', 'p-0a1b2c （主人） ： 通过 → 已发出 · 理由“MOCK 想问问近况” p-3d4e5f ： 没通过（理由涉及健康）'],
    ['主人点了“现在醒一次”', '2（没出卡： 开关关着 ×1、刚聊过 ×1）', '写了随笔（被拒收）、点名人数 2', 'p-3d4e5f ： 通过 → 等待发出 · 理由“MOCK 另一个人提到的事” ? ： 没通过（不是这次小卡上的人）'],
    ['到点', '2（没出卡： 开关关着 ×1、刚聊过 ×1）', '点名人数 1', 'p-3d4e5f ： 通过 → 没有发出（作废（对方先说话了）） · 理由“MOCK 想聊聊”'],
    ['到点', '2（没出卡： 开关关着 ×1、刚聊过 ×1）', '休息', '没有点名任何人'],
    ['到点', '2（没出卡： 开关关着 ×1、刚聊过 ×1）', '推迟（预算到了降级档（当天不再醒））', '没有点名任何人'],
    ['有打算到期（旧版本）', '—', '—', '旧版本记录（当时只演算、不发送）'],
    ['没醒成或保险命中: 安静时段 ×2、保险：全局每小时次数 ×1'],
  ]);
  // Nothing of a person beyond opaque labels: no account-like number, no conversation ID.
  assert.doesNotMatch(shown, /\d{7,}|private:|person:/);
  // A fuse hit today is said at the top.
  states[WAKE] = view({ fuse: { name: 'per_hour', at: AT } });
  assert.ok(squeezed(h.textOf(card(h, h.render(key => zh[key] || key), zh['wake.title']))).includes('保险已触发，今天不再醒来、不再主动找人（明天自动恢复）：保险：全局每小时次数'));
  // Off, unavailable and empty.
  states[WAKE] = view({ wake: { enabled: false, times: ['10:00', '19:00'] }, reach: { enabled: false, people: [] }, nextAt: null, moods: [], notes: [], log: [] });
  const off = h.textOf(card(h, h.render()));
  for (const key of ['wake.off', 'wake.noPeople', 'wake.noMoods', 'wake.noNotes', 'wake.noLog', 'wake.next —']) assert.ok(off.includes(key), key);
  states[WAKE] = null;
  assert.ok(h.textOf(card(h, h.render())).includes('wake.unavailable'));
  assert.equal(h.nodes(card(h, h.render())).find(node => node.type === 'input'), undefined);
});

test('the switches, a person\'s switch, the times and "wake now" send what they say and read the page again; a blocked wake-up says why', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[WAKE] = view({ wake: { enabled: false, times: ['10:00', '19:00'], maxTimes: 2 }, reach: { enabled: false, people } });
  let answer = { scheduledAt: AT, blocked: null };
  const h = await harness(states, (url, options) => options.method === 'POST' ? answer : view());
  const section = () => card(h, h.render());
  const boxes = () => h.nodes(section()).filter(node => node.type === 'input' && node.props.type === 'checkbox');
  const reread = { url: '/initiative', method: 'GET', payload: undefined };
  boxes()[0].props.onChange({ target: { checked: true } }); await settled();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { wake: { enabled: true } } }, reread]);
  boxes()[1].props.onChange({ target: { checked: true } }); await settled();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { reach: { enabled: true } } }, reread]);
  // One person's switch names that person by the opaque label and nothing else.
  boxes()[3].props.onChange({ target: { checked: true } }); await settled();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { reach: { people: { 'p-3d4e5f': true } } } }, reread]);
  // The times: one or two HH:MM, sent as given.
  const submit = async draft => { states[DRAFT] = draft; h.nodes(section()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settled(); };
  await submit('09:30，20:15');
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/settings', method: 'POST', payload: { wake: { times: ['09:30', '20:15'] } } }, reread]);
  assert.equal(states[DRAFT], '');
  for (const bad of ['9:30', '25:00', '10:00 10:00', '08:00, 12:00, 19:00', 'x', ' ']) await submit(bad);
  assert.deepEqual(h.calls.splice(0), []);
  // "Wake now": an empty body, then the page again.
  const press = async () => { h.nodes(section()).find(node => node.type === 'button' && h.textOf(node).includes('wake.now')).props.onClick(); await settled(); };
  await press();
  assert.deepEqual(h.calls.splice(0), [{ url: '/initiative/wake', method: 'POST', payload: {} }, reread]);
  assert.ok(states.includes('wake.asked'));
  answer = { scheduledAt: AT, blocked: 'quiet_hours' }; await press();
  // (This harness has no dictionary: a reason without words shows as its code.)
  assert.ok(states.includes('wake.blockedquiet_hours'));
});

test('wake strings exist in both locales for every reason, outcome, check and refusal Authority can produce', () => {
  const keys = value => typeof value === 'string' ? [] : Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner).map(sub => `${key}.${sub}`)]);
  assert.deepEqual(keys(DICTIONARIES.en.wake).sort(), keys(DICTIONARIES.zh.wake).sort());
  for (const locale of ['zh', 'en']) {
    const { wake } = DICTIONARIES[locale];
    for (const [group, names] of Object.entries({ reason: ['schedule', 'manual'], outcome: ['failed', 'unknown', 'deferred', 'dropped'], check: ['accepted', 'rejected'], sent: ['waiting', 'sent', 'partial', 'declined', 'none'],
      excluded: ['reach_off', 'switch', 'boundary', 'recent', 'budget', 'fuse', 'target'],
      rejected: ['not_candidate', 'duplicate', 'empty', 'too_long', 'sensitive', 'unsafe_text', 'sensitive:health', 'sensitive:finance', 'sensitive:romance', 'sensitive:account', 'sensitive:quote', 'wake_not_done', 'reach_off', 'switch', 'boundary', 'budget', 'fuse', 'target', 'fuse:per_day', 'fuse:per_person_day', 'fuse:per_person_week', 'fuse:per_hour'],
      skip: ['off', 'paused', 'quiet_hours', 'budget', 'busy', 'missed', 'fuse', 'fuse:wakes_per_day', 'fuse:per_day', 'fuse:per_person_day', 'fuse:per_person_week', 'fuse:per_hour', 'fuse:messages_per_turn', 'target', 'expired', 'epoch', 'unsupported', 'person_spoke', 'reach_off', 'switch', 'boundary', 'fuse_messages'],
      person: ['person', 'allowed', 'lastAt', 'reachedAt', 'unanswered', 'reached7', 'openIntents'] }))
      for (const key of names) assert.equal(typeof wake[group][key], 'string', `${locale} ${group}.${key}`);
  }
  assert.match(DICTIONARIES.zh.wake.hint, /看不到任何人的小卡，也不会给任何人发消息/);
});
