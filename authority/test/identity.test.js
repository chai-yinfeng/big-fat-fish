import test from 'node:test';
import assert from 'node:assert/strict';
import { closed, canonical, integer } from '../src/identity.js';

test('canonical JSON treats order as immaterial, not field values or nesting', () => {
  assert.equal(canonical({ b: { z: 1, a: 2 }, a: 3 }), canonical({ a: 3, b: { a: 2, z: 1 } }));
  assert.notEqual(canonical({ a: '1' }), canonical({ a: 1 }));
});
test('closed JSON excludes inherited, hidden, symbolic and accessor fields', () => {
  const bad = [[], null, new Date(), Object.create({ a: 1 }), { a: 1, b: 2 }, { a: 1, [Symbol('x')]: 2 }, Object.defineProperty({}, 'a', { value: 1 }), { get a() { throw new Error('getter must never run'); } }];
  for (const value of bad) assert.throws(() => closed(value, ['a']), e => e.code === 'VALIDATION_ERROR');
  assert.doesNotThrow(() => closed(Object.assign(Object.create(null), { a: 1 }), ['a']));
  for (const value of [NaN, Infinity, 0.5, '1', -1]) assert.throws(() => integer(value));
});
