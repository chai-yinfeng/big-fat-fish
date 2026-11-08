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
安装器按 manifest 固定的 sha256 校验。安装后在控制台“音色”中登记参考录音。发布与安装工具按
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
   在 main 上。显示版本、提交、标题和日期后要求输入 y。随后：停 companion-*
   单元 → 安装只读 release（属主 companion）→ 快照旧 unit 并安装新 unit →
   daemon-reload → 原子切换 current → 启动 → 健康检查（全部单元无 failed、
   3082 在监听、约 20 秒内无重启）。全新主机（没有任何 release 与 companion 单元）
   首次 deploy 只安装 release、单元与 current，不启动服务；完成下文一次性初始化后由用户执行
   `sudo companion-deploy start` 启动并做同样的健康检查（失败则再次停止服务）。失败则自动恢复上一个 release 及其 unit
   快照，删除失败的 release 目录（同一个包修好环境后可直接重新 deploy），并以非零退出；
   若恢复后的 release 也不健康，则停止全部 companion 服务和 socket，不留在重启循环里
   （rollback 失败同理），排除原因后用 `sudo companion-deploy start`。
   只重启 companion 服务和 socket，不碰 NapCat，不重启机器。
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
   ssh home-agent 'cat /var/log/companion-deploy.status.json'   # 无需 sudo
   ssh -t home-agent 'sudo companion-deploy status'     # 用户执行：另含各单元状态
   ssh -t home-agent 'sudo companion-deploy list'       # 用户执行：列出所有 release 目录
   ```

   current、previous 与最近一次结果可不用 sudo 从 status JSON 读取；单元状态与
   release 目录清单在 companion 的 0700 目录下，只能由用户 sudo 查看。

   旧 VM 上第一次部署前的旧 unit（写死 authority-0.10.0）也会被快照，rollback 可完整
   恢复它们。再次 rollback 会切回刚才的版本。

数据库/配置迁移不在部署范围内：新 release 的 authority SCHEMA_VERSION 与当前
release 不同则部署被拒绝，迁移须另行人工完成。回退只切换代码与 unit，不覆盖
数据库、人设、记忆或登录态。

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
