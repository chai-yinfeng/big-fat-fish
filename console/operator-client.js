// Browser-only transport. Never attach this bearer to the conversation executor or model tools.
export const TOKEN_KEY = 'companion-world:operator:v1';
// Only this operator access code may enter sessionStorage; never model credentials.
export function consumeOperatorFragment({ location, history, storage }) {
  if (!location.hash?.startsWith('#companion-operator=')) return false;
  const token = location.hash.slice('#companion-operator='.length);
  try {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return false;
    storage.setItem(TOKEN_KEY, token);
    return true;
  } catch { return false; }
  finally { history.replaceState(history.state, '', `${location.pathname}${location.search}`); }
}
export function modelPayload(model, apiKey = '') {
  return { model: model.trim(), ...(apiKey === '' ? {} : { apiKey }) };
}
export function validModel(value) {
  return value?.provider === 'deepseek' && typeof value.model === 'string'
    && typeof value.configured === 'boolean' && ['unconfigured', 'configured', 'verified', 'error'].includes(value.status)
    && (value.configured ? value.status !== 'unconfigured' : value.status === 'unconfigured')
    && (value.lastTest === undefined || (typeof value.lastTest?.ok === 'boolean' && Number.isFinite(value.lastTest.at)
      && (value.lastTest.code === undefined || typeof value.lastTest.code === 'string')));
}
export function qqPayload(allowedCallerUID) {
  const uid = allowedCallerUID.trim();
  if (!/^[0-9]+$/.test(uid)) throw Object.assign(new Error('invalid_qq_uid'), { code: 'invalid_qq_uid' });
  return { allowedCallerUID: uid };
}
/** Daily cap (CNY) and tier percentages: 0 < reduced < restricted < 100 (exhausted is always 100%). */
export function spendPayload(draft) {
  const value = { dailyCapYuan: Number(draft?.dailyCapYuan), reducedPercent: Number(draft?.reducedPercent), restrictedPercent: Number(draft?.restrictedPercent) };
  if (!(value.dailyCapYuan >= 0.01 && value.dailyCapYuan <= 1000) || !(value.reducedPercent > 0 && value.reducedPercent < value.restrictedPercent && value.restrictedPercent < 100)) {
    throw Object.assign(new Error('invalid_spend_settings'), { code: 'invalid_spend_settings' });
  }
  return value;
}
export function validSpend(value) {
  return value && typeof value.day === 'string' && ['spentYuan', 'reservedYuan', 'capYuan', 'percent'].every(key => Number.isFinite(value[key]))
    && ['normal', 'reduced', 'restricted', 'exhausted'].includes(value.tier) && Number.isFinite(value.thresholds?.reducedPercent) && Number.isFinite(value.thresholds?.restrictedPercent)
    && value.byTier && typeof value.byTier === 'object';
}
/** One capability's daily limit: a whole number of 0–1000, or null to return to its default. */
export function limitsPayload(id, value) {
  const limit = value === null ? null : Number(value);
  if (typeof id !== 'string' || !id || limit !== null && (String(value).trim() === '' || !Number.isSafeInteger(limit) || limit < 0 || limit > 1000)) throw Object.assign(new Error('invalid_usage_limit'), { code: 'invalid_usage_limit' });
  return { limits: { [id]: limit } };
}
const usageNumbers = row => ['used', 'calls', 'ok', 'failed', 'busyMs', 'costYuan'].every(key => Number.isFinite(row?.[key])) && (row.limit === null || Number.isFinite(row.limit))
  && row.denied && typeof row.denied === 'object' && row.units && typeof row.units === 'object';
/** GET /usage: today's row per capability (model-gateway usage ledger). */
export function validUsage(value) {
  return value && typeof value.day === 'string' && Array.isArray(value.rows) && value.rows.every(row => typeof row.id === 'string' && typeof row.title === 'string' && ['paid', 'local'].includes(row.kind) && usageNumbers(row)
    && (row.limitDefault === null || Number.isFinite(row.limitDefault)));
}
/** GET /usage/history: finished days, newest first; a day lists only the capabilities that were used. */
export function validUsageHistory(value) {
  return value && Array.isArray(value.days) && value.days.every(day => typeof day.day === 'string' && day.rows && typeof day.rows === 'object' && Object.values(day.rows).every(usageNumbers));
}
export function validPeople(value) {
  return value && Array.isArray(value.people) && value.people.every(p => typeof p.personId === 'string' && typeof p.label === 'string' && typeof p.owner === 'boolean' && Array.isArray(p.actors))
    && Number.isFinite(value.limit) && Number.isFinite(value.admitted);
}
export function validConversations(value) {
  return Array.isArray(value) && value.every(c => typeof c.streamId === 'string' && typeof c.label === 'string' && typeof c.audience === 'string' && Number.isFinite(c.messages));
}
/** A QQ number shown only partially (first two and last two digits). */
export function maskAccount(externalActorId) {
  const uid = /:user:(\d+)$/.exec(externalActorId || '')?.[1];
  return uid ? (uid.length <= 4 ? '****' : uid.slice(0, 2) + '*'.repeat(uid.length - 4) + uid.slice(-2)) : '—';
}
export function validQQ(value) {
  return value && ['loggedIn', 'connected', 'configured', 'callerConfigured', 'paused'].every(key => typeof value[key] === 'boolean')
    && (value.sessionId === undefined || typeof value.sessionId === 'string');
}
export function operatorOrigin(location, { sameOrigin = false } = {}) {
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)) {
    throw Object.assign(new Error('loopback_required'), { code: 'loopback_required' });
  }
  const host = location.hostname === '::1' ? '[::1]' : location.hostname;
  if (sameOrigin) return `http://${host}${location.port ? ':' + location.port : ''}`;
  return `http://${host}:3082`;
}
// Authority operator codes (never its message) mapped to localized console codes.
const SERVER_ERRORS = { VALIDATION_ERROR: 'validation_error', INVALID_REQUEST: 'invalid_request', BODY_TOO_LARGE: 'body_too_large', OPERATION_FAILED: 'operation_failed', CONFLICT: 'revision_conflict' };
/** Read-only query of GET /memory: one owner (opaque label or "none") and the page cursor. Never a raw person ID. */
export function memoryQuery({ person, beforeRevision } = {}) {
  if (person !== undefined && !/^(p-[0-9a-f]{6}|none)$/.test(person) || beforeRevision !== undefined && !(Number.isSafeInteger(beforeRevision) && beforeRevision >= 0)) throw new Error('invalid_memory_query');
  const query = new URLSearchParams({ ...(person === undefined ? {} : { person }), ...(beforeRevision === undefined ? {} : { beforeRevision: String(beforeRevision) }) }).toString();
  return query ? `?${query}` : '';
}
/** Read-only query of GET /memory/sources: the one memory item whose source observations are read. */
export function sourcesQuery({ id } = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid_memory_query');
  return `?${new URLSearchParams({ id }).toString()}`;
}
export async function operatorRequest({ location, token, path, payload, query, fetchImpl = fetch, signal, sameOrigin = false }) {
  if (!token) throw Object.assign(new Error('authorization_required'), { code: 'authorization_required' });
  if (!['/world', '/world/pause', '/persona', '/persona/preview', '/model', '/model/test', '/qq', '/memory', '/memory/consolidation', '/memory/sources', '/memory/retention', '/memory/public', '/diary/publish', '/memory/forget-preview', '/memory/forget', '/memory/cleanup/pending', '/runtime', '/speech', '/voice/reference', '/voice/reference/remove', '/voice/default', '/voice/test', '/people', '/conversations', '/spend', '/spend/settings', '/usage', '/usage/history', '/usage/limits'].includes(path)) throw new Error('unsupported_operator_path');
  if (['/model', '/model/test', '/spend/settings', '/usage/limits', '/speech', '/voice/reference', '/voice/reference/remove', '/voice/default', '/voice/test'].includes(path) && payload === undefined) throw new Error('operator_post_required');
  if (['/runtime', '/people', '/conversations', '/spend', '/usage', '/usage/history', '/memory/consolidation', '/memory/sources'].includes(path) && payload !== undefined) throw new Error('operator_get_required');
  if (query !== undefined && (!['/memory', '/memory/sources'].includes(path) || payload !== undefined) || path === '/memory/sources' && query === undefined) throw new Error('operator_query_unsupported');
  const response = await fetchImpl(`${operatorOrigin(location, { sameOrigin })}${path}${query === undefined ? '' : path === '/memory/sources' ? sourcesQuery(query) : memoryQuery(query)}`, {
    method: payload === undefined ? 'GET' : 'POST',
    mode: sameOrigin ? 'same-origin' : 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: signal || AbortSignal.timeout(12000),
  });
  let body;
  try { body = await response.json(); } catch { throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' }); }
  if (!response.ok || body?.ok !== true) {
    // Do not echo a remote message: it could reflect the credential or request headers.
    const code = response.status === 401 || response.status === 403 ? 'authorization_required'
      : response.status === 409 ? 'revision_conflict'
      : typeof body?.error?.code === 'string' && /^[a-z_]{1,64}$/.test(body.error.code) ? body.error.code
      : Object.hasOwn(SERVER_ERRORS, body?.error?.code) ? SERVER_ERRORS[body.error.code] : 'request_failed';
    throw Object.assign(new Error(code), { code, status: response.status });
  }
  return body.value;
}
const PERSONA_TEXT = ['name', 'userCallName', 'identity', 'speechStyle', 'relationshipStage'], PERSONA_LISTS = ['traits', 'boundaries', 'principles'];
export const PERSONA_FIELDS = [...PERSONA_TEXT, ...PERSONA_LISTS, 'examples'];
export function personaPatch(draft) {
  const patch = {};
  for (const key of PERSONA_TEXT) patch[key] = draft[key] || '';
  for (const key of PERSONA_LISTS) patch[key] = (draft[key] || '').split('\n').map(line => line.trim()).filter(Boolean);
  patch.examples = (draft.examples || []).map(({ user, assistant }) => ({ user: user || '', assistant: assistant || '' }));
  return patch;
}
export function personaDraft(value) {
  return Object.fromEntries(PERSONA_FIELDS.map(key => [key, key === 'examples'
    ? (Array.isArray(value.examples) ? value.examples : []).map(({ user, assistant }) => ({ user: user || '', assistant: assistant || '' }))
    : Array.isArray(value[key]) ? value[key].join('\n') : value[key] || '']));
}
/** Export format: the persona fields as pretty JSON, the same shape import accepts. */
export function personaExport(draft) {
  return JSON.stringify(personaPatch(draft), null, 2) + '\n';
}
/** Import a persona file into an editor draft; omitted fields take the default persona's values. Saving stays explicit. */
export function personaImport(source, defaults) {
  let value;
  try { value = JSON.parse(source); } catch { value = null; }
  if (value?.persona && typeof value.persona === 'object') value = value.persona;
  const bad = !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !PERSONA_FIELDS.includes(key))
    || PERSONA_TEXT.some(key => key in value && typeof value[key] !== 'string')
    || PERSONA_LISTS.some(key => key in value && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string')))
    || ('examples' in value && (!Array.isArray(value.examples) || value.examples.some(item => typeof item?.user !== 'string' || typeof item?.assistant !== 'string')));
  if (bad) throw Object.assign(new Error('invalid_persona_file'), { code: 'invalid_persona_file' });
  return personaDraft({ ...defaults, ...value });
}
export function validWorld(value) {
  return value && typeof value.world?.paused === 'boolean' && Number.isSafeInteger(value.world.revision)
    && Number.isSafeInteger(value.persona?.revision) && value.persona.value && value.counts
    && ['facts', 'notes', 'experiences', 'pending'].every(key => Number.isFinite(value.counts[key]))
    && Array.isArray(value.channels) && Array.isArray(value.bindings) && validModel(value.model);
}
