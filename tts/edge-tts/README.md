# edge-tts 本地服务

独立的 edge-tts HTTP 服务，不依赖 DSH。`companion-adapters` 通过
`http://127.0.0.1:9003/tts` 调它；也可以在终端单独用。

用 `uv` 管理 venv 和锁文件：`pyproject.toml` + `uv.lock`，venv 在 `.venv/`。

## 启动

```sh
cd projects/big-fat-fish/tts/edge-tts

# 首次：创建/同步 venv（需要网络）
uv sync --frozen

# 启动（默认 127.0.0.1:9003）
./run.sh
```

`run.sh` 会设置 `UV_CACHE_DIR=.uv-cache` 并执行 `uv run --frozen --no-dev server.py`。
`--port 0` 会挑一个空闲端口，并在 stdout 打印 `EDGE_TTS_PORT=<port>`。

## 接口

```text
GET  /health                         -> {"ok":true,"service":"edge-tts","version":"7.3.1",...}
GET  /voices?locale=zh-CN            -> {"ok":true,"count":8,"voices":[...]}
POST /tts   {"text":"...", "voice":"zh-CN-XiaoxiaoNeural",
             "rate":"+0%","pitch":"+0Hz","volume":"+0%"} -> audio/mpeg
```

- `text` 必填，最长 4000 字符；`voice` 默认 `zh-CN-XiaoxiaoNeural`，传 `auto` 也映射到它。
- `rate`/`volume` 形如 `+10%`/`-5%`；`pitch` 形如 `+5Hz`/`-2Hz`。
- 返回头带 `X-Voice`、`X-Duration-Ms`；错误是 JSON `{ok:false,error}`（400/502）。
- 只绑定 `127.0.0.1`；没有鉴权，不要暴露到公网。
- 音色列表在内存缓存 1 小时（`--voices-cache-seconds`）。

## 验证

```sh
# 服务级集成测试（会真的联网合成中文 mp3）
cd projects/big-fat-fish && npm run test:edge

# 手动
curl -s http://127.0.0.1:9003/health
curl -s -X POST http://127.0.0.1:9003/tts \
  -H 'content-type: application/json' \
  -d '{"text":"你好，我是大肥鱼。","voice":"zh-CN-XiaoxiaoNeural"}' \
  -o /tmp/fish.mp3
afplay /tmp/fish.mp3      # macOS
ffplay -nodisp -autoexit /tmp/fish.mp3
```

## 依赖与限制

- `edge-tts==7.3.1`，Python >= 3.10；运行时需要访问微软 Edge 的在线朗读服务。
- 没有 API key，但这是第三方在线服务，离线或被限流时会返回 502。
- 微软改协议时升级 `edge-tts` 并重新 `uv lock` 即可；DSH 侧只认 HTTP 契约，不用改。
