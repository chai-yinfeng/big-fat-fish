# companion ASR gateway

本地 ASR 网关：**Qwen3-ASR 流式（云）→ SenseVoice（本地）**，带 VAD、逐字上屏、
模型一键下载。默认端口 `9005`。

## 能力

- `POST /asr`：整段音频（base64）→ 最终文本；同时跑云端和本地，云端优先，本地兜底/对照。
- `GET /asr/stream`：WebSocket；发送 PCM16 16k mono 分片，返回 `partial` / `final`，
  支持 30s+ 录音的逐字上屏。partial 是**全量文本**，客户端直接替换草稿即可。
  start/`POST /asr` 可带有序 `providers` 列表（推荐）：
  - `["zipformer", "qwen3", "sensevoice"]`：本地实时 partial + 云端 final；
  - `["zipformer"]`：纯本地实时，不调用付费 API；
  - `["sensevoice"]`：只跑 SenseVoice（非流式模拟 partial）；
  - `["qwen3"]`：只跑云端。
  旧的 `provider: auto | local | cloud` 仍兼容。
- **逐字上屏的差异**：Qwen3 云端是真正的流式 partial；SenseVoice 是非流式模型，
  只启用 SenseVoice 时是每约 1.5s 对已录音频重跑一次（模拟 partial），长录音时可能落后于说话速度。
  需要本地真流式时用 Zipformer（后续拓展）。
- `GET /health`：云端 key、SenseVoice、VAD、模型状态。
- `GET /models`：SenseVoice / Zipformer / VAD 安装状态/进度。
- `POST /models/install` `{target: zipformer|sensevoice|all}`：一键下载对应模型。
- VAD：Silero VAD；失败时回退能量 VAD。VAD 会裁掉首尾静音。

## 配置

`~/.dsh/companion/dashscope.env`：

```sh
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=https://llm-rteufrp0wmbdr6xz.cn-beijing.maas.aliyuncs.com/api/v1
DASHSCOPE_WS_URL=wss://llm-rteufrp0wmbdr6xz.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
DASHSCOPE_ASR_MODEL=qwen-audio-3.1-asr-flash-streaming
ASR_LANGUAGE=zh
```

- 模型 ID 可改；默认 `qwen-audio-3.1-asr-flash-streaming`，失败时尝试
  `qwen3-asr-flash-realtime`，再退 SenseVoice。
- 模型目录默认 `$DSH_HOME/companion/models/`；可用 `ASR_MODELS_DIR` 覆盖。
- 没有 key 时仍可启动；只走 SenseVoice。没装模型且没 key 时 `/asr` 返回错误。

## 启动

```sh
cd projects/big-fat-fish/asr
uv sync --frozen
./run.sh --port 9005
```

DSH 里由 `companion-core` supervisor 自动启动，不需要手动跑。

## 测试

```sh
# 健康
curl -s http://127.0.0.1:9005/health

# 整段识别（用一段 wav；这里用 MiMo 生成的样本）
B64=$(base64 -i ../experiments/voice-samples/mimo-warm.wav | tr -d '\n')
curl -s -X POST http://127.0.0.1:9005/asr \
  -H 'content-type: application/json' \
  -d "{\"audio\":\"$B64\",\"mime\":\"audio/wav\"}"
```

整段结果示例：

```json
{
  "ok": true,
  "text": "你回来啦，今天辛苦了，先坐下歇一会儿吧。",
  "provider": "qwen3-asr",
  "model": "qwen-audio-3.1-asr-flash-streaming",
  "alternative": "你回来了今天辛苦了先坐下歇一会儿吧",
  "verified": true,
  "durationMs": 3318
}
```

流式 WebSocket 客户端示例见 `experiments/` 或 UI 的 `client.js`：发送
`{"type":"start","language":"zh","sampleRate":16000}`，然后二进制 PCM16 分片，
最后 `{"type":"stop"}`。

## 注意

- 云端音频会发往阿里百炼；本地 SenseVoice 不上传。
- 逐字上屏的 partial 会修正前面的字，UI 必须**替换**而不是追加。
- 草稿回退/流式模型（Zipformer）是后续拓展；当前按住录音整段模式不需要。
- 依赖 `sherpa-onnx`/`numpy`/`dashscope`/`aiohttp`，由 `uv` 管理。
