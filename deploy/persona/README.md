# 人格卡文件与卡包

把人格卡写成 Markdown 文件（一张卡一个文件），在 Mac 上转换成一个卡包 JSON，再在控制台一次导入。
卡库按**卡名称（title）**匹配：同名的卡更新，没有的新建；当前是哪张卡不变，也不删任何卡。

## 使用步骤

1. 改卡文件（例如主检出里的 `notes/plans/persona-cards/*.md`）。
2. 在仓库根目录运行：

   ```sh
   node deploy/persona/build-cards.mjs notes/plans/persona-cards
   ```

   逐张校验，全部通过才写出 `notes/plans/persona-cards/persona-cards.json`（可用 `--out <文件>` 改位置）。
   出错时只报哪张卡、哪个字段、哪条限制，不写文件。每张卡还会打印渲染后的人格块长度和预算（2400 字），超出时提示会被截断。
3. 控制台「人格」页 → 人格卡库 →「导入卡包」，选这个 JSON。
   页面列出每张卡是新建、更新还是无变化，以及更新哪些字段；点「确认导入」才写入。
   编辑区有未保存的修改时不能导入。预览之后卡库如果在别处被改过，确认时会拒绝，请重新选文件预览。
   更新到当前卡时会立即生效（她的提示缓存会重来一次），预览里会标出来。

脚本只读文件、写一个 JSON，不连接任何服务，也不需要令牌。

## 卡文件格式

目录里每个 `*.md` 是一张卡；`README.md`、以 `_` 或 `.` 开头的文件不读。

~~~markdown
---
title: 久美子式·嘴懒心热
tags: 表面淡淡、嘴嫌麻烦手先做、在意就追问
summary: 表面懒懒淡淡、爱吐槽，吐槽后总跟一句真心和一个行动。
name: 大肥鱼
userCallName: 你
---

# 随便写的标题和说明（不进卡）

## identity

```text
你是住在家里一台小主机上的 AI……
```

## traits

留空。

## speechStyle

```text
像和熟人聊天：短句、口语……
```

## principles

```text
每行一条
```

## boundaries

```text
每行一条
```

## examples

```text
【难过】标题行以【开头，不进卡
对方：今天好累。
她：辛苦了。是事情多，还是遇到烦心的了？

对方：我去睡了。
她：嗯，晚安。
```

## 备注

其他任何 `##` 小节（调研、取舍、上线观察……）都不进卡。
~~~

规则：

- **卡片信息**：文件第一行是 `---`，到下一个 `---` 为止，每行 `字段: 值`。
  `title`、`name`、`userCallName` 必填；`tags`、`summary` 可省略（为空）。
  `tags` 用 `、` `,` `，` `;` `；` 或空格分隔，重复的只算一个。
- **人格小节**：标题必须正好是 `## identity`、`## traits`、`## speechStyle`、`## principles`、`## boundaries`、`## examples`（大小写一致）。
  除 `traits` 外都必须有；每节只取唯一的一个 ``` 代码块，代码块外的文字是给人看的说明。没有代码块就是留空。
  - `identity`、`speechStyle`：代码块原文（去掉首尾空白，段内换行保留）。
  - `traits`、`principles`、`boundaries`：每个非空行一条。
  - `examples`：每组以 `对方：` 开头、`她：` 接着（中英文冒号都行）；下一行不以这两个开头时接在上一句后面换行；空行分组；`【` 开头的行是标题，不进卡。
- 卡里没有的字段（`relationshipStage`）不在卡包里：更新时保持卡原来的值，新建时取默认值。卡包里的其他人格字段会把卡的对应字段整个换掉，所以 `traits` 留空会把卡的特质清空。

## 限制（与 Authority 一致，见 `authority/src/cards.js`、`authority/src/persona.js`）

| 字段 | 限制 |
|---|---|
| title | 必填，≤40 字，目录内不能重名 |
| tags | ≤6 个，每个 ≤12 字 |
| summary | ≤60 字 |
| 卡数 | 一个卡包 ≤24 张；导入后卡库总数也不能超过 24 |
| name、userCallName | 必填 |
| 文本字段 | 每个 ≤4000 字 |
| traits/principles/boundaries | 每项 ≤40 条 |
| examples | ≤20 组 |
| 整个人格 | JSON ≤24000 字 |

## 卡包 JSON

```json
{ "kind": "big-fat-fish/persona-cards", "version": 1,
  "cards": [ { "title": "…", "tags": ["…"], "summary": "…",
               "persona": { "name": "大肥鱼", "userCallName": "你", "identity": "…", "speechStyle": "…",
                            "traits": [], "principles": ["…"], "boundaries": ["…"],
                            "examples": [{ "user": "…", "assistant": "…" }] } } ] }
```

控制台写入时只用已有的卡库接口：新建 `POST /persona/cards`（title、tags、summary），再 `POST /persona/cards/update` 写人格；
已有的卡只发变了的字段，当前卡带 `expectedRevision`。写入是逐张进行的，中途失败时已写的保留，修好后再导入一次即可（没变的卡显示「无变化」，不会重复写）。

编辑区里原有的「导出 JSON / 导入 JSON」仍然是单张卡的人格字段，只载入编辑区，和卡包不是一种文件。
