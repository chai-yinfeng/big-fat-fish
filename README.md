# 大肥鱼 · big-fat-fish

独立 Companion 项目：同一人格、世界与记忆，通过 QQ 等渠道交互。
当前版本 0.10.0，Node.js ≥24。源码可独立开发；默认对话执行仍依赖
DSH 适配器，不应把控制台独立误称为整个运行时已去 DSH。

## 当前产品

| 目录 | 职责 |
|---|---|
| authority | 唯一世界、人格、记忆权威及用户 operator API |
| console | 独立世界控制台；同时保留旧 DSH 入口兼容 |
| capabilities/conversation、integrations/dsh | 中立执行契约与当前 DSH 实现 |
| capabilities/qq、media、speech、memory | 渠道、受控素材、本地文件语音与记忆维护 |
| model-gateway | 私有模型出口及预算，不拥有角色记忆 |
| deploy | 完整发布与运维入口；不可直接修改正式版本目录 |

文字、语音识别、图片描述、授权素材回发与本地 TTS 已有实现。
Qwen Base 当前量化 CLI 使用 speaker-file 条件，不能冒称完整转写 ICL。
图片生成、家庭群、Live2D 不因接口存在而自动启用。

plugin、preset、adapters、voice-runtime、旧 asr/tts/ui 等是保留的历史实现，
不是当前发布装配；仅在任务涉及 legacy 时读取或运行。

## 开发

在本项目根执行，不依赖 Playground 的目录位置：

```sh
# 使用已安装的 pnpm；本地依赖只装在 console，不安装到正式运行时。
pnpm --dir console install --frozen-lockfile --ignore-workspace --ignore-scripts

git config --local core.hooksPath .githooks
node --run test:qq       # 按变更选择模块，不默认每次全测
node --run test:speech
node --run build:console
node --run test          # 迁移、跨层变更或发布前
```

完整命令、Mac/VM 单 Agent 交接及回退见 [开发流程](docs/DEV_WORKFLOW.md)。
架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 数据与发布

Git 只维护源码、锁文件和公开开发文档。密钥、模型、运行状态、参考录音、
构建产物与本地运维 notes 不公开；克隆源码不会复制生产世界或QQ登录态。
本地历史运维资料可能仍在 notes 中，但不随公开仓库分发。

开发 checkout 与正式 release/data 分开。发布器拒绝覆盖现有产物，并记录
干净 Git commit 和逐文件摘要；发布/回滚须有明确授权和可核对版本。
不会因 clone、安装开发依赖或启动测试而自动恢复世界、发 QQ 消息或付费。
