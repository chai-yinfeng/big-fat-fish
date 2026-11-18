# 房间（room v0）

一个网页：伪 2.5D 的房间，她在里面做自己的事。房间只是看 Authority 世界状态的一扇窗，
**自己不决定任何事**：它拿到一份“房间状态”，按素材清单把它画出来。

v0 只验证这条链路：房间状态契约 → 分层渲染。数据是假的，画是占位的手画 SVG。
没有接进任何发布、端口、systemd 单元或 operator API；`deploy/` 和发行包里没有它。

```sh
node room/serve.mjs          # 只听 127.0.0.1:4173，仅供本机预览
# http://127.0.0.1:4173/                      假时间线，每 6 秒一步，走完所有活动
# http://127.0.0.1:4173/?step=2000            每 2 秒一步
# http://127.0.0.1:4173/?activity=sleeping    固定在某个活动
node --run test:room
```

页面下方的“假数据”一栏可以强制活动、天气、时段。纯静态文件，没有构建步骤，没有依赖
（`console/` 因为用 React 才需要 esbuild；这里用不着）。

| 文件 | 作用 |
|---|---|
| `state.js` | 房间状态契约、校验、构造 |
| `providers/fake.js` | 假数据：每个活动一份固定状态，加一条走完一天的时间线（只由时刻决定，可重复） |
| `providers/authority.js` | 纯函数：把 Authority 现有的只读结果映射成房间状态（还没接线） |
| `manifest.json`、`manifest.js` | 素材清单及其校验 |
| `view.js` | 页面上的文字（按类别选固定句子） |
| `index.html`、`room.js`、`room.css` | 页面 |
| `assets/` | 占位画（自己画的 SVG，不含第三方素材） |
| `serve.mjs` | 本机预览用的静态服务 |

## 房间状态（v1）

```js
{
  version: 1,
  source: 'fake' | 'authority',
  at: 1794990000000,            // 这份状态是哪一刻的（毫秒）
  since: 1794989400000,         // 当前活动从哪一刻开始（≤ at）
  clock: { timezone: 'Asia/Shanghai', minute: 0..1439, phase: 'dawn' | 'day' | 'dusk' | 'night' },
  weather: 'clear' | 'cloudy' | 'rain' | 'snow',     // 目前只有假数据
  lamp: 'on' | 'off',
  activity: 'idle' | 'replying' | 'speaking' | 'watching' | 'writing' | 'working' | 'sleeping',
  pose: 'sitting' | 'phone' | 'mic' | 'screen' | 'notebook' | 'laptop' | 'bed',
  mood: 'calm' | 'cheerful' | 'tired'                // 可选，很粗
}
```

| activity | 含义 | 默认 pose |
|---|---|---|
| `idle` | 发呆 | `sitting` |
| `replying` | 在回消息 | `phone` |
| `speaking` | 在说话（语音） | `mic` |
| `watching` | 在看视频 | `screen` |
| `writing` | 在写日记 | `notebook` |
| `working` | 后台在忙一件事（沙箱、后台任务） | `laptop` |
| `sleeping` | 睡了（安静时段） | `bed` |

`phase` 由 `minute` 决定：05:00 清晨、07:30 白天、17:30 傍晚、19:30 夜里。没给 `lamp` 时，
傍晚和夜里她醒着就开灯。一个活动以后可以有多个 pose（`POSES` 里每个活动是一个列表）。

### 隔离（硬规则）

同一个房间可能有好几个人在看，所以它只显示她在做的事的**类别**，不显示：在和谁聊、
消息内容、谁分享的视频、日记正文、任务内容。这条规则写在契约里，不靠页面自觉：

- 状态里没有放这些东西的字段；`validateRoomState` 拒绝任何未列出的字段。
- 状态里每个字符串都来自固定的词表，没有自由文本，所以也塞不进已有字段。
- `roomState()` 只读契约自己的字段，输入里多出来的东西直接丢掉，不复制。
- 页面文字（`view.js`）是按类别选的固定句子，时长只说到“已经 12 分钟”这个粒度。

`room.test.mjs` 用带着人名、QQ 号、消息、任务标题和结果的输入检查这几条。

仍然会透露的：活动类别和它的大致时长本身（例如“她刚开始回消息”说明此刻有人在找她）。
这是“在场感”的代价，是否接受由主人决定。

## 素材清单：换成真图或循环视频

换画 = 把文件放进 `assets/`，改 `manifest.json`，不改代码。坐标都是舞台单位
（`stage.width × stage.height`，原点在左上角），页面按比例缩放。

```json
{
  "version": 1,
  "stage": { "width": 1600, "height": 1000 },
  "base": { "src": "assets/base.svg" },
  "window": [[740, 100], [520, 210], [520, 350], [740, 240]],
  "lamp": { "x": 1390, "y": 455, "radius": 420 },
  "poses": {
    "sitting": { "kind": "image", "src": "assets/pose-sitting.svg", "anchor": { "x": 740, "y": 705 }, "width": 180 },
    "bed": { "kind": "video", "src": "assets/sleep-loop.webm", "poster": "assets/sleep.png", "anchor": { "x": 460, "y": 760 }, "width": 520 }
  },
  "hotspots": [{ "id": "window", "shows": "weather", "polygon": [[740, 100], [520, 210], [520, 350], [740, 240]] }]
}
```

- `base`：底图，铺满舞台。图片比例要和 `stage` 一致。
- `poses`：七个 pose 都要有。`kind` 是 `image`（svg/png/jpg/webp/avif/gif）或 `video`（webm/mp4，
  静音、循环、自动播放；`poster` 可选）。`anchor` 是这张图**底边中点**（她的脚）落在舞台上的位置，
  `width` 是图在舞台上的宽度，高度按图自己的比例。人物图要透明背景；视频要透明的话用带
  alpha 的 WebM（VP9），mp4 没有透明通道。
- `window`（可选）：窗户的多边形，天空和天气画在里面。真图自己画了窗外就删掉这一项。
- `lamp`（可选）：灯光晕的中心和半径。
- `hotspots`：可点的区域，`shows` 只能是 `activity`、`weather`、`clock`、`lamp`，点开的小抽屉
  只显示类别级的信息。她本人也可以点（显示 `activity`）。
- 文件只能是页面旁边的相对路径；`manifest.js` 拒绝网址、`..` 和别的文件类型。

注意：仓库的 `.gitignore` 忽略 `*.mp4`、`*.mov`，mp4 不会进 Git；真素材放不放进这个公开
仓库由主人决定。

分层从下到上：底图 → 窗外（天空、天气）→ pose → 光照（按时段整体着色）→ 灯光晕 → 热区 → 抽屉。

## 真实数据：现在能映射什么，还缺什么

`providers/authority.js` 的 `fromAuthority({ now, world, initiative, jobs, conversations })`
是纯函数，输入是 Authority 今天已有的只读结果，原样传入即可：

| 输入 | 来自 | 用到的 |
|---|---|---|
| `world` | `authority.worldStatus()`（`GET /world` 结果里的 `world`） | `paused` |
| `initiative` | `authority.initiationLog()`（`GET /initiative/log`） | `quietHours.now`、`quietHours.from` |
| `jobs` | `authority.jobList()`（`GET /jobs`） | 每个任务的 `status`、`startedAt` |
| `conversations` | `authority.listConversations()`（`GET /conversations`） | 每个会话的 `lastAt` |

规则，按先后：

1. 世界没暂停，且有会话在最近 90 秒内有新消息 → `replying`（夜里也是：有人找她就醒）。
2. 在安静时段 → `sleeping`，从安静时段开始的那一刻算起。
3. 世界没暂停，且有后台任务在跑 → `working`。
4. 其余 → `idle`。

人、标签、会话、任务标题和结果一概不读。

**没有接线，也不能直接接**，原因和缺的东西：

1. 上面四个都是 operator 路由，要 operator 令牌；房间页面是给好几个人看的，不能拿这个令牌。
   需要 Authority 自己在进程内算好这份状态，开一个只读出口只返回房间状态这十个字段
   （例如 `GET /room`），用单独的、只能读这一个路由的凭据，或由一个不持有 operator 令牌的
   小服务转发。是否对外网开放、怎么鉴权需要主人决定。
2. `replying` 只是近似：`listConversations()` 的 `lastAt` 是任一方向最新一条消息的时间，
   分不清“她正在回”和“她刚回完”。要准确，需要渠道桥或执行器报告“回合进行中”。
3. `speaking`（语音合成/发送中）、`watching`（看视频）、`writing`（写日记）现在没有任何
   可读的信号：语音在内容服务里同步完成，不留“进行中”；看视频的能力还不存在；日记由记忆
   worker 定时写，Authority 不知道它正在写。需要这些能力各自报告一个只有类别的
   “开始/结束”，由 Authority 汇总。
4. `weather` 没有来源（Authority 的世界状态里没有天气）；`mood` 也没有。
5. `initiationLog()` 读的时候会顺手结清过期的发起请求（有写入），不适合给房间高频轮询；
   房间出口应该只调用纯读的 `quietHours()`。
