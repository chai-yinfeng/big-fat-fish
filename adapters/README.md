# @big-fat-fish/adapters

companion-core 的外围适配器。零依赖，纯接口 + HTTP 实现。

## HTTP TTS

```js
import { createHttpTtsAdapter } from "./src/index.js";

const tts = createHttpTtsAdapter({
  url: "http://127.0.0.1:9000/tts",
  headers: { authorization: "Bearer local" },
  // 默认 POST JSON：{ text, voice, style, ... }
  // 默认解析 audio/mpeg 字节
});
const { audio, mime } = await tts.synthesize({ text: "你好", voice: "fish" });
```

适合把 edge-tts / MiniMax / 阿里 CosyVoice / 本地模型统一包成一个本地 HTTP 服务。

## HTTP ASR

```js
import { createHttpAsrAdapter } from "./src/index.js";

const asr = createHttpAsrAdapter({ url: "http://127.0.0.1:9100/asr" });
const { text } = await asr.transcribe({ audio: pcmBytes, language: "zh" });
```

默认把 `Uint8Array` 转 base64，POST `{ audio, language }`，解析 `{ text }`。

## TTS fallback

```js
import { createTtsRouter } from "./src/index.js";

const router = createTtsRouter({
  providers: [minimax, aliyun, edge], // 按顺序降级
  onFallback: ({ to, errors }) => console.warn("tts fallback", to, errors),
});

const result = await router.synthesize({ text: "晚安", voice: "fish" }, { prefer: "minimax" });
```

- 成功结果按 `text+voice+prefer` 缓存；
- 所有供应商失败时抛 `AggregateError`；
- `prefer` 只调整顺序，不阻止降级。

## 测试

```sh
node --test
```
