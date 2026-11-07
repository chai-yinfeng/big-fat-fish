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
UI 可单独 node --run build:console（输出 console/dist；没有 dev/watch/HMR）。
开发服务使用独立配置/数据根，不把复制到正式 release 当热更新。

## 测试发送与版本记录

- 向用户本人已绑定的 QQ 发测试消息/语音：用户在一个会话中批准一次即覆盖该会话后续
  的测试发送，不必逐条授权或另写私有记录。发给其他人或群仍需逐次单独授权。
- 每个版本只在根目录 CHANGELOG.md 写简短条目（改了什么、真实验证了什么、什么未验证），
  不再写长篇实机验收笔记。汇报只说真实运行过的内容，未验证的明确列出。

## 开发只在 Mac

开发、测试和构建只在 Mac 本机 checkout 进行；VM（myvm）只运行正式服务，不在 VM 上
改源码。代码只通过下面的发布流程到达 VM，不用 rsync、git pull 或手工复制。开发 QQ
用测试发送口/独立账号，不能和正式桥重复回应。

## VM 访问与远程命令

VM（myvm）只用于生产。服务以专用用户 companion（uid 1001，密码锁定、不可登录，
home 0700）运行，由 root 通过 `systemctl --user -M companion@ ...` 管理。人类和
Agent 都以 blackmagic 身份 SSH 登录：没有 docker/lxd 权限，sudo 需要人类输入
密码；blackmagic 属于 adm 组，不用 sudo 就能只读查看 companion 的日志和部署记录
（两个部署文件为 root:adm 0640，不含密钥；/var/lib/companion-deploy/state.json
仍只有 root 可读），查看命令见“发布与回退”第 3 步。

需要私有 token 的 Mac 辅助脚本（open-world、deploy/qq/open-login、
verify-standalone-console、verify-console-browser、verify-dialogue）都经
deploy/authority/companion-sudo.mjs 以 `ssh -t myvm sudo -u companion` 读取，由用户
在终端输入 sudo 密码；Agent 不运行它们。verify-live 只能在 VM 上以 companion 身份
运行，且对正式世界只允许 status。

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
