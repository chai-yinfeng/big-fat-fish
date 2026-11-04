import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createDecisions(file) {
  let records = {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid decision state");
    records = value;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return {
    has: (bvid) => Object.hasOwn(records, bvid),
    record({ candidate, action, reason = "" }) {
      if (!["skip", "share"].includes(action)) throw new Error("action must be skip or share");
      if (typeof reason !== "string" || reason.length > 400) throw new Error("reason exceeds 400 characters");
      if (Object.hasOwn(records, candidate.bvid)) return { ...records[candidate.bvid], duplicate: true };
      const receipt = {
        bvid: candidate.bvid, action, reason, at: Date.now(),
        source: candidate.source,
        // A decision tool never claims a QQ delivery receipt.
        delivery: action === "share" ? "intent_only" : "not_applicable",
      };
      const next = { ...records, [candidate.bvid]: receipt };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, file);
      records = next;
      return receipt;
    },
  };
}
