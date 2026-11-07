#!/usr/bin/env node
// Run on the Mac with 3081 and 3082 forwarded. Resumes the world and sends one real
// prompt (provider cost). Credentials come through sudo on this terminal, never printed.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectWeb } from '../../integrations/dsh/web-rpc.js';
import { WORLD, readCompanionFiles } from './companion-sudo.mjs';
const [webAccess, consoleToken] = await readCompanionFiles([WORLD + '/dsh-home/run/local-access.json', WORLD + '/operator/console.token']);
const operator = consoleToken.trim();
async function control(route, body) {
  const response = await fetch('http://127.0.0.1:3082' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + operator, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) throw new Error('CONTROL_FAILED');
  return envelope.value;
}
let resumed = false, stage = 'configuration';
try {
  let world = await control('/world');
  if (!world.model.configured) throw new Error('MODEL_NOT_CONFIGURED');
  if (!world.world.paused) throw new Error('EXPECTED_MAINTENANCE_PAUSE');
  if (world.model.status !== 'verified') {
    stage = 'connection-probe';
    const probe = await control('/model/test', {});
    console.log(JSON.stringify({ connectionProbe: probe.ok, code: probe.code, model: probe.model }));
    if (!probe.ok) throw new Error('PROVIDER_PROBE_FAILED');
  }
  const rpc = await connectWeb(JSON.parse(webAccess));
  const sessionId = 'deepseek-live-' + Date.now().toString(36);
  await control('/test-conversations', { conversationId: sessionId });
  const created = await rpc('session/create', { request: { sessionId, cwd: '/home/companion/dsh', agentPreset: 'companion' } });
  if (created.sessionId !== sessionId) throw new Error('SESSION_NOT_CREATED');
  const statusResult = await rpc('commands/execute', { agentId: sessionId, line: '/companion status', submittedAttachments: [] });
  if (statusResult.result.kind !== 'success') throw new Error('CAPABILITY_NOT_READY');
  const status = JSON.parse(statusResult.result.text);
  if (JSON.stringify(status.tools) !== JSON.stringify(['companion_scope'])) throw new Error('UNEXPECTED_TOOLS');
  const projection = await rpc('session/projections', { request: { sessionId } });
  if (projection.kind !== 'sequenced') throw new Error('SESSION_NOT_SEQUENCED');
  let seenSeq = projection.asOfSeq;
  world = await control('/world');
  await control('/world/pause', { paused: false, expectedRevision: world.world.revision }); resumed = true;
  const requestId = randomUUID(), events = [];
  stage = 'real-dialogue';
  const accepted = await rpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: '你好大肥鱼。这是一条通信链路验收消息，请用一句中文回应，不要为这条测试保存记忆或新增经历。' }] } });
  if (!accepted.accepted) throw new Error('PROMPT_NOT_ACCEPTED');
  console.log(JSON.stringify({ realPromptAccepted: true, sessionId, requestId }));
  const deadline = Date.now() + 120000;
  let complete = false;
  while (Date.now() < deadline) {
    const p = await rpc('session/projections', { request: { sessionId } });
    if (p.kind !== 'sequenced') throw new Error('SESSION_NOT_SEQUENCED');
    if (p.asOfSeq > seenSeq) {
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: p.asOfSeq, maxMessages: 500 } });
      events.push(...page.records.filter(r => r.type === 'event' && r.event.seq > seenSeq).map(r => r.event));
      seenSeq = p.asOfSeq;
    }
    const user = events.findIndex(e => e.type === 'user/message' && e.data.source?.rpcId === requestId);
    if (user >= 0) {
      const turn = events.slice(0, user).findLast(e => e.type === 'turn/start')?.data.turn;
      const end = events.find(e => e.type === 'turn/end' && e.data.turn === turn);
      if (end) {
        const last = events.findLast(e => e.type === 'assistant/message' && e.data.turn === turn);
        const text = (last?.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
        console.log(JSON.stringify({ dialogueCompleted: end.data.reason.kind === 'completed', reason: end.data.reason.kind, text, tools: status.tools }));
        if (end.data.reason.kind !== 'completed' || !text) throw new Error('DIALOGUE_FAILED');
        complete = true; break;
      }
    }
    await delay(500);
  }
  if (!complete) throw new Error('PROMPT_WAIT_TIMEOUT');
} catch (error) { console.error(JSON.stringify({ verified: false, stage, code: ['MODEL_NOT_CONFIGURED', 'PROVIDER_PROBE_FAILED', 'EXPECTED_MAINTENANCE_PAUSE', 'PROMPT_WAIT_TIMEOUT', 'DIALOGUE_FAILED'].includes(error.message) ? error.message : 'DIALOGUE_CHECK_FAILED' })); process.exitCode = 1; }
finally {
  if (resumed) {
    const state = await control('/world');
    if (!state.world.paused) await control('/world/pause', { paused: true, expectedRevision: state.world.revision });
  }
  const state = await control('/world');
  console.log(JSON.stringify({ finalPaused: state.world.paused, model: state.model, counts: state.counts, personaRevision: state.persona.revision }));
}
