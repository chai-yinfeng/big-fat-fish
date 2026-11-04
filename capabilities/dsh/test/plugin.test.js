import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';
import { qqRequestId, qqSessionId } from '../../qq/worker-route.js';

class Scope {
  sessionQuery = { readSurface: async () => ({ events: [], capturedThroughSeq: null }) };
  handlers = new Map(); toolsList = []; contexts = []; disposers = []; restrictions = []; services = new Map();
  provide(name, value) { assert.equal(this.services.has(name), false); this.services.set(name, value); const dispose = () => this.services.delete(name); this.disposers.push(dispose); return dispose; }
  globals = ['ask_user_question', 'bash', 'web_fetch'];
  tools = {
    register: tool => { this.toolsList.push(tool); return () => { this.toolsList = this.toolsList.filter(t => t !== tool); }; },
    restrict: filter => { assert.ok(filter.allow.every(name => this.globals.includes(name))); this.restrictions.push(filter); return () => { this.restrictions = this.restrictions.filter(v => v !== filter); }; },
    schemas: () => [...this.globals.filter(name => this.restrictions.every(r => r.allow.includes(name))).map(name => ({ name })), ...this.toolsList],
  };
  systemPrompt = { context: c => { this.contexts.push(c); return () => { this.contexts = this.contexts.filter(v => v !== c); }; } };
  on(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); const dispose = () => this.handlers.get(name).delete(fn); this.disposers.push(dispose); return dispose; }
  effect(fn) { const dispose = fn(); this.disposers.push(dispose); return dispose; }
}

test('plugin mounts root companion agents and awaits Authority-bound context before admission', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-mount-'));
  const socketPath = join(dir, 'a.sock');
  const tokenFile = join(dir, 'token');
  const file = join(dir, 'config.json');
  await writeFile(tokenFile, 'fixture-secret');
  await writeFile(file, JSON.stringify({ socketPath, tokenFile, actorId: 'owner' }));
  const previous = process.env.COMPANION_DSH_CONFIG_FILE;
  process.env.COMPANION_DSH_CONFIG_FILE = file;
  const observed = [];
  let revision = 1; let denied = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    let value;
    if (req.url === '/v1/context') {
      if (denied) { res.statusCode = 403; res.end('{"ok":false,"error":{"code":"FORBIDDEN","message":"denied"}}'); return; }
      await Promise.resolve(); value = { revision, entityId: 'entity:big-fat-fish', memoryEpoch: 0, personaRevision: 1, scope: { audience: 'private', personId: 'p', streamId: 'native' }, text: `revision ${revision}` };
    } else { observed.push(JSON.parse(body)); value = { observationId: 'o1', duplicate: false }; }
    res.end(JSON.stringify({ ok: true, value }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { if (previous === undefined) delete process.env.COMPANION_DSH_CONFIG_FILE; else process.env.COMPANION_DSH_CONFIG_FILE = previous; await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const makeAgent = (id, header = {}) => {
    const events = Array.from({ length: 10 }, (_, seq) => ({ type: 'turn/start', seq, time: 1, data: {} }));
    return { id, ctx: new Scope(), events, session: { id, header, get seq() { return events.length; }, eventAt: seq => events[seq], ownEvents: () => events.filter(e => e.seq >= 10), isOwnSeq: seq => seq >= 10 } };
  };
  const native = makeAgent('native', { agentPreset: 'companion' }); const unknown = makeAgent('other'); const child = makeAgent('child', { origin: 'subagent', agentPreset: 'companion' });
  const ctx = new Scope(); ctx.agents = { list: () => [native, unknown, child] };
  await apply(ctx);
  assert.deepEqual(ctx.services.get('companionCapabilityReady'), { version: 1 });
  assert.equal(Object.isFrozen(ctx.services.get('companionCapabilityReady')), true);
  assert.ok(ctx.handlers.has('agent/pre-step'), 'Host companion guard must be registered');
  const hostGuard = [...ctx.handlers.get('agent/pre-step')][0];
  const guardedDecision = { kind: 'enter', messages: [] };
  await assert.rejects(hostGuard({ agent: makeAgent('unknown-companion', { agentPreset: 'companion' }) }, async () => assert.fail('unknown companion must not run')), /AUTHORITY_BINDING_REQUIRED/);
  await assert.rejects(hostGuard({ agent: child }, async () => assert.fail('delegated companion must not run')), /AUTHORITY_BINDING_REQUIRED/);
  assert.equal(await hostGuard({ agent: makeAgent('unknown-standard', { agentPreset: 'standard' }) }, async () => guardedDecision), guardedDecision);
  assert.equal(await hostGuard({ agent: native }, async () => guardedDecision), guardedDecision);
  assert.equal(native.ctx.toolsList.length, 2);
  assert.deepEqual(native.ctx.restrictions, [{ allow: [] }]);
  assert.deepEqual(native.ctx.tools.schemas(native).map(t => t.name).sort(), ['companion_content', 'companion_scope']);
  native.ctx.globals.push('future_mcp_shell');
  assert.deepEqual(native.ctx.tools.schemas(native).map(t => t.name).sort(), ['companion_content', 'companion_scope']);
  assert.equal(unknown.ctx.restrictions.length, 0);
  assert.equal(unknown.ctx.toolsList.length, 0); assert.equal(child.ctx.toolsList.length, 0);
  const preStep = [...native.ctx.handlers.get('agent/pre-step')][0];
  const payload = { agent: native, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'tea' }] }], turn: 1, signal: new AbortController().signal };
  const decision = { kind: 'enter', messages: [], startsRequestSeries: true };
  assert.equal(await preStep(payload, async () => { assert.match(native.ctx.contexts[0].text(), /revision 1/); return decision; }), decision);
  revision++;
  await preStep(payload, async () => { assert.match(native.ctx.contexts[0].text(), /revision 2/); return decision; });
  const onEvent = [...native.ctx.handlers.get('session/event')][0];
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'tea' }] };
  const tool = native.ctx.toolsList[0];
  assert.deepEqual(await tool.execute({ action: 'evidence' }, { agent: native }), { evidence: [], unavailable: [] });
  onEvent(native.session, { type: 'user/message', seq: 2, time: 1, data: message });
  const committed = { type: 'user/message', seq: 10, time: 1, data: message };
  native.events.push(committed);
  onEvent(native.session, committed);
  const discovered = await tool.execute({ action: 'evidence' }, { agent: native });
  assert.deepEqual(discovered.evidence, [{ ref: 'o1', eventId: 'native:10', role: 'user' }]);
  assert.equal(JSON.stringify(discovered).includes('tea'), false);
  await preStep(payload, async () => decision);
  assert.equal(observed.length, 1); assert.equal(observed[0].eventId, 'native:10');
  denied = true;
  await assert.rejects(preStep(payload, async () => assert.fail('no admission without Authority binding')), /AUTHORITY_BINDING_REQUIRED/);
  assert.equal(native.ctx.contexts[0].text(), '');
  native.ctx.toolsList.push({ name: 'unexpected_local_shell' });
  await assert.rejects(preStep(payload, async () => assert.fail('unexpected scoped tool must block admission')), /CAPABILITY_TOOL_BOUNDARY_INVALID/);
  native.ctx.toolsList = native.ctx.toolsList.filter(tool => tool.name !== 'unexpected_local_shell');
  for (const dispose of ctx.disposers) await dispose();
  assert.equal(native.ctx.toolsList.length, 0); assert.equal(native.ctx.contexts.length, 0);
  assert.equal(native.ctx.handlers.get('session/event').size, 0);
  assert.equal(native.ctx.restrictions.length, 0);
  assert.equal(ctx.handlers.get('agent/pre-step').size, 0);
  assert.equal(ctx.services.has('companionCapabilityReady'), false);
  denied = false; // A bound stream reaches tool-boundary validation during attachment.
  const bad = makeAgent('native', { agentPreset: 'companion' });
  bad.ctx.toolsList.push({ name: 'unexpected_local_shell' });
  const invalid = new Scope(); invalid.agents = { list: () => [bad] };
  await assert.rejects(apply(invalid), /CAPABILITY_TOOL_BOUNDARY_INVALID/);
  assert.deepEqual(bad.ctx.toolsList.map(t => t.name), ['unexpected_local_shell']);
  assert.equal(bad.ctx.restrictions.length, 0);
  assert.equal(invalid.services.has('companionCapabilityReady'), false);
  for (const dispose of invalid.disposers) await dispose();
  const minimal = makeAgent('native', { agentPreset: 'companion' }); minimal.ctx.globals = [];
  const minimalCtx = new Scope(); minimalCtx.agents = { list: () => [minimal] };
  await apply(minimalCtx);
  assert.deepEqual(minimal.ctx.tools.schemas(minimal).map(t => t.name), ['companion_scope', 'companion_content']);
  for (const dispose of minimal.ctx.disposers) await dispose(); // agent-owned teardown first
  assert.equal(minimal.ctx.toolsList.length, 0); assert.equal(minimal.ctx.contexts.length, 0);
  assert.equal(minimal.ctx.restrictions.length, 0);
  for (const dispose of minimalCtx.disposers) await dispose(); // plugin teardown remains idempotent
  assert.equal(minimal.ctx.restrictions.length, 0);
});

test('invalid capability config never provides the startup readiness marker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-not-ready-'));
  const previous = process.env.COMPANION_DSH_CONFIG_FILE;
  process.env.COMPANION_DSH_CONFIG_FILE = join(dir, 'missing-config.json');
  t.after(async () => { if (previous === undefined) delete process.env.COMPANION_DSH_CONFIG_FILE; else process.env.COMPANION_DSH_CONFIG_FILE = previous; await rm(dir, { recursive: true, force: true }); });
  const ctx = new Scope(); ctx.agents = { list: () => assert.fail('invalid config must not reach attachment') };
  await assert.rejects(apply(ctx), /INVALID_CONFIG/);
  assert.equal(ctx.services.has('companionCapabilityReady'), false);
  assert.equal(ctx.handlers.size, 0);
});

test('QQ and bound Native roots select different credentials; unbound roots and untrusted QQ frames cannot run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-routes-'));
  const socketPath = join(dir, 'a.sock'), nativeToken = join(dir, 'native.token'), qqToken = join(dir, 'qq.token');
  const nativeFile = join(dir, 'native.json'), qqFile = join(dir, 'qq.json'), inboxFile = join(dir, 'inbox.ndjson');
  const oldNative = process.env.COMPANION_DSH_CONFIG_FILE, oldQQ = process.env.COMPANION_QQ_WORKER_CONFIG;
  const streamId = 'qq:100:private:200', sdkId = qqSessionId('100', '200');
  const observation = { eventId: 'onebot:v11:message:7', streamId, actorId: 'qq:100:user:200', role: 'user', text: 'I prefer tea', at: 1000 };
  const requestId = qqRequestId(observation), observed = [], queried = [], contentCalls = [];
  let paused = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), auth = req.headers.authorization;
    if (req.url === '/v1/context') {
      queried.push({ auth, streamId: body.streamId });
      const allowed = auth === 'Bearer native-fixture' && body.streamId === 'native-bound' || auth === 'Bearer qq-fixture' && body.streamId === streamId;
      if (!allowed) { res.statusCode = 403; res.end('{"ok":false,"error":{"code":"FORBIDDEN","message":"unbound"}}'); return; }
      res.end(JSON.stringify({ ok: true, value: { revision: 1, entityId: 'entity:big-fat-fish', memoryEpoch: 0, personaRevision: 1, world: { paused }, text: 'One shared Authority persona' } }));
    } else if (req.url === '/v1/content') {
      contentCalls.push({ auth, body });
      res.end(JSON.stringify({ ok: true, value: body.action === 'attach' ? { queued: true, delivered: false, ref: body.ref } : body.action === 'transcribe' ? { text: 'derived transcript', ref: 'transcript-ref', derived: true } : { url: body.url, content: 'x'.repeat(8000), external: true, derived: true } }));
    } else {
      observed.push({ auth, body });
      res.end(JSON.stringify({ ok: true, value: { observationId: 'obs-' + body.eventId } }));
    }
  });
  t.after(async () => {
    for (const [key, value] of [['COMPANION_DSH_CONFIG_FILE', oldNative], ['COMPANION_QQ_WORKER_CONFIG', oldQQ]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve));
    assert.ok((await realpath(dir)).startsWith((await realpath(tmpdir())) + sep + 'fish-routes-'));
    await rm(dir, { recursive: true });
  });
  await Promise.all([writeFile(nativeToken, 'native-fixture'), writeFile(qqToken, 'qq-fixture'), writeFile(nativeFile, JSON.stringify({ socketPath, tokenFile: nativeToken, actorId: 'owner' })), writeFile(qqFile, JSON.stringify({ enabled: false })), writeFile(inboxFile, JSON.stringify({ requestId, sessionId: sdkId, observation }) + '\n')]);
  await new Promise(resolve => server.listen(socketPath, resolve));
  process.env.COMPANION_DSH_CONFIG_FILE = nativeFile; process.env.COMPANION_QQ_WORKER_CONFIG = qqFile;
  function agent(id, initial = []) {
    const events = [...initial];
    return { id, ctx: new Scope(), events, session: { id, header: { agentPreset: 'companion' }, get seq() { return events.length; }, eventAt: seq => events[seq], ownEvents: () => events, isOwnSeq: () => true } };
  }
  const qq = agent(sdkId), native = agent('native-bound');
  const unknown = agent('unbound', [{ type: 'user/message', seq: 0, time: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'not admitted' }] } }]);
  const ctx = new Scope(); ctx.agents = { list: () => [native, unknown] };
  await apply(ctx);
  await t.test('Host started with QQ disabled attaches the first QQ root after operator enables it', async () => {
    assert.equal(qq.ctx.toolsList.length, 0);
    await writeFile(qqFile, JSON.stringify({ enabled: true, expectedSelfId: '100', allowedCallerUID: '200', socketPath, tokenFile: qqToken, inboxFile }));
    for (const handler of ctx.handlers.get('agent/created')) await handler({ agent: qq });
    assert.deepEqual(qq.ctx.tools.schemas(qq).map(tool => tool.name), ['companion_scope', 'companion_content']);
    assert.ok(queried.some(q => q.auth === 'Bearer qq-fixture' && q.streamId === streamId));
    assert.ok(!queried.some(q => q.auth === 'Bearer native-fixture' && q.streamId === sdkId));
  });
  assert.deepEqual(native.ctx.tools.schemas(native).map(tool => tool.name), ['companion_scope', 'companion_content']);
  assert.equal(unknown.ctx.toolsList.length, 0);
  assert.deepEqual(observed, [], 'unbound history must not be observed under Native credentials');
  assert.ok(queried.some(q => q.auth === 'Bearer qq-fixture' && q.streamId === streamId));
  assert.ok(!queried.some(q => q.auth === 'Bearer native-fixture' && q.streamId === sdkId));
  const preStep = [...qq.ctx.handlers.get('agent/pre-step')][0], signal = new AbortController().signal;
  const message = { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: observation.text }] };
  const decision = { kind: 'enter', messages: [message] };
  assert.equal(await preStep({ agent: qq, messages: [message], turn: 1, signal }, async () => decision), decision, 'pre-commit input is authenticated from the trusted inbox');
  qq.events.push({ type: 'user/message', seq: 0, time: 2, data: message });
  const evidence = await qq.ctx.toolsList[0].execute({ action: 'evidence' }, { agent: qq });
  assert.equal(evidence.evidence[0].eventId, observation.eventId);
  assert.deepEqual(observed, [{ auth: 'Bearer qq-fixture', body: observation }]);
  await preStep({ agent: qq, messages: [], turn: 1, signal }, async () => decision);
  const content = qq.ctx.toolsList.find(tool => tool.name === 'companion_content');
  const attached = await content.execute({ action: 'attach', ref: 'image-ref' }, { agent: qq, signal });
  assert.equal(attached.queued, true); assert.equal(attached.delivered, false);
  assert.deepEqual(contentCalls[0], { auth: 'Bearer qq-fixture', body: { action: 'attach', ref: 'image-ref', streamId, memoryEpoch: 0, requestId } });
  await assert.rejects(content.execute({ action: 'attach', ref: 'image-ref', requestId: 'model-selected' }, { agent: qq, signal }), /INVALID_REQUEST/);
  const page = await content.execute({ action: 'read', url: 'https://example.com/page' }, { agent: qq, signal });
  assert.equal(page.url, 'https://example.com/page'); assert.equal(page.truncated, true); assert.ok(JSON.stringify(page).length <= 6000);
  assert.equal(contentCalls[1].body.action, 'fetch'); assert.equal(contentCalls[1].body.streamId, streamId);
  const transcription = await content.execute({ action: 'transcribe', ref: 'audio-ref', quality: 'heavy' }, { agent: qq, signal });
  assert.equal(transcription.text, 'derived transcript'); assert.equal(transcription.isVerbatimUserText, false);
  assert.deepEqual(contentCalls[2], { auth: 'Bearer qq-fixture', body: { action: 'transcribe', ref: 'audio-ref', quality: 'heavy', streamId, memoryEpoch: 0 } });
  const nativePreStep = [...native.ctx.handlers.get('agent/pre-step')][0];
  await nativePreStep({ agent: native, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }], turn: 1, signal }, async () => decision);
  const nativeContent = native.ctx.toolsList.find(tool => tool.name === 'companion_content');
  assert.equal((await nativeContent.execute({ action: 'attach', ref: 'image-ref' }, { agent: native, signal })).available, false);
  assert.equal(contentCalls.length, 3, 'Native has no outbox and does not attach through Core');
  await assert.rejects(preStep({ agent: qq, messages: [{ ...message, source: { kind: 'user', rpcId: 'not-from-qq' } }], turn: 2, signal }, async () => assert.fail('untrusted input cannot run')), /QQ_INPUT_UNTRUSTED/);
  paused = true;
  await assert.rejects(content.execute({ action: 'search', query: 'not while paused' }, { agent: qq, signal }), /EXECUTION_EPOCH_RETIRED/);
  assert.equal(contentCalls.length, 3);
  await assert.rejects(preStep({ agent: qq, messages: [message], turn: 2, signal }, async () => assert.fail('paused world cannot run')), /WORLD_PAUSED/);
  for (const dispose of ctx.disposers) await dispose();
});
