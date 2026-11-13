import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from './index.js';
import { CATEGORIES } from '../../model-gateway/spend.mjs';

test('the registry lists every declared capability once, as frozen dependency-free data', () => {
  assert.deepEqual(CAPABILITIES.map(item => item.id), ['chat', 'consolidation', 'vision', 'web', 'speech-tts', 'speech-asr', 'proactive', 'demo']);
  // One directory per capability, and none that the index forgot.
  const directories = fs.readdirSync(fileURLToPath(new URL('./', import.meta.url)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(directories, CAPABILITIES.map(item => item.id).sort());
  for (const id of directories) assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL(`./${id}/manifest.js`, import.meta.url)), 'utf8'), /^\s*import\s|require\(/m, `${id}: a declaration imports nothing`);
  assert.ok(Object.isFrozen(CAPABILITIES) && CAPABILITIES.every(item => Object.isFrozen(item) && Object.isFrozen(item.meter) && Object.isFrozen(item.actions)));
  assert.doesNotThrow(() => JSON.stringify(CAPABILITIES));
});

test('every declaration has the same closed shape', () => {
  for (const item of CAPABILITIES) {
    assert.deepEqual(Object.keys(item).sort(), ['actions', 'credentials', 'id', 'meter', 'operatorConfig', 'outputs', 'runtime', 'title', 'visibility'], item.id);
    assert.match(item.id, /^[a-z][a-z0-9-]{1,31}$/); assert.ok(item.title.length > 0 && item.title.length <= 12);
    assert.ok(item.actions.length && item.actions.every(action => /^[a-z]+$/.test(action.name) && ['sync', 'background'].includes(action.mode) && typeof action.model === 'boolean'), item.id);
    const { meter } = item;
    assert.deepEqual(Object.keys(meter).filter(key => key !== 'legacyCounter').sort(), ['dailyLimit', 'kind', 'perPerson', 'source', 'spendCategory', 'stopTier', 'unit', 'units'], item.id);
    assert.ok(['paid', 'local'].includes(meter.kind) && ['gateway', 'reported'].includes(meter.source) && Array.isArray(meter.units) && typeof meter.perPerson === 'boolean', item.id);
    assert.ok(meter.dailyLimit === null || Number.isSafeInteger(meter.dailyLimit) && meter.dailyLimit >= 0 && meter.dailyLimit <= 1000, item.id);
    // Money: a paid capability names the spend category it is charged to and the tier that stops it; a local one names neither.
    if (meter.kind === 'paid') assert.ok(CATEGORIES.includes(meter.spendCategory) && ['reduced', 'restricted', 'exhausted'].includes(meter.stopTier), item.id);
    else assert.deepEqual([meter.spendCategory, meter.stopTier], [null, null], item.id);
    // Credentials are locations inside the data root, never values.
    assert.ok(item.credentials.every(entry => Object.keys(entry).sort().join() === 'holder,location,name' && !entry.location.startsWith('/') && !entry.location.includes('..')), item.id);
    assert.equal(item.visibility, 'private');
    assert.ok(item.outputs.length && item.outputs.every(output => typeof output.type === 'string' && (output.derived === null || typeof output.derived === 'string')), item.id);
    assert.ok(typeof item.runtime.process === 'string' && typeof item.runtime.subprocess === 'boolean', item.id);
  }
});

test('metering as it is today: vision 12 and web 20 a day on the legacy counters, local speech only reported', () => {
  const meter = Object.fromEntries(CAPABILITIES.map(item => [item.id, item.meter]));
  assert.deepEqual([meter.vision.dailyLimit, meter.vision.legacyCounter, meter.web.dailyLimit, meter.web.legacyCounter], [12, 'visionCalls', 20, 'webCalls']);
  assert.deepEqual([meter.chat.spendCategory, meter.chat.stopTier, meter.consolidation.spendCategory, meter.consolidation.stopTier], ['conversation', 'exhausted', 'maintenance', 'restricted']);
  assert.deepEqual([meter.chat.dailyLimit, meter.consolidation.dailyLimit], [null, null]);
  assert.deepEqual([meter['speech-tts'].source, meter['speech-tts'].units, meter['speech-asr'].source, meter['speech-asr'].units], ['reported', ['chars', 'audioSeconds'], 'reported', ['audioSeconds']]);
  assert.deepEqual(CAPABILITIES.filter(item => item.meter.source === 'gateway').map(item => item.id), ['chat', 'consolidation', 'vision', 'web', 'proactive']);
});
