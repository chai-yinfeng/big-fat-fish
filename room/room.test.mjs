import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { ACTIVITIES, ALL_POSES, POSES, WEATHERS, LAMPS, PHASES, MOODS, SOURCES, TIMEZONE, beijingMinute, phaseOf, roomState, validateRoomState, isRoomState } from './state.js';
import { TIMELINE, STEP_MS, fakeState, fixture, FIXTURES } from './providers/fake.js';
import { acceptLive, POLL_MS } from './providers/authority.js';
import { createRoomServer, authorityReader } from './serve.mjs';
import { roomProjection, PHONE_MS } from '../authority/src/room.js';
import { Authority } from '../authority/src/engine.js';
import { createAuthorityServer } from '../authority/src/server.js';
import { validateManifest, placement, HOTSPOT_SHOWS } from './manifest.js';
import { caption, drawer, ACTIVITY_TEXT } from './view.js';

const root = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const invalid = { code: 'ROOM_STATE_INVALID' };
// 2026-11-18 12:00 Beijing.
const NOON = Date.UTC(2026, 10, 18, 4, 0, 0);
/** Every string anywhere in a value. */
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const VOCABULARY = new Set([...ACTIVITIES, ...ALL_POSES, ...WEATHERS, ...LAMPS, ...PHASES, ...MOODS, ...SOURCES, TIMEZONE]);
const SECRETS = ['person:qq:10001', 'p-3f9a', 'qq', '12345678', '妈妈', '今天好累啊', 'BV1xx411c7mD', 'job:1b4e28ba-2fa1-11d2-883f-0016d3cca427', '转写这段视频', '结果正文'];

test('contract: Beijing clock, phases and defaults', () => {
  assert.equal(beijingMinute(NOON), 720);
  assert.equal(beijingMinute(Date.UTC(2026, 10, 18, 16, 0, 0)), 0);
  assert.deepEqual([0, 299, 300, 449, 450, 1049, 1050, 1169, 1170, 1439].map(phaseOf), ['night', 'night', 'dawn', 'dawn', 'day', 'day', 'dusk', 'dusk', 'night', 'night']);
  const state = roomState({ source: 'fake', at: NOON, activity: 'idle' });
  assert.deepEqual(state, { version: 1, source: 'fake', at: NOON, since: NOON, clock: { timezone: 'Asia/Shanghai', minute: 720, phase: 'day' }, weather: 'clear', lamp: 'off', activity: 'idle', pose: 'sitting' });
  assert.equal(roomState({ source: 'fake', at: NOON, activity: 'writing', minute: 1300 }).lamp, 'on');
  assert.equal(roomState({ source: 'fake', at: NOON, activity: 'sleeping', minute: 1420 }).lamp, 'off');
  for (const activity of ACTIVITIES) assert.equal(roomState({ source: 'fake', at: NOON, activity }).pose, POSES[activity][0]);
});

test('contract: the validator refuses anything outside the closed lists', () => {
  const good = roomState({ source: 'fake', at: NOON, since: NOON - 5000, activity: 'replying', mood: 'cheerful' });
  assert.equal(validateRoomState(good), good);
  for (const change of [
    { version: 2 }, { source: 'qq' }, { at: -1 }, { at: 1.5 }, { since: NOON + 1 }, { weather: 'storm' }, { lamp: 'dim' }, { activity: 'chatting' },
    { pose: 'bed' }, { pose: 'dancing' }, { mood: 'angry at someone' }, { clock: { ...good.clock, phase: 'night' } }, { clock: { ...good.clock, minute: 1440 } },
    { clock: { ...good.clock, timezone: 'UTC' } }, { clock: { ...good.clock, label: 'x' } },
  ]) assert.throws(() => validateRoomState({ ...good, ...change }), invalid, JSON.stringify(change));
  for (const value of [null, [], 'idle', 1]) assert.equal(isRoomState(value), false);
  assert.throws(() => roomState({ source: 'fake', at: NOON, activity: 'nothing' }), invalid);
  assert.throws(() => roomState({ source: 'fake', activity: 'idle' }), invalid);
});

test('isolation: a state has no field for a person, a conversation, a text or an id', () => {
  const good = FIXTURES.replying;
  for (const key of ['person', 'personId', 'label', 'with', 'streamId', 'conversation', 'channel', 'message', 'text', 'title', 'url', 'video', 'sharedBy', 'diary', 'job', 'jobId', 'result', 'detail', 'note'])
    assert.throws(() => validateRoomState({ ...good, [key]: 'x' }), invalid, key);
  // The builder reads its own fields and nothing else: extra input is dropped, not copied.
  const loose = roomState({ source: 'fake', at: NOON, activity: 'watching', person: SECRETS[0], sharedBy: SECRETS[4], title: SECRETS[6], message: { text: SECRETS[5] }, clock: { label: SECRETS[5] } });
  assert.deepEqual(Object.keys(loose), ['version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose']);
  assert.deepEqual(Object.keys(loose.clock), ['timezone', 'minute', 'phase']);
  // Free text cannot ride in a known field either: every string of a valid state is from the fixed vocabulary.
  for (const key of ['weather', 'lamp', 'pose', 'mood', 'source']) assert.throws(() => roomState({ source: 'fake', at: NOON, activity: 'idle', [key]: SECRETS[5] }), invalid, key);
  for (const state of [loose, ...Object.values(FIXTURES), ...TIMELINE.map((_, index) => fakeState(index * STEP_MS))]) for (const text of strings(state)) assert.ok(VOCABULARY.has(text), text);
});

test('fake provider: the timeline is deterministic and passes through every activity', () => {
  const day = TIMELINE.map((_, index) => fakeState(index * STEP_MS + 17));
  assert.deepEqual(day.map(state => state.activity), TIMELINE.map(step => step.activity));
  assert.deepEqual([...new Set(day.map(state => state.activity))].sort(), [...ACTIVITIES].sort());
  assert.deepEqual([...new Set(day.map(state => state.weather))].sort(), [...WEATHERS].sort());
  assert.deepEqual([...new Set(day.map(state => state.clock.phase))].sort(), [...PHASES].sort());
  for (const state of day) { validateRoomState(state); assert.equal(state.source, 'fake'); }
  assert.deepEqual(fakeState(123456), fakeState(123456));
  assert.equal(fakeState(STEP_MS - 1).activity, TIMELINE[0].activity);
  assert.equal(fakeState(STEP_MS).activity, TIMELINE[1].activity);
  assert.deepEqual(fakeState(STEP_MS + 250), { ...fakeState(STEP_MS), at: STEP_MS + 250 });
  assert.equal(fakeState(STEP_MS + 250).since, STEP_MS);
  assert.equal(fakeState(TIMELINE.length * STEP_MS).activity, TIMELINE[0].activity);
  assert.equal(fakeState(5000, { stepMs: 1000 }).activity, TIMELINE[5].activity);
  assert.throws(() => fakeState(-1)); assert.throws(() => fakeState(0, { stepMs: 0 }));
  for (const activity of ACTIVITIES) assert.equal(validateRoomState(fixture(activity, NOON)).activity, activity);
  assert.equal(fixture('idle', NOON, { weather: 'snow', minute: 1300 }).lamp, 'on');
  assert.throws(() => fixture('dancing'));
});

// What Authority hands its own projection (authority/src/room.js): the world's pause, the quiet hours, the content
// service's job rows and recent message times. The job rows are filled with things a room must not show.
const snapshot = ({ quiet = false, lastAt = NOON - 3600000, jobs = [], paused = false, now = NOON } = {}) => ({
  now, paused, quiet: { now: quiet, fromMinute: 23 * 60 + 30 },
  jobs: jobs.map(job => ({ id: SECRETS[7], capability: 'demo', title: SECRETS[8], result: SECRETS[9], scope: { personId: SECRETS[0], streamId: 'qq:1:private:12345678' }, startedAt: null, ...job })),
  lastAts: [lastAt, NOON - 7200000, null],
});

test('authority projection: quiet hours, running jobs and recent conversation become categories', () => {
  assert.deepEqual(roomProjection(snapshot()), roomState({ source: 'authority', at: NOON, since: NOON - 3600000, activity: 'idle' }));
  const replying = roomProjection(snapshot({ lastAt: NOON - 20000 }));
  assert.equal(replying.activity, 'replying'); assert.equal(replying.pose, 'phone'); assert.equal(replying.since, NOON - 20000);
  assert.equal(roomProjection(snapshot({ lastAt: NOON - PHONE_MS })).activity, 'replying');
  assert.equal(roomProjection(snapshot({ lastAt: NOON - PHONE_MS - 1 })).activity, 'idle');
  const working = roomProjection(snapshot({ jobs: [{ status: 'queued' }, { status: 'running', startedAt: NOON - 60000 }, { status: 'done', startedAt: NOON - 900000 }] }));
  assert.equal(working.activity, 'working'); assert.equal(working.since, NOON - 60000);
  assert.equal(roomProjection(snapshot({ jobs: [{ status: 'queued' }, { status: 'done' }] })).activity, 'idle');
  // Quiet hours: asleep since they began (23:30 the evening before, seen from 03:00), a job does not show, a message wakes her.
  const night = Date.UTC(2026, 10, 17, 19, 0, 0), asleep = roomProjection(snapshot({ now: night, quiet: true, jobs: [{ status: 'running', startedAt: night - 1000 }] }));
  assert.equal(asleep.activity, 'sleeping'); assert.equal(asleep.since, night - 3.5 * 3600000); assert.equal(asleep.lamp, 'off'); assert.equal(asleep.clock.phase, 'night');
  assert.equal(roomProjection({ ...snapshot({ now: night, quiet: true }), lastAts: [night - 5000] }).activity, 'replying');
  // A paused world does nothing; quiet hours still read as sleep.
  assert.equal(roomProjection(snapshot({ paused: true, lastAt: NOON - 1000, jobs: [{ status: 'running', startedAt: NOON - 1000 }] })).activity, 'idle');
  assert.equal(roomProjection(snapshot({ paused: true, quiet: true })).activity, 'sleeping');
});

test('authority projection: Authority builds exactly what the contract builds, at every hour, and nothing leaks', () => {
  // Authority's copy of the clock, phase, lamp and pose rules (room/ is not in a release) against this contract.
  for (let step = 0; step < 96; step++) for (const extra of [{}, { lastAt: NOON + step * 900000 - 1000 }, { quiet: true }, { jobs: [{ status: 'running', startedAt: NOON - 5 }] }]) {
    const now = NOON + step * 900000 + 123, state = roomProjection(snapshot({ now, ...extra }));
    assert.deepEqual(state, roomState({ source: 'authority', at: now, since: state.since, activity: state.activity }));
    assert.equal(acceptLive(state), state);
  }
  assert.deepEqual([...new Set(Array.from({ length: 96 }, (_, step) => roomProjection({ now: NOON + step * 900000 }).clock.phase))].sort(), [...PHASES].sort());
  for (const input of [snapshot(), snapshot({ lastAt: NOON - 1 }), snapshot({ quiet: true }), snapshot({ jobs: [{ status: 'running', startedAt: NOON - 1 }] })]) {
    const state = validateRoomState(roomProjection(input)), json = JSON.stringify(state);
    for (const text of strings(state)) assert.ok(VOCABULARY.has(text), text);
    for (const secret of SECRETS.filter(item => item !== 'qq')) assert.ok(!json.includes(secret), secret);
    for (const page of [caption(state), ...HOTSPOT_SHOWS.map(shows => JSON.stringify(drawer(shows, state)))]) for (const secret of SECRETS) assert.ok(!page.includes(secret), secret);
  }
  assert.throws(() => acceptLive(FIXTURES.idle), invalid);
  assert.throws(() => acceptLive({ ...roomProjection(snapshot()), person: SECRETS[0] }), invalid);
});

test('page text: captions and drawers are fixed sentences chosen by category', () => {
  assert.equal(caption(fixture('watching', NOON)), '看视频 · 14:00 白天 · 下雨');
  assert.deepEqual(drawer('activity', roomState({ source: 'fake', at: NOON, since: NOON - 12 * 60000, activity: 'replying', mood: 'cheerful' })), { title: '看手机', lines: ['她在看手机。', '已经 12 分钟', '看起来开心。'] });
  // The phone pose says she is on her phone, not that she is answering anyone.
  for (const text of Object.values(ACTIVITY_TEXT).flat()) assert.ok(!/回消息|回复|聊天|消息/.test(text), text);
  assert.deepEqual(drawer('activity', roomState({ source: 'fake', at: NOON, since: NOON - 5 * 3600000, activity: 'sleeping' })).lines, ['她睡了，安静时段不打扰。', '已经 5 小时多']);
  assert.deepEqual(drawer('lamp', fixture('writing', NOON)), { title: '灯', lines: ['灯开着。'] });
  assert.deepEqual(drawer('clock', fixture('idle', NOON)).lines, ['北京时间 08:10，白天。']);
  assert.deepEqual(drawer('weather', fixture('writing', NOON)).lines, ['窗外下雪。']);
  assert.deepEqual(Object.keys(ACTIVITY_TEXT), ACTIVITIES);
  assert.throws(() => drawer('diary', FIXTURES.idle));
  assert.throws(() => caption({ ...FIXTURES.idle, person: 'x' }), invalid);
});

test('manifest: the shipped one is valid, complete and names files that exist', async () => {
  validateManifest(manifest);
  assert.deepEqual(Object.keys(manifest.poses).sort(), [...ALL_POSES].sort());
  for (const src of [manifest.base.src, ...Object.values(manifest.poses).map(slot => slot.src)]) await access(new URL(src, root));
  assert.deepEqual(placement(manifest, 'sitting'), { left: 40.625, bottom: 29.5, width: 11.25 });
});

test('manifest: video slots are accepted, bad files and positions are refused', () => {
  const change = edit => { const copy = structuredClone(manifest); edit(copy); return copy; };
  const bad = { code: 'ROOM_MANIFEST_INVALID' };
  validateManifest(change(m => { m.poses.bed = { kind: 'video', src: 'assets/sleep-loop.webm', poster: 'assets/sleep.png', anchor: { x: 460, y: 760 }, width: 520 }; }));
  validateManifest(change(m => { m.poses.mic = { ...m.poses.mic, kind: 'video', src: 'assets/talk.mp4' }; }));
  validateManifest(change(m => { delete m.window; delete m.lamp; m.hotspots = []; }));
  for (const edit of [
    m => { m.version = 2; }, m => { m.extra = 1; }, m => { m.stage.width = 0; }, m => { delete m.poses.bed; }, m => { m.poses.dancing = m.poses.bed; },
    m => { m.poses.bed.kind = 'iframe'; }, m => { m.poses.bed.src = 'assets/sleep.webm'; }, m => { m.poses.bed = { ...m.poses.bed, kind: 'video' }; },
    m => { m.poses.bed.src = 'https://example.org/a.png'; }, m => { m.poses.bed.src = '../secret.png'; }, m => { m.poses.bed.src = '/etc/a.png'; }, m => { m.poses.bed.src = 'assets/a.png?x=1'; },
    m => { m.poses.bed.src = 'assets/a.html'; }, m => { m.poses.bed.poster = 'assets/a.png'; }, m => { m.poses.bed.anchor.x = 1601; }, m => { m.poses.bed.width = 0; }, m => { m.poses.bed.caption = 'x'; },
    m => { m.base.src = 'assets/base.webm'; }, m => { m.window = [[0, 0], [1, 1]]; }, m => { m.lamp.radius = -1; },
    m => { m.hotspots[0].shows = 'diary'; }, m => { m.hotspots[1].id = m.hotspots[0].id; }, m => { m.hotspots[0].polygon[0] = [5000, 0]; }, m => { m.hotspots[0].text = '她在和谁聊'; },
  ]) assert.throws(() => validateManifest(change(edit)), bad, edit.toString());
});

test('page: no inline script or style, and nothing but its own files', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8'), script = await readFile(new URL('room.js', root), 'utf8');
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'/);
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/\sstyle=|<style/.test(html) && !/https?:\/\//.test(html));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|3082|Authorization/.test(script));
  // The page reads two things, both from its own server: the manifest and (live provider) the room state.
  const provider = await readFile(new URL('providers/authority.js', root), 'utf8');
  assert.deepEqual([...script.matchAll(/fetch\(([^,)]+)/g)].map(match => match[1]), ["'manifest.json'"]);
  assert.deepEqual([...provider.matchAll(/fetch\(([^,)]+)/g)].map(match => match[1]), ["'state'"]);
  assert.ok(!/Authorization|Bearer|token|\.sock|3082/i.test(provider.replace(/^\s*(\/\/|\/\*\*|\*).*$/gm, '')));
});

/** A real Authority on a temporary Unix socket with a room credential, and people, messages and a job with names. */
async function liveAuthority(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'room-live-')), socketPath = path.join(dir, 'api.sock'), credentialFile = path.join(dir, 'room.token');
  const token = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex'), sha = value => createHash('sha256').update(value).digest('hex');
  const authority = new Authority({ file: path.join(dir, 'state.sqlite') });
  authority.registerCapability({ id: 'qq', policy: 'conversation.v1' });
  authority.bindActor({ capabilityId: 'qq', externalActorId: 'qq:1:user:2', personId: 'person:owner' });
  authority.bindStream({ capabilityId: 'qq', streamId: 'qq:1:private:2', personId: 'person:owner', audience: 'private' });
  authority.observe('qq', { eventId: 'e1', streamId: 'qq:1:private:2', actorId: 'qq:1:user:2', role: 'user', text: SECRETS[5], at: Date.now() - 3600000 });
  const app = createAuthorityServer({ authority, socketPath, credentials: [{ hash: sha(token), role: 'room' }, { hash: sha(other), role: 'capability', capabilityId: 'qq' }],
    contentJobs: async () => ({ jobs: [{ id: SECRETS[7], title: SECRETS[8], result: SECRETS[9], scope: { personId: SECRETS[0] }, status: 'queued', startedAt: null }] }) });
  await app.start();
  writeFileSync(credentialFile, token + '\n', { mode: 0o600 });
  t.after(async () => { await app.close(); authority.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, socketPath, credentialFile, token, other, authority };
}
async function serving(t, options) {
  const server = createRoomServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return path => fetch(`http://127.0.0.1:${server.address().port}/${path}`);
}

test('serve: fake mode has no state route; real mode hands on the contract and never the credential', async t => {
  const fake = await serving(t);
  assert.equal((await fake('state')).status, 404);
  assert.equal((await fake('')).status, 200);
  const { socketPath, credentialFile, token, dir } = await liveAuthority(t);
  const get = await serving(t, { live: authorityReader({ socketPath, credentialFile, cacheMs: 0 }) });
  const response = await get('state'), text = await response.text(), state = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(acceptLive(state), state);
  // This Authority runs on the real clock. The owner spoke an hour ago and the only job is queued: idle since that
  // message, or asleep when the test happens to run in the quiet hours.
  assert.ok(state.activity === 'idle' ? state.at - state.since >= 3600000 : state.activity === 'sleeping', state.activity);
  assert.ok(Math.abs(Date.now() - state.at) < 60000);
  assert.deepEqual(Object.keys(state), ['version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose']);
  for (const secret of [token, ...SECRETS.filter(item => item !== 'qq')]) assert.ok(!text.includes(secret) && !JSON.stringify([...response.headers]).includes(secret), secret);
  // Nothing this server answers contains the credential, and the credential file cannot be asked for.
  for (const name of ['', 'room.js', 'providers/authority.js', 'serve.mjs', 'state.js', 'manifest.json', 'state?x=1']) assert.ok(!(await (await get(name)).text()).includes(token), name);
  for (const name of ['room.token', '../room.token', '%2e%2e/room.token', encodeURIComponent(credentialFile), 'state/room.token']) assert.equal((await get(name)).status, 404, name);
  assert.equal((await fetch(`http://127.0.0.1:${new URL((await get('state')).url).port}/state`, { method: 'POST' })).status, 404);
  assert.ok(POLL_MS >= 1000);
  // Unavailable: 503 with an empty body, no reason and no path. A wrong grant, a loose file mode, a missing socket.
  for (const [change, restore] of [
    [() => writeFileSync(credentialFile, randomBytes(32).toString('hex')), () => writeFileSync(credentialFile, token)],
    [() => chmodSync(credentialFile, 0o644), () => chmodSync(credentialFile, 0o600)],
    [() => writeFileSync(credentialFile, 'short'), () => writeFileSync(credentialFile, token)],
  ]) {
    change();
    const failed = await get('state');
    assert.equal(failed.status, 503); assert.equal(await failed.text(), '{}');
    restore();
    assert.equal((await get('state')).status, 200);
  }
  const gone = await serving(t, { live: authorityReader({ socketPath: path.join(dir, 'none.sock'), credentialFile }) });
  assert.equal((await gone('state')).status, 503);
  assert.throws(() => authorityReader({ socketPath: 'api.sock', credentialFile }));
});

test('serve: a capability credential is refused by Authority, an answer outside the contract is not passed on, reads are cached', async t => {
  const { socketPath, credentialFile, other } = await liveAuthority(t);
  writeFileSync(credentialFile, other);
  const wrong = await serving(t, { live: authorityReader({ socketPath, credentialFile, cacheMs: 0 }) });
  assert.equal((await wrong('state')).status, 503);
  let calls = 0;
  const good = roomProjection({ now: NOON });
  const bad = await serving(t, { live: async () => ({ ...good, person: SECRETS[0] }) });
  assert.equal(await (await bad('state')).text(), '{}');
  // A stand-in Authority counts the reads: many viewers within the cache time are one read.
  const dir = mkdtempSync(path.join(tmpdir(), 'room-stub-')), stubSocket = path.join(dir, 'stub.sock'), tokenFile = path.join(dir, 'room.token');
  writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const stub = http.createServer((req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, value: req.url === '/v1/room' && req.method === 'GET' ? good : null })); });
  await new Promise(resolve => stub.listen(stubSocket, resolve));
  t.after(() => new Promise(resolve => stub.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); })));
  const cached = await serving(t, { live: authorityReader({ socketPath: stubSocket, credentialFile: tokenFile, cacheMs: 60000 }) });
  const answers = await Promise.all(Array.from({ length: 8 }, () => cached('state').then(response => response.json())));
  for (const answer of answers) assert.deepEqual(answer, good);
  assert.equal((await cached('state')).status, 200);
  assert.equal(calls, 1);
});
