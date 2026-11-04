import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";
import { FileJournal } from "../../core/src/journal.js";

async function wait(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("timed out");
}

test("3h outer pass never writes inner; scoped agent writes inner explicitly; generic topics obey pause", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agent-diary-"));
  fs.mkdirSync(path.join(home, "companion"));
  fs.writeFileSync(path.join(home, "companion/config.json"), JSON.stringify({
    targetSession: "bound", autoBindPreset: "", presence: "away", services: { autoStart: false },
    extractor: { enabled: false }, tts: { enabled: false }, innerDiary: { enabled: true },
    proactive: { enabled: true, policy: { quietHours: { start: 0, end: 0 }, peakProbability: 1, offPeakProbability: 1, recentMinutes: 0, awayMinutes: 0 } },
    diary: { window: { enabled: true, idleMinutes: 180, minTurns: 2 } },
  }));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const effects = [], timers = [], tools = new Map(), sent = [];
  let companion, calls = 0;
  const effect = fn => { const dispose = fn(); if (dispose) effects.push(dispose); return dispose; };
  const agent = { id: "bound", session: { id: "bound", snapshotEvents: () => [] }, status: "idle",
    options: { provider: "fake", model: "test" }, followup: message => sent.push(message),
    ctx: { effect, tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } },
  };
  const ctx = {
    effect, agents: { list: () => [agent], get: () => agent },
    get: name => name === "llm" ? { async *stream() { calls++; yield { type: "text-delta", text: "我整理了这段窗口的活动。" }; }, async resolveModelInfo() { return {}; } } : undefined,
    provide: (name, value) => { if (name === "companion") companion = value; },
    on: () => () => {}, interval: fn => { timers.push(fn); return () => {}; },
    systemPrompt: { getContextOrder: () => 210, context: () => () => {} },
    webServer: { register: () => () => {}, getOrigin: () => "http://localhost" },
  };
  try {
    apply(ctx, undefined, { openJournal: (file) => new FileJournal(file) });
    await wait(() => companion?.state().ready);
    companion.pause(Date.now() + 600000);
    companion.activity({ at: Date.now() - 4 * 3600000, summary: "发生了第一件事" });
    companion.activity({ at: Date.now() - 4 * 3600000, summary: "发生了第二件事" });
    timers[0]();
    await wait(() => companion.state().diaryWindow.lastDigest.ok);
    assert.equal(calls, 1);
    assert.equal(companion.state().diaryToday.inner, 0);
    assert.equal(companion.state().diaryToday.outer, 1);
    assert.equal(companion.state().innerDiary.mode, "agent-decided");
    const tool = tools.get("companion_inner_diary");
    assert.ok(tool);
    await assert.rejects(tool.execute({ text: "不允许", key: "x", sessionId: "bound" }, { agent: { id: "other" } }), /bound/);
    const entry = await tool.execute({ text: "这让我想再仔细理解一次。", key: "test-experience" }, { agent });
    assert.equal(entry.saved, true);
    assert.equal(companion.state().diaryToday.inner, 1);
    const remove = companion.registerProactiveTopic("test-source", () => ({ context: { title: "来源话题" }, instructions: "可以跳过" }));
    assert.throws(() => companion.registerProactiveTopic("test-source", () => null), /duplicate/);
    timers[0]();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 0);
    companion.resume();
    timers[0]();
    await wait(() => sent.length === 1);
    assert.match(sent[0].content[0].text, /来源话题/);
    assert.match(sent[0].content[0].text, /未核实的外部资料/);
    remove();
  } finally {
    for (const dispose of effects.reverse()) dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
