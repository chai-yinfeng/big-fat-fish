import { closed, enumeration, jsonValue, text } from './identity.js';
import { validatePersonaPatch } from '../../core/src/persona.js';

export const POLICIES = ['conversation.v1', 'learning.v1'];
export const APPRAISAL_KINDS = ['gratitude', 'support', 'repair', 'boundary'];
export const TYPES = ['fact.report', 'experience.remember', 'appraisal.record', 'learning.note', 'self.note', 'persona.change'];
export function validatePayload(type, payload) {
  enumeration(type, TYPES);
  switch (type) {
    case 'fact.report':
      closed(payload, ['key', 'value', 'quote']); text(payload.key, 128); text(payload.value, 1000); break;
    case 'experience.remember':
      closed(payload, ['summary', 'quote']); text(payload.summary, 2000); break;
    case 'appraisal.record':
      closed(payload, ['kind', 'quote']); enumeration(payload.kind, APPRAISAL_KINDS); break;
    case 'learning.note':
      closed(payload, ['text', 'quote']); text(payload.text, 2000); break;
    case 'self.note':
      closed(payload, ['text', 'quote', 'kind']); text(payload.text, 2000); enumeration(payload.kind, ['outer', 'inner']); break;
    case 'persona.change':
      closed(payload, ['patch', 'reason'], []);
      if (Object.hasOwn(payload, 'patch')) { jsonValue(payload.patch); validatePersonaPatch(payload.patch); }
      if (Object.hasOwn(payload, 'reason')) text(payload.reason, 1000);
      return;
  }
  text(payload.quote, 2000);
}
// A deliberately conservative lexical retention guard, not a classifier or a
// claim of semantic truth. Raw observations remain private admin evidence.
export const SENSITIVE = /password|passphrase|api[ _-]?key|secret[ _-]?key|access[ _-]?token|bearer\s+|private[ _-]?key|-----BEGIN|\bsk-[a-z0-9]|\b\d{3}-\d{2}-\d{4}\b|密码|口令|密钥|身份证|银行卡|信用卡|诊断|病历|抑郁|自杀|自残|depression|diagnos|suicid|self[ -]?harm|sexual|sex life|性取向|性生活|宗教信仰|political affiliation|政治立场/iu;
const LEARNING_PERSONAL = /user\s+(?:prefers?|likes?|wants?|needs?)|用户(?:偏好|喜欢|需要)|主人(?:偏好|喜欢)|永远(?:陪|爱)|只有我懂|承诺|promise|intimacy|relationship\s+(?:score|level)/iu;
export function review({ policy, proposal, observation, identity, state }) {
  const { type, payload } = proposal;
  const rejected = reason => ({ status: 'rejected', reason, effects: [] });
  if (!POLICIES.includes(policy)) return rejected('unknown_policy');
  if (type === 'persona.change') return rejected('admin_persona_revision_required');
  if (!observation.text.includes(payload.quote)) return rejected('quote_not_in_observation');
  if (!identity.stream || identity.stream.audience !== 'private') return rejected('private_binding_required');
  if (SENSITIVE.test(JSON.stringify(payload))) return rejected('sensitive_retention_denied');
  const personId = identity.stream.personId;
  const evidence = { observationId: observation.id, quote: payload.quote, role: observation.role, actorId: observation.actorId, streamId: observation.streamId, at: observation.at };
  const base = { personId, visibility: 'private', policy, evidence };
  if (policy === 'learning.v1') {
    if (type !== 'learning.note') return rejected('learning_policy_kind_denied');
    if (observation.role !== 'external') return rejected('external_learning_source_required');
    if (LEARNING_PERSONAL.test(payload.text)) return rejected('learning_personal_claim_denied');
    // The external author is evidence provenance, never an alias of the human.
    // Reading changes the companion's private knowledge, not a person's facts.
    return { status: 'accepted', effects: [{ owner: 'self', visibility: 'private', policy, evidence, collection: 'notes', kind: 'learning', text: payload.text }] };
  }
  if (type === 'learning.note') return rejected('conversation_policy_kind_denied');
  if (observation.origin === 'attachment') return rejected('authored_text_required');
  // Assistant authorship comes from trusted transport metadata, not a human
  // actor mapping. Only its person-bound private conversation gets that note.
  if (!(type === 'self.note' && observation.role === 'assistant') && !identity.confirmed) return rejected('unconfirmed_identity');
  if (type !== 'self.note' && observation.role !== 'user') return rejected('real_user_required');
  if (type === 'self.note' && !['user', 'assistant'].includes(observation.role)) return rejected('conversation_role_required');
  switch (type) {
    case 'fact.report':
      if (!payload.quote.includes(payload.value)) return rejected('value_not_in_quote');
      // This records what the confirmed actor reported. It never verifies that
      // claim, or accepts a text identity claim as an actor alias registration.
      return { status: 'accepted', effects: [{ ...base, collection: 'facts', key: payload.key, value: payload.value, attribution: 'reported' }] };
    case 'experience.remember':
      return { status: 'accepted', effects: [{ ...base, collection: 'experiences', summary: payload.summary }] };
    case 'self.note':
      return { status: 'accepted', effects: [{ ...base, collection: 'notes', text: payload.text, kind: payload.kind }] };
    case 'appraisal.record': {
      if (state.alreadyAppraised || state.appraisals?.some(entry => entry.evidence.observationId === observation.id)) return rejected('observation_already_appraised');
      // Enum indicates proposed interpretation, not objectively proven sentiment.
      // No intimacy jumps, punishment, or client-selected numerical deltas.
      const delta = payload.kind === 'boundary' ? 0 : 1;
      return { status: 'accepted', effects: [{ ...base, collection: 'appraisals', kind: payload.kind, delta }] };
    }
    default: return rejected('unknown_kind');
  }
}
