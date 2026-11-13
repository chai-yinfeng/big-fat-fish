import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Authority } from '../../authority/src/engine.js';
import { createAuthorityServer } from '../../authority/src/server.js';
import { createContentControlClient } from '../../authority/src/content-control.js';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createContentServer } from './server.mjs';
import http from 'node:http';
import { ContentClient, capabilityGateway, meteredSpeech } from './client.js';

test('real capability and private-control sockets preserve media provenance; pause prevents work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-content-flow-'));
  const core = new Authority({ file: path.join(root, 'core.sqlite') });
  const capabilityToken = 'synthetic-capability-credential-for-media', controlToken = 'synthetic-content-control-credential';
  const tokenFile = path.join(root, 'cap.token'), controlFile = path.join(root, 'control.token');
  fs.writeFileSync(tokenFile, capabilityToken, { mode: 0o600 }); fs.writeFileSync(controlFile, controlToken, { mode: 0o600 });
  core.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  core.bindActor({ capabilityId: 'qq', externalActorId: 'owner', personId: 'person:owner' });
  core.bindStream({ capabilityId: 'qq', streamId: 'private', personId: 'person:owner', audience: 'private' });
  core.observe('qq', { streamId: 'private', eventId: 'source', actorId: 'owner', role: 'user', text: '[audio attachment]', at: 1 });
  let speechCalls = 0; const qualities = [];
  const store = new ArtifactStore({ root: path.join(root, 'media') });
  const service = new MediaService({ store, workRoot: path.join(root, 'work'), speech: { transcribe: async args => { speechCalls++; qualities.push(Object.hasOwn(args, 'quality')); return { text: '合成测试转写', model: 'synthetic' }; } } });
  const controlSocket = path.join(root, 'content.sock'), socketPath = path.join(root, 'core.sock');
  const content = createContentServer({ socketPath: controlSocket, tokenFile: controlFile, service, worldStatus: async () => core.worldStatus() });
  const authority = createAuthorityServer({ authority: core, socketPath, credentials: [{ role: 'capability', capabilityId: 'qq', hash: createHash('sha256').update(capabilityToken).digest('hex') }], contentControl: createContentControlClient({ socketPath: controlSocket, tokenFile: controlFile }) });
  t.after(async () => { await content.close(); await authority.close(); core.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^fish-content-flow-/); fs.rmSync(root, { recursive: true }); });
  await content.start(); await authority.start(); const client = new ContentClient({ socketPath, tokenFile });
  const wave = Buffer.alloc(46); wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(2, 40);
  const scope = { streamId: 'private', memoryEpoch: 0 };
  const artifact = await client.call({ ...scope, action: 'ingest', kind: 'audio', sourceEventId: 'source', data: wave.toString('base64') });
  const result = await client.call({ ...scope, action: 'transcribe', ref: artifact.id });
  assert.equal(result.text, '合成测试转写'); assert.equal(result.isVerbatimUserText, false); assert.equal(result.isNewEvidence, false); assert.deepEqual(qualities, [false]);
  assert.equal(JSON.parse(core.store.db.prepare('SELECT body FROM observations WHERE event_id=?').get('source').body).text, '[audio attachment]');
  core.setWorldPaused({ paused: true, expectedRevision: core.worldStatus().revision });
  await assert.rejects(client.call({ ...scope, action: 'transcribe', ref: artifact.id })); assert.equal(speechCalls, 1);
});

test('a spend-tier refusal keeps its code from the gateway through the content service and Authority to the channel', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-content-flow-'));
  const core = new Authority({ file: path.join(root, 'core.sqlite') });
  const capabilityToken = 'synthetic-capability-credential-for-media', controlToken = 'synthetic-content-control-credential', gatewayToken = 'synthetic-gateway-credential-for-media';
  const tokenFile = path.join(root, 'cap.token'), controlFile = path.join(root, 'control.token'), gatewayFile = path.join(root, 'gateway.token');
  fs.writeFileSync(tokenFile, capabilityToken, { mode: 0o600 }); fs.writeFileSync(controlFile, controlToken, { mode: 0o600 }); fs.writeFileSync(gatewayFile, gatewayToken, { mode: 0o600 });
  core.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  core.bindActor({ capabilityId: 'qq', externalActorId: 'owner', personId: 'person:owner' });
  core.bindStream({ capabilityId: 'qq', streamId: 'private', personId: 'person:owner', audience: 'private' });
  core.observe('qq', { streamId: 'private', eventId: 'source', actorId: 'owner', role: 'user', text: '[image attachment]', at: 1 });
  // A stand-in gateway answering the way the real one refuses (429 + fixed code).
  let refusal = 'SPEND_RESTRICTED';
  const gatewaySocket = path.join(root, 'gateway.sock');
  const gatewayServer = http.createServer((req, res) => { req.resume(); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: refusal, message: 'x' } })); });
  await new Promise(resolve => gatewayServer.listen(gatewaySocket, resolve));
  const gateway = capabilityGateway({ socketPath: gatewaySocket, tokenFile: gatewayFile });
  const service = new MediaService({ store: new ArtifactStore({ root: path.join(root, 'media') }), workRoot: path.join(root, 'work'), speech: {}, normalizeImage: async data => ({ data, mime: 'image/gif' }), vision: gateway.vision, search: gateway.search, fetchPage: gateway.fetchPage });
  const controlSocket = path.join(root, 'content.sock'), socketPath = path.join(root, 'core.sock');
  const content = createContentServer({ socketPath: controlSocket, tokenFile: controlFile, service, worldStatus: async () => core.worldStatus() });
  const authority = createAuthorityServer({ authority: core, socketPath, credentials: [{ role: 'capability', capabilityId: 'qq', hash: createHash('sha256').update(capabilityToken).digest('hex') }], contentControl: createContentControlClient({ socketPath: controlSocket, tokenFile: controlFile }) });
  t.after(async () => { await content.close(); await authority.close(); await new Promise(resolve => gatewayServer.close(resolve)); core.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^fish-content-flow-/); fs.rmSync(root, { recursive: true }); });
  await content.start(); await authority.start(); const client = new ContentClient({ socketPath, tokenFile });
  const scope = { streamId: 'private', memoryEpoch: 0 };
  const artifact = await client.call({ ...scope, action: 'ingest', kind: 'image', sourceEventId: 'source', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });
  await assert.rejects(client.call({ ...scope, action: 'describe', ref: artifact.id }), { code: 'CONTENT_SPEND_RESTRICTED' });
  await assert.rejects(client.call({ ...scope, action: 'search', query: 'x' }), { code: 'CONTENT_SPEND_RESTRICTED' });
  // The daily call count (and anything else) still reaches the channel as a plain failure.
  refusal = 'BUDGET_EXHAUSTED';
  await assert.rejects(client.call({ ...scope, action: 'describe', ref: artifact.id }), { code: 'CONTENT_OPERATION_UNAVAILABLE' });
});

test('local speech is reported to the usage ledger: count, units and time, never text; a ledger that is down changes nothing', async () => {
  let now = 1000;
  const reports = [], runner = {
    status: () => ({ configured: true }),
    transcribe: async ({ inputFile }) => { now += 900; if (inputFile === 'bad.wav') throw Object.assign(new Error('SPEECH_AUDIO_LIMIT'), { code: 'SPEECH_AUDIO_LIMIT' }); return { text: 'MOCK 转写', model: 'synthetic', durationMs: 6540 }; },
    synthesize: async () => { now += 5200; return { model: 'synthetic', durationMs: 4210, sampleRate: 24000, mime: 'audio/wav' }; },
  };
  const speech = meteredSpeech(runner, async body => { reports.push(body); }, () => now);
  assert.deepEqual(speech.status(), { configured: true });
  assert.equal((await speech.transcribe({ inputFile: 'ok.wav' })).text, 'MOCK 转写');
  await assert.rejects(speech.transcribe({ inputFile: 'bad.wav' }), { code: 'SPEECH_AUDIO_LIMIT' });
  assert.equal((await speech.synthesize({ text: 'MOCK 你好呀', outputFile: 'out.wav' })).durationMs, 4210);
  assert.deepEqual(reports, [
    { capability: 'speech-asr', outcome: 'ok', busyMs: 900, units: { audioSeconds: 6.5 } },
    { capability: 'speech-asr', outcome: 'failed', busyMs: 900 },
    { capability: 'speech-tts', outcome: 'ok', busyMs: 5200, units: { chars: 8, audioSeconds: 4.2 } },
  ]);
  assert.ok(!JSON.stringify(reports).includes('MOCK'), 'no text leaves the content process');
  // A ledger that rejects, throws or never answers: speech still returns its result at once.
  for (const record of [async () => { throw new Error('down'); }, () => { throw new Error('down'); }, () => new Promise(() => {})]) {
    const unavailable = meteredSpeech(runner, record, () => now);
    assert.equal((await unavailable.synthesize({ text: 'MOCK', outputFile: 'out.wav' })).durationMs, 4210);
    assert.equal((await unavailable.transcribe({ inputFile: 'ok.wav' })).text, 'MOCK 转写');
    await assert.rejects(unavailable.transcribe({ inputFile: 'bad.wav' }), { code: 'SPEECH_AUDIO_LIMIT' });
  }
});
