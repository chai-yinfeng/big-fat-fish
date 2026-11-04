import test from "node:test";
import assert from "node:assert/strict";
import { buildOuterDigestPrompt } from "../lib/diary-window.js";
import { buildExtractionPrompt } from "../lib/extractor.js";
import { buildInnerDiaryPrompt } from "../lib/inner-diary.js";

const state = { persona: { name: "改名后的伙伴", traits: ["好奇"] }, diary: [] };
const turns = [{ userText: "我们聊了咖啡", assistantText: "今天的豆子很香" }];

test("every memory-writing prompt follows the authoritative name without a second fixed identity", () => {
  const prompts = [
    buildOuterDigestPrompt({ state, entries: [{ kind: "turn", ...turns[0] }] }),
    buildExtractionPrompt({ state, turns }),
    buildInnerDiaryPrompt({ state, turns }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt.system, /改名后的伙伴/);
    assert.doesNotMatch(prompt.system + prompt.user, /大肥鱼|小肥鱼/);
  }
});
