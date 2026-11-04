# @local/companion-ui

可选的大肥鱼角色 UI。核心插件 `companion-core` 不依赖它；只装 core 时命令/HTTP 仍可用。

- 角色头像悬浮在 Web UI 右下角，默认 **128px**（可调 128–256），**可拖动、边缘吸附、位置记忆**；透明底鲸鱼娘立绘，可切换 10 个动作。
- 面板拆成三个页签：
  - **ASR**：Qwen3 / Zipformer / SenseVoice 的勾选与排序、语言、模型下载、按住录音/逐字上屏。
    Zipformer 是本地真流式；推荐 `Zipformer → Qwen3 → SenseVoice`。
  - **TTS**：MiMo / Qwen3-TTS / MiniMax / edge 的勾选与排序、音色/风格/自动朗读/试听。
  - **状态**：语音服务状态/重启、ASR 依赖（Qwen3/SenseVoice/VAD）、心情、关系、
    outer 日记、绑定状态、角色动作选择。
- 路由规则统一：**勾选=允许走这条，顺序=优先级**。只勾 SenseVoice 就不会调用付费 Qwen3；
  取消 MiMo 只走下一个 TTS provider。
- **点击头像**打开管理面板；**悬浮 1 秒**打开外观快调面板（头像大小、动作、按住说话键）。
- ASR 支持窗口内按住快捷键（默认 Control+Option+Space，可改）说话；松开后自动填入 DSH 输入框，
  也可以手动“填入输入框”或“直接发送”。全局热键需要原生壳。
- TTS/ASR sidecar 由 `companion-tts` / `companion-asr` 管理；UI 直接调用 `127.0.0.1:9005` 的 ASR 流式 WebSocket。
- 没有 core 时，UI 仍可单独使用 TTS/ASR 适配器（降级体验，显示“core 不可用”）。
- 立绘为透明底，共 10 个动作；自动模式随录音/忙碌/错误切换，也可以在状态页固定。
- 立绘来源与许可证见 `NOTICE.md` 和 `LICENSE.whale-musume`。
