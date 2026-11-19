# 房间（room v0）

一个网页：伪 2.5D 的房间，她在里面做自己的事。房间只是看 Authority 世界状态的一扇窗，
**自己不决定任何事**：它拿到一份“房间状态”，按素材清单把它画出来。

这条链路是：房间状态契约 → 分层渲染。画是占位的手画 SVG；数据默认是假的，也可以读 Authority 的只读出口
（见“真实数据”）。没有接进任何发布、端口、systemd 单元或 operator API；`deploy/` 和发行包里没有它，
还差哪些部署工作见最后一节。

```sh
node room/serve.mjs          # 只听 127.0.0.1:4173，仅供本机预览；默认假数据
# http://127.0.0.1:4173/                      假时间线，每 6 秒一步，走完所有活动
# http://127.0.0.1:4173/?step=2000            每 2 秒一步
# http://127.0.0.1:4173/?activity=sleeping    固定在某个活动
node --run test:room
```

假数据模式下，页面下方的“假数据”一栏可以强制活动、天气、时段。纯静态文件，没有构建步骤，没有依赖
（`console/` 因为用 React 才需要 esbuild；这里用不着）。

| 文件 | 作用 |
|---|---|
| `state.js` | 房间状态契约、校验、构造 |
| `providers/fake.js` | 假数据：每个活动一份固定状态，加一条走完一天的时间线（只由时刻决定，可重复） |
| `providers/authority.js` | 真实数据：向页面自己的服务器要 `state`，按契约再校验一遍（映射本身在 `authority/src/room.js`） |
| `manifest.json`、`manifest.js` | 素材清单及其校验 |
| `view.js` | 页面上的文字（按类别选固定句子） |
| `index.html`、`room.js`、`room.css` | 页面 |
| `assets/` | 占位画（自己画的 SVG，不含第三方素材） |
| `serve.mjs` | 本机预览用的静态服务；真实模式下替页面去读 Authority 的 `GET /v1/room` |

## 房间状态（v1）

```js
{
  version: 1,
  source: 'fake' | 'authority',
  at: 1794990000000,            // 这份状态是哪一刻的（毫秒）
  since: 1794989400000,         // 当前活动从哪一刻开始（≤ at）
  clock: { timezone: 'Asia/Shanghai', minute: 0..1439, phase: 'dawn' | 'day' | 'dusk' | 'night' },
  weather: 'clear' | 'cloudy' | 'rain' | 'snow',     // 真实数据里固定是 clear（还没有来源）
  lamp: 'on' | 'off',
  activity: 'idle' | 'replying' | 'speaking' | 'watching' | 'writing' | 'working' | 'sleeping',
  pose: 'sitting' | 'phone' | 'mic' | 'screen' | 'notebook' | 'laptop' | 'bed',
  mood: 'calm' | 'cheerful' | 'tired'                // 可选，很粗；真实数据里没有
}
```

| activity | 含义 | 默认 pose |
|---|---|---|
| `idle` | 发呆 | `sitting` |
| `replying` | 在看手机（刚有会话动过；可能在回，也可能只是在刷，页面不说是哪种） | `phone` |
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

仍然会透露的：活动类别和它的大致时长本身（例如“她刚拿起手机”说明此刻多半有人在找她）。
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

## 真实数据

房间状态由 Authority 自己在进程内算（`authority/src/room.js`），从它的 capability socket 上的只读出口
`GET /v1/room` 给出，返回的就是上面这份契约，别的什么都没有（协议见 `authority/PROTOCOL.md` 的 Room 一节）。

```
浏览器 ──GET /state──▶ room/serve.mjs（真实模式，只听 127.0.0.1）──GET /v1/room + room 凭据──▶ Authority（Unix socket）
```

- **凭据**：Authority 配置的 `credentials` 里加一条 `{ "role": "room", "hash": "<令牌的 sha256>" }`。这个角色只能
  `GET /v1/room`：别的路由、别的方法一律 403（包括 health 和任何写入）；它也不是 operator 令牌，operator
  socket 不认它。反过来，渠道、记忆 worker、admin 的凭据读不了 `/v1/room`。
- **serve.mjs 真实模式**：给出 Authority 的 socket 和凭据文件（都是绝对路径；凭据文件只能自己可读，如 0600）。

  ```sh
  node room/serve.mjs 4173 --authority-socket /abs/authority.sock --credential-file /abs/room.token
  # 或者用环境变量 ROOM_AUTHORITY_SOCKET、ROOM_CREDENTIAL_FILE
  ```

  页面每 5 秒问一次自己的服务器 `GET /state`；服务器把结果缓存 5 秒，所以看的人多不会让 Authority 多读。
  凭据只留在 serve.mjs 进程里，只发给那个 Unix socket；它回给浏览器的任何东西里都没有凭据，凭据文件也
  不在它能提供的目录里。读不到时 `/state` 回 503 和空对象（不带原因），页面保留上一幅画并提示稍后再试。
  真实模式下页面不显示“假数据”一栏；`?fake=1` 强制看假数据，`?fake=0` 在没有真实数据时报错而不是退回假数据。
- 两头都按契约校验：serve.mjs 收到的、页面收到的状态都再过一遍 `validateRoomState`，多一个字段就拒绝。

规则，按先后：

1. 世界没暂停，且最近 90 秒内有新消息（任一会话、任一方向）→ `replying`，pose 是 `phone`（夜里也是：有人
   找她就醒）。页面说的是“看手机”，不说她在回谁：这个信号分不清“她正在回”“她刚回完”和“别人刚发来”。
2. 在安静时段（控制台设过就用设的，否则默认 23:30–08:00）→ `sleeping`，从安静时段开始的那一刻算起。
3. 世界没暂停，且内容服务有后台任务在跑 → `working`，从最早开始的那个算起。内容服务连不上就当没有。
4. 其余 → `idle`，从最近一条消息算起。

`weather` 固定是 `clear`，没有 `mood`：两者都还没有来源。人、标签、会话、消息、任务标题和结果一概不读。

这个出口只读：不调用 `initiationLog()`（它读的时候会顺手结清过期的发起请求，有写入），只用纯函数
`quietHours()` 和已存的安静时段设置；不写数据库、不记审计，可以轮询。“最近的消息时间”只看最新到达的
64 条 observation，读取量不随历史增长。没有改数据库结构，没有数据迁移。

还没有的信号：

1. `replying` 只是近似（见上）。要准确，需要渠道桥或执行器报告“回合进行中”。
2. `speaking`（语音合成/发送中）、`watching`（看视频）、`writing`（写日记）没有任何可读的信号：语音在内容
   服务里同步完成，不留“进行中”；看视频的能力还不存在；日记由记忆 worker 定时写，Authority 不知道它正在写。
   需要这些能力各自报告一个只有类别的“开始/结束”，由 Authority 汇总。真实模式下这三种活动不会出现。
3. `weather`、`mood` 没有来源。

## 还没做的部署工作（等主人决定）

现在只有代码和本机验证：生产上没有 `room` 凭据，没有进程在跑房间，`deploy/`、发行包、systemd、端口都没动。
要让家里人真的看到房间，还差这些，每一项都需要主人拍板：

1. **凭据的发放**：`deploy/authority/bootstrap.mjs`（新环境）和 `rotate-tokens.mjs`（轮换）要生成 room 令牌、
   把它的 sha256 写进 Authority 配置的 `credentials`、把令牌文件放到只有“提供页面的那个进程”能读的地方
   （它不该和 operator 令牌、渠道凭据放在同一个账号可读的目录）。已有的生产环境加这一条要改 Authority 配置并
   重启 Authority。**回退注意**：这一版之前的 Authority 见到 `role: 'room'` 的凭据会拒绝启动，所以回退到旧版
   之前要先把这条凭据从配置里拿掉（或者让 `companion-deploy` 的回退步骤处理），否则自动回退会失败。
2. **谁来提供页面**：`room/` 不在发行包里（`build-release.mjs` 没有复制它），`serve.mjs` 写的是“开发预览”。
   要么把 `room/` 放进发行包、给 serve.mjs（或一个等价的小服务）配一个单独的低权限账号和 systemd 单元，
   它只需要能连 Authority 的 socket 和读自己的令牌文件；要么由别的已有进程代为提供。不管哪种，这个进程
   都不应该持有 operator 令牌。Authority 的 socket 现在是 0600（`main.js` 没有开放别的权限；`createAuthorityServer`
   本身支持 0660 组），所以这个进程能不能连上、以什么账号/组运行，也要一起定。
3. **怎么让人访问**：serve.mjs 只听 127.0.0.1，没有任何登录。可选的方向：只在家里局域网内开放；经已有的
   反向代理加一层访问控制（口令、每人一个链接等）；或者只做成 QQ 里发一张截图。对外网开放意味着任何拿到
   地址的人都能看到“她此刻在做哪一类事、做了多久”，是否接受、要不要鉴权由主人决定。
4. **在场感透露多少**：现在的房间会让所有看的人知道“刚刚有人找过她”（看手机）和她的安静时段。是否要把
   “看手机”做得更模糊（比如延迟、只在白天显示），由主人决定。
5. 上线前的验证：在 staging（`home-agent-dev`）上带着 room 凭据跑一遍升级和回退；用真手机看页面。这些都没做。
