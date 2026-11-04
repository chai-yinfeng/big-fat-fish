import fs from 'node:fs';

const fail = code => Object.assign(new Error(code), { code });
export const ACTIVE_CONTEXT_CHARS = 32000;
const MARKER = 'Older completed execution dialogue is outside the active window. No facts are asserted by this maintenance marker. Retrieve authoritative long-term memory with companion_scope search/read when needed.';

export function createTurnQuery() {
  let currentTurn, currentQuery;
  return ({ messages, turn }, trustedQuery) => {
    const texts = trustedQuery === undefined ? messages.filter(m => m.role === 'user' && m.source?.kind === 'user').map(m => (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')).filter(s => s.trim()) : [trustedQuery];
    if (texts.length && texts.some(s => s.trim())) { currentTurn = turn; currentQuery = texts.join('\n').trim().slice(0, 512); }
    if (currentTurn !== turn || !currentQuery) throw fail('REAL_USER_INPUT_REQUIRED');
    return currentQuery;
  };
}

/** Control-plane execution stamp, not a second personality or memory store. */
export function createEpochStore(file) {
  let rows = {};
  if (file) { try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw fail('EXECUTION_EPOCH_STORE_INVALID'); } }
  return {
    assert(session, context) {
      if (typeof context.entityId !== 'string' || !Number.isSafeInteger(context.memoryEpoch) || context.memoryEpoch < 0) throw fail('INVALID_AUTHORITY_EPOCH');
      const stamp = Object.hasOwn(rows, session.id) ? rows[session.id] : undefined;
      if (stamp?.retired) throw fail('EXECUTION_EPOCH_RETIRED');
      if (stamp && (stamp.entityId !== context.entityId || stamp.memoryEpoch !== context.memoryEpoch)) throw fail('EXECUTION_EPOCH_RETIRED');
      if (!stamp) {
        // Legacy history may be adopted only before the first explicit forget.
        if (context.memoryEpoch > 0 && session.firstLifecycleSeq > 0) throw fail('EXECUTION_EPOCH_RETIRED');
        rows[session.id] = { entityId: context.entityId, memoryEpoch: context.memoryEpoch };
        if (file) { fs.writeFileSync(file + '.tmp', JSON.stringify(rows) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
      }
    },
  };
}

/** Public SDK readSurface + append/SurfaceIntent; no extra inference or raw-log rewrite. */
export async function boundActiveSurface(agent, payload, limit = ACTIVE_CONTEXT_CHARS) {
  const query = agent.ctx.sessionQuery;
  const surface = await query.readSurface(agent.id);
  const size = events => events.reduce((n, e) => n + JSON.stringify(e.data.message || e.data).length, 0);
  if (size(surface.events) <= limit) return;
  const observation = await query.observeSession(agent.id, { projectionMode: 'none', signal: payload.signal });
  let nodes;
  try {
    const ended = new Set(observation.events.filter(e => e.type === 'turn/end').map(e => e.data.turn));
    const turns = new Map(); let turn;
    for (const event of observation.events) { if (event.type === 'turn/start') turn = event.data.turn; turns.set(event.seq, turn); }
    const completed = [...ended].sort((a, b) => a - b), retain = new Set(completed.slice(-2));
    const events = surface.events;
    let start = events[0]?.type === 'system/message' ? 1 : 0, end = start;
    while (end < events.length) { const t = turns.get(events[end].seq); if (!ended.has(t) || retain.has(t) || t === payload.turn) break; end++; }
    nodes = events.slice(start, end);
    if (!nodes.length || size(events.slice(0, start).concat(events.slice(end))) + MARKER.length > limit) throw fail('ACTIVE_CONTEXT_LIMIT');
    payload.signal.throwIfAborted();
    if (surface.capturedThroughSeq !== null && agent.session.seq !== surface.capturedThroughSeq + 1) throw fail('ACTIVE_CONTEXT_CHANGED');
  } finally { observation[Symbol.dispose](); }
  agent.session.append('user/message', { id: `companion-window-${agent.session.seq}`, role: 'user', source: { kind: 'plugin', plugin: 'companion-context-window' }, content: [{ type: 'text', text: MARKER }] }, { surfaceOp: { op: 'replace', startSeq: nodes[0].seq, endSeq: nodes.at(-1).seq }, sourceEventSeqs: nodes.map(e => e.seq) });
}
