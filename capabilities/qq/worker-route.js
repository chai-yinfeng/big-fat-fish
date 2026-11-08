import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');

/** Stable dedupe/reply key for one authenticated platform event. */
export function qqRequestId(observation) {
  if (typeof observation?.streamId !== 'string' || typeof observation?.eventId !== 'string') throw fail('QQ_INPUT_UNTRUSTED');
  return `qq-message-${digest(`${observation.streamId}\0${observation.eventId}`)}`;
}
