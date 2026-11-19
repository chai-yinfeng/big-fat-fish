import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DECLARATIONS, CAPABILITIES, ACTIVITIES } from './index.js';
import { CATEGORIES } from '../../model-gateway/spend.mjs';

test('the registry lists every declared capability once, as frozen dependency-free data', () => {
  assert.deepEqual(CAPABILITIES.map(item => item.id), ['chat', 'consolidation', 'vision', 'sticker', 'web', 'speech-tts', 'speech-asr', 'proactive', 'demo', 'video', 'video-note', 'video-frame']);
  // One directory per capability, and none that the index forgot.
  const directories = fs.readdirSync(fileURLToPath(new URL('./', import.meta.url)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  // The declarations without a meter (content actions that are not counted) have a directory and no ledger row.
  assert.deepEqual(DECLARATIONS.filter(item => !item.meter).map(item => item.id), ['media', 'sticker-library', 'job']);
  assert.deepEqual(DECLARATIONS.filter(item => item.meter), [...CAPABILITIES]);
  assert.deepEqual(directories, DECLARATIONS.map(item => item.id).sort());
  for (const id of directories) assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL(`./${id}/manifest.js`, import.meta.url)), 'utf8'), /^\s*import\s|require\(/m, `${id}: a declaration imports nothing`);
  assert.ok(Object.isFrozen(CAPABILITIES) && CAPABILITIES.every(item => Object.isFrozen(item) && Object.isFrozen(item.meter) && Object.isFrozen(item.actions)));
  assert.doesNotThrow(() => JSON.stringify(CAPABILITIES));
});

test('every declaration has the same closed shape', () => {
  for (const item of DECLARATIONS) {
    assert.deepEqual(Object.keys(item).sort(), ['actions', 'config', 'credentials', 'forget', 'id', 'meter', 'operatorConfig', 'outputs', 'runtime', 'title', 'visibility'], item.id);
    assert.match(item.id, /^[a-z][a-z0-9-]{1,31}$/); assert.ok(item.title.length > 0 && item.title.length <= 12);
    assert.ok(item.actions.length && item.actions.every(action => /^[a-z]+$/.test(action.name) && ['sync', 'background'].includes(action.mode) && (action.model === false || typeof action.model === 'object') && Object.keys(action).sort().join() === 'content,mode,model,name'), item.id);
    assert.equal(item.visibility, 'private');
    assert.ok(item.outputs.length && item.outputs.every(output => typeof output.type === 'string' && (output.derived === null || typeof output.derived === 'string')), item.id);
    assert.ok(typeof item.runtime.process === 'string' && typeof item.runtime.subprocess === 'boolean', item.id);
    const { meter } = item;
    // Not metered: no ledger row, no credentials of its own.
    if (meter === null) { assert.deepEqual(item.credentials, [], item.id); continue; }
    assert.deepEqual(Object.keys(meter).filter(key => key !== 'legacyCounter' && key !== 'via').sort(), ['dailyLimit', 'kind', 'perPerson', 'source', 'spendCategory', 'stopTier', 'unit', 'units'], item.id);
    assert.ok(['paid', 'local'].includes(meter.kind) && ['gateway', 'reported'].includes(meter.source) && Array.isArray(meter.units) && typeof meter.perPerson === 'boolean', item.id);
    assert.ok(meter.dailyLimit === null || Number.isSafeInteger(meter.dailyLimit) && meter.dailyLimit >= 0 && meter.dailyLimit <= 1000, item.id);
    // Money: a paid capability names the spend category it is charged to and the tier that stops it; a local one names neither.
    if (meter.kind === 'paid') assert.ok(CATEGORIES.includes(meter.spendCategory) && ['reduced', 'restricted', 'exhausted'].includes(meter.stopTier), item.id);
    else assert.deepEqual([meter.spendCategory, meter.stopTier], [null, null], item.id);
    // Credentials are locations inside the data root, never values.
    assert.ok(item.credentials.every(entry => Object.keys(entry).sort().join() === 'holder,location,name' && !entry.location.startsWith('/') && !entry.location.includes('..')), item.id);
  }
});

test('metering as it is today: vision 12 and web 20 a day on the legacy counters, local speech only reported', () => {
  const meter = Object.fromEntries(CAPABILITIES.map(item => [item.id, item.meter]));
  assert.deepEqual([meter.vision.dailyLimit, meter.vision.legacyCounter, meter.web.dailyLimit, meter.web.legacyCounter], [12, 'visionCalls', 20, 'webCalls']);
  assert.deepEqual([meter.chat.spendCategory, meter.chat.stopTier, meter.consolidation.spendCategory, meter.consolidation.stopTier], ['conversation', 'exhausted', 'maintenance', 'restricted']);
  assert.deepEqual([meter.chat.dailyLimit, meter.consolidation.dailyLimit], [null, null]);
  assert.deepEqual([meter['speech-tts'].source, meter['speech-tts'].units, meter['speech-asr'].source, meter['speech-asr'].units], ['reported', ['chars', 'audioSeconds'], 'reported', ['audioSeconds']]);
  assert.deepEqual(CAPABILITIES.filter(item => item.meter.source === 'gateway').map(item => item.id), ['chat', 'consolidation', 'vision', 'sticker', 'web', 'proactive', 'video-note', 'video-frame']);
});

test('companion_activity offers exactly the actions declared for it: watching a video, its status, its pages and its stills', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ACTIVITIES)), [{ capability: 'video', title: '看视频', actions: ['watch', 'status', 'page', 'frames'] }]);
  const meter = Object.fromEntries(CAPABILITIES.map(item => [item.id, item.meter]));
  // A new video takes one of six daily slots of a local row; the summary's money is its own paid row, stopped at the restricted tier.
  assert.deepEqual([meter.video.kind, meter.video.source, meter.video.dailyLimit, meter['video-note'].spendCategory, meter['video-note'].stopTier, meter['video-note'].dailyLimit], ['local', 'reported', 6, 'activity', 'restricted', null]);
  // A still is a paid gateway row of its own: six a day, the money in vision's category, stopped at the restricted tier; nothing the model calls.
  assert.deepEqual([meter['video-frame'].kind, meter['video-frame'].source, meter['video-frame'].dailyLimit, meter['video-frame'].spendCategory, meter['video-frame'].stopTier], ['paid', 'gateway', 6, 'vision', 'restricted']);
  assert.equal(CAPABILITIES.find(item => item.id === 'video-frame').actions.some(action => action.model), false);
  // Nothing of a particular site is in the declaration: it only points at the operator's file.
  assert.equal(CAPABILITIES.find(item => item.id === 'video').operatorConfig, 'operator/providers/video.json');
});
