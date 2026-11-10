#!/usr/bin/env node
// Development-only measurement of DeepSeek prompt-cache hits for the conversation executor.
// Never part of a release or a production unit. In one process it runs the repo's real
// createModelGateway (real fetch to DeepSeek) and the real createConversationExecutor against
// a stub Authority (fixed MOCK persona and memories; revision and world time change on every
// call, as in production), replays a fixed scripted chat and records the usage of every
// upstream request.
//   node scripts/prompt-cache-bench.mjs --key-file <file> [--label <name>] [--thinking high|low|max|disabled]
//        [--turns <n>] [--budget-yuan <n>] [--pause-ms <n>] [--state-dir <dir>] [--model deepseek-flash]
// The key file (or $BENCH_DEEPSEEK_KEY_FILE) holds the bare API key with mode 600. The key is
// never printed or written to a result. The gateway's settings file (which must hold the key)
// lives in the state directory outside the repo and is removed when the run ends. The spend
// state stays in that directory, so every run of a day shares the gateway's daily cap (¥2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModelGateway, MODELS } from '../model-gateway/server.mjs';
import { DEFAULT_PRICING, beijingDay, isPeak, parseUsage, usageCost } from '../model-gateway/spend.mjs';
import { createGatewayStream } from '../capabilities/conversation/model.js';
import { createConversationExecutor } from '../capabilities/conversation/agent.js';
import { SessionStore } from '../capabilities/conversation/sessions.js';
import { renderContextParts } from '../authority/src/context.js';
import { DEFAULT_PERSONA } from '../core/src/persona.js';
import { tokenize } from '../core/src/util.js';

export const DAILY_CAP_YUAN = 2;
export const THINKING_LEVELS = Object.freeze(['high', 'low', 'max', 'disabled']);
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.config', 'big-fat-fish-dev', 'bench-state');
const STREAM = 'qq:999900000001:private:999900000011', ACTOR = 'qq:999900000001:user:999900000011', PERSON = 'person:qq:999900000011';

/** The scripted chat (MOCK-A talking). Turns 4 and 7 invite a tool call. */
export const TURNS = Object.freeze([
  '在吗？刚下班到家，累瘫了。',
  '今天又被 MOCK-LI 拉去开了三个小时的会，啥也没定下来。',
  '不说工作了。我家煤球今天把我的耳机线咬断了，气死我了。',
  '对了，帮我记一下：我下周三晚上要和 MOCK-WANG 去看演唱会。',
  '你觉得我晚饭吃啥好？冰箱里只有鸡蛋和西红柿。',
  '哈哈行，那就西红柿炒蛋。你上次说你搬家了，新主机住得惯吗？',
  '我之前是不是跟你说过我妹妹的事？你翻翻记忆，她是做什么工作的来着？',
  '嗯对。周末想带煤球去打疫苗，但是它一进猫包就嚎，有什么办法吗？',
  '好，我试试。困了，先去洗澡，晚安～',
]);

/** About 1600 characters once rendered, like a filled-in production persona. `salt` keeps runs from sharing a cached prefix. */
export function mockPersona(salt) {
  return {
    ...DEFAULT_PERSONA,
    identity: `${DEFAULT_PERSONA.identity}（MOCK 测试人格 ${salt}）`,
    principles: [...DEFAULT_PERSONA.principles,
      '聊到 MOCK 家里的人时，只说自己确实记得的，不替别人编故事',
      '对方只是想吐槽的时候，先陪着吐槽，等对方问了再给办法',
      '晚上聊天语气放松一点，对方说困了就痛快放人去睡',
      '被问到记不清的旧事，可以翻一翻记忆再回答，翻不到就照实说'],
    examples: [...DEFAULT_PERSONA.examples,
      { user: 'MOCK：今天老板又拖会。', assistant: '又来？这回拖了多久……先喝口水缓缓。' },
      { user: 'MOCK：猫又闯祸了。', assistant: '哈哈哈它这回干了啥，快讲讲。' },
      { user: 'MOCK：帮我记个事。', assistant: '说吧，我记着。' },
      { user: 'MOCK：周末不知道干嘛。', assistant: '想出门还是想瘫着？我两种方案都能陪你想。' },
      { user: 'MOCK：你还记得我上次说的吗？', assistant: '我想想……要是记岔了你纠正我啊。' },
      { user: 'MOCK：我有点焦虑。', assistant: '嗯，我在。是因为工作上的事，还是别的？慢慢说。' }],
  };
}

/** Realistic MOCK memories in the shape Authority hands to its context renderer. */
export function mockMemories() {
  const base = Date.parse('2026-10-20T12:00:00Z');
  const evidence = (n, quote) => ({ observationId: `obs-mock-${String(n).padStart(4, '0')}-7f3a9c2e51d84b6a`, quote, role: 'user', actorId: ACTOR, streamId: STREAM, at: base + n * 3600000 * 7 });
  const fact = (n, key, value, quote) => ({ id: `mem-mock-${n}`, type: 'facts', attribution: 'reported', personId: PERSON, key, value, policy: 'conversation.v1', evidence: evidence(n, quote) });
  const experience = (n, summary, quote) => ({ id: `mem-mock-${n}`, type: 'experiences', personId: PERSON, summary, policy: 'conversation.v1', evidence: evidence(n, quote) });
  const note = (n, kind, text, quote) => ({ id: `mem-mock-${n}`, type: 'notes', personId: PERSON, kind, text, policy: 'conversation.v1', evidence: evidence(n, quote) });
  return [
    fact(1, '猫的名字', '煤球，一只三岁的黑猫', '我家猫叫煤球，三岁了，是只黑猫'),
    fact(2, '妹妹', 'MOCK-MEI，在医院做护士，经常上夜班', '我妹妹 MOCK-MEI 在医院做护士，经常上夜班'),
    fact(3, '工作', '在一家做物流软件的公司做测试', '我在一家做物流软件的公司做测试'),
    fact(4, '喜欢的食物', '西红柿炒蛋和螺蛳粉', '我最喜欢吃西红柿炒蛋和螺蛳粉'),
    fact(5, '生日', '3 月 12 日', '我生日是 3 月 12 日'),
    fact(6, '住的城市', '杭州，租的房子在地铁站旁边', '我住杭州，租的房子就在地铁站旁边'),
    fact(7, '过敏', '对芒果过敏，吃了嘴会肿', '我对芒果过敏，吃了嘴会肿'),
    fact(8, '老板', 'MOCK-LI，喜欢开很长的会', '我老板 MOCK-LI 特别喜欢开很长的会'),
    experience(9, 'MOCK-A 说上周带煤球去宠物医院体检，医生说它有点超重，要少喂零食', '上周带煤球去体检，医生说有点超重，让我少喂零食'),
    experience(10, 'MOCK-A 加班到很晚，说项目要赶在月底上线，这周几乎没有按时下班', '这周天天加班，项目月底要上线'),
    experience(11, 'MOCK-A 提到想学吉他，已经买了一把入门琴，但一直没时间练', '我买了把入门吉他，就是一直没空练'),
    experience(12, 'MOCK-A 和朋友 MOCK-WANG 约了一起去看演唱会，她很期待', '我和 MOCK-WANG 约了去看演唱会，超期待'),
    note(13, 'learning', '和 MOCK-A 聊天时，她累的时候更想被接话，不想马上听建议', '今天好累，别给我讲道理'),
    note(14, 'outer', '我最近从旧虚拟机搬到了新主机，MOCK-A 问过我住得惯不惯', '你搬家了？新主机住得惯吗'),
  ];
}

/** Authority stand-in. Like production, the revision and the world time differ on every call. */
export function createAuthorityStub({ salt, clock = Date.now }) {
  const persona = mockPersona(salt), memories = mockMemories();
  const tokens = memories.map(entry => new Set(tokenize([entry.key, entry.value, entry.summary, entry.text].filter(Boolean).join(' '))));
  let revision = 100;
  const ranked = query => {
    const wanted = [...new Set(tokenize(query))];
    return memories.map((entry, index) => ({ entry, hits: wanted.filter(token => tokens[index].has(token)).length }))
      .filter(item => item.hits > 0).sort((a, b) => b.hits - a.hits).map(item => item.entry);
  };
  const excerpt = entry => [entry.key, entry.value, entry.summary, entry.text].filter(Boolean).join(' ');
  return {
    async context({ query = '', budgetChars = 4000 }) {
      revision += 1;
      return { revision, entityId: 'entity:mock-bench', memoryEpoch: 0, personaRevision: 2, ...renderContextParts(persona, ranked(query), budgetChars), scope: { audience: 'private' }, world: { paused: false, revision: 1, worldNow: clock() } };
    },
    async memorySearch({ query, limit = 4 }) { const items = ranked(query).slice(0, limit).map(entry => ({ id: entry.id, type: entry.type, excerpt: excerpt(entry) })); return { items, text: items.map(item => JSON.stringify({ id: item.id, text: item.excerpt })).join('\n') }; },
    async memoryRead({ id }) { const entry = memories.find(item => item.id === id); if (!entry) throw Object.assign(new Error('NOT_FOUND'), { status: 404 }); return { id, type: entry.type, text: excerpt(entry) }; },
    async memoryRecall() { return { items: [], text: '' }; },
    async submit({ proposalId }) { revision += 1; return { proposalId, status: 'pending' }; },
    async getReceipt() { throw Object.assign(new Error('NOT_FOUND'), { status: 404 }); },
  };
}

/** The bare key from a private file. Throws without ever echoing file contents. */
export function readKey(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.mode & 0o077) throw new Error('The key file must be a regular file with mode 600');
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw new Error('The key file does not hold one bare key');
  return key;
}

/** Rewrites only the thinking parameters of the body the gateway sends upstream (the gateway forces high). */
export function withThinking(body, level) {
  if (level === 'disabled') { const { reasoning_effort: _dropped, ...rest } = body; return { ...rest, thinking: { type: 'disabled' } }; }
  return { ...body, thinking: { type: 'enabled' }, reasoning_effort: level };
}

const sharedPrefix = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++; return i; };
/** Reads a streamed (or JSON) body for its last usage object; whatever arrived before an abort still counts. */
async function usageOf(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', found = null;
  const scan = line => {
    if (!line.includes('"usage"')) return;
    try { const value = JSON.parse(line.startsWith('data:') ? line.slice(5) : line); if (value?.usage && typeof value.usage === 'object') found = { usage: value.usage, model: value.model }; } catch {}
  };
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index; while ((index = buffer.indexOf('\n')) >= 0) { scan(buffer.slice(0, index).trim()); buffer = buffer.slice(index + 1); }
    }
  } catch {}
  scan(buffer.trim());
  return found;
}

/** fetch wrapper for the gateway: applies the thinking level and reports one record per upstream request. */
export function measuringFetch({ level, onRequest, fetchImpl = fetch, clock = Date.now }) {
  let previous = '';
  return async (url, options = {}) => {
    const body = withThinking(JSON.parse(options.body), level), at = clock();
    const prompt = JSON.stringify([body.tools ?? [], body.messages ?? []]);
    const shared = sharedPrefix(previous, prompt); previous = prompt;
    const response = await fetchImpl(url, { ...options, body: JSON.stringify(body) });
    const record = { at, status: response.status, model: body.model, thinking: body.thinking?.type === 'disabled' ? 'disabled' : body.reasoning_effort, messages: body.messages?.length ?? 0, promptChars: prompt.length, sharedPrefixChars: shared };
    onRequest(record);
    if (!response.ok) { record.ms = clock() - at; return response; }
    // The gateway streams the original body on (and aborts it once its caller hangs up); the clone is only
    // read for its usage line. `ms` marks the record complete.
    void usageOf(response.clone()).then(reported => {
      const parsed = reported && parseUsage(reported.usage);
      if (parsed) Object.assign(record, { promptTokens: parsed.cacheHit + parsed.cacheMiss, cacheHitTokens: parsed.cacheHit, cacheMissTokens: parsed.cacheMiss, completionTokens: parsed.output, reasoningTokens: parsed.reasoning, costYuan: usageCost(DEFAULT_PRICING, body.model, parsed, at) / 1e6, upstreamModel: reported.model });
    }).finally(() => { record.ms = clock() - at; });
    return response;
  };
}

function spendState(stateDir, clock) {
  try { const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'spend.json'), 'utf8')); return state.day === beijingDay(clock()) ? state : { spentMicros: 0, reservedMicros: 0 }; }
  catch (error) { if (error.code === 'ENOENT') return { spentMicros: 0, reservedMicros: 0 }; throw error; }
}
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const percent = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 : 0;
function totals(requests) {
  const prompt = sum(requests, 'promptTokens'), hit = sum(requests, 'cacheHitTokens'), completion = sum(requests, 'completionTokens'), reasoning = sum(requests, 'reasoningTokens');
  return { requestCount: requests.length, promptTokens: prompt, cacheHitTokens: hit, cacheMissTokens: sum(requests, 'cacheMissTokens'), hitPercent: percent(hit, prompt), completionTokens: completion, reasoningTokens: reasoning, reasoningPercentOfOutput: percent(reasoning, completion), costYuan: Math.round(sum(requests, 'costYuan') * 1e6) / 1e6 };
}

/**
 * One replay. Returns the result object (no key, no prompt text). `fetchImpl` is the upstream
 * transport (the real fetch unless a test injects one).
 */
export async function runBench({ keyFile, stateDir = DEFAULT_STATE_DIR, label = 'run', thinking = 'high', turns = TURNS.length, budgetYuan = 1.5, pauseMs = 3000, model = MODELS[0], fetchImpl = fetch, clock = Date.now, log = () => {} }) {
  if (!THINKING_LEVELS.includes(thinking) || !MODELS.includes(model) || !Number.isInteger(turns) || turns < 1 || turns > TURNS.length || !(budgetYuan > 0) || budgetYuan > DAILY_CAP_YUAN) throw new Error('Invalid bench options');
  const apiKey = readKey(keyFile);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const settingsFile = path.join(stateDir, 'model-settings.json');
  // Short base: Unix socket paths are limited to ~104 bytes on macOS.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), 'fish-bench-')));
  const token = randomBytes(32).toString('base64url'), tokenFile = path.join(temp, 'gateway.token');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const result = { label, startedAt: new Date(clock()).toISOString(), model, thinking, priceWindow: isPeak(DEFAULT_PRICING, clock()) ? 'peak' : 'offPeak', prices: DEFAULT_PRICING.models[model], dailyCapYuan: DAILY_CAP_YUAN, budgetYuan, turns: [], stopped: null };
  let gateway, current = null;
  try {
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    fs.rmSync(settingsFile, { force: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ model, apiKey }), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(stateDir, 'spend-settings.json'), JSON.stringify({ dailyCapYuan: DAILY_CAP_YUAN, reducedPercent: 60, restrictedPercent: 80 }), { mode: 0o600 });
    gateway = createModelGateway({
      settingsFile, inferenceSocket: path.join(temp, 'inference.sock'), controlSocket: path.join(temp, 'control.sock'),
      inferenceTokenHash: hash(token), operatorTokenHash: hash(randomBytes(32).toString('base64url')), worldStatus: async () => ({ paused: false }), clock,
      fetchImpl: measuringFetch({ level: thinking, fetchImpl, clock, onRequest: record => { current?.requests.push(record); } }),
    });
    await gateway.start();
    const { model: gatewayModel, streamFn } = createGatewayStream({ socketPath: path.join(temp, 'inference.sock'), tokenFile });
    const sessions = path.join(temp, 'sessions');
    const executor = createConversationExecutor({ authority: createAuthorityStub({ salt: randomBytes(6).toString('hex'), clock }), store: new SessionStore(sessions), model: gatewayModel, streamFn });
    for (let index = 0; index < turns; index++) {
      const before = spendState(stateDir, clock);
      if (before.spentMicros / 1e6 >= budgetYuan) { result.stopped = `today's spend reached the bench budget of ¥${budgetYuan} before turn ${index + 1}`; break; }
      current = { turn: index + 1, input: TURNS[index], requests: [] };
      const started = clock();
      try {
        const reply = await executor.execute({ scope: { streamId: STREAM, memoryEpoch: 0 }, requestId: `bench-${label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${index + 1}`, input: { text: TURNS[index], evidence: [{ ref: `obs-bench-${index + 1}`, eventId: `bench:message:${index + 1}`, role: 'user' }] }, timeoutMs: 300000 });
        current.replyChars = reply.length;
      } catch (error) { current.error = typeof error?.code === 'string' ? error.code : 'FAILED'; }
      // The gateway settles its reservation just after the response ends.
      let after = spendState(stateDir, clock);
      for (let i = 0; i < 40 && (after.reservedMicros > 0 || current.requests.some(row => row.ms === undefined)); i++) { await new Promise(resolve => setTimeout(resolve, 50)); after = spendState(stateDir, clock); }
      Object.assign(current, { ms: clock() - started, spendYuan: (after.spentMicros - before.spentMicros) / 1e6, ...totals(current.requests) });
      result.turns.push(current);
      log(`turn ${current.turn}: ${current.requests.length} request(s), hit ${current.cacheHitTokens}/${current.promptTokens} prompt tokens${current.error ? ', ' + current.error : ''}`);
      if (current.error) { result.stopped = `turn ${current.turn} failed with ${current.error}`; break; }
      if (index + 1 < turns && pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
    current = null;
    // History the executor persisted, measured the way the active window counts it.
    result.sessionChars = fs.readdirSync(sessions).reduce((total, name) => total + fs.readFileSync(path.join(sessions, name), 'utf8').length, 0);
  } finally {
    await gateway?.close().catch(() => {});
    fs.rmSync(settingsFile, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const requests = result.turns.flatMap(turn => turn.requests);
  result.total = { ...totals(requests), spendYuan: Math.round(sum(result.turns, 'spendYuan') * 1e6) / 1e6 };
  // Turn 1 always starts cold (fresh salt): the steady state is everything after it.
  result.afterFirstTurn = totals(result.turns.slice(1).flatMap(turn => turn.requests));
  result.spentTodayYuan = spendState(stateDir, clock).spentMicros / 1e6;
  return result;
}

/** Readable per-request table plus totals. */
export function formatResult(result) {
  const cell = (value, width) => String(value ?? '-').padStart(width);
  const lines = [`${result.label}: model ${result.model}, thinking ${result.thinking}, ${result.priceWindow} prices ${JSON.stringify(result.prices[result.priceWindow])} CNY per 1M tokens`,
    'turn req  prompt     hit    miss  hit%  output  reason  shared%  cost(¥)'];
  for (const turn of result.turns) {
    turn.requests.forEach((row, i) => lines.push([cell(turn.turn, 4), cell(i + 1, 3), cell(row.promptTokens, 7), cell(row.cacheHitTokens, 7), cell(row.cacheMissTokens, 7), cell(percent(row.cacheHitTokens ?? 0, row.promptTokens), 5), cell(row.completionTokens, 7), cell(row.reasoningTokens, 7), cell(percent(row.sharedPrefixChars, row.promptChars), 8), cell(row.costYuan?.toFixed(5), 8)].join(' ')));
    lines.push(`     = turn ${turn.turn}: gateway spend ¥${turn.spendYuan.toFixed(5)}, ${turn.ms} ms${turn.error ? ', ' + turn.error : ''}`);
  }
  const line = (name, t) => `${name}: ${t.requestCount} requests, prompt ${t.promptTokens} (hit ${t.cacheHitTokens} = ${t.hitPercent}%), output ${t.completionTokens} (reasoning ${t.reasoningTokens} = ${t.reasoningPercentOfOutput}%), ¥${t.costYuan}`;
  lines.push(line('total', result.total), line('after turn 1', result.afterFirstTurn), `gateway spend this run ¥${result.total.spendYuan}; today ¥${result.spentTodayYuan} of the ¥${result.dailyCapYuan} cap${result.stopped ? '; STOPPED: ' + result.stopped : ''}`);
  return lines.join('\n');
}

async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
  const keyFile = args['key-file'] ?? process.env.BENCH_DEEPSEEK_KEY_FILE;
  if (!keyFile || !fs.existsSync(keyFile)) { console.log('prompt-cache-bench: no key file (--key-file or $BENCH_DEEPSEEK_KEY_FILE); skipped.'); return 0; }
  const stateDir = args['state-dir'] ?? DEFAULT_STATE_DIR, label = args.label ?? 'run';
  const result = await runBench({
    keyFile: path.resolve(keyFile), stateDir: path.resolve(stateDir), label, thinking: args.thinking ?? 'high', model: args.model ?? MODELS[0],
    ...(args.turns ? { turns: Number(args.turns) } : {}), ...(args['budget-yuan'] ? { budgetYuan: Number(args['budget-yuan']) } : {}), ...(args['pause-ms'] ? { pauseMs: Number(args['pause-ms']) } : {}),
    log: line => console.log(line),
  });
  const out = path.join(path.resolve(stateDir), 'results');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, `${label.replace(/[^A-Za-z0-9_.-]/g, '_')}-${result.startedAt.replace(/[:.]/g, '')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(formatResult(result));
  console.log('result: ' + file);
  return result.stopped ? 2 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error('prompt-cache-bench: ' + error.message); process.exitCode = 1; });
}
