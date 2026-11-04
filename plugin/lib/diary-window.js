/**
 * Idle-window diary: accumulate turns/activities until the user has been quiet
 * for a configured window, then write one outer digest. Inner diary is an explicit agent decision. There is deliberately no one-per-day cap; entries are bounded
 * by total characters and pruned by the core journal.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pickReasoningEffort } from "./extractor.js";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createDiaryWindow({ file, maxEntries = 400, log = () => {} } = {}) {
  let cache = null;
  function load() {
    if (cache) return cache;
    cache = readJsonLines(file).slice(-maxEntries);
    return cache;
  }
  function append(entry) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    if (cache) cache.push(entry);
    else cache = readJsonLines(file).slice(-maxEntries);
    if (cache.length > maxEntries) cache.splice(0, cache.length - maxEntries);
    return entry;
  }
  return {
    appendTurn({ at = Date.now(), userText = "", assistantText = "" } = {}) {
      return append({
        kind: "turn",
        at,
        userText: asString(userText),
        assistantText: asString(assistantText),
      });
    },
    appendActivity({ at = Date.now(), kind = "activity", summary = "", source = "", metadata = undefined } = {}) {
      const text = asString(summary);
      if (!text) throw new Error("activity summary is required");
      return append({ kind: "activity", activityKind: asString(kind) || "activity", at, summary: text, source: asString(source), metadata });
    },
    read() {
      return [...load()];
    },
    lastAt() {
      const entries = load();
      return entries.length ? entries[entries.length - 1].at : 0;
    },
    turnCount() {
      return load().filter((entry) => entry.kind === "turn").length;
    },
    consume(entries) {
      const consumed = new Set(entries);
      const remaining = load().filter((entry) => !consumed.has(entry));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, remaining.map((entry) => JSON.stringify(entry) + "\n").join(""), "utf8");
      cache = remaining;
    },
    clear() {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "", "utf8");
      cache = [];
    },
    status() {
      const entries = load();
      return {
        entries: entries.length,
        turns: entries.filter((entry) => entry.kind === "turn").length,
        activities: entries.filter((entry) => entry.kind === "activity").length,
        lastAt: entries.length ? entries[entries.length - 1].at : null,
        bytes: (() => { try { return statSync(file).size; } catch { return 0; } })(),
      };
    },
  };
}

function recentOuter(state, limit = 4) {
  return [...(state?.diary ?? [])]
    .filter((entry) => (entry.kind ?? "outer") === "outer")
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
    .slice(0, limit)
    .reverse();
}

function stateBlock(state) {
  const persona = state?.persona ?? {};
  const relationship = state?.relationship ?? {};
  const mood = state?.mood ?? {};
  const lines = [
    `人格：${persona.name ?? "陪伴 agent"}`,
    `关系：${relationship.stage ?? "new"}，亲密度 ${Math.round(relationship.intimacy ?? 0)}/100，信任 ${Math.round(relationship.trust ?? 0)}/100`,
    `心情：valence=${Math.round(mood.valence ?? 70)}，energy=${Math.round(mood.energy ?? 60)}`,
  ];
  const outer = recentOuter(state);
  if (outer.length) {
    lines.push("之前的外记（供衔接，不要照抄）：");
    for (const entry of outer) lines.push(`- ${entry.text}`);
  }
  return lines.join("\n");
}

export function formatWindowEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (entry.kind === "activity") {
        return `【活动/${entry.activityKind ?? "activity"}】${entry.summary}`;
      }
      const user = asString(entry.userText);
      const assistant = asString(entry.assistantText);
      return [user ? `用户：${user}` : "", assistant ? `助手：${assistant}` : ""].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function entriesToTurns(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.kind === "turn")
    .map((entry) => ({ userText: entry.userText, assistantText: entry.assistantText }));
}

export function buildOuterDigestPrompt({ state, entries, maxChars = 300 } = {}) {
  const system = [
    `你正在以「${asString(state?.persona?.name) || "陪伴 agent"}」的第一人称写一段“outer diary”，记录这段时间实际发生过什么。`,
    "用“我”来叙述，像自己在回顾，2-4 句，不超过 " + Math.max(80, Number(maxChars) || 300) + " 字。",
    "写事件、关系变化、用户提到的重要事，以及我当时的回应；不要写内心独白或猜测，不要列清单，不要 JSON，不要复述敏感信息。",
    "只输出日记正文。",
  ].join("\n");
  const user = `${stateBlock(state)}\n\n【这段窗口的对话与活动】\n${formatWindowEntries(entries) || "（没有可用内容）"}`;
  return { system, user };
}

export function parseOuterDigest(text, maxChars = 500) {
  let value = String(text ?? "").trim();
  if (!value) return "";
  const fenced = value.match(/```(?:text|markdown)?\s*([\s\S]*?)```/i);
  if (fenced) value = fenced[1].trim();
  value = value.replace(/^(outer diary|日记|外记)\s*[:：]\s*/i, "").replace(/\s+/g, " ").trim();
  const limit = Math.max(80, Number(maxChars) || 500);
  if (value.length > limit) {
    const clipped = value.slice(0, limit);
    const sentenceEnd = Math.max(
      clipped.lastIndexOf("。"), clipped.lastIndexOf("！"), clipped.lastIndexOf("？"),
      clipped.lastIndexOf("."), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"),
    );
    value = sentenceEnd >= Math.floor(limit * 0.6)
      ? clipped.slice(0, sentenceEnd + 1)
      : `${clipped.trimEnd()}…`;
  }
  return value;
}

export function createOuterDigestWriter({ llm, config = {}, log = () => {} } = {}) {
  const effortCache = new Map();
  return {
    async write({ state, entries, route } = {}) {
      if (!llm || typeof llm.stream !== "function") throw new Error("the harness LLM service is unavailable");
      if (!route?.provider || !route?.model) throw new Error("no provider/model route is available for the outer diary");
      const prompt = buildOuterDigestPrompt({ state, entries, maxChars: config.maxChars });
      const cacheKey = `${route.provider}/${route.model}`;
      let effort = effortCache.get(cacheKey);
      if (effort === undefined) {
        effort = await pickReasoningEffort({ llm, route, configured: config.reasoningEffort || "low" });
        effortCache.set(cacheKey, effort ?? null);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("outer diary timed out")), Math.max(5_000, Number(config.timeoutMs) || 45_000));
      let text = "";
      try {
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
          system: prompt.system,
          maxTokens: Math.max(400, Number(config.maxTokens) || 1000),
          temperature: Math.min(2, Math.max(0, Number(config.temperature) || 0.4)),
          signal: controller.signal,
          ...(effort ? { reasoningEffort: effort } : {}),
        })) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        }
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("outer diary timed out");
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const diary = parseOuterDigest(text, config.maxChars);
      if (!diary) throw new Error("outer diary returned no text");
      log(`outer diary written (${diary.length} chars)`);
      return diary;
    },
  };
}
