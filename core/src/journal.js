/** Append-only JSONL journal plus in-memory and file backends. */

import fs from "node:fs";
import path from "node:path";

export class MemoryJournal {
  constructor(lines = []) {
    this.lines = [...lines];
  }

  append(event) {
    this.lines.push(JSON.stringify(event));
  }

  readAll() {
    return [...this.lines];
  }

  close() {}
}

const NATIVE_LOCK_MARKER = "companion-journal/flock-v1\n";

export class FileJournal {
  constructor(filePath, { fsync = true } = {}) {
    initializeJournal(this, filePath, fsync);
    try {
      this.lockFd = fs.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("journal locked by another writer; after a crash, confirm no writer remains before manually recovering the lock");
      }
      throw error;
    }
    try {
      recoverJournal(this);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /**
   * Inject a nonblocking exclusive kernel lock: await lockExclusive(fd), held
   * until fd closes (including process death). No injection uses the conservative
   * constructor. Native lock files persist: never unlink or replace their inode.
   */
  static async open(filePath, { fsync = true, lockExclusive } = {}) {
    if (lockExclusive === undefined) return new FileJournal(filePath, { fsync });
    if (typeof lockExclusive !== "function") throw new TypeError("lockExclusive must be a function");
    const journal = Object.create(FileJournal.prototype);
    initializeJournal(journal, filePath, fsync);
    journal.nativeLock = true;
    let created = false;
    try {
      try {
        journal.lockFd = fs.openSync(journal.lockPath, "wx+", 0o600);
        created = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Refuse symlink locks: all participants must lock the same stable inode.
        journal.lockFd = fs.openSync(journal.lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        // Reject uninitialized/foreign files before taking their kernel lock:
        // a second opener must not beat a new file's creator to flock(). The
        // native marker is immutable; no cooperating writer ever replaces it.
        if (fs.fstatSync(journal.lockFd).size !== Buffer.byteLength(NATIVE_LOCK_MARKER)
          || fs.readFileSync(journal.lockFd, "utf8") !== NATIVE_LOCK_MARKER) {
          throw new Error("unknown or conservative journal lock protocol; refusing automatic recovery");
        }
      }
      await lockExclusive(journal.lockFd);
      if (created) {
        writeAll(journal.lockFd, Buffer.from(NATIVE_LOCK_MARKER));
        // Protocol metadata must be durable even if event fsync was disabled.
        fs.fsyncSync(journal.lockFd);
      }
      const owned = fs.fstatSync(journal.lockFd);
      const current = fs.lstatSync(journal.lockPath);
      if (owned.dev !== current.dev || owned.ino !== current.ino) {
        throw new Error("journal lock inode changed while acquiring writer lock");
      }
      recoverJournal(journal);
      return journal;
    } catch (error) {
      journal.close();
      throw error;
    }
  }

  append(event) {
    if (this.fd === null) throw new Error("journal is closed");
    if (this.failed) throw new Error("journal write failed; close and reopen before appending");
    // Validate the serialized representation too (e.g. toJSON can change it).
    const serialized = JSON.stringify(event);
    const record = validateEvent(JSON.parse(serialized));
    validateSequence(record.seq, this.lastSeq);
    try {
      writeAll(this.fd, Buffer.from(`${serialized}\n`, "utf8"));
      if (this.fsync) fs.fsyncSync(this.fd);
      this.lastSeq = record.seq;
    } catch (error) {
      // A partial write must be recovered on reopen, never followed by a new event.
      this.failed = true;
      throw error;
    }
  }

  readAll() {
    if (this.fd === null) throw new Error("journal is closed");
    const bytes = Buffer.alloc(fs.fstatSync(this.fd).size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(this.fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("journal changed while reading");
      offset += count;
    }
    return bytes.toString("utf8").split("\n");
  }

  close() {
    try {
      if (this.fd !== null) {
        const fd = this.fd;
        this.fd = null;
        fs.closeSync(fd);
      }
    } finally {
      if (this.lockFd !== null) {
        const fd = this.lockFd;
        this.lockFd = null;
        // Only release the lock we created, never an externally replaced lock.
        try {
          const own = fs.fstatSync(fd);
          const current = fs.lstatSync(this.lockPath);
          if (!this.nativeLock && own.dev === current.dev && own.ino === current.ino) fs.unlinkSync(this.lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }
}

function initializeJournal(journal, filePath, fsync) {
  journal.filePath = filePath;
  journal.fsync = fsync;
  journal.fd = null;
  journal.lockFd = null;
  journal.failed = false;
  journal.nativeLock = false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Symlink aliases share a lock. Hard-link aliases and non-cooperating writers
  // are not covered; the host must use a stable local path and never remove locks.
  journal.canonicalPath = fs.existsSync(filePath)
    ? fs.realpathSync(filePath)
    : path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  journal.lockPath = `${journal.canonicalPath}.lock`;
}

function recoverJournal(journal) {
  journal.fd = fs.openSync(journal.canonicalPath, "a+");
  const bytes = fs.readFileSync(journal.fd);
  const { events, tornIndex } = inspectJournal(bytes.toString("utf8").split("\n"));
  journal.lastSeq = events.at(-1)?.seq ?? 0;
  if (tornIndex !== null) {
    // Byte offsets preserve complete UTF-8 even if the torn tail splits a glyph.
    fs.ftruncateSync(journal.fd, bytes.lastIndexOf(0x0a) + 1);
    if (journal.fsync) fs.fsyncSync(journal.fd);
  } else if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
    writeAll(journal.fd, Buffer.from("\n"));
    if (journal.fsync) fs.fsyncSync(journal.fd);
  }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written === 0) throw new Error("journal write made no progress");
    offset += written;
  }
}

function validateEvent(event) {
  if (!event || typeof event !== "object") throw new Error("event must be an object");
  if (event.v !== 1) throw new Error(`unsupported journal version: ${event.v}`);
  if (typeof event.type !== "string" || event.type.length === 0) {
    throw new Error("event.type must be a non-empty string");
  }
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new Error("event.seq must be a positive integer");
  }
  if (!Number.isFinite(event.at)) throw new Error("event.at must be a number");
  return event;
}

function validateSequence(seq, previous) {
  if ((previous === 0 && seq !== 1) || seq <= previous) {
    throw new Error("event.seq must start at 1 and strictly increase");
  }
}

// Node's JSON parser identifies EOF separately from invalid interior syntax.
// Checking the reported position also handles truncated escapes/numbers/keys.
function isIncompleteJSON(line, error) {
  if (!(error instanceof SyntaxError)) return false;
  if (/Unexpected end of JSON input|Unterminated string in JSON/.test(error.message)) return true;
  const position = /at position (\d+)/.exec(error.message);
  return position !== null && Number(position[1]) === line.length;
}

function inspectJournal(lines) {
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      // The empty sentinel produced by split("\n") means the last record WAS
      // newline-terminated; such a record is corruption, not a recoverable tail.
      if (index === lines.length - 1 && isIncompleteJSON(line, error)) {
        return { events, tornIndex: index };
      }
      throw new Error(`invalid journal line ${index + 1}: ${error.message}`);
    }
    try {
      validateEvent(event);
      validateSequence(event.seq, events.at(-1)?.seq ?? 0);
      events.push(event);
    } catch (error) {
      throw new Error(`invalid journal line ${index + 1}: ${error.message}`);
    }
  }
  return { events, tornIndex: null };
}

/**
 * Parse JSONL lines, retaining complete records even without a trailing newline.
 * Only an incomplete, unterminated final JSON record may be discarded. Preserve
 * split("\n")'s trailing empty element so terminated corruption is rejected.
 */
export function parseJournal(lines) {
  return inspectJournal(lines).events;
}
