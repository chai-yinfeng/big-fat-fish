# 单 Agent 开发、同步与回退

## 开始与交接

```sh
git status --short
git log -3 --oneline
```

一次只让一个 Agent 写一个工作树。切换 Mac/VM/Codex 前，把已完成的小步修改
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

## VM 开发与正式环境

建议开发 checkout 为 ~/work/big-fat-fish。正式 release 在另外的版本目录，
正式世界与登录状态不在源码仓库；不重跑 bootstrap，不把生产目录 rsync 进 Git。

在 SSH 会话中使用 agent forwarding 访问已授权 GitHub 仓库，不复制私钥。
转发 agent 通常只在对应连接存活时可用；断连后 Git 认证可能需重新连接。
CLI 在 VM 只代表命令/文件操作在远端，不代表编码模型离线推理。

开发 Agent 应使用独立用户或等效挂载隔离。仅建另一个目录、仍用生产 Linux
用户，不能阻止读取生产密钥。本轮 clone 不等于已完成这种权限隔离，也不会
自动安装 Codex。开发 QQ 用测试发送口/独立账号，不能和正式桥重复回应。

后续交接通常采用本地提交 → 经授权 push 当前分支 → 另一端先确认工作树干净
再 pull --ff-only。出现分叉先检查，不用 force 或 reset --hard 消除冲突。

## 低往返远程命令与耗时

本机项目根可运行：

```sh
node scripts/vm.mjs status
node scripts/vm.mjs check qq
node scripts/vm.mjs check speech
```

该助手只进入 ~/work/big-fat-fish，使用 IPv4 和现有 Node24；成功返回短摘要，
失败日志保留本机 .build，不读生产访问码或启动正式桥。VM 内直接运行模块检查
最快，不必再 SSH 回自己。Codex CLI/桌面 SSH 项目均可使用同一开发 checkout。

本轮空 SSH 命令曾耗10.2–11.5秒，诊断主要停在TCP建立阶段；强制IPv4约1.3秒，
临时复用连接约37毫秒。是本轮实际环境结果，不是所有网络的固定值。没有修改
全局 SSH 配置；GitHub主机校验可使用官方公钥的项目级 known_hosts，不能关闭校验。

SSH传输不消耗模型token；多次工具调用、长输出、重复上下文和失败重试会消耗。
这次不读取私人会话账单，不虚报节省比例。就地CLI可减少往返，但模型仍使用其
账号/API服务；换CLI本身不保证更少token。

## 发布与回退

发布源码必须已提交、工作树干净；先构建前端，再构建新的不可变 release 路径。
产物 source-manifest.json 记录 sourceRevision、productVersion 与文件摘要。
不在旧版本目录改源码；更新正式服务须另行确认，迁移源码不等于发布。

代码撤销优先用 git revert <commit> 并检查后提交；不要擅自重写已公开历史。
生产回滚使用已核对的旧 release 与服务配置，不把数据库/人设/记忆也一起覆盖。
Git 管理代码版本，不替代数据库迁移策略，也不备份平台登录态与用户录音。
