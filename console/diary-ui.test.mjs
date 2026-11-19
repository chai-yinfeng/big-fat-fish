import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';

test('her private diaries are shown one card a day with the persona card; no open column; the forget preview names the diaries', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const diary = (id, day, text, extra = {}) => ({ id, type: 'diary', kind: 'private', status: 'private', revision: 1, v: 2, day, text, cardId: 'card:default', cardTitle: 'MOCK-默认卡', readDiaryIds: [], ...extra });
  const pages = {
    '/memory': { entityId: 'entity:test', memoryEpoch: 0, more: false, people: [], unowned: 0, items: [], diaries: [
      diary('d-2', '2026-11-18', 'MOCK-私密第二天', { cardId: 'card:gone', cardTitle: null }),
      diary('d-1', '2026-11-17', 'MOCK-私密第一天'),
      diary('d-0', '2026-11-16', 'MOCK-私密第零天'),
      { id: 'd-old', type: 'diary', kind: 'private', status: 'private', revision: 1, text: 'MOCK-旧版自动日记正文' },
      { id: 'd-draft', type: 'diary', kind: 'public', status: 'draft', revision: 1, text: 'MOCK-公开草稿' }] },
    '/memory/forget-preview': { entityId: 'entity:test', memoryEpoch: 0, revision: 4, ids: ['d-1'], expandedIds: ['d-1', 'd-2'], digestIds: [], sourceObservationIds: [], diaryIds: ['d-1', 'd-2'], mixedDiaryIds: ['d-2'], mentionDiaryIds: ['d-0'] },
  };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    fetch: async (url, options) => { const route = url.slice(url.indexOf('3082') + 4); calls.push([`${options.method} ${route}`, options.body ? JSON.parse(options.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true, value: pages[route] }) }; } });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const buttons = key => nodes(render()).filter(n => n.type === 'button' && n.children.includes(key));
  assert.ok(!JSON.stringify(render()).includes('MOCK-私密'));
  await buttons('memoryReadExplicitly')[0].props.onClick();
  const articles = nodes(render()).filter(n => n.type === 'article');
  // One card a day, newest first, then the diaries of the old format one by one.
  assert.deepEqual(articles.map(n => nodes(n).find(child => child.type === 'h3')?.children.join('') ?? null), ['diaryPanel.day 2026-11-18', 'diaryPanel.day 2026-11-17', 'diaryPanel.day 2026-11-16', null, null]);
  const [second, first, zero, old, draft] = articles.map(n => JSON.stringify(n));
  assert.ok(second.includes('MOCK-私密第二天') && first.includes('MOCK-私密第一天') && zero.includes('MOCK-私密第零天'));
  for (const card of [second, first, zero]) assert.ok(card.includes('diaryPanel.private') && card.includes('memoryForgetPreview'));
  // The persona card: its name, or its id once the card is gone.
  assert.ok(first.includes('diaryPanel.card: MOCK-默认卡') && second.includes('diaryPanel.card: card:gone'));
  // No open diary is written: nothing about one is shown, not even an empty column.
  assert.ok(!JSON.stringify(render()).includes('diaryPanel.open') && !JSON.stringify(render()).includes('readback'));
  // The old format: marked as the old automatic diary; a public draft keeps its publish button.
  assert.ok(old.includes('MOCK-旧版自动日记正文') && old.includes('diaryPanel.legacy') && old.includes('memoryPrivateDiary'));
  assert.ok(draft.includes('memoryPublicDraft') && draft.includes('memoryPublishDraft') && !draft.includes('diaryPanel.legacy'));
  // Forgetting: how many diaries go, how many of them hold other content, and the ones that may still speak of it.
  await buttons('memoryForgetPreview')[1].props.onClick();
  const dialog = JSON.stringify(nodes(render()).find(n => n.props.role === 'alertdialog'));
  assert.ok(dialog.includes('diaryPanel.forgetDiaries: 2 · diaryPanel.forgetMixed: 1'));
  assert.ok(dialog.includes('diaryPanel.forgetMentions') && dialog.includes('2026-11-16 diaryPanel.private: MOCK-私密第零天'));
  // The owner decides diary by diary: a new preview with that diary added, nothing forgotten yet.
  await buttons('diaryPanel.forgetToo')[0].props.onClick();
  assert.deepEqual(calls.at(-1), ['POST /memory/forget-preview', { entityId: 'entity:test', ids: ['d-1', 'd-0'] }]);
  assert.ok(!calls.some(([route]) => route === 'POST /memory/forget'));
});
