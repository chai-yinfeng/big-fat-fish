import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConsole } from './test-harness.mjs';
import { operatorRequest, consumeOperatorFragment, TOKEN_KEY } from './operator-client.js';
import { speechPayload, referencePayload, inspectReferenceWav } from './runtime-client.js';
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
  const payload = speechPayload('revision-one', { defaultTtsQuality: 'heavy', numThreads: '2', maxTextChars: '100' });
  await operatorRequest({ location: page, sameOrigin: true, token, path: '/speech', payload, fetchImpl: async (url, options) => { assert.equal(url, 'http://127.0.0.1:19082/speech'); assert.equal(options.mode, 'same-origin'); assert.equal(options.credentials, 'omit'); assert.deepEqual(JSON.parse(options.body), payload); return response({}); } });
  assert.deepEqual(writes, [[TOKEN_KEY, token]]); assert.deepEqual(replaced, [[null, '', '/']]);
  await assert.rejects(operatorRequest({ location: { ...page, hostname: 'untrusted.example' }, sameOrigin: true, token, path: '/runtime', fetchImpl: () => assert.fail() }), /loopback_required/);
  assert.throws(() => speechPayload('r', { defaultTtsQuality: 'heavy', numThreads: 0, maxTextChars: 100 }), /invalid_speech_parameters/);
  assert.throws(() => referencePayload('r', 'YWJj', 'text', false), /reference_authorization_required/);
  assert.equal(inspectReferenceWav(wav()).durationMs, 3000);
  assert.throws(() => inspectReferenceWav(new Uint8Array([1, 2, 3])), /invalid_reference_audio/);
});

test('standalone reference and speech actions are explicit, ephemeral and paused; audio URLs are revoked', async () => {
  const world = { world: { paused: true, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: true, status: 'configured' } };
  const runtime = { speech: { configurationRevision: 'runtime-r1', defaultTtsQuality: 'heavy', numThreads: 2, maxTextChars: 100, models: Object.fromEntries(['asr:light', 'asr:heavy', 'tts:light', 'tts:heavy'].map(key => [key, { model: 'test-' + key, componentsPresent: true, enabled: true, verified: true }])) }, voice: { profileId: 'default', origin: 'kokoro-local', hasReference: true, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false }, imageGeneration: { configured: false, status: 'not_configured' } };
  const states = ['operator-test', '', world, {}, 'runtime', false, '', '', 'deepseek-flash', null, null, null, runtime, { defaultTtsQuality: 'heavy', numThreads: 2, maxTextChars: 100 }];
  const refs = [], calls = [], storageWrites = [], revoked = []; let stateIndex = 0, refIndex = 0, component, loaded, urlCount = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; }, useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => { if ((type === 'input' || type === 'textarea') && props.ref) props.ref.current ||= { value: '' }; return { type, props: props || {}, children: children.flat(Infinity) }; } };
  const storage = { getItem: () => 'operator-test', setItem: (...args) => storageWrites.push(args), removeItem() {} };
  const bytes = wav();
  loaded = await loadConsole({ window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '19082', hash: '' }, sessionStorage: storage }, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, Blob, atob, btoa, URL: { createObjectURL: () => 'blob:test-' + (++urlCount), revokeObjectURL: url => revoked.push(url) },
    fetch: async (url, options) => { const payload = options.body && JSON.parse(options.body); calls.push({ url, payload }); if (url.endsWith('/voice/reference')) { assert.equal(refs[6].current.value, ''); assert.equal(refs[7].current.value, ''); assert.equal(refs[8].current.checked, false); } return response(url.endsWith('/world') ? world : url.endsWith('/voice/test') ? { audioBase64: bytes.toString('base64'), mime: 'audio/wav', durationMs: 3000, model: 'test-heavy' } : runtime); } });
  component = loaded.factory(() => React).WorldConsole;
  const render = () => { stateIndex = 0; refIndex = 0; return component({ t: key => key, standalone: true }); };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
  const button = key => nodes(render()).find(n => n.type === 'button' && n.children.includes(key));
  assert.equal(calls.length, 0); assert.match(JSON.stringify(render()), /speechPanel.imageUnavailable/);
  states[4] = 'channels'; assert.doesNotMatch(JSON.stringify(render()), /sessionTitle/); states[4] = 'runtime';
  const saveForm = nodes(render()).find(n => n.type === 'form' && n.children.some(c => c?.type === 'button' && c.children.includes('speechPanel.save')));
  saveForm.props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:19082/speech', payload: { expectedRevision: 'runtime-r1', defaultTtsQuality: 'heavy', numThreads: 2, maxTextChars: 100 } });
  render(); refs[6].current = { value: 'ignored-file-name.wav', files: [{ size: bytes.length, name: 'must-not-send-file-name.wav', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }] }; refs[7].current.value = 'synthetic exact transcript'; refs[8].current.checked = true;
  const upload = nodes(render()).find(n => n.type === 'form' && n.children.some(c => c?.type === 'button' && c.children.includes('speechPanel.upload')));
  upload.props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  const submitted = calls.find(c => c.url.endsWith('/voice/reference'));
  assert.deepEqual(Object.keys(submitted.payload).sort(), ['audioBase64', 'authorized', 'expectedRevision', 'transcript']); assert.equal(submitted.payload.authorized, true); assert.equal(submitted.payload.transcript, 'synthetic exact transcript');
  assert.equal(storageWrites.length, 0); assert.doesNotMatch(JSON.stringify(render(), (key, value) => key === 'ref' ? undefined : value), /synthetic exact transcript|must-not-send-file-name/);
  await button('speechPanel.test').props.onClick(); let audio = nodes(render()).find(n => n.type === 'audio'); assert.equal(audio.props.autoPlay, undefined); assert.equal(audio.props.preload, 'none'); assert.equal(audio.props.src, 'blob:test-1');
  await button('speechPanel.test').props.onClick(); assert.deepEqual(revoked, ['blob:test-1']);
  states[12] = { ...runtime, voice: { ...runtime.voice, origin: 'operator-authorized' } };
  button('speechPanel.remove').props.onClick(); assert.equal(calls.some(c => c.url.endsWith('/voice/reference/remove')), false);
  assert.ok(button('speechPanel.removeConfirm'));
  button('discard').props.onClick(); assert.equal(calls.some(c => c.url.endsWith('/voice/reference/remove')), false);
  states[12] = { ...runtime, voice: { ...runtime.voice, cleanupPending: true } };
  assert.ok(button('speechPanel.retryCleanup')); assert.equal(button('speechPanel.upload'), undefined); assert.match(JSON.stringify(render()), /speechPanel.cleanupPending/);
  button('logout').props.onClick(); assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
  states[0] = 'operator-test'; states[2] = { ...world, world: { ...world.world, paused: false } }; states[12] = runtime; states[13] = { ...runtime.speech }; assert.equal(button('speechPanel.test').props.disabled, true);
});
