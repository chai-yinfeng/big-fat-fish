/** Lexical retrieval over facts, diary and episodes. No embedding dependency. */

import { DAY_MS, overlapScore, tokenize, uniqueTokens } from "./util.js";

export const DEFAULT_LIMITS = { facts: 5, diary: 3, episodes: 4 };
export const EVIDENCE_THRESHOLD = 0.15;

function ageDays(at, now) {
  return Math.max(0, now - at) / DAY_MS;
}

function recencyBoost(at, now, horizonDays = 180) {
  return 1 / (1 + ageDays(at, now) / horizonDays);
}

export function scoreFact(fact, queryTokens, now) {
  const text = `${fact.subject} ${fact.key} ${fact.value}`;
  if (queryTokens.size === 0) {
    return 0.45 + (fact.confidence ?? 0.5) * 0.3 + recencyBoost(fact.lastConfirmedAt ?? fact.firstSeenAt, now) * 0.25;
  }
  const overlap = overlapScore(queryTokens, tokenize(text));
  if (overlap === 0) return 0;
  return overlap * 0.7
    + (fact.confidence ?? 0.5) * 0.15
    + recencyBoost(fact.lastConfirmedAt ?? fact.firstSeenAt, now) * 0.15;
}

export function scoreDiary(entry, queryTokens, now) {
  if (queryTokens.size === 0) return recencyBoost(entry.at, now, 60);
  const text = `${entry.text} ${(entry.tags ?? []).join(" ")}`;
  const overlap = overlapScore(queryTokens, tokenize(text));
  if (overlap === 0) return 0;
  return overlap * 0.75 + recencyBoost(entry.at, now, 60) * 0.25;
}

export function scoreEpisode(episode, queryTokens, now) {
  const halfLife = episode.halfLifeDays ?? 30;
  const decay = Math.pow(0.5, ageDays(episode.at, now) / halfLife);
  const salience = episode.salience ?? 0.5;
  if (queryTokens.size === 0) {
    return salience * 0.3 + decay * 0.5 + recencyBoost(episode.at, now, 90) * 0.2;
  }
  const text = `${episode.summary} ${(episode.participants ?? []).join(" ")} ${Object.keys(episode.emotions ?? {}).join(" ")}`;
  const overlap = overlapScore(queryTokens, tokenize(text));
  if (overlap === 0) return 0;
  return overlap * 0.55 + salience * 0.2 + decay * 0.2 + recencyBoost(episode.at, now, 90) * 0.05;
}

function takeScored(items, score, limit, threshold) {
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter(({ score: value }) => value > 0 && value >= threshold)
    .sort((left, right) => right.score - left.score || (right.item.at ?? 0) - (left.item.at ?? 0))
    .slice(0, limit)
    .map(({ item, score: value }) => ({ ...item, score: Number(value.toFixed(4)) }));
}

export function retrieveMemory(state, {
  query = "",
  now,
  limits = {},
  threshold = EVIDENCE_THRESHOLD,
  diaryKinds = ["outer"],
} = {}) {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const queryTokens = new Set(uniqueTokens(query));
  // Only genuinely empty input gets recency fallback, not punctuation/unsupported scripts.
  if (String(query).trim() !== "" && queryTokens.size === 0) {
    return { query, facts: [], diary: [], episodes: [] };
  }
  const activeFacts = state.facts.filter((fact) => fact.status === "active");
  const visibleDiary = state.diary.filter((entry) => diaryKinds.includes(entry.kind ?? "outer"));
  return {
    query,
    facts: takeScored(activeFacts, (fact) => scoreFact(fact, queryTokens, now), resolved.facts, queryTokens.size ? threshold : 0),
    diary: takeScored(visibleDiary, (entry) => scoreDiary(entry, queryTokens, now), resolved.diary, queryTokens.size ? threshold : 0),
    episodes: takeScored(state.episodes, (episode) => scoreEpisode(episode, queryTokens, now), resolved.episodes, queryTokens.size ? threshold : 0),
  };
}
