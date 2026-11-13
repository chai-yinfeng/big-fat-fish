import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beijingDay, yuan } from './spend.mjs';

/** Why a call was refused before it ran. */
export const DENIAL_REASONS = Object.freeze(['daily_limit', 'spend_tier', 'paused', 'quiet_hours', 'cooldown', 'not_configured', 'busy', 'blocked']);
export const HISTORY_DAYS = 90;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => failure('INVALID_REQUEST', 'Invalid usage report');

async function readPrivate(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) throw new Error('Unsafe gateway file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function writePrivate(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/**
 * Daily usage ledger (Beijing day): per declared capability, how often it was tried, how it ended,
 * why it was refused, its own units, what it cost and how long it took. It only observes and shows;
 * money stays with the spend meter (spend.json), and a capability with a `legacyCounter` keeps its
 * daily count where it was (`external(day)` reads it).
 *
 * Files in `directory`: usage-ledger.json (today), usage-history.jsonl (one line per finished day,
 * the newest HISTORY_DAYS kept) and usage-limits.json (operator overrides of daily limits). No older
 * release reads them. An unreadable or invalid file is started afresh: it never stops the gateway.
 */
export function createUsageLedger({ directory, capabilities, defaults = {}, external = () => ({}), clock = Date.now }) {
  const stateFile = path.join(directory, 'usage-ledger.json'), historyFile = path.join(directory, 'usage-history.jsonl'), limitsFile = path.join(directory, 'usage-limits.json');
  const declared = new Map(capabilities.map(item => [item.id, item]));
  const emptyRow = () => ({ calls: 0, ok: 0, failed: 0, reserved: 0, denied: {}, units: {}, costMicros: 0, busyMs: 0 });
  const fresh = day => ({ schema: 1, day, rows: {} });
  let state = fresh(beijingDay(clock())), overrides = {}, queue = Promise.resolve();
  const serial = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  const adjustable = id => declared.get(id)?.meter.dailyLimit != null;
  const limitOf = id => !adjustable(id) ? null : overrides[id] ?? defaults[id] ?? declared.get(id).meter.dailyLimit;
  /** One capability's numbers as shown: `used` is what counts against `limit`. */
  function shown(id, row = emptyRow(), day = state.day) {
    const { meter } = declared.get(id), limit = limitOf(id);
    const used = meter.legacyCounter ? external(day)[id] ?? 0 : limit === null ? row.calls : row.reserved;
    return { used, limit, calls: row.calls, ok: row.ok, failed: row.failed, denied: { ...row.denied }, units: { ...row.units }, costMicros: row.costMicros, busyMs: row.busyMs };
  }
  function storedRow(value) {
    if (!object(value) || !['calls', 'ok', 'failed', 'reserved', 'costMicros', 'busyMs'].every(key => count(value[key])) || !object(value.denied) || !object(value.units)) return null;
    return {
      ...emptyRow(), ...Object.fromEntries(['calls', 'ok', 'failed', 'reserved', 'costMicros', 'busyMs'].map(key => [key, value[key]])),
      denied: Object.fromEntries(Object.entries(value.denied).filter(([reason, n]) => DENIAL_REASONS.includes(reason) && count(n))),
      units: Object.fromEntries(Object.entries(value.units).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0)),
    };
  }
  async function historyLines() {
    try { return (await readPrivate(historyFile, 1048576)).split('\n').flatMap(line => { try { const value = JSON.parse(line); return object(value) && typeof value.day === 'string' && object(value.rows) ? [value] : []; } catch { return []; } }); }
    catch { return []; }
  }
  /** A new Beijing day: the finished day becomes one history line, today starts empty. */
  async function roll() {
    const day = beijingDay(clock());
    if (state.day === day) return;
    const finished = state;
    state = fresh(day);
    const rows = Object.fromEntries([...declared.keys()].map(id => [id, shown(id, finished.rows[id], finished.day)]).filter(([, row]) => row.used || row.calls || Object.keys(row.denied).length));
    if (!Object.keys(rows).length) return;
    const lines = [...(await historyLines()).filter(line => line.day !== finished.day), { day: finished.day, rows }].slice(-HISTORY_DAYS);
    await writePrivate(historyFile, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  }
  /** Apply `change(row)` to today's row of `id` and persist. */
  async function update(id, change) {
    // A day that cannot be archived still starts: counting today matters more than yesterday's line.
    await roll().catch(() => {});
    const row = state.rows[id] ?? emptyRow(), result = change(row);
    state = { ...state, rows: { ...state.rows, [id]: row } };
    await writePrivate(stateFile, JSON.stringify(state));
    return result;
  }
  function entryOf(input) {
    const { outcome, reason, units = {}, busyMs = 0, costMicros = 0 } = input;
    if (!['ok', 'failed', 'denied'].includes(outcome) || (outcome === 'denied' ? !DENIAL_REASONS.includes(reason) : reason !== undefined)
      || !count(busyMs) || busyMs > 86400000 || !count(costMicros) || !object(units)
      || Object.values(units).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e7)) throw invalid();
    return { outcome, reason, units, busyMs, costMicros };
  }
  function record(id, input) {
    if (!declared.has(id) || !object(input)) return Promise.reject(invalid());
    let entry; try { entry = entryOf(input); } catch (error) { return Promise.reject(error); }
    if (Object.keys(entry.units).some(unit => !declared.get(id).meter.units.includes(unit))) return Promise.reject(invalid());
    return serial(() => update(id, row => {
      if (entry.outcome === 'denied') { row.denied[entry.reason] = (row.denied[entry.reason] ?? 0) + 1; return; }
      row.calls++; row[entry.outcome]++; row.busyMs += entry.busyMs; row.costMicros += entry.costMicros;
      for (const [unit, value] of Object.entries(entry.units)) row.units[unit] = Math.round(((row.units[unit] ?? 0) + value) * 1000) / 1000;
    }));
  }
  const view = () => ({
    day: state.day, timezone: 'Asia/Shanghai',
    rows: [...declared.values()].map(({ id, title, meter }) => {
      const { costMicros, ...row } = shown(id, state.rows[id]);
      return { id, title, kind: meter.kind, unit: meter.unit, ...row, limitDefault: adjustable(id) ? defaults[id] ?? meter.dailyLimit : null, costYuan: yuan(costMicros), spendCategory: meter.spendCategory, stopTier: meter.stopTier };
    }),
  });
  return {
    async start() {
      try {
        const stored = JSON.parse(await readPrivate(limitsFile, 16384));
        if (stored?.schema === 1 && object(stored.limits)) overrides = Object.fromEntries(Object.entries(stored.limits).filter(([id, value]) => adjustable(id) && count(value) && value <= 1000));
      } catch {}
      try {
        const stored = JSON.parse(await readPrivate(stateFile, 262144));
        if (stored?.schema === 1 && typeof stored.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored.day) && object(stored.rows)) {
          state = { schema: 1, day: stored.day, rows: Object.fromEntries(Object.entries(stored.rows).filter(([id]) => declared.has(id)).map(([id, row]) => [id, storedRow(row)]).filter(([, row]) => row)) };
        }
      } catch {}
      await serial(() => roll().catch(() => {}));
    },
    /** Today's effective daily limit of a capability (null: none). */
    limit: limitOf,
    /** Counted by the gateway itself at its own exits. `costMicros` is what the spend meter charged. */
    record,
    /** What another process reports about a capability it runs (`source: 'reported'`); it cannot report money. */
    report(input) {
      if (!object(input) || Object.keys(input).some(key => !['capability', 'outcome', 'reason', 'units', 'busyMs'].includes(key)) || declared.get(input.capability)?.meter.source !== 'reported') return Promise.reject(invalid());
      const { capability, ...entry } = input;
      return record(capability, entry);
    },
    /** Take one of today's slots of a reported capability with a daily limit; BUDGET_EXHAUSTED when none is left. */
    reserve(id) {
      if (declared.get(id)?.meter.source !== 'reported') return Promise.reject(invalid());
      return serial(async () => {
        const taken = await update(id, row => {
          const limit = limitOf(id);
          if (limit !== null && row.reserved >= limit) { row.denied.daily_limit = (row.denied.daily_limit ?? 0) + 1; return false; }
          row.reserved++; return true;
        });
        if (!taken) throw failure('BUDGET_EXHAUSTED', 'The daily capability budget is exhausted');
      });
    },
    /** `{ id: integer 0–1000 | null }`; null returns a capability to its default. Only capabilities declared with a daily limit. */
    setLimits(input) {
      return serial(async () => {
        if (!object(input) || !Object.keys(input).length || Object.entries(input).some(([id, value]) => !adjustable(id) || value !== null && !(count(value) && value <= 1000))) throw failure('INVALID_REQUEST', 'Invalid usage limits');
        const next = { ...overrides };
        for (const [id, value] of Object.entries(input)) { if (value === null) delete next[id]; else next[id] = value; }
        await writePrivate(limitsFile, JSON.stringify({ schema: 1, limits: next }, null, 2));
        overrides = next;
      });
    },
    status: () => serial(async () => { await roll().catch(() => {}); return view(); }),
    /** The newest `days` finished days, newest first. */
    history(days = 7) {
      if (!Number.isSafeInteger(days) || days < 1 || days > HISTORY_DAYS) return Promise.reject(failure('INVALID_REQUEST', 'Invalid usage history request'));
      return serial(async () => {
        await roll().catch(() => {});
        const lines = (await historyLines()).slice(-days).reverse();
        return { timezone: 'Asia/Shanghai', days: lines.map(line => ({ day: line.day, rows: Object.fromEntries(Object.entries(line.rows).filter(([id, row]) => declared.has(id) && object(row)).map(([id, { costMicros, ...row }]) => [id, { ...row, costYuan: yuan(count(costMicros) ? costMicros : 0) }])) })) };
      });
    },
    close: () => queue,
  };
}
