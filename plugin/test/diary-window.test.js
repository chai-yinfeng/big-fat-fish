import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOuterDigestPrompt,
  createDiaryWindow,
  entriesToTurns,
  parseOuterDigest,
} from "../lib/diary-window.js";

test("diary window accumulates turns and activities until idle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-window-"));
  try {
    const window = createDiaryWindow({ file: path.join(dir, "window.jsonl") });
    window.appendTurn({ at: 1000, userText: "今天有点累", assistantText: "先休息一下" });
    window.appendActivity({ at: 2000, kind: "video", summary: "一起看了一个很治愈的短片", source: "test" });
    const entries = window.read();
    assert.equal(entries.length, 2);
    assert.equal(window.turnCount(), 1);
    assert.equal(window.status().activities, 1);
    assert.equal(entriesToTurns(entries).length, 1);
    assert.match(buildOuterDigestPrompt({ state: { persona: { name: "大肥鱼" } }, entries, maxChars: 300 }).user, /治愈的短片/);
    assert.equal(parseOuterDigest("外记：今天聊了很久。", 300), "今天聊了很久。");
    window.appendTurn({ at: 3000, userText: "模型写日记期间来了新消息", assistantText: "这是下一个窗口" });
    window.consume(entries);
    assert.equal(window.read().length, 1);
    assert.match(window.read()[0].userText, /新消息/);
    window.clear();
    assert.equal(window.read().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
