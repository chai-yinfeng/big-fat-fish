import test from 'node:test';
import assert from 'node:assert/strict';
import { withQuickLoginAccount } from './configure-recovery.mjs';

test('quick login preserves private runtime settings and is repeatable without duplicate accounts', () => {
  const original = 'MODE=ws\nWEBUI_TOKEN=fixture-not-a-real-token\nNAPCAT_UID=1000\nNAPCAT_GID=1000\n';
  const result = withQuickLoginAccount(original, '12345');
  assert.ok(result.startsWith(original));
  assert.equal(withQuickLoginAccount(result, '12345'), result);
  assert.equal(withQuickLoginAccount(result, '67890').match(/^ACCOUNT=/gm).length, 1);
  assert.ok(withQuickLoginAccount(result, '67890').endsWith('ACCOUNT=67890\n'));
});
test('quick login account cannot inject runtime variables or accept a missing account', () => {
  for (const value of ['', undefined, '123\nWEBUI_TOKEN=changed', '0', ' 123']) assert.throws(() => withQuickLoginAccount('MODE=ws\n', value));
});
