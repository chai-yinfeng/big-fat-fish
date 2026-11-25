import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { validRuntime, COOKIE_STATES } from './runtime-client.js';

const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' } };
const speech = { speech: { status: 'ready', configurationRevision: 'r1', numThreads: 8, maxTextChars: 100, models: {} }, voices: { defaultVoice: null, profiles: [], cleanupPending: false }, imageGeneration: { configured: false, status: 'not_configured' } };
const video = (cookie = {}, configured = true) => ({ configured, cookie: { state: 'configured', lastSuccessAt: null, suspectedExpired: false, ...cookie } });
// Hook position in view.js: the runtime status is state 12 (as in standalone.test.mjs).
const RUNTIME = 12;

test('the runtime status may carry the video capability\'s state; an older server has none, a malformed one is refused', () => {
  assert.equal(validRuntime(speech), true);
  assert.equal(validRuntime({ ...speech, video: null }), true);
  for (const state of COOKIE_STATES) assert.equal(validRuntime({ ...speech, video: video({ state }) }), true, state);
  assert.equal(validRuntime({ ...speech, video: video({ lastSuccessAt: 1_800_000_000_000, suspectedExpired: true }) }), true);
  const degraded = { speech: { status: 'not_configured' }, voices: null, imageGeneration: { configured: false, status: 'not_configured' } };
  assert.equal(validRuntime({ ...degraded, video: video() }), true, 'the video state does not depend on speech');
  for (const bad of [{ configured: 'yes', cookie: video().cookie }, video({ state: 'other' }), video({ lastSuccessAt: 'yesterday' }), video({ suspectedExpired: 1 }), { configured: true }]) assert.equal(validRuntime({ ...speech, video: bad }), false, JSON.stringify(bad));
});

test('the video card on the runtime page shows configured or not, the cookies\' state, last success and possibly expired, never more', async () => {
  const states = ['operator-test', '', world, {}, 'runtime', false, '', '', 'deepseek-flash', null, null, null, null, { numThreads: 8, maxTextChars: 100 }], refs = []; let stateIndex = 0, refIndex = 0, calls = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '19082', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, value: world }) }; } });
  const component = loaded.factory(() => React).WorldConsole;
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const textOf = node => typeof node === 'boolean' || node == null ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' ');
  const card = runtime => {
    states[RUNTIME] = runtime; stateIndex = 0; refIndex = 0;
    const tree = component({ t: key => key, standalone: true });
    // The innermost section with the title: the card itself, not a page around it.
    return nodes(tree).filter(node => node.type === 'section' && node.props.className === 'bff-card' && textOf(node).includes('videoPanel.title')).at(-1);
  };
  // Not loaded yet, then an older content service that says nothing about videos.
  assert.match(textOf(card(null)), /speechPanel\.pending/);
  assert.match(textOf(card(speech)), /videoPanel\.unavailable/);
  // No cookie file.
  let text = textOf(card({ ...speech, video: video({ state: 'none' }, false) }));
  assert.match(text, /videoPanel\.notConfigured/); assert.match(text, /videoPanel\.cookieState\.none/); assert.match(text, /videoPanel\.lastSuccess —/);
  assert.doesNotMatch(text, /videoPanel\.suspectedExpired/);
  // Configured, with a last success and then a sign of expiry.
  const at = Date.UTC(2026, 10, 25, 4, 0, 0);
  text = textOf(card({ ...speech, video: video({ lastSuccessAt: at }) }));
  assert.match(text, /videoPanel\.configured/); assert.match(text, /videoPanel\.cookieState\.configured/); assert.ok(text.includes(new Date(at).toLocaleString()));
  assert.doesNotMatch(text, /videoPanel\.suspectedExpired/);
  const suspected = card({ ...speech, video: video({ lastSuccessAt: at, suspectedExpired: true }) });
  assert.ok(nodes(suspected).some(node => node.props?.className === 'bff-badge warn' && textOf(node).includes('videoPanel.suspectedExpired')));
  // Unsafe permissions: said in red; no "possibly expired" beside a file that is not used.
  const unsafe = card({ ...speech, video: video({ state: 'unsafe', suspectedExpired: true }) });
  assert.ok(nodes(unsafe).some(node => node.props?.className === 'bff-badge danger' && textOf(node).includes('videoPanel.cookieState.unsafe')));
  assert.doesNotMatch(textOf(unsafe), /videoPanel\.suspectedExpired/);
  // Nothing to type or press: the cookies are the operator's to put on the host.
  assert.deepEqual(nodes(unsafe).filter(node => ['input', 'button', 'form', 'textarea'].includes(node.type)), []);
  assert.equal(calls, 0);
  for (const name of ['en', 'zh']) {
    const panel = JSON.parse(await readFile(new URL(`./locale/${name}.json`, import.meta.url), 'utf8')).videoPanel;
    assert.deepEqual(Object.keys(panel.cookieState), COOKIE_STATES, name);
    for (const key of ['title', 'hint', 'unavailable', 'capability', 'configured', 'notConfigured', 'cookie', 'suspectedExpired', 'lastSuccess', 'cookieHint']) assert.equal(typeof panel[key], 'string', `${name} ${key}`);
  }
});
