import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { purgeExecution } from './purge-execution.mjs';
import { ArtifactStore } from '../../capabilities/media/artifacts.js';

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-purge-'))), base = path.join(temp, 'companion-world-v1');
  for (const dir of ['operator', 'authority-data', 'dsh-home/sessions/project', 'dsh-home/cache', 'dsh-home/storages/session_projcache/sessions', 'qq-inbox', 'qq-data']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  fs.writeFileSync(path.join(base, 'operator/authority.json'), '{}');
  fs.writeFileSync(path.join(base, 'authority-data/keep.json'), '{"remember":"not selected"}');
  fs.writeFileSync(path.join(base, 'operator/execution-storage.json'), JSON.stringify({ version: 1, sessionsRoot: 'dsh-home/sessions', derivedPaths: [{ path: 'dsh-home/cache/search.sqlite', kind: 'sqlite' }, { path: 'dsh-home/storages/session_projcache', kind: 'projection-cache-domain' }] }));
  fs.writeFileSync(path.join(base, 'dsh-home/storages/session_projcache/sessions/target.json.bak.fixture'), '{}');
  fs.writeFileSync(path.join(base, 'dsh-home/cache/search.sqlite'), 'SQLite format 3\0fixture derived index');
  fs.writeFileSync(path.join(base, 'dsh-home/conversation-delivery.json'), JSON.stringify({ version: 1, streams: { target: { cursor: 4 }, keep: { cursor: 8 } } }));
  fs.writeFileSync(path.join(base, 'dsh-home/conversation-delivery.json.epochs.json'), JSON.stringify({ target: { entityId: 'e', memoryEpoch: 0 }, keep: { entityId: 'other', memoryEpoch: 0 } }));
  const session = (id, parentSession) => {
    const directory = path.join(base, 'dsh-home/sessions/project', id); fs.mkdirSync(directory);
    for (const version of [3, 4]) fs.writeFileSync(path.join(directory, `session.v${version}.jsonl.zstd`), zlib.zstdCompressSync(JSON.stringify({ version, id, cwd: '/home/companion/dsh', agentPreset: 'companion', ...(parentSession ? { parentSession } : {}) }) + '\n' + JSON.stringify({ text: 'fixture controlled raw text' }) + '\n'));
    return directory;
  };
  fs.writeFileSync(path.join(base, 'qq-inbox/inbox.jsonl'), JSON.stringify({ requestId: 'forgotten-message', observation: { streamId: 'qq:100:private:200', text: 'fixture private text' } }) + '\n');
  fs.writeFileSync(path.join(base, 'qq-data/dispatch.json'), JSON.stringify({ records: { 'forgotten-message': { status: 'sent', messageId: 'fixture-receipt' }, keep: { status: 'sent' } } }));
  const target = session('target'), keep = session('keep'), child = session('copied-child', 'target');
  t.after(() => { assert.ok(fs.realpathSync(temp).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-purge-')); fs.rmSync(temp, { recursive: true }); });
  const plan = { id: 'forget-fixture', entityId: 'e', memoryEpoch: 1, affectedStreams: [{ capabilityId: 'dsh-test', streamId: 'target' }, { capabilityId: 'qq', streamId: 'qq:100:private:200' }], sourceObservationIds: [], sourceEvents: [] };
  return { base, target, keep, child, plan };
}

test('operator purge removes only targeted execution generations and descendants, resets derived copies, preserves Authority', async t => {
  const f = fixture(t); let checked = 0;
  const media = new ArtifactStore({ root: path.join(f.base, 'media-data') });
  const scope = { entityId: 'e', streamId: 'qq:100:private:200', personId: 'person:owner', audience: 'private' };
  const original = media.put({ scope, sourceEventId: 'media-source', kind: 'audio', mime: 'audio/wav', data: Buffer.from('private fixture audio') });
  media.put({ scope, sourceEventId: 'media-source', kind: 'transcript', mime: 'text/plain', data: Buffer.from('private fixture transcript'), parents: [original.id] });
  const retained = media.put({ scope, sourceEventId: 'other-source', kind: 'image', mime: 'image/png', data: Buffer.from('unrelated fixture image') });
  fs.mkdirSync(path.join(f.base, 'speech-data/reference'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'speech-data/reference/default.wav'), 'kokoro synthetic voice');
  const scratch = path.join(f.base, 'speech-data/tts-11111111-1111-1111-1111-111111111111.wav'); fs.writeFileSync(scratch, 'unfinished source speech');
  const layoutFile = path.join(f.base, 'operator/execution-storage.json'), layout = JSON.parse(fs.readFileSync(layoutFile));
  layout.media = { root: 'media-data', workRoot: 'speech-data' }; fs.writeFileSync(layoutFile, JSON.stringify(layout));
  f.plan.sourceEvents.push({ streamId: scope.streamId, eventId: 'media-source' });
  const result = await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => { checked++; } });
  assert.equal(result.sdkPurged, true); assert.equal(result.executionSessionsRemoved, 2); assert.ok(checked >= 2);
  assert.equal(result.mediaArtifactsRemoved, 2); assert.equal(fs.existsSync(media.directory(original.id)), false);
  assert.equal(media.read(retained.id, scope).data.toString(), 'unrelated fixture image');
  assert.equal(fs.existsSync(scratch), false); assert.equal(fs.existsSync(path.join(f.base, 'speech-data/reference/default.wav')), true);
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(f.child), false); assert.equal(fs.existsSync(f.keep), true);
  assert.equal(fs.existsSync(path.join(f.base, 'dsh-home/cache/search.sqlite')), false);
  assert.equal(fs.existsSync(path.join(f.base, 'dsh-home/storages/session_projcache')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base, 'dsh-home/conversation-delivery.json'))).streams, { keep: { cursor: 8 } });
  assert.equal(fs.readFileSync(path.join(f.base, 'qq-inbox/inbox.jsonl'), 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base, 'qq-data/dispatch.json'))).records, { 'forgotten-message': { status: 'forgotten' }, keep: { status: 'sent' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.base, 'dsh-home/conversation-delivery.json.epochs.json'))).target.retired, true);
  assert.equal(fs.readFileSync(path.join(f.base, 'authority-data/keep.json'), 'utf8'), '{"remember":"not selected"}');
});

test('non-product root, live writers, unknown layout and symlink targets are refused before erasure', async t => {
  const f = fixture(t), checkStopped = () => {};
  await assert.rejects(purgeExecution({ base: path.dirname(f.base), plan: f.plan, checkStopped }), /ROOT_REFUSED/);
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => { throw new Error('WRITER_RUNNING'); } }), /WRITER_RUNNING/);
  assert.equal(fs.existsSync(f.target), true);
  const descriptor = path.join(f.base, 'operator/execution-storage.json');
  fs.symlinkSync(path.join(f.keep, 'session.v4.jsonl.zstd'), path.join(f.target, 'linked-artifact'));
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped }), /SYMLINK_REFUSED/);
  assert.equal(fs.existsSync(f.target), true);
  fs.writeFileSync(descriptor, '{"version":99}');
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped }), /STORAGE_UNVERIFIED/);
  assert.equal(fs.existsSync(f.target), true);
});
