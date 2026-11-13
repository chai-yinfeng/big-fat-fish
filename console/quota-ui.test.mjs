import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, limitsPayload, validUsage, validUsageHistory } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const spend = { day: '2026-11-12', timezone: 'Asia/Shanghai', spentYuan: 1.2345, reservedYuan: 0, capYuan: 5, percent: 24.7, tier: 'normal', thresholds: { reducedPercent: 60, restrictedPercent: 80, exhaustedPercent: 100 }, byTier: { conversation: 1.2, maintenance: 0.0195, vision: 0.01, web: 0.005 }, calls: 3, unreportedUsage: 0, window: 'peak', pricing: 'file', tokens: { requests: 12, cacheHit: 30000, cacheMiss: 10000, output: 4321, reasoning: 3000 } };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' }, spend };
const row = (id, title, kind, extra = {}) => ({ id, title, kind, unit: kind === 'paid' && !['vision', 'web'].includes(id) ? 'requests' : 'calls', used: 0, limit: null, limitDefault: null, calls: 0, ok: 0, failed: 0, denied: {}, units: {}, busyMs: 0, costYuan: 0, spendCategory: null, stopTier: null, ...extra });
const usage = { day: '2026-11-12', timezone: 'Asia/Shanghai', rows: [
  row('chat', '聊天', 'paid', { used: 14, calls: 14, ok: 13, failed: 1, units: { inputTokens: 40000, outputTokens: 4321 }, busyMs: 42000, costYuan: 1.2, denied: { spend_tier: 2 }, spendCategory: 'conversation', stopTier: 'exhausted' }),
  row('consolidation', '后台整合', 'paid', { used: 3, calls: 3, ok: 3, busyMs: 9000, costYuan: 0.0195, spendCategory: 'maintenance', stopTier: 'restricted' }),
  row('vision', '看图', 'paid', { used: 12, limit: 12, limitDefault: 12, calls: 12, ok: 12, busyMs: 18000, costYuan: 0.12, denied: { daily_limit: 3, spend_tier: 1 }, spendCategory: 'vision', stopTier: 'restricted' }),
  row('web', '联网', 'paid', { used: 1, limit: 7, limitDefault: 20, calls: 1, ok: 1, busyMs: 800, costYuan: 0.005, spendCategory: 'web', stopTier: 'restricted' }),
  row('speech-tts', '语音合成', 'local', { used: 2, calls: 2, ok: 2, units: { chars: 25, audioSeconds: 4.7 }, busyMs: 9400 }),
  row('speech-asr', '语音识别', 'local', { used: 3, calls: 3, ok: 2, failed: 1, units: { audioSeconds: 20 }, busyMs: 3000 }),
] };
const history = { timezone: 'Asia/Shanghai', days: [
  { day: '2026-11-11', rows: { vision: { used: 5, limit: 12, calls: 5, ok: 4, failed: 1, denied: { paused: 1 }, units: {}, busyMs: 5000, costYuan: 0.05 }, chat: { used: 30, limit: null, calls: 30, ok: 30, failed: 0, denied: {}, units: { inputTokens: 90000, outputTokens: 9000 }, busyMs: 60000, costYuan: 2.5 } } },
  { day: '2026-11-10', rows: { chat: { used: 2, limit: null, calls: 2, ok: 2, failed: 0, denied: {}, units: {}, busyMs: 3000, costYuan: 0.1 } } },
] };
const consolidation = { day: '2026-11-12', calls: 3, limits: { perDay: 24, perStreamPerDay: 2 }, paused: null, streams: [], staleDigestIds: [] };
// Hook positions in view.js: quota, the open row, its history and the limit drafts are states 26–29.
const QUOTA = 26, OPEN = 27, HISTORY = 28;

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

test('usage operator paths: reads stay GET, a limit must POST a whole number of 0–1000 or null', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  for (const path of ['/usage', '/usage/history']) await operatorRequest({ location, token: 'operator-test', path, fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/usage/limits', payload: limitsPayload('vision', '8'), fetchImpl });
  assert.deepEqual(seen, ['GET /usage', 'GET /usage/history', 'POST /usage/limits']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/usage/limits', fetchImpl }), /operator_post_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/usage', payload: {}, fetchImpl }), /operator_get_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/usage/history', query: { days: 7 }, fetchImpl }), /operator_query_unsupported/);
  assert.deepEqual([limitsPayload('vision', '8'), limitsPayload('web', 0), limitsPayload('web', null)], [{ limits: { vision: 8 } }, { limits: { web: 0 } }, { limits: { web: null } }]);
  for (const bad of ['', ' ', '-1', '1001', '1.5', 'x', undefined]) assert.throws(() => limitsPayload('vision', bad), error => error.code === 'invalid_usage_limit', String(bad));
  assert.equal(validUsage(usage), true); assert.equal(validUsage({ ...usage, rows: [{ ...usage.rows[0], kind: 'x' }] }), false); assert.equal(validUsage({ ...usage, rows: [{ ...usage.rows[0], used: 'x' }] }), false);
  assert.equal(validUsageHistory(history), true); assert.equal(validUsageHistory({ days: [{ day: 1, rows: {} }] }), false);
});

test('quota page: the day’s spend on top with tier marks, then one row per capability with usage, cost, time, refusals and status', async () => {
  const states = ['operator-test', '', world, {}, 'quota'];
  states[QUOTA] = { usage, spend, consolidation };
  const { render, nodes, textOf } = await harness(states, () => null);
  // `t` returns the key here; a unit or reason without a string of its own is shown by its code.
  const tree = render(), text = JSON.stringify(tree);
  // Spend bar: amount, percent, price window, cache hit rate, the two tier marks.
  assert.ok(text.includes('¥1.23 / ¥5 (24.7%)') && text.includes('spend.window.peak') && text.includes('spend.tokens.hitRate 75%') && text.includes('spend.tier.normal'));
  assert.deepEqual(nodes(tree).filter(n => n.type === 'b').map(n => n.props.style.left), ['60%', '80%']);
  const table = nodes(tree).find(n => n.type === 'table');
  const cells = Object.fromEntries(nodes(table).filter(n => n.type === 'tr' && n.children[0]?.type === 'td').map(n => { const values = n.children.map(textOf).map(value => value.replace(/\s+/g, ' ').trim()); return [values[0], values.slice(1, 7)]; }));
  assert.deepEqual(Object.keys(cells), ['聊天', '后台整合', '看图', '联网', '语音合成', '语音识别'], 'one row per capability, in the ledger’s order, and no row for anything else');
  assert.deepEqual(cells['聊天'], ['quotaPanel.kind.paid', '14 inputTokens 40,000 · outputTokens 4,321', '¥1.20', 'quotaPanel.average 3 s', 'quotaPanel.denied 2 · quotaPanel.failed 1', 'quotaPanel.status.normal']);
  assert.deepEqual(cells['后台整合'], ['quotaPanel.kind.paid', '3 quotaPanel.batches 3 / 24', '¥0.0195', 'quotaPanel.average 3 s', '—', 'quotaPanel.status.normal']);
  assert.deepEqual(cells['看图'], ['quotaPanel.kind.paid', '12 / 12', '¥0.1200', 'quotaPanel.average 1.5 s', 'quotaPanel.denied 4', 'quotaPanel.status.limitReached']);
  assert.deepEqual(cells['联网'], ['quotaPanel.kind.paid', '1 / 7', '¥0.0050', 'quotaPanel.average 800 ms', '—', 'quotaPanel.status.normal']);
  assert.deepEqual(cells['语音合成'], ['quotaPanel.kind.local', '2 chars 25 · audioSeconds 4.7', '—', 'quotaPanel.average 4.7 s · quotaPanel.total 9.4 s · quotaPanel.realtime 2×', '—', 'quotaPanel.status.local']);
  assert.deepEqual(cells['语音识别'], ['quotaPanel.kind.local', '3 audioSeconds 20', '—', 'quotaPanel.average 1 s · quotaPanel.total 3 s · quotaPanel.realtime 0.15×', 'quotaPanel.failed 1', 'quotaPanel.status.local']);
  for (const absent of ['video', '视频', '主动', '生图', '唱歌']) assert.ok(!text.includes(absent), `no placeholder row for ${absent}`);
  // Spend tiers: maintenance, vision and web stop at "restricted", chat at 100%; a used-up count still says so.
  states[QUOTA] = { usage, spend: { ...spend, tier: 'restricted' }, consolidation };
  const status = () => Object.fromEntries(nodes(nodes(render()).find(n => n.type === 'table')).filter(n => n.type === 'tr' && n.children[0]?.type === 'td').map(n => [textOf(n.children[0]).trim(), textOf(n.children[6]).trim()]));
  assert.deepEqual(status(), { '聊天': 'quotaPanel.status.normal', '后台整合': 'quotaPanel.status.stopped.restricted', '看图': 'quotaPanel.status.limitReached', '联网': 'quotaPanel.status.stopped.restricted', '语音合成': 'quotaPanel.status.local', '语音识别': 'quotaPanel.status.local' });
  states[QUOTA] = { usage, spend: { ...spend, tier: 'exhausted' }, consolidation: { ...consolidation, paused: 'daily' } };
  assert.deepEqual([status()['聊天'], status()['后台整合']], ['quotaPanel.status.stopped.exhausted', 'quotaPanel.status.limitReached']);
  // Without spend or consolidation the table still shows.
  states[QUOTA] = { usage, spend: null, consolidation: null };
  const bare = JSON.stringify(render());
  assert.ok(bare.includes('spend.unavailable') && bare.includes('语音识别') && !bare.includes('quotaPanel.batches'));
  states[QUOTA] = null;
  assert.ok(JSON.stringify(render()).includes('quotaPanel.pending'));
});

test('quota page: a row opens to its refusals by reason and the last 7 days; only a row with a daily limit can be changed', async () => {
  const states = ['operator-test', '', world, {}, 'quota'];
  states[QUOTA] = { usage, spend, consolidation };
  const changed = { ...usage, rows: usage.rows.map(item => item.id === 'vision' ? { ...item, limit: 20 } : item) };
  const { render, nodes, calls, textOf } = await harness(states, (url, options) => url.endsWith('/usage/history') ? history : options.method === 'POST' ? changed : null);
  const openButton = name => nodes(nodes(render()).find(n => n.type === 'table')).filter(n => n.type === 'tr' && n.children[0]?.type === 'td').find(n => textOf(n.children[0]).trim() === name).children[7].children[0];
  openButton('看图').props.onClick();
  await settled();
  assert.deepEqual(calls, [{ url: '/usage/history', method: 'GET', payload: undefined }]);
  assert.equal(states[OPEN], 'vision'); assert.deepEqual(states[HISTORY], history);
  let tree = render(), detail = nodes(tree).find(n => n.props.className === 'bff-quota-detail'), text = textOf(detail).replace(/\s+/g, ' ');
  assert.ok(text.includes('quotaPanel.deniedToday: daily_limit 3 · spend_tier 1'), text);
  // History: only the days this capability was used.
  const days = nodes(detail).filter(n => n.type === 'tr' && n.children[0]?.type === 'td').map(n => n.children.map(textOf).map(value => value.trim()));
  assert.deepEqual(days, [['2026-11-11', '5 / 12', '4 / 1', '¥0.0500', 'quotaPanel.average 1 s', 'paused 1']]);
  // The limit: shown with its default, saved through POST /usage/limits, and the table takes the answer.
  const input = () => nodes(render()).find(n => n.type === 'input' && n.props.name === 'limit-vision');
  assert.equal(input().props.value, '12');
  input().props.onChange({ target: { value: '20' } });
  nodes(render()).find(n => n.type === 'form' && nodes(n).some(c => c.props?.name === 'limit-vision')).props.onSubmit({ preventDefault() {} });
  await settled();
  assert.deepEqual(calls[1], { url: '/usage/limits', method: 'POST', payload: { limits: { vision: 20 } } });
  assert.equal(states[QUOTA].usage.rows.find(item => item.id === 'vision').limit, 20);
  assert.equal(input().props.value, '20');
  // A limit that differs from the default can be reset; an invalid one never reaches the operator API.
  const reset = nodes(render()).filter(n => n.type === 'button').find(n => textOf(n).includes('quotaPanel.limitReset'));
  reset.props.onClick();
  await settled();
  assert.deepEqual(calls[2], { url: '/usage/limits', method: 'POST', payload: { limits: { vision: null } } });
  input().props.onChange({ target: { value: '2000' } });
  nodes(render()).find(n => n.type === 'form' && nodes(n).some(c => c.props?.name === 'limit-vision')).props.onSubmit({ preventDefault() {} });
  await settled();
  assert.equal(calls.length, 3);
  assert.equal(states[6], 'errors.invalid_usage_limit');
  // Chat has no daily limit of its own: its detail has history and no limit form; the history is not read twice.
  openButton('聊天').props.onClick();
  await settled();
  detail = nodes(render()).find(n => n.props.className === 'bff-quota-detail');
  assert.ok(!nodes(detail).some(n => n.type === 'input'));
  assert.deepEqual(nodes(detail).filter(n => n.type === 'tr' && n.children[0]?.type === 'td').map(n => textOf(n.children[0]).trim()), ['2026-11-11', '2026-11-10']);
  assert.equal(calls.filter(call => call.url === '/usage/history').length, 1);
  // A capability never used before: an empty history says so.
  openButton('语音合成').props.onClick();
  assert.ok(textOf(nodes(render()).find(n => n.props.className === 'bff-quota-detail')).includes('quotaPanel.historyEmpty'));
  // Closing the open row.
  openButton('语音合成').props.onClick();
  assert.equal(states[OPEN], null);
});

test('quota page strings exist in both locales, for every row, unit, reason and status the ledger can send', async () => {
  for (const locale of ['zh', 'en']) {
    const panel = JSON.parse(await readFile(new URL(`./locale/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(typeof panel.quota, 'string');
    assert.deepEqual(Object.keys(panel.quotaPanel.rows), ['chat', 'consolidation', 'vision', 'web', 'speech-tts', 'speech-asr', 'proactive', 'demo'], locale);
    assert.deepEqual(Object.keys(panel.quotaPanel.reason), ['daily_limit', 'spend_tier', 'paused', 'quiet_hours', 'cooldown', 'not_configured', 'busy', 'blocked'], locale);
    assert.deepEqual(Object.keys(panel.quotaPanel.units), ['inputTokens', 'outputTokens', 'chars', 'audioSeconds'], locale);
    assert.deepEqual(Object.keys(panel.quotaPanel.status.stopped), ['reduced', 'restricted', 'exhausted'], locale);
    assert.equal(typeof panel.errors.invalid_usage_limit, 'string');
  }
});
