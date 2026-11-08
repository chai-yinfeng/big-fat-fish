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
export async function operatorRequest({ location, token, path, payload, fetchImpl = fetch, signal, sameOrigin = false }) {
  if (!token) throw Object.assign(new Error('authorization_required'), { code: 'authorization_required' });
  if (!['/world', '/world/pause', '/persona', '/model', '/model/test', '/qq', '/memory', '/memory/retention', '/memory/public', '/diary/publish', '/memory/forget-preview', '/memory/forget', '/memory/cleanup/pending', '/runtime', '/speech', '/voice/reference', '/voice/reference/remove', '/voice/default', '/voice/test'].includes(path)) throw new Error('unsupported_operator_path');
  if (['/model', '/model/test', '/speech', '/voice/reference', '/voice/reference/remove', '/voice/default', '/voice/test'].includes(path) && payload === undefined) throw new Error('operator_post_required');
  if (path === '/runtime' && payload !== undefined) throw new Error('operator_get_required');
  const response = await fetchImpl(`${operatorOrigin(location, { sameOrigin })}${path}`, {
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
      : typeof body?.error?.code === 'string' && /^[a-z_]{1,64}$/.test(body.error.code) ? body.error.code : 'request_failed';
    throw Object.assign(new Error(code), { code, status: response.status });
  }
  return body.value;
}
export function personaPatch(draft) {
  const patch = {};
  for (const key of ['name', 'identity', 'speechStyle']) patch[key] = draft[key] || '';
  for (const key of ['traits', 'boundaries', 'principles']) patch[key] = (draft[key] || '').split('\n').map(line => line.trim()).filter(Boolean);
  return patch;
}
export function personaDraft(value) {
  return Object.fromEntries(['name', 'identity', 'traits', 'speechStyle', 'boundaries', 'principles'].map(key => [key,
    Array.isArray(value[key]) ? value[key].join('\n') : value[key] || '']));
}
export function validWorld(value) {
  return value && typeof value.world?.paused === 'boolean' && Number.isSafeInteger(value.world.revision)
    && Number.isSafeInteger(value.persona?.revision) && value.persona.value && value.counts
    && ['facts', 'notes', 'experiences', 'pending'].every(key => Number.isFinite(value.counts[key]))
    && Array.isArray(value.channels) && Array.isArray(value.bindings) && validModel(value.model);
}
