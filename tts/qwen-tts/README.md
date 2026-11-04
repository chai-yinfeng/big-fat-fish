# Qwen3-TTS local service

百炼 Qwen3-TTS-Flash 的本地 HTTP 服务，端口 `9006`。复用 ASR 的
`~/.dsh/companion/dashscope.env`（`DASHSCOPE_API_KEY` 同一个 key）。

- `GET /health`：是否配置 key、模型、base URL。
- `GET /voices`：Cherry / Ethan / Li / Sunny 等。
- `POST /tts` `{text, voice, style}`：返回 WAV（24k mono）。
- `voice:auto` -> Cherry；`style` 暂不转发（Qwen3-TTS 的非实时接口没有统一 style 参数）。

已验证：使用现有百炼 key 真实合成成功，`x-tts-provider: qwen`，
`audio/wav` 24kHz。默认 base URL 复用 workspace 的 `DASHSCOPE_BASE_URL`，
失败时回退 `https://dashscope.aliyuncs.com/api/v1`。

启动：

```sh
cd tts/qwen-tts && ./run.sh
```

DSH 里由 `companion-core` supervisor 自动启动。
