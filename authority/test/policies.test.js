import test from 'node:test';
import assert from 'node:assert/strict';
import { review, validatePayload } from '../src/policies.js';

const observation = { id: 'o', streamId: 's', actorId: 'a', role: 'user', at: 1, text: 'I like tea and support.' };
const identity = { confirmed: true, actor: { personId: 'p' }, stream: { personId: 'p', audience: 'private' } };
function decide(type, payload, overrides = {}) {
  return review({ policy: 'conversation.v1', proposal: { type, payload }, observation, identity, state: { appraisals: [] }, ...overrides });
}

test('closed payload schema and bounded evidence for every accepted kind', () => {
  const cases = [
    ['fact.report', { key: 'drink', value: 'tea', quote: 'tea' }],
    ['experience.remember', { summary: 'tea encounter', quote: 'tea' }],
    ['appraisal.record', { kind: 'support', quote: 'support' }],
    ['self.note', { text: 'self understanding', quote: 'tea', kind: 'outer' }],
    ['learning.note', { text: 'A reading distinction', quote: 'tea' }],
  ];
  for (const [type, payload] of cases) {
    validatePayload(type, payload);
    assert.throws(() => validatePayload(type, { ...payload, policy: 'other' }));
    const result = decide(type, payload, type === 'learning.note' ? { policy: 'learning.v1', observation: { ...observation, role: 'external' }, identity: { ...identity, confirmed: false, actor: undefined } } : {});
    assert.equal(result.status, 'accepted'); assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].evidence.observationId, 'o');
    if (type === 'learning.note') { assert.equal(result.effects[0].owner, 'self'); assert.equal(result.effects[0].personId, undefined); }
    else assert.equal(result.effects[0].personId, 'p');
    assert.ok(result.effects[0].policy.endsWith('.v1'));
    assert.equal(result.effects[0].evidence.quoteVerbatim, undefined);
  }
  assert.throws(() => validatePayload('appraisal.record', { kind: 'love', quote: 'tea' }));
  assert.throws(() => validatePayload('fact.report', { key: 'x', value: 'tea', quote: 'x'.repeat(2001) }));
  assert.throws(() => validatePayload('unknown', {}));
  assert.equal(decide('fact.report', cases[0][1], { policy: 'future.v99' }).status, 'rejected');
});

test('a quote that is not in the observation is accepted and marked; the observation stays the provenance', () => {
  const said = { ...observation, text: '我下个月 5 号去上海，待三天。' };
  const fact = quote => decide('fact.report', { key: '去上海', value: '2026-12-05', quote }, { observation: said });
  // Punctuation, full-width or half-width forms and spacing are not a different sentence.
  for (const quote of ['我下个月 5 号去上海', ' 我下个月5号去上海,待三天 ', '我下个月　５ 号去上海，待三天。', '下个月 5 号去上海 待三天']) {
    const result = fact(quote);
    assert.equal(result.status, 'accepted', quote); assert.ok(!Object.hasOwn(result.effects[0].evidence, 'quoteVerbatim'), quote);
  }
  for (const quote of ['我下个月五号去上海', '下个月 5 号要去上海出差', '。，']) {
    const result = fact(quote);
    assert.equal(result.status, 'accepted', quote);
    assert.deepEqual(result.effects[0].evidence, { observationId: 'o', quote, role: 'user', actorId: 'a', streamId: 's', at: 1, quoteVerbatim: false });
    assert.deepEqual([result.effects[0].personId, result.effects[0].visibility, result.effects[0].value], ['p', 'private', '2026-12-05']);
  }
  // Every other kind is marked the same way; who may be quoted and where is unchanged.
  for (const [type, payload] of [['experience.remember', { summary: 's', quote: 'not in source' }], ['appraisal.record', { kind: 'support', quote: 'not in source' }], ['self.note', { text: 't', quote: 'not in source', kind: 'outer' }]])
    assert.equal(decide(type, payload).effects[0].evidence.quoteVerbatim, false);
  assert.equal(decide('learning.note', { text: 'A reading distinction', quote: 'not in source' }, { policy: 'learning.v1', observation: { ...observation, role: 'external' } }).effects[0].evidence.quoteVerbatim, false);
  const loose = { key: 'k', value: 'anything', quote: 'not in source' };
  assert.equal(decide('fact.report', loose, { observation: { ...observation, role: 'assistant' } }).reason, 'real_user_required');
  assert.equal(decide('fact.report', loose, { identity: { ...identity, confirmed: false } }).reason, 'unconfirmed_identity');
  assert.equal(decide('fact.report', loose, { identity: { ...identity, stream: { personId: 'p', audience: 'group' } } }).reason, 'private_binding_required');
  assert.equal(decide('fact.report', loose, { observation: { ...observation, origin: 'attachment' } }).reason, 'authored_text_required');
  assert.equal(decide('fact.report', { ...loose, value: 'my password' }).reason, 'sensitive_retention_denied');
  assert.throws(() => validatePayload('fact.report', { key: 'k', value: 'v' }));
  assert.throws(() => validatePayload('fact.report', { key: 'k', value: 'v', quote: '' }));
});

test('learning keeps reading notes separate from personal preference or intimacy interpretations', () => {
  for (const value of ['user prefers tea', '用户喜欢茶', 'I promise eternal intimacy']) {
    const result = decide('learning.note', { text: value, quote: 'tea' }, { policy: 'learning.v1', observation: { ...observation, role: 'external' } });
    assert.equal(result.status, 'rejected');
  }
  assert.equal(decide('fact.report', { key: 'x', value: 'tea', quote: 'tea' }, { policy: 'learning.v1' }).status, 'rejected');
});

test('persona proposals require bounded plain JSON even though their decision is always rejection', () => {
  validatePayload('persona.change', {});
  assert.equal(decide('persona.change', {}).reason, 'admin_persona_revision_required');
  for (const patch of [null, { name: 'x', subject: 'p' }, { examples: [{ user: 'u', assistant: 'a', policy: 'x' }] }, { name: undefined }, { get name() { throw new Error('not evaluated'); } }]) {
    assert.throws(() => validatePayload('persona.change', { patch }));
  }
});
