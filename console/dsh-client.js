// Official DSH client-request protocol, deliberately separate from operatorRequest.
export async function createDshSession({ payload, fetchImpl = fetch, uuid = () => crypto.randomUUID() }) {
  const response = await fetchImpl('/api/session/create', {
    method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method: 'session/create', payload: { args: payload } }),
    signal: AbortSignal.timeout(15000),
  });
  let envelope;
  try { envelope = await response.json(); } catch { throw new Error('session_create_failed'); }
  if (!response.ok || envelope?.result?.ok !== true || envelope.result.value?.sessionId !== payload.request.sessionId) {
    throw new Error('session_create_failed');
  }
  return envelope.result;
}
