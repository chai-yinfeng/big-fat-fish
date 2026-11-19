export const DEFAULT_EXECUTION_TIMEOUT_MS = 120000;
/** Her whole reply to a run she was asked to start herself (`input.initiated`) when she chooses to say nothing:
 * the channel then sends nothing. */
export const DECLINE_MARK = '<不说>';

/** Text execution port: the backend owns sessions (derived from scope) and its model/tool loop. */
export async function executeConversation(executor, { scope, requestId, input, timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS }) {
  if (typeof executor?.execute !== 'function') throw new Error('CONVERSATION_EXECUTOR_REQUIRED');
  if (typeof scope?.streamId !== 'string' || !scope.streamId || !Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof requestId !== 'string' || !requestId || typeof input?.text !== 'string' || !input.text || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_EXECUTION_REQUEST');
  const result = await executor.execute({ scope: { streamId: scope.streamId, memoryEpoch: scope.memoryEpoch }, requestId, input, timeoutMs });
  if (typeof result !== 'string' || !result) throw new Error('EMPTY_REPLY');
  return result;
}

/** What a channel reports once the delivery of a reply has ended: what really went out, part by part, in the order
 * it was sent. Channel-neutral (QQ is the first to report it); the executor keeps it with the reply it stored and
 * shows her only where it differs from what she wrote (see delivery.js).
 *   kind         text | voice | sticker | image | attachment
 *   status       sent (the platform's receipt came back) | unsent (never handed to the platform) | unknown (handed
 *                over, no receipt: never said to be sent)
 *   chars        text: how long this message was
 *   fallback     text: 'voice' when this text went out in place of a voice message that could not be made
 *   marker       the exact piece of her reply that stood for this part (a channel's own marker syntax); the executor
 *                shows the outcome in its place
 *   description  what the part is, in words the channel already had (never made for this report); `machine: true`
 *                when a model wrote them
 *   reason       unsent only: 'none' when there was nothing to send for it */
export const DELIVERY_KINDS = ['text', 'voice', 'sticker', 'image', 'attachment'], DELIVERY_STATUSES = ['sent', 'unsent', 'unknown'];
export const MAX_DELIVERY_PARTS = 16, MAX_DELIVERY_DESCRIPTION_CHARS = 400, MAX_DELIVERY_MARKER_CHARS = 64;
export function validDelivery(delivery) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(delivery) || Object.keys(delivery).some(key => key !== 'parts') || !Array.isArray(delivery.parts) || !delivery.parts.length || delivery.parts.length > MAX_DELIVERY_PARTS) return false;
  return delivery.parts.every(part => object(part) && Object.keys(part).every(key => ['kind', 'status', 'chars', 'fallback', 'marker', 'description', 'machine', 'reason'].includes(key))
    && DELIVERY_KINDS.includes(part.kind) && DELIVERY_STATUSES.includes(part.status)
    && (part.chars === undefined || part.kind === 'text' && Number.isSafeInteger(part.chars) && part.chars >= 0 && part.chars <= 24000)
    && (part.fallback === undefined || part.kind === 'text' && part.fallback === 'voice')
    && (part.marker === undefined || typeof part.marker === 'string' && part.marker.length > 0 && part.marker.length <= MAX_DELIVERY_MARKER_CHARS)
    && (part.description === undefined || typeof part.description === 'string' && part.description.length > 0 && part.description.length <= MAX_DELIVERY_DESCRIPTION_CHARS)
    && (part.machine === undefined || part.machine === true && part.description !== undefined)
    && (part.reason === undefined || part.reason === 'none' && part.status === 'unsent'));
}

/** Delivery report port: tells the backend what became of the reply of run `requestId` (the latest run of that
 * conversation). A backend without `delivered` keeps no such record: nothing is reported, and false is returned. */
export async function reportDelivery(executor, { scope, requestId, delivery }) {
  if (typeof executor?.delivered !== 'function') return false;
  if (typeof scope?.streamId !== 'string' || !scope.streamId || !Number.isSafeInteger(scope.memoryEpoch) || scope.memoryEpoch < 0 || typeof requestId !== 'string' || !requestId || !validDelivery(delivery)) throw new Error('INVALID_DELIVERY_REPORT');
  await executor.delivered({ scope: { streamId: scope.streamId, memoryEpoch: scope.memoryEpoch }, requestId, delivery });
  return true;
}
