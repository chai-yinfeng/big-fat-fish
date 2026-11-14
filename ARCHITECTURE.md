# Companion Service：独立业务与可替换适配

## 产品与依赖方向

本仓库是独立 Git 项目。发行根是 Node 服务产物；对话执行器打包为单个 ESM 文件随 release 发布，不带 node_modules。

```text
Authority（世界/实体/身份/人格/记忆，唯一SQLite writer）
        ↑                     ↑
Conversation port       scoped content port
        ↑                     ↓
渠道桥（QQBridge…）    media / speech / vision / web
        ↓                     ↓
注入 Executor          opaque artifacts、机器感知、待发送parts
        ↓ UDS /execute        ↓
companion-conversation QQ delivery adapter → 实际回执
(pi-agent-core)  → model-gateway（UDS）→ DeepSeek
```

默认 Executor 是 companion-conversation：pi-agent-core 的 Agent/tool loop，经 pi-ai `openai-completions`（DeepSeek compat，回传 `reasoning_content`）和 Unix socket fetch 只访问私有 model-gateway。会话 ID 由执行器按 streamId+memoryEpoch 派生，每个会话一个私有 JSONL，一行一个回合，存的就是发给模型的消息；每个回合取一次 Authority context（查询为本回合真实输入），同一回合的工具往返复用它，之后每次模型请求前只复查暂停与 epoch；超时或调用方断开即 abort，同一会话串行。请求按供应商前缀缓存排布：system 消息是固定说明 + 渠道段（见“渠道、身份与记忆的归属”）+ 人格 + 对话人的常驻档案（该人的置顶事实优先，再按重要度补事实，整行计、不超过 1000 字符，与本回合问什么无关；只有本人的私聊有，人格和档案不变则逐字节不变）；后面是已落盘的对话历史。每回合变化的内容（revision、真实时间的北京时间（中文、带星期、到分钟；世界时间只在 Authority 内部用，不给模型看）、按本回合输入检索的记忆、证据引用）合成一段「记忆中枢附注」，作为该回合 user 消息的第一个文本块，并随回合落盘，所以下一次请求等于上一次请求加新消息；落盘的 user 消息另带 `hub` 字段（附注里的记忆 id、当时的 personaRevision），只供执行器自己用，不发给模型。窗口里已有的记忆 id 作为 `exclude` 传给 context，不再重复注入；常驻档案里的条目也不进附注。每段附注里检索到的记忆最多 6 条（按检索排序取靠前的）、合计不超过 900 字符，被挡在外面的不算已注入，以后相关时仍可进入。重放窗口按整回合成批裁剪：超过 16000 序列化字符时一次裁到 8000，裁剪点由落盘记录重放得出；人格版本变化后的第一个回合只保留此前最近 2 个回合。成批裁剪保留最近 2 个完成的回合和当前回合；它们仍放不进 16000 时再从最早的丢起，只有当前回合自身超过 16000 才执行失败（`ACTIVE_CONTEXT_LIMIT`）。system 说明只认 user 消息最开头的附注，聊天正文、工具结果里出现的同样标记一律当聊天内容，且用户原文、记忆文本与档案里的定界标记会被中和。忘记记忆时 Authority 提升受影响会话的 epoch，旧会话文件（连同里面的附注）不再被读取并由清理任务删除。 她先开口的回合（`input.initiated`，只由渠道设置，模型不能）没有对方的消息：渠道给的文字作为事件块（开头是 `[后台事件 · 这不是对方发来的话]`）放在 user 消息里附注之后，附注里多一行说明这一条不是对方发来的、不想说就只回复 `<不说>`；system、工具定义和落盘格式都不变，所以它之前和之后的请求仍然互为前缀。这类回合的模型请求带 `x-companion-run: initiated` 请求头，网关记到 `proactive` 类别。

## 渠道、身份与记忆的归属

渠道（QQ，以后的微信小号、由外部操作官方客户端的渠道）只是适配器；人、记忆、人格属于 Authority，不属于任何渠道。

- **渠道端口**：一个渠道 = Authority 里一个 `conversation.v1` capability（id 即渠道 id，生产只有 `qq`）+ 一个桥。桥只走两个入口：
  用本渠道的凭据调 Authority capability API（observe / context / admit / initiations），和调一个对话执行器的 `/execute`。
  Authority 的 actors、streams、observations 都以 capability 为键，所以一个渠道的凭据读不到、也触达不了另一个渠道的会话。
  执行器持有它所服务渠道的那一个凭据（生产是 QQ 的）；再接一个渠道时给它单独起一个执行器实例（staging 的第二渠道就是这样跑的）。
- **渠道说明书**（`capabilities/channels/`，单入口 `index.js`，每个渠道一份无依赖的静态声明）：能否发语音/图片/小表情、长回复是否拆条、
  有没有好友关系及账号名的形状、平台回执是否可靠（不可靠的渠道沿用“状态不明不重发”）、系统提示里的“渠道段”、桥每回合可加的固定策略行。
  它只是说明：读它的是 Authority（准入是否允许、控制台渠道列表）、执行器（渠道段）和桥（策略行）。`mock` 是只给测试和 staging 用的渠道：
  配置里出现它而没有 `operator.allowTestChannels: true` 时 Authority 拒绝启动、部署预检拒绝部署，发行包里也没有它的桥。
- **系统提示里的渠道段**：`BASE_PROMPT` 不提任何渠道。执行器按 Authority 在 context 里给出的 `capabilityId` 取该渠道声明里的固定文字，
  放在固定说明和人格之间（system = 固定说明 + 渠道段 + 人格 + 常驻档案）；同一渠道每次逐字节相同、不超过 600 字符，请求里没有任何字段能改它。
- **身份**：人由绑定推出（`actors`：渠道 + 账号 → 人；没有 persons 表）。人的名字（`person:owner`、`person:qq:<uid>`、`person:<渠道>:<账号>`）
  只是不透明的名字，任何代码都不从它的前缀读含义；“是不是主人”只与 `person:owner` 整体比较。准入上限按不同的人计。
- **记忆按人共用，对话按渠道分开**：事实、常驻档案、关系、机器摘要（以及将来的日记素材）挂在人上，这个人在哪个渠道都一样；
  原话（observations）、执行器会话与重放窗口、整合游标、会话代次挂在“某渠道上的那段对话”（stream）上。同一个人在两个渠道 = 两段对话、一份长期记忆；
  忘记这个人的一条私有记忆会重开他在所有渠道上的会话。
- **准入**只属于声明了好友关系的渠道（国内就是 QQ 和微信这一类）：桥判断好友关系，并用渠道自己的说法给出账号、actor 和会话的标识，
  Authority 只要求它们在该渠道的命名空间里（以 `<渠道 id>:` 开头）、字符集朴素、长度有界。没有好友关系的渠道不能准入，人由操作员绑定。
- **认成同一个人**只能由操作员做（控制台“人与会话”页，operator `POST /people/attach`）：把某渠道的一个账号连同它的私聊会话挂到已存在的人身上；
  一个账号不会同时属于两个人，改挂必须显式（`move:true`），主人的账号不能被改挂；原先那个人名下已记住的事不合并（那需要数据迁移）。
- **她先开口**发到“这个人最近说过话的那段私聊”（按 Authority 收到的先后；从没说过话则取最后绑定的那段）；每个渠道的桥只能取到、也只能回报
  发往自己渠道的请求，桥仍然不能指名任何会话或人。后台任务的结果只在登记它的那段对话所在的渠道上告诉登记人。

当前限制：
- 渠道说明书里的表达能力（语音/图片/拆条）目前只是声明：QQ 桥的发送路径仍按自己的实现走，没有由声明驱动。
- 控制台只有 QQ 有接入配置卡片（`/qq`，绑定主人）；别的渠道的主人账号用“认成同一个人”挂到主人身上。
- 执行器以 companion 用户运行、没有文件系统隔离（home-agent 的非特权 user manager 会静默跳过挂载/命名空间类选项）；网络经 seccomp 限制为 Unix socket；模型只能调用两个受限工具，它们不访问文件系统。

## 实际源码边界

- `authority/`：独立 canonical service、规则审核、实体/人/受众与来源约束。没有 Cordis、DSH Session、QQ SDK 或供应商 SDK 依赖。`context()` 每次有内容返回时在内存里记一条注入追踪（附注各记忆块与常驻档案各有哪些条目 id、各段字符数、人和会话的不透明标签；最近 400 次，不落库，不含正文和账号），只经 operator `GET /memory/trace` 读取。按日期的 recall 返回置顶条目、重要度 ≥0.8 的事实和默认重要度（0.65）及以上的经历。按人整合（`consolidation.js`）：执行器在每回合的 context 请求里报告重放窗口的起点（`windowFromAt`），滚出窗口的原话（以及北京时间 03:00–06:00 时今天之前的原话）由记忆 worker 用 maintenance 凭据一次取一个会话的一批，调一次模型后交回；Authority 校验后在一个事务里写入这个人名下的机器摘要（`memory_items`，`kind='digest'`，带派生来源 `derivedFrom`）、把抽取的事实连同出处（原话的 observation 和一句引文）送进现有审核、推进游标。审核只硬性要求出处：每条记忆必须指向这个人、这个私聊里一条真实存在的观察；value 按她的理解写（相对日期换算成具体日期），引文与原话对不上的照常入库并标记 `evidence.quoteVerbatim:false`，控制台记忆页标出并可查看来源原话。摘要目前只写不读：不进任何对话的检索、档案、read 或 recall，也不能授权公开；忘记它覆盖的任何一句原话会连它一起删除。每会话每天 2 批、全实体每天 24 批，网关花费到“受限”档时暂停且游标不动。
- `core/src/persona.js`、`core/src/util.js`：当前 Authority 复用的纯数据逻辑；其它旧 core 不是新服务的第二权威。
- `capabilities/conversation/`：执行契约（executor.js，duck-typed）、渠道侧 UDS 客户端，以及执行器服务（agent/tools/sessions/window/model/server，main.mjs 入口）。两个受限模型工具 `companion_scope`、`companion_content` 的作用域由执行请求绑定，模型不能指定 entity/person/stream/path/epoch；evidence 只返回本回合 QQ 传入的 observation ref。
- `capabilities/qq/bridge.js`：QQ 渠道的桥。私聊入口（主人 + 机器人 QQ 好友，好友经 Authority `/v1/people/admit` 准入，桥给出账号和 QQ 自己的 actor/会话标识，新的人被命名为 `person:qq:<uid>`）、每会话串行队列（全局并发 2）、去重、epoch、投递回执；把 scope 与 prepared 输入交给执行器。QQ main 是选择执行 backend（UDS 客户端）的应用装配点。 已连接、已登录时每 60 秒（`qq-bridge.json` 可选 `initiationPollMs`）向 Authority 取一个她先开口的回合（`/v1/initiations/next`，见 PROTOCOL.md；Authority 只把发往 QQ 的请求交给 QQ 桥）：发送目标只从 Authority 给的会话号解析，本版本必须是机器人与主人的私聊，否则丢弃；在该会话自己的队列里跑一个没有用户消息的回合，回复照常拆条、每条等平台回执，失败或状态不明即停、不重发，回复含 `<不说>` 则什么都不发；每个回合的结果只回报一次，重启后“发送中”的记为状态不明。后台任务做完后的 `completion` 回合走同一条路，目标是登记任务的那个人的私聊（主人或仍是好友的人），结果正文由桥在该会话的作用域里向内容服务读取；每个普通回合开始前桥先问 Authority 这个会话有没有待通知的结果（`/v1/initiations/carry`），有就作为事件块附在对方的话后面交给执行器（`input.event`），回报 `carried`，她不再为它另开口。
- `capabilities/media/`：文件引用、ACL、来源派生、感知/合成/附件表达；不解析 OneBot 字段。平台原生表情描述是 opaque 数据，仅所属渠道解释。后台任务（`jobs.js`）：在 Authority 给出的作用域里登记，记录存 `media-data/jobs.json`（原子写，不进数据库）；一次跑一个，排队上限 8、每人 2 个；阶段时限加总截止时间；可让步的任务每一片开始前等到没有及时请求（走 `/content` 的同步请求和控制台试听）在排队或执行；暂停时放回队列，重启后重排一次。结果留在内容服务，由 Authority 经控制口 `/jobs` 来问、来回报通知结果，内容服务不调 Authority。目前唯一的任务是演示任务（`demo-job.js`，等几秒返回固定文本），只能由控制台登记。
- `capabilities/channels/`：渠道说明书（见“渠道、身份与记忆的归属”）。`qq` 的声明里有小表情名单（发送默认关闭时为空）、系统提示的 QQ 段和“这次回复会用语音发出”的策略行；`mock` 只用于测试与 staging。
- `capabilities/providers/`：能力声明（注册表）。每个能力一个目录、一份无依赖的数据声明（`manifest.js`：动作、计量方式、凭据位置、产物、运行方式），`index.js` 是唯一入口。目前只有额度账本和控制台额度页读它；模型工具、Authority 的 `/v1/content` 白名单和 content 的分发仍各自写死。`demo` 是演示用的后台任务，不是模型能调用的能力。
- `capabilities/speech/`：纯本地文件 ASR/TTS provider，单请求只跑选中引擎。无麦克风、音箱、虚拟声卡、声纹身份或实时直播假设。
- `model-gateway/`：固定供应商出口、私有 Key、取消与有界预算；不拥有实体/人格/记忆。所有付费 Key 都只在这里：DeepSeek 之外的供应商各写一个适配模块（`providers/`，本版本一个都没有），Key 在控制台录入、存 `providers.json`，调用统一走 提交/查询/取回 三个动作并计入花费与额度账本。新增视觉与网页仍经 Authority 作用域授权后使用。
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

QQ 收语音：认证消息 → get_record 转 WAV → MediaRef → 本地 ASR → 明确机器转写的执行上下文。QQ 发语音：最终回复文本 → 本地 TTS 文件 → QQ adapter 提交 record → 成功回执才记录已发送；不调用服务器的录音或播放设备。图片与表情也由 adapter 下载/封装，不把容器路径交给业务模型。QQ 桥把“是不是表情包、商城表情叫什么”归一成两个内部字段（来自 NapCat 专有的 `sub_type`/`emoji_id`/`summary`，没有时按普通图片）；内容服务只认这两个字段和图片哈希，按哈希记“这张图是什么”（`media-data/describe-cache.json`，所有人共用、不记发送者），同一张图只看一次；第一次看一张表情包占账本“表情识别”一行，不占看图的每日次数。她自己的表情库也在内容服务（`media-data/stickers/`，JSON 索引 + 文件，不进 Authority 数据库），属于她、不属于某个人；目前只有主人在自己私聊里说“收下这个”能往里加（内容服务按作用域再核一次）。她回复里的 `[表情:词]` 由 QQ 桥取出，内容服务按标签字词重合度匹配，表情包作为最后单独一条消息、各有回执；语音回合不发，她先开口的回合丢弃标记。忘记来源消息时清理任务连库里的条目一起删。QQ 自带小表情（OneBot 标准 `face` 段）只在 QQ 桥里换算（`capabilities/qq/faces.js`，116 个编号↔名字）：收到时按原位置写成 `[微笑]` 进文字、不算附件；发送默认关闭（主人决定，带括号的情绪动作比小黄脸好）：QQ 渠道说明书的 `expression.faces` 为 false，系统提示里不教她写，她写了 `[微笑]` 也原样当文字发；把说明书里的 `FACES` 改成 true 才会把表内精确匹配的 `[名字]` 换成同一条消息里的 `face` 段（每条最多 3 个）。语音合成前去掉表内标记；记录保留她写的文字。

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
- 每日金额上限（model-gateway，按北京时间日）：默认 ¥5，60%/80%/100% 三档（控制台可改）；chat 按流式 usage 计价，区分高峰/闲时；到 100% 网关直接拒绝，QQ 对任何人静默，只给主人每天发一次 QQ 提醒。同一处按日累计上报的 token（命中/未命中输入、输出、其中推理、请求数），控制台概览显示缓存命中率；只用于观察，不参与上限。 她先开口的回合记在 `proactive` 类别，到 60% 档（reduced）就在联系供应商之前被拒，普通回复不受影响；这时不给主人发提醒。
- 额度账本（model-gateway，按北京时间日）：每种声明过的能力一行（聊天、后台整合、看图、表情识别、联网、语音合成、语音识别、主动开口），记尝试/成功/失败次数、被拒次数与原因、各自的单位（token、合成字数、音频秒数）、花费和耗时，保留 90 天的每日一行；控制台“额度”页显示，看图/联网的每日上限可在页面上改。账本只观察：钱仍以 `spend.json` 为准，看图/联网的当日次数仍在 `capability-usage.json`（文件结构不变，旧版本可照常启动），整合批次仍在 Authority。本地 TTS/ASR 由 content 服务事后上报，账本不可用不影响发语音。
- 两个模型工具的 schema 按 4chars/token 估计比旧 memory-only 多约252 tokens（估算，非 provider 实测）。

当前限制：
- 实际延迟、内存和音质须实测，不能由模型大小或 synthetic tests 推断。
- Qwen3-TTS 是较新的集成，生产成熟度未充分验证。

