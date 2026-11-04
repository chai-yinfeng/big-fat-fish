import test from "node:test";
import assert from "node:assert/strict";
import { buildInnerDiaryPrompt, createInnerDiaryWriter, parseInnerDiary } from "../lib/inner-diary.js";

function fakeLlm(text) {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "low" }] } };
    },
    async *stream() {
      yield { type: "text-delta", text };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

test("inner diary prompt is first-person and explicitly private", () => {
  const prompt = buildInnerDiaryPrompt({
    state: {
      persona: { name: "大肥鱼", traits: ["温和"] },
      relationship: { stage: "close", intimacy: 40, trust: 30 },
      mood: { valence: 70, energy: 60 },
      diary: [{ kind: "outer", text: "今天一起喝了咖啡。", at: 1 }],
    },
    turns: [{ userText: "今天有点累", assistantText: "那先休息一下吧" }],
    maxChars: 120,
  });
  assert.match(prompt.system, /第一人称/);
  assert.match(prompt.system, /只给自己看/);
  assert.match(prompt.user, /今天一起喝了咖啡/);
  assert.match(prompt.user, /今天有点累/);
});

test("inner diary writer parses a private first-person entry", async () => {
  const writer = createInnerDiaryWriter({
    llm: fakeLlm("```text\n内心日记：今天他声音有点低，我有点担心，想多陪他一会儿。\n```"),
    config: { maxChars: 180 },
  });
  const text = await writer.write({
    state: { persona: { name: "大肥鱼" }, diary: [] },
    turns: [{ userText: "有点累", assistantText: "先休息" }],
    route: { provider: "fake", model: "fake-1" },
  });
  assert.equal(text, "今天他声音有点低，我有点担心，想多陪他一会儿。");
  assert.equal(parseInnerDiary("“短句。”", 180), "短句。");
});
