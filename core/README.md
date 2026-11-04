# @big-fat-fish/companion-core

无框架依赖的陪伴内核：长期记忆（facts/diary/episodes）、心情、关系、主动开口策略、上下文组装。
用 Node 内置 `node:test`，零依赖。

规格：[`../notes/companion-core-spec.md`](../notes/companion-core-spec.md)

## 快速开始

```js
import { CompanionCore, FileJournal, SystemClock, MathRng } from "./src/index.js";

const core = await CompanionCore.open({
  journal: new FileJournal("/path/to/companion/journal.jsonl"),
  clock: SystemClock,
  rng: MathRng,
});

core.rememberFact({ subject: "用户", key: "喜欢的饮料", value: "咖啡" });
core.addDiary({ text: "今天一起喝了手冲" });
core.addEpisode({ summary: "聊了咖啡豆产地", salience: 0.7 });

await core.ingestTurn({
  userText: "今天有点累",
  assistantText: "那先歇一会儿，我在。",
  sentiment: "care",
});

const context = core.buildContext({ query: "咖啡", budgetChars: 2400 });
console.log(context.text);

const decision = core.tick({ presence: "away" });
if (decision.speak) {
  await transport.send({ text: decision.opener.seed, channel: decision.opener.channel });
  core.markProactiveSent({ intent: decision.opener.intent });
}
```

## 关键约定

- **journal 是已应用状态的真相**：写入 append 到 JSONL，启动 replay；人格作者文档由宿主层管理，core 只应用带修订号、内容哈希与原因的完整快照。
- **人格版本**：`applyPersonaDocument({schemaVersion:1,revision,persona}, {source,reason,expectedRevision})`；同号不同内容、跳号、旧修订及重复初始化都拒绝。`updatePersona(patch, options)` 是显式修订，不由抽取器调用。旧日志的人格事件仍能回放；不自动重写真实日志。
- **崩溃恢复**：仅无换行的 JSON EOF 残尾可修复；完整但非法版本、schema、倒序/重复 seq、中间损坏均报错。纠正事实使用单条 `fact/replaced`，避免先废弃旧值、再写新值失败的中间状态；旧的双事件格式仍可回放，新日志不保证旧版二进制可读。
- **单写者锁**：生产使用 `await FileJournal.open(file, {lockExclusive})`，注入宿主 `@deepseek-ai/node-addon-system/flock` 的 `tryLockExclusive`；关闭或进程退出自动释放内核锁，标记锁文件不删除。没有注入时同步构造器仍是保守 wx 模式，崩溃残锁需人工核实，不能用于宣称自动恢复。首次创建锁标记尚未完成的极短崩溃窗口也保守拒绝；不覆盖硬链接别名、非协作写者或网络文件系统。
- **facts/diary/episodes 三类**：facts 不衰减、diary 只追加、episodes 才衰减。
- **心情**：valence/energy + 7 种情绪；读取时按半衰期衰减，写入前先衰减再叠加。
- **主动开口**：安静时段/冷却/日上限/暂停是硬约束；概率由峰谷、时间、存在感、心情、未回应共同决定。
- **上下文预算**：人格先取有界空间（最多 60%，小预算保底但不越总额），剩余在关系/心情与非空记忆类别间公平分配；返回 dropped/truncated。事实只完整保留或明确省略，inner 默认不可见。
- **召回**：非空查询必须命中词法证据，置信度/新近性不能单独使无关条目入选；真正空查询才使用有界回退。这不是同义语义检索。
- **适配器**：TTS/ASR/IM/UI/Clock/Transport 都是接口；core 不 import 供应商 SDK。

## 适配器

```js
const adapters = {
  clock: { now: () => Date.now(), localParts: (now) => ({ hour: 10, minute: 0, weekday: 3, date: "2026-10-24" }) },
  rng: { next: () => Math.random() },
  extractor: { extract: async ({ turn, state }) => ({ facts: [], diary: [], episodes: [], moodEvent: null }) },
  tts: { synthesize: async (req) => ({ audio: new Uint8Array(), mime: "audio/mpeg" }) },
  asr: { transcribe: async (req) => ({ text: "" }) },
  transport: { send: async (msg) => {}, presence: () => "active" },
};
```

HTTP TTS/ASR 与 fallback router 在 [`../adapters`](../adapters)。

## 测试

```sh
node --test
```
