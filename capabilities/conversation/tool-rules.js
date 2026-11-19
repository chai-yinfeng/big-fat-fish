// The named rules of the model tool layer (tools.js): evidence, source and scope rules that stay hand-written. A
// capability declaration (capabilities/providers/<id>/manifest.js, an action's `model.rules`) may only pick names from
// this table, never define a rule. Name -> function: tools.js runs the rules an action declares, stage by stage
// (`turn` before the input is looked at, `request` while the content request is built, `call` right before the
// content service is called, `result` on what it returned) and, within a stage, in the order they are declared.
const refuse = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rule = (stage, text, run) => Object.assign(run, { stage, text });
export const TOOL_RULES = Object.freeze({
  scopeBound: rule('request', 'streamId and memoryEpoch come from the trusted execution request; no field of the model selects them.',
    ({ request, scope }) => { request.streamId = scope.streamId; request.memoryEpoch = scope.memoryEpoch; }),
  worldGuard: rule('call', 'Pause, entity and memory epoch are re-checked with Authority before the content service is called.',
    ({ guard }) => guard()),
  // A turn she starts herself (a finished job, a poke) is for telling, not for starting something new: nothing
  // more than before can be done in it.
  notInitiated: rule('turn', 'Refused in a turn she started herself (ACTIVITY_UNAVAILABLE).',
    ({ turn }) => { if (turn.initiated) throw refuse('ACTIVITY_UNAVAILABLE', '这一条是你自己开口的回合，不能在这里开始或查看活动。'); }),
  // Only a link the person sent in this very message: it is not the model's to choose.
  linkFromThisMessage: rule('request', 'input.url must appear, exactly as given, in what the person wrote in this turn, and not start with "-".',
    ({ declared, input, turn }) => {
      const url = input.url;
      if (typeof url !== 'string' || !url.length || url.length > declared.input.url.schema.maxLength || url.startsWith('-') || !turn.text.includes(url)) throw refuse('INVALID_REQUEST', 'input.url 必须是对方这条消息里出现的视频链接，原样复制，不能改写或自己找链接');
    }),
  // The message itself is the source of what follows (the note is filed under it, and forgetting it removes the note).
  sourceFromEvidence: rule('request', 'The source message is the user observation of this turn, taken from the evidence; the model cannot name it.',
    ({ request, evidence }) => {
      const asked = evidence.find(item => item.role === 'user');
      if (!asked) throw refuse('ACTIVITY_UNAVAILABLE', '这一回合没有对方发来的消息可以作为来源。');
      request.sourceEventId = asked.eventId;
    }),
  requestBound: rule('request', 'requestId is the execution request\'s own.',
    ({ request, requestId }) => { request.requestId = requestId; }),
  neutralizeExternalText: rule('result', 'Memory-hub note delimiters in returned external text (note, text) are neutralized.',
    ({ value, neutralize }) => isObject(value) ? { ...value, ...Object.fromEntries(['note', 'text'].filter(key => typeof value[key] === 'string').map(key => [key, neutralize(value[key])])) } : value),
  derivedNotEvidence: rule('result', 'The result is marked isNewEvidence:false, isVerbatimUserText:false and kept within the tool output limit.',
    ({ value, boundedContent }) => boundedContent(value)),
  queuedNotDelivered: rule('result', 'The result is marked delivered:false: queued for this reply, not sent.',
    ({ value }) => ({ ...value, delivered: false })),
});
