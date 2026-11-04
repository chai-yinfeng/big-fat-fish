import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_MOOD_EVENTS,
  buildExtractionPrompt,
  createLlmExtractor,
  formatTurnHistory,
  parseExtraction,
  parseExtractionJson,
  pickReasoningEffort,
  sanitizeExtraction,
} from "../lib/extractor.js";

function stateFixture() {
  return {
    persona: { name: "大肥鱼", userCallName: "你", traits: ["温和", "好奇"] },
    relationship: { stage: "familiar", intimacy: 25, trust: 15 },
    mood: { valence: 72, energy: 58, emotions: {} },
    facts: [
      { subject: "用户", key: "喜欢的饮料", value: "咖啡", status: "active", lastConfirmedAt: 2 },
      { subject: "用户", key: "旧事实", value: "已过期", status: "superseded", lastConfirmedAt: 1 },
    ],
    diary: [
      { kind: "outer", date: "2026-10-24", text: "今天一起喝了手冲", at: 1 },
      { kind: "inner", date: "2026-10-24", text: "我觉得他今天有点累", at: 2 },
    ],
    __date: "2026-10-24",
  };
}

test("prompt includes persona, diary caps and the current state", () => {
  const { system, user } = buildExtractionPrompt({
    state: stateFixture(),
    turns: [{ userText: "我最近在学手冲", assistantText: "耶加雪菲不错" }],
    maxChars: 2000,
  });
  assert.match(system, /只输出一个 JSON 对象/);
  assert.match(system, /outer 至多 1，inner 至多 1/);
  assert.match(system, /praise\/affection/);
  assert.match(user, /【当前状态】/);
  assert.match(user, /今天的日记：outer 已有 1 条，inner 已有 1 条/);
  assert.match(user, /用户\.喜欢的饮料：咖啡/);
  assert.doesNotMatch(user, /旧事实/);
  assert.match(user, /用户：我最近在学手冲/);
  assert.match(user, /助手：耶加雪菲不错/);
});

test("turn history keeps the newest turns within the budget", () => {
  const filler = "这是一段用来占位的对话内容，".repeat(6);
  const turns = [
    { userText: `第一轮${filler}`, assistantText: `回复一${filler}` },
    { userText: `第二轮${filler}`, assistantText: `回复二${filler}` },
    { userText: `第三轮${filler}`, assistantText: `回复三${filler}` },
  ];
  const text = formatTurnHistory(turns, 200);
  assert.match(text, /更早的对话已省略/);
  assert.match(text, /第三轮/);
  assert.doesNotMatch(text, /第一轮/);
});

test("JSON parser tolerates fences and surrounding prose", () => {
  const fenced = parseExtractionJson('好的：\n```json\n{"facts":[]}\n```\n结束');
  assert.deepEqual(fenced, { facts: [] });
  assert.throws(() => parseExtractionJson("没有 JSON"), /no JSON object/);
  assert.throws(() => parseExtractionJson("{ broken }"), /not valid JSON/);
});

test("sanitizer drops malformed items and enforces bounds", () => {
  const extraction = sanitizeExtraction({
    facts: [
      { subject: "用户", key: "喜欢的饮料", value: "咖啡", confidence: 3 },
      { subject: "用户", key: "喜欢的饮料", value: "咖啡", confidence: 0.2 },
      { subject: "用户", key: "", value: "空 key" },
      { key: "住址", value: "不应记录" },
      { key: "银行卡密码", value: "123456" },
      { key: "token", value: "sk-abcdefghijk" },
      { key: "a", value: "1" },
      { key: "b", value: "2" },
      { key: "c", value: "3" },
    ],
    diary: [
      "今天一起散步",
      { kind: "inner", text: "我有点担心他" },
      { kind: "weird", text: "按 outer 处理" },
      { kind: "inner", text: "我有点担心他" },
    ],
    episodes: [
      { summary: "聊了咖啡", salience: 2, emotions: { joy: 5, unknown: 1 }, participants: ["用户", "大肥鱼"], evidence: ["原话"] },
      "第二件事",
      "第三件事",
    ],
    moodEvent: { type: "conflict", deltas: { valence: -99, emotions: { sadness: 99 } } },
    relationshipEvent: { intimacy: 99, trust: -99 },
  });
  assert.equal(extraction.facts.length, 3);
  assert.equal(extraction.facts[0].confidence, 1);
  assert.equal(extraction.facts[0].subject, "用户");
  assert.equal(extraction.diary.length, 3);
  assert.equal(extraction.diary[0].kind, "outer");
  assert.equal(extraction.diary[1].kind, "inner");
  assert.equal(extraction.diary[2].kind, "outer");
  assert.equal(extraction.episodes.length, 2);
  assert.equal(extraction.episodes[0].salience, 1);
  assert.deepEqual(extraction.episodes[0].emotions, { joy: 1 });
  assert.equal(extraction.moodEvent.type, "conflict");
  assert.equal(extraction.moodEvent.deltas.valence, -30);
  assert.equal(extraction.moodEvent.deltas.emotions.sadness, 30);
  assert.deepEqual(extraction.relationshipEvent, { intimacy: 3, trust: -3 });
});

test("unknown mood events are dropped", () => {
  assert.equal(sanitizeExtraction({ moodEvent: "nonsense" }).moodEvent, null);
  for (const event of ALLOWED_MOOD_EVENTS) {
    assert.equal(sanitizeExtraction({ moodEvent: event }).moodEvent, event);
  }
});

test("credential-shaped facts are dropped even if the model returns them", () => {
  const extraction = sanitizeExtraction({
    facts: [
      { key: "银行卡密码", value: "123456" },
      { key: "家庭住址", value: "某路 1 号" },
      { key: "api key", value: "sk-abcdefghijk" },
      { key: "喜欢的饮料", value: "咖啡" },
    ],
  });
  assert.deepEqual(extraction.facts.map((fact) => fact.key), ["喜欢的饮料"]);
});

test("reasoning effort picks the lowest advertised level", async () => {
  assert.equal(await pickReasoningEffort({ configured: "high" }), "high");
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "high" }, { id: "low" }, { id: "medium" }] } };
    },
  };
  assert.equal(await pickReasoningEffort({ llm, route: { provider: "p", model: "m" } }), "low");
  assert.equal(await pickReasoningEffort({ llm: {}, route: { provider: "p", model: "m" } }), undefined);
});

test("LLM extractor streams text and returns sanitized memory", async () => {
  const captured = [];
  const llm = {
    async *stream(options) {
      captured.push(options);
      yield { type: "text-delta", index: 0, text: '{"facts":[{"subject":"用户",' };
      yield { type: "text-delta", index: 0, text: '"key":"咖啡","value":"耶加雪菲","confidence":0.9}]}' };
      yield { type: "finish", reason: { kind: "stop" } };
    },
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "high" }, { id: "minimal" }] } };
    },
  };
  const extractor = createLlmExtractor({
    llm,
    config: { maxTokens: 500, temperature: 0.1, timeoutMs: 5_000, reasoningEffort: "" },
  });
  const result = await extractor.extract({
    turn: { messages: [{ userText: "我喜欢耶加雪菲", assistantText: "记住了" }], now: Date.now() },
    state: stateFixture(),
    route: { provider: "fake", model: "fake-1" },
  });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].key, "咖啡");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].provider, "fake");
  assert.equal(captured[0].model, "fake-1");
  assert.equal(captured[0].reasoningEffort, "minimal");
  assert.equal(captured[0].maxTokens, 500);
  assert.equal(captured[0].temperature, 0.1);
  assert.equal(typeof captured[0].system, "string");
  assert.equal(captured[0].messages[0].role, "user");
});

test("LLM extractor reports model failures and empty output", async () => {
  const failing = createLlmExtractor({
    llm: {
      async *stream() {
        yield { type: "finish", reason: { kind: "error", failure: { message: "quota", code: "quota" } } };
      },
    },
  });
  await assert.rejects(() => failing.extract({
    turn: { messages: [{ userText: "hi" }] },
    state: stateFixture(),
    route: { provider: "fake", model: "fake-1" },
  }), /model request error: quota/);

  const empty = createLlmExtractor({
    llm: {
      async *stream() {
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  });
  await assert.rejects(() => empty.extract({
    turn: { messages: [{ userText: "hi" }] },
    state: stateFixture(),
    route: { provider: "fake", model: "fake-1" },
  }), /no text/);

  const noLlm = createLlmExtractor({});
  await assert.rejects(() => noLlm.extract({
    turn: { messages: [{ userText: "hi" }] },
    state: stateFixture(),
    route: { provider: "fake", model: "fake-1" },
  }), /LLM service is unavailable/);
});
