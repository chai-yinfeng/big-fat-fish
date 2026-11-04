import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from './artifacts.js';

test('media references enforce scope, expire bytes and erase source descendants without touching unrelated assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-media-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^fish-media-/); fs.rmSync(root, { recursive: true }); });
  let now = 0; const store = new ArtifactStore({ root, clock: () => now, ttlMs: 60000 });
  const scope = { entityId: 'entity:a', streamId: 'private:a', personId: 'person:owner', audience: 'private' };
  const original = store.put({ scope, sourceEventId: 'event:one', kind: 'audio', mime: 'audio/wav', data: Buffer.from('synthetic audio') });
  const transcript = store.put({ scope, sourceEventId: 'event:one', kind: 'transcript', mime: 'text/plain', data: Buffer.from('synthetic transcript'), parents: [original.id] });
  const unrelated = store.put({ scope, sourceEventId: 'event:two', kind: 'image', mime: 'image/png', data: Buffer.from('synthetic image') });
  assert.equal(original.file, undefined); assert.equal(original.sha256, undefined);
  assert.equal(store.read(transcript.id, scope).data.toString(), 'synthetic transcript');
  assert.throws(() => store.read(original.id, { ...scope, entityId: 'entity:b' }), { code: 'MEDIA_FORBIDDEN' });
  assert.throws(() => store.read(original.id, { ...scope, streamId: 'group:a' }), { code: 'MEDIA_FORBIDDEN' });
  assert.deepEqual(store.forget({ entityId: 'entity:a', sourceEvents: [{ streamId: scope.streamId, eventId: 'event:one' }] }), { mediaPurged: true, removed: 2 });
  assert.equal(store.read(unrelated.id, scope).data.toString(), 'synthetic image');
  assert.throws(() => store.read(transcript.id, scope), { code: 'MEDIA_UNAVAILABLE' });
  now = 60000; assert.throws(() => store.read(unrelated.id, scope), { code: 'MEDIA_UNAVAILABLE' });
  assert.equal(store.expire().removed, 1); assert.equal(fs.existsSync(path.join(store.directory(unrelated.id), 'content')), false);
});
