import test from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../src/context.js";
import { createInitialState } from "../src/state.js";
import { T0 } from "./helpers.js";

function populated() {
  const state = createInitialState({ now: T0 });
  state.facts.push({
    id: "f1",
    subject: "用户",
    key: "喜欢",
    value: "咖啡",
    confidence: 0.9,
    status: "active",
    firstSeenAt: T0,
    lastConfirmedAt: T0,
  });
  state.diary.push({
    id: "d1",
    at: T0,
    date: "2026-10-24",
    text: "今天一起喝了手冲咖啡",
    mood: { valence: 75, energy: 60 },
    tags: ["咖啡"],
  });
  state.episodes.push({
    id: "e1",
    at: T0,
    summary: "聊了咖啡豆的产地",
    participants: ["用户"],
    salience: 0.8,
    emotions: { joy: 20 },
    evidence: [1],
    halfLifeDays: 30,
  });
  return state;
}

test("context includes persona, state and relevant memory in order", () => {
  const context = buildContext(populated(), { query: "咖啡", now: T0, budgetChars: 2400 });
  assert.match(context.text, /【人格】/);
  assert.match(context.text, /【关系与心情】/);
  assert.match(context.text, /【长期事实】/);
  assert.match(context.text, /用户\.喜欢：咖啡/);
  assert.match(context.text, /【最近日记】/);
  assert.match(context.text, /【相关回忆】/);
  assert.ok(context.usedChars <= 2400);
  assert.deepEqual(context.sections.map((section) => section.key), ["persona", "state", "facts", "diary", "episodes"]);
});

test("small budgets truncate or drop later sections without exceeding the budget", () => {
  const context = buildContext(populated(), { query: "咖啡", now: T0, budgetChars: 220 });
  assert.ok(context.usedChars <= 220);
  assert.ok(context.dropped.length > 0 || context.truncated.length > 0);
  assert.match(context.text, /【人格】/);
});

test("inner diary is excluded unless explicitly requested", () => {
  const state = populated();
  state.diary.push({
    id: "d2",
    at: T0,
    date: "2026-10-24",
    text: "我心里其实有点担心你",
    kind: "inner",
    mood: { valence: 60, energy: 50 },
    tags: [],
  });
  const outer = buildContext(state, { query: "咖啡", now: T0, budgetChars: 2400 });
  assert.doesNotMatch(outer.text, /担心你/);
  const both = buildContext(state, { query: "", now: T0, budgetChars: 2400, includeInnerDiary: true });
  assert.match(both.text, /担心你/);
});

test("large facts cannot starve diary categories or episodes", () => {
  const state = populated();
  state.facts[0].value = "超长事实".repeat(1000) + "事实末尾";
  state.diary[0].text = "外部日记".repeat(1000);
  state.diary.push({ id: "inner", kind: "inner", at: T0 - 1, text: "内部日记".repeat(1000) });
  // More recent outer entries must not consume the inner category's retrieval slots.
  for (let index = 0; index < 4; index += 1) {
    state.diary.push({ id: `outer-${index}`, kind: "outer", at: T0, text: "外部日记".repeat(1000) });
  }
  state.episodes[0].summary = "相关回忆".repeat(1000);
  const context = buildContext(state, { now: T0, includeInnerDiary: true });
  assert.ok(context.usedChars <= 2400);
  assert.equal(context.usedChars, context.text.length);
  assert.deepEqual(context.sections.map((section) => section.key), ["persona", "state", "facts", "diary", "innerDiary", "episodes"]);
  for (const key of ["diary", "innerDiary", "episodes"]) {
    assert.ok(context.sections.find((section) => section.key === key).chars >= 100);
  }
  assert.doesNotMatch(context.text, /用户\.喜欢：超长事实/);
  assert.match(context.text, /省略/);
  assert.match(context.text, /截断/);
  const outer = buildContext(state, { now: T0 });
  assert.doesNotMatch(outer.text, /内部日记/);
  assert.ok(outer.memory.diary.every((entry) => entry.kind !== "inner"));
});

test("oversized facts are omitted whole while later short facts remain usable", () => {
  const state = populated();
  state.facts[0].value = "不可截半句".repeat(1000);
  state.facts.push({ ...state.facts[0], id: "short", value: "完整短事实" });
  const context = buildContext(state, { now: T0, budgetChars: 600 });
  assert.match(context.text, /完整短事实/);
  assert.doesNotMatch(context.text, /不可截半句/);
  assert.match(context.text, /已省略 1 条/);
  assert.ok(context.truncated.includes("facts"));
});

test("long persona retains priority without starving memory at the default budget", () => {
  const state = populated();
  state.persona.speechStyle = "稳定温和".repeat(170);
  const context = buildContext(state, { now: T0 });
  assert.match(context.text, new RegExp(state.persona.speechStyle));
  assert.deepEqual(context.sections.map((section) => section.key), ["persona", "state", "facts", "diary", "episodes"]);
  assert.ok(context.usedChars <= 2400);
});

test("pathological persona size is explicitly truncated and leaves room for memory", () => {
  const state = populated();
  state.persona.speechStyle = "很长的人格描述".repeat(1000);
  const context = buildContext(state, { now: T0 });
  assert.ok(context.truncated.includes("persona"));
  assert.match(context.text, /截断/);
  assert.match(context.text, /用户\.喜欢：咖啡/);
  assert.match(context.text, /【最近日记】/);
  assert.match(context.text, /【相关回忆】/);
  assert.ok(context.usedChars <= 2400);
});

test("persona comes from state, and all tiny budgets remain bounded", () => {
  const state = populated();
  state.persona.name = "当前人格";
  state.persona.meta = { version: 9 };
  for (const budgetChars of [0, 1, 8, 24, 80, 220, 500, 2400]) {
    const context = buildContext(state, { now: T0, budgetChars });
    assert.ok(context.usedChars <= budgetChars);
    assert.equal(context.usedChars, context.text.length);
    if (budgetChars >= 80) assert.match(context.text, /当前人格/);
    if (context.sections.length > 0) assert.equal(context.sections[0].key, "persona");
  }
});

test("empty memory produces only persona and state", () => {
  const context = buildContext(createInitialState({ now: T0 }), { now: T0, budgetChars: 1000 });
  assert.deepEqual(context.sections.map((section) => section.key), ["persona", "state"]);
});


test("outer and inner diary use distinct sections when requested", () => {
  const state = {
    persona: { name: "大肥鱼", traits: [], boundaries: [], speechStyle: "" },
    relationship: { stage: "new", intimacy: 0, trust: 0 },
    mood: { valence: 70, energy: 60, emotions: {}, at: 0 },
    facts: [],
    episodes: [],
    diary: [
      { kind: "outer", text: "今天聊了咖啡。", at: 1000 },
      { kind: "inner", text: "我其实有点开心。", at: 2000 },
    ],
    interaction: {},
  };
  const context = buildContext(state, {
    now: 1000,
    budgetChars: 2000,
    includeInnerDiary: true,
    labels: { diary: "【最近发生的事】", innerDiary: "【内心日记】" },
  });
  assert.deepEqual(context.sections.map((section) => section.key), ["persona", "state", "diary", "innerDiary"]);
  assert.match(context.text, /【最近发生的事】/);
  assert.match(context.text, /【内心日记】/);
  assert.match(context.text, /今天聊了咖啡/);
  assert.match(context.text, /我其实有点开心/);
});
