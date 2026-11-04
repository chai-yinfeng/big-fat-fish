export class AuthorityError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message); this.name = 'AuthorityError'; this.code = code; this.statusCode = statusCode;
  }
}
export function fail(code, message, statusCode = 400) { throw new AuthorityError(code, message, statusCode); }
export function closed(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION_ERROR', 'Expected a plain object');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('VALIDATION_ERROR', 'Unexpected or missing fields');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('VALIDATION_ERROR', 'Expected enumerable JSON data fields');
  return value;
}
export function text(value, max = 256, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) fail('VALIDATION_ERROR', 'Invalid string length or type');
  return value;
}
export function identifier(value) {
  text(value); if (/[\u0000-\u001f\u007f]/u.test(value)) fail('VALIDATION_ERROR', 'Invalid identifier'); return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('VALIDATION_ERROR', 'Invalid integer range'); return value;
}
export function enumeration(value, values) {
  if (!values.includes(value)) fail('VALIDATION_ERROR', 'Unsupported enum value'); return value;
}
export function jsonValue(value, depth = 0, budget = { nodes: 0, chars: 0 }) {
  budget.nodes += 1;
  if (depth > 6 || budget.nodes > 1000) fail('VALIDATION_ERROR', 'JSON complexity exceeds limit');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { text(value, 24000, true); budget.chars += value.length; if (budget.chars > 24000) fail('VALIDATION_ERROR', 'JSON text exceeds limit'); return; }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('VALIDATION_ERROR', 'Expected JSON data');
  if (Array.isArray(value)) {
    if (value.length > 100 || Reflect.ownKeys(value).length !== value.length + 1) fail('VALIDATION_ERROR', 'Invalid JSON array');
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('VALIDATION_ERROR', 'Invalid JSON array data');
      jsonValue(descriptor.value, depth + 1, budget);
    }
  } else {
    const keys = Object.keys(value); if (keys.length > 100) fail('VALIDATION_ERROR', 'JSON object exceeds limit');
    closed(value, keys); for (const key of keys) jsonValue(value[key], depth + 1, budget);
  }
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function capability(store, id) {
  identifier(id);
  const result = store.db.prepare('SELECT * FROM capabilities WHERE id=?').get(id);
  if (!result) fail('FORBIDDEN', 'Unknown capability', 403);
  return result;
}
export function resolveIdentity(store, capabilityId, observation) {
  const stream = store.db.prepare('SELECT person_id AS personId, audience, entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, observation.streamId);
  const actor = store.db.prepare('SELECT person_id AS personId FROM actors WHERE capability_id=? AND actor_id=?').get(capabilityId, observation.actorId);
  return { stream, actor, confirmed: !!stream && !!actor && actor.personId === stream.personId };
}
export function contextScope(store, capabilityId, streamId) {
  const stream = store.db.prepare('SELECT person_id AS personId, audience, entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, streamId);
  if (!stream) fail('FORBIDDEN', 'Unbound stream', 403);
  return { audience: stream.audience, personId: stream.personId, entityId: stream.entityId, streamId };
}
