import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';

test('her diaries are shown one card a day with the persona card, an open one with whose it is; old public drafts are marked old; the forget preview names the diaries', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const diary = (id, day, text, extra = {}) => ({ id, type: 'diary', kind: 'private', status: 'private', revision: 1, v: 2, day, text, cardId: 'card:default', cardTitle: 'MOCK-默认卡', readDiaryIds: [], ...extra });
  const pages = {
    '/memory': { entityId: 'entity:test', memoryEpoch: 0, more: false, people: [], unowned: 0, items: [], diaries: [
      diary('d-2', '2026-11-18', 'MOCK-私密第二天', { cardId: 'card:gone', cardTitle: null }),
      diary('o-2', '2026-11-18', 'MOCK-明面给主人', { kind: 'open', status: 'open', personLabel: 'p-0a0a0a', personIsOwner: true }),
      diary('o-3', '2026-11-18', 'MOCK-明面给朋友', { kind: 'open', status: 'open', personLabel: 'p-1b1b1b', personIsOwner: false }),
      diary('d-1', '2026-11-17', 'MOCK-私密第一天'),
      diary('d-0', '2026-11-16', 'MOCK-私密第零天'),
      { id: 'd-old', type: 'diary', kind: 'private', status: 'private', revision: 1, text: 'MOCK-旧版自动日记正文' },
      { id: 'd-draft', type: 'diary', kind: 'public', status: 'draft', revision: 1, text: 'MOCK-公开草稿' }] },
    '/diary/open': { entityId: 'entity:test', people: [
      { personId: 'person:owner', label: 'p-0a0a0a', owner: true, listed: true, hasCode: true, codeAt: 1_800_000_000_000, diaries: 3, lastDay: '2026-11-18' },
      { personId: 'person:qq:999900000011', label: 'p-1b1b1b', owner: false, listed: false, hasCode: false, codeAt: null, diaries: 0, lastDay: null }] },
    '/diary/open/listed': { entityId: 'entity:test', people: [
      { personId: 'person:owner', label: 'p-0a0a0a', owner: true, listed: true, hasCode: true, codeAt: 1_800_000_000_000, diaries: 3, lastDay: '2026-11-18' },
      { personId: 'person:qq:999900000011', label: 'p-1b1b1b', owner: false, listed: true, hasCode: false, codeAt: null, diaries: 0, lastDay: null }] },
    '/diary/open/code': { entityId: 'entity:test', personId: 'person:owner', label: 'p-0a0a0a', code: 'mockcd22', codeAt: 1_800_000_000_001 },
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
  // The open diaries of a day sit in that day's card, each with whose it is (the owner badge or the opaque label) and its card.
  const openParts = nodes(articles[0]).filter(n => n.type === 'div' && ['o-2', 'o-3'].includes(n.props.key)).map(n => JSON.stringify(n));
  assert.equal(openParts.length, 2);
  assert.ok(openParts[0].includes('MOCK-明面给主人') && openParts[0].includes('diaryPanel.for') && openParts[0].includes('peoplePanel.owner') && openParts[0].includes('diaryPanel.card: MOCK-默认卡') && openParts[0].includes('memoryForgetPreview'));
  assert.ok(openParts[1].includes('MOCK-明面给朋友') && openParts[1].includes('p-1b1b1b') && !openParts[1].includes('peoplePanel.owner'));
  assert.ok(!first.includes('diaryPanel.open') && !JSON.stringify(render()).includes('person:'));
  // The persona card: its name, or its id once the card is gone.
  assert.ok(first.includes('diaryPanel.card: MOCK-默认卡') && second.includes('diaryPanel.card: card:gone'));
  // The old format: marked as the old automatic diary; a public draft is marked old too (no longer written) and keeps its publish button.
  assert.ok(old.includes('MOCK-旧版自动日记正文') && old.includes('"diaryPanel.legacy"') && old.includes('memoryPrivateDiary'));
  assert.ok(draft.includes('memoryPublicDraft') && draft.includes('memoryPublishDraft') && draft.includes('"diaryPanel.legacyPublic"'));
  // Forgetting: how many diaries go, how many of them hold other content, and the ones that may still speak of it.
  await buttons('memoryForgetPreview')[3].props.onClick();
  const dialog = JSON.stringify(nodes(render()).find(n => n.props.role === 'alertdialog'));
  assert.ok(dialog.includes('diaryPanel.forgetDiaries: 2 · diaryPanel.forgetMixed: 1'));
  assert.ok(dialog.includes('diaryPanel.forgetMentions') && dialog.includes('2026-11-16 diaryPanel.private: MOCK-私密第零天'));
  // The owner decides diary by diary: a new preview with that diary added, nothing forgotten yet.
  await buttons('diaryPanel.forgetToo')[0].props.onClick();
  assert.deepEqual(calls.at(-1), ['POST /memory/forget-preview', { entityId: 'entity:test', ids: ['d-1', 'd-0'] }]);
  assert.ok(!calls.some(([route]) => route === 'POST /memory/forget'));
});

test('the open diary list: read on request, a checkbox per person, a new passcode shown once and never listed', async () => {
  const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const person = (personId, label, extra = {}) => ({ personId, label, owner: false, listed: false, hasCode: false, codeAt: null, diaries: 0, lastDay: null, ...extra });
  const owner = person('person:owner', 'p-0a0a0a', { owner: true, listed: true, hasCode: true, codeAt: 1_800_000_000_000, diaries: 3, lastDay: '2026-11-18' }), friend = person('person:qq:999900000011', 'p-1b1b1b');
  const pages = { '/diary/open': { entityId: 'entity:test', people: [owner, friend] }, '/diary/open/listed': { entityId: 'entity:test', people: [owner, { ...friend, listed: true }] },
    '/diary/open/code': { entityId: 'entity:test', personId: friend.personId, label: friend.label, code: 'mockcd33', codeAt: 1_800_000_000_001 } };
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
  const boxes = () => nodes(render()).filter(n => n.type === 'input' && n.props.name === 'openDiaryListed');
  // Nothing is read until asked for.
  assert.ok(JSON.stringify(render()).includes('openDiary.title') && boxes().length === 0 && calls.length === 0);
  await buttons('openDiary.read')[0].props.onClick();
  assert.deepEqual(calls, [['GET /diary/open', undefined]]);
  assert.deepEqual(boxes().map(box => box.props.checked), [true, false]);
  const page = JSON.stringify(render());
  // The owner by badge, others by opaque label; never a person ID (it may hold an account number) and never a passcode.
  assert.ok(page.includes('peoplePanel.owner') && page.includes('p-1b1b1b') && !page.includes('person:') && !page.includes('999900000011') && !page.includes('mockcd'));
  assert.ok(page.includes('openDiary.hasCode') && page.includes('2026-11-18'));
  // Only someone on the list can be given a passcode.
  assert.equal(buttons('openDiary.reset').length, 1);
  // Ticking the friend puts them on the list.
  await boxes()[1].props.onChange({ target: { checked: true } });
  assert.deepEqual(calls.at(-1), ['POST /diary/open/listed', { personId: 'person:qq:999900000011', listed: true }]);
  assert.deepEqual(boxes().map(box => box.props.checked), [true, true]);
  // A new passcode for the friend: shown once, with whose it is.
  await buttons('openDiary.reset')[1].props.onClick();
  assert.deepEqual(calls.slice(-2), [['POST /diary/open/code', { personId: 'person:qq:999900000011' }], ['GET /diary/open', undefined]]);
  assert.ok(JSON.stringify(render()).includes('openDiary.newCode p-1b1b1b: mockcd33'));
  // Changing the list again clears it from the page.
  await boxes()[1].props.onChange({ target: { checked: true } });
  assert.ok(!JSON.stringify(render()).includes('mockcd33'));
});
