export const DEFAULT_EXECUTION_TIMEOUT_MS = 120000;

/** Text execution port: the backend owns its own sessions and model/tool loop. */
export async function executeConversation(executor, { sessionId, requestId, text, timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS }) {
  if (typeof executor?.execute !== 'function') throw new Error('CONVERSATION_EXECUTOR_REQUIRED');
  if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId || typeof text !== 'string' || !text || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_EXECUTION_REQUEST');
  const result = await executor.execute({ sessionId, requestId, text, timeoutMs });
  if (typeof result !== 'string' || !result) throw new Error('EMPTY_REPLY');
  return result;
}
