import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";
import { FileJournal, normalizePersona } from "../../core/src/index.js";

function host() {
  const effects = [], contexts = [];
  let companion;
  const agent = { session: { id: "bound", snapshotEvents: () => [] }, status: "idle" };
  const ctx = {
    effect: (fn) => { const stop = fn(); if (stop) effects.push(stop); return stop; },
    agents: { list: () => [agent], get: () => agent }, get: () => undefined,
    provide: (name, value) => { if (name === "companion") companion = value; },
    on: () => () => {}, interval: () => () => {},
    systemPrompt: { getContextOrder: () => 210, context: (definition) => { contexts.push(definition); return () => {}; } },
    webServer: { register: () => () => {}, getOrigin: () => "http://localhost" },
  };
  return { ctx, contexts, agent, state: () => companion?.state(), stop: () => { for (const stop of effects.splice(0).reverse()) stop(); } };
}
async function settled(runtime) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = runtime.state();
    if (state?.ready || state?.coreError) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("startup did not settle");
}

test("invalid identity source reports unavailable and releases the journal for a corrected restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-persona-startup-"));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const directory = path.join(root, "companion");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ targetSession: "bound", autoBindPreset: "", services: { autoStart: false }, tts: { enabled: false }, extractor: { enabled: false } }));
  const file = path.join(directory, "persona.json");
  fs.writeFileSync(file, "{invalid");
  const first = host(), second = host();
  const dependencies = { openJournal: (file) => new FileJournal(file) };
  try {
    apply(first.ctx, undefined, dependencies);
    const failed = await settled(first);
    assert.equal(failed.ready, false);
    assert.match(failed.coreError, /persona source JSON/);
    assert.match(first.contexts[0].text({ agent: first.agent }), /未就绪|暂不可用/);
    assert.equal(fs.readFileSync(file, "utf8"), "{invalid");
    const probe = new FileJournal(path.join(directory, "journal.jsonl"));
    probe.close();
    first.stop();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, persona: normalizePersona({ name: "恢复的伙伴" }) }));
    apply(second.ctx, undefined, dependencies);
    assert.equal((await settled(second)).ready, true);
    assert.match(second.contexts[0].text({ agent: second.agent }), /恢复的伙伴/);
  } finally {
    first.stop(); second.stop();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
