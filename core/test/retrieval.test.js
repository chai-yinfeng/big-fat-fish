import test from "node:test";
import assert from "node:assert/strict";
import { retrieveMemory } from "../src/retrieval.js";
import { createInitialState } from "../src/state.js";
import { DAY_MS } from "../src/util.js";
import { T0 } from "./helpers.js";

function fact(overrides) {
  return {
    id: overrides.id,
    subject: "用户",
    key: "喜欢",
    value: "咖啡",
    confidence: 0.8,
    status: "active",
    firstSeenAt: T0,
    lastConfirmedAt: T0,
    ...overrides,
  };
}

test("nonempty queries require lexical evidence in every memory category", () => {
  const state = createInitialState({ now: T0 });
  state.facts.push(fact({ id: "coffee", value: "浅烘咖啡" }));
  state.diary.push({ id: "coffee-diary", at: T0, text: "浅烘咖啡", tags: [] });
  state.episodes.push({ id: "coffee-episode", at: T0, summary: "浅烘咖啡", salience: 1 });
  for (const threshold of [undefined, 0]) {
    const result = retrieveMemory(state, { query: "显卡驱动故障", now: T0, threshold });
    assert.deepEqual([result.facts, result.diary, result.episodes], [[], [], []]);
  }
  const unsupported = retrieveMemory(state, { query: "!!!", now: T0 });
  assert.deepEqual(unsupported.facts, []);
});

test("Chinese bigrams match and superseded facts never return", () => {
  const state = createInitialState({ now: T0 });
  state.facts.push(fact({ id: "active", value: "喜欢浅烘咖啡豆" }));
  state.facts.push(fact({ id: "old", value: "浅烘咖啡豆", status: "superseded" }));
  for (const query of ["浅烘咖啡", ""]) {
    assert.deepEqual(retrieveMemory(state, { query, now: T0 }).facts.map((item) => item.id), ["active"]);
  }
});

test("retrieval ranks a matching fact above an unrelated one", () => {
  const state = createInitialState({ now: T0 });
  state.facts.push(fact({ id: "a", value: "咖啡" }));
  state.facts.push(fact({ id: "b", key: "讨厌", value: "香菜" }));
  const result = retrieveMemory(state, { query: "咖啡", now: T0 });
  assert.equal(result.facts[0].id, "a");
  assert.ok(result.facts[0].score > 0.15);
});

test("episode decay lowers an old memory below a fresh one", () => {
  const state = createInitialState({ now: T0 });
  state.episodes.push({
    id: "old",
    at: T0 - 60 * DAY_MS,
    summary: "一起喝咖啡",
    salience: 0.7,
    halfLifeDays: 30,
    participants: [],
    emotions: {},
    evidence: [],
  });
  state.episodes.push({
    id: "new",
    at: T0,
    summary: "一起喝咖啡",
    salience: 0.7,
    halfLifeDays: 30,
    participants: [],
    emotions: {},
    evidence: [],
  });
  const result = retrieveMemory(state, { query: "咖啡", now: T0 });
  assert.equal(result.episodes[0].id, "new");
});

test("matching facts and diary still rank fresh evidence above stale evidence", () => {
  const state = createInitialState({ now: T0 });
  state.facts.push(fact({ id: "old", lastConfirmedAt: T0 - 180 * DAY_MS }));
  state.facts.push(fact({ id: "fresh" }));
  state.diary.push({ id: "old", at: T0 - 60 * DAY_MS, text: "咖啡" });
  state.diary.push({ id: "fresh", at: T0, text: "咖啡" });
  const result = retrieveMemory(state, { query: "咖啡", now: T0 });
  assert.equal(result.facts[0].id, "fresh");
  assert.equal(result.diary[0].id, "fresh");
  assert.ok(result.facts[0].score > result.facts[1].score);
  assert.ok(result.diary[0].score > result.diary[1].score);
});

test("limits and empty query work", () => {
  const state = createInitialState({ now: T0 });
  for (let index = 0; index < 8; index += 1) {
    state.facts.push(fact({ id: `f${index}`, key: `k${index}`, value: "咖啡" }));
    state.diary.push({ id: `d${index}`, at: T0, text: "咖啡" });
    state.episodes.push({ id: `e${index}`, at: T0, summary: "咖啡" });
  }
  for (const query of ["", "  \n"]) {
    const result = retrieveMemory(state, { query, now: T0, limits: { facts: 3 } });
    assert.equal(result.facts.length, 3);
    assert.equal(result.diary.length, 3);
    assert.equal(result.episodes.length, 4);
  }
});
