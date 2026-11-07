# 单 Agent 开发、同步与回退

## 开始与交接

```sh
git status --short
git log -3 --oneline
```

一次只让一个 Agent 写一个工作树。切换 Agent 前，把已完成的小步修改
做相关检查并本地提交，说明未完成项与验证命令。未提交内容不通过覆盖同步搬运。
公开远端不包含私密 notes、录音、状态或模型；不要用 push --all/--mirror。
GitHub推送仍须符合用户对目的地及公开范围的授权。

首次 clone 后启用本地检查（不是全局配置）：

```sh
git config --local core.hooksPath .githooks
```

pre-commit 只检查暂存文件的可疑凭据、私有素材和大文件，不自动跑全部测试。
它不是完整的安全审计，public 推送仍需人工确认内容。提交信息写清改变与原因。

## 依赖与定向检查

Node ≥24；前端使用 console 内的锁文件。Mac 与 Linux 的原生依赖不能直接互拷。
使用已有 pnpm 安装 console 依赖，不修改全局 npm 配置或生产运行时：

```sh
pnpm --dir console install --frozen-lockfile --ignore-workspace --ignore-scripts
node --run test:authority
node --run test:qq
node --run test:speech
node --run test:media
node --run test:memory
node --run test:console
```

仅选择受影响的模块；迁移、发布或跨层改动再跑 node --run test。
UI 可单独 node --run build:console。当前没有自动接好的 dev/watch/HMR：构建输出
console/dist，正式装配使用 console-web。不要把复制到正式 release 当开发热更新，
也不要为 UI 小改动重启全部六个服务。下一步开发服务器需使用独立配置/数据根。

## 开发只在 Mac

开发、测试和构建只在 Mac 本机 checkout 进行；VM（myvm）只运行正式服务，不再
保留 VM 开发 checkout，也不在 VM 上改源码。代码通过下面的发布流程到达 VM，不通过 rsync、git pull 或手工复制。开发 QQ 用测试发送口/独立
账号，不能和正式桥重复回应。

## VM 访问与远程命令

VM（myvm）只用于生产。服务以专用用户 companion（uid 1001，密码锁定、不可登录，
home 0700）运行，由 root 通过 `systemctl --user -M companion@ ...` 管理。人类和
Agent 都以 blackmagic 身份 SSH 登录：没有 docker/lxd 权限，sudo 需要人类输入
密码；blackmagic 属于 adm 组，不用 sudo 就能只读查看 companion 的日志和部署记录
（两个部署文件为 root:adm 0640，不含密钥；/var/lib/companion-deploy/state.json
仍只有 root 可读）：

```sh
ssh myvm 'journalctl _UID=1001 --since -1h --no-pager | tail -n 50'
ssh myvm 'cat /var/log/companion-deploy.status.json'   # current/previous、最近一次结果与时间
ssh myvm 'tail -n 20 /var/log/companion-deploy.log'    # 每次部署/回退一行 JSON
```

生产变更只走 stage-release → `sudo companion-deploy`（见下文）。不在 VM 上开发、
测试或改文件。scripts/vm.mjs，以及 deploy/qq/open-login.mjs、
deploy/authority/verify-standalone-console.mjs、verify-console-browser.mjs 等少数
辅助脚本仍指向旧的 blackmagic $HOME 布局，已过时，尚未修复，不要用。

SSH 传输不消耗模型 token；多次工具调用、长输出、重复上下文和失败重试会消耗。
远程命令尽量合并为一次调用，只返回有限长度的摘要。

## 长期运行的清理

VM 上会随时间增长的内容及负责清理的人：

| 内容 | 位置 | 清理方式 |
| --- | --- | --- |
| 旧 release | /home/companion/src/dsh-companion/authority-*-<sha> | companion-deploy 自动保留最近 3 个及 current/previous；旧版 authority-0.10.0、0.9.0 不会自动删除 |
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
~/src/dsh-companion/current，这是指向当前 release 的符号链接。

1. Agent 在 Mac 上暂存（要求工作树干净、HEAD 已包含在 origin/main）：

   ```sh
   node --run stage:release
   ```

   它会 git fetch、构建前端、运行 build-release、生成确定性的
   .build/releases/<release>.tar.gz 与 .sha256，scp 到 myvm:~/releases/，并打印
   部署命令。本地试构建用 `node deploy/authority/stage-release.mjs --no-upload`
   （未推送的提交需再加 `--allow-unpublished`，这样的包会被 VM 拒绝）。

2. 用户在有 TTY 的终端上部署：

   ```sh
   ssh -t myvm 'sudo companion-deploy deploy ~blackmagic/releases/<release>.tar.gz'
   ```

   companion-deploy 把包复制到 root 目录后校验 .sha256、安全解包（拒绝绝对路径、
   `..`、链接、设备文件和 setuid/setgid）、逐文件核对 manifest，再用 root 自己的
   origin 镜像（/var/lib/companion-deploy/mirror.git，URL 写死在脚本里）确认该提交
   在 main 上。显示版本、提交、标题和日期后要求输入 y。随后：停 companion-*
   单元 → 安装只读 release（属主 companion）→ 快照旧 unit 并安装新 unit →
   daemon-reload → 原子切换 current → 启动 → 健康检查（全部单元无 failed、
   3081/3082 在监听、约 20 秒内无重启）。失败则自动恢复上一个 release 及其 unit
   快照并以非零退出。只重启 companion 服务和 socket，不碰 NapCat，不重启机器。
   保留最近 3 个部署管理的 release 及 current/previous；旧的 authority-0.10.0、
   authority-0.9.0 从不删除。日志在 /var/log/companion-deploy.log，摘要在
   /var/log/companion-deploy.status.json（均 root:adm 0640，Agent 可直接 cat）。

   Agent 交给用户的除命令外还要有核对值：提交 sha 与标题、tarball sha256；
   若 companion-deploy 本身有改动，再给出
   `git show <SHA>:deploy/authority/companion-deploy/companion-deploy | shasum -a 256`。
   Agent 不运行 sudo/companion-deploy，也不经手 sudo 密码；用户核对后输入 y。

3. 部署后核查（Agent，无需 sudo）：

   ```sh
   ssh myvm 'cat /var/log/companion-deploy.status.json'   # current/previous、last.ok
   ssh myvm 'tail -n 20 /var/log/companion-deploy.log'
   ssh myvm 'journalctl _UID=1001 --since -15min --no-pager | tail -n 80'
   ssh myvm "ss -Hltn | grep -E ':(3001|3081|3082|6099) '"
   ```

   last.ok 为 false 表示部署已被拒绝或健康检查失败并自动恢复了 previous：从日志
   诊断，在 Mac 上修复后重新发布，不在 VM 上打补丁。2026-11 教训：release 经
   `current` 符号链接运行，入口判断必须用 realpath（否则进程静默退出 0）；由
   model-gateway/entrypoint.test.mjs 强制检查。

4. 回退与查看：

   ```sh
   ssh -t myvm 'sudo companion-deploy rollback'   # 用户执行：切回 previous 及其 unit 快照
   ssh myvm 'cat /var/log/companion-deploy.status.json'   # 无需 sudo
   ssh -t myvm 'sudo companion-deploy status'     # 用户执行：另含各单元状态
   ssh -t myvm 'sudo companion-deploy list'       # 用户执行：列出所有 release 目录
   ```

   current、previous 与最近一次结果可不用 sudo 从 status JSON 读取；单元状态与
   release 目录清单在 companion 的 0700 目录下，只能由用户 sudo 查看。

   第一次部署前的旧 unit（写死 authority-0.10.0）也会被快照，rollback 可完整
   恢复它们。再次 rollback 会切回刚才的版本。

数据库/配置迁移不在部署范围内：新 release 的 authority SCHEMA_VERSION 与当前
release 不同则部署被拒绝，迁移须另行人工完成。回退只切换代码与 unit，不覆盖
数据库、人设、记忆或登录态。

首次安装（用户在 VM 上执行一次）：

```sh
sudo install -d -o root -g root -m 0700 /var/lib/companion-deploy
sudo git clone --mirror https://github.com/chai-yinfeng/big-fat-fish.git /var/lib/companion-deploy/mirror.git
```

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
