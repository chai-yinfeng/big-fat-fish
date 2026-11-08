import test from 'node:test';
import assert from 'node:assert/strict';
import { webuiLoginUrl } from './open-login.mjs';

test('login URL goes straight to the NapCat web_login page with the token', () => {
  const token = 'c'.repeat(64);
  const url = new URL(webuiLoginUrl(token));
  assert.equal(url.origin, 'http://127.0.0.1:6099');
  // /webui/?token= is dropped by NapCat when the browser holds a stale WebUI credential.
  assert.equal(url.pathname, '/webui/web_login');
  assert.deepEqual([...url.searchParams], [['token', token]]);
  assert.equal(url.hash, '');
});
