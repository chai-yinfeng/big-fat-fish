import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ArtifactStore } from './artifacts.js';
import { createStickers } from './stickers.js';
import { createJobs } from './jobs.js';
import { createContentServer } from './server.mjs';
import { forgetLive } from './forget.js';

// Forgetting inside the running content service (its `/forget`): the stores this process holds forget, serially with
// everything else the process writes.
const stream = 'qq:999900000001:private:MOCK-A', other = 'qq:999900000001:private:MOCK-B';
const scope = (streamId = stream, memoryEpoch = 0) => ({ entityId: 'entity:mock', streamId, personId: 'person:' + streamId.split(':').at(-1), audience: 'private', memoryEpoch });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const until = async (check, label) => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('never: ' + label); };
const plan = (extra = {}) => ({ id: 'job-1', entityId: 'entity:mock', memoryEpoch: 1, affectedStreams: [{ capabilityId: 'qq', streamId: stream, memoryEpoch: 1 }], sourceObservationIds: [], sourceEvents: [{ capabilityId: 'qq', streamId: stream, eventId: 'MOCK-forgotten' }], ...extra });

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-forget-')));
  const f = { dir, world: { paused: false, revision: 3 }, steps: [], workRoot: path.join(dir, 'work') };
  fs.mkdirSync(f.workRoot);
  f.store = new ArtifactStore({ root: path.join(dir, 'media') });
  f.stickers = createStickers({ root: f.store.root });
  f.file = path.join(f.store.root, 'jobs.json');
  // Every slice of a job waits until the test lets it go.
  const runner = { title: 'MOCK 任务', action: 'wait', priority: 'yielding', deadlineMs: 60000, input: raw => raw ?? {}, async run({ stage }) { await stage('work', 30000, step => step.slice(() => { const gate = deferred(); f.steps.push(gate); return gate.promise; })); return { text: 'MOCK-RESULT' }; } };
  f.jobs = createJobs({ file: f.file, runners: { demo: runner }, worldStatus: async () => ({ ...f.world }), worldCheckMs: 5, usage: { reserve: async () => {}, record: async () => {} } });
  f.live = () => ({ store: f.store, stickers: f.stickers, jobs: f.jobs, workRoot: f.workRoot });
  f.stored = () => JSON.parse(fs.readFileSync(f.file, 'utf8')).jobs.map(job => job.id);
  t.after(async () => { await f.jobs.close(); assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-forget-')); fs.rmSync(dir, { recursive: true }); });
  return f;
}

test('forgetLive: the running service\'s own stores forget the message, nothing it holds in memory writes a record back, and the same job again is harmless', async t => {
  const f = fixture(t);
  const picture = f.store.put({ scope: scope(), sourceEventId: 'MOCK-forgotten', kind: 'image', mime: 'image/png', data: Buffer.from('MOCK picture') });
  const note = f.store.put({ scope: scope(), sourceEventId: 'MOCK-forgotten', kind: 'note', mime: 'text/plain', data: Buffer.from('MOCK video note') });
  const derived = f.store.put({ scope: scope(), sourceEventId: 'MOCK-later', kind: 'description', mime: 'text/plain', data: Buffer.from('MOCK description'), parents: [picture.id] });
  const kept = f.store.put({ scope: scope(other), sourceEventId: 'MOCK-forgotten', kind: 'image', mime: 'image/png', data: Buffer.from('MOCK other picture') });
  const hash = n => String(n).repeat(64);
  for (const [n, eventId] of [[1, 'MOCK-forgotten'], [2, 'MOCK-kept']]) f.stickers.keep({ hash: hash(n), data: Buffer.from('MOCK sticker ' + n), mime: 'image/png', kind: 'sticker', name: 'MOCK' + n, tags: [], origin: { entityId: 'entity:mock', streamId: stream, eventId } });
  fs.mkdirSync(path.join(f.workRoot, 'reference'));
  fs.writeFileSync(path.join(f.workRoot, 'reference/default.wav'), 'MOCK voice reference');
  fs.writeFileSync(path.join(f.workRoot, 'tts-11111111-1111-1111-1111-111111111111.wav'), 'MOCK unfinished speech');
  // Three job records while the world is paused (none starts): one asked for by the forgotten message, one of the
  // retired epoch of that conversation, one of another conversation.
  f.world.paused = true;
  const asked = await f.jobs.register(scope(stream, 1), { capability: 'demo', source: { sourceEventId: 'MOCK-forgotten' } });
  const retired = await f.jobs.register(scope(stream, 0), { capability: 'demo', source: { sourceEventId: 'MOCK-earlier' } });
  const others = await f.jobs.register(scope(other), { capability: 'demo', source: { sourceEventId: 'MOCK-forgotten' } });
  assert.deepEqual(f.stored(), [asked.id, retired.id, others.id]);

  assert.deepEqual(forgetLive(plan(), f.live()), { artifactsRemoved: 3, stickersRemoved: 1, stickersDetached: 0, jobRecordsRemoved: 2, speechScratchRemoved: 1 });
  for (const gone of [picture, note, derived]) assert.equal(fs.existsSync(f.store.directory(gone.id)), false);
  assert.equal(f.store.read(kept.id, scope(other)).data.toString(), 'MOCK other picture');
  assert.deepEqual(fs.readdirSync(f.workRoot), ['reference']);
  assert.deepEqual(f.stored(), [others.id]);
  // The process writes its files again afterwards (a cancelled job, a sticker kept): what was forgotten stays gone.
  f.jobs.control({ action: 'cancel', id: others.id });
  f.stickers.keep({ hash: hash(3), data: Buffer.from('MOCK sticker 3'), mime: 'image/png', kind: 'sticker', name: 'MOCK3', tags: [], origin: { entityId: 'entity:mock', streamId: stream, eventId: 'MOCK-kept' } });
  assert.deepEqual(f.stored(), [others.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.store.root, 'stickers/index.json'), 'utf8')).entries.map(entry => entry.name), ['MOCK2', 'MOCK3']);
  // The world resumes: a forgotten job that was waiting never starts.
  f.world.paused = false; f.jobs.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.steps.length, 0);
  // The same job again finds nothing.
  assert.deepEqual(forgetLive(plan(), f.live()), { artifactsRemoved: 0, stickersRemoved: 0, stickersDetached: 0, jobRecordsRemoved: 0, speechScratchRemoved: 0 });
  // A plan that is not one erases nothing; a link in the work directory is refused before anything goes.
  assert.throws(() => forgetLive({ entityId: 'entity:mock', sourceEvents: [] }, f.live()), { code: 'MEDIA_FORGET_PLAN' });
  f.store.put({ scope: scope(), sourceEventId: 'MOCK-forgotten', kind: 'image', mime: 'image/png', data: Buffer.from('MOCK again') });
  fs.symlinkSync(path.join(f.workRoot, 'reference/default.wav'), path.join(f.workRoot, 'tts-22222222-2222-2222-2222-222222222222.wav'));
  assert.throws(() => forgetLive(plan(), f.live()), { code: 'EXECUTION_SYMLINK_REFUSED' });
  assert.equal(f.store.records().filter(meta => meta.sourceEventId === 'MOCK-forgotten' && meta.streamId === stream).length, 1);
});

test('a job that is running is not forgotten under its feet: forgetting waits for the pause to send it back to the queue', async t => {
  const f = fixture(t);
  const job = await f.jobs.register(scope(), { capability: 'demo', source: { sourceEventId: 'MOCK-forgotten' } });
  await until(() => f.steps.length === 1, 'the job runs');
  assert.equal(f.jobs.running, true);
  assert.throws(() => forgetLive(plan(), f.live()), { code: 'MEDIA_JOB_RUNNING' });
  assert.deepEqual(f.stored(), [job.id]);
  // The pause aborts the slice; the job is queued again, and only then is its record forgotten.
  f.world.paused = true;
  await until(() => !f.jobs.running, 'the job is back in the queue');
  assert.equal(forgetLive(plan(), f.live()).jobRecordsRemoved, 1);
  assert.deepEqual(f.stored(), []);
  f.world.paused = false; f.jobs.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual([f.steps.length, f.stored()], [1, []]);
});

test('/forget: only Authority\'s credential, only while the world is paused, and never while another request of this process is in flight', async t => {
  const f = fixture(t);
  const tokenFile = path.join(f.dir, 'control.token'), socketPath = path.join(f.dir, 'content.sock'), token = 'synthetic-content-control-credential-MOCK';
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  // A content request that writes only when the test lets it: the write a forget must not overlap.
  const gates = [], order = [];
  const service = { call: async currentScope => { const gate = deferred(); gates.push(gate); await gate.promise; order.push('write'); return f.store.put({ scope: currentScope, sourceEventId: 'MOCK-forgotten', kind: 'image', mime: 'image/png', data: Buffer.from('MOCK late write') }); } };
  const stickerGates = [];
  const server = createContentServer({ socketPath, tokenFile, service, worldStatus: async () => ({ ...f.world }), jobsCall: input => f.jobs.control(input),
    stickersCall: async () => { const gate = deferred(); stickerGates.push(gate); await gate.promise; return {}; },
    forgetCall: job => { order.push('forget'); return { ...forgetLive(job, f.live()), startedAt: 7 }; } });
  await server.start(); t.after(() => server.close());
  const post = (route, body, bearer = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'POST', agent: false, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal((await post('/forget', plan(), 'another-synthetic-credential-of-enough-length')).status, 401);
  // Not paused: refused, nothing erased.
  assert.deepEqual([(await post('/forget', plan())).body.error.code, order], ['CONTENT_FORGET_WORLD', []]);
  // A request is under way when the world pauses. Until it has ended, forgetting is refused.
  const inflight = post('/content', { scope: { ...scope(), worldRevision: 3 }, input: { action: 'ingest' } });
  await until(() => gates.length === 1, 'the request is in flight');
  f.world.paused = true;
  assert.deepEqual([(await post('/forget', plan())).body.error.code, order], ['CONTENT_BUSY', []]);
  gates[0].resolve();
  assert.equal((await inflight).body.error.code, 'CONTENT_PAUSED');
  // Its write came first; the forget that follows takes it.
  const done = await post('/forget', plan());
  assert.deepEqual([done.status, done.body.value.artifactsRemoved, done.body.value.startedAt, order], [200, 1, 7, ['write', 'forget']]);
  assert.equal(f.store.records().length, 0);
  // The same holds for a console request about her sticker library, which needs no pause.
  const sticker = post('/stickers', { action: 'list' });
  await until(() => stickerGates.length === 1, 'the sticker request is in flight');
  assert.equal((await post('/forget', plan())).body.error.code, 'CONTENT_BUSY');
  stickerGates[0].resolve(); await sticker;
  assert.equal((await post('/forget', plan())).status, 200);
  // A plan that is not one is refused and counted as nothing.
  assert.notEqual((await post('/forget', { entityId: 'entity:mock' })).status, 200);
  // While paused no new content request is taken at all, so nothing can start between a forget's check and its end.
  assert.equal((await post('/content', { scope: { ...scope(), worldRevision: 3 }, input: { action: 'ingest' } })).body.error.code, 'CONTENT_PAUSED');
  assert.equal(gates.length, 1);
});
