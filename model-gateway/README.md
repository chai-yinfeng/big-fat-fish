# Private model gateway

Node 24, standard library only. The network-capable host gateway owns the real
DeepSeek credential. The conversation executor (and the content/memory workers)
get only an opaque inference token and the inference socket; it must not see the settings file, launch configuration,
operator credential, control socket, or Authority credential.

```sh
node model-gateway/main.mjs --config /absolute/private/model-gateway.json
node --test model-gateway/server.test.mjs
```

The launch JSON must be an owner-only regular file (0600), never environment
variables containing the provider key:

```json
{
  "settingsFile": "/absolute/private/model-settings.json",
  "inferenceSocket": "/absolute/private/inference.sock",
  "controlSocket": "/absolute/private/control.sock",
  "inferenceTokenHash": "<sha256 lowercase hex of opaque inference token>",
  "operatorTokenHash": "<sha256 lowercase hex of existing console token>",
  "authority": {
    "socketPath": "/absolute/authority/api.sock",
    "tokenFile": "/absolute/private/health.token"
  }
}
```

All three gateway paths must be absolute and distinct; hashes must be distinct
64-character lowercase SHA-256 hex values. `authority.tokenFile` is the existing
health-only `health` capability (policy `learning.v1`, no actor or stream binding), not admin. Main calls only
`new AuthorityClient({socketPath, tokenFile}).health()` and supplies its `.world`
to the gateway. Health failure fails inference/settings updates closed.

Sockets are 0600; parent directories must be owned by the gateway UID and not
writable by group/other. Provision appropriate same-UID service ownership and
role-specific mounts; do not chmod sockets public. Existing non-socket targets
and live sockets are refused. Dead sockets are recovered only after an inode
check. Deployment runs one controller via systemd and the live Unix socket
ownership check; there is no extra PID/lock-file mechanism. Settings use 0600
exclusive temporary files, fsync, and atomic replacement. SIGINT/SIGTERM abort
active upstream requests and close both servers.

## API

`server.mjs` exports `MODELS` and
`createModelGateway({ settingsFile, inferenceSocket, controlSocket,
inferenceTokenHash, operatorTokenHash, worldStatus, fetchImpl = fetch,
upstream = 'https://api.deepseek.com/chat/completions' })`, returning async
`start()` and `close()`. `worldStatus()` must resolve `{paused: boolean}`.
Only trusted embedding code may override fetch/upstream; main exposes neither.
`main.mjs` also exports `main(args)` for embedding.

Control socket uses `Authorization: Bearer <console token>`:

- `GET /model`: `{ok:true,value:{provider:'deepseek',model,configured,status,lastTest?}}`.
  Status is `unconfigured`, `configured`, `verified`, or `error`. No credential
  fragments or key length are exposed.
- `POST /model {model,apiKey?}`: models are exactly `deepseek-flash` and
  `deepseek-v4-pro`. Blank/omitted key retains the current key; first configuration
  requires a nonblank key. Only while the world is paused, with no active
  inference; otherwise 409. Changes reset test status to `configured`.
- `POST /model/test {}`: explicit, potentially billable fixed 16-output-token
  connectivity probe, with no persona/world/prompt data. Allowed while paused.
  Returns `{ok:true,value:{ok,code?,model}}`; records sanitized `lastTest` using
  Unix milliseconds. HTTP success with invalid JSON/choices fails the probe.
- `POST /cancel {}`: abort every active inference/probe for maintenance. A
  concurrent probe may settle with `CANCELLED`; cancellation is not verification.

Inference socket uses `Authorization: Bearer <opaque inference token>` and only
`POST /v1/chat/completions`. The worker sends model `deepseek`; gateway rewrites
it to the configured real model, forces `thinking.type=enabled` and
`reasoning_effort=high`, and clamps/defaults `max_tokens` to 4096. A paused world
returns 409 and unconfigured running world 503, without calling the provider.
The gateway rechecks world state immediately before upstream fetch. The bounded
JSON body otherwise retains messages, `reasoning_content`, tools and tool IDs.
Successful upstream body bytes pass through unchanged (including SSE), without
forwarding upstream headers. Client disconnection aborts upstream. Requests use
redirect rejection and bounded deadlines. Failures expose only fixed safe
codes/messages, never upstream error text or headers. No prompt/response/key logs.

For model changes, pause the world, drain/stop the worker tool loop, call `/cancel`,
then update settings and start a new conversation as appropriate before resuming.
The gateway cannot infer a conversation boundary from individual HTTP requests.
Changing the console setting does not require a gateway/worker restart. The
executor's model metadata must remain valid for both selectable models.

The conversation executor (`capabilities/conversation/model.js`) defines a pi-ai
provider `companion`, model `deepseek`, API `openai-completions` with explicit
DeepSeek compat (`thinkingFormat: deepseek`, replayed `reasoning_content`,
`max_tokens`), and reaches only `inference.sock` through a Unix-socket fetch; it
has no TCP network access.

## Daily spend cap

The gateway meters money per Beijing day (Asia/Shanghai, independent of the host
TZ) in three private files next to the settings file: `spend.json` (state),
`spend-settings.json` (cap and tiers) and `model-pricing.json` (price table).

- Prices: written on first start with DeepSeek's official table verified on
  2026-11-08 (api-docs.deepseek.com/zh-cn/quick_start/pricing): flash 0.04/2/8 CNY
  per 1M tokens (cache hit / miss / output) at peak, half off-peak; v4-pro
  0.30/9/27 peak, half off-peak; web search/fetch 0.005 per call; vision is a
  conservative 0.01 per call. Peak is Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing
  time. Chinese statutory holidays are off-peak all day: the 2026 and 2027 dates from
  the State Council notices are built in (`CN_HOLIDAYS` in `spend.mjs`) and are added
  to whatever `peak.offPeakDates` lists, also for a file written before they existed;
  a year without data gets no holiday discount. The file is
  re-read before every reservation; an invalid file falls back to peak prices at
  every hour (`pricing: 'fallback'`).
- Chat requests are forced to `stream_options.include_usage`; usage (cache hit,
  miss, output including reasoning) is read from the SSE stream as a side channel
  while bytes pass through unchanged. Each call reserves an estimate (prompt
  characters at the miss price plus max output) and settles to the reported usage;
  no usage charges the reservation; a provider error releases it; a reservation
  held across a restart is charged.
- Tiers (defaults 60/80/100 of a ¥5 cap): ≥reduced refuses the chat completions of a run she starts herself (category `proactive`: a
  `/v1/chat/completions` request with the header `x-companion-run: initiated`, set only by the conversation executor),
  ≥restricted refuses `/v1/memory/completions`, vision and web, ≥100% refuses every
  call with 429 `BUDGET_EXHAUSTED` before contacting the provider. A vision/web call
  refused by the spend tier answers 429 `SPEND_RESTRICTED` (the daily call count stays
  `BUDGET_EXHAUSTED`); QQ then stays silent instead of sending the attachment notice. The cap includes
  the owner's own chats.
- Control socket: `GET /spend` → `{day,timezone,spentYuan,reservedYuan,capYuan,percent,tier,thresholds,byTier:{conversation,maintenance,vision,web,generation,proactive},calls,unreportedUsage,window,pricing,tokens:{requests,cacheHit,cacheMiss,output,reasoning}}`
  (`tokens`: the day's reported chat/maintenance usage, observation only);
  `POST /spend/settings {dailyCapYuan?,reducedPercent?,restrictedPercent?}` validates
  0.01 ≤ cap ≤ 1000 and 0 < reduced < restricted < 100, persists atomically and
  applies to the next reservation without restart or pause.

## Usage ledger

Next to the spend files the gateway keeps a daily usage ledger (`usage-ledger.mjs`, Beijing
day): one row per declared capability (`capabilities/providers/index.js`: chat, consolidation,
vision, web, speech-tts, speech-asr). It only observes and shows; it never refuses a model call
and a ledger that cannot be written never fails or delays one.

- Files: `usage-ledger.json` (today), `usage-history.jsonl` (one line per finished day, the
  newest 90) and `usage-limits.json` (operator overrides of daily limits). No earlier release
  reads them, and an unreadable or invalid one is started afresh instead of stopping the gateway.
- Money stays with the spend meter: `spend.json` is unchanged and each row's cost is what
  `settle` charged. `capability-usage.json` is unchanged too and still holds the vision/web
  daily counts (an older release refuses to start on a file with unknown fields); the ledger
  reads `visionCalls` / `webCalls` from it as the rows' `used`. Consolidation's batch limits stay
  in Authority (`GET /memory/consolidation`). A row of a capability this release does not declare
  (counted by a newer release before a rollback) is kept in today's file, unseen.
- A row: `used` (what counts against `limit`), `limit` / `limitDefault` (null: none), `calls`,
  `ok`, `failed`, `denied` by reason (`daily_limit`, `spend_tier`, `paused`, `quiet_hours`,
  `cooldown`, `not_configured`, `busy`, `blocked`), `units` (chat and consolidation: reported
  `inputTokens` / `outputTokens`; speech: `chars`, `audioSeconds`), `costYuan`, `busyMs`.
  Chat and consolidation rows count model requests, not turns or batches. A malformed request
  is not counted.
- Inference socket (the `inference.token` holders): `POST /v1/usage/record
  {capability,outcome:'ok'|'failed'|'denied',reason?,units?,busyMs?}` for a capability its own
  process runs (today the content service's local TTS/ASR; never a gateway-counted row, never
  money), and `POST /v1/usage/reserve {capability}` to take a daily slot of such a capability
  (429 `BUDGET_EXHAUSTED` when none is left, 409 while paused; no declared capability needs it yet).
- Control socket: `GET /usage` → `{day,timezone,rows:[{id,title,kind,unit,used,limit,limitDefault,calls,ok,failed,denied,units,costYuan,busyMs,spendCategory,stopTier}]}`;
  `GET /usage/history?days=7` (1–90) → `{timezone,days:[{day,rows:{id:{…}}}]}` newest first, only
  the capabilities used that day; `POST /usage/limits {limits:{id:0–1000|null}}` for a
  capability declared with a daily limit (vision, web), applied to the next call; `null`
  returns to the default. After a rollback the older release enforces its own 12/20.

## Provider adapters

Every paid key lives in the gateway. Besides the DeepSeek key (`settings.json`, unchanged) the gateway
keeps one key per provider adapter and reaches each adapter's operations through three actions. This
release ships no adapter (`providers/index.mjs` exports an empty list), so nothing can be submitted;
adding a provider is one module there plus one import line. The shape of an adapter is documented in
that file. It only describes HTTP exchanges; the gateway owns the key, the network, the money and the
ledger.

- Files next to `settings.json`: `providers.json` (`{schema:1,keys:{<provider>:<key>}}`, 0600, written
  atomically like the settings; a key of a provider this release does not know is kept) and
  `provider-jobs.json` (async jobs: ids, operation, provider, state; no key, input or result). No
  earlier release reads either. An unreadable `providers.json` does not stop the gateway: no adapter
  has a key and none can be stored until the file is fixed; it is never overwritten.
- Control socket: `GET /providers` → `{providers:[{id,title,configured,operations:[{name,mode}],managed}]}`:
  DeepSeek first (`managed:'model'`, its key is set with `POST /model` as before), then each adapter
  (`managed:'providers'`). Only whether a key is set; never a key, its length or a fragment.
  `POST /providers/key {provider,apiKey}` stores an adapter's key and `POST /providers/clear {provider}`
  removes it → `{provider,configured}`. Both apply to the next call and need no pause. `deepseek` and
  unknown providers answer 400.
- An operation is named `<capability id>.<action>` (`image.generate`). The capability declaration
  (`capabilities/providers`) gives its ledger row, daily limit (`POST /usage/limits` changes it), spend
  category (`generation`, refused from the restricted tier on) and units. An adapter whose operation
  names no gateway-counted capability stops the gateway from being built. `mode` is `sync` (the submit
  exchange answers with the result: OpenAI, MiniMax and Seedream pictures) or `async` (it answers with a
  task that is polled: Seedance video, Replicate predictions).
- Inference socket (the `inference.token` holders):
  - `POST /v1/provider/submit {operation,input}` → `{job,operation,state,outputs}`; `state` is `done` for
    a sync operation, `pending` for an async one. `input` is the adapter's own bounded JSON (body ≤ 3 MiB).
    The first adapter that offers the operation and has a key takes it. Refusals, each counted in the
    ledger row: 409 `WORLD_PAUSED` (`paused`), 503 `UNCONFIGURED` (`not_configured`), 429 `SPEND_RESTRICTED`
    (`spend_tier`), 429 `BUDGET_EXHAUSTED` (`daily_limit`), 503 `UNAVAILABLE` with 64 jobs open (`busy`).
  - `POST /v1/provider/status {job}` → the same shape. While the job is pending this asks the provider
    once; the caller sets the pace, the gateway runs no timer. 404 for an unknown job.
  - `POST /v1/provider/fetch {job,output}` → the bytes of result file `output` (0-based) of a finished job,
    with its media type: a URL result is downloaded from one of the adapter's declared hosts at that
    moment and streamed (≤ 64 MiB), a base64 result was kept in memory. Nothing is stored on disk.
- Money: the adapter's estimate is reserved before the submit and a daily slot of the capability is
  taken (it stays taken when the provider fails). A finished job is settled to the cost the adapter
  derived from the provider's answer, or to the estimate; a task that failed or a submit the provider
  refused is released; a request whose outcome is unknown (cut connection, unreadable answer) is charged.
  The ledger line (`ok`/`failed`, cost, units, elapsed time) is written when the job ends.
- Restart: an async job is read back and can still be asked about and fetched. Its reservation was
  charged in full by the spend meter at the restart (as for any reservation), so the later ledger line
  carries no cost. A sync result not fetched before a restart is gone. A job nobody asks about is
  dropped after 72 hours (async; charged if still pending) or one hour (sync).
- Network: an adapter's requests go only to its declared `hosts` (HTTPS, redirects refused). An adapter
  with `proxy:true` goes through the host's outbound HTTP proxy when the gateway process has
  `COMPANION_OUTBOUND_PROXY` (e.g. `http://127.0.0.1:7890`; not a secret, set in the unit when the first
  such adapter ships; `proxy-fetch.mjs`, node:https with an Agent's `proxyEnv`, Node ≥ 24.5). Chat,
  vision and web keep the global fetch and never use the proxy.
- `main.mjs` cannot be given an adapter, a capability list or a fetch: only embedding code can
  (`providers`, `capabilities`, `fetchImpl`, `proxyFetch` of `createModelGateway`). The staging launcher
  and the tests use that for the mock adapter in `deploy/staging/fake-provider.mjs`, which is not part
  of a release.

Tests use injected fetch mocks, not real DeepSeek calls. They exercise token
isolation, paused gates, atomic private settings, SSE/tool/reasoning bytes, model
rewriting/token caps, safe upstream errors, explicit probes and cancellation.
