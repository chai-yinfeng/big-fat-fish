import test from "node:test";
import assert from "node:assert/strict";
import { CompanionCore, MemoryJournal } from "../src/index.js";

async function open(journal = new MemoryJournal()) {
  return CompanionCore.open({ journal });
}

test("persona revisions reject stale edits and preserve a replayable full snapshot", async () => {
  const journal = new MemoryJournal();
  const core = await open(journal);
  core.updatePersona({ name: "测试伙伴" }, { expectedRevision: 0, reason: "explicit edit" });
  assert.equal(core.snapshot().personaMeta.revision, 1);
  assert.equal(core.snapshot().personaMeta.reason, "explicit edit");
  const seq = core.snapshot().meta.seq;
  assert.throws(() => core.updatePersona({ name: "stale" }, { expectedRevision: 0 }), /revision/i);
  assert.equal(core.snapshot().meta.seq, seq);
  const restored = await open(journal);
  assert.deepEqual(restored.snapshot().persona, core.snapshot().persona);
  assert.deepEqual(restored.snapshot().personaMeta, core.snapshot().personaMeta);
});

test("an authoritative persona document is idempotent and rejects same-version drift", async () => {
  const core = await open();
  const document = { schemaVersion: 1, revision: 1, persona: { ...core.snapshot().persona, name: "文档伙伴" } };
  core.applyPersonaDocument(document, { source: "persona.json", reason: "bootstrap" });
  const seq = core.snapshot().meta.seq;
  core.applyPersonaDocument(document, { source: "persona.json" });
  assert.equal(core.snapshot().meta.seq, seq);
  assert.throws(() => core.applyPersonaDocument({ ...document, persona: { ...document.persona, name: "偷偷修改" } }), /revision|content/i);
  assert.throws(() => core.applyPersonaDocument({ ...document, revision: 3 }), /revision/i);
  assert.equal(core.snapshot().persona.name, "文档伙伴");
});

test("invalid persona input never appends an event or mutates current identity", async () => {
  const core = await open();
  const before = core.snapshot();
  assert.throws(() => core.updatePersona({ traits: "not-an-array" }), /traits/i);
  assert.throws(() => core.updatePersona({ unexpected: "silent extra source" }), /unknown|unexpected/i);
  assert.deepEqual(core.snapshot(), before);
});

test("a failed persona append leaves its revision and identity unchanged", async () => {
  const journal = new MemoryJournal();
  const core = await open(journal);
  const before = core.snapshot();
  journal.append = () => { throw new Error("simulated disk failure"); };
  assert.throws(() => core.updatePersona({ name: "not committed" }), /disk failure/);
  assert.deepEqual(core.snapshot(), before);
});

test("legacy persona events remain intact until an explicit first revision", async () => {
  const journal = new MemoryJournal([
    JSON.stringify({ v: 1, seq: 1, at: 1000, type: "core/initialized", data: { persona: { name: "旧名字", traits: ["旧性格"] } } }),
    JSON.stringify({ v: 1, seq: 2, at: 2000, type: "persona/updated", data: { patch: { userCallName: "旧称呼" } } }),
  ]);
  const core = await open(journal);
  assert.equal(core.snapshot().persona.name, "旧名字");
  assert.equal(core.snapshot().personaMeta.revision, 0);
  core.applyPersonaDocument({ schemaVersion: 1, revision: 1, persona: core.snapshot().persona }, { source: "persona.json", reason: "legacy migration" });
  assert.equal(core.snapshot().persona.userCallName, "旧称呼");
  assert.equal(core.snapshot().personaMeta.revision, 1);
});

test("a second initialization cannot bypass the versioned identity", async () => {
  const journal = new MemoryJournal();
  const core = await open(journal);
  core.updatePersona({ name: "权威伙伴" });
  const before = journal.readAll();
  assert.throws(() => core._append("core/initialized", { persona: { name: "旁路名字" } }), /initializ|first/i);
  assert.deepEqual(journal.readAll(), before);
  journal.append({ v: 1, seq: core.snapshot().meta.seq + 1, at: Date.now(), type: "core/initialized", data: { persona: { name: "旁路名字" } } });
  await assert.rejects(open(journal), /initializ|first/i);
});

test("same-revision verification checks actual identity, not just cached metadata", async () => {
  const core = await open();
  const document = { schemaVersion: 1, revision: 1, persona: core.snapshot().persona };
  core.applyPersonaDocument(document);
  core.state.persona.name = "out-of-band mutation";
  assert.throws(() => core.applyPersonaDocument(document), /content|identity/i);
});
