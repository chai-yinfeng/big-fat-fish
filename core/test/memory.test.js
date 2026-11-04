import test from "node:test";
import assert from "node:assert/strict";
import { CompanionCore } from "../src/companion.js";
import { MemoryJournal } from "../src/journal.js";
import { T0, fixedClock } from "./helpers.js";

test("fact confirmation keeps one active fact, supersession keeps history", async () => {
  const clock = fixedClock();
  const journal = new MemoryJournal();
  const core = await CompanionCore.open({ journal, clock });
  const first = core.rememberFact({ subject: "用户", key: "喜欢的饮料", value: "咖啡" });
  assert.equal(core.snapshot().facts.length, 1);
  core.rememberFact({ subject: "用户", key: "喜欢的饮料", value: "咖啡", confidence: 0.9 });
  let state = core.snapshot();
  assert.equal(state.facts.length, 1);
  assert.ok(state.facts[0].lastConfirmedAt >= T0);

  const second = core.rememberFact({ subject: "用户", key: "喜欢的饮料", value: "茶" });
  state = core.snapshot();
  const old = state.facts.find((fact) => fact.id === first.id);
  const active = state.facts.find((fact) => fact.status === "active");
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, second.id);
  assert.equal(active.value, "茶");
});

test("diary and episode dedupe by day/time", async () => {
  const clock = fixedClock();
  const core = await CompanionCore.open({ journal: new MemoryJournal(), clock });
  const a = core.addDiary({ text: "今天一起喝了咖啡" });
  const b = core.addDiary({ text: "今天一起喝了咖啡" });
  assert.equal(a.id, b.id);
  assert.equal(core.snapshot().diary.length, 1);

  const episodeA = core.addEpisode({ summary: "一起喝咖啡" });
  const episodeB = core.addEpisode({ summary: "一起喝咖啡" });
  assert.equal(episodeA.id, episodeB.id);
  assert.equal(core.snapshot().episodes.length, 1);
});

test("inner and outer diary are separate entries with the same text", async () => {
  const clock = fixedClock();
  const core = await CompanionCore.open({ journal: new MemoryJournal(), clock });
  const outer = core.addDiary({ text: "今天聊了咖啡", kind: "outer" });
  const inner = core.addDiary({ text: "今天聊了咖啡", kind: "inner" });
  assert.notEqual(outer.id, inner.id);
  const state = core.snapshot();
  assert.equal(state.diary.length, 2);
  assert.deepEqual(state.diary.map((entry) => entry.kind).sort(), ["inner", "outer"]);
  assert.throws(() => core.addDiary({ text: "x", kind: "secret" }), /inner.*outer/);
});

test("state can be reloaded from the journal", async () => {
  const clock = fixedClock();
  const journal = new MemoryJournal();
  const core = await CompanionCore.open({ journal, clock });
  core.rememberFact({ subject: "用户", key: "名字", value: "小林" });
  core.addDiary({ text: "第一次聊天" });
  const lines = journal.readAll();

  const reloaded = await CompanionCore.open({ journal: new MemoryJournal(lines), clock });
  const state = reloaded.snapshot();
  assert.equal(state.facts.length, 1);
  assert.equal(state.diary.length, 1);
  assert.equal(state.meta.seq, core.snapshot().meta.seq);
});

test("ingestTurn applies an injected extractor", async () => {
  const clock = fixedClock();
  const extractor = {
    async extract() {
      return {
        facts: [{ subject: "用户", key: "城市", value: "北京" }],
        diary: "今天聊了北京",
        episodes: [{ summary: "聊北京天气", salience: 0.6 }],
        moodEvent: "share",
        relationshipEvent: { intimacy: 2, trust: 1.5 },
      };
    },
  };
  const core = await CompanionCore.open({ journal: new MemoryJournal(), clock, extractor });
  const result = await core.ingestTurn({ userText: "我在北京", assistantText: "北京今天冷吗" });
  assert.equal(result.ok, true);
  const state = core.snapshot();
  assert.equal(state.facts[0].value, "北京");
  assert.equal(state.diary[0].text, "今天聊了北京");
  assert.equal(state.episodes[0].summary, "聊北京天气");
  assert.equal(state.relationship.intimacy, 2);
  assert.equal(state.relationship.trust, 1.5);
  assert.ok(state.mood.valence > 70);
});

test("extractor failure is reported without corrupting the turn", async () => {
  const clock = fixedClock();
  const extractor = { async extract() { throw new Error("model unavailable"); } };
  const core = await CompanionCore.open({ journal: new MemoryJournal(), clock, extractor });
  const result = await core.ingestTurn({ userText: "hi", assistantText: "hello" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /model unavailable/);
  assert.equal(core.snapshot().interaction.lastUserAt, T0);
});


test("diary pruning enforces a total character budget without touching other kinds", async () => {
  const clock = fixedClock();
  const core = await CompanionCore.open({ journal: new MemoryJournal(), clock });
  core.addDiary({ text: "第一天的外记".repeat(30), kind: "outer", at: 1000 });
  core.addDiary({ text: "第二天的外记".repeat(30), kind: "outer", at: 2000 });
  core.addDiary({ text: "inner 保留", kind: "inner", at: 3000 });
  const removed = core.pruneDiary({ kind: "outer", maxChars: 300, at: 4000 });
  assert.ok(removed.length >= 1);
  const state = core.snapshot();
  assert.ok(state.diary.filter((entry) => entry.kind === "outer").reduce((sum, entry) => sum + entry.text.length, 0) <= 300);
  assert.ok(state.diary.some((entry) => entry.kind === "inner"));
});
