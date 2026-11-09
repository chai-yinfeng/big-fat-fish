import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// Money is kept in integer micro-yuan (1 CNY = 1e6) to avoid float drift.
const MICROS = 1_000_000;
const BEIJING_MS = 8 * 3600000; // Asia/Shanghai has no DST; independent of the host TZ.
export const CATEGORIES = Object.freeze(['conversation', 'maintenance', 'vision', 'web']);
export const DEFAULT_SPEND_SETTINGS = Object.freeze({ dailyCapYuan: 5, reducedPercent: 60, restrictedPercent: 80 });
/** DeepSeek official prices (CNY per 1M tokens; web per call), verified 2026-11-08 at
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing — peak is Beijing time
 * Mon–Fri 09:00–12:00 and 14:00–18:00 (statutory holidays are off-peak; list them
 * in `offPeakDates`), every other time is off-peak at half price. Vision has no
 * separate price; it is charged per call at a conservative estimate. */
export const DEFAULT_PRICING = Object.freeze({
  schema: 1, currency: 'CNY', source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', verifiedAt: '2026-11-08',
  peak: { weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], offPeakDates: [] },
  models: {
    'deepseek-flash': { peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } },
    'deepseek-v4-pro': { peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 } },
  },
  perCall: { web: 0.005, vision: 0.01 },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000;
const hhmm = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value);
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const beijingDay = ms => new Date(ms + BEIJING_MS).toISOString().slice(0, 10);
export const yuan = micros => Math.round(micros) / MICROS;

export function validPricing(value) {
  if (!object(value) || value.schema !== 1 || !object(value.peak) || !object(value.models) || !object(value.perCall)) return false;
  const { weekdays, windows, offPeakDates = [] } = value.peak;
  if (!Array.isArray(weekdays) || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return false;
  if (!Array.isArray(windows) || windows.length > 12 || windows.some(w => !Array.isArray(w) || w.length !== 2 || !hhmm(w[0]) || !hhmm(w[1]) || minutes(w[0]) >= minutes(w[1]))) return false;
  if (!Array.isArray(offPeakDates) || offPeakDates.length > 400 || offPeakDates.some(d => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) return false;
  const models = Object.entries(value.models);
  if (!models.length || models.some(([, m]) => !object(m) || ['peak', 'offPeak'].some(w => !object(m[w]) || !['cacheHit', 'cacheMiss', 'output'].every(k => price(m[w][k]))))) return false;
  return ['web', 'vision'].every(k => price(value.perCall[k]));
}
/** Missing file → verified defaults are written; unreadable/invalid file → every hour at peak price. */
function fallbackPricing() {
  const models = Object.fromEntries(Object.entries(DEFAULT_PRICING.models).map(([id, m]) => [id, { peak: m.peak, offPeak: m.peak }]));
  return { ...DEFAULT_PRICING, models };
}
export function isPeak(pricing, ms) {
  const local = new Date(ms + BEIJING_MS), day = local.toISOString().slice(0, 10), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if ((pricing.peak.offPeakDates || []).includes(day) || !pricing.peak.weekdays.includes(local.getUTCDay())) return false;
  return pricing.peak.windows.some(([from, to]) => minute >= minutes(from) && minute < minutes(to));
}
function modelPrices(pricing, model) {
  if (pricing.models[model]) return pricing.models[model];
  // Unknown model: the most expensive configured entry.
  return Object.values(pricing.models).sort((a, b) => b.peak.output - a.peak.output)[0];
}
/** Token usage from a DeepSeek response; output includes reasoning tokens. */
export function parseUsage(value) {
  if (!object(value)) return null;
  const n = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
  const prompt = n('prompt_tokens'), hit = n('prompt_cache_hit_tokens'), miss = n('prompt_cache_miss_tokens');
  let output = n('completion_tokens');
  const reasoning = object(value.completion_tokens_details) && Number.isSafeInteger(value.completion_tokens_details.reasoning_tokens) ? value.completion_tokens_details.reasoning_tokens : 0;
  if (output === null && prompt === null && hit === null && miss === null) return null;
  if (output === null) output = reasoning;
  const cacheHit = hit ?? 0, cacheMiss = miss ?? Math.max(0, (prompt ?? 0) - cacheHit);
  return { cacheHit, cacheMiss, output, reasoning };
}
export function usageCost(pricing, model, usage, at) {
  const p = modelPrices(pricing, model)[isPeak(pricing, at) ? 'peak' : 'offPeak'];
  // tokens × (CNY per 1M tokens) = micro-yuan.
  return Math.ceil(usage.cacheHit * p.cacheHit + usage.cacheMiss * p.cacheMiss + usage.output * p.output);
}
/** Conservative pre-call estimate: one token per prompt character at the miss price, plus max output. */
export function chatEstimate(pricing, model, body, maxTokens, at) {
  const p = modelPrices(pricing, model)[isPeak(pricing, at) ? 'peak' : 'offPeak'];
  const chars = JSON.stringify([body.messages ?? [], body.tools ?? []]).length;
  return Math.ceil(chars * p.cacheMiss + maxTokens * p.output);
}
export function validSpendSettings(value) {
  return object(value) && typeof value.dailyCapYuan === 'number' && Number.isFinite(value.dailyCapYuan) && value.dailyCapYuan >= 0.01 && value.dailyCapYuan <= 1000
    && [value.reducedPercent, value.restrictedPercent].every(v => typeof v === 'number' && Number.isFinite(v))
    && value.reducedPercent > 0 && value.reducedPercent < value.restrictedPercent && value.restrictedPercent < 100;
}
/** Passes body bytes through unchanged while reading `usage` from SSE `data:` lines or a JSON body. */
export function usageTap(streaming, onUsage) {
  const decoder = new StringDecoder('utf8'), whole = [];
  let buffer = '', size = 0;
  const scan = line => {
    if (!line.startsWith('data:') || !line.includes('"usage"')) return;
    try { const value = JSON.parse(line.slice(5)); if (object(value?.usage)) onUsage(value.usage); } catch {}
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (streaming) {
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { scan(buffer.slice(0, index).trim()); buffer = buffer.slice(index + 1); }
        if (buffer.length > 1048576) buffer = '';
      } else if (size <= 2 * 1048576) { size += chunk.length; whole.push(chunk); }
      callback(null, chunk);
    },
    flush(callback) {
      if (streaming) scan((buffer + decoder.end()).trim());
      else if (size <= 2 * 1048576) { try { const value = JSON.parse(Buffer.concat(whole).toString('utf8')); if (object(value?.usage)) onUsage(value.usage); } catch {} }
      callback();
    },
  });
}
async function readPrivate(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) throw new Error('Unsafe gateway file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function writePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const budgetError = () => Object.assign(new Error('The daily capability budget is exhausted'), { code: 'BUDGET_EXHAUSTED' });

/**
 * Daily spend meter (Beijing day). Reserve an estimate before a provider call, settle
 * after it (unreported usage charges the reservation). Tiers: ≥reduced% stops proactive
 * work, ≥restricted% stops maintenance/vision/web, ≥100% refuses everything.
 */
export function createSpendMeter({ stateFile, settingsFile, pricingFile, clock = Date.now }) {
  let settings = { ...DEFAULT_SPEND_SETTINGS }, pricing = DEFAULT_PRICING, pricingSource = 'default', queue = Promise.resolve();
  const fresh = day => ({ schema: 1, day, spentMicros: 0, reservedMicros: 0, byTier: Object.fromEntries(CATEGORIES.map(c => [c, 0])), calls: 0, unreported: 0 });
  let state = fresh(beijingDay(clock()));
  const reservations = new Map();
  const serial = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  function roll() {
    const day = beijingDay(clock());
    // In-flight reservations from the previous day are carried into (and settle in) the new day.
    if (state.day !== day) state = { ...fresh(day), reservedMicros: [...reservations.values()].reduce((sum, r) => sum + r.amount, 0) };
  }
  const percent = () => (state.spentMicros + state.reservedMicros) / (settings.dailyCapYuan * MICROS) * 100;
  function tier() {
    const used = percent();
    return used >= 100 ? 'exhausted' : used >= settings.restrictedPercent ? 'restricted' : used >= settings.reducedPercent ? 'reduced' : 'normal';
  }
  const ORDER = ['normal', 'reduced', 'restricted', 'exhausted'];
  // The first tier at which each kind of work is refused.
  const STOP = { proactive: 'reduced', maintenance: 'restricted', vision: 'restricted', web: 'restricted', conversation: 'exhausted' };
  async function loadPricing() {
    try { const value = await readPrivate(pricingFile); if (validPricing(value)) { pricing = value; pricingSource = 'file'; } else { pricing = fallbackPricing(); pricingSource = 'fallback'; } }
    catch (error) {
      if (error.code !== 'ENOENT') { pricing = fallbackPricing(); pricingSource = 'fallback'; return; }
      pricing = DEFAULT_PRICING; pricingSource = 'default';
      await writePrivate(pricingFile, DEFAULT_PRICING).catch(() => {});
    }
  }
  return {
    async start() {
      try { const stored = await readPrivate(settingsFile); if (validSpendSettings(stored)) settings = { dailyCapYuan: stored.dailyCapYuan, reducedPercent: stored.reducedPercent, restrictedPercent: stored.restrictedPercent }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        const stored = await readPrivate(stateFile);
        if (stored?.schema === 1 && typeof stored.day === 'string' && ['spentMicros', 'reservedMicros', 'calls', 'unreported'].every(k => Number.isSafeInteger(stored[k]) && stored[k] >= 0) && object(stored.byTier)) {
          // A reservation held across a restart is charged: its call may have been billed.
          state = { ...fresh(stored.day), ...stored, spentMicros: stored.spentMicros + stored.reservedMicros, reservedMicros: 0, byTier: { ...fresh(stored.day).byTier, ...stored.byTier } };
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      roll();
      await loadPricing();
    },
    status() {
      roll();
      return {
        day: state.day, timezone: 'Asia/Shanghai', spentYuan: yuan(state.spentMicros), reservedYuan: yuan(state.reservedMicros), capYuan: settings.dailyCapYuan,
        percent: Math.round(percent() * 10) / 10, tier: tier(), thresholds: { reducedPercent: settings.reducedPercent, restrictedPercent: settings.restrictedPercent, exhaustedPercent: 100 },
        byTier: Object.fromEntries(CATEGORIES.map(c => [c, yuan(state.byTier[c] ?? 0)])), calls: state.calls, unreportedUsage: state.unreported,
        window: isPeak(pricing, clock()) ? 'peak' : 'offPeak', pricing: pricingSource,
      };
    },
    settings: () => ({ ...settings }),
    updateSettings(input) {
      return serial(async () => {
        const next = { ...settings, ...input };
        if (!object(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULT_SPEND_SETTINGS, k)) || !validSpendSettings(next)) throw Object.assign(new Error('Invalid spend settings'), { code: 'INVALID_REQUEST' });
        await writePrivate(settingsFile, next);
        settings = next;
      });
    },
    /** `estimate(pricing, at)` returns micro-yuan. Throws BUDGET_EXHAUSTED when this kind of work is stopped. */
    reserve(category, estimate) {
      return serial(async () => {
        await loadPricing();
        roll();
        if (ORDER.indexOf(tier()) >= ORDER.indexOf(STOP[category])) throw budgetError();
        const at = clock(), amount = Math.max(0, Math.ceil(estimate(pricing, at)));
        const handle = { id: randomUUID(), category, amount, at, pricing };
        reservations.set(handle.id, handle);
        state = { ...state, reservedMicros: state.reservedMicros + amount };
        await writePrivate(stateFile, state);
        return handle;
      });
    },
    /** cost: micro-yuan (priced with handle.pricing at handle.at), or null when usage is unknown (charges the reservation). `charge:false` releases. */
    settle(handle, cost, { charge = true } = {}) {
      return serial(async () => {
        if (!reservations.delete(handle.id)) return;
        roll();
        const amount = charge ? (cost === null ? handle.amount : Math.ceil(cost)) : 0;
        state = {
          ...state, reservedMicros: Math.max(0, state.reservedMicros - handle.amount), spentMicros: state.spentMicros + amount,
          byTier: { ...state.byTier, [handle.category]: (state.byTier[handle.category] ?? 0) + amount },
          calls: state.calls + (charge ? 1 : 0), unreported: state.unreported + (charge && cost === null ? 1 : 0),
        };
        await writePrivate(stateFile, state);
      });
    },
    close: () => queue,
  };
}
