import fs from 'node:fs/promises';
import net from 'node:net';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A job nobody asked about any more: an async one after 72 hours (a task may run two days and its files
 * stay a day), a sync one (its files are held in memory) after one hour. */
export const JOB_TTL_MS = { async: 72 * 3600000, sync: 3600000 };
export const MAX_JOBS = 64;
const ANSWER_LIMIT = 32 * 1024 * 1024, FILE_LIMIT = 64 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, extra) => Object.assign(new Error(code), { code }, extra);
const validKey = key => typeof key === 'string' && /^[\x21-\x7e]{1,4096}$/.test(key);
const micros = value => Number.isSafeInteger(value) && value >= 0;
const MEDIA = /^(?:image|audio|video)\/[a-z0-9.+-]{1,40}$/;
const CODES = ['INVALID_REQUEST', 'NOT_FOUND', 'WORLD_PAUSED', 'UNCONFIGURED', 'UNAVAILABLE', 'UPSTREAM_AUTH', 'UPSTREAM_LIMIT', 'UPSTREAM_ERROR', 'CANCELLED', 'BUDGET_EXHAUSTED', 'SPEND_RESTRICTED'];

async function readPrivate(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) throw new Error('Unsafe gateway file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function writePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function boundedJson(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw failure('UPSTREAM_ERROR');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) { await reader.cancel(); throw failure('UPSTREAM_ERROR'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('UPSTREAM_ERROR'); }
  } finally { reader.releaseLock(); }
}

/** The adapters as a checked table. Throws on one that does not have the shape in providers/index.mjs. */
function checked(adapters, capabilities) {
  const declared = new Map(capabilities.map(item => [item.id, item])), fn = value => typeof value === 'function';
  if (!Array.isArray(adapters) || new Set(adapters.map(adapter => adapter?.id)).size !== adapters.length) throw new Error('Invalid provider adapters');
  for (const adapter of adapters) {
    if (!object(adapter) || typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(adapter.id) || adapter.id === 'deepseek' || typeof adapter.title !== 'string' || !adapter.title || adapter.title.length > 40
      || !Array.isArray(adapter.hosts) || !adapter.hosts.length || adapter.hosts.some(host => typeof host !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || net.isIP(host)) || typeof adapter.proxy !== 'boolean' || !object(adapter.operations)) throw new Error('Invalid provider adapter');
    for (const [name, operation] of Object.entries(adapter.operations)) {
      const meter = /^[a-z][a-z0-9-]*\.[a-z]+$/.test(name) ? declared.get(name.split('.')[0])?.meter : null;
      // Counted and charged at this exit: a gateway-counted capability with a spend category of its own.
      if (meter?.source !== 'gateway' || !meter.spendCategory || meter.legacyCounter || !object(operation) || !['sync', 'async'].includes(operation.mode)
        || ![operation.estimate, operation.submit, operation.submitted].every(fn) || (operation.mode === 'async' && ![operation.poll, operation.polled].every(fn))) throw new Error(`Invalid provider operation ${adapter.id} ${name}`);
    }
  }
  return { byId: new Map(adapters.map(adapter => [adapter.id, adapter])), meterOf: operation => declared.get(operation.split('.')[0]).meter };
}

/**
 * Provider keys and the three actions every adapter operation is reached through: submit, status, fetch.
 * Keys live in `providers.json` (0600, atomic) next to the settings file and never leave this module:
 * `list()` says only whether one is set. Each submit reserves its estimate with the spend meter, takes a
 * daily slot of its capability and is written to the usage ledger when it ends. Async jobs are kept in
 * `provider-jobs.json` (ids only: no key, no input, no result) so that a restart can still ask about them.
 * No earlier release reads either file.
 *
 * `track(controller)` registers an upstream request for cancellation and returns the function that ends it.
 */
export function createProviders({ directory, adapters, capabilities, spend, ledger, world, fetchImpl, proxyFetch, track, clock = Date.now }) {
  const { byId, meterOf } = checked(adapters, capabilities);
  const keysFile = path.join(directory, 'providers.json'), jobsFile = path.join(directory, 'provider-jobs.json');
  let keys = {}, keysReadable = true, queue = Promise.resolve();
  const jobs = new Map();
  const serial = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  const note = (operation, entry) => { void ledger.record(operation.split('.')[0], entry).catch(() => {}); };
  const persistJobs = () => serial(() => writePrivate(jobsFile, { schema: 1, jobs: [...jobs.values()].filter(job => job.task).map(({ id, provider, operation, task, at, state }) => ({ id, provider, operation, task, at, state })) })).catch(() => {});

  function changeKey(id, key) {
    if (!byId.has(id) || (key !== null && !validKey(key))) return Promise.reject(failure('INVALID_REQUEST'));
    return serial(async () => {
      // A file this release could not read is never overwritten: it may hold keys a newer release stored.
      if (!keysReadable) throw failure('UNAVAILABLE');
      const next = { ...keys };
      if (key === null) delete next[id]; else next[id] = key;
      await writePrivate(keysFile, { schema: 1, keys: next });
      keys = next;
    });
  }
  /** One request an adapter built, to one of its own hosts; `consume(response)` reads the answer within the same
   * deadline and cancellation. A refusal by the provider carries `refused: true`. */
  async function exchange(adapter, request, timeoutMs, res, consume) {
    let url;
    try {
      url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || !adapter.hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error();
    } catch { throw failure('UPSTREAM_ERROR', { refused: true }); }
    const controller = new AbortController(), untrack = track(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res?.on('close', disconnected);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (adapter.proxy && proxyFetch ? proxyFetch : fetchImpl)(url.href, { method: request.method ?? 'GET', redirect: 'error', signal: controller.signal, headers: { ...request.headers }, ...(request.body === undefined ? {} : { body: request.body }) });
      if (!response.ok) { await response.body?.cancel(); throw failure(response.status === 401 || response.status === 403 ? 'UPSTREAM_AUTH' : response.status === 429 ? 'UPSTREAM_LIMIT' : 'UPSTREAM_ERROR', { refused: true }); }
      return await consume(response);
    } catch (error) {
      if (CODES.includes(error.code)) throw error;
      throw failure(controller.signal.aborted ? 'CANCELLED' : 'UPSTREAM_ERROR');
    } finally { clearTimeout(timer); res?.off('close', disconnected); untrack(); }
  }
  const json = response => boundedJson(response, ANSWER_LIMIT);
  /** What an adapter made of an answer, checked. */
  function outcome(adapter, read, json, key, pendingAllowed) {
    let value; try { value = read(json, key); } catch { throw failure('UPSTREAM_ERROR'); }
    if (!object(value)) throw failure('UPSTREAM_ERROR');
    if (value.state === 'failed') return { state: 'failed' };
    if (value.state === 'pending' && pendingAllowed) return { state: 'pending', task: value.task };
    if (value.state !== 'done' || !Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 8 || (value.costMicros !== undefined && !micros(value.costMicros)) || (value.units !== undefined && !object(value.units))) throw failure('UPSTREAM_ERROR');
    const outputs = value.outputs.map(output => {
      if (object(output) && typeof output.base64 === 'string' && MEDIA.test(output.mime)) { const bytes = Buffer.from(output.base64, 'base64'); if (bytes.length) return { bytes, mime: output.mime }; }
      if (object(output) && typeof output.url === 'string' && (output.headers === undefined || object(output.headers))) return { url: output.url, headers: output.headers };
      throw failure('UPSTREAM_ERROR');
    });
    return { state: 'done', outputs, costMicros: value.costMicros, units: value.units };
  }
  /** A pending job ended: settle its reservation and write the ledger line. A job taken over from before a
   * restart has no reservation any more; the spend meter charged it in full when it started again. */
  async function conclude(job, result) {
    const reservation = job.reservation, done = result.state === 'done';
    job.reservation = undefined;
    const declared = meterOf(job.operation).units, units = Object.fromEntries(Object.entries(result.units ?? {}).filter(([unit, value]) => declared.includes(unit) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e7));
    const charged = reservation ? await spend.settle(reservation, done ? result.costMicros ?? reservation.amount : 0, { charge: done }).catch(() => undefined) : undefined;
    note(job.operation, { outcome: done ? 'ok' : 'failed', busyMs: Math.min(86400000, Math.max(0, Math.round(clock() - job.at))), ...(charged ? { costMicros: charged } : {}), ...(done ? { units } : {}) });
    job.state = result.state; job.outputs = done ? result.outputs : undefined;
    if (job.task) await persistJobs();
  }
  /** Ask the provider about an async job: one upstream request, nothing when it is still running. */
  async function refresh(job) {
    const adapter = byId.get(job.provider), operation = adapter?.operations[job.operation];
    if (operation?.mode !== 'async') throw failure('UNAVAILABLE');
    const key = keys[adapter.id]; if (!key) throw failure('UNCONFIGURED');
    let request; try { request = operation.poll(job.task, key); } catch { throw failure('UPSTREAM_ERROR'); }
    const result = outcome(adapter, operation.polled, await exchange(adapter, request, 30000, undefined, json), key, true);
    if (result.state === 'pending') return;
    if (job.state === 'pending') await conclude(job, result);
    else if (result.state === 'done') job.outputs = result.outputs;
  }
  /** Drop the jobs nobody asked about for too long. One still pending is charged: the provider may have run it. */
  async function sweep() {
    let dropped = false;
    for (const job of [...jobs.values()]) {
      if (clock() - job.at < (job.task ? JOB_TTL_MS.async : JOB_TTL_MS.sync)) continue;
      jobs.delete(job.id); dropped ||= Boolean(job.task);
      if (job.state !== 'pending') continue;
      const charged = job.reservation ? await spend.settle(job.reservation, job.reservation.amount).catch(() => undefined) : undefined;
      if (byId.get(job.provider)?.operations[job.operation]) note(job.operation, { outcome: 'failed', ...(charged ? { costMicros: charged } : {}) });
    }
    if (dropped) await persistJobs();
  }
  /** One at a time per job: two callers asking about the same job settle it once. */
  function withJob(id, action) {
    const job = typeof id === 'string' ? jobs.get(id) : undefined;
    if (!job) return Promise.reject(failure('NOT_FOUND'));
    const next = (job.queue ?? Promise.resolve()).then(() => action(job));
    job.queue = next.catch(() => {});
    return next;
  }
  const view = job => ({ job: job.id, operation: job.operation, state: job.state, outputs: job.outputs?.length ?? 0 });
  async function current(job) {
    if ((await world()).paused) throw failure('WORLD_PAUSED');
    // A finished job read back after a restart has lost its file list: the provider is asked for it again.
    if (job.state === 'pending' || (job.state === 'done' && !job.outputs)) await refresh(job);
    return job;
  }

  return {
    async start() {
      try {
        const stored = await readPrivate(keysFile, 65536);
        if (stored?.schema !== 1 || !object(stored.keys) || !Object.values(stored.keys).every(validKey)) throw new Error('Invalid provider keys file');
        keys = stored.keys;
      } catch (error) { if (error.code !== 'ENOENT') keysReadable = false; }
      try {
        const stored = await readPrivate(jobsFile, 262144);
        for (const job of stored?.schema === 1 && Array.isArray(stored.jobs) ? stored.jobs : []) {
          if (object(job) && [job.id, job.provider, job.operation, job.task].every(value => typeof value === 'string' && value && value.length <= 512) && Number.isSafeInteger(job.at) && ['pending', 'done', 'failed'].includes(job.state)) jobs.set(job.id, { id: job.id, provider: job.provider, operation: job.operation, task: job.task, at: job.at, state: job.state });
        }
      } catch {}
      await sweep();
    },
    /** The adapters and whether each has a key. Never the key, its length or a part of it. */
    list: () => adapters.map(adapter => ({ id: adapter.id, title: adapter.title, configured: Boolean(keys[adapter.id]), operations: Object.entries(adapter.operations).map(([name, operation]) => ({ name, mode: operation.mode })) })),
    setKey: (id, key) => validKey(key) ? changeKey(id, key) : Promise.reject(failure('INVALID_REQUEST')),
    clearKey: id => changeKey(id, null),
    /** `{operation, input}` -> `{job, operation, state, outputs}`; `state` is `done` for a sync operation. */
    async submit(body, res) {
      const { operation, input } = body;
      const offered = typeof operation === 'string' ? adapters.filter(adapter => Object.hasOwn(adapter.operations, operation)) : [];
      if (!offered.length || !object(input)) throw failure('INVALID_REQUEST');
      const meter = meterOf(operation), denied = reason => note(operation, { outcome: 'denied', reason });
      if ((await world()).paused) { denied('paused'); throw failure('WORLD_PAUSED'); }
      const adapter = offered.find(item => keys[item.id]);
      if (!adapter) { denied('not_configured'); throw failure('UNCONFIGURED'); }
      const spec = adapter.operations[operation], key = keys[adapter.id];
      let estimate, request;
      try { estimate = spec.estimate(input); request = spec.submit(input, key); } catch { throw failure('INVALID_REQUEST'); }
      if (!micros(estimate) || !object(request)) throw failure('UNAVAILABLE');
      await sweep();
      if (jobs.size >= MAX_JOBS) { denied('busy'); throw failure('UNAVAILABLE'); }
      // The spend tier refuses first, then the capability's own daily limit; a slot stays taken when the provider fails.
      const reservation = await spend.reserve(meter.spendCategory, () => estimate).catch(error => { if (error.code !== 'BUDGET_EXHAUSTED') throw error; denied('spend_tier'); throw failure('SPEND_RESTRICTED'); });
      const job = { id: randomUUID(), provider: adapter.id, operation, task: null, at: clock(), state: 'pending', reservation };
      let result, sent = false;
      try {
        await ledger.take(operation.split('.')[0]);
        if ((await world()).paused) { denied('paused'); throw failure('WORLD_PAUSED'); }
        sent = true;
        result = outcome(adapter, spec.submitted, await exchange(adapter, request, 300000, res, json), key, spec.mode === 'async');
        if (result.state === 'pending' && (typeof result.task !== 'string' || !result.task || result.task.length > 512)) throw failure('UPSTREAM_ERROR');
      } catch (error) {
        // Not sent, or refused by the provider: released. Anything unclear after the request left: charged.
        const charged = await spend.settle(reservation, reservation.amount, { charge: sent && !error.refused }).catch(() => undefined);
        if (sent) note(operation, { outcome: 'failed', ...(charged ? { costMicros: charged } : {}) });
        throw CODES.includes(error.code) ? error : failure('UNAVAILABLE');
      }
      jobs.set(job.id, job);
      if (result.state === 'pending') { job.task = result.task; await persistJobs(); }
      else await conclude(job, result);
      return view(job);
    },
    /** `{job}` -> `{job, operation, state, outputs}`; asks the provider while the job is pending. */
    status: body => withJob(body.job, async job => view(await current(job))),
    /** `{job, output}`: the bytes of one result file of a finished job, streamed to `res`. */
    fetch: (body, res) => withJob(body.job, async job => {
      const output = (await current(job)).state === 'done' && Number.isSafeInteger(body.output) ? job.outputs?.[body.output] : undefined;
      if (!output) throw failure('INVALID_REQUEST');
      const headers = mime => ({ 'content-type': mime, 'cache-control': 'no-store' });
      if (output.bytes) { res.writeHead(200, { ...headers(output.mime), 'content-length': output.bytes.length }); res.end(output.bytes); return; }
      const adapter = byId.get(job.provider);
      if (!adapter) throw failure('UNAVAILABLE');
      await exchange(adapter, { url: output.url, headers: output.headers }, 300000, res, async response => {
        if (!response.body) throw failure('UPSTREAM_ERROR');
        const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        let size = 0;
        const bounded = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > FILE_LIMIT ? failure('UPSTREAM_ERROR') : null, chunk); } });
        res.writeHead(200, headers(MEDIA.test(mime) ? mime : 'application/octet-stream'));
        await pipeline(Readable.fromWeb(response.body), bounded, res);
      });
    }),
    close: () => queue,
  };
}
