import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { operatorRequest, operatorOrigin, personaPatch, personaDraft, personaExport, personaImport, validWorld, validModel, modelPayload, consumeOperatorFragment, TOKEN_KEY, qqPayload, validQQ } from './operator-client.js';
import { loadConsole } from './test-harness.mjs';
import { flattenDictionary } from './view.js';
const location = { protocol: 'http:', hostname: '127.0.0.1' };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const root = new URL('./', import.meta.url);
test('operator bearer stays at fixed loopback 3082 and exact mutation payload', async () => {
  let calls = 0;
  const payload = { paused: false };
  await operatorRequest({ location, token: 'test-only', path: '/world/pause', payload, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'http://127.0.0.1:3082/world/pause'); assert.equal(options.headers.Authorization, 'Bearer test-only');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.deepEqual(JSON.parse(options.body), payload);
    return response({ ok: true, value: { paused: false } });
  } });
  assert.equal(calls, 1);
  assert.equal(operatorOrigin({ protocol: 'http:', hostname: '[::1]' }), 'http://[::1]:3082');
  assert.throws(() => operatorOrigin({ protocol: 'https:', hostname: 'example.org' }), /loopback_required/);
  await assert.rejects(operatorRequest({ location, token: '', path: '/world', fetchImpl: () => assert.fail('must not fetch') }), /authorization_required/);
});
test('normal API errors never echo reflected secrets', async () => {
  await assert.rejects(operatorRequest({ location, token: 'test-only', path: '/world', fetchImpl: async () => response({ ok: false, error: { code: 'unauthorized', message: 'test-only' } }, 401) }), error => error.code === 'authorization_required' && !error.message.includes('test-only'));
  await assert.rejects(operatorRequest({ location, token: 'test-only', path: '/world', fetchImpl: async () => response({ ok: false, error: { code: 'revision_conflict' } }, 409) }), error => error.code === 'revision_conflict');
  assert.equal(validWorld({}), false);
});
test('model transport uses POST only, preserves omitted key, and never echoes errors', async () => {
  const key = 'test-secret-model-key';
  for (const [path, payload] of [['/model', modelPayload(' deepseek-flash ', key)], ['/model', modelPayload('deepseek-flash', '')], ['/model/test', {}]]) {
    await operatorRequest({ location, token: 'operator-test', path, payload, fetchImpl: async (url, options) => {
      assert.equal(url, `http://127.0.0.1:3082${path}`); assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), payload);
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      return response({ ok: true, value: { ok: false, code: 'upstream_error', model: 'deepseek-flash' } });
    } });
  }
  assert.deepEqual(modelPayload('deepseek-flash', ''), { model: 'deepseek-flash' });
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/model', fetchImpl: () => assert.fail() }), /operator_post_required/);
  await assert.rejects(operatorRequest({ location, token: 'operator-test', path: '/model', payload: modelPayload('deepseek-flash', key),
    fetchImpl: async () => response({ ok: false, error: { code: key, message: key } }, 500) }), error => error.message === 'request_failed');
  assert.equal(validModel({ provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' }), true);
  assert.equal(validModel({ provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured', lastTest: { ok: false, at: 123, code: 'upstream_error' } }), true);
  assert.equal(validModel({ provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'verified' }), false);
});
test('QQ status and sender payload use only the private operator endpoint', async () => {
  const uid = '123456789';
  assert.deepEqual(qqPayload(` ${uid} `), { allowedCallerUID: uid });
  assert.throws(() => qqPayload('not-a-number'), error => error.code === 'invalid_qq_uid' && !error.message.includes('not-a-number'));
  const status = { loggedIn: true, connected: false, configured: false, callerConfigured: false, paused: true };
  assert.equal(validQQ(status), true); assert.equal(validQQ({ ...status, loggedIn: 'yes' }), false);
  for (const payload of [undefined, qqPayload(uid)]) {
    await operatorRequest({ location, token: 'operator-test', path: '/qq', payload, fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3082/qq'); assert.equal(options.method, payload ? 'POST' : 'GET');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer operator-test');
      assert.equal(options.body, payload && JSON.stringify({ allowedCallerUID: uid }));
      return response({ ok: true, value: status });
    } });
  }
});
test('QQ UI saves only a paused logged-in sender, clears it, and hides saved numbers', async () => {
  const uid = '123456789';
  const qq = { loggedIn: true, connected: true, configured: true, callerConfigured: true, paused: true, allowedCallerUID: uid, token: 'must-not-render' };
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [{ id: 'qq', name: 'QQ', status: 'ready', enabled: true, boundStreams: 1 }], bindings: [{ sourceId: 'qq', conversationId: `qq:bot:private:${uid}`, personId: 'person:owner', audience: 'private' }], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const states = ['operator-test', '', world, {}, 'channels', false, '', '', 'deepseek-flash', qq], refs = [], calls = [], writes = [];
  let cursor = 0, refCursor = 0, component, loaded;
  const React = { Fragment: 'fragment', useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => { if (type === 'input' && props.ref) props.ref.current ||= { value: '' }; return { type, props: props || {}, children: children.flat(Infinity) }; } };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem: (...args) => writes.push(args) };
  loaded = await loadConsole({ window: { location: { ...location, hash: '' }, sessionStorage: storage }, sessionStorage: storage,
    AbortController, AbortSignal, setTimeout, clearTimeout, fetch: async (url, options) => {
      calls.push({ url, method: options.method, payload: options.body && JSON.parse(options.body) });
      if (options.method === 'POST') return response({ ok: true, value: qq });
      assert.equal(refs[1].current.value, '', 'caller input clears before status refresh');
      return response({ ok: true, value: url.endsWith('/qq') ? qq : world });
    } });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  let tree = render(); assert.equal(calls.length, 0, 'render never requests QQ status');
  assert.ok(!JSON.stringify(tree).includes(uid)); assert.ok(!JSON.stringify(tree).includes('must-not-render'));
  assert.ok(JSON.stringify(tree).includes('qqChannelStatus.ready'));
  const input = nodes(tree).find(node => node.type === 'input' && node.props.ref);
  assert.equal(input.props.type, 'text'); assert.equal(input.props.inputMode, 'numeric'); assert.equal(input.props.value, undefined);
  input.props.ref.current.value = uid;
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:3082/qq', method: 'POST', payload: { allowedCallerUID: uid } }, { url: 'http://127.0.0.1:3082/qq', method: 'GET', payload: undefined }, { url: 'http://127.0.0.1:3082/world', method: 'GET', payload: undefined }]);
  assert.equal(writes.length, 0); assert.equal(input.props.ref.current.value, ''); assert.ok(!JSON.stringify(render()).includes(uid));
  states[9] = { ...qq, loggedIn: false }; tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('qqSave')).props.disabled, true);
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(calls.length, 3);
  states[9] = qq; states[2] = { ...world, world: { ...world.world, paused: false } }; tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('qqSave')).props.disabled, true);
});
test('operator fragment is consumed once, removed immediately, and never stores invalid values', () => {
  const writes = []; const replacements = [];
  const code = 'a'.repeat(43);
  const page = { hash: `#companion-operator=${code}`, pathname: '/settings', search: '?tab=world' };
  const history = { state: { existing: true }, replaceState: (...args) => replacements.push(args) };
  assert.equal(consumeOperatorFragment({ location: page, history, storage: { setItem: (...args) => writes.push(args) } }), true);
  assert.deepEqual(writes, [[TOKEN_KEY, code]]); assert.deepEqual(replacements, [[history.state, '', '/settings?tab=world']]);
  assert.equal(consumeOperatorFragment({ location: { ...page, hash: '#companion-operator=bad/key' }, history, storage: { setItem: () => assert.fail() } }), false);
  assert.equal(consumeOperatorFragment({ location: page, history, storage: { setItem: () => { throw new Error('disabled'); } } }), false);
  assert.equal(replacements.length, 3);
  assert.equal(consumeOperatorFragment({ location: { ...page, hash: '#another-anchor' }, history, storage: {} }), false);
  assert.equal(replacements.length, 3);
});
test('persona arrays and expected operator edit shape', () => {
  assert.deepEqual(personaPatch({ name: 'Fish', identity: 'companion', traits: ' calm \n\n curious', speechStyle: 'brief', boundaries: 'honest', principles: '', examples: [{ user: 'hi', assistant: 'hey' }] }), {
    name: 'Fish', userCallName: '', identity: 'companion', speechStyle: 'brief', relationshipStage: '', traits: ['calm', 'curious'], boundaries: ['honest'], principles: [], examples: [{ user: 'hi', assistant: 'hey' }],
  });
});
test('persona export round-trips through import; import fills defaults and rejects foreign fields', () => {
  const defaults = { name: 'Default', userCallName: '你', identity: 'd', traits: ['t'], boundaries: [], speechStyle: 's', relationshipStage: 'new', principles: [], examples: [{ user: 'u', assistant: 'a' }] };
  const draft = personaDraft({ ...defaults, name: 'Anime', traits: ['元气', '中二'], examples: [{ user: '早', assistant: '早安！' }] });
  assert.deepEqual(personaImport(personaExport(draft), defaults), draft);
  assert.deepEqual(personaImport(JSON.stringify({ persona: { name: 'Wrapped' } }), defaults), personaDraft({ ...defaults, name: 'Wrapped' }));
  for (const bad of ['not json', '[]', '{"mood":"x"}', '{"traits":"one"}', '{"examples":[{"user":"only"}]}']) assert.throws(() => personaImport(bad, defaults), /invalid_persona_file/);
});
test('persona panel edits examples, previews the unsaved draft and warns when truncated', async () => {
  const persona = { name: 'Fish', userCallName: '你', identity: 'i', traits: [], boundaries: [], speechStyle: 's', relationshipStage: 'new', principles: [], examples: [{ user: 'a', assistant: '1' }, { user: 'b', assistant: '2' }] };
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 4, value: persona, default: { ...persona, name: 'Default', examples: [] } }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };
  const states = ['operator-test', '', world, null, 'persona']; const calls = []; let cursor = 0, refCursor = 0; const refs = [];
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { ...location, hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => { const payload = JSON.parse(options.body); calls.push({ url, payload }); return response({ ok: true, value: { text: 'x'.repeat(1700), chars: 1700, limit: 1600 } }); } });
  const component = loaded.factory(() => React).WorldConsole;
  states[3] = personaDraft(persona);
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const buttons = key => nodes(render()).filter(n => n.type === 'button' && n.children.includes(key));
  assert.ok(nodes(render()).some(n => n.props.name === 'userCallName') && nodes(render()).some(n => n.props.name === 'relationshipStage'));
  assert.equal(buttons('personaPanel.moveUp')[0].props.disabled, true);
  buttons('personaPanel.moveDown')[0].props.onClick();
  assert.equal(states[3].examples.map(e => e.user).join(), 'b,a');
  buttons('personaPanel.addExample')[0].props.onClick();
  nodes(render()).find(n => n.props.name === 'example-2-user').props.onChange({ target: { value: 'c' } });
  buttons('personaPanel.removeExample')[0].props.onClick();
  assert.equal(JSON.stringify(states[3].examples), JSON.stringify([{ user: 'a', assistant: '1' }, { user: 'c', assistant: '' }]));
  buttons('personaPanel.preview')[0].props.onClick(); await new Promise(setImmediate);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/persona/preview'));
  assert.equal(JSON.stringify(calls[0].payload.patch.examples), JSON.stringify(states[3].examples));
  let tree = JSON.stringify(render()); assert.match(tree, /1700 \/ 1600/); assert.match(tree, /personaPanel.previewTruncated/);
  nodes(render()).find(n => n.props.name === 'name').props.onChange({ target: { value: 'Changed' } });
  assert.doesNotMatch(JSON.stringify(render()), /previewTruncated/, 'a stale preview is hidden after edits');
  buttons('personaPanel.loadDefault')[0].props.onClick();
  assert.equal(states[3].name, 'Default'); assert.equal(states[3].examples.length, 0); assert.equal(calls.length, 1, 'loading the default never saves');
});
test('model UI keeps key ephemeral, clears it before refresh, and tests only on explicit click', async () => {
  const secret = 'test-model-key-never-store';
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [],
    model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured', apiKey: 'must-not-render', keySuffix: 'must-not-render' } };
  const states = ['operator-test', '', world, {}, 'runtime']; const refs = [];
  let cursor = 0; let refCursor = 0; let component; let loaded; const calls = []; const writes = [];
  const React = { Fragment: 'fragment', useState: initial => {
    const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], value => { states[index] = value; }];
  }, useRef: initial => { const index = refCursor++; return refs[index] ||= { current: initial }; }, useEffect() {},
  createElement: (type, props, ...children) => {
    if (type === 'input' && props.ref) props.ref.current ||= { value: '' };
    return { type, props: props || {}, children: children.flat(Infinity) };
  } };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => writes.push(args), removeItem: (...args) => writes.push(args) };
  loaded = await loadConsole({
    window: { location: { ...location, hash: '' }, sessionStorage: storage }, sessionStorage: storage,
    AbortController, AbortSignal, setTimeout, clearTimeout, fetch: async (url, options) => {
      calls.push({ url, payload: options.body && JSON.parse(options.body) });
      if (url.endsWith('/model')) return response({ ok: true, value: world.model });
      if (url.endsWith('/model/test')) return response({ ok: true, value: { ok: false, code: secret, model: 'deepseek-flash' } });
      assert.equal(refs[0].current.value, '', 'key clears before the subsequent world refresh');
      return response({ ok: true, value: world });
    },
  });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { cursor = 0; refCursor = 0; return component({ t: key => key }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  let tree = render(); assert.equal(calls.length, 0);
  assert.ok(JSON.stringify(tree).includes('modelStatus.configured')); assert.ok(!JSON.stringify(tree).includes('must-not-render'));
  const password = nodes(tree).find(node => node.type === 'input' && node.props.ref);
  assert.equal(password.props.type, 'password'); assert.equal(password.props.value, undefined);
  password.props.ref.current.value = secret;
  const form = nodes(tree).find(node => node.type === 'form'); form.props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(refs[0].current.value, ''); assert.equal(writes.length, 0);
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:3082/model', 'http://127.0.0.1:3082/world']);
  assert.deepEqual(calls[0].payload, { model: 'deepseek-flash', apiKey: secret });
  tree = render(); assert.ok(!JSON.stringify(tree).includes(secret));
  const testButton = nodes(tree).find(node => node.type === 'button' && node.children.includes('modelTest'));
  testButton.props.onClick(); await new Promise(setImmediate);
  assert.deepEqual(calls[2], { url: 'http://127.0.0.1:3082/model/test', payload: {} });
  assert.equal(states[7], 'modelTestFailed'); assert.ok(!JSON.stringify(render()).includes(secret));
  states[2] = { ...world, model: { ...world.model, configured: false, status: 'unconfigured' } };
  tree = render(); assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('modelTest')).props.disabled, true);
  assert.ok(JSON.stringify(tree).includes('modelStatus.unconfigured'));
  states[2] = { ...world, world: { ...world.world, paused: false } };
  tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('modelSave')).props.disabled, true);
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('modelTest')).props.disabled, false);
  assert.ok(JSON.stringify(tree).includes('modelPauseRequired'));
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 4, 'running world never saves model configuration');
  states[2] = world; states[8] = 'deepseek-chat'; tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('modelSave')).props.disabled, true);
  states[8] = 'deepseek-v4-pro'; tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.children.includes('modelSave')).props.disabled, false);
});
test('bilingual resource metadata has matching keys and flattens to strings', async () => {
  const en = JSON.parse(await readFile(new URL('locale/en.json', root), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('locale/zh.json', root), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort()); assert.ok(en.meta.title && zh.meta.description);
  const icon = await readFile(new URL('icon.svg', root), 'utf8'); assert.ok(icon.startsWith('<svg')); assert.ok(icon.length < 256 * 1024);
  for (const source of [en, zh]) {
    const flat = flattenDictionary(source);
    assert.equal(flat['modelStatus.unconfigured'], source.modelStatus.unconfigured);
    assert.equal(flat['errors.request_failed'], source.errors.request_failed);
    assert.ok(Object.values(flat).every(value => typeof value === 'string'));
    assert.deepEqual(Object.keys(flattenDictionary(en)).sort(), Object.keys(flattenDictionary(zh)).sort());
  }
});
test('uppercase Authority error codes map to localized console codes without echoing messages', async () => {
  const fail = (code, status) => operatorRequest({ location, token: 'test-only', path: '/persona', payload: { patch: {} }, fetchImpl: async () => response({ ok: false, error: { code, message: 'reflected test-only' } }, status) });
  for (const [code, mapped] of [['VALIDATION_ERROR', 'validation_error'], ['INVALID_REQUEST', 'invalid_request'], ['BODY_TOO_LARGE', 'body_too_large'], ['OPERATION_FAILED', 'operation_failed'], ['UNKNOWN_THING', 'request_failed'], ['TOSTRING', 'request_failed']]) {
    await assert.rejects(fail(code, code === 'BODY_TOO_LARGE' ? 413 : 500), error => error.code === mapped && !error.message.includes('reflected'));
  }
  const en = JSON.parse(await readFile(new URL('locale/en.json', root), 'utf8')), zh = JSON.parse(await readFile(new URL('locale/zh.json', root), 'utf8'));
  for (const key of ['validation_error', 'invalid_request', 'body_too_large', 'operation_failed']) assert.ok(en.errors[key] && zh.errors[key]);
});
