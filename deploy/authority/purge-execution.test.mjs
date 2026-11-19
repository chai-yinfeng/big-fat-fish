import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeExecution } from './purge-execution.mjs';
import { ArtifactStore } from '../../capabilities/media/artifacts.js';
import { createStickers } from '../../capabilities/media/stickers.js';
import { conversationSessionId } from '../../capabilities/conversation/sessions.js';
import { qqRequestId } from '../../capabilities/qq/worker-route.js';

const target = 'qq:100:private:200', other = 'qq:100:private:300';
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-purge-'))), base = path.join(temp, 'companion-world-v1');
  for (const dir of ['operator', 'authority-data', 'conversation-data/sessions', 'qq-data']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  fs.writeFileSync(path.join(base, 'operator/authority.json'), '{}');
  fs.writeFileSync(path.join(base, 'authority-data/keep.json'), '{"remember":"not selected"}');
  fs.writeFileSync(path.join(base, 'operator/execution-storage.json'), JSON.stringify({ version: 2, sessionsRoot: 'conversation-data/sessions' }));
  const session = (streamId, epoch) => {
    const file = path.join(base, 'conversation-data/sessions', conversationSessionId(streamId, epoch) + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ v: 1, messages: [{ role: 'user', content: 'fixture controlled raw text' }] }) + '\n', { mode: 0o600 });
    return file;
  };
  const forgotten = qqRequestId({ streamId: target, eventId: 'onebot:v11:message:7' });
  fs.writeFileSync(path.join(base, 'qq-data/dispatch.json'), JSON.stringify({ records: { [forgotten]: { status: 'sent', messageId: 'fixture-receipt' }, keep: { status: 'sent' } } }));
  const sessions = { old: session(target, 0), older: session(target, 1), keep: session(other, 0) };
  t.after(() => { assert.ok(fs.realpathSync(temp).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-purge-')); fs.rmSync(temp, { recursive: true }); });
  const plan = { id: 'forget-fixture', entityId: 'e', memoryEpoch: 2, affectedStreams: [{ capabilityId: 'qq', streamId: target }], sourceObservationIds: [], sourceEvents: [{ capabilityId: 'qq', streamId: target, eventId: 'onebot:v11:message:7' }] };
  return { base, sessions, plan, forgotten };
}

test('operator purge removes retired conversation sessions of affected streams only, tombstones dispatch, preserves Authority', async t => {
  const f = fixture(t); let checked = 0;
  const media = new ArtifactStore({ root: path.join(f.base, 'media-data') });
  const scope = { entityId: 'e', streamId: target, personId: 'person:owner', audience: 'private' };
  const original = media.put({ scope, sourceEventId: 'media-source', kind: 'audio', mime: 'audio/wav', data: Buffer.from('private fixture audio') });
  media.put({ scope, sourceEventId: 'media-source', kind: 'transcript', mime: 'text/plain', data: Buffer.from('private fixture transcript'), parents: [original.id] });
  const retained = media.put({ scope, sourceEventId: 'other-source', kind: 'image', mime: 'image/png', data: Buffer.from('unrelated fixture image') });
  // Two library stickers the owner had her keep: one from the forgotten message, one from another.
  const library = createStickers({ root: media.root }), hash = n => String(n).repeat(64);
  for (const [n, eventId] of [[1, 'media-source'], [2, 'other-source']]) library.keep({ hash: hash(n), data: Buffer.from('fixture sticker ' + n), mime: 'image/png', kind: 'sticker', name: 'MOCK' + n, tags: [], origin: { entityId: 'e', streamId: target, eventId } });
  // Two stickers collected from the forgotten message: one nobody else sent, one that another person sent as well.
  const sticker = n => ({ hash: hash(n), data: Buffer.from('fixture sticker ' + n), mime: 'image/png', kind: 'sticker', name: 'MOCK' + n, tags: [] });
  for (const n of [3, 4]) { library.remember(hash(n), { kind: 'sticker', description: 'MOCK description ' + n }); library.collect({ ...sticker(n), personId: 'person:owner', origin: { entityId: 'e', streamId: target, eventId: 'media-source' } }); }
  library.collect({ ...sticker(4), personId: 'person:qq:9999002', origin: { entityId: 'e', streamId: other, eventId: 'media-source' } });
  fs.mkdirSync(path.join(f.base, 'speech-data/reference'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'speech-data/reference/default.wav'), 'synthetic voice reference');
  const scratch = path.join(f.base, 'speech-data/tts-11111111-1111-1111-1111-111111111111.wav'); fs.writeFileSync(scratch, 'unfinished source speech');
  const layoutFile = path.join(f.base, 'operator/execution-storage.json'), layout = JSON.parse(fs.readFileSync(layoutFile));
  layout.media = { root: 'media-data', workRoot: 'speech-data' }; fs.writeFileSync(layoutFile, JSON.stringify(layout));
  f.plan.sourceEvents.push({ capabilityId: 'qq', streamId: target, eventId: 'media-source' });
  const result = await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => { checked++; } });
  assert.equal(result.sdkPurged, true); assert.equal(result.executionSessionsRemoved, 2); assert.ok(checked >= 2);
  assert.equal(fs.existsSync(f.sessions.old), false); assert.equal(fs.existsSync(f.sessions.older), false); assert.equal(fs.existsSync(f.sessions.keep), true);
  assert.equal(result.mediaArtifactsRemoved, 2); assert.equal(fs.existsSync(media.directory(original.id)), false);
  assert.equal(media.read(retained.id, scope).data.toString(), 'unrelated fixture image');
  assert.deepEqual([result.stickersRemoved, result.stickersDetached], [2, 1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(media.root, 'stickers/index.json'), 'utf8')).entries.map(entry => entry.name), ['MOCK2', 'MOCK4']);
  assert.deepEqual(fs.readdirSync(path.join(media.root, 'stickers')).sort(), [hash(2) + '.png', hash(4) + '.png', 'index.json']);
  // What the cache said of the sticker only the forgotten message carried is gone; the other is one person's now.
  const after = createStickers({ root: media.root });
  assert.deepEqual([after.described(hash(3)), after.described(hash(4)).description, after.list().stickers.map(entry => entry.senders)], [null, 'MOCK description 4', [0, 1]]);
  assert.equal(fs.existsSync(scratch), false); assert.equal(fs.existsSync(path.join(f.base, 'speech-data/reference/default.wav')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base, 'qq-data/dispatch.json'))).records, { [f.forgotten]: { status: 'forgotten' }, keep: { status: 'sent' } });
  assert.equal(fs.readFileSync(path.join(f.base, 'authority-data/keep.json'), 'utf8'), '{"remember":"not selected"}');
});

test('a scoped forget plan retires only each affected stream’s own earlier epochs', async t => {
  const f = fixture(t);
  // The target stream moved to epoch 1 while the job epoch is 2 (another stream's): only epoch 0 retires.
  f.plan.affectedStreams = [{ capabilityId: 'qq', streamId: target, memoryEpoch: 1 }];
  const result = await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => {} });
  assert.equal(result.executionSessionsRemoved, 1);
  assert.equal(fs.existsSync(f.sessions.old), false); assert.equal(fs.existsSync(f.sessions.older), true); assert.equal(fs.existsSync(f.sessions.keep), true);
  for (const memoryEpoch of [0, 3, 'x']) await assert.rejects(purgeExecution({ base: f.base, plan: { ...f.plan, affectedStreams: [{ capabilityId: 'qq', streamId: target, memoryEpoch }] }, checkStopped: () => {} }), /PLAN_INVALID/);
});

test('forgetting cancels and removes background job records: jobs asked for by a forgotten message and jobs of a retired epoch go, the rest stay', async t => {
  const f = fixture(t), mediaRoot = path.join(f.base, 'media-data'), file = path.join(mediaRoot, 'jobs.json');
  new ArtifactStore({ root: mediaRoot });
  const layoutFile = path.join(f.base, 'operator/execution-storage.json'), layout = JSON.parse(fs.readFileSync(layoutFile));
  layout.media = { root: 'media-data', workRoot: 'speech-data' }; fs.writeFileSync(layoutFile, JSON.stringify(layout));
  const job = (id, extra = {}) => ({ id, capability: 'video', status: 'done', scope: { entityId: 'e', streamId: target, personId: 'person:owner', audience: 'private', memoryEpoch: 2 }, source: { requestId: null, sourceEventId: null }, result: { text: 'MOCK note ' + id }, notice: { state: 'pending', at: 1 }, ...extra });
  const write = () => fs.writeFileSync(file, JSON.stringify({ schema: 1, jobs: [
    job('job:asked-by-forgotten', { source: { requestId: null, sourceEventId: 'onebot:v11:message:7' } }),
    job('job:waiting-old-epoch', { status: 'queued', result: null, scope: { entityId: 'e', streamId: target, personId: 'person:owner', audience: 'private', memoryEpoch: 1 } }),
    job('job:current-epoch'), job('job:other-stream', { scope: { entityId: 'e', streamId: other, personId: 'person:qq:300', audience: 'private', memoryEpoch: 0 }, source: { requestId: null, sourceEventId: 'onebot:v11:message:7' } }),
    job('job:other-entity', { scope: { entityId: 'entity:other', streamId: target, personId: 'person:owner', audience: 'private', memoryEpoch: 0 } }),
  ] }) + '\n', { mode: 0o600 });
  write();
  const result = await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => {} });
  assert.equal(result.jobRecordsRemoved, 2);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([kept.schema, kept.jobs.map(entry => entry.id)], [1, ['job:current-epoch', 'job:other-stream', 'job:other-entity']]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('MOCK note job:asked-by-forgotten'));
  // The same plan again finds nothing more; without a job file there is nothing to do.
  assert.equal((await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => {} })).jobRecordsRemoved, 0);
  fs.rmSync(file);
  assert.equal((await purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => {} })).jobRecordsRemoved, 0);
  // Records that cannot be read are not guessed at: the purge stops before it erases anything.
  fs.writeFileSync(file, '{broken'); f.sessions.again = path.join(f.base, 'conversation-data/sessions', conversationSessionId(target, 0) + '.jsonl'); fs.writeFileSync(f.sessions.again, '{}\n');
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => {} }), { code: 'MEDIA_JOB_STATE' });
  assert.equal(fs.existsSync(f.sessions.again), true);
});

test('non-product root, live writers, old layouts and symlink targets are refused before erasure', async t => {
  const f = fixture(t), checkStopped = () => {};
  await assert.rejects(purgeExecution({ base: path.dirname(f.base), plan: f.plan, checkStopped }), /ROOT_REFUSED/);
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped: () => { throw new Error('WRITER_RUNNING'); } }), /WRITER_RUNNING/);
  assert.equal(fs.existsSync(f.sessions.old), true);
  fs.unlinkSync(f.sessions.old); fs.symlinkSync(f.sessions.keep, f.sessions.old);
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped }), /SYMLINK_REFUSED/);
  assert.equal(fs.existsSync(f.sessions.keep), true); assert.equal(fs.existsSync(f.sessions.older), true);
  fs.writeFileSync(path.join(f.base, 'operator/execution-storage.json'), JSON.stringify({ version: 1, sessionsRoot: 'dsh-home/sessions' }));
  await assert.rejects(purgeExecution({ base: f.base, plan: f.plan, checkStopped }), /STORAGE_UNVERIFIED/);
});

test('purge CLI asks the operator API on --operator-port (default 3082) and refuses a bad port', async t => {
  const { spawn } = await import('node:child_process'), http = await import('node:http');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-purge-cli-'))), base = path.join(temp, 'companion-world-v1');
  t.after(() => fs.rmSync(temp, { recursive: true }));
  fs.mkdirSync(path.join(base, 'operator'), { recursive: true });
  fs.writeFileSync(path.join(base, 'operator/console.token'), 'synthetic-operator-token\n');
  const plan = path.join(temp, 'plan.json'); fs.writeFileSync(plan, '{}');
  let seen;
  const server = http.createServer((req, res) => { seen = req.url; res.end(JSON.stringify({ ok: true, value: { world: { paused: false } } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const run = (...extra) => new Promise(resolve => {
    const child = spawn(process.execPath, [new URL('./purge-execution.mjs', import.meta.url).pathname, '--base', base, '--plan', plan, ...extra], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', c => err += c); child.on('close', code => resolve({ code, err: err.trim() }));
  });
  assert.deepEqual(await run('--operator-port', String(server.address().port)), { code: 1, err: 'WORLD_MUST_BE_PAUSED' });
  assert.equal(seen, '/world');
  assert.deepEqual(await run('--operator-port', '0'), { code: 1, err: 'PURGE_ARGUMENTS_REQUIRED' });
});
