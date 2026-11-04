# companion-tts

TTS provider 路由 + 本地 sidecar。拥有 edge / MiMo / Qwen3-TTS / MiniMax 四个进程，
不再由 core 启动。

- `POST /companion/tts`：按 provider 顺序合成，**第一个成功即返回**，下游跳过。
- `GET /companion/voices`
- `GET|POST /companion/tts/providers`：顺序 + enabled；配置存 `~/.dsh/companion/tts.json`
  （首次从旧 `adapters.json.tts` 迁移）。
- `GET /companion/tts/health`：各 provider `configured`/健康。
- `GET /companion/tts/services`、`POST /companion/tts/services/restart`：sidecar 状态/重启。

sidecar 端口：edge 9003、MiMo 9004、Qwen 9006、MiniMax 9007。

默认只启用免费方案（MiMo + edge）；Qwen / MiniMax 付费，需在 UI 手动点亮。
provider 顺序默认 `minimax → qwen → mimo → edge`，但前两个默认关闭。
