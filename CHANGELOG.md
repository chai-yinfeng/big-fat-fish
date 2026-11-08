# Changelog

每个版本几行即可：改了什么、真实验证了什么、什么还没验证。

## Unreleased

- 部署预检与 staging：companion-deploy 在停单元、切 current 之前以 companion 身份运行新包的 `ops/preflight.mjs`，按各服务的启动检查（speech 用 loadSpeechConfig、对话用 loadConfig）校验现有配置，并拒绝钉在具体 release 目录里的路径；失败只输出错误码/文件名/字段名，删除新包，生产不变（companion-deploy 有改动，需按新 sha256 重装）。新增 `deploy/staging/run.mjs`：在 home-agent 的 agent 账号下用 companion-deploy 本身跑完整生命周期（全新安装旧包、初始化、启动、升级、删除旧包、重启、operator 冒烟），单元 `companion-staging-*`、端口 13082、memory/qq 只允许 Unix socket。memory-worker.json `operatorPort`、qq-bridge.json `onebotPort`、purge-execution `--operator-port` 可配置，默认仍为 3082/3001。已验证：test:deploy/qq/memory 与全量测试；home-agent-dev 上真实运行 945e4dc→本分支、main→本分支均 PASSED，40433ae→本分支被预检以 SPEECH_CONFIG_SCHEMA 拒绝（复现旧 speech schema 事故），40433ae→9844a5e 在删除旧包后 memory 反复重启（复现 purgeModule 事故）。未验证：生产主机上以 root 运行的预检（`subprocess` 切换到 companion 用户）、真实模型对话。
- 修复 `deploy/qq/open-login.mjs` 打开 NapCat WebUI 后闪错并停在登录页：浏览器 localStorage 留有过期 WebUI 凭证时，上游 `/webui/?token=` 入口先进仪表盘，QQ 状态请求鉴权失败后跳到不带 token 的 `/web_login`。现在直接打开 `/webui/web_login?token=`（v4.18.42 登录页读取 URL token 自动提交）。已验证：deploy/qq 测试、test:qq，按 NapCatQQ v4.18.42 源码静态核对。未验证：真实浏览器与生产 WebUI。
- 修复 companion-memory 在旧 release 被清理后启动失败：prepare-memory 曾把 Node realpath 后的 release 专属路径写进 memory-worker.json 的 `purgeModule`，release 被保留策略删掉后动态 import 失败。现在 worker 从自己所在的 release 解析 purge-execution（release 为 `ops/`，开发 checkout 为 `deploy/authority/`），忽略旧配置里的 `purgeModule`，prepare-memory 也不再写该字段；部署后无需在主机上重跑 prepare-memory。启动失败日志带稳定错误码（如 `MEMORY_CONFIG`），不含路径、令牌或内容。已验证：test:memory/authority/deploy。未验证：生产主机。
- 修复控制台「运行与设置」在旧版 speech.json 下报错：media operator 的 status 遇到配置缺失、schema 1 或不合法时返回 200 和 `speech.status`（not_configured / config_schema_outdated / config_invalid），正常时为 ready；控制台按原因显示本地化提示，其余设置照常显示。操作出错不再清空整个页面，只有授权失效才清状态。Authority 的大写错误码（VALIDATION_ERROR 等）映射为对应的中英文提示，仍不回显服务端消息。已验证：test:console/media/authority/speech。未验证：生产主机上的实际页面。
- 控制台人格页可编辑全部人格字段（含称呼、关系阶段和对话示例的增删排序），operator `/persona` 接受全部字段并仍经 validatePersonaPatch 与可选 expectedRevision；新增只读 `/persona/preview` 显示渲染文本和字符数/1600 份额并在会截断时告警；人格 JSON 导出/导入与「载入默认人格」只载入编辑区，需手动保存。已验证：test:console/authority/conversation。未验证：真实浏览器中的下载与文件选择。
- 新默认人格「大肥鱼」：知道自己是跑在 DeepSeek 上的 AI，经历只讲真实发生的事（聊天、记忆、主机时间、从旧 VM 搬到新主机），正向描述为主，10 条对话示例；执行器 system prompt 的基础说明和框架行改为自然中文。Authority context 默认/客户端上限 2400 → 4000 字符，有记忆时人格份额 40%（1600），默认人格（渲染约 1083 字符）不再被截断。只影响新世界和默认值，已有世界需在控制台人格页或 admin persona 接口更新。已验证：test:conversation/authority/memory/console/qq。未验证：真实模型下的语气效果。
- 对话执行器改为基于 pi-agent-core 1.5.0 / pi-ai 1.5.0 的 companion-conversation 服务（UDS `POST /execute`，bearer 哈希认证）：会话由 streamId+memoryEpoch 派生、每会话一个私有 JSONL；每次模型请求前取 Authority context；companion_scope / companion_content 移植为作用域绑定的 AgentTool；32k 字符完整回合裁剪；超时/断开即中止；经 Unix socket 只访问 model-gateway，DeepSeek compat 回传 `reasoning_content`。release 中为 esbuild 单文件（约 1.2 MB），不含 node_modules。
- QQ 改为把 scope、执行文本、查询文本、媒体引用与本回合 observation ref 交给执行器；删除 DSH inbox 与 worker route。
- 彻底移除 DSH：capabilities/dsh、integrations/dsh、控制台旧 DSH 入口与 legacy client 构建、run-capability / wait-sdk-ready / web-rpc / access / verify-dialogue / verify-console-browser、isolation 的 capability/dsh 角色与 bin 包装、companion-dsh-* 单元、deploy/vm 旧验证文件；install-runtime.sh 只装私有 Node。新增 companion-conversation.service（不用 bwrap），companion-qq 依赖它；purge 改为删除受影响 stream 旧 epoch 的会话文件（execution-storage v2）；rotate-tokens 纳入 conversation caller token。
- companion-deploy：健康检查只看 3082；全新主机首次 deploy 只安装不启动，新增 `companion-deploy start`。
- 去掉 DSH 遗留名：生产 release 路径 `src/dsh-companion` → `src/companion`；`dsh-config/` → `service-config/`（`health.token`、`inference.token`），health 检查用的 `dsh-test` capability → `health`（learning.v1，无 actor/stream 绑定）；Authority 与控制台删除 "DSH 测试对话" 渠道和 `/test-conversations`。companion-conversation 单元只保留在非特权 user manager 下真正生效的选项（NoNewPrivileges 与 seccomp 类），无文件系统隔离。
- 已验证：本机全量 `node --run test`（含新增 conversation 测试：假 gateway/Authority 的真实 UDS、经真实 model-gateway 服务的 reasoning_content 回传）、companion-deploy 与 isolation Python 测试、本地 release 构建。未验证：生产主机部署、真实 DeepSeek 多轮工具调用。
- 文档整理：删除根目录 DEVELOPMENT.md，其中仍有效的 VM 布局、管理页面命令、一次性维护命令和控制台操作要点并入 docs/DEV_WORKFLOW.md。
- AGENTS.md 写明执行器方向：现行默认仍是 DSH 适配，计划在执行器接口后用 pi-agent-core 实现新执行器，DSH 不再作为未来聊天入口；机器转写/描述须标注为派生内容。
- 移除公开文档中指向本地 notes/ 的死链；各模块 README 的测试/限制段压缩为简短的"测试覆盖 / 当前限制"。
- 生产主机改为 home-agent（x86_64），myvm（arm64）退为旧环境待退役：发布/安装工具按主机架构选择私有 Node、CMake（Kitware 官方 sha256）、sherpa 原生包和 NapCat 平台；Mac 辅助脚本目标主机取 COMPANION_HOST（默认 home-agent）；语音安装新增可选 `--hf-endpoint https://hf-mirror.com`（固定 revision 与 sha256 不变）。已验证：本机单元测试与 home-agent 只读探测（uname、hf-mirror 跳转）；未验证：x64 上的实际运行时安装、语音构建、NapCat 拉取和发布部署。
- isolation：Authority bwrap 沙箱在主机存在 /usr/lib64 时加 `--symlink usr/lib64 /lib64`，修复 x86_64（home-agent）上 node 因缺少 /lib64/ld-linux-x86-64.so.2 报 `execvp ... No such file or directory`；arm64 主机不受影响。已验证：本机 isolation 单元测试；未验证：生产主机部署。
- companion-deploy：deploy 健康检查失败并恢复后删除失败的 release 目录及其 installed 记录（日志 `removed_failed`），同一个包可直接重新 deploy，不再报 "release already installed"；恢复后的 release 也不健康时（deploy 与 rollback）停止全部 companion 服务和 socket，不再留在重启循环（日志 `stopped_units`）。已验证：companion-deploy 单元测试；未验证：生产主机。
- DEV_WORKFLOW：全新主机顺序补上 NapCat prepare（`deploy/qq/prepare.mjs`，首次 start 前必须运行），给出在 home-agent 验证过的 bootstrap/prepare-memory/prepare-content 调用方式；首次安装说明 home-agent 镜像须用 `git clone -c http.https://github.com/.proxy=...` 写入代理。
- isolation：Authority 沙箱时区 TZ 由 America/New_York 改为 Asia/Shanghai（home-agent 世界为新初始化，无数据迁移）。已验证：isolation 单元测试；未验证：生产主机。
- 语音（speech 配置 schema 2，不迁移：旧配置报 SPEECH_CONFIG_SCHEMA，移开后重跑 prepare-speech）：彻底移除 Kokoro 引擎、合成参考生成（setup-reference）和 Kokoro 试听脚本。多音色：`voiceProfiles` 按 id 登记 + `defaultVoice`，每个音色有 engine（目前仅 llama-tts Qwen3-TTS）、operator 上传的参考录音、来源逐字稿、参考语言、`useReferenceText:false`、`usageScope` private/public（只记录：private=家人朋友内部使用、含群聊，未来公开发布渠道才强制）；控制台/operator 可登记、设默认、试听、移除。ASR 只用 Qwen3-ASR（≤30 秒，超长报 SPEECH_AUDIO_LIMIT；SenseVoice 移除，不再安装），预留繁转简钩子（目前不转换）；线程上限 16，默认 8。安装器新增 `--model-source modelscope`（GGUF，固定 sha256）、`--proxy` 与 `--archive-dir`（预取的 Qwen3-ASR 压缩包，home-agent 无法下载 GitHub release），Qwen3-ASR 压缩包的 sha256 已固定（Mac 直连 GitHub 下载所得），`--models` 改为 asr|all。已验证：本机 test:speech/media/qq/console/authority/conversation 与安装器单元测试、临时目录 plan 冒烟；未验证：真实模型加载与合成、ModelScope/代理下载、生产主机安装。

## 0.10.0

- Authority 是唯一世界/人格/记忆写入方；独立世界控制台（同源 operator 入口）与旧 DSH 设置入口共用一套视图。
- QQ 私聊（仅本人已绑定号）已实现文字、语音识别、图片描述、授权素材回发和本地 TTS（Qwen3-TTS 重档，speaker-file 条件）。
- 对话执行默认仍经 DSH 适配器；模型出口经 model-gateway（DeepSeek）。
- 发布改为 Mac 上 stage-release → 用户在 VM 上 sudo companion-deploy，失败自动恢复上一版本。
- 精简流程：删除 bili-bridge；operator 的世界暂停/恢复、人格编辑和语音运行时操作不再强制携带世界 revision（忘记记忆与语音配置文件仍保留 CAS）。
- Kokoro 已弃用，仅作为现有合成参考来源，待移除。
