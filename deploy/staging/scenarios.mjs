#!/usr/bin/env node
// Staging-only scenario replay: "who said what -> who received which reply", driven through
// the fake OneBot (fake-onebot.mjs), the scripted model (fake-model.mjs) and the real operator
// API of the staged release. No real QQ account, no provider key.
//   node scenarios.mjs --operator-port 13082 --operator-token-file <file> --onebot-control <socket>
//        --model-script <file> --model-log <file> --scenarios <scenarios.json> [--only S1,S3]
// A scenario is { id, title, model: [rules for fake-model.mjs], steps: [...], finally: [...] };
// each step is an object with exactly one key naming an entry of STEPS below.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MOCK_MODEL_KEY = 'MOCK-KEY-staging-not-a-real-key';
const MOCK_NAME = /^MOCK-[A-Z0-9-]{1,24}$/, MOCK_QQ = /^9999\d{8}$/;
const list = value => Array.isArray(value) ? value : [value];
const fail = message => { throw new Error(message); };

/** Scenario data with every simulated person visibly fake (MOCK- names, 9999-prefixed 12-digit QQ numbers). */
export function validateScenarios(data) {
  const people = { ...data?.people, ...(data?.bot ? { [data.bot.name]: data.bot } : {}) };
  if (!data?.bot || !Array.isArray(data.scenarios) || !data.scenarios.length) fail('scenario file needs bot, people and scenarios');
  for (const [name, person] of Object.entries(people)) if (!MOCK_NAME.test(name) || !MOCK_QQ.test(person?.qq ?? '')) fail(`not visibly fake: ${name} ${person?.qq} (use MOCK-<NAME> and a 12-digit QQ number starting with 9999)`);
  if (new Set(Object.values(people).map(person => person.qq)).size !== Object.keys(people).length) fail('duplicate QQ number');
  if (Object.values(data.people).filter(person => person.owner).length !== 1) fail('exactly one person must be the owner');
  const ids = new Set();
  for (const scenario of data.scenarios) {
    if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(scenario?.id ?? '') || ids.has(scenario.id) || typeof scenario.title !== 'string' || !Array.isArray(scenario.steps) || !scenario.steps.length) fail('invalid scenario ' + scenario?.id);
    ids.add(scenario.id);
    for (const step of [...scenario.steps, ...(scenario.finally ?? [])]) {
      const keys = Object.keys(step ?? {});
      if (keys.length !== 1 || !Object.hasOwn(STEPS, keys[0])) fail(`${scenario.id}: unknown step ${JSON.stringify(step)}`);
      const args = step[keys[0]];
      for (const name of [args.from, args.person, ...list(args.observedFrom ?? []), ...list(args.to ?? []).filter(to => to !== '*')].filter(value => value !== undefined)) if (!data.people[name]) fail(`${scenario.id}: unknown person ${name}`);
    }
  }
  return data;
}

const includes = (text, { contains, absent }) => (contains === undefined || text.includes(contains)) && (absent === undefined || !text.includes(absent));

/** Step implementations. `run` is the Runner; `ctx` is per-scenario state. */
export const STEPS = {
  /** A private message arrives from a person (subType: OneBot sub_type, default "friend"). */
  async say(run, ctx, { from, text, subType }) {
    ctx.observed.set(from, await run.messageCount(from));
    await run.onebot('POST', '/message', { user_id: run.qq(from), nickname: from, text, ...(subType ? { sub_type: subType } : {}) });
  },
  /** The next not-yet-matched message delivered to `to` must arrive and contain `contains`. */
  async expectReply(run, ctx, { to, contains, timeoutMs = 60000 }) {
    const message = await run.poll(async () => (await run.sent()).find(item => item.user_id === run.qq(to) && !ctx.matched.has(item.message_id)), timeoutMs, `no message delivered to ${to}`);
    ctx.matched.add(message.message_id);
    if (contains !== undefined && !message.text.includes(contains)) fail(`${to} received ${JSON.stringify(message.text.slice(0, 80))}, expected it to contain ${JSON.stringify(contains)}`);
  },
  /** Nothing unmatched may have been delivered to `to` (a name, a list or "*"). `observedFrom`: first wait
   * until Authority has recorded the last message said by each of these people, then `afterMs`. */
  async expectSilence(run, ctx, { to, observedFrom = [], afterMs = 3000 }) {
    for (const name of list(observedFrom)) await run.poll(async () => await run.messageCount(name) > (ctx.observed.get(name) ?? -1), 30000, `the message from ${name} never reached Authority`);
    await run.sleep(afterMs);
    const targets = to === '*' ? null : list(to).map(name => run.qq(name));
    const extra = (await run.sent()).filter(item => !ctx.matched.has(item.message_id) && (!targets || targets.includes(item.user_id)));
    if (extra.length) fail(`expected silence, but ${run.nameOf(extra[0].user_id)} received ${JSON.stringify(extra[0].text.slice(0, 80))}`);
  },
  /** Total messages delivered to `to` during this scenario (optionally only those containing `contains`). */
  async expectSentCount(run, _ctx, { to, contains, count }) {
    const actual = (await run.sent()).filter(item => item.user_id === run.qq(to) && includes(item.text, { contains })).length;
    if (actual !== count) fail(`${to} received ${actual} message(s), expected ${count}`);
  },
  /** Authority's canonical memory (operator GET /memory): `contains` waits for an active item of that
   * person; `absent` requires that none of that person's items mentions the text. */
  async expectMemory(run, _ctx, { person, contains, absent, timeoutMs = 20000 }) {
    const items = async () => (await run.operator('GET', '/memory?limit=100')).items.filter(item => item.personId === run.personId(person) && item.status === 'active').map(item => [item.key, item.value, item.summary, item.text].filter(Boolean).join(' '));
    if (contains !== undefined) await run.poll(async () => (await items()).some(text => text.includes(contains)), timeoutMs, `Authority has no memory of ${person} containing ${JSON.stringify(contains)}`);
    if (absent !== undefined && (await items()).some(text => text.includes(absent))) fail(`Authority memory of ${person} contains ${JSON.stringify(absent)}`);
  },
  /** The whole request body the model was sent for the run whose typed user text contains `userText`:
   * system prompt, memory-hub note, the typed text, earlier dialogue and tool results.
   * `in: "context"` narrows it to the memory-hub note, i.e. what Authority retrieved for this run. */
  async expectPrompt(run, ctx, { userText, contains, absent, in: part = 'request' }) {
    if (!['request', 'context'].includes(part)) fail(`expectPrompt: unknown part ${JSON.stringify(part)}`);
    const requests = run.modelLog(ctx).filter(entry => entry.stream && entry.userText.includes(userText));
    if (!requests.length) fail(`the model never received ${JSON.stringify(userText)}`);
    // A log entry without these fields would turn `absent` into an empty check: refuse it.
    if (!requests.every(entry => [entry.system, entry.context, entry.rest].every(value => typeof value === 'string'))) fail('the model request log lacks system/context/rest');
    const sent = entry => part === 'context' ? entry.context : [entry.system, entry.context, entry.userText, entry.rest].join('\n');
    if (!requests.every(entry => includes(sent(entry), { contains, absent }))) fail(`the model ${part} for ${JSON.stringify(userText)} ${contains !== undefined ? 'lacks ' + JSON.stringify(contains) : 'contains ' + JSON.stringify(absent)}`);
  },
  async expectNoModelCall(run, ctx, { userText }) {
    if (run.modelLog(ctx).some(entry => entry.userText.includes(userText))) fail(`the model received ${JSON.stringify(userText)}`);
  },
  /** `times` turns with one person, one at a time: `text` is said (`{n}` = the turn number) and the reply awaited. */
  async converse(run, ctx, { from, text, times, reply }) {
    for (let n = 1; n <= times; n++) {
      await STEPS.say(run, ctx, { from, text: text.replaceAll('{n}', String(n)) });
      await STEPS.expectReply(run, ctx, { to: from, contains: reply });
    }
  },
  /** Injection trace (operator GET /memory/trace) against what the model was really sent, for the run whose
   * typed text contains `userText`: the newest trace of `person` recorded before that model request. The
   * memory-hub note must carry exactly one memory line per traced ID, and the content of every traced ID
   * (read back from operator GET /memory). `contains` / `absent`: about the content of the traced items. */
  async expectTrace(run, ctx, { person, userText, contains, absent }) {
    const entry = run.modelLog(ctx).find(item => item.stream && !item.afterTool && item.userText.includes(userText));
    if (!entry) fail(`the model never received ${JSON.stringify(userText)}`);
    if (typeof entry.context !== 'string' || !Number.isFinite(entry.at)) fail('the model request log lacks context/at');
    const label = await run.personLabel(person), response = await run.operator('GET', `/memory/trace?person=${label}&limit=400`);
    const leaked = [run.data.bot, ...Object.values(run.data.people)].find(account => JSON.stringify(response).includes(account.qq));
    if (leaked) fail(`the trace contains the account number ${leaked.qq}`);
    const trace = response.traces.find(item => item.at <= entry.at);
    if (!trace) fail(`no injection trace of ${person} before the model request for ${JSON.stringify(userText)}`);
    const ids = trace.sections.flatMap(section => section.ids), lines = (entry.context.match(/^\{"content":.*$/gm) ?? []).length;
    if (ids.length !== lines) fail(`the trace lists ${ids.length} injected item(s), the model context carries ${lines} memory line(s)`);
    const known = new Map((await run.memoryPages('')).flatMap(page => page.items).map(item => [item.id, item]));
    const texts = ids.map(id => {
      const item = known.get(id);
      if (!item) fail(`traced item ${id} is not in Authority's memory listing`);
      const content = item.attribution === 'reported' ? `${item.key}: ${item.value}` : item.summary ?? item.text;
      // Memory lines are JSON: compare the content as it is written inside one.
      if (!entry.context.includes(JSON.stringify(content).slice(1, -1))) fail(`the model context lacks the traced item ${JSON.stringify(content.slice(0, 80))}`);
      return content;
    });
    if (contains !== undefined && !texts.some(text => text.includes(contains))) fail(`no traced item of ${person} contains ${JSON.stringify(contains)}`);
    if (absent !== undefined && texts.some(text => text.includes(absent))) fail(`a traced item of ${person} contains ${JSON.stringify(absent)}`);
  },
  /** Owner filter and paging of operator GET /memory (what the console memory page reads): `person`'s items,
   * `pageSize` a page, until at least `atLeast` exist. The first page must be full and not the last, no item
   * may repeat, every item must be that person's, and the filtered pages must be exactly that person's part
   * of the unfiltered listing, which must also hold someone else's items. */
  async expectMemoryPages(run, _ctx, { person, atLeast, pageSize = 50, timeoutMs = 60000 }) {
    const label = await run.personLabel(person), count = pages => pages.reduce((sum, page) => sum + page.items.length, 0);
    const pages = await run.poll(async () => { const read = await run.memoryPages(`person=${label}&`, pageSize); return count(read) >= atLeast ? read : null; }, timeoutMs, `Authority has fewer than ${atLeast} memory items of ${person}`);
    const items = pages.flatMap(page => page.items), ids = new Set(items.map(item => item.id));
    if (pages.length < 2 || pages[0].items.length !== pageSize) fail(`expected a full first page of ${pageSize} and a later page, got ${pages.map(page => page.items.length).join('+')}`);
    if (ids.size !== items.length) fail('an item was listed on two pages');
    const foreign = items.find(item => item.personId !== run.personId(person) || item.personLabel !== label);
    if (foreign) fail(`the listing filtered to ${person} returned an item of ${foreign.personLabel}`);
    const everything = (await run.memoryPages('')).flatMap(page => page.items), own = everything.filter(item => item.personId === run.personId(person));
    if (own.length === everything.length) fail('nobody else has memory: the filter was not exercised');
    if (own.length !== items.length || own.some(item => !ids.has(item.id))) fail(`the filtered pages hold ${items.length} item(s), the unfiltered listing has ${own.length} of ${person}`);
  },
  /** Admission = an actor binding and a private conversation in Authority (operator /people, /conversations). */
  async expectAdmitted(run, _ctx, { person, admitted }) {
    const people = (await run.operator('GET', '/people')).people, conversations = await run.operator('GET', '/conversations');
    const actor = people.some(item => item.actors.some(binding => binding.externalActorId.endsWith(':user:' + run.qq(person))));
    const stream = conversations.some(item => item.streamId.endsWith(':private:' + run.qq(person)));
    if (actor !== admitted || stream !== admitted) fail(`${person}: actor bound=${actor}, conversation bound=${stream}, expected ${admitted}`);
  },
  /** Daily cap / tiers through the real operator route (POST /spend/settings). */
  async spendSettings(run, _ctx, settings) { await run.operator('POST', '/spend/settings', settings); },
  async expectSpend(run, _ctx, { tier, timeoutMs = 10000 }) {
    await run.poll(async () => (await run.operator('GET', '/spend')).tier === tier, timeoutMs, `spend tier never became ${tier}`);
  },
};

export class Runner {
  /** operator(method, route, body) and onebot(method, route, body) resolve to the `value` of an ok envelope. */
  constructor({ data, operator, onebot, modelScript, modelLog, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {} }) {
    Object.assign(this, { data: validateScenarios(data), operator, onebot, modelScriptFile: modelScript, modelLogFile: modelLog, sleep, report: say });
    this.owner = Object.keys(data.people).find(name => data.people[name].owner);
  }
  qq(name) { return this.data.people[name].qq; }
  nameOf(qq) { return Object.keys(this.data.people).find(name => this.data.people[name].qq === qq) ?? qq; }
  personId(name) { return this.data.people[name].owner ? 'person:owner' : 'person:qq:' + this.qq(name); }
  /** The opaque label Authority shows for a person (operator /people). */
  async personLabel(name) {
    const person = (await this.operator('GET', '/people')).people.find(item => item.personId === this.personId(name));
    return person?.label ?? fail(`${name} is not a person in Authority`);
  }
  /** Every page of operator GET /memory for `filter` ("" or "person=<label>&"), newest first. */
  async memoryPages(filter, pageSize = 100) {
    const pages = [];
    for (let before; ;) {
      const page = await this.operator('GET', `/memory?${filter}limit=${pageSize}${before === undefined ? '' : '&beforeRevision=' + before}`);
      pages.push(page);
      if (page.more !== true || !page.items.length) return pages;
      if (pages.length >= 200) fail('the memory listing does not end');
      before = Math.min(...page.items.map(item => item.revision));
    }
  }
  async sent() { return (await this.onebot('GET', '/state')).sent; }
  async messageCount(name) {
    const row = (await this.operator('GET', '/conversations')).find(item => item.streamId === `qq:${this.data.bot.qq}:private:${this.qq(name)}`);
    return row ? row.messages : -1;
  }
  logLines() { try { return fs.readFileSync(this.modelLogFile, 'utf8').split('\n').filter(Boolean); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  modelLog(ctx) { return this.logLines().slice(ctx.logOffset).map(line => JSON.parse(line)); }
  async poll(probe, timeoutMs, message) {
    for (const deadline = Date.now() + timeoutMs; ;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() >= deadline) fail(message);
      await this.sleep(250);
    }
  }
  async setPaused(paused) {
    const world = (await this.operator('GET', '/world')).world;
    if (world.paused !== paused) await this.operator('POST', '/world/pause', { paused, expectedRevision: world.revision });
  }
  /** Bridge logged in as MOCK-BOT, friends set, owner bound and mock key stored while paused, world resumed. */
  async prepare() {
    await this.poll(async () => (await this.onebot('GET', '/state')).clients > 0 && (await this.operator('GET', '/qq')).loggedIn, 45000, 'the QQ bridge never logged in to the fake OneBot');
    await this.onebot('POST', '/friends', { friends: Object.entries(this.data.people).filter(([, person]) => person.friend).map(([name, person]) => ({ user_id: person.qq, nickname: name })) });
    await this.setPaused(true);
    await this.operator('POST', '/qq', { allowedCallerUID: this.qq(this.owner) });
    await this.operator('POST', '/model', { model: 'deepseek-flash', apiKey: MOCK_MODEL_KEY });
    await this.setPaused(false);
    await this.poll(async () => { const status = await this.operator('GET', '/qq'); return status.configured && status.callerConfigured && !status.paused; }, 15000, 'the QQ bridge is not configured');
    await this.poll(async () => (await this.operator('GET', '/people')).qq?.friends === Object.values(this.data.people).filter(person => person.friend).length, 15000, 'the QQ bridge did not load the friend list');
  }
  async scenario(scenario) {
    const ctx = { matched: new Set(), observed: new Map(), logOffset: this.logLines().length };
    let done = 0, error = null;
    const each = async steps => { for (const step of steps) { const [name] = Object.keys(step); await STEPS[name](this, ctx, step[name]); done++; } };
    try {
      fs.writeFileSync(this.modelScriptFile, JSON.stringify(scenario.model ?? []) + '\n', { mode: 0o600 });
      await this.onebot('POST', '/reset', {});
      await each(scenario.steps);
    } catch (cause) { error = `step ${done + 1} ${JSON.stringify(scenario.steps[done] ?? null)}: ${cause.message}`; }
    const steps = done;
    try { await each(scenario.finally ?? []); } catch (cause) { error ??= 'finally: ' + cause.message; }
    return { id: scenario.id, title: scenario.title, ok: !error, steps, ...(error ? { error } : {}) };
  }
  async run(only = null) {
    const selected = this.data.scenarios.filter(scenario => !only || only.includes(scenario.id));
    if (!selected.length || only && selected.length !== only.length) fail('unknown scenario in --only');
    const results = [];
    let setup = null;
    try { await this.prepare(); } catch (error) { setup = error.message; }
    for (const scenario of selected) {
      const result = setup ? { id: scenario.id, title: scenario.title, ok: false, steps: 0, error: 'setup: ' + setup } : await this.scenario(scenario);
      this.report(`scenario ${result.id} ${result.ok ? 'PASS' : 'FAIL'} ${result.title} (${result.steps}/${scenario.steps.length} steps)${result.error ? ' -- ' + result.error : ''}`);
      results.push(result);
    }
    // Leave the staging world paused, as the lifecycle found it.
    try { await this.setPaused(true); } catch {}
    return { passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length, results };
  }
}

/** One-line result for the staging summary. */
export function summaryLine(summary) {
  return `${summary.passed}/${summary.passed + summary.failed} passed: ` + summary.results.map(result => `${result.id} ${result.ok ? 'PASS' : 'FAIL'}`).join(', ');
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ ...options, agent: false, timeout: 20000, headers: { ...options.headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let envelope = null; try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode === 200 && envelope?.ok === true) resolve(envelope.value);
        else reject(new Error(`${options.method} ${options.path} -> ${res.statusCode} ${envelope?.error?.code ?? envelope?.error ?? ''}`.trim()));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${options.method} ${options.path} timed out`)));
    req.on('error', reject); req.end(payload);
  });
}

async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
  const port = Number(args['operator-port']);
  if (!Number.isInteger(port) || [3001, 3082, 6099].includes(port)) fail('refusing operator port ' + args['operator-port']);
  const token = fs.readFileSync(args['operator-token-file'], 'utf8').trim();
  const runner = new Runner({
    data: JSON.parse(fs.readFileSync(args.scenarios, 'utf8')), modelScript: args['model-script'], modelLog: args['model-log'], say: line => console.log(line),
    operator: (method, route, body) => request({ host: '127.0.0.1', port, method, path: route, headers: { authorization: 'Bearer ' + token } }, body),
    onebot: (method, route, body) => request({ socketPath: args['onebot-control'], method, path: route }, body),
  });
  const summary = await runner.run(args.only ? args.only.split(',') : null);
  console.log('SCENARIOS ' + JSON.stringify({ passed: summary.passed, failed: summary.failed, line: summaryLine(summary) }));
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error('scenarios: ' + error.message); process.exitCode = 1; });
}
