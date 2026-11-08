import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const MAX_LOAD_BYTES = 16 * 1024 * 1024;

/** Derived by the executor from trusted scope; callers never choose a session ID. */
export function conversationSessionId(streamId, memoryEpoch) {
  if (typeof streamId !== 'string' || !streamId || streamId.length > 256 || !Number.isSafeInteger(memoryEpoch) || memoryEpoch < 0) throw fail('INVALID_SCOPE');
  return 'conv-' + createHash('sha256').update(`${streamId}\0${memoryEpoch}`).digest('hex').slice(0, 32);
}

/** One private JSONL file per session. Each line is one completed run, so a
 * crash can only leave an incomplete trailing line, which is ignored and cut. */
export class SessionStore {
  #dir;
  constructor(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail('SESSION_STORE_CONFIG');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.mode & 0o077 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('SESSION_STORE_UNSAFE');
    this.#dir = dir;
  }
  file(sessionId) {
    if (!/^conv-[a-f0-9]{32}$/.test(sessionId)) throw fail('INVALID_SESSION');
    return path.join(this.#dir, sessionId + '.jsonl');
  }
  /** Returns the persisted transcript and the byte length of complete lines. */
  load(sessionId) {
    const file = this.file(sessionId);
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return { messages: [], validBytes: 0 }; throw fail('SESSION_UNAVAILABLE'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw fail('SESSION_UNAVAILABLE');
      const start = Math.max(0, stat.size - MAX_LOAD_BYTES), buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      const end = text.lastIndexOf('\n') + 1;
      const validBytes = start + Buffer.byteLength(text.slice(0, end));
      text = text.slice(0, end);
      // A bounded tail read starts mid-line: drop the fragment before the first newline.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const messages = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        let run;
        try { run = JSON.parse(line); } catch { throw fail('SESSION_CORRUPT'); }
        if (run?.v !== 1 || !Array.isArray(run.messages)) throw fail('SESSION_CORRUPT');
        messages.push(...run.messages);
      }
      return { messages, validBytes };
    } finally { fs.closeSync(fd); }
  }
  append(sessionId, validBytes, run) {
    const file = this.file(sessionId);
    const line = Buffer.from(JSON.stringify({ v: 1, ...run }) + '\n');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw fail('SESSION_UNAVAILABLE');
      if (stat.size > validBytes) fs.ftruncateSync(fd, validBytes);
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}
