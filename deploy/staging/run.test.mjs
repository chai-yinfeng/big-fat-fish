import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, checkHost } from './run.mjs';

test('staging arguments: lifecycle by default, --reset alone only resets', () => {
  assert.deepEqual(parseArgs([]), { reset: false, from: null, to: null, lifecycle: true });
  assert.deepEqual(parseArgs(['--reset']), { reset: true, from: null, to: null, lifecycle: false });
  const both = parseArgs(['--reset', '--from', 'a/authority-0.10.0-945e4dc91c10.tar.gz', '--to', 'authority-0.10.1-0123456789ab.tar.gz']);
  assert.equal(both.lifecycle, true);
  assert.equal(both.from, 'a/authority-0.10.0-945e4dc91c10.tar.gz');
  for (const bad of [['--to'], ['--from', 'x.tar.gz'], ['--prod'], ['--to', '--reset']]) assert.throws(() => parseArgs(bad), /Usage|tarball/);
});

test('staging never targets the production host alias', () => {
  assert.equal(checkHost('home-agent-dev'), 'home-agent-dev');
  for (const host of ['home-agent', 'bad host', 'x;rm']) assert.throws(() => checkHost(host), /Refusing/);
});
