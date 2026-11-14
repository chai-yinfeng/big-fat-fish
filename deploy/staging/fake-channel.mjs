#!/usr/bin/env node
// Staging-only second channel: the bridge of the test-only MOCK channel (capabilities/channels/mock). It is a
// text-only channel that is not QQ and whose receipts are not reliable. It goes through the same doors as the QQ
// bridge and nothing else: Authority's capability API with its own credential (capability `mock`) and a conversation
// executor's /execute. Never part of a release or a production unit: Authority refuses to start with a `mock`
// capability configured unless its private configuration sets operator.allowTestChannels, which only staging does.
//   node fake-channel.mjs --release <release dir> --control <socket> --authority-socket <socket> --authority-token-file <file>
//        --executor-config <conversation config of this channel> --caller-token-file <file> [--poll-ms 3000]
// The release's own conversation executor is started here as a child with that config: a channel's executor holds
// that channel's credential only, so this one can reach no QQ conversation.
// An account is a MOCK-<NAME>; its actor is `mock:user:<account>` and its conversation `mock:private:<account>`.
// Control (HTTP on the Unix socket):
//   GET  /state                      -> { sent, lost, friends, turns }   (sent: [{ message_id, account, text, at }])
//   POST /friends { friends: [account] }
//   POST /message { account, text }  -> { event_id }   (a private message; only a friend is admitted and answered)
//   POST /lose-receipts { count }    -> the next `count` sends get no receipt: recorded in `lost`, the turn ends as
//                                       `unknown`, and nothing is sent again
//   POST /reset                      -> forgets recorded sends and pending lost receipts
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHANNEL = 'mock';
const ACCOUNT = /^MOCK-[A-Z0-9-]{1,24}$/;
// What she is told in place of a message in a run she starts herself (the QQ bridge says the same).
const PROACTIVE_EVENT = '现在没有人给你发消息。你可以主动找对方说一两句：想到什么、想问什么都行，照你平时的样子，简短一点。';
export const actorOf = account => `${CHANNEL}:user:${account}`, streamOf = account => `${CHANNEL}:private:${account}`;

/** The bridge itself. `authority` is an AuthorityClient holding the `mock` capability credential, `executor` a
 * conversation client; `executeConversation` and `declineMark` come from the release under test. */
export function createFakeChannel({ authority, executor, executeConversation, declineMark, controlSocket, pollMs = 3000 }) {
  if (!path.isAbsolute(controlSocket) || !Number.isInteger(pollMs) || pollMs < 200) throw new Error('FAKE_CHANNEL_CONFIG');
  const declined = new RegExp(`[<＜]\\s*${declineMark.slice(1, -1)}\\s*[>＞]`, 'u');
  const sent = [], lost = [], turns = [], friends = new Set(), admitted = new Set(), tails = new Map(), initiated = new Set();
  let losing = 0, sequence = 0, timer = null, polling = false;
  const run = (account, job) => { const tail = (tails.get(account) ?? Promise.resolve()).then(job).catch(() => {}); tails.set(account, tail); return tail; };
  /** One send. The receipt is all this channel knows: without one the message may or may not have gone out, so it
   * is `unknown`, it is not recorded as hers and it is never sent again. */
  async function deliver(account, text) {
    if (losing > 0) { losing--; lost.push({ account, text, at: Date.now() }); return 'unknown'; }
    const message_id = `${Date.now().toString(36)}${++sequence}`;
    sent.push({ message_id, account, text, at: Date.now() });
    await authority.observe({ eventId: `${CHANNEL}:sent:${message_id}`, streamId: streamOf(account), actorId: `${CHANNEL}:model`, role: 'assistant', text, at: Date.now() }).catch(() => {});
    return 'sent';
  }
  async function turn(account, text, turnRecord) {
    const end = status => { turnRecord.status = status; };
    try {
      if (!friends.has(account)) return end('ignored');
      if ((await authority.health()).world.paused) return end('paused');
      // Idempotent: an account the operator attached to a known person is that person already.
      if (!admitted.has(account)) { await authority.admitPerson({ uid: account, actorId: actorOf(account), streamId: streamOf(account) }); admitted.add(account); }
      const streamId = streamOf(account), eventId = `${CHANNEL}:msg:${randomBytes(8).toString('hex')}`;
      const scope = await authority.context({ streamId, query: text.slice(0, 512), budgetChars: 1 });
      const observed = await authority.observe({ eventId, streamId, actorId: actorOf(account), role: 'user', text, at: Date.now() });
      const reply = await executeConversation(executor, { scope: { streamId, memoryEpoch: scope.memoryEpoch }, requestId: eventId, input: { text, queryText: text.slice(0, 512), evidence: [{ ref: observed.observationId, eventId, role: 'user' }] } });
      end(await deliver(account, reply));
    } catch (error) { end(error?.code === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'failed'); }
  }
  /** One round: ask Authority for a run she starts herself on this channel, run it, report once. */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const { initiation } = await authority.initiationNext();
      if (!initiation || initiated.has(initiation.id)) return;
      initiated.add(initiation.id);
      const account = typeof initiation.streamId === 'string' && initiation.streamId.startsWith(`${CHANNEL}:private:`) ? initiation.streamId.slice(`${CHANNEL}:private:`.length) : '';
      let outcome;
      if (initiation.kind !== 'proactive') outcome = 'dropped:unsupported';
      else if (!ACCOUNT.test(account)) outcome = 'dropped:target';
      else outcome = await run(account, async () => {
        try {
          const reply = await executeConversation(executor, { scope: { streamId: initiation.streamId, memoryEpoch: initiation.memoryEpoch }, requestId: `${CHANNEL}:init:${initiation.id}`, input: { text: PROACTIVE_EVENT, initiated: true } });
          return declined.test(reply) ? 'declined' : await deliver(account, reply);
        } catch (error) { return error?.code === 'BUDGET_EXHAUSTED' ? 'deferred:budget' : error?.code === 'WORLD_PAUSED' ? 'dropped:paused' : 'failed'; }
      }).then(value => value ?? 'failed');
      await authority.initiationAck({ id: initiation.id, outcome });
    } catch {} finally { polling = false; }
  }
  const control = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && req.url === '/state') { send(200, { ok: true, value: { sent, lost, friends: [...friends], turns } }); return; }
      if (req.method !== 'POST') { send(404, { ok: false }); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.url === '/reset') { sent.length = 0; lost.length = 0; turns.length = 0; losing = 0; send(200, { ok: true, value: {} }); return; }
      if (req.url === '/lose-receipts') {
        if (!Number.isInteger(body.count) || body.count < 0 || body.count > 20) throw new Error('LOSE');
        losing = body.count; send(200, { ok: true, value: { losing } }); return;
      }
      if (req.url === '/friends') {
        if (!Array.isArray(body.friends) || body.friends.some(account => typeof account !== 'string' || !ACCOUNT.test(account))) throw new Error('FRIENDS');
        friends.clear(); for (const account of body.friends) friends.add(account);
        send(200, { ok: true, value: { friends: friends.size } }); return;
      }
      if (req.url === '/message') {
        if (typeof body.account !== 'string' || !ACCOUNT.test(body.account) || typeof body.text !== 'string' || !body.text || body.text.length > 8000) throw new Error('MESSAGE');
        const record = { account: body.account, status: 'queued', at: Date.now() }; turns.push(record);
        void run(body.account, () => turn(body.account, body.text, record));
        send(200, { ok: true, value: { queued: true } }); return;
      }
      send(404, { ok: false });
    } catch { send(400, { ok: false, error: 'INVALID_REQUEST' }); }
  });
  return {
    sent, lost, turns, poll,
    async start() {
      fs.mkdirSync(path.dirname(controlSocket), { recursive: true, mode: 0o700 });
      fs.rmSync(controlSocket, { force: true });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlSocket, resolve); });
      fs.chmodSync(controlSocket, 0o600);
      timer = setInterval(() => { void poll(); }, pollMs); timer.unref();
    },
    async close() {
      clearInterval(timer);
      control.closeAllConnections(); await new Promise(resolve => control.close(resolve));
      fs.rmSync(controlSocket, { force: true });
    },
  };
}

/** The conversation executor of the release (bundled) or of a checkout, as the entry file to run. */
export function executorEntry(release) {
  const bundled = path.join(release, 'capabilities/conversation/conversation.mjs');
  return fs.existsSync(bundled) ? bundled : path.join(release, 'capabilities/conversation/main.mjs');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
  process.umask(0o077);
  const release = path.resolve(args.release), load = file => import(pathToFileURL(path.join(release, file)).href);
  let child = null;
  const stop = code => { child?.kill('SIGTERM'); process.exit(code); };
  (async () => {
    const [{ AuthorityClient }, { createConversationClient }, { executeConversation, DECLINE_MARK }] = await Promise.all([load('authority/src/client.js'), load('capabilities/conversation/client.js'), load('capabilities/conversation/executor.js')]);
    const executorConfig = JSON.parse(fs.readFileSync(args['executor-config'], 'utf8'));
    child = spawn(process.execPath, [executorEntry(release), '--config', args['executor-config']], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('exit', code => { process.stderr.write(`fake channel: its conversation executor exited (${code})\n`); process.exit(1); });
    for (let i = 0; !fs.existsSync(executorConfig.socketPath); i++) { if (i > 300) throw new Error('EXECUTOR_START'); await new Promise(resolve => setTimeout(resolve, 50)); }
    const fake = createFakeChannel({
      authority: new AuthorityClient({ socketPath: args['authority-socket'], tokenFile: args['authority-token-file'] }),
      executor: createConversationClient({ socketPath: executorConfig.socketPath, tokenFile: args['caller-token-file'] }),
      executeConversation, declineMark: DECLINE_MARK, controlSocket: args.control, ...(args['poll-ms'] ? { pollMs: Number(args['poll-ms']) } : {}),
    });
    await fake.start();
    process.stdout.write('fake channel ready\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void fake.close().then(() => stop(0)); });
  })().catch(error => { process.stderr.write('fake channel failed: ' + (error.code || error.message) + '\n'); stop(1); });
}
