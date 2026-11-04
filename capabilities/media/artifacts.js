import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const kinds = new Set(['audio', 'image', 'sticker', 'transcript', 'description', 'web']);
const idPattern = /^media:([a-f0-9-]{36})$/;
const sameScope = (a, b) => a.entityId === b.entityId && a.streamId === b.streamId && a.personId === b.personId && a.audience === b.audience;
function scopeOf(value) {
  if (!value || !['entityId', 'streamId', 'personId'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 256) || !['private', 'shared'].includes(value.audience)) throw fail('MEDIA_SCOPE_REQUIRED');
  return { entityId: value.entityId, streamId: value.streamId, personId: value.personId, audience: value.audience };
}

/** Product-owned files, not another personality/memory store. Model-facing values
 * are opaque references; only trusted workers resolve a reference to a filename. */
export class ArtifactStore {
  constructor({ root, clock = Date.now, ttlMs = 7 * 86400000, maxBytes = 8 * 1024 * 1024 }) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(ttlMs) || ttlMs < 60000) throw fail('MEDIA_STORAGE_CONFIG');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw fail('MEDIA_STORAGE_ROOT');
    this.root = fs.realpathSync(root); this.clock = clock; this.ttlMs = ttlMs; this.maxBytes = maxBytes;
  }
  directory(id) {
    const match = idPattern.exec(id);
    if (!match) throw fail('MEDIA_REFERENCE_INVALID');
    const result = path.resolve(this.root, match[1]);
    if (path.dirname(result) !== this.root || fs.existsSync(result) && (fs.lstatSync(result).isSymbolicLink() || fs.realpathSync(result) !== result)) throw fail('MEDIA_STORAGE_ROOT');
    return result;
  }
  metadata(id) {
    const directory = this.directory(id), file = path.join(directory, 'metadata.json');
    if (!fs.existsSync(file)) throw fail('MEDIA_UNAVAILABLE');
    if (fs.lstatSync(file).isSymbolicLink()) throw fail('MEDIA_STORAGE_ROOT');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.id !== id) throw fail('MEDIA_STORAGE_FORMAT');
    return value;
  }
  save(value) {
    const file = path.join(this.directory(value.id), 'metadata.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  info(value) {
    return { id: value.id, kind: value.kind, mime: value.mime, bytes: value.bytes, expiresAt: value.expiresAt,
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
      ...(value.width === undefined ? {} : { width: value.width, height: value.height }),
      derived: value.parents.length > 0 };
  }
  put({ scope, sourceEventId, kind, mime, data, parents = [], durationMs, width, height, ttlMs = this.ttlMs }) {
    const owner = scopeOf(scope);
    if (!kinds.has(kind) || typeof mime !== 'string' || mime.length > 80 || !Buffer.isBuffer(data) || !data.length || data.length > this.maxBytes || !Array.isArray(parents) || parents.length > 8 || typeof sourceEventId !== 'string' || !sourceEventId.length || sourceEventId.length > 256 || !Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > this.ttlMs) throw fail('MEDIA_INPUT_INVALID');
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 600000)) throw fail('MEDIA_INPUT_INVALID');
    if (width !== undefined && (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)) throw fail('MEDIA_INPUT_INVALID');
    let expiresAt = this.clock() + ttlMs;
    for (const id of parents) { const p = this.read(id, owner); expiresAt = Math.min(expiresAt, p.meta.expiresAt); }
    const id = 'media:' + randomUUID(), directory = this.directory(id);
    fs.mkdirSync(directory, { mode: 0o700 });
    const meta = { version: 1, id, ...owner, sourceEventId, kind, mime, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), parents: [...new Set(parents)], createdAt: this.clock(), expiresAt, state: 'pending', ...(durationMs === undefined ? {} : { durationMs }), ...(width === undefined ? {} : { width, height }) };
    // Save lineage before bytes: even an interrupted write remains attributable
    // and can be removed by an explicit source-forgetting operation.
    this.save(meta);
    fs.writeFileSync(path.join(directory, 'content'), data, { flag: 'wx', mode: 0o600 });
    meta.state = 'ready'; this.save(meta);
    return this.info(meta);
  }
  read(id, scope) {
    const meta = this.metadata(id);
    if (!sameScope(meta, scopeOf(scope))) throw fail('MEDIA_FORBIDDEN');
    if (meta.state !== 'ready' || meta.expiresAt <= this.clock()) throw fail('MEDIA_UNAVAILABLE');
    const file = path.join(this.directory(id), 'content');
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > this.maxBytes) throw fail('MEDIA_STORAGE_FORMAT');
    const data = fs.readFileSync(file);
    if (data.length !== meta.bytes || createHash('sha256').update(data).digest('hex') !== meta.sha256) throw fail('MEDIA_STORAGE_FORMAT');
    return { meta, data, file };
  }
  records() {
    return fs.readdirSync(this.root).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => this.metadata('media:' + name));
  }
  expire() {
    let removed = 0;
    for (const meta of this.records()) if (meta.expiresAt <= this.clock() && meta.state !== 'expired') {
      const file = path.join(this.directory(meta.id), 'content');
      if (fs.existsSync(file)) { if (fs.lstatSync(file).isSymbolicLink()) throw fail('MEDIA_STORAGE_ROOT'); fs.unlinkSync(file); }
      meta.state = 'expired'; this.save(meta); removed++;
    }
    return { removed };
  }
  forget({ entityId, sourceEvents, dryRun = false }) {
    if (typeof entityId !== 'string' || !Array.isArray(sourceEvents)) throw fail('MEDIA_FORGET_PLAN');
    const rows = this.records(), selected = new Set();
    for (const m of rows) if (m.entityId === entityId && sourceEvents.some(s => s.streamId === m.streamId && s.eventId === m.sourceEventId)) selected.add(m.id);
    let changed = true;
    while (changed) { changed = false; for (const m of rows) if (m.entityId === entityId && !selected.has(m.id) && m.parents.some(id => selected.has(id))) { selected.add(m.id); changed = true; } }
    const targets = [...selected].map(id => this.directory(id));
    // Validate every target before the first destructive operation.
    for (const target of targets) for (const name of fs.readdirSync(target)) {
      const p = path.join(target, name);
      if (!['metadata.json', 'metadata.json.tmp', 'content'].includes(name) || !fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) throw fail('MEDIA_STORAGE_FORMAT');
    }
    if (dryRun) return { verified: true, selected: targets.length };
    for (const target of targets) { if (path.dirname(target) !== this.root || fs.realpathSync(target) !== target) throw fail('MEDIA_STORAGE_ROOT'); fs.rmSync(target, { recursive: true }); }
    return { mediaPurged: true, removed: targets.length };
  }
}
