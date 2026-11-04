import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileJournal, MemoryJournal, parseJournal } from "../src/journal.js";
import { applyEvent, createInitialState } from "../src/state.js";
import { T0 } from "./helpers.js";

test("MemoryJournal stores lines and can be replayed", () => {
  const journal = new MemoryJournal();
  const event = { v: 1, seq: 1, at: T0, type: "core/initialized", data: {} };
  journal.append(event);
  const parsed = parseJournal(journal.readAll());
  assert.deepEqual(parsed, [event]);
});

test("FileJournal appends and reads complete records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-journal-"));
  const file = path.join(dir, "journal.jsonl");
  const journal = new FileJournal(file, { fsync: false });
  journal.append({ v: 1, seq: 1, at: T0, type: "core/initialized", data: {} });
  journal.append({ v: 1, seq: 2, at: T0 + 1, type: "interaction/recorded", data: { patch: { presence: "active" } } });
  journal.close();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const events = parseJournal(lines);
  assert.equal(events.length, 2);
  assert.equal(events[1].seq, 2);
});

test("parseJournal discards a torn final line but rejects a broken middle line", () => {
  const good = JSON.stringify({ v: 1, seq: 1, at: T0, type: "core/initialized", data: {} });
  assert.deepEqual(parseJournal([good, "{\"v\":1,"]).length, 1);
  assert.throws(() => parseJournal([good, "not json", good]), /invalid journal line/);
});

test("replay applies journal events to state", () => {
  const state = createInitialState({ now: T0 });
  applyEvent(state, { v: 1, seq: 1, at: T0, type: "interaction/recorded", data: { patch: { presence: "away" } } });
  assert.equal(state.interaction.presence, "away");
  assert.equal(state.meta.seq, 1);
});
