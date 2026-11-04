/** State schema, defaults and the journal event reducer. */
import { normalizePersona, normalizePersonaDocument, personaHash } from "./persona.js";
export { DEFAULT_PERSONA } from "./persona.js";

export const MOOD_EMOTIONS = [
  "joy",
  "calm",
  "affection",
  "worry",
  "sadness",
  "jealousy",
  "missing",
];

export const DEFAULT_POLICY = {
  quietHours: { start: 1, end: 8 },
  cooldownMinutes: 120,
  dailyCap: 2,
  maxUnanswered: 1,
  unansweredMoodAfterMinutes: 120,
  peakProbability: 0.08,
  offPeakProbability: 0.18,
  peakWindows: [
    { days: [1, 2, 3, 4, 5], start: 9, end: 12 },
    { days: [1, 2, 3, 4, 5], start: 14, end: 18 },
  ],
  recentMinutes: 30,
  awayMinutes: 240,
  pausedUntil: null,
};

function zeroEmotions() {
  return Object.fromEntries(MOOD_EMOTIONS.map((name) => [name, 0]));
}

export function createInitialState({ persona = {}, policy = {}, now }) {
  return {
    version: 1,
    persona: normalizePersona(persona),
    personaMeta: { schemaVersion: 1, revision: 0, source: "legacy", hash: null, reason: "unversioned", at: now },
    relationship: {
      stage: "new",
      intimacy: 0,
      trust: 0,
      lastInteractionAt: null,
    },
    mood: {
      valence: 70,
      energy: 60,
      emotions: zeroEmotions(),
      at: now,
    },
    facts: [],
    diary: [],
    episodes: [],
    interaction: {
      lastUserAt: null,
      lastAssistantAt: null,
      lastSpokeAt: null,
      lastProactiveAt: null,
      unrespondedProactive: 0,
      proactiveMoodFor: null,
      proactiveDay: null,
      proactiveCount: 0,
      presence: "unknown",
      lastIntent: null,
    },
    policy: {
      ...DEFAULT_POLICY,
      ...policy,
      quietHours: { ...DEFAULT_POLICY.quietHours, ...(policy.quietHours ?? {}) },
      peakWindows: policy.peakWindows ?? DEFAULT_POLICY.peakWindows,
    },
    meta: { createdAt: now, updatedAt: now, seq: 0 },
  };
}

function requireFact(state, id) {
  const fact = state.facts.find((item) => item.id === id);
  if (!fact) throw new Error(`journal references unknown fact: ${id}`);
  return fact;
}

/**
 * Apply one journal event to the state. Mutates and returns the same object.
 * Unknown event types throw: the journal is the schema, not a loose bag.
 */
export function applyEvent(state, event) {
  const { type, data = {}, at, seq } = event;
  switch (type) {
    case "core/initialized": {
      if (state.meta.seq !== 0 || seq !== 1) throw new Error("core initialization must be the first event");
      if (data.persona) state.persona = { ...state.persona, ...data.persona };
      if (data.policy) state.policy = { ...state.policy, ...data.policy };
      state.meta.createdAt = at;
      break;
    }
    case "persona/updated": {
      if (data.document) {
        const document = normalizePersonaDocument(data.document);
        if (document.revision !== state.personaMeta.revision + 1) throw new Error("invalid persona revision sequence");
        const hash = personaHash(document.persona);
        if (data.hash !== hash) throw new Error("persona content hash does not match its revision");
        state.persona = document.persona;
        state.personaMeta = {
          schemaVersion: document.schemaVersion, revision: document.revision,
          source: data.source, hash, reason: data.reason, at,
        };
      } else {
        if (state.personaMeta.revision > 0) throw new Error("unversioned persona edit after a versioned revision");
        state.persona = { ...state.persona, ...data.patch };
      }
      break;
    }
    case "fact/added":
      state.facts.push(data.fact);
      break;
    case "fact/replaced": {
      const previous = requireFact(state, data.id);
      const next = data.fact;
      if (previous.status !== "active" || !next || next.supersedes !== previous.id || next.status !== "active" || next.id === previous.id) {
        throw new Error("invalid atomic fact replacement");
      }
      previous.status = "superseded";
      previous.supersededBy = next.id;
      previous.supersededAt = at;
      state.facts.push(next);
      break;
    }
    case "fact/confirmed": {
      const fact = requireFact(state, data.id);
      fact.lastConfirmedAt = data.at ?? at;
      fact.confidence = Math.max(fact.confidence ?? 0, data.confidence ?? fact.confidence ?? 0);
      break;
    }
    case "fact/superseded": {
      const fact = requireFact(state, data.id);
      fact.status = "superseded";
      fact.supersededBy = data.byId ?? null;
      fact.supersededAt = at;
      break;
    }
    case "diary/added":
      state.diary.push(data.entry);
      break;
    case "episode/added":
      state.episodes.push(data.episode);
      break;
    case "mood/adjusted":
      state.mood = { ...data.mood };
      break;
    case "relationship/updated":
      state.relationship = { ...state.relationship, ...data.patch };
      break;
    case "interaction/recorded":
      state.interaction = { ...state.interaction, ...data.patch };
      break;
    case "policy/updated":
      state.policy = { ...state.policy, ...data.patch };
      break;
    case "proactive/sent":
      state.interaction = {
        ...state.interaction,
        lastProactiveAt: at,
        lastSpokeAt: at,
        lastIntent: data.intent ?? null,
        unrespondedProactive: (state.interaction.unrespondedProactive ?? 0) + 1,
        proactiveMoodFor: null,
        proactiveDay: data.day ?? state.interaction.proactiveDay,
        proactiveCount: data.day === state.interaction.proactiveDay
          ? (state.interaction.proactiveCount ?? 0) + 1
          : 1,
      };
      break;
    case "proactive/answered":
      state.interaction = { ...state.interaction, unrespondedProactive: 0, proactiveMoodFor: null };
      break;
    case "diary/pruned": {
      const ids = new Set(data.ids ?? []);
      state.diary = state.diary.filter((entry) => !ids.has(entry.id));
      break;
    }
    default:
      throw new Error(`unknown journal event type: ${type}`);
  }
  state.meta.updatedAt = at;
  state.meta.seq = seq;
  return state;
}
