import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReportSource } from "../lib/reports.js";

const A = "BV1Uinz6CENd";
const B = "BV1cbH56KER3";
const C = "BV16jHL6AE5z";
const DAY = "2026-10-27";

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "bili-reports-test-"));
  t.after(() => {
    const target = path.resolve(root);
    if (path.dirname(target) !== base || !path.basename(target).startsWith("bili-reports-test-")) throw new Error("Unsafe cleanup target");
    fs.rmSync(target, { recursive: true, force: true });
  });
  const out = path.join(root, "out");
  fs.mkdirSync(out);
  return { root, out, source: createReportSource({ sourceDir: root }) };
}

function report(bvid = A, title = "测试视频") {
  return `### ${bvid}\n标题：${title} / UP：测试作者 / 链接：https://evil.invalid/private / 播放量：4.4万\n**档位**：值得看\n为什么值得：报告给出的理由。\n一句话：报告作者的看法。\n`;
}

// Mirrors the installed dsh-bili-scroll report format, not a transcript fixture.
const REAL_SHAPE = `# 刷B站日报 2026-10-27

## 2026-10-27 · 手动看一眼（挑了 3 条）

### BV1Uinz6CENd
标题：给你的dsh添加一双灵活且低功耗的手 / UP：堕了个喵 / 链接：https://www.bilibili.com/video/BV1Uinz6CENd / 播放量：4.4万
**档位**：值得看
为什么值得：dsh 的电脑操作芯片，18 个工具；安全上默认关闭，按需授权。
一句话：1 分 17 秒，比大部分教程干脆。

### BV1cbH56KER3
标题：deepseek大肥鱼可以唱歌和说话了，模型公布！ / UP：星落落_oi / 链接：https://www.bilibili.com/video/BV1cbH56KER3 / 播放量：13.8万
**档位**：可以看
为什么值得：后半段把风险摆到明面上。
一句话：当故事听不错，当教程不够细。

### BV16jHL6AE5z
标题：当我让Astra和大肥鱼同时水群 / UP：天边的未知数 / 链接：https://www.bilibili.com/video/BV16jHL6AE5z / 播放量：57.4万
**档位**：可以看
为什么值得：后半段是实际配置步骤。
一句话：前半段是乐子，后半段才是干货。

总结：三条都跟 dsh / 大肥鱼这条线有关。
因无字幕跳过 1 条（BV1kCJk6kEn3）。
已私信（UID private-recipient）。
补一句：私信没发出去。
## 投递
- 投递：只私信
一句话：不得混入上一个候选。
`;

test("real report shape yields bounded report-only candidates and precise provenance", async t => {
  const { out, source } = fixture(t);
  fs.writeFileSync(path.join(out, `${DAY}.md`), REAL_SHAPE);
  const result = await source.list();
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.warnings, []);
  const first = result.items[0];
  assert.deepEqual(first, {
    bvid: A, date: DAY, title: "给你的dsh添加一双灵活且低功耗的手", author: "堕了个喵",
    url: `https://www.bilibili.com/video/${A}`, tier: "值得看",
    reason: "dsh 的电脑操作芯片，18 个工具；安全上默认关闭，按需授权。",
    opinion: "1 分 17 秒，比大部分教程干脆。",
    source: { file: `out/${DAY}.md`, date: DAY, sha256: createHash("sha256").update(REAL_SHAPE).digest("hex"), lineStart: 5, lineEnd: 9 },
    trust: "untrusted_discovery_report", coverage: "report_only",
  });
  assert.equal(result.items[2].opinion, "前半段是乐子，后半段才是干货。");
  assert.doesNotMatch(JSON.stringify(result.items), /private-recipient|不得混入|因无字幕/);
});

test("bold and plain labels, CRLF and arbitrary embedded URLs", async t => {
  const { out, source } = fixture(t);
  const text = `### ${A}\r\n**标题：** 标题 / **UP**：作者 / **链接**：https://evil.invalid/${B}\r\n档位：可以看\r\n**为什么值得**：理由\r\n**你自己的一句话：** 看法\r\n`;
  fs.writeFileSync(path.join(out, `${DAY}.md`), text);
  const item = await source.get({ bvid: A });
  assert.equal(item.title, "标题");
  assert.equal(item.author, "作者");
  assert.equal(item.tier, "可以看");
  assert.equal(item.reason, "理由");
  assert.equal(item.opinion, "看法");
  assert.equal(item.url, `https://www.bilibili.com/video/${A}`);
  assert.equal(await source.get({ bvid: B }), null);
});

test("latest duplicate wins across files and within a file; date-qualified lookup and pagination", async t => {
  const { out, source } = fixture(t);
  fs.writeFileSync(path.join(out, "2026-10-26.md"), report(A, "旧版") + report(B));
  const latest = report(A, "先写") + report(A, "后写") + report(C);
  fs.writeFileSync(path.join(out, `${DAY}.md`), latest);
  const page = await source.list({ limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(page.items.map(item => item.bvid), [A, C]);
  assert.equal(page.items[0].title, "后写");
  assert.equal(page.items[0].source.lineStart, 6);
  assert.equal(page.items[0].source.sha256, createHash("sha256").update(latest).digest("hex"));
  assert.equal((await source.list({ offset: 2 })).items[0].bvid, B);
  assert.equal((await source.get({ bvid: A })).date, DAY);
  assert.equal((await source.get({ bvid: A, date: "2026-10-26" })).title, "旧版");
  assert.equal(await source.get({ bvid: A, date: "2026-10-25" }), null);
  assert.deepEqual((await source.list({ offset: 100 })).items, []);
});

test("missing source/out is graceful and sourceDir stays fixed after construction", async t => {
  const { root, source } = fixture(t);
  const missing = createReportSource({ sourceDir: path.join(root, "missing") });
  assert.deepEqual(await missing.list(), { items: [], total: 0, nextOffset: null, warnings: [] });
  assert.equal(await missing.get({ bvid: A }), null);
  assert.deepEqual((await source.list({ sourceDir: "/etc" })).items, []);
});

test("only strict date files directly in out are read; private files and malformed headings excluded", async t => {
  const { root, out, source } = fixture(t);
  for (const name of ["config.json", "credentials.json", "logs.md", "2026-02-30.md", "2026-1-01.md", "0000-01-01.md", "2026-10-28.md.bak"]) {
    fs.writeFileSync(path.join(out, name), report(B, "private"));
  }
  fs.writeFileSync(path.join(root, `${DAY}.md`), report(B));
  fs.mkdirSync(path.join(out, "nested"));
  fs.writeFileSync(path.join(out, "nested", `${DAY}.md`), report(B));
  fs.writeFileSync(path.join(out, `${DAY}.md`), report(A) + "### BV1bad\n标题：not a candidate\n");
  assert.deepEqual((await source.list()).items.map(item => item.bvid), [A]);
});

test("rejects report symlinks, directories and oversized files with warnings", async t => {
  const { root, out, source } = fixture(t);
  fs.writeFileSync(path.join(root, "private.md"), report(B));
  fs.symlinkSync(path.join(root, "private.md"), path.join(out, "2026-10-28.md"));
  fs.mkdirSync(path.join(out, "2026-10-26.md"));
  fs.writeFileSync(path.join(out, "2026-10-25.md"), "x".repeat(262145));
  fs.writeFileSync(path.join(out, `${DAY}.md`), report(A));
  const result = await source.list();
  assert.deepEqual(result.items.map(item => item.bvid), [A]);
  assert.deepEqual(result.warnings.map(w => w.code), ["UNSAFE_PATH", "UNSAFE_PATH", "REPORT_TOO_LARGE"]);
  assert.equal(await source.get({ bvid: B, date: "2026-10-28" }), null);
});

test("rejects out, sourceDir and ancestor symlinks", async t => {
  const { root } = fixture(t);
  const actual = path.join(root, "actual");
  fs.mkdirSync(actual);
  fs.mkdirSync(path.join(actual, "out"));
  fs.writeFileSync(path.join(actual, "out", `${DAY}.md`), report(A));
  const linked = path.join(root, "linked");
  fs.symlinkSync(actual, linked);
  const source = createReportSource({ sourceDir: linked });
  assert.equal((await source.list()).warnings[0].code, "UNSAFE_PATH");
  const parent = path.join(root, "parent");
  fs.mkdirSync(parent);
  fs.symlinkSync(path.join(actual, "out"), path.join(parent, "out"));
  assert.equal((await createReportSource({ sourceDir: parent }).list()).warnings[0].code, "UNSAFE_PATH");
  fs.mkdirSync(path.join(actual, "child"));
  fs.mkdirSync(path.join(actual, "child", "out"));
  assert.equal((await createReportSource({ sourceDir: path.join(linked, "child") }).list()).warnings[0].code, "UNSAFE_PATH");
});

test("byte and scan budgets are hard caps; field values are bounded", async t => {
  const { root, out } = fixture(t);
  for (let day = 1; day <= 31; day++) {
    fs.writeFileSync(path.join(out, `2026-08-${String(day).padStart(2, "0")}.md`), report(B));
  }
  for (let day = 1; day <= 30; day++) {
    fs.writeFileSync(path.join(out, `2026-09-${String(day).padStart(2, "0")}.md`), report(A));
  }
  // The 61st date must not be read, even through date-qualified get.
  assert.equal(await createReportSource({ sourceDir: root }).get({ bvid: B, date: "2026-08-01" }), null);
  const limited = createReportSource({ sourceDir: root, maxDays: 1 });
  assert.equal((await limited.list()).total, 1);
  const tiny = createReportSource({ sourceDir: root, maxDays: 1, maxBytes: 1 });
  assert.equal((await tiny.list()).warnings[0].code, "REPORT_TOO_LARGE");
  fs.writeFileSync(path.join(out, `${DAY}.md`), report(A, "t".repeat(2000)) + `为什么值得：${"r".repeat(5000)}\n一句话：${"o".repeat(3000)}\n`);
  const item = await limited.get({ bvid: A });
  assert.equal(item.title.length, 512);
  assert.equal(item.reason.length, 4096);
  assert.equal(item.opinion.length, 2048);
});

test("invalid constructor, pagination, date and BV inputs fail closed", async t => {
  const { source } = fixture(t);
  for (const sourceDir of [undefined, "", " ", 123, "bad\0path"]) assert.throws(() => createReportSource({ sourceDir }), TypeError);
  for (const maxBytes of [0, -1, 262145, NaN, "100"]) assert.throws(() => createReportSource({ sourceDir: ".", maxBytes }), RangeError);
  for (const maxDays of [0, 61, 1.5]) assert.throws(() => createReportSource({ sourceDir: ".", maxDays }), RangeError);
  for (const limit of [0, -1, 101, 1.5, "10"]) await assert.rejects(source.list({ limit }), RangeError);
  for (const offset of [-1, 0.5, Infinity, "0"]) await assert.rejects(source.list({ offset }), RangeError);
  for (const bvid of [undefined, A + "/..", "../../private", A.toLowerCase(), "BV1000000000", "BV1bad", ` ${A}`, `${A}\n`]) await assert.rejects(source.get({ bvid }), TypeError);
  for (const date of ["../../private", "2026-02-29", "2026-13-01", "2026-1-01", "0000-01-01", 20261027]) await assert.rejects(source.get({ bvid: A, date }), TypeError);
});
