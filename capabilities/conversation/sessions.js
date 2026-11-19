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
 * crash can only leave an incomplete trailing line, which is ignored and cut.
 * A line with `delivery` (and no messages) is what the channel reported about the delivery of the run right before
 * it: `load` hands it out as `delivery` on that run's last assistant message, and `last` says which run is the
 * latest and whether it has one. A release that does not know such lines reads them as runs without messages. */
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
    catch (error) { if (error.code === 'ENOENT') return { messages: [], validBytes: 0, last: null }; throw fail('SESSION_UNAVAILABLE'); }
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
      // The latest run, and whether a delivery record for it is stored.
      let last = null;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let run;
        try { run = JSON.parse(line); } catch { throw fail('SESSION_CORRUPT'); }
        if (run?.v !== 1 || !Array.isArray(run.messages)) throw fail('SESSION_CORRUPT');
        if (run.delivery !== undefined) {
          // A delivery line belongs to the run right before it; anywhere else it is ignored.
          if (last && !last.delivered && last.reply && run.requestId === last.requestId) { last.reply.delivery = run.delivery; last.delivered = true; }
          continue;
        }
        messages.push(...run.messages);
        if (run.messages.length) last = { requestId: run.requestId, reply: run.messages.findLast(message => message?.role === 'assistant'), delivered: false };
      }
      return { messages, validBytes, last: last && { requestId: last.requestId, delivered: last.delivered } };
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

/** Offline forgetting (deploy/authority/purge-execution.mjs, with this executor stopped and the world paused): every
 * earlier memory epoch of an affected stream is a retired session, and its file goes. A scoped forget carries each
 * stream's own new epoch; older plans use the job's. `storage` is the deployment's operator/execution-storage.json,
 * `inside(root, file)` the caller's guard (absolute, under root, no symlink). `dryRun` only validates and counts; a
 * file already gone is not counted, so running the same plan again is harmless. -> { sessionsRemoved } */
export function forget(plan, { base, storage, inside, dryRun = false }) {
  if (storage?.sessionsRoot !== 'conversation-data/sessions') throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const root = inside(base, path.join(base, storage.sessionsRoot));
  if (!fs.statSync(root).isDirectory()) throw fail('EXECUTION_STORAGE_UNVERIFIED');
  const files = [];
  for (const entry of plan.affectedStreams) {
    if (typeof entry?.capabilityId !== 'string' || typeof entry.streamId !== 'string') throw fail('EXECUTION_PLAN_INVALID');
    const current = entry.memoryEpoch ?? plan.memoryEpoch;
    if (!Number.isSafeInteger(current) || current < 1 || current > plan.memoryEpoch) throw fail('EXECUTION_PLAN_INVALID');
    for (let epoch = 0; epoch < current; epoch++) {
      const file = inside(root, path.join(root, conversationSessionId(entry.streamId, epoch) + '.jsonl'));
      if (!fs.existsSync(file)) continue;
      if (!fs.lstatSync(file).isFile()) throw fail('EXECUTION_UNKNOWN_ARTIFACT');
      files.push(file);
    }
  }
  // Every target was checked above; recheck immediately before mutation.
  if (!dryRun) for (const file of files) { inside(root, file); fs.unlinkSync(file); }
  return { sessionsRemoved: files.length };
}
