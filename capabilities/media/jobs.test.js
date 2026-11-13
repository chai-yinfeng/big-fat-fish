import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createJobs, createGate, JOBS } from './jobs.js';
import { createDemoRunner, DEMO_RESULT } from './demo-job.js';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createContentServer } from './server.mjs';

const fail = code => Object.assign(new Error(code), { code });
const scope = (uid = 'MOCK-A', extra = {}) => ({ entityId: 'entity:mock', streamId: `qq:999900000001:private:${uid}`, personId: `person:${uid}`, audience: 'private', memoryEpoch: 0, worldRevision: 3, capabilityId: 'qq', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const until = async (check, label = 'condition') => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('never: ' + label); };

function fixture(t, { runners, file, clock } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), 'fish-jobs-'));
  if (!file) t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-jobs-')); fs.rmSync(dir, { recursive: true }); });
  const f = { dir, file: file ?? path.join(dir, 'jobs.json'), world: { paused: false, revision: 3 }, reserved: [], reported: [], reserveError: null, steps: [] };
  // A scripted runner: every slice waits until the test lets it go (`f.steps` holds one entry per started slice).
  const scripted = (priority = 'yielding') => ({
    title: 'MOCK 任务', action: 'wait', priority, deadlineMs: 60000, input: raw => ({ slices: raw?.slices ?? 1, stageMs: raw?.stageMs ?? 30000, text: raw?.text ?? 'MOCK-RESULT' }),
    async run({ input, stage }) {
      await stage('work', input.stageMs, async step => {
        for (let n = 1; n <= input.slices; n++) {
          await step.slice(signal => { const gate = deferred(); f.steps.push({ n, signal, ...gate }); return gate.promise; });
          step.progress(n / input.slices * 100);
        }
      });
      return { text: input.text };
    },
  });
  f.jobs = createJobs({
    file: f.file, runners: runners ?? { demo: scripted(), quick: scripted('timely') }, worldStatus: async () => ({ ...f.world }), worldCheckMs: 10, ...(clock ? { clock } : {}),
    usage: { reserve: async capability => { if (f.reserveError) throw f.reserveError; f.reserved.push(capability); }, record: async body => { f.reported.push(body); } },
  });
  t.after(() => f.jobs.close());
  f.list = () => f.jobs.control({ action: 'list' }).jobs;
  f.job = id => f.list().find(job => job.id === id);
  f.pending = () => f.jobs.control({ action: 'pending' }).jobs;
  f.stored = () => JSON.parse(fs.readFileSync(f.file, 'utf8'));
  f.started = n => until(() => f.steps.length >= n, `slice ${n} started`);
  f.status = (id, status) => until(() => f.job(id).status === status, `${id} ${status}`);
  return f;
}

test('a job is registered in the scope it was given, runs, and its result waits to be told: listed without the text, read only once handed out, inside its own scope', async t => {
  const f = fixture(t);
  const made = await f.jobs.register(scope(), { capability: 'demo', input: { text: 'MOCK-笔记' }, source: { requestId: 'MOCK-request' } });
  assert.deepEqual([Object.keys(made).sort(), made.status, made.failureCode], [['capability', 'failureCode', 'id', 'status'], 'queued', null]);
  await f.started(1);
  assert.deepEqual([f.job(made.id).status, f.job(made.id).progress, f.job(made.id).attempts, f.pending()], ['running', { stage: 'work', percent: 0 }, 1, []]);
  f.steps[0].resolve(); await f.status(made.id, 'done');
  // What Authority is told: who registered it and where, and the world revision it finished in. Not the result.
  const [waiting] = f.pending();
  assert.deepEqual(Object.keys(waiting).sort(), ['capability', 'endedAt', 'expiresAt', 'failureCode', 'id', 'notice', 'scope', 'source', 'status', 'worldRevision']);
  assert.deepEqual([waiting.id, waiting.status, waiting.notice, waiting.worldRevision, waiting.source], [made.id, 'done', 'pending', 3, { requestId: 'MOCK-request', sourceEventId: null }]);
  assert.deepEqual(waiting.scope, { entityId: 'entity:mock', streamId: 'qq:999900000001:private:MOCK-A', personId: 'person:MOCK-A', audience: 'private', memoryEpoch: 0 });
  assert.ok(!JSON.stringify(f.pending()).includes('MOCK-笔记'));
  assert.equal(waiting.expiresAt - waiting.endedAt, JOBS.resultTtlMs);
  // Not handed out yet: unreadable. Handed out: readable in the very scope it was registered in, by nobody else.
  assert.throws(() => f.jobs.read(scope(), made.id), { code: 'MEDIA_UNAVAILABLE' });
  assert.deepEqual(f.jobs.control({ action: 'notice', id: made.id, state: 'issued' }), { id: made.id, notice: 'issued' });
  assert.deepEqual(f.pending(), []);
  const read = f.jobs.read(scope(), made.id);
  assert.deepEqual([read.text, read.status, read.title, read.derived, read.isVerbatimUserText, read.isNewEvidence], ['MOCK-笔记', 'done', 'MOCK 任务', true, false, false]);
  for (const other of [scope('MOCK-B'), scope('MOCK-A', { memoryEpoch: 1 }), scope('MOCK-A', { personId: 'person:MOCK-B' }), scope('MOCK-A', { entityId: 'entity:other' }), scope('MOCK-A', { audience: 'shared' })]) assert.throws(() => f.jobs.read(other, made.id), { code: 'MEDIA_FORBIDDEN' });
  assert.throws(() => f.jobs.read(scope(), 'job:nope'), { code: 'MEDIA_FORBIDDEN' });
  assert.throws(() => f.jobs.read({ streamId: 'x' }, made.id), { code: 'MEDIA_SCOPE_REQUIRED' });
  // The ledger: one slot taken before it was queued, one report of how it ended. Never the text.
  assert.deepEqual(f.reserved, ['demo']);
  assert.deepEqual([f.reported.length, f.reported[0].capability, f.reported[0].outcome, Object.keys(f.reported[0]).sort()], [1, 'demo', 'ok', ['busyMs', 'capability', 'outcome']]);
});

test('how the telling ended is recorded once: carry-only, handed out, closed; a closed one never reopens, and one that may never be told loses its result', async t => {
  const f = fixture(t), ids = [];
  for (const text of ['MOCK-一', 'MOCK-二']) { const made = await f.jobs.register(scope(), { capability: 'demo', input: { text } }); ids.push(made.id); }
  await f.started(1); f.steps[0].resolve(); await f.started(2); f.steps[1].resolve(); await f.status(ids[1], 'done');
  const notice = (id, state, outcome) => f.jobs.control({ action: 'notice', id, state, ...(outcome ? { outcome } : {}) }).notice;
  assert.equal(notice(ids[0], 'carry', 'deferred:budget'), 'carry');
  assert.deepEqual(f.pending().map(job => [job.id, job.notice]), [[ids[0], 'carry'], [ids[1], 'pending']]);
  assert.equal(notice(ids[0], 'issued'), 'issued');
  assert.equal(notice(ids[0], 'closed', 'carried'), 'closed');
  // Settled: nothing reopens it, and it is never listed as waiting again.
  for (const state of ['issued', 'carry']) assert.equal(notice(ids[0], state), 'closed');
  assert.equal(notice(ids[0], 'closed', 'sent'), 'closed');
  assert.deepEqual([f.job(ids[0]).notice.outcome, f.job(ids[0]).result, f.pending().map(job => job.id)], ['carried', 'MOCK-一', [ids[1]]]);
  assert.throws(() => f.jobs.read(scope(), ids[0]), { code: 'MEDIA_UNAVAILABLE' });
  // The conversation or the source is gone: closed as dropped, and the result is deleted with it.
  assert.equal(notice(ids[1], 'closed', 'dropped:epoch'), 'closed');
  assert.deepEqual([f.job(ids[1]).notice.outcome, f.job(ids[1]).result, f.stored().jobs.find(job => job.id === ids[1]).result], ['dropped:epoch', null, null]);
  for (const bad of [{ state: 'pending' }, { state: 'told' }, { state: 'closed' }, { state: 'closed', outcome: 'Sent!' }, { state: 'issued', to: 'MOCK-B' }]) assert.throws(() => f.jobs.control({ action: 'notice', id: ids[1], ...bad }), { code: 'MEDIA_JOB_REQUEST' });
  assert.throws(() => f.jobs.control({ action: 'notice', id: 'job:nope', state: 'issued' }), { code: 'MEDIA_JOB_UNKNOWN' });
  for (const bad of [null, [], { action: 'register' }, { action: 'pending', streamId: 'x' }, { action: 'list', id: ids[0] }]) assert.throws(() => f.jobs.control(bad), { code: 'MEDIA_JOB_REQUEST' });
});

test('one job runs at a time, first come first served; a person has at most two waiting or running and the queue holds eight: more is refused as busy, in the ledger, without taking a slot', async t => {
  const f = fixture(t), made = [];
  for (const uid of ['MOCK-A', 'MOCK-A']) made.push(await f.jobs.register(scope(uid), { capability: 'demo' }));
  const third = await f.jobs.register(scope('MOCK-A'), { capability: 'demo' });
  assert.deepEqual([third.status, third.failureCode, f.reserved.length, f.reported], ['rejected', 'busy', 2, [{ capability: 'demo', outcome: 'denied', reason: 'busy' }]]);
  // Another person is not held back by MOCK-A's two, until the queue itself is full.
  for (const uid of ['MOCK-B', 'MOCK-B', 'MOCK-C', 'MOCK-C', 'MOCK-D', 'MOCK-D']) made.push(await f.jobs.register(scope(uid), { capability: 'demo' }));
  assert.deepEqual(made.map(job => job.status), Array(8).fill('queued'));
  const ninth = await f.jobs.register(scope('MOCK-E'), { capability: 'demo' });
  assert.deepEqual([ninth.status, ninth.failureCode, f.reserved.length, f.reported.filter(entry => entry.reason === 'busy').length], ['rejected', 'busy', 8, 2]);
  // Only the first is running; each next one starts when the one before it ended, in the order registered.
  await f.started(1);
  assert.deepEqual(f.list().filter(job => job.status === 'running').map(job => job.id), [made[0].id]);
  for (let n = 0; n < 8; n++) { await f.started(n + 1); assert.equal(f.list().filter(job => job.status === 'running').length, 1); assert.equal(f.job(made[n].id).status, 'running'); f.steps[n].resolve(); await f.status(made[n].id, 'done'); }
  // A refusal is on the operator's list with its reason and has nothing to tell.
  assert.deepEqual(f.list().filter(job => job.status === 'rejected').map(job => [job.failureCode, job.notice.state, job.result]), [['busy', 'none', null], ['busy', 'none', null]]);
  assert.equal(f.pending().length, 8);
});

test('no slot left today: refused as daily_limit; a ledger that cannot be asked starts nothing', async t => {
  const f = fixture(t);
  f.reserveError = fail('CONTENT_BUDGET_EXHAUSTED');
  const refused = await f.jobs.register(scope(), { capability: 'demo' });
  assert.deepEqual([refused.status, refused.failureCode, f.list().length, f.steps.length], ['rejected', 'daily_limit', 1, 0]);
  // The ledger counted that refusal itself; this service does not report it a second time.
  assert.deepEqual(f.reported, []);
  f.reserveError = fail('CONTENT_TRANSPORT_UNAVAILABLE');
  await assert.rejects(f.jobs.register(scope(), { capability: 'demo' }), { code: 'MEDIA_JOB_UNAVAILABLE' });
  assert.equal(f.list().length, 1);
  f.reserveError = null;
  await assert.rejects(f.jobs.register(scope(), { capability: 'video' }), { code: 'MEDIA_ACTION_DENIED' });
  await assert.rejects(f.jobs.register(scope(), { capability: 'constructor' }), { code: 'MEDIA_ACTION_DENIED' });
  await assert.rejects(f.jobs.register({ streamId: 'qq:1:private:2' }, { capability: 'demo' }), { code: 'MEDIA_SCOPE_REQUIRED' });
  assert.deepEqual([f.reserved, f.list().length], [[], 1]);
});

test('a stage that takes too long fails the job with `timeout`; a job past its overall deadline expires; both are told like a result', async t => {
  const f = fixture(t);
  const slow = await f.jobs.register(scope(), { capability: 'demo', input: { stageMs: 30 } });
  await f.started(1); await f.status(slow.id, 'failed');
  assert.deepEqual([f.job(slow.id).failureCode, f.job(slow.id).result, f.steps[0].signal.aborted, f.steps[0].signal.reason.code], ['timeout', null, true, 'timeout']);
  // A runner's own fixed code is kept; anything else it throws is just `failed`.
  for (const [thrown, code] of [[fail('no_speech'), 'no_speech'], [new Error('ENOENT: /private/path'), 'failed'], [fail('Has Spaces'), 'failed']]) {
    const job = await f.jobs.register(scope(), { capability: 'demo' });
    await f.started(f.steps.length + 1); f.steps.at(-1).reject(thrown); await f.status(job.id, 'failed');
    assert.equal(f.job(job.id).failureCode, code);
  }
  assert.deepEqual(f.pending().map(job => [job.status, job.failureCode, job.notice]), [['failed', 'timeout', 'pending'], ['failed', 'no_speech', 'pending'], ['failed', 'failed', 'pending'], ['failed', 'failed', 'pending']]);
  assert.deepEqual(f.reported.map(entry => entry.outcome), ['failed', 'failed', 'failed', 'failed']);
  // The overall deadline: a runner allowed 40 ms in all, with a stage that would allow far more.
  const g = fixture(t, { runners: { demo: { title: 'MOCK', action: 'wait', priority: 'yielding', deadlineMs: 40, input: () => ({}), run: ({ stage }) => stage('work', 60000, step => step.slice(() => new Promise(() => {}))) } } });
  const late = await g.jobs.register(scope(), { capability: 'demo' });
  await g.status(late.id, 'expired');
  assert.deepEqual([g.job(late.id).failureCode, g.pending().map(job => job.status)], ['deadline', ['expired']]);
});

test('yielding: a background job starts no new slice while a timely request is queued or running, and that wait costs its stage nothing; a timely job does not wait', async t => {
  const f = fixture(t), order = [];
  const job = await f.jobs.register(scope(), { capability: 'demo', input: { slices: 3, stageMs: 150 } });
  await f.started(1);
  // A voice reply arrives while slice 1 runs: it starts at once (it does not queue behind the job)...
  const voice = deferred(), second = deferred();
  const timely = f.jobs.gate.timely(async () => { order.push('voice started'); await voice.promise; order.push('voice done'); });
  const another = f.jobs.gate.timely(async () => { await second.promise; order.push('second done'); });
  assert.deepEqual([order, f.jobs.gate.busy], [['voice started'], 2]);
  // ...and when slice 1 ends, slice 2 does not start: the job waits, longer than its whole stage limit.
  f.steps[0].resolve(); order.push('slice 1 done');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual([f.steps.length, f.job(job.id).status, f.job(job.id).progress], [1, 'running', { stage: 'work', percent: 33 }]);
  voice.resolve(); await timely;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.steps.length, 1, 'one timely request is still running');
  second.resolve(); await another;
  await f.started(2); order.push('slice 2 started');
  assert.deepEqual(order, ['voice started', 'slice 1 done', 'voice done', 'second done', 'slice 2 started']);
  f.steps[1].resolve(); await f.started(3); f.steps[2].resolve(); await f.status(job.id, 'done');
  // The 250 ms at the gate were not charged to the 150 ms stage.
  assert.deepEqual([f.job(job.id).failureCode, f.job(job.id).attempts], [null, 1]);
  // A job that is itself timely goes on while timely requests run.
  const hold = deferred(), held = f.jobs.gate.timely(() => hold.promise);
  const quick = await f.jobs.register(scope(), { capability: 'quick', input: { slices: 2 } });
  await f.started(4); f.steps[3].resolve(); await f.started(5); f.steps[4].resolve(); await f.status(quick.id, 'done');
  hold.resolve(); await held;
  // The gate alone: idle() gives up with the signal's reason, and a failed timely request still releases it.
  const gate = createGate(), stuck = deferred(), waiting = gate.timely(() => stuck.promise), controller = new AbortController();
  const idle = gate.idle(controller.signal); controller.abort(fail('cancelled'));
  await assert.rejects(idle, { code: 'cancelled' });
  stuck.reject(new Error('MOCK failure')); await assert.rejects(waiting);
  assert.equal(gate.busy, 0); await gate.idle();
});

test('cancel: a queued job never runs, a running one is stopped; neither has anything to tell', async t => {
  const f = fixture(t);
  const first = await f.jobs.register(scope(), { capability: 'demo' }), second = await f.jobs.register(scope(), { capability: 'demo' });
  await f.started(1);
  assert.equal(f.jobs.control({ action: 'cancel', id: second.id }).status, 'cancelled');
  f.jobs.control({ action: 'cancel', id: first.id });
  await f.status(first.id, 'cancelled');
  assert.deepEqual([f.steps.length, f.steps[0].signal.reason.code, f.pending(), f.list().map(job => job.notice.state)], [1, 'cancelled', [], ['none', 'none']]);
  // Cancelling again, or something finished, changes nothing.
  assert.equal(f.jobs.control({ action: 'cancel', id: first.id }).status, 'cancelled');
  assert.throws(() => f.jobs.control({ action: 'cancel', id: 'job:nope' }), { code: 'MEDIA_JOB_UNKNOWN' });
});

test('a paused world stops the running job and puts it back uncounted; nothing starts until the world runs again', async t => {
  const f = fixture(t);
  const job = await f.jobs.register(scope(), { capability: 'demo' });
  await f.started(1);
  f.world.paused = true; f.world.revision = 4;
  await f.status(job.id, 'queued');
  assert.deepEqual([f.job(job.id).attempts, f.steps[0].signal.reason.code, f.reported], [0, 'paused', []]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.steps.length, 1, 'nothing runs while paused');
  f.world.paused = false; f.world.revision = 5;
  await f.started(2); f.steps[1].resolve(); await f.status(job.id, 'done');
  assert.deepEqual([f.job(job.id).attempts, f.pending()[0].worldRevision], [1, 5]);
});

test('restart: a job that was running is queued again once, then failed as interrupted; results waiting to be told survive, and an unreadable file is set aside', async t => {
  const f = fixture(t);
  const done = await f.jobs.register(scope(), { capability: 'demo', input: { text: 'MOCK-留着' } });
  await f.started(1); f.steps[0].resolve(); await f.status(done.id, 'done');
  const cut = await f.jobs.register(scope(), { capability: 'demo' });
  await f.started(2);
  await f.jobs.close();
  assert.equal(f.stored().jobs.find(job => job.id === cut.id).status, 'running');
  // Second process: the cut-off job is queued again (attempt 2 of 2), the finished one still waits to be told.
  const g = fixture(t, { file: f.file });
  assert.deepEqual([g.job(cut.id).status, g.job(cut.id).attempts, g.pending().map(job => job.id)], ['queued', 1, [done.id]]);
  g.jobs.start(); await g.started(1);
  assert.equal(g.job(cut.id).attempts, 2);
  await g.jobs.close();
  // Third process: no attempt left. It failed, and that is told like any failure.
  const h = fixture(t, { file: f.file });
  assert.deepEqual([h.job(cut.id).status, h.job(cut.id).failureCode, h.pending().map(job => [job.id, job.status])], ['failed', 'interrupted', [[done.id, 'done'], [cut.id, 'failed']]]);
  h.jobs.start(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.steps.length, 0);
  await h.jobs.close();
  fs.writeFileSync(f.file, '{"schema":1,"jobs":');
  const broken = fixture(t, { file: f.file });
  assert.deepEqual([broken.list(), fs.existsSync(f.file + '.invalid')], [[], true]);
});

test('housekeeping: an untold result is dropped after seven days, a queued job past its deadline expires, old settled records go, and an idle look writes nothing', async t => {
  const clock = { now: 1_800_000_000_000 }, f = fixture(t, { clock: () => clock.now });
  const job = await f.jobs.register(scope(), { capability: 'demo', input: { text: 'MOCK-旧' } });
  await f.started(1); f.steps[0].resolve(); await f.status(job.id, 'done');
  const before = fs.statSync(f.file).mtimeMs, content = fs.readFileSync(f.file, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 20));
  f.pending(); f.list(); f.jobs.sweep();
  assert.deepEqual([fs.statSync(f.file).mtimeMs, fs.readFileSync(f.file, 'utf8')], [before, content]);
  clock.now += JOBS.resultTtlMs - 1; assert.equal(f.pending().length, 1);
  clock.now += 1;
  assert.deepEqual([f.pending(), f.job(job.id).notice.state, f.job(job.id).notice.outcome, f.job(job.id).result], [[], 'closed', 'expired', null]);
  // More settled records than are kept: the oldest go, the newest stay.
  f.reserveError = fail('CONTENT_BUDGET_EXHAUSTED');
  for (let n = 0; n < JOBS.kept + 5; n++) await f.jobs.register(scope(), { capability: 'demo' });
  f.jobs.sweep();
  assert.deepEqual([f.list().length, f.job(job.id)], [JOBS.kept, undefined]);
  // Still queued when its deadline passes (the one ahead of it is taking long): it expires without ever running.
  f.reserveError = null;
  const ahead = await f.jobs.register(scope(), { capability: 'demo' }), behind = await f.jobs.register(scope(), { capability: 'demo' });
  await f.started(2);
  clock.now += 60001; f.jobs.sweep();
  assert.deepEqual([f.job(behind.id).status, f.job(behind.id).failureCode, f.job(behind.id).attempts, f.job(ahead.id).status], ['expired', 'deadline', 0, 'running']);
  f.steps[1].resolve(); await f.status(ahead.id, 'done');
  assert.equal(f.steps.length, 2);
});

test('the demonstration job waits its seconds a slice at a time and returns the fixed text', async t => {
  const slept = [], runner = createDemoRunner({ sleep: async ms => { slept.push(ms); } });
  assert.deepEqual([runner.input(), runner.input({ seconds: 3 }), runner.priority, runner.action], [{ seconds: 5 }, { seconds: 3 }, 'yielding', 'wait']);
  for (const bad of [{ seconds: 0 }, { seconds: 121 }, { seconds: 1.5 }, { seconds: '3' }, { seconds: 3, text: 'x' }, [], 'x']) assert.throws(() => runner.input(bad), { code: 'MEDIA_INPUT_INVALID' });
  const f = fixture(t, { runners: { demo: runner } });
  const job = await f.jobs.register(scope(), { capability: 'demo', input: { seconds: 3 } });
  await f.status(job.id, 'done');
  f.jobs.control({ action: 'notice', id: job.id, state: 'issued' });
  assert.deepEqual([slept, f.jobs.read(scope(), job.id).text, f.jobs.read(scope(), job.id).title], [[1000, 1000, 1000], DEMO_RESULT, '演示任务']);
  assert.ok(DEMO_RESULT.length <= JOBS.resultChars);
});

test('the control socket: /jobs answers its one credential only; a job is registered and read through the scoped content route; the records sit beside the media files unseen by the artifact store', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-jobs-'));
  const tokenFile = path.join(dir, 'control.token'), socketPath = path.join(dir, 'content.sock'), token = 'synthetic-content-control-credential-MOCK';
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const store = new ArtifactStore({ root: path.join(dir, 'media') });
  const f = fixture(t, { file: path.join(dir, 'media', 'jobs.json'), runners: { demo: createDemoRunner({ sleep: async () => {} }) } });
  const service = new MediaService({ store, workRoot: path.join(dir, 'work'), jobs: f.jobs });
  const server = createContentServer({ socketPath, tokenFile, service, worldStatus: async () => ({ ...f.world }), jobsCall: input => f.jobs.control(input) });
  await server.start();
  t.after(async () => { await server.close(); await f.jobs.close(); assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'fish-jobs-')); fs.rmSync(dir, { recursive: true }); });
  const post = (route, body, bearer = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'POST', agent: false, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal((await post('/jobs', { action: 'list' }, 'another-synthetic-credential-of-enough-length')).status, 401);
  assert.deepEqual((await post('/jobs', { action: 'list' })).body, { ok: true, value: { limits: { queued: 8, perPerson: 2 }, jobs: [] } });
  for (const bad of [{ action: 'register', capability: 'demo' }, { action: 'notice', id: 'job:nope', state: 'issued' }, { action: 'pending', streamId: 'x' }]) assert.equal((await post('/jobs', bad)).status, 400);
  // Registered through the scoped route, with the scope Authority would derive; told through /jobs; read back scoped.
  const started = await post('/content', { scope: scope(), input: { action: 'jobStart', capability: 'demo', input: { seconds: 1 }, requestId: 'MOCK-request' } });
  assert.deepEqual([started.status, started.body.value.status], [200, 'queued']);
  const id = started.body.value.id;
  await until(async () => (await post('/jobs', { action: 'pending' })).body.value.jobs.length === 1, 'job done');
  assert.equal((await post('/content', { scope: scope(), input: { action: 'jobResult', ref: id } })).status, 503);
  assert.deepEqual((await post('/jobs', { action: 'notice', id, state: 'issued' })).body.value, { id, notice: 'issued' });
  assert.equal((await post('/content', { scope: scope(), input: { action: 'jobResult', ref: id } })).body.value.text, DEMO_RESULT);
  assert.equal((await post('/content', { scope: scope('MOCK-B'), input: { action: 'jobResult', ref: id } })).status, 503);
  // Paused: the scoped route refuses, as for every content action.
  f.world.paused = true;
  assert.equal((await post('/content', { scope: scope(), input: { action: 'jobStart', capability: 'demo' } })).status, 503);
  // The file lives in the media root; the artifact store neither lists nor expires it.
  assert.ok(fs.existsSync(path.join(dir, 'media', 'jobs.json')));
  assert.deepEqual([store.records(), store.expire()], [[], { removed: 0 }]);
  // Without a job framework the content service answers as before.
  const plain = new MediaService({ store, workRoot: path.join(dir, 'work') });
  await assert.rejects(plain.call(scope(), { action: 'jobStart', capability: 'demo' }), { code: 'MEDIA_ACTION_DENIED' });
});
