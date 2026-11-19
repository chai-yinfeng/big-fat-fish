// The room page: draws a room state through the asset manifest. It reads a state and shows it; it never
// decides what she does. Live state when this page's server offers it (README.md, "真实数据"), else the fake provider.
import { ACTIVITIES, WEATHERS, PHASES, roomState, validateRoomState } from './state.js';
import { fakeState, fixture, STEP_MS } from './providers/fake.js';
import { liveState, POLL_MS } from './providers/authority.js';
import { validateManifest, placement } from './manifest.js';
import { ACTIVITY_TEXT, WEATHER_TEXT, PHASE_TEXT, caption, drawer } from './view.js';

const SVG = 'http://www.w3.org/2000/svg';
const $ = selector => document.querySelector(selector);
const svg = (name, attributes = {}, parent) => { const node = document.createElementNS(SVG, name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); parent?.append(node); return node; };
const points = polygon => polygon.map(point => point.join(',')).join(' ');
/** A minute in the middle of each phase, for the dev control's "时段". */
const PHASE_MINUTE = { dawn: 6 * 60, day: 13 * 60, dusk: 18 * 60, night: 22 * 60 };

const query = new URLSearchParams(location.search);
const stage = $('#stage'), poses = $('.poses'), panel = $('#drawer');
let manifest, state, shownPose = null, open = null;

function buildSky() {
  const sky = $('.sky'), { width, height } = manifest.stage;
  sky.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (!manifest.window) return;
  const xs = manifest.window.map(point => point[0]), ys = manifest.window.map(point => point[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), w = x1 - x0, h = y1 - y0;
  svg('polygon', { points: points(manifest.window) }, svg('clipPath', { id: 'window-clip' }, svg('defs', {}, sky)));
  const inside = svg('g', { 'clip-path': 'url(#window-clip)' }, sky);
  svg('rect', { class: 'sky-fill', x: x0, y: y0, width: w, height: h }, inside);
  svg('circle', { class: 'orb', cx: x0 + w * .62, cy: y0 + h * .36, r: Math.min(w, h) * .12 }, inside);
  const clouds = svg('g', { class: 'clouds' }, inside), rain = svg('g', { class: 'rain' }, inside), snow = svg('g', { class: 'snow' }, inside);
  for (const [fx, fy, rx] of [[.3, .35, .2], [.55, .3, .24], [.75, .5, .18]]) svg('ellipse', { cx: x0 + w * fx, cy: y0 + h * fy, rx: w * rx, ry: h * .1 }, clouds);
  // A fixed scatter (no randomness: the same page every time), one tile taller than the window so the loop is seamless.
  for (let index = 0; index < 28; index++) {
    const x = x0 + (index * 37 % 100) / 100 * w, y = y0 - 60 + (index * 53 % 100) / 100 * (h + 60);
    svg('line', { x1: x, y1: y, x2: x - 5, y2: y + 20 }, rain);
    svg('circle', { cx: x, cy: y, r: 3 + index % 3 }, snow);
  }
  svg('polygon', { class: 'frame', points: points(manifest.window) }, sky);
}
function buildHotspots() {
  const layer = $('.hotspots'), { width, height } = manifest.stage;
  layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
  for (const spot of manifest.hotspots) {
    const node = svg('polygon', { points: points(spot.polygon), tabindex: '0', role: 'button', 'aria-label': drawer(spot.shows, state).title }, layer);
    const show = () => openDrawer(spot.shows);
    node.addEventListener('click', show);
    node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
  }
}
function openDrawer(shows) { open = shows; renderDrawer(); }
function renderDrawer() {
  panel.hidden = open === null;
  if (open === null) return;
  const { title, lines } = drawer(open, state);
  panel.querySelector('h2').textContent = title;
  panel.querySelector('.lines').replaceChildren(...lines.map(line => Object.assign(document.createElement('p'), { textContent: line })));
}
/** The pose slot: an <img>, or a muted looping <video> when the manifest says so. */
function showPose(pose) {
  if (pose === shownPose) return;
  shownPose = pose;
  const slot = manifest.poses[pose], place = placement(manifest, pose);
  const holder = Object.assign(document.createElement('button'), { type: 'button', className: 'pose' });
  holder.dataset.pose = pose;
  holder.style.left = place.left + '%'; holder.style.bottom = place.bottom + '%'; holder.style.width = place.width + '%';
  let media;
  if (slot.kind === 'video') {
    media = Object.assign(document.createElement('video'), { src: slot.src, muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto' });
    if (slot.poster) media.poster = slot.poster;
    media.play?.().catch(() => {});
  } else media = Object.assign(document.createElement('img'), { src: slot.src, alt: '' });
  holder.append(media);
  holder.addEventListener('click', () => openDrawer('activity'));
  poses.replaceChildren(holder);
}
function render(next) {
  state = validateRoomState(next);
  Object.assign(stage.dataset, { activity: state.activity, phase: state.clock.phase, weather: state.weather, lamp: state.lamp });
  showPose(state.pose);
  poses.firstElementChild.setAttribute('aria-label', ACTIVITY_TEXT[state.activity][0]);
  $('#caption').textContent = caption(state);
  renderDrawer();
}

// Fake provider and its dev control. `?activity=sleeping` forces one; `?step=2000` changes the timeline's pace.
const dev = $('#dev');
const stepMs = /^\d{3,6}$/.test(query.get('step') ?? '') ? Number(query.get('step')) : STEP_MS;
let forcedSince = Date.now();
function fakeNow() {
  const now = Date.now(), forced = dev.elements.activity.value, weather = dev.elements.weather.value, phase = dev.elements.phase.value;
  const base = forced ? fixture(forced, now) : fakeState(now, { stepMs });
  return roomState({ source: 'fake', at: now, since: forced ? Math.min(forcedSince, now) : base.since, activity: base.activity, mood: base.mood, weather: weather || base.weather, minute: phase ? PHASE_MINUTE[phase] : base.clock.minute });
}
function buildDev() {
  const fill = (select, first, values, text) => select.replaceChildren(new Option(first, ''), ...values.map(value => new Option(text(value), value)));
  fill(dev.elements.activity, '按时间线', ACTIVITIES, value => ACTIVITY_TEXT[value][0]);
  fill(dev.elements.weather, '按时间线', WEATHERS, value => WEATHER_TEXT[value]);
  fill(dev.elements.phase, '按时间线', PHASES, value => PHASE_TEXT[value]);
  if (ACTIVITIES.includes(query.get('activity'))) dev.elements.activity.value = query.get('activity');
  dev.addEventListener('change', event => { if (event.target === dev.elements.activity) forcedSince = Date.now(); render(fakeNow()); });
  dev.addEventListener('submit', event => event.preventDefault());
  dev.hidden = false;
}

const notify = message => { const notice = $('#notice'); notice.textContent = message ?? ''; notice.hidden = !message; };
async function start() {
  // Live unless `?fake=1`: the server says whether it has live state. While it has but cannot read it, wait and retry.
  let first = null;
  if (query.get('fake') !== '1') for (;;) {
    try { first = await liveState(); break; } catch (error) { notify(error.message); await new Promise(resolve => setTimeout(resolve, POLL_MS)); }
  }
  const live = first !== null;
  if (!live && query.get('fake') === '0') throw new Error('这个预览服务没有接真实数据（启动方式见 README“真实数据”）。去掉 ?fake=0 看假数据。');
  notify(null);
  const response = await fetch('manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('manifest.json 读不到');
  manifest = validateManifest(await response.json());
  stage.style.aspectRatio = `${manifest.stage.width} / ${manifest.stage.height}`;
  $('.base').src = manifest.base.src;
  if (manifest.lamp) for (const [name, value] of [['--lamp-x', manifest.lamp.x / manifest.stage.width], ['--lamp-y', manifest.lamp.y / manifest.stage.height], ['--lamp-rx', manifest.lamp.radius / manifest.stage.width], ['--lamp-ry', manifest.lamp.radius / manifest.stage.height]]) $('.glow').style.setProperty(name, value * 100 + '%');
  if (!live) buildDev();
  state = live ? first : fakeNow();
  buildSky(); buildHotspots();
  panel.querySelector('.close').addEventListener('click', () => { open = null; renderDrawer(); });
  stage.hidden = false;
  render(state);
  // A failed poll keeps the last drawing and says so; the next one that works clears the notice.
  if (live) setInterval(async () => { try { const next = await liveState(); if (next) { render(next); notify(null); } } catch (error) { notify(error.message); } }, POLL_MS);
  else setInterval(() => render(fakeNow()), 500);
}
start().catch(error => notify(error.message));
