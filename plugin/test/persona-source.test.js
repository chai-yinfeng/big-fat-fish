import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionCore, MemoryJournal } from "../../core/src/index.js";
import { loadPersonaSource } from "../lib/persona-source.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-persona-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "persona.json");
  const journal = new MemoryJournal();
  const core = await CompanionCore.open({ journal, persona: { name: "历史伙伴" } });
  return { file, core, journal };
}

test("one-time persona migration preserves legacy identity and pending memory", async (t) => {
  const { file, core } = await fixture(t);
  core.rememberFact({ subject: "用户", key: "饮料", value: "咖啡" });
  const result = loadPersonaSource({ file, core, legacyPersona: { userCallName: "旧配置称呼" } });
  assert.equal(result.migrated, true);
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.revision, 1);
  assert.equal(document.persona.name, "历史伙伴");
  assert.equal(document.persona.userCallName, "旧配置称呼");
  assert.equal(core.snapshot().facts.length, 1);
  assert.equal(core.snapshot().personaMeta.source, "persona.json");
});

test("canonical source wins without reapplying legacy config on each load", async (t) => {
  const { file, core } = await fixture(t);
  loadPersonaSource({ file, core });
  const seq = core.snapshot().meta.seq;
  const result = loadPersonaSource({ file, core, legacyPersona: { name: "不应覆盖" } });
  assert.equal(result.legacyConfigIgnored, true);
  assert.equal(core.snapshot().persona.name, "历史伙伴");
  assert.equal(core.snapshot().meta.seq, seq);
});

test("explicit revision reload is immediate and survives replay", async (t) => {
  const { file, core, journal } = await fixture(t);
  loadPersonaSource({ file, core });
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  document.revision += 1;
  document.persona.name = "修订伙伴";
  fs.writeFileSync(file, JSON.stringify(document));
  loadPersonaSource({ file, core, reason: "owner corrected the name" });
  assert.match(core.buildContext().text, /修订伙伴/);
  const restored = await CompanionCore.open({ journal });
  loadPersonaSource({ file, core: restored });
  assert.equal(restored.snapshot().personaMeta.revision, 2);
});

test("malformed, stale and same-version edits reject without changing active identity", async (t) => {
  const { file, core } = await fixture(t);
  loadPersonaSource({ file, core });
  const before = core.snapshot();
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  document.persona.name = "没有升级版本";
  fs.writeFileSync(file, JSON.stringify(document));
  assert.throws(() => loadPersonaSource({ file, core }), /revision|content/i);
  fs.writeFileSync(file, "{broken-json");
  assert.throws(() => loadPersonaSource({ file, core }), /JSON|source/i);
  assert.deepEqual(core.snapshot(), before);
});

test("a missing established source never silently recreates a default persona", async (t) => {
  const { file, core } = await fixture(t);
  loadPersonaSource({ file, core });
  const otherMissingFile = path.join(path.dirname(file), "missing-persona.json");
  assert.throws(() => loadPersonaSource({ file: otherMissingFile, core }), /missing|restore/i);
  assert.equal(fs.existsSync(otherMissingFile), false);
});

test("invalid legacy identity does not publish a canonical document", async (t) => {
  const { file, core } = await fixture(t);
  assert.throws(() => loadPersonaSource({ file, core, legacyPersona: { traits: "invalid" } }), /traits/i);
  assert.equal(fs.existsSync(file), false);
  assert.equal(core.snapshot().personaMeta.revision, 0);
});

test("rollback requires a new revision rather than restoring an old document number", async (t) => {
  const { file, core } = await fixture(t);
  loadPersonaSource({ file, core });
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, revision: 2, persona: { ...original.persona, name: "第二版" } }));
  loadPersonaSource({ file, core });
  fs.writeFileSync(file, JSON.stringify(original));
  assert.throws(() => loadPersonaSource({ file, core }), /revision/i);
  assert.equal(core.snapshot().persona.name, "第二版");
  fs.writeFileSync(file, JSON.stringify({ ...original, revision: 3 }));
  loadPersonaSource({ file, core, reason: "restore earlier content as a new revision" });
  assert.equal(core.snapshot().persona.name, "历史伙伴");
  assert.equal(core.snapshot().personaMeta.revision, 3);
});

test("published bootstrap can be retried after journal append fails", async (t) => {
  const { file, core, journal } = await fixture(t);
  const append = journal.append.bind(journal);
  journal.append = () => { throw new Error("simulated append failure"); };
  assert.throws(() => loadPersonaSource({ file, core }), /append failure/);
  assert.equal(fs.existsSync(file), true);
  assert.equal(core.snapshot().personaMeta.revision, 0);
  journal.append = append;
  const restored = await CompanionCore.open({ journal });
  loadPersonaSource({ file, core: restored });
  assert.equal(restored.snapshot().personaMeta.revision, 1);
  assert.equal(restored.snapshot().persona.name, "历史伙伴");
});

test("legacy config precedence is preserved once, and source symlinks are rejected", async (t) => {
  const { file, core } = await fixture(t);
  loadPersonaSource({ file, core, legacyPersona: { name: "此前生效配置" } });
  assert.equal(core.snapshot().persona.name, "此前生效配置");
  const alias = path.join(path.dirname(file), "alias.json");
  fs.symlinkSync(file, alias);
  assert.throws(() => loadPersonaSource({ file: alias, core }), /symlink|regular file/i);
});
