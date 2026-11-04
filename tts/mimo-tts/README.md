# MiMo-V2.5-TTS 本地服务

把小米 MiMo 的 `mimo-v2.5-tts` 包成和 edge-tts 一样的本地 HTTP 契约，方便
`companion-adapters` 直接在供应商之间降级。

## 为什么接它

- 中文预置音色：冰糖 / 茉莉 / 苏打 / 白桦。
- 支持自然语言风格指令、音频标签（`(温柔)`、`[叹气]` 等）、导演模式。
- 支持 `mimo-v2.5-tts-voicedesign`（文本设计音色）和 `mimo-v2.5-tts-voiceclone`（数秒样本复刻）。
- 官方文档标注**限时免费**；`mimo-v2.5-tts` 支持低延迟流式 PCM16（本服务暂用非流式 WAV）。
- OpenAI 兼容接口，密钥只在本服务里使用，不进入 DSH。

## 启动

```sh
cd projects/big-fat-fish/tts/mimo-tts

# 把 key 放到 DSH 状态目录（不要提交到仓库）
mkdir -p ~/.dsh/companion
cat > ~/.dsh/companion/mimo.env <<'EOF'
MIMO_API_KEY=你的 MiMo API Key
MIMO_VOICE=冰糖
MIMO_STYLE=温柔、自然，像在跟亲近的人说话，语速稍慢，不要播音腔。
EOF
chmod 600 ~/.dsh/companion/mimo.env

./run.sh                 # 默认 127.0.0.1:9004
```

也可以只走环境变量：`MIMO_API_KEY=... ./run.sh`。`MIMO_BASE_URL` 默认
`https://api.xiaomimimo.com/v1`，`MIMO_MODEL` 默认 `mimo-v2.5-tts`。

## 接口

```text
GET  /health  -> { ok, model, keyConfigured, voice, baseUrl }
GET  /voices?locale=zh-CN -> { ok, count, voices[] }
POST /tts     { text, voice?, style?, format? } -> audio/wav（format=pcm16 时为 audio/pcm）
```

- `voice` 可用 `auto`（用 `MIMO_VOICE`）、`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean。
- 不传 `style` 时用 `MIMO_STYLE`；也可以每次请求传不同风格。
- `rate/pitch/volume` 不是 MiMo 的参数；用 `style` 或文本里的音频标签控制。
- 没有 key 时 `/tts` 返回 503，`/health` 仍可用（`keyConfigured:false`）。

## 接入 DSH

`$DSH_HOME/companion/adapters.json` 把 MiMo 放第一位，edge 作为兜底：

```json
{
  "tts": [
    { "name": "mimo", "url": "http://127.0.0.1:9004/tts" },
    { "name": "edge", "url": "http://127.0.0.1:9003/tts" }
  ]
}
```

`companion-core` 的 `tts.voice` 建议设为 `auto`，这样 MiMo 用自己的默认音色，
降级到 edge 时 edge 用自己的默认音色；如果设成某个具体音色，不认这个音色的
provider 会返回 400，由 router 自动试下一个。

## 测试

```sh
# 不联网的契约测试（mock MiMo 上游）
cd projects/big-fat-fish && node --test tts/mimo-tts/test/*.test.js

# 有 key 时手动听一下
curl -s -X POST http://127.0.0.1:9004/tts \
  -H 'content-type: application/json' \
  -d '{"text":"你好，我是大肥鱼。","voice":"冰糖","style":"温柔、自然，像在跟亲近的人说话"}' \
  -o /tmp/mimo.wav
afplay /tmp/mimo.wav
```

## 限制

- 限时免费随时可能结束；正式使用前看 [MiMo 计费说明](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)。
- 本服务只封装 `mimo-v2.5-tts`（预置音色）。voicedesign / voiceclone 的请求体不同，
  需要时再在 `server.js` 里加分支。
- 输出默认 WAV，比 edge 的 MP3 大；好处是免转码、`afplay` 直接播。
- 语音数据会发往小米 MiMo API；在意隐私就保留 edge-tts 或改用本地 TTS。
