import test from "node:test";
import assert from "node:assert/strict";
import { CompanionCore } from "../src/companion.js";
import { MemoryJournal } from "../src/journal.js";
import { T0, alwaysRng, fixedClock } from "./helpers.js";

async function makeCore(overrides = {}) {
  const clock = fixedClock();
  const journal = new MemoryJournal();
  const core = await CompanionCore.open({ journal, clock, rng: alwaysRng(0), ...overrides });
  return { core, journal, clock };
}

test("tick speaks, marks sent, then respects cooldown", async () => {
  const { core } = await makeCore();
  core.recordUserMessage("在吗", { at: T0 - 60_000 });
  const tick = core.tick({ at: T0, presence: "away" });
  assert.equal(tick.speak, true);
  core.markProactiveSent({ at: T0, intent: tick.opener.intent });
  const again = core.tick({ at: T0 + 1000, presence: "away" });
  assert.equal(again.speak, false);
  assert.equal(again.reason, "cooldown");
});

test("poke bypasses the policy and pause blocks ticks", async () => {
  const { core } = await makeCore();
  core.pauseProactive(T0 + 60_000);
  assert.equal(core.tick({ at: T0, presence: "away" }).reason, "paused");
  const opener = core.poke({ at: T0 });
  assert.equal(typeof opener.seed, "string");
  core.resumeProactive();
  assert.equal(core.snapshot().policy.pausedUntil, null);
});

test("context and mood survive a journal reload", async () => {
  const { core, journal } = await makeCore();
  core.rememberFact({ subject: "用户", key: "宠物", value: "猫" });
  core.addDiary({ text: "聊到了猫" });
  core.adjustMood("affection", { at: T0 + 1000 });
  const context = core.buildContext({ query: "猫", now: T0 + 1000 });
  assert.match(context.text, /用户\.宠物：猫/);

  const reloaded = await CompanionCore.open({ journal: new MemoryJournal(journal.readAll()), clock: fixedClock() });
  assert.equal(reloaded.snapshot().facts[0].value, "猫");
  assert.equal(reloaded.snapshot().diary[0].text, "聊到了猫");
  assert.ok(reloaded.snapshot().mood.emotions.affection > 0);
});
