// Background jobs of the content service: work one person asked for that outlives the turn it was asked in.
// A job is registered inside a scope Authority derived (conversation, person, memory epoch), queued, run one
// at a time, and its result waits here until Authority has it told to that same conversation: either in a
// turn she starts herself (`completion`) or with the person's next message (`carried`).
//
// Records are one JSON file in the data root (atomic write, like the QQ bridge's state file); no database.
// This service never calls Authority about a job and never names who is told: Authority asks (`/jobs` on the
// control socket), decides and reports back how the telling ended.
//
// Two priorities. `timely` work is what somebody is waiting for now; a `yielding` job advances in slices and,
// before each slice, waits until no timely request is queued or running (the gate below). Waiting there costs
// the job's stage nothing; only the job's overall deadline keeps running. A slice already running is not
// interrupted: stopping a child process group mid-slice (SIGSTOP/SIGCONT) is for the first runner that has
// one, and would hook into the same gate.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
export const JOBS = Object.freeze({
  /** Jobs waiting or running, all people together; a registration beyond it is refused as `busy`. */
  queued: 8,
  /** Jobs one person may have waiting or running. */
  perPerson: 2,
  /** A job cut off by a restart is queued again until it has been started this often. */
  attempts: 2,
  /** A result is a short text. */
  resultChars: 1200,
  /** A result nobody was told about is dropped after this (the media cache's seven days). */
  resultTtlMs: 7 * 86400000,
  /** Settled records kept for the operator's list. */
  kept: 100,
  /** How often a running or waiting job looks at the world (paused: back to the queue, uncounted). */
  worldCheckMs: 1000,
});
/** How telling the person about a finished job stands. `pending`: she may start a turn about it or it may ride on
 * the person's next message. `carry`: only with the person's next message. `issued`: handed out, being told.
 * `closed`: settled, with the outcome. `none`: nothing to tell (refused, cancelled). */
const NOTICE_STATES = ['pending', 'carry', 'issued', 'closed'];
const FINISHED = ['done', 'failed', 'expired'];
const CODE = /^[a-z_]{1,32}$/;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const scopeOf = value => {
  if (!value || !['entityId', 'streamId', 'personId'].every(key => text(value[key])) || !['private', 'shared'].includes(value.audience) || !Number.isSafeInteger(value.memoryEpoch) || value.memoryEpoch < 0) throw fail('MEDIA_SCOPE_REQUIRED');
  return { entityId: value.entityId, streamId: value.streamId, personId: value.personId, audience: value.audience, memoryEpoch: value.memoryEpoch };
};
const sameScope = (a, b) => ['entityId', 'streamId', 'personId', 'audience', 'memoryEpoch'].every(key => a[key] === b[key]);

/** Counts the timely requests in flight and lets a yielding job wait for none. */
export function createGate() {
  let busy = 0; const waiters = new Set();
  return {
    get busy() { return busy; },
    /** Run a timely request: from now until it settles, yielding jobs start no new slice. */
    async timely(run) {
      busy++;
      try { return await run(); } finally { if (!--busy) { const woken = [...waiters]; waiters.clear(); for (const wake of woken) wake(); } }
    },
    /** Resolves once no timely request is queued or running; rejects with the signal's reason when it aborts. */
    async idle(signal) {
      while (busy) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
          const stop = () => { waiters.delete(wake); reject(signal.reason); };
          const wake = () => { signal?.removeEventListener('abort', stop); resolve(); };
          waiters.add(wake); signal?.addEventListener('abort', stop, { once: true });
        });
      }
    },
  };
}

/**
 * `runners`: `{ [capability]: { title, action, priority: 'timely' | 'yielding', deadlineMs, input(raw) -> input,
 * run({ input, signal, stage }) -> { text } } }`. A runner does its work in stages, each with its own time limit,
 * and each stage in slices: `await stage(name, timeoutMs, step => ...)`, inside it `await step.slice(signal => ...)`
 * and `step.progress(percent)`. It fails with a fixed lowercase code (`fail('no_speech')`); anything else is `failed`.
 * `usage`: `{ reserve(capability), record(body) }`, the gateway's usage ledger (a slot of the day before the job
 * exists; how it ended afterwards). `worldStatus()` -> `{ paused, revision }`.
 */
export function createJobs({ file, runners, gate = createGate(), worldStatus, usage, clock = Date.now, worldCheckMs = JOBS.worldCheckMs }) {
  if (!path.isAbsolute(file)) throw fail('MEDIA_JOB_CONFIG');
  let state = { schema: 1, jobs: [] }, current = null, working = false, closed = false, registering = Promise.resolve();
  const sleepers = new Set();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file);
  };
  const report = body => { try { Promise.resolve(usage.record(body)).catch(() => {}); } catch {} };
  const pause = ms => new Promise(resolve => { const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); }, timer = setTimeout(wake, ms); sleepers.add(wake); });
  const world = async () => { try { const value = await worldStatus(); return typeof value?.paused === 'boolean' && Number.isSafeInteger(value.revision) ? value : null; } catch { return null; } };

  if (fs.existsSync(file)) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored?.schema !== 1 || !Array.isArray(stored.jobs)) throw fail('MEDIA_JOB_STATE');
      state = { schema: 1, jobs: stored.jobs };
    } catch {
      // Nothing is thrown away and the service still starts (speech and pictures do not depend on this file).
      fs.renameSync(file, file + '.invalid'); process.stderr.write('Background job records were unreadable and set aside; starting with none.\n');
    }
    // A job the last process was running: queued again while it has attempts left, else it failed.
    for (const job of state.jobs) if (job.status === 'running') {
      job.status = 'interrupted';
      if (job.attempts < JOBS.attempts) { job.status = 'queued'; job.progress = null; }
      else settle(job, 'failed', { failureCode: 'interrupted' });
    }
    save(); sweep();
  }

  /** A job ends: its result (or why there is none) now waits to be told. */
  function settle(job, status, { failureCode = null, result = null, worldRevision = null } = {}) {
    const now = clock();
    Object.assign(job, { status, failureCode, result, endedAt: now, progress: null });
    if (FINISHED.includes(status)) { job.notice = { state: 'pending', at: now }; job.doneWorldRevision = worldRevision; job.expiresAt = now + JOBS.resultTtlMs; }
    else job.notice = { state: 'none', at: now };
    if (job.startedAt) report({ capability: job.capability, outcome: status === 'done' ? 'ok' : 'failed', busyMs: Math.min(86400000, Math.max(0, now - job.startedAt)) });
  }
  /** Housekeeping: untold results past their time are dropped, queued jobs past their deadline expire, old records go. */
  function sweep() {
    const now = clock(); let changed = false;
    for (const job of state.jobs) {
      if (job.status === 'queued' && now >= job.deadlineAt) { settle(job, 'expired', { failureCode: 'deadline' }); changed = true; }
      if (FINISHED.includes(job.status) && job.notice.state !== 'closed' && now >= job.expiresAt) { job.notice = { state: 'closed', outcome: 'expired', at: now }; job.result = null; changed = true; }
    }
    const settled = state.jobs.filter(job => !['queued', 'running'].includes(job.status) && ['closed', 'none'].includes(job.notice.state));
    const dropped = new Set(settled.slice(0, Math.max(0, settled.length - JOBS.kept)));
    if (dropped.size) { state.jobs = state.jobs.filter(job => !dropped.has(job)); changed = true; }
    // An idle look writes nothing.
    if (changed) save();
  }
  const find = id => state.jobs.find(job => job.id === id);
  const active = () => state.jobs.filter(job => ['queued', 'running'].includes(job.status));
  const brief = job => ({ id: job.id, capability: job.capability, status: job.status, failureCode: job.failureCode });

  /** One stage of a running job. The time limit covers the slices only, not the waits before them. */
  function stage(job, controller, name, timeoutMs, body) {
    if (!text(name, 32) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw fail('MEDIA_JOB_RUNNER');
    let left = timeoutMs;
    job.progress = { stage: name, percent: 0 }; save();
    return body({
      progress(percent) { job.progress = { stage: name, percent: Math.max(0, Math.min(100, Math.round(percent))) }; save(); },
      async slice(run) {
        if (job.priority === 'yielding') await gate.idle(controller.signal);
        controller.signal.throwIfAborted();
        if (left <= 0) throw fail('timeout');
        const slice = new AbortController(), stop = () => slice.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        const from = clock(), timer = setTimeout(() => slice.abort(fail('timeout')), left);
        try {
          // The abort wins even over a runner that does not listen to its signal.
          return await Promise.race([run(slice.signal), new Promise((_, reject) => slice.signal.addEventListener('abort', () => reject(slice.signal.reason), { once: true }))]);
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); left -= clock() - from; }
      },
    });
  }
  async function run(job, startedIn) {
    const runner = runners[job.capability], controller = new AbortController();
    Object.assign(job, { status: 'running', attempts: job.attempts + 1, startedAt: clock() }); save();
    current = { job, controller };
    const deadline = setTimeout(() => controller.abort(fail('deadline')), Math.max(0, job.deadlineAt - clock()));
    let checking = false, revision = startedIn.revision;
    const watch = setInterval(async () => {
      if (checking) return; checking = true;
      try { const now = await world(); if (!now || now.paused || now.revision !== revision) controller.abort(fail('paused')); } finally { checking = false; }
    }, worldCheckMs);
    try {
      const result = await runner.run({ input: job.input, signal: controller.signal, stage: (name, timeoutMs, body) => stage(job, controller, name, timeoutMs, body) });
      controller.signal.throwIfAborted();
      if (!text(result?.text, JOBS.resultChars)) throw fail('failed');
      settle(job, 'done', { result: { text: result.text }, worldRevision: (await world())?.revision ?? null });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason?.code : null;
      // Closing: the record stays `running`, which the next start reads as interrupted.
      if (reason === 'closing') return;
      // Paused: back to the queue as if it had not been started.
      if (reason === 'paused') Object.assign(job, { status: 'queued', attempts: job.attempts - 1, startedAt: null, progress: null });
      else if (reason === 'cancelled') settle(job, 'cancelled');
      else if (reason === 'deadline') settle(job, 'expired', { failureCode: 'deadline', worldRevision: (await world())?.revision ?? null });
      else settle(job, 'failed', { failureCode: CODE.test(error?.code ?? '') ? error.code : 'failed', worldRevision: (await world())?.revision ?? null });
    } finally { clearTimeout(deadline); clearInterval(watch); current = null; save(); }
  }
  /** The one worker: heavy jobs run one at a time, first come first served, never while the world is paused. */
  async function work() {
    if (working || closed) return;
    working = true;
    try {
      while (!closed) {
        sweep();
        const job = state.jobs.find(entry => entry.status === 'queued');
        if (!job) return;
        const now = await world();
        if (closed) return;
        if (!now || now.paused) { await pause(worldCheckMs); continue; }
        await run(job, now);
      }
    } finally { working = false; }
  }
  const kick = () => { void work().catch(() => {}); };

  return {
    gate,
    start: kick,
    /** A job for the person of `scope`, as Authority derived it. Returns `{ id, capability, status, failureCode }`:
     * `queued`, or `rejected` with `busy` (the queue or this person's share is full) or `daily_limit` (no slot left
     * today); both refusals are in the usage ledger. */
    register(scope, { capability, input, source } = {}) {
      const next = registering.then(async () => {
        const owner = scopeOf(scope), runner = Object.hasOwn(runners, capability) ? runners[capability] : null;
        if (!runner || closed) throw fail('MEDIA_ACTION_DENIED');
        if (source?.requestId !== undefined && !text(source.requestId) || source?.sourceEventId !== undefined && !text(source.sourceEventId)) throw fail('MEDIA_INPUT_INVALID');
        const accepted = runner.input(input), now = clock();
        const job = {
          id: 'job:' + randomUUID(), capability, action: runner.action, priority: runner.priority, scope: owner,
          source: { requestId: source?.requestId ?? null, sourceEventId: source?.sourceEventId ?? null }, dedupeKey: null, input: accepted,
          status: 'queued', attempts: 0, progress: null, createdAt: now, startedAt: null, endedAt: null, deadlineAt: now + runner.deadlineMs,
          result: null, failureCode: null, notice: { state: 'none', at: now },
        };
        const reject = code => { settle(job, 'rejected', { failureCode: code }); state.jobs.push(job); save(); return brief(job); };
        const waiting = active();
        if (waiting.length >= JOBS.queued || waiting.filter(entry => entry.scope.entityId === owner.entityId && entry.scope.personId === owner.personId).length >= JOBS.perPerson) {
          report({ capability, outcome: 'denied', reason: 'busy' });
          return reject('busy');
        }
        // The ledger counts a refused slot itself. Without the ledger nothing is started: the daily limit is its to keep.
        try { await usage.reserve(capability); }
        catch (error) { if (error?.code === 'CONTENT_BUDGET_EXHAUSTED') return reject('daily_limit'); throw fail('MEDIA_JOB_UNAVAILABLE'); }
        state.jobs.push(job); save(); kick();
        return brief(job);
      });
      registering = next.catch(() => {});
      return next;
    },
    /** The result of a job, for the turn that tells it: only inside the job's own scope and only once Authority has
     * handed that telling out. Machine-made text, never the person's words. */
    read(scope, id) {
      const owner = scopeOf(scope), job = find(id);
      if (!job || !sameScope(job.scope, owner)) throw fail('MEDIA_FORBIDDEN');
      if (job.notice.state !== 'issued' || !FINISHED.includes(job.status)) throw fail('MEDIA_UNAVAILABLE');
      return { id: job.id, capability: job.capability, title: runners[job.capability]?.title ?? job.capability, status: job.status, failureCode: job.failureCode, text: job.result?.text ?? null, derived: true, isNewEvidence: false, isVerbatimUserText: false };
    },
    /** Control socket only (Authority). */
    control(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MEDIA_JOB_REQUEST');
      const only = (...keys) => { if (Object.keys(input).some(key => !['action', ...keys].includes(key))) throw fail('MEDIA_JOB_REQUEST'); };
      sweep();
      if (input.action === 'pending') {
        only();
        // Finished and not yet told: who registered it and where, never the result itself.
        return { jobs: state.jobs.filter(job => FINISHED.includes(job.status) && ['pending', 'carry'].includes(job.notice.state)).map(job => ({ id: job.id, capability: job.capability, status: job.status, failureCode: job.failureCode, scope: job.scope, source: job.source, endedAt: job.endedAt, worldRevision: job.doneWorldRevision ?? null, expiresAt: job.expiresAt, notice: job.notice.state })) };
      }
      if (input.action === 'list') {
        only();
        return { limits: { queued: JOBS.queued, perPerson: JOBS.perPerson }, jobs: state.jobs.map(job => ({ id: job.id, capability: job.capability, title: runners[job.capability]?.title ?? job.capability, action: job.action, priority: job.priority, status: job.status, failureCode: job.failureCode, attempts: job.attempts, progress: job.progress, scope: job.scope, createdAt: job.createdAt, startedAt: job.startedAt, endedAt: job.endedAt, deadlineAt: job.deadlineAt, notice: { state: job.notice.state, outcome: job.notice.outcome ?? null, at: job.notice.at }, result: job.result?.text ?? null })).reverse() };
      }
      if (input.action === 'cancel') {
        only('id');
        const job = find(input.id);
        if (!job) throw fail('MEDIA_JOB_UNKNOWN');
        if (job.status === 'queued') { settle(job, 'cancelled'); save(); }
        else if (job.status === 'running' && current?.job === job) current.controller.abort(fail('cancelled'));
        return brief(job);
      }
      if (input.action === 'notice') {
        only('id', 'state', 'outcome');
        const job = find(input.id);
        if (!job) throw fail('MEDIA_JOB_UNKNOWN');
        if (!NOTICE_STATES.includes(input.state) || input.state === 'pending' || input.outcome !== undefined && !(typeof input.outcome === 'string' && /^[a-z_:]{1,64}$/.test(input.outcome)) || input.state === 'closed' && input.outcome === undefined) throw fail('MEDIA_JOB_REQUEST');
        // A settled telling stays settled, and a job with nothing to tell has no telling.
        if (!FINISHED.includes(job.status) || ['closed', 'none'].includes(job.notice.state)) return { id: job.id, notice: job.notice.state };
        job.notice = { state: input.state, ...(input.outcome === undefined ? {} : { outcome: input.outcome }), at: clock() };
        // Never to be told (the conversation, the person or the source is gone): the result goes too.
        if (input.state === 'closed' && input.outcome.startsWith('dropped:')) job.result = null;
        save();
        return { id: job.id, notice: job.notice.state };
      }
      throw fail('MEDIA_JOB_REQUEST');
    },
    sweep,
    /** Stops the worker; a running job is left for the next start to find interrupted. */
    async close() {
      closed = true;
      for (const wake of [...sleepers]) wake();
      current?.controller.abort(fail('closing'));
      while (working) await new Promise(resolve => setTimeout(resolve, 5));
    },
  };
}
