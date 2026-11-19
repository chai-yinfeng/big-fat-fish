// Asset manifest (v1): which files the room is drawn from and where they sit on the stage. Swapping the
// placeholder art for real images or looping videos is a change to manifest.json and the files it names,
// not to code. All coordinates are stage units (manifest.stage), origin top-left.
import { ALL_POSES } from './state.js';

export const MANIFEST_VERSION = 1;
/** What a hotspot's drawer tells: always a category from the room state, never anything else. */
export const HOTSPOT_SHOWS = Object.freeze(['activity', 'weather', 'clock', 'lamp']);
const IMAGE = /\.(?:svg|png|jpe?g|webp|avif|gif)$/i, VIDEO = /\.(?:webm|mp4)$/i;
const fail = message => { throw Object.assign(new Error(message), { code: 'ROOM_MANIFEST_INVALID' }); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys, what) => { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid ' + what); };
/** A file next to the page: relative, forward slashes, no scheme, no `..`, no query. */
const local = (src, pattern) => typeof src === 'string' && src.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(src) && !src.includes('..') && !src.includes('//') && pattern.test(src);

/** Throws ROOM_MANIFEST_INVALID unless the manifest is complete and every position is on the stage. Returns it. */
export function validateManifest(manifest) {
  closed(manifest, ['version', 'stage', 'base', 'window', 'lamp', 'poses', 'hotspots'], 'manifest');
  if (manifest.version !== MANIFEST_VERSION) fail('Unsupported manifest version');
  closed(manifest.stage, ['width', 'height'], 'stage');
  const { width, height } = manifest.stage;
  if (!(Number.isInteger(width) && width >= 100 && width <= 10000 && Number.isInteger(height) && height >= 100 && height <= 10000)) fail('Invalid stage');
  const onStage = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= width && y >= 0 && y <= height;
  const polygon = (value, what) => { if (!Array.isArray(value) || value.length < 3 || value.length > 64 || value.some(point => !Array.isArray(point) || point.length !== 2 || !onStage(point[0], point[1]))) fail('Invalid polygon: ' + what); };
  closed(manifest.base, ['src'], 'base');
  if (!local(manifest.base.src, IMAGE)) fail('Invalid base image');
  if (manifest.window !== undefined) polygon(manifest.window, 'window');
  if (manifest.lamp !== undefined) {
    closed(manifest.lamp, ['x', 'y', 'radius'], 'lamp');
    if (!onStage(manifest.lamp.x, manifest.lamp.y) || !(manifest.lamp.radius > 0 && manifest.lamp.radius <= width)) fail('Invalid lamp');
  }
  if (!plain(manifest.poses)) fail('Invalid poses');
  for (const pose of Object.keys(manifest.poses)) if (!ALL_POSES.includes(pose)) fail('Unknown pose: ' + pose);
  for (const pose of ALL_POSES) {
    const slot = manifest.poses[pose];
    if (!slot) fail('Missing pose: ' + pose);
    closed(slot, ['kind', 'src', 'poster', 'anchor', 'width'], 'pose ' + pose);
    if (slot.kind === 'image') { if (!local(slot.src, IMAGE) || slot.poster !== undefined) fail('Invalid image for pose ' + pose); }
    else if (slot.kind === 'video') { if (!local(slot.src, VIDEO) || slot.poster !== undefined && !local(slot.poster, IMAGE)) fail('Invalid video for pose ' + pose); }
    else fail('Pose kind is image or video: ' + pose);
    closed(slot.anchor, ['x', 'y'], 'anchor of ' + pose);
    if (!onStage(slot.anchor.x, slot.anchor.y) || !(slot.width > 0 && slot.width <= width)) fail('Invalid placement of ' + pose);
  }
  if (!Array.isArray(manifest.hotspots) || manifest.hotspots.length > 32) fail('Invalid hotspots');
  const ids = new Set();
  for (const spot of manifest.hotspots) {
    closed(spot, ['id', 'shows', 'polygon'], 'hotspot');
    if (typeof spot.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(spot.id) || ids.has(spot.id)) fail('Invalid hotspot id');
    ids.add(spot.id);
    if (!HOTSPOT_SHOWS.includes(spot.shows)) fail('Unknown hotspot content: ' + spot.id);
    polygon(spot.polygon, spot.id);
  }
  return manifest;
}
/** Where a pose sits, in percent of the stage: `anchor` is the bottom centre of the picture (her feet). */
export function placement(manifest, pose) {
  const { anchor, width } = manifest.poses[pose], stage = manifest.stage;
  const percent = value => Math.round(value * 100000) / 1000;
  return { left: percent((anchor.x - width / 2) / stage.width), bottom: percent((stage.height - anchor.y) / stage.height), width: percent(width / stage.width) };
}
