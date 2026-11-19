import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Authority } from '../src/engine.js';
import { INITIATION } from '../src/initiations.js';
import { createAuthorityServer } from '../src/server.js';
import { roomProjection, PHONE_MS } from '../src/room.js';

const MINUTE = 60000, HOUR = 60 * MINUTE;
const KEYS = ['version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose'];
// Things a room must never show: a person, an account, what was said, a job's id, title and result.
const SECRETS = ['person:owner', 'person:qq', '999900000011', '妈妈', '今天好累啊', 'job:1b4e28ba', '转写这段视频', '结果正文', 'private'];
const SELF = '999900000001', OWNER = '999900000002', A = '999900000011';
const stream = uid => `qq:${SELF}:private:${uid}`;
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { jobs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-room-'));
  // 2027-01-15 16:00 in Beijing: day, outside the quiet hours.
  const clock = { now: 1_800_000_000_000 };
  const authority = new Authority({ file: path.join(root, 'state.sqlite'), clock: () => clock.now });
  const tokens = { room: randomBytes(32).toString('hex'), capability: randomBytes(32).toString('hex'), admin: randomBytes(32).toString('hex'), maintenance: randomBytes(32).toString('hex') };
  const socketPath = path.join(root, 'api.sock');
  authority.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'qq', externalActorId: `qq:${SELF}:user:${OWNER}`, personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'qq', streamId: stream(OWNER), personId: 'person:owner', audience: 'private' });
  authority.admitPerson('qq', { uid: A, actorId: `qq:${SELF}:user:${A}`, streamId: stream(A) });
  const asked = [];
  const app = createAuthorityServer({ authority, socketPath, ...(jobs ? { contentJobs: async input => { asked.push(input); return jobs(); } } : {}), credentials: [
    { hash: hash(tokens.room), role: 'room' }, { hash: hash(tokens.capability), role: 'capability', capabilityId: 'qq' },
    { hash: hash(tokens.admin), role: 'admin' }, { hash: hash(tokens.maintenance), role: 'maintenance', entityId: authority.health().entityId },
  ] });
  await app.start();
  t.after(async () => { await app.close(); authority.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = (method, url, credential = tokens.room, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), 'content-type': 'application/json' } }, res => {
      let value = ''; res.on('data', chunk => { value += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw: value, body: JSON.parse(value) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  let seq = 0;
  const say = (uid, text) => authority.observe('qq', { eventId: `e-${++seq}`, streamId: stream(uid), actorId: `qq:${SELF}:user:${uid}`, role: 'user', text, at: clock.now });
  /** Every row of every table: what a write would change. */
  const dump = () => JSON.stringify(authority.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, authority.store.db.prepare(`SELECT * FROM "${name}"`).all()]));
  return { authority, clock, tokens, request, say, dump, asked };
}

test('room grant: reads GET /v1/room and nothing else; no other grant reads it; no operator token is involved', async t => {
  // No operator server exists in this fixture at all: the route lives on the capability socket.
  const { request, tokens } = await fixture(t);
  const ok = await request('GET', '/v1/room');
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true);
  const posts = ['/v1/observations', '/v1/proposals', '/v1/context', '/v1/memory/search', '/v1/memory/read', '/v1/memory/recall', '/v1/people/admit', '/v1/initiations/next', '/v1/initiations/ack', '/v1/initiations/carry',
    '/v1/content', '/v1/maintenance/batch', '/v1/maintenance/diary', '/v1/maintenance/consolidation/next', '/v1/maintenance/consolidation/commit',
    '/v1/admin/capabilities', '/v1/admin/actors', '/v1/admin/streams', '/v1/admin/persona', '/v1/room'];
  for (const route of posts) assert.equal((await request('POST', route, tokens.room, {})).status, 403, 'POST ' + route);
  for (const route of ['/v1/health', '/v1/admin/state', '/v1/receipts/p1', '/v1/room/', '/v1/room/state', '/v1/anything', '/']) assert.equal((await request('GET', route)).status, 403, 'GET ' + route);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await request(method, '/v1/room', tokens.room, {})).status, 403, method);
  assert.equal((await request('GET', '/v1/room?person=1')).status, 400);
  // The room state is for the room grant only: a channel, the maintenance worker and the admin credential are refused.
  for (const name of ['capability', 'admin', 'maintenance']) assert.equal((await request('GET', '/v1/room', tokens[name])).status, 403, name);
  assert.equal((await request('GET', '/v1/room', '')).status, 401);
  assert.equal((await request('GET', '/v1/room', randomBytes(32).toString('hex'))).status, 401);
  assert.throws(() => createAuthorityServer({ authority: {}, socketPath: '/tmp/x.sock', credentials: [{ hash: hash('x'), role: 'viewer' }] }), /Invalid authority credential/);
});

test('room state: only the contract keys, whatever people, messages and jobs exist', async t => {
  const jobRow = extra => ({ id: 'job:1b4e28ba-2fa1-11d2-883f-0016d3cca427', capability: 'demo', title: '转写这段视频', result: '结果正文', scope: { personId: `person:qq:${A}`, streamId: stream(A), audience: 'private' }, status: 'queued', startedAt: null, ...extra });
  let jobs = [jobRow()];
  const { request, say, clock, asked, authority } = await fixture(t, { jobs: () => ({ limits: { queued: 8, perPerson: 2 }, jobs }) });
  const read = async () => {
    const { status, raw, body } = await request('GET', '/v1/room');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ['ok', 'value']); assert.deepEqual(Object.keys(body.value), KEYS); assert.deepEqual(Object.keys(body.value.clock), ['timezone', 'minute', 'phase']);
    for (const secret of SECRETS) assert.ok(!raw.includes(secret), secret);
    return body.value;
  };
  // Nobody has spoken: idle since now. 16:00 Beijing is day; weather is the neutral default; there is no mood.
  assert.deepEqual(await read(), { version: 1, source: 'authority', at: clock.now, since: clock.now, clock: { timezone: 'Asia/Shanghai', minute: 960, phase: 'day' }, weather: 'clear', lamp: 'off', activity: 'idle', pose: 'sitting' });
  // A conversation moved just now: the phone pose, since that message. Which conversation it was is not in the answer.
  say(A, '妈妈说今天好累啊'); const spoke = clock.now; clock.now += 20000;
  assert.deepEqual([(await read()).activity, (await read()).pose, (await read()).since], ['replying', 'phone', spoke]);
  clock.now = spoke + PHONE_MS; assert.equal((await read()).activity, 'replying');
  clock.now += 1; assert.deepEqual([(await read()).activity, (await read()).since], ['idle', spoke]);
  // A running job: working since it started. Its id, title, result and owner stay behind.
  jobs = [jobRow(), jobRow({ status: 'running', startedAt: clock.now - 5 * MINUTE }), jobRow({ status: 'done', startedAt: clock.now - HOUR })];
  assert.deepEqual([(await read()).activity, (await read()).pose, (await read()).since], ['working', 'laptop', clock.now - 5 * MINUTE]);
  assert.deepEqual(asked.at(-1), { action: 'list' });
  // A paused world does nothing.
  authority.setWorldPaused({ paused: true }); say(OWNER, '今天好累啊');
  assert.equal((await read()).activity, 'idle');
  authority.setWorldPaused({ paused: false });
  // Quiet hours (default 23:30-08:00 Beijing): asleep since they began; the running job no longer shows; a message wakes her.
  clock.now = 1_800_000_000_000 + 11 * HOUR;
  const asleep = await read();
  assert.deepEqual([asleep.activity, asleep.pose, asleep.lamp, asleep.clock.phase, asleep.since], ['sleeping', 'bed', 'off', 'night', clock.now - 3.5 * HOUR]);
  say(OWNER, '今天好累啊'); clock.now += 1000;
  assert.deepEqual([(await read()).activity, (await read()).lamp], ['replying', 'on']);
  // The operator's own quiet hours are the ones in force.
  clock.now += HOUR; authority.initiationSettings({ quietHours: { from: '00:00', to: '00:00' } });
  assert.equal((await read()).activity, 'working');
});

test('room state: the content service being absent, down or odd only means no job shows', async t => {
  const plain = await fixture(t);
  assert.equal((await plain.request('GET', '/v1/room')).body.value.activity, 'idle');
  for (const jobs of [() => { throw new Error('down'); }, () => null, () => ({ jobs: 'x' }), () => ({ jobs: [null, { status: 'running', startedAt: '转写这段视频' }] })]) {
    const { request, clock } = await fixture(t, { jobs });
    const { status, body } = await request('GET', '/v1/room');
    assert.equal(status, 200); assert.deepEqual(Object.keys(body.value), KEYS);
    if (body.value.activity === 'working') assert.equal(body.value.since, clock.now);
  }
});

test('room state: reading writes nothing, so polling settles no initiation', async t => {
  const { authority, request, say, clock, dump } = await fixture(t, { jobs: () => ({ jobs: [] }) });
  say(OWNER, '今天好累啊');
  authority.initiationPoke();
  const items = () => JSON.parse(authority.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get().value).items;
  assert.equal(items()[0].status, 'waiting');
  // Past the time nobody fetched it: the next read that settles would close it.
  clock.now += INITIATION.ttlMs + MINUTE;
  const before = dump();
  for (let round = 0; round < 3; round++) assert.equal((await request('GET', '/v1/room')).status, 200);
  assert.equal(dump(), before); assert.equal(items()[0].status, 'waiting');
  // The operator's log is the read that writes: it closes the dead request, which is why the room does not use it.
  authority.initiationLog();
  assert.equal(items()[0].status, 'closed'); assert.notEqual(dump(), before);
});

test('room projection: malformed input degrades to idle and carries nothing over', () => {
  const now = 1_800_000_000_000;
  assert.equal(roomProjection({ now }).activity, 'idle');
  const odd = roomProjection({ now, paused: 'x', quiet: { now: 'yes', fromMinute: 7 }, jobs: [null, { status: 'running', startedAt: 'soon', title: '转写这段视频' }, { status: 'running', startedAt: now + 5 }], lastAts: [null, 'now', now + MINUTE, -4] });
  assert.deepEqual([odd.activity, odd.since], ['working', now]); assert.deepEqual(Object.keys(odd), KEYS);
  assert.equal(roomProjection({ now, quiet: { now: true, fromMinute: 'late' } }).since, now);
  assert.throws(() => roomProjection({})); assert.throws(() => roomProjection());
});

test('the entry point takes the room credential from its own private file beside the configuration, and refuses a loose or malformed one', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-room-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'authority.json'), roomFile = path.join(root, 'room-credential.json'), socketPath = path.join(root, 'a.sock');
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const token = randomBytes(32).toString('base64url'), other = randomBytes(32).toString('base64url');
  // What every release so far reads: no room credential in `credentials` (an older release would refuse one).
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, databasePath: path.join(root, 'w.sqlite'), socketPath, credentials: [{ hash: hash(other), role: 'capability', capabilityId: 'health' }], capabilities: [{ id: 'health', policy: 'learning.v1' }], actors: [], streams: [], operator: { socketPath: path.join(root, 'o.sock'), tokenHash: 'b'.repeat(64), origins: [] } }), { mode: 0o600 });
  const refused = () => spawnSync(process.execPath, [main, '--config', config], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000, killSignal: 'SIGTERM' });
  for (const [text, mode] of [[JSON.stringify({ schemaVersion: 1, hash: hash(token) }), 0o644], ['{', 0o600], [JSON.stringify({ schemaVersion: 2, hash: hash(token) }), 0o600], [JSON.stringify({ schemaVersion: 1, hash: 'short' }), 0o600], [JSON.stringify({ schemaVersion: 1, hash: hash(token), role: 'admin' }), 0o600], [JSON.stringify({ schemaVersion: 1, hash: hash(other) }), 0o600]]) {
    fs.rmSync(roomFile, { force: true });
    fs.writeFileSync(roomFile, text, { mode });
    const result = refused();
    assert.equal(result.status, 1, text); assert.match(result.stderr, /could not start/);
  }
  fs.rmSync(roomFile);
  fs.writeFileSync(roomFile, JSON.stringify({ schemaVersion: 1, hash: hash(token) }), { mode: 0o600 });
  const child = spawn(process.execPath, [main, '--config', config], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); }); child.on('exit', () => reject(new Error('Authority exited'))); });
  const get = (route, bearer) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'GET', agent: false, headers: { authorization: 'Bearer ' + bearer } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await get('/v1/room', token), 200);
  assert.equal(await get('/v1/health', token), 403);
  assert.equal(await get('/v1/room', other), 403);
  assert.equal(await get('/v1/health', other), 200);
});
