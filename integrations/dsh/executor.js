import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_EXECUTION_TIMEOUT_MS } from '../../capabilities/conversation/executor.js';

// DSH is selected here as the execution backend, not by a conversation source.
export function createDshExecutor({ getRpc }) {
  return {
    async execute(request) {
      const rpc = await getRpc();
      await ensureSdkSession(rpc, request.sessionId);
      return executeDshConversation({ ...request, rpc });
    },
  };
}

export async function ensureSdkSession(rpc, sessionId) {
  try {
    const current = await rpc('session/projections', { request: { sessionId } });
    if (current?.kind === 'sequenced') return;
  } catch (error) { if (error.message !== 'WEB_RPC_REJECTED') throw error; }
  const created = await rpc('session/create', { request: { sessionId, cwd: '/home/companion/dsh', agentPreset: 'companion' } });
  if (created.sessionId !== sessionId) throw new Error('SESSION_ROUTE_CONFLICT');
}
export async function executeDshConversation({ rpc, sessionId, requestId, text, timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS }) {
  const base = await rpc('session/projections', { request: { sessionId } });
  if (base.kind !== 'sequenced') throw new Error('SESSION_NOT_SEQUENCED');
  let seenSeq = base.asOfSeq;
  const events = [];
  const receipt = await rpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
  if (!receipt.accepted) throw new Error('PROMPT_NOT_ACCEPTED');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const p = await rpc('session/projections', { request: { sessionId } });
    if (p.kind !== 'sequenced') throw new Error('SESSION_NOT_SEQUENCED');
    if (p.asOfSeq > seenSeq) {
      let beforeSeq; const fresh = [];
      while (true) {
        const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: p.asOfSeq, maxMessages: 500, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
        const batch = page.records.filter(r => r.type === 'event').map(r => r.event);
        fresh.push(...batch.filter(e => e.seq > seenSeq));
        if (!page.hasMore || !batch.length || batch[0].seq <= seenSeq) break;
        beforeSeq = batch[0].seq;
      }
      events.push(...fresh.sort((a, b) => a.seq - b.seq)); seenSeq = p.asOfSeq;
    }
    const user = events.findIndex(e => e.type === 'user/message' && e.data.source?.rpcId === requestId);
    if (user >= 0) {
      const turn = events.slice(0, user).findLast(e => e.type === 'turn/start')?.data.turn;
      const end = events.find(e => e.type === 'turn/end' && e.data.turn === turn);
      if (end) {
        if (end.data.reason.kind !== 'completed') throw new Error('TURN_NOT_COMPLETED');
        const last = events.findLast(e => e.type === 'assistant/message' && e.data.turn === turn);
        const result = (last?.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
        if (!result) throw new Error('EMPTY_REPLY');
        return result;
      }
    }
    await delay(500);
  }
  throw new Error('TURN_TIMEOUT');
}
