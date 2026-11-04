import test from "node:test";
import assert from "node:assert/strict";
import { composeOpener, shouldSpeak } from "../src/proactive.js";
import { createInitialState } from "../src/state.js";
import { T0, alwaysRng } from "./helpers.js";

const parts = { hour: 10, minute: 0, weekday: 3, date: "2026-10-24" };

function state(overrides = {}) {
  const value = createInitialState({ now: T0 });
  value.interaction.lastUserAt = T0 - 60 * 60_000;
  Object.assign(value.interaction, overrides.interaction ?? {});
  if (overrides.policy) value.policy = { ...value.policy, ...overrides.policy };
  return value;
}

test("speaks when constraints pass and the roll is below probability", () => {
  const result = shouldSpeak({ state: state(), now: T0, parts, presence: "away", rng: alwaysRng(0) });
  assert.equal(result.speak, true);
  assert.equal(result.reason, "speak");
  assert.ok(result.probability > 0);
});

test("quiet hours, cooldown, daily cap and pause are hard stops", () => {
  const quiet = shouldSpeak({ state: state(), now: T0, parts: { ...parts, hour: 3 }, presence: "away", rng: alwaysRng(0) });
  assert.equal(quiet.speak, false);
  assert.equal(quiet.reason, "quiet-hours");

  const cooldown = shouldSpeak({
    state: state({ interaction: { lastProactiveAt: T0 - 10 * 60_000 } }),
    now: T0,
    parts,
    presence: "away",
    rng: alwaysRng(0),
  });
  assert.equal(cooldown.reason, "cooldown");

  const awaiting = shouldSpeak({
    state: state({ interaction: { unrespondedProactive: 1 } }),
    now: T0,
    parts,
    presence: "away",
    rng: alwaysRng(0),
  });
  assert.equal(awaiting.reason, "awaiting-reply");

  const cap = shouldSpeak({
    state: state({ interaction: { proactiveDay: parts.date, proactiveCount: 6 } }),
    now: T0,
    parts,
    presence: "away",
    rng: alwaysRng(0),
  });
  assert.equal(cap.reason, "daily-cap");

  const paused = shouldSpeak({
    state: state({ policy: { pausedUntil: T0 + 60_000 } }),
    now: T0,
    parts,
    presence: "away",
    rng: alwaysRng(0),
  });
  assert.equal(paused.reason, "paused");
});

test("active presence lowers the probability versus away", () => {
  const away = shouldSpeak({ state: state(), now: T0, parts, presence: "away", rng: alwaysRng(0.99) });
  const active = shouldSpeak({ state: state(), now: T0, parts, presence: "active", rng: alwaysRng(0.99) });
  assert.ok(active.probability < away.probability);
});

test("opener intent follows absence and mood", () => {
  const absent = state({ interaction: { lastUserAt: T0 - 7 * 60 * 60_000 } });
  assert.equal(composeOpener({ state: absent, now: T0, presence: "away" }).intent, "missing");
  const low = state({ interaction: { lastUserAt: T0 - 60 * 60_000 } });
  low.mood.valence = 30;
  assert.equal(composeOpener({ state: low, now: T0, presence: "desktop" }).intent, "care");
});
