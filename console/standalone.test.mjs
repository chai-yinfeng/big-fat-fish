import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, consumeOperatorFragment, TOKEN_KEY } from './operator-client.js';
import { speechPayload, referencePayload, inspectReferenceWav, validRuntime, ttsBackend } from './runtime-client.js';
const root = new URL('./', import.meta.url);
const response = value => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) });
function wav() { const b = Buffer.alloc(44 + 16000 * 2 * 3); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b; }

test('standalone assets contain their own runtime and never load DSH boot, slots or session RPC', async () => {
  const html = await fs.readFile(new URL('dist/index.html', root), 'utf8'), js = await fs.readFile(new URL('dist/console.js', root), 'utf8'), css = await fs.readFile(new URL('dist/console.css', root), 'utf8');
  assert.match(html, /lang="zh-CN"/); assert.match(html, /src="\/console.js"/); assert.match(html, /href="\/console.css"/);
  assert.doesNotMatch(html, /https?:\/\//); assert.doesNotMatch(js, /__DSH_BOOT__|__ModuleLoader__|createDshSession|\/api\/session\/create|settings\.section/);
  assert.match(js, /companion-operator=/); assert.match(css, /--bff-page/); assert.match(css, /prefers-color-scheme/);
  assert.deepEqual((await fs.readdir(new URL('dist/', root))).sort(), ['console.css', 'console.js', 'icon.svg', 'index.html']);
});

test('standalone uses its explicit same-origin loopback API and consumes only the access fragment', async () => {
  const writes = [], replaced = [], token = 's'.repeat(43), page = { protocol: 'http:', hostname: '127.0.0.1', port: '19082', pathname: '/', search: '', hash: '#companion-operator=' + token };
  assert.equal(consumeOperatorFragment({ location: page, history: { state: null, replaceState: (...args) => replaced.push(args) }, storage: { setItem: (...args) => writes.push(args) } }), true);
  const payload = speechPayload('revision-one', { numThreads: '8', maxTextChars: '100' });
  await operatorRequest({ location: page, sameOrigin: true, token, path: '/speech', payload, fetchImpl: async (url, options) => { assert.equal(url, 'http://127.0.0.1:19082/speech'); assert.equal(options.mode, 'same-origin'); assert.equal(options.credentials, 'omit'); assert.deepEqual(JSON.parse(options.body), payload); return response({}); } });
  assert.deepEqual(writes, [[TOKEN_KEY, token]]); assert.deepEqual(replaced, [[null, '', '/']]);
  await assert.rejects(operatorRequest({ location: { ...page, hostname: 'untrusted.example' }, sameOrigin: true, token, path: '/runtime', fetchImpl: () => assert.fail() }), /loopback_required/);
  assert.throws(() => speechPayload('r', { numThreads: 0, maxTextChars: 100 }), /invalid_speech_parameters/); assert.throws(() => speechPayload('r', { numThreads: 17, maxTextChars: 100 }), /invalid_speech_parameters/);
  assert.throws(() => referencePayload('r', 'YWJj', 'text', true, { voiceId: '../x', label: 'x', language: 'ja', usageScope: 'private' }), /invalid_voice_fields/);
  assert.throws(() => referencePayload('r', 'YWJj', 'text', false), /reference_authorization_required/);
  assert.equal(inspectReferenceWav(wav()).durationMs, 3000);
  assert.throws(() => inspectReferenceWav(new Uint8Array([1, 2, 3])), /invalid_reference_audio/);
});

test('standalone reference and speech actions are explicit, ephemeral and paused; audio URLs are revoked', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' } };
  const profile = { id: 'actress', label: 'Synthetic actress', engine: 'llama-tts', referenceLanguage: 'ja', usageScope: 'private', useReferenceText: false, auditioned: false, hasReference: true };
  const runtime = { speech: { status: 'ready', configurationRevision: 'runtime-r1', numThreads: 8, maxTextChars: 100, models: Object.fromEntries(['asr:default', 'tts:llama-tts'].map(key => [key, { model: 'test-' + key, componentsPresent: true, enabled: true, verified: true }])) }, voices: { defaultVoice: 'actress', profiles: [profile, { ...profile, id: 'synthetic', label: 'Synthetic public', usageScope: 'public' }], cleanupPending: false, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false }, imageGeneration: { configured: false, status: 'not_configured' } };
  const states = ['operator-test', '', world, {}, 'runtime', false, '', '', 'deepseek-flash', null, null, null, runtime, { numThreads: 8, maxTextChars: 100 }];
  const refs = [], calls = [], storageWrites = [], revoked = []; let stateIndex = 0, refIndex = 0, component, loaded, urlCount = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => { if ((type === 'input' || type === 'textarea') && props.ref) props.ref.current ||= { value: '' }; return { type, props: props || {}, children: children.flat(Infinity) }; } };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => storageWrites.push(args), removeItem() {} };
  const bytes = wav();
  loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '19082', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, Blob, atob, btoa, URL: { createObjectURL: () => 'blob:test-' + (++urlCount), revokeObjectURL: url => revoked.push(url) },
    fetch: async (url, options) => { const payload = options.body && JSON.parse(options.body); calls.push({ url, payload }); if (url.endsWith('/voice/reference')) { assert.equal(refs[6].current.value, ''); assert.equal(refs[7].current.value, ''); assert.equal(refs[8].current.checked, false); } return response(url.endsWith('/world') ? world : url.endsWith('/voice/test') ? { audioBase64: bytes.toString('base64'), mime: 'audio/wav', durationMs: 3000, model: 'test-tts' } : runtime); } });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { stateIndex = 0; refIndex = 0; return component({ t: key => key, standalone: true }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  const buttons = key => nodes(render()).filter(n => n.type === 'button' && n.children.includes(key));
  assert.equal(calls.length, 0); assert.match(JSON.stringify(render()), /speechPanel.imageUnavailable/);
  states[4] = 'channels'; assert.doesNotMatch(JSON.stringify(render()), /sessionTitle/); states[4] = 'runtime';
  const saveForm = nodes(render()).find(n => n.type === 'form' && n.children.some(c => c?.type === 'button' && c.children.includes('speechPanel.save')));
  saveForm.props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:19082/speech', payload: { expectedRevision: 'runtime-r1', numThreads: 8, maxTextChars: 100 } });
  render(); refs[6].current = { value: 'ignored-file-name.wav', files: [{ size: bytes.length, name: 'must-not-send-file-name.wav', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }] }; refs[7].current.value = 'synthetic exact transcript'; refs[8].current.checked = true; states[16] = { voiceId: 'new-voice', label: 'New voice', language: 'ja', usageScope: 'private' };
  const upload = nodes(render()).find(n => n.type === 'form' && n.children.some(c => c?.type === 'button' && c.children.includes('speechPanel.upload')));
  upload.props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  const submitted = calls.find(c => c.url.endsWith('/voice/reference'));
  assert.deepEqual(Object.keys(submitted.payload).sort(), ['audioBase64', 'authorized', 'expectedRevision', 'label', 'language', 'transcript', 'usageScope', 'voiceId']); assert.equal(submitted.payload.voiceId, 'new-voice'); assert.equal(submitted.payload.authorized, true); assert.equal(submitted.payload.transcript, 'synthetic exact transcript');
  assert.equal(storageWrites.length, 0); assert.doesNotMatch(JSON.stringify(render(), (key, value) => key === 'ref' ? undefined : value), /synthetic exact transcript|must-not-send-file-name/);
  await buttons('speechPanel.test')[1].props.onClick(); assert.deepEqual(calls.at(-1).payload, { voiceId: 'synthetic' }); let audio = nodes(render()).find(n => n.type === 'audio'); assert.equal(audio.props.autoPlay, undefined); assert.equal(audio.props.preload, 'none'); assert.equal(audio.props.src, 'blob:test-1');
  await button('speechPanel.test').props.onClick(); assert.deepEqual(revoked, ['blob:test-1']);
  await button('speechPanel.makeDefault').props.onClick(); assert.deepEqual(calls.find(c => c.url.endsWith('/voice/default')).payload, { expectedRevision: 'runtime-r1', voiceId: 'synthetic' });
  button('speechPanel.remove').props.onClick(); assert.equal(calls.some(c => c.url.endsWith('/voice/reference/remove')), false);
  assert.ok(button('speechPanel.removeConfirm'));
  button('discard').props.onClick(); assert.equal(calls.some(c => c.url.endsWith('/voice/reference/remove')), false);
  states[12] = { ...runtime, voices: { ...runtime.voices, cleanupPending: true } };
  assert.ok(button('speechPanel.retryCleanup')); assert.equal(button('speechPanel.upload'), undefined); assert.match(JSON.stringify(render()), /speechPanel.cleanupPending/);
  button('logout').props.onClick(); assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
  states[0] = 'operator-test'; states[2] = { ...world, world: { ...world.world, paused: false } }; states[12] = runtime; states[13] = { ...runtime.speech }; assert.ok(buttons('speechPanel.test').every(b => b.props.disabled === true));
});

test('degraded speech status renders a localized reason; a failed action keeps the loaded world on screen', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' } };
  const degraded = reason => ({ speech: { status: reason }, voices: null, imageGeneration: { configured: false, status: 'not_configured' } });
  for (const reason of ['not_configured', 'config_schema_outdated', 'config_invalid']) assert.equal(validRuntime(degraded(reason)), true);
  assert.equal(validRuntime({ ...degraded('config_invalid'), speech: { status: 'config_invalid', numThreads: 2 } }), false);
  assert.equal(validRuntime(degraded('broken')), false);
  const states = ['operator-test', '', world, {}, 'runtime'], refs = []; let stateIndex = 0, refIndex = 0, fail = false;
  const React = { Fragment: 'fragment', useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => { if ((type === 'input' || type === 'textarea') && props?.ref) props.ref.current ||= { value: '' }; return { type, props: props || {}, children: children.flat(Infinity) }; } };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '19082', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async url => fail
      ? { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'reflected-secret' } }) }
      : response(url.endsWith('/world') ? world : degraded('config_schema_outdated')) });
  const component = loaded.factory(() => React).WorldConsole;
  const render = () => { stateIndex = 0; refIndex = 0; return component({ t: key => key, standalone: true }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  await button('speechPanel.refresh').props.onClick(); await new Promise(setImmediate);
  let tree = JSON.stringify(render());
  assert.match(tree, /speechPanel.unavailable.config_schema_outdated/); assert.doesNotMatch(tree, /speechPanel.voiceTitle/);
  assert.match(tree, /modelSave/, 'the rest of the runtime view still renders');
  fail = true; await button('speechPanel.refresh').props.onClick(); await new Promise(setImmediate);
  assert.equal(states[2], world, 'an error never blanks the loaded world');
  tree = JSON.stringify(render()); assert.match(tree, /errors.validation_error/); assert.doesNotMatch(tree, /reflected-secret/); assert.match(tree, /modelSave/);
});

test('TTS backend view: configured device, observed or probe-expected backend, known fallback codes only', async () => {
  assert.equal(ttsBackend({}), null); assert.equal(ttsBackend({ tts: null }), null); assert.equal(ttsBackend({ tts: { device: 'gpu', backend: 'vulkan' } }), null);
  assert.deepEqual(ttsBackend({ tts: { device: 'auto', backend: 'vulkan', fallback: null, observed: true } }), { device: 'auto', backend: 'vulkan', observed: true, fallback: null });
  assert.deepEqual(ttsBackend({ tts: { device: 'auto', backend: 'cpu', fallback: 'SPEECH_VULKAN_FAILED', observed: true } }), { device: 'auto', backend: 'cpu', observed: true, fallback: 'SPEECH_VULKAN_FAILED' });
  assert.deepEqual(ttsBackend({ tts: { device: 'auto', backend: 'cpu', fallback: 'SPEECH_<b>', observed: 1 } }), { device: 'auto', backend: 'cpu', observed: false, fallback: null });
  // Rendered by the real view from the server's runtime status (no synthesis is triggered to find out).
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' } };
  const runtime = tts => ({ speech: { status: 'ready', configurationRevision: 'r1', numThreads: 8, maxTextChars: 100, models: { 'tts:llama-tts': { model: 'm', componentsPresent: true, enabled: true, verified: true } }, ...(tts === undefined ? {} : { tts }) }, voices: { defaultVoice: null, profiles: [], cleanupPending: false }, imageGeneration: { configured: false, status: 'not_configured' } });
  const states = ['operator-test', '', world, {}, 'runtime', false, '', '', 'deepseek-flash', null, null, null, null, { numThreads: 8, maxTextChars: 100 }], refs = []; let stateIndex = 0, refIndex = 0, calls = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: () => 'operator-test', setItem() {}, removeItem() {} };
  const loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '19082', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: async () => { calls++; return response(world); } });
  const component = loaded.factory(() => React).WorldConsole;
  const rendered = tts => { states[12] = runtime(tts); stateIndex = 0; refIndex = 0; return JSON.stringify(component({ t: key => key, standalone: true })); };
  assert.doesNotMatch(rendered(undefined), /speechPanel\.tts(Backend|Device|Last|Expected|Fallback)/); // an older server
  let tree = rendered({ device: 'auto', backend: 'vulkan', fallback: null, observed: false });
  assert.match(tree, /speechPanel\.ttsBackend/); assert.match(tree, /"Vulkan"/); assert.match(tree, /speechPanel\.ttsDevice\.auto · speechPanel\.ttsExpected\.vulkan"/);
  tree = rendered({ device: 'auto', backend: 'cpu', fallback: 'SPEECH_VULKAN_FAILED', observed: true });
  assert.match(tree, /"bff-badge warn"/); assert.match(tree, /"CPU"/); assert.match(tree, /speechPanel\.ttsDevice\.auto · speechPanel\.ttsLast\.cpu · speechPanel\.ttsFallback\.SPEECH_VULKAN_FAILED"/);
  tree = rendered({ device: 'cpu', backend: 'cpu', fallback: null, observed: true });
  assert.match(tree, /speechPanel\.ttsDevice\.cpu · speechPanel\.ttsLast\.cpu"/);
  assert.equal(calls, 0);
  const { readFile } = await import('node:fs/promises');
  for (const name of ['en', 'zh']) {
    const panel = JSON.parse(await readFile(new URL(`./locale/${name}.json`, import.meta.url), 'utf8')).speechPanel;
    assert.ok(panel.ttsBackend);
    assert.deepEqual(Object.keys(panel.ttsDevice), ['auto', 'vulkan', 'cpu']);
    for (const group of ['ttsLast', 'ttsExpected']) assert.deepEqual(Object.keys(panel[group]), ['vulkan', 'cpu']);
    assert.deepEqual(Object.keys(panel.ttsFallback), ['SPEECH_VULKAN_UNSUPPORTED', 'SPEECH_VULKAN_NO_DEVICE', 'SPEECH_VULKAN_FAILED']);
  }
});
