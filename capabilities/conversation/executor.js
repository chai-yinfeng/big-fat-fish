export const DEFAULT_EXECUTION_TIMEOUT_MS = 120000;

/** Text execution port: the backend owns sessions (derived from scope) and its model/tool loop. */
export async function executeConversation(executor, { scope, requestId, input, timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS }) {
  if (typeof executor?.execute !== 'function') throw new Error('CONVERSATION_EXECUTOR_REQUIRED');
  if (typeof scope?.streamId !== 'string' || !scope.streamId || !Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof requestId !== 'string' || !requestId || typeof input?.text !== 'string' || !input.text || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_EXECUTION_REQUEST');
  const result = await executor.execute({ scope: { streamId: scope.streamId, memoryEpoch: scope.memoryEpoch }, requestId, input, timeoutMs });
  if (typeof result !== 'string' || !result) throw new Error('EMPTY_REPLY');
  return result;
}
