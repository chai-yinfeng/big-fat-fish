// Consistency: every hand-written list of capabilities, actions, fields, purposes and spend categories in the
// product, held against the capability declarations and the tables derived from them (./index.js). The executor
// (tools.js), the model gateway, the content service, Authority's /v1/content and the console's spend card read their
// tables already; each other test here names one list that is still written by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DECLARATIONS, CAPABILITIES, ACTIVITIES, ACTIVITY_TOOL, CONTENT_TOOL, MODEL_ACTIONS, ACTIVITY_TOOL_DEFINITION, CONTENT_SCOPE_FIELDS, CONTENT_ACTIONS, CONTENT_FIELDS, GATEWAY_PURPOSES, SPEND_CATEGORIES, SPEND_STOP, GATEWAY_DEFAULT_LIMITS, CONFIGS, FORGET_OWNERS } from './index.js';
import { TOOL_RULES } from '../conversation/tool-rules.js';
import { ACTIVITY_TOOL_SCHEMA, CONTENT_TOOL_SCHEMA, SCOPE_TOOL_SCHEMA, createCompanionTools } from '../conversation/tools.js';
import { CATEGORIES, STOP, RESERVED_STOP } from '../../model-gateway/spend.mjs';
import { CONTENT_SERVICE_ACTIONS, checkContentActions } from '../media/service.js';
import { CHANNELS } from '../channels/index.js';

const source = file => fs.readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
const sorted = list => [...list].sort();
const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
const keysOf = text => text.split(',').map(part => part.trim().replace(/:.*$/s, '').replace(/'/g, '')).filter(Boolean);
const found = (text, pattern, what) => { const match = pattern.exec(text); assert.ok(match, `${what}: the hand-written list was not found where this test looks for it`); return match[1]; };

test('declarations: the new fields have one closed shape, and `rules` only picks names from the tool layer\'s table', () => {
  for (const item of DECLARATIONS) {
    for (const action of item.actions) {
      const where = `${item.id}.${action.name}`;
      if (action.content !== null) {
        assert.deepEqual(Object.keys(action.content), ['action', 'fields', 'source'], where);
        assert.match(action.content.action, /^[a-zA-Z]+$/, where);
        assert.ok(['required', 'optional', 'none'].includes(action.content.source), where);
        // A source message is the field `sourceEventId`; the scope fields are never an action's own.
        assert.equal(action.content.fields.includes('sourceEventId'), action.content.source !== 'none', where);
        assert.deepEqual(action.content.fields.filter(field => CONTENT_SCOPE_FIELDS.includes(field)), [], where);
      }
      if (action.model === false) continue;
      const activity = action.model.tool === ACTIVITY_TOOL;
      assert.deepEqual(Object.keys(action.model).sort(), activity ? ['description', 'input', 'rules', 'tool'] : ['input', 'rules', 'tool'], where);
      assert.ok([ACTIVITY_TOOL, CONTENT_TOOL].includes(action.model.tool), where);
      // What the model may call is reached through /v1/content.
      assert.notEqual(action.content, null, where);
      for (const [key, field] of Object.entries(action.model.input)) {
        assert.equal(typeof field.required, 'boolean', `${where} ${key}`);
        // Only a generated tool carries what the model is shown; the frozen tool's schema stays in tools.js.
        assert.deepEqual(Object.keys(field).filter(name => name !== 'max').sort(), activity ? ['description', 'required', 'schema'] : ['required'], `${where} ${key}`);
      }
      assert.ok(action.model.rules.length && action.model.rules.every(rule => Object.hasOwn(TOOL_RULES, rule)), `${where}: rules must be names of capabilities/conversation/tool-rules.js`);
      assert.equal(new Set(action.model.rules).size, action.model.rules.length, where);
      // Every model action is bound to the scope and re-checked; an activity is never open in a turn she started.
      assert.ok(['scopeBound', 'worldGuard', 'derivedNotEvidence'].every(rule => action.model.rules.includes(rule)), where);
      if (activity) assert.ok(['notInitiated', 'neutralizeExternalText'].every(rule => action.model.rules.includes(rule)), where);
    }
    if (item.meter?.via) {
      assert.deepEqual(Object.keys(item.meter.via), ['capability', 'purpose'], item.id);
      const route = CAPABILITIES.find(other => other.id === item.meter.via.capability);
      // Borrowing a route keeps the money where the route's is.
      assert.deepEqual([route?.meter.source, route?.meter.spendCategory, route?.meter.stopTier], ['gateway', item.meter.spendCategory, item.meter.stopTier], item.id);
    }
    if (item.config !== null) assert.deepEqual(Object.keys(item.config), ['file', 'module', 'load'], item.id);
    assert.equal(item.config?.file ?? null, item.operatorConfig, `${item.id}: config.file is the operatorConfig file`);
    if (item.forget !== null) assert.deepEqual([Object.keys(item.forget), typeof item.forget.what], [['owner', 'what'], 'string'], item.id);
  }
  // No name in the table that no declaration uses.
  assert.deepEqual(sorted(new Set(MODEL_ACTIONS.flatMap(action => action.rules))), sorted(Object.keys(TOOL_RULES)));
  // Name -> function: each rule is code of the tool layer, run at one of its stages.
  assert.ok(Object.isFrozen(TOOL_RULES) && Object.values(TOOL_RULES).every(rule => typeof rule === 'function' && ['turn', 'request', 'call', 'result'].includes(rule.stage) && typeof rule.text === 'string' && rule.text.length > 0));
  // The seven actions that had no declaration now have one, none of them with a ledger row.
  const unmetered = DECLARATIONS.filter(item => !item.meter).flatMap(item => item.actions.map(action => action.content.action));
  assert.deepEqual(unmetered, ['ingest', 'asset', 'attach', 'pending', 'stickerKeep', 'stickerPick', 'jobResult']);
});

test('executor (tools.js): the companion_activity definition is the generated one', () => {
  // service.test.js pins what is sent to the provider (PINNED_ALL_TOOLS_SHA256) from tools.js, so the bytes of the
  // generated definition are held there.
  assert.equal(ACTIVITY_TOOL_SCHEMA, ACTIVITY_TOOL_DEFINITION);
  // The executor checks a declared field as a string or an integer, nothing else.
  for (const action of MODEL_ACTIONS.filter(action => action.tool === ACTIVITY_TOOL)) for (const key of action.keys) assert.ok(['string', 'integer'].includes(action.input[key].schema.type), `${action.capability}.${action.action} ${key}`);
  assert.deepEqual(MODEL_ACTIONS.filter(action => action.tool === ACTIVITY_TOOL).map(action => `${action.capability}.${action.action}`), ACTIVITIES.flatMap(item => item.actions.map(action => `${item.capability}.${action}`)));
  // One field name means one thing across the tool: no two actions declare the same input field.
  const fields = MODEL_ACTIONS.filter(action => action.tool === ACTIVITY_TOOL).flatMap(action => action.keys);
  assert.equal(new Set(fields).size, fields.length);
});

test('executor (tools.js): the frozen companion_content tool offers exactly the declared actions and fields', async () => {
  const declared = MODEL_ACTIONS.filter(action => action.tool === CONTENT_TOOL), properties = CONTENT_TOOL_SCHEMA.parameters.properties;
  assert.deepEqual(sorted(properties.action.enum), sorted(declared.map(action => action.action)));
  assert.deepEqual(sorted(Object.keys(properties).filter(key => key !== 'action')), sorted(new Set(declared.flatMap(action => action.keys))));
  // The dispatch is the declarations': an action that is not a declared one of this tool is refused before anything
  // is asked (a content action's own name, another tool's action, no action at all).
  const asked = [];
  const tool = createCompanionTools({ authority: {}, content: { call: async request => { asked.push(request); return {}; } }, scope: { streamId: 's1', memoryEpoch: 3 }, requestId: 'r1', evidence: [], guard: async () => {} }).find(item => item.name === CONTENT_TOOL);
  const undeclared = [...CONTENT_ACTIONS.map(row => row.action), ...MODEL_ACTIONS.filter(action => action.tool !== CONTENT_TOOL).map(action => action.action), undefined].filter(name => !declared.some(action => action.action === name));
  for (const action of undeclared) await assert.rejects(tool.execute('call', { action, ref: 'ref-1', url: 'https://video.invalid/v/1', query: 'weather' }), { code: 'INVALID_REQUEST' }, String(action));
  assert.equal(asked.length, 0);
});

// The two older model tools, written out: the whole list of what they offer. An approval gate, not a ban: an action
// that belongs in one of them by meaning is added there, by changing this list with the owner's approval (the tool
// definition changes, so the prompt cache is lost once).
const FROZEN_TOOLS = Object.freeze({
  // Her own memory, which Authority owns. No capability declaration offers anything through it today.
  companion_scope: Object.freeze({ actions: ['evidence', 'propose', 'receipt', 'search', 'read', 'recall'], declared: [] }),
  companion_content: Object.freeze({ actions: ['search', 'read', 'describe', 'transcribe', 'attach'], declared: ['vision.describe', 'web.search', 'web.read', 'speech-asr.transcribe', 'media.attach'] }),
});

test('frozen tools: companion_scope and companion_content offer the written-out actions, and no declaration adds one', () => {
  const how = '按语义选工具：同步只读查阅→companion_content；她的记忆→companion_scope；要花时间或有副作用→companion_activity。往前两个工具加动作需要更新冻结名单（consistency.test.js 的 FROZEN_TOOLS；经主人批准，会让提示缓存失效一次）。';
  assert.deepEqual(SCOPE_TOOL_SCHEMA.parameters.properties.action.enum, FROZEN_TOOLS.companion_scope.actions, how);
  assert.deepEqual(CONTENT_TOOL_SCHEMA.parameters.properties.action.enum, FROZEN_TOOLS.companion_content.actions, how);
  assert.deepEqual([SCOPE_TOOL_SCHEMA.name, CONTENT_TOOL_SCHEMA.name, CONTENT_TOOL], ['companion_scope', 'companion_content', 'companion_content']);
  for (const item of DECLARATIONS) for (const action of item.actions) {
    if (!action.model || !Object.hasOwn(FROZEN_TOOLS, action.model.tool)) continue;
    const frozen = FROZEN_TOOLS[action.model.tool], name = `${item.id}.${action.name}`;
    assert.ok(frozen.declared.includes(name) && frozen.actions.includes(action.name), `${name} 声明了 model.tool: '${action.model.tool}'，但它不在冻结名单里。${how}`);
  }
  // And none has gone missing: the list is exactly what is declared.
  for (const [tool, frozen] of Object.entries(FROZEN_TOOLS)) assert.deepEqual(DECLARATIONS.flatMap(item => item.actions.filter(action => action.model && action.model.tool === tool).map(action => `${item.id}.${action.name}`)), frozen.declared, how);
});

test('executor (tools.js): every declared model action runs with its declared fields and reaches its declared content action', async () => {
  const sample = { ref: 'ref-1', question: 'what is this', query: 'weather', url: 'https://video.invalid/v/1', page: 2 };
  const scope = { streamId: 's1', memoryEpoch: 3 }, asked = [];
  const tools = createCompanionTools({ authority: {}, content: { call: async request => { asked.push(request); return { text: 'x' }; } }, scope, requestId: 'r1', evidence: [{ ref: 'obs-1', eventId: 'e1', role: 'user' }], guard: async () => {}, turn: { text: `看看 ${sample.url}`, initiated: false } });
  const tool = name => tools.find(item => item.name === name);
  for (const action of MODEL_ACTIONS) {
    const where = `${action.capability}.${action.action}`, pick = keys => Object.fromEntries(keys.map(key => [key, sample[key]]));
    const call = input => action.tool === ACTIVITY_TOOL ? { capability: action.capability, action: action.action, input } : { action: action.action, ...input };
    for (const keys of new Set([action.required, action.keys])) {
      asked.length = 0;
      await tool(action.tool).execute('call', call(pick(keys)));
      assert.equal(asked.length, 1, where);
      const [request] = asked, used = CONTENT_ACTIONS.find(row => row.action === action.contentAction).uses.find(use => use.capability === action.capability && use.name === action.action);
      assert.equal(request.action, action.contentAction, where);
      if (action.tool === ACTIVITY_TOOL) assert.deepEqual([request.capability, request.activity], [action.capability, action.action], where);
      // Nothing reaches the content service that the declaration does not list.
      assert.deepEqual(Object.keys(request).filter(key => ![...CONTENT_SCOPE_FIELDS, ...used.fields].includes(key)), [], where);
      assert.equal(Object.hasOwn(request, 'sourceEventId'), used.source === 'required', where);
      assert.equal(Object.hasOwn(request, 'requestId'), action.rules.includes('requestBound'), where);
    }
    // A field the declaration does not list is refused, and so is a missing required one.
    asked.length = 0;
    await assert.rejects(tool(action.tool).execute('call', call({ ...pick(action.required), undeclared: 'x' })), { code: 'INVALID_REQUEST' }, where);
    if (action.required.length) await assert.rejects(tool(action.tool).execute('call', call({})), { code: 'INVALID_REQUEST' }, where);
    assert.equal(asked.length, 0, where);
  }
});

test('Authority (server.js /v1/content): the action allowlist, the field allowlist and "must carry a source" are read from the derived table', () => {
  const server = source('authority/src/server.js'), route = server.split("route === '/v1/content'")[1]?.split('} else if (')[0];
  assert.ok(route, 'the /v1/content branch');
  assert.ok(server.includes("import { CONTENT_ACTIONS, CONTENT_FIELDS } from '../../capabilities/providers/index.js';"));
  assert.ok(route.includes('bodyOf(req, CONTENT_FIELDS,'), 'field allowlist from CONTENT_FIELDS');
  assert.ok(route.includes('const declared = CONTENT_ACTIONS.find(row => row.action === body.action);') && route.includes("if (!declared) throw failure('INVALID_REQUEST');"), 'action allowlist from CONTENT_ACTIONS');
  assert.ok(route.includes("if (declared.sourceRequired && typeof body.sourceEventId !== 'string') throw failure('INVALID_REQUEST');"), 'source rule from CONTENT_ACTIONS');
  assert.doesNotMatch(route, /\[\s*'\w+'\s*,/, 'no hand-written list left in the route');
  // What the hand-written lists had differed in: `quality` (no action takes it) is gone, and stickerPick needs a source
  // message at Authority as at the content service.
  assert.equal(CONTENT_FIELDS.includes('quality'), false);
  assert.deepEqual(sorted(CONTENT_ACTIONS.filter(row => row.sourceRequired).map(row => row.action)), ['ingest', 'stickerPick', 'synthesize']);
});

test('content client (media/client.js): what it lets through to /v1/content is the derived action list', async () => {
  const client = source('capabilities/media/client.js');
  assert.ok(client.includes("import { CONTENT_ACTIONS } from '../providers/index.js';") && client.includes('!CONTENT_ACTIONS.some(row => row.action === input.action)'));
  assert.doesNotMatch(client, /\['ingest', /, 'no hand-written action list left');
  // An action that is not declared is refused before anything is sent (the socket does not exist).
  const { ContentClient } = await import('../media/client.js');
  const content = new ContentClient({ socketPath: '/nonexistent/content.sock', tokenFile: '/nonexistent/token' });
  for (const action of ['jobStart', 'paint', undefined]) await assert.rejects(content.call({ action, streamId: 's1', memoryEpoch: 0 }), { code: 'CONTENT_REQUEST_INVALID' }, String(action));
  for (const { action } of CONTENT_ACTIONS) await assert.rejects(content.call({ action, streamId: 's1', memoryEpoch: 0 }), { code: 'CONTENT_CREDENTIAL_UNAVAILABLE' }, action);
});

test('PROTOCOL.md: the /v1/content actions are pointed at, not listed', () => {
  const protocol = source('authority/PROTOCOL.md');
  assert.doesNotMatch(protocol, /\nActions are `/);
  assert.ok(protocol.includes('(`capabilities/providers/index.js`: `CONTENT_ACTIONS`, `CONTENT_FIELDS`)'));
});

test('content service (media/service.js, main.mjs, video/provider.js): what is dispatched is what is declared', () => {
  // The registry is what main.mjs checks before it starts: each declared action implemented, nothing else but the
  // operator-only `jobStart` (only Authority's operator route sends it).
  checkContentActions(CONTENT_ACTIONS);
  const operatorOnly = Object.keys(CONTENT_SERVICE_ACTIONS).filter(name => CONTENT_SERVICE_ACTIONS[name].operatorOnly);
  assert.deepEqual(operatorOnly, ['jobStart']);
  assert.deepEqual(sorted(Object.keys(CONTENT_SERVICE_ACTIONS).filter(name => !operatorOnly.includes(name))), sorted(CONTENT_ACTIONS.map(row => row.action)));
  assert.match(source('capabilities/media/main.mjs'), /checkContentActions\(CONTENT_ACTIONS\)/);
  // Either side out of step refuses, naming the action.
  assert.throws(() => checkContentActions([...CONTENT_ACTIONS, { action: 'paint' }]), /declared but not implemented: paint\./);
  assert.throws(() => checkContentActions(CONTENT_ACTIONS.filter(row => row.action !== 'fetch')), /implemented but not declared: fetch\./);
  assert.throws(() => checkContentActions([...CONTENT_ACTIONS, { action: 'jobStart' }]), /declared but operator only: jobStart\./);
  // The providers behind the `activity` action, and the activities each one answers.
  const main = source('capabilities/media/main.mjs');
  assert.deepEqual(keysOf(found(main, /activities: \{ ([^}]*) \}/, 'main.mjs activities')), ACTIVITIES.map(item => item.capability));
  const provider = source('capabilities/providers/video/provider.js');
  assert.deepEqual(sorted(new Set([...provider.matchAll(/activity [!=]== '(\w+)'/g)].map(match => match[1]))), sorted(ACTIVITIES.find(item => item.capability === 'video').actions));
  // Job kinds: a declared capability each, or the `job` an action of one names (the stills job of `video`).
  const runners = keysOf(found(main, /runners: \{ ([^}]*) \}/, 'main.mjs runners'));
  const named = DECLARATIONS.flatMap(item => item.actions.filter(action => action.job).map(action => action.job));
  assert.deepEqual(runners.filter(kind => !DECLARATIONS.some(item => item.id === kind)), named);
});

test('model gateway (server.mjs): purposes and default daily limits are read from the derived tables', () => {
  const server = source('model-gateway/server.mjs');
  assert.ok(server.includes('const PURPOSES = Object.freeze({ __proto__: null, ...GATEWAY_PURPOSES.vision });'), 'PURPOSES from GATEWAY_PURPOSES');
  assert.deepEqual(Object.keys(GATEWAY_PURPOSES), ['vision']);
  assert.ok(server.includes('budgets = GATEWAY_DEFAULT_LIMITS,') && server.includes('const limits = { ...GATEWAY_DEFAULT_LIMITS, ...budgets };'), 'default limits from GATEWAY_DEFAULT_LIMITS');
  assert.doesNotMatch(server, /web: 20|vision: 12/, 'no hand-written default limit left');
  // The values the gateway had written by hand before it read the tables: the same, so nothing it decides changes.
  assert.deepEqual({ ...GATEWAY_PURPOSES.vision }, { sticker: 'sticker', frame: 'video-frame' });
  assert.deepEqual({ ...GATEWAY_DEFAULT_LIMITS }, { web: 20, vision: 12 });
  // Every row the gateway counts itself is named in it as a literal.
  for (const item of CAPABILITIES.filter(item => item.meter.source === 'gateway')) assert.ok(server.includes(`'${item.id}'`), `${item.id}: counted by the gateway`);
});

test('model gateway (spend.mjs): categories and stop tiers are the derived ones plus the reserved `generation`', () => {
  const spend = source('model-gateway/spend.mjs');
  assert.doesNotMatch(spend, /const STOP = \{ /, 'no hand-written stop table left');
  assert.deepEqual(CATEGORIES, [...SPEND_CATEGORIES.map(row => row.category), ...Object.keys(RESERVED_STOP)]);
  assert.deepEqual({ ...STOP }, { ...SPEND_STOP, ...RESERVED_STOP });
  // A reserved category has no declaration charged to it; a declaration that claims it moves it out of RESERVED_STOP.
  assert.deepEqual(Object.keys(RESERVED_STOP), ['generation']);
  assert.deepEqual(Object.keys(RESERVED_STOP).filter(category => Object.hasOwn(SPEND_STOP, category)), []);
  // The tables spend.mjs had written by hand before it read the declarations: the same categories and stop tiers.
  assert.deepEqual(sorted(CATEGORIES), sorted(['conversation', 'maintenance', 'vision', 'web', 'generation', 'proactive', 'activity']));
  assert.deepEqual({ ...STOP }, { proactive: 'reduced', maintenance: 'restricted', vision: 'restricted', web: 'restricted', generation: 'restricted', activity: 'restricted', conversation: 'exhausted' });
  // One category, one stop tier, whichever capability is charged to it.
  for (const item of CAPABILITIES.filter(item => item.meter.spendCategory)) assert.equal(item.meter.stopTier, SPEND_STOP[item.meter.spendCategory], item.id);
});

test('console (view.js, locale): the spend card lists the categories the gateway reports, titled by their capabilities', () => {
  // The gateway's /spend carries SPEND_CATEGORIES as `categories` (model-gateway/usage-ledger.test.mjs holds the value).
  assert.ok(source('model-gateway/spend.mjs').includes('categories: SPEND_CATEGORIES.map('));
  const view = source('console/view.js');
  assert.ok(view.includes('(Array.isArray(spend.categories) ? spend.categories : []).map(row =>'), 'view.js spend card');
  assert.doesNotMatch(view, /spend\.byTier\./, 'no hand-written category line left');
  for (const locale of ['zh', 'en']) assert.equal(JSON.parse(source(`console/locale/${locale}.json`)).spend.byTier, undefined, locale);
  // Every category with money has a line, including the two the hand-written list had missed.
  assert.ok(['proactive', 'activity'].every(category => SPEND_CATEGORIES.some(row => row.category === category)));
});

test('configuration and forgetting: each declared loader exists, and the owners are the processes the purge knows', async () => {
  assert.deepEqual(CONFIGS.map(row => [row.file, row.capabilities]), [['operator/speech.json', ['speech-tts', 'speech-asr']], ['operator/providers/video.json', ['video']]]);
  for (const row of CONFIGS) assert.equal(typeof (await import(new URL(`../../${row.module}`, import.meta.url)))[row.load], 'function', row.file);
  // Every declaration says who forgets for it, or that nothing is kept.
  assert.deepEqual(DECLARATIONS.filter(item => item.forget === null).map(item => item.id), ['web']);
  assert.deepEqual(sorted(Object.values(FORGET_OWNERS).flat()), sorted(DECLARATIONS.filter(item => item.forget).map(item => item.id)));
  assert.deepEqual(Object.keys(FORGET_OWNERS), ['companion-conversation', 'authority', 'companion-content']);
  const purge = source('deploy/authority/purge-execution.mjs');
  const units = quoted(found(purge, /const units = \[([^\]]*)\]/, 'purge units')).map(unit => unit.replace(/\.service$/, ''));
  const called = [...found(purge, /const owners = \[([^]*?)\n\];/, 'purge owners').matchAll(/\['([^']+)',/g)].map(match => match[1]);
  // The offline purge stops the services whose files are forgotten and calls each one's forget; Authority's own rows
  // are Authority's. A channel's bridge is declared in its channel's manifest.
  const owners = [...Object.keys(FORGET_OWNERS).filter(owner => owner !== 'authority'), ...CHANNELS.filter(item => item.forget).map(item => item.forget.owner)];
  assert.deepEqual(sorted(units), sorted(owners));
  assert.deepEqual(sorted(called), sorted(owners));
});
