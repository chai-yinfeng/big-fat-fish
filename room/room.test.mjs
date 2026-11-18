import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { ACTIVITIES, ALL_POSES, POSES, WEATHERS, LAMPS, PHASES, MOODS, SOURCES, TIMEZONE, beijingMinute, phaseOf, roomState, validateRoomState, isRoomState } from './state.js';
import { TIMELINE, STEP_MS, fakeState, fixture, FIXTURES } from './providers/fake.js';
import { fromAuthority, REPLYING_MS } from './providers/authority.js';
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

// Fixture snapshots in the shapes Authority's operator routes return today, filled with things a room must not show.
const snapshot = ({ quiet = false, lastAt = NOON - 3600000, jobs = [], paused = false } = {}) => ({
  now: NOON,
  world: { paused, revision: 7, worldNow: NOON, realNow: NOON },
  initiative: { quietHours: { from: '23:30', to: '08:00', timezone: 'Asia/Shanghai', now: quiet }, deferredAt: null, items: [{ id: 'init:1', person: 'p-3f9a', status: 'delivered', reason: SECRETS[5] }] },
  jobs: { limits: { queued: 8, perPerson: 2 }, jobs: jobs.map(job => ({ id: SECRETS[7], capability: 'demo', title: SECRETS[8], result: SECRETS[9], person: 'p-3f9a', owner: true, startedAt: null, ...job })) },
  conversations: [
    { capabilityId: 'qq', streamId: 'private:12345678', personId: SECRETS[0], audience: 'private', label: 'p-3f9a', owner: false, messages: 42, lastAt, memoryEpoch: 3 },
    { capabilityId: 'qq', streamId: 'private:1', personId: 'person:owner', audience: 'private', label: '主人', owner: true, messages: 9, lastAt: NOON - 7200000, memoryEpoch: 1 },
    { capabilityId: 'qq', streamId: 'private:2', personId: 'person:qq:2', label: 'p-0000', messages: 0, lastAt: null },
  ],
});

test('authority mapping: quiet hours, running jobs and recent conversation become categories', () => {
  assert.deepEqual(fromAuthority(snapshot()), roomState({ source: 'authority', at: NOON, since: NOON - 3600000, activity: 'idle' }));
  const replying = fromAuthority(snapshot({ lastAt: NOON - 20000 }));
  assert.equal(replying.activity, 'replying'); assert.equal(replying.since, NOON - 20000);
  assert.equal(fromAuthority(snapshot({ lastAt: NOON - REPLYING_MS })).activity, 'replying');
  assert.equal(fromAuthority(snapshot({ lastAt: NOON - REPLYING_MS - 1 })).activity, 'idle');
  const working = fromAuthority(snapshot({ jobs: [{ status: 'queued' }, { status: 'running', startedAt: NOON - 60000 }, { status: 'done', startedAt: NOON - 900000 }] }));
  assert.equal(working.activity, 'working'); assert.equal(working.since, NOON - 60000);
  assert.equal(fromAuthority(snapshot({ jobs: [{ status: 'queued' }, { status: 'done' }] })).activity, 'idle');
  // Quiet hours: asleep since they began (23:30 the evening before, seen from 03:00), a job does not show, a message wakes her.
  const night = Date.UTC(2026, 10, 17, 19, 0, 0), asleep = fromAuthority({ ...snapshot({ quiet: true, jobs: [{ status: 'running', startedAt: night - 1000 }] }), now: night });
  assert.equal(asleep.activity, 'sleeping'); assert.equal(asleep.since, night - 3.5 * 3600000); assert.equal(asleep.lamp, 'off'); assert.equal(asleep.clock.phase, 'night');
  assert.equal(fromAuthority({ ...snapshot({ quiet: true, lastAt: night - 5000 }), now: night }).activity, 'replying');
  // A paused world does nothing; quiet hours still read as sleep.
  assert.equal(fromAuthority(snapshot({ paused: true, lastAt: NOON - 1000, jobs: [{ status: 'running', startedAt: NOON - 1000 }] })).activity, 'idle');
  assert.equal(fromAuthority(snapshot({ paused: true, quiet: true })).activity, 'sleeping');
});

test('authority mapping: missing or malformed input degrades to idle, never throws, never leaks', () => {
  assert.deepEqual(fromAuthority({ now: NOON }), roomState({ source: 'authority', at: NOON, activity: 'idle' }));
  const odd = fromAuthority({ now: NOON, world: 'x', initiative: { quietHours: { now: 'yes', from: 7 } }, jobs: { jobs: [null, { status: 'running', startedAt: 'soon' }, { status: 'running', startedAt: NOON + 5 }] }, conversations: [null, { lastAt: 'now' }, { lastAt: NOON + 60000 }, { lastAt: -4 }] });
  assert.equal(odd.activity, 'working'); assert.equal(odd.since, NOON);
  assert.equal(fromAuthority({ now: NOON, initiative: { quietHours: { now: true, from: 'late' } } }).since, NOON);
  assert.throws(() => fromAuthority({})); assert.throws(() => fromAuthority());
  for (const input of [snapshot(), snapshot({ lastAt: NOON - 1 }), snapshot({ quiet: true }), snapshot({ jobs: [{ status: 'running', startedAt: NOON - 1 }] })]) {
    const state = validateRoomState(fromAuthority(input)), json = JSON.stringify(state);
    for (const text of strings(state)) assert.ok(VOCABULARY.has(text), text);
    for (const secret of SECRETS.filter(item => item !== 'qq')) assert.ok(!json.includes(secret), secret);
    for (const page of [caption(state), ...HOTSPOT_SHOWS.map(shows => JSON.stringify(drawer(shows, state)))]) for (const secret of SECRETS) assert.ok(!page.includes(secret), secret);
  }
});

test('page text: captions and drawers are fixed sentences chosen by category', () => {
  assert.equal(caption(fixture('watching', NOON)), '看视频 · 14:00 白天 · 下雨');
  assert.deepEqual(drawer('activity', roomState({ source: 'fake', at: NOON, since: NOON - 12 * 60000, activity: 'replying', mood: 'cheerful' })), { title: '回消息', lines: ['她在回消息。', '已经 12 分钟', '看起来开心。'] });
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
  assert.deepEqual([...script.matchAll(/fetch\(([^,)]+)/g)].map(match => match[1]), ["'manifest.json'"]);
});
