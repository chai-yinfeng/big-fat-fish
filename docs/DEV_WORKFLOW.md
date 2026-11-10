# 单 Agent 开发、同步与回退

## 开始与交接

```sh
git status --short
git log -3 --oneline
```

一次只让一个 Agent 写一个工作树。切换前把已完成的修改检查后本地提交，说明未完成项。
公开远端不包含 notes、录音、状态或模型；不要用 push --all/--mirror，推送须经用户授权。

首次 clone 后启用本地检查 `git config --local core.hooksPath .githooks`。pre-commit
只检查暂存文件中的可疑凭据、私有素材和大文件，不跑测试，也不替代推送前的人工确认。

## 依赖与定向检查

Node ≥24；前端使用 console 内的 pnpm 锁文件，对话执行器使用 capabilities/conversation
内的 npm 锁文件（固定 @earendil-works/pi-agent-core、pi-ai 1.5.0 与 esbuild 0.25.11）。
Mac 与 Linux 的原生依赖不能直接互拷。依赖只装在开发 checkout，不修改全局 npm 配置或生产运行时；
release 中执行器是 esbuild 打包的单文件，不含 node_modules：

```sh
pnpm --dir console install --frozen-lockfile --ignore-workspace --ignore-scripts
npm --prefix capabilities/conversation ci --ignore-scripts
node --run test:authority
node --run test:conversation
node --run test:qq
node --run test:speech
node --run test:media
node --run test:memory
node --run test:console
```

仅选择受影响的模块；迁移、发布或跨层改动再跑 node --run test。
UI 可单独 node --run build:console（输出 console/dist；没有 dev/watch/HMR）。
开发服务使用独立配置/数据根，不把复制到正式 release 当热更新。

## 测试发送与版本记录

- 向用户本人已绑定的 QQ 发测试消息/语音：用户在一个会话中批准一次即覆盖该会话后续
  的测试发送，不必逐条授权或另写私有记录。发给其他人或群仍需逐次单独授权。
- 每个版本只在根目录 CHANGELOG.md 写简短条目（改了什么、真实验证了什么、什么未验证），
  不再写长篇实机验收笔记。汇报只说真实运行过的内容，未验证的明确列出。

## 开发只在 Mac

开发、测试和构建只在 Mac 本机 checkout 进行；生产主机只运行正式服务，不在生产主机上
改源码。代码只通过下面的发布流程到达生产主机，不用 rsync、git pull 或手工复制。开发 QQ
用测试发送口/独立账号，不能和正式桥重复回应。

## 生产主机访问与远程命令

生产主机为 home-agent（Beelink SER8，x86_64，Ubuntu 24.04，经 Tailscale 的 SSH 别名
`home-agent`）。Mac 辅助脚本默认连它，可用环境变量 `COMPANION_HOST=<ssh 别名>` 覆盖。
旧的 arm64 VM（myvm）已退为旧环境、待退役，不再作为发布目标。home-agent 上全新初始化
世界，不安装 DSH；该主机无法直连 huggingface.co，Docker Hub 只能经本机代理 127.0.0.1:7890。
语音安装在该主机上建议：`ops/install-speech.mjs --apply --models all --model-source modelscope
--proxy http://127.0.0.1:7890 --hf-endpoint https://hf-mirror.com --archive-dir <目录>`（GGUF 走
ModelScope 直连并校验固定 sha256；npm、git clone 走代理；小型模型卡走 hf-mirror）。该主机经代理下载
GitHub release 失败（SSL_ERROR_SYSCALL），sherpa Qwen3-ASR 压缩包须先在 Mac 上下载再拷到 `<目录>`，
安装器按 manifest 固定的 sha256 校验。已有安装补装长语音用的 Silero VAD（>30 秒的 ASR 需要它）：
`ops/install-speech.mjs --apply --models vad --model-source modelscope --proxy http://127.0.0.1:7890`
（只下载约 2.3MB 的固定 sha256 文件，并在 speech.json 补 `models.vad`、把旧默认 maxAudioSeconds 30 提到 120）。
`--models all` 默认以 Vulkan 编译 llama-tts（iGPU，需主机已装 glslc、libvulkan-dev、spirv-headers，缺少时报
`SPEECH_VULKAN_BUILD_DEPS` 且不下载任何东西；`--cpu-only` 编译旧的纯 CPU 版），重跑会在原 build 目录重新配置编译（-j2 约 3.5 分钟）。
运行时 `auto` 需要 content 服务进程在 render 组里（能读写 /dev/dri/renderD*）；companion 加入 render 组后须重启它的
user manager（`systemctl restart user@$(id -u companion).service`）才会生效，否则 TTS 回落 CPU，日志
`SPEECH_TTS_FALLBACK_CPU SPEECH_VULKAN_NO_DEVICE`。
安装后在控制台“音色”中登记参考录音。发布与安装工具按
`process.arch` / `uname -m` 在 arm64 与 x64 之间选择私有 Node、CMake、sherpa 原生包和
NapCat 平台。
home-agent 网络问题一律先走本机代理 `http://127.0.0.1:7890`（git/curl/pip/npm/Docker；PyPI 可用清华镜像），交给用户的联网命令须提示加代理，详见 AGENTS.md。

生产主机只用于生产。服务以专用用户 companion（uid 由主机分配，不固定；密码锁定、不可登录，
home 0700）运行，由 root 通过 `systemctl --user -M companion@ ...` 管理。人类和
Agent 都以 blackmagic 身份 SSH 登录：sudo 需要人类输入密码；旧 VM 上 blackmagic 没有
docker/lxd 权限，而 home-agent 上它目前在 docker、lxd 组（等价 root），交给 Agent 前须先
按 AGENTS.md 隔离；blackmagic 属于 adm 组，不用 sudo 就能只读查看 companion 的日志和部署记录
（两个部署文件为 root:adm 0640，不含密钥；/var/lib/companion-deploy/state.json
仍只有 root 可读），查看命令见“发布与回退”第 3 步。

需要私有 token 的 Mac 辅助脚本（open-world、deploy/qq/open-login、
verify-standalone-console、verify-console-browser、verify-dialogue）都经
deploy/authority/companion-sudo.mjs 以 `ssh -t <生产主机> sudo -u companion` 读取，由用户
在终端输入 sudo 密码；Agent 不运行它们。verify-live 只能在生产主机上以 companion 身份
运行，且对正式世界只允许 status。

```sh
# 用户在 Mac 项目根执行；token 经 sudo -u companion 读取，会提示输入生产主机的 sudo 密码：
node deploy/authority/open-world.mjs
node deploy/authority/open-world.mjs --open-only
node deploy/qq/open-login.mjs        # NapCat WebUI 扫码登录（默认 home-agent）
```

失败时只输出错误码（如 FORWARD_PORT_OCCUPIED、SUDO_FAILED、TOKEN_READ_FAILED），
不输出 token；token 只交给系统浏览器，operator fragment 即时消费移除。关闭本机转发
不等于停止生产服务或退出 QQ。不要为更新此 GUI 另起 Vite 服务器。

远程命令尽量合并为一次调用，只返回有限长度的摘要。

## 生产主机布局

```text
产品：/home/companion/src/companion/current → authority-<版本>-<sha>
正式数据：/home/companion/.local/share/companion-world-v1
私有运行时：/home/companion/.local/opt/companion
用户单元：/home/companion/.config/systemd/user/companion-*
会话记录：/home/companion/.local/share/companion-world-v1/conversation-data/sessions（每会话一个 JSONL）
执行器：companion-conversation（UDS ipc/conversation/execute.sock，无 TCP 端口；以 companion 用户运行、无文件系统隔离，网络经 seccomp 只允许 Unix socket，模型只能用两个不访问文件系统的工具）
3082 独立世界控制台与 operator API（唯一由 companion 单元监听的 TCP 端口）
NapCat WebUI 6099 / OneBot WS 3001（沿用旧记录，未在新布局下复核）
```

主机入口均只监听回环；执行器、Authority、model-gateway 之间只走 Unix socket。运行中的世界状态
（暂停、revision、QQ 登录等）以控制台和 status JSON 为准，文档不记录快照。

## 控制台操作要点

- 模型：deepseek-flash / deepseek-v4-pro 可选，视觉固定 Flash。Key 只填 password 框，
  留空保留旧 Key；显式 probe 可能计费。
- QQ：扫码后只在暂停且已登录时绑定本人发送号（须与机器人号不同）。当前仅本人私聊，
  不开群、广播或自动加好友。
- 语音识别在本地，但转写会进入 DeepSeek 对话，不是全本地对话。
- 音色：暂停后在“音色”中上传参考 WAV 登记（ID、名称、参考语言、使用范围），可设默认、试听、移除。
  使用范围只是记录（“内部”=家人朋友间使用，私聊和群聊都可用；“可公开”=可公开发布）；没有默认音色时语音请求改回文字。
- 暂停：冻结世界、拒绝新模型/记忆效果、取消在途请求；不补算停机期间、不补发消息。
  已交给供应商/平台的请求不可撤回，仍可能计费。恢复须用户明确操作。

## 长期运行的清理

生产主机上会随时间增长的内容及负责清理的人：

| 内容 | 位置 | 清理方式 |
| --- | --- | --- |
| 旧 release | /home/companion/src/companion/authority-*-<sha> | companion-deploy 自动保留最近 3 个及 current/previous；旧 VM 上的 authority-0.10.0、0.9.0 不会自动删除 |
| 上传的发布包 | ~blackmagic/releases/*.tar.gz(.sha256) | 手动删除 |
| unit 快照与 Git 镜像 | /var/lib/companion-deploy/unit-snapshots/、mirror.git | 手动（root）；不要删掉 current/previous 对应的快照 |
| systemd 日志 | journald | `sudo journalctl --vacuum-size=…` / `--vacuum-time=…` |
| NapCat 镜像与容器日志 | docker（companion-world-qq） | 人类手动处理；companion-deploy 不碰 |
| 世界数据（聊天、记忆、媒体） | /home/companion/.local/share/companion-world-v1 | 从不自动删除；任何清理都须用户明确批准 |

这里只是说明，目前没有自动清理任务。

## Staging 与部署预检（交付部署命令前必做）

单元测试曾全部通过、上线却坏（旧 speech.json schema 被新代码拒绝；memory-worker.json
指向被保留策略删掉的 release）。因此 Agent 在把生产部署命令交给用户之前必须：

1. 在 Mac 上构建目标包：`node deploy/authority/stage-release.mjs --no-upload`
   （分支上的提交加 `--allow-unpublished`；只用于 staging，生产会拒绝）。
2. 跑 staging：`node deploy/staging/run.mjs --reset`（只清空）后
   `node deploy/staging/run.mjs`，或一次 `node deploy/staging/run.mjs --reset --to <包>`。
   `--from` 默认是生产当前 release（读 home-agent 上的 status JSON，包取自
   `.build/releases/`），`--to` 默认是 HEAD 的包。结果须为 `STAGING PASSED`，汇报时附上摘要。

staging 以 home-agent 上无 sudo 的 `agent` 账号（`ssh home-agent-dev`，已开 linger）运行，
直接调用 companion-deploy 本身的 deploy/预检/单元/健康检查/保留代码：全新安装 from 包 →
用该包的 bootstrap、prepare-memory、prepare-content、QQ prepare 初始化（无模型 Key、
不登录 QQ）→ start → disable 全部单元（模拟旧版 companion-deploy 留下的未 enable 状态）→
升级到 to 包（预检、切换、健康检查、enable）→ 冒烟与场景回放（让新版本先用过这个数据根）→
迁移演练（见「数据库迁移」）→ `companion-deploy rollback` 回到 from 包并冒烟（旧版本在新版本用过的
数据根上健康启动、能读能写）→ 再 rollback 一次回到 to 包 → 删除 from 包 → 重启全部单元 →
manager 重启代理（确认均已 enable，停掉全部单元但不 disable，daemon-reload 后确认
default.target 的依赖树覆盖全部单元，再 `systemctl --user start default.target sockets.target`
并做健康检查；已激活的 sockets.target 不会因 start default.target 被重新拉起，故单独启动）→ operator API 冒烟（/world、/runtime、/qq、/memory、人格预览与保存、对话执行器鉴权）→
场景回放（见下）→ 确认生产端口没有 staging 监听。全部位于 `~/companion-staging`（作为服务的 HOME），单元
改名为 `companion-staging-*`，operator 端口 13082；memory、qq 单元限制为 Unix socket，
旧 release 里写死的 3082/3001 连不到生产。`--reset` 只删除这个目录、staging 单元及其 enable 链接。
staging 不校验提交是否在 origin main（生产 companion-deploy 仍校验），不跑真实模型对话。

场景回放（`scenarios-upgraded` 与最后的 `scenarios` 两次，只对 to 包运行；摘要里的 `SCENARIOS` 行取最后一次）验证「谁发了什么 → 谁收到了什么回复」，
不登录 QQ、不用模型 Key：`fake-onebot.mjs` 在 13001 上冒充 NapCat（校验 access_token，记录
send_private_msg），`fake-model.mjs` 启动 release 里真实的 model-gateway（计费、三档、暂停检查不变），
只把上游换成按脚本应答的假 DeepSeek；这一步把 staging 的 model 单元改为经它启动，并放开 qq 单元到
回环地址的连接（先确认 qq-bridge.json 的 onebotPort 是 13001）。两者只是上传到
`~/companion-staging/tools/` 的 staging 工具，不进 release，生产网关没有可配置的上游。运行器
（`scenarios.mjs`）暂停世界、经 operator `/qq` 绑定主人、写入假 Key、恢复世界，然后按
`deploy/staging/scenarios.json` 注入私聊并断言：假 OneBot 收到的发送记录、operator 的
`/memory`、`/people`、`/conversations`、`/spend`，以及假模型收到的整个请求体（`expectPrompt`：
system、记忆中枢附注、用户原文、历史与工具结果全部在内；加 `"in": "context"` 时只看本回合的记忆中枢附注，
即 Authority 为这一回合检索到的内容；加 `"in": "system"` 时只看 system 消息，即固定说明、人格和对话人的常驻档案）。结束后世界保持暂停。现有场景：S1 两个好友的记忆互不可见，S2 非好友静默且不准入，
S3 每日上限到顶后所有人静默、主人只收到一次提醒；M1 `trace-matches-prompt`：operator
`/memory/trace` 记下的注入条目与假模型实际收到的附注一致（每个 id 一行、内容都在，别人的条目不在）；
M2 `console-filter`：`/memory` 按人筛选只返回该人的条目，并能翻到第 50 条之后（同一个人连说 52 轮）；
M3 `stable-prefix`：同一人连续四轮（其中一轮带工具往返），每次请求都以上一次请求为前缀，system 里没有
revision 和时间；M4 `batch-trim`：连说 30 轮，历史起点只移动几次、每次裁掉多个回合；M5 `profile-always-on`：
置顶事实在与它无关的提问里也在本人的 system 里，另一个人的整个请求里没有；M6 `persona-change-trim`：
经 operator 改人格后的下一轮最多重放 2 个旧回合，事实仍在；M7 `no-duplicate-injection`：同一条记忆只进窗口里的
一段附注。场景文本里的 `{run}` 每次回放换成一个新标记（生命周期会回放两次，前一次留下的记忆不会被认错）。
M1 起的场景排在 S3 之后：S3 要求当日开销从零开始。摘要里有一行 `SCENARIOS n/n passed: ...`，
任一场景失败则是 `STAGING FAILED`。

- 新功能开工前先加场景：在 `scenarios.json` 的 `scenarios` 里加一项
  `{ id, title, model, steps, finally }`。`model` 是假模型的规则（最新一条用户消息包含 `match`
  时回 `reply`；带 `propose` 则先发起一次 companion_scope propose；`usage` 决定计费）；`steps`
  每步一个键：`say`、`converse`、`expectReply`、`expectSilence`、`expectSentCount`、`expectMemory`、
  `expectMemoryPages`、`expectPrompt`、`expectTrace`、`expectStablePrefix`、`expectBatchTrim`、`expectHistory`、
  `expectInjectedOnce`、`pinMemory`、`setPersona`、`restorePersona`、`expectNoModelCall`、`expectAdmitted`、`spendSettings`、`expectSpend`
  （含义见 `scenarios.mjs` 的 `STEPS`，缺的断言在那里加）。所有人名必须是 `MOCK-xx`，QQ 号必须是
  9999 开头的 12 位假号，否则运行器拒绝。
- 本机先跑：`node --test deploy/staging/scenarios.test.mjs` 用本 checkout 的真实 Authority、
  网关、执行器和 QQ 桥进程回放同一份场景（静默等待缩短）。
- 在 staging 上单独重跑（沿用上一次生命周期留下的 release，会重置当日开销与主人提醒状态）：
  `node deploy/staging/run.mjs --scenarios`，或 `--scenarios --only S1,S3`。

部署预检：companion-deploy 在停止任何单元、切换 current 之前，以 companion 身份运行新包的
`ops/preflight.mjs`，用新包自己的校验逻辑检查现有数据根中的全部配置（speech 用
loadSpeechConfig，对话用 loadConfig，其余与各服务启动检查一致），并拒绝指向某个具体
release 目录的路径（`current/` 下的路径须在新包中存在）。失败时只输出稳定错误码、文件名和
字段名，删除刚安装的包，生产不变。旧配置里已被忽略的 `purgeModule` 只给警告。

## 发布与回退

发布单位是 main 上的一个提交。release 目录名为 authority-<版本>-<提交前12位>，
版本取根 package.json。source-manifest.json（schemaVersion 2）记录完整
sourceRevision、productVersion、每个文件的 sha256 和可执行文件列表；unit 文件
随代码一起位于 release 的 ops/isolation/units/。unit 与 launch.py 只引用
~/src/companion/current，这是指向当前 release 的符号链接。

1. Agent 在 Mac 上暂存（要求工作树干净、HEAD 已包含在 origin/main）：

   ```sh
   node --run stage:release
   ```

   它会 git fetch、构建前端、运行 build-release、生成确定性的
   .build/releases/<release>.tar.gz 与 .sha256，scp 到 <生产主机>:~/releases/，并打印
   部署命令。本地试构建用 `node deploy/authority/stage-release.mjs --no-upload`
   （未推送的提交需再加 `--allow-unpublished`，这样的包会被 companion-deploy 拒绝）。
   目标主机取 `COMPANION_HOST`，默认 home-agent。

2. 用户在有 TTY 的终端上部署：

   ```sh
   ssh -t home-agent 'sudo companion-deploy deploy ~blackmagic/releases/<release>.tar.gz'
   ```

   companion-deploy 把包复制到 root 目录后校验 .sha256、安全解包（拒绝绝对路径、
   `..`、链接、设备文件和 setuid/setgid）、逐文件核对 manifest，再用 root 自己的
   origin 镜像（/var/lib/companion-deploy/mirror.git，URL 写死在脚本里）确认该提交
   在 main 上。显示版本、提交、标题和日期后要求输入 y。随后：安装只读
   release（属主 companion）→ 以 companion 身份运行新包预检（失败则删除该包并拒绝，服务不动）→
   停 companion-* 单元 → 快照旧 unit 并安装新 unit →
   daemon-reload → 原子切换 current → 启动 → 健康检查（全部单元无 failed、
   3082 在监听、约 20 秒内无重启）。全新主机（没有任何 release 与 companion 单元）
   首次 deploy 只安装 release、单元与 current，不启动服务；完成下文一次性初始化后由用户执行
   `sudo companion-deploy start` 启动并做同样的健康检查（失败则再次停止服务）。失败则自动恢复上一个 release 及其 unit
   快照，删除失败的 release 目录（同一个包修好环境后可直接重新 deploy），并以非零退出；
   若恢复后的 release 也不健康，则停止全部 companion 服务和 socket，不留在重启循环里
   （rollback 失败同理），排除原因后用 `sudo companion-deploy start`。
   只重启 companion 服务和 socket，不碰 NapCat，不重启机器。
   开机与 user manager 重启：companion-deploy 只在健康检查通过后对单元执行
   `systemctl --user enable`（`WantedBy=default.target`，socket 为 sockets.target；
   companion 已开 linger），凡是它停掉的单元都先 disable 再 stop（deploy/rollback 切换前、
   健康检查失败、恢复后仍不健康、`start` 失败、`stop`）。因此
   `systemctl restart user@<uid>` 或重启机器后，user manager 会按单元里的
   Requires/After 顺序自动拉起上次 companion-deploy 留下的、健康的那组单元；
   单元文件名固定且只引用 current，不会指向已删除的 release。自动拉起不做
   companion-deploy 的健康检查（start 本身也只是 systemctl start 加检查，没有别的
   启动前步骤），失败的单元按 Restart=on-failure 重试，事后用第 3 步核查。
   有意停服用 `sudo companion-deploy stop`：disable 后 stop，重启机器也保持停止，
   直到 `sudo companion-deploy start`。旧版 companion-deploy 装的单元从未 enable，
   换上新版后第一次 deploy 或 start 健康通过即会 enable。
   保留最近 3 个部署管理的 release 及 current/previous；旧 VM 上的 authority-0.10.0、
   authority-0.9.0 从不删除。日志在 /var/log/companion-deploy.log，摘要在
   /var/log/companion-deploy.status.json（均 root:adm 0640，Agent 可直接 cat）。

   Agent 交给用户的除命令外还要有核对值：提交 sha 与标题、tarball sha256；
   若 companion-deploy 本身有改动，再给出
   `git show <SHA>:deploy/authority/companion-deploy/companion-deploy | shasum -a 256`。
   Agent 不运行 sudo/companion-deploy，也不经手 sudo 密码；用户核对后输入 y。

3. 部署后核查（Agent，无需 sudo）：

   ```sh
   ssh home-agent 'cat /var/log/companion-deploy.status.json'   # current/previous、last.ok
   ssh home-agent 'tail -n 20 /var/log/companion-deploy.log'
   ssh home-agent 'journalctl _UID=$(id -u companion) --since -15min --no-pager | tail -n 80'
   ssh home-agent "ss -Hltn | grep -E ':(3001|3082|6099) '"
   ```

   last.ok 为 false 表示部署已被拒绝或健康检查失败并自动恢复了 previous：从日志
   诊断，在 Mac 上修复后重新发布，不在生产主机上打补丁。2026-11 教训：release 经
   `current` 符号链接运行，入口判断必须用 realpath（否则进程静默退出 0）；由
   model-gateway/entrypoint.test.mjs 强制检查。

4. 回退与查看：

   ```sh
   ssh -t home-agent 'sudo companion-deploy rollback'   # 用户执行：切回 previous 及其 unit 快照
   ssh -t home-agent 'sudo companion-deploy stop'       # 用户执行：停服并 disable，重启机器也不自动拉起
   ssh home-agent 'cat /var/log/companion-deploy.status.json'   # 无需 sudo
   ssh -t home-agent 'sudo companion-deploy status'     # 用户执行：另含各单元状态
   ssh -t home-agent 'sudo companion-deploy list'       # 用户执行：列出所有 release 目录
   ```

   current、previous 与最近一次结果可不用 sudo 从 status JSON 读取；单元状态与
   release 目录清单在 companion 的 0700 目录下，只能由用户 sudo 查看。

   旧 VM 上第一次部署前的旧 unit（写死 authority-0.10.0）也会被快照，rollback 可完整
   恢复它们。再次 rollback 会切回刚才的版本。

数据库迁移只有一种：`authority/src/migrations.js` 里登记的加法式迁移，由新版本的 Authority
启动时自动备份后应用（见下节「数据库迁移」）。authority SCHEMA_VERSION（SQLite user_version）
保持 2 不变；新 release 的 SCHEMA_VERSION 与当前 release 不同则部署仍被拒绝。配置迁移不在部署
范围内。回退只切换代码与 unit，不覆盖数据库、人设、记忆或登录态，也不撤销已应用的迁移。

## 数据库迁移

Authority 是唯一写库方。表结构变更一律登记在 `authority/src/migrations.js` 的 `MIGRATIONS`
（当前为空：部署不改动生产库）。Store 打开数据库时应用尚未应用的条目：全部待应用条目在一个事务里
执行，记入台账表 `schema_migrations`（第一条迁移时才创建）；任何一条失败则整批回滚、Authority 拒绝
启动（日志带 `MIGRATION_*` 码），companion-deploy 健康检查失败后自动恢复上一版。

规则（代码里的 additive 检查会拒绝违反前四条的迁移）：

- 只追加：id 从 1 连续递增，已发布的条目不改不删。
- 只做加法：新表、新索引、给旧表加可空或带默认值的列。不删、不改名、不重定义已有的表/列/索引，
  不改 user_version 与 application_id，不改写已有行。这样被替换的旧版本仍能打开迁移后的库
  （`inspect()` 在 user_version 2 下只要求必需的表存在，容忍多出的表和列），`rollback` 无需恢复数据。
- 给旧表加列必须声明 `rollbackLevel: 1`。旧版本的 INSERT 具名列之后（`ROLLBACK_LEVEL` 1，即带有
  `authority/src/migrations.js` 的版本）才不受加列影响；生产的 7987e8b 及更早版本按位置插入，表一加列写入就全部失败。
  预检在 `current` 的回退级别不够时以 `MIGRATION_ROLLBACK_UNSAFE` 拒绝部署。所以：**在生产跑过
  一个含具名列的版本之前，只能建新表/新索引，不能给旧表加列。**
- 迁移只做结构变更，不放耗时的数据回填。
- 加一条迁移：在 `MIGRATIONS` 末尾加 `{ id, name, up(db) { db.exec(...) } }`（name 为小写短横线），
  在 `authority/test/` 补它的测试（测试用 `new Authority({ file, migrations })` 注入列表），
  CHANGELOG 写明。迁移属于数据迁移，按 AGENTS.md **须先经主人批准才能登记和发布**；交付部署命令时
  写明这次会应用哪些迁移（staging 预检输出的 `MIGRATION_PENDING` 行）。

迁移前备份：只要有待应用的迁移且数据库不是本次新建的，先用 `VACUUM INTO`（由持有写锁的同一连接
执行，一致）备份到数据库旁的 `migration-backups/`，生产为
`~companion/.local/share/companion-world-v1/authority-data/migration-backups/authority-m<迁移前>-m<迁移后>-<UTC时间>.sqlite`，
目录 0700、文件 0600，校验（quick_check）通过后才迁移；备份失败则不迁移并拒绝启动
（`MIGRATION_BACKUP_FAILED`）。只保留最近 3 份。没有登记迁移或没有待应用迁移时不读不写、不备份。

预检（`ops/preflight.mjs`，只读；Authority 运行时持有写锁，预检用 `immutable=1` 无锁读取）：
新包打不开现有库 → `SCHEMA_ERROR` / `DATABASE_UNREADABLE`；库里有新包不认识的已应用迁移（库比包新，
回旧版本应当用 `rollback` 而不是 deploy 旧包）→ `MIGRATION_UNKNOWN`；有待应用迁移时逐条给出
`PREFLIGHT WARN authority-db MIGRATION_PENDING m<id>-<name>`，并检查备份目录可写
（`MIGRATION_BACKUP_UNWRITABLE`）、剩余空间不少于两倍库大小加 16 MiB（`MIGRATION_DISK_SPACE`）
和上面的回退级别。注意 companion-deploy 是先询问 y 再跑预检，待应用迁移要在交付时事先告知。

staging 验证（`migration-drill (copy)` 步骤，工具 `deploy/staging/migration-drill.mjs`，不进 release）：
停掉 staging 单元复制一份数据库再启动，然后只对这份副本操作：用 to 包的 Store 注入一条建
`staging_drill_*` 表的测试迁移，断言先有备份（0600、文件名带版本、不含新表）、迁移已应用并记入台账、
重开不重复应用；再用 from 包的代码打开迁移后的副本并完成一次 observe → submit → 审核写入。
from 包的回退级别 ≥ 1 时再演练一轮「给旧表加列」，否则跳过并在摘要里注明。随后的
`rollback (to from)` / `smoke-from` 在真实 staging 数据根上验证旧版本可用。本机：
`node --test authority/test/migrations.test.js deploy/staging/migration-drill.test.mjs`。

用备份手工恢复（**需主人批准并由主人执行**；会丢失备份之后的全部写入，只在迁移确实损坏了数据时用——
单纯回退版本不需要恢复）：

```sh
# 1. 停服
ssh -t home-agent 'sudo companion-deploy stop'
# 2. 以 companion 身份换回备份；现库（以及若存在的 -journal）改名保留，不删除
sudo -u companion -H bash -c 'cd ~/.local/share/companion-world-v1/authority-data && ls -l migration-backups && T=$(date +%Y%m%dT%H%M%S) && mv authority.sqlite authority.sqlite.before-restore-$T && { [ ! -e authority.sqlite-journal ] || mv authority.sqlite-journal authority.sqlite-journal.before-restore-$T; } && cp -p migration-backups/<备份文件名> authority.sqlite && chmod 600 authority.sqlite'
# 3. 回到迁移前的版本（留在新版本上启动会再迁移一次）：
ssh -t home-agent 'sudo companion-deploy rollback'   # current 仍是新版本时；它会启动旧版本
ssh -t home-agent 'sudo companion-deploy start'      # 健康检查失败已自动恢复到旧版本时
```

一次性维护命令须以 companion 身份运行（需要人类 sudo，并按 AGENTS.md 先获批准）。
全新主机上用户在自己的账号下执行：

```sh
# 已在 home-agent 验证：
sudo -u companion -H bash -c 'cd ~ && N=~/.local/opt/companion/bin/node R=~/src/companion/current/ops && $N $R/bootstrap.mjs && $N $R/prepare-memory.mjs && $N $R/prepare-content.mjs'
# NapCat prepare：只写配置/token（含 qq-runtime/private/onebot.token），不启动容器；首次 start 前必须运行
sudo -u companion -H bash -c 'cd ~ && ~/.local/opt/companion/bin/node ~/src/companion/current/deploy/qq/prepare.mjs'
```

单独运行时的各命令：

```sh
# 仅全新数据根不存在时；已有世界禁止重跑 bootstrap：
/home/companion/.local/opt/companion/bin/node /home/companion/src/companion/current/ops/bootstrap.mjs
# 已有世界只补对应基础设施，保留 Key/人格/绑定（bootstrap 已含 conversation 配置）：
/home/companion/.local/opt/companion/bin/node /home/companion/src/companion/current/ops/prepare-memory.mjs
/home/companion/.local/opt/companion/bin/node /home/companion/src/companion/current/ops/prepare-content.mjs
/home/companion/.local/opt/companion/bin/node /home/companion/src/companion/current/ops/prepare-conversation.mjs
```

全新主机顺序：用户安装私有 Node（deploy/vm/install-runtime.sh，不再安装 DSH/pnpm）→
首次 `companion-deploy deploy`（不启动服务）→ 以 companion 身份运行 bootstrap、prepare-memory、
prepare-content 和 NapCat prepare（`deploy/qq/prepare.mjs`，否则 companion-qq 因缺 onebot.token
反复退出）→ `sudo companion-deploy start`。旧 DSH 会话历史不迁移，长期记忆在 Authority。

首次安装（用户在生产主机上执行一次）：

```sh
sudo install -d -o root -g root -m 0700 /var/lib/companion-deploy
# 二选一。可直连 GitHub 的主机：
sudo git clone --mirror https://github.com/chai-yinfeng/big-fat-fish.git /var/lib/companion-deploy/mirror.git
# home-agent 需经本机代理访问 GitHub，写入镜像自身的配置：
sudo git clone -c http.https://github.com/.proxy=http://127.0.0.1:7890 --mirror https://github.com/chai-yinfeng/big-fat-fish.git /var/lib/companion-deploy/mirror.git
```

companion-deploy 运行 git 时设置 GIT_CONFIG_NOSYSTEM 并使用自己的 HOME，只有镜像仓库本地
配置生效，所以代理必须用 `clone -c` 写进镜像，不能放在 /etc/gitconfig 或 ~/.gitconfig。

之后以及每次 companion-deploy 有改动时，按顺序升级（用户执行；<SHA> 是 main 上
已审阅的提交，Agent 给出该提交的期望 sha256）：

```sh
# 1. 更新镜像
sudo git --git-dir=/var/lib/companion-deploy/mirror.git fetch --prune
# 2. 可选：先读一遍脚本
sudo git --git-dir=/var/lib/companion-deploy/mirror.git show <SHA>:deploy/authority/companion-deploy/companion-deploy | less
# 3. 从 <SHA> 安装
sudo sh -c 'git --git-dir=/var/lib/companion-deploy/mirror.git show <SHA>:deploy/authority/companion-deploy/companion-deploy > /usr/local/sbin/.companion-deploy.new && chmod 0755 /usr/local/sbin/.companion-deploy.new && mv /usr/local/sbin/.companion-deploy.new /usr/local/sbin/companion-deploy'
# 4. 与 Agent 给出的期望值比对
sha256sum /usr/local/sbin/companion-deploy
```

代码撤销优先用 git revert <commit> 并检查后提交；不要擅自重写已公开历史。
Git 管理代码版本，不替代数据库迁移策略，也不备份平台登录态与用户录音。
