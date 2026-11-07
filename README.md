# 大肥鱼 · big-fat-fish

独立 Companion 项目：同一人格、世界与记忆，通过 QQ 等渠道与用户身边的家人朋友
（最多约 20 人）交互。当前版本 0.10.0（见 [CHANGELOG](CHANGELOG.md)），Node.js ≥24。

## 当前产品

| 目录 | 职责 |
|---|---|
| authority | 唯一世界、人格、记忆权威及用户 operator API |
| console | 独立世界控制台；同时保留旧 DSH 入口兼容 |
| capabilities/conversation、integrations/dsh | 中立执行契约与当前 DSH 实现 |
| capabilities/qq、media、speech、memory | 渠道、受控素材、本地文件语音与记忆维护 |
| model-gateway | 私有模型出口及预算，不拥有角色记忆 |
| deploy | 完整发布与运维入口；不可直接修改正式版本目录 |

文字、语音识别、图片描述、授权素材回发与本地 TTS（Qwen3-TTS）已有实现。
plugin、preset、adapters、voice-runtime、旧 asr/tts/ui 等是保留的历史实现，
不是当前发布装配；仅在任务涉及 legacy 时读取或运行。

当前限制：
- 默认对话执行仍经 DSH 适配器，独立控制台不等于运行时已去 DSH。
- Qwen3-TTS 只用 speaker-file 条件，参考转写不参与合成（不是完整 ICL 克隆）。
- Kokoro 已弃用，仅作为现有合成参考来源，待移除。
- 图片生成、家庭群、Live2D 未启用。

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

完整命令、仅在 Mac 开发与 stage-release → companion-deploy 发布/回退流程见 [开发流程](docs/DEV_WORKFLOW.md)。
架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 数据与发布

Git 只维护源码、锁文件和公开开发文档。密钥、模型、运行状态、参考录音、
构建产物与本地 notes 不进入 Git；克隆源码不会复制生产世界或 QQ 登录态。

开发 checkout 与正式 release/data 分开。发布器拒绝覆盖现有产物，并记录
干净 Git commit 和逐文件摘要；发布/回滚须有明确授权和可核对版本。
clone、安装开发依赖或跑测试不会恢复世界、发 QQ 消息或付费。
