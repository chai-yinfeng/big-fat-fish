export { CompanionCore } from "./companion.js";
export { PERSONA_SCHEMA_VERSION, normalizePersona, normalizePersonaDocument, personaHash, renderPersona } from "./persona.js";
export { buildContext, DEFAULT_LABELS } from "./context.js";
export { FileJournal, MemoryJournal, parseJournal } from "./journal.js";
export { applyMoodEvent, decayMood, describeMood, moodFactor, moodLabel } from "./mood.js";
export { composeOpener, shouldSpeak } from "./proactive.js";
export { retrieveMemory, scoreDiary, scoreEpisode, scoreFact } from "./retrieval.js";
export { createInitialState, DEFAULT_PERSONA, DEFAULT_POLICY, MOOD_EMOTIONS } from "./state.js";
export { MathRng, NullExtractor, SystemClock } from "./adapters.js";
export {
  clamp,
  DAY_MS,
  HOUR_MS,
  inQuietHours,
  isPeak,
  isoDate,
  tokenize,
  uniqueTokens,
} from "./util.js";
