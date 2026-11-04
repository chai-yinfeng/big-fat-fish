import test from "node:test";
import assert from "node:assert/strict";
import { applyMoodEvent, decayMood, describeMood, moodLabel } from "../src/mood.js";
import { MOOD_EMOTIONS } from "../src/state.js";
import { HOUR_MS } from "../src/util.js";
import { T0 } from "./helpers.js";

function mood(overrides = {}) {
  return {
    valence: 70,
    energy: 60,
    emotions: Object.fromEntries(MOOD_EMOTIONS.map((name) => [name, 0])),
    at: T0,
    ...overrides,
  };
}

test("valence and emotions decay on their half-lives", () => {
  const start = mood({ valence: 90, emotions: { ...mood().emotions, joy: 80 } });
  const after = decayMood(start, T0 + 3 * HOUR_MS);
  assert.ok(Math.abs(after.valence - 80) < 0.01);
  const emotionAfter = decayMood(start, T0 + 1.5 * HOUR_MS);
  assert.ok(Math.abs(emotionAfter.emotions.joy - 40) < 0.01);
});

test("praise raises valence and joy, and values stay bounded", () => {
  const next = applyMoodEvent(mood(), "praise", T0 + 1000);
  assert.equal(next.valence, 76);
  assert.equal(next.emotions.joy, 8);
  const capped = applyMoodEvent(mood({ valence: 99, emotions: { ...mood().emotions, joy: 99 } }), "praise", T0 + 1000);
  assert.equal(capped.valence, 100);
  assert.equal(capped.emotions.joy, 100);
});

test("describeMood exposes label and dominant emotion", () => {
  const view = describeMood(mood({ valence: 85, emotions: { ...mood().emotions, affection: 30 } }), T0);
  assert.equal(view.label, "欢喜");
  assert.equal(view.dominant.name, "affection");
  assert.match(view.text, /心情/);
  assert.equal(moodLabel(20), "难过");
});
