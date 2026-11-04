import test from 'node:test';
import assert from 'node:assert/strict';
import baseline from './fixtures/legacy-inner-diary-schema.json' with { type: 'json' };
import { TOOL_SCHEMA } from '../lib/adapter.js';
import { CONTENT_TOOL_SCHEMA } from '../lib/content.js';

// Host Inspect exposes tokenMeter.measure/estimateMessage but no invocation
// interface. Desktop's app.asar cannot be imported by the external Node test
// runner. These are the inspected host heuristic's exact text/tool formulas
// (dsh-token-meter/lib/index.js:16-18,39-45,61-85), NOT tokenizer counts.
const toolsEstimate = tools => Math.ceil(JSON.stringify(tools).length / 4) + 4;
const systemEstimate = text => Math.ceil(text.length / 4) + 4;
const userEstimate = text => Math.ceil(text.length / 4) + 8;

test('records old/new first-turn contribution under the same host-compatible estimator', t => {
  // Keep the exact comparison schema, not a runtime dependency on the retired shell.
  const before = [baseline.tool];
  const after = [TOOL_SCHEMA];
  const common = systemEstimate('Fixed comparison fixture; all other plugins excluded.') + userEstimate('I prefer tea.');
  const oldTools = toolsEstimate(before); const newTools = toolsEstimate(after);
  const report = {
    precision: 'estimate, not exact provider tokens',
    estimator: 'inspected DSH tokenMeter fixed 4 chars/token + framing',
    scope: 'controlled first-turn fixture, schema contribution only; live persona/memory context excluded',
    beforeToolCount: before.length, afterToolCount: after.length,
    beforeToolTokens: oldTools, afterToolTokens: newTools,
    beforeFirstTurnTokens: common + oldTools, afterFirstTurnTokens: common + newTools,
    deltaTokens: newTools - oldTools,
  };
  t.diagnostic(JSON.stringify(report));
  assert.equal(after.length, 1);
  assert.ok(newTools < 600);
});


test('records 0.7 to memory-search/read/recall schema change with the same estimator', t => {
  const previous = structuredClone(TOOL_SCHEMA);
  previous.description = 'Discover current evidence, propose memory, or check a receipt. Pending is not remembered. No worthwhile finding needs no proposal.';
  previous.parameters.properties.action.enum = ['evidence', 'propose', 'receipt'];
  previous.parameters.properties.id.description = 'Stable proposal key, 1–96 characters; propose/receipt only. Reuse on retry.';
  delete previous.parameters.properties.query;
  delete previous.parameters.properties.from; delete previous.parameters.properties.to;
  const common = systemEstimate('Fixed comparison fixture; all other plugins excluded.') + userEstimate('I prefer tea.');
  t.diagnostic(JSON.stringify({ precision: 'estimate, not exact provider tokens', scope: '0.7 vs search/read/recall first-turn schema contribution; other prompt/context excluded', beforeToolTokens: toolsEstimate([previous]), afterToolTokens: toolsEstimate([TOOL_SCHEMA]), beforeFirstTurnTokens: common + toolsEstimate([previous]), afterFirstTurnTokens: common + toolsEstimate([TOOL_SCHEMA]), deltaTokens: toolsEstimate([TOOL_SCHEMA]) - toolsEstimate([previous]) }));
  assert.ok(toolsEstimate([TOOL_SCHEMA]) < 600);
});

test('records the separate content tool first-turn contribution without expanding memory schema', t => {
  const before = toolsEstimate([TOOL_SCHEMA]), after = toolsEstimate([TOOL_SCHEMA, CONTENT_TOOL_SCHEMA]);
  const common = systemEstimate('Fixed comparison fixture; all other plugins excluded.') + userEstimate('I prefer tea.');
  t.diagnostic(JSON.stringify({ precision: 'estimate, not exact provider tokens', scope: '0.8 memory tool vs memory plus content schema; other context excluded', beforeToolTokens: before, afterToolTokens: after, beforeFirstTurnTokens: common + before, afterFirstTurnTokens: common + after, deltaTokens: after - before }));
  assert.equal(TOOL_SCHEMA.name, 'companion_scope'); assert.equal(CONTENT_TOOL_SCHEMA.name, 'companion_content');
  assert.ok(after - before < 300);
});
