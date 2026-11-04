import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const MAX_DAYS = 60;
const BV = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
const LIMITS = { title: 512, author: 256, tier: 32, reason: 4096, opinion: 2048 };
const LABELS = { 标题: "title", UP: "author", 档位: "tier", 为什么值得: "reason", 一句话: "opinion", 你自己的一句话: "opinion" };

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function unsafe(message) {
  return Object.assign(new Error(message), { code: "UNSAFE_PATH" });
}

// Check every component, including sourceDir and out; realpath alone would hide symlinks.
async function checkedDirectory(directory) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe("Report directory must not contain symlinks or non-directories");
  }
  return lstat(directory);
}

function parseReport(text, date, file, sha256) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let item;
  function finish() {
    if (item) items.push(item);
    item = undefined;
  }
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const heading = /^### (BV1[1-9A-HJ-NP-Za-km-z]{9})\s*$/.exec(raw);
    if (heading) {
      finish();
      const bvid = heading[1];
      item = {
        bvid, date, title: "", author: "", url: `https://www.bilibili.com/video/${bvid}`,
        tier: "", reason: "", opinion: "",
        source: { file, date, sha256, lineStart: index + 1, lineEnd: index + 1 },
        trust: "untrusted_discovery_report", coverage: "report_only",
      };
      continue;
    }
    if (!item) continue;
    // Only explicitly labelled report fields are evidence; delivery/summary prose is not.
    const line = raw.replace(/\*\*/g, "").trim();
    if (/^#{1,6}\s|^(?:总结|小结|本轮总结|投递|已私信|补一句|因无字幕|还没发过评论)\s*[:：（(]/.test(line)) {
      finish();
      continue;
    }
    const fields = line.split(/\s+\/\s+(?=(?:标题|UP|链接|播放量|档位|为什么值得|一句话|你自己的一句话)\s*[:：])/);
    for (const field of fields) {
      const match = /^(标题|UP|档位|为什么值得|一句话|你自己的一句话)\s*[:：]\s*(.*)$/.exec(field);
      if (!match) continue;
      const key = LABELS[match[1]];
      item[key] = match[2].trim().slice(0, LIMITS[key]);
      item.source.lineEnd = index + 1;
    }
  }
  finish();
  return items;
}

/** Read only fixed sourceDir/out/YYYY-MM-DD.md reports. No transcript or viewing evidence. */
export function createReportSource({ sourceDir, maxBytes = MAX_BYTES, maxDays = MAX_DAYS } = {}) {
  if (typeof sourceDir !== "string" || !sourceDir.trim() || sourceDir.includes("\0")) {
    throw new TypeError("sourceDir must be a non-empty directory path");
  }
  boundedInteger(maxBytes, "maxBytes", 1, MAX_BYTES);
  boundedInteger(maxDays, "maxDays", 1, MAX_DAYS);
  const out = path.join(path.resolve(sourceDir), "out");

  async function scan(dateFilter) {
    const warnings = [];
    const warn = (file, error) => warnings.push({ file, code: error.code || "READ_ERROR", message: error.message });
    let directory;
    let dates;
    try {
      directory = await checkedDirectory(out);
      dates = (await readdir(out)).filter(name => name.endsWith(".md") && validDate(name.slice(0, -3)))
        .sort().reverse().slice(0, maxDays);
    } catch (error) {
      if (error.code !== "ENOENT") warn("out", error);
      return { items: [], warnings };
    }
    const byBV = new Map();
    for (const name of dates) {
      const date = name.slice(0, -3);
      if (dateFilter && date !== dateFilter) continue;
      const file = `out/${name}`;
      const target = path.join(out, name);
      let handle;
      try {
        const parent = await checkedDirectory(out);
        if (parent.dev !== directory.dev || parent.ino !== directory.ino) throw unsafe("Report directory changed during scan");
        const before = await lstat(target);
        if (before.isSymbolicLink() || !before.isFile()) throw unsafe("Report must be a regular non-symlink file");
        if (before.size > maxBytes) throw Object.assign(new Error("Report exceeds maxBytes"), { code: "REPORT_TOO_LARGE" });
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw unsafe("Report changed during open");
        // A bounded read also protects against a file growing after the size check.
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > maxBytes) throw Object.assign(new Error("Report exceeds maxBytes"), { code: "REPORT_TOO_LARGE" });
        const after = await checkedDirectory(out);
        if (after.dev !== directory.dev || after.ino !== directory.ino) throw unsafe("Report directory changed during read");
        const bytes = buffer.subarray(0, size);
        const hash = createHash("sha256").update(bytes).digest("hex");
        // Last section wins within a date; newest date wins across files.
        const local = new Map();
        for (const item of parseReport(bytes.toString("utf8"), date, file, hash)) local.set(item.bvid, item);
        for (const [bvid, item] of local) if (!byBV.has(bvid)) byBV.set(bvid, item);
      } catch (error) {
        warn(file, error);
      } finally {
        await handle?.close();
      }
    }
    return { items: [...byBV.values()], warnings };
  }

  return {
    async list({ limit = 10, offset = 0 } = {}) {
      boundedInteger(limit, "limit", 1, 100);
      boundedInteger(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
      const { items, warnings } = await scan();
      const end = Math.min(offset + limit, items.length);
      return { items: items.slice(offset, end), total: items.length, nextOffset: end < items.length ? end : null, warnings };
    },
    async get({ bvid, date } = {}) {
      if (typeof bvid !== "string" || !BV.test(bvid)) throw new TypeError("bvid must be a strict BV identifier");
      if (date !== undefined && !validDate(date)) throw new TypeError("date must be a valid YYYY-MM-DD date");
      const { items } = await scan(date);
      return items.find(item => item.bvid === bvid) || null;
    },
  };
}
