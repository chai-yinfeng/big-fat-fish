# @local/companion-core

大肥鱼的 DSH 插件壳：把 `../../core` 的陪伴状态接到 DSH 宿主能力上。
## core 0.3.0：迁移前修复（代码验证，不代表已部署）

- 唯一作者源为 `$DSH_HOME/companion/persona.json`，完整 `schemaVersion/revision/persona` 文档。首次只按旧 journal 与旧 `config.persona` 的有效覆盖生成 revision 1；之后旧配置不再覆盖它，preset 不再携带第二套人格。
- 修改文档时 revision 加一，再 `/companion persona reload`；同修订不同内容、跳号与倒退拒绝。回退旧内容要创建新修订。已应用快照、哈希、来源与原因保存在 journal，状态接口返回版本与来源错误。
- source 损坏/缺失不会静默创建默认身份；运行时错误更新保留已应用版本，启动时失败则 core 不就绪。启动失败后修好文件需要重新启动插件，不能靠 persona reload 复活已关闭的 core。
- 生产日志使用 DSH 已有 `@deepseek-ai/node-addon-system/flock` 内核锁（显式 peer）；缺少相应平台组件会拒绝启动，不降级成可丢失的内存或猜 PID 清锁。
- 残尾安全恢复、非法完整记录报错、原子事实替换；召回要求词法相关性，上下文按类别分配空间，事实不截成半句。
- 空库/迁移前须同时准备新版 core 与新版 preset；已有会话可能保留旧 preset revision，部署时验证新建与恢复会话，不据源码修改声称运行时已切换。

## 前次变更（运行时状态以实际挂载验证为准）

- outer diary 仍由空闲3h窗口生成；inner 不再被窗口或独立模型 pass 自动生成。
- 绑定 agent 可调用 `companion_inner_diary(text,key)`，自主决定是否写内记；无每日凑数要求，保留总篇幅预算。
- `companion.registerProactiveTopic(id, peek)` 允许独立能力层提供候选话题；core 只应用统一静默、冷却、暂停与未回应策略，不管理外部 queue。
- B站资料桥是独立 bundle，不在 core 库中引入 B站协议、报告、凭据或队列。
- 修正 `buildContext(includeInnerDiary)` 未向下传参；消费外记窗口快照时保留模型运行期间新到的消息。

以下为旧版本说明；若有冲突，以本节与当前实现为准。

## 做什么

- **只作用于绑定会话**：`/companion bind` 之前，不注入上下文、不抽取记忆、不主动开口。
- **上下文注入**：通过 `systemPrompt.context` 把 `core.buildContext()` 注入绑定的 agent，
  包含人格、关系/心情、facts、outer 日记、相关 episodes，预算内截断。
- **互动记录**：监听 `session/event` 维护每个会话最近一轮的用户/助手文本；`agent/turn-stopping`
  时写回 core（用户消息、助手消息、主动开口的回应）。
- **LLM 记忆抽取**：每轮结束后延迟合并（默认 20 秒，最多 6 轮），用当前会话的 provider/model
  调 `ctx.llm.stream()` 抽 facts / outer+inner diary / episodes / moodEvent。失败只记日志，不打断对话。
  日记每天最多 outer 1 条、inner 1 条；facts 有敏感信息过滤。
- **主动开口**：`ctx.interval` 定时 `core.tick()`；通过 `agent.followup()` 投递一条带
  `plugin:companion-core` source 的指令消息，让模型用人设自然开口；`pause/resume/poke` 可控。
- **本机语音**：助手每轮最终回复可自动朗读（默认开），也可 `/companion speak` 手动朗读。
  音频优先走 `companion-tts` 的 `/companion/tts`（可把 MiMo 排第一、Qwen/MiniMax/edge 兜底），
  失败再直连 edge-tts；macOS 用 `afplay`，其他平台用 `ffplay`（可用配置覆盖）。
- **管理接口**：本地 HTTP 路由 + `companion` 服务；可选 `companion-ui` 角色面板。
- **ASR**：由 `companion-asr` 管理 `asr/` 网关（端口 9005）；Zipformer 本地流式 + Qwen3 + SenseVoice/VAD；
  `POST /companion-core/voice` 把转写作为用户消息发送；模型一键下载由 ASR 网关提供。
- **无头可用**：只装 core 时用 `/companion status|diary|speak|extract` 和 HTTP 路由；UI 不是必需。

## 命令

| 命令 | 作用 |
|---|---|
| `/companion bind` | 把当前会话绑定为陪伴会话 |
| `/companion unbind` | 解除绑定（journal 保留） |
| `/companion status` | 心情、关系、记忆计数、抽取/语音状态 |
| `/companion pause [30m\|2h\|1d]` | 暂停主动开口（默认 2 小时） |
| `/companion resume` | 恢复主动开口 |
| `/companion poke` | 无视概率，立刻让大肥鱼主动说一句 |
| `/companion diary [n]` | 最近 n 条 **outer** 日记（默认 3） |
| `/companion speak [文本]` | 本机朗读；不带文本时朗读上一条回复 |
| `/companion voice [auto\|音色名]` | 查看/切换音色（`auto` 让 provider 选默认音色） |
| `/companion style [描述]` | 查看/设置 MiMo 风格指令（edge 会忽略） |
| `/companion autospeak [on\|off\|first\|full\|short]` | 自动朗读策略 |
| `/companion extract` | 立刻抽取当前/待处理对话的记忆 |

> 2026-10-25：语音 sidecar 已迁到 `companion-tts` / `companion-asr`；core 的
> `services.autoStart` 默认关闭，`/companion-core/services` 仅保留兼容状态。

## 配置

`$DSH_HOME/companion/config.json`，由首次 `/companion bind` 自动生成。默认值：

```json
{
  "version": 1,
  "targetSession": "",
  "autoBindPreset": "companion",
  "presence": "auto",
  "budgetChars": 2400,
  "tickMs": 30000,
  "services": {
    "autoStart": true,
    "stopOnDispose": false,
    "edge": { "enabled": true },
    "mimo": { "enabled": true },
    "qwen": { "enabled": true },
    "minimax": { "enabled": true },
    "asr": { "enabled": true }
  },
  "proactive": { "enabled": true },
  "extractor": {
    "enabled": true,
    "debounceMs": 20000,
    "maxTurns": 6,
    "maxChars": 6000,
    "maxTokens": 1200,
    "timeoutMs": 45000,
    "temperature": 0.2,
    "provider": "",
    "model": "",
    "reasoningEffort": ""
  },
  "diary": { "maxOuterPerDay": 1, "maxInnerPerDay": 1 },
  "tts": {
    "enabled": true,
    "useAdapter": true,
    "urls": [],
    "voice": "auto",
    "style": "温柔、自然，像在跟亲近的人说话，语速稍慢，不要播音腔。",
    "rate": "+0%",
    "pitch": "+0Hz",
    "volume": "+0%",
    "maxChars": 400,
    "autoSpeak": true,
    "autoSpeakMode": "first-sentences",
    "autoSpeakMaxChars": 120,
    "player": "auto",
    "timeoutMs": 60000
  }
}
```

- `extractor.provider/model` 留空表示跟随当前会话的 `request/header`，再退回 `agentDefaultModel`。
- `presence` 支持 `auto`（按最后一条用户消息推断 active/away/unknown）、`active`、`away`、`unknown`。
- `tts.urls` 留空时依次尝试 `http://<dsh-origin>/companion/tts` 和 `http://127.0.0.1:9003/tts`。
- `tts.voice="auto"` 让每个 provider 用自己的默认音色：MiMo 用 `冰糖`，edge 用
  `zh-CN-XiaoxiaoNeural`。也可以填具体音色；不认这个音色的 provider 会失败并由 router 降级。
- `tts.style` 是 MiMo 的自然语言风格指令；edge 忽略它。
- `tts.player` 支持 `auto`、`afplay`、`ffplay`、`mpv` 或任意可执行文件。
- **自动朗读不会念整篇回复**：只在 `turn-stopping` 时念最终回复，先去掉代码块/URL/markdown，
  默认 `first-sentences` 只念开头 1–2 个完整句子，最多 `autoSpeakMaxChars`（默认 120）字。
  其他策略：`full`（截断到上限）、`short-only`（超长直接不念）、`off`（关闭）。
  `/companion speak` 手动朗读才用 `maxChars`（默认 400）。

状态目录：

```text
$DSH_HOME/companion/
  config.json          # 上面这份配置
  journal.jsonl        # append-only 事件日志，core replay 的唯一真相
  tts-cache/           # 播放临时 mp3，afplay 退出后删除
```

## 本地 HTTP 路由

都挂在 DSH web server 上。DSH 默认只监听 `127.0.0.1`；这些路由**没有额外鉴权**，不要通过
反向代理/公网暴露。

| 方法/路径 | 作用 |
|---|---|
| `GET /companion-core/state` | 完整状态（不含 inner 日记正文） |
| `POST /companion-core/bind` `{sessionId}` | 绑定会话 |
| `POST /companion-core/unbind` | 解除绑定 |
| `POST /companion-core/extract` `{dryRun?, userText?, assistantText?}` | 抽取；`dryRun` 只返回不写 journal |
| `POST /companion-core/poke` | 主动开口一次 |
| `POST /companion-core/pause` `{minutes?}` | 暂停主动开口 |
| `POST /companion-core/resume` | 恢复主动开口 |
| `POST /companion-core/speak` `{text?, voice?, play?}` | 合成/播放；`play:false` 返回音频 |
| `POST /companion-core/config` `{tts:{...}}` | UI 修改音色/风格/autoSpeak |
| `POST /companion-core/voice` `{text}` | 把语音转写作为用户消息发送 |
| `GET /companion-core/services` / `POST .../services/restart` | 服务状态/重启 |
| `GET /companion-core/diary?limit=n` | 只返回 outer 日记；`kind=inner` 返回 403 |

插件还会 `ctx.provide("companion", ...)`，暴露 `state/bind/unbind/status/pause/resume/poke/memory/speak/extract`。

## 安装与验证

当前用 pnpm link 安装到 desktop profile（不是打包发布）：

```sh
# 由 Creator 会话通过 plugin_manager install_bundle 完成，或手动：
pnpm add link:/absolute/path/to/projects/big-fat-fish/plugin
```

验证：

```sh
curl -s http://127.0.0.1:60619/companion-core/state
curl -s -X POST http://127.0.0.1:60619/companion-core/extract \
  -H 'content-type: application/json' \
  -d '{"dryRun":true,"userText":"我喜欢浅烘咖啡","assistantText":"记住了"}'
```

## 已知边界

- **单 profile / 单 journal**：core 假设一个 journal 一个写者；不要在多个 DSH 进程里同时绑定同一目录。
- **inner 日记不对外**：HTTP、命令、service 都只暴露 outer 正文；inner 只用于抽取/反思素材。
- **核心不再管理语音 sidecar**：TTS/ASR 进程归 `companion-tts` / `companion-asr`；core 只保留
  领域逻辑和 `/companion-core/*` 路由。发布时以整合包 vendor。
- **设置页未做**：目前用命令和 `config.json`；M2 剩余的 client 设置页在下一轮。
- **`snapshotEvents()` 是 deprecated API**：只在 mirror 缺失时作为手动抽取的 fallback 使用；
  正常路径走 `session/event` live feed。
