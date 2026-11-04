/** Assemble the model-facing companion context within a character budget. */

import { describeMood } from "./mood.js";
import { renderPersona } from "./persona.js";
import { retrieveMemory } from "./retrieval.js";
import { isoDate } from "./util.js";

export const DEFAULT_LABELS = {
  persona: "【人格】",
  state: "【关系与心情】",
  facts: "【长期事实】",
  diary: "【最近日记】",
  innerDiary: "【内心日记】",
  episodes: "【相关回忆】",
};

function stateBody(state, now) {
  const { relationship } = state;
  const mood = describeMood(state.mood, now);
  return [
    `关系：${relationship.stage}，亲密度 ${Math.round(relationship.intimacy)}/100，信任 ${Math.round(relationship.trust)}/100。`,
    `此刻：${mood.text}。`,
  ].join("\n");
}

const CUT = "…[截断]";

function clip(text, available) {
  if (text.length <= available) return text;
  if (available < CUT.length) return "";
  return `${text.slice(0, available - CUT.length)}${CUT}`;
}

function omission(count) {
  return `[已省略 ${count} 条]`;
}

function renderBody(candidate, available) {
  if (!candidate.lines) return clip(candidate.body, available);
  if (candidate.body.length <= available) return candidate.body;
  // Facts are atomic evidence: omit an oversized fact rather than assert a fragment.
  const lines = [];
  let used = 0;
  let omitted = candidate.lines.length;
  for (const line of candidate.lines) {
    const separator = lines.length ? 1 : 0;
    const reserve = omitted > 1 ? 1 + omission(omitted - 1).length : 0;
    const room = available - used - separator - reserve;
    const rendered = candidate.key === "facts"
      ? (line.length <= room ? line : "")
      : clip(line, room);
    if (!rendered) continue;
    lines.push(rendered);
    used += separator + rendered.length;
    omitted -= 1;
  }
  if (omitted > 0) {
    const marker = omission(omitted);
    if (used + (lines.length ? 1 : 0) + marker.length <= available) lines.push(marker);
  }
  return lines.join("\n");
}

/** Equal shares, returning unused space from short sections to longer sections. */
function allocate(demands, budget) {
  const shares = demands.map(() => 0);
  let pending = demands.map((_, index) => index);
  while (pending.length > 0 && budget > 0) {
    const share = Math.floor(budget / pending.length);
    const short = pending.filter((index) => demands[index] <= share);
    if (short.length === 0) {
      for (const index of pending) {
        shares[index] = share + (budget % pending.length > pending.indexOf(index) ? 1 : 0);
      }
      break;
    }
    for (const index of short) {
      shares[index] = demands[index];
      budget -= demands[index];
    }
    pending = pending.filter((index) => !short.includes(index));
  }
  return shares;
}

/** Persona first; remaining space is shared across state and nonempty memory kinds. */
export function buildContext(state, {
  query = "",
  now,
  budgetChars = 2400,
  labels = {},
  limits = undefined,
  includeInnerDiary = false,
} = {}) {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 2400;
  const resolvedLabels = { ...DEFAULT_LABELS, ...labels };
  const memory = retrieveMemory(state, { query, now, limits, diaryKinds: ["outer"] });
  const outerDiary = memory.diary;
  // Each explicitly visible kind gets its own bounded retrieval slots.
  const innerDiary = includeInnerDiary
    ? retrieveMemory(state, { query, now, limits, diaryKinds: ["inner"] }).diary
    : [];
  memory.diary = [...outerDiary, ...innerDiary];
  const candidates = [
    { key: "persona", title: resolvedLabels.persona, body: renderPersona(state.persona) },
    { key: "state", title: resolvedLabels.state, body: stateBody(state, now) },
  ];
  const addMemory = (key, lines) => {
    if (lines.length > 0) candidates.push({ key, title: resolvedLabels[key], lines, body: lines.join("\n") });
  };
  addMemory("facts", memory.facts.map((fact) => `- ${fact.subject}.${fact.key}：${fact.value}`));
  addMemory("diary", outerDiary.map((entry) => `- ${isoDate(entry.at)}：${entry.text}`));
  addMemory("innerDiary", innerDiary.map((entry) => `- ${isoDate(entry.at)}：${entry.text}`));
  addMemory("episodes", memory.episodes.map((episode) => `- ${isoDate(episode.at)}：${episode.summary}`));

  const parts = [];
  const sections = [];
  const dropped = [];
  const truncated = [];
  let used = 0;
  const append = (candidate, allowance) => {
    const header = `${parts.length === 0 ? "" : "\n\n"}${candidate.title}\n`;
    const body = renderBody(candidate, Math.max(0, allowance - header.length));
    if (!body) {
      dropped.push(candidate.key);
      return;
    }
    const text = `${header}${body}`;
    const isTruncated = body !== candidate.body;
    if (isTruncated) truncated.push(candidate.key);
    parts.push(text);
    used += text.length;
    sections.push({ key: candidate.key, title: candidate.title, chars: text.length, truncated: isTruncated });
  };

  // Persona has first claim and up to 60% (at least 160 chars for tiny contexts),
  // but pathological persona size must not consume every memory category's space.
  const personaBudget = Math.min(budget, Math.max(160, Math.floor(budget * 0.6)));
  append(candidates[0], personaBudget);
  const rest = candidates.slice(1);
  // Header/separator cost is included in each allocation, keeping the hard bound exact.
  const demands = rest.map((candidate) => 2 + candidate.title.length + 1 + candidate.body.length);
  const shares = allocate(demands, budget - used);
  rest.forEach((candidate, index) => append(candidate, shares[index]));

  return {
    text: parts.join(""),
    sections,
    usedChars: used,
    budgetChars,
    dropped,
    truncated,
    memory,
  };
}
