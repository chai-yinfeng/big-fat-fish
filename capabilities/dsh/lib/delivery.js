import { open, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const empty = () => ({ cursor: -1, recent: [], unavailable: [] });

/** Delivery metadata only: no persona, evidence text, actor binding or token. */
export function createDeliveryStore(file, sessionIds) {
  let document = { version: 1, streams: {} };
  let initialized;
  let tail = Promise.resolve();
  async function initialize() {
    if (!file) return;
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) throw fail('DELIVERY_STATE_INVALID');
      const buffer = Buffer.alloc(262145);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 262144) throw fail('DELIVERY_STATE_INVALID');
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (value?.version !== 1 || !value.streams || Array.isArray(value.streams) || typeof value.streams !== 'object' || Object.keys(value.streams).length > 64) throw fail('DELIVERY_STATE_INVALID');
      for (const entry of Object.values(value.streams)) {
        if (!Number.isSafeInteger(entry?.cursor) || entry.cursor < -1 || !Array.isArray(entry.recent) || entry.recent.length > 16 || !entry.recent.every(seq => integer(seq) && seq <= entry.cursor) || !Array.isArray(entry.unavailable) || entry.unavailable.length > 16 || !entry.unavailable.every(v => integer(v?.seq) && v.seq <= entry.cursor && ['EVIDENCE_LIMIT', 'WIRE_LIMIT', 'FORGOTTEN'].includes(v.reason))) throw fail('DELIVERY_STATE_INVALID');
      }
      document = { version: 1, streams: Object.fromEntries(Object.entries(value.streams).filter(([id]) => !sessionIds || sessionIds.includes(id))) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('DELIVERY_STATE_INVALID');
    } finally { await handle?.close(); }
  }
  const ready = () => initialized ||= initialize();
  return {
    async load(id) { await ready(); return structuredClone(Object.hasOwn(document.streams, id) ? document.streams[id] : empty()); },
    async save(id, entry) {
      const operation = tail.catch(() => {}).then(async () => {
        await ready();
        const next = { version: 1, streams: { ...document.streams, [id]: structuredClone(entry) } };
        if (Object.keys(next.streams).length > 64) throw fail('DELIVERY_STATE_LIMIT');
        if (file) {
          const temporary = `${file}.tmp-${randomUUID()}`;
          try {
            await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
            // Commit the cursor only after the complete metadata file is synced.
            const handle = await open(temporary, 'r');
            try { await handle.sync(); } finally { await handle.close(); }
            await rename(temporary, file);
          } catch { await unlink(temporary).catch(() => {}); throw fail('DELIVERY_STATE_UNAVAILABLE'); }
        }
        document = next;
      });
      tail = operation;
      await operation;
    },
  };
}

/** One incremental source cursor; failed unacked batches stay in the adapter. */
export async function createSessionDelivery({ adapter, session, store }) {
  const id = session.id;
  const eventId = seq => adapter.eventId ? adapter.eventId(id, session.eventAt(seq)) : `native:${seq}`;
  let acknowledged = await store.load(id);
  const own = session.ownEvents(); // exactly once per mount, not once per request
  if (!Number.isSafeInteger(session.seq) || session.seq < 0 || acknowledged.cursor >= session.seq || own.some(event => !session.isOwnSeq(event.seq))) throw fail('DELIVERY_SOURCE_INVALID');
  let scan = acknowledged.cursor + 1;
  let running;
  let disposed = false;
  for (const item of acknowledged.unavailable) adapter.unavailable(id, eventId(item.seq), item.reason);
  for (const seq of acknowledged.recent) {
    const event = session.eventAt(seq);
    if (!event || !session.isOwnSeq(seq)) throw fail('DELIVERY_SOURCE_INVALID');
    adapter.ingest(id, event); // reobserve source, never trust a cached observation ID
  }
  async function save(cursor, seq, unavailable) {
    const recent = seq === undefined ? acknowledged.recent.filter(n => n !== unavailable?.seq) : [...new Set([...acknowledged.recent, seq])].sort((a, b) => a - b).slice(-16);
    const excluded = unavailable ? [...acknowledged.unavailable.filter(v => v.seq !== unavailable.seq), unavailable].slice(-16) : acknowledged.unavailable;
    const next = { cursor: Math.max(acknowledged.cursor, cursor), recent, unavailable: excluded };
    await store.save(id, next);
    acknowledged = next;
  }
  const flush = () => adapter.flush(id, (seq, forgotten) => save(seq, forgotten ? undefined : seq, forgotten ? { seq, reason: 'FORGOTTEN' } : undefined));
  return {
    sync() {
      if (disposed) return Promise.reject(fail('DELIVERY_DISPOSED'));
      if (running) return running;
      running = (async () => {
        try {
          await flush();
          // A failed context/transport hid old refs; reconstruct only the recent
          // acknowledged source events, without rescanning historical messages.
          if (!adapter.references(id).length && !adapter.pendingCount(id)) {
            for (const seq of acknowledged.recent) {
              const event = session.eventAt(seq);
              if (!event || !session.isOwnSeq(seq)) throw fail('DELIVERY_SOURCE_INVALID');
              adapter.ingest(id, event);
            }
            await flush();
          }
          let batch = 0;
          while (scan < session.seq) {
            if (disposed) throw fail('DELIVERY_DISPOSED');
            const event = session.eventAt(scan);
            if (!event) throw fail('DELIVERY_SOURCE_INVALID');
            if (session.isOwnSeq(scan)) {
              try { adapter.ingest(id, event); } catch (error) {
                if (!['EVIDENCE_LIMIT', 'WIRE_LIMIT'].includes(error.code)) throw error;
                await flush();
                adapter.unavailable(id, eventId(scan), error.code);
                await save(scan, undefined, { seq: scan, reason: error.code });
              }
            }
            scan++; batch++;
            if (batch === 128) { await flush(); batch = 0; }
          }
          await flush();
          if (scan - 1 > acknowledged.cursor) await save(scan - 1);
        } catch (error) { adapter.clearContext(id); throw error; }
      })().finally(() => { running = undefined; });
      return running;
    },
    async dispose() { disposed = true; await running?.catch(() => {}); },
  };
}
