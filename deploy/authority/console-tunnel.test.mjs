import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tunnelArgs, consoleURL, pickRoomPort, portFree, ROOM_LOCAL_PORTS } from './console-tunnel.mjs';

const token = 't'.repeat(43);

test('the tunnel forwards the console, and the room to the chosen local port only when there is one', () => {
  const base = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N', '-L', '127.0.0.1:3082:127.0.0.1:3082'];
  assert.deepEqual(tunnelArgs('home-agent', 4175), [...base, '-L', '127.0.0.1:4175:127.0.0.1:4173', 'home-agent']);
  assert.deepEqual(tunnelArgs('home-agent', null), [...base, 'home-agent']);
});

test('the console URL carries the room port beside the access code, or nothing about the room', () => {
  assert.equal(consoleURL(token, 4174).href, `http://127.0.0.1:3082/#companion-operator=${token}&room=4174`);
  assert.equal(consoleURL(token, null).href, `http://127.0.0.1:3082/#companion-operator=${token}`);
});

test('the room gets the first free local port; with none free it is skipped', async () => {
  assert.equal(ROOM_LOCAL_PORTS[0], 4173);
  assert.equal(await pickRoomPort(async port => port === 4176), 4176);
  assert.equal(await pickRoomPort(async () => false), null);
  // The real check: a port something listens on is not free.
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await portFree(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portFree(port), true);
});
