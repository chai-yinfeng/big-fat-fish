# MiniMax TTS local service

MiniMax T2A 的本地 HTTP 服务，端口 `9007`。key 放在
`~/.dsh/companion/minimax.env`（不要提交到仓库）。

```sh
MINIMAX_API_KEY=...
MINIMAX_GROUP_ID=...
# 国内站用 https://api.minimaxi.com/v1；国际站用 https://api.minimax.io/v1
MINIMAX_API_BASE=https://api.minimaxi.com/v1
MINIMAX_TTS_MODEL=speech-2.8-hd
```

- `GET /health`：`configured` 表示 key 是否就绪。
- `GET /voices`：少女/御姐/成熟女声/青涩青年等。
- `POST /tts` `{text, voice}`：返回 MP3；`voice:auto` -> `female-shaonv`。
- 没有 key 时 `/tts` 返回 503，TTS router 会继续降级到下一个 provider。
- 服务会依次尝试配置的 base、`api.minimaxi.com`、`api.minimax.io`、`api.minimax.chat`；
  国内 key 在 `.io` 会返回 `2049 invalid api key`，实际可用的是 `api.minimaxi.com`。
- 已实测：`speech-2.8-hd` + `female-shaonv` 返回 MP3（128kbps/32kHz），
  GroupId 填/不填都可用的环境下不强制。

启动：

```sh
cd tts/minimax-tts && ./run.sh
```

DSH 里由 `companion-core` supervisor 自动启动。填入 key 后重启
`minimax` 服务，再在 UI 的 TTS 路由里勾选启用即可；实测需要 key 才能完成合成。
