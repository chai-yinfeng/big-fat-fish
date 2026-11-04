# Companion Service：独立业务与可替换适配

## 产品与依赖方向

本仓库是独立 Git 项目，不属于 DSH 实现 checkout。发行根是 Node 服务产物，嵌套的 capability-bundle 是可选 DSH 接入包；不以 DSH 创造模式拥有世界或人格。

```text
Authority（世界/实体/身份/人格/记忆，唯一SQLite writer）
        ↑                     ↑
Conversation port       scoped content port
        ↑                     ↓
QQBridge               media / speech / vision / web
        ↓                     ↓
注入 Executor          opaque artifacts、机器感知、待发送parts
        ↓                     ↓
integrations/dsh       QQ delivery adapter → 实际回执
```

当前默认 Executor 仍是 DSH，自有 session/Agent/tool loop 经过 pi-ai 模型适配器调用 DeepSeek。pi-ai 不是整个 DSH loop。可以另接 Pi agent-core、AI SDK 等成熟循环，但不能把替换后端说成只改一个 import：会话持久化、取消、预算与原文清理仍需满足现有契约。

## 实际源码边界

- `authority/`：独立 canonical service、规则审核、实体/人/受众与来源约束。没有 Cordis、DSH Session、QQ SDK 或供应商 SDK 依赖。
- `core/src/persona.js`、`core/src/util.js`：当前 Authority 复用的纯数据逻辑；其它旧 core 不是新服务的第二权威。
- `capabilities/conversation/`：纯会话与文本执行契约；执行器 duck-typed 注入，不包含 session/create 等 DSH RPC。
- `integrations/dsh/`：DSH 会话执行、Web RPC 传输。默认装配会选择它，不把它塞回业务规则。
- `capabilities/dsh/`：DSH Host 插件适配、当前 turn 与来源验证、两个受限模型工具。它是集成层，不是本体。
- `capabilities/qq/bridge.js`：认证私聊的串行入口、去重、epoch、投递回执；不导入 DSH backend。QQ main 是显式选择执行 backend 的应用装配点。
- `capabilities/media/`：文件引用、ACL、来源派生、感知/合成/附件表达；不解析 OneBot 字段。平台原生表情描述是 opaque 数据，仅所属渠道解释。
- `capabilities/speech/`：纯本地文件 ASR/TTS provider，单请求只跑选中引擎。无麦克风、音箱、虚拟声卡、声纹身份或实时直播假设。
- `model-gateway/`：固定供应商出口、私有 Key、取消与有界预算；不拥有实体/人格/记忆。新增视觉与网页仍经 Authority 作用域授权后使用。
- [console](<console/README.md>)：0.10共享视图同时构建独立网页与旧DSH兼容入口。独立管理页由operator同源入口提供，不需要DSH boot/slots/session RPC；世界状态、受控参数与授权参考管理已交付。Live2D/房间视觉仍未实施，对话执行也仍默认DSH适配，不能把管理页独立夸成全运行时替换。
- `plugin/`、`adapter-plugin/`、旧 `voice-runtime/` 等保留源码，未重新发行/启用。根默认 test 指向当前产品，旧检查只在显式 legacy 脚本中。

目录调整只做真实边界需要的移动，没有批量搬迁或删除历史源文件。

## 媒体不是平台动作

```ts
speech.transcribe({inputFile, quality}) -> attributed transcript
speech.synthesize({text, outputFile, quality, voiceProfile}) -> WAV metadata
vision.inspect(imageRef) -> attributed description
web.search(query) / web.read(url) -> bounded external content
channel.deliver(parts) -> sent / failed / unknown receipts
```

文件路径只存在于可信 Host/provider 接口。模型使用的是绑定 entity/person/stream/audience 的 opaque MediaRef，不能选择路径、QQ号、平台凭据、entity 或 requestId。Authority 在私有 content socket 前后检查当前绑定/epoch/暂停版本，模型不拿到 content-control 凭据。

QQ 收语音：认证消息 → get_record 转 WAV → MediaRef → 本地 ASR → 明确机器转写的执行上下文。QQ 发语音：最终回复文本 → 本地 TTS 文件 → QQ adapter 提交 record → 成功回执才记录已发送；不调用服务器的录音或播放设备。图片与表情也由 adapter 下载/封装，不把容器路径交给业务模型。

默认文字，用户明确要求才合成语音。本地失败不自动上传云，不默认轻重双跑。Qwen Base 重 TTS 使用 Kokoro 生成的固定合成参考；不从用户 QQ 语音提取音色，不开放真人声音克隆。

## 来源与保留

ASR/OCR/视觉描述不是真人逐字输入。只有附件时 Core 原观察保留平台占位和 origin:attachment；机器文字只进入执行上下文，不能凭占位生成真人事实/经历/appraisal。真人文字确认可成为新的普通证据。自述笔记仍是自述，不是对他人的独立核验。

自管原件缓存默认七个真实日；聊天转写并不因此自动全部删除。自然记忆衰减仍按世界时间。明确忘记按原始事件删除自管文件及下游描述/转写，停 content/SDK/QQ writers 后清原始执行与临时音频；不删除无关资料、合成参考、QQ登录卷。不宣称能清掉平台客户端/供应商/外部导出的所有副本。

## CPU 与预算

- 默认轻档：SenseVoice int8 ASR，Kokoro v1.1-zh int8 TTS。
- 按需重档：Qwen3-ASR 0.6B sherpa int8；Qwen3-TTS 1.7B Base Q4 + Q8 mmproj，通过 CPU-only llama.cpp。后者是待验证的较新集成，不把 runtime 成熟性冒充完整 TTS 生产保证。
- 单本地任务串行子进程，用完退出；轻 ASR ≤120秒，重 ASR ≤30秒，合成 ≤120字。不同时常驻四个模型。
- 重模型默认 disabled，显式 CPU 基准通过才可准入；文件已下载、编译完成、基准通过、真人试听是不同状态。
- content 用户服务限 2 核/4GiB，不修改全局 GPU/Node/PATH。实际延迟、内存和音质不能由模型大小推测，需实测记录。
- Flash 视觉默认512缩图/动图首帧；网页仅公网 search/fetch，无登录cookies或点击购买。默认全产品每UTC日 vision12/web20次，先预留，失败也占；不暗示免费。
- 两个模型工具的 schema 在同一4chars/token估计下比旧 memory-only 增252 tokens；不等于 provider 实测，也不代表总上下文只这些 tokens。

实际安装、CPU数据、QQ编解码与发送验收应另附记录，不能用本机 synthetic tests 代替。
