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
  time; list statutory holidays (off-peak) in `peak.offPeakDates`. The file is
  re-read before every reservation; an invalid file falls back to peak prices at
  every hour (`pricing: 'fallback'`).
- Chat requests are forced to `stream_options.include_usage`; usage (cache hit,
  miss, output including reasoning) is read from the SSE stream as a side channel
  while bytes pass through unchanged. Each call reserves an estimate (prompt
  characters at the miss price plus max output) and settles to the reported usage;
  no usage charges the reservation; a provider error releases it; a reservation
  held across a restart is charged.
- Tiers (defaults 60/80/100 of a ¥5 cap): ≥reduced stops proactive work (none yet),
  ≥restricted refuses `/v1/memory/completions`, vision and web, ≥100% refuses every
  call with 429 `BUDGET_EXHAUSTED` before contacting the provider. A vision/web call
  refused by the spend tier answers 429 `SPEND_RESTRICTED` (the daily call count stays
  `BUDGET_EXHAUSTED`); QQ then stays silent instead of sending the attachment notice. The cap includes
  the owner's own chats.
- Control socket: `GET /spend` → `{day,timezone,spentYuan,reservedYuan,capYuan,percent,tier,thresholds,byTier:{conversation,maintenance,vision,web},calls,unreportedUsage,window,pricing}`;
  `POST /spend/settings {dailyCapYuan?,reducedPercent?,restrictedPercent?}` validates
  0.01 ≤ cap ≤ 1000 and 0 < reduced < restricted < 100, persists atomically and
  applies to the next reservation without restart or pause.

Tests use injected fetch mocks, not real DeepSeek calls. They exercise token
isolation, paused gates, atomic private settings, SSE/tool/reasoning bytes, model
rewriting/token caps, safe upstream errors, explicit probes and cancellation.
