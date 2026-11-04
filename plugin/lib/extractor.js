/**
 * LLM memory extraction for the companion.
 *
 * The core library deliberately owns no model call: it only defines the
 * `MemoryExtractor` shape. This module is the plugin-side implementation. It
 * builds a small JSON-only prompt, streams one model call, and sanitizes the
 * reply before it can reach the append-only journal.
 */

import { MOOD_EMOTIONS } from "../../core/src/state.js";

export const ALLOWED_MOOD_EVENTS = [
  "praise",
  "affection",
  "criticism",
  "conflict",
  "repair",
  "absence",
  "reunion",
  "share",
  "ignore",
];

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function trimChars(text, max) {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function todayCountsOf(state, date) {
  const counts = { outer: 0, inner: 0 };
  for (const entry of state?.diary ?? []) {
    if (entry.date !== date) continue;
    if (entry.kind === "inner") counts.inner += 1;
    else counts.outer += 1;
  }
  return counts;
}

function stateBlock(state) {
  const persona = state?.persona ?? {};
  const relationship = state?.relationship ?? {};
  const mood = state?.mood ?? {};
  const facts = (state?.facts ?? [])
    .filter((fact) => fact.status === "active")
    .sort((left, right) => (right.lastConfirmedAt ?? 0) - (left.lastConfirmedAt ?? 0))
    .slice(0, 8);
  const recentDiary = [...(state?.diary ?? [])]
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
    .slice(0, 4)
    .reverse();
  const date = typeof state?.__date === "string" ? state.__date : undefined;
  const counts = date ? todayCountsOf(state, date) : null;

  const lines = ["【当前状态】"];
  lines.push(`人格：${persona.name ?? "助手"}`);
  if (persona.userCallName) lines.push(`用户称呼：${persona.userCallName}`);
  if (Array.isArray(persona.traits) && persona.traits.length) {
    lines.push(`性格：${persona.traits.join("、")}`);
  }
  lines.push(
    `关系：${relationship.stage ?? "new"}，亲密度 ${Math.round(relationship.intimacy ?? 0)}/100，信任 ${Math.round(relationship.trust ?? 0)}/100`,
  );
  lines.push(
    `心情：valence=${Math.round(asNumber(mood.valence, 70))} energy=${Math.round(asNumber(mood.energy, 60))}（心情只用于语气，不要据此编造事实）`,
  );
  if (counts) {
    lines.push(`今天的日记：outer 已有 ${counts.outer} 条，inner 已有 ${counts.inner} 条。`);
  }
  if (facts.length) {
    lines.push("已有事实（避免重复）：");
    for (const fact of facts) {
      lines.push(`- ${fact.subject}.${fact.key}：${trimChars(fact.value, 80)}`);
    }
  }
  if (recentDiary.length) {
    lines.push("最近日记（仅用于去重和衔接，不要照抄）：");
    for (const entry of recentDiary) {
      const tag = entry.kind === "inner" ? "[inner]" : "[outer]";
      lines.push(`- ${tag} ${trimChars(entry.text, 120)}`);
    }
  }
  return lines.join("\n");
}

function turnBlock(turn) {
  const user = asString(turn?.userText ?? turn?.user);
  const assistant = asString(turn?.assistantText ?? turn?.assistant);
  if (!user && !assistant) return "";
  const lines = [];
  if (user) lines.push(`用户：${user}`);
  if (assistant) lines.push(`助手：${assistant}`);
  return lines.join("\n");
}

/**
 * Keep the newest turns that fit the character budget. A single oversized
 * turn is truncated rather than dropped, so a long reply still contributes.
 */
export function formatTurnHistory(turns, maxChars = 6000) {
  const blocks = (Array.isArray(turns) ? turns : [turns]).map(turnBlock).filter(Boolean);
  const limit = Math.max(200, Number(maxChars) || 6000);
  const selected = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (used + block.length + 2 > limit && selected.length > 0) break;
    const clipped = block.length > limit ? `${block.slice(0, limit - 1)}…` : block;
    selected.unshift(clipped);
    used += clipped.length + 2;
  }
  const omitted = selected.length < blocks.length;
  return `${omitted ? "（更早的对话已省略）\n" : ""}${selected.join("\n\n")}`;
}

export function buildExtractionPrompt({
  state,
  turns,
  maxChars = 6000,
  now = Date.now(),
} = {}) {
  const name = asString(state?.persona?.name) || "助手";
  const date = state?.__date ?? new Date(now).toLocaleDateString("en-CA");
  const system = [
    `你是「${name}」的记忆整理器。你只输出一个 JSON 对象，不要 markdown 代码块，不要解释。`,
    "",
    "从对话中提取值得长期记住的内容。宁缺毋滥：寒暄、临时情绪、一次性的安排不要写成 facts 或 episodes。",
    "",
    "输出格式：",
    "{",
    '  "facts": [{"subject":"用户","key":"...","value":"...","confidence":0.8}],',
    '  "diary": [{"kind":"outer","text":"..."},{"kind":"inner","text":"..."}],',
    '  "episodes": [{"summary":"...","salience":0.6,"emotions":{"joy":0.7},"participants":["用户"],"evidence":["..."]}],',
    '  "moodEvent": null,',
    '  "relationshipEvent": null',
    "}",
    "",
    "规则：",
    "1. facts 最多 3 条；subject 默认“用户”；key 用简短中文名词（如“喜欢的饮料”）；value 是用户明确表达的事实。不要猜测，不要记录密码、token、身份证、住址、银行卡等敏感信息。",
    `2. diary 最多 2 条（outer 至多 1，inner 至多 1）。outer 是 ${name} 的第一人称、用户可读的“这段时间发生了什么”综合叙事；inner 是 ${name} 自己的观察、判断或情绪来由，不对外展示。今天已经有的日记数量见状态，不要重复写。`,
    "3. episodes 最多 2 条；summary 一句话；salience 0..1；emotions 只用 joy/calm/affection/worry/sadness/jealousy/missing 的 0..1 数值；evidence 只放对话里的短原话。",
    "4. moodEvent 只在有明确情绪触发时给：praise/affection/criticism/conflict/repair/absence/reunion/share/ignore；普通闲聊给 null。有明确触发时尽量给 deltas，例如 {\"type\":\"share\",\"deltas\":{\"valence\":2,\"energy\":1,\"emotions\":{\"joy\":4}}}；不要无依据地大幅改变。",
    "5. relationshipEvent 只在这次对话确实改变关系时给：{\"intimacy\": -3..3, \"trust\": -3..3}。用户自我暴露、认真回应、共同计划、兑现承诺，可以加 trust/intimacy；冲突、敷衍、失信则减。普通寒暄、单纯交换信息给 null；不要每轮都涨。",
    '6. 没有值得记录的内容时返回 {"facts":[],"diary":[],"episodes":[],"moodEvent":null,"relationshipEvent":null}。',
  ].join("\n");

  const user = [
    stateBlock({ ...state, __date: date }),
    "",
    "【对话】",
    formatTurnHistory(turns, maxChars),
  ].join("\n");

  return { system, user };
}

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Parse the model reply into a JSON object, tolerating prose around it. */
export function parseExtractionJson(text) {
  const source = stripFences(String(text ?? ""));
  if (source === "") throw new Error("extractor returned an empty response");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("extractor response contained no JSON object");
  let parsed;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new Error(`extractor response was not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extractor response was not a JSON object");
  }
  return parsed;
}

const SENSITIVE_FACT = /(密码|口令|api[_-]?key|access[_-]?token|secret|身份证|护照|银行卡|信用卡|住址|地址|手机号)/i;
const SECRET_SHAPE = /\bsk-[A-Za-z0-9_-]{8,}\b/;

function sanitizeFacts(raw) {
  const facts = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item === null || typeof item !== "object") continue;
    const key = asString(item.key);
    const value = asString(item.value);
    if (!key || !value) continue;
    // The prompt asks the model to avoid credentials; enforce it here anyway.
    if (SENSITIVE_FACT.test(key) || SENSITIVE_FACT.test(value) || SECRET_SHAPE.test(value)) continue;
    const subject = asString(item.subject) || "用户";
    const dedupe = `${subject}|${key}|${value}`.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    facts.push({
      subject: trimChars(subject, 40),
      key: trimChars(key, 60),
      value: trimChars(value, 300),
      confidence: clamp01(asNumber(item.confidence, 0.8)),
    });
    if (facts.length >= 3) break;
  }
  return facts;
}

function sanitizeDiary(raw) {
  const diary = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = typeof item === "string" ? item.trim() : asString(item?.text);
    if (!text) continue;
    const kind = item?.kind === "inner" ? "inner" : "outer";
    const dedupe = `${kind}|${text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    diary.push({ kind, text: trimChars(text, 600) });
    if (diary.length >= 4) break;
  }
  return diary;
}

function sanitizeEmotions(raw) {
  const emotions = {};
  if (!raw || typeof raw !== "object") return emotions;
  for (const name of MOOD_EMOTIONS) {
    if (!(name in raw)) continue;
    const value = asNumber(raw[name], undefined);
    if (value !== undefined) emotions[name] = clamp01(value);
  }
  return emotions;
}

function sanitizeEpisodes(raw) {
  const episodes = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const summary = typeof item === "string" ? item.trim() : asString(item?.summary);
    if (!summary) continue;
    episodes.push({
      summary: trimChars(summary, 300),
      salience: clamp01(asNumber(item?.salience, 0.5)),
      emotions: sanitizeEmotions(item?.emotions),
      participants: (Array.isArray(item?.participants) ? item.participants : [])
        .map((value) => asString(value))
        .filter(Boolean)
        .slice(0, 4),
      evidence: (Array.isArray(item?.evidence) ? item.evidence : [])
        .map((value) => asString(value))
        .filter(Boolean)
        .slice(0, 4),
      halfLifeDays: Math.min(365, Math.max(1, asNumber(item?.halfLifeDays, 30))),
    });
    if (episodes.length >= 2) break;
  }
  return episodes;
}

function sanitizeRelationshipEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const intimacy = asNumber(raw.intimacy, 0);
  const trust = asNumber(raw.trust, 0);
  const result = {
    intimacy: Math.max(-3, Math.min(3, intimacy)),
    trust: Math.max(-3, Math.min(3, trust)),
  };
  return result.intimacy === 0 && result.trust === 0 ? null : result;
}

function sanitizeMoodEvent(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") {
    return ALLOWED_MOOD_EVENTS.includes(raw) ? raw : null;
  }
  if (typeof raw !== "object") return null;
  const type = asString(raw.type);
  if (!ALLOWED_MOOD_EVENTS.includes(type)) return null;
  const source = raw.deltas && typeof raw.deltas === "object" ? raw.deltas : raw;
  const deltas = {};
  for (const field of ["valence", "energy"]) {
    const value = asNumber(source[field], undefined);
    if (value !== undefined) deltas[field] = Math.max(-30, Math.min(30, value));
  }
  const emotions = {};
  if (source.emotions && typeof source.emotions === "object") {
    for (const name of MOOD_EMOTIONS) {
      const value = asNumber(source.emotions[name], undefined);
      if (value !== undefined) emotions[name] = Math.max(-30, Math.min(30, value));
    }
  }
  if (Object.keys(emotions).length) deltas.emotions = emotions;
  return { type, ...(Object.keys(deltas).length ? { deltas } : {}) };
}

/** Validate and normalize anything the model said before it reaches core. */
export function sanitizeExtraction(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    facts: sanitizeFacts(source.facts),
    diary: sanitizeDiary(source.diary),
    episodes: sanitizeEpisodes(source.episodes),
    moodEvent: sanitizeMoodEvent(source.moodEvent),
    relationshipEvent: sanitizeRelationshipEvent(source.relationshipEvent),
  };
}

export function parseExtraction(text) {
  return sanitizeExtraction(parseExtractionJson(text));
}

/** Lowest reasoning effort the model advertises; undefined means "omit". */
export async function pickReasoningEffort({ llm, route, configured } = {}) {
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  if (typeof llm?.resolveModelInfo !== "function" || !route?.provider || !route?.model) {
    return undefined;
  }
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts)) return undefined;
    const ids = efforts
      .map((entry) => (entry && typeof entry === "object" ? entry.id : undefined))
      .filter((id) => typeof id === "string" && id !== "");
    if (ids.length === 0) return undefined;
    let best = ids[0];
    let bestRank = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const rank = EFFORT_ORDER.indexOf(id);
      if (rank >= 0 && rank < bestRank) {
        best = id;
        bestRank = rank;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

function finishError(reason) {
  if (!reason || typeof reason !== "object") return null;
  if (reason.kind === "error" || reason.kind === "aborted") {
    const failure = reason.failure;
    const message = failure?.message ?? "model request failed";
    return `model request ${reason.kind}: ${message}`;
  }
  return null;
}

/**
 * Build the core-compatible extractor. `route` is resolved by the shell on
 * every call, so switching models mid-session is respected.
 */
export function createLlmExtractor({ llm, config = {}, log = () => {} } = {}) {
  const effortCache = new Map();
  return {
    /** @param {{ turn: object, state: object, route: {provider: string, model: string} }} input */
    async extract({ turn, state, route } = {}) {
      if (!llm || typeof llm.stream !== "function") {
        throw new Error("the harness LLM service is unavailable");
      }
      if (!route?.provider || !route?.model) {
        throw new Error("no provider/model route is available for extraction");
      }
      const prompt = buildExtractionPrompt({
        state,
        turns: turn?.messages ?? turn?.turns ?? [turn],
        maxChars: config.maxChars,
        now: turn?.now,
      });
      const cacheKey = `${route.provider}/${route.model}`;
      let effort = effortCache.get(cacheKey);
      if (effort === undefined) {
        effort = await pickReasoningEffort({ llm, route, configured: config.reasoningEffort });
        effortCache.set(cacheKey, effort ?? null);
      }
      const timeoutMs = Math.min(120_000, Math.max(1_000, Number(config.timeoutMs) || 45_000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("extraction timed out")), timeoutMs);
      let text = "";
      let finish = null;
      try {
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
          system: prompt.system,
          maxTokens: Math.max(256, Number(config.maxTokens) || 1200),
          temperature: Math.min(2, Math.max(0, Number(config.temperature) || 0.2)),
          signal: controller.signal,
          ...(effort ? { reasoningEffort: effort } : {}),
        })) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            text += chunk.text;
          } else if (chunk?.type === "finish") {
            finish = chunk.reason ?? null;
          }
        }
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("extraction timed out");
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const failure = finishError(finish);
      if (failure) throw new Error(failure);
      if (text.trim() === "") throw new Error("extractor returned no text");
      try {
        return parseExtraction(text);
      } catch (error) {
        log(`extraction parse failed: ${error.message}`);
        throw error;
      }
    },
  };
}
