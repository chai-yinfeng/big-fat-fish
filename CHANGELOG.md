# Changelog

每个版本几行即可：改了什么、真实验证了什么、什么还没验证。

## 0.10.0

- Authority 是唯一世界/人格/记忆写入方；独立世界控制台（同源 operator 入口）与旧 DSH 设置入口共用一套视图。
- QQ 私聊（仅本人已绑定号）已实现文字、语音识别、图片描述、授权素材回发和本地 TTS（Qwen3-TTS 重档，speaker-file 条件）。
- 对话执行默认仍经 DSH 适配器；模型出口经 model-gateway（DeepSeek）。
- 发布改为 Mac 上 stage-release → 用户在 VM 上 sudo companion-deploy，失败自动恢复上一版本。
- 精简流程：删除 bili-bridge；operator 的世界暂停/恢复、人格编辑和语音运行时操作不再强制携带世界 revision（忘记记忆与语音配置文件仍保留 CAS）。
- Kokoro 已弃用，仅作为现有合成参考来源，待移除。
