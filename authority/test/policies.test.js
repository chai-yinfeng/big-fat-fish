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
    assert.equal(decide(type, { ...payload, quote: 'not in source' }).status, 'rejected');
  }
  assert.throws(() => validatePayload('appraisal.record', { kind: 'love', quote: 'tea' }));
  assert.throws(() => validatePayload('fact.report', { key: 'x', value: 'tea', quote: 'x'.repeat(2001) }));
  assert.throws(() => validatePayload('unknown', {}));
  assert.equal(decide('fact.report', cases[0][1], { policy: 'future.v99' }).status, 'rejected');
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
