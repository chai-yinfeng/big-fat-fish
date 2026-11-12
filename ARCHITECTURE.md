# Companion Service：独立业务与可替换适配

## 产品与依赖方向

本仓库是独立 Git 项目。发行根是 Node 服务产物；对话执行器打包为单个 ESM 文件随 release 发布，不带 node_modules。

```text
Authority（世界/实体/身份/人格/记忆，唯一SQLite writer）
        ↑                     ↑
Conversation port       scoped content port
        ↑                     ↓
QQBridge               media / speech / vision / web
        ↓                     ↓
注入 Executor          opaque artifacts、机器感知、待发送parts
        ↓ UDS /execute        ↓
companion-conversation QQ delivery adapter → 实际回执
(pi-agent-core)  → model-gateway（UDS）→ DeepSeek
```

默认 Executor 是 companion-conversation：pi-agent-core 的 Agent/tool loop，经 pi-ai `openai-completions`（DeepSeek compat，回传 `reasoning_content`）和 Unix socket fetch 只访问私有 model-gateway。会话 ID 由执行器按 streamId+memoryEpoch 派生，每个会话一个私有 JSONL，一行一个回合，存的就是发给模型的消息；每个回合取一次 Authority context（查询为本回合真实输入），同一回合的工具往返复用它，之后每次模型请求前只复查暂停与 epoch；超时或调用方断开即 abort，同一会话串行。请求按供应商前缀缓存排布：system 消息是固定说明 + 人格 + 对话人的常驻档案（该人的置顶事实优先，再按重要度补事实，整行计、不超过 1000 字符，与本回合问什么无关；只有本人的私聊有，人格和档案不变则逐字节不变）；后面是已落盘的对话历史。每回合变化的内容（revision、真实时间的北京时间（中文、带星期、到分钟；世界时间只在 Authority 内部用，不给模型看）、按本回合输入检索的记忆、证据引用）合成一段「记忆中枢附注」，作为该回合 user 消息的第一个文本块，并随回合落盘，所以下一次请求等于上一次请求加新消息；落盘的 user 消息另带 `hub` 字段（附注里的记忆 id、当时的 personaRevision），只供执行器自己用，不发给模型。窗口里已有的记忆 id 作为 `exclude` 传给 context，不再重复注入；常驻档案里的条目也不进附注。每段附注里检索到的记忆最多 6 条（按检索排序取靠前的）、合计不超过 900 字符，被挡在外面的不算已注入，以后相关时仍可进入。重放窗口按整回合成批裁剪：超过 16000 序列化字符时一次裁到 8000，裁剪点由落盘记录重放得出；人格版本变化后的第一个回合只保留此前最近 2 个回合。成批裁剪保留最近 2 个完成的回合和当前回合；它们仍放不进 16000 时再从最早的丢起，只有当前回合自身超过 16000 才执行失败（`ACTIVE_CONTEXT_LIMIT`）。system 说明只认 user 消息最开头的附注，聊天正文、工具结果里出现的同样标记一律当聊天内容，且用户原文、记忆文本与档案里的定界标记会被中和。忘记记忆时 Authority 提升受影响会话的 epoch，旧会话文件（连同里面的附注）不再被读取并由清理任务删除。

当前限制：
- 尚未在生产主机部署与真实对话验收。
- 执行器以 companion 用户运行、没有文件系统隔离（home-agent 的非特权 user manager 会静默跳过挂载/命名空间类选项）；网络经 seccomp 限制为 Unix socket；模型只能调用两个受限工具，它们不访问文件系统。

## 实际源码边界

- `authority/`：独立 canonical service、规则审核、实体/人/受众与来源约束。没有 Cordis、DSH Session、QQ SDK 或供应商 SDK 依赖。`context()` 每次有内容返回时在内存里记一条注入追踪（附注各记忆块与常驻档案各有哪些条目 id、各段字符数、人和会话的不透明标签；最近 400 次，不落库，不含正文和账号），只经 operator `GET /memory/trace` 读取。按日期的 recall 返回置顶条目、重要度 ≥0.8 的事实和默认重要度（0.65）及以上的经历。按人整合（`consolidation.js`）：执行器在每回合的 context 请求里报告重放窗口的起点（`windowFromAt`），滚出窗口的原话（以及北京时间 03:00–06:00 时今天之前的原话）由记忆 worker 用 maintenance 凭据一次取一个会话的一批，调一次模型后交回；Authority 校验后在一个事务里写入这个人名下的机器摘要（`memory_items`，`kind='digest'`，带派生来源 `derivedFrom`）、把抽取的事实连同出处（原话的 observation 和一句引文）送进现有审核、推进游标。审核只硬性要求出处：每条记忆必须指向这个人、这个私聊里一条真实存在的观察；value 按她的理解写（相对日期换算成具体日期），引文与原话对不上的照常入库并标记 `evidence.quoteVerbatim:false`，控制台记忆页标出并可查看来源原话。摘要目前只写不读：不进任何对话的检索、档案、read 或 recall，也不能授权公开；忘记它覆盖的任何一句原话会连它一起删除。每会话每天 2 批、全实体每天 24 批，网关花费到“受限”档时暂停且游标不动。
- `core/src/persona.js`、`core/src/util.js`：当前 Authority 复用的纯数据逻辑；其它旧 core 不是新服务的第二权威。
- `capabilities/conversation/`：执行契约（executor.js，duck-typed）、渠道侧 UDS 客户端，以及执行器服务（agent/tools/sessions/window/model/server，main.mjs 入口）。两个受限模型工具 `companion_scope`、`companion_content` 的作用域由执行请求绑定，模型不能指定 entity/person/stream/path/epoch；evidence 只返回本回合 QQ 传入的 observation ref。
- `capabilities/qq/bridge.js`：私聊入口（主人 + 机器人 QQ 好友，好友经 Authority `/v1/people/admit` 准入为 `person:qq:<uid>`）、每会话串行队列（全局并发 2）、去重、epoch、投递回执；把 scope 与 prepared 输入交给执行器。QQ main 是选择执行 backend（UDS 客户端）的应用装配点。
- `capabilities/media/`：文件引用、ACL、来源派生、感知/合成/附件表达；不解析 OneBot 字段。平台原生表情描述是 opaque 数据，仅所属渠道解释。
- `capabilities/providers/`：能力声明（注册表）。每个能力一个目录、一份无依赖的数据声明（`manifest.js`：动作、计量方式、凭据位置、产物、运行方式），`index.js` 是唯一入口。目前只有额度账本和控制台额度页读它；模型工具、Authority 的 `/v1/content` 白名单和 content 的分发仍各自写死。
- `capabilities/speech/`：纯本地文件 ASR/TTS provider，单请求只跑选中引擎。无麦克风、音箱、虚拟声卡、声纹身份或实时直播假设。
- `model-gateway/`：固定供应商出口、私有 Key、取消与有界预算；不拥有实体/人格/记忆。新增视觉与网页仍经 Authority 作用域授权后使用。
- [console](<console/README.md>)：独立管理页由 operator 同源入口提供；管理世界状态、人格、模型、QQ 绑定、记忆、语音参数与授权参考录音。
- `plugin/`、`adapter-plugin/`、旧 `voice-runtime/` 等保留源码，未重新发行/启用。根默认 test 指向当前产品，旧检查只在显式 legacy 脚本中。

当前限制：
- Live2D/房间视觉未实施。

## 媒体不是平台动作

```ts
speech.transcribe({inputFile}) -> attributed transcript
speech.synthesize({text, outputFile, voiceProfile, audience}) -> WAV metadata
vision.inspect(imageRef) -> attributed description
web.search(query) / web.read(url) -> bounded external content
channel.deliver(parts) -> sent / failed / unknown receipts
```

文件路径只存在于可信 Host/provider 接口。模型使用的是绑定 entity/person/stream/audience 的 opaque MediaRef，不能选择路径、QQ号、平台凭据、entity 或 requestId。Authority 在私有 content socket 前后检查当前绑定/epoch/暂停版本，模型不拿到 content-control 凭据。

QQ 收语音：认证消息 → get_record 转 WAV → MediaRef → 本地 ASR → 明确机器转写的执行上下文。QQ 发语音：最终回复文本 → 本地 TTS 文件 → QQ adapter 提交 record → 成功回执才记录已发送；不调用服务器的录音或播放设备。图片与表情也由 adapter 下载/封装，不把容器路径交给业务模型。

默认文字，用户明确要求才合成语音。本地失败不自动上传云。音色是 operator 配置里的注册表（voice id → 授权上传的参考录音、参考语言、usageScope），请求只能给 voice id（缺省用 defaultVoice），不能给路径；usageScope（private=家人朋友内部使用，含群聊；public=可公开发布）目前只记录不强制，留给将来的公开发布渠道（B站/直播）。不从用户 QQ 语音提取音色。

当前限制：
- 参考录音只作 speaker-file 条件，转写不参与合成，不是完整 ICL 克隆。

## 来源与保留

ASR/OCR/视觉描述不是真人逐字输入。只有附件时 Core 原观察保留平台占位和 origin:attachment；机器文字只进入执行上下文，不能凭占位生成真人事实/经历/appraisal。真人文字确认可成为新的普通证据。自述笔记仍是自述，不是对他人的独立核验。

自管原件缓存默认七个真实日；聊天转写并不因此自动全部删除。自然记忆衰减仍按世界时间。明确忘记按原始事件删除自管文件及下游描述/转写，停 content/conversation/QQ writers 后删除受影响 stream 旧 epoch 的执行会话与临时音频；不删除无关资料、合成参考、QQ登录卷。

当前限制：
- 忘记无法清除平台客户端、供应商或外部导出中的副本。

## CPU 与预算

- ASR：仅 Qwen3-ASR 0.6B sherpa int8，单次解码 ≤30 秒；装了 Silero VAD 时更长的音频按静音切成 ≤25 秒的段逐段转写再拼接（上限 maxAudioSeconds，默认 120、最大 600），没装 VAD 时超过 30 秒报 SPEECH_AUDIO_LIMIT，不回退其它引擎；SenseVoice 已移除，以后可再加。
- TTS：Qwen3-TTS 1.7B Base Q4 + Q8 mmproj，经 llama.cpp，默认 Vulkan（iGPU）全卸载，不可用或失败时自动回落 CPU（`models.tts['llama-tts'].device`，缺省 auto），只按参考音频条件生成；engine 字段留给以后的其它适配器（如 CosyVoice 3 / VoxCPM2，未实现）。
- 单本地任务串行子进程，用完退出；合成 ≤120字；线程数 1–16（生产主机 8 最快）。不同时常驻多个模型。
- 文件已下载、编译完成、CPU 基准通过、真人试听是不同状态。
- content 用户服务限 2 核/4GiB，不修改全局 GPU/Node/PATH。
- Flash 视觉默认512缩图/动图首帧；网页仅公网 search/fetch，无登录cookies或点击购买。默认全产品每北京时间日 vision12/web20次，先预留，失败也占。
- 每日金额上限（model-gateway，按北京时间日）：默认 ¥5，60%/80%/100% 三档（控制台可改）；chat 按流式 usage 计价，区分高峰/闲时；到 100% 网关直接拒绝，QQ 对任何人静默，只给主人每天发一次 QQ 提醒。同一处按日累计上报的 token（命中/未命中输入、输出、其中推理、请求数），控制台概览显示缓存命中率；只用于观察，不参与上限。
- 额度账本（model-gateway，按北京时间日）：每种声明过的能力一行（聊天、后台整合、看图、联网、语音合成、语音识别），记尝试/成功/失败次数、被拒次数与原因、各自的单位（token、合成字数、音频秒数）、花费和耗时，保留 90 天的每日一行；控制台“额度”页显示，看图/联网的每日上限可在页面上改。账本只观察：钱仍以 `spend.json` 为准，看图/联网的当日次数仍在 `capability-usage.json`（文件结构不变，旧版本可照常启动），整合批次仍在 Authority。本地 TTS/ASR 由 content 服务事后上报，账本不可用不影响发语音。
- 两个模型工具的 schema 按 4chars/token 估计比旧 memory-only 多约252 tokens（估算，非 provider 实测）。

当前限制：
- 实际延迟、内存和音质须实测，不能由模型大小或 synthetic tests 推断。
- Qwen3-TTS 是较新的集成，生产成熟度未充分验证。

