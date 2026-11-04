# Private model gateway

Node 24, standard library only. The network-capable host gateway owns the real
DeepSeek credential. The DSH worker gets only an opaque inference token and the
inference socket; it must not see the settings file, launch configuration,
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
    "tokenFile": "/absolute/private/dsh-test.token"
  }
}
```

All three gateway paths must be absolute and distinct; hashes must be distinct
64-character lowercase SHA-256 hex values. `authority.tokenFile` is the existing
read-only `dsh-test` capability, not admin. Main calls only
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
Changing the console setting does not require a gateway/worker restart. Existing
SDK adapter metadata must remain valid for both selectable models.

The SDK adapter uses stable provider `companion`, model `deepseek` (application
primary `companion/deepseek`), `openai-completions`, and explicit DeepSeek compat.
A role-restricted bridge maps the worker's fixed localhost model port to only
`inference.sock`; this module does not grant any worker network access.

Tests use injected fetch mocks, not real DeepSeek calls. They exercise token
isolation, paused gates, atomic private settings, SSE/tool/reasoning bytes, model
rewriting/token caps, safe upstream errors, explicit probes and cancellation.
