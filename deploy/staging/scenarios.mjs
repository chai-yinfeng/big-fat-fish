#!/usr/bin/env node
// Staging-only scenario replay: "who said what -> who received which reply", driven through
// the fake OneBot (fake-onebot.mjs), the scripted model (fake-model.mjs) and the real operator
// API of the staged release. No real QQ account, no provider key.
//   node scenarios.mjs --operator-port 13082 --operator-token-file <file> --onebot-control <socket>
//        --model-script <file> --model-log <file> --scenarios <scenarios.json> [--only S1,S3]
//        [--inference-socket <socket> --inference-token-file <file>]   (the staged gateway, for `gatewayCall` and `providerJob`)
// A scenario is { id, title, model: [rules for fake-model.mjs], steps: [...], finally: [...] };
// each step is an object with exactly one key naming an entry of STEPS below. `{run}` anywhere in a
// scenario becomes a token that is new on every replay, so a replay never mistakes the memory an
// earlier replay left behind for its own.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MOCK_MODEL_KEY = 'MOCK-KEY-staging-not-a-real-key';
// The key of the staging-only mock provider (fake-provider.mjs); its upstream accepts any key starting with MOCK-.
export const MOCK_PROVIDER_KEY = 'MOCK-PROVIDER-KEY-staging-not-a-real-key';
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

/** Is `earlier` (message hashes of one request) a prefix of `later`? */
const extends_ = (later, earlier) => earlier.length <= later.length && earlier.every((hash, index) => later[index] === hash);
/** Did the history only lose its oldest messages between two requests (system message apart)? */
const trimmed = (later, earlier) => { for (let k = 1; k < earlier.length - 1; k++) if (extends_(later.slice(1), earlier.slice(1 + k))) return true; return false; };
/** The logged model requests of this scenario whose typed text contains `userText`, with the fields the prefix steps need. */
function requestsOf(run, ctx, userText) {
  const requests = run.modelLog(ctx).filter(entry => entry.stream && entry.userText.includes(userText));
  if (!requests.length) fail(`the model never received ${JSON.stringify(userText)}`);
  if (!requests.every(entry => Array.isArray(entry.hashes) && entry.hashes.length > 1 && Array.isArray(entry.notes) && Number.isInteger(entry.turns) && typeof entry.system === 'string')) fail('the model request log lacks hashes/notes/turns/system');
  return requests;
}

// A 1x1 PNG: what the content service would send the gateway after shrinking a real picture.
const MOCK_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** Today's usage rows by capability (operator GET /usage). */
const usageRows = async run => Object.fromEntries((await run.operator('GET', '/usage')).rows.map(row => [row.id, row]));
const includes = (text, { contains, absent }) => (contains === undefined || text.includes(contains)) && (absent === undefined || !text.includes(absent));

/** Step implementations. `run` is the Runner; `ctx` is per-scenario state. */
async function provenance(run, item, person, { source, verbatim = true }) {
  const { sources } = await run.operator('GET', '/memory/sources?id=' + encodeURIComponent(item.id));
  if (item.personId !== run.personId(person) || item.visibility !== 'private' || sources.length !== 1 || sources[0].role !== 'user' || sources[0].id !== item.evidence?.observationId) fail(`the memory of ${person} is not a private item traced to one observation of that person's own words`);
  if (source !== undefined && !sources[0].text.includes(source)) fail(`the memory of ${person} is not traced to the observation containing ${JSON.stringify(source)}`);
  const quoted = typeof item.evidence.quote === 'string' && sources[0].text.includes(item.evidence.quote);
  if (verbatim ? !quoted || item.evidence.quoteVerbatim !== undefined : quoted || item.evidence.quoteVerbatim !== false) fail(`the quote of the memory of ${person} is ${verbatim ? 'not verbatim in its observation, or is marked as not verbatim' : 'not marked as not verbatim'}`);
}

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
   * `in: "context"` narrows it to the memory-hub note, i.e. what Authority retrieved for this run;
   * `in: "system"` to the system message (base prompt, persona and the person's standing profile). */
  async expectPrompt(run, ctx, { userText, contains, absent, in: part = 'request' }) {
    if (!['request', 'context', 'system'].includes(part)) fail(`expectPrompt: unknown part ${JSON.stringify(part)}`);
    const requests = run.modelLog(ctx).filter(entry => entry.stream && entry.userText.includes(userText));
    if (!requests.length) fail(`the model never received ${JSON.stringify(userText)}`);
    // A log entry without these fields would turn `absent` into an empty check: refuse it.
    if (!requests.every(entry => [entry.system, entry.context, entry.rest].every(value => typeof value === 'string'))) fail('the model request log lacks system/context/rest');
    const sent = entry => part === 'context' ? entry.context : part === 'system' ? entry.system : [entry.system, entry.context, entry.userText, entry.rest].join('\n');
    if (!requests.every(entry => includes(sent(entry), { contains, absent }))) fail(`the model ${part} for ${JSON.stringify(userText)} ${contains !== undefined ? 'lacks ' + JSON.stringify(contains) : 'contains ' + JSON.stringify(absent)}`);
  },
  async expectNoModelCall(run, ctx, { userText }) {
    if (run.modelLog(ctx).some(entry => entry.userText.includes(userText))) fail(`the model received ${JSON.stringify(userText)}`);
  },
  /** `times` turns with one person, one at a time: `text` is said (`{n}` = the turn number) and the reply
   * awaited. `pad`: that many filler characters are appended, to make runs of a known size. */
  async converse(run, ctx, { from, text, times, reply, pad = 0 }) {
    for (let n = 1; n <= times; n++) {
      await STEPS.say(run, ctx, { from, text: text.replaceAll('{n}', String(n)) + '。'.repeat(pad) });
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
    const count = text => (text.match(/^\{"content":.*$/gm) ?? []).length;
    const ids = trace.sections.flatMap(section => section.ids), lines = count(entry.context);
    if (ids.length !== lines) fail(`the trace lists ${ids.length} injected item(s), the model context carries ${lines} memory line(s)`);
    // The standing profile is traced apart: its items are in the system message, not in the note.
    const profile = trace.profile ?? [];
    if (trace.profile !== undefined) {
      if (typeof entry.system !== 'string') fail('the model request log lacks system');
      if (profile.length !== count(entry.system)) fail(`the trace lists ${profile.length} profile item(s), the system message carries ${count(entry.system)} line(s)`);
    }
    const known = new Map((await run.memoryPages('')).flatMap(page => page.items).map(item => [item.id, item]));
    const texts = [...ids.map(id => [id, entry.context, 'context']), ...profile.map(id => [id, entry.system, 'system message'])].map(([id, sent, where]) => {
      const item = known.get(id);
      if (!item) fail(`traced item ${id} is not in Authority's memory listing`);
      const content = item.attribution === 'reported' ? `${item.key}: ${item.value}` : item.summary ?? item.text;
      // Memory lines are JSON: compare the content as it is written inside one.
      if (!sent.includes(JSON.stringify(content).slice(1, -1))) fail(`the model ${where} lacks the traced item ${JSON.stringify(content.slice(0, 80))}`);
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
  /** Stable prefix, over the requests whose typed text contains `userText` (at least `minRequests`, in order):
   * the system message carries no revision counter and no clock time; a tool continuation is its run's
   * first request plus new messages; and the first request of the next run is the previous request plus
   * new messages. A batch trim legitimately breaks that once in a while: at most `trims` of the run-to-run
   * steps may instead have only lost the oldest messages. */
  async expectStablePrefix(run, ctx, { userText, minRequests = 4, trims = 1 }) {
    const requests = requestsOf(run, ctx, userText);
    if (requests.length < minRequests) fail(`only ${requests.length} model request(s) for ${JSON.stringify(userText)}, expected at least ${minRequests}`);
    const volatile = requests.find(entry => /revision=|\d{4}-\d\d-\d\dT\d\d:\d\d/.test(entry.system));
    if (volatile) fail(`the system message for ${JSON.stringify(volatile.userText.slice(0, 40))} carries a revision or a clock time`);
    let continuations = 0, cuts = 0;
    for (let i = 1; i < requests.length; i++) {
      const earlier = requests[i - 1], later = requests[i], what = `request ${i + 1} (${JSON.stringify(later.userText.slice(0, 40))})`;
      if (extends_(later.hashes, earlier.hashes) && later.hashes.length > earlier.hashes.length) { if (later.afterTool) continuations++; continue; }
      if (later.afterTool) fail(`${what} is a tool continuation but does not start with the request before it`);
      if (!trimmed(later.hashes, earlier.hashes)) fail(`${what} does not start with the request before it`);
      if (++cuts > trims) fail(`${what}: the history start moved ${cuts} times in ${requests.length} requests`);
    }
    if (!continuations) fail('no tool continuation was replayed: the prefix inside a run was not exercised');
  },
  /** Batch trim, over the first request of each run whose typed text contains `userText`: the start of the
   * replayed history moves only `minMoves`..`maxMoves` times, every move drops at least two runs at once
   * and is at least `minGap` runs after the previous one; between moves every request starts with the one before. */
  async expectBatchTrim(run, ctx, { userText, minMoves, maxMoves, minGap = 3 }) {
    const requests = requestsOf(run, ctx, userText).filter(entry => !entry.afterTool), moves = [];
    for (let i = 1; i < requests.length; i++) {
      const earlier = requests[i - 1], later = requests[i];
      if (later.hashes[1] === earlier.hashes[1]) {
        if (!extends_(later.hashes, earlier.hashes)) fail(`run ${i + 1} kept its history start but does not start with the request before it`);
        continue;
      }
      if (!trimmed(later.hashes, earlier.hashes)) fail(`run ${i + 1}: the history changed otherwise than by losing its oldest runs`);
      if (later.turns > earlier.turns - 1) fail(`run ${i + 1} dropped ${earlier.turns + 1 - later.turns} run(s): not a batch`);
      if (moves.length && i - moves.at(-1) < minGap) fail(`the history start moved at runs ${moves.at(-1) + 1} and ${i + 1}: less than ${minGap} runs apart`);
      moves.push(i);
    }
    if (moves.length < minMoves || moves.length > maxMoves) fail(`the history start moved ${moves.length} time(s) in ${requests.length} runs, expected ${minMoves}..${maxMoves}`);
  },
  /** Earlier turns replayed with the run whose typed text contains `userText` (user messages before it). */
  async expectHistory(run, ctx, { userText, minEarlier = 0, maxEarlier = Infinity }) {
    for (const entry of requestsOf(run, ctx, userText)) if (entry.turns - 1 < minEarlier || entry.turns - 1 > maxEarlier) fail(`${entry.turns - 1} earlier turn(s) were replayed with ${JSON.stringify(userText)}, expected ${minEarlier}..${maxEarlier}`);
  },
  /** In every request for the run whose typed text contains `userText`, exactly one memory-hub note of the
   * whole replayed window (the newest one included) carries `contains`. */
  async expectInjectedOnce(run, ctx, { userText, contains }) {
    for (const entry of requestsOf(run, ctx, userText)) {
      const carrying = entry.notes.filter(note => note.includes(contains)).length;
      if (carrying !== 1) fail(`${carrying} memory-hub note(s) in the request for ${JSON.stringify(userText)} carry ${JSON.stringify(contains)}, expected exactly 1`);
    }
  },
  /** Pin the active memory item of `person` that mentions `contains` (operator POST /memory/retention). */
  async pinMemory(run, _ctx, { person, contains, timeoutMs = 20000 }) {
    const mentions = item => item.personId === run.personId(person) && item.status === 'active' && [item.key, item.value, item.summary, item.text].filter(Boolean).join(' ').includes(contains);
    const item = await run.poll(async () => (await run.operator('GET', '/memory?limit=100')).items.find(mentions), timeoutMs, `Authority has no memory of ${person} containing ${JSON.stringify(contains)}`);
    await run.operator('POST', '/memory/retention', { entityId: item.entityId, id: item.id, pinned: true });
  },
  /** Edit the persona through the operator route the console uses; `restorePersona` puts the old values back. */
  async setPersona(run, ctx, { patch }) {
    const { persona } = await run.operator('GET', '/world');
    ctx.persona ??= Object.fromEntries(Object.keys(patch).map(key => [key, persona.value[key]]));
    await run.operator('POST', '/persona', { patch, expectedRevision: persona.revision });
  },
  async restorePersona(run, ctx) {
    if (!ctx.persona) return;
    const { persona } = await run.operator('GET', '/world');
    await run.operator('POST', '/persona', { patch: ctx.persona, expectedRevision: persona.revision });
    ctx.persona = undefined;
  },
  /** Admission = an actor binding and a private conversation in Authority (operator /people, /conversations). */
  async expectAdmitted(run, _ctx, { person, admitted }) {
    const people = (await run.operator('GET', '/people')).people, conversations = await run.operator('GET', '/conversations');
    const actor = people.some(item => item.actors.some(binding => binding.externalActorId.endsWith(':user:' + run.qq(person))));
    const stream = conversations.some(item => item.streamId.endsWith(':private:' + run.qq(person)));
    if (actor !== admitted || stream !== admitted) fail(`${person}: actor bound=${actor}, conversation bound=${stream}, expected ${admitted}`);
  },
  /** A machine digest of `person` (operator GET /memory: kind "digest", marked as machine-written, private, no
   * evidence) whose summary contains `contains`; waits for the memory worker to write it. `covers`: one of the
   * observations it was derived from (operator GET /memory/sources) must contain this text. */
  async expectDigest(run, _ctx, { person, contains, covers, timeoutMs = 90000 }) {
    const digest = await run.poll(async () => (await run.digests(person)).find(item => item.summary.includes(contains)), timeoutMs, `Authority has no digest of ${person} containing ${JSON.stringify(contains)}`);
    if (digest.personId !== run.personId(person) || digest.source?.machine !== 'digest' || digest.visibility !== 'private' || digest.evidence !== undefined) fail(`the digest of ${person} is not a private machine digest without evidence`);
    if (covers === undefined) return;
    const { sources } = await run.operator('GET', '/memory/sources?id=' + encodeURIComponent(digest.id));
    if (sources.length !== digest.derivedFrom.length || !sources.some(source => source.text.includes(covers))) fail(`the digest of ${person} is not derived from an observation containing ${JSON.stringify(covers)}`);
  },
  async expectNoDigest(run, _ctx, { person, contains }) {
    if ((await run.digests(person)).some(item => item.summary.includes(contains))) fail(`Authority still has a digest of ${person} containing ${JSON.stringify(contains)}`);
  },
  /** A fact of `person` that consolidation extracted (marked "extracted") whose value contains `contains`, with
   * the provenance of `expectProvenance` (`source`, `verbatim`). */
  async expectExtracted(run, _ctx, { person, contains, source, verbatim, timeoutMs = 30000 }) {
    const label = await run.personLabel(person);
    const fact = await run.poll(async () => (await run.memoryPages(`person=${label}&`)).flatMap(page => page.items).find(item => item.type === 'facts' && item.status === 'active' && item.source?.machine === 'extracted' && String(item.value).includes(contains)), timeoutMs, `Authority has no extracted fact of ${person} containing ${JSON.stringify(contains)}`);
    await provenance(run, fact, person, { source, verbatim });
  },
  /** The active memory item of `person` that mentions `contains` is private, that person's, and traced to exactly
   * one observation of that person's own words (operator GET /memory/sources); `source`: text that observation
   * must contain. Its quote is in that observation and the item is unmarked, or with `verbatim: false` the quote
   * is not in it and the item carries the non-verbatim mark. */
  async expectProvenance(run, _ctx, { person, contains, source, verbatim, timeoutMs = 20000 }) {
    const mentions = item => item.personId === run.personId(person) && item.status === 'active' && [item.key, item.value, item.summary, item.text].filter(Boolean).join(' ').includes(contains);
    const item = await run.poll(async () => (await run.operator('GET', '/memory?limit=100')).items.find(mentions), timeoutMs, `Authority has no memory of ${person} containing ${JSON.stringify(contains)}`);
    await provenance(run, item, person, { source, verbatim });
  },
  /** The consolidation requests the model was sent during this scenario (the fake model logs their whole input).
   * `contains` selects them: at least one, or exactly `count`; none of the selected may contain `absent`.
   * `afterMs`: wait first, to give an unwanted request the time to happen. */
  async expectConsolidationInput(run, ctx, { contains, absent, count, afterMs = 0 }) {
    await run.sleep(afterMs);
    const requests = run.modelLog(ctx).filter(entry => entry.consolidation === true);
    if (!requests.every(entry => typeof entry.maintenance === 'string' && entry.stream === false)) fail('the model request log lacks the consolidation input');
    const selected = requests.filter(entry => entry.maintenance.includes(contains));
    if (count === undefined ? !selected.length : selected.length !== count) fail(`${selected.length} consolidation request(s) contain ${JSON.stringify(contains)}, expected ${count ?? 'at least 1'}`);
    if (absent !== undefined && selected.some(entry => entry.maintenance.includes(absent))) fail(`a consolidation request containing ${JSON.stringify(contains)} also contains ${JSON.stringify(absent)}`);
  },
  /** No chat request of this scenario contains `text` anywhere (system message, memory-hub notes, typed text,
   * earlier dialogue, tool results). At least `minRequests` chat requests must have been made. */
  async expectNoChatContains(run, ctx, { text, minRequests = 1 }) {
    const requests = run.modelLog(ctx).filter(entry => entry.stream);
    if (requests.length < minRequests) fail(`only ${requests.length} chat request(s) were made, expected at least ${minRequests}`);
    if (!requests.every(entry => [entry.system, entry.context, entry.userText, entry.rest].every(value => typeof value === 'string'))) fail('the model request log lacks system/context/rest');
    const leaked = requests.find(entry => [entry.system, entry.context, entry.userText, entry.rest].join('\n').includes(text));
    if (leaked) fail(`the chat request for ${JSON.stringify(leaked.userText.slice(0, 40))} contains ${JSON.stringify(text)}`);
  },
  /** Consolidation status (operator GET /memory/consolidation) of `person`'s conversation: waits until every given
   * condition holds (`calls` and `digests` exactly, `waitingMin` observations out of the window and not yet
   * consolidated, `paused` the reason nothing is handed out); with `steadyMs` they must still hold after that time. */
  async expectConsolidation(run, _ctx, { person, calls, digests, waitingMin, paused, steadyMs = 0, timeoutMs = 90000 }) {
    const label = await run.personLabel(person);
    const read = async () => {
      const status = await run.operator('GET', '/memory/consolidation'), row = status.streams.find(item => item.person === label);
      const leaked = [run.data.bot, ...Object.values(run.data.people)].find(account => JSON.stringify(status).includes(account.qq));
      if (leaked) fail(`the consolidation status contains the account number ${leaked.qq}`);
      return { calls: row?.calls, digests: row?.digests, waiting: row?.waiting, paused: status.paused };
    };
    const holds = seen => (calls === undefined || seen.calls === calls) && (digests === undefined || seen.digests === digests) && (waitingMin === undefined || seen.waiting >= waitingMin) && (paused === undefined || seen.paused === paused);
    let seen;
    const wanted = JSON.stringify({ calls, digests, waitingMin, paused });
    try { await run.poll(async () => holds(seen = await read()), timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`consolidation of ${person} is ${JSON.stringify(seen)}, expected ${wanted}`); }
    if (!steadyMs) return;
    await run.sleep(steadyMs);
    if (holds(seen = await read())) return;
    // A batch is counted when handed out and uncounted when the spend tier refuses it: look once more.
    await run.sleep(1000);
    if (!holds(seen = await read())) fail(`consolidation of ${person} became ${JSON.stringify(seen)}, expected it to stay ${wanted}`);
  },
  /** `noteExtracted` remembers how many extracted facts review() has refused so far, by reason;
   * `expectRejected` then requires exactly these new refusals since (`reasons`: { reason: count }). */
  async noteExtracted(run, ctx) { ctx.rejected = (await run.operator('GET', '/memory/consolidation')).extracted.rejected; },
  async expectRejected(run, ctx, { reasons, timeoutMs = 30000 }) {
    let seen;
    const since = async () => { const now = (await run.operator('GET', '/memory/consolidation')).extracted.rejected; return Object.fromEntries(Object.keys(now).map(reason => [reason, now[reason] - (ctx.rejected?.[reason] ?? 0)]).filter(([, n]) => n)); };
    const same = value => JSON.stringify(Object.entries(value).sort()) === JSON.stringify(Object.entries(reasons).sort());
    try { await run.poll(async () => same(seen = await since()), timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`extracted facts were refused as ${JSON.stringify(seen)}, expected ${JSON.stringify(reasons)}`); }
  },
  /** Forget the observation of `person` containing `source`, the way the console does: preview, pause, forget,
   * resume. The preview must list the digest derived from it; afterwards only that person's conversation has a
   * new memory epoch. Staging's memory unit cannot reach the operator port, so the runner acknowledges the
   * cleanup job itself: no session file is purged here (the retired session is simply never loaded again). */
  async forget(run, _ctx, { person, source }) {
    let observation, digest;
    for (const item of await run.digests(person)) {
      const found = (await run.operator('GET', '/memory/sources?id=' + encodeURIComponent(item.id))).sources.find(row => row.text.includes(source));
      if (found) { observation = found; digest = item; break; }
    }
    if (!observation) fail(`no digest of ${person} is derived from an observation containing ${JSON.stringify(source)}`);
    const preview = await run.operator('POST', '/memory/forget-preview', { entityId: digest.entityId, ids: [observation.id] });
    if (!preview.digestIds?.includes(digest.id) || !preview.sourceObservationIds.includes(observation.id)) fail('the forget preview does not list the digest derived from the observation');
    const epochs = async () => new Map((await run.operator('GET', '/conversations')).map(row => [row.streamId, row.memoryEpoch]));
    const before = await epochs();
    await run.setPaused(true);
    await run.operator('POST', '/memory/forget', { entityId: digest.entityId, ids: [observation.id], expectedMemoryEpoch: preview.memoryEpoch });
    for (const job of await run.operator('GET', '/memory/cleanup/pending')) await run.operator('POST', '/memory/cleanup/complete', { id: job.id, memoryEpoch: job.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
    await STEPS.resume(run);
    const own = `qq:${run.data.bot.qq}:private:${run.qq(person)}`;
    for (const [streamId, epoch] of await epochs()) if (epoch !== before.get(streamId) + (streamId === own ? 1 : 0)) fail(`memory epoch of ${run.nameOf(streamId.split(':').at(-1))} went from ${before.get(streamId)} to ${epoch}`);
  },
  /** The world runs and the QQ bridge has noticed (also as a `finally` after `forget`). */
  async resume(run) {
    await run.setPaused(false);
    await run.poll(async () => !(await run.operator('GET', '/qq')).paused, 15000, 'the QQ bridge stayed paused');
  },
  /** The world is paused (`resume` runs it again). */
  async pause(run) { await run.setPaused(true); },
  /** The quiet hours of initiated runs through the operator route (POST /initiative/settings): "none" (so a replay
   * does the same at any hour), "now" (two hours around the present, Beijing time) or "default" (23:30 to 08:00). */
  async quietHours(run, _ctx, { window }) {
    const minute = Math.floor((Date.now() + 8 * 3600000) / 60000) % 1440, clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    const quietHours = window === 'none' ? { from: '00:00', to: '00:00' } : window === 'now' ? { from: clock((minute + 1380) % 1440), to: clock((minute + 60) % 1440) } : window === 'default' ? { from: '23:30', to: '08:00' } : fail(`quietHours: unknown window ${JSON.stringify(window)}`);
    const set = (await run.operator('POST', '/initiative/settings', { quietHours })).quietHours;
    if (set.now !== (window === 'now')) fail(`the quiet hours ${set.from}-${set.to} ${set.now ? 'cover' : 'do not cover'} the present`);
  },
  /** The operator's "try it on me" (POST /initiative/poke with an empty body: the route takes no target). `expect`:
   * "waiting" (registered for the bridge to fetch) or the outcome it must be closed with at once. The request is
   * remembered for `expectInitiation`. */
  async poke(run, ctx, { expect = 'waiting' } = {}) {
    const value = await run.operator('POST', '/initiative/poke', {});
    if (value.already) fail('an earlier initiation is still open');
    if (value.owner !== true) fail('the poke is not about the owner');
    const got = value.status === 'closed' ? value.outcome : value.status;
    if (got !== expect) fail(`the poke is ${got}, expected ${expect}`);
    ctx.initiation = value.id;
  },
  /** How the poked request ended (operator GET /initiative/log): waits until it is closed, then its outcome must be
   * `outcome`. The list never holds an account number. */
  async expectInitiation(run, ctx, { outcome, timeoutMs = 60000 }) {
    if (!ctx.initiation) fail('expectInitiation: no poke in this scenario');
    const ended = await run.poll(async () => {
      const log = await run.operator('GET', '/initiative/log');
      const leaked = [run.data.bot, ...Object.values(run.data.people)].find(account => JSON.stringify(log).includes(account.qq));
      if (leaked) fail(`the initiation list contains the account number ${leaked.qq}`);
      const item = log.items.find(entry => entry.id === ctx.initiation);
      return item?.status === 'closed' ? item : null;
    }, timeoutMs, 'the initiation never ended');
    if (ended.outcome !== outcome) fail(`the initiation ended as ${ended.outcome}, expected ${outcome}`);
  },
  /** The operator's demonstration job (POST /jobs/demo: the body can only say how many seconds it waits; it is always
   * registered in the owner's own conversation). `expect`: "queued", or the reason it must be refused with
   * ("daily_limit", "busy"). The job is remembered for `expectJob`. */
  async demoJob(run, ctx, { seconds = 2, expect = 'queued' } = {}) {
    const value = await run.operator('POST', '/jobs/demo', { seconds });
    const got = value.status === 'rejected' ? value.failureCode : value.status;
    if (got !== expect) fail(`the demo job is ${got}, expected ${expect}`);
    (ctx.jobs ??= []).push(value.id);
  },
  /** One job of this scenario on the operator's list (GET /jobs; `job`: its number in the order registered, default
   * the last): waits until its state is `status` and telling the person stands as `notice` ("none", "pending",
   * "carry", "issued", or how it was closed: "sent", "carried", ...). A finished job shows its result, a refused one
   * its reason (`code`). The list never holds an account number. */
  async expectJob(run, ctx, { job, status, notice, code, timeoutMs = 60000 }) {
    const id = ctx.jobs?.[job === undefined ? ctx.jobs.length - 1 : job - 1] ?? fail('expectJob: no such demo job in this scenario');
    let seen = null;
    const told = entry => entry.notice.state === 'closed' ? entry.notice.outcome : entry.notice.state;
    try {
      await run.poll(async () => {
        const listing = await run.operator('GET', '/jobs');
        const leaked = [run.data.bot, ...Object.values(run.data.people)].find(account => JSON.stringify(listing).includes(account.qq));
        if (leaked) fail(`the job list contains the account number ${leaked.qq}`);
        seen = listing.jobs.find(entry => entry.id === id) ?? null;
        return seen && seen.status === status && (notice === undefined || told(seen) === notice);
      }, timeoutMs, 'timeout');
    } catch (error) { if (error.message !== 'timeout') throw error; fail(`the job is ${seen ? `${seen.status}, telling ${told(seen)}` : 'not listed'}, expected ${status}${notice === undefined ? '' : ', telling ' + notice}`); }
    if (seen.owner !== true) fail('the job is not the owner\'s');
    if (code !== undefined && seen.failureCode !== code) fail(`the job's reason is ${seen.failureCode}, expected ${code}`);
    if (status === 'done' && !['dropped'].includes(String(told(seen)).split(':')[0]) && !(typeof seen.result === 'string' && seen.result)) fail('the finished job shows no result');
  },
  /** `noteCompletions` remembers the completion requests on the operator's list (GET /initiative/log);
   * `expectCompletions` then requires exactly these new ones since, oldest first, each closed with the given outcome:
   * how often she was asked to tell a finished job, and how each telling ended. */
  async noteCompletions(run, ctx) { ctx.completions = new Set((await run.operator('GET', '/initiative/log')).items.filter(item => item.kind === 'completion').map(item => item.id)); },
  async expectCompletions(run, ctx, { outcomes, timeoutMs = 60000 }) {
    if (!ctx.completions) fail('expectCompletions: no noted completions');
    let seen;
    const since = async () => (await run.operator('GET', '/initiative/log')).items.filter(item => item.kind === 'completion' && !ctx.completions.has(item.id)).reverse().map(item => item.owner !== true ? 'not-the-owner' : item.status === 'closed' ? item.outcome : item.status);
    try { await run.poll(async () => JSON.stringify(seen = await since()) === JSON.stringify(outcomes), timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`the completions since are ${JSON.stringify(seen)}, expected ${JSON.stringify(outcomes)}`); }
  },
  /** The fake OneBot leaves the next `count` sends without a receipt, as when the platform's answer is lost. */
  async loseReceipts(run, _ctx, { count }) { await run.onebot('POST', '/lose-receipts', { count }); },
  /** Sends towards `to` that got no receipt during this scenario (never counted as delivered): exactly `count`. */
  async expectLostSends(run, _ctx, { to, count }) {
    const lost = (await run.onebot('GET', '/state')).lost;
    if (!Array.isArray(lost)) fail('this fake OneBot does not record lost sends');
    const actual = lost.filter(item => item.user_id === run.qq(to)).length, others = lost.filter(item => item.user_id !== run.qq(to));
    if (actual !== count || others.length) fail(`${actual} send(s) to ${to} went without a receipt (and ${others.length} to others), expected ${count} (and 0)`);
  },
  /** Runs the model was asked for during this scenario whose typed text or event block contains `userText`
   * (first requests only, tool continuations apart): exactly `count`. */
  async expectModelCalls(run, ctx, { userText, count }) {
    const actual = run.modelLog(ctx).filter(entry => entry.stream && !entry.afterTool && entry.userText.includes(userText)).length;
    if (actual !== count) fail(`the model was asked ${actual} time(s) for ${JSON.stringify(userText)}, expected ${count}`);
  },
  /** `noteMessages` remembers how many lines Authority holds of `person`'s private conversation (operator
   * GET /conversations); `expectMessages` then requires exactly `added` more: what was really said and delivered. */
  async noteMessages(run, ctx, { person }) {
    // A reply is recorded a moment after it is delivered: note the count once it has stopped moving.
    let count = await run.messageCount(person);
    for (let i = 0; i < 20; i++) { await run.sleep(400); const again = await run.messageCount(person); if (again === count) break; count = again; }
    (ctx.messages ??= new Map()).set(person, count);
  },
  async expectMessages(run, ctx, { person, added, timeoutMs = 15000 }) {
    const before = ctx.messages?.get(person) ?? fail(`expectMessages: no noted count for ${person}`);
    let seen;
    try { await run.poll(async () => (seen = await run.messageCount(person) - before) === added, timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`Authority holds ${seen} more line(s) of ${person}, expected ${added}`); }
  },
  /** A run she started herself keeps the request prefix. The chain is: the last request whose typed text contains
   * `before`, every request of the initiated run (an event block marked as not the person's words stands where a
   * message would be, after a note saying nobody wrote), the first request whose typed text contains `after`. Each
   * is the one before it plus new messages, with the same system message; at most `trims` steps may instead have
   * only lost the oldest messages (a batch trim). No ordinary request carries the note line of an initiated run. */
  async expectInitiatedPrefix(run, ctx, { before, after, trims = 1 }) {
    const log = run.modelLog(ctx).filter(entry => entry.stream), EVENT = '[后台事件 · 这不是对方发来的话]', NOTE = '这一条不是对方发来的消息';
    if (!log.every(entry => Array.isArray(entry.hashes) && entry.hashes.length > 1 && typeof entry.system === 'string' && typeof entry.context === 'string')) fail('the model request log lacks hashes/system/context');
    const earlier = log.findLast(entry => entry.userText.includes(before)), later = log.find(entry => entry.userText.includes(after)), initiated = log.filter(entry => entry.userText.startsWith(EVENT));
    if (!earlier || !later || !initiated.length) fail(`the model log lacks ${!earlier ? JSON.stringify(before) : !later ? JSON.stringify(after) : 'an initiated run'}`);
    if (!initiated.every(entry => entry.context.includes(NOTE))) fail('an initiated run was sent without the note saying nobody wrote');
    const ordinary = log.find(entry => !entry.userText.startsWith(EVENT) && entry.context.includes(NOTE));
    if (ordinary) fail(`the ordinary request for ${JSON.stringify(ordinary.userText.slice(0, 40))} carries the note of an initiated run`);
    const chain = [earlier, ...initiated, later];
    let cuts = 0;
    for (let i = 1; i < chain.length; i++) {
      const what = `request ${i + 1} of the chain (${JSON.stringify(chain[i].userText.slice(0, 40))})`;
      if (chain[i].system !== chain[0].system) fail(`${what} has another system message`);
      if (extends_(chain[i].hashes, chain[i - 1].hashes) && chain[i].hashes.length > chain[i - 1].hashes.length) continue;
      if (!trimmed(chain[i].hashes, chain[i - 1].hashes)) fail(`${what} does not start with the request before it`);
      if (++cuts > trims) fail(`${what}: the history start moved ${cuts} times in ${chain.length} requests`);
    }
  },
  /** Daily cap / tiers through the real operator route (POST /spend/settings). */
  async spendSettings(run, _ctx, settings) { await run.operator('POST', '/spend/settings', settings); },
  async expectSpend(run, _ctx, { tier, timeoutMs = 10000 }) {
    await run.poll(async () => (await run.operator('GET', '/spend')).tier === tier, timeoutMs, `spend tier never became ${tier}`);
  },
  /** One paid call at the gateway's own exit, the way the content service makes it (staging has no image runtime,
   * so a picture cannot come in through QQ): `kind` "vision" (a 1x1 picture with `text` as the question) or
   * "search" (`text` as the query). `expect`: "ok", or the gateway's refusal code. */
  async gatewayCall(run, _ctx, { kind, text, expect = 'ok' }) {
    if (typeof run.gateway !== 'function') fail('gatewayCall needs --inference-socket and --inference-token-file');
    const [route, body] = kind === 'vision' ? ['/v1/vision/describe', { imageBase64: MOCK_IMAGE, mime: 'image/png', question: text }] : kind === 'search' ? ['/v1/web/search', { query: text }] : fail(`gatewayCall: unknown kind ${JSON.stringify(kind)}`);
    const outcome = await run.gateway(route, body);
    if (outcome !== expect) fail(`the gateway answered ${outcome} to a ${kind} call, expected ${expect}`);
  },
  /** A provider's key through the real operator routes (POST /providers/key, /providers/clear): `action` "set"
   * stores the visibly fake key, "clear" removes it. The listing (GET /providers) must then say so. */
  async providerKey(run, _ctx, { provider, action }) {
    if (!['set', 'clear'].includes(action)) fail(`providerKey: unknown action ${JSON.stringify(action)}`);
    await run.operator('POST', action === 'set' ? '/providers/key' : '/providers/clear', { provider, ...(action === 'set' ? { apiKey: MOCK_PROVIDER_KEY } : {}) });
    const listed = (await run.operator('GET', '/providers')).providers;
    if (listed.find(item => item.id === provider)?.configured !== (action === 'set')) fail(`provider ${provider} is not listed as ${action === 'set' ? 'configured' : 'not configured'}`);
    if (JSON.stringify(listed).includes(MOCK_PROVIDER_KEY.slice(0, 12))) fail('the provider listing contains the key');
  },
  /** One operation of a provider adapter through the gateway's three actions, the way the content service will
   * call them: submit, ask until the job has ended (at most `maxPolls` times), fetch its first file (which must be
   * a PNG). `expect`: "done", "failed", or the code the submit is refused with. */
  async providerJob(run, _ctx, { operation, prompt, expect = 'done', maxPolls = 5 }) {
    if (typeof run.gatewayAnswer !== 'function') fail('providerJob needs --inference-socket and --inference-token-file');
    const submitted = await run.gatewayAnswer('/v1/provider/submit', { operation, input: { prompt } });
    if (submitted.code) { if (submitted.code !== expect) fail(`the gateway refused ${operation} with ${submitted.code}, expected ${expect}`); return; }
    let job = submitted.value, polls = 0;
    for (; job.state === 'pending' && polls < maxPolls; polls++) {
      const asked = await run.gatewayAnswer('/v1/provider/status', { job: job.job });
      if (asked.code) fail(`asking about the ${operation} job was refused with ${asked.code}`);
      job = asked.value;
    }
    if (job.state !== expect) fail(`the ${operation} job is ${job.state} after ${polls} polls, expected ${expect}`);
    if (expect !== 'done') return;
    const file = await run.gatewayAnswer('/v1/provider/fetch', { job: job.job, output: 0 });
    if (file.code || file.type !== 'image/png' || file.bytes.subarray(1, 4).toString('latin1') !== 'PNG') fail(`fetching the ${operation} result gave ${file.code ?? file.type}, expected a PNG`);
  },
  /** `noteUsage` remembers today's usage rows (operator GET /usage); `expectUsage` then requires exactly these changes
   * of one capability's row since: `used`, `calls`, `ok`, `failed` (default 0 each) and `denied` ({ reason: count },
   * default none). The ledger is written after the call it counts, so this waits for it. */
  async noteUsage(run, ctx) { ctx.usage = await usageRows(run); },
  async expectUsage(run, ctx, { capability, used = 0, calls = 0, ok = 0, failed = 0, denied = {}, timeoutMs = 15000 }) {
    const before = ctx.usage?.[capability] ?? fail(`expectUsage: no noted usage row for ${capability}`), wanted = JSON.stringify({ used, calls, ok, failed, denied: Object.entries(denied).sort() });
    let seen;
    const since = async () => {
      const now = (await usageRows(run))[capability];
      return JSON.stringify({ ...Object.fromEntries(['used', 'calls', 'ok', 'failed'].map(key => [key, now[key] - before[key]])), denied: Object.keys(now.denied).map(reason => [reason, now.denied[reason] - (before.denied[reason] ?? 0)]).filter(([, n]) => n).sort() });
    };
    try { await run.poll(async () => (seen = await since()) === wanted, timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`usage of ${capability} changed by ${seen}, expected ${wanted}`); }
  },
  /** The ledger and the spend meter agree on today's money: every paid row's cost is its spend category's amount
   * (operator GET /usage against GET /spend), and the rows add up to what was spent. At least `minPaidRows` rows cost something. */
  async expectUsageMatchesSpend(run, _ctx, { minPaidRows = 1, timeoutMs = 15000 }) {
    let seen;
    const micros = value => Math.round(value * 1e6);
    const agree = async () => {
      const usage = await run.operator('GET', '/usage'), spend = await run.operator('GET', '/spend'), paid = usage.rows.filter(row => row.spendCategory);
      seen = { day: [usage.day, spend.day], rows: Object.fromEntries(paid.map(row => [row.id, [row.costYuan, spend.byTier[row.spendCategory]]])), total: [paid.reduce((sum, row) => sum + micros(row.costYuan), 0), micros(spend.spentYuan)] };
      return usage.day === spend.day && paid.every(row => micros(row.costYuan) === micros(spend.byTier[row.spendCategory])) && seen.total[0] === seen.total[1] && paid.filter(row => row.costYuan > 0).length >= minPaidRows;
    };
    try { await run.poll(agree, timeoutMs, 'timeout'); } catch (error) { if (error.message !== 'timeout') throw error; fail(`the usage ledger and the spend meter disagree: ${JSON.stringify(seen)}`); }
  },
  /** A capability's daily limit through the real operator route (POST /usage/limits): a number, null (back to its
   * default), or "used" (what is used so far today, so that the next call is refused). */
  async usageLimit(run, _ctx, { capability, limit }) {
    await run.operator('POST', '/usage/limits', { limits: { [capability]: limit === 'used' ? (await usageRows(run))[capability].used : limit } });
  },
  /** One reply sent as several messages: the not-yet-matched messages delivered to `to`, in the order they
   * were sent, must be `minParts`..`maxParts` messages of at most `maxChars` characters each that together
   * are `text`, apart from white space. */
  async expectSplitReply(run, ctx, { to, text, minParts = 2, maxParts = 4, maxChars = 60, timeoutMs = 60000 }) {
    const squeeze = value => value.replace(/\s+/g, ''), whole = squeeze(text);
    const pending = async () => (await run.sent()).filter(item => item.user_id === run.qq(to) && !ctx.matched.has(item.message_id));
    let parts = [];
    await run.poll(async () => { parts = await pending(); return parts.length > maxParts || squeeze(parts.map(item => item.text).join('')).length >= whole.length; }, timeoutMs, `${to} did not receive the whole reply`).catch(error => fail(`${error.message}: got ${parts.length} message(s) ${JSON.stringify(parts.map(item => item.text.slice(0, 20)))}`));
    for (const item of parts) ctx.matched.add(item.message_id);
    if (parts.length < minParts || parts.length > maxParts) fail(`${to} received the reply as ${parts.length} message(s), expected ${minParts}..${maxParts}`);
    const long = parts.find(item => item.text.length > maxChars);
    if (long) fail(`a message to ${to} has ${long.text.length} characters, more than ${maxChars}: ${JSON.stringify(long.text.slice(0, 40))}`);
    if (squeeze(parts.map(item => item.text).join('')) !== whole) fail(`the messages to ${to} do not add up to the reply, in order: ${JSON.stringify(parts.map(item => item.text.slice(0, 20)))}`);
  },
  /** The memory-hub note of every request for the run whose typed text contains `userText` tells the time in
   * one line, as Beijing wall-clock time within `toleranceMs` of when the model was really asked (the real
   * time, not a world clock that stopped during a pause); the note and the system message carry no UTC timestamp. */
  async expectBeijingTime(run, ctx, { userText, toleranceMs = 120000 }) {
    for (const entry of requestsOf(run, ctx, userText)) {
      if (typeof entry.context !== 'string' || !Number.isFinite(entry.at)) fail('the model request log lacks context/at');
      const lines = entry.context.match(/^现在是 .*$/gm) ?? [], told = /^现在是 (\d{4})年(\d{1,2})月(\d{1,2})日 周([日一二三四五六]) (\d\d):(\d\d)（北京时间）$/.exec(lines[0] ?? '');
      if (lines.length !== 1 || !told) fail(`the note for ${JSON.stringify(userText)} has no single Beijing time line: ${JSON.stringify(lines)}`);
      const [year, month, day, , hour, minute] = told.slice(1).map(Number), at = Date.UTC(year, month - 1, day, hour - 8, minute);
      if ('日一二三四五六'[new Date(at + 8 * 3600000).getUTCDay()] !== told[4]) fail(`the note names the wrong weekday: ${lines[0]}`);
      // The line is to the minute: the request may be up to a minute later than it says.
      if (entry.at - at < -toleranceMs || entry.at - at > 60000 + toleranceMs) fail(`the note says ${JSON.stringify(lines[0])}, but the model was asked at ${new Date(entry.at).toISOString()}`);
      const utc = /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z/.exec(entry.context + '\n' + entry.system);
      if (utc) fail(`the model was shown the UTC timestamp ${utc[0]}`);
    }
  },
  /** Tool results the model was sent back during the run whose typed text contains `userText`, in order: the
   * `nth` one (1 = the first) must contain `contains` and must not contain `absent`. */
  async expectToolResult(run, ctx, { userText, nth = 1, contains, absent }) {
    const results = requestsOf(run, ctx, userText).filter(entry => entry.afterTool).map(entry => entry.toolResult);
    if (results.some(text => typeof text !== 'string')) fail('the model request log lacks toolResult');
    if (results.length < nth) fail(`the model got ${results.length} tool result(s) for ${JSON.stringify(userText)}, expected at least ${nth}`);
    if (!includes(results[nth - 1], { contains, absent })) fail(`tool result ${nth} for ${JSON.stringify(userText)} ${contains !== undefined && !results[nth - 1].includes(contains) ? 'lacks ' + JSON.stringify(contains) : 'contains ' + JSON.stringify(absent)}: ${JSON.stringify(results[nth - 1].slice(0, 200))}`);
  },
};

export class Runner {
  /** operator(method, route, body) and onebot(method, route, body) resolve to the `value` of an ok envelope. */
  /** gateway(route, body) (optional) posts to the staged gateway's inference socket and resolves to "ok" or the refusal code. */
  /** gatewayAnswer(route, body) (optional) does the same and resolves to { value } (a JSON answer), { bytes, type } (a file) or { code }. */
  constructor({ data, operator, onebot, gateway, gatewayAnswer, modelScript, modelLog, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {} }) {
    Object.assign(this, { data: validateScenarios(data), operator, onebot, gateway, gatewayAnswer, modelScriptFile: modelScript, modelLogFile: modelLog, sleep, report: say });
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
  /** The active machine digests of a person (operator GET /memory, every page). */
  async digests(name) {
    const label = await this.personLabel(name);
    return (await this.memoryPages(`person=${label}&`)).flatMap(page => page.items).filter(item => item.kind === 'digest' && item.status === 'active' && typeof item.summary === 'string');
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
  async scenario(written) {
    // `{run}`: new on every replay (letters and digits only, so it is one retrieval token).
    const scenario = JSON.parse(JSON.stringify(written).replaceAll('{run}', 'R' + Date.now().toString(36).toUpperCase()));
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

/** `gateway` for the Runner: POST to the gateway's inference socket; "ok", or the error code it refused with. */
export function gatewayCaller(socketPath, token) {
  return (route, body) => request({ socketPath, method: 'POST', path: route, headers: { authorization: 'Bearer ' + token } }, body).then(() => 'ok', error => / -> \d+ (\S+)$/.exec(error.message)?.[1] ?? error.message);
}

/** `gatewayAnswer` for the Runner: POST to the gateway's inference socket; the JSON value, the bytes of a file, or the refusal code. */
export function gatewayReader(socketPath, token) {
  return (route, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath, method: 'POST', path: route, agent: false, timeout: 20000, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks), type = String(res.headers['content-type'] ?? '').split(';')[0];
        if (type !== 'application/json') { resolve(res.statusCode === 200 ? { bytes, type } : { code: String(res.statusCode) }); return; }
        let envelope = null; try { envelope = JSON.parse(bytes.toString('utf8')); } catch {}
        resolve(res.statusCode === 200 && envelope?.ok === true ? { value: envelope.value } : { code: envelope?.error?.code ?? String(res.statusCode) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`POST ${route} timed out`)));
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
    ...(args['inference-socket'] && args['inference-token-file'] ? { gateway: gatewayCaller(args['inference-socket'], fs.readFileSync(args['inference-token-file'], 'utf8').trim()), gatewayAnswer: gatewayReader(args['inference-socket'], fs.readFileSync(args['inference-token-file'], 'utf8').trim()) } : {}),
  });
  const summary = await runner.run(args.only ? args.only.split(',') : null);
  console.log('SCENARIOS ' + JSON.stringify({ passed: summary.passed, failed: summary.failed, line: summaryLine(summary) }));
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error('scenarios: ' + error.message); process.exitCode = 1; });
}
