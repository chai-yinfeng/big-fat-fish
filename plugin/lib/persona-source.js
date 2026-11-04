/** One authored persona document; the core journal records only applied revisions. */
import fs from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizePersonaDocument } from "../../core/src/persona.js";

function publishInitialDocument(file, document) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Exclusive publication cannot overwrite an identity concurrently authored
    // by the owner. Both names are on the same local filesystem.
    fs.linkSync(temporary, file);
    const directory = fs.openSync(dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function loadPersonaSource({ file, core, legacyPersona, reason = "explicit persona source load" }) {
  const state = core.snapshot();
  let migrated = false;
  let document;
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!info) {
    if (state.personaMeta.revision > 0) throw new Error("authoritative persona source is missing; restore it instead of creating a default identity");
    document = normalizePersonaDocument({
      schemaVersion: 1, revision: 1,
      persona: { ...state.persona, ...(legacyPersona ?? {}) },
    });
    publishInitialDocument(file, document);
    migrated = true;
  } else {
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000) throw new Error("persona source must be a bounded regular file, not a symlink");
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("invalid persona source JSON; current identity was not replaced"); }
    document = normalizePersonaDocument(parsed);
  }
  core.applyPersonaDocument(document, {
    source: "persona.json",
    reason: migrated ? "one-time migration from legacy journal and config.persona" : reason,
  });
  const meta = core.snapshot().personaMeta;
  return {
    file, revision: meta.revision, hash: meta.hash, source: meta.source,
    migrated, legacyConfigIgnored: !migrated && legacyPersona !== undefined,
  };
}
