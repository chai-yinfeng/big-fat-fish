import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileJournal, parseJournal } from "../src/journal.js";

const event = (seq, extra = {}) => ({ v: 1, seq, at: 123, type: "test/event", data: {}, ...extra });
const line = (seq, extra) => JSON.stringify(event(seq, extra));
function fixture(t, contents = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "journal.jsonl");
  fs.writeFileSync(file, contents);
  return file;
}
function open(t, file) {
  const journal = new FileJournal(file, { fsync: false });
  t.after(() => journal.close());
  return journal;
}

test("repair torn UTF-8 tail before append, preserving the new event on second reopen", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`${line(1)}\n{"v":1,"label":"`), Buffer.from([0xe4, 0xb8])]));
  const journal = open(t, file);
  assert.deepEqual(parseJournal(journal.readAll()), [event(1)]);
  journal.append(event(2));
  journal.close();
  const reopened = open(t, file);
  assert.deepEqual(parseJournal(reopened.readAll()), [event(1), event(2)]);
});

test("complete event without terminal newline survives append and reopen", (t) => {
  const file = fixture(t, line(1));
  const journal = open(t, file);
  journal.append(event(2));
  journal.close();
  assert.deepEqual(parseJournal(open(t, file).readAll()), [event(1), event(2)]);
});

test("only incomplete final JSON without a newline may be discarded", () => {
  assert.deepEqual(parseJournal([line(1), '{"v":1,']), [event(1)]);
  assert.throws(() => parseJournal([line(1), '{"v":1,', ""]), /invalid journal line 2/);
  assert.throws(() => parseJournal([line(1), '{"v":1,}']), /invalid journal line 2/);
  assert.throws(() => parseJournal([line(1), "not json"]), /invalid journal line 2/);
  assert.throws(() => parseJournal([line(1), "broken", line(2)]), /invalid journal line 2/);
});

test("complete unsupported or malformed final records fail loudly", () => {
  for (const invalid of [event(2, { v: 2 }), event(2, { type: "" }), event(2, { at: "123" }), null]) {
    assert.throws(() => parseJournal([line(1), JSON.stringify(invalid)]), /invalid journal line 2/);
  }
});

test("sequences start at one and strictly increase without requiring contiguous numbers", () => {
  assert.deepEqual(parseJournal([line(1), line(3)]), [event(1), event(3)]);
  for (const lines of [[line(2)], [line(1), line(1)], [line(1), line(3), line(2)]]) {
    assert.throws(() => parseJournal(lines), /seq/);
  }
});

test("opening an invalid complete journal is rejected without mutating its bytes", (t) => {
  for (const content of [`${line(1)}\n${line(2, { v: 2 })}`, `${line(1)}\nbroken\n`]) {
    const file = fixture(t, content);
    assert.throws(() => open(t, file), /invalid journal line 2/);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.throws(() => open(t, file), /invalid journal line 2/); // failed open releases its own lock
  }
});

test("append rejects invalid or repeated sequences before writing", (t) => {
  const file = fixture(t);
  const journal = open(t, file);
  assert.throws(() => journal.append(event(2)), /seq/);
  journal.append(event(1));
  assert.throws(() => journal.append(event(1)), /seq/);
  assert.throws(() => journal.append(event(2, { v: 2 })), /version/);
  assert.deepEqual(parseJournal(journal.readAll()), [event(1)]);
});

test("same-process and cross-process writers cannot hold the same journal", (t) => {
  const file = fixture(t);
  const journal = open(t, file);
  assert.throws(() => open(t, file), /locked|writer/i);
  const script = `import { FileJournal } from ${JSON.stringify(new URL("../src/journal.js", import.meta.url).href)};
    try { const journal = new FileJournal(process.argv[1]); journal.close(); process.exit(2); }
    catch (error) { if (!/locked|writer/i.test(error.message)) throw error; }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, file], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  journal.close();
  open(t, file).append(event(1));
});

test("pre-existing lock is never guessed stale or removed", (t) => {
  const file = fixture(t);
  fs.writeFileSync(`${file}.lock`, "do not remove");
  assert.throws(() => open(t, file), /locked|writer/i);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "do not remove");
});

test("async open injects the lock before recovery and retains the lock inode on close", async (t) => {
  const file = fixture(t, `${line(1)}\n{"v":`);
  let lockFd;
  const lockExclusive = async (fd) => {
    lockFd = fd;
    assert.equal(fs.readFileSync(file, "utf8"), `${line(1)}\n{"v":`);
  };
  const journal = await FileJournal.open(file, { fsync: false, lockExclusive });
  t.after(() => journal.close());
  journal.append(event(2));
  const inode = fs.statSync(`${file}.lock`).ino;
  assert.throws(() => new FileJournal(file), /locked|writer/i);
  journal.close();
  assert.throws(() => fs.fstatSync(lockFd), /EBADF/);
  assert.equal(fs.statSync(`${file}.lock`).ino, inode);
  const reopened = await FileJournal.open(file, { lockExclusive: async () => {} });
  t.after(() => reopened.close());
  assert.deepEqual(parseJournal(reopened.readAll()), [event(1), event(2)]);
  assert.equal(fs.statSync(`${file}.lock`).ino, inode);
});

test("native open refuses conservative and unknown locks without modifying them", async (t) => {
  const file = fixture(t);
  const conservative = open(t, file);
  await assert.rejects(() => FileJournal.open(file, { lockExclusive: async () => {} }), /protocol|unknown|conservative/i);
  conservative.close();
  fs.writeFileSync(`${file}.lock`, "unknown lock");
  await assert.rejects(() => FileJournal.open(file, { lockExclusive: async () => {
    assert.fail("must not invoke acquisition");
  } }), /protocol|unknown|conservative/i);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "unknown lock");
});

test("native lock and recovery failures close the descriptor but never unlink it", async (t) => {
  const file = fixture(t);
  let fd;
  await assert.rejects(() => FileJournal.open(file, { lockExclusive: async (value) => {
    fd = value;
    throw new Error("kernel lock busy");
  } }), /kernel lock busy/);
  assert.throws(() => fs.fstatSync(fd), /EBADF/);
  assert.ok(fs.existsSync(`${file}.lock`));
  // A failed initial kernel acquisition cannot initialize a trusted marker.
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "");
  const other = fixture(t, line(1, { v: 2 }));
  await assert.rejects(() => FileJournal.open(other, { lockExclusive: async (value) => { fd = value; } }), /version/);
  assert.throws(() => fs.fstatSync(fd), /EBADF/);
  assert.ok(fs.existsSync(`${other}.lock`));
});

test("async open without injection retains the conservative fallback", async (t) => {
  const file = fixture(t);
  const journal = await FileJournal.open(file, { fsync: false });
  t.after(() => journal.close());
  assert.throws(() => new FileJournal(file), /locked|writer/i);
  journal.close();
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("symlink aliases share the writer lock", (t) => {
  const file = fixture(t);
  const alias = path.join(path.dirname(file), "alias.jsonl");
  fs.symlinkSync(file, alias);
  open(t, file);
  assert.throws(() => open(t, alias), /locked|writer/i);
});
