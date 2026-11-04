# companion-asr

ASR 网关代理 + 本地网关/model sidecar。拥有 Python ASR gateway（端口 9005）。

- `POST /companion/asr`：注入有序 `providers` 后代理到网关。
- `GET|POST /companion/asr/providers`：顺序 + enabled；配置存 `~/.dsh/companion/asr.json`
  （首次从旧 `adapters.json.asr` 迁移）。
- `GET /companion/asr/models`、`POST /companion/asr/models/install {target}`。
- `GET /companion/asr/health`：网关健康 + sidecar 状态。
- `GET /companion/asr/services`、`POST /companion/asr/services/restart`。
- 流式仍直连 `ws://127.0.0.1:9005/asr/stream`，避免多一跳代理。

provider：`zipformer`（本地真流式）、`qwen3`（云端）、`sensevoice`（本地整段）。
