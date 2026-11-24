import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './test-harness.mjs';
import { consumeOperatorFragment, TOKEN_KEY, ROOM_PORT_KEY, validRoomPort } from './operator-client.js';

const code = 'a'.repeat(43);
const world = { world: { paused: false, revision: 1 }, persona: { revision: 1, value: {} }, counts: { facts: 0, notes: 0, experiences: 0, pending: 0 }, channels: [], bindings: [], model: { provider: 'deepseek', model: 'deepseek-flash', configured: false, status: 'unconfigured' } };

test('the fragment may carry the room’s local port; it is stored beside the access code, a stale one is removed', () => {
  const history = { state: null, replaceState() {} }, page = { pathname: '/', search: '' };
  const consume = (hash, storage) => consumeOperatorFragment({ location: { ...page, hash }, history, storage });
  const store = () => { const values = {}; return { values, setItem: (key, value) => { values[key] = value; }, removeItem: key => { delete values[key]; } }; };
  let storage = store();
  assert.equal(consume(`#companion-operator=${code}&room=4174`, storage), true);
  assert.deepEqual(storage.values, { [TOKEN_KEY]: code, [ROOM_PORT_KEY]: '4174' });
  // A later open without a room (open-world --open-only) leaves no stale port behind.
  assert.equal(consume(`#companion-operator=${code}`, storage), true);
  assert.deepEqual(storage.values, { [TOKEN_KEY]: code });
  // A malformed room part makes the whole fragment malformed: nothing is stored.
  for (const hash of [`#companion-operator=${code}&room=80`, `#companion-operator=${code}&room=70000`, `#companion-operator=${code}&room=4173&x=1`, `#companion-operator=${code}&room=`]) {
    storage = store();
    assert.equal(consume(hash, storage), false, hash); assert.deepEqual(storage.values, {}, hash);
  }
  assert.deepEqual(['4173', '65535', '1024', '1023', '04173', 'x', null, undefined].map(validRoomPort), [4173, 65535, 1024, null, null, null, null, null]);
});

async function overview(roomPort) {
  const states = ['operator-test', '', world, {}, 'overview'], refs = [];
  let cursor = 0, refCursor = 0;
  const React = { Fragment: 'fragment', useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const storage = { getItem: key => key === ROOM_PORT_KEY ? roomPort : 'operator-test', setItem() {}, removeItem() {} };
  const opened = [];
  const window = { location: { protocol: 'http:', hostname: '127.0.0.1', hash: '' }, sessionStorage: storage, open: (...args) => opened.push(args) };
  const loaded = await loadConsole({ window, sessionStorage: storage, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: async () => assert.fail('no request expected') });
  const component = loaded.factory(() => React).WorldConsole;
  cursor = 0; refCursor = 0;
  const tree = component({ t: key => key });
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(nodes)];
  return { opened, text: JSON.stringify(tree), button: nodes(tree).find(node => node.type === 'button' && node.children.includes('room.open')) };
}

test('overview: the room button shows only when open-world said where the room is, and opens it in a new tab', async () => {
  const shown = await overview('4175');
  assert.ok(shown.button && shown.text.includes('room.hint'));
  shown.button.props.onClick();
  assert.deepEqual(shown.opened, [['http://127.0.0.1:4175/', '_blank', 'noopener,noreferrer']]);
  for (const port of [null, 'operator-test', '22']) {
    const hidden = await overview(port);
    assert.equal(hidden.button, undefined, String(port)); assert.ok(!hidden.text.includes('room.hint'));
  }
});
