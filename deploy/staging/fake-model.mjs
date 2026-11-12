#!/usr/bin/env node
// Staging-only model gateway launcher: the release's real createModelGateway (spend meter,
// tiers, pause checks, sockets) with a scripted, deterministic stand-in for DeepSeek injected
// as fetchImpl. No provider is ever called. Never part of a release or a production unit;
// the production gateway has no configurable upstream.
//   node fake-model.mjs --release <release dir> --config <model-gateway.json> --script <rules.json> --log <requests.jsonl>
// Script file: [{ match, reply?, propose?: { type, payload }, retry?: { type, payload }, usage?: { prompt_tokens, completion_tokens } }]
// The first rule whose `match` occurs in the newest user message applies. `propose` makes the
// first answer a companion_scope propose tool call (evidence ref taken from the memory-hub note
// that leads the newest user message); the answer after the tool result is `reply`. `retry` (with `propose`)
// makes the answer to the first tool result a second propose, without an id; `reply` follows its result.
// Each logged request also records `notes` (the memory-hub note of every user message, oldest first),
// `turns` (the number of user messages) and `hashes` (one per message, system first), so a scenario can
// compare whole requests without the log holding every request in full.
// A consolidation request of the memory worker (not streamed; its user message is JSON with a `messages`
// list of [ref, speaker, time, text] rows) is answered by the first rule that has `consolidate` and whose
// `match` occurs in one of those rows: { match, consolidate: { summary, feeling?, facts?: [{ key, value,
// quote, in? }] } }. Each fact gets the ref of the first row containing `in` (default: its quote), so a
// script can point a quote at the wrong row or misquote it. Without such a rule the answer is a plain
// valid digest. Rules with `consolidate` never answer a chat, and chat rules never answer a consolidation.
// It is logged with `consolidation: true`, its user message as `maintenance`, and an empty `userText`.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_REPLY = 'MOCK-REPLY';
export const DEFAULT_USAGE = Object.freeze({ prompt_tokens: 100, completion_tokens: 20 });
export const DEFAULT_DIGEST = Object.freeze({ summary: 'MOCK-DIGEST 一段没有编排的闲聊', feeling: '', facts: [] });

/** The rows of a consolidation request ([ref, speaker, time, text]), or null for any other request. */
export function consolidationRows(body, userText) {
  if (body?.stream === true) return null;
  try { const rows = JSON.parse(userText)?.messages; return Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 4 && row.every(cell => typeof cell === 'string')) ? rows : null; } catch { return null; }
}
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : '';

// The executor's note delimiter (capabilities/conversation/agent.js NOTE_OPEN). This staging tool is
// uploaded on its own, so it cannot import the release's constant.
const NOTE_OPEN = '<<<记忆中枢附注开始>>>';

/** The observation ref the executor offers as evidence for this run (the evidence line of its note). */
export function evidenceRef(note) {
  const match = /^本轮可引用的聊天证据：(\[.*\])\s*$/m.exec(note);
  try { return JSON.parse(match[1]).find(item => item.role === 'user')?.ref ?? null; } catch { return null; }
}

/** The newest user message apart: the executor's memory-hub note (its first text block) and what the person typed. */
function splitUser(content) {
  const parts = Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text) : [textOf(content)];
  return parts.length > 1 && parts[0].startsWith(NOTE_OPEN) ? { context: parts[0], userText: parts.slice(1).join('') } : { context: '', userText: parts.join('') };
}

/** Pure decision: what the scripted model answers to one upstream chat-completions body. */
export function planReply(body, rules = []) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.findLastIndex(message => message?.role === 'user');
  const { context, userText } = last < 0 ? { context: '', userText: '' } : splitUser(messages[last].content), system = messages[0]?.role === 'system' ? textOf(messages[0].content) : '';
  // Everything else the model was sent: earlier dialogue, and this run's tool calls and results.
  const rest = JSON.stringify(messages.filter((message, index) => index !== last && !(index === 0 && message?.role === 'system')));
  const toolResult = last < 0 ? undefined : messages.slice(last + 1).findLast(message => message?.role === 'tool');
  const afterTool = toolResult !== undefined;
  const rows = consolidationRows(body, userText);
  if (rows) {
    const scripted = rules.find(item => typeof item?.match === 'string' && item.match && item.consolidate && rows.some(row => row[3].includes(item.match)))?.consolidate ?? DEFAULT_DIGEST;
    const facts = (scripted.facts ?? []).map(({ in: where, ...fact }) => ({ ...fact, ref: rows.find(row => row[3].includes(where ?? fact.quote))?.[0] ?? 'o999' }));
    const usage = { ...DEFAULT_USAGE, total_tokens: DEFAULT_USAGE.prompt_tokens + DEFAULT_USAGE.completion_tokens };
    return { kind: 'text', consolidation: true, maintenance: userText, userText: '', system, context: '', rest: '', notes: [], turns: 1, hashes: [], afterTool: false, usage, stream: false, text: JSON.stringify({ summary: scripted.summary, feeling: scripted.feeling ?? '', facts }) };
  }
  const rule = rules.find(item => typeof item?.match === 'string' && item.match && !item.consolidate && userText.includes(item.match)) ?? {};
  const usage = { ...DEFAULT_USAGE, ...rule.usage };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const users = messages.filter(message => message?.role === 'user');
  const shape = { notes: users.map(message => splitUser(message.content).context).filter(Boolean), turns: users.length, hashes: messages.map(message => createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 16)) };
  const base = { userText, system, context, rest, ...shape, afterTool, ...(afterTool ? { toolResult: textOf(toolResult.content) } : {}), usage, stream: body?.stream === true };
  const ref = evidenceRef(context);
  if (base.stream && rule.propose && !afterTool && ref && body.tools?.some(tool => tool?.function?.name === 'companion_scope')) {
    const id = 'mock-' + createHash('sha256').update(ref).digest('hex').slice(0, 16);
    return { ...base, kind: 'tool', call: { name: 'companion_scope', arguments: { action: 'propose', id, ref, type: rule.propose.type, payload: rule.propose.payload } } };
  }
  if (base.stream && rule.propose && rule.retry && ref && messages.slice(last + 1).filter(message => message?.role === 'tool').length === 1) {
    return { ...base, kind: 'tool', call: { name: 'companion_scope', arguments: { action: 'propose', ref, type: rule.retry.type, payload: rule.retry.payload } } };
  }
  return { ...base, kind: 'text', text: typeof rule.reply === 'string' ? rule.reply : base.stream ? DEFAULT_REPLY : 'OK' };
}

const chunk = (delta, finish = null, extra = {}) => ({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock-deepseek', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
/** A DeepSeek-shaped response body (SSE when streaming) for a plan. */
export function renderReply(plan) {
  if (!plan.stream) return JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock-deepseek', choices: [{ index: 0, message: { role: 'assistant', content: plan.text }, finish_reason: 'stop' }], usage: plan.usage });
  const chunks = plan.kind === 'tool'
    ? [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: plan.call.name, arguments: JSON.stringify(plan.call.arguments) } }] }), chunk({}, 'tool_calls', { usage: plan.usage })]
    : [chunk({ role: 'assistant', content: plan.text }), chunk({}, 'stop', { usage: plan.usage })];
  return chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** fetch stand-in. Every request is appended to `logFile`; anything but chat completions is refused. */
export function createFakeUpstream({ scriptFile, logFile }) {
  return async (url, options = {}) => {
    if (String(url) !== 'https://api.deepseek.com/chat/completions') return new Response('{}', { status: 503 });
    const body = JSON.parse(options.body);
    let rules = []; try { rules = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch {}
    const plan = planReply(body, Array.isArray(rules) ? rules : []);
    const entry = { at: Date.now(), stream: plan.stream, userText: plan.userText, system: plan.system, context: plan.context, rest: plan.rest, notes: plan.notes, turns: plan.turns, hashes: plan.hashes, afterTool: plan.afterTool, ...(plan.afterTool ? { toolResult: plan.toolResult } : {}), ...(plan.consolidation ? { consolidation: true, maintenance: plan.maintenance } : {}), answer: plan.kind === 'tool' ? { tool: plan.call } : { text: plan.text }, usage: plan.usage };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return new Response(renderReply(plan), { status: 200, headers: { 'content-type': plan.stream ? 'text/event-stream' : 'application/json' } });
  };
}

async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
  for (const key of ['release', 'config', 'script', 'log']) if (typeof args[key] !== 'string' || !path.isAbsolute(args[key])) throw new Error('Expected --release --config --script --log (absolute paths)');
  // Only ever a staging data root: this launcher must not be pointed at production state.
  if (![args.config, args.script, args.log].every(file => file.split(path.sep).includes('companion-staging'))) throw new Error('Refusing a path outside companion-staging');
  process.umask(0o077);
  const stat = fs.lstatSync(args.config);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe gateway launch configuration');
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const release = fs.realpathSync(args.release);
  const { createModelGateway } = await import(pathToFileURL(path.join(release, 'model-gateway/server.mjs')).href);
  const { AuthorityClient } = await import(pathToFileURL(path.join(release, 'authority/src/client.js')).href);
  const authority = new AuthorityClient(config.authority);
  const gateway = createModelGateway({ ...config, worldStatus: async () => (await authority.health()).world, fetchImpl: createFakeUpstream({ scriptFile: args.script, logFile: args.log }) });
  await gateway.start();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (stopping) return; stopping = true; void gateway.close().catch(() => { process.exitCode = 1; }); });
  process.stdout.write('Model gateway ready with the scripted staging upstream (no provider).\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write('Staging model gateway failed: ' + error.message + '\n'); process.exitCode = 1; });
}
