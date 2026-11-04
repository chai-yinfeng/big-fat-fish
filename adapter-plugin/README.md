> **已弃用（2026-10-25）**：TTS/ASR 已拆成 `companion-tts` 和 `companion-asr`；本目录仅保留迁移参考。

# @local/companion-adapters

把 TTS/ASR 供应商收在一个 DSH 插件里，对本地暴露 HTTP 路由。**0.2.0 已实现并在 desktop profile 里挂载验证。**

```text
POST /companion/tts      { text, voice?, rate?, pitch?, volume? } -> audio/mpeg 等字节
POST /companion/asr      { audio: base64, language? }             -> { text }
GET  /companion/voices   ?locale=zh-CN                             -> edge-tts 音色列表
GET  /companion/health                                               -> 已配置的 provider
GET  /companion/providers                                            -> TTS 顺序/enabled + ASR 模式
POST /companion/providers { tts?: [{name,enabled}], asr?: {enabled,provider} } -> 持久化并热更新
```

## 配置

`$DSH_HOME/companion/adapters.json`：

```json
{
  "tts": [
    { "name": "mimo",    "url": "http://127.0.0.1:9004/tts" },
    { "name": "edge",    "url": "http://127.0.0.1:9003/tts" },
    { "name": "minimax", "url": "http://127.0.0.1:9001/tts", "headers": { "authorization": "Bearer ..." } },
    { "name": "aliyun",  "url": "http://127.0.0.1:9002/tts" }
  ],
  "asr": { "name": "asr-gateway", "url": "http://127.0.0.1:9005/asr" }
}
```

- `tts` 按数组顺序降级；第一个失败试下一个。
- 每个 provider 是“JSON 进、音频字节出”的本地 HTTP 服务；供应商签名/密钥在各自小服务里，不进 DSH。
- **MiMo 已在 [../tts/mimo-tts](../tts/mimo-tts) 提供**：OpenAI 兼容、限时免费、中文风格控制；
  key 只放在 `~/.dsh/companion/mimo.env`。把 `mimo` 放第一位即可优先用它，失败自动降级到 edge。
- **ASR 网关在 [../asr](../asr)**：Qwen3-ASR 流式 + SenseVoice 本地；`/companion/asr` 指向 9005。
- **没有配置文件时默认使用 edge**：`http://127.0.0.1:9003/tts`，所以 Mac 上装完 edge 服务即可用。
- 显式写 `"tts": []` 才表示“没有 TTS provider”，路由返回 503。
- `tts[].enabled=false` 可关闭某个 provider（例如关闭 MiMo，只走 edge）；顺序即降级顺序。
- `asr.providers` 是 `zipformer` / `qwen3` / `sensevoice` 的有序列表，`enabled:false` 关闭、顺序即优先级，
  由 `POST /companion/providers` 热更新；UI 的 ASR 路由勾选/排序改的就是这里。
  `asr.provider` 仅保留旧调用兼容。
- 文件损坏时回退到默认 edge，并在 `/companion/health` 的 `configError` 里报告。
- 请求超时：TTS 60 秒，voices 15 秒；`signal` 只用于传输取消，不会进入 JSON body。
- `voice: "auto"` 会原样传给 provider，由每个 provider 映射到自己的默认音色；这样一套
  `companion-core` 配置可以在 MiMo / edge 之间降级。
- `GET /companion/voices` 按 provider 顺序尝试，某个 provider 没有 `/voices` 就试下一个。

## 示例

```sh
curl -s -X POST http://127.0.0.1:60619/companion/tts \
  -H 'content-type: application/json' \
  -d '{"text":"你好，我是大肥鱼。","voice":"auto"}' \
  -o /tmp/fish.audio

curl -s 'http://127.0.0.1:60619/companion/voices?locale=zh-CN'
curl -s http://127.0.0.1:60619/companion/health
```

响应头 `x-tts-provider` 标明实际命中的 provider；命中缓存时还有 `x-tts-cached: 1`。

## 状态

- 路由、降级、超时、voices 代理、health 已实现并有单测。
- edge-tts 独立服务在 [`../tts/edge-tts`](../tts/edge-tts)。
- MiniMax / 阿里 TTS 小服务尚未附带；ASR 已由 `../asr` 网关提供。
- 当前通过 pnpm link 安装；插件用相对路径 import `../../adapters`，发布前需要把 adapters vendor
  进插件包（与 `companion-core` 的打包问题相同）。
