import test from "node:test";
import assert from "node:assert/strict";
import { inQuietHours, isPeak, overlapScore, tokenize, uniqueTokens } from "../src/util.js";

test("tokenize keeps Chinese bigrams and Latin words, drops stopwords", () => {
  const tokens = tokenize("我喜欢喝咖啡 and 2026年");
  assert.ok(tokens.includes("咖啡"));
  assert.ok(tokens.includes("喜欢"));
  assert.ok(tokens.includes("and"));
  assert.ok(tokens.includes("2026"));
  assert.ok(!tokens.includes("我"));
  assert.ok(!tokens.includes("的"));
});

test("overlapScore is normalized over the query", () => {
  const query = uniqueTokens("咖啡");
  assert.equal(overlapScore(query, new Set(["咖啡", "喜欢"])), 1);
  assert.equal(overlapScore(query, new Set(["茶"])), 0);
  assert.equal(overlapScore(query, new Set([])), 0);
});

test("quiet hours handle wrap and disabled windows", () => {
  assert.equal(inQuietHours(3, { start: 1, end: 8 }), true);
  assert.equal(inQuietHours(9, { start: 1, end: 8 }), false);
  assert.equal(inQuietHours(23, { start: 22, end: 6 }), true);
  assert.equal(inQuietHours(12, { start: 22, end: 6 }), false);
  assert.equal(inQuietHours(3, { start: 8, end: 8 }), false);
});

test("peak windows match weekday and hour ranges", () => {
  const windows = [{ days: [1, 2, 3, 4, 5], start: 9, end: 12 }];
  assert.equal(isPeak({ weekday: 3, hour: 10 }, windows), true);
  assert.equal(isPeak({ weekday: 3, hour: 12 }, windows), false);
  assert.equal(isPeak({ weekday: 6, hour: 10 }, windows), false);
});
