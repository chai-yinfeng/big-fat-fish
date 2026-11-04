import test from "node:test";
import assert from "node:assert/strict";
import { CompanionCore, MemoryJournal } from "../../core/src/index.js";
import { writeInnerDiary, innerDiaryTool } from "../lib/inner-diary-action.js";

async function fixture() {
  const core = await CompanionCore.open({ journal: new MemoryJournal() });
  const config = { innerDiary: { enabled: true }, diary: { window: { maxEntryChars: { inner: 240 }, maxTotalChars: { inner: 6000 } } } };
  return { core, config, sessionId: "bound", isBound: (id) => id === "bound" };
}

test("inner diary is an explicit bound-agent action, deduplicated and private by default", async () => {
  const input = await fixture();
  assert.equal(input.core.snapshot().diary.length, 0);
  const first = writeInnerDiary({ ...input, text: "我拿不准这个细节，还想再看一眼。", key: "reading-1" });
  const repeat = writeInnerDiary({ ...input, text: "我拿不准这个细节，还想再看一眼。", key: "reading-1" });
  assert.equal(first.saved, true);
  assert.equal(repeat.duplicate, true);
  assert.equal(first.id, repeat.id);
  assert.equal(input.core.snapshot().diary.length, 1);
  assert.doesNotMatch(input.core.buildContext().text, /拿不准这个细节/);
  assert.match(input.core.buildContext({ includeInnerDiary: true }).text, /拿不准这个细节/);
  assert.throws(() => writeInnerDiary({ ...input, text: "另一件事", key: "reading-1" }), /another/);
});

test("inner action rejects unbound callers, disabled state and oversized text without writes", async () => {
  const input = await fixture();
  assert.throws(() => writeInnerDiary({ ...input, sessionId: "other", text: "不写", key: "k" }), /bound/);
  assert.throws(() => writeInnerDiary({ ...input, config: { innerDiary: { enabled: false } }, text: "不写", key: "k" }), /disabled/);
  assert.throws(() => writeInnerDiary({ ...input, text: "长".repeat(241), key: "k" }), /exceeds/);
  assert.throws(() => writeInnerDiary({ ...input, text: "", key: "k" }), /required/);
  assert.equal(input.core.snapshot().diary.length, 0);
});

test("inner tool exposes a small explicit action and caller identity", async () => {
  let received;
  const tool = innerDiaryTool((args, agent) => { received = { args, agent }; return { saved: true }; });
  const agent = { id: "a" };
  assert.deepEqual(await tool.execute({ text: "想法", key: "1" }, { agent }), { saved: true });
  assert.equal(received.agent, agent);
  assert.equal(tool.isConcurrencySafe(), false);
  assert.equal(tool.parameters.additionalProperties, false);
});
