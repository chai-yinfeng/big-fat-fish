import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getSystemErrorName } from "node:util";
import { spawnSync } from "node:child_process";
import { FileJournal, parseJournal } from "../src/journal.js";

// Optional integration test: supply an already installed system.node binary.
// Never installs/copies native dependencies or reads an actual user journal.
const bindingPath = process.env.JOURNAL_TEST_FLOCK_BINDING;
test("real kernel lock excludes processes and recovers a SIGKILL torn append", { skip: !bindingPath }, async (t) => {
  const binding = createRequire(import.meta.url)(bindingPath);
  const lockExclusive = async (fd) => {
    const errno = await new Promise((resolve) => binding.tryLock(fd, resolve));
    if (errno !== 0) throw new Error(`${getSystemErrorName(-errno)}: flock failed`);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "journal.jsonl");
  const event = (seq) => ({ v: 1, seq, at: 123, type: "test/event", data: {} });
  const journal = await FileJournal.open(file, { lockExclusive });
  t.after(() => journal.close());
  journal.append(event(1));
  const inode = fs.statSync(`${file}.lock`).ino;
  await assert.rejects(() => FileJournal.open(file, { lockExclusive }), /EAGAIN|EWOULDBLOCK/);
  const prelude = `import fs from "node:fs";
    import { createRequire } from "node:module";
    import { getSystemErrorName } from "node:util";
    import { FileJournal } from ${JSON.stringify(new URL("../src/journal.js", import.meta.url).href)};
    const binding = createRequire(import.meta.url)(process.env.JOURNAL_TEST_FLOCK_BINDING);
    const lockExclusive = async fd => {
      const errno = await new Promise(resolve => binding.tryLock(fd, resolve));
      if (errno !== 0) throw new Error(getSystemErrorName(-errno));
    };
    const file = process.argv[1];`;
  const run = (body) => spawnSync(process.execPath, ["--input-type=module", "-e", prelude + body, file], { encoding: "utf8" });
  const contender = run(`try { const j = await FileJournal.open(file, { lockExclusive }); j.close(); process.exit(2); }
    catch (error) { if (!/EAGAIN|EWOULDBLOCK/.test(error.message)) throw error; }`);
  assert.equal(contender.status, 0, contender.stderr);
  const fallback = run(`try { const j = new FileJournal(file); j.close(); process.exit(2); }
    catch (error) { if (!/locked|writer/.test(error.message)) throw error; }`);
  assert.equal(fallback.status, 0, fallback.stderr);
  journal.close();
  const crashed = run(`const j = await FileJournal.open(file, { lockExclusive });
    j.append(${JSON.stringify(event(2))});
    fs.writeSync(j.fd, '{"v":1,"seq":');
    process.kill(process.pid, "SIGKILL");`);
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(fs.statSync(`${file}.lock`).ino, inode);
  const recovered = await FileJournal.open(file, { lockExclusive });
  t.after(() => recovered.close());
  assert.deepEqual(parseJournal(recovered.readAll()), [event(1), event(2)]);
  recovered.append(event(3));
  recovered.close();
  const reopened = await FileJournal.open(file, { lockExclusive });
  t.after(() => reopened.close());
  assert.deepEqual(parseJournal(reopened.readAll()), [event(1), event(2), event(3)]);
  assert.equal(fs.statSync(`${file}.lock`).ino, inode);
});
