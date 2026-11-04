import test from "node:test";
import assert from "node:assert/strict";
import { CompanionCore, MemoryJournal } from "../src/index.js";

async function fixture() {
  const journal = new MemoryJournal();
  const core = await CompanionCore.open({ journal });
  core.rememberFact({ subject: "用户", key: "饮料", value: "咖啡" });
  return { core, journal };
}

test("fact correction is one durable event, with no superseded-only intermediate state", async () => {
  const { core, journal } = await fixture();
  const before = journal.readAll().length;
  core.rememberFact({ subject: "用户", key: "饮料", value: "茶" });
  assert.equal(journal.readAll().length, before + 1);
  const restored = await CompanionCore.open({ journal });
  assert.deepEqual(restored.snapshot().facts.filter((item) => item.status === "active").map((item) => item.value), ["茶"]);
});

test("failed correction cannot retire the previous fact before its replacement commits", async () => {
  const { core, journal } = await fixture();
  const append = journal.append.bind(journal);
  journal.append = (event) => {
    if (event.type === "fact/added" || event.type === "fact/replaced") throw new Error("replacement write failed");
    append(event);
  };
  assert.throws(() => core.rememberFact({ subject: "用户", key: "饮料", value: "茶" }), /write failed/);
  assert.deepEqual(core.snapshot().facts.filter((item) => item.status === "active").map((item) => item.value), ["咖啡"]);
  journal.append = append;
  const restored = await CompanionCore.open({ journal });
  assert.deepEqual(restored.snapshot().facts.filter((item) => item.status === "active").map((item) => item.value), ["咖啡"]);
});
