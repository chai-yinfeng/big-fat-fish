/** CompanionCore facade: journaled state, memory writes, retrieval, proactive policy. */

import { resolveClock, resolveRng, NullExtractor } from "./adapters.js";
import { buildContext } from "./context.js";
import { parseJournal } from "./journal.js";
import { applyMoodEvent, describeMood } from "./mood.js";
import { composeOpener, shouldSpeak } from "./proactive.js";
import { retrieveMemory } from "./retrieval.js";
import { applyEvent, createInitialState } from "./state.js";
import { normalizePersonaDocument, personaHash, validatePersonaPatch } from "./persona.js";
import { clamp, deepClone, randomId } from "./util.js";

function stageFor(intimacy) {
  if (intimacy >= 75) return "bonded";
  if (intimacy >= 40) return "close";
  if (intimacy >= 10) return "familiar";
  return "new";
}

function normalizeFactValue(value) {
  return String(value).trim().toLowerCase();
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export class CompanionCore {
  constructor({ journal, clock, rng, extractor = NullExtractor, state } = {}) {
    if (!journal) throw new Error("journal is required");
    this.journal = journal;
    this.clock = resolveClock(clock);
    this.rng = resolveRng(rng);
    this.extractor = extractor;
    this.state = state ?? createInitialState({ now: this.clock.now() });
  }

  /** Load a journal, replay it, and initialize a fresh one when empty. */
  static async open({ journal, clock, rng, extractor, persona, policy } = {}) {
    if (!journal) throw new Error("journal is required");
    const resolvedClock = resolveClock(clock);
    try {
      const events = parseJournal(journal.readAll());
      const state = createInitialState({ now: resolvedClock.now(), persona, policy });
      for (const event of events) applyEvent(state, event);
      const core = new CompanionCore({ journal, clock: resolvedClock, rng, extractor, state });
      if (events.length === 0) {
        core._append("core/initialized", { persona: state.persona, policy: state.policy }, resolvedClock.now());
      }
      return core;
    } catch (error) {
      journal.close?.();
      throw error;
    }
  }

  _append(type, data, at = this.clock.now()) {
    if (type === "core/initialized" && this.state.meta.seq !== 0) throw new Error("core initialization must be the first event");
    const event = {
      v: 1,
      seq: this.state.meta.seq + 1,
      at,
      type,
      data,
    };
    this.journal.append(event);
    applyEvent(this.state, event);
    return event;
  }

  snapshot() {
    return deepClone(this.state);
  }

  mood(now = this.clock.now()) {
    return describeMood(this.state.mood, now);
  }

  recordUserMessage(text, { at = this.clock.now() } = {}) {
    this._append("interaction/recorded", {
      patch: { lastUserAt: at, unrespondedProactive: 0, proactiveMoodFor: null },
    }, at);
    // Relationship growth is appraisal-driven (see applyExtraction). A plain
    // user message must not inflate intimacy before the scorer has judged it.
    this._append("interaction/recorded", { patch: { lastInteractionAt: at } }, at);
    return text;
  }

  recordAssistantMessage(text, { at = this.clock.now() } = {}) {
    this._append("interaction/recorded", { patch: { lastAssistantAt: at } }, at);
    return text;
  }

  rememberFact({ subject, key, value, confidence = 0.8, source = "user", at = this.clock.now() }) {
    const normalizedSubject = requireText(subject, "subject");
    const normalizedKey = requireText(key, "key");
    const normalizedValue = requireText(String(value), "value");
    const existing = this.state.facts.find(
      (fact) => fact.status === "active"
        && fact.subject.toLowerCase() === normalizedSubject.toLowerCase()
        && fact.key.toLowerCase() === normalizedKey.toLowerCase(),
    );
    if (existing && normalizeFactValue(existing.value) === normalizeFactValue(normalizedValue)) {
      this._append("fact/confirmed", {
        id: existing.id,
        at,
        confidence: clamp(confidence, 0, 1),
      }, at);
      return { ...existing, lastConfirmedAt: at };
    }
    const fact = {
      id: randomId("fact"),
      subject: normalizedSubject,
      key: normalizedKey,
      value: normalizedValue,
      confidence: clamp(confidence, 0, 1),
      source,
      firstSeenAt: at,
      lastConfirmedAt: at,
      status: "active",
      supersedes: existing?.id ?? null,
    };
    // Retiring the old value and committing its replacement is one durable row.
    this._append(existing ? "fact/replaced" : "fact/added", { fact, ...(existing ? { id: existing.id } : {}) }, at);
    return deepClone(fact);
  }

  addDiary({
    text,
    at = this.clock.now(),
    kind = "outer",
    mood = undefined,
    tags = [],
    sourceSeq = undefined,
  }) {
    const normalizedText = requireText(text, "diary text");
    if (kind !== "inner" && kind !== "outer") {
      throw new Error('diary kind must be "inner" or "outer"');
    }
    const date = this.clock.localParts(at).date;
    const existing = this.state.diary.find(
      (entry) => entry.date === date && entry.text === normalizedText && (entry.kind ?? "outer") === kind,
    );
    if (existing) return existing;
    const moodView = mood ?? describeMood(this.state.mood, at);
    const entry = {
      id: randomId("diary"),
      at,
      date,
      text: normalizedText,
      kind,
      mood: {
        valence: Math.round(moodView.valence ?? this.state.mood.valence),
        energy: Math.round(moodView.energy ?? this.state.mood.energy),
        label: moodView.label ?? undefined,
      },
      tags: Array.isArray(tags) ? [...tags] : [],
      sourceSeq: sourceSeq ?? null,
    };
    this._append("diary/added", { entry }, at);
    return entry;
  }

  pruneDiary({ kind = "outer", maxChars = 12_000, at = this.clock.now() } = {}) {
    if (kind !== "inner" && kind !== "outer") {
      throw new Error('diary kind must be "inner" or "outer"');
    }
    const limit = Math.max(0, Number(maxChars) || 0);
    const entries = this.state.diary
      .filter((entry) => (entry.kind ?? "outer") === kind)
      .sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    let total = entries.reduce((sum, entry) => sum + String(entry.text ?? "").length, 0);
    if (total <= limit) return [];
    const removed = [];
    for (const entry of entries) {
      if (total <= limit) break;
      total -= String(entry.text ?? "").length;
      removed.push(entry.id);
    }
    if (removed.length) this._append("diary/pruned", { ids: removed, kind }, at);
    return removed;
  }

  addEpisode({
    summary,
    at = this.clock.now(),
    participants = [],
    salience = 0.5,
    emotions = {},
    evidence = [],
    halfLifeDays = 30,
  }) {
    const normalizedSummary = requireText(summary, "episode summary");
    const duplicate = this.state.episodes.find(
      (episode) => episode.summary === normalizedSummary && Math.abs(at - episode.at) < 3_600_000,
    );
    if (duplicate) return duplicate;
    const episode = {
      id: randomId("episode"),
      at,
      summary: normalizedSummary,
      participants: Array.isArray(participants) ? [...participants] : [],
      salience: clamp(salience, 0, 1),
      emotions: { ...emotions },
      evidence: Array.isArray(evidence) ? [...evidence] : [],
      halfLifeDays: Math.max(1, halfLifeDays),
    };
    this._append("episode/added", { episode }, at);
    return episode;
  }

  adjustMood(type, { at = this.clock.now(), deltas = undefined } = {}) {
    const mood = applyMoodEvent(this.state.mood, type, at, deltas);
    this._append("mood/adjusted", { mood }, at);
    return mood;
  }

  applyPersonaDocument(input, { source = "explicit", reason = "explicit persona revision", expectedRevision = this.state.personaMeta.revision } = {}) {
    const document = normalizePersonaDocument(input);
    const current = this.state.personaMeta;
    if (expectedRevision !== current.revision) throw new Error("persona revision conflict: reload the current identity before editing");
    if (typeof source !== "string" || !source.trim() || source.length > 1000) throw new Error("persona source is required and bounded");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new Error("persona revision reason is required and bounded");
    const hash = personaHash(document.persona);
    if (document.revision === current.revision) {
      if (hash !== current.hash || personaHash(this.state.persona) !== hash) throw new Error("persona content changed without a new revision");
      return this.snapshot().persona;
    }
    if (document.revision !== current.revision + 1) throw new Error("persona revision must advance by exactly one");
    // Keep the v1 event name/patch for historical readers; the complete document
    // makes the applied revision independent of defaults added in future builds.
    this._append("persona/updated", {
      patch: document.persona, document, hash, source: source.trim(), reason: reason.trim(),
    }, this.clock.now());
    return this.snapshot().persona;
  }

  updatePersona(patch, options = {}) {
    validatePersonaPatch(patch);
    const revision = this.state.personaMeta.revision;
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw new Error("persona revision conflict");
    const persona = { ...this.state.persona, ...patch };
    if (revision > 0 && personaHash(persona) === this.state.personaMeta.hash) return this.snapshot().persona;
    return this.applyPersonaDocument({ schemaVersion: 1, revision: revision + 1, persona }, { source: "api", ...options });
  }

  setRelationship(patch) {
    const next = { ...patch };
    if (next.intimacy !== undefined) {
      next.intimacy = clamp(next.intimacy);
      if (next.stage === undefined) next.stage = stageFor(next.intimacy);
    }
    this._append("relationship/updated", { patch: next }, this.clock.now());
    return this.state.relationship;
  }

  updatePolicy(patch) {
    this._append("policy/updated", { patch }, this.clock.now());
    return this.state.policy;
  }

  setPresence(presence) {
    if (!["active", "away", "unknown"].includes(presence)) {
      throw new Error(`unknown presence: ${presence}`);
    }
    this._append("interaction/recorded", { patch: { presence } }, this.clock.now());
  }

  applyExtraction(extraction, { at = this.clock.now() } = {}) {
    if (!extraction) return [];
    const applied = [];
    for (const fact of extraction.facts ?? []) {
      applied.push(this.rememberFact({ ...fact, at }));
    }
    const diaryEntries = extraction.diary === undefined
      ? []
      : Array.isArray(extraction.diary) ? extraction.diary : [extraction.diary];
    for (const entry of diaryEntries) {
      applied.push(this.addDiary(typeof entry === "string" ? { text: entry, at } : { ...entry, at }));
    }
    const episodes = extraction.episodes === undefined
      ? []
      : Array.isArray(extraction.episodes) ? extraction.episodes : [extraction.episodes];
    for (const entry of episodes) {
      applied.push(this.addEpisode(typeof entry === "string" ? { summary: entry, at } : { ...entry, at }));
    }
    if (extraction.moodEvent) {
      if (typeof extraction.moodEvent === "string") {
        applied.push(this.adjustMood(extraction.moodEvent, { at }));
      } else {
        applied.push(this.adjustMood(extraction.moodEvent.type, {
          at,
          deltas: extraction.moodEvent.deltas,
        }));
      }
    }
    if (extraction.relationshipEvent) {
      const current = this.state.relationship;
      const next = {
        ...current,
        intimacy: clamp((current.intimacy ?? 0) + (Number(extraction.relationshipEvent.intimacy) || 0)),
        trust: clamp((current.trust ?? 0) + (Number(extraction.relationshipEvent.trust) || 0)),
        lastInteractionAt: at,
      };
      next.stage = stageFor(next.intimacy);
      applied.push(this.setRelationship(next));
    }
    return applied;
  }

  async ingestTurn({ userText, assistantText, at = this.clock.now(), sentiment = undefined, extraction = undefined }) {
    this.recordUserMessage(userText, { at });
    if (assistantText) this.recordAssistantMessage(assistantText, { at });
    if (sentiment) this.adjustMood(sentiment, { at });
    let resolved = extraction;
    if (resolved === undefined && this.extractor && this.extractor !== NullExtractor) {
      try {
        resolved = await this.extractor.extract({
          turn: { userText, assistantText, at },
          state: this.snapshot(),
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
    return { ok: true, extraction: resolved ?? null, applied: this.applyExtraction(resolved ?? null, { at }) };
  }

  retrieve(query = "", { now = this.clock.now(), limits = undefined } = {}) {
    return retrieveMemory(this.state, { query, now, limits });
  }

  buildContext({ query = "", now = this.clock.now(), budgetChars = 2400, labels = {}, includeInnerDiary = false } = {}) {
    return buildContext(this.state, { query, now, budgetChars, labels, includeInnerDiary });
  }

  tick({ at = this.clock.now(), presence = this.state.interaction.presence } = {}) {
    const parts = this.clock.localParts(at);
    const interaction = this.state.interaction;
    const unansweredAfter = Number(this.state.policy.unansweredMoodAfterMinutes) || 120;
    if ((interaction.unrespondedProactive ?? 0) > 0
      && Number.isFinite(interaction.lastProactiveAt)
      && at - interaction.lastProactiveAt >= unansweredAfter * 60_000
      && interaction.proactiveMoodFor !== interaction.lastProactiveAt) {
      // One gentle consequence per unanswered proactive: the companion feels
      // a little ignored, goes quieter, but never nags. A user reply resets it.
      this.adjustMood("ignore", { at });
      this._append("interaction/recorded", { patch: { proactiveMoodFor: interaction.lastProactiveAt } }, at);
    }
    const decision = shouldSpeak({
      state: this.state,
      now: at,
      parts,
      presence,
      rng: this.rng,
    });
    if (!decision.speak) return decision;
    return { ...decision, opener: composeOpener({ state: this.state, now: at, presence }) };
  }

  markProactiveSent({ at = this.clock.now(), intent = null, messageId = null } = {}) {
    const day = this.clock.localParts(at).date;
    this._append("proactive/sent", { intent, messageId, day }, at);
    return this.state.interaction;
  }

  markProactiveAnswered({ at = this.clock.now() } = {}) {
    this._append("proactive/answered", {}, at);
    const intimacy = clamp((this.state.relationship.intimacy ?? 0) + 1);
    this._append("relationship/updated", {
      patch: { intimacy, stage: stageFor(intimacy), lastInteractionAt: at },
    }, at);
    return this.state.interaction;
  }

  poke({ at = this.clock.now(), presence = this.state.interaction.presence } = {}) {
    return composeOpener({ state: this.state, now: at, presence });
  }

  pauseProactive(until) {
    if (!Number.isFinite(until)) throw new Error("pauseProactive requires an epoch-ms time");
    return this.updatePolicy({ pausedUntil: until });
  }

  resumeProactive() {
    return this.updatePolicy({ pausedUntil: null });
  }

  close() {
    if (typeof this.journal.close === "function") this.journal.close();
  }
}
