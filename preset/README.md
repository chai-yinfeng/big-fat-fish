# @local/companion-preset

这是 **agent preset bundle**，不是运行时插件；随整合包发行，`companion-core` 用它做
`autoBindPreset: "companion"`。因此它在 profile 里仍是一个独立 bundle 项。

新增一个名为 **大肥鱼陪伴** 的 agent preset，在新建会话的模式选择器里可选。

选中后，全局 `companion-core` 插件会读取 `session.header.agentPreset`，自动把该会话设为
陪伴会话（`config.autoBindPreset`，默认 `companion`），不需要再执行 `/companion bind`。

## 安装

```sh
# 由 Creator 会话通过 plugin_manager install_bundle 安装
plugin_manager install_bundle /absolute/path/to/projects/big-fat-fish/preset
```

安装后在新建会话的模式选择器里应出现“大肥鱼陪伴”。该 preset 只做：

- 不再注入 persona 前缀；身份只由 companion-core 的版本化上下文提供；
- 时间上下文；
- 只读图片、无写文件/终端工具；
- ask_user_question；
- 对话压缩。

记忆、心情、主动开口、TTS/ASR 都由全局插件提供，不重复挂载。

## 自动绑定

`companion-core` 的配置：

```json
{
  "autoBindPreset": "companion"
}
```

- 新建的 `companion` 会话会优先自动绑定。
- 如果已经有一个存活的陪伴会话，不会抢占；需要手动切换时用 `/companion bind`。
- 未选择该 preset 的普通会话不受影响。
