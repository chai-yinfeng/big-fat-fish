import test from 'node:test';
import assert from 'node:assert/strict';
import { OneBotClient, onebotURL } from '../onebot-client.js';

test('OneBot URL defaults to loopback 3001 and takes only a valid configured port', () => {
  assert.equal(onebotURL(), 'ws://127.0.0.1:3001');
  assert.equal(onebotURL(undefined), 'ws://127.0.0.1:3001');
  assert.equal(onebotURL(13001), 'ws://127.0.0.1:13001');
  for (const bad of [0, 65536, '3001', 2.5, null]) assert.throws(() => onebotURL(bad), /ONEBOT_CONFIG/);
});

test('OneBot client stays on explicit loopback ws with a port', () => {
  const client = url => new OneBotClient({ url, token: 'synthetic', onEvent: () => {} });
  for (const url of ['ws://127.0.0.1:3001', 'ws://127.0.0.1:13001']) assert.doesNotThrow(() => client(url));
  for (const url of ['ws://127.0.0.1', 'wss://127.0.0.1:3001', 'ws://localhost:3001', 'ws://10.0.0.1:3001', 'ws://127.0.0.1:3001/?x=1'])
    assert.throws(() => client(url), /ONEBOT_CONFIG/, url);
});
