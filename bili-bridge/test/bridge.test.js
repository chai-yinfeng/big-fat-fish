import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

function harness(root) {
  const effects = [], contexts = [], routes = new Map(), listeners = new Map(), timers = [];
  const topics = new Map(), bindings = new Set(["onebot-private-test"]);
  const scopedTools = new Map();
  const ownEffect = (fn) => { const dispose = fn(); if (dispose) effects.push(dispose); return dispose; };
  const agent = { id: "onebot-private-test", ctx: { effect: ownEffect, tools: { register(tool) { scopedTools.set(tool.name, tool); return () => scopedTools.delete(tool.name); } } } };
  const other = { id: "unbound" };
  const ctx = {
    effect: ownEffect,
    companion: {
      isBound: (id) => bindings.has(id),
      state: () => ({ boundSessions: [...bindings] }),
      registerProactiveTopic(id, peek) { topics.set(id, peek); return () => topics.delete(id); },
    },
    agents: { list: () => [agent, other] },
    systemPrompt: { context: (value) => { contexts.push(value); return () => {}; } },
    webServer: { register: (value) => { routes.set(value.path, value); return () => routes.delete(value.path); } },
    interval(fn) { timers.push(fn); return () => {}; },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
  };
  apply(ctx, { sourceDir: root, stateDir: join(root, "bridge-state") });
  return { agent, other, ctx, bindings, scopedTools, contexts, routes, topics, timers,
    dispose: () => effects.reverse().forEach((fn) => fn()) };
}

async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("fixture source did not refresh");
}

test("same bound companion reads report-only evidence, decides and owns normal delivery", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bili-bridge-")));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out/2026-10-27.md"), "### BV1Uinz6CENd\n标题：测试视频 / UP：作者 / 链接：https://invalid.test\n**档位**：值得看\n为什么值得：这是一个发现，不是观影证据。\n");
  const h = harness(root);
  try {
    await eventually(() => h.contexts[0].text({ agent: h.agent }).includes("测试视频"));
    assert.equal(h.scopedTools.size, 2);
    assert.equal(h.contexts[0].text({ scope: h.other }), "");
    assert.match(h.contexts[0].text({ scope: h.agent }), /未核实/);
    const peek = h.topics.get("bili-discovery");
    assert.equal(peek().preferredSessionId, h.agent.id);
    const read = h.scopedTools.get("companion_bili_read");
    const result = await read.execute({ bvid: "BV1Uinz6CENd" }, { agent: h.agent });
    assert.equal(result.candidate.coverage, "report_only");
    assert.equal(result.candidate.url, "https://www.bilibili.com/video/BV1Uinz6CENd");
    await assert.rejects(read.execute({}, { agent: h.other }), /bound/);
    await assert.rejects(read.execute({ bvid: "../../credentials" }, { agent: h.agent }), /strict/);
    const decide = h.scopedTools.get("companion_bili_decide");
    const decision = await decide.execute({ bvid: "BV1Uinz6CENd", action: "share", reason: "想聊一个具体细节" }, { agent: h.agent });
    assert.equal(decision.sent, false);
    assert.equal(decision.decision.delivery, "intent_only");
    assert.equal(peek(), null);
    const duplicate = await decide.execute({ bvid: "BV1Uinz6CENd", action: "share" }, { agent: h.agent });
    assert.equal(duplicate.decision.duplicate, true);
    assert.equal(JSON.parse(readFileSync(join(root, "bridge-state/decisions.json"), "utf8")).BV1Uinz6CENd.delivery, "intent_only");
    h.bindings.clear();
    h.timers[0]();
    assert.equal(h.scopedTools.size, 0);
  } finally { h.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("missing reports are quiet and a corrupt decision store fails closed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bili-empty-")));
  const h = harness(root);
  try {
    assert.equal(h.topics.get("bili-discovery")(), null);
    const decide = h.scopedTools.get("companion_bili_decide");
    await assert.rejects(decide.execute({ bvid: "BV1Uinz6CENd", action: "share" }, { agent: h.agent }), /not found/);
    mkdirSync(join(root, "bridge-state"), { recursive: true });
    writeFileSync(join(root, "bridge-state/decisions.json"), "bad json");
    assert.throws(() => harness(root), /JSON/);
  } finally { h.dispose(); rmSync(root, { recursive: true, force: true }); }
});
