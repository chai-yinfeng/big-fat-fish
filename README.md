# 大肥鱼（big-fat-fish）

目标是做一个拟人化的陪伴 agent：会记事、会主动开口、有情绪，能通过 IM 或本机语音交流。

当前阶段：**Mac 上先跑通，正式部署再迁到 Linux 服务器。**

## 目录

| 路径 | 内容 |
|---|---|
| `notes/` | 视频拆解、插件对比、决策记录；核心规格见 `notes/companion-core-spec.md`，语音选型见 `notes/voice-options.md` |
| `core/` | 陪伴内核库（记忆 / 心情 / 策略 / 上下文），零依赖 + `node:test` |
| `adapters/` | TTS/ASR HTTP 适配器与 TTS fallback router |
| `plugin/` | `companion-core`：记忆/心情/绑定/命令/抽取；preset 随 core 发行 |
| `preset/` | “大肥鱼陪伴” agent preset：新建会话时选择，自动绑定 |
| `tts-plugin/` | `companion-tts`：TTS 路由 + edge/MiMo/Qwen/MiniMax sidecar |
| `asr-plugin/` | `companion-asr`：ASR 代理 + ASR 网关 sidecar + 模型下载 |
| `voice-runtime/` | TTS/ASR 共用的 sidecar 进程管理（安全重启，不杀外部客户端） |
| `adapter-plugin/` | 旧合并网关，已弃用；代码保留作迁移参考 |
| `tts/edge-tts/` | 独立 edge-tts HTTP 服务（uv 管 venv，端口 9003） |
| `tts/mimo-tts/` | 独立 MiMo-V2.5-TTS 服务（OpenAI 兼容，端口 9004，需 key） |
| `tts/qwen-tts/` | 独立 Qwen3-TTS-Flash 服务（复用百炼 key，端口 9006） |
| `tts/minimax-tts/` | 独立 MiniMax T2A 服务（端口 9007，需 key） |
| `asr/` | ASR 网关：Qwen3-ASR 流式 + SenseVoice 本地 + VAD + 模型一键下载 |
| `ui/` | 可选角色 UI：可拖动头像、语音/服务/心情/日记面板 |
| `notes/companion-ui-architecture.md` | UI/核心/语音网关的分层与可选 UI 边界 |
| `persona/` | 人设、系统提示词、称呼、记忆模板（脱敏后） |
| `im/` | QQ / 企微 / Telegram 等渠道配置（脱敏后） |
| `experiments/` | 临时试验、脚本、抓包/日志 |

## 参考插件（视频：BV1ednc6jE3j）

- `dsh-qq-bridge`：QQ（OneBot HTTP）双向桥，单目标会话
- `dsh-fish-memory`：按会话的长期记忆（会淡忘、可召回）
- `dsh-speak-up`：主动搭话（本地掷骰、安静时段）
- `dsh-feiyu-mood`：心情/情绪状态
- `dsh-tts-bridge`：浏览器朗读桥（非 TTS API）
- `dsh-bili-subagent`：派子代理刷 B 站

## 当前方向

- IM：优先试 `@michengai/dsh-im-connect`（企微/Telegram 官方机器人、每聊天独立会话）；
  QQ 个人号走 NapCat/SnowLuma + `dsh-qq-bridge` 作为后续玩法。
- 陪伴为主：工具权限收窄（只读/有限工具），不追求 IM 内的复杂审批体验。
- 核心三件套：长期记忆、主动搭话、情绪；TTS/IM/扩展行为是外围。
- TTS：Mac 本地先用 edge-tts 跑通；国内云（MiniMax / 阿里 CosyVoice / 豆包 / 腾讯）后续接入。

## 运行测试

```sh
cd projects/big-fat-fish
npm test           # 78 项：core + adapters + 插件壳 + MiMo/桥接安全测试
npm run test:edge  # edge-tts 服务集成测试（需要网络）
npm run test:mimo  # MiMo 服务契约测试（mock 上游，不需要 key）
npm run test:asr   # ASR 网关纯函数测试（resample/VAD/路由归一化，5 项）
```

## 已跑通（0.2.0）

- [x] 核心规格（`notes/companion-core-spec.md`）
- [x] core 库 + 单测（facts / outer+inner diary / episodes / 心情 / 主动策略 / 上下文）
- [x] TTS/ASR HTTP 适配器 + fallback router
- [x] 两个插件真实安装到 desktop profile 并验证状态/TTS/LLM 抽取
- [x] LLM 记忆抽取：每轮延迟合并、日记每日配额、敏感 facts 过滤、失败软处理
- [x] `/companion bind|unbind|status|pause|resume|poke|diary|speak|extract`
- [x] edge-tts 独立服务（uv + `zh-CN-XiaoxiaoNeural`），`afplay` 本机播放
- [x] MiMo-V2.5-TTS 本地服务 + 降级链（需 `MIMO_API_KEY` 才能真实合成）
- [x] Qwen3-TTS-Flash 服务（复用百炼 ASR key，真实合成已验证）；默认关闭
- [x] MiniMax T2A 真实合成验证（`api.minimaxi.com`）；默认关闭，手动点亮
- [x] 自动朗读只念开头完整句子（默认 120 字），不念整篇回复
- [x] 新建会话时选择“大肥鱼陪伴”自动绑定
- [x] 插件启动时自动拉起 edge/MiMo/ASR，服务状态与一键重启
- [x] ASR 网关：Qwen3-ASR 逐字上屏 + Zipformer 本地真流式 + SenseVoice/VAD 兜底
- [x] SenseVoice / Zipformer / VAD 模型一键下载（插件内，无需手工 wget）
- [x] 可选 companion-ui：鲸鱼娘立绘、可拖动/吸附、ASR/TTS/状态三页签、按住录音/逐字上屏
- [x] 只对绑定会话生效；inner 日记不对外暴露

## 待定

- [x] core / TTS / ASR / UI 拆分插件 + 假 ctx 冒烟测试
- [x] 记忆抽取器（LLM）与 edge-tts 真实接入
- [x] 角色面板（client 插件）：音色、autoSpeak、按住录音、服务、心情、日记
- [ ] IM-connect 接企微/Telegram 跑通
- [ ] QQ 个人号方案验证
- [x] 用真实 MiMo key 跑中文对比并决定默认 provider
- [x] ASR gateway（Zipformer 本地流式 → SenseVoice → Qwen3）+ VAD + 模型一键下载
- [x] 可选 companion-ui 角色头像 + 面板 + 按住录音
- [ ] 逐字上屏的草稿回退/差分（后续拓展；当前 partial 全量替换）
- [ ] 全局置顶原生 overlay（Electron/Tauri）
- [ ] MiniMax / 阿里 TTS、本地/云 ASR
- [ ] 把 core/tts/asr/ui vendor 进整合包，迁移 Linux 的打包与配置清单
