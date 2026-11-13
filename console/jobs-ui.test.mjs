import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, validJobs, jobNotice } from './operator-client.js';

const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' };
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' }, spend: null };
const job = (id, status, extra = {}) => ({ id: 'job:' + id, capability: 'demo', title: '演示任务', status, failureCode: null, progress: null, person: 'p-0a1b2c', owner: true, createdAt: 1794000000000, notice: { state: 'none', outcome: null, at: 1 }, result: null, ...extra });
// Hook position in view.js: the initiation list is state 32, the job list follows it.
const INITIATIONS = 32, JOBS = 33;

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
const card = (h, tree, title = 'jobs.title') => h.nodes(tree).find(node => node.type === 'section' && node.props.className === 'bff-card' && h.textOf(node).includes(title));

test('job paths: the list is a GET; registering the demo job and cancelling are POSTs', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)} ${options.body ?? ''}`.trim()); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  await operatorRequest({ location, token: 'operator-test', path: '/jobs', fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/jobs/demo', payload: {}, fetchImpl });
  await operatorRequest({ location, token: 'operator-test', path: '/jobs/cancel', payload: { id: 'job:a' }, fetchImpl });
  assert.deepEqual(seen, ['GET /jobs', 'POST /jobs/demo {}', 'POST /jobs/cancel {"id":"job:a"}']);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/jobs', payload: {}, fetchImpl }), /operator_get_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/jobs/demo', fetchImpl }), /operator_post_required/);
  assert.equal(validJobs({ jobs: [job('a', 'queued'), job('b', 'done', { result: 'MOCK' })] }), true);
  for (const bad of [null, {}, { jobs: [{ ...job('a', 'done'), notice: null }] }, { jobs: [{ ...job('a', 'done'), createdAt: 'now' }] }, { jobs: [{ ...job('a', 'done'), result: 7 }] }]) assert.equal(validJobs(bad), false);
});

test('how telling the person stands: a state, and for a held or void one the reason', () => {
  const shown = (state, outcome = null) => jobNotice(job('x', 'done', { notice: { state, outcome, at: 1 } }));
  assert.deepEqual([shown('none'), shown('pending'), shown('issued')], [{ state: 'none', reason: null }, { state: 'pending', reason: null }, { state: 'issued', reason: null }]);
  assert.deepEqual([shown('carry', 'deferred:budget'), shown('carry', 'dropped:paused'), shown('carry', 'failed')], [{ state: 'carry', reason: 'budget' }, { state: 'carry', reason: 'paused' }, { state: 'carry', reason: 'failed' }]);
  assert.deepEqual(['sent', 'carried', 'unknown', 'declined', 'expired'].map(outcome => shown('closed', outcome)), ['sent', 'carried', 'unknown', 'declined', 'expired'].map(state => ({ state, reason: null })));
  assert.deepEqual(shown('closed', 'dropped:epoch'), { state: 'dropped', reason: 'epoch' });
  // A reason is a plain code or it is not shown at all.
  assert.deepEqual(shown('closed', 'dropped:<b>x</b>'), { state: 'dropped', reason: null });
});

test('the card sits on the channels page after "she speaks first": one button, the newest ten jobs with state, refusal reason, telling and result, no account; completions stay out of the try-once list', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[INITIATIONS] = { items: [{ id: 'i-1', kind: 'completion', source: 'job', person: 'p-0a1b2c', owner: true, status: 'closed', outcome: 'carried', createdAt: 1794000000000, issuedAt: null, endedAt: null }, { id: 'i-2', kind: 'proactive', source: 'poke', person: 'p-0a1b2c', owner: true, status: 'closed', outcome: 'sent', createdAt: 1794000000000, issuedAt: null, endedAt: null }] };
  states[JOBS] = { limits: { queued: 8, perPerson: 2 }, jobs: [
    job('a', 'running', { progress: { stage: 'wait', percent: 40 } }), job('b', 'queued'),
    job('c', 'done', { result: 'MOCK-RESULT', notice: { state: 'closed', outcome: 'sent', at: 1 } }), job('d', 'done', { result: 'MOCK-RESULT', notice: { state: 'carry', outcome: 'deferred:budget', at: 1 } }),
    job('e', 'done', { result: 'MOCK-RESULT', notice: { state: 'closed', outcome: 'carried', at: 1 } }), job('f', 'rejected', { failureCode: 'daily_limit' }), job('g', 'rejected', { failureCode: 'busy' }),
    job('h', 'failed', { failureCode: 'timeout', notice: { state: 'pending', outcome: null, at: 1 } }), job('i', 'done', { notice: { state: 'closed', outcome: 'dropped:epoch', at: 1 } }), job('j', 'cancelled'),
    job('old', 'done', { result: 'MOCK-OLD' })] };
  const h = await harness(states, () => null);
  const tree = h.render(), section = card(h, tree);
  const titles = h.nodes(tree).filter(node => node.type === 'h2').map(node => h.textOf(node));
  assert.equal(titles.indexOf('jobs.title'), titles.indexOf('initiative.title') + 1);
  // One action and a cancel per job still waiting or running; no field to name anybody.
  assert.deepEqual(h.nodes(section).filter(node => node.type === 'button').map(node => h.textOf(node).trim()), ['refresh', 'jobs.demo', 'jobs.cancel', 'jobs.cancel']);
  assert.deepEqual(h.nodes(section).filter(node => ['input', 'select', 'textarea', 'form'].includes(node.type)), []);
  const zh = h.flattenDictionary(JSON.parse(await readFile(new URL('./locale/zh.json', import.meta.url), 'utf8')));
  const squeeze = value => value.replace(/\s+/g, ' ').trim();
  const rows = h.nodes(card(h, h.render(key => zh[key] || key), zh['jobs.title'])).filter(node => node.type === 'tr').slice(1).map(row => row.children.slice(2, 5).map(cell => squeeze(h.textOf(cell))));
  assert.deepEqual(rows, [
    ['运行中 40%', '—', '—'], ['排队中', '—', '—'],
    ['完成', '她已开口告诉', 'MOCK-RESULT'], ['完成', '随你的下一条消息带上（预算到了降级档）', 'MOCK-RESULT'],
    ['完成', '已随你的消息带上', 'MOCK-RESULT'], ['被拒 今日次数已用完', '—', '—'], ['被拒 队列已满或你已有 2 个任务', '—', '—'],
    ['失败 某一步超时', '等她开口，或随你的下一条消息', '—'], ['完成', '作废（会话已换代（有内容被忘记））', '—'], ['已取消', '—', '—'],
  ]);
  assert.ok(!JSON.stringify(section).includes('p-0a1b2c'));
  // A completion is shown with its job, not in the try-once list.
  const tries = h.nodes(card(h, tree, 'initiative.title')).filter(node => node.type === 'tr').slice(1);
  assert.equal(tries.length, 1);
  // Nothing loaded or nothing yet: the card says so, the button stays.
  states[JOBS] = null;
  assert.ok(h.textOf(card(h, h.render())).includes('jobs.unavailable') && h.textOf(card(h, h.render())).includes('jobs.demo'));
  states[JOBS] = { jobs: [] };
  assert.ok(h.textOf(card(h, h.render())).includes('jobs.empty'));
});

test('the button posts an empty body and reads the list again; a refusal is told with its reason; cancel names the job only', async () => {
  const states = ['operator-test', '', world, {}, 'channels'];
  states[JOBS] = { jobs: [] };
  let answer = { id: 'job:a', capability: 'demo', status: 'queued', failureCode: null };
  const h = await harness(states, (url, options) => options.method === 'POST' ? answer : { jobs: [job('a', answer.status, { failureCode: answer.failureCode })] });
  const press = async label => { h.nodes(card(h, h.render())).find(node => node.type === 'button' && h.textOf(node).includes(label)).props.onClick(); await settled(); };
  await press('jobs.demo');
  assert.deepEqual(h.calls, [{ url: '/jobs/demo', method: 'POST', body: '{}' }, { url: '/jobs', method: 'GET', body: undefined }]);
  assert.ok(states.includes('jobs.queued'));
  await press('jobs.cancel');
  assert.deepEqual(h.calls.slice(2), [{ url: '/jobs/cancel', method: 'POST', body: '{"id":"job:a"}' }, { url: '/jobs', method: 'GET', body: undefined }]);
  answer = { id: 'job:b', capability: 'demo', status: 'rejected', failureCode: 'daily_limit' }; await press('jobs.demo');
  assert.ok(states.includes('jobs.refusedjobs.code.daily_limit') || states.includes('jobs.refuseddaily_limit'));
});

test('job strings exist in both locales for every state, refusal and ending the services can produce', async () => {
  for (const locale of ['zh', 'en']) {
    const { jobs, quotaPanel } = JSON.parse(await readFile(new URL(`./locale/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['title', 'hint', 'demo', 'queued', 'refused', 'unavailable', 'empty', 'cancel']) assert.equal(typeof jobs[key], 'string', `${locale} ${key}`);
    assert.deepEqual(Object.keys(jobs.columns), ['time', 'job', 'status', 'notice', 'result', 'action'], locale);
    assert.deepEqual(Object.keys(jobs.status), ['queued', 'running', 'done', 'failed', 'expired', 'cancelled', 'rejected'], locale);
    assert.deepEqual(Object.keys(jobs.code), ['busy', 'daily_limit', 'timeout', 'deadline', 'interrupted', 'failed'], locale);
    assert.deepEqual(Object.keys(jobs.notice), ['none', 'pending', 'carry', 'issued', 'sent', 'partial', 'unknown', 'declined', 'carried', 'expired', 'dropped', 'closed'], locale);
    assert.deepEqual(Object.keys(jobs.reason), ['paused', 'expired', 'quiet_hours', 'budget', 'person_spoke', 'stale', 'failed', 'target', 'epoch', 'forgotten', 'unsupported'], locale);
    assert.equal(typeof quotaPanel.rows.demo, 'string');
  }
});
