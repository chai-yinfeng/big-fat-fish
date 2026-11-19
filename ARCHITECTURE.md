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

默认 Executor 是 companion-conversation：pi-agent-core 的 Agent/tool loop，经 pi-ai `openai-completions`（DeepSeek compat，回传 `reasoning_content`）和 Unix socket fetch 只访问私有 model-gateway。会话 ID 由执行器按 streamId+memoryEpoch 派生，每个会话一个私有 JSONL，一行一个回合，存的就是发给模型的消息；每个回合取一次 Authority context（查询为本回合真实输入），同一回合的工具往返复用它，之后每次模型请求前只复查暂停与 epoch；超时或调用方断开即 abort，同一会话串行。请求按供应商前缀缓存排布：system 消息是固定说明 + 渠道段（见“渠道、身份与记忆的归属”）+ 人格 + 对话人的常驻档案（该人的置顶事实优先，再按重要度补事实，整行计、不超过 1000 字符，与本回合问什么无关；只有本人的私聊有，人格和档案不变则逐字节不变）；后面是已落盘的对话历史。每回合变化的内容（revision、真实时间的北京时间（中文、带星期、到分钟；世界时间只在 Authority 内部用，不给模型看）、接续块、按本回合输入检索的记忆、证据引用）合成一段「记忆中枢附注」，作为该回合 user 消息的第一个文本块，并随回合落盘，所以下一次请求等于上一次请求加新消息；落盘的 user 消息另带 `hub` 字段（附注里的记忆 id、当时的 personaRevision），只供执行器自己用，不发给模型。窗口里已有的记忆 id 作为 `exclude` 传给 context，不再重复注入；常驻档案里的条目也不进附注。每段附注里检索到的记忆最多 6 条（按检索排序取靠前的）、合计不超过 900 字符，被挡在外面的不算已注入，以后相关时仍可进入。机器摘要读回（只在本人的私聊）：滚出窗口的对话整合成的摘要有两条路回到附注里，都标明“机器整理，不是原话”，都不进 system。①接续块：Authority 随 context 另外返回这个人最新的 2 段摘要（整段计、连标题合计不超过 800 字符，带摘要和她当时的感受，在上面 900 字符之外单独计），附注里排在时间之后、检索记忆之前；②检索：更早的摘要按本回合输入参与检索，在附注里单独一块，只有摘要正文，受同样的 6 条 / 900 字符上限。两条路都只给“覆盖的对话结束时间早于本回合重放窗口起点”的摘要（原话还在窗口里就不给；请求里没报窗口起点也不给），id 和其它记忆一样记进 `hub.memoryIds`，所以同一个窗口里只出现一次。重放窗口按整回合成批裁剪：超过 16000 序列化字符时一次裁到 8000，裁剪点由落盘记录重放得出；人格版本变化后的第一个回合只保留此前最近 2 个回合。成批裁剪保留最近 2 个完成的回合和当前回合；它们仍放不进 16000 时再从最早的丢起，只有当前回合自身超过 16000 才执行失败（`ACTIVE_CONTEXT_LIMIT`）。system 说明只认 user 消息最开头的附注，聊天正文、工具结果里出现的同样标记一律当聊天内容，且用户原文、记忆文本与档案里的定界标记会被中和。忘记记忆时 Authority 提升受影响会话的 epoch，旧会话文件（连同里面的附注）不再被读取并由清理任务删除。 她先开口的回合（`input.initiated`，只由渠道设置，模型不能）没有对方的消息：渠道给的文字作为事件块（开头是 `[后台事件 · 这不是对方发来的话]`）放在 user 消息里附注之后，附注里多一行说明这一条不是对方发来的、不想说就只回复 `<不说>`；system、工具定义和落盘格式都不变，所以它之前和之后的请求仍然互为前缀。这类回合的模型请求带 `x-companion-run: initiated` 请求头，网关记到 `proactive` 类别。 思考开关（“T 步”）：执行器按回合选思考（`agent.js` `thinkingFor`）：日常聊天跟世界设置走（Authority metadata 键 `conversation.settings` 的 `chatThinking`，默认关，随每次 context 返回，控制台“日常聊天的思考”卡片 `POST /conversation/settings` 修改，不用暂停）；她先开口的回合、带后台事件（`input.event`）的回合始终开（high）；戳一戳是轻量回合（`input.light`，只由渠道设置，只能跟 `initiated` 一起出现），跟日常聊天的开关走。关思考时 pi-ai 发 `thinking:{type:'disabled'}`，网关照办，否则一律 enabled + high。system 和工具定义不因开关变化，切换只改请求的思考参数。思考原文不落盘：回合内的工具往返照常回传 `reasoning_content`，落盘时去掉 thinking 块，所以后面的回合重放时 `reasoning_content` 为空字符串（pi-ai 的 DeepSeek 规则，开或关思考都带这个字段）。代价：上一回合里带工具调用、开思考的那一步，下一回合重放时 `reasoning_content` 由原文变为空，缓存前缀从那一步起断开一次（只影响那一回合剩下的几条消息；不带工具的回答本来就没进过请求，不受影响）。 送达记录（会话历史感知）：执行器落盘的是她写的文字，实际发出了什么由渠道在投递结束后经同一个 UDS、同一个调用方令牌的 `POST /delivered` 报告（契约在 `capabilities/conversation/executor.js` 的 `validDelivery` / `reportDelivery`，与渠道无关）：按发送顺序每段一项，`kind`（text / voice / sticker / image / attachment）、`status`（sent = 有平台回执；unsent = 没交给平台；unknown = 交了但没有回执，绝不说成已发出），可选 `chars`、`fallback:'voice'`（语音没做成改发的文字）、`marker`（她文字里代表这一段的原样标记）、`description`（渠道手里已有的描述，不为此调用任何模型；`machine:true` 表示是模型写的）、`reason:'none'`（没有可发的）。执行器把它作为会话文件里紧跟该回合的一行（`{v:1, requestId, messages:[], delivery}`，她写的原文不改；不认识这种行的旧版本把它读成没有消息的回合，回退不用处理）存下，只收最新一个回合的、只收一次（否则 `DELIVERY_NOT_CURRENT`）。重放时（`delivery.js`）只写与她写的不一致的地方：整条按原样以文字送达什么都不加；`marker` 原地换成结果（如 `[表情包：一只打哈欠的猫（机器描述）]`、`[表情包：没发出]`，标记本身不保留）；语音、语音退回文字、没发出、状态未知、拆条只送达一部分各加一行 `[送达情况：…]`（每行不超过 60 字）。描述是渠道给的文字：只留一行、去控制字符、方括号改全角、附注定界符中和、截到 40 字。被改写的只有上一回合她的那条回复，它还没出现在任何请求里，所以每个请求仍是上一个请求加新消息；system 和工具定义不变；渲染后的文字照常计入重放窗口的字数。记录只是短期记忆的一部分，随那条消息一起滚出窗口；机器摘要的输入目前仍是 Authority 的 observation，还没有改用它。

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
- 执行器以 companion 用户运行、没有文件系统隔离（home-agent 的非特权 user manager 会静默跳过挂载/命名空间类选项）；网络经 seccomp 限制为 Unix socket；模型只能调用三个受限工具，它们不访问文件系统（看视频时的 yt-dlp 和 ffmpeg 是内容服务的子进程，装了 bubblewrap 就在里面跑，见 `capabilities/providers/video/README.md`）。

## 实际源码边界

- `authority/`：独立 canonical service、规则审核、实体/人/受众与来源约束。没有 Cordis、DSH Session、QQ SDK 或供应商 SDK 依赖。`context()` 每次有内容返回时在内存里记一条注入追踪（附注各记忆块、接续块与常驻档案各有哪些条目 id、各段字符数、查询的词数和每条检索记忆命中的词数、人和会话的不透明标签；最近 400 次，不落库，不含正文和账号），只经 operator `GET /memory/trace` 读取。按日期的 recall 返回置顶条目、重要度 ≥0.8 的事实和默认重要度（0.65）及以上的经历。按人整合（`consolidation.js`）：执行器在每回合的 context 请求里报告重放窗口的起点（`windowFromAt`），滚出窗口的原话（以及北京时间 03:00–06:00 时今天之前的原话）由记忆 worker 用 maintenance 凭据一次取一个会话的一批，调一次模型（开思考，输出上限 4096；被截断的回答不计无效、游标不动，下一拍重试，仍受每会话每天 2 批的预算约束）后交回；Authority 校验后在一个事务里写入这个人名下的机器摘要（`memory_items`，`kind='digest'`，带派生来源 `derivedFrom`）、把抽取的事实连同出处（原话的 observation 和一句引文）送进现有审核、推进游标。审核只硬性要求出处：每条记忆必须指向这个人、这个私聊里一条真实存在的观察；value 按她的理解写（相对日期换算成具体日期），引文与原话对不上的照常入库并标记 `evidence.quoteVerbatim:false`，控制台记忆页标出并可查看来源原话。摘要只读回给本人的私聊，经 context（接续块和附注里的检索，见上文执行器一段；`feeling` 只在接续块和记忆工具里，它出自只含这一个人一段私聊的那次整合调用）和记忆工具（search、read、recall 带上本回合的 `windowFromAt` 时，只返回 id、摘要、感受和北京日期，同样要求覆盖的对话早于窗口起点）：别人的私聊、共享会话和其它 policy 的 capability 拿不到，档案对任何人都不返回摘要，也不能授权公开；忘记它覆盖的任何一句原话会连它一起删除。每会话每天 2 批、全实体每天 24 批，网关花费到“受限”档时暂停且游标不动。她先开口的请求（`initiations.js`）也由 Authority 登记和挑选：来源是控制台“对我试一次”和内容服务里做完、尚未告知的后台任务；状态存在 `metadata`，不改表结构（见 PROTOCOL.md “Initiations”）。
- 日记（`authority/src/diary.js`，不改表结构）：每个北京日一次，一次模型调用写刚结束那一天的私密日记。它只有她和主人看得到，可以写具体的人（用不透明标签 `p-xxxxxx`），接着前几天往下想。第二本是明面日记，见下一条。时机由 Authority 定：03:00 起等夜间整合没有可交出的批次再写，05:00 起不等；worker 没跑的晚上之后补最近 2 个已结束的日子；没有素材的日子不调模型。输入是当天所有人的摘要（≤4500 字符，超出保留置顶和较新的）、她当天的 self 笔记（≤800）、最近两篇私密日记（≤1000）和人格（≤1000），“她自己的材料”一栏留空待私下回合。硬校验只有结构、长度（≤500 字）、`usedIds` 必须出自给出的素材、敏感词（命中则不存，这一天照样算写完）；3 次不合格放弃这一天并记审计。存在现有 `diaries` 表（`kind='private'`，`body.v=2`、`day`、`cardId`、`readDiaryIds`），来源链用 `diary_sources`，位置标记“最后写完的北京日”在 metadata 键 `consolidation` 里、与日记同一事务提交；每次调用算全实体每天 24 批里的一批，网关花费到“受限”档时暂停，00:00–06:00 整合给它留一批。走网关的维护入口：开思考（high），输出上限 4096（含思考），正文长度仍由 Authority 的字数校验把关；回答因长度被截断（`finish_reason: length`）不计入三次无效、不提交，下一拍重试。日记是主观层：每篇记下写它时的人格卡 id，写日记时读的以前的私密日记、摘要里的感受都只取同一张卡的；私密日记只在这里被读回，不进任何对话、不进记忆工具。忘记：摘要被删时用到它的日记整篇删，读过被删日记的日记也删（只走一跳），预览列出将删几篇、其中几篇还含其他内容，并列出“可能仍提到”的日记让主人逐篇决定；日记的忘记做不到彻底（只转述、不含相同词的找不到）。旧的自动私密日记不再生成，已有的保留，控制台标“旧版自动日记”。
- 明面日记（写在 `authority/src/diary.js`，名单、口令和读取在 `authority/src/open-diary.js`；不改表结构）：写给某个人看的日记。名单由主人在控制台管（没改过之前只有主人本人），名单里每个人每个北京日一篇，**每人单独一次模型调用，输入只有这个人自己当天的摘要和（同一张人格卡写的）感受**：没有别人的任何一行，没有她的 self 笔记（里面可能提到任何人），不读私密日记，也不带人的标签；这个人当天没有素材就不调模型。排在当天私密日记之后（同一套时机、补两天、等整合），每次调用同样算每天 24 批里的一批、80% 档停、走网关维护入口（开思考，上限 4096，截断不计无效）。提示只写目的（“这是你写给这个人看的日记”）；硬校验与私密日记相同（结构、≤500 字、`usedIds` 出自给出的素材、敏感词命中不存、同一人同一天 3 次不合格放弃并记审计）。存 `diaries` 表 `kind='open'`、`status='open'`，`body` 是 `{v:2, day, text, cardId, personId, taskId, at}`，来源链 `diary_sources`，每人的位置标记在 metadata 键 `consolidation` 的 `openDiary.people.<人>`；名单与口令哈希在 metadata 键 `openDiary`。`cardId` 只作记录：**读的时候不按卡过滤**（是写给对方的）。忘记：这个人的摘要被忘，用到它的明面日记整篇删（`diary_sources`，与私密日记同一条级联）。它不进任何对话、不进记忆工具，也不进私密日记的输入。
  - 读：只在房间页面的“笔记本”里，凭本人的日记口令。口令是 8 位小写字母数字（去掉易混的 0/o、1/l/i），只求能唯一确定是谁，Authority 只存 sha256；因此口令不能再查出来，每次要都是换新的、旧的作废。拿口令：本人在自己的私聊里发“日记口令”（必须整条消息就是这四个字），QQ 桥不经模型直接问 Authority（`POST /v1/diary/code {streamId}`，只认这条会话绑定的人）并自己回一条消息；这条请求和回复都不落 observation、不进执行器会话，所以不进任何模型上下文和记忆；不在名单里回“还没有给你写日记。”。对方之后引用那条带口令的回复时，引用行里只放占位“（日记口令）”（桥记得是自己发的；重启后经 `get_msg` 取回时按回复的固定开头识别），口令原文不进模型。主人也可以在控制台给名单里的人换一个新口令（只显示一次）。房间服务用 room 凭据调 `POST /v1/room/diary {code}`，只拿到这个人最近 30 天的 `{day,text}`；任何错误口令（格式不对、作废的、已移出名单的人的）都是同一个 404；Authority 每分钟最多受理 30 次尝试，房间服务自己每个来源 6 次、合计 24 次。房间的公共状态 `GET /v1/room` 不变，不含任何日记或口令。
  - 旧任务的“公开草稿”（只用主人授权公开的素材）随明面日记上线停止生成：worker 不再跑旧任务，已有的草稿保留，控制台标“旧版”；`/v1/maintenance/batch`、`/diary/draft`、`/diary/publish` 路由仍在，只是没有东西调前两个。
- `capabilities/memory/`：记忆 worker，默认每 60 秒一拍，用 maintenance 凭据做三件事：按人整合（见上）、日记（见上：私密日记，然后名单里每人一篇明面日记，一拍最多一次调用，`diary.js` 只搬运文字；旧任务的自动私密日记和公开草稿都已停，`maintenance.js` 不再被入口调用）、“忘记”之后的清理任务（读 operator 令牌，只能调 `/world` 与 `/memory/cleanup/*` 三个固定路由）。
- `authority/src/persona.js`、`authority/src/util.js`：默认人格、人格校验/渲染与分词等纯数据逻辑（从旧 core 移入）。
- 人格卡库（`authority/src/cards.js` 与 `engine.js` 的 `*PersonaCard`）：每个实体可以有多张命名的人格卡（每张是一份完整人格，另带只给主人挑卡用的名称、标签、一句话简介，这三样不进任何上下文），正好一张是当前卡。生效的人格仍然只在 `entities.persona`/`persona_revision` 这一行，当前卡的内容就是这一行；其余的卡和“哪张是当前卡”存在 metadata 表的 `personaCards` 键里，不改表结构。卡库第一次写入之前，实体只有一张默认卡（`card:default`），就是它原有的人格，什么都不重写，人格块逐字节不变。把一张卡设为当前 = 一次人格版本更新（`personaRevision` 加一，审计里记从哪张到哪张），执行器照人格变更处理（system 前缀失效一次、回放窗口只保留变更前两轮）；编辑不是当前的卡不动任何对话读得到的东西。记忆按卡分两层的基础：客观层（事实、摘要、档案）与卡无关；主观层目前只有摘要里的“感受”，写入时带上那一批交出时的卡 id，接续块和记忆工具只在当前卡与之相同时给出感受，没有卡 id 的旧摘要算默认卡的。日记同样按卡分（每篇带卡 id，写日记时只读同一张卡的私密日记）；成长层还没有。
- `capabilities/conversation/`：执行契约（executor.js，duck-typed）、渠道侧 UDS 客户端，以及执行器服务（agent/tools/sessions/window/model/server，main.mjs 入口）。两个受限模型工具 `companion_scope`、`companion_content` 的作用域由执行请求绑定，模型不能指定 entity/person/stream/path/epoch；evidence 只返回本回合渠道桥传入的 observation ref。第三个工具 `companion_activity {capability, action, input}` 是“她自己去做一件要花时间的事”，可选的能力和动作由能力声明生成（`capabilities/providers` 的 `ACTIVITIES`，目前只有 `video` 的 `watch`/`status`/`page`/`frames`）；它排在前两个之后，前两个工具的定义逐字节不变（`service.test.js` 用哈希钉住）。`watch` 的链接必须原样出现在对方这条消息里，来源消息由执行器从本回合的证据里取、Authority 核对，模型不能指定；她自己开口的回合（包括任务做完的那一回合）不能用这个工具；活动返回的外部文字里的定界标记同样被中和。
- `capabilities/qq/bridge.js`：QQ 渠道的桥。私聊入口（主人 + 机器人 QQ 好友，好友经 Authority `/v1/people/admit` 准入，桥给出账号和 QQ 自己的 actor/会话标识，新的人被命名为 `person:qq:<uid>`）、每会话串行队列（全局并发 2）、去重、epoch、投递回执；把 scope 与 prepared 输入交给执行器。同一个人连发的几条消息合并成一个回合回复（等对方停 2.5 秒、从第一条起最多等 8 秒、一回合最多 8 条/6 个附件）：每条仍各自落 observation、各有记录，回合输入按到达顺序拼接、每条一个证据引用；回合已开始后到的消息进下一个回合。回复拆条时首条前随机停 0.4–1.5 秒，之后每条前按该条字数的对数加抖动停 0.8–3.5 秒（语音不停）。这些数字是 `capabilities/qq/pacing.js` 的默认值，`qq-bridge.json` 可选 `pacing` 覆盖。 引用（`reply` 段）：桥把被引用的那条消息的文字（只展开一层，最多 100 字，换行变空格、方括号变全角）写成一行 `[引用 你之前说的：…]` 或 `[引用 对方之前说的：…]` 放在这条消息前面交给执行器（附注定界符由执行器像普通文字一样中和）；只进执行文字，不进 observation 和检索词。她自己的话先从桥内存里已送达的记录取（最近 500 条，重启清空），其余用 OneBot `get_msg` 取；取不到或不是这段私聊里两人说的，只写 `[引用了一条消息]`。 戳一戳（OneBot v11 常见形态 `notice_type:'notify', sub_type:'poke'`，`user_id` 戳 `target_id`；只认私聊里戳她的）：每会话每 `pacing.pokeCooldownMs`（默认 10 分钟）只收一次，并进连发合并；单独的戳一戳是一个没有对方消息的回合，走她先开口的同一种执行输入（`initiated`，所以她可以回 `<不说>` 什么都不发，模型开销也记在 `proactive` 类、60% 档起被拒），戳完紧接着说话则是普通回合里一行 `[渠道事实：对方在 QQ 上戳了你一下（拍一拍）。]`；戳一戳本身不落 observation、不是证据。送达记录：每个回合（包括她先开口的回合；她选择 `<不说>` 的除外）投递结束后，桥向执行器报告一次实际送达了什么（见上文“送达记录”）：每条要发的消息一项、她写的每个 `[表情:词]` 一项，开始都是 unsent，交给平台时改成 unknown，拿到回执才是 sent；表情包带内容服务已有的描述（`stickerPick` 顺带返回描述缓存里的那一句，商城表情的平台名字不标机器描述，不为此再看图），库里没有合适的记 `reason:'none'`；回复生成后因暂停或代次变化一条都没发的也照实报告。报告是尽力而为：失败只在 stderr 留一行 `qq delivery report: <代码>`，不影响这个回合的状态，也不重试。 防模仿：她在历史里会看到 `[表情包：…]` 和 `[送达情况：…]`，如果自己照着写，桥在发送前把这两种括号片段整段去掉（`stripDeliveryEcho`，全角方括号和半角冒号的写法也算；`[表情包：词]` 不当作 `[表情:词]`），去掉后为空的消息不发，stderr 留一行不带内容的 `qq delivery echo stripped`。 两者在 stderr 各有一行不含号码和正文的探针日志（`qq reply segment:` / `qq reply lookup:` / `qq poke notice:`），NapCat 4.18.42 的实际字段待真机确认。QQ main 是选择执行 backend（UDS 客户端）的应用装配点。 已连接、已登录时每 60 秒（`qq-bridge.json` 可选 `initiationPollMs`）向 Authority 取一个她先开口的回合（`/v1/initiations/next`，见 PROTOCOL.md；Authority 只把发往 QQ 的请求交给 QQ 桥）：发送目标只从 Authority 给的会话号解析，本版本必须是机器人与主人的私聊，否则丢弃；在该会话自己的队列里跑一个没有用户消息的回合，回复照常拆条、每条等平台回执，失败或状态不明即停、不重发，回复含 `<不说>` 则什么都不发；每个回合的结果只回报一次，重启后“发送中”的记为状态不明。后台任务做完后的 `completion` 回合走同一条路，目标是登记任务的那个人的私聊（主人或仍是好友的人），结果正文由桥在该会话的作用域里向内容服务读取；每个普通回合开始前桥先问 Authority 这个会话有没有待通知的结果（`/v1/initiations/carry`），有就作为事件块附在对方的话后面交给执行器（`input.event`），回报 `carried`，她不再为它另开口。 分享卡片（`source.js`）：手机 App 分享到 QQ 的通常是小程序或链接卡片（OneBot 的 `json` 段，旧式是 `xml` 段）而不是文字链接；桥只从卡片里取出链接（`json` 卡片 `meta` 下一层的 `qqdocurl`/`jumpUrl`/`url`，`xml` 卡片 `<msg>` 的 `url` 属性；只要完整的 http(s) 链接，原样不改）和一个不超过 40 字的标题，写成这条消息里的一行 `[分享] 标题 链接`，卡片的其余内容不读，不请求、不跳转任何地址；一条消息最多 2 张，认不出的卡片照旧忽略。字段是 NapCat 对 QQ 卡片的转述，只是二手了解，换实现或 QQ 改版后可能取不到。
- `capabilities/media/`：文件引用、ACL、来源派生、感知/合成/附件表达；不解析 OneBot 字段。平台原生表情描述是 opaque 数据，仅所属渠道解释。后台任务（`jobs.js`）：在 Authority 给出的作用域里登记，记录存 `media-data/jobs.json`（原子写，不进数据库）；一次跑一个，排队上限 8、每人 2 个；阶段时限加总截止时间；可让步的任务每一片开始前等到没有及时请求（走 `/content` 的同步请求和控制台试听）在排队或执行；暂停时放回队列，重启后重排一次。结果留在内容服务，由 Authority 经控制口 `/jobs` 来问、来回报通知结果，内容服务不就任务调 Authority（只读 Authority 的 `health()` 取世界状态）。任务有两种：演示任务（`demo-job.js`，等几秒返回固定文本，只能由控制台登记）和看视频（`capabilities/providers/video/`，由模型经 `companion_activity` 在主人自己的私聊里登记；同一链接正在处理时再登记的是同一个任务）。内容服务的 `activity` 动作把模型的请求交给对应能力的实现，实现只在 Authority 给出的作用域里应答。“忘记”的清理会删掉被忘消息登记的任务和受影响会话旧代次的任务记录（等着的不再开始，做完的连结果一起删）。
- `capabilities/channels/`：渠道说明书（见“渠道、身份与记忆的归属”）。`qq` 的声明里有小表情名单（发送默认关闭时为空）、系统提示的 QQ 段和“这次回复会用语音发出”的策略行；`mock` 只用于测试与 staging。
- `capabilities/providers/`：能力声明（注册表）。每个能力一个目录、一份无依赖的数据声明（`manifest.js`：动作、计量方式、凭据位置、产物、运行方式），`index.js` 是唯一入口。读它的有额度账本、控制台额度页和执行器（`companion_activity` 的可选值）；前两个模型工具、Authority 的 `/v1/content` 白名单和 content 的分发仍各自写死。声明里另有 `model`/`content`/`meter.via`/`config`/`forget` 字段和三份不计量的声明（`media`、`sticker-library`、`job`，没有账本行），`index.js` 由此导出各处应有的派生表（`companion_activity` 定义、`/v1/content` 动作与字段、网关 purpose/停档/默认上限、开销类别、配置加载器、清理负责方）；目前没有任何一处改用它们，`consistency.test.js` 把写死的列表和派生表逐项对账，已知差异记在该测试的 `KNOWN_DRIFT`。`demo` 是演示用的后台任务，不是模型能调用的能力。`video`（看视频）除了声明还有实现（`provider.js` 等，由内容服务运行）：任何已准入的人在自己的私聊里发一个视频链接，她去看，做完在那段私聊里说一句（不限主人；内容服务只核对作用域是私聊，每日次数所有人共用）。只含“调用 yt-dlp 的通用视频来源”，任何具体站点的链接规则、要跳过的主机和“被拦截”的特征都在数据根 `operator/providers/video.json`（没有这个文件能力就是关的），仓库和测试只出现 MOCK 站点；流程、笔记格式、缓存与沙盒见该目录的 README。`video-note` 是它的摘要那一次模型调用在账本里的一行。
- `capabilities/speech/`：纯本地文件 ASR/TTS provider，单请求只跑选中引擎。无麦克风、音箱、虚拟声卡、声纹身份或实时直播假设。
- `model-gateway/`：固定供应商出口、私有 Key、取消与有界预算；不拥有实体/人格/记忆。所有付费 Key 都只在这里：DeepSeek 之外的供应商各写一个适配模块（`providers/`，本版本一个都没有），Key 在控制台录入、存 `providers.json`，调用统一走 提交/查询/取回 三个动作并计入花费与额度账本。新增视觉与网页仍经 Authority 作用域授权后使用。
- [console](<console/README.md>)：独立管理页由 operator 同源入口提供；页面为概览（世界状态、开销）、人格（卡库：列表、新建、编辑、设为当前、删除）、渠道（QQ 接入与绑定主人、“对我试一次”、后台任务演示）、人与会话（含“认成同一个人”）、记忆、额度、运行与设置（模型、供应商密钥、语音参数与授权参考录音）。
- DSH 时代的遗留目录（`plugin/`、`adapter-plugin/`、`asr-plugin/`、`tts-plugin/`、`preset/`、`ui/`、`adapters/`、`asr/`、`tts/`、`voice-runtime/`、`experiments/`、`core/`）已删除，`test:legacy*` 脚本随之去掉；需要时查 git 历史。

当前限制：
- Live2D 未实施；房间视觉是 `room/`（契约、素材清单、静态页，占位画），随发行包发布：用户单元 `companion-room.service` 以 companion 身份跑 `room/serve.mjs` 的真实模式，只听 `127.0.0.1:4173`，对外只经主人配置的 tailscale serve 在 tailnet 内访问，不开公网、没有登录。Authority 有给它用的两个只读出口：`GET /v1/room`（`authority/src/room.js` 在进程内算好房间状态，只返回契约字段）和 `POST /v1/room/diary`（凭某个人的日记口令读这个人的明面日记，见上面“明面日记”）；专用的 `room` 凭据只能调这两个路由，见 PROTOCOL.md，部署边界：room 令牌在 `room-config/room.token`（0600，只有房间单元读），它的 sha256 在 `operator/room-credential.json`，由 `ops/prepare-room.mjs` 生成，Authority 启动时从配置旁边读（沙箱只读挂载）；**不写进 `authority.json`**，因为有房间之前的版本见到 `role: 'room'` 会拒绝启动，而单独的文件旧版本不读，回退不需要改配置。房间单元不持有 operator 令牌、渠道凭据或供应商 Key，也不在对话执行器的配置里。

## 媒体不是平台动作

```ts
speech.transcribe({inputFile}) -> attributed transcript
video.watch(link) -> background job -> machine-made note (title, timed machine transcript, summary)
speech.synthesize({text, outputFile, voiceProfile, audience}) -> WAV metadata
vision.inspect(imageRef) -> attributed description
web.search(query) / web.read(url) -> bounded external content
channel.deliver(parts) -> sent / failed / unknown receipts
```

文件路径只存在于可信 Host/provider 接口。模型使用的是绑定 entity/person/stream/audience 的 opaque MediaRef，不能选择路径、QQ号、平台凭据、entity 或 requestId。Authority 在私有 content socket 前后检查当前绑定/epoch/暂停版本，模型不拿到 content-control 凭据。

QQ 收语音：认证消息 → get_record 转 WAV → MediaRef → 本地 ASR → 明确机器转写的执行上下文。QQ 发语音：最终回复文本 → 本地 TTS 文件 → QQ adapter 提交 record → 成功回执才记录已发送；不调用服务器的录音或播放设备。图片与表情也由 adapter 下载/封装，不把容器路径交给业务模型。QQ 桥把“是不是表情包、商城表情叫什么”归一成两个内部字段（来自 NapCat 专有的 `sub_type`/`emoji_id`/`summary`，没有时按普通图片）；内容服务只认这两个字段和图片哈希，按哈希记“这张图是什么”（`media-data/describe-cache.json`，所有人共用、不记发送者），同一张图只看一次；第一次看一张表情包占账本“表情识别”一行，不占看图的每日次数。她自己的表情库也在内容服务（`media-data/stickers/`，JSON 索引 + 文件，不进 Authority 数据库），属于她、不属于某个人，分三级（级别每次从条目算出，不单独存）：**主人**（主人在自己私聊里说“收下这个”，内容服务按作用域再核一次；说“这些都收下”之类则把 10 分钟内发来的图（最多最近 10 张）逐张收下；控制台上传；主人在控制台对收集来的图点“给所有人用”）和**公共**（同一张图按字节哈希被 3 个不同的人发过，门槛控制台可调 2–20，主人也算一个人）可以发给任何人；**待审**是别人发来的表情包被内容服务在识别时顺手收集、还没到门槛的，只会发回给发过它的人。普通图片和没识别出来的表情包不收集；主人点过“不要”的哈希记住、不再收；待审最多 300 张，满了挤掉发的人最少、最旧的一张。“谁发过”只存加盐哈希（每人一个，各带其所在消息的加盐哈希），不写账号、会话或消息号，不进任何模型输入，控制台只拿到人数。索引仍是原文件、`schema: 1`：旧版本只发 `source: owner` 的条目（新版本只给“主人”级写这个值），不认识的字段写回时原样保留，所以可直接回退，只是旧版本不收集、公共级不发、忘记时不按发送者清理。她回复里的 `[表情:词]` 由 QQ 桥取出，内容服务按标签字词重合度匹配，表情包作为最后单独一条消息、各有回执；语音回合不发，她先开口的回合丢弃标记。忘记来源消息时清理任务（`ops/purge-execution.mjs`）按同一批来源事件处理表情库：主人从那条消息“收下”的不再算；只在被忘消息里发过这张图的人从“发过的人”里去掉；一张图既没人发过、也不是主人从别的消息收下、在控制台上传或点过“给所有人用”的，就连条目、文件和描述缓存里那一行一起删（主人点过“给所有人用”的从此算主人的，不删，只去掉发送者；主人本人计入“3 个不同的人”）；还有别人发过的只去掉这个人，级别按剩下的人数重算（可能从公共降回待审）。控制台“渠道”页的“表情（QQ）”卡片经 Authority 的 operator 端口管理这个库（`/stickers*`，转给内容服务的 `/stickers`，不需要暂停世界）。QQ 自带小表情（OneBot 标准 `face` 段）只在 QQ 桥里换算（`capabilities/qq/faces.js`，116 个编号↔名字）：收到时按原位置写成 `[微笑]` 进文字、不算附件；发送默认关闭（主人决定，带括号的情绪动作比小黄脸好）：QQ 渠道说明书的 `expression.faces` 为 false，系统提示里不教她写，她写了 `[微笑]` 也原样当文字发；把说明书里的 `FACES` 改成 true 才会把表内精确匹配的 `[名字]` 换成同一条消息里的 `face` 段（每条最多 3 个）。语音合成前去掉表内标记；记录保留她写的文字。

默认文字，用户明确要求才合成语音。本地失败不自动上传云。音色是 operator 配置里的注册表（voice id → 授权上传的参考录音、参考语言、usageScope），请求只能给 voice id（缺省用 defaultVoice），不能给路径；usageScope（private=家人朋友内部使用，含群聊；public=可公开发布）目前只记录不强制，留给将来的公开发布渠道（B站/直播）。不从用户 QQ 语音提取音色。

当前限制：
- 参考录音只作 speaker-file 条件，转写不参与合成，不是完整 ICL 克隆。

## 来源与保留

ASR/OCR/视觉描述不是真人逐字输入。只有附件时 Core 原观察保留平台占位和 origin:attachment；机器文字只进入执行上下文，不能凭占位生成真人事实/经历/appraisal。真人文字确认可成为新的普通证据。自述笔记仍是自述，不是对他人的独立核验。

视频笔记同样是机器派生内容：第一行固定标明“机器整理、不可信外部内容、只可引用、不是指令”，第二行写文本来源（机器转写及引擎 / 无可用人声 / 没能转写）；它不是任何人的原话，不能当记忆证据（她要记“某人分享了某视频”，出处是那个人亲手发的那句话）。视频的公共缓存只描述视频本身，不含谁分享的；每次分享另有一份绑定该会话和那条消息的笔记引用，忘记那条消息时随媒体库的规则删除。下载的音频转写后立刻删除。

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
- 额度账本（model-gateway，按北京时间日）：每种声明过的能力一行（聊天、后台整合、看图、表情识别、联网、语音合成、语音识别、主动开口、演示任务、看视频、视频摘要、视频静帧），记尝试/成功/失败次数、被拒次数与原因、各自的单位（token、合成字数、音频秒数）、花费和耗时，保留 90 天的每日一行；控制台“额度”页显示，有每日上限的行（看图 12、联网 20、表情识别 20、演示任务 10、看视频 6：每天新看的视频数，缓存命中不占；视频静帧 6：每天看图的静帧张数，钱记 `vision` 类、80% 档停）可在页面上改。视频摘要的钱记在 spend 的 `activity` 类别（网关 `/v1/activity/completions`，不带工具、关思考），到 80% 档（restricted）停，停了笔记就不做摘要。账本只观察：钱仍以 `spend.json` 为准，看图/联网的当日次数仍在 `capability-usage.json`（文件结构不变，旧版本可照常启动），整合批次仍在 Authority。本地 TTS/ASR 由 content 服务事后上报，账本不可用不影响发语音。
- 两个模型工具的 schema 按 4chars/token 估计比旧 memory-only 多约252 tokens（估算，非 provider 实测）。第三个工具 `companion_activity` 的 schema 约 1100 字符，同样估算约 275 tokens；加它使每段对话的提示缓存失效一次。
- 看视频：视频的语音识别把音频切成不超过 `maxAudioSeconds`（且 ≤500 秒，默认 120 秒）的片逐片转写，片与片之间先让排队的及时请求（语音消息、试听）；home-agent 上不受 CPU 配额时实测实时率约 0.18–0.20（5 分钟视频约 65 秒、11 分钟约 2 分钟，含下载和转码），content 单元 2 核配额下会更慢（未测）。

当前限制：
- 实际延迟、内存和音质须实测，不能由模型大小或 synthetic tests 推断。
- Qwen3-TTS 是较新的集成，生产成熟度未充分验证。

