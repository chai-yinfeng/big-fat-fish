// Consistency: every hand-written list of capabilities, actions, fields, purposes and spend categories in the
// product, held against the capability declarations and the tables derived from them (./index.js). Nothing reads the
// derived tables yet, so each test here names one list that a later step replaces with its table.
//
// Where a list and the declarations disagree today, the difference is written down in KNOWN_DRIFT and asserted
// exactly: fixing one (or adding a new one) fails the test until this table is updated on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DECLARATIONS, CAPABILITIES, ACTIVITIES, ACTIVITY_TOOL, CONTENT_TOOL, MODEL_ACTIONS, ACTIVITY_TOOL_DEFINITION, CONTENT_SCOPE_FIELDS, CONTENT_ACTIONS, CONTENT_FIELDS, GATEWAY_PURPOSES, SPEND_CATEGORIES, SPEND_STOP, GATEWAY_DEFAULT_LIMITS, CONFIGS, FORGET_OWNERS } from './index.js';
import { TOOL_RULES } from '../conversation/tool-rules.js';
import { ACTIVITY_TOOL_SCHEMA, CONTENT_TOOL_SCHEMA, createCompanionTools } from '../conversation/tools.js';
import { CATEGORIES } from '../../model-gateway/spend.mjs';

const KNOWN_DRIFT = {
  // authority/src/server.js accepts a /v1/content field no action takes and nothing sends.
  authorityFieldsNobodyUses: ['quality'],
  // The content service refuses stickerPick without a source message; Authority only insists on one for ingest and synthesize.
  sourceRequiredButNotByAuthority: ['stickerPick'],
  // Implemented by the content service, deliberately not an action of /v1/content: only Authority's operator route sends it.
  contentServiceOnly: ['jobStart'],
  // A job kind of the content service that is not a declared capability (the stills job of `video`; its ledger row is `video-frame`).
  jobRunnersNotDeclared: ['video-frames'],
  // A spend category kept for provider adapters (model-gateway/providers.mjs); no declaration is charged to it yet.
  spendCategoriesNotDeclared: ['generation'],
  // The console's spend card lists four categories by hand; these have money and no line.
  spendCategoriesNotOnConsole: ['proactive', 'activity'],
  // Stopped by the offline purge script, but no declaration names it as the owner of anything to forget (a channel, not a capability).
  purgeUnitsNotDeclared: ['companion-qq'],
};

const source = file => fs.readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
const sorted = list => [...list].sort();
const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
/** The keys and values of a one-line object literal such as `{ a: 'x', 'b-c': 2 }`. */
const literal = text => Object.fromEntries([...text.matchAll(/(?:'([\w-]+)'|(\w+)): ('[^']*'|\d+)/g)].map(match => [match[1] ?? match[2], match[3].startsWith("'") ? match[3].slice(1, -1) : Number(match[3])]));
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
  assert.ok(Object.isFrozen(TOOL_RULES) && Object.values(TOOL_RULES).every(text => typeof text === 'string' && text.length > 0));
  // The seven actions that had no declaration now have one, none of them with a ledger row.
  const unmetered = DECLARATIONS.filter(item => !item.meter).flatMap(item => item.actions.map(action => action.content.action));
  assert.deepEqual(unmetered, ['ingest', 'asset', 'attach', 'pending', 'stickerKeep', 'stickerPick', 'jobResult']);
});

test('executor (tools.js): the generated companion_activity definition is byte for byte the hand-written one', () => {
  // service.test.js pins what is sent to the provider (PINNED_ALL_TOOLS_SHA256) from tools.js; equal bytes here mean
  // the generated definition gives the same hash.
  assert.equal(JSON.stringify(ACTIVITY_TOOL_DEFINITION), JSON.stringify(ACTIVITY_TOOL_SCHEMA));
  assert.deepEqual(MODEL_ACTIONS.filter(action => action.tool === ACTIVITY_TOOL).map(action => `${action.capability}.${action.action}`), ACTIVITIES.flatMap(item => item.actions.map(action => `${item.capability}.${action}`)));
  // One field name means one thing across the tool: no two actions declare the same input field.
  const fields = MODEL_ACTIONS.filter(action => action.tool === ACTIVITY_TOOL).flatMap(action => action.keys);
  assert.equal(new Set(fields).size, fields.length);
});

test('executor (tools.js): the frozen companion_content tool offers exactly the declared actions and fields', () => {
  const declared = MODEL_ACTIONS.filter(action => action.tool === CONTENT_TOOL), properties = CONTENT_TOOL_SCHEMA.parameters.properties;
  assert.deepEqual(sorted(properties.action.enum), sorted(declared.map(action => action.action)));
  assert.deepEqual(sorted(Object.keys(properties).filter(key => key !== 'action')), sorted(new Set(declared.flatMap(action => action.keys))));
  // The hand-written dispatch names each action as a literal.
  const dispatch = found(source('capabilities/conversation/tools.js'), /async function contentAction[\s\S]*?!\[([^\]]*)\]\.includes\(args\.action\)/, 'tools.js contentAction');
  assert.deepEqual(sorted(quoted(dispatch)), sorted(declared.map(action => action.action)));
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

test('Authority (server.js /v1/content): the action allowlist, the field allowlist and "must carry a source" match the derived table', () => {
  const route = source('authority/src/server.js').split("route === '/v1/content'")[1];
  assert.ok(route, 'the /v1/content branch');
  const fields = quoted(found(route, /bodyOf\(req, \[([^\]]*)\]/, 'field allowlist'));
  const actions = quoted(found(route, /if \(!\[([^\]]*)\]\.includes\(body\.action\)\)/, 'action allowlist'));
  const sourced = quoted(found(route, /if \(\[([^\]]*)\]\.includes\(body\.action\) && typeof body\.sourceEventId !== 'string'\)/, 'source rule'));
  assert.deepEqual(sorted(actions), sorted(CONTENT_ACTIONS.map(row => row.action)));
  assert.deepEqual(sorted(fields), sorted([...CONTENT_FIELDS, ...KNOWN_DRIFT.authorityFieldsNobodyUses]));
  assert.deepEqual(KNOWN_DRIFT.authorityFieldsNobodyUses.filter(field => CONTENT_FIELDS.includes(field)), []);
  assert.deepEqual(sorted([...sourced, ...KNOWN_DRIFT.sourceRequiredButNotByAuthority]), sorted(CONTENT_ACTIONS.filter(row => row.sourceRequired).map(row => row.action)));
});

test('PROTOCOL.md: the list of /v1/content actions is the derived one', () => {
  const listed = [...found(source('authority/PROTOCOL.md'), /\nActions are ((?:`\w+`(?:, )?)+)\./, 'PROTOCOL.md "Actions are"').matchAll(/`(\w+)`/g)].map(match => match[1]);
  assert.deepEqual(sorted(listed), sorted(CONTENT_ACTIONS.map(row => row.action)));
});

test('content service (media/service.js, main.mjs, video/provider.js): what is dispatched is what is declared', () => {
  const service = source('capabilities/media/service.js');
  const call = service.slice(service.indexOf('async call(scope, input)'), service.indexOf('async stickersCall('));
  const dispatched = [...new Set([...call.matchAll(/action === '(\w+)'/g)].map(match => match[1]))];
  assert.deepEqual(sorted(dispatched), sorted([...CONTENT_ACTIONS.map(row => row.action), ...KNOWN_DRIFT.contentServiceOnly]));
  // The providers behind the `activity` action, and the activities each one answers.
  const main = source('capabilities/media/main.mjs');
  assert.deepEqual(keysOf(found(main, /activities: \{ ([^}]*) \}/, 'main.mjs activities')), ACTIVITIES.map(item => item.capability));
  const provider = source('capabilities/providers/video/provider.js');
  assert.deepEqual(sorted(new Set([...provider.matchAll(/activity [!=]== '(\w+)'/g)].map(match => match[1]))), sorted(ACTIVITIES.find(item => item.capability === 'video').actions));
  // Job kinds: a declared capability each, but for the one written down above.
  const runners = keysOf(found(main, /runners: \{ ([^}]*) \}/, 'main.mjs runners'));
  assert.deepEqual(runners.filter(kind => !DECLARATIONS.some(item => item.id === kind)), KNOWN_DRIFT.jobRunnersNotDeclared);
});

test('model gateway (server.mjs): purposes, default daily limits and ledger rows match the declarations', () => {
  const server = source('model-gateway/server.mjs');
  assert.deepEqual(literal(found(server, /const PURPOSES = Object\.freeze\(\{ __proto__: null, ([^}]*) \}\)/, 'PURPOSES')), { ...GATEWAY_PURPOSES.vision });
  assert.deepEqual(Object.keys(GATEWAY_PURPOSES), ['vision']);
  // The default limits are written twice in server.mjs.
  assert.deepEqual(literal(found(server, /budgets = \{ ([^}]*) \}/, 'budgets default')), { ...GATEWAY_DEFAULT_LIMITS });
  assert.deepEqual(sorted(Object.entries(literal(found(server, /const limits = \{ ([^}]*), \.\.\.budgets \}/, 'limits')))), sorted(Object.entries(GATEWAY_DEFAULT_LIMITS)));
  // Every row the gateway counts itself is named in it as a literal.
  for (const item of CAPABILITIES.filter(item => item.meter.source === 'gateway')) assert.ok(server.includes(`'${item.id}'`), `${item.id}: counted by the gateway`);
});

test('model gateway (spend.mjs): categories and stop tiers match the declarations', () => {
  const stop = literal(found(source('model-gateway/spend.mjs'), /const STOP = \{ ([^}]*) \}/, 'STOP'));
  assert.deepEqual(sorted(CATEGORIES), sorted([...SPEND_CATEGORIES.map(row => row.category), ...KNOWN_DRIFT.spendCategoriesNotDeclared]));
  assert.deepEqual(sorted(Object.keys(stop)), sorted(CATEGORIES));
  for (const [category, tier] of Object.entries(SPEND_STOP)) assert.equal(stop[category], tier, category);
  // One category, one stop tier, whichever capability is charged to it.
  for (const item of CAPABILITIES.filter(item => item.meter.spendCategory)) assert.equal(item.meter.stopTier, SPEND_STOP[item.meter.spendCategory], item.id);
});

test('console (view.js, locale): the spend card lists declared categories, and misses the ones written down', () => {
  const shown = quoted(found(source('console/view.js'), /\.\.\.\[([^\]]*)\]\.map\(key => \[`spend\.byTier\.\$\{key\}`/, 'view.js spend card'));
  assert.deepEqual(sorted([...shown, ...KNOWN_DRIFT.spendCategoriesNotOnConsole]), sorted(SPEND_CATEGORIES.map(row => row.category)));
  for (const locale of ['zh', 'en']) assert.deepEqual(Object.keys(JSON.parse(source(`console/locale/${locale}.json`)).spend.byTier), shown, locale);
});

test('configuration and forgetting: each declared loader exists, and the owners are the processes the purge knows', async () => {
  assert.deepEqual(CONFIGS.map(row => [row.file, row.capabilities]), [['operator/speech.json', ['speech-tts', 'speech-asr']], ['operator/providers/video.json', ['video']]]);
  for (const row of CONFIGS) assert.equal(typeof (await import(new URL(`../../${row.module}`, import.meta.url)))[row.load], 'function', row.file);
  // Every declaration says who forgets for it, or that nothing is kept.
  assert.deepEqual(DECLARATIONS.filter(item => item.forget === null).map(item => item.id), ['web']);
  assert.deepEqual(sorted(Object.values(FORGET_OWNERS).flat()), sorted(DECLARATIONS.filter(item => item.forget).map(item => item.id)));
  assert.deepEqual(Object.keys(FORGET_OWNERS), ['companion-conversation', 'authority', 'companion-content']);
  const units = quoted(found(source('deploy/authority/purge-execution.mjs'), /const units = \[([^\]]*)\]/, 'purge units')).map(unit => unit.replace(/\.service$/, ''));
  // The offline purge stops the services whose files it rewrites; Authority's own rows are Authority's.
  assert.deepEqual(sorted(units), sorted([...Object.keys(FORGET_OWNERS).filter(owner => owner !== 'authority'), ...KNOWN_DRIFT.purgeUnitsNotDeclared]));
});
