// The named rules of the model tool layer (tools.js): evidence, source and scope rules that stay hand-written. A
// capability declaration (capabilities/providers/<id>/manifest.js, an action's `model.rules`) may only pick names from
// this table, never define a rule. Names only: the rules themselves are the code in tools.js, which does not read
// this table yet.
export const TOOL_RULES = Object.freeze({
  scopeBound: 'streamId and memoryEpoch come from the trusted execution request; no field of the model selects them.',
  worldGuard: 'Pause, entity and memory epoch are re-checked with Authority before the content service is called.',
  notInitiated: 'Refused in a turn she started herself (ACTIVITY_UNAVAILABLE).',
  linkFromThisMessage: 'input.url must appear, exactly as given, in what the person wrote in this turn, and not start with "-".',
  sourceFromEvidence: 'The source message is the user observation of this turn, taken from the evidence; the model cannot name it.',
  requestBound: 'requestId is the execution request\'s own.',
  neutralizeExternalText: 'Memory-hub note delimiters in returned external text (note, text) are neutralized.',
  derivedNotEvidence: 'The result is marked isNewEvidence:false, isVerbatimUserText:false and kept within the tool output limit.',
  queuedNotDelivered: 'The result is marked delivered:false: queued for this reply, not sent.',
});
