import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';

test('memory and private diaries load only on explicit read; forgetting requires preview and pause', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 1, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const memory = { entityId: 'entity:test', memoryEpoch: 0, items: [{ id: 'm1', type: 'facts', status: 'active', key: 'preference', value: 'synthetic preference' }], diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'synthetic private diary' }] };
  const preview = { entityId: memory.entityId, memoryEpoch: 0, revision: 4, ids: ['m1'], expandedIds: ['m1', 'd1'], sourceObservationIds: ['o1'] };
  // The confirmation table: one job pending, the content service has confirmed, the QQ bridge and executor have not.
  let cleanup = { jobs: [{ id: 'job-1', status: 'pending', parties: [{ party: 'content', confirmed: true }, { party: 'bridge:qq', confirmed: false }, { party: 'executor:qq', confirmed: false }] }] };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [], writes = [];
  let cursor = 0, refCursor = 0, component, loaded;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem() {} };
  loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, payload: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, value: url.endsWith('/forget-preview') ? preview : url.endsWith('/world') ? world : url.endsWith('/memory/cleanup/status') ? cleanup : memory }) }; } });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  assert.equal(calls.length, 0); assert.equal(JSON.stringify(render()).includes('synthetic private diary'), false);
  await button('memoryReadExplicitly').props.onClick();
  assert.equal(JSON.stringify(render()).includes('synthetic private diary'), true);
  await button('memoryForgetPreview').props.onClick();
  assert.equal(calls.some(c => c.url.endsWith('/memory/forget')), false);
  states[2] = { ...world, world: { ...world.world, paused: false } };
  assert.equal(button('memoryForgetConfirm').props.disabled, true);
  states[2] = world;
  await button('memoryForgetConfirm').props.onClick();
  assert.deepEqual(calls.find(c => c.url.endsWith('/memory/forget')).payload, { entityId: 'entity:test', ids: ['m1'], expectedMemoryEpoch: 0, expectedRevision: 4 });
  assert.equal(states[7], 'memoryCleanupPending'); assert.equal(writes.length, 0);
  // Refreshing names who has not confirmed yet; once every job is closed it says so.
  await button('memoryCleanupRefresh').props.onClick();
  assert.equal(states[7], 'memoryCleanupPending memoryCleanupWaitingmemoryCleanupPartyBridge qq / memoryCleanupPartyExecutor qq');
  cleanup = { jobs: [{ id: 'job-1', status: 'complete', parties: [] }] };
  await button('memoryCleanupRefresh').props.onClick();
  assert.equal(states[7], 'memoryCleanupComplete');
  button('overview').props.onClick(); assert.equal(states[10], null); assert.equal(states[11], null);
});

test('memory page is read-only about provenance: owner filter, older pages, opaque owner labels and source marks', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 3, notes: 1, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  // Synthetic data; the raw person ID carries a visibly fake account number that must never be rendered.
  const item = (id, revision, extra) => ({ id, revision, type: 'facts', status: 'active', key: 'MOCK-键', value: `MOCK-值-${id}`, visibility: 'private', personId: 'person:qq:999900000011', personLabel: 'p-aaaaaa', personIsOwner: false, source: { channel: 'qq', role: 'user', proposal: 'fact.report' }, evidence: { actorId: 'qq:999900000001:user:999900000011' }, ...extra });
  const people = [{ label: 'p-0f0f0f', owner: true, items: 1 }, { label: 'p-aaaaaa', owner: false, items: 2 }];
  const pages = {
    '/memory': { entityId: 'entity:test', memoryEpoch: 0, more: true, people, unowned: 1, diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'MOCK-私密日记' }],
      items: [item('m3', 30, { personId: 'person:owner', personLabel: 'p-0f0f0f', personIsOwner: true, visibility: 'public' }), item('m2', 20)] },
    '/memory?beforeRevision=20': { entityId: 'entity:test', memoryEpoch: 0, more: false, people, unowned: 1, diaries: [{ id: 'd1', kind: 'private', status: 'private', text: 'MOCK-私密日记' }],
      items: [item('m1', 10), item('m0', 5, { type: 'notes', kind: 'learning', key: undefined, value: undefined, text: 'MOCK-学习笔记', personId: undefined, personLabel: null, source: { channel: 'reader', role: 'external', proposal: 'learning.note' } }), item('old', 1, { personLabel: null, personId: undefined, source: { channel: null, role: null, proposal: null } })] },
    '/memory?person=p-aaaaaa': { entityId: 'entity:test', memoryEpoch: 0, more: false, people, unowned: 1, diaries: [], items: [item('m2', 20), item('m1', 10)] },
  };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    fetch: async (url, options) => { const route = url.slice(url.indexOf('3082') + 4); calls.push(`${options.method} ${route}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: pages[route] }) }; } });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  const cards = () => nodes(render()).filter(n => n.type === 'article').map(n => JSON.stringify(n));
  const settle = () => new Promise(setImmediate);
  assert.equal(nodes(render()).some(n => n.type === 'select'), false, 'no filter before the explicit read');
  await button('memoryReadExplicitly').props.onClick();
  // Ownership (opaque label / owner / public) and source on every item.
  let shown = cards();
  assert.ok(shown[0].includes('peoplePanel.owner') && shown[0].includes('memoryPanel.public') && shown[0].includes('memoryPanel.source: memoryPanel.role.user · memoryPanel.proposal.fact · qq'));
  assert.ok(shown[1].includes('p-aaaaaa') && !shown[1].includes('memoryPanel.public') && !shown[1].includes('peoplePanel.owner'));
  const options = () => nodes(render()).find(n => n.type === 'select').children.filter(Boolean).map(n => [n.props.value, n.children.join('')]);
  assert.deepEqual(options(), [['', 'memoryPanel.all'], ['p-0f0f0f', 'peoplePanel.owner (1)'], ['p-aaaaaa', 'p-aaaaaa (2)'], ['none', 'memoryPanel.unowned (1)']]);
  // Older page: appended after what is shown, cursor = the oldest revision on screen; then nothing more to load.
  await button('memoryPanel.loadMore').props.onClick();
  shown = cards();
  assert.deepEqual(shown.filter(card => card.includes('MOCK-值-')).map(card => /MOCK-值-(\w+)/.exec(card)[1]), ['m3', 'm2', 'm1', 'old']);
  const learning = shown.find(card => card.includes('MOCK-学习笔记')), old = shown.find(card => card.includes('MOCK-值-old'));
  assert.ok(learning.includes('memoryPanel.unowned') && learning.includes('memoryPanel.source: memoryPanel.role.external · memoryPanel.proposal.learning · reader'));
  assert.ok(old.includes('memoryPanel.source: memoryPanel.sourceUnknown'));
  assert.equal(button('memoryPanel.loadMore'), undefined);
  assert.ok(JSON.stringify(render()).includes('memoryPanel.shown: 5'));
  // Filter by owner: one more read with the opaque label; diaries are not part of a filtered view.
  nodes(render()).find(n => n.type === 'select').props.onChange({ target: { value: 'p-aaaaaa' } });
  await settle();
  assert.equal(nodes(render()).find(n => n.type === 'select').props.value, 'p-aaaaaa');
  assert.ok(cards().every(card => card.includes('p-aaaaaa')) && cards().length === 2 && !JSON.stringify(render()).includes('MOCK-私密日记'));
  // Read-only: three GETs, the label and cursor are the only query, and no account number is ever rendered.
  assert.deepEqual(calls, ['GET /memory', 'GET /memory?beforeRevision=20', 'GET /memory?person=p-aaaaaa']);
  assert.ok(!JSON.stringify(render()).includes('9999') && !JSON.stringify(render()).includes('person:'));
  // Leaving the page drops the loaded memory and the filter.
  button('overview').props.onClick(); assert.equal(states[10], null); assert.equal(states[23], '');
});

test('memory queries carry only an opaque owner label and a page cursor', async () => {
  const { operatorRequest, memoryQuery } = await import('./operator-client.js');
  assert.deepEqual([memoryQuery(), memoryQuery({ person: 'none' }), memoryQuery({ person: 'p-0a1b2c', beforeRevision: 7 })], ['', '?person=none', '?person=p-0a1b2c&beforeRevision=7']);
  for (const bad of [{ person: 'person:qq:999900000011' }, { person: '999900000011' }, { beforeRevision: -1 }, { beforeRevision: 1.5 }]) assert.throws(() => memoryQuery(bad), /invalid_memory_query/);
  const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) });
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/memory/forget', payload: {}, query: { person: 'none' }, fetchImpl }), /operator_query_unsupported/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/people', query: {}, fetchImpl }), /operator_query_unsupported/);
});

test('machine digests are marked as machine text with what they cover; consolidation status and source lines are explicit reads', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 1, notes: 0, experiences: 1, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const base = { status: 'active', visibility: 'private', personId: 'person:qq:999900000011', personLabel: 'p-aaaaaa', personIsOwner: false };
  const digest = { ...base, id: 'd-1', revision: 30, type: 'experiences', kind: 'digest', summary: 'MOCK-摘要：对方说起养了仓鼠', feeling: 'MOCK-感受：很开心', derivedFrom: ['o1', 'o2'], fromAt: 1_800_000_000_000, toAt: 1_800_000_060_000, source: { channel: 'qq', role: null, proposal: null, machine: 'digest' } };
  const fact = { ...base, id: 'f-1', revision: 20, type: 'facts', key: 'MOCK-宠物', value: 'MOCK-年糕', source: { channel: 'qq', role: 'user', proposal: 'fact.report', machine: 'extracted' } };
  const plain = { ...base, id: 'e-1', revision: 10, type: 'experiences', summary: 'MOCK-当场记下的经历', source: { channel: 'qq', role: 'user', proposal: 'experience.remember' } };
  // Noted in conversation with a quote that is not word for word in the observation it cites.
  const loose = { ...base, id: 'f-2', revision: 5, type: 'facts', key: 'MOCK-搬家', value: 'MOCK-2026-12-05', evidence: { observationId: 'o7', quote: 'MOCK-下个月五号搬家', role: 'user', quoteVerbatim: false }, source: { channel: 'qq', role: 'user', proposal: 'fact.report' } };
  const pages = {
    '/memory': { entityId: 'entity:test', memoryEpoch: 0, more: false, people: [{ label: 'p-aaaaaa', owner: false, items: 4 }], unowned: 0, diaries: [], items: [digest, fact, plain, loose] },
    '/memory/sources?id=f-2': { entityId: 'entity:test', id: 'f-2', machine: false, sources: [{ id: 'o7', role: 'user', at: 1_800_000_000_000, text: 'MOCK-原话：我下个月 5 号搬家', forgotten: false }] },
    '/memory/sources?id=d-1': { entityId: 'entity:test', id: 'd-1', machine: true, sources: [{ id: 'o1', role: 'user', at: 1_800_000_000_000, text: 'MOCK-原话：我养了一只仓鼠', forgotten: false }, { id: 'o2', role: 'assistant', at: 1_800_000_060_000, text: '', forgotten: true }] },
    '/memory/consolidation': { entityId: 'entity:test', day: '2026-11-11', calls: 3, limits: { perDay: 24, perStreamPerDay: 2 }, lastCommittedAt: 1_800_000_090_000, paused: 'spend', staleDigestIds: ['d-9'], extracted: { accepted: 4, pending: 0, rejected: { unconfirmed_identity: 2, newer_fact_kept: 1 } },
      streams: [{ stream: 's-111111', person: 'p-aaaaaa', owner: false, behind: { observations: 12, chars: 340 }, waiting: 5, calls: 2, digests: 7, skipped: 1, lastAt: 1_800_000_090_000 }, { stream: 's-222222', person: 'p-0f0f0f', owner: true, behind: { observations: 0, chars: 0 }, waiting: 0, calls: 0, digests: 0, skipped: 0, lastAt: null }] },
    '/memory/forget-preview': { entityId: 'entity:test', memoryEpoch: 0, revision: 4, ids: ['o1'], expandedIds: ['d-1'], digestIds: ['d-1'], sourceObservationIds: ['o1'] },
  };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [], writes = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    fetch: async (url, options) => { const route = url.slice(url.indexOf('3082') + 4); calls.push(`${options.method} ${route}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: pages[route] }) }; } });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const buttons = key => nodes(render()).filter(n => n.type === 'button' && n.children.includes(key));
  const cards = () => nodes(render()).filter(n => n.type === 'article').map(n => JSON.stringify(n));
  // Nothing about consolidation is fetched until asked for.
  assert.equal(JSON.stringify(render()).includes('consolidation.callsToday'), false);
  await buttons('memoryReadExplicitly')[0].props.onClick();
  const [digestCard, factCard, plainCard, looseCard] = cards();
  // The digest: machine badge, her feeling, what it covers, its origin; it cannot be made public.
  for (const shown of ['memoryPanel.machineBadge', 'MOCK-摘要：对方说起养了仓鼠', 'memoryPanel.feeling: MOCK-感受：很开心', 'memoryPanel.lines: 2', 'memoryPanel.source: memoryPanel.machine.digest · qq', 'p-aaaaaa']) assert.ok(digestCard.includes(shown), shown);
  assert.ok(!digestCard.includes('memoryPublicAuthorize') && digestCard.includes('memoryPanel.showSources'));
  assert.ok(factCard.includes('memoryPanel.extractedBadge') && factCard.includes('memoryPanel.machine.extracted') && factCard.includes('memoryPublicAuthorize') && factCard.includes('memoryPanel.showSources'));
  assert.ok(!plainCard.includes('memoryPanel.machineBadge') && !plainCard.includes('memoryPanel.extractedBadge') && !plainCard.includes('memoryPanel.showSources') && plainCard.includes('memoryPanel.source: memoryPanel.role.user · memoryPanel.proposal.experience · qq'));
  // A quote that is not verbatim is marked, shown as she noted it, and its source can be read; nothing else carries the mark.
  for (const shown of ['memoryPanel.looseQuoteBadge', 'memoryPanel.notedQuote: MOCK-下个月五号搬家', 'memoryPanel.showSources', 'MOCK-搬家: MOCK-2026-12-05']) assert.ok(looseCard.includes(shown), shown);
  for (const card of [digestCard, factCard, plainCard]) assert.ok(!card.includes('memoryPanel.looseQuoteBadge') && !card.includes('memoryPanel.notedQuote'));
  // Source lines of one item: read on click, whose words they are; a forgotten line shows no text.
  assert.ok(!JSON.stringify(render()).includes('MOCK-原话'));
  await buttons('memoryPanel.showSources')[0].props.onClick();
  assert.ok(cards()[0].includes('memoryPanel.role.user · ') && cards()[0].includes(': MOCK-原话：我养了一只仓鼠') && cards()[0].includes(': memoryPanel.sourceForgotten'));
  assert.ok(!cards()[1].includes('MOCK-原话') && !cards()[3].includes('MOCK-原话'));
  await buttons('memoryPanel.showSources')[2].props.onClick();
  assert.ok(cards()[3].includes(': MOCK-原话：我下个月 5 号搬家') && calls.includes('GET /memory/sources?id=f-2'));
  // Status card: counters, the spend pause, leftovers, one row per conversation by opaque label.
  await buttons('consolidation.read')[0].props.onClick();
  const page = JSON.stringify(render());
  for (const shown of ['consolidation.paused.spend', 'consolidation.stale: 1', 'consolidation.today (2026-11-11): 3 / 24 · consolidation.perConversation: 2', 'consolidation.extracted: 4 · consolidation.refused: 3']) assert.ok(page.includes(shown), shown);
  const rows = nodes(render()).filter(n => n.type === 'tr').map(n => nodes(n).filter(cell => cell.type === 'td').map(cell => JSON.stringify(cell.children)));
  assert.deepEqual(rows.filter(row => row.length).map(row => row.slice(1, 6).map(cell => JSON.parse(cell)[0])), [['12', '5', '2', '7', '1'], ['0', '0', '0', '0', '0']]);
  assert.ok(rows.filter(row => row.length)[0][0].includes('p-aaaaaa') && rows.filter(row => row.length)[1][0].includes('peoplePanel.owner'));
  // The forget preview names the digests that go along.
  await buttons('memoryForgetPreview')[0].props.onClick();
  assert.ok(JSON.stringify(render()).includes('memoryPanel.digestsRemoved: 1'));
  // Read-only: GETs and the existing forget preview; nothing written to the browser, no account number rendered.
  assert.deepEqual(calls, ['GET /memory', 'GET /memory/sources?id=d-1', 'GET /memory/sources?id=f-2', 'GET /memory/consolidation', 'POST /memory/forget-preview']);
  assert.equal(writes.length, 0);
  assert.ok(!JSON.stringify(render()).includes('999900000011'));
  // Leaving the page drops what was read.
  nodes(render()).find(n => n.type === 'button' && n.children.includes('overview')).props.onClick();
  // (state 25 is the source lines read for single items)
  assert.deepEqual([states[10], Object.keys(states[25]).length], [null, 0]);
});

test('consolidation status and source reads are GET-only; a source read names exactly one item', async () => {
  const { operatorRequest, sourcesQuery } = await import('./operator-client.js');
  assert.equal(sourcesQuery({ id: 'd-1' }), '?id=d-1');
  for (const bad of [{}, { id: '' }, { id: 'a b' }, { id: 'x&person=p-aaaaaa' }, { id: 'x'.repeat(65) }]) assert.throws(() => sourcesQuery(bad), /invalid_memory_query/);
  const location = { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, urls = [], fetchImpl = async (url, options) => { urls.push(`${options.method} ${url.slice(url.indexOf('3082') + 4)}`); return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }; };
  const ask = extra => operatorRequest({ location, token: 'operator-test', fetchImpl, ...extra });
  await ask({ path: '/memory/consolidation' }); await ask({ path: '/memory/sources', query: { id: 'd-1' } });
  assert.deepEqual(urls, ['GET /memory/consolidation', 'GET /memory/sources?id=d-1']);
  for (const path of ['/memory/consolidation', '/memory/sources']) await assert.rejects(ask({ path, payload: {} }), /operator_get_required/);
  await assert.rejects(ask({ path: '/memory/sources' }), /operator_query_unsupported/);
  await assert.rejects(ask({ path: '/memory/consolidation', query: { id: 'd-1' } }), /operator_query_unsupported/);
  await assert.rejects(ask({ path: '/memory/consolidation/next' }), /unsupported_operator_path/);
});

test('memory type filter: all by default, one type at a time, diaries untouched, choice kept in this tab (and fine without storage)', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 1, notes: 1, experiences: 2, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const base = { status: 'active', visibility: 'private', personLabel: 'p-aaaaaa', personIsOwner: false, source: { channel: 'qq', role: 'user', proposal: null } };
  const memory = { entityId: 'entity:test', memoryEpoch: 0, more: false, people: [], unowned: 0, diaries: [{ id: 'dy', kind: 'private', status: 'private', text: 'MOCK-日记' }], items: [
    { ...base, id: 'f', revision: 6, type: 'facts', key: 'MOCK-事实', value: 'x' },
    { ...base, id: 'd', revision: 5, type: 'experiences', kind: 'digest', summary: 'MOCK-摘要', source: { channel: 'qq', machine: 'digest' } },
    { ...base, id: 'e', revision: 4, type: 'experiences', summary: 'MOCK-经历' },
    { ...base, id: 'n', revision: 3, type: 'notes', kind: 'learning', text: 'MOCK-笔记' },
    { ...base, id: 'a', revision: 2, type: 'appraisals', text: 'MOCK-评价' },
    { ...base, id: 'z', revision: 1, type: 'mystery', text: 'MOCK-其它' }] };
  const mount = async storage => {
    const states = ['operator-test', '', world, {}, 'memory']; const refs = [];
    let cursor = 0, refCursor = 0;
    const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
    const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: memory }) }) });
    const component = loaded.factory(() => React).WorldConsole;
    const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
    const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
    const view = {
      render,
      kinds: () => nodes(render()).filter(n => n.type === 'button' && n.props.name === 'memoryKind'),
      pressed: () => view.kinds().filter(n => n.props['aria-pressed']).map(n => n.children.join('')),
      shown: () => nodes(render()).filter(n => n.type === 'article').map(n => /MOCK-[^"\\: ]+/.exec(JSON.stringify(n))[0]),
    };
    assert.equal(view.kinds().length, 0, 'no type buttons before the explicit read');
    await nodes(render()).find(n => n.type === 'button' && n.children.includes('memoryReadExplicitly')).props.onClick();
    return view;
  };
  const KEY = 'companion-world:memory-kind:v1', ALL = ['MOCK-事实', 'MOCK-摘要', 'MOCK-经历', 'MOCK-笔记', 'MOCK-评价', 'MOCK-其它', 'MOCK-日记'];
  // Fresh tab: nothing stored -> all; the five types always offered, others as found in the list.
  const writes = [];
  const storage = { getItem: key => key === 'companion-world:operator:v1' ? 'operator-test' : null, setItem: (...args) => writes.push(args), removeItem() {} };
  const stored = value => ({ ...storage, getItem: key => key === KEY ? value : storage.getItem(key) });
  let view = await mount(storage);
  const pick = label => view.kinds().find(n => n.children.join('') === label).props.onClick();
  assert.deepEqual(view.kinds().map(n => n.children.join('')), ['memoryPanel.kind.all', 'memoryPanel.kind.facts', 'memoryPanel.kind.experiences', 'memoryPanel.kind.digest', 'memoryPanel.kind.notes', 'memoryPanel.kind.intent', 'memoryPanel.kind.appraisals', 'mystery']);
  assert.deepEqual([view.pressed(), view.shown()], [['memoryPanel.kind.all'], ALL]);
  // One type at a time; the diary stays; a digest is apart from a plain experience.
  pick('memoryPanel.kind.digest');
  assert.deepEqual([view.pressed(), view.shown()], [['memoryPanel.kind.digest'], ['MOCK-摘要', 'MOCK-日记']]);
  pick('memoryPanel.kind.experiences'); assert.deepEqual(view.shown(), ['MOCK-经历', 'MOCK-日记']);
  pick('memoryPanel.kind.notes'); assert.deepEqual(view.shown(), ['MOCK-笔记', 'MOCK-日记']);
  pick('mystery'); assert.deepEqual(view.shown(), ['MOCK-其它', 'MOCK-日记']);
  assert.equal(JSON.stringify(view.render()).includes('memoryPanel.kindEmpty'), false);
  pick('memoryPanel.kind.all'); assert.deepEqual(view.shown(), ALL);
  pick('memoryPanel.kind.facts');
  assert.deepEqual(writes, ['digest', 'experiences', 'notes', 'mystery', 'all', 'facts'].map(value => [KEY, value]));
  // A new mount in the same tab starts on the stored type.
  view = await mount(stored('notes'));
  assert.deepEqual([view.pressed(), view.shown()], [['memoryPanel.kind.notes'], ['MOCK-笔记', 'MOCK-日记']]);
  // A stored type with nothing loaded of it says so; one this page does not offer falls back to all.
  memory.items = memory.items.filter(item => item.type !== 'facts');
  view = await mount(stored('facts'));
  assert.deepEqual([view.pressed(), view.shown()], [['memoryPanel.kind.facts'], ['MOCK-日记']]);
  assert.ok(JSON.stringify(view.render()).includes('memoryPanel.kindEmpty'));
  view = await mount(stored('gone'));
  assert.deepEqual(view.pressed(), ['memoryPanel.kind.all']);
  // Storage that throws: the filter still works, starting from all.
  view = await mount({ getItem: key => { if (key === KEY) throw new Error('blocked'); return 'operator-test'; }, setItem: () => { throw new Error('blocked'); }, removeItem() {} });
  assert.deepEqual(view.pressed(), ['memoryPanel.kind.all']);
  pick('memoryPanel.kind.digest');
  assert.deepEqual([view.pressed(), view.shown()], [['memoryPanel.kind.digest'], ['MOCK-摘要', 'MOCK-日记']]);
});

test('memory type filter strings exist in both locales', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['zh', 'en']) {
    const panel = JSON.parse(await readFile(new URL(`./locale/${name}.json`, import.meta.url), 'utf8')).memoryPanel;
    assert.equal(typeof panel.kindFilter, 'string'); assert.equal(typeof panel.kindEmpty, 'string');
    for (const kind of ['all', 'facts', 'experiences', 'digest', 'notes', 'intent', 'appraisals']) assert.equal(typeof panel.kind[kind], 'string', `${name}: ${kind}`);
    for (const key of ['intentDue', 'intentNoDue', 'intentState', 'intentDelete']) assert.equal(typeof panel[key], 'string', `${name}: ${key}`);
    for (const state of ['open', 'done', 'expired']) assert.equal(typeof panel.intentStates[state], 'string', `${name}: ${state}`);
    assert.equal(typeof panel.proposal.intent, 'string');
  }
});

test('her intents: a type of their own, shown with whose they are (label, no account), due day and state; deleted by a POST, never made public', async () => {
  const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 3, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  // Synthetic data; the raw person ID carries a visibly fake account number that must never be rendered.
  const base = { type: 'notes', status: 'active', visibility: 'private', personId: 'person:qq:999900000011', personLabel: 'p-aaaaaa', personIsOwner: false, source: { channel: 'qq', role: 'user', proposal: 'intent.note' }, evidence: { actorId: 'qq:999900000001:user:999900000011' } };
  let memory = { entityId: 'entity:test', memoryEpoch: 0, more: false, people: [], unowned: 0, diaries: [], items: [
    { ...base, id: 'i1', revision: 4, kind: 'intent', text: 'MOCK-明天问问面试', dueDate: '2027-01-16', state: 'open' },
    { ...base, id: 'i2', revision: 3, kind: 'intent', text: 'MOCK-推荐那本书', dueDate: null, state: 'expired', personLabel: 'p-0f0f0f', personIsOwner: true, personId: 'person:owner' },
    { ...base, id: 'n1', revision: 2, kind: 'outer', text: 'MOCK-自述', source: { channel: 'qq', role: 'assistant', proposal: 'self.note' } }] };
  const states = ['operator-test', '', world, {}, 'memory']; const refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: key => key === 'companion-world:operator:v1' ? 'operator-test' : null, setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    fetch: async (url, options) => {
      const payload = options.body && JSON.parse(options.body);
      calls.push([options.method, url.slice(url.indexOf('3082') + 4), payload]);
      if (url.endsWith('/memory/intent/delete')) { memory = { ...memory, items: memory.items.filter(item => item.id !== payload.id) }; return { ok: true, status: 200, json: async () => ({ ok: true, value: { id: payload.id, deleted: true } }) }; }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: memory }) };
    } });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const cards = () => nodes(render()).filter(n => n.type === 'article');
  await nodes(render()).find(n => n.type === 'button' && n.children.includes('memoryReadExplicitly')).props.onClick();
  nodes(render()).find(n => n.type === 'button' && n.props.name === 'memoryKind' && n.children.join('') === 'memoryPanel.kind.intent').props.onClick();
  const shown = cards().map(card => JSON.stringify(card));
  assert.equal(shown.length, 2, 'only the intents');
  assert.ok(shown[0].includes('MOCK-明天问问面试') && shown[0].includes('p-aaaaaa') && shown[0].includes('memoryPanel.intentDue: 2027-01-16 · memoryPanel.intentState: memoryPanel.intentStates.open'));
  assert.ok(shown[0].includes('memoryPanel.source: memoryPanel.role.user · memoryPanel.proposal.intent · qq'));
  assert.ok(shown[1].includes('peoplePanel.owner') && shown[1].includes('memoryPanel.intentDue: memoryPanel.intentNoDue · memoryPanel.intentState: memoryPanel.intentStates.expired'));
  assert.ok(!shown.join('').includes('9999'), 'no account number');
  const buttons = card => nodes(card).filter(n => n.type === 'button').map(n => n.children.filter(child => typeof child === 'string').join(''));
  assert.ok(buttons(cards()[0]).includes('memoryPanel.intentDelete') && !buttons(cards()[0]).includes('memoryPublicAuthorize'));
  await nodes(cards()[0]).find(n => n.type === 'button' && n.children.includes('memoryPanel.intentDelete')).props.onClick();
  assert.deepEqual(calls.find(call => call[1] === '/memory/intent/delete'), ['POST', '/memory/intent/delete', { entityId: 'entity:test', id: 'i1' }]);
  assert.deepEqual(cards().map(card => JSON.stringify(card).includes('MOCK-推荐那本书')), [true]);
});
